'use strict';
/**
 * tests/phase2/netlist.test.js — raw parser: NAND/LATCH/REF with offsets,
 * plus regression against Phase 1 decode(). Run: npm test (offline)
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { parseNetlist } = require('../../src/lineage/netlist');
const P1 = require('../../src/phase1/netlist');

const FIX = (n) => JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', n), 'utf8'));

describe('raw parser', () => {
  it('parses the AND circuit with exact offsets', () => {
    const p = parseNetlist(FIX('no-ref.json').netlist, 2);
    assert.deepEqual(p.gates, [
      { index: 0, type: 'NAND', offset: 0, length: 7, a: 2, b: 3, out: 4 },
      { index: 1, type: 'NAND', offset: 7, length: 7, a: 4, b: 4, out: 5 },
    ]);
    assert.deepEqual(p.refs, []);
    assert.deepEqual(p.stats, { nand: 2, latch: 0, ref: 0, total: 2 });
  });

  it('parses LATCH with exact offsets', () => {
    // LATCH(2)->4 with nIn=1: 01 000002 (4 bytes).
    const p = parseNetlist('0x01000002', 1);
    assert.deepEqual(p.gates, [{ index: 0, type: 'LATCH', offset: 0, length: 4, d: 2, out: 3 }]);
    assert.deepEqual(p.stats, { nand: 0, latch: 1, ref: 0, total: 1 });
  });

  it('accepts forward LATCH.d like the official decoder (live Nandverse #1 head)', () => {
    // Nandverse circuit #1 opens with LATCH(d=30) while next free signal is 22.
    // Official decoder R() checks definedness for NAND/REF inputs but never for
    // LATCH.d (D resolves after the full signal array is built). Rejecting it
    // misclassified a live mainnet circuit as missing — regression test.
    const p = parseNetlist('0x0100001e', 20);
    assert.equal(p.gates[0].type, 'LATCH');
    assert.equal(p.gates[0].d, 30);
    assert.equal(p.gates[0].out, 22);
  });

  it('parses one REF with outs allocated after prior gates', () => {
    const f = FIX('one-ref.json');
    const p = parseNetlist(f.netlist, f.nIn ?? 2);
    assert.equal(p.gates.length, 2);
    assert.equal(p.gates[0].type, 'NAND');
    const r = p.gates[1];
    assert.equal(r.type, 'REF');
    assert.equal(r.offset, 7);
    assert.equal(r.length, 31 + 3 * 2);
    assert.equal(r.processor, f.expectRefs[0].processor);
    assert.equal(r.circuitId, 7n);
    assert.deepEqual(r.inputs, [2, 4]);
    assert.deepEqual(r.outs, [5]); // next free signal after NAND out=4
    assert.equal(p.refs.length, 1);
  });

  it('parses duplicate REFs as two records, parses cross-processor REFs', () => {
    const d = FIX('duplicate-ref.json');
    const pd = parseNetlist(d.netlist, 2);
    assert.equal(pd.refs.length, 2);
    assert.equal(pd.refs[0].offset, 0);
    assert.equal(pd.refs[1].offset, pd.refs[0].length);
    assert.equal(pd.refs[0].circuitId, pd.refs[1].circuitId);

    const c = FIX('cross-processor.json');
    const pc = parseNetlist(c.netlist, 2);
    assert.equal(pc.refs.length, 2);
    assert.notEqual(pc.refs[0].processor, pc.refs[1].processor);
  });

  it('rejects unknown opcodes, truncation, forward refs with byte positions', () => {
    assert.throws(() => parseNetlist('0xff000002000003', 2), /unknown opcode 0xff at byte 0/);
    assert.throws(() => parseNetlist('0x00000002', 2), /truncated NAND/);
    assert.throws(() => parseNetlist('0x0100', 1), /truncated LATCH/);
    assert.throws(() => parseNetlist('0x00000009000009', 2), /forward reference/);
    assert.throws(() => parseNetlist('0x02', 2), /REF#0 malformed/);
    assert.throws(() => parseNetlist('0x00000002000003', -1), /bad nIn/);
  });
});

describe('regression against Phase 1 decode()', () => {
  for (const [name, nIn] of [['no-ref.json', 2], ['one-ref.json', 2], ['duplicate-ref.json', 2], ['cross-processor.json', 2], ['live-trace-1.json', 4]]) {
    it(`gate-for-gate agreement on ${name}`, () => {
      const f = FIX(name);
      const a = parseNetlist(f.netlist, nIn);
      const b = P1.decode(f.netlist, nIn);
      assert.equal(a.gates.length, b.gates.length);
      assert.equal(a.stats.ref, b.refCount);
      assert.equal(a.stats.nand, b.nNand);
      assert.equal(a.stats.latch, b.nLatch);
      for (let i = 0; i < a.gates.length; i++) {
        const g = a.gates[i];
        const h = b.gates[i];
        assert.equal(g.type, h.op === 0 ? 'NAND' : h.op === 1 ? 'LATCH' : 'REF');
        if (g.type === 'NAND') assert.deepEqual([g.a, g.b, g.out], [h.a, h.b, h.out]);
        if (g.type === 'LATCH') assert.deepEqual([g.d, g.out], [h.d, h.out]);
        if (g.type === 'REF') {
          assert.equal(g.processor, h.cpu);
          assert.equal(g.circuitId.toString(), h.circuitId);
          assert.deepEqual(g.inputs, h.ins);
          assert.deepEqual(g.outs, h.outs);
        }
      }
      // Offsets tile the byte string exactly.
      assert.equal(a.gates.reduce((s, g) => s + g.length, 0), (f.netlist.length - 2) / 2);
    });
  }
});
