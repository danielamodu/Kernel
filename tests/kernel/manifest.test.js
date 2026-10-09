'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  SCHEMA, buildManifest, validateManifest, parseManifest, canonicalManifest, manifestHash,
} = require('../../src/kernel/manifest');

const SLOT_A = 'tapeout:v1:196:0x1111111111111111111111111111111111111111:1';
const H = '0x' + 'ab'.repeat(32);
const good = () => ({
  schema: 'kernel-manifest-v1',
  name: 'proof-machine',
  version: '1.0.0',
  root: 'tapeout:v1:196:0x9999999999999999999999999999999999999999:1',
  dependencies: [{
    identity: SLOT_A, version: '1.0.0', netlistHash: H,
    license: { required: true, termsHash: H, priceWei: '100', payee: '0x1d207352dd708498cada1524eb4b36b5fa178886' },
  }],
  netlistHash: H,
  lineageHash: H,
});

describe('manifest (kernel-manifest-v1)', () => {
  it('builds canonical manifests deterministically with hash', () => {
    const a = buildManifest(good());
    const b = buildManifest(JSON.parse(JSON.stringify(good())));
    assert.equal(canonicalManifest(a), canonicalManifest(b));
    assert.equal(manifestHash(a), manifestHash(b));
    assert.match(manifestHash(a), /^0x[0-9a-f]{64}$/);
    assert.equal(SCHEMA, 'kernel-manifest-v1');
  });

  it('sorts dependencies by slot (order-independent input)', () => {
    const SLOT_B = 'tapeout:v1:196:0x2222222222222222222222222222222222222222:2';
    const depA = {
      identity: SLOT_A, version: '1.0.0', netlistHash: H,
      license: { required: true, termsHash: H, priceWei: '100' },
    };
    const depB = {
      identity: SLOT_B, version: null, netlistHash: H,
      license: { required: true, termsHash: H, priceWei: '7' },
    };
    const m1 = buildManifest({ ...good(), dependencies: [depB, depA] });
    const m2 = buildManifest({ ...good(), dependencies: [depA, depB] });
    assert.deepEqual(m1.dependencies.map((d) => d.identity), [SLOT_A, SLOT_B]);
    assert.equal(canonicalManifest(m1), canonicalManifest(m2));
  });

  it('round-trips through JSON; rejects malformed manifests', () => {
    const m = buildManifest(good());
    assert.deepEqual(parseManifest(JSON.stringify(m)), m);
    assert.throws(() => parseManifest('{broken'), /malformed/);
    const bad = [
      [{ ...good(), schema: 'x' }, /schema/],
      [{ ...good(), dependencies: 'nope' }, /array/],
      [{ ...good(), root: 'nope' }, /root/],
      [{ ...good(), netlistHash: '0x123' }, /netlistHash/],
      [{ ...good(), dependencies: [{ ...good().dependencies[0], version: '1.0' }] }, /version/],
      [{ ...good(), dependencies: [{ ...good().dependencies[0], license: { required: true, termsHash: H, priceWei: '-1' } }] }, /priceWei/],
      [{ ...good(), extra: 1 }, /unknown field/],
    ];
    for (const [input, re] of bad) {
      assert.equal(validateManifest(input).ok, false);
      assert.match(validateManifest(input).reason, re);
    }
  });

  it('changed content changes the hash', () => {
    const h = manifestHash(good());
    assert.notEqual(manifestHash({ ...good(), version: '2.0.0' }), h);
    assert.notEqual(manifestHash({ ...good(), lineageHash: '0x' + '00'.repeat(32) }), h);
  });
});
