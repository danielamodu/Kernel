'use strict';
/**
 * tests/phase4/preflight.test.js — offline preflight matrix. Run: npm test.
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { preflight } = require('../../src/router/preflight');
const { MemoryRegistry } = require('../../src/registry/memory');
const { keyHashFor } = require('../../src/registry/client');
const { hashTerms } = require('../../src/registry/terms');
const { computeLineageHash } = require('../../src/router/commitment');

const FIX = (n) => JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'phase2', 'fixtures', n), 'utf8'));
const A = '0x1111111111111111111111111111111111111111';
const B = '0x2222222222222222222222222222222222222222';
const PAYEE = '0x1d207352dd708498cada1524eb4b36b5fa178886';
const BY = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const LIVE_HASH = '0x' + 'ab'.repeat(32);
const TERMS = hashTerms({ version: 1, model: 'single-license', priceWei: '100', currency: 'OKB', attributionRequired: true });
const QUOTE = { mintPriceWei: '1000000000000', protocolFeeWei: '660000000000000' };
const TAPEOUT_FEE = '1300000000000000';

const fixtureFetch = (fix, hash = LIVE_HASH) => {
  const map = { ...(fix.circuits || {}) };
  if (fix.root) map[`${fix.root.processor.toLowerCase()}:${fix.root.circuitId}`] = fix.root;
  return async ({ processor, circuitId }) => {
    const hit = map[`${processor.toLowerCase()}:${circuitId}`];
    return hit ? { ...hit, netlistHash: hash } : null;
  };
};
const memLookup = (mem) => async (slot) => {
  const m = slot.match(/^tapeout:v1:([0-9]+):(0x[0-9a-f]{40}):([0-9]+)$/);
  return mem.getRegistration(keyHashFor({ chainId: m[1], processor: m[2], circuitId: m[3] }));
};
function registerDep(mem, proc, id, over = {}) {
  return mem.register({
    chainId: 196, processor: proc, circuitId: id, netlistHash: LIVE_HASH,
    payee: PAYEE, priceWei: '100', termsHash: TERMS, by: BY, ...over,
  });
}
const codes = (r) => r.failures.map((f) => f.code);

describe('preflight', () => {
  it('valid registered dependency: allowed with totals + lineageHash', async () => {
    const fix = FIX('nested.json');
    const mem = new MemoryRegistry();
    registerDep(mem, A, 1);
    const r = await preflight({
      targetCpu: A, netlist: fix.root.netlist, nIn: 1, nOut: 1,
      fetchCircuit: fixtureFetch(fix), lookupRegistry: memLookup(mem),
      tapeoutFeeWei: TAPEOUT_FEE, mintQuote: QUOTE, chainId: 196,
    });
    assert.equal(r.allowed, true);
    assert.deepEqual(codes(r), []);
    assert.equal(r.totalPriceWei, '100');
    assert.equal(r.dependencies.length, 1);
    assert.equal(r.dependencies[0].hashVerified, true);
    assert.equal(r.manufacture.tapeoutFeeWei, TAPEOUT_FEE);
    // lineageHash equals an independent direct computation.
    assert.equal(r.lineageHash, computeLineageHash({
      targetCpu: A, nIn: 1, nOut: 1, netlist: fix.root.netlist,
      deps: [{
        keyHash: keyHashFor({ chainId: 196, processor: A, circuitId: 1 }),
        netlistHash: LIVE_HASH, payee: PAYEE, priceWei: '100', termsHash: TERMS,
      }],
    }));
  });

  it('unregistered / inactive / mismatch / missing are explicit failures', async () => {
    const fix = FIX('nested.json');
    const base = {
      targetCpu: A, netlist: fix.root.netlist, nIn: 1, nOut: 1,
      fetchCircuit: fixtureFetch(fix), tapeoutFeeWei: TAPEOUT_FEE, mintQuote: QUOTE, chainId: 196,
    };
    assert.deepEqual(codes(await preflight({ ...base, lookupRegistry: memLookup(new MemoryRegistry()) })), ['UNREGISTERED']);

    const memI = new MemoryRegistry();
    const { key } = registerDep(memI, A, 1);
    memI.deactivate({ key, by: BY });
    assert.deepEqual(codes(await preflight({ ...base, lookupRegistry: memLookup(memI) })), ['INACTIVE']);

    const memM = new MemoryRegistry();
    registerDep(memM, A, 1, { netlistHash: '0x' + 'cd'.repeat(32) });
    assert.deepEqual(codes(await preflight({ ...base, lookupRegistry: memLookup(memM) })), ['NETLIST_MISMATCH']);

    const rMiss = await preflight({
      ...base, fetchCircuit: async () => null, lookupRegistry: memLookup(new MemoryRegistry()),
    });
    assert.deepEqual(codes(rMiss), ['MISSING_DEPENDENCY']);
  });

  it('duplicate REF pays once; multiple deps sum; malformed REF fails', async () => {
    const dup = FIX('duplicate-ref.json');
    const mem = new MemoryRegistry();
    registerDep(mem, A, 5);
    const r = await preflight({
      targetCpu: A, netlist: dup.netlist, nIn: 2, nOut: 2,
      // A:5 exposes nIn=1/nOut=1, matching both REF records' pins.
      fetchCircuit: async () => ({ netlist: '0x00000002000002', nIn: 1, nOut: 1, netlistHash: LIVE_HASH }),
      lookupRegistry: memLookup(mem), tapeoutFeeWei: TAPEOUT_FEE, mintQuote: QUOTE, chainId: 196,
    });
    assert.equal(r.totalPriceWei, '100');
    assert.equal(r.allowed, true);

    const cross = FIX('cross-processor.json');
    const mem2 = new MemoryRegistry();
    registerDep(mem2, A, 1, { priceWei: '100' });
    registerDep(mem2, B, 2, { priceWei: '250' });
    const r2 = await preflight({
      targetCpu: A, netlist: cross.netlist, nIn: 2, nOut: 2,
      // Both targets expose 1/1, matching their REF pins.
      fetchCircuit: async () => ({ netlist: '0x00000002000002', nIn: 1, nOut: 1, netlistHash: LIVE_HASH }),
      lookupRegistry: memLookup(mem2), tapeoutFeeWei: TAPEOUT_FEE, mintQuote: QUOTE, chainId: 196,
    });
    assert.equal(r2.allowed, true);
    assert.equal(r2.totalPriceWei, '350');

    const r3 = await preflight({
      targetCpu: A, netlist: '0xff00', nIn: 0, nOut: 1,
      fetchCircuit: async () => null, lookupRegistry: memLookup(mem2),
      tapeoutFeeWei: TAPEOUT_FEE, mintQuote: QUOTE, chainId: 196,
    });
    assert.deepEqual(codes(r3), ['MALFORMED_REF']);
  });

  it('pin mismatch, missing terms, invalid payee/price fail distinctly', async () => {
    const fix = FIX('nested.json');
    const base = {
      targetCpu: A, netlist: fix.root.netlist, nIn: 1, nOut: 1,
      tapeoutFeeWei: TAPEOUT_FEE, mintQuote: QUOTE, chainId: 196,
    };
    // Live dep exposes different pins than the REF declares.
    const rPin = await preflight({
      ...base,
      fetchCircuit: async () => ({ netlist: '0x00', nIn: 9, nOut: 9, netlistHash: LIVE_HASH }),
      lookupRegistry: memLookup(new MemoryRegistry()),
    });
    assert.deepEqual(codes(rPin), ['PIN_MISMATCH']);

    const memT = new MemoryRegistry();
    registerDep(memT, A, 1, { termsHash: '0x' + '00'.repeat(32) });
    assert.deepEqual(codes(await preflight({ ...base, fetchCircuit: fixtureFetch(fix), lookupRegistry: memLookup(memT) })), ['MISSING_TERMS']);

    const stubLookup = (rec) => async () => rec;
    const baseRec = { netlistHash: LIVE_HASH, payee: PAYEE, priceWei: '100', termsHash: TERMS, active: true };
    const rPayee = await preflight({
      ...base, fetchCircuit: fixtureFetch(fix),
      lookupRegistry: stubLookup({ ...baseRec, payee: '0x' + '00'.repeat(20) }),
    });
    assert.deepEqual(codes(rPayee), ['INVALID_PAYEE']);
    const rPrice = await preflight({
      ...base, fetchCircuit: fixtureFetch(fix),
      lookupRegistry: stubLookup({ ...baseRec, priceWei: '-5' }),
    });
    assert.deepEqual(codes(rPrice), ['INVALID_PRICE']);
  });

  it('missing fee quote is an explicit failure, not a silent zero', async () => {
    const fix = FIX('nested.json');
    const mem = new MemoryRegistry();
    registerDep(mem, A, 1);
    const r = await preflight({
      targetCpu: A, netlist: fix.root.netlist, nIn: 1, nOut: 1,
      fetchCircuit: fixtureFetch(fix), lookupRegistry: memLookup(mem), chainId: 196,
    });
    assert.equal(r.allowed, false);
    assert.deepEqual(codes(r), ['FEE_UNKNOWN']);
    assert.equal(r.manufacture, null);
  });
});
