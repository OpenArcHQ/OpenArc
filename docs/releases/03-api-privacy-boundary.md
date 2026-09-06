# Milestone 03 — API and privacy boundary

Status: **complete — `rc/03-api-privacy-boundary/1` merged into `main`**
Base: `main` closure `61af347b586a9c5e2d1fb1467139887559e4a378` after immutable
`rc/02-encrypted-workspace/1` at `298c695ae615ea090b02b0410b7ae37125c625b1`
Closed candidate branch: `codex/03-api-privacy-boundary`
Live-source review: **not applicable — all adapters remain absent/disabled**

## Frozen scope and order

1. Freeze shared strict API/error/capability/permission-receipt contracts and
   their malformed/time/version/capacity tests.
2. Build configuration, HTTP/Origin/CSRF/error/log/metrics/readiness boundaries.
3. Implement bounded provider transport and real Redis atomic reservation
   infrastructure; prove failure/accounting/privacy behavior with test transports
   and disposable Redis, not deployed mock routes.
4. Add the explicit capability permission flow and encrypted receipt lifecycle,
   guarded typed client, Sources presentation, and browser failure journeys.
5. Wire the optional same-origin verified-TLS proxy and exact-image CI; retain
   default-disabled builds and the local-only M02 regression gate.
6. Run the full local/hosted gates, independent review, existing-service staging
   walkthrough, immutable RC, and closure before M04.

The M03 additions to the controlling SOT and backend/frontend architecture own
the exact contracts. No live account/transaction/registry/job/Gateway adapter,
mainnet configuration, signing, user account, new managed service, or private
server persistence is included.

## Cost and authority boundary

Use the existing capped Railway web/API services only. Source-disabled M03 does
not require a managed Redis instance. Real disposable Redis remains mandatory
for limiter/budget integration tests; missing test infrastructure is not grounds
to silently skip those tests. Local project-scoped test dependencies may be
installed without creating a global service. Later live-source staging requires
separate verification of actual Redis resource authority/cost and provider terms.

New operator-only metrics configuration is generated securely when deployment
requires it; secret values must not be printed, committed, or exposed through
browser variables. No existing user key is rotated or read for M03.

## Exit evidence

- [x] Strict shared schemas and malformed/future-version/time/capacity tests
- [x] Config/Origin/CSRF/credentials/preflight/parser/error/header contract tests
- [x] Real Redis 8 atomic multi-client limits, budgets, TTL/reset, outage, privacy
- [x] Pinned provider timeout/encoding/redirect/size/JSON/abort tests
- [x] Bounded logs, metrics authentication, readiness, and canary tests
- [x] Permission commit precedes request; failed commit proves zero calls
- [x] Cancellation/session boundaries prove zero late UI or writes
- [x] M02/receipt backup/import/recovery/delete and encrypted persistence tests
- [x] Chromium/WebKit/mobile/Axe/flag-off and exact production-proxy tests
- [x] Full Node 22 gate, audit/licenses, exact images/scans/SBOM/hosted CI
- [x] Exact staging identity, lifecycle/headers/proxy walkthrough and rollback
- [x] Independent no-P0/P1 review, immutable RC and `main` closure

## Local pre-push evidence — 2026-09-03

- Node 22 `pnpm release:gate` passed: shared 54, API 39, web 55,
  baseline Chromium/WebKit 46, flag-off 2, and M03 Chromium/WebKit 12.
- API integration tests used a disposable project-local Redis 8.10.1 process
  built from the official archive after SHA-256 verification
  (`60166c95ab7aedaa9dfe516de685be0a4dd87be95ded59ba429df14c13f1b663`).
- The same persistent browser profile created a receipt under M03, then loaded
  immutable M02 `298c695ae615ea090b02b0410b7ae37125c625b1`. M02 rejected the
  newer record without unlocking, downloaded opaque rescue, and retained its
  acknowledged deletion path.
- Independent review reports no P0/P1 blocker. Exact Docker image, internal TLS,
  HSTS/error-path, scan, SBOM, and clean-room evidence remains gated on hosted CI
  because the local Docker daemon is unavailable.

## Exact implementation candidate evidence — 2026-09-03

Implementation `ceab9be7cd91ba6734c67e69b7240b90224f52eb` was clean,
pushed, and equal to its remote branch head before final staging. GitHub Actions
run `33792431990` completed successfully on that exact SHA:

- Node 22 release checks, production dependency audit, license policy, lint,
  typecheck, 54 shared / 39 API / 55 web tests, and all builds passed. API
  integration used real disposable Redis 8; no limiter or budget test was
  skipped.
- All 46 baseline Chromium/WebKit journeys and 2 flag-off journeys passed. The
  immutable M02 production image passed its exact-image browser journey.
- Exact M03 API/web images passed the two-engine 12-test permission suite
  through a same-origin proxy and a certificate-verified, SNI-bound internal
  TLS hop. The persistent-profile M03-to-immutable-M02 receipt journey passed;
  wrong internal SNI returned 502 with HSTS.
- Four production images built and passed exact-marker smoke tests and all
  HIGH/CRITICAL Trivy scans. Syft generated four CycloneDX 1.7 SBOMs. Unexpired
  artifact `9907941523` (`openarc-sboms`) has digest
  `sha256:47647afb139106ff5474de0b9239f43a278ab1b8fdbdfc1f80793c063545c14c`.
- GitHub reported zero billable runner milliseconds.

