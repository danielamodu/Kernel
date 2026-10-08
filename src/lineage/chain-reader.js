'use strict';
/**
 * Read-only X Layer chain reader for lineage resolution.
 *
 * READ ONLY: no signer is ever created, no PRIVATE_KEY is ever read, nothing is
 * sent except eth_call / eth_getCode / eth_getBlockNumber. Reuses Phase 1's RPC
 * configuration and ABIs (dynamically imported; this file stays dependency-free
 * except for the lazily-loaded ethers via chain.mjs).
 *
 * Exports (all async, all read-only):
 *   getChain() -> { chainId, rpcUrl, block }
 *   getProcessor(processor) -> { processor, transistors, nextId, tapeoutFee, factory, isCPU }
 *   getCircuit(processor, circuitId) -> { chainId, processor, circuitId, nIn, nOut,
 *     nState, gateCount, netlist, owner, netlistHash } | null when absent/unreadable
 *   getDirectRefs(processor, circuitId) -> parsed REF gates (via lineage parser)
 *   fetchCircuitForResolver({ chainId, processor, circuitId }) — resolver-compatible
 *     fetch: returns { netlist, nIn, nOut, netlistHash } | null. Throws ONLY on
 *     transport failure; contract-level absence decodes to null (missing).
 */
let chainMod = null;
let lineageMods = null;

async function mods() {
  if (!chainMod) {
    chainMod = await import('../../scripts/phase1/chain.mjs');
    lineageMods = {
      netlist: require('./netlist'),
      identity: require('./identity'),
    };
  }
  return { chain: chainMod, ...lineageMods };
}

function isAbsenceError(e) {
  // eth_call reverts for nonexistent circuits / EOAs without code: clean "missing".
  const msg = String((e && (e.shortMessage || e.message)) || e || '');
  return /revert|CALL_EXCEPTION|missing revert data|bad address|invalid address|BAD_DATA|overflow|timeout/i.test(msg)
    || e?.code === 'CALL_EXCEPTION'
    || e?.code === 'BAD_DATA';
}

async function getChain() {
  const { chain } = await mods();
  chain.loadEnv();
  const { provider, rpcUrl, block } = await chain.getProvider();
  const chainId = Number((await provider.getNetwork()).chainId);
  return { chainId, rpcUrl, block, provider };
}

async function getProcessor(processor) {
  const { chain } = await mods();
  const { ethers } = await import('ethers');
  const { provider } = await getChain();
  const cpu = new ethers.Contract(processor, chain.CIRCUITS_ABI, provider);
  const [transistors, nextId, tapeoutFee, factory, isCPU] = await Promise.all([
    cpu.transistors(), cpu.nextId(), cpu.TAPEOUT_FEE(), cpu.factory(),
    new ethers.Contract(chain.FACTORY, chain.FACTORY_ABI, provider).isCPU(processor),
  ]);
  return {
    processor: ethers.getAddress(processor),
    transistors, nextId: nextId.toString(), tapeoutFee: tapeoutFee.toString(), factory, isCPU,
  };
}

/** Returns circuit data, or null when the circuit is absent/unreadable. */
async function getCircuit(processor, circuitId) {
  const { chain } = await mods();
  const { ethers } = await import('ethers');
  const { provider, chainId } = await getChain();
  if ((await provider.getCode(processor)) === '0x') return null;
  const cpu = new ethers.Contract(processor, chain.CIRCUITS_ABI, provider);
  const id = BigInt(circuitId);
  try {
    const [info, netlist, owner] = await Promise.all([
      cpu.circuitInfo(id), cpu.netlist(id), cpu.ownerOf(id),
    ]);
    return {
      chainId,
      processor: ethers.getAddress(processor),
      circuitId: id.toString(),
      nIn: Number(info[0]),
      nOut: Number(info[1]),
      nState: Number(info[2]),
      gateCount: Number(info[3]),
      netlist,
      owner,
      netlistHash: ethers.keccak256(netlist),
    };
  } catch (e) {
    if (isAbsenceError(e)) return null;
    throw new Error(`chain-reader: transport/read failure: ${e.shortMessage || e.message}`);
  }
}

/** Parsed REF gates of a live circuit (empty array when none; throws if netlist corrupt). */
async function getDirectRefs(processor, circuitId) {
  const { netlist: nl } = await mods();
  const c = await getCircuit(processor, circuitId);
  if (!c) return null; // absent circuit: no refs to report
  return nl.parseNetlist(c.netlist, c.nIn).refs;
}

/** Resolver-compatible fetch over live chain state. Never throws for missing data. */
async function fetchCircuitForResolver({ processor, circuitId }) {
  const c = await getCircuit(processor, circuitId);
  if (!c) return null;
  return { netlist: c.netlist, nIn: c.nIn, nOut: c.nOut, netlistHash: c.netlistHash };
}

module.exports = { getChain, getProcessor, getCircuit, getDirectRefs, fetchCircuitForResolver };
