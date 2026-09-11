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
- Full private `pnpm release:gate` passed on source commit
  `11a35e3b4124bfe334c24bd9a9ee10e3aec736a6`: 629 unit/integration tests
  (326 shared, 185 API, 118 web), 112 browser tests, release structure,
  production-dependency audit, license policy, lint, typecheck and build.
- [Public source verification](https://github.com/OpenArcHQ/OpenArc/actions/runs/34625049283)
  targets public source commit `23e66d004dbafc79f47df367431ca95b718a243a`.
  Its recorded result is authoritative for that revision; publication requires a
  successful result. The public baseline includes four additional API tests.
- This evidence-only follow-up changes no implementation or test. Source-gate
  results are tied to the exact revisions above, not claimed as fresh executions
  on a later documentation commit. A source diff must confirm that distinction
  before merging the follow-up.

Verification applies to this candidate's code, not to unrelated development work
or the currently deployed legacy Testnet application. Authentication integration,
PostgreSQL authority, purchases and frontend visual parity remain unfinished.
