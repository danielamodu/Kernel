'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { ethers } = require('ethers');
const { preparePublish, executePublish } = require('../../src/kernel/publish');
const { MemoryRegistry } = require('../../src/registry/memory');
const { keyHashFor } = require('../../src/registry/client');
const H = require('./harness');

const TRACE = '0x7761ce17a2e75c6910f1d5a77e6f66cd9ca1274a';
const liveTraceFetch = async () => ({ ...H.fix('live-trace-1.json'), netlistHash: H.LIVE_HASH });
const pkgInput = () => ({
  schema: 'kernel-package-v1', name: 'trace-core', version: '1.0.0',
  identity: { chainId: 196, processor: TRACE, circuitId: 1 },
  description: 'Demo IP.',
  license: { priceWei: '100', currency: 'OKB', attributionRequired: true },
  publisher: H.PAYEE,
});

describe('publishing (prepare vs execute separated)', () => {
  it('preparePublish validates, reads, hashes, and builds calldata', async () => {
    const mem = new MemoryRegistry();
    const plan = await preparePublish({
      packageInput: pkgInput(),
      fetchCircuit: liveTraceFetch,
      lookupRegistry: H.memLookup(mem),
      chainId: 196,
    });
    assert.equal(plan.slotKey, `tapeout:v1:196:${TRACE.toLowerCase()}:1`);
    assert.equal(plan.keyHash, keyHashFor({ chainId: 196, processor: TRACE, circuitId: 1 }));
    assert.equal(plan.payee, H.PAYEE.toLowerCase());
    assert.equal(plan.priceWei, '100');
    assert.equal(plan.valueWei, '0');
    assert.equal(plan.alreadyRegistered, false);
    assert.equal(plan.live.netlistBytes, 56);
  });

  it('register calldata targets the right slot with exact args', async () => {
    const { buildRegisterCalldata } = require('../../src/registry/client.js');
    const mem = new MemoryRegistry();
    const plan = await preparePublish({
      packageInput: pkgInput(), fetchCircuit: liveTraceFetch,
      lookupRegistry: H.memLookup(mem), chainId: 196,
    });
    const frag = new ethers.Interface([
      'function register(uint256,address,uint256,bytes32,address,uint256,bytes32)',
    ]);
    const dec = frag.parseTransaction({ data: plan.registerCalldata });
    assert.equal(dec.name, 'register');
    assert.equal(dec.args[1].toLowerCase(), TRACE.toLowerCase());
    assert.equal(dec.args[2], 1n);
    assert.equal(dec.args[4].toLowerCase(), H.PAYEE.toLowerCase());
    assert.equal(dec.args[5], 100n);
  });

  it('refuses already-registered slots and unreadable circuits', async () => {
    const mem = new MemoryRegistry();
    H.registerDep(mem, TRACE, 1);
    // Note: registerDep uses its own hash; plan fetch uses LIVE_HASH — mismatch is
    // fine here; the refusal under test is double-registration, checked first.
    await assert.rejects(
      preparePublish({ packageInput: pkgInput(), fetchCircuit: liveTraceFetch, lookupRegistry: H.memLookup(mem) }),
      /already registered/,
    );
    await assert.rejects(
      preparePublish({
        packageInput: pkgInput(), fetchCircuit: async () => null,
        lookupRegistry: H.memLookup(new MemoryRegistry()),
      }),
      /unreadable|missing/,
    );
  });

  it('executePublish only forwards prepared calldata via injected executor', async () => {
    const mem = new MemoryRegistry();
    const plan = await preparePublish({
      packageInput: pkgInput(), fetchCircuit: liveTraceFetch,
      lookupRegistry: H.memLookup(mem), chainId: 196,
    });
    const calls = [];
    const res = await executePublish(plan, {
      registry: '0xcccccccccccccccccccccccccccccccccccccccc',
      broadcast: async (tx) => { calls.push(tx); return { hash: '0x' + 'ff'.repeat(32) }; },
    });
    assert.equal(res.hash, '0x' + 'ff'.repeat(32));
    assert.equal(calls.length, 1);
    assert.equal(calls[0].value, '0');
    assert.equal(calls[0].data, plan.registerCalldata);
    await assert.rejects(executePublish(null, { broadcast: async () => ({}), registry: '0x1' }), /prepared plan/);
    await assert.rejects(executePublish(plan, {}), /broadcast.*required|executor/);
  });
});
