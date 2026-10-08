'use strict';
/**
 * REF gate codec — pure, dependency-free, byte-exact.
 *
 * Verified format (docs/PROTOCOL.md 3.1/4.2, official tapeout.net bundle decoder):
 *   0x02 || cpu:20B || circuitId:u64 BE || nIns:u8 || nOut:u8 || ins: nIns*u24 BE
 *   total = 31 + 3*nIns bytes. Outputs are ALLOCATED implicitly (never stored).
 *
 * DIVERGENCE NOTE: the Phase 2 brief describes trailing `nOut * uint24` output pins.
 * That is incorrect per the verified on-chain format and the official decoder `R`,
 * which assigns `outs` sequentially (`for u<g: d.push(i++)`). This module implements
 * the verified bytes. See docs/PHASE2.md ("protocol ambiguities").
 */

const REF_OPCODE = 0x02;
const U64_MAX = 0xffffffffffffffffn;

function fail(why) {
  throw new Error(`REF: ${why}`);
}

function checkAddress(cpu) {
  if (typeof cpu !== 'string' || !/^0[xX][0-9a-fA-F]{40}$/.test(cpu)) fail(`invalid processor address: ${String(cpu).slice(0, 24)}`);
  const norm = '0x' + cpu.slice(2).toLowerCase();
  if (/^0x0{40}$/.test(norm)) fail('processor address is zero (unresolvable)');
  return norm;
}

function checkCircuitId(id) {
  let n;
  try {
    n = typeof id === 'bigint' ? id : BigInt(String(id).trim());
  } catch {
    fail(`invalid circuit id: ${String(id).slice(0, 24)}`);
  }
  if (n < 1n) fail(`circuit ids start at 1, got ${n}`);
  if (n > U64_MAX) fail(`circuit id exceeds u64: ${n}`);
  return n;
}

function checkU8(v, what) {
  if (!Number.isInteger(v) || v < 0 || v > 255) fail(`${what} out of u8 range: ${v}`);
  return v;
}

function checkU24(v, what) {
  if (!Number.isInteger(v) || v < 0 || v > 0xffffff) fail(`${what} out of u24 range: ${v}`);
  return v;
}

function toBytes(netlistHex) {
  if (typeof netlistHex !== 'string' || !/^0[xX]([0-9a-fA-F]{2})*$/.test(netlistHex)) {
    fail(`malformed hex: ${String(netlistHex).slice(0, 24)}`);
  }
  return Buffer.from(netlistHex.slice(2).toLowerCase(), 'hex');
}

/** Exact record length for a REF with nIns input pins. */
function refByteLength(nIns) {
  return 31 + 3 * checkU8(nIns, 'nIns');
}

/** True iff the byte value is the REF opcode. Accepts a number or 0x-hex. */
function isRefGate(v) {
  if (typeof v === 'number') return v === REF_OPCODE;
  if (typeof v === 'string' && /^0[xX][0-9a-fA-F]{2}$/.test(v)) return parseInt(v.slice(2), 16) === REF_OPCODE;
  return false;
}

/**
 * Encode one REF gate. `inputs` = array of u24 signal indices (length = nIns).
 * Returns 0x hex of exactly 31 + 3*inputs.length bytes.
 */
function encodeRef({ processor, circuitId, inputs, nOut }) {
  const cpu = checkAddress(processor);
  const id = checkCircuitId(circuitId);
  if (!Array.isArray(inputs)) fail('inputs must be an array of u24 signal indices');
  if (inputs.length > 255) fail(`nIns out of u8 range: ${inputs.length}`);
  const nO = checkU8(nOut, 'nOut');
  const bytes = [REF_OPCODE];
  for (let i = 0; i < 40; i += 2) bytes.push(parseInt(cpu.slice(2 + i, 4 + i), 16));
  for (let i = 7; i >= 0; i--) bytes.push(Number((id >> BigInt(i * 8)) & 0xffn));
  bytes.push(inputs.length, nO);
  for (const s of inputs) {
    checkU24(s, 'REF.in');
    bytes.push((s >>> 16) & 0xff, (s >>> 8) & 0xff, s & 0xff);
  }
  return '0x' + Buffer.from(bytes).toString('hex');
}

/**
 * Decode ONE REF record from `buf` at `offset`.
 * Returns { gate, bytesConsumed, nextOffset }. Throws on ANY defect; never partial.
 * `gate` = { type:'REF', processor, circuitId:bigint, nIns, nOut, inputs }.
 * (Output signals are NOT stored; the netlist parser assigns them sequentially.)
 */
function decodeRefAt(buf, offset) {
  if (!Buffer.isBuffer(buf)) fail('decodeRefAt needs a Buffer');
  if (!Number.isInteger(offset) || offset < 0 || offset >= buf.length) fail(`offset out of range: ${offset}`);
  const failAt = (why) => fail(`${why} (offset ${offset})`);
  if (buf[offset] !== REF_OPCODE) failAt(`not a REF record (opcode 0x${buf[offset].toString(16)})`);
  const need = (n, what) => {
    if (offset + n > buf.length) failAt(`TRUNCATED_REF ${what}: need ${n}B, have ${buf.length - offset}B`);
  };
  need(1 + 20 + 8 + 2, 'header');
  const cpu = '0x' + buf.subarray(offset + 1, offset + 21).toString('hex');
  if (/^0x0{40}$/.test(cpu)) failAt('processor address is zero (unresolvable)');
  let id = 0n;
  for (let i = 0; i < 8; i++) id = (id << 8n) | BigInt(buf[offset + 21 + i]);
  if (id < 1n) failAt('circuit id is 0 (ids start at 1)');
  const nIns = buf[offset + 29];
  const nOut = buf[offset + 30];
  need(31 + 3 * nIns, `pins (nIns=${nIns})`);
  const inputs = [];
  for (let i = 0; i < nIns; i++) {
    const o = offset + 31 + 3 * i;
    inputs.push((buf[o] << 16) | (buf[o + 1] << 8) | buf[o + 2]);
  }
  return {
    gate: { type: 'REF', processor: cpu, circuitId: id, nIns, nOut, inputs },
    bytesConsumed: 31 + 3 * nIns,
    nextOffset: offset + 31 + 3 * nIns,
  };
}

/** Decode one REF record from 0x hex at byte `offset` (default 0). */
function decodeRef(netlistHex, offset = 0) {
  return decodeRefAt(toBytes(netlistHex), offset);
}

/**
 * Parse a hex string that must consist of EXACTLY one complete REF record.
 * Rejects leading-garbage (first byte != 0x02) and trailing bytes.
 */
function parseRefGate(netlistHex) {
  const buf = toBytes(netlistHex);
  if (buf.length === 0) fail('empty input');
  if (buf[0] !== REF_OPCODE) fail(`not a REF record (opcode 0x${buf[0].toString(16)})`);
  const { gate, bytesConsumed } = decodeRefAt(buf, 0);
  if (bytesConsumed !== buf.length) {
    fail(`trailing bytes: REF record is ${bytesConsumed}B but input is ${buf.length}B`);
  }
  return gate;
}

module.exports = {
  REF_OPCODE, refByteLength, isRefGate, encodeRef, decodeRef, decodeRefAt, parseRefGate,
};
