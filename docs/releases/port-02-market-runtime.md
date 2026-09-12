# PORT-02 marketplace runtime component evidence

September 12, 2026. OpenCode Go `opencode-go/deepseek-v4.1-flash` implemented
and tested this slice; lead and independent review closed one integration issue.

Catalog, listing management and moderation have independent default-off flags.
Catalog requires no account service; listing management requires account and
tenant reads but not tenant writes; moderation requires account service but not
tenant reads. Enabled stores share one restricted pool with initialization,
bounded retained readiness work and cleanup on startup failure.

The app registers all 18 declared marketplace route tuples and a separate
credentialless marketplace capability endpoint. The existing five-family,
41-route capability endpoint is unchanged. Missing lifecycle dependencies now
fail startup for either protected marketplace family rather than omitting routes
while advertising availability. Narrow draft-test fixture updates retain all
existing assertions, including provider-admin/developer successful writes.

Final component checks passed: 91 focused tests, all 717 API unit tests,
application types, test types, lint and build. Review covers exact family/error
classification, independent dependencies, credential rejection, bounded retained
readiness probes and the eight explicitly ignored Railway edge metadata headers.
No new header is trusted as identity, origin, routing or authorization.

A preceding real PostgreSQL draft API run passed all 11 cases on integration
6db282e, including the corrected provider roles. The final combined runtime
and lifecycle/catalog PostgreSQL suite is a separate pending gate; that earlier
11-test run is not claimed as verification of this new runtime revision.
Reverse proxy, production-browser tests, hosted enablement and PORT-02 release
acceptance remain separate. No real funds, hosted database or extra spend.
