'use strict';
/**
 * Deterministic circuit identity.
 *
 * A TapeOut circuit is identified by (chainId, processor, circuitId). Processor
 * address + circuit ID alone are NOT globally unique across chains, so chainId is
 * mandatory. `netlistHash` (keccak256 of the stored netlist bytes, read from chain)
 * distinguishes *content*: same slot + different hash must never happen on a correct
 * chain (netlists are immutable), but the field lets consumers prove what they saw.
 *
 * Canonical form: { chainId:'196', processor:'0x…' (lowercase), circuitId:'1',
 * netlistHash:'0x…'|null }. Key: tapeout:v1:{chain}:{processor}:{id}:{hash|unverified}.
 */
const HASH_RE = /^0x[0-9a-f]{64}$/;

function normChainId(v) {
  let n;
  try {
    n = typeof v === 'bigint' ? v : BigInt(String(v).trim());
  } catch {
    throw new Error(`identity: bad chainId: ${String(v).slice(0, 20)}`);
  }
  if (n < 1n) throw new Error(`identity: bad chainId: ${String(v).slice(0, 20)}`);
  return n.toString(10);
}

function normProcessor(addr) {
  if (typeof addr !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(addr)) {
    throw new Error(`identity: bad processor: ${String(addr).slice(0, 24)}`);
  }
  if (/^0x0{40}$/i.test(addr)) throw new Error('identity: processor is zero address');
  return addr.toLowerCase();
}

function normCircuitId(v) {
  let n;
  try {
    n = typeof v === 'bigint' ? v : BigInt(String(v).trim());
  } catch {
    throw new Error(`identity: bad circuitId: ${String(v).slice(0, 24)}`);
  }
  if (n < 1n) throw new Error(`identity: circuit ids start at 1, got ${n}`);
  return n.toString(10);
}

function normHash(h) {
  if (h === null || h === undefined) return null;
  if (typeof h !== 'string' || !HASH_RE.test(h.toLowerCase())) {
    throw new Error(`identity: bad netlistHash (want 0x + 64 hex): ${String(h).slice(0, 24)}`);
  }
  return h.toLowerCase();
}

function makeIdentity({ chainId, processor, circuitId, netlistHash = null }) {
  return Object.freeze({
    chainId: normChainId(chainId),
    processor: normProcessor(processor),
    circuitId: normCircuitId(circuitId),
    netlistHash: normHash(netlistHash),
  });
}

function identityKey(id) {
  const c = makeIdentity(id); // re-normalize: same input → same key, always
  return `tapeout:v1:${c.chainId}:${c.processor}:${c.circuitId}:${c.netlistHash ?? 'unverified'}`;
}

/** Slot key: same on-chain slot regardless of observed content. */
function slotKey(id) {
  const c = makeIdentity({ ...id, netlistHash: null });
  return `tapeout:v1:${c.chainId}:${c.processor}:${c.circuitId}`;
}

function parseIdentityKey(key) {
  const m = typeof key === 'string' && key.match(/^tapeout:v1:([0-9]+):(0x[0-9a-f]{40}):([0-9]+):(0x[0-9a-f]{64}|unverified)$/);
  if (!m) throw new Error(`identity: bad key: ${String(key).slice(0, 60)}`);
  return makeIdentity({
    chainId: m[1], processor: m[2], circuitId: m[3],
    netlistHash: m[4] === 'unverified' ? null : m[4],
  });
}

/** Same on-chain slot (chain + processor + id), ignoring content hash. */
function equalSlot(a, b) {
  return slotKey(a) === slotKey(b);
}

/** Same slot AND same observed content (both hashes present and equal). */
function equalExact(a, b) {
  const x = makeIdentity(a);
  const y = makeIdentity(b);
  return x.netlistHash !== null && x.netlistHash === y.netlistHash && equalSlot(x, y);
}

/**
 * Parse a slot key (`tapeout:v1:{chain}:{processor}:{id}`, no hash segment).
 * Backward-compatible ADDITION (Phase 3): no existing function changed.
 */
function parseSlotKey(key) {
  const m = typeof key === 'string' && key.match(/^tapeout:v1:([0-9]+):(0x[0-9a-f]{40}):([0-9]+)$/);
  if (!m) throw new Error(`identity: bad slot key: ${String(key).slice(0, 60)}`);
  return { chainId: m[1], processor: m[2], circuitId: m[3] };
}

module.exports = { makeIdentity, identityKey, slotKey, parseIdentityKey, parseSlotKey, equalSlot, equalExact };
