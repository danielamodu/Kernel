# Phase 3 — Attribution Registry

Status: **activated. Registry live at `0x34cDa4B9668609FC7EF62c6f84058B68894c6bBa`
(X Layer 196) with canonical TRACE #1 registration (tx `0xab74807e…`,
block 72686876). No payments moved through the registry itself (records only).**
 Phase 0 ground truth: `docs/PROTOCOL.md` · Phase 1: `docs/PHASE1.md` ·
 Phase 2 lineage: `docs/PHASE2.md`.

## 1. What the attribution registry does

It records, for a reusable TapeOut computation: **who registered it, the exact
content observed, who to pay, at what price, under what terms-hash** — keyed by
the Phase 2 slot identity. It is an evidence log that Phase 2 lineage graphs can
be joined against. Nothing more.

## 2. Why identityKey matters

The slot key `tapeout:v1:{chainId}:{processor}:{circuitId}` is the only identifier
that is (a) deterministic from raw bytes, (b) chain-scoped, and (c) stable across
implementations. The on-chain primary key is its keccak:
`keyHash = keccak256(abi.encode(chainId, processor, circuitId))` — 96-byte
non-packed preimage, pinned by an explicit layout test. Human names, URLs, and
dotted tape IDs are never keys.

## 3. Why netlistHash is stored

Without it, a record is just someone's claim about a slot. With it, anyone can
re-derive `(processor, circuitId, netlistHash)` live via `netlist()` and compare:
match ⇒ the record describes the actual bytes; differ ⇒ explicit `mismatch`
(the record is NOT trusted). Content binding is what turns registration from a
claim into a verifiable artifact.

## 4. Why termsHash is stored

Terms are a canonical JSON document hashed to bytes32 (`keccak256` of
whitespace-free, key-sorted UTF-8 — exact bytes documented in §tests and
`src/registry/terms.js`). The hash commits the registrant to specific terms
(price, model, attribution requirement) without paying their byte-rent on chain.

## 5. Why terms are not stored directly on-chain

Gas (arbitrary text × every registration), mutability confusion (edited text vs
the hash committed at registration), and scope (Phase 3 records terms; Phase 4
settles them). The hash is the commitment; the document lives off-chain and is
re-hashed by any verifier in one function call.

## 6. How lineage joins against the registry

```
TapeOut Factory
      ↓
  TapedOut
      ↓
   netlist()
      ↓
  REF parser            (src/lineage/netlist.js — raw bytes, offsets)
      ↓
Lineage graph           (src/lineage/resolver.js — dedup, cycles, depth, missing)
      ↓
 identityKey            (src/lineage/identity.js — slotKey per dependency)
      ↓
Attribution Registry    (contracts/AttributionRegistry.sol + src/registry/*)
      ↓
 payee / price / termsHash   (+ registered | unregistered | inactive | mismatch | unknown)
```

`src/registry/attribution.js` (`attributeLineage`) walks unique dependency slots
(direct first, then transitive), looks each up, and compares the record hash to the
live node hash. Duplicates collapse to one entry; the root is reported separately
and never counted as its own dependency; unreadable deps are `unknown`, never
`unregistered`.

## 7–9. What the statuses mean

- **REGISTERED** — active record, live hash equals record hash. "We can prove which
  computation was reused and retrieve its attribution terms."
- **UNREGISTERED** — no record for this slot. Means exactly that — not "free", not
  "licensed", not "infringing". Never treated as licensed-by-default.
- **MISMATCH** — record exists but the live bytes differ. The record is distrusted;
  possible causes: wrong hash at registration (correctable by the registrant via
  `updateTerms`, evented), or a genuinely different circuit erroneously conflated.
- **INACTIVE** — record existed, registrant deactivated it (permanent tombstone).
  Terms remain visible for reference; the slot counts as unattributed.
- **UNKNOWN** — dependency unreadable live (missing/truncated). Cannot verify;
  reported with reason, never dropped.

## 10. What the registry does NOT enforce

Repeating `docs/PROTOCOL.md` §5–§6 because it matters most here: no prevention of
copying, REF reuse, reimplementation, or direct factory calls; no mandatory
royalties; no TapeOut-level license checks. Anyone calling the factory directly
bypasses this registry completely — by protocol design. The registry is
**application-level attribution**: `CONTRACT ENFORCED` as a record,
`NOT ENFORCEABLE` as a gate. Forbidden language: "licensed", "protected",
"royalty-enforcing", "REF requires a license". Allowed: "registered",
"attributed", "terms available", "registration valid".

