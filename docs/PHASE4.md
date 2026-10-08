# Phase 4 — Licensed Tape-Out Router

Status: **ACTIVATED on X Layer mainnet. One real licensed tape-out (circuit #2),
fully verified. Zero further broadcasts planned.**
 Prior phases: `docs/PROTOCOL.md` (ground truth), `docs/PHASE1.md`,
 `docs/PHASE2.md` (lineage), `docs/PHASE3.md` (registry).

## 1. Architecture

```
SUBMIT (targetCpu, netlist, nIn, nOut) + msg.value
        ↓
PARSE raw bytes (own NAND/LATCH counts + REF records; caps 8 kB / 16 REFs)
        ↓
VALIDATE each UNIQUE dep (netlist order):
  registry record? → active? → terms? → payee? → live netlist hash match?
  → live pin agreement?
        ↓
COMMIT lineageHash = keccak256(abi.encode(
  targetCpu, nIn, nOut, keccak(nl),
  keyHashes[], netlistHashes[], payees[], prices[], termsHashes[]))
        ↓
ACCOUNT exact value = Σ prices + mintValue + tapeoutFee (else revert)
        ↓
PAY each payee → MINT material → TAPEOUT → forward NFT to payer
        ↓
EMIT LicensePaid[] + LicensedTapeout
```

One transaction, all-or-nothing (EVM rollback). No database in the router: every
decision derives from the submitted bytes + live registry + live TapeOut reads.

## 2. Exact payment flow

Per unique dependency slot: `payment = registry.priceWei`, pushed via plain
`call` (checked success). Zero-price deps emit `LicensePaid` with 0 and no call
(avoids griefing through reverting fallbacks). Multi-dep totals are plain sums;
duplicate REF records pay **once** (dedupe by slot key, netlist order). No ERC20,
no float: integer wei of the native asset (OKB on X Layer). Scope decision
(documented in code): **direct dependencies only** — transitive deps stay
attributable via the Phase 3 join and were licensable when their parent taped;
a recursive router is future work, not a silent omission.

## 3. Lineage preflight (`src/router/preflight.js`, read-only, no key)

Parses → dedupes (first-appearance order = contract order) → live-fetch each dep
→ registry lookup → checks (registered/active/hash/pins/payee/price/terms) →
manufacturing math → totals → `lineageHash`. Failure codes, never silent:
`UNREGISTERED, INACTIVE, NETLIST_MISMATCH, INVALID_PAYEE, INVALID_PRICE,
MISSING_TERMS, MALFORMED_REF, MISSING_DEPENDENCY, PIN_MISMATCH, FEE_UNKNOWN`.
Missing fee quotes fail closed (`FEE_UNKNOWN`) rather than pricing at zero.

## 4. Registry verification (live, per execution)

Record lookup by `keyHash`; `active` required; `netlistHash` compared against
`keccak256(netlist(refCpu, refId))` read in the same tx (no staleness window);
pins compared against `circuitInfo`. Terms must be nonzero (router is stricter
than the registry, which permits unpublished terms). Payee re-checked nonzero.

## 5. Lineage commitment (`src/router/commitment.js`)

Layout pinned above; JS and Solidity implement it identically (EVM test asserts
`computeLineageHash(...) == LicensedTapeout.lineageHash`). Order is part of the
commitment (same set, different netlist order ⇒ different hash). Golden vector
in `tests/phase4/lineage-commitment.test.js` breaks loudly on layout drift.

## 6. TapeOut transaction sequence (inside one router call)

1. `factory.isCPU(targetCpu)` — else `NotFactoryCpu`, before any value moves.
2. Registry + live reads per unique dep (view calls).
3. Value check: `msg.value == required` else `WrongValue` (exact-match policy:
   no refund path, no trapped funds; no receive/fallback).
4. Payees (mutex held; zero-price skipped as calls).
5. `mint` per nonzero token id with exact per-call value (`n·price + fee`).
6. `tapeout{value: fee}` → `newCircuitId`.
7. `safeTransferFrom(router → payer)` (else the NFT would strand; a contract
   payer needs `onERC721Received`, else atomic revert).
8. Events. Mutex released.

## 7. Atomicity guarantees

Single-transaction EVM atomicity: any revert (bad dep, short value, failed pay,
failed mint, failed tapeout, failed NFT forward, reentrant payee) unwinds
payments, mints, and manufacture alike. Proven in-process: failing mint/tapeout
tests assert payee balances unchanged and zero logs. No `LicensedTapeout` can
exist without a completed manufacture in the same tx.

## 8. Failure / revert behavior

Custom errors per cause (`UnregisteredDep`, `InactiveDep`, `MissingTerms`,
`NetlistMismatch` (record distrusted), `PinMismatch` (early, pre-payment),
`MissingDependency`, `WrongValue(required, sent)`, `PayFailed`, `MintFailed`,
`TapeoutFailed`, `TransferFailed`, `MalformedNetlist`, `TooManyRefs`,
`NetlistTooLarge`, `NotFactoryCpu`, `Reentrant`, `ZeroAddress`). Preflight maps
1:1 to these before money moves; the contract re-checks everything live
(preflight is advisory, execution is authoritative).

## 9. Security assumptions (reviewed, tested where executable)

- **Reentrancy**: bool mutex (no OZ dependency); payees are untrusted contracts —
  a reentering payee's inner call reverts, which fails the outer payment, which
  reverts everything (tested with a griefer contract).
- **Payment griefing**: a malicious payee can always revert to block tape-outs
  that name it (it can also just deactivate). Inherent to push-payments;
  documented, not fixable without pull-flows (rejected: breaks atomic proof).
- **Duplicate payment**: impossible — unique-slot loop, single tx, exact value
  (tested: identical REFs pay once).
- **Stale registry**: all reads happen in the execution tx; preflight quotes can
  go stale and then fail closed on `WrongValue` (tested).
- **Registry mutation mid-tx**: impossible (single tx, mutex).
- **Malformed calldata**: ABI decoding + parser guards + caps (tested).
- **Overflow**: Solidity 0.8 checked arithmetic; uint256-max price tested
  (valid single, panic on overflow sum).
- **Zero values**: zero payee rejected; zero price allowed (gratis path tested);
  zero-value exact-match enforced.
- **Forced OKB**: no receive/fallback (direct sends revert); selfdestruct dust
  accepted as residual risk; exact accounting leaves no residuals by construction.
- **State**: router holds none besides the mutex (no database to corrupt).

## 10. Known protocol limitations (not router bugs)

- The factory stays permissionless: direct `tapeout` bypasses everything here.
  "Licensed" = "completed our voluntary flow" — never "protocol permission was
  required". (Registered / paid / licensed-through-router / protocol-enforced
  are four different things; only the first three can coincide here.)
