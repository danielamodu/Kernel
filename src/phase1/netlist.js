'use strict';
/**
 * Minimal TapeOut netlist codec — pure, dependency-free.
 *
 * Byte spec (docs/PROTOCOL.md Section 3.1, from official tapeout.net bundle):
 *   signal 0 = const-0, 1 = const-1, 2..2+nIn-1 = inputs; each gate appends outputs.
 *   NAND 0x00: 00 || u24(a) || u24(b)                                  (7 bytes)
 *   LATCH 0x01: 01 || u24(d)                                           (4 bytes)
 *   REF 0x02: 02 || addr(cpu 20B) || u64(circuitId) || u8(nIns) || u8(nOut)
 *             || u24(ins[nIns])                                         (31 + 3*nIns bytes)
 *             Outputs (nOut) are allocated implicitly, never stored.
 *   All integers big-endian. Forward references (input >= next free signal) reject.
 */

const OP = Object.freeze({ NAND: 0, LATCH: 1, REF: 2 });
const U24_MAX = 0xffffff;

function assertU24(v, what) {
  if (!Number.isInteger(v) || v < 0 || v > U24_MAX) {
    throw new RangeError(`${what} out of u24 range: ${v}`);
  }
}

function pushU24(bytes, v, what = 'signal') {
  assertU24(v, what);
  bytes.push((v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff);
}

function isHexAddress(s) {
  return /^0x[0-9a-fA-F]{40}$/.test(s);
}

/** Encode a gate list to netlist bytes. Gates: {op,a,b,out} | {op,d,out} | {op,cpu,circuitId,ins,nOut}. */
function encode(gates) {
  const bytes = [];
  for (const g of gates) {
    if (g.op === OP.NAND) {
      bytes.push(OP.NAND);
      pushU24(bytes, g.a, 'NAND.a');
      pushU24(bytes, g.b, 'NAND.b');
    } else if (g.op === OP.LATCH) {
      bytes.push(OP.LATCH);
      pushU24(bytes, g.d, 'LATCH.d');
    } else if (g.op === OP.REF) {
      if (!isHexAddress(g.cpu)) throw new Error(`bad REF cpu address: ${g.cpu}`);
      const id = BigInt(g.circuitId);
      if (id < 1n || id > 0xffffffffffffffffn) throw new RangeError(`REF circuitId out of u64 range: ${g.circuitId}`);
      if (!Array.isArray(g.ins) || g.ins.length > 255) throw new RangeError(`REF nIns out of u8 range: ${g.ins?.length}`);
      if (!Number.isInteger(g.nOut) || g.nOut < 0 || g.nOut > 255) throw new RangeError(`REF nOut out of u8 range: ${g.nOut}`);
      bytes.push(OP.REF);
      for (let i = 0; i < 40; i += 2) bytes.push(parseInt(g.cpu.slice(2 + i, 4 + i), 16));
      for (let i = 7; i >= 0; i--) bytes.push(Number((id >> BigInt(i * 8)) & 0xffn));
      bytes.push(g.ins.length, g.nOut);
      for (const s of g.ins) pushU24(bytes, s, 'REF.in');
    } else {
      throw new Error(`unknown opcode ${g.op}`);
    }
  }
  return '0x' + Buffer.from(bytes).toString('hex');
}

/**
 * Decode netlist hex to {gates, refCount, nNand, nLatch}.
 * Attaches `out` (first output signal) / `outs` (REF) as allocated sequentially from 2+nIn.
 * Throws on truncation, unknown opcode, or forward reference.
 */
function decode(netlistHex, nIn) {
  if (typeof netlistHex !== 'string' || !/^0x([0-9a-fA-F]{2})*$/.test(netlistHex)) {
    throw new Error('netlist must be 0x hex');
  }
  if (!Number.isInteger(nIn) || nIn < 0) throw new Error('nIn must be a non-negative integer');
  const raw = Buffer.from(netlistHex.slice(2), 'hex');
  let p = 0;
  let next = 2 + nIn;
  const gates = [];
  const defined = (s) => s >= 0 && s < next;
  const u8 = () => {
    if (p >= raw.length) throw new Error('TRUNCATED_NETLIST');
    return raw[p++];
  };
  const u24 = () => {
    if (p + 3 > raw.length) throw new Error('TRUNCATED_NETLIST');
    const v = (raw[p] << 16) | (raw[p + 1] << 8) | raw[p + 2];
    p += 3;
    return v;
  };
  while (p < raw.length) {
    const op = u8();
    if (op === OP.NAND) {
      const a = u24(); const b = u24();
      if (!defined(a) || !defined(b)) throw new Error(`NAND@${next}: forward reference (a=${a},b=${b})`);
      gates.push({ op, a, b, out: next++ });
    } else if (op === OP.LATCH) {
      const d = u24();
      // NOTE: official decoder allows LATCH.d to reference its own not-yet-allocated
      // output (self-loop); only strictly-future signals are impossible here since d
      // is read before allocation. We permit d <= next (self-loop) to match canvas.
      if (d < 0 || d > next) throw new Error(`LATCH@${next}: signal out of range (d=${d})`);
      gates.push({ op, d, out: next++ });
    } else if (op === OP.REF) {
      if (p + 20 + 8 + 2 > raw.length) throw new Error('TRUNCATED_NETLIST');
      const cpu = '0x' + raw.subarray(p, p + 20).toString('hex');
      p += 20;
      let id = 0n;
      for (let i = 0; i < 8; i++) id = (id << 8n) | BigInt(raw[p++]);
      const nIns = u8(); const nOut = u8();
      const ins = [];
      for (let i = 0; i < nIns; i++) ins.push(u24());
      for (const s of ins) {
        if (!defined(s)) throw new Error(`REF: forward reference (${s})`);
      }
      const outs = [];
      for (let i = 0; i < nOut; i++) outs.push(next++);
      gates.push({ op, cpu, circuitId: id.toString(), ins, nOut, outs });
    } else {
      throw new Error(`unknown opcode 0x${op.toString(16)} at byte ${p - 1}`);
    }
  }
  return {
    gates,
    refCount: gates.filter((g) => g.op === OP.REF).length,
    nNand: gates.filter((g) => g.op === OP.NAND).length,
    nLatch: gates.filter((g) => g.op === OP.LATCH).length,
  };
}

/** Evaluate a NAND/LATCH-only gate list (no REF) over input bits. Returns output bits (last nOut signals). */
function evaluate(gates, nIn, nOut, inputBits) {
  if (!Array.isArray(inputBits) || inputBits.length !== nIn || inputBits.some((b) => b !== 0 && b !== 1)) {
    throw new Error(`${nIn} binary inputs required`);
  }
  if (gates.some((g) => g.op === OP.REF)) throw new Error('evaluate() does not resolve REF; use resolveRef first');
  const sig = [0, 1, ...inputBits];
  for (const g of gates) {
    if (g.op === OP.NAND) sig.push(sig[g.a] & sig[g.b] ? 0 : 1);
    else if (g.op === OP.LATCH) throw new Error('evaluate() is combinational-only; LATCH needs state stepping');
    else throw new Error(`unknown opcode ${g.op}`);
  }
  return sig.slice(sig.length - nOut);
}

/** Full truth table: array of {inputs, outputs} for all 2^nIn rows. */
function truthTable(gates, nIn, nOut) {
  const rows = [];
  for (let v = 0; v < (1 << nIn); v++) {
    const inputs = Array.from({ length: nIn }, (_, i) => (v >> i) & 1);
    rows.push({ inputs, outputs: evaluate(gates, nIn, nOut, inputs) });
  }
  return rows;
}

/**
 * Audit raw netlist bytes against declared (nIn, nOut).
 * Decodes (throwing on any structural defect), then reports:
 * gates by opcode, REF dependency list, transistor usage, I/O mapping.
 * Pure and dependency-free; works on any hex, local or read from chain.
 */
function audit(netlistHex, nIn, nOut) {
  if (!Number.isInteger(nIn) || nIn < 0) throw new Error('nIn must be a non-negative integer');
  if (!Number.isInteger(nOut) || nOut < 1) throw new Error('nOut must be a positive integer');
  const { gates, refCount, nNand, nLatch } = decode(netlistHex, nIn);
  const totalSignals = 2 + nIn + gates.reduce((n, g) => n + (g.op === OP.REF ? g.nOut : 1), 0);
  const outputSignals = [];
  for (let i = 0; i < nOut; i++) outputSignals.push(totalSignals - nOut + i);
  // Every output signal must be produced by some gate (no dangling outputs).
  const produced = new Set();
  for (const g of gates) {
    if (g.op === OP.REF) for (const o of g.outs) produced.add(o);
    else produced.add(g.out);
  }
  const dangling = outputSignals.filter((s) => !produced.has(s));
  if (dangling.length) throw new Error(`dangling output signals: ${dangling.join(',')}`);
  return {
    byteLength: (netlistHex.length - 2) / 2,
    nIn,
    nOut,
    gates: gates.length,
    nNand,
    nLatch,
    refCount,
    refs: gates.filter((g) => g.op === OP.REF).map((g) => ({
      cpu: g.cpu, circuitId: g.circuitId, nIns: g.ins.length, nOut: g.nOut,
    })),
    transistors: { NAND: nNand, LATCH: nLatch },
    inputs: Array.from({ length: nIn }, (_, i) => 2 + i),
    outputs: outputSignals,
  };
}

/**
 * Pack input bits for eval/step calls: bit i of the first byte = input i (LSB-first).
 * Matches the official frontend (`inputsToByte`) and chain-verified behavior
 * (all 16 TRACE rows, docs/PHASE1.md). Returns 0x hex (multi-byte for >8 inputs).
 */
function packInputs(inputs) {
  if (!Array.isArray(inputs) || inputs.some((b) => b !== 0 && b !== 1)) {
    throw new Error('binary input array required');
  }
  const bytes = Buffer.alloc(Math.max(1, Math.ceil(inputs.length / 8)));
  inputs.forEach((b, i) => { if (b) bytes[i >> 3] |= 1 << (i % 8); });
  return '0x' + bytes.toString('hex');
}

/**
 * Unpack an eval/step output byte-string: bit j of the first byte = output j.
 * `rawHex` is the FULL 0x return value (never destructured — see docs/PHASE1.md
 * known issues: `const [raw] = await eval(...)` silently yields '0').
 */
function unpackOutputs(rawHex, nOut) {
  if (typeof rawHex !== 'string' || !/^0x[0-9a-fA-F]*$/.test(rawHex) || rawHex.length < 4) {
    throw new Error(`malformed eval return: ${String(rawHex).slice(0, 20)}`);
  }
  const first = parseInt(rawHex.slice(2, 4), 16);
  return Array.from({ length: nOut }, (_, j) => (first >> j) & 1);
}

module.exports = { OP, encode, decode, evaluate, truthTable, audit, packInputs, unpackOutputs };
