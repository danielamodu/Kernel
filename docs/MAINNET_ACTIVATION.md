# Mainnet Activation — Phase 1 (run once, by the wallet owner)

Precondition: **engineering is complete; only funding is missing.**
Nothing below broadcasts unless `CONFIRM_BROADCAST=1` is set in `.env`.
The private key NEVER appears in code, docs, logs, or chat, and is never requested.

## Before funding

- [x] Code/tests pass — `npm test` → 22/22 offline (codec, AND, audit, validators, packing)
- [x] Circuit deterministic — `0x0000000200000300000004000004`, SHA-256
      `0x53c134b4…bd3cf` (see `docs/PHASE1.md`), reproducible via
      `node scripts/phase1/build-circuit.mjs`
- [x] Netlist verified — `audit()` on raw bytes: 2 NAND / 0 LATCH / 0 REF,
      inputs `[2,3]` → outputs `[5]`; TRACE-vector cross-checks pass
- [x] Calldata verified — dry-run printed selectors `0x47f9b5fd` (createCPU),
      `0x1b2ef1ca` (mint), `0x7bd3ac1d` (tapeout) with exact args/values
- [x] Factory address verified — `0x1f09daefa827f02cbb40967cc91b259763760761`
      (chain 196, code present, `isCPU(cpuAt(0))` true, read live at every dry-run)
- [x] Processor parameters finalized — name `Phase1 Proof`, symbol `P1PRF`,
      story (see `.env.example`), supply `100`, mint price `1e12 wei` (0.000001 OKB)
- [x] Circuit parameters finalized — nIn=2, nOut=1, 2 NAND, 0 REF
- [x] Verify pipeline proven read-only — 45/45 checks vs live TRACE circuit #1
- [ ] Wallet funded (the ONLY open item — see Funding)

## Funding

- Target: **~0.02–0.03 OKB on X Layer mainnet** (chain 196) at the deployer address.
- Itemized requirement (dry-run, live-quoted): createCPU 0.0066 + mint 0.000662 +
  tapeout 0.0013 + gas ≈ 0.00003 ≈ **0.00859 OKB**; the rest is headroom.
- Record here at activation: funder tx / CEX withdrawal ref: `_______________`.

## Broadcast (wallet owner only, in this order — do not parallelize)

```powershell
cd C:\Users\USER\Desktop\tapeout
Copy-Item .env.example .env   # then set PRIVATE_KEY + CONFIRM_BROADCAST=1 in .env
npm install
npm test                      # must be 22/22 before spending anything

# 1. createCPU (1 tx) — static-calls first, then broadcasts, then verifies registry/link/terms
node scripts/phase1/create-processor.mjs --out state/phase1.json
# 2. wait for confirmation (script blocks on receipt; do NOT Ctrl-C mid-step)
# 3. verify processor — included in step 1 (12 post-creation checks, fails closed)
# 4. mint transistor (≤1 tx, batched) + 5. tape out (1 tx) + read-back byte check
node scripts/phase1/tapeout.mjs
# 6. wait for confirmation (script blocks; refuses success without TapedOut + read-back match)
# 7. read circuit + 8. verify netlist (≈30 checks incl. full on-chain eval table)
node scripts/phase1/verify.mjs --out reports/phase1-report.json
```

Single-command equivalent (same steps, stops on first failure):
`CONFIRM_BROADCAST=1 node scripts/phase1/deploy.mjs`

If any step fails: capture full stdout/stderr, classify per `docs/PHASE1.md`
(ABI / encoding / supply / funds / gas / contract / RPC / tooling), fix root cause,
add a regression test. Never re-run a broadcast blindly — check the explorer first
for whether the earlier tx actually landed (nonce gaps invalidate predicted addresses).

## After broadcast (record every field — no fabrication, `TBD` until observed)

- [ ] Creation tx hash: `_______________` · block: `_____` · gas used: `_____`
- [ ] Processor (circuits) address: `_______________` · factory index: `_____`
- [ ] Transistors address: `_______________`
- [ ] Mint tx hash: `_______________` (or `n/a — balance already covered`: `_____`)
- [ ] Tape-out tx hash: `_______________` · block: `_____` · gas used: `_____`
- [ ] Circuit ID: `_____` (expected `1`)
- [ ] On-chain netlist: `_______________` (expected `0x0000000200000300000004000004`)
- [ ] Netlist SHA-256: `_______________`
- [ ] Owner: `_______________` (expected deployer)
- [ ] Explorer URLs (processor / transistors / all txs): `_______________`
- [ ] Actual OKB spent (fees + gas): `_______________`
- [ ] `verify.mjs` report saved at `reports/phase1-report.json`: pass `[ ]`
- [ ] `docs/PHASE1.md` placeholders filled in with the above: `[ ]`
- [ ] `.env` rotated/removed from the activation machine if it leaves your control
