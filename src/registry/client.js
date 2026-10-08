'use strict';
/**
 * Registry client: key derivation, calldata building, read-only queries.
 * Transaction EXECUTION lives in scripts/phase3 (safety-gated); this module only
 * encodes/decodes and reads. No signer is created here; PRIVATE_KEY is never read.
 *
 * Slot key (MUST equal the contract's slotKey()):
 *   keyHash = keccak256(abi.encode(uint256 chainId, address processor, uint256 circuitId))
 * i.e. the keccak of the 96-byte ABI (non-packed) encoding. Pinned by an explicit
 * preimage-layout test (tests/phase3/registry.test.js), not just by re-encoding.
 */
const { ethers } = require('ethers');

// Canonical fragments — MUST match contracts/AttributionRegistry.sol exactly.
// Cross-checked against the solc build in tests (selectors + topics).
const REGISTRY_ABI = [
  'function slotKey(uint256 chainId, address processor, uint256 circuitId) view returns (bytes32)',
  'function register(uint256 chainId, address processor, uint256 circuitId, bytes32 netlistHash, address payee, uint256 price, bytes32 termsHash) returns (bytes32)',
  'function updateTerms(bytes32 key, bytes32 netlistHash, address payee, uint256 price, bytes32 termsHash)',
  'function deactivate(bytes32 key)',
  'function getRegistration(bytes32 key) view returns (tuple(bytes32 netlistHash, address payee, uint256 price, bytes32 termsHash, uint64 registeredAt, address registeredBy, bool active, bool exists))',
  'function isRegistered(bytes32 key) view returns (bool)',
  'event Registered(bytes32 indexed key, uint256 chainId, address indexed processor, uint256 indexed circuitId, bytes32 netlistHash, address payee, uint256 price, bytes32 termsHash, address registeredBy)',
  'event TermsUpdated(bytes32 indexed key, bytes32 netlistHash, address payee, uint256 price, bytes32 termsHash)',
  'event Deactivated(bytes32 indexed key)',
  'error AlreadyRegistered(bytes32)',
  'error NotRegistered(bytes32)',
  'error NotRegistrant(bytes32,address)',
  'error InactiveRecord(bytes32)',
  'error InvalidParam(string)',
];

const iface = new ethers.Interface(REGISTRY_ABI);

function checkSlot({ chainId, processor, circuitId }) {
  const c = BigInt(chainId);
  if (c < 1n) throw new Error('registry: chainId must be >= 1');
  if (!/^0[xX][0-9a-fA-F]{40}$/.test(processor)) throw new Error(`registry: bad processor: ${processor}`);
  const p = '0x' + processor.slice(2).toLowerCase();
  if (/^0x0{40}$/.test(p)) throw new Error('registry: processor is zero');
  const id = BigInt(circuitId);
  if (id < 1n) throw new Error('registry: circuitId must be >= 1');
  return { chainId: c, processor: p, circuitId: id };
}

/** bytes32 slot key, identical to the contract's slotKey(). */
function keyHashFor({ chainId, processor, circuitId }) {
  const s = checkSlot({ chainId, processor, circuitId });
  const preimage = ethers.AbiCoder.defaultAbiCoder().encode(
    ['uint256', 'address', 'uint256'],
    [s.chainId, s.processor, s.circuitId],
  );
  return ethers.keccak256(preimage);
}

function checkBytes32(v, what) {
  if (typeof v !== 'string' || !/^0[xX][0-9a-fA-F]{64}$/.test(v)) {
    throw new Error(`registry: bad ${what}: ${String(v).slice(0, 24)}`);
  }
  return '0x' + v.slice(2).toLowerCase();
}

function buildRegisterCalldata({ chainId, processor, circuitId, netlistHash, payee, priceWei, termsHash }) {
  const s = checkSlot({ chainId, processor, circuitId });
  const nh = checkBytes32(netlistHash, 'netlistHash');
  if (nh === '0x' + '00'.repeat(32)) throw new Error('registry: netlistHash must be nonzero');
  if (!/^0[xX][0-9a-fA-F]{40}$/.test(payee)) throw new Error(`registry: bad payee: ${payee}`);
  const py = '0x' + payee.slice(2).toLowerCase();
  if (/^0x0{40}$/.test(py)) throw new Error('registry: payee must be nonzero');
  const price = BigInt(priceWei);
  if (price < 0n) throw new Error('registry: price must be >= 0');
  const th = checkBytes32(termsHash, 'termsHash'); // 0x0 allowed = "terms not published"
  return iface.encodeFunctionData('register', [s.chainId, s.processor, s.circuitId, nh, py, price, th]);
}

function buildUpdateCalldata({ key, netlistHash, payee, priceWei, termsHash }) {
  const k = checkBytes32(key, 'key');
  const nh = checkBytes32(netlistHash, 'netlistHash');
  if (!/^0[xX][0-9a-fA-F]{40}$/.test(payee)) throw new Error(`registry: bad payee: ${payee}`);
  return iface.encodeFunctionData('updateTerms', [k, nh, '0x' + payee.slice(2).toLowerCase(), BigInt(priceWei), checkBytes32(termsHash, 'termsHash')]);
}

function buildDeactivateCalldata({ key }) {
  return iface.encodeFunctionData('deactivate', [checkBytes32(key, 'key')]);
}

/** Read-only: full record or null when the key was never registered. */
async function readRegistration(provider, registry, key) {
  const c = new ethers.Contract(registry, REGISTRY_ABI, provider);
  const k = checkBytes32(key, 'key');
  try {
    if ((await provider.getCode(registry)) === '0x') return null; // no contract, no record
    const r = await c.getRegistration(k);
    if (!r.exists) return null; // belt-and-braces: contract reverts when absent
    return {
      netlistHash: r.netlistHash.toLowerCase(),
      payee: r.payee.toLowerCase(),
      priceWei: r.price.toString(),
      termsHash: r.termsHash.toLowerCase(),
      registeredAt: Number(r.registeredAt),
      registeredBy: r.registeredBy.toLowerCase(),
      active: r.active,
    };
  } catch (e) {
    if (e?.code === 'CALL_EXCEPTION' || /revert|NotRegistered/i.test(e?.shortMessage || e?.message || '')) return null;
    throw e;
  }
}

async function readIsRegistered(provider, registry, key) {
  const c = new ethers.Contract(registry, REGISTRY_ABI, provider);
  return c.isRegistered(checkBytes32(key, 'key'));
}

module.exports = {
  REGISTRY_ABI, registryInterface: iface,
  keyHashFor, buildRegisterCalldata, buildUpdateCalldata, buildDeactivateCalldata,
  readRegistration, readIsRegistered,
};
