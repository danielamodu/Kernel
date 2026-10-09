'use strict';
/**
 * Creator publishing: prepare (pure plan) vs execute (gated broadcast) are
 * strictly separated. This module only PREPARES:
 *
 * preparePublish({ packageInput, fetchCircuit, lookupRegistry, termsInput?, chainId })
 *   validate circuit -> read netlist -> identity -> netlist hash ->
 *   terms hash -> registry pre-check -> register calldata + plan.
 *
 * The plan's `registerCalldata` + `valueWei: '0'` is what executePublish (or the
 * existing scripts/phase4/register-example.mjs flow, wallet-gated) broadcasts.
 * Nothing here signs, sends, or needs a key.
 *
 * On-chain vs application split (documented, enforced by shape):
 *   ON-CHAIN: chainId, processor, circuitId, netlistHash, payee, priceWei, termsHash
 *   APPLICATION: name, version, description, terms document, publisher claim
 */
const { buildPackage } = require('./package');
const { canonicalizeTerms, hashTerms } = require('../registry/terms');
const { keyHashFor, buildRegisterCalldata } = require('../registry/client');
const { slotKey } = require('../lineage/identity');

function fail(why) {
  throw new Error(`publish: ${why}`);
}

/**
 * Totally offline plan assembly from already-fetched data (for tests/composers).
 * `executePublish` is intentionally dumb: it forwards prepared calldata through
 * an injected broadcast function so UIs/CLIs own the safety gates.
 */
async function preparePublish({
  packageInput, fetchCircuit, lookupRegistry, termsInput = null,
  payeeOverride = null, chainId = 196,
}) {
  if (typeof fetchCircuit !== 'function') throw new Error('publish: fetchCircuit is required');
  if (typeof lookupRegistry !== 'function') throw new Error('publish: lookupRegistry is required');
  const pkg = buildPackage(packageInput); // validates name/version/identity shape
  const id = pkg.identity;

  // 1-2. Validate circuit + read netlist (live).
  const live = await fetchCircuit({ chainId: String(chainId), processor: id.processor, circuitId: id.circuitId })
    .catch((e) => { throw new Error(`publish: circuit unreadable: ${e?.message || e}`); });
  if (!live || typeof live.netlist !== 'string') fail('circuit unreadable (missing)');
  if (!live.netlistHash) fail('fetch must provide netlistHash (keccak of stored bytes)');

  // 3-5. Identity + hashes + terms.
  const slot = slotKey({ chainId, processor: id.processor, circuitId: id.circuitId });
  const keyHash = keyHashFor({ chainId, processor: id.processor, circuitId: id.circuitId });
  const priceWei = pkg.license ? pkg.license.priceWei : '0';
  const currency = pkg.license ? pkg.license.currency : 'OKB';
  const terms = termsInput !== null && termsInput !== undefined
    ? canonicalizeTerms(termsInput)
    : canonicalizeTerms({
      version: 1, model: priceWei === '0' ? 'gratis' : 'single-license',
      priceWei, currency, attributionRequired: true,
    });
  if (terms.priceWei !== priceWei) fail('terms.priceWei must equal package license priceWei');
  const termsHash = hashTerms(terms);
  const payee = (payeeOverride || pkg.publisher || (live.owner || null));
  if (!payee || !/^0[xX][0-9a-fA-F]{40}$/.test(payee) || /^0x0{40}$/i.test(payee)) {
    fail('payee required: pass payeeOverride, set package.publisher, or fetch must expose owner');
  }

  // 6. Registry pre-check. ANY existing record blocks a fresh register():
  // active => duplicate (contract reverts AlreadyRegistered); inactive =>
  // permanent tombstone that also occupies the key (same revert). Publishing
  // over either would burn gas on a guaranteed revert, so fail here instead.
  const existing = await lookupRegistry(slot).catch(() => null);
  if (existing && existing.active) {
    fail(`slot already registered (active) — update/deactivate first: ${slot}`);
  }
  if (existing) {
    fail(`slot holds an inactive (tombstone) record and cannot be re-registered: ${slot}`);
  }

  // 7. Register calldata (value 0: register() is non-payable).
  const registerCalldata = buildRegisterCalldata({
    chainId, processor: id.processor, circuitId: id.circuitId,
    netlistHash: live.netlistHash, payee, priceWei, termsHash,
  });

  return Object.freeze({
    package: pkg,
    slotKey: slot,
    keyHash,
    live: Object.freeze({
      nIn: live.nIn ?? null, nOut: live.nOut ?? null,
      netlistHash: live.netlistHash, netlistBytes: (live.netlist.length - 2) / 2,
    }),
    terms: Object.freeze({ ...terms }),
    termsHash,
    payee: payee.toLowerCase(),
    priceWei,
    registerCalldata,
    valueWei: '0',
    alreadyRegistered: !!existing,
  });
}

/**
 * Broadcast a prepared plan. The executor owns ALL safety (gates, signer, receipt
 * handling): `broadcast({ to, data, value }) -> { hash, ... }`.
 */
async function executePublish(plan, { broadcast, registry }) {
  if (!plan || !plan.registerCalldata) throw new Error('publish: prepared plan required');
  if (typeof broadcast !== 'function') throw new Error('publish: broadcast executor required');
  if (typeof registry !== 'string' || !/^0[xX][0-9a-fA-F]{40}$/.test(registry)) {
    throw new Error('publish: registry address required (0x + 40 hex)');
  }
  return broadcast({ to: registry, data: plan.registerCalldata, value: '0' });
}

module.exports = { preparePublish, executePublish };
