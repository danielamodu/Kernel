'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { resolveDependencies } = require('../../src/kernel/deps');
const { MemoryRegistry } = require('../../src/registry/memory');
const H = require('./harness');

describe('dependency resolution (first-class)', () => {
  it('nested: enriched records carry identity, package, registration, occurrences', async () => {
    const fix = H.fix('nested.json');
    const mem = new MemoryRegistry();
    H.registerDep(mem, H.A, 1);
    const r = await resolveDependencies(
      { processor: fix.root.processor, circuitId: fix.root.circuitId },
      { fetchCircuit: H.fixtureFetch(fix), lookupRegistry: H.memLookup(mem), packageStore: H.store(), chainId: 196 },
    );
    assert.equal(r.dependencies.length, 2);
    const m1 = r.dependencies[0];
    assert.equal(m1.processor, H.A.toLowerCase());
    assert.equal(m1.occurrences, 1);
    assert.equal(m1.registrationStatus, 'registered');
    assert.equal(m1.registration.priceWei, '100');
    assert.equal(r.edges.length, 2);
    assert.ok(r.edges.every((e) => typeof e.refIndex === 'number'));
  });

  it('duplicate REFs: one entry, occurrences == 2', async () => {
    const f = H.fix('duplicate-ref.json');
    const mem = new MemoryRegistry();
    H.registerDep(mem, H.A, 5);
    const r = await resolveDependencies(
      { processor: H.A, circuitId: 70 },
      {
        fetchCircuit: async (ref) => String(ref.circuitId) === '70'
          ? { netlist: f.netlist, nIn: 2, nOut: 2, netlistHash: H.LIVE_HASH }
          : { netlist: '0x00000002000002', nIn: 1, nOut: 1, netlistHash: H.LIVE_HASH },
        lookupRegistry: H.memLookup(mem), packageStore: H.store(), chainId: 196,
      },
    );
    assert.equal(r.dependencies.length, 1);
    assert.equal(r.dependencies[0].occurrences, 2);
    assert.equal(r.dependencies[0].registrationStatus, 'registered');
  });

  it('package enrichment: known vs unknown slots', async () => {
    const fix = H.fix('nested.json');
    const r = await resolveDependencies(
      { processor: fix.root.processor, circuitId: fix.root.circuitId },
      { fetchCircuit: H.fixtureFetch(fix), lookupRegistry: H.memLookup(new MemoryRegistry()), packageStore: H.store(), chainId: 196 },
    );
    // Fake processors are not in the curated store.
    assert.ok(r.dependencies.every((d) => d.packageStatus === 'unknown' && d.package === null));
    assert.equal(r.stats.knownPackages, 0);
    // Live TRACE identity resolves to trace-core v1.0.0.
    const live = await resolveDependencies(
      { processor: '0x7761ce17a2e75c6910f1d5a77e6f66cd9ca1274a', circuitId: 1 },
      {
        fetchCircuit: async () => ({ ...H.fix('live-trace-1.json'), netlistHash: H.LIVE_HASH }),
        lookupRegistry: H.memLookup(new MemoryRegistry()), packageStore: H.store(), chainId: 196,
      },
    );
    assert.equal(live.dependencies.length, 0); // TRACE#1 is dep-free; root package check below
  });

  it('cycles terminate; missing/malformed surface explicitly', async () => {
    const cyc = H.fix('cycle.json');
    const r = await resolveDependencies(
      { processor: cyc.root.processor, circuitId: cyc.root.circuitId },
      { fetchCircuit: H.fixtureFetch(cyc), lookupRegistry: H.memLookup(new MemoryRegistry()), chainId: 196 },
    );
    assert.equal(r.cycles.length, 1);
    const miss = H.fix('missing-dep.json');
    const r2 = await resolveDependencies(
      { processor: miss.root.processor, circuitId: miss.root.circuitId },
      { fetchCircuit: H.fixtureFetch(miss), lookupRegistry: H.memLookup(new MemoryRegistry()), chainId: 196 },
    );
    assert.equal(r2.dependencies[0].nodeStatus, 'missing');
    assert.equal(r2.dependencies[0].registrationStatus, 'unknown');
    await assert.rejects(
      resolveDependencies({ processor: H.A, circuitId: 1 }, { lookupRegistry: async () => null }),
      /fetchCircuit/,
    );
  });
});