## 11. Foundation for Phase 4 settlement

Phase 4 needs exactly what now exists: `payee` + `priceWei` per verified slot
(payment targets), `termsHash` (what was agreed), `hashVerified` lineage joins
(what was actually reused), and the router pattern from `docs/PROTOCOL.md` §7
(pay → mint → tapeout atomically, emitting a proof event). Nothing in Phase 3
moves funds; `price` is recorded, not collected.

## Contract design (`contracts/AttributionRegistry.sol`, solc 0.8.26, ~2.6 kB init)

- `register(...)` — one-shot per slot; caller becomes sole registrant; requires
  nonzero `netlistHash`/`payee`; price may be 0 (gratis), termsHash may be 0
  ("terms not published"). Emits `Registered`.
- `updateTerms(...)` — registrant + active only; all bound fields correctable with
  an event (assertion log, not proof). Emits `TermsUpdated`.
- `deactivate(...)` — registrant only, **one-way** (tombstone; keeps "registered"
  unambiguous). Emits `Deactivated`.
- `getRegistration(...)` (reverts `NotRegistered` when absent),
  `isRegistered(...)` (exists AND active), pure `slotKey(...)` helper.
- Custom errors mirror the memory twin's codes 1:1. No owner/admin, no upgrade,
  no tokens, no marketplace. `chainId` is data, never `block.chainid`-checked:
  any chain's slots can be registered.

## Economic data (live-quoted, pre-deployment)

- Registry deploy (dry-run, X Layer): init 2,573 B, **608,527 gas ≈ 0.000012 OKB**
  at 20 gwei — two orders of magnitude cheaper than the Phase 1 flow.
- Registration storage: one SSTORE-heavy tx per slot (measured at activation).
- Price representation: `uint256` wei of the chain native asset (OKB on X Layer);
  currency explicit in terms (`currency: 'OKB'`), never assumed by the contract.

## Verification performed (all without funding)

- `npm test` → **83/83** (22 Phase 1 + 36 Phase 2 + 25 Phase 3), incl. solc compile
  (pretest), client↔contract selector/topic cross-checks, key-preimage layout pin,
  terms determinism matrix, and the full attribution matrix
  (registered/unregistered/inactive/mismatch/unknown/dedup/nested/cross-processor).
- Live read-only: lineage→registry join of a synthetic REF root against **live
  TRACE circuit #1** resolved `registered` + `hashVerified: true` with
  payee/price/terms retrieved (see report §5).
- `inspect-registration` on TRACE #1 prints identity
  (`tapeout:v1:196:0x7761…:1`), hash, owner, I/O — `NOT_CONFIGURED` until a
  registry deploys (honest, no fabrication).
- Safety: deploy script refuses without `CONFIRM_BROADCAST=1`; no `.env` exists;
  secrets sweep clean (only doc/gate string references).

## Activation (observed mainnet values — activation day)

- Registry address (X Layer 196): `0x34cDa4B9668609FC7EF62c6f84058B68894c6bBa`
  ([explorer](https://www.oklink.com/xlayer/address/0x34cDa4B9668609FC7EF62c6f84058B68894c6bBa))
- Deploy tx / block / gas: `0xd6989bacf9046718250a6da4b02667c378c500f0f9eb6d0d4b18ca380fddc60c`
  / 72686810 / 521,373. Code hash matches build artifact (`0x8b29c4f2…`); on-chain
  `slotKey(196, TRACE, 1)` == client derivation `0x1101b7fd…`.
- First registration (TRACE #1): key `0x1101b7fda93495f606b4ee008f95a1fff76ccf12ad790a308810118e93a06c9b`,
  tx `0xab74807ef7c17eaba61c7771f5e4aed52614ed645562477ea73334c9669fc655`
  (block 72686876, gas 139,251); read-back byte-for-byte verified + independent
  `inspect-registration`: REGISTERED, Identity MATCH, Netlist MATCH.
- Superseded artifact (honest record): a first registry deploy
  (`0xfE0e1F98fB4940320F808F1734c24862C5A92a0e`, tx `0x417260a5…`) used a stale
  pre-`exists`-flag build (root-caused to a legacy artifact filename; freshness
  guards added to both deploy scripts). Its TRACE registration
  (tx `0xa5b4cfd0…`, block 72686210) is valid on-chain but unreadable by the
  current router/client tuple shape — abandoned, not reused.
