'use strict';
/**
 * tests/phase3/terms.test.js — canonical terms hashing. Run: npm test (offline)
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  VERSION, MODELS, canonicalizeTerms, validateTerms, canonicalJson, hashTerms,
} = require('../../src/registry/terms');

const GOOD = {
  version: 1, model: 'single-license', priceWei: '10000000000000',
  currency: 'OKB', attributionRequired: true,
};

describe('terms hashing', () => {
  it('is deterministic and documents its schema', () => {
    assert.equal(VERSION, 1);
    assert.deepEqual(MODELS, ['single-license', 'gratis', 'custom']);
    assert.equal(hashTerms(GOOD), hashTerms(JSON.parse(JSON.stringify(GOOD))));
    assert.match(hashTerms(GOOD), /^0x[0-9a-f]{64}$/);
  });

  it('reordered object fields do not change the hash', () => {
    const reordered = {
      attributionRequired: true, currency: 'OKB', priceWei: '10000000000000',
      model: 'single-license', version: 1,
    };
    assert.equal(canonicalJson(reordered), canonicalJson(GOOD));
    assert.equal(hashTerms(reordered), hashTerms(GOOD));
  });

  it('changed terms change the hash (each field)', () => {
    const base = hashTerms(GOOD);
    assert.notEqual(hashTerms({ ...GOOD, priceWei: '10000000000001' }), base);
    assert.notEqual(hashTerms({ ...GOOD, model: 'gratis' }), base);
    assert.notEqual(hashTerms({ ...GOOD, currency: 'ETH' }), base);
    assert.notEqual(hashTerms({ ...GOOD, attributionRequired: false }), base);
    assert.notEqual(hashTerms({ ...GOOD, note: 'hello' }), base);
  });

  it('canonical form pins exact bytes (what is hashed, byte-for-byte)', () => {
    assert.equal(
      canonicalJson(GOOD),
      '{"attributionRequired":true,"currency":"OKB","model":"single-license","priceWei":"10000000000000","version":1}',
    );
  });

  it('gratis pricing (price 0) is valid; non-canonical numbers rejected', () => {
    assert.equal(validateTerms({ ...GOOD, model: 'gratis', priceWei: '0' }).ok, true);
    assert.equal(validateTerms({ ...GOOD, priceWei: '007' }).ok, false);
    assert.equal(validateTerms({ ...GOOD, priceWei: '-1' }).ok, false);
    assert.equal(validateTerms({ ...GOOD, priceWei: 7 }).ok, false); // must be a string
  });

  it('invalid terms rejected (never hashed silently)', () => {
    const bad = [
      [{ ...GOOD, version: 2 }, /version/],
      [{ ...GOOD, model: 'perpetual-everything' }, /model/],
      [{ ...GOOD, currency: '' }, /currency/],
      [{ ...GOOD, currency: 'TOOLONGCURRENCYNAME!' }, /currency/],
      [{ ...GOOD, attributionRequired: 'yes' }, /attributionRequired/],
      [{ ...GOOD, extra: 1 }, /unknown field/],
      [{ ...GOOD, note: 'x'.repeat(281) }, /note/],
      [{ ...GOOD, priceWei: undefined }, /priceWei/],
      ['not-an-object', /object/],
      [null, /object/],
    ];
    for (const [t, re] of bad) {
      assert.equal(validateTerms(t).ok, false, JSON.stringify(t));
      assert.match(validateTerms(t).reason, re);
      assert.throws(() => hashTerms(t), re);
    }
  });
});
