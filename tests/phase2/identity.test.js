'use strict';
/**
 * tests/phase2/identity.test.js — deterministic circuit identity. Run: npm test (offline)
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  makeIdentity, identityKey, slotKey, parseIdentityKey, parseSlotKey, equalSlot, equalExact,
} = require('../../src/lineage/identity');

const PROC = '0x7761cE17a2e75C6910f1D5a77E6F66CD9Ca1274a';
const HASH = '0x' + 'ab'.repeat(32);

describe('circuit identity', () => {
  it('is deterministic across representations', () => {
    const a = makeIdentity({ chainId: 196, processor: PROC, circuitId: 1, netlistHash: HASH.toUpperCase() });
    const b = makeIdentity({ chainId: '196', processor: PROC.toLowerCase(), circuitId: 1n, netlistHash: HASH });
    const c = makeIdentity({ chainId: 196n, processor: PROC, circuitId: '1' });
    assert.deepEqual(a, b);
    assert.equal(identityKey(a), identityKey(b));
    assert.equal(identityKey(a), `tapeout:v1:196:${PROC.toLowerCase()}:1:${HASH}`);
    assert.equal(identityKey(c), `tapeout:v1:196:${PROC.toLowerCase()}:1:unverified`);
  });

  it('chainId is part of identity (same slot, different chain => different key)', () => {
    const x = identityKey({ chainId: 196, processor: PROC, circuitId: 1 });
    const b = identityKey({ chainId: 56, processor: PROC, circuitId: 1 });
    assert.notEqual(x, b);
  });

  it('key round-trips exactly', () => {
    const id = makeIdentity({ chainId: 196, processor: PROC, circuitId: 11, netlistHash: HASH });
    assert.deepEqual(parseIdentityKey(identityKey(id)), id);
    const bare = makeIdentity({ chainId: 196, processor: PROC, circuitId: 11 });
    assert.deepEqual(parseIdentityKey(identityKey(bare)), bare);
    assert.throws(() => parseIdentityKey('tapeout:v1:196:0x123:1:unverified'), /bad key/);
    assert.throws(() => parseIdentityKey('nonsense'), /bad key/);
  });

  it('slot vs exact equality: identity is not the hash', () => {
    const p = { chainId: 196, processor: PROC, circuitId: 1, netlistHash: HASH };
    const q = { chainId: 196, processor: PROC, circuitId: 1, netlistHash: '0x' + 'cd'.repeat(32) };
    const r = { chainId: 196, processor: PROC, circuitId: 1 };
    assert.equal(equalSlot(p, q), true); // same on-chain slot
    assert.equal(equalExact(p, q), false); // ...but different observed content
    assert.equal(equalExact(p, r), false); // unverified never equals exact
    assert.equal(equalExact(p, { ...p }), true);
    assert.equal(slotKey(p), slotKey(r)); // slot ignores content
  });

  it('rejects bad inputs loudly', () => {
    assert.throws(() => makeIdentity({ chainId: 0, processor: PROC, circuitId: 1 }), /chainId/);
    assert.throws(() => makeIdentity({ chainId: 196, processor: '0x123', circuitId: 1 }), /processor/);
    assert.throws(() => makeIdentity({ chainId: 196, processor: '0x' + '00'.repeat(20), circuitId: 1 }), /zero/);
    assert.throws(() => makeIdentity({ chainId: 196, processor: PROC, circuitId: 0 }), /start at 1/);
    assert.throws(() => makeIdentity({ chainId: 196, processor: PROC, circuitId: 1, netlistHash: '0x123' }), /netlistHash/);
  });

  it('parseSlotKey parses slot keys (Phase 3 addition; old functions unchanged)', () => {
    const s = slotKey({ chainId: 196, processor: PROC, circuitId: 7 });
    assert.deepEqual(parseSlotKey(s), { chainId: '196', processor: PROC.toLowerCase(), circuitId: '7' });
    assert.throws(() => parseSlotKey('tapeout:v1:196:0x123:7'), /bad slot key/);
    assert.throws(() => parseSlotKey(identityKey({ chainId: 196, processor: PROC, circuitId: 7 })), /bad slot key/);
  });
});
