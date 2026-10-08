'use strict';
/**
 * Phase 1 local tests (no chain needed): netlist codec + AND circuit definition.
 * Run: npm test  (node --test tests/phase1/)
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { OP, encode, decode, evaluate, truthTable } = require('../../src/phase1/netlist');
const AND = require('../../src/phase1/circuit');

describe('AND circuit definition', () => {
  it('encodes to the exact 14-byte netlist', () => {
    assert.equal(AND.netlistHex(), '0x0000000200000300000004000004');
    assert.equal((AND.netlistHex().length - 2) / 2, 14);
  });

  it('matches the AND truth table', () => {
    assert.deepEqual(AND.expectedTable(), [
      { inputs: [0, 0], outputs: [0] },
      { inputs: [1, 0], outputs: [0] },
      { inputs: [0, 1], outputs: [0] },
      { inputs: [1, 1], outputs: [1] },
    ]);
  });

  it('uses exactly 2 NAND, 0 LATCH, 0 REF', () => {
    assert.equal(AND.N_NAND, 2);
    assert.equal(AND.N_LATCH, 0);
    const { refCount, nNand, nLatch } = decode(AND.netlistHex(), AND.N_IN);
    assert.equal(refCount, 0);
    assert.equal(nNand, 2);
    assert.equal(nLatch, 0);
  });

  it('round-trips through decode with identical gates', () => {
    const { gates } = decode(AND.netlistHex(), AND.N_IN);
    assert.deepEqual(gates, [
      { op: OP.NAND, a: 2, b: 3, out: 4 },
      { op: OP.NAND, a: 4, b: 4, out: 5 },
    ]);
    assert.equal(encode(gates), AND.netlistHex());
  });
});

describe('codec against independently-known vectors', () => {
  it('decodes the TRACE on-chain circuit #1 netlist (docs/PROTOCOL.md 3.3)', () => {
    // 56 bytes read live from netlist(1) on 0x7761...1274a; must decode to 8 NANDs.
    // verify() re-derives these exact bytes from chain data; this pins the codec.
    const raw = '0x0000000400000400000003000005000000060000070000000700000700000002000008000000020000090000000a00000a0000000b00000b';
    assert.equal((raw.length - 2) / 2, 56);
    const { gates, refCount, nNand, nLatch } = decode(raw, 4);
    assert.equal(gates.length, 8);
    assert.equal(refCount, 0);
    assert.equal(nNand, 8);
    assert.equal(nLatch, 0);
    assert.deepEqual([gates[0].a, gates[0].b], [4, 4]); // NOT fresh
    assert.deepEqual([gates[1].a, gates[1].b], [3, 5]); // NOT (depth AND activity)
    assert.deepEqual([gates[6].a, gates[6].b], [10, 10]); // output buffer
    assert.deepEqual([gates[7].a, gates[7].b], [11, 11]); // output buffer
    assert.equal(encode(gates).toLowerCase(), raw.toLowerCase());
  });

  it('decodes the documented REF record (docs/PROTOCOL.md 4.2)', () => {
    const nl = '0x027761ce17a2e75c6910f1d5a77e6f66cd9ca1274a00000000000000010402000002000003000004000005';
    assert.equal((nl.length - 2) / 2, 43);
    const { gates, refCount, nNand } = decode(nl, 4);
    assert.equal(refCount, 1);
    assert.equal(nNand, 0);
    assert.equal(gates[0].op, OP.REF);
    assert.equal(gates[0].cpu, '0x7761ce17a2e75c6910f1d5a77e6f66cd9ca1274a');
    assert.equal(gates[0].circuitId, '1');
    assert.deepEqual(gates[0].ins, [2, 3, 4, 5]);
    assert.equal(gates[0].nOut, 2);
    assert.deepEqual(gates[0].outs, [6, 7]);
    assert.equal(encode(gates).toLowerCase(), nl.toLowerCase());
  });

  it('evaluates all 16 TRACE truth-table rows locally', () => {
    const raw = '0x0000000400000400000003000005000000060000070000000700000700000002000008000000020000090000000a00000a0000000b00000b';
    const { gates } = decode(raw, 4);
    // discover = valid AND (fresh OR (depth AND act)); showcase = valid AND depth AND act
    for (const { inputs, outputs } of truthTable(gates, 4, 2)) {
      const [v, d, f, a] = inputs;
      const exp = [v && (f || (d && a)) ? 1 : 0, v && d && a ? 1 : 0];
      assert.deepEqual(outputs, exp, `row ${inputs}`);
    }
  });
});

describe('codec rejection (must throw, never silently accept)', () => {
  it('rejects forward references', () => {
    assert.throws(() => decode('0x00000009000009', 2), /forward reference/);
  });
  it('rejects truncation', () => {
    assert.throws(() => decode('0x00000002', 2), /TRUNCATED/);
    assert.throws(() => decode('0x02', 2), /TRUNCATED/);
  });
  it('rejects unknown opcodes', () => {
    assert.throws(() => decode('0xff000002000003', 2), /unknown opcode/);
  });
  it('rejects bad REF addresses and pin counts', () => {
    assert.throws(() => encode([{ op: OP.REF, cpu: '0x123', circuitId: 1, ins: [2], nOut: 1 }]), /bad REF cpu/);
    assert.throws(() => encode([{ op: OP.REF, cpu: '0x7761ce17a2e75c6910f1d5a77e6f66cd9ca1274a', circuitId: 0, ins: [2], nOut: 1 }]), /u64 range/);
  });
  it('rejects non-binary evaluation inputs', () => {
    assert.throws(() => evaluate(AND.GATES, 2, 1, [1]), /binary inputs/);
    assert.throws(() => evaluate(AND.GATES, 2, 1, [2, 0]), /binary inputs/);
  });
});
