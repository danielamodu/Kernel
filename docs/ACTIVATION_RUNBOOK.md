# Activation Runbook — funding day (wallet owner only)

Precondition: `npm test` passes, `npm run demo:dry-run` prints ALLOWED with all
MATCH lines. Append-only: record every hash below; never edit a recorded value.
Exactly 4 broadcasts. Nothing else. Costs reference `docs/PHASE1.md`/`PHASE4.md`
dry-run figures; re-quote live at each step.

## STEP 1 — Deploy AttributionRegistry

```powershell
Copy-Item .env.example .env   # set PRIVATE_KEY + CONFIRM_BROADCAST=1 (never commit)
npm install; npm test         # must be green before spending anything
CONFIRM_BROADCAST=1 node scripts/phase3/deploy-registry.mjs
```

Record: registry address `_______________`, tx `_______________`,
block `_____`, gas `_____`.

## STEP 2 — Verify registry deployment

- `eth_getCode` nonzero at the address (script asserts; re-check on explorer).
- `slotKey(196, TRACE, 1)` returns `0x1101b7fd…93a06c9b` (pure call — compare!).
- Record: slotKey check `MATCH / MISMATCH` `_______________`.

## STEP 3 — Read live TRACE #1

`node scripts/phase4/register-example.mjs --registry <REGISTRY>` already reads
(`circuitInfo`, `netlist`, `ownerOf`) and prints the plan. Confirm:
nIn=4 nOut=2 gates=8, hash `0x0ea38cb4…91ff0942`, owner `0x1d207352…f178886`.

## STEP 4 — Register TRACE #1

```powershell
CONFIRM_BROADCAST=1 CONFIRM_REGISTRY_DEPLOY=1 node scripts/phase4/register-example.mjs --registry <REGISTRY>
```

Canonical values: payee = live owner, price `500000000000000` wei (0.0005 OKB),
single-license/OKB/attribution terms. Record: registration tx `_______________`.

## STEP 5 — Read registration back independently

`node scripts/phase3/inspect-registration.mjs --chain 196 --processor <TRACE> --circuit 1 --registry <REGISTRY>`
Expect: `Status: REGISTERED`, Identity MATCH, Netlist MATCH. Record result.

## STEP 6 — Deploy LicensedTapeoutRouter with the actual registry address

```powershell
CONFIRM_BROADCAST=1 node scripts/phase4/deploy-router.mjs --registry <REGISTRY>
```

Record: router address `_______________`, tx `_______________`, gas `_____`.

## STEP 7 — Verify router configuration

- `REGISTRY()` returns the Step-1 address; `FACTORY()` returns `0x1f09…0761`.
- `MAX_NETLIST_BYTES`/`MAX_REFS` sane (8192/16).
- Record: `MATCH / MISMATCH` `_______________`.

## STEP 8 — Prepare canonical demo root

`fixtures/final/demo-root.json` (43 B single-REF root, lineageHash
`0x02335455…31af82f`). Re-run the encoder check inside
`npm run demo:dry-run` (re-encode byte-identical line). Record: `MATCH`.

## STEP 9 — Final preflight against live registry + live TapeOut

`node scripts/phase4/prepare-licensed-tapeout.mjs --registry <REGISTRY> --router <ROUTER> --wallet <DEPLOYER>`
Expect: `Preflight: ALLOWED`, lineageHash MATCH, live gas estimate printed.
Do NOT proceed on any other outcome.

## STEP 10 — Execute ONE licensed tape-out

```powershell
CONFIRM_BROADCAST=1 CONFIRM_LICENSED_TAPEOUT=1 node scripts/phase4/licensed-tapeout.mjs --router <ROUTER> --registry <REGISTRY>
```

Expected value: 0.0018 OKB + gas (0 mint: 0 own transistors). Script re-validates
live, broadcasts once, parses events, verifies lineageHash + bytes + owner==payer.
Record: tx `_______________`.

## STEP 11 — Read the resulting circuit back

`cpu.netlist(<newId>)`, `circuitInfo`, `ownerOf` (script does this; confirm on
explorer independently). Record: circuit ID `_____`.

## STEP 12 — Verify (all must hold)

- circuit ID assigned by TRACE processor; processor `0x7761…1274a`;
- netlist bytes == submitted 43 B; hash matches;
- REF dependency == TRACE #1 (parse independently);
- registry record active with matching hash;
- event `lineageHash` == locally recomputed `0x02335455…`;
- `LicensePaid` 0.0005 OKB to payee (balance delta);
- `LicensedTapeout` event present with correct fields.
- Command: `node scripts/phase4/verify-licensed-tapeout.mjs --router <ROUTER> --tx <TX> --registry <REGISTRY>` (exit 0).

## STEP 13 — Save all transaction hashes

Registry deploy / registration / router deploy / licensed tape-out (+ blocks, gas,
explorer URLs) into `reports/` (gitignored) AND below.

## STEP 14 — Generate final proof report

`node scripts/final/generate-proof-report.mjs --live` (refuses without explicit
flag; dry-run is the default). Fill `docs/PHASE3.md` + `docs/PHASE4.md`
placeholders. Done — stop. No further broadcasts.

## If anything fails

Capture full output, classify (ABI / encoding / supply / funds / gas / contract /
RPC / tooling), fix root cause, add a regression test. Never re-broadcast blindly:
check the explorer first — a landed-but-unconfirmed tx changes nonces and
invalidates predicted values.
