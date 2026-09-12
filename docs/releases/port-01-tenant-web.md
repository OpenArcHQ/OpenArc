# PORT-01 — protected tenant console and production acceptance

September 12, 2026. Component and isolated production-image acceptance passed;
combined local release also passed. See [combined verification](port-01-tenant-combined.md).
This is not whole-port or live-account readiness.

The supplied cobalt/gold visual system now frames a protected, read-only tenant
console at `/app/overview`, `/app/agents` and `/app/provider`. Organization
selection is explicit, data is permission-scoped, bounded pages replace rather
than accumulate, and Back to page 1 restores the first page. No mock dashboard
counts are shipped. Existing public design, account and encrypted Vault routes
remain separate. Hidden tabs, expired sessions and changed organizations clear
protected data; refresh is explicit and no browser persistence is added.

The four tenant GET routes have a separate default-off frontend/nginx gate.
Only canonical allowlisted paths reach the API, with verified upstream TLS,
explicit header forwarding, no authorization-header or body forwarding, finite
body limit, early body-header rejection, no upstream retry and no spooling.

Implementation and tests were authored through the configured OpenCode CLI using
`opencode-go/deepseek-v4.1-flash`; lead and independent read-only review closed
route isolation, refresh, role-matrix, mobile focus, nginx body/syntax and first
page controls. Actual nginx syntax and pre-upstream method/header/body/path
rejection checks passed in an isolated container.

Component evidence: 226 web units passed before the final four pagination tests;
the final focused tenant suite passes 32 tests, with types and lint passing.
All 29 deployment guards (16 unchanged account + 13 tenant) and all 48 mocked
Chromium/WebKit browser cases pass on the final component source. Mocked browser
tests prove the UI contract, not backend authorization.

The separate production fixture performs actual Chromium virtual-authenticator
passkey signup against production API/nginx and guarded disposable PostgreSQL.
It never injects login cookies, mocks tenant HTTP responses or resets a running
application database. Synthetic tenant rows are explicitly fixture-seeded, not
presented as proof of a tenant-management UI. Its static types/lint/test listing
pass. Runtime execution now passes all 19 enabled and one disabled Chromium
journeys against production API/web images built from application revision
`3f09d5f5ae2ff99401248ebd156395cee537f96a`, not a Vite development server.

The enabled fixture used real passkey registration, HttpOnly cookies, restricted
database roles, explicit organization selection, exact 50/50/1 pagination and
first-page restoration, role denials, actual session revocation and DB-clock
expiry, observed blocked-read expiry, scoped CSS/CSP, and storage/wallet access
instrumentation. The disabled image was checked in a separate isolated network
namespace; it required no database or upstream service. Nginx's bounded generic
error HTML was distinguished from a forbidden SPA fallback; tests require the
proper error status, no SPA bootstrap or assets, and no protected DTO fields.

Runtime test-harness corrections were authored through the same DeepSeek CLI
and reviewed: exact scoped selectors, explicit denied-role headings, and a
post-load expiry barrier inside the existing DB statement timeout. No retries,
login-cookie injection, HTTP mocking, skipped assertions or application changes
were introduced to make this production suite pass. All fixture data and TLS
material were synthetic; no OS trust store, real account or live wallet used.

No hosted database, real user enrollment, wallet, funds, mainnet operation or new
paid service is enabled by this component. Account and tenant flags remain off
on the existing temporary Railway domain until a suitable live environment is
verified. Later write UI, machine credentials and commerce phases remain open.
