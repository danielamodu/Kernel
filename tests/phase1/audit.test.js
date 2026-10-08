'use strict';
/**
 * Phase 1 audit/validator tests (no chain needed).
 * Run: npm test
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { audit, packInputs, unpackOutputs } = require('../../src/phase1/netlist');
const {
  validateProcessor, validateCircuitId, validateTxHash, validateNetlistHex, fingerprint,
} = require('../../src/phase1/validate');
const AND = require('../../src/phase1/circuit');

const TRACE_NL = '0x0000000400000400000003000005000000060000070000000700000700000002000008000000020000090000000a00000a0000000b00000b';
const TRACE_PROC = '0x7761cE17a2e75C6910f1D5a77E6F66CD9Ca1274a';
const REF_NL = '0x027761ce17a2e75c6910f1d5a77e6f66cd9ca1274a00000000000000010402000002000003000004000005';

describe('auditNetlist (raw bytes)', () => {
  it('audits the AND circuit: 2 NAND, 0 LATCH, 0 REF, exact I/O map', () => {
    assert.deepEqual(audit(AND.netlistHex(), 2, 1), {
      byteLength: 14,
      nIn: 2,
      nOut: 1,
      gates: 2,
      nNand: 2,
      nLatch: 0,
      refCount: 0,
      refs: [],
      transistors: { NAND: 2, LATCH: 0 },
      inputs: [2, 3],
      outputs: [5],
    });
  });

  it('audits the TRACE on-chain circuit: 8 NAND, 56 bytes, outputs [12,13]', () => {
    const a = audit(TRACE_NL, 4, 2);
    assert.equal(a.byteLength, 56);
    assert.equal(a.gates, 8);
    assert.deepEqual(a.transistors, { NAND: 8, LATCH: 0 });
    assert.equal(a.refCount, 0);
    assert.deepEqual(a.inputs, [2, 3, 4, 5]);
    assert.deepEqual(a.outputs, [12, 13]);
  });

  it('identifies REF gates with cpu/circuitId/pins', () => {
    const a = audit(REF_NL, 4, 2);
    assert.equal(a.refCount, 1);
    assert.deepEqual(a.refs, [{
      cpu: TRACE_PROC.toLowerCase(), circuitId: '1', nIns: 4, nOut: 2,
    }]);
    assert.deepEqual(a.transistors, { NAND: 0, LATCH: 0 }); // REF burns no material
    assert.deepEqual(a.outputs, [6, 7]);
  });

  it('rejects dangling outputs and bad dimensions without throwing raw codec errors', () => {
    // 1 gate but nOut=2: output signal 5 is never produced.
    assert.throws(() => audit('0x00000002000003', 2, 2), /dangling output/);
    assert.throws(() => audit(AND.netlistHex(), -1, 1), /nIn/);
    assert.throws(() => audit(AND.netlistHex(), 2, 0), /nOut/);
    // Structurally broken bytes still surface as decode errors.
    assert.throws(() => audit('0x00000009000009', 2, 1), /forward reference/);
  });
});

describe('validators', () => {
  it('validateProcessor accepts 0x addresses, rejects garbage and zero', () => {
    assert.equal(validateProcessor(TRACE_PROC).ok, true);
    assert.equal(validateProcessor(TRACE_PROC).value, TRACE_PROC.toLowerCase());
    assert.equal(validateProcessor('0x123').ok, false);
    assert.equal(validateProcessor('7761ce17a2e75c6910f1d5a77e6f66cd9ca1274a').ok, false);
    assert.equal(validateProcessor('0x0000000000000000000000000000000000000000').ok, false);
    assert.equal(validateProcessor('').ok, false);
    assert.equal(validateProcessor(null).ok, false);
  });

  it('validateCircuitId accepts >= 1, rejects 0 / negative / non-integers', () => {
    assert.deepEqual(validateCircuitId(1), { ok: true, value: 1n });
    assert.deepEqual(validateCircuitId('11'), { ok: true, value: 11n });
    assert.equal(validateCircuitId(0).ok, false);
    assert.equal(validateCircuitId(-3).ok, false);
    assert.equal(validateCircuitId('abc').ok, false);
    assert.equal(validateCircuitId('1.5').ok, false);
    assert.equal(validateCircuitId('').ok, false);
  });

  it('validateTxHash enforces 0x + 64 hex', () => {
    const good = '0xf93f8803387a747c83ada2b4f69d977f674be2059b229b06a6227d7dd9e8510c';
    assert.equal(validateTxHash(good).ok, true);
    assert.equal(validateTxHash('0x123').ok, false);
    assert.equal(validateTxHash(good.slice(2)).ok, false);
  });

describe('eval bit-packing (regression: never destructure a bytes return)', () => {
  it('packInputs is LSB-first, multi-byte safe', () => {
    assert.equal(packInputs([1, 0, 1, 0]), '0x05');
    assert.equal(packInputs([0, 0]), '0x00');
    assert.equal(packInputs([1, 1, 1, 1]), '0x0f');
    // 10 inputs → 2 bytes, bit 8 and 9 set.
    assert.equal(packInputs([0, 0, 0, 0, 0, 0, 0, 0, 1, 1]), '0x0003');
    assert.throws(() => packInputs([2, 0]), /binary/);
  });

  it('unpackOutputs reads bit j as output j from the FULL return value', () => {
    assert.deepEqual(unpackOutputs('0x01', 2), [1, 0]);
    assert.deepEqual(unpackOutputs('0x03', 2), [1, 1]);
    assert.deepEqual(unpackOutputs('0x00', 1), [0]);
    // The original bug: `const [raw] = '0x01'` yields '0' and silently verifies nothing.
    assert.notEqual('0x01'[0], '0x01');
    assert.deepEqual(unpackOutputs('0x01'[0] === '0' ? '0x01' : '0x00', 1), [1]);
    assert.throws(() => unpackOutputs('0x', 1), /malformed/);
    assert.throws(() => unpackOutputs('zz', 1), /malformed/);
  });
});
  it('validateNetlistHex + fingerprint are deterministic', () => {
    assert.equal(validateNetlistHex(AND.netlistHex()).byteLength, 14);
    assert.equal(validateNetlistHex('0x123').ok, false);
    const f1 = fingerprint(AND.netlistHex());
    const f2 = fingerprint(AND.netlistHex().toUpperCase());
    assert.equal(f1, f2);
    assert.match(f1, /^0x[0-9a-f]{64}$/);
  });
});
