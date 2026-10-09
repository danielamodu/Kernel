'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  SCHEMA, FIELD_PROVENANCE, buildPackage, validatePackage, parsePackage,
  canonicalPackage, packageHash,
} = require('../../src/kernel/package');

const TRACE = '0x7761ce17a2e75c6910f1d5a77e6f66cd9ca1274a';
const good = () => ({
  schema: 'kernel-package-v1',
  name: 'trace-core',
  version: '1.0.0',
  identity: { chainId: 196, processor: TRACE, circuitId: 1 },
  description: 'Demo IP.',
  license: { priceWei: '100', currency: 'OKB', attributionRequired: true },
  publisher: '0x1d207352Dd708498caDA1524eB4b36B5fa178886',
  displayName: 'TRACE Core',
});

describe('package model', () => {
  it('builds canonical packages deterministically', () => {
    const a = buildPackage(good());
    const b = buildPackage(JSON.parse(JSON.stringify(good())));
    assert.equal(canonicalPackage(a), canonicalPackage(b));
    assert.equal(packageHash(a), packageHash(b));
    assert.match(packageHash(a), /^0x[0-9a-f]{64}$/);
    assert.equal(a.identity.processor, TRACE.toLowerCase());
    assert.equal(a.identity.circuitId, '1');
  });

  it('field order does not matter; minimal packages validate', () => {
    const reordered = { version: '1.0.0', name: 'trace-core', identity: { circuitId: 1, processor: TRACE, chainId: '196' }, schema: SCHEMA };
    assert.equal(canonicalPackage(reordered), canonicalPackage({ schema: SCHEMA, name: 'trace-core', version: '1.0.0', identity: { chainId: 196, processor: TRACE, circuitId: 1 } }));
    assert.equal(validatePackage(reordered).ok, true);
  });

  it('every canonical field carries a provenance tag (total coverage)', () => {
    const p = buildPackage(good());
    const seen = new Set();
    const walk = (v, prefix) => {
      if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
        for (const k of Object.keys(v)) walk(v[k], prefix ? `${prefix}.${k}` : k);
      } else if (prefix) {
        seen.add(prefix);
        assert.ok(['onchain', 'derived', 'application', 'presentation'].includes(FIELD_PROVENANCE[prefix]), `untagged: ${prefix}`);
      }
    };
    walk(p, '');
    // Identity fields are onchain; name/version application; displayName presentation.
    assert.equal(FIELD_PROVENANCE['identity.processor'], 'onchain');
    assert.equal(FIELD_PROVENANCE.version, 'application');
    assert.equal(FIELD_PROVENANCE.displayName, 'presentation');
    assert.ok(seen.size >= 8);
  });

  it('rejects bad shapes loudly', () => {
    const cases = [
      [{ ...good(), schema: 'x' }, /schema/],
      [{ ...good(), name: 'Bad Name!' }, /name/],
      [{ ...good(), version: '1.0' }, /version/],
      [{ ...good(), identity: { chainId: 196, processor: TRACE, circuitId: 0 } }, /start at 1/],
      [{ ...good(), identity: { chainId: 196, processor: '0x123', circuitId: 1 } }, /processor/],
      [{ ...good(), license: { priceWei: '007', currency: 'OKB', attributionRequired: true } }, /canonical/],
      [{ ...good(), license: { priceWei: 7, currency: 'OKB', attributionRequired: true } }, /string/],
      [{ ...good(), extra: 1 }, /unknown field/],
      [{ ...good(), description: 'x'.repeat(501) }, /description/],
    ];
    for (const [input, re] of cases) {
      assert.equal(validatePackage(input).ok, false, JSON.stringify(input).slice(0, 80));
      assert.match(validatePackage(input).reason, re);
    }
    assert.throws(() => parsePackage('{nope'), /malformed/);
  });

  it('changed content changes the hash', () => {
    const h = packageHash(good());
    assert.notEqual(packageHash({ ...good(), version: '1.0.1' }), h);
    assert.notEqual(packageHash({ ...good(), description: 'Other.' }), h);
  });
});
