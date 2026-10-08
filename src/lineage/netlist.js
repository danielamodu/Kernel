'use strict';
/**
 * Raw TapeOut netlist parser — the bytes are the source of truth.
 * Identifies NAND / LATCH / REF gates with byte offsets, so any record can be
 * traced back to its exact position in the stored netlist.
 *
 * Reuses Phase 1's opcode constants (no duplication); this parser additionally
 * tracks offsets/record lengths and emits lineage-shaped gates. A regression test
 * pins its output against Phase 1 `decode()` gate-for-gate.
 */
const { OP } = require('../phase1/netlist');
const { decodeRefAt } = require('./ref');

const U24_MAX = 0xffffff;

function toBytes(netlistHex) {
  if (typeof netlistHex !== 'string' || !/^0[xX]([0-9a-fA-F]{2})*$/.test(netlistHex)) {
    throw new Error(`netlist: malformed hex: ${String(netlistHex).slice(0, 24)}`);
  }
  return Buffer.from(netlistHex.slice(2).toLowerCase(), 'hex');
}

/**
 * Parse a full netlist. Returns:
 * {
 *   gates: [{ index, type:'NAND'|'LATCH'|'REF', offset, length, ...fields }],
 *   refs:  [REF gates in netlist order],
 *   stats: { nand, latch, ref, total }
 * }
 * NAND: {a,b,out}. LATCH: {d,out}. REF: {processor,circuitId:bigint,nIns,nOut,inputs,outs}.
 * `out`/`outs` are allocated sequentially from 2+nIn, exactly as the official decoder.
 * Throws on truncation, unknown opcode, or forward reference — never partial.
 */
function parseNetlist(netlistHex, nIn) {
  if (!Number.isInteger(nIn) || nIn < 0) throw new Error(`netlist: bad nIn: ${nIn}`);
  const buf = toBytes(netlistHex);
  const gates = [];
  const refs = [];
  let p = 0;
  let next = 2 + nIn;
  const defined = (s) => Number.isInteger(s) && s >= 0 && s < next;

  const u24At = (o, what) => {
    if (o + 3 > buf.length) throw new Error(`netlist: truncated ${what} at byte ${o}`);
    return (buf[o] << 16) | (buf[o + 1] << 8) | buf[o + 2];
  };

  while (p < buf.length) {
    const op = buf[p];
    const index = gates.length;
    if (op === OP.NAND) {
      if (p + 7 > buf.length) throw new Error(`netlist: truncated NAND at byte ${p}`);
      const a = u24At(p + 1, 'NAND.a');
      const b = u24At(p + 4, 'NAND.b');
      if (!defined(a) || !defined(b)) throw new Error(`netlist: NAND#${index} forward reference (a=${a},b=${b})`);
      gates.push({ index, type: 'NAND', offset: p, length: 7, a, b, out: next++ });
      p += 7;
    } else if (op === OP.LATCH) {
      if (p + 4 > buf.length) throw new Error(`netlist: truncated LATCH at byte ${p}`);
      // Official decoder imposes NO definedness check on LATCH.d (unlike NAND/REF):
      // d may reference a later signal (e.g. Nandverse #1 opens with LATCH(d=30)).
      // Accept any u24; executors resolve D after the full signal array is built.
      const d = u24At(p + 1, 'LATCH.d');
      gates.push({ index, type: 'LATCH', offset: p, length: 4, d, out: next++ });
      p += 4;
    } else if (op === OP.REF) {
      let rec;
      try {
        rec = decodeRefAt(buf, p);
      } catch (e) {
        throw new Error(`netlist: REF#${index} malformed: ${e.message}`);
      }
      for (const s of rec.gate.inputs) {
        if (!defined(s)) throw new Error(`netlist: REF#${index} forward reference (${s})`);
      }
      const outs = [];
      for (let i = 0; i < rec.gate.nOut; i++) outs.push(next++);
      const g = {
        index, type: 'REF', offset: p, length: rec.bytesConsumed,
        processor: rec.gate.processor, circuitId: rec.gate.circuitId,
        nIns: rec.gate.nIns, nOut: rec.gate.nOut, inputs: rec.gate.inputs, outs,
      };
      gates.push(g);
      refs.push(g);
      p = rec.nextOffset;
    } else {
      throw new Error(`netlist: unknown opcode 0x${op.toString(16)} at byte ${p}`);
    }
  }
  return {
    gates,
    refs,
    stats: {
      nand: gates.filter((g) => g.type === 'NAND').length,
      latch: gates.filter((g) => g.type === 'LATCH').length,
      ref: refs.length,
      total: gates.length,
    },
  };
}

module.exports = { parseNetlist };
