# Phase 1 — Minimal TapeOut Proof

Status: **engineering complete, awaiting mainnet funding. Nothing has been broadcast.**
 companion: `docs/MAINNET_ACTIVATION.md` (the exact activation runbook).
 Ground truth: `docs/PROTOCOL.md` (read it first).

## Deployment (tooling, no framework added)

- Runtime: Node.js 24 (`node --test`, no test framework). One dependency: `ethers@6`
  (devDependency, same library the reference builder repos use).
- Layout: `src/phase1/` (netlist codec, AND definition, validators),
  `scripts/phase1/` (chain helpers, build, create, mint+tapeout, verify, deploy
  orchestrator), `tests/phase1/` (22 tests), `state/` + `reports/` (gitignored outputs).
- Reproduction from clean env: `npm install && npm test` (no key, no network for tests).

## Circuit (selected: 2-input AND)

`src/phase1/circuit.js`. AND = NOT(NAND(A,B)) — the smallest useful circuit in the
brief: 2 NAND gates vs ≥4 for XOR and ≥6 for a half-adder. Combinational (no LATCH),
no REF (first circuit on a fresh processor has nothing to reference).

| Item | Value |
|---|---|
| Gates | `NAND(2,3)→4`, `NAND(4,4)→5` (signals 0=const-0, 1=const-1, 2=A, 3=B) |
| Inputs / outputs | nIn=2 `[A,B]`, nOut=1 (last signal `[5]`) |
| Transistor requirement | 2 NAND, 0 LATCH |
| Netlist | `0x0000000200000300000004000004` (14 bytes) |
| SHA-256 | `0x53c134b474d83082cb134bbe2e7e126d698a866452ca8e317ea618931debd3cf` |
| Behavior | 4-row AND truth table: `00→0, 10→0, 01→0, 11→1` |

Deliberate deviation from canvas convention: the official canvas appends +2 NAND
output buffers per output pin. Those are ordinary gates, not a contract requirement —
the contract executes whatever netlist it is given. The bare 2-gate form keeps
material usage exactly auditable (2 NAND). If activation ever reverts unexpectedly,
the buffered 4-gate variant is the documented fallback (see Known issues).

## Local / dry-run proof (all verified WITHOUT broadcasting)

### 1. Unit tests — 22/22 pass (`npm test`, offline, no key, no RPC)

- AND definition: exact 14-byte encoding, truth table, 2 NAND / 0 LATCH / 0 REF,
  decode round-trip with identical gates.
- Independent vectors: TRACE on-chain circuit #1 netlist decodes to 8 NANDs with
  matching gate fields; documented REF record decodes to
  `(cpu, id=1, ins=[2,3,4,5], nOut=2)`; all 16 TRACE truth-table rows evaluate locally.
- Codec rejection: forward refs, truncation, unknown opcodes, bad REF addresses/pins,
  non-binary inputs, dangling outputs, bad dimensions.
- Validators: processor/tx-hash/netlist-hex/circuit-ID accept+reject cases (IDs start
  at 1; `0`, negatives, non-integers rejected), fingerprint determinism.
- Eval bit-packing regression (see Known issues): LSB-first `packInputs`,
  full-return `unpackOutputs`, incl. multi-byte inputs.

### 2. Offline build (`node scripts/phase1/build-circuit.mjs`)

Prints the deterministic artifact (netlist, byte length, truth table, material:
`{NAND: 2, LATCH: 0}`). No RPC, no key.

### 3. Offline audit (`audit()` in `src/phase1/netlist.js`, on raw bytes)

Decodes, identifies NAND/LATCH/REF, validates structure (no forward refs, no dangling
outputs), counts transistors, maps inputs `[2,3]` → outputs `[5]`. AND audit:
`{byteLength: 14, gates: 2, nNand: 2, nLatch: 0, refCount: 0, refs: []}`.

### 4. Dry-run deploy (read-only + estimates — no key, no broadcast)

Bash: `DRY_RUN=true npm run phase1:deploy` ·
PowerShell: `$env:DRY_RUN='true'; npm run phase1:deploy` ·
or: `node scripts/phase1/deploy.mjs --dry-run` (any shell).

Verified output (X Layer mainnet, block ~71703377, `cpuCount` now 248):

