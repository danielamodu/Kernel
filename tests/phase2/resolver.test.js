'use strict';
/**
 * tests/phase2/resolver.test.js — lineage closure: nested/dup/cross/cycle/depth/missing.
 * Run: npm test (offline; fixtures stand in for chain reads)
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { resolveLineage } = require('../../src/lineage/resolver');
const { slotKey } = require('../../src/lineage/identity');

const FIX = (n) => JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', n), 'utf8'));
const slot = (proc, id, chain = 196) => slotKey({ chainId: chain, processor: proc, circuitId: id });

/** fetch serving a fixture's root + circuits map; unknown slots => null (missing). */
const fixtureFetch = (fix) => {
  const map = { ...(fix.circuits || {}) };
  if (fix.root) map[`${fix.root.processor.toLowerCase()}:${fix.root.circuitId}`] = fix.root;
  return async ({ processor, circuitId }) => map[`${processor.toLowerCase()}:${circuitId}`] ?? null;
};
const A = '0x1111111111111111111111111111111111111111';
const B = '0x2222222222222222222222222222222222222222';
const C = '0x3333333333333333333333333333333333333333';

describe('lineage resolver', () => {
  it('resolves nested R -> M1 -> M2 with transitive closure', async () => {
    const fix = FIX('nested.json');
    const r = await resolveLineage(
      { processor: fix.root.processor, circuitId: fix.root.circuitId },
      { fetchCircuit: fixtureFetch(fix), chainId: 196 },
    );
    assert.equal(r.nodes.length, 3);
    assert.equal(r.edges.length, 2);
    assert.deepEqual(r.directDependencies, [slot(A, 1)]);
    assert.deepEqual(r.transitiveDependencies, [slot(B, 2)]);
    assert.equal(r.depth, 2);
    assert.deepEqual(r.cycles, []);
    assert.deepEqual(r.missing, []);
    assert.deepEqual(r.stats, {
      nodeCount: 3, edgeCount: 2, nandCount: 1, latchCount: 0, refCount: 2,
      uniqueDependencies: 2, cycles: 0, missing: 0, truncated: 0,
    });
  });

  it('deduplicates: two REF records => one node, two edges', async () => {
    const f = FIX('duplicate-ref.json');
    const fetch = async () => null; // dependency content irrelevant to dedup shape
    const r = await resolveLineage(
      { processor: A, circuitId: 50 },
      {
        fetchCircuit: async (ref) => {
          if (String(ref.circuitId) === '50') return { netlist: f.netlist, nIn: 2, nOut: 2 };
          return fetch(ref);
        },
        chainId: 196,
      },
    );
    assert.equal(r.nodes.length, 2); // root + one B node
    assert.equal(r.edges.length, 2);
    assert.equal(r.edges[0].to, r.edges[1].to);
    assert.notEqual(r.edges[0].refIndex, r.edges[1].refIndex);
    assert.equal(r.missing.length, 1); // the shared target is unreadable — recorded once
  });

  it('supports cross-processor references', async () => {
    const f = FIX('cross-processor.json');
    const r = await resolveLineage(
      { processor: A, circuitId: 60 },
      {
        fetchCircuit: async (ref) => {
          if (String(ref.circuitId) === '60') return { netlist: f.netlist, nIn: 2, nOut: 2 };
          return null;
        },
        chainId: 196,
      },
    );
    assert.equal(r.directDependencies.length, 2);
    assert.ok(r.directDependencies.includes(slot(A, 1)));
    assert.ok(r.directDependencies.includes(slot(B, 2)));
    assert.equal(r.missing.length, 2);
  });

  it('terminates on A -> B -> C -> A and reports the cycle path', async () => {
    const fix = FIX('cycle.json');
    const r = await resolveLineage(
      { processor: fix.root.processor, circuitId: fix.root.circuitId },
      { fetchCircuit: fixtureFetch(fix), chainId: 196 },
    );
    assert.equal(r.cycles.length, 1);
    assert.deepEqual(r.cycles[0], [slot(A, 1), slot(B, 1), slot(C, 1), slot(A, 1)]);
    assert.equal(r.nodes.length, 3); // no infinite expansion
    assert.ok(r.nodes.every((n) => n.status === 'resolved'));
  });

  it('enforces maxDepth explicitly (chain of 6, limit 2)', async () => {
    const fix = FIX('depth-chain.json');
    const r = await resolveLineage(
      { processor: fix.root.processor, circuitId: fix.root.circuitId },
      { fetchCircuit: fixtureFetch(fix), chainId: 196, maxDepth: fix.maxDepth },
    );
    assert.equal(r.depth, 3);
    assert.deepEqual(r.truncated, [slot(A, 4)]);
    assert.equal(r.missing.length, 0);
    const t = r.nodes.find((n) => n.key === slot(A, 4));
    assert.equal(t.status, 'truncated');
    assert.match(t.error, /maxDepth/);
  });

  it('records missing dependencies explicitly, never drops them', async () => {
    const fix = FIX('missing-dep.json');
    const r = await resolveLineage(
      { processor: fix.root.processor, circuitId: fix.root.circuitId },
      { fetchCircuit: fixtureFetch(fix), chainId: 196 },
    );
    assert.equal(r.edges.length, 1);
    assert.equal(r.missing.length, 1);
    assert.equal(r.missing[0].key, slot(C, 999));
    assert.match(r.missing[0].reason, /null/);
    const ghost = r.nodes.find((n) => n.key === slot(C, 999));
    assert.equal(ghost.status, 'missing');
  });

  it('is deterministic: two runs are deep-equal', async () => {
    const fix = FIX('nested.json');
    const run = () => resolveLineage(
      { processor: fix.root.processor, circuitId: fix.root.circuitId },
      { fetchCircuit: fixtureFetch(fix), chainId: 196 },
    );
    assert.deepEqual(await run(), await run());
  });

  it('never drops a dependency: parsed REF records == edges', async () => {
    for (const name of ['nested.json', 'cycle.json', 'depth-chain.json']) {
      const fix = FIX(name);
      const r = await resolveLineage(
        { processor: fix.root.processor, circuitId: fix.root.circuitId },
        { fetchCircuit: fixtureFetch(fix), chainId: 196, maxDepth: 50 },
      );
      const records = r.nodes
        .filter((n) => n.status === 'resolved')
        .reduce((s, n) => s + n.own.ref, 0);
      assert.equal(records, r.edges.length, name);
    }
  });

  it('resolves the LIVE-VERIFIED TRACE fixture to a dep-free node', async () => {
    const f = FIX('live-trace-1.json');
    assert.equal(f.label, 'LIVE-VERIFIED');
    const r = await resolveLineage(
      { processor: f.processor, circuitId: f.circuitId },
      {
        fetchCircuit: async () => ({ netlist: f.netlist, nIn: f.nIn, nOut: f.nOut }),
        chainId: f.chainId,
      },
    );
    assert.equal(r.nodes.length, 1);
    assert.deepEqual(r.directDependencies, []);
    assert.equal(r.stats.refCount, 0);
    assert.equal(r.stats.nandCount, 8);
  });

  it('rejects bad resolver inputs loudly', async () => {
    await assert.rejects(() => resolveLineage({ processor: A, circuitId: 1 }, {}), /fetchCircuit/);
    await assert.rejects(
      () => resolveLineage({ processor: A, circuitId: 1 }, { fetchCircuit: async () => null, maxDepth: -1 }),
      /maxDepth/,
    );
    await assert.rejects(
      () => resolveLineage({ processor: A }, { fetchCircuit: async () => null }),
      /rootRef/,
    );
    await assert.rejects(
      () => resolveLineage({ processor: '0x123', circuitId: 1 }, { fetchCircuit: async () => null }),
      /processor/,
    );
  });
});