The earlier exact implementation run `33791013434` also passed. Its staging
walkthrough then found that web `/metrics` was not proxied but inherited the SPA
fallback's HTTP 200. No metrics data was exposed; nevertheless, that status did
not satisfy the direct-API-only contract. The final implementation adds an
exact HSTS-protected web 404 and a hosted release assertion for it. A separate
Docker fail-fast check also proves the M03 Nginx template and proxy parameters
exist before the image can enter browser testing.

Independent read-only review of the implementation, contracts, failure states,
privacy boundaries, and tests found no P0/P1 blocker. It approved only exact-SHA
staging; immutable tagging, evidence-successor verification, and closure remain
separately gated.

## Exact implementation staging evidence — 2026-09-03

The implementation SHA `ceab9be7cd91ba6734c67e69b7240b90224f52eb`
was deployed API-first to the existing `openarc-staging` project's `staging`
environment. Both deployments reached `SUCCESS`:

- API `6bf9a6bc-21a5-4941-9638-72877c9858c4`, image
  `sha256:bcd650459c02502d0366b2dfd33a620bdc6ae275ecd54663ecc8308192393b96`.
- Web `c4129eca-ba8b-4235-b3dd-3df434fc6576`, image
  `sha256:b4affb7ca335c7e748be13d61e5c08ec28d82766039b3eafc2d7b6c421ceac0c`.

API `/healthz` and `/readyz`, the web shell marker, and both direct and proxied
capability envelopes exposed the full exact SHA. Readiness reported
configuration up, source routes disabled, and Redis not required. Capability
truth reported Arc Testnet `eip155:5042002`, read-only behavior, zero enabled
connectors, and every future source feature false.

The live HTTP boundary passed the following controlled checks:

- the exact preflight returned 204;
- missing and wrong Origin requests returned 403;
- a query mutation returned 400;
- unauthenticated direct API metrics returned 401;
- web `/metrics` returned 404 with HSTS and exposed no operator metrics;
- direct and proxied future source routes returned 503 `FEATURE_DISABLED`;
- shell, proxy-success, and proxy-error paths retained HSTS; the shell retained
  no-store and the M03 same-origin-only CSP.

All 12 production permission journeys passed again against the actual Railway
web origin in Chromium and WebKit. They covered explicit disclosure before the
single capability request, encrypted approval/completion receipts, failed
approval-write zero-call behavior, post-network completion uncertainty,
revision-conflict invalidation, lock-during-request cancellation, mobile
layout, and serious/critical accessibility scanning. Each test used an isolated
browser context; no existing user profile or Vault was touched. A bounded scan
of 22 API and 65 web application-log lines found neither the synthetic
passphrase nor synthetic private label.

### Live-proof, cost, and rollback boundary

Live Arc address/transaction/registry/job/Gateway proof is not applicable to
M03: no source adapter exists or is enabled, the capability route accepts no
identifier and makes no upstream call, and its response explicitly reports
zero connectors. M04 owns the first live chain-read proof. Claiming provider,
Redis-runtime, or mainnet proof here would be false.

Only the two existing capped services were used. Both retained one replica,
1 vCPU / 1 GB ceilings, serverless sleep, and zero volumes. No project, service,
database, managed Redis, paid provider, PAYG path, or recurring resource was
created. The generated operator metrics secret was sent directly to Railway;
it was neither printed, read back, nor committed.

If the boundary or same-origin TLS proxy fails after promotion, stop further
promotion and roll both services back to the last known-good immutable M02
images, or rebuild with both M03 flags false. Verify the exact API/web markers,
M02 local-only CSP, health/readiness, and absence of enabled private routes.
Preserve the origin and local encrypted Vault bytes; a rollback must not delete,
rewrite, downgrade, or claim to recover them. No destructive rollback drill was
needed or claimed.

## Final exact candidate and closure — 2026-09-03

The evidence-only successor
`10172744b6316b21b7b228a9c89d4541b7dd8f3e` passed exact GitHub
Actions run `33793712725`. All verification, browser, and image jobs succeeded,
including the real-Redis API tests, 46 baseline and 2 flag-off browser journeys,
the immutable-M02 compatibility journey, 12 M03 permission journeys through
verified TLS, wrong-SNI rejection, the explicit web-metrics 404, and four
HIGH/CRITICAL image scans. Four CycloneDX 1.7 SBOMs are in unexpired artifact
`9908409814`, with digest
`sha256:0f50d9c2acad293b0e50ba3b6c7d969241ec6fc76e52af4518696085506b5848`.
GitHub reported zero billable runner milliseconds.

Final exact Railway deployments both reached `SUCCESS`:

- API `fe95a216-d04c-4f39-b362-ae9a173c3434`, image
  `sha256:cb88296bf8b9a807f214edfe8cf70d992ecb643cfc4864f1ef0e4ddf593cc147`.
- Web `32d2efc6-a0d7-47ba-9012-239af32af045`, image
  `sha256:04a985a6a6e6c8f6bf9717a365584063bb07705c9704b1e00decac12615d4434`.

API readiness, the web shell, and direct/proxied capability envelopes exposed
the full final SHA. The concise live recheck confirmed empty capability truth,
disabled future sources, authenticated direct-only metrics, web metrics 404,
and HSTS. All 12 Chromium/WebKit production permission journeys passed again
against the final Railway marker.

Immutable annotated tag `rc/03-api-privacy-boundary/1` was created and pushed
at `10172744b6316b21b7b228a9c89d4541b7dd8f3e`, then fast-forwarded into
`main`. This subsequent documentation-only closure records completed operations
without moving or reusing the tag. M04 has not been created or implemented; it
may begin only from updated production `main`. M03 approval is Testnet capability
bootstrap approval, not live-source, public-launch, mainnet, signing, custody,
or transaction-execution approval.
