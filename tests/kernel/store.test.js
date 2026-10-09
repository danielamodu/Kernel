'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { loadStore, resolvePackageVersion, resolvePackage } = require('../../src/kernel/store');

const DIR = path.join(__dirname, '..', '..', 'packages');

describe('package store + resolution', () => {
  it('loads the curated registry; trace-core v1.0.0 maps to TRACE #1', () => {
    const store = loadStore(DIR);
    assert.ok(store.names().includes('trace-core'));
    const r = resolvePackageVersion(store, 'trace-core', '1.0.0');
    assert.equal(r.status, 'ok');
    assert.equal(r.package.identity.processor, '0x7761ce17a2e75c6910f1d5a77e6f66cd9ca1274a');
    assert.equal(r.package.identity.circuitId, '1');
    assert.equal(r.package.identity.chainId, '196');
    const latest = resolvePackageVersion(store, 'trace-core', 'latest');
    assert.equal(latest.status, 'ok');
    assert.equal(latest.package.version, '1.0.0');
  });

  it('unknown package / version / non-semver are explicit', () => {
    const store = loadStore(DIR);
    assert.equal(resolvePackageVersion(store, 'nope', '1.0.0').status, 'unknown-package');
    const u = resolvePackageVersion(store, 'trace-core', '9.9.9');
    assert.equal(u.status, 'unknown-version');
    assert.ok(Array.isArray(u.available));
    assert.equal(resolvePackageVersion(store, 'trace-core', 'caret').status, 'unknown-version');
  });

  it('reverse lookup matches exact identity only', () => {
    const store = loadStore(DIR);
    const hit = resolvePackage(store, { chainId: 196, processor: '0x7761cE17a2e75C6910f1D5a77E6F66CD9Ca1274a', circuitId: 1 });
    assert.equal(hit.status, 'ok');
    assert.equal(hit.package.name, 'trace-core');
    assert.equal(resolvePackage(store, { chainId: 196, processor: '0x7761ce17a2e75c6910f1d5a77e6f66cd9ca1274a', circuitId: 2 }).status, 'unknown');
    assert.equal(resolvePackage(store, { chainId: 56, processor: '0x7761ce17a2e75c6910f1d5a77e6f66cd9ca1274a', circuitId: 1 }).status, 'unknown');
    assert.equal(resolvePackage(store, { chainId: 196, processor: '0x123', circuitId: 1 }).status, 'unknown');
  });

  it('duplicate versions fail closed at load', () => {
    const dir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'kernel-pkg-'));
    fs.writeFileSync(path.join(dir, 'dup.json'), JSON.stringify({
      name: 'dup', versions: [
        { version: '1.0.0', chainId: 196, processor: '0x1111111111111111111111111111111111111111', circuitId: 1 },
        { version: '1.0.0', chainId: 196, processor: '0x1111111111111111111111111111111111111111', circuitId: 2 },
      ],
    }));
    assert.throws(() => loadStore(dir), /duplicate version/);
    fs.rmSync(dir, { recursive: true });
    assert.throws(() => loadStore(path.join(dir, 'missing')), /unreadable/);
  });
});
