'use strict';
/**
 * tests/phase4/lineage-commitment.test.js — lineageHash determinism + sensitivity.
 * Run: npm test (offline). On-chain equality with the router event is asserted in
 * router.test.js (EVM): JS computeLineageHash == emitted LicensedTapeout.lineageHash.
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { computeLineageHash } = require('../../src/router/commitment');

const TARGET = '0x7761ce17a2e75c6910f1d5a77e6f66cd9ca1274a';
const NL = '0x027761ce17a2e75c6910f1d5a77e6f66cd9ca1274a00000000000000010402000002000003000004000005';
const KEY = '0x' + '11'.repeat(32);
const HASH = '0x' + 'ab'.repeat(32);
const PAYEE = '0x1d207352dd708498cada1524eb4b36b5fa178886';
const TERMS = '0x' + '22'.repeat(32);
const dep = (over = {}) => ({
  keyHash: KEY, netlistHash: HASH, payee: PAYEE, priceWei: '500000000000000', termsHash: TERMS, ...over,
});
const base = (deps = [dep()]) => ({ targetCpu: TARGET, nIn: 4, nOut: 2, netlist: NL, deps });

describe('lineage commitment', () => {
  it('is deterministic (same input twice)', () => {
    assert.equal(computeLineageHash(base()), computeLineageHash(base()));
    assert.match(computeLineageHash(base()), /^0x[0-9a-f]{64}$/);
  });

  it('empty dependency set commits cleanly (pure-manufacture path)', () => {
    const h = computeLineageHash({ ...base([]), targetCpu: TARGET, nIn: 2, nOut: 1, netlist: '0x00000002000003' });
    assert.match(h, /^0x[0-9a-f]{64}$/);
    assert.notEqual(h, computeLineageHash(base()));
  });

  it('order is part of the commitment (first-appearance, netlist order)', () => {
    const d2 = dep({ keyHash: '0x' + '33'.repeat(32), priceWei: '7' });
    const a = computeLineageHash(base([dep(), d2]));
    const b = computeLineageHash(base([d2, dep()]));
    assert.notEqual(a, b); // same set, different order => different commitment
  });

  it('every committed field is load-bearing', () => {
    const h = computeLineageHash(base());
    assert.notEqual(computeLineageHash({ ...base(), targetCpu: PAYEE }), h, 'targetCpu');
    assert.notEqual(computeLineageHash({ ...base(), nIn: 5 }), h, 'nIn');
    assert.notEqual(computeLineageHash({ ...base(), netlist: NL + '00' }), h, 'netlist');
    assert.notEqual(computeLineageHash(base([dep({ priceWei: '1' })])), h, 'price');
    assert.notEqual(computeLineageHash(base([dep({ payee: TARGET })])), h, 'payee');
    assert.notEqual(computeLineageHash(base([dep({ termsHash: '0x' + '44'.repeat(32) })])), h, 'terms');
    assert.notEqual(computeLineageHash(base([dep({ netlistHash: '0x' + 'cd'.repeat(32) })])), h, 'hash');
    assert.notEqual(computeLineageHash(base([dep({ keyHash: '0x' + '55'.repeat(32) })])), h, 'key');
  });

  it('rejects malformed commitment inputs', () => {
    assert.throws(() => computeLineageHash({ ...base(), targetCpu: '0x123' }), /targetCpu/);
    assert.throws(() => computeLineageHash({ ...base(), netlist: '0xzz' }), /netlist/);
    assert.throws(() => computeLineageHash({ ...base(), deps: 'nope' }), /array/);
    assert.throws(() => computeLineageHash(base([dep({ priceWei: 'NaN' })])), /BigInt|price/i);
  });

  it('golden vector pins the commitment (loud break on layout drift)', () => {
    // Computed from the documented layout; if the packing ever changes, this MUST
    // change loudly (and the router contract must change identically).
    assert.equal(
      computeLineageHash(base()),
      '0xab598956bc8a42ae621ecb950ea39781ccb68a0db6bd3ebfbb6ce2cafd91e234',
    );
  });
});
