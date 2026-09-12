# PORT-02 lifecycle database component evidence

September 12, 2026. OpenCode Go `opencode-go/deepseek-v4.1-flash` authored the
implementation and tests. Independent SQL review and lead integration review
closed the recorded findings.

Migration 0007 adds immutable origin-review records, separately provisioned
moderator authority, publication/pause/retirement with active-version CAS, public
catalog projections, and atomic audit/idempotency/outbox writes. It also restores
provider-admin/developer draft writes through a migrator-only provider UPDATE
policy; existing owner-only provider-console permissions remain unchanged.
Migrations 0001–0006 were checked byte-for-byte unchanged before integration.

Review verified replay after retirement, independent moderator status lookup,
strict public query handling, real two-connection publication conflict, expiry
after a blocked provider lock, outbox-failure rollback, and upgrade from schema6
preserving tenant/machine/draft data and receipt replay. Moderator grants start
empty; runtime roles cannot provision them or directly read/write review tables.

The main component gate passed 182 database unit tests, 321 database PostgreSQL
tests, 30 worker unit tests and 10 worker PostgreSQL tests, plus static checks.
The final readiness closure subsequently passed 29 focused unit tests and all
48 lifecycle PostgreSQL tests, plus types, test types, lint and build. It adds
healthy readiness controls and catalog-only schema7 tamper negatives. Catalog
readiness now composes the complete lifecycle/market posture without constructing
authentication services. The closure also corrects PostgreSQL UPDATE policy
command decoding and casts role names to driver-parsed text arrays.

The exact accepted provider policy expressions compare CURRENT_USER with
openarc_migrator; they are not unconditional true. Readiness checks their actual
deparsed expressions. No SQL was changed in the final readiness closure.

The 321-test full run predates that final readiness-only correction; the final
integrated release gate must rerun the complete database suite on this source.
Real API and production-browser acceptance, hosted enrollment and whole PORT-02
acceptance are separate. No payment execution, real wallet, new hosted service
or recurring spend was enabled.
