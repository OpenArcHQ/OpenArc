# PORT-01 machine credential and session API

September 12, 2026. Component-accepted, not hosted or whole-port completion.
DeepSeek V4.1 Flash on OpenCode implemented the18 source/test files. Lead and
bounded security/database reviews closed the reported findings.

Human cookie/CSRF routes list, issue, revoke and check durable credential
mutations. A raw credential is returned only after its first confirmed commit;
replays and status expose safe metadata only. Lost results never automatically
create another credential. Agent owner/operator and provider-owner authorization,
fresh issuance proof and recovery revocation remain server-enforced.

Separate machine-only Bearer routes exchange a long-lived credential for a
short-lived self-read session, read its current metadata, and revoke it. Agent
and provider namespaces are distinct. Every current read consults durable
authorization; neither a sign-in nor a machine session grants payment authority.
Browser headers and cookies are rejected on machine session endpoints.

The runtime owns a restricted schema5 pool, initializes rather than migrates,
and fails readiness closed. Existing bounded scrypt and versioned peppers are
reused. Temporary key copies are cleared. Durable hashed rate buckets separate
exchange from self/revoke traffic. All machine flags default off; no provider,
payment, wallet signing or hosted database was enabled.

Final focused60 and total473 API unit tests passed, along with source/test
typechecks, lint and build. The real PostgreSQL suite passed53 tests, including
27 machine cases. Real scrypt and repositories are used; human proof fixtures
in the API tests are explicitly mocked, so browser proof is separate evidence.

Post-KDF races independently observe blocked session-creation SQL through a
separate database connection, then commit revocation/suspension before releasing
the lock. Both namespaces deny the invalidated request with401 and no session.
Existing sessions are denied after credential expiry/revocation, issuer
suspension or profile suspension. Two distinct AuthStore/pool instances prove
durable limiter sharing. Unknown session COMMIT returns a non-retryable503
without a second creation or token disclosure.

The final configuration/projection-only correction tightened canonical version
and secret parsing, rotation-key separation and sub-millisecond expiry binding.
Focused/static and all473 API units were rerun; the53 PostgreSQL results are
retained for the unchanged database orchestration. The combined final candidate
will also run the database gate. Actual production-image machine UI/API
acceptance, capability runtime integration, final release gate and publication
remain pending.