- `createCPU("Phase1 Proof","P1PRF",story,100,1e12)` → calldata selector `0x47f9b5fd`,
  value 0.0066 OKB; with `WALLET` set: gas estimate **774,733** and staticCall-predicted
  addresses (marked valid ONLY if creation is the wallet's next tx).
- `mint(0,2)` → calldata selector `0x1b2ef1ca`, value **0.000662 OKB**
  (2×0.000001 + 0.00066 protocolFee).
- `tapeout(0x0000000200000300000004000004,2,1)` → calldata selector `0x7bd3ac1d`,
  value **0.0013 OKB** (assumed standard; re-read live at activation).
- Required total ≈ **0.00859 OKB** (fees 0.008562 + gas at 20 gwei budget);
  recommended funding **0.02–0.03 OKB**. Safety gates proven: scripts refuse without
  `CONFIRM_BROADCAST=1`; no `.env` exists; no key material anywhere in repo.

### 5. Verify pipeline proven against live mainnet (read-only)

`scripts/phase1/verify.mjs` run against the known TRACE processor/circuit #1 with
recorded tx hashes: **45/45 checks pass**, including all 16 rows executed on-chain
via `eval` and matched to the local model, netlist byte-equality + independent
decode, REF count 0, owner match, material accounting, and `CPUCreated`/`TapedOut`
event inspection. The same script verifies our circuit at activation unchanged.

## Mainnet activation (placeholders — NOT yet executed, NOT fabricated)

| Item | Value |
|---|---|
| Processor address | TBD |
| Transistors address | TBD |
| Processor factory index / `cpuCount` at creation | TBD |
| Circuit ID | TBD (expected `1`) |
| Creation tx | TBD |
| Mint tx | TBD |
| Tape-out tx | TBD |
| Netlist on chain | expected `0x0000000200000300000004000004` — TBD read-back |
| Explorer URLs | TBD (`https://www.oklink.com/xlayer/...`) |
| Actual OKB spent | TBD (estimate ≈ 0.00859 + gas variance) |

Activation commands: see `docs/MAINNET_ACTIVATION.md`.

## Cost (quoted live, pre-broadcast)

| Step | Fee | Gas reference |
|---|---|---|
| createCPU | 0.0066 OKB | 774,733 est. (dry-run, wallet set) |
| mint(0,2) | 0.000662 OKB | n/a pre-processor (ref: 96,747 for mint(0,8)) |
| tapeout (14 B, 2 gates) | 0.0013 OKB | n/a pre-processor (ref: ~240k for 8-gate tapeout) |
| **Total** | **≈ 0.00859 OKB** | recommended funding 0.02–0.03 OKB |

## Reproduction (clean environment)

```powershell
git clone <repo>; cd tapeout
npm install
npm test                                  # 22/22, offline
node scripts/phase1/build-circuit.mjs     # offline artifact
node scripts/phase1/deploy.mjs --dry-run  # read-only + estimates, no key (any shell)
# after funding (wallet owner only):
#   copy .env.example to .env, set PRIVATE_KEY + CONFIRM_BROADCAST=1
#   node scripts/phase1/deploy.mjs        # create → tapeout → verify
```

## Known issues (discovered during implementation; none open against activation)

1. **`eval` return destructuring bug (found, fixed, regression-tested).** `eval`
   returns a single `bytes` value; `const [raw] = await cpu.eval(...)` silently yields
   `'0'`, making every check vacuously pass-or-mislead. Fixed via `packInputs` /
   `unpackOutputs` in `src/phase1/netlist.js`, now the single implementation used by
   `verify.mjs`, with dedicated tests (`audit.test.js`). Caught because the TRACE
   dry-run failed 5 rows instead of waving through.
2. **Uppercase `0X` prefix rejected (found, fixed, tested).** `validateNetlistHex`
   now normalizes case.
3. **`cpuCount` drift 247 → 248** between Phase 0 and Phase 1 dry-runs: third parties
   keep creating processors; no impact (we read it live, never hardcode).
4. **Fallback 4-gate variant** (canvas-style +2 output buffers) held in reserve if the
   bare 2-gate tape-out ever reverts for structural reasons. No evidence it will —
   the contract executes arbitrary valid netlists — but the fallback costs only +2 NAND.
5. Observed mainnet txs in Phase 0 report `effectiveGasPrice 0x0` (relayed path); do
   not assume zero gas price — the dry-run budgets 1.4M gas at live gas price.
