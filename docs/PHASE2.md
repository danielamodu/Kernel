# Phase 2 — Computational Lineage (REF provenance)

Status: **complete, fully offline-testable, read-only on chain. Zero broadcasts.**
 Phase 0 ground truth: `docs/PROTOCOL.md` · Phase 1 proof: `docs/PHASE1.md`.

## 1. Why REF matters

TapeOut computation is composable through exactly one mechanism: the REF gate
(opcode `0x02`), a netlist record that names an already taped-out circuit
`(processor, circuitId)` plus a pin map. Everything else (canvas UX, vault labels,
market mining weights) is commentary. The bytes are the composition.

Phase 2 answers one question, deterministically, from raw bytes:

> "What computation is actually inside this circuit?"

The answer is a lineage graph: every REF dependency, recursively resolved, with
cycles, duplicates, depth violations, and missing circuits handled explicitly.
Phase 3 (attribution/licensing) will consume this graph. **This phase proves the
graph layer only.** It does not prevent copying, does not enforce licenses, and
claims no such thing (see `docs/PROTOCOL.md` §5–§6: prevention is NOT ENFORCEABLE;
lineage is PROTOCOL RECORDED).

## 2. Exact REF byte format

```
0x02 || cpu:20B || circuitId:u64 BE || nIns:u8 || nOut:u8 || ins: nIns × u24 BE
total length = 31 + 3 × nIns bytes
```

