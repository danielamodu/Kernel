# Pitch — attributable computation on TapeOut

"TapeOut makes computation composable. We make composable computation attributable and licensable."

## Problem

Reusable computational circuits can be composed through REF — one circuit can
embed another with a single 43-byte record. But there is no native
attribution/licensing layer around those reusable components. If you publish a
useful circuit, anyone can reuse it, and nobody can prove whose computation is
inside what, or settle terms for it.

## Solution

We identify the exact computations inside a circuit (byte-level REF parsing +
recursive lineage), bind them to verifiable identities and terms (an on-chain
attribution registry keyed by content hash), and provide a voluntary licensed
route that settles those terms atomically before manufacturing (pay → mint →
tape out → proof event).

## Demo (60-120 seconds, `npm run demo:dry-run` + activation at funding)

1. Alice registers a reusable computation (TRACE circuit #1: identity, content hash, payee, 0.0005 OKB, terms hash).
2. Alice sets attribution terms (canonical JSON, hashed on-chain).
3. Bob builds a new computation using REF (43-byte root, 0 own transistors).
4. Our lineage engine discovers Alice's computation (parse + live resolve).
5. Registry verifies the exact netlist (hash MATCH, pins agree).
6. Router calculates the license (0.0005 OKB, one payment per unique dependency).
7. Payment is made (pushed to Alice in the same transaction).
8. TapeOut manufactures the new circuit (mint + tapeout, exact-value accounting).
9. A LicensedTapeout event commits the proof (lineageHash binds deps + terms).

## What we do NOT claim

We do not stop people from using circuits. We do not enforce royalties at the
TapeOut protocol level. REF does not require a license — the factory is
permissionless and always will be. What we provide is a verifiable record plus
a voluntary settlement path: compliance as an asset, not prevention as a promise.

"TapeOut makes computation composable. This makes that computation attributable and licensable."
