#!/usr/bin/env node
/**
 * Phase 1 end-to-end deployment orchestrator.
 *
 *   DRY RUN (default-safe, broadcasts NOTHING, needs NO private key):
 *     DRY_RUN=true npm run phase1:deploy
 *     -- or: node scripts/phase1/deploy.mjs --dry-run [--wallet 0x..]
 *
 *   LIVE (only when explicitly authorized; wallet owner runs it):
 *     CONFIRM_BROADCAST=1 node scripts/phase1/deploy.mjs
 *     -- runs create-processor → tapeout → verify sequentially.
 *
 * Dry run prints per step: target contract, function, calldata, value, fees,
 * gas estimate (where the target exists on chain), required balance, and exactly
 * what WOULD be sent. Predicted addresses from staticCall are marked as such:
 * they are only valid if the creation tx is the wallet's next transaction.
 */
import { ethers } from 'ethers';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import {
  loadEnv, getProvider, FACTORY, FACTORY_ABI, CIRCUITS_ABI, TRANSISTORS_ABI,
  fmtOKB, txUrl, addrUrl, parseArgs, readState,
} from './chain.mjs';

const require = createRequire(import.meta.url);
const AND = require('../../src/phase1/circuit.js');
const { audit } = require('../../src/phase1/netlist.js');
const { fingerprint, validateProcessor } = require('../../src/phase1/validate.js');

loadEnv();
const args = parseArgs();
const DRY = args['dry-run'] !== undefined || /^true|1$/i.test(process.env.DRY_RUN || '');

const NAME = process.env.P1_NAME || 'Phase1 Proof';
const SYMBOL = process.env.P1_SYMBOL || 'P1PRF';
const STORY = process.env.P1_STORY || 'Minimal Phase 1 proof circuit (2-gate AND). No license terms; REPL test asset.';
const SUPPLY = BigInt(process.env.P1_SUPPLY || '100');
const MINT_PRICE = BigInt(process.env.P1_MINT_PRICE_WEI || '1000000000000');
const ASSUMED_TAPEOUT_FEE = 1300000000000000n; // re-read live at activation (uniform on X Layer to date)

