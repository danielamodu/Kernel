'use strict';
/**
 * tests/phase3/attribution.test.js — lineage → registry join.
 * Run: npm test (offline; memory registry + fixtures stand in for chain)
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { resolveLineage } = require('../../src/lineage/resolver');
const { slotKey } = require('../../src/lineage/identity');
const { MemoryRegistry } = require('../../src/registry/memory');
const { keyHashFor } = require('../../src/registry/client');
const { hashTerms } = require('../../src/registry/terms');
const { attributeLineage, compareRegistration } = require('../../src/registry/attribution');

const FIX = (n) => JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'phase2', 'fixtures', n), 'utf8'));
const A = '0x1111111111111111111111111111111111111111';
const B = '0x2222222222222222222222222222222222222222';
const C = '0x3333333333333333333333333333333333333333';
const PAYEE = '0x1d207352dd708498cada1524eb4b36b5fa178886';
const BY = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const LIVE_HASH = '0x' + 'ab'.repeat(32);
const OTHER_HASH = '0x' + 'cd'.repeat(32);
const TERMS = hashTerms({ version: 1, model: 'single-license', priceWei: '100', currency: 'OKB', attributionRequired: true });

const slot = (proc, id) => slotKey({ chainId: 196, processor: proc, circuitId: id });
// Tiny readable dependency: 1-gate NOT (NAND(2,2)), nIn=1. Readable => verifiable.
const TINY = '0x00000002000002';
const tinyDep = (hash = LIVE_HASH) => ({ netlist: TINY, nIn: 1, nOut: 1, netlistHash: hash });
const fixtureFetch = (fix, hash = LIVE_HASH) => {
  const map = { ...(fix.circuits || {}) };
  if (fix.root) map[`${fix.root.processor.toLowerCase()}:${fix.root.circuitId}`] = fix.root;
  return async ({ processor, circuitId }) => {
    const hit = map[`${processor.toLowerCase()}:${circuitId}`];
    return hit ? { ...hit, netlistHash: hash } : null;
  };
};
const lookupOf = (mem) => async (slotStr) => {
  const m = slotStr.match(/^tapeout:v1:([0-9]+):(0x[0-9a-f]{40}):([0-9]+)$/);
  const rec = mem.getRegistration(keyHashFor({ chainId: m[1], processor: m[2], circuitId: m[3] }));
  return rec; // null when unregistered — explicit, never licensed-by-default
};
function registerDep(mem, proc, id, over = {}) {
  return mem.register({
    chainId: 196, processor: proc, circuitId: id, netlistHash: LIVE_HASH,
    payee: PAYEE, priceWei: '100', termsHash: TERMS, by: BY, ...over,
  });
}

describe('attribution join', () => {
  it('registered dependency resolves with terms', async () => {
    const fix = FIX('nested.json');
    const mem = new MemoryRegistry();
    registerDep(mem, A, 1);
    const lin = await resolveLineage(
      { processor: fix.root.processor, circuitId: fix.root.circuitId },
      { fetchCircuit: fixtureFetch(fix), chainId: 196 },
    );
    // Resolver nodes lack hashes here (fixture fetch supplies LIVE_HASH — set on nodes).
    const attr = await attributeLineage(lin, { lookup: lookupOf(mem) });
    const m1 = attr.dependencies.find((d) => d.slotKey === slot(A, 1));
    assert.equal(m1.status, 'registered');
    assert.equal(m1.registered, true);
    assert.equal(m1.payee, PAYEE.toLowerCase());
    assert.equal(m1.priceWei, '100');
    assert.equal(m1.termsHash, TERMS);
    const m2 = attr.dependencies.find((d) => d.slotKey === slot(B, 2));
    assert.equal(m2.status, 'unregistered');
    assert.equal(m2.registered, false);
    assert.equal(attr.stats.total, 2);
  });

  it('unregistered dependency is explicit (never licensed-by-default)', async () => {
    const fix = FIX('nested.json');
    const mem = new MemoryRegistry(); // empty
    const lin = await resolveLineage(
      { processor: fix.root.processor, circuitId: fix.root.circuitId },
      { fetchCircuit: fixtureFetch(fix), chainId: 196 },
    );
    const attr = await attributeLineage(lin, { lookup: lookupOf(mem) });
    assert.ok(attr.dependencies.every((d) => d.status === 'unregistered' && d.registered === false));
  });

  it('inactive dependency is explicit and distinct', async () => {
    const fix = FIX('nested.json');
    const mem = new MemoryRegistry();
    const { key } = registerDep(mem, A, 1);
    mem.deactivate({ key, by: BY });
    const lin = await resolveLineage(
      { processor: fix.root.processor, circuitId: fix.root.circuitId },
      { fetchCircuit: fixtureFetch(fix), chainId: 196 },
    );
    const attr = await attributeLineage(lin, { lookup: lookupOf(mem) });
    const m1 = attr.dependencies.find((d) => d.slotKey === slot(A, 1));
    assert.equal(m1.status, 'inactive');
    assert.equal(m1.registered, false);
    assert.equal(m1.payee, PAYEE.toLowerCase()); // terms still visible for reference
  });

  it('netlist mismatch is explicit (record NOT trusted)', async () => {
    const fix = FIX('nested.json');
    const mem = new MemoryRegistry();
    registerDep(mem, A, 1, { netlistHash: OTHER_HASH }); // record claims different content
    const lin = await resolveLineage(
      { processor: fix.root.processor, circuitId: fix.root.circuitId },
      { fetchCircuit: fixtureFetch(fix), chainId: 196 }, // live says LIVE_HASH
    );
    const attr = await attributeLineage(lin, { lookup: lookupOf(mem) });
    const m1 = attr.dependencies.find((d) => d.slotKey === slot(A, 1));
    assert.equal(m1.status, 'mismatch');
    assert.equal(m1.registered, false);
    assert.equal(m1.recordNetlistHash, OTHER_HASH.toLowerCase());
    assert.equal(m1.liveNetlistHash, LIVE_HASH.toLowerCase());
  });

  it('duplicate REF dependency is deduplicated to one summary entry', async () => {
    const f = FIX('duplicate-ref.json');
    const mem = new MemoryRegistry();
    registerDep(mem, A, 5);
    const lin = await resolveLineage(
      { processor: A, circuitId: 70 },
      {
        fetchCircuit: async (ref) => String(ref.circuitId) === '70'
          ? { netlist: f.netlist, nIn: 2, nOut: 2, netlistHash: LIVE_HASH }
          : tinyDep(), // shared target is live-readable => hash-verifiable
        chainId: 196,
      },
    );
    assert.equal(lin.edges.length, 2); // lineage keeps both edges...
    const attr = await attributeLineage(lin, { lookup: lookupOf(mem) });
    assert.equal(attr.dependencies.length, 1); // ...attribution dedups
    assert.equal(attr.dependencies[0].status, 'registered');
  });

  it('nested lineage + cross-processor deps resolve end to end', async () => {
    const fix = FIX('nested.json');
    const mem = new MemoryRegistry();
    registerDep(mem, A, 1);
    registerDep(mem, B, 2);
    const lin = await resolveLineage(
      { processor: fix.root.processor, circuitId: fix.root.circuitId },
      { fetchCircuit: fixtureFetch(fix), chainId: 196 },
    );
    const attr = await attributeLineage(lin, { lookup: lookupOf(mem) });
    assert.deepEqual(attr.stats.byStatus, { registered: 2 });
    // Cross-processor variant on the raw fixture shape.
    const cross = FIX('cross-processor.json');
    const lin2 = await resolveLineage(
      { processor: A, circuitId: 80 },
      {
        fetchCircuit: async (ref) => String(ref.circuitId) === '80'
          ? { netlist: cross.netlist, nIn: 2, nOut: 2, netlistHash: LIVE_HASH }
          : tinyDep(), // both cross-processor targets live-readable
        chainId: 196,
      },
    );
    const attr2 = await attributeLineage(lin2, { lookup: lookupOf(mem) });
    const statuses = Object.fromEntries(attr2.dependencies.map((d) => [d.slotKey, d.status]));
    assert.equal(statuses[slot(A, 1)], 'registered');
    assert.equal(statuses[slot(B, 2)], 'registered');
  });

  it('missing/live-unreadable deps are unknown, root never self-depends', async () => {
    const fix = FIX('missing-dep.json');
    const mem = new MemoryRegistry();
    const lin = await resolveLineage(
      { processor: fix.root.processor, circuitId: fix.root.circuitId },
      { fetchCircuit: fixtureFetch(fix), chainId: 196 },
    );
    const attr = await attributeLineage(lin, { lookup: lookupOf(mem) });
    assert.equal(attr.dependencies.length, 1);
    assert.equal(attr.dependencies[0].status, 'unknown');
    assert.match(attr.dependencies[0].reason, /missing/);
    assert.ok(!attr.dependencies.some((d) => d.slotKey === lin.root));
  });

  it('compareRegistration unit matrix (+ root registration reporting)', async () => {
    const live = { chainId: 196, processor: A, circuitId: 1, liveNetlistHash: LIVE_HASH };
    assert.deepEqual(compareRegistration(live, null), { registered: false, status: 'unregistered' });
    const rec = { netlistHash: LIVE_HASH, payee: PAYEE, priceWei: '100', termsHash: TERMS, active: true };
    const ok = compareRegistration(live, rec);
    assert.equal(ok.status, 'registered');
    assert.equal(ok.hashVerified, true);
    assert.equal(
      compareRegistration(live, { ...rec, active: false }).status, 'inactive',
    );
    assert.equal(
      compareRegistration(live, { ...rec, netlistHash: OTHER_HASH }).status, 'mismatch',
    );
    assert.equal(compareRegistration({ ...live, liveNetlistHash: null }, rec).hashVerified, false);
    // Root registration rides along in the join.
    const fix = FIX('nested.json');
    const mem = new MemoryRegistry();
    registerDep(mem, C, 9);
    const lin = await resolveLineage(
      { processor: fix.root.processor, circuitId: fix.root.circuitId },
      { fetchCircuit: fixtureFetch(fix), chainId: 196 },
    );
    const attr = await attributeLineage(lin, { lookup: lookupOf(mem) });
    assert.equal(attr.rootRegistration.status, 'registered');
  });
});
