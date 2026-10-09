'use strict';
/**
 * Canonical LicenseReceipt: what was used, what was agreed, what was paid,
 * what resulted. Deterministic from (plan + tx receipt + lineage output).
 * A receipt asserts application-level settlement at composition/TapeOut time —
 * never runtime royalties, never protocol enforcement.
 *
 * {
 *   schema: 'kernel-receipt-v1',
 *   component: slotKey, packageVersion: '1.0.0'|null,
 *   termsHash, priceWei, payee, payer,
 *   transaction, blockNumber,
 *   resultingCircuit: slotKey, lineageHash
 * }
 */
const { parseSlotKey } = require('../lineage/identity');

const SCHEMA = 'kernel-receipt-v1';
const HASH_RE = /^0x[0-9a-f]{64}$/;
const ADDR_RE = /^0x[0-9a-f]{40}$/;
const TX_RE = /^0x[0-9a-f]{64}$/;

function fail(why) {
  throw new Error(`receipt: ${why}`);
}

function buildReceipt(input) {
  if (!input || typeof input !== 'object') fail('receipt must be an object');
  const allowed = ['schema', 'component', 'packageVersion', 'termsHash', 'priceWei',
    'payee', 'payer', 'transaction', 'blockNumber', 'resultingCircuit', 'lineageHash'];
  for (const k of Object.keys(input)) if (!allowed.includes(k)) fail(`unknown field: ${k}`);
  if (input.schema !== SCHEMA) fail(`unsupported schema (want ${SCHEMA})`);
  parseSlotKey(input.component);
  parseSlotKey(input.resultingCircuit);
  if (input.packageVersion !== null && input.packageVersion !== undefined
    && typeof input.packageVersion !== 'string') fail('packageVersion must be a string or null');
  if (!HASH_RE.test((input.termsHash || '').toLowerCase())) fail('bad termsHash');
  let price;
  try {
    if (typeof input.priceWei !== 'string') fail('priceWei must be a decimal string');
    price = BigInt(input.priceWei);
  } catch (e) {
    if (String(e.message).startsWith('receipt')) throw e;
    fail('priceWei not a uint');
  }
  if (price < 0n) fail('priceWei negative');
  if (!ADDR_RE.test((input.payee || '').toLowerCase())) fail('bad payee');
  if (!ADDR_RE.test((input.payer || '').toLowerCase())) fail('bad payer');
  if (!TX_RE.test((input.transaction || '').toLowerCase())) fail('bad transaction hash');
  if (!Number.isInteger(input.blockNumber) || input.blockNumber < 0) fail('bad blockNumber');
  if (!HASH_RE.test((input.lineageHash || '').toLowerCase())) fail('bad lineageHash');
  return Object.freeze({
    schema: SCHEMA,
    component: input.component,
    packageVersion: input.packageVersion ?? null,
    termsHash: input.termsHash.toLowerCase(),
    priceWei: price.toString(10),
    payee: input.payee.toLowerCase(),
    payer: input.payer.toLowerCase(),
    transaction: input.transaction.toLowerCase(),
    blockNumber: input.blockNumber,
    resultingCircuit: input.resultingCircuit,
    lineageHash: input.lineageHash.toLowerCase(),
  });
}

/**
 * Assemble a receipt from the pieces the router flow already produces:
 * preflight dep entry + licensed-tx data + lineage result.
 */
function receiptFromSettlement({ dep, payer, transaction, blockNumber, resultingSlot, lineageHash }) {
  if (!dep || typeof dep !== 'object') fail('dep entry required');
  return buildReceipt({
    schema: SCHEMA,
    component: dep.slotKey,
    packageVersion: dep.packageVersion ?? null,
    termsHash: dep.termsHash,
    priceWei: dep.priceWei,
    payee: dep.payee,
    payer,
    transaction,
    blockNumber,
    resultingCircuit: resultingSlot,
    lineageHash,
  });
}

module.exports = { SCHEMA, buildReceipt, receiptFromSettlement };
