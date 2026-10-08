#!/usr/bin/env node
/**
 * Shared Phase 1 chain helpers: env, RPC with fallback, ABIs, addresses.
 * Read-only helpers work with no private key. Broadcasts require CONFIRM_BROADCAST=1.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ethers } from 'ethers';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

// --- minimal .env loader (no dependency): KEY=VALUE, ignores # comments ---
export function loadEnv() {
  for (const f of [path.join(ROOT, '.env'), path.join(ROOT, 'scripts', 'phase1', '.env')]) {
    if (!fs.existsSync(f)) continue;
    for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
      if (!m || m[1].startsWith('#') || process.env[m[1]] !== undefined) continue;
      let v = m[2];
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      process.env[m[1]] = v;
    }
  }
}

export const CHAIN_ID = 196;
export const FACTORY = '0x1f09daefa827f02cbb40967cc91b259763760761';
export const RPCS = (process.env.RPC_URLS || 'https://xlayerrpc.okx.com,https://rpc.xlayer.tech')
  .split(',').map((s) => s.trim()).filter(Boolean);
export const EXPLORER = 'https://www.oklink.com/xlayer';
export const txUrl = (h) => `${EXPLORER}/tx/${h}`;
export const addrUrl = (a) => `${EXPLORER}/address/${a}`;

export const FACTORY_ABI = [
  'function createCPU(string name, string symbol, string story, uint256 transistorSupply, uint256 mintPrice) payable returns (address transistors, address circuits)',
  'function cpuCount() view returns (uint256)',
  'function cpuAt(uint256 i) view returns (address)',
  'function isCPU(address) view returns (bool)',
  'function deployFee() view returns (uint256)',
  'function protocolFee() view returns (uint256)',
  'event CPUCreated(address indexed circuits, address indexed transistors, address indexed creator, string name, uint256 supply, uint256 mintPrice)',
];

export const CIRCUITS_ABI = [
  'function transistors() view returns (address)',
  'function name() view returns (string)',
  'function symbol() view returns (string)',
  'function nextId() view returns (uint256)',
  'function factory() view returns (address)',
  'function tapeout(bytes nl, uint32 nIn, uint32 nOut) payable returns (uint256)',
  'function eval(uint256 id, bytes inputs) view returns (bytes)',
  'function step(uint256 id, bytes state, bytes inputs) view returns (bytes newState, bytes outputs)',
  'function circuitInfo(uint256 id) view returns (uint32 nIn, uint32 nOut, uint32 nState, uint32 gateCount)',
  'function ownerOf(uint256 id) view returns (address)',
  'function netlist(uint256 id) view returns (bytes)',
  'function TAPEOUT_FEE() view returns (uint256)',
  'event TapedOut(uint256 indexed circuitId, address indexed author, uint32 gateCount, uint32 nState)',
];

export const TRANSISTORS_ABI = [
  'function NAND() view returns (uint256)',
  'function LATCH() view returns (uint256)',
  'function mintPrice() view returns (uint256)',
  'function protocolFee() view returns (uint256)',
  'function supplyCap() view returns (uint256)',
  'function minted() view returns (uint256)',
  'function creator() view returns (address)',
  'function circuits() view returns (address)',
  'function cpuName() view returns (string)',
  'function cpuSymbol() view returns (string)',
  'function story() view returns (string)',
  'function balanceOf(address a, uint256 id) view returns (uint256)',
  'function mint(uint256 id, uint256 amount) payable',
  'function owed(address a) view returns (uint256)',
  'function withdraw()',
  'event Minted(address indexed to, uint256 indexed id, uint256 amount, uint256 paid)',
];

function withHeaders(rpcUrl) {
  // xlayerrpc.okx.com 403s bare clients; browser-like Origin fixes it (docs/PROTOCOL.md 8.1).
  const req = new ethers.FetchRequest(rpcUrl);
  req.setHeader('Origin', 'https://www.okx.com');
  req.setHeader('Referer', 'https://www.okx.com/');
  return req;
}

/** Return the first responsive provider at the right chain ID; throw otherwise. */
export async function getProvider() {
  const errors = [];
  for (const url of RPCS) {
    try {
      const p = new ethers.JsonRpcProvider(withHeaders(url), CHAIN_ID, { staticNetwork: true });
      const [netId, block] = await Promise.all([p.send('eth_chainId', []), p.getBlockNumber()]);
      if (BigInt(netId) !== BigInt(CHAIN_ID)) throw new Error(`wrong chain ${netId} at ${url}`);
      console.error(`[chain] RPC ok: ${url} (block ${block})`);
      return { provider: p, rpcUrl: url, block };
    } catch (e) {
      errors.push(`${url}: ${e.shortMessage || e.message}`);
    }
  }
  throw new Error('no responsive X Layer RPC:\n  ' + errors.join('\n  '));
}