- `cpu`: the referenced Circuits contract address (20 bytes, any chain — resolution
  happens on the referencing chain's state).
- `circuitId`: big-endian uint64, ≥ 1 (IDs start at 1; `circuitInfo(0)` reverts live
  with `"no circuit"`).
- `nIns`/`nOut`: uint8 each ⇒ ≤ 255 pins per side.
- `ins`: `nIns` big-endian u24 signal indices into the *referencing* circuit. They
  must reference already-defined signals (forward refs rejected on chain and here).
- **Outputs are allocated implicitly, never stored.** The `nOut` outputs are the next
  `nOut` free signals after the record. There are no output-pin bytes.

**Divergence from the Phase 2 brief (resolved in favor of ground truth):** the brief
describes trailing `nOut × uint24` output pins. That is incorrect. The official
`tapeout.net` decoder (`R` in `netlist-nwZJybgD.js`), the 43-byte documented example
(`docs/PROTOCOL.md` §4.2, byte-exact round-trip in `tests/phase2/ref.test.js`), and
live `netlist()` bytes all confirm `31 + 3×nIns` with implicit allocation.
`src/lineage/ref.js` implements the verified format; `parseRefGate` rejects trailing
bytes rather than misreading them as pins.

## 3. How raw netlists expose composition

`src/lineage/netlist.js` (`parseNetlist`) walks the byte stream with zero trust in
any frontend representation: per gate it records `{index, type, offset, length,
fields…}`. NAND (7 B) and LATCH (4 B) records are fixed-size; REF records are
variable (`decodeRefAt` returns exact `bytesConsumed`). Offsets tile the input
exactly (asserted in tests), so any dependency can be traced to its byte position.

Consequences for attribution:

- REF extraction is a pure function of `netlist(id)` bytes: scan for `0x02`, parse,
  done. Any contract *or* indexer can do it; we do it off-chain, deterministically.
- Flattened copies (REF inlined as raw NANDs) leave no `0x02` trace — detectable only
  by content matching (`netlistHash`, gate-subgraph). The graph layer reports what is
  *referenced*; copy-detection is a Phase 3 consumer concern.
- REF gates burn **no** transistors (`own burn 0`, `docs/PROTOCOL.md` §3.2): lineage
  weight (`stats.nandCount/latchCount/refCount`) counts own-level gates of resolved
  nodes, matching the protocol's mining-weight semantics.

## 4. Circuit identity (`src/lineage/identity.js`)

Identity = slot + optional content proof:

```js
{ chainId: '196', processor: '0x…', circuitId: '1', netlistHash: '0x…' | null }
key: tapeout:v1:196:0x…:1:<keccak|unverified>
```

- `chainId` is mandatory: processor + circuit ID alone are **not** globally unique.
- Normalization (lowercase address, decimal strings) makes the key deterministic
  across input representations (address case, number/bigint/string IDs).
- `slotKey` (no hash) drives graph dedup/cycle logic; the full key (with hash) is
  what gets recorded and compared. `equalSlot` vs `equalExact` keep the two notions
  apart; `parseIdentityKey` round-trips strictly.

## 5. Recursive lineage (`src/lineage/resolver.js`)

`resolveLineage(rootRef, { fetchCircuit, chainId, maxDepth = 8 })` performs an
iterative DFS in netlist order (FIFO-deterministic: same input → deep-equal output).
`fetchCircuit` is injected — fixtures in tests, `chain-reader` live — so the core
logic never touches the network. Output: `{ root, nodes, edges,
directDependencies, transitiveDependencies, depth, cycles, missing, truncated,
stats }`, where each node carries `{ key, chainId, processor, circuitId,
netlistHash, depth, status, nIn, nOut, own:{nand,latch,ref}, error? }` and each edge
`{ from, to, refIndex, gateOffset }`.

## 6. Cycles, depth, missing (all explicit, never silent)

- **Cycles** (`A→B→C→A` fixture): traversal back-edges are recorded as paths in
  `cycles` (e.g. `[A,B,C,A]`); the shared node keeps its resolved status; expansion
  stops. Terminates by construction (iterative stack + visited classification).
- **Duplicates** (two identical REF records): one node, **two edges** (edge per
  record, with distinct `refIndex`/`gateOffset`). `directDependencies` dedups to
  unique slots in first-appearance order; `edges` preserves multiplicity.
- **Depth** (chain of 6, `maxDepth: 2`): nodes past the limit are fetched, classified
  `truncated` with reason, and not expanded. Their identity is recorded; their
  children are explicitly unexplored — not dropped.
- **Missing** (fetch null/throw/unparseable): node `status: 'missing'` with reason,
  listed in `missing`, edge to it preserved. One unreadable dep never aborts the rest.
- **Invariant (tested):** over all resolved nodes, `Σ own.ref == edges.length` —
  every parsed REF record yields exactly one edge.

## 7. Vocabulary (do not conflate)

| Term | Meaning | Example |
|---|---|---|
| Direct dependency | slot named by a root-level REF record | root → B |
| Transitive dependency | reachable beyond direct, deduped, BFS order | root → B → C ⇒ C |
| Circuit identity | canonical slot (+ optional content proof) | `tapeout:v1:196:0x…:1:…` |
| Netlist hash | keccak256 of stored bytes; proves *content* | `0xe6477490…` (matches published column, §8) |

Note: Phase 1's `fingerprint()` is SHA-256 (TRACE `netlist.json` convention); lineage
`netlistHash` is **keccak256** (matches the repos' published `Netlist Keccak-256`
column — verified equal on Nandverse #1, §8). Different hashes, different consumers;
both recorded, never mixed.

## 8. Verified live on X Layer (read-only, X Layer mainnet chain 196)

`scripts/phase2/inspect-circuit.mjs --processor 0x.. --circuit N` (prints tree +
summary + JSON; broadcasts nothing):

1. **TRACE circuit #1** (`0x7761…1274a`, block ~71998334): 1 node, 0 edges —
   8 NAND / 0 LATCH / 0 REF; all 16 `eval` rows already matched in Phase 1.
2. **Nandverse circuit #1** (`0x57E9…1A44`): 1 node — **118 NAND / 1 LATCH / 0 REF**;
   keccak `0xe64774909343d9f7b9928ee66630ac0adec49f715ae3868c0bd10dee959fb179`
   **exactly equals** the published `Netlist Keccak-256` for Oathkeeper in the
   builder repo's `docs/XLAYER-MAINNET.md` — independent end-to-end confirmation of
   the read path. `nextId` is now 12 (drift: 11 → 12, a 12th circuit taped since).
3. **Synthetic-root → live-dependency demo** (root NOT on chain, dep live):
   single-REF root resolving TRACE #1 → 2 nodes, 1 edge, depth 1, dep content
   8 NAND. Proves the resolver's live leg without spending anything.
4. No REF-bearing circuit was found on X Layer in the inspected sample (TRACE,
   Nandverse #1); same-chain REF *broadcast* remains open (Phase 0 §9 Q1).

## 9. Fixtures (`tests/phase2/fixtures/`, every file labeled)

| Fixture | Label | Covers brief case |
|---|---|---|
| `no-ref.json` (Phase 1 AND) | SYNTHETIC | 1. no REF |
| `one-ref.json` | SYNTHETIC | 2. one REF |
| `nested.json` (R→M1→M2 map) | SYNTHETIC | 3. nested |
| `duplicate-ref.json` | SYNTHETIC | 4. duplicate |
| `cross-processor.json` | SYNTHETIC | 5. cross-processor |
| `malformed-ref.json` (7 cases) | SYNTHETIC | 6. malformed |
| `truncated-ref.json` (7 prefixes) | SYNTHETIC | 7. truncated |
| `cycle.json` (A→B→C→A map) | SYNTHETIC | 8. cycle |
| `missing-dep.json` | SYNTHETIC | 9. missing |
| `depth-chain.json` (chain of 6) | SYNTHETIC | 10. depth |
| `live-trace-1.json` (chain 196, block 71630664) | LIVE-VERIFIED | live anchor |

Nothing synthetic is presented as live: labels are inside each fixture and enforced
by test names; the inspect script prints `SYNTHETIC`/`NOT on chain` for fixture roots.

## 10. What this enables for Phase 3 (and what it does not)

Enables: registry keys (`identityKey`), router-side REF allowlisting (parse submitted
`nl` with `parseNetlist`, compare against paid licenses), indexer lineage joins,
flattened-copy detection via `netlistHash`, timestamp priority via `TapedOut` blocks.
Does **not** enable: preventing unlicensed tape-outs, forcing payment, or trusting
frontend checks — `docs/PROTOCOL.md` §5–§6 still govern. The graph is evidence
infrastructure, not an enforcement hook.

## Protocol ambiguities discovered (new in Phase 2)

1. **Brief vs bytes on REF outputs** (§2 above): brief claims stored output pins;
   verified format allocates implicitly. Implemented the verified bytes.
2. **LATCH.d may reference future signals.** The official decoder checks definedness
   for NAND/REF but never for LATCH.d. Live Nandverse #1 opens with `LATCH(d=30)`
   while only 22 signals exist yet — our first inspect misclassified it as missing.
   Fixed (`src/lineage/netlist.js` accepts any u24 d) with a regression test.
   (Phase 1's codec remains stricter — untouched per constraints; it only ever sees
   our latch-free AND.)
3. **`circuitInfo(0)` reverts `"no circuit"`** (observed live): confirms 1-based IDs
   with an exact protocol error string worth matching in Phase 3 routers.
4. **`TapedOut.gateCount` semantics for REF-bearing circuits** are still unobserved
   live (no such circuit found on X Layer): does `gateCount` count REF records, and
   does `nState` include resolved sub-state? The frontend resolver says yes to the
   latter; chain confirmation awaits the first REF broadcast.
5. **Hash conventions differ by consumer** (keccak here vs SHA-256 in Phase 1
   fingerprints): both kept, labeled, never interchanged.

## Completion mapping (§10 criteria)

- [x] REF encoder/decoder byte-for-byte (`ref.test.js`: exact 43 B vector + encoder
      cross-agreement between lineage and Phase 1 encoders at fixture build)
- [x] raw parser identifies NAND/LATCH/REF with offsets (`netlist.test.js` + Phase 1 regression)
- [x] deterministic identity (`identity.test.js`: normalization, cross-chain, round-trip)
- [x] recursive resolver (`resolver.test.js`: nested/duplicate/cross-processor)
- [x] duplicates: 1 node + 2 edges (tested)
- [x] cycles terminate + reported (tested, path asserted)
- [x] depth limits explicit (tested, truncation asserted)
- [x] missing explicit (tested, reason asserted)
- [x] cross-processor REF (tested + byte-level)
- [x] live X Layer inspection read-only (TRACE #1, Nandverse #1, synthetic→live demo)
- [x] lineage output includes netlist hash (keccak256 in every node + summary)
- [x] all Phase 1 tests still pass (22/22, zero Phase 1 files modified)
- [x] all Phase 2 tests pass (36/36; total 58/58 via `npm test`)
- [x] docs/PHASE2.md complete
- [x] no mainnet transaction broadcast (no key configured; scripts refuse without `CONFIRM_BROADCAST=1`)
