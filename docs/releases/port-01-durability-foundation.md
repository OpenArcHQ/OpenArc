# PORT-01 durability and tenant read contracts

Status: schema4 and combined local release accepted; publication tracked separately.
See [combined verification](port-01-tenant-combined.md). Historical component
scope and counts below precede the read/write HTTP integration.
Prepared September 12, 2026 (UTC). This is not a completed commerce port.

## Implemented scope

Schema3 adds one concrete atomic operation: agent creation with durable hashed
idempotency, safe receipt/status recovery, a bound audit event and an outbox event.
The worker repository supports fenced claims, bounded retries and dead letters.
It does not run a background worker, dispatch payments or perform external calls.
Schema4 extends atomic durability to organization bootstrap, agent update,
provider create/update and membership set. Typed foreign keys and explicit
operation/resource/event constraints bind every receipt, audit and outbox row
to its actual organization/resource. Durable bootstrap uses a deterministic
organization ID from the logical mutation UUID. Membership changes preserve
last-owner protection and revoke affected sessions atomically. No HTTP write
route is exposed yet; old non-durable methods remain internal compatibility APIs.

Strict shared read contracts cover organization pages/context and agent/provider
pages. They enforce canonical identifiers, matching organization scope, ordered
bounded pages and exact v2 envelopes. The contracts alone do not authenticate
users, expose tenant HTTP routes or create a protected workspace.

## Component verification

DeepSeek V4.1 Flash through OpenCode authored implementation and tests. Astra
reviewed contracts, integration and material correctness/security findings.
All identified findings are closed, including direct durable write grants,
compound receipt bindings, lease expiry after lock waits, status expiry after its
final table read, nonblocking dead-letter maintenance, effective worker grants
and exact helper readiness. This is not an independent professional security audit.

- Shared: 370 tests passed (345 baseline plus 25 tenant-contract tests).
- Database unit: 99 passed (81 baseline plus 18 durability tests).
- Real PostgreSQL: 172 passed (128 baseline plus 44 durability tests).
- Relevant types, test types, lint and build passed.
- Frozen schema1/schema2 SQL, AuthStore and previous auth/tenant repository tests
  remain intact; exact migration-manifest expectations were advanced explicitly.

Tests include true concurrent lock barriers, whole-transaction rollback, real
COMMIT followed by a lost reply, same-key and logical-request replay conflicts,
role/tenant denial, no raw key/name in durable records, worker crash/reclaim,
stale lease rejection and restricted-role privilege drift. Disposable isolated
fixtures only: no user wallet, real funds, hosted database or paid resource.

Schema4 follow-up passed 108 database unit tests and 211 real PostgreSQL tests
(39 new tenant-mutation PostgreSQL cases), plus types/test types/lint/build.
Review closed own-organization resource binding and operation/resource mapping.
The actual schema3→4 upgrade preserves prior receipt/audit/outbox/agent rows and
their original replay behavior. Further coverage proves same-derived-ID concurrent
bootstrap conflicts without orphan rows, logical-ID replay conflicts, per-resource
audit/outbox rollback, restored membership sessions/challenges on rollback, and
self-demotion/self-suspension expiry during an observed outbox lock wait.
Migrator-only SELECT policies permit existing parent-row validation during the
upgrade; no tenant runtime grants are broadened. SQL0001–0003 remain unchanged.

## Integration and deployment boundary

Based on private tenant foundation `a242664569efcd9c4fa75e632feb577826b3a122`.
The corresponding public tenant release `be9d884745996f3d84287bef5b3243b9c63c2086`
passed [public CI](https://github.com/OpenArcHQ/OpenArc/actions/runs/34667057414)
and was merged via a fast-forward. These component changes are not part of that
CI result or current Railway deployment.

Existing Railway staging remains on supplied frontend/account release
`f9c37922a1cd911e2d1d80e1e5d2c693328140fd`, with account enrollment and writes
disabled. Source publication and hosted feature activation are separate states.