if (DRY) {
  console.log('='.repeat(72));
  console.log('DRY RUN — read-only simulation. NOTHING IS BROADCAST. This is NOT a deployment.');
  console.log('='.repeat(72));

  const st = readState();
  const walletRaw = args.wallet || process.env.WALLET || st.minter || st.creator || '';
  const walletCheck = validateProcessor(walletRaw);
  const { provider, rpcUrl } = await getProvider();
  const chainId = (await provider.getNetwork()).chainId;
  console.log(`[net] chainId=${chainId} rpc=${rpcUrl}`);
  if (chainId !== 196n) throw new Error('wrong chain — refusing to plan');

  const factory = new ethers.Contract(FACTORY, FACTORY_ABI, provider);
  if ((await provider.getCode(FACTORY)) === '0x') throw new Error('factory has no code');
  const [deployFee, factoryProtoFee, cpuCount] = await Promise.all([
    factory.deployFee(), factory.protocolFee(), factory.cpuCount(),
  ]);
  console.log(`[factory] ${FACTORY} ${addrUrl(FACTORY)}`);
  console.log(`[factory] deployFee=${fmtOKB(deployFee)} protocolFee/mint-call=${fmtOKB(factoryProtoFee)} cpuCount=${cpuCount}`);
  if (!(await factory.isCPU(await factory.cpuAt(0n)))) throw new Error('factory sanity check failed');

  // --- circuit audit (offline, on the exact bytes that would be taped out) ---
  const nl = AND.netlistHex();
  const a = audit(nl, AND.N_IN, AND.N_OUT);
  console.log(`[circuit] 2-gate AND nIn=2 nOut=1 netlist=${nl} (${a.byteLength}B) sha256=${fingerprint(nl)}`);
  console.log(`[circuit] material: ${a.transistors.NAND} NAND + ${a.transistors.LATCH} LATCH, REF=${a.refCount}`);

  // --- step 1: createCPU ---
  const from = walletCheck.ok ? walletCheck.value : '(WALLET env not set — estimates below use zero-address balance)';
  const cdata = factory.interface.encodeFunctionData('createCPU', [NAME, SYMBOL, STORY, SUPPLY, MINT_PRICE]);
  let gasCreate = null; let predicted = null;
  if (walletCheck.ok) {
    try {
      gasCreate = await provider.estimateGas({ from: walletCheck.value, to: FACTORY, data: cdata, value: deployFee });
    } catch (e) { console.log(`[warn] createCPU estimateGas failed: ${e.shortMessage || e.message}`); }
    try {
      const r = await factory.getFunction('createCPU').staticCall(NAME, SYMBOL, STORY, SUPPLY, MINT_PRICE, { from: walletCheck.value, value: deployFee });
      predicted = { transistors: r[0], circuits: r[1] };
    } catch (e) { console.log(`[warn] createCPU staticCall failed: ${e.shortMessage || e.message}`); }
  }
  const balance = walletCheck.ok ? await provider.getBalance(walletCheck.value) : 0n;
  console.log(`[1 createCPU] to=${FACTORY}\n    function=createCPU(string,string,string,uint256,uint256)\n    args=${JSON.stringify([NAME, SYMBOL, STORY, SUPPLY.toString(), MINT_PRICE.toString()])}\n    calldata=${cdata}\n    value=${fmtOKB(deployFee)} (deployFee)\n    gasEstimate=${gasCreate ?? 'n/a (set WALLET)'}${predicted ? `\n    predictedTransistors=${predicted.transistors} (valid ONLY if this is the wallet's next tx)\n    predictedCircuits=${predicted.circuits} (same caveat)` : ''}\n    wallet=${from} balance=${fmtOKB(balance)}\n    will-send: 1 tx createCPU with value=deployFee`);

  // --- step 2: mint (needs transistors addr: predicted, else TBD after step 1) ---
  const needNAND = BigInt(AND.N_NAND);
  const mintValue = needNAND * MINT_PRICE + factoryProtoFee;
  const matIface = new ethers.Interface(TRANSISTORS_ABI);
  const mdata = matIface.encodeFunctionData('mint', [0n, needNAND]);
  console.log(`[2 mint] to=${predicted ? predicted.transistors : '<transistors from step 1>'}\n    function=mint(uint256 id, uint256 amount) args=["0","${needNAND}"]\n    calldata=${mdata}\n    value=${fmtOKB(mintValue)} (= ${needNAND}×${fmtOKB(MINT_PRICE)} mintPrice + ${fmtOKB(factoryProtoFee)} protocolFee)\n    gasEstimate=n/a until processor exists (reference: 96,747 for mint(0,8) on TRACE)\n    will-send: 1 tx mint(0, ${needNAND})`);

  // --- step 3: tapeout ---
  const cpuIface = new ethers.Interface(CIRCUITS_ABI);
  const tdata = cpuIface.encodeFunctionData('tapeout', [nl, AND.N_IN, AND.N_OUT]);
  console.log(`[3 tapeout] to=${predicted ? predicted.circuits : '<processor from step 1>'}\n    function=tapeout(bytes,uint32,uint32) args=[${nl},${AND.N_IN},${AND.N_OUT}]\n    calldata=${tdata}\n    value=${fmtOKB(ASSUMED_TAPEOUT_FEE)} (TAPEOUT_FEE — ASSUMED 0.0013, re-read live at activation)\n    gasEstimate=n/a until processor exists (reference: ~240k for 8-gate tapeout on TRACE)\n    will-send: 1 tx tapeout, expect TapedOut(circuitId=1, gateCount=2, nState=0)`);

  // --- step 4+: read + verify (read-only, always available post-activation) ---
  console.log(`[4 verify] read-only: node scripts/phase1/verify.mjs (≈30 checks, full on-chain eval table)`);

  // --- totals ---
  const feeData = await provider.getFeeData();
  const gasPrice = feeData.gasPrice ?? 0n;
  const gasBudget = 1400000n; // create ~1M + mint ~100k + tapeout ~250k, rounded up
  const gasCost = gasBudget * gasPrice;
  const total = deployFee + mintValue + ASSUMED_TAPEOUT_FEE + gasCost;
  console.log(`[total] protocolFees=${fmtOKB(deployFee + mintValue + ASSUMED_TAPEOUT_FEE)} + gas≈${fmtOKB(gasCost)} (@${gasPrice} wei, ${gasBudget} budget) = ≈${fmtOKB(total)} required`);
  console.log(`[total] recommended wallet funding: 0.02–0.03 OKB (headroom for gas spikes + retries)`);
  if (walletCheck.ok && balance < total) console.log(`[warn] wallet balance ${fmtOKB(balance)} BELOW estimated requirement`);
  console.log('DRY RUN COMPLETE — nothing broadcast. Fund the wallet, then run live (see docs/MAINNET_ACTIVATION.md).');
  process.exit(0);
}

// ---------------- LIVE MODE: sequential, reuse tested scripts ----------------
if (process.env.CONFIRM_BROADCAST !== '1') {
  throw new Error('live deploy requires CONFIRM_BROADCAST=1 (or use --dry-run). Refusing.');
}
console.error('[deploy] LIVE MODE — broadcasting real mainnet transactions');
const steps = [
  ['create-processor', ['scripts/phase1/create-processor.mjs', '--out', 'state/phase1.json']],
  ['tapeout', ['scripts/phase1/tapeout.mjs']],
  ['verify', ['scripts/phase1/verify.mjs', '--out', 'reports/phase1-report.json']],
];
for (const [name, cmd] of steps) {
  console.error(`[deploy] >>> ${name}: node ${cmd.join(' ')}`);
  const r = spawnSync(process.execPath, cmd, { stdio: 'inherit', cwd: process.cwd(), env: process.env });
  if (r.status !== 0) throw new Error(`step '${name}' failed with exit ${r.status} — STOPPING (do not retry blindly; see docs/MAINNET_ACTIVATION.md)`);
}
console.error('[deploy] ALL STEPS COMPLETE');
