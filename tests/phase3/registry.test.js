'use strict';
/**
 * tests/phase3/registry.test.js — memory-twin semantics, key derivation,
 * calldata round-trips, client↔contract cross-checks. Run: npm test (offline)
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { ethers } = require('ethers');
const { MemoryRegistry } = require('../../src/registry/memory');
const {
  REGISTRY_ABI, registryInterface, keyHashFor,
  buildRegisterCalldata, buildUpdateCalldata, buildDeactivateCalldata,
} = require('../../src/registry/client');

const PROC = '0x7761ce17a2e75c6910f1d5a77e6f66cd9ca1274a';
const PAYEE = '0x1d207352dd708498cada1524eb4b36b5fa178886';
const BY = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const OTHER = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const NH = '0x' + '11'.repeat(32);
const TH = '0x' + '22'.repeat(32);

function fresh() {
  return new MemoryRegistry();
}
function regArgs(over = {}) {
  return {
    chainId: 196, processor: PROC, circuitId: 1, netlistHash: NH,
    payee: PAYEE, priceWei: '10000000000000', termsHash: TH, by: BY, ...over,
  };
}

describe('memory registry semantics (mirrors the contract)', () => {
  it('registration succeeds and reads back exactly', () => {
    const m = fresh();
    const { key, record } = m.register(regArgs());
    assert.equal(key, keyHashFor({ chainId: 196, processor: PROC, circuitId: 1 }));
    assert.equal(m.isRegistered(key), true);
    assert.deepEqual(m.getRegistration(key), record);
    assert.equal(record.active, true);
    assert.equal(record.priceWei, '10000000000000');
  });

  it('duplicate registration is rejected', () => {
    const m = fresh();
    m.register(regArgs());
    assert.throws(() => m.register(regArgs()), (e) => e.code === 'AlreadyRegistered');
    // Same slot, different content is STILL the same key (binding, not versioning).
    assert.throws(
      () => m.register(regArgs({ netlistHash: '0x' + '99'.repeat(32) })),
      (e) => e.code === 'AlreadyRegistered',
    );
  });

  it('unauthorized update is rejected; authorized update succeeds', () => {
    const m = fresh();
    const { key } = m.register(regArgs());
    assert.throws(
      () => m.updateTerms({ key, netlistHash: NH, payee: PAYEE, priceWei: '1', termsHash: TH, by: OTHER }),
      (e) => e.code === 'NotRegistrant',
    );
    const u = m.updateTerms({ key, netlistHash: NH, payee: OTHER, priceWei: '7', termsHash: TH, by: BY });
    assert.equal(u.payee, OTHER.toLowerCase());
    assert.equal(u.priceWei, '7');
  });

  it('update on unknown key and bad fields rejected', () => {
    const m = fresh();
    assert.throws(
      () => m.updateTerms({ key: '0x' + '00'.repeat(32), netlistHash: NH, payee: PAYEE, priceWei: '1', termsHash: TH, by: BY }),
      (e) => e.code === 'NotRegistered',
    );
    const { key } = m.register(regArgs());
    assert.throws(
      () => m.updateTerms({ key, netlistHash: '0x' + '00'.repeat(32), payee: PAYEE, priceWei: '1', termsHash: TH, by: BY }),
      (e) => e.code === 'InvalidParam',
    );
  });

  it('deactivation works, is permanent, and is distinguishable', () => {
    const m = fresh();
    const { key } = m.register(regArgs());
    assert.throws(() => m.deactivate({ key, by: OTHER }), (e) => e.code === 'NotRegistrant');
    m.deactivate({ key, by: BY });
    assert.equal(m.isRegistered(key), false);
    const rec = m.getRegistration(key); // record still readable (tombstone)
    assert.equal(rec.active, false);
    assert.throws(() => m.deactivate({ key, by: BY }), (e) => e.code === 'InactiveRecord');
    assert.throws(
      () => m.updateTerms({ key, netlistHash: NH, payee: PAYEE, priceWei: '1', termsHash: TH, by: BY }),
      (e) => e.code === 'InactiveRecord',
    );
  });

  it('unknown keys read as absent', () => {
    const m = fresh();
    const k = keyHashFor({ chainId: 196, processor: PROC, circuitId: 999 });
    assert.equal(m.getRegistration(k), null);
    assert.equal(m.isRegistered(k), false);
  });

  it('exact identity lookup: different slot fields => different records', () => {
    const m = fresh();
    const k1 = m.register(regArgs({ circuitId: 1 })).key;
    const k2 = m.register(regArgs({ circuitId: 2 })).key;
    const k3 = m.register(regArgs({ chainId: 56, circuitId: 1 })).key;
    assert.notEqual(k1, k2);
    assert.notEqual(k1, k3);
    assert.equal(m.isRegistered(k1) && m.isRegistered(k2) && m.isRegistered(k3), true);
  });
});

describe('slot key derivation (must equal contract slotKey())', () => {
  it('preimage is the 96-byte abi.encode layout', () => {
    const pre = ethers.AbiCoder.defaultAbiCoder().encode(
      ['uint256', 'address', 'uint256'], [196n, PROC.toLowerCase(), 1n],
    );
    assert.equal(pre.length, 2 + 3 * 64);
    assert.equal(pre.slice(2, 66), '00000000000000000000000000000000000000000000000000000000000000c4'); // 196
    assert.equal(pre.slice(66, 130), '000000000000000000000000' + PROC.slice(2).toLowerCase());
    assert.equal(pre.slice(130, 194), '0000000000000000000000000000000000000000000000000000000000000001');
    assert.equal(ethers.keccak256(pre), keyHashFor({ chainId: 196, processor: PROC, circuitId: 1 }));
  });

  it('key differs by chain / processor / id; rejects zero processor and id 0', () => {
    const base = keyHashFor({ chainId: 196, processor: PROC, circuitId: 1 });
    assert.notEqual(base, keyHashFor({ chainId: 56, processor: PROC, circuitId: 1 }));
    assert.notEqual(base, keyHashFor({ chainId: 196, processor: PAYEE, circuitId: 1 }));
    assert.notEqual(base, keyHashFor({ chainId: 196, processor: PROC, circuitId: 2 }));
    assert.throws(() => keyHashFor({ chainId: 196, processor: '0x' + '00'.repeat(20), circuitId: 1 }), /zero/);
    assert.throws(() => keyHashFor({ chainId: 196, processor: PROC, circuitId: 0 }), />= 1/);
  });
});

describe('client calldata (round-trips through our own fragments)', () => {
  it('register/update/deactivate calldata decode back to args', () => {
    const a = { chainId: 196, processor: PROC, circuitId: 1, netlistHash: NH, payee: PAYEE, priceWei: '10000000000000', termsHash: TH };
    const reg = registryInterface.parseTransaction({ data: buildRegisterCalldata(a) });
    assert.equal(reg.name, 'register');
    assert.equal(reg.args.circuitId, 1n);
    assert.equal(reg.args.payee.toLowerCase(), PAYEE.toLowerCase());
    const key = keyHashFor(a);
    const upd = registryInterface.parseTransaction({
      data: buildUpdateCalldata({ key, netlistHash: NH, payee: OTHER, priceWei: '5', termsHash: TH }),
    });
    assert.equal(upd.name, 'updateTerms');
    assert.equal(upd.args.price, 5n);
    const de = registryInterface.parseTransaction({ data: buildDeactivateCalldata({ key }) });
    assert.equal(de.name, 'deactivate');
    assert.equal(de.args.key.toLowerCase(), key);
  });

  it('client fragments match the compiled contract ABI (selectors + topics)', () => {
    const buildPath = path.join(__dirname, '..', '..', 'build', 'AttributionRegistry.json');
    if (!fs.existsSync(buildPath)) throw new Error('build artifact missing — run npm run phase3:compile (pretest)');
    const compiled = new ethers.Interface(JSON.parse(fs.readFileSync(buildPath, 'utf8')).abi);
    for (const frag of ['register', 'updateTerms', 'deactivate', 'getRegistration', 'isRegistered', 'slotKey']) {
      assert.equal(
        registryInterface.getFunction(frag).selector, compiled.getFunction(frag).selector, frag,
      );
    }
    for (const ev of ['Registered', 'TermsUpdated', 'Deactivated']) {
      assert.equal(registryInterface.getEvent(ev).topicHash, compiled.getEvent(ev).topicHash, ev);
    }
    for (const err of ['AlreadyRegistered', 'NotRegistered', 'NotRegistrant', 'InactiveRecord', 'InvalidParam']) {
      assert.equal(registryInterface.getError(err).selector, compiled.getError(err).selector, err);
    }
  });
});
