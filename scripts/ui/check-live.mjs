'use strict';
// Exercises web/rpc.js decoders against live X Layer (uses global fetch).
// Run: node scripts/ui/check-live.mjs  (opt-in; NOT part of npm test)
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const ctx = { fetch, console, URL };
vm.createContext(ctx);
const combined = ['data.js', 'rpc.js']
  .map((f) => fs.readFileSync(path.join(ROOT, 'web', f), 'utf8')).join('\n');
vm.runInContext(combined + '\nglobalThis.__Live = Live; globalThis.__D = KERNEL_SNAPSHOT; globalThis.__S = KERNEL_SELECTORS; globalThis.__ethCall = ethCall; globalThis.__decRecord = decRecord;', ctx, { filename: 'web-bundle' });
const Live = ctx.__Live, D = ctx.__D, S = ctx.__S, ethCall = ctx.__ethCall, decRecord = ctx.__decRecord;

(async () => {
  const checks = [];
  const check = (name, cond, detail = '') => {
    checks.push({ name, ok: !!cond, detail });
    console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${detail ? ' -- ' + detail : ''}`);
  };
  const block = await Live.blockNumber().catch((e) => 'ERR:' + e.message);
  check('block reachable', !String(block).startsWith('ERR'), String(block));
  const info = await Live.circuitInfo(D.trace.processor, 1).catch((e) => ({ err: e.message }));
  check('circuitInfo(1) = 4/2/0/8', !info.err && info.nIn === 4n && info.nOut === 2n && info.nState === 0n && info.gateCount === 8n, JSON.stringify(info, (_, v) => typeof v === 'bigint' ? v.toString() : v));
  const nl = await Live.netlist(D.trace.processor, 1).catch((e) => 'ERR');
  check('netlist(1) decodes to 56 bytes', typeof nl === 'string' && (nl.length - 2) / 2 === 56);
  const o1 = await Live.ownerOf(D.trace.processor, 1).catch(() => null);
  check('ownerOf(1) == snapshot payee', o1 && o1.toLowerCase() === D.ip.payee.toLowerCase(), o1);
  const o2 = await Live.ownerOf(D.trace.processor, 2).catch(() => null);
  check('ownerOf(2) == snapshot payer', o2 && o2.toLowerCase() === D.result.payer.toLowerCase(), o2);
  const reg = await Live.isRegistered(D.registry.address, D.ip.keyHash).catch(() => null);
  check('isRegistered(TRACE#1) true', reg === true);
  const rec = await (async () => {
    try {
      const raw = await ethCall(D.registry.address, S.getRegistration + D.ip.keyHash.slice(2).padStart(64, '0'));
      return decRecord(raw);
    } catch { return null; }
  })();
  check('record payee/price match snapshot', rec && rec.payee.toLowerCase() === D.ip.payee.toLowerCase() && rec.priceWei === D.ip.priceWei, rec && rec.priceWei);
  const fee = await Live.tapeoutFee(D.trace.processor).catch(() => null);
  check('TAPEOUT_FEE == 0.0013 OKB', fee === '1300000000000000', fee);
  const bad = checks.filter((c) => !c.ok);
  if (bad.length) process.exit(1);
  console.log('UI live layer: all checks passed.');
})().catch((e) => { console.error('FATAL', e.message); process.exit(1); });

