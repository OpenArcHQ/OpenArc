# M07 — x402 / Gateway evidence

Status: **complete** — immutable `rc/07-x402-gateway-evidence/1`.
This is an M07 Testnet milestone, not public-release or mainnet readiness.
Branch: `codex/07-x402-gateway-evidence`, based on production main `12705ad`.

## Frozen implementation boundary

- Separate strict normalized receipt metadata, Gateway observation, and versioned
  local reconciliation contracts. M01 synthetic schemas and engine stay unchanged.
- Imported metadata is explicitly unauthenticated. No signatures, keys, raw
  headers, private URLs, paid response bodies, or caller-supplied conclusions.
- Read one exact transfer UUID through the fixed Circle Gateway Testnet GET route.
  Only the network and UUID leave the vault after encrypted consent is committed.
- Preserve five Gateway states, exact six-decimal USDC integer amounts, nonce,
  and nullable batch hash. Batch inclusion is not unique payment or fulfillment proof.
- Compare exact field bindings; missing evidence remains a gap and inconsistent
  evidence a conflict. Imported timing is not independently authenticated.
- Keep authorization verification, metadata agreement, provider claims, Gateway
  status, and batch inclusion distinct, with cited inputs and a rule version.
- Keep existing vault global capacity and atomic permission/observation saves,
  lock cancellation, rescue/export/import integrity, and bounded source budgets.
- Default-off cumulative Gateway flags. No execution path in product code.

## Required release evidence

- [x] Schema, reconciliation, backend, consent, vault integrity and UI failure tests.
- [x] Complete and intentionally incomplete authentic external Testnet evidence.
- [x] Independent review with no unresolved P0/P1 findings.
- [x] Full local release gate and exact-SHA CI, production scans and SBOM.
- [x] Exact-SHA staging deployment and isolated browser smoke proof.
- [x] Immutable RC tag and production-main closure under sequential release rules.

## Rollback and data compatibility

Keep an M07-capable reader once any M07 metadata, observation, or v5 permission
record has been saved. Disable `GATEWAY_EVIDENCE_ENABLED` first to stop new reads;
do not replace the reader with M06 over an M07 vault. Existing backup/recovery
and opaque rescue remain available. Disabling the web flag hides payment controls
but does not remove encrypted data. Staging changes reuse only the existing API,
web and Redis services; no new project, provider account, or paid plan is required.

## Live test authorization

Controlled external test progress (2026-09-05): Circle faucet supplied 20 valueless
test USDC; only 1 was deposited. Exact approval transaction
`0x73b4b07db0a35361364306885e4217553b9249b46dfc75d65e6ee9438e6df54a`,
deposit `0x9b766c0cbc9c4d7e94c446116c0f329442d4aa9664020b85c621bde7fd491121`.
One 0.001 test USDC payment produced transfer
`7d8160d5-1dad-4094-888b-f9bdfc5b5613`. The first exact Gateway read reported
`received` with no batch hash. A later exact read reported `completed`, updated
at `2026-09-05T23:22:03.150Z`, and batch transaction
`0x01ea0668820c33a45bbd9be1b0cec99d06f6dffb4cdce8529581b96220cea2c2`.
The consented product/staging check independently observed successful batch
transaction inclusion. Individual payment inclusion is not inferred.
The initial harness hook stopped before signing because the SDK omits resource
metadata from that hook. A non-signing reproduction proved zero signer calls;
the aborted attempt marker was preserved before one corrected attempt. There was
no blind retry or duplicate payment. Complete and deliberately response-omitted
normalized bundles were captured externally; signing material remains outside
OpenArc. Product/staging validation passed using both normalized bundles.

User approval on 2026-09-05 covers a new disposable external EOA, at most 1 test
USDC deposited and 0.01 test USDC paid total, plus testnet gas. No user wallets,
real funds, paid accounts, or PII. Product signing remains prohibited. See the
[source preflight](../engineering/m07-x402-preflight.md) for current official APIs.

