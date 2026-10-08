# Demo script (60-120 seconds)

Total: ~2 minutes. Every claim below is executable today via the cited command
(pre-activation: dry-run lines; post-activation: explorer links).

## 0-10 sec — the problem

"TapeOut circuits compose through REF — one 43-byte record embeds a whole
computation. But nothing records whose computation it is, or settles terms.
Reuse is invisible."

## 10-25 sec — registered computation

Show the canonical registration plan:
`node scripts/phase4/register-example.mjs`
"TRACE circuit #1: identity `tapeout:v1:196:0x7761…:1`, content hash verified
live, payee is the on-chain owner, price 0.0005 OKB, single-license terms."
(Pre-activation: plan + BLOCKED line. Post-activation: registration tx + explorer.)

## 25-45 sec — compose with REF

Show the demo root: `fixtures/final/demo-root.json` — 43 bytes, 0 own
transistors, one REF to TRACE #1. "Built with our verified encoder; re-encodes
byte-identical. Composing costs nothing but the reference itself."

## 45-65 sec — lineage discovers the dependency

`npm run demo:dry-run` — parse, live resolve, identity derivation:
"One dependency found: TRACE #1. Netlist hash MATCH, verified against live
chain state, not our database."

## 65-85 sec — attribution + terms

"Registry state: payee, 0.0005 OKB, terms hash. Terms document re-hashed locally
— MATCH. Preflight: ALLOWED." Show the terms JSON (short, explicit).

## 85-105 sec — licensed tape-out flow

"One transaction: pay Alice 0.0005, mint nothing (REF-only root), tapeout fee
0.0013 — total exactly 0.0018 OKB, else the whole thing reverts. No partial
payment is possible."
(Pre-activation: calldata + BLOCKED line. Post-activation: the tx + gas used.)

## 105-120 sec — proof

"LicensedTapeout event: target processor, new circuit ID, lineage hash binding
deps + terms + payees. Recomputed locally — MATCH. Circuit read back from
chain, owned by the payer."
(Pre-activation: dry-run recomputation MATCH. Post-activation: explorer links.)

Final sentence: "TapeOut makes computation composable. This makes that
computation attributable and licensable."

## Fallbacks (if RPC is slow on stage)

Everything above except live reads runs offline: `npm test` (115 green),
fixture verification (`node scripts/final/verify-demo.mjs` without `--live`
still checks bytes, identity, terms, commitment). Never improvise numbers —
every figure on screen comes from a command shown beside it.
