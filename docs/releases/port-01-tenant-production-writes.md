# PORT-01 real production-image tenant writes

September 12, 2026. Accepted: **15 enabled + 1 writes-disabled browser tests**,
zero failed/skipped. DeepSeek V4.1 Flash on OpenCode authored the fixture and
its corrections; lead reviewed the source and managed the isolated stack.

The enabled web was built from exact source
`bf3a1c84a9f270210d789af9ba5debca74c59157`; its image manifest is
`sha256:782dbda71e9d8089bf353ecfc14f65152e82093f427f3d006ce43f04baf0213e`.
The API and writes-disabled web retained source
`c3597ad2d203fa5982c0d2dd09f9a1e93cd42515`, with the unchanged tenant HTTP
contract and schema4 database. This evidence is specifically the tenant-write
UI/API contract, not acceptance of the later schema5 machine API.

The fixture uses actual production nginx and Fastify images, verified HTTPS
upstream transport, restricted PostgreSQL roles and real browser passkey
registration with synthetic virtual authenticators. Only reserved loopback
fixture origins and disposable accounts are used; no browser cookies are
injected or serialized, and no OS trust/DNS changes are made. Test traces,
screenshots and video are disabled. The auth rate limits are raised only for
synthetic fixture capacity; this is not evidence of rate-limit enforcement.

Coverage includes organization bootstrap, agent/provider creation and edits,
owner/operator/viewer boundaries, last-owner protection, self-demotion and
session revocation, cross-organization rejection, stale proof, CSRF/input/
idempotency rejection, method/query/header restrictions, logout cleanup,
320px forms, scoped CSP, and preserved reads with writes disabled.

One case intentionally interrupts delivery of a successful response through
Chromium CDP. The fixture independently confirms the database commit BEFORE
injecting the fault. The UI then reports uncertainty and an explicit status
check recovers the same receipt. Exactly one idempotency, audit and outbox
record remain; no automatic second mutation is sent. This is a controlled
delivery fault, not a claim that the server failed to commit.

Two real UI defects found in the first run (hidden first-organization and
self-demotion receipts) were fixed before acceptance. Fixture corrections
retain exact DTO assertions and isolate independent account journeys in
separate browser contexts. Final lint, test-file typecheck and test listing
also passed. A combined release gate/publication is still pending; these
changes are not yet deployed to hosted staging and do not finish the port.
