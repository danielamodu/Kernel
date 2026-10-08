'use strict';
/**
 * Pure input validators for Phase 1 identifiers (no dependencies, no chain).
 * Every function returns { ok, value?, reason? } — never throws on bad input.
 * Chain-existence checks (isCPU, ownerOf, …) belong to verify.mjs, not here.
 */
const { createHash } = require('node:crypto');

function validateProcessor(addr) {
  if (typeof addr !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(addr)) {
    return { ok: false, reason: `not a 0x address: ${String(addr).slice(0, 20)}` };
  }
  if (/^0x0{40}$/i.test(addr)) return { ok: false, reason: 'zero address' };
  return { ok: true, value: addr.toLowerCase() };
}

function validateCircuitId(v) {
  let n;
  try {
    n = typeof v === 'bigint' ? v : BigInt(String(v).trim());
  } catch {
    return { ok: false, reason: `not an integer: ${String(v).slice(0, 20)}` };
  }
  if (n < 1n) return { ok: false, reason: `circuit ids start at 1, got ${n}` };
  if (n > 2n ** 256n - 1n) return { ok: false, reason: 'exceeds uint256' };
  return { ok: true, value: n };
}

function validateTxHash(h) {
  if (typeof h !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(h)) {
    return { ok: false, reason: `not a 0x tx hash: ${String(h).slice(0, 20)}` };
  }
  return { ok: true, value: h.toLowerCase() };
}

function validateNetlistHex(s) {
  if (typeof s !== 'string' || !/^0[xX]([0-9a-fA-F]{2})+$/.test(s)) {
    return { ok: false, reason: 'not even-length 0x hex' };
  }
  const v = '0x' + s.slice(2).toLowerCase();
  return { ok: true, value: v, byteLength: (s.length - 2) / 2 };
}

/** SHA-256 fingerprint of netlist bytes (matches TRACE dist/netlist.json convention). */
function fingerprint(netlistHex) {
  const v = validateNetlistHex(netlistHex);
  if (!v.ok) throw new Error(v.reason);
  return '0x' + createHash('sha256').update(Buffer.from(netlistHex.slice(2), 'hex')).digest('hex');
}

module.exports = { validateProcessor, validateCircuitId, validateTxHash, validateNetlistHex, fingerprint };
