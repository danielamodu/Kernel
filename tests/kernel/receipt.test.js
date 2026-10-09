'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { SCHEMA, buildReceipt, receiptFromSettlement } = require('../../src/kernel/receipt');

const SLOT = 'tapeout:v1:196:0x1111111111111111111111111111111111111111:1';
const ROOT = 'tapeout:v1:196:0x9999999999999999999999999999999999999999:1';
const H = '0x' + 'ab'.repeat(32);
const T = '0x' + '22'.repeat(32);
const TX = '0x' + '33'.repeat(32);
const PAYEE = '0x1d207352dd708498cada1524eb4b36b5fa178886';
const PAYER = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

const good = () => ({
  schema: 'kernel-receipt-v1', component: SLOT, packageVersion: '1.0.0',
  termsHash: T, priceWei: '100', payee: PAYEE, payer: PAYER,
  transaction: TX, blockNumber: 72687060, resultingCircuit: ROOT, lineageHash: H,
});

describe('license receipt', () => {
  it('builds deterministic receipts', () => {
    const a = buildReceipt(good());
    const b = buildReceipt(JSON.parse(JSON.stringify(good())));
    assert.deepEqual(a, b);
    assert.equal(SCHEMA, 'kernel-receipt-v1');
    assert.equal(a.priceWei, '100');
  });

  it('assembles from settlement pieces', () => {
    const r = receiptFromSettlement({
      dep: { slotKey: SLOT, packageVersion: null, termsHash: T, priceWei: '100', payee: PAYEE },
      payer: PAYER, transaction: TX, blockNumber: 1, resultingSlot: ROOT, lineageHash: H,
    });
    assert.equal(r.component, SLOT);
    assert.equal(r.packageVersion, null);
    assert.equal(r.resultingCircuit, ROOT);
  });

  it('rejects malformed receipts', () => {
    const bad = [
      [{ ...good(), schema: 'x' }, /schema/],
      [{ ...good(), component: 'nope' }, /slot|identity|circuit/i],
      [{ ...good(), termsHash: '0x123' }, /termsHash/],
      [{ ...good(), priceWei: '-1' }, /priceWei/],
      [{ ...good(), payee: '0x123' }, /payee/],
      [{ ...good(), transaction: '0x123' }, /transaction/],
      [{ ...good(), blockNumber: -1 }, /blockNumber/],
      [{ ...good(), lineageHash: 'zz' }, /lineageHash/],
      [{ ...good(), extra: 1 }, /unknown field/],
    ];
    for (const [input, re] of bad) {
      assert.throws(() => buildReceipt(input), re, JSON.stringify(input).slice(0, 60));
    }
  });
});
