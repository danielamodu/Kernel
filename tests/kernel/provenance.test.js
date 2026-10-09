'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { getProvenance } = require('../../src/kernel/provenance');
const { MemoryRegistry } = require('../../src/registry/memory');
const H = require('./harness');

describe('provenance aggregation', () => {
  it('single dependency: full shape with recomputed lineageHash', async () => {
    // Synthetic single-REF root over a live-readable dep.
    const depNl = '0x00000002000002';
    const depProc = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const rootNl = '0x02' + depProc.slice(2) + '0000000000000001' + '0101' + '000002';
    const mem = new MemoryRegistry();
    mem.register({
      chainId: 196, processor: depProc, circuitId: 1, netlistHash: H.LIVE_HASH,
      payee: H.PAYEE, priceWei: '100', termsHash: H.TERMS, by: H.BY,
    });
    const fetch = async ({ processor, circuitId }) => {
      if (String(circuitId) === '70') return { netlist: rootNl, nIn: 1, nOut: 1, netlistHash: H.LIVE_HASH };
      return { netlist: depNl, nIn: 1, nOut: 1, netlistHash: H.LIVE_HASH };
    };
    const p = await getProvenance(
      { processor: H.A, circuitId: 70 },
      { fetchCircuit: fetch, lookupRegistry: H.memLookup(mem), packageStore: H.store(), chainId: 196 },
    );
    assert.equal(p.direct.length, 1);
    assert.equal(p.transitive.length, 0);
    assert.equal(p.edges.length, 1);
    assert.equal(p.dependencies[0].registrationStatus, 'registered');
    assert.ok(p.lineageHash && /^0x[0-9a-f]{64}$/.test(p.lineageHash));
    assert.equal(p.root.nIn, 1);
    assert.equal(p.missing.length, 0);
  });

  it('duplicate + nested + cycle + missing cases aggregate explicitly', async () => {
    const mem = new MemoryRegistry();
    // Duplicate fixture.
    const dup = H.fix('duplicate-ref.json');
    const d1 = await getProvenance(
      { processor: H.A, circuitId: 71 },
      {
        fetchCircuit: async (ref) => String(ref.circuitId) === '71'
          ? { netlist: dup.netlist, nIn: 2, nOut: 2, netlistHash: H.LIVE_HASH }
          : { netlist: '0x00000002000002', nIn: 1, nOut: 1, netlistHash: H.LIVE_HASH },
        lookupRegistry: H.memLookup(mem), chainId: 196,
      },
    );
    assert.equal(d1.dependencies.length, 1);
    assert.equal(d1.dependencies[0].occurrences, 2);
    assert.equal(d1.lineageHash, null); // unregistered dep => not verifiable
    // Nested fixture.
    const nest = H.fix('nested.json');
    const d2 = await getProvenance(
      { processor: nest.root.processor, circuitId: nest.root.circuitId },
      { fetchCircuit: H.fixtureFetch(nest), lookupRegistry: H.memLookup(mem), chainId: 196 },
    );
    assert.equal(d2.direct.length, 1);
    assert.equal(d2.transitive.length, 1);
    // Cycle terminates.
    const cyc = H.fix('cycle.json');
    const d3 = await getProvenance(
      { processor: cyc.root.processor, circuitId: cyc.root.circuitId },
      { fetchCircuit: H.fixtureFetch(cyc), lookupRegistry: H.memLookup(mem), chainId: 196 },
    );
    assert.equal(d3.cycles.length, 1);
    // Missing dep.
    const miss = H.fix('missing-dep.json');
    const d4 = await getProvenance(
      { processor: miss.root.processor, circuitId: miss.root.circuitId },
      { fetchCircuit: H.fixtureFetch(miss), lookupRegistry: H.memLookup(mem), chainId: 196 },
    );
    assert.equal(d4.dependencies[0].nodeStatus, 'missing');
    assert.equal(d4.lineageHash, null);
  });

  it('malformed REF roots surface as missing, never half-provenance', async () => {
    const p = await getProvenance(
      { processor: H.A, circuitId: 72 },
      {
        fetchCircuit: async () => ({ netlist: '0xff00', nIn: 0, nOut: 1, netlistHash: H.LIVE_HASH }),
        lookupRegistry: H.memLookup(new MemoryRegistry()), chainId: 196,
      },
    );
    assert.equal(p.missing.length, 1);
    assert.match(p.missing[0].reason, /unparseable netlist/);
    assert.equal(p.lineageHash, null);
    assert.equal(p.dependencies.length, 0);
  });
});
