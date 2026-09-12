# PORT-02 marketplace verification

Accepted locally September 12, 2026. This record distinguishes source checks
from actual production-image
checks, publication, deployment and whole-product completion.

## Integrated scope

Immutable listing versions; independent origin-metadata moderation; publication,
pause and retirement; credentialless catalog and provider profiles; protected
provider editor/history; three independent default-off feature families; bounded
production proxy routes; and contract-only reference-provider artifacts.

Origin review is not a security endorsement or payment authority. Purchases,
budget enforcement, grants, execution and mainnet remain unavailable. Reference
artifacts are not a deployed service or working paid retrieval flow.

## Source and database evidence

The full source gate tested `6bf6e89ad23a6d1245b9df191957de79c0dba656` in the
pinned Node22 runner. Its resulting image is
`sha256:f9609aa36ff244b39bf3b4fcf04b6dc5e8592e3fdd8ad9951e11e5531c72ead5`.

- `pnpm release:gate`: passed, including release checks, production dependency
  audit, license policy, lint, type checks and builds.
- Unit tests: **1,992 passed** — shared611, database182, API713, web456, worker30.
- Development browser tests: **301 passed**, including 13 public marketplace
  and 27 protected listing cases. These use synthetic HTTP fixtures, not payment
  or production acceptance.
- Reference-provider contract tests: **19 passed**; contract-only evidence.
- Real PostgreSQL: **325 database + 82 API + 10 worker passed**. The final
  database/worker run tested the source above. The API run preceded it; later
  changes did not change its tested API/SQL inputs.
- Final deployment/CI guards: **134 passed** using the reviewed public workflow.
- Account-browser supplement: **27 passed** against isolated PostgreSQL,
  including genuine virtual-authenticator passkey registration and wallet-login
  fixtures. No personal wallet or real funds were used.

After the full source snapshot, `b9063f44a3ad19d02e804d54d96a4c8f0687ffd1`
changed only two nginx mixed-method parent body limits and their two regression
tests. A valid 1,098-byte draft POST previously hit the parent's 1KiB limit
before reaching the named 16KiB POST handler. The corrected parent admits it;
16,385-byte POSTs still return413 and GET bodies return400. No API, SQL or web
application code changed. The final 134 guards include this correction.
Subsequent changes are documentation and production-browser fixtures.

## Actual production-image boundary

All eight combinations of catalog/listing/moderation flags built successfully
and passed `nginx -t`; standalone deny-only mode passed separately. Real encoded
requests exercised all18 route tuples, wrong verbs, literal/invalid queries,
double encoding, credential/header rejection and lookalike paths. None fell
through to the SPA. Public responses suppress cookies and CORS.

The enabled fixture uses real schema7, restricted database roles, the built API,
nginx and verified upstream TLS in an isolated disposable network. Its API image
is `sha256:66f80a8f195f813b42b06d3f4546b501e2481c5ed5043b757cf719741e0e20d4`
from `b2f45820189e4630ef3b4eec6ac018c60e65f943`; corrected web image is
`sha256:082f2201e58d7ded9c44f78fde9cb36165468ce18766e30dd84b003ff3cd6f6a`
from `b9063f44a3ad19d02e804d54d96a4c8f0687ffd1`.

Final production-browser result: **7 enabled + 1 disabled passed**, with no
retries, HTTP success mocks or injected account cookies. Tests cover real
passkey registration; immutable version creation; independent moderator review
and provider self-review rejection; publish/pause/republish/retire and anonymous
catalog visibility; operator/viewer denial; stale proof/CAS and zero durability;
response loss after independently observed commit with status-only recovery;
synchronous pagehide/hidden draft erasure; mobile320px and keyboard use; all18
route families and exact transport rejections. Fixture lint and type checks pass.

The fixture distinguishes nginx-local missing-CSRF400 from API CSRF403, sends
public reads without account cookies, and deliberately verifies credentialed
public requests return403. Missing catalog entries use the accepted nullable
200 envelope, not an invented404. No API assertions were relaxed to pass these
different transport cases.

## Release boundaries

All implementation and test code was authored through OpenCode Go
`opencode-go/deepseek-v4.1-flash`. The lead planned, reviewed, integrated and
independently executed checks. Public exports contain source only, not private
Git ancestry, and must pass project-branded identity and secret screening.

Publication/CI/merge/deployment: pending for this phase. Hosted account enrollment
and marketplace flags remain off; no new hosted database, recurring vendor spend,
personal-wallet connection or mainnet activation is authorized by these results.
The whole commerce port remains incomplete; PORT03–09 are subsequent phases.
The accepted local PORT02 gate permits the next phase's scoped policy/session
foundations; it does not authorize payment execution or activation.
