'use strict';
/**
 * In-memory AttributionRegistry twin for offline tests and dry flows.
 *
 * Mirrors the Solidity semantics 1:1 (same validations, same state machine):
 *  register → duplicate rejects · updateTerms → registrant+active only ·
 *  deactivate → permanent · get/isRegistered. Thrown Error codes match the
 * contract's custom-error names (AlreadyRegistered, NotRegistered, NotRegistrant,
 * InactiveRecord, InvalidParam) so tests assert the same vocabulary on both sides.
 *
 * NOT a replacement for the contract: it cannot prove on-chain behavior. It is a
 * deterministic reference for exercising attribution flows without funding.
 */
const { keyHashFor } = require('./client');

class MemoryRegistry {
  constructor() {
    this.records = new Map(); // keyHash -> record
    this.time = 1700000000; // deterministic clock source for tests
  }

  _now() {
    return this.time++;
  }

  _key(chainId, processor, circuitId) {
    return keyHashFor({ chainId, processor, circuitId });
  }

  register({ chainId, processor, circuitId, netlistHash, payee, priceWei, termsHash, by }) {
    if (!/^0[xX][0-9a-fA-F]{64}$/.test(netlistHash || '')) {
      const e = new Error('InvalidParam: netlistHash'); e.code = 'InvalidParam'; throw e;
    }
    const nh = '0x' + netlistHash.slice(2).toLowerCase();
    if (nh === '0x' + '00'.repeat(32)) {
      const e = new Error('InvalidParam: netlistHash'); e.code = 'InvalidParam'; throw e;
    }
    if (!/^0[xX][0-9a-fA-F]{40}$/.test(payee || '')) {
      const e = new Error('InvalidParam: payee'); e.code = 'InvalidParam'; throw e;
    }
    const py = '0x' + payee.slice(2).toLowerCase();
    if (/^0x0{40}$/.test(py)) {
      const e = new Error('InvalidParam: payee'); e.code = 'InvalidParam'; throw e;
    }
    const key = this._key(chainId, processor, circuitId); // validates slot too
    if (this.records.has(key)) {
      const e = new Error(`AlreadyRegistered: ${key}`); e.code = 'AlreadyRegistered'; throw e;
    }
    const rec = {
      netlistHash: nh,
      payee: py,
      priceWei: BigInt(priceWei).toString(),
      termsHash: '0x' + String(termsHash).slice(2).toLowerCase(),
      registeredAt: this._now(),
      registeredBy: String(by).toLowerCase(),
      active: true,
      exists: true,
    };
    this.records.set(key, rec);
    return { key, record: { ...rec } };
  }

  updateTerms({ key, netlistHash, payee, priceWei, termsHash, by }) {
    const r = this.records.get(String(key).toLowerCase());
    if (!r) {
      const e = new Error(`NotRegistered: ${key}`); e.code = 'NotRegistered'; throw e;
    }
    if (r.registeredBy !== String(by).toLowerCase()) {
      const e = new Error(`NotRegistrant: ${key}`); e.code = 'NotRegistrant'; throw e;
    }
    if (!r.active) {
      const e = new Error(`InactiveRecord: ${key}`); e.code = 'InactiveRecord'; throw e;
    }
    const nh = '0x' + String(netlistHash).slice(2).toLowerCase();
    if (!/^0x[0-9a-f]{64}$/.test(nh) || nh === '0x' + '00'.repeat(32)) {
      const e = new Error('InvalidParam: netlistHash'); e.code = 'InvalidParam'; throw e;
    }
    r.netlistHash = nh;
    r.payee = '0x' + String(payee).slice(2).toLowerCase();
    r.priceWei = BigInt(priceWei).toString();
    r.termsHash = '0x' + String(termsHash).slice(2).toLowerCase();
    return { ...r };
  }

  deactivate({ key, by }) {
    const r = this.records.get(String(key).toLowerCase());
    if (!r) {
      const e = new Error(`NotRegistered: ${key}`); e.code = 'NotRegistered'; throw e;
    }
    if (r.registeredBy !== String(by).toLowerCase()) {
      const e = new Error(`NotRegistrant: ${key}`); e.code = 'NotRegistrant'; throw e;
    }
    if (!r.active) {
      const e = new Error(`InactiveRecord: ${key}`); e.code = 'InactiveRecord'; throw e;
    }
    r.active = false;
    return { ...r };
  }

  getRegistration(key) {
    const r = this.records.get(String(key).toLowerCase());
    return r ? { ...r } : null;
  }

  isRegistered(key) {
    const r = this.records.get(String(key).toLowerCase());
    return !!r && r.active;
  }
}

module.exports = { MemoryRegistry };
