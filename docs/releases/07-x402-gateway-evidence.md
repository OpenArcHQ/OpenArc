# M07 — x402 / Gateway evidence

Status: implementation active; not release-ready or deployed.
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

- [ ] Schema, reconciliation, backend, consent, vault integrity and UI failure tests.
- [ ] Complete and intentionally incomplete authentic external Testnet evidence.
- [ ] Independent review with no unresolved P0/P1 findings.
- [ ] Full local release gate and exact-SHA CI, production scans and SBOM.
- [ ] Exact-SHA staging deployment and isolated browser smoke proof.
- [ ] Immutable RC tag and production-main closure under sequential release rules.

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
`<deployment-id>`. The first exact Gateway read reported
`received` with no batch hash. A later exact read reported `completed`, updated
at `2026-09-05T23:22:03.150Z`, and batch transaction
`0x01ea0668820c33a45bbd9be1b0cec99d06f6dffb4cdce8529581b96220cea2c2`.
This is Gateway's completion report; independent batch inclusion is still pending
the consented product/staging check, and individual payment inclusion is not inferred.
The initial harness hook stopped before signing because the SDK omits resource
metadata from that hook. A non-signing reproduction proved zero signer calls;
the aborted attempt marker was preserved before one corrected attempt. There was
no blind retry or duplicate payment. Complete and deliberately response-omitted
normalized bundles were captured externally; signing material remains outside
OpenArc. Product/staging validation is still outstanding.

User approval on 2026-09-05 covers a new disposable external EOA, at most 1 test
USDC deposited and 0.01 test USDC paid total, plus testnet gas. No user wallets,
real funds, paid accounts, or PII. Product signing remains prohibited. See the
[source preflight](../engineering/m07-x402-preflight.md) for current official APIs.
