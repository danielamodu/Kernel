#!/usr/bin/env node
/**
 * Create a Phase 1 processor through the official factory (BROADCASTS 1 tx).
 * Usage:
 *   CONFIRM_BROADCAST=1 node scripts/phase1/create-processor.mjs [--out state/phase1.json]
 * Env (see .env.example): RPC_URLS, PRIVATE_KEY, P1_NAME, P1_SYMBOL, P1_STORY,
 *   P1_SUPPLY, P1_MINT_PRICE_WEI.
 * Prints the state JSON to stdout. Fails closed on any post-creation check mismatch.
 */
import { ethers } from 'ethers';
import {
  loadEnv, getProvider, getSigner, requireBroadcastConfirm,
  FACTORY, FACTORY_ABI, CIRCUITS_ABI, TRANSISTORS_ABI,
  fmtOKB, txUrl, addrUrl, parseArgs, writeState,
} from './chain.mjs';

loadEnv();
const args = parseArgs();

const NAME = process.env.P1_NAME || 'Phase1 Proof';
const SYMBOL = process.env.P1_SYMBOL || 'P1PRF';
const STORY = process.env.P1_STORY || 'Minimal Phase 1 proof circuit (2-gate AND). No license terms; REPL test asset.';
const SUPPLY = BigInt(process.env.P1_SUPPLY || '100');
const MINT_PRICE = BigInt(process.env.P1_MINT_PRICE_WEI || '1000000000000'); // 1e12 wei = 0.000001 OKB

requireBroadcastConfirm('create a processor (spends OKB on mainnet)');

const { provider, rpcUrl } = await getProvider();
const { signer, address: deployer, balance } = await getSigner(provider);
const factory = new ethers.Contract(FACTORY, FACTORY_ABI, provider);

const code = await provider.getCode(FACTORY);
if (code === '0x') throw new Error('factory has no code — wrong RPC or address');
const deployFee = await factory.deployFee();
const countBefore = await factory.cpuCount();
console.error(`[create] factory ${FACTORY} code=${code.length / 2 - 1}B deployFee=${fmtOKB(deployFee)} cpuCount=${countBefore}`);
console.error(`[create] deployer ${deployer} balance=${fmtOKB(balance)}`);
if (balance < deployFee) throw new Error(`insufficient OKB: need >= ${fmtOKB(deployFee)} + gas`);
if (!(await factory.isCPU(await factory.cpuAt(0n)))) throw new Error('sanity: factory does not recognize cpuAt(0)');

// Read-only simulation first: staticCall returns (transistors, circuits) without spending.
const sim = await factory.getFunction('createCPU').staticCall(NAME, SYMBOL, STORY, SUPPLY, MINT_PRICE, { from: deployer, value: deployFee });
console.error(`[create] staticCall ok → transistors=${sim[0]} circuits=${sim[1]}`);

const wFactory = new ethers.Contract(FACTORY, FACTORY_ABI, signer);
const tx = await wFactory.createCPU(NAME, SYMBOL, STORY, SUPPLY, MINT_PRICE, { value: deployFee });
console.error(`[create] broadcast ${tx.hash} ${txUrl(tx.hash)}`);
const receipt = await tx.wait();
if (receipt.status !== 1n && receipt.status !== 1) throw new Error(`creation tx reverted: ${tx.hash}`);
console.error(`[create] confirmed block=${receipt.blockNumber} gasUsed=${receipt.gasUsed}`);

// Parse CPUCreated (must be exactly one, from the factory).
let created = null;
for (const log of receipt.logs) {
  if (log.address.toLowerCase() !== FACTORY.toLowerCase()) continue;
  try {
    const parsed = factory.interface.parseLog(log);
    if (parsed?.name === 'CPUCreated') {
      if (created) throw new Error('more than one CPUCreated event');
      created = parsed.args;
    }
  } catch { /* foreign log shape */ }
}
if (!created) throw new Error('CPUCreated event missing from receipt');
if (created.creator.toLowerCase() !== deployer.toLowerCase()) throw new Error('CPUCreated.creator != deployer');
if (created.name !== NAME || created.supply !== SUPPLY || created.mintPrice !== MINT_PRICE) {
  throw new Error('CPUCreated terms differ from proposal');
}
const circuits = await ethers.resolveAddress(created.circuits);
const transistors = await ethers.resolveAddress(created.transistors);

// Post-creation verification (same checks as docs/PROTOCOL.md 2.2).
const cpu = new ethers.Contract(circuits, CIRCUITS_ABI, provider);
const mat = new ethers.Contract(transistors, TRANSISTORS_ABI, provider);
const checks = {
  factoryCode: (await provider.getCode(FACTORY)) !== '0x',
  cpuCode: (await provider.getCode(circuits)) !== '0x',
  transistorsCode: (await provider.getCode(transistors)) !== '0x',
  isCPU: await factory.isCPU(circuits),
  reciprocalA: (await cpu.transistors()).toLowerCase() === transistors.toLowerCase(),
  reciprocalB: (await mat.circuits()).toLowerCase() === circuits.toLowerCase(),
  creator: (await mat.creator()).toLowerCase() === deployer.toLowerCase(),
  name: (await mat.cpuName()) === NAME,
  symbol: (await mat.cpuSymbol()) === SYMBOL,
  story: (await mat.story()) === STORY,
  supplyCap: (await mat.supplyCap()) === SUPPLY,
  mintPrice: (await mat.mintPrice()) === MINT_PRICE,
};
const bad = Object.entries(checks).filter(([, v]) => v !== true).map(([k]) => k);
if (bad.length) throw new Error(`post-creation checks failed: ${bad.join(', ')}`);
console.error('[create] all post-creation checks passed');

const state = {
  chainId: 196,
  rpcUrl,
  factory: FACTORY,
  processor: circuits,
  transistors,
  creator: deployer,
  name: NAME, symbol: SYMBOL, story: STORY,
  supplyCap: SUPPLY.toString(),
  mintPriceWei: MINT_PRICE.toString(),
  deployFeeWei: deployFee.toString(),
  creationTx: tx.hash,
  creationBlock: Number(receipt.blockNumber),
  creationGasUsed: receipt.gasUsed.toString(),
};
console.log(JSON.stringify(state, null, 2));
if (args.out !== undefined) {
  writeState(state);
  console.error('[create] state saved to state/phase1.json');
}
