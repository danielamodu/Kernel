# Architecture

```
                X LAYER (chain 196, OKB gas)
                   |
          +--------+--------+
          |                 |
   TapeOut Factory    AttributionRegistry      <- ON-CHAIN (ours: registry+router)
   (official,          (register/update/
    permissionless)     deactivate/get)
          |                 |
          |                 |
      netlist()         identityKey
   (per circuit)       (slotKey keccak)
          |                 |
          +--------+--------+
                   |
            Lineage Engine                 <- OFF-CHAIN (src/lineage/*, read-only RPC)
            (parse -> resolve ->
             dedupe/cycles/depth)
                   |
           Licensed Router                 <- ON-CHAIN (LicensedTapeoutRouter.sol)
           (validate -> pay -> mint ->
            tapeout -> prove)
                   |
           Payment + TapeOut
                   |
         LicensedTapeout Event             <- ON-CHAIN proof (queryable forever)
```

## Which parts are what

- **TapeOut protocol** (not ours, permissionless): factory (`0x1f09…0761`),
  per-processor Circuits + Transistors contracts, `tapeout`/`mint`/`eval`/`step`
  semantics, REF opcode layout. Source of truth for bytes; never gated by us.
- **Our on-chain contracts**: `AttributionRegistry` (evidence log: who/what/how
  much/under-what-hash), `LicensedTapeoutRouter` (voluntary atomic
  pay-mint-tapeout-prove path). Neither can restrict the factory.
- **Off-chain tooling** (this repo): lineage parser/resolver/identity
  (`src/lineage`), registry + router clients, preflight, commitment
  (`src/registry`, `src/router`), and all `scripts/*` (read/prepare/verify;
  broadcasts only behind explicit dual gates, wallet owner only).
- **Off-chain data**: human-readable terms documents (only their keccak lives
  on-chain), fixture labels, demo plans. Nothing here is trusted — verifiers
  re-hash and re-read.

## Frontend decision (deliberate: none)

The repository has no frontend foundation (pure Node CLI + docs + tests). Per
scope control, no web UI was built: a half-finished UI would risk more than a
strong CLI/demo communicates. Judge surface = `npm run demo:dry-run` output,
`docs/PITCH.md` (60 s), `docs/DEMO_SCRIPT.md` (120 s), and explorer links after
activation. A UI can consume the machine-readable JSON every script already
prints — no backend changes needed.

## Data flow (demo)

1. Canonical bytes (`fixtures/final/demo-root.json`, PREPARED) ->
2. live `netlist()`/`circuitInfo`/`ownerOf` reads (chain-reader) ->
3. parse + resolve (lineage) ->
4. `identityKey`/`keyHash` (identity + client) ->
5. registry record (live after activation; expected-config before) ->
6. preflight verdict + `lineageHash` (commitment) ->
7. router calldata + exact value (client) ->
8. broadcast (activation only) ->
9. `LicensedTapeout` + read-back verify (verify scripts).
