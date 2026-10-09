'use strict';
/**
 * tests/kernel/hardening.test.js — backend-sprint regressions. Each test pins a
 * genuine gap found in audit: flaky lookups must degrade (never abort or
 * mislabel), malformed records must fail closed with codes (never throw raw),
 * tombstones must block re-registration, transport errors must not read as
 * absence, executors must be validated. Run: npm test (offline).
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { attributeLineage } = require('../../src/registry/attribution');
const { resolveLineage } = require('../../src/lineage/resolver');
const { preflight } = require('../../src/router/preflight');
const { computeLineageHash } = require('../../src/router/commitment');
const { preparePublish, executePublish } = require('../../src/kernel/publish');
const { isAbsenceError } = require('../../src/lineage/chain-reader');
const { MemoryRegistry } = require('../../src/registry/memory');
const H = require('./harness');

const A = H.A;
const nestFixture = () => H.fix('nested.json');

describe('attribution survives registry outages', () => {
  it('throwing lookup degrades per-slot to unknown (join completes)', async () => {
    const fix = nestFixture();
    const lin = await resolveLineage(
      { processor: fix.root.processor, circuitId: fix.root.circuitId },
      { fetchCircuit: H.fixtureFetch(fix), chainId: 196 },
    );
    let calls = 0;
    const attr = await attributeLineage(lin, {
      lookup: async (slot) => {
        calls++;
        if (slot.endsWith(':1')) throw new Error('RPC timeout (simulated)');
        return null;
      },
    });
    assert.ok(calls >= 2);
    const failed = attr.dependencies.find((d) => d.reason && /timeout/.test(d.reason));
    assert.ok(failed, 'flaky slot recorded with reason');
    assert.equal(failed.status, 'unknown');
    assert.equal(failed.registered, false);
    assert.ok(attr.dependencies.every((d) => d.slotKey), 'no dependency dropped');
    assert.equal(attr.rootRegistration.status, 'unregistered'); // null lookup, healthy path
  });
});

describe('preflight fails closed with codes (never raw throws)', () => {
  const base = (over = {}) => ({
    targetCpu: A,
    netlist: nestFixture().root.netlist, nIn: 1, nOut: 1,
    fetchCircuit: H.fixtureFetch(nestFixture()),
    lookupRegistry: H.memLookup(new MemoryRegistry()),
    tapeoutFeeWei: '1300000000000000',
    mintQuote: { mintPriceWei: '1000000000000', protocolFeeWei: '660000000000000' },
    chainId: 196, ...over,
  });

  it('garbage priceWei => INVALID_PRICE (not a throw)', async () => {
    const r = await preflight({
      ...base(),
      lookupRegistry: async () => ({
        active: true, payee: H.PAYEE, priceWei: 'not-a-number',
        termsHash: H.TERMS, netlistHash: H.LIVE_HASH,
      }),
    });
    assert.equal(r.allowed, false);
    assert.ok(r.failures.some((f) => f.code === 'INVALID_PRICE'));
  });

  it('lookup transport failure => LOOKUP_FAILED (never mislabeled unregistered)', async () => {
    const r = await preflight({
      ...base(), lookupRegistry: async () => { throw new Error('socket hang up (simulated)'); },
    });
    assert.equal(r.allowed, false);
    assert.ok(r.failures.some((f) => f.code === 'LOOKUP_FAILED'));
    assert.ok(!r.failures.some((f) => f.code === 'UNREGISTERED'));
    assert.equal(r.dependencies[0].status, 'lookup-failed');
  });

  it('string-typed nIn/nOut from custom fetches compare correctly', async () => {
    const fix = nestFixture();
    const r = await preflight({
      ...base(),
      fetchCircuit: async ({ processor, circuitId }) => {
        const map = { ...(fix.circuits || {}) };
        map[`${fix.root.processor.toLowerCase()}:${fix.root.circuitId}`] = fix.root;
        const hit = map[`${String(processor).toLowerCase()}:${circuitId}`];
        // Deliberately string-typed pins, as a UI-agent fetch might return.
        return hit ? { ...hit, nIn: String(hit.nIn), nOut: String(hit.nOut), netlistHash: H.LIVE_HASH } : null;
      },
    });
    assert.ok(!r.failures.some((f) => f.code === 'PIN_MISMATCH'), JSON.stringify(r.failures));
  });
});

describe('publishing safety', () => {
  const TRACE = '0x7761ce17a2e75c6910f1d5a77e6f66cd9ca1274a';
  const liveTraceFetch = async () => ({ ...H.fix('live-trace-1.json'), netlistHash: H.LIVE_HASH });
  const pkgInput = () => ({
    schema: 'kernel-package-v1', name: 'trace-core', version: '9.9.9',
    identity: { chainId: 196, processor: TRACE, circuitId: 1 },
    license: { priceWei: '100', currency: 'OKB', attributionRequired: true },
    publisher: H.PAYEE,
  });

  it('inactive tombstone blocks re-registration (would revert on-chain)', async () => {
    const mem = new MemoryRegistry();
    const { key } = mem.register({
      chainId: 196, processor: TRACE, circuitId: 1, netlistHash: H.LIVE_HASH,
      payee: H.PAYEE, priceWei: '100', termsHash: H.TERMS, by: H.BY,
    });
    mem.deactivate({ key, by: H.BY });
    await assert.rejects(
      preparePublish({ packageInput: pkgInput(), fetchCircuit: liveTraceFetch, lookupRegistry: H.memLookup(mem) }),
      /tombstone|cannot be re-registered/,
    );
  });

  it('executePublish validates the registry address and never self-broadcasts', async () => {
    const mem = new MemoryRegistry();
    const plan = await preparePublish({
      packageInput: pkgInput(), fetchCircuit: liveTraceFetch,
      lookupRegistry: H.memLookup(mem),
    });
    assert.equal(plan.valueWei, '0');
    await assert.rejects(executePublish(plan, { broadcast: async () => ({}), registry: '0x123' }), /registry address/);
    await assert.rejects(executePublish(plan, { broadcast: async () => ({}), registry: '' }), /registry address/);
    await assert.rejects(executePublish(plan, { broadcast: 'nope', registry: '0xcccccccccccccccccccccccccccccccccccccccc' }), /executor/);
  });
});

describe('chain-reader error taxonomy (absence vs outage)', () => {
  it('reverts and bad data are absence; transport failures are not', () => {
    for (const e of [
      new Error('execution reverted: no circuit'),
      Object.assign(new Error('missing revert data'), { code: 'CALL_EXCEPTION' }),
      Object.assign(new Error('x'), { code: 'BAD_DATA' }),
      new Error('invalid address'),
    ]) {
      assert.equal(isAbsenceError(e), true, e.message);
    }
    for (const e of [
      new Error('RPC timeout (simulated)'),
      new Error('socket hang up'),
      new Error('fetch failed'),
      new Error('connect ECONNREFUSED 127.0.0.1'),
      new Error('429 Too Many Requests'),
      new Error('502 Bad Gateway'),
      new Error('request body timeout'),
    ]) {
      assert.equal(isAbsenceError(e), false, e.message);
    }
  });
});

describe('commitment input validation', () => {
  const dep = () => ({
    keyHash: '0x' + '11'.repeat(32), netlistHash: '0x' + 'ab'.repeat(32),
    payee: H.PAYEE, priceWei: '100', termsHash: '0x' + '22'.repeat(32),
  });
  const args = (deps) => ({
    targetCpu: A, nIn: 1, nOut: 1, netlist: '0x00000002000002', deps,
  });
  it('bad priceWei fails with a commitment: error (not raw BigInt TypeError)', () => {
    assert.throws(() => computeLineageHash(args([{ ...dep(), priceWei: 'NaN' }])), /commitment: dep 0 bad priceWei/);
    assert.throws(() => computeLineageHash(args([{ ...dep(), priceWei: 100 }])), /commitment: dep 0 bad priceWei/);
  });
});