- `TapedOut.gateCount`/`nState` semantics for REF-bearing circuits are unobserved
  live (no REF circuit found on X Layer); the router does not depend on them.
- Pure-REF roots (0 own transistors, like the demo) skip mint calls; whether a
  zero-balance tapeout succeeds on the *real* processor is supported by the
  Phase-0 `eth_call` probe but unconfirmed by broadcast — first failure mode to
  watch at activation (fallback: mint 1 NAND; netlist unchanged in meaning? No —
  fallback would need a different root; documented in activation plan instead).
- `safeTransferFrom` on the real Circuits contract is interface-verified
  (`docs/PROTOCOL.md` §8.5) but transfer-to-payer is unexecuted live until activation.
- EVM tests run against faithful stubs (same verified interfaces), not the real
  contracts — execution semantics of the *router* are proven; TapeOut-side
  behavior is covered by Phase 0–1 live reads.

## Activation (observed mainnet values — activation executed)

Order followed exactly (wallet owner approval; each step gated, each verified
before the next). All values below are observed, not estimated.

- Registry: `0x34cDa4B9668609FC7EF62c6f84058B68894c6bBa`
  ([explorer](https://www.oklink.com/xlayer/address/0x34cDa4B9668609FC7EF62c6f84058B68894c6bBa)),
  deploy tx `0xd6989bacf9046718250a6da4b02667c378c500f0f9eb6d0d4b18ca380fddc60c`
  (block 72686810, gas 521,373). Code hash matches build; `slotKey` matches client.
- Registration (TRACE #1, canonical values as planned):
  tx `0xab74807ef7c17eaba61c7771f5e4aed52614ed645562477ea73334c9669fc655`
  (block 72686876, gas 139,251); read-back byte-for-byte verified; independent
  inspect: REGISTERED, Identity MATCH, Netlist MATCH.
- Router: `0x2bbd57Fc7b84e1a90451C8a0Ed499234aE0a4d6D`
  ([explorer](https://www.oklink.com/xlayer/address/0x2bbd57Fc7b84e1a90451C8a0Ed499234aE0a4d6D)),
  tx `0x2ad03d6ac7b52ab05a90c16c72f7c0b5a6679db3c10812ff1e7aa9b5198f5895`
  (block 72686947, gas 1,505,899). `REGISTRY()`/`FACTORY()` correct, both
  immutables embedded in code (code-keccak differs from artifact hash *only* by
  those two addresses — verified by content), caps 8192/16.
- Licensed demo tx: `0x17aad8c2a3aec1d050966e5ff87cabf235c1cfd2b309f8058f08978d5f7a775f`
  ([explorer](https://www.oklink.com/xlayer/tx/0x17aad8c2a3aec1d050966e5ff87cabf235c1cfd2b309f8058f08978d5f7a775f),
  block 72687060, gas 345,004, value exactly 0.0018 OKB
  = 0.0005 license + 0 mint + 0.0013 fee).
- Result: TRACE circuit **#2**, owner = payer, netlist = submitted 43 B
  (keccak `0x046f2bad…`), `nextId` 1→2, material `minted` unchanged at 8
  (zero-balance pure-REF tapeout confirmed live).
- `LicensedTapeout(TRACE, 2, 0x02335455…, 500000000000000, 1, payer)` —
  event lineageHash == locally recomputed value; `LicensePaid` 0.0005 OKB.
- Payee balance delta across the licensed block: **exactly 500000000000000 wei**.
- Live preflight gas estimate was 387,217; actual 345,004 (estimate conservatism
  confirmed, no anomaly).
- Total wallet spend: 0.02040883 → 0.01854376 = **0.00186507 OKB** across 6 txs
  (incl. one superseded registry deploy + registration — see incident note).
- Incident (honest record): the first registry deploy used a stale pre-`exists`
  artifact (legacy lowercase filename shadowing the canonical build; the
  `getRegistration` tuple then mis-decoded client-side). Its TRACE registration
  (tx `0xa5b4cfd0…`, block 72686210) is valid on-chain but unreadable by the
  current 8-field client/router — abandoned, documented here, never reused.
  Root-cause fixes: build-freshness guards in both deploy scripts, legacy
  filename removed by the compiler, canonical `build/<Contract>.json` paths
  everywhere.

## Gate matrix (no normal command spends)

| Command | Broadcasts? | Gates |
|---|---|---|
| `npm test`, `phase4:prepare`, `phase4:dry-run`, verify/inspect scripts | Never | none needed |
| `scripts/phase3/deploy-registry.mjs` (live) | Registry deploy | `CONFIRM_BROADCAST=1` |
| `scripts/phase4/register-example.mjs` (live) | Registration | `CONFIRM_BROADCAST=1` **+** `CONFIRM_REGISTRY_DEPLOY=1` |
| `scripts/phase4/deploy-router.mjs` (live) | Router deploy | `CONFIRM_BROADCAST=1` |
| `scripts/phase4/licensed-tapeout.mjs` | Licensed tape-out | `CONFIRM_BROADCAST=1` **+** `CONFIRM_LICENSED_TAPEOUT=1` |