/**
 * Signer for broadcasting (never logged, never printed).
 * Priority: PRIVATE_KEY (0x + 64 hex) else MNEMONIC (BIP-39 phrase) else
 * MNEMONIC_FILE (path to a file containing ONLY the phrase, kept outside the repo).
 * Derivation path: WALLET_DERIVATION_PATH or m/44'/60'/0'/0/0 (OKX/EVM standard).
 * Throws if nothing usable is configured.
 */
function loadMnemonic() {
  if (process.env.MNEMONIC && process.env.MNEMONIC.trim()) return process.env.MNEMONIC.trim().replace(/\s+/g, ' ');
  const f = process.env.MNEMONIC_FILE;
  if (f && fs.existsSync(f)) {
    return fs.readFileSync(f, 'utf8').trim().replace(/\s+/g, ' ');
  }
  return '';
}
export async function getSigner(provider) {
  const pk = process.env.PRIVATE_KEY;
  let w;
  if (pk && /^0x[0-9a-fA-F]{64}$/.test(pk.trim())) {
    w = new ethers.Wallet(pk.trim(), provider);
  } else {
    const mnemonic = loadMnemonic();
    if (!mnemonic || mnemonic.split(' ').length < 12) {
      throw new Error('no wallet configured: set PRIVATE_KEY or MNEMONIC/MNEMONIC_FILE (see .env.example)');
    }
    const derivationPath = process.env.WALLET_DERIVATION_PATH || `m/44'/60'/0'/0/0`;
    w = ethers.Wallet.fromPhrase(mnemonic, undefined, derivationPath);
    w = w.connect(provider);
  }
  const [net, bal] = await Promise.all([
    w.provider.getNetwork(),
    w.provider.getBalance(w.address),
  ]);
  if (net.chainId !== BigInt(CHAIN_ID)) throw new Error(`signer on wrong chain ${net.chainId}`);
  return { signer: w, address: w.address, balance: bal };
}

export function requireBroadcastConfirm(action) {
  if (process.env.CONFIRM_BROADCAST !== '1') {
    throw new Error(
      `refusing to ${action} without CONFIRM_BROADCAST=1 (safety gate; see .env.example)`,
    );
  }
}

export const fmtOKB = (wei) => `${ethers.formatEther(wei)} OKB`;
export const STATE_PATH = path.join(ROOT, 'state', 'phase1.json');

export function readState() {
  if (!fs.existsSync(STATE_PATH)) return {};
  return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
}

export function writeState(patch) {
  fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
  const merged = { ...readState(), ...patch };
  fs.writeFileSync(STATE_PATH, JSON.stringify(merged, null, 2) + '\n');
  return merged;
}

const BOOL_FLAGS = new Set(['dry-run']);
export function parseArgs(argv = process.argv.slice(2)) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const m = argv[i].match(/^--([A-Za-z0-9-]+)(=(.*))?$/);
    if (!m) continue;
    if (m[3] !== undefined) out[m[1]] = m[3];
    else if (BOOL_FLAGS.has(m[1])) out[m[1]] = true;
    else out[m[1]] = argv[++i];
  }
  return out;
}
