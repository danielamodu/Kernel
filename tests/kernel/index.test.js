'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const K = require('../../src/kernel/index');
const { loadStore } = require('../../src/kernel/store');

describe('kernel facade (ecosystem API surface)', () => {
  it('exposes exactly the nine capability groups', () => {
    for (const fn of [
      'loadStore', 'discoverPackage', 'resolvePackage', 'resolvePackageVersion',
      'resolveDependencies', 'prepareComposition',
      'verifyComposition', 'buildManifest', 'validateManifest', 'manifestHash', 'getProvenance',
      'preflight', 'prepareLicense', 'buildLicenseCalldata', 'requiredValue', 'computeLineageHash',
      'buildPackage', 'packageHash', 'preparePublish', 'executePublish',
    ]) {
      assert.equal(typeof K[fn], 'function', fn);
    }
  });

  it('discover + prepareComposition work end to end offline', async () => {
    const store = loadStore(path.join(__dirname, '..', '..', 'packages'));
    const d = K.discoverPackage(store, 'trace-core');
    assert.equal(d.status, 'ok');
    assert.deepEqual(d.versions, ['1.0.0']);
    assert.equal(d.latest, '1.0.0');
    assert.equal(K.discoverPackage(store, 'nope').status, 'unknown-package');
    const r = K.resolvePackageVersion(store, 'trace-core', 'latest');
    assert.equal(r.package.version, '1.0.0');
    const c = K.prepareComposition({ netlist: '0x0000000200000300000004000004', nIn: 2, nOut: 1 });
    assert.equal(c.audited.nNand, 2);
    assert.equal(c.audited.refCount, 0);
    assert.throws(() => K.prepareComposition({ netlist: '0xff00', nIn: 0, nOut: 1 }), /unknown opcode/);
  });

  it('prepareLicense mirrors preflight (offline twin, no broadcast)', async () => {
    const { MemoryRegistry } = require('../../src/registry/memory');
    const fix = JSON.parse(require('node:fs').readFileSync(
      path.join(__dirname, '..', 'phase2', 'fixtures', 'nested.json'), 'utf8'));
    const mem = new MemoryRegistry();
    const LIVE_HASH = '0x' + 'ab'.repeat(32);
    mem.register({
      chainId: 196, processor: fix.root.processor, circuitId: fix.root.circuitId,
      netlistHash: LIVE_HASH, payee: '0x1d207352dd708498cada1524eb4b36b5fa178886',
      priceWei: '100',
      termsHash: '0x' + '22'.repeat(32),
      by: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    });
    const map = {};
    for (const [k, v] of Object.entries(fix.circuits || {})) map[k] = v;
    map[`${fix.root.processor.toLowerCase()}:${fix.root.circuitId}`] = fix.root;
    const fetch = async ({ processor, circuitId }) =>
      map[`${String(processor).toLowerCase()}:${circuitId}`]
        ? { ...map[`${String(processor).toLowerCase()}:${circuitId}`], netlistHash: LIVE_HASH }
        : null;
    const lookup = async () => null;
    // Root itself unregistered -> preflight blocks; prepareLicense surfaces it without calldata.
    const r = await K.prepareLicense({
      targetCpu: fix.root.processor, netlist: fix.root.netlist, nIn: 1, nOut: 1,
      fetchCircuit: fetch, lookupRegistry: lookup,
      tapeoutFeeWei: '1300000000000000',
      mintQuote: { mintPriceWei: '1000000000000', protocolFeeWei: '660000000000000' },
      chainId: 196,
    });
    assert.equal(r.allowed, false);
    assert.equal(r.calldata, null);
    assert.equal(r.valueWei, null);
    assert.ok(r.failures.some((f) => f.code === 'UNREGISTERED'));
  });
});
