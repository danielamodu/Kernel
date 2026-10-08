#!/usr/bin/env node
/**
 * Compile contracts/ with solc (offline, deterministic).
 * Usage: npm run phase3:compile
 * Writes build/<Contract>.json { contractName, abi, bytecode, deployedBytecode,
 * sourceHash, compiler }. Wired as `pretest` so cross-checks always run fresh.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import solc from 'solc';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DIR = path.join(ROOT, 'contracts');
const OUTDIR = path.join(ROOT, 'build');

const sources = {};
function collect(dir, prefix = '') {
  for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, f.name);
    if (f.isDirectory()) collect(full, prefix + f.name + '/');
    else if (f.name.endsWith('.sol')) {
      sources[prefix + f.name] = { content: fs.readFileSync(full, 'utf8') };
    }
  }
}
collect(DIR);
const input = {
  language: 'Solidity',
  sources,
  settings: {
    evmVersion: 'paris', // avoid PUSH0 (pre-Shanghai): maximal L2 compatibility
    viaIR: true, // LicensedTapeoutRouter needs it (stack-too-deep otherwise); tiny contracts so build stays fast
    optimizer: { enabled: true, runs: 200 },
    outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object', 'evm.deployedBytecode.object'] } },
  },
};

const out = JSON.parse(solc.compile(JSON.stringify(input)));
const errors = (out.errors || []).filter((e) => e.severity === 'error');
if (errors.length) {
  for (const e of errors) console.error(e.formattedMessage || e.message);
  process.exit(1);
}
for (const w of (out.errors || []).filter((e) => e.severity === 'warning')) {
  console.error(`[compile] warning: ${w.formattedMessage || w.message}`);
}
fs.mkdirSync(OUTDIR, { recursive: true });
// Legacy artifact name from the single-contract era; the canonical name is now
// per-contract (<Contract>.json). Remove it so nothing reads a stale build.
for (const legacy of ['attribution-registry.json']) {
  try { fs.unlinkSync(path.join(OUTDIR, legacy)); } catch { /* absent */ }
}
for (const [file, contracts] of Object.entries(out.contracts)) {
  for (const [name, c] of Object.entries(contracts)) {
    const artifact = {
      contractName: name,
      sourceFile: `contracts/${file}`,
      sourceHash: '0x' + createHash('sha256').update(sources[file].content).digest('hex'),
      compiler: 'solc-0.8.26-evm-paris-opt200',
      abi: c.abi,
      bytecode: '0x' + c.evm.bytecode.object,
      deployedBytecode: '0x' + c.evm.deployedBytecode.object,
    };
    const p = path.join(OUTDIR, `${name}.json`);
    fs.writeFileSync(p, JSON.stringify(artifact, null, 2) + '\n');
    console.log(`[compile] ok: ${name}: ${artifact.abi.length} ABI entries, bytecode ${(artifact.bytecode.length - 2) / 2}B, source ${artifact.sourceHash}`);
  }
}
