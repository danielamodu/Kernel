'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { verifyComposition } = require('../../src/kernel/verify');
const { MemoryRegistry } = require('../../src/registry/memory');
const H = require('./harness');

const codes = (r) => r.checks.map((c) => `${c.code}:${c.passed ? 'pass' : c.skipped ? 'skip' : 'FAIL'}`);

describe('verifyPackage (Kernel Verified = all green)', () => {
  it('fully verified composition: all 10 checks pass', async () => {
    const fix = H.fix('live-trace-1.json');
    const mem = new MemoryRegistry();
    const r = await verifyComposition({
      root: { processor: fix.processor, circuitId: fix.circuitId },
      fetchCircuit: async () => ({ netlist: fix.netlist, nIn: fix.nIn, nOut: fix.nOut, netlistHash: H.LIVE_HASH }),
      lookupRegistry: H.memLookup(mem),
      expectedNetlistHash: H.LIVE_HASH,
      chainId: 196,
    });
    assert.equal(r.verified, true, codes(r).join(' '));
    assert.equal(r.checks.length, 10);
    assert.deepEqual(r.failed, []);
    const byCode = Object.fromEntries(r.checks.map((c) => [c.code, c]));
    assert.equal(byCode.IDENTITY_RESOLVES.passed, true);
    assert.equal(byCode.NETLIST_MATCH.passed, true);
    assert.equal(byCode.LINEAGE_REPRODUCIBLE.passed, true);
    // No locks/expectations supplied -> skipped, never failed.
    assert.equal(byCode.TERMS_MATCH.skipped, true);
    assert.equal(byCode.MANIFEST_CONSISTENT.skipped, true);
    assert.equal(byCode.REGISTRATION_PRESENT.skipped, true);
  });

  it('hash mismatch fails NETLIST_MATCH; missing dep fails resolution', async () => {
    const fix = H.fix('live-trace-1.json');
    const mem = new MemoryRegistry();
    const base = {
      root: { processor: fix.processor, circuitId: fix.circuitId },
      fetchCircuit: async () => ({ netlist: fix.netlist, nIn: fix.nIn, nOut: fix.nOut, netlistHash: H.LIVE_HASH }),
      lookupRegistry: H.memLookup(mem),
      chainId: 196,
    };
    const r1 = await verifyComposition({ ...base, expectedNetlistHash: '0x' + '00'.repeat(32) });
    assert.equal(r1.verified, false);
    assert.ok(r1.failed.includes('NETLIST_MATCH'));

    const nest = H.fix('nested.json');
    const r2 = await verifyComposition({
      root: { processor: nest.root.processor, circuitId: nest.root.circuitId },
      fetchCircuit: H.fixtureFetch(nest),
      lookupRegistry: H.memLookup(mem),
      requireRegistration: true,
      chainId: 196,
    });
    assert.equal(r2.verified, false);
    assert.ok(r2.failed.includes('REGISTRATION_PRESENT'));
  });

  it('manifest consistency is checked when supplied', async () => {
    const fix = H.fix('live-trace-1.json');
    const mem = new MemoryRegistry();
    const base = {
      root: { processor: fix.processor, circuitId: fix.circuitId },
      fetchCircuit: async () => ({ netlist: fix.netlist, nIn: fix.nIn, nOut: fix.nOut, netlistHash: H.LIVE_HASH }),
      lookupRegistry: H.memLookup(mem),
      chainId: 196,
    };
    const goodManifest = {
      schema: 'kernel-manifest-v1', name: 't', version: '1.0.0',
      root: `tapeout:v1:196:${fix.processor.toLowerCase()}:${fix.circuitId}`,
      dependencies: [], netlistHash: H.LIVE_HASH, lineageHash: H.LIVE_HASH,
    };
    const r1 = await verifyComposition({ ...base, manifest: goodManifest });
    assert.ok(r1.checks.find((c) => c.code === 'MANIFEST_CONSISTENT').passed);
    const r2 = await verifyComposition({
      ...base, manifest: { ...goodManifest, netlistHash: '0x' + '00'.repeat(32) },
    });
    assert.equal(r2.verified, false);
    assert.ok(r2.failed.includes('MANIFEST_CONSISTENT'));
  });

  it('bad identity fails fast with a single check', async () => {
    const r = await verifyComposition({
      root: { processor: '0x123', circuitId: 1 },
      fetchCircuit: async () => null, lookupRegistry: async () => null, chainId: 196,
    });
    assert.equal(r.verified, false);
    assert.deepEqual(r.checks.map((c) => c.code), ['IDENTITY_RESOLVES']);
  });
});
