'use strict';
/**
 * tests/phase4/router.test.js — (A) offline: calldata/event cross-checks vs the
 * compiled router; (B) execution: real in-process EVM runs of register → pay →
 * mint → tapeout → prove, incl. every revert path. Run: npm test (offline).
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { ethers } = require('ethers');
const { createAddressFromString, bytesToHex } = require('@ethereumjs/util');
const { createHarness } = require('./evm-harness');
const { routerInterface, buildLicenseCalldata } = require('../../src/router/client');
const { computeLineageHash } = require('../../src/router/commitment');
const { keyHashFor } = require('../../src/registry/client');
const { hashTerms } = require('../../src/registry/terms');

const BUILD = path.join(__dirname, '..', '..', 'build');
const abiOf = (name) => new ethers.Interface(JSON.parse(fs.readFileSync(path.join(BUILD, `${name}.json`), 'utf8')).abi);

const MINT_PRICE = 1000000000000n;
const PROTO_FEE = 660000000000000n;
const TAPEOUT_FEE = 1300000000000000n;
const PRICE = 500000000000000n; // 0.0005 OKB demo price
const DEP_NL = '0x00000002000002'; // 1-gate NOT, nIn=1, nOut=1
const TERMS = hashTerms({ version: 1, model: 'single-license', priceWei: PRICE.toString(), currency: 'OKB', attributionRequired: true });

describe('router client vs compiled contract', () => {
  it('fragments match compiled selectors/topics/errors', () => {
    const compiled = abiOf('LicensedTapeoutRouter');
    for (const f of ['licenseAndTapeout', 'REGISTRY', 'FACTORY', 'MAX_NETLIST_BYTES', 'MAX_REFS']) {
      assert.equal(routerInterface.getFunction(f).selector, compiled.getFunction(f).selector, f);
    }
    for (const e of ['LicensedTapeout', 'LicensePaid']) {
      assert.equal(routerInterface.getEvent(e).topicHash, compiled.getEvent(e).topicHash, e);
    }
    for (const err of ['WrongValue', 'UnregisteredDep', 'NetlistMismatch', 'Reentrant', 'PayFailed', 'MintFailed', 'TapeoutFailed', 'TransferFailed', 'PinMismatch', 'MissingTerms', 'ZeroPayee', 'TooManyRefs', 'NetlistTooLarge', 'MalformedNetlist', 'NotFactoryCpu', 'InactiveDep', 'MissingDependency']) {
      assert.equal(routerInterface.getError(err).selector, compiled.getError(err).selector, err);
    }
  });

  it('licenseAndTapeout calldata round-trips; LicensedTapeout event parses', () => {
    const target = '0x7761ce17a2e75c6910f1d5a77e6f66cd9ca1274a';
    const data = buildLicenseCalldata({ targetCpu: target, netlist: DEP_NL, nIn: 1, nOut: 1 });
    const tx = routerInterface.parseTransaction({ data });
    assert.equal(tx.name, 'licenseAndTapeout');
    assert.equal(tx.args.nl.toLowerCase(), DEP_NL);
    const ev = routerInterface.getEvent('LicensedTapeout');
    const vals = [target, 2n, ethers.keccak256('0x1234'), PRICE, 1n, target];
    const enc = routerInterface.encodeEventLog(ev, vals);
    const parsed = routerInterface.parseLog({ topics: enc.topics, data: enc.data });
    assert.equal(parsed.args.newCircuitId, 2n);
    assert.equal(parsed.args.totalPriceWei, PRICE);
    assert.throws(() => buildLicenseCalldata({ targetCpu: '0x123', netlist: DEP_NL, nIn: 1, nOut: 1 }), /targetCpu/);
  });
});

describe('router execution (in-process EVM)', () => {
  const hex = (addrObj) => bytesToHex(addrObj.bytes);

  // Full stack + seeded dep circuit #1 (via real mint+tapeout) + registration.
  // Chain id inside the EVM is 1: registrations use chainId 1.
  async function setup({ depPrice = PRICE, depTerms = TERMS } = {}) {
    const h = await createHarness();
    const call = (from, toHex, abiName, fn, args = [], value = 0n) => h.send({
      from, to: createAddressFromString(ethers.getAddress(toHex)),
      data: abiOf(abiName).encodeFunctionData(fn, args), value,
    });
    const deployer = h.eoa(11), payer = h.eoa(22), payee = h.eoa(33);
    await h.fund(payer, 10n ** 24n);
    await h.fund(deployer, 10n ** 24n);
    const trans = await h.deploy(deployer, 'StubTransistors', MINT_PRICE, PROTO_FEE);
    const proc = await h.deploy(deployer, 'StubProcessor', trans.address);
    await call(deployer, trans.address, 'StubTransistors', 'setBurner', [proc.address]);
    const fact = await h.deploy(deployer, 'StubFactory');
    await call(deployer, fact.address, 'StubFactory', 'addCpu', [proc.address]);
    const reg = await h.deploy(deployer, 'AttributionRegistry');
    const router = await h.deploy(deployer, 'LicensedTapeoutRouter', reg.address, fact.address);
    // Seed dependency circuit #1 through mint + tapeout (1 NAND).
    await call(deployer, trans.address, 'StubTransistors', 'mint', [0n, 1n], MINT_PRICE + PROTO_FEE);
    await call(deployer, proc.address, 'StubProcessor', 'tapeout', [DEP_NL, 1, 1], TAPEOUT_FEE);
    const depHash = ethers.keccak256(DEP_NL);
    await call(deployer, reg.address, 'AttributionRegistry', 'register',
      [1n, proc.address, 1n, depHash, hex(payee), depPrice, depTerms]);
    const key = keyHashFor({ chainId: 1, processor: proc.address, circuitId: 1 });
    return { h, call, deployer, payer, payee, trans, proc, fact, reg, router, depHash, key };
  }

  // Root: single REF(proc:1, ins=[2], nOut=1), nIn=1. 34 bytes, 0 own material.
  const refRoot = (procHex) => '0x02' + procHex.slice(2).toLowerCase()
    + '0000000000000001' + '0101' + '000002';

  const licenseCall = (s, rootNl, nIn, nOut, value) => s.call(
    s.payer, s.router.address, 'LicensedTapeoutRouter', 'licenseAndTapeout',
    [s.proc.address, rootNl, nIn, nOut], value,
  );

  const licensedEvent = (s, res) => {
    const hits = res.logs.map((l) => {
      try { return routerInterface.parseLog(l); } catch { return null; }
    }).filter((p) => p && p.name === 'LicensedTapeout');
    assert.equal(hits.length, 1);
    return hits[0].args;
  };

  const revertName = (res) => {
    try {
      const data = res.returnValue && res.returnValue !== '0x' ? res.returnValue : null;
      if (!data || data.length < 10) return null;
      return routerInterface.parseError(data).name;
    } catch { return null; }
  };

  const expectedLineage = (s, rootNl, nIn, nOut) => computeLineageHash({
    targetCpu: s.proc.address, nIn, nOut, netlist: rootNl,
    deps: [{
      keyHash: s.key, netlistHash: s.depHash,
      payee: bytesToHex(s.payee.bytes), priceWei: PRICE.toString(), termsHash: TERMS,
    }],
  });

  it('valid path: pays, manufactures, proves; event matches local lineageHash', async () => {
    const s = await setup();
    const root = refRoot(s.proc.address);
    const before = await s.h.balanceOf(s.payee);
    const res = await licenseCall(s, root, 1, 1, PRICE + TAPEOUT_FEE);
    assert.equal(res.status, 1);
    const ev = licensedEvent(s, res);
    assert.equal(ev.targetCpu.toLowerCase(), s.proc.address.toLowerCase());
    assert.equal(ev.newCircuitId, 2n); // dep used #1; root mints #2
    assert.equal(ev.lineageHash, expectedLineage(s, root, 1, 1));
    assert.equal(ev.totalPriceWei, PRICE);
    assert.equal(ev.depCount, 1n);
    assert.equal(ev.payer.toLowerCase(), bytesToHex(s.payer.bytes));
    // Payment observable; NFT forwarded to payer.
    assert.equal((await s.h.balanceOf(s.payee)) - before, PRICE);
    const own = await s.call(s.payer, s.proc.address, 'StubProcessor', 'ownerOf', [2n]);
    assert.equal(own.status, 1);
  });

  it('failed tapeout reverts payment (no event, balances unchanged)', async () => {
    const s = await setup();
    await s.call(s.deployer, s.proc.address, 'StubProcessor', 'setFailTapeout', [true]);
    const before = await s.h.balanceOf(s.payee);
    const root = refRoot(s.proc.address);
    const res = await licenseCall(s, root, 1, 1, PRICE + TAPEOUT_FEE);
    assert.equal(res.status, 0);
    assert.equal(revertName(res), 'TapeoutFailed');
    assert.equal(res.logs.length, 0); // no LicensedTapeout, no LicensePaid
    assert.equal(await s.h.balanceOf(s.payee), before);
  });

  it('failed mint reverts (payment unwound)', async () => {
    const s = await setup();
    // Root with 1 own NAND + REF: NAND(2,3)->4 then REF(proc:1, ins=[2], nOut=1).
    const root = '0x00000002000003' + refRoot(s.proc.address).slice(2).replace(/^02/, '02');
    await s.call(s.deployer, s.trans.address, 'StubTransistors', 'setFailMint', [true]);
    const before = await s.h.balanceOf(s.payee);
    const res = await licenseCall(s, root, 2, 1, PRICE + MINT_PRICE + PROTO_FEE + TAPEOUT_FEE);
    assert.equal(res.status, 0);
    assert.equal(revertName(res), 'MintFailed');
    assert.equal(await s.h.balanceOf(s.payee), before);
  });

  it('duplicate REF records pay once (unique identityKey model)', async () => {
    const s = await setup();
    const one = refRoot(s.proc.address).slice(2);
    // Two identical REF records; nIn=1, both ins=[2]; nOut=2 (outputs 3,4).
    const root = '0x' + one + one;
    const res = await licenseCall(s, root, 1, 2, PRICE + TAPEOUT_FEE);
    assert.equal(res.status, 1);
    const ev = licensedEvent(s, res);
    assert.equal(ev.depCount, 1n);
    assert.equal(ev.totalPriceWei, PRICE);
  });

  it('value policy: insufficient and excess both revert', async () => {
    const s = await setup();
    const root = refRoot(s.proc.address);
    const good = PRICE + TAPEOUT_FEE;
    const under = await licenseCall(s, root, 1, 1, good - 1n);
    assert.equal(under.status, 0);
    assert.equal(revertName(under), 'WrongValue');
    const over = await licenseCall(s, root, 1, 1, good + 1n);
    assert.equal(over.status, 0);
    assert.equal(revertName(over), 'WrongValue');
  });

  it('registry states: unregistered / inactive / mismatch / missing-terms all revert', async () => {
    // Unregistered (fresh stack, no registration for id 9 target... use unknown dep id).
    const s = await setup();
    const ghost = '0x02' + s.proc.address.slice(2).toLowerCase() + '0000000000000009' + '0101' + '000002';
    const r1 = await licenseCall(s, ghost, 1, 1, PRICE + TAPEOUT_FEE);
    assert.equal(r1.status, 0);
    assert.equal(revertName(r1), 'UnregisteredDep');

    // Inactive.
    const s2 = await setup();
    await s2.call(s2.deployer, s2.reg.address, 'AttributionRegistry', 'deactivate', [s2.key]);
    const r2 = await licenseCall(s2, refRoot(s2.proc.address), 1, 1, PRICE + TAPEOUT_FEE);
    assert.equal(r2.status, 0);
    assert.equal(revertName(r2), 'InactiveDep');

    // Mismatch (re-register semantics: fresh stack, wrong hash at registration).
    const s3 = await setup();
    await s3.call(s3.deployer, s3.reg.address, 'AttributionRegistry', 'updateTerms',
      [s3.key, ethers.keccak256('0x1234'), bytesToHex(s3.payee.bytes), PRICE, TERMS]);
    const r3 = await licenseCall(s3, refRoot(s3.proc.address), 1, 1, PRICE + TAPEOUT_FEE);
    assert.equal(r3.status, 0);
    assert.equal(revertName(r3), 'NetlistMismatch');

    // Missing terms (termsHash 0x0).
    const s4 = await setup({ depTerms: '0x' + '00'.repeat(32) });
    const r4 = await licenseCall(s4, refRoot(s4.proc.address), 1, 1, PRICE + TAPEOUT_FEE);
    assert.equal(r4.status, 0);
    assert.equal(revertName(r4), 'MissingTerms');
  });

  it('pin mismatch reverts before payment', async () => {
    const s = await setup();
    // REF claims nIns=2/nOut=2 but live dep exposes 1/1.
    const bad = '0x02' + s.proc.address.slice(2).toLowerCase() + '0000000000000001' + '0202' + '000002000003';
    const before = await s.h.balanceOf(s.payee);
    const res = await s.call(s.payer, s.router.address, 'LicensedTapeoutRouter', 'licenseAndTapeout',
      [s.proc.address, bad, 2, 2], PRICE + TAPEOUT_FEE);
    assert.equal(res.status, 0);
    assert.equal(revertName(res), 'PinMismatch');
    assert.equal(await s.h.balanceOf(s.payee), before);
  });

  it('reentrancy via payee reverts the whole licensed tape-out', async () => {
    const s = await setup();
    // Deploy griefer payee, arm it to reenter, register dep pointing at it.
    const griefer = await s.h.deploy(s.deployer, 'ReenteringPayee', s.router.address);
    const root = refRoot(s.proc.address);
    const inner = abiOf('LicensedTapeoutRouter').encodeFunctionData(
      'licenseAndTapeout', [s.proc.address, root, 1, 1]);
    await s.call(s.deployer, griefer.address, 'ReenteringPayee', 'arm', [inner, PRICE + TAPEOUT_FEE]);
    await s.call(s.deployer, s.reg.address, 'AttributionRegistry', 'updateTerms',
      [s.key, s.depHash, griefer.address, PRICE, TERMS]);
    const before = await s.h.balanceOf(s.deployer);
    const res = await licenseCall(s, root, 1, 1, PRICE + TAPEOUT_FEE);
    assert.equal(res.status, 0); // inner Reentrant() -> receive reverts -> PayFailed
    assert.equal(revertName(res), 'PayFailed');
    assert.equal(await s.h.balanceOf(s.deployer), before);
  });

  it('reverting payee griefs visibly (PayFailed, nothing paid)', async () => {
    const s = await setup();
    const bad = await s.h.deploy(s.deployer, 'RevertingPayee');
    await s.call(s.deployer, s.reg.address, 'AttributionRegistry', 'updateTerms',
      [s.key, s.depHash, bad.address, PRICE, TERMS]);
    const res = await licenseCall(s, refRoot(s.proc.address), 1, 1, PRICE + TAPEOUT_FEE);
    assert.equal(res.status, 0);
    assert.equal(revertName(res), 'PayFailed');
  });

  it('stale registry reads cannot slip through: execution uses live state', async () => {
    const s = await setup();
    const root = refRoot(s.proc.address);
    // Preflight-era price was PRICE; registrant doubles it before execution.
    await s.call(s.deployer, s.reg.address, 'AttributionRegistry', 'updateTerms',
      [s.key, s.depHash, bytesToHex(s.payee.bytes), PRICE * 2n, TERMS]);
    const stale = await licenseCall(s, root, 1, 1, PRICE + TAPEOUT_FEE);
    assert.equal(stale.status, 0);
    assert.equal(revertName(stale), 'WrongValue');
    const fresh = await licenseCall(s, root, 1, 1, PRICE * 2n + TAPEOUT_FEE);
    assert.equal(fresh.status, 1);
    assert.equal(licensedEvent(s, fresh).totalPriceWei, PRICE * 2n);
  });

  it('zero-price dependency succeeds with event but no transfer', async () => {
    const s = await setup({ depPrice: 0n });
    const root = refRoot(s.proc.address);
    const res = await licenseCall(s, root, 1, 1, TAPEOUT_FEE);
    assert.equal(res.status, 1);
    const paid = res.logs.map((l) => {
      try { return routerInterface.parseLog(l); } catch { return null; }
    }).filter((p) => p && p.name === 'LicensePaid');
    assert.equal(paid.length, 1);
    assert.equal(paid[0].args.price, 0n);
  });

  it('large values work; overflow reverts safely', async () => {
    const s = await setup({ depPrice: 10n ** 30n });
    await s.h.fund(s.payer, 2n ** 200n);
    const root = refRoot(s.proc.address);
    const res = await licenseCall(s, root, 1, 1, 10n ** 30n + TAPEOUT_FEE);
    assert.equal(res.status, 1);
    assert.equal(licensedEvent(s, res).totalPriceWei, 10n ** 30n);
    // Dedup avoids double-count: same max-price dep twice still pays once.
    const s2 = await setup({ depPrice: 2n ** 255n });
    await s2.h.fund(s2.payer, 2n ** 256n - 1n);
    const one = refRoot(s2.proc.address).slice(2);
    const two = '0x' + one + one;
    const r2 = await licenseCall(s2, two, 1, 2, 2n ** 255n + TAPEOUT_FEE);
    assert.equal(r2.status, 1);
    assert.equal(licensedEvent(s2, r2).totalPriceWei, 2n ** 255n);
    // required = licenseTotal + mintValue + tapeoutFee overflows at uint256 max
    // (checked arithmetic panics; status 0, no event, nothing paid).
    const s3 = await setup({ depPrice: 2n ** 256n - 1n });
    await s3.h.fund(s3.payer, 2n ** 256n - 1n);
    const r3 = await licenseCall(s3, refRoot(s3.proc.address), 1, 1, 2n ** 256n - 1n - 10n ** 18n);
    assert.equal(r3.status, 0);
    assert.equal(r3.logs.length, 0);
  });

  it('structural guards: unknown target, malformed, too-large, too-many', async () => {
    const s = await setup();
    const root = refRoot(s.proc.address);
    // Unknown target processor.
    const r0 = await s.call(s.payer, s.router.address, 'LicensedTapeoutRouter', 'licenseAndTapeout',
      ['0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', root, 1, 1], PRICE + TAPEOUT_FEE);
    assert.equal(r0.status, 0);
    assert.equal(revertName(r0), 'NotFactoryCpu');
    // Malformed netlist.
    const r1 = await licenseCall(s, '0xff00', 0, 1, PRICE + TAPEOUT_FEE);
    assert.equal(r1.status, 0);
    assert.equal(revertName(r1), 'MalformedNetlist');
    // Too many REFs (17 identical).
    const one = refRoot(s.proc.address).slice(2);
    const many = '0x' + one.repeat(17);
    const r2 = await licenseCall(s, many, 1, 17, PRICE + TAPEOUT_FEE);
    assert.equal(r2.status, 0);
    assert.equal(revertName(r2), 'TooManyRefs');
    // Oversized netlist (length gate fires before any walk).
    const r3 = await licenseCall(s, '0x' + '00'.repeat(8193), 0, 1, PRICE + TAPEOUT_FEE);
    assert.equal(r3.status, 0);
    assert.equal(revertName(r3), 'NetlistTooLarge');
  });
});
