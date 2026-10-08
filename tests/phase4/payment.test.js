'use strict';
/**
 * tests/phase4/payment.test.js — exact-value policy math. Run: npm test (offline).
 * On-chain enforcement of the same formulas is covered in router.test.js (EVM).
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { requiredValue, classifyValue } = require('../../src/router/client');

const MP = '1000000000000'; // mintPrice
const PF = '660000000000000'; // protocolFee per mint call
const TF = '1300000000000000'; // tapeout fee

describe('payment math (mirrors the contract formula 1:1)', () => {
  it('REF-only root: license + tapeout fee, zero mint', () => {
    // Demo root: 43B single REF, 0 own transistors.
    assert.equal(requiredValue({
      totalPriceWei: '500000000000000', nNand: 0, nLatch: 0,
      mintPriceWei: MP, protocolFeeWei: PF, tapeoutFeeWei: TF,
    }), (500000000000000n + 1300000000000000n).toString());
  });

  it('mint math: one protocol fee per nonzero token id', () => {
    const nandOnly = requiredValue({
      totalPriceWei: '0', nNand: 2, nLatch: 0,
      mintPriceWei: MP, protocolFeeWei: PF, tapeoutFeeWei: TF,
    });
    assert.equal(nandOnly, (2n * 1000000000000n + 660000000000000n + 1300000000000000n).toString());
    const both = requiredValue({
      totalPriceWei: '0', nNand: 2, nLatch: 1,
      mintPriceWei: MP, protocolFeeWei: PF, tapeoutFeeWei: TF,
    });
    // Two mint calls => two protocol fees.
    assert.equal(both, (3n * 1000000000000n + 2n * 660000000000000n + 1300000000000000n).toString());
  });

  it('zero-price (gratis) dependency: only manufacture is charged', () => {
    assert.equal(requiredValue({
      totalPriceWei: '0', nNand: 0, nLatch: 0,
      mintPriceWei: MP, protocolFeeWei: PF, tapeoutFeeWei: TF,
    }), TF);
  });

  it('classifyValue: exact ok, shortfall and excess rejected with amounts', () => {
    assert.deepEqual(classifyValue({ requiredWei: '100', proposedWei: '100' }), { ok: true, policy: 'exact' });
    assert.deepEqual(classifyValue({ requiredWei: '100', proposedWei: '99' }),
      { ok: false, policy: 'exact', code: 'INSUFFICIENT', shortfallWei: '1' });
    assert.deepEqual(classifyValue({ requiredWei: '100', proposedWei: '101' }),
      { ok: false, policy: 'exact', code: 'EXCESS', excessWei: '1' });
    // 1 wei matters: no dust tolerance (dust would strand or complicate refunds).
    assert.equal(classifyValue({ requiredWei: '100', proposedWei: '101' }).ok, false);
  });

  it('no floating point anywhere: big values stay exact', () => {
    const huge = '115792089237316195423570985008687907853269984665640564039457584007913129639935'; // 2^256-1
    assert.equal(requiredValue({
      totalPriceWei: huge, nNand: 0, nLatch: 0,
      mintPriceWei: '0', protocolFeeWei: '0', tapeoutFeeWei: '0',
    }), huge);
  });
});
