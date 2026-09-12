# PORT-01 tenant foundation

Status: accepted locally, including the combined release and account/database gates.
Prepared September 12, 2026 (UTC). This is a backend foundation, not a completed
commerce port or an enabled staging account/tenant service.

## Scope and compatibility

Based on private source `8891b338d58309246c740ce989a23e5a58140e83`.
Adds numbered migration `0002_tenants`, organization membership and agent/provider
profiles, and a restricted `TenantStore`. The first auth migration, AuthStore and
its existing PostgreSQL tests remain byte-identical. The shared identity module
is now exported through the package root; consumers use its canonical validators.

The new migration requires a pre-provisioned `openarc_tenant_app` role. It creates
no roles or paid resources. Runtime roles cannot migrate. Applications validate
the complete bundled migration manifest and fail closed on drift, older or newer
schemas. Applying this migration requires a coordinated runtime deployment; an
older schema-one-only application is not claimed compatible with schema two.

No HTTP tenant routes, machine credentials, marketplace, budgets or payments are
enabled by this increment. Existing account-free and local encrypted workspace
behavior is preserved.

## Authority and review

- Forced row-level security and selected-organization context; owner-only member
  listing includes suspended members, while non-owners cannot enumerate others.
- Five narrow session/membership helpers with fixed search paths and restricted
  execution; no auth-row CRUD for the tenant runtime.
- Ordered account/session/organization/membership locks, last-owner protection,
  and atomic target-session/challenge revocation on actual membership changes.
- Bootstrap eligibility ends when the first membership is inserted, including
  within the organization-creation transaction.
- One checked-out transaction per repository operation. Session expiry is checked
  after blocking locks/writes; organization bootstrap also requires fresh proof.
- Strict inputs, terminal profile states, canonical DTO projections, bounded
  cursors, no automatic mutation retry, and explicit unknown-COMMIT outcomes.

DeepSeek V4.1 Flash through OpenCode authored implementation and tests. Astra
performed integration and bounded read-only review. All identified SQL and
repository findings were corrected and reviewed closed. This is agent-assisted
review, not an independent professional security audit.

## Component verification

Final isolated PostgreSQL 17 fixture and Node 22 worker results:

| Check | Result |
| --- | --- |
| Shared identity export regressions | 5 passed |
| Database unit tests | 81 passed |
| Real PostgreSQL tests | 128 passed |
| Tenant repository PostgreSQL subset | 22 passed, included above |
| Tenant SQL PostgreSQL subset | 41 passed, included above |
| Typecheck, test typecheck, lint, build | Passed |

The PostgreSQL regressions include cross-organization/role isolation, pooled
context cleanup, concurrent owner changes, terminal states, schema mismatch,
transitive elevated-role refusal, and deterministic lock-wait expiry. Synthetic
fixtures only: no user wallet, real funds, hosted database or production data.

## Previously published frontend/account release

The complete private source gate on `ab76bb325d76b5f0ec8481c838dda9d9362bde66`
passed 923 unit/integration tests (345 shared, 81 database, 299 API, 198 web),
152 development-browser tests, dependency audit, license checks, lint, typecheck
and build. The resulting image was then used for a separate sequential gate:
16 account deployment checks, 128 database PostgreSQL tests, 5 API/PostgreSQL
tests and 27 account-browser tests, all passed. The image manifest is
`sha256:e348a3174484abde010a7113b4b99bdb06b75d0eaecd2c31899193b83c3ac72b`.
Only this evidence document changed after that source gate. These are local
results; they do not claim a public CI result or hosted tenant deployment.

Public commit `f9c37922a1cd911e2d1d80e1e5d2c693328140fd` passed
[public source CI](https://github.com/OpenArcHQ/OpenArc/actions/runs/34665166139),
was fast-forward merged, and was deployed to the existing Railway staging web/API
services. This tenant increment is not part of that deployment.

Live checks confirmed matching web/API release IDs, healthy readiness, existing
Testnet observation capabilities, restored supplied video with pause/resume,
mobile navigation, three documentation tabs, FAQ expansion and preserved locked
workspace/legacy redirect. Account enrollment remains disabled; `/v2/auth/session`
returns 404. No new service, database or paid resource was created.
