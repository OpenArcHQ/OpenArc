# Milestone 03 — API and privacy boundary

Status: **active implementation**
Base: `main` closure `61af347b586a9c5e2d1fb1467139887559e4a378` after immutable
`rc/02-encrypted-workspace/1` at `298c695ae615ea090b02b0410b7ae37125c625b1`
Active branch: `codex/03-api-privacy-boundary`
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
- [ ] Chromium/WebKit/mobile/Axe/flag-off and exact production-proxy tests
- [ ] Full Node 22 gate, audit/licenses, exact images/scans/SBOM/hosted CI
- [ ] Exact staging identity, lifecycle/headers/proxy walkthrough and rollback
- [ ] Independent no-P0/P1 review, immutable RC and `main` closure

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
