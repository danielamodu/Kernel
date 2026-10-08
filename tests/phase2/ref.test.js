'use strict';
/**
 * tests/phase2/ref.test.js — REF encoder/decoder, byte-for-byte, strict rejection.
 * Run: npm test (offline)
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const {
  REF_OPCODE, refByteLength, isRefGate, encodeRef, decodeRef, parseRefGate,
} = require('../../src/lineage/ref');

const TRACE_PROC = '0x7761ce17a2e75c6910f1d5a77e6f66cd9ca1274a';
// 43-byte documented example (docs/PROTOCOL.md 4.2): REF(TRACE:1, ins=[2,3,4,5], nOut=2)
const EX43 = '0x027761ce17a2e75c6910f1d5a77e6f66cd9ca1274a00000000000000010402000002000003000004000005';
const FIX = (n) => JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', n), 'utf8'));

describe('REF encoding (exact bytes)', () => {
  it('opcode is 0x02 and length rule is 31 + 3*nIns', () => {
    assert.equal(REF_OPCODE, 2);
    assert.equal(refByteLength(0), 31);
    assert.equal(refByteLength(4), 43);
    assert.equal(refByteLength(255), 31 + 3 * 255);
  });

  it('encodes the documented 43-byte example byte-for-byte', () => {
    const got = encodeRef({ processor: TRACE_PROC, circuitId: 1, inputs: [2, 3, 4, 5], nOut: 2 });
    assert.equal(got, EX43);
    assert.equal((got.length - 2) / 2, 43);
  });

  it('round-trips circuitId as bigint and normalizes processor case', () => {
    const g = parseRefGate(encodeRef({ processor: TRACE_PROC.toUpperCase(), circuitId: '7', inputs: [], nOut: 1 }));
    assert.equal(g.processor, TRACE_PROC.toLowerCase());
    assert.equal(g.circuitId, 7n);
    assert.deepEqual(g.inputs, []);
  });

  it('isRefGate detects the opcode only', () => {
    assert.equal(isRefGate(2), true);
    assert.equal(isRefGate('0x02'), true);
    assert.equal(isRefGate(0), false);
    assert.equal(isRefGate(1), false);
    assert.equal(isRefGate('0x00'), false);
    assert.equal(isRefGate('zz'), false);
    assert.equal(isRefGate(null), false);
  });
});

describe('REF decoding (strict)', () => {
  it('decodeRef returns structured data with byte accounting', () => {
    const { gate, bytesConsumed, nextOffset } = decodeRef(EX43);
    assert.deepEqual(gate, {
      type: 'REF', processor: TRACE_PROC, circuitId: 1n, nIns: 4, nOut: 2, inputs: [2, 3, 4, 5],
    });
    assert.equal(bytesConsumed, 43);
    assert.equal(nextOffset, 43);
  });

  it('decodeRef honors byte offsets (second record in a stream)', () => {
    const stream = EX43 + EX43.slice(2); // two concatenated 43B records
    const second = decodeRef(stream, 43);
    assert.equal(second.gate.circuitId, 1n);
    assert.equal(second.bytesConsumed, 43);
    assert.equal(second.nextOffset, 86);
  });

  it('outputs are NOT stored: nOut only sizes implicit allocation', () => {
    // A record claiming nOut=2 with nIns=0 is exactly 31 bytes — no output pins present.
    const rec = encodeRef({ processor: TRACE_PROC, circuitId: 3, inputs: [], nOut: 2 });
    assert.equal((rec.length - 2) / 2, 31);
    assert.equal(parseRefGate(rec).nOut, 2);
  });

  it('rejects every malformed fixture case', () => {
    for (const c of FIX('malformed-ref.json').cases) {
      assert.throws(() => parseRefGate(c.hex), /REF:/, c.name);
    }
  });

  it('rejects every truncated prefix', () => {
    const t = FIX('truncated-ref.json');
    assert.equal(t.full, EX43);
    for (const p of t.prefixes) {
      assert.throws(() => parseRefGate(p), /TRUNCATED/, p);
    }
  });

  it('rejects inconsistent and impossible inputs', () => {
    assert.throws(() => encodeRef({ processor: TRACE_PROC, circuitId: 1, inputs: new Array(256).fill(0), nOut: 1 }), /u8/);
    assert.throws(() => encodeRef({ processor: TRACE_PROC, circuitId: 1, inputs: [2], nOut: 256 }), /u8/);
    assert.throws(() => encodeRef({ processor: TRACE_PROC, circuitId: 1, inputs: [0x1000000], nOut: 1 }), /u24/);
    assert.throws(() => encodeRef({ processor: '0x123', circuitId: 1, inputs: [], nOut: 1 }), /address/);
    assert.throws(() => encodeRef({ processor: TRACE_PROC, circuitId: 2n ** 64n, inputs: [], nOut: 1 }), /u64/);
    assert.throws(() => decodeRef('0x01' + '00'.repeat(40)), /not a REF/);
  });
});