## Exact application and automated proof

Application SHA: `2edbc9d2c4c9eec309603a4347e69fbe15974470`.
Hosted release gates (pre-publication CI; private link omitted)
passed on that exact SHA: 410 shared/API/web tests, 84 Chromium/WebKit functional
journeys, production-image source/proxy journeys, lint, types, build, dependency
audit, license checks, and eight blocking HIGH/CRITICAL image scans. No vulnerability
suppression was added. The SBOM artifact is `9978909258` (`openarc-sboms`), digest
`sha256:78f13556064807066fa223e79806544545d76b71e46fec0d0c85a2ae2485963a`,
expiring `2026-12-04T23:28:40Z`.

The final Node 22 / disposable Redis clean-room gate passed the same 410 tests
and 84 browser journeys. Image manifest:
`sha256:f8f83c8bbc16167bfc3cc6bc9be4563313ac12719e950d1b6bd5ce3c049e8d6a`.
An earlier browser run exposed an unreachable ninth navigation button at short
desktop heights; the scrollable sidebar fix passed the rerun. Independent shared,
frontend, backend and CI reviews left no unresolved P0/P1 findings.

## Existing Railway staging proof

Only the existing staging API and web were deployed; Redis, production, service
count, and plan were unchanged. Both services expose the exact application SHA.

- API deployment `9ecdaccc-76bd-4360-a945-7682c40e2504`, image
  `sha256:9195a6952babb25c1548cdd542bbc6666df04b0ff30df055d3bb0697f5fbd782`.
- Web deployment `44378d7a-d82c-44bf-aab5-1db69eabdc06`, image
  `sha256:db4113732957268d90c9086a5bcf2952c1a8718c95b3bd115fc9d103a97b7ce9`.
- Readiness confirmed configuration, enabled source routes, and Redis healthy.

The isolated live browser journey imported both bundles with zero source calls,
cancelled consent without a call, then made exactly two explicitly approved
lookups: one exact Gateway transfer UUID and one exact Arc batch transaction hash.
Actual request headers omit cookies, authorization and referrer. Responses are
no-store and match the deployed SHA and requested identifiers.

Complete metadata agrees (`consistent`); the deliberately response-omitted bundle
reports `AUTHORIZATION_EXECUTION_TIME_NOT_SUPPLIED`, `GATEWAY_NOT_OBSERVED`, and
`RESPONSE_METADATA_NOT_SUPPLIED`. Repeated authorization metadata produces
`DUPLICATE_AUTHORIZATION_METADATA`, not an invented executed-replay conflict.
The saved Arc observation anchors the successful batch at block `60654320`, hash
`0x57783f0ad605e53484335b96349503050b63571afca59653b088deed2608655a`,
timestamp `2026-09-05T23:22:01.000Z`, deterministic finality, one confirmation.
Authorization, fulfillment, and individual settlement remain **not verified**.

Encrypted persistence, lock/reload/unlock, no automatic refresh, and local-only
batch selection passed; plaintext canaries were absent from IndexedDB. Desktop
and mobile screenshots were inspected and mobile overflow was absent. The test
uses a disposable isolated workspace, never the user's vault. Subsequent test-only
response-capture corrections do not alter the tested application or repeat payments.

The final verification-only revision is
`ee81478b9d479ac4c1115b6faf07d1f087d901e6`. It uses bounded clones of actual fetch
responses in the disposable browser, returning the original fetch promise untouched,
to avoid Chromium CDP response-body cache races. It also reads complete sent headers
and corrects the native-select label locator. Syntax, ESLint and diff checks passed,
followed by two consecutive successful live runs. It does not intercept or retry
requests and adds no product behavior. The immutable RC points to application SHA
`2edbc9d2c4c9eec309603a4347e69fbe15974470`, not this later verification or closure
documentation revision. Main includes those separately identified follow-ups.
