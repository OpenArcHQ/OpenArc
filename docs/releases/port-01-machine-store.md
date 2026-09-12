# PORT-01 — durable machine credential foundation

September 12, 2026. Component accepted; HTTP exchange, credential management UI,
combined release gate and deployment are not yet accepted.

DeepSeek V4.1 Flash on OpenCode authored schema5 and its repository/tests. Agent
and provider credentials have separate namespaces, typed ownership and fixed
Testnet self-read scopes. Only versioned password hashes are stored; no raw
credentials, peppers or session tokens enter the database. Current human proof,
membership/profile state and database-clock expiry are checked transactionally.
Issuance/revocation commit with safe idempotency receipts, audit and outbox events;
replay never replaces key material. Session expiry is bounded to15minutes and
credential expiry, and revocation invalidates current sessions.

Review closed table-level session lifetime bounds, consistent lock ordering,
database-clock status, explicit current credential expiry and actual role
context. Existing SQL0001–0004 and legacy tenant receipt unions remain unchanged.
Schema5 adds four notification-only worker events; they do not execute payments,
contact providers or imply business reconciliation.

Final component checks passed:126 database units,236 real PostgreSQL tests
(25 focused credential cases),28 worker units and9 real PostgreSQL worker tests,
types, test types, lint and builds. The fixture includes two-process lock barriers,
rollback, replay, cross-kind ownership, restricted-role access and expiry/revocation.
An earlier run exhausted the disposable database's512MB temporary filesystem;
the failed runtime was replaced with an isolated2GB fixture and bounded WAL.
The final PostgreSQL passes were obtained after that repair, not inferred from
the failed run. No application requirement or assertion was relaxed.

No hosted database/service, real wallet, funds or paid provider was used. This
foundation is not a finished credential API or a whole-port completion claim.
