# PORT-02 draft and immutable version persistence

September 12, 2026. Component acceptance; no catalog, publication, HTTP, UI,
payment or whole-port completion is claimed by this database slice.

Migration 0006 adds same-organization/provider listing roots, immutable version
content and separate mutable state. A draft's active pointer remains null even
when subsequent versions exist. Draft creation and next-version creation commit
their safe receipt, idempotency record, audit event and outbox event atomically.
No endpoint is fetched, reviewed, activated or paid by these operations.

Writes require an active owner/provider-admin/provider-developer membership,
same-organization active provider and a fresh non-recovery account proof. All
five active organization roles can read protected history. Authorization uses
database time and is rechecked after blocking work; caller-provided principals,
roles and clocks cannot establish authority. Unknown commit outcomes are not
silently retried. Protected response rows, timestamps, IDs and receipt bindings
are strictly validated and bounded before being returned.

## Evidence

Implementation and corrections: OpenCode CLI `opencode-go/deepseek-v4.1-flash`.
Lead reviewed the initial diff and concrete correction batches; independent
review checked raw SQL/schema parity. Frozen migrations 0001–0005 are byte-identical.

- Focused database unit tests: 27 passed; all database units: 153 passed.
- Focused marketplace PostgreSQL tests: 41 passed; full database PostgreSQL suite:
  277 passed in nine files.
- Worker units: 29 passed; worker PostgreSQL: 10 passed. Subsequent corrections
  did not change worker implementation; this evidence is retained, not rerun.
- Database types, strict test types, lint and build: exit 0.

Coverage includes exact JSON/uint256/URL/text/schema constraints through raw SQL;
active-pointer and ownership FKs; immutable content; restricted role/ACL/RLS,
helper-owner/search-path and migration-checksum failures; same-key races and CAS
races across real connections; receipt/status namespace and actor isolation;
post-resource audit/outbox failures with no orphan rows; expiry while a read,
listing-root write or late outbox insertion is actually blocked; and schema5→6
preservation/replay of existing tenant and agent/provider credential records.

The market-only operations are added to the existing durable SQL registry without
widening the legacy tenant/credential TypeScript status unions. Added worker
events are payload-free notifications, not payment or provider-dispatch jobs.

Combined API/frontend integration and the stable PORT-02 release gate remain
separate acceptance steps. Nothing in this slice enables a hosted database or
changes the existing live default-off account and payment settings.
