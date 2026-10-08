'use strict';
/**
 * Router client: calldata building + read-only quoting for LicensedTapeoutRouter.
 * Execution lives in scripts/phase4 (safety-gated). No signer here; no key read.
 *
 * ROUTER_ABI fragments MUST match contracts/LicensedTapeoutRouter.sol exactly —
 * cross-checked against the solc build in tests (selectors + topics + errors).
 */
const { ethers } = require('ethers');

const ROUTER_ABI = [
  'function REGISTRY() view returns (address)',
  'function FACTORY() view returns (address)',
  'function MAX_NETLIST_BYTES() view returns (uint256)',
  'function MAX_REFS() view returns (uint256)',
  'function licenseAndTapeout(address targetCpu, bytes nl, uint32 nIn, uint32 nOut) payable returns (uint256, bytes32)',
  'event LicensePaid(bytes32 indexed key, address indexed payee, uint256 price, bytes32 termsHash)',
  'event LicensedTapeout(address indexed targetCpu, uint256 indexed newCircuitId, bytes32 lineageHash, uint256 totalPriceWei, uint256 depCount, address indexed payer)',
  'error ZeroAddress()',
  'error Reentrant()',
  'error NotFactoryCpu(address)',
  'error NetlistTooLarge(uint256)',
  'error TooManyRefs(uint256)',
  'error MalformedNetlist(string)',
  'error UnregisteredDep(bytes32)',
  'error InactiveDep(bytes32)',
  'error MissingTerms(bytes32)',
  'error ZeroPayee(bytes32)',
  'error MissingDependency(address,uint256)',
  'error PinMismatch(address,uint256)',
  'error NetlistMismatch(bytes32)',
  'error WrongValue(uint256,uint256)',
  'error PayFailed(address,uint256)',
  'error MintFailed()',
  'error TapeoutFailed()',
  'error TransferFailed()',
];

const routerInterface = new ethers.Interface(ROUTER_ABI);

function buildLicenseCalldata({ targetCpu, netlist, nIn, nOut }) {
  if (!/^0[xX][0-9a-fA-F]{40}$/.test(targetCpu)) throw new Error(`router: bad targetCpu: ${targetCpu}`);
  if (!/^0[xX]([0-9a-fA-F]{2})+$/.test(netlist)) throw new Error('router: bad netlist hex');
  return routerInterface.encodeFunctionData('licenseAndTapeout', [
    targetCpu.toLowerCase(), netlist.toLowerCase(), Number(nIn), Number(nOut),
  ]);
}

/**
 * Exact value the router requires: licenseTotal + mintValue + tapeoutFee.
 * Mirrors the contract formula 1:1 (single mint call per nonzero token id).
 */
function requiredValue({ totalPriceWei, nNand, nLatch, mintPriceWei, protocolFeeWei, tapeoutFeeWei }) {
  const mp = BigInt(mintPriceWei);
  const pf = BigInt(protocolFeeWei);
  let mint = BigInt(nNand) * mp + BigInt(nLatch) * mp;
  if (BigInt(nNand) > 0n) mint += pf;
  if (BigInt(nLatch) > 0n) mint += pf;
  return (BigInt(totalPriceWei) + mint + BigInt(tapeoutFeeWei)).toString();
}

/** Classify a proposed msg.value against the requirement (exact-match policy). */
function classifyValue({ requiredWei, proposedWei }) {
  const r = BigInt(requiredWei);
  const p = BigInt(proposedWei);
  if (p === r) return { ok: true, policy: 'exact' };
  if (p < r) return { ok: false, policy: 'exact', code: 'INSUFFICIENT', shortfallWei: (r - p).toString() };
  return { ok: false, policy: 'exact', code: 'EXCESS', excessWei: (p - r).toString() };
}

module.exports = { ROUTER_ABI, routerInterface, buildLicenseCalldata, requiredValue, classifyValue };
