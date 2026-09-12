# PORT02 reference contract and real API/PostgreSQL acceptance

September 12, 2026. Source integration base b364615, including database schema7
6db282e and runtime closure96d93cd. Implementation: exact OpenCode CLI model
opencode-go/deepseek-v4.1-flash; independent lead/read-only review.

The first-party reference sum contract is testnet-only and contract-only: strict
input/output/receipt JSON Schemas, byte-pinned digests, synthetic unreviewed
listing fixture and declared future direct-retrieval semantics. No service,
endpoint ownership, execution, purchase, charging or recovery is claimed.
Review closed receipt field/schema parity and absolute regex end assertions.
Final focused contract check: 19 passed; shared build and lint exit0.

Real API/PostgreSQL packet adds 18 focused cases; all 82 API/PostgreSQL tests
across six files pass, test typecheck and lint exit0. Uses real restricted
pools, stores, RLS, lifecycle functions, CAS, idempotency, audit and outbox;
proof adapter is explicitly synthetic. HTTP injection is not TLS/browser proof.
Lifecycle coverage includes independent moderation, publication/public projection,
pause/retire, rejection/reapproval, replay and changed-key/body denial, staleCAS,
grant revocation/self-review denial, isolated runtime flags, catalog without auth,
healthy readiness and fail-closed schema posture. Existing 11 draft API tests
also pass, including administrator/developer writes.

Fixed accepted mappings: unapproved publish is400 INVALID_REQUEST; missing
CSRF403; staleCAS409 POLICY_DENIED. Anonymous moderation WITH browser marker
is401. Do not claim this new PG suite separately tested the absent-marker403
ordering; that transport behavior has separate unit coverage.

No production-browser, public CI, push, deployment or whole-port acceptance is
claimed by these component results. Those gates follow on the combined candidate.
