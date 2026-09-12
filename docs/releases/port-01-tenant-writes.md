# PORT-01 — durable tenant write HTTP surface

September 12, 2026. Component and combined local release accepted.
See [combined verification](port-01-tenant-combined.md). Browser write UI and
hosted activation remain separate; the counts below are component evidence.

The default-off tenant write API exposes organization bootstrap, agent/provider
creation and updates, membership changes, and two scoped mutation-status reads.
It uses the accepted schema-four durable repositories, one shared restricted
tenant pool, real account cookies/CSRF, strict request contracts and a single
canonical idempotency header. It does not provide payment or machine authority.

Every mutation returns only a validated receipt. Unknown commit outcomes are
not retried or described as rolled back; independent status reads recover the
answer. Intentional self-demotion returns the minimal committed receipt even
though the accepted SQL revokes that session. Status reads recheck the live
session after their awaited repository result and never mint a new cookie.

Exact OpenCode `opencode-go/deepseek-v4.1-flash` authored source and tests.
Read-only review closed duplicate-wire critical-header rejection and post-read
status-expiry coverage. Real TCP tests cover duplicate Content-Type discarded
by Node normalization; authorization never runs for rejected header forms.

Final component evidence: 364 API unit/HTTP tests (336 baseline + 28 new), 26
real PostgreSQL API tests (16 baseline + 10 new), types, test types, lint and
build all pass. Real PostgreSQL covers CSRF, role denial, replay, logical/key
conflicts, last-owner rollback, self-demotion/revocation, and a committed result
with a deliberately lost reply recovered through status. The lost-reply seam is
explicitly test-only, not claimed as a production network-fault experiment.

DB, shared contracts, original AuthService, migrations and earlier tests remain
unchanged in this packet. `TENANT_WRITES_ENABLED` requires tenant reads and auth;
disabled new paths fail closed. Browser write/proxy integration, full combined
gate, public publication and live tenant enrollment are not claimed here.
