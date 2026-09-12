# PORT-01 — tenant management and notification worker

September 12, 2026. Component-accepted; combined source gate, production-image
write-browser acceptance and publication are pending.

The protected supplied-style console now has organization bootstrap, agent and
provider create/edit, and membership forms. Server roles and fresh-proof rules
remain authoritative. All changes require explicit confirmation. A confirmed
commit stays confirmed even if later refresh fails; an uncertain response stays
locked to checks of its original mutation ID and never enables a blind resend.
Default-off flags require account access and tenant reads; no payment authority
or live hosted enrollment is added.

DeepSeek V4.1 Flash on OpenCode authored implementation and tests. Review closed
zero-organization bootstrap, commit-versus-refresh classification and unknown
outcome resubmission. Final component tests:38 focused,268 total web units,
31 write-browser journeys,48 existing tenant-read browser cases and48 deployment
guards. Types, test types, lint and web build passed. Actual nginx syntax also
passed using the new allowlisted read/write configuration, including verified
upstream TLS and finite body limits. Browser fixtures are mocked and do not
prove production HTTP writes; that acceptance is separate.

The worker is a bounded, default-off PostgreSQL outbox consumer for six validated
tenant notification types only. It is not an economic action runner. Restricted
worker role, lease generation checks, at-most50 concurrent handlers, bounded
shutdown and safe unknown acknowledgement outcomes are retained. Review closed
shutdown-during-initialization and serial-batch starvation.28 worker units and8
real PostgreSQL worker tests, types, test types, lint and build passed. Tests
cover50 actual database notifications completing without starvation, crash/
lease recovery and role isolation. No credential or financial handlers are yet
included. Root CI wiring and the production worker image remain pending here.

No hosted service/database, real funds, wallet interaction or paid resource was
created. The whole commerce port remains incomplete.
