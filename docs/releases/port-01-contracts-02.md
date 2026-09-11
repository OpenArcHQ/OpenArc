# PORT-01 contract foundation — second batch

September 11, 2026. Build phase: shared foundations in progress, not a commerce
launch or deployed wallet/passkey login.

## Scope

- P01-01d: fixed four-DTO identity registry, exact field-class maps, preserved
  schema refinements and separately typed API v2 success responses.
- P01-02a: Arc Testnet USDC quantities and exact BigInt conversion/arithmetic.
  Native and ERC-20 values are two unit views of one asset; no balance aggregation,
  rounding, payment signing, broadcast, budget authority or automatic retry.
- Canonical S/B/F specifications amended together to 0.3.0-draft: wallet-first
  payment access; passkeys proposed for other accounts; login, wallet linking and
  agent spending remain separate. Minimum passkey account retention awaits owner
  clarification. Public browsing remains account-free, not a zero-logging promise.
- Original supplied specifications preserved byte-for-byte in
  `docs/engineering/archive/commerce-supplied-2026-08-16/`; all three original
  SHA-256 values match the provenance table in `commerce-transition.md`.

No existing shared export, legacy parser, route, dependency, wallet, Vault format,
frontend screen, infrastructure setting or deployment source changed.

## Implementation and verification

DeepSeek V4.1 Flash through OpenCode Go authored all code and tests. Astra defined
the contracts, reviewed the diffs and ran verification. The worker correctly
reported that it did not run commands in the patch-only transport.

The registry initially had one incorrect test expectation for a valid fractional
timestamp and one type-only import lint finding. A single test-only correction
preserved the valid case and added exact increasing/decreasing sub-millisecond
vectors. Existing production schemas and assertions were not weakened.

- Registry focused suite: 11 passed; strict test/source type checks and lint passed.
- Money focused suite: 34 passed; strict test/source type checks and lint passed.
- Combined commerce suites: 105 tests across the accepted batches.
- Full release/source verification: pending on this candidate; do not infer a
  completed application gate from these focused results.

Verification applies to this candidate's code, not to unrelated development work
or the currently deployed legacy Testnet application. Authentication integration,
PostgreSQL authority, purchases and frontend visual parity remain unfinished.
