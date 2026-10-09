'use strict';
/**
 * tests/ui/snapshot.test.js — offline internal consistency of web/data.js.
 * (Live re-verification lives in scripts/ui/check-live.mjs, opt-in.)
 * Run: npm test (offline, no key, no RPC)
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { ethers } = require('ethers');

const ROOT = path.join(__dirname, '..', '..');
const ctx = {};
vm.createContext(ctx);
vm.runInContext(
  fs.readFileSync(path.join(ROOT, 'web', 'data.js'), 'utf8') + '\nglobalThis.__D = KERNEL_SNAPSHOT; globalThis.__S = KERNEL_SELECTORS;',
  ctx,
);
const D = ctx.__D;
const S = ctx.__S;

describe('UI snapshot consistency', () => {
  it('slot keyHash matches canonical derivation', () => {
    const preimage = ethers.AbiCoder.defaultAbiCoder().encode(
      ['uint256', 'address', 'uint256'], [196n, D.ip.processor, 1n],
    );
    assert.equal(ethers.keccak256(preimage), D.ip.keyHash);
  });

  it('totals add up in integer wei (no floats)', () => {
    assert.equal(
      (BigInt(D.composition.licenseWei) + BigInt(D.composition.tapeoutFeeWei)).toString(),
      D.composition.valueWei,
    );
    assert.equal(D.composition.valueWei, '1800000000000000');
  });

  it('embedded calldata matches canonical encoding of the demo root', () => {
    const iface = new ethers.Interface(['function licenseAndTapeout(address,bytes,uint32,uint32)']);
    const data = iface.encodeFunctionData('licenseAndTapeout', [D.trace.processor, D.composition.netlist, D.composition.nIn, D.composition.nOut]);
    assert.equal(data.toLowerCase(), D.composition.calldata.toLowerCase());
    assert.ok(D.composition.calldata.toLowerCase().startsWith(S.licenseAndTapeout.toLowerCase()));
  });

  it('demo fixture and UI snapshot agree byte-for-byte', () => {
    const fix = JSON.parse(fs.readFileSync(path.join(ROOT, 'fixtures', 'final', 'demo-root.json'), 'utf8'));
    assert.equal(fix.netlist.toLowerCase(), D.composition.netlist.toLowerCase());
    assert.equal(fix.lineageHash.toLowerCase(), D.composition.lineageHash.toLowerCase());
    assert.equal(fix.dependencies[0].netlistHashExpected.toLowerCase(), D.ip.netlistHash.toLowerCase());
    assert.equal(fix.dependencies[0].termsHash.toLowerCase(), D.ip.termsHash.toLowerCase());
  });

  it('addresses/hashes are well-formed; explorer links derivable', () => {
    for (const a of [D.factory, D.registry.address, D.trace.processor, D.trace.transistors, D.router.address, D.ip.payee, D.result.payer]) {
      assert.match(a, /^0x[0-9a-fA-F]{40}$/, a);
    }
    for (const h of [D.ip.keyHash, D.ip.netlistHash, D.ip.termsHash, D.composition.lineageHash, D.composition.netlistKeccak]) {
      assert.match(h, /^0x[0-9a-f]{64}$/, h);
    }
    for (const t of [D.registry.deployTx, D.ip.registrationTx, D.router.deployTx, D.result.tx]) {
      assert.match(t, /^0x[0-9a-fA-F]{64}$/, t);
    }
  });

  it('receipt internals are consistent (circuit, payer, value, block order)', () => {
    assert.equal(D.result.circuitId, '2');
    assert.ok(D.result.block > D.router.deployBlock && D.router.deployBlock > D.ip.registrationBlock);
    assert.equal(BigInt(D.result.payeeDeltaWei).toString(), D.ip.priceWei);
  });

  it('brand assets exist and are wired (logo, favicon, theme)', () => {
    for (const f of ['assets/kernel-mark.png', 'assets/favicon.png', 'assets/apple-touch-icon.png', 'assets/kernel-lockup.png']) {
      const st = fs.statSync(path.join(ROOT, 'web', f));
      assert.ok(st.size > 1000, `${f} unexpectedly small`);
    }
    const html = fs.readFileSync(path.join(ROOT, 'web', 'index.html'), 'utf8');
    assert.ok(html.includes('rel="icon"') && html.includes('assets/favicon.png'));
    assert.ok(html.includes('rel="apple-touch-icon"'));
    assert.ok(html.includes('#1B17FF'), 'theme-color must match the logo blue');
    const css = fs.readFileSync(path.join(ROOT, 'web', 'styles.css'), 'utf8');
    assert.ok(css.includes('#1b17ff') || css.includes('#1B17FF'), 'brand blue in theme');
    assert.ok(!css.includes('#7dd3a8'), 'old green accent must be gone');
    const app = fs.readFileSync(path.join(ROOT, 'web', 'app.js'), 'utf8');
    assert.ok(app.includes('assets/kernel-mark.png'), 'header brand mark');
    assert.ok(app.includes('assets/kernel-lockup.png'), 'hero lockup');
  });
});
