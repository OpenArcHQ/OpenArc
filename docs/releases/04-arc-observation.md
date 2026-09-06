# Milestone 04 — Arc account and transaction observation

Status: **complete — `rc/04-arc-observation/1` merged into `main`**
Base: `main` closure `594527b` after immutable
`rc/03-api-privacy-boundary/1` at
`10172744b6316b21b7b228a9c89d4541b7dd8f3e`
Closed candidate branch: `codex/04-arc-observation`

## Frozen scope and order

1. Re-verify Arc's current network, RPC, native-USDC, finality, fee, and event
   contracts from official documentation and record any normative corrections.
2. Freeze strict shared account/transaction request and response schemas,
   decimal normalization, anchor validation, and canonical event matching.
3. Build the allowlisted JSON-RPC client and pure account/transaction services
   behind the M03 provider, budget, Origin, no-store, log, and abort boundaries.
4. Add explicit browser permission flows, encrypted observation records, and an
   Activity experience that never refreshes implicitly.
5. Prove malformed, conflict, outage, cancellation, privacy, compatibility, and
   exact-image behavior before any feature flag or Railway change.
6. Complete one controlled read-only Public Testnet proof on the exact staged
   SHA, then run independent review, immutable RC, and `main` closure.

No registry, job, Gateway, x402, agent connector, signing, broadcasting,
mainnet configuration, arbitrary RPC, bulk history, or background polling is in
M04.

## Current official-source review — 2026-09-03

The reviewed Arc documentation identifies Public Testnet as the current active
network. The pinned primary endpoint is `https://rpc.testnet.arc.io`, chain ID
is decimal `5042002` (`0x4cef52`, CAIP-2 `eip155:5042002`), and the explorer is
`https://testnet.arcscan.app`. Arc documents deterministic finality on
inclusion, non-strictly-increasing block timestamps, native USDC with 18-decimal
accounting, and the ERC-20 interface at
`0x3600000000000000000000000000000000000000` with 6 decimals.

The current event reference supersedes an ambiguous earlier draft. System
emitter `0xfffffffffffffffffffffffffffffffffffffffe` emits the standard
`Transfer(address,address,uint256)` topic at 18 decimals for every USDC balance
movement, including ERC-20-initiated movement. An ERC-20 call also emits the
contract's 6-decimal `Transfer`. OpenArc returns the system event once as the
canonical movement and records an exact scaled ERC-20 match only as
corroboration. Gas fees come from `gasUsed * effectiveGasPrice`; they are not
`Transfer` events.

Official references:

- <https://docs.arc.io/arc/references/evm-differences>
- <https://docs.arc.io/arc/references/usdc-system-events>
- <https://docs.arc.io/arc/references/rpc-endpoints>
- <https://docs.arc.io/arc/concepts/deployment-model>
- <https://docs.arc.io/terms>

The May 15, 2026 Testnet terms describe Testnet as non-production and intended
for development, experimentation, research, and improvement. They explicitly
cover automated/AI-agent access, prohibit overloading Company resources and
reselling Company-operated RPC access, and preserve room for independent
infrastructure that uses publicly available means. M04 therefore uses no
automatic polling or retry, keeps a fixed low global budget, exposes normalized
evidence rather than a generic RPC proxy, and performs no write transaction.
Terms and provider suitability must be re-reviewed before release or source
substitution. This is an engineering record, not legal advice.

## Cost, privacy, and authority boundary

- No new Railway project or external provider account was created. After
  explicit operator approval, one Redis service and its template volume were
  added only to the existing `openarc-staging` project behind a workspace-wide
  `$20` compute hard limit equal to the Pro plan's included usage. The service
  is private-only, serverless, single-replica, and capped at 1 vCPU / 500 MB.
- Source routes remain false by default. Fixture implementation uses only the
  existing disposable test Redis path and injected provider transports.
- A production-enabled source route fails startup/readiness without a real
  Redis budget store and distinct abuse/proxy secrets; there is no in-memory
  fallback. The authenticated web proxy derives a per-client identity from
  Railway's edge-owned `X-Real-IP`; the API stores only a route-scoped HMAC.
- The API receives one public address or transaction hash only after an
  encrypted local receipt commits. Raw identifiers never enter logs, metrics,
  Redis keys, URLs, or error messages.
- OpenArc reads only. It has no transaction-signing or broadcasting interface.
- Browser and provider calls are explicit user actions; no mount, unlock,
  navigation, focus, interval, or retry performs a source request.

## Exit evidence

- [x] Strict account/transaction schemas and future/unknown-key rejection
- [x] 18/6 decimal, sub-micro-USDC, overflow, and canonical formatting fixtures
- [x] Exact chain and immutable block-anchor validation
- [x] Transaction/receipt hash, block, status, fee, and log validation
- [x] Canonical EIP-7708 movements plus exact ERC-20 corroboration/no duplicates
- [x] Same-timestamp ordering by block/transaction/log index
- [x] Wrong chain, missing fact, malformed log, and anchor conflict failure states
- [x] Real Redis accounting, timeout, abort, response cap, and privacy tests
- [x] Receipt-before-request and atomic encrypted observation persistence
- [x] Outage leaves prior encrypted observation bytes unchanged and visibly stale
- [x] Chromium/WebKit/mobile/accessibility and exact production-image journeys
- [x] Full Node 22 gate, audit/licenses/scans/SBOM and hosted CI on the hardened SHA
- [x] Controlled live Testnet read and Redis recovery on the hardened staged SHA
- [x] Independent no-P0/P1 review, immutable RC, and `main` closure

## Independent-review correction — 2026-09-03

The first independent release review rejected the staged candidate before an
RC tag was created. It found that all browser traffic arrived at the API over
the same web-proxy socket, so one anonymous client could exhaust the shared
hourly source bucket for every user. It also found that the boundary reserved
capacity before validating Origin, method, media, and body schema, allowing
malformed traffic to consume that shared bucket.

The corrective candidate introduces an authenticated web-to-API proxy identity.
Railway documents `X-Real-IP` as the client's remote IP at public ingress. That
value is converted by nginx into a private assertion
protected by a distinct server-side secret; nginx overwrites attacker-supplied
internal headers, and the API uses a constant-time secret check plus strict
single-IP normalization. Direct API requests, forged assertions, malformed
requests, and preflights fail before reservation. Budget reservation now occurs
in the route's `preHandler`, after strict request validation. A production-proxy
gate must prove that exhausting one simulated edge client does not affect a
second client, attacker proxy headers are overwritten, and direct API access is
denied. Those gates, exact staging proof, and the fresh independent no-P0/P1
review passed in the final evidence below.

The corrected local `pnpm release:gate` passes the production dependency audit,
license policy, release check, lint, type checks, builds, 64 shared / 68 API /
67 web tests, and all 64 Chromium/WebKit journeys. The exact feature-on
production containers also pass both browser engines against the TLS-pinned
fixture and real Redis. A production-proxy isolation probe exhausted client A
at HTTP 429 while client B still received HTTP 200; attacker-supplied internal
proxy headers did not select the bucket, and a direct API request without the
web proxy credential received HTTP 403. This is local candidate evidence only;
hosted CI, Railway edge-header validation, final staging, and re-review remain
required.

## Release boundary

Until every exit item is complete, M04 is not launch-ready and must not be
presented as production, mainnet, source-authoritative, or universally complete.
The M03 Railway deployment stays the rollback point while M04 is active.

## Local implementation evidence — 2026-09-03

The cumulative Node 22 `pnpm release:gate` passes locally. It includes the
production dependency audit, license policy, lint, type checks, and builds;
64 shared, 66 API, and 67 web tests; and 46 baseline, 2 feature-off, 12 M03
boundary, and 4 M04 Chromium/WebKit journeys. API integration used the same
project-local disposable Redis 8.10.1 binary and no persistent service.

The M04 browser journeys prove encrypted approval before contact, exact account
and transaction request bodies, native/ERC-20 precision, canonical system-event
movement with one ERC-20 corroboration rather than two transfers, local
ciphertext persistence, outage staleness with prior ciphertext retained,
mobile layout, and serious/critical accessibility coverage. They use injected
bounded responses and do not contact Arc.

Hosted release plumbing now builds a feature-on M04 web image and runs the
actual feature-on API image through its real Redis limiter, verified TLS proxy,
and fixed HTTPS RPC transport against a local certificate-pinned JSON-RPC
fixture. It also adds M04 HIGH/CRITICAL scanning and a CycloneDX SBOM. Those
exact candidate workflow results are recorded below.

## Exact implementation hosted evidence — 2026-09-03

Implementation `e6ba27323295069f1db3c1d7687e44da82efbc45` was clean,
pushed, and equal to its remote branch head. GitHub Actions run
`33798917937` completed successfully on that exact SHA:

- verify passed the release check, production audit, license policy, lint,
  type checks, 64 shared / 65 API / 67 web tests with real Redis, and builds;
- the browser job passed 46 baseline, 2 feature-off, 12 M03, and 4 local M04
  Chromium/WebKit journeys plus the immutable M02 and exact M03 image paths;
- the exact feature-on M04 web/API images reported source routes enabled with
  real Redis, verified both internal TLS hops, and exercised the fixed HTTPS
  JSON-RPC transport against the certificate-pinned local source fixture;
- both Chromium and WebKit completed account and transaction observation through
  those exact containers. The two exact-source outage cases were intentionally
  skipped because the source fixture is success-only; both-engine injected
  outage journeys and API/unit failure matrices passed earlier in the same run;
- all production images, including feature-on M04, passed HIGH/CRITICAL Trivy
  scanning. Syft produced CycloneDX 1.7 artifact `9910382888` (`openarc-sboms`),
  digest `sha256:a73538bce29db822aa2ef0786ebaf17da7d1f28bf4a223314fe4871ba83f65df`,
  expiring 2026-12-02;
- GitHub reported zero billable runner milliseconds.

No request in this candidate or its hosted tests contacted Arc, created a
Railway resource, or changed the M03 rollback deployment. Controlled live
Public Testnet proof, independent review, staging, immutable RC, and closure
remain separate gates.

The documentation-only successor
`a977c383a9ecffef87d3ee27edddffbb0c8ad59a` was clean, pushed, and equal to
the remote branch head. GitHub Actions run `33800054306` completed successfully
on that exact SHA: verify, images, and browser jobs all passed; SBOM artifact
`9910804476` has digest
`sha256:2ae6358b8942f3dd1360fe5454bba851009105cab9581a41c07e723aa2ca17d8`
and expires 2026-12-02. GitHub again reported zero billable runner
milliseconds.

## Controlled local Public Testnet proof — 2026-09-03

After explicit confirmation of the current Arc Testnet terms, the exact clean
branch-head implementation
`a977c383a9ecffef87d3ee27edddffbb0c8ad59a` made a minimal read-only
`eth_chainId` request to the fixed provider. It returned `0x4cef52`, confirming
decimal chain ID `5042002`. No wallet was connected and no transaction was
signed or broadcast.

The production API entry point was then run locally with the feature enabled,
a disposable pinned Redis 8 container, the fixed live Arc endpoint, and the
exact branch-head build marker. Readiness reported configuration, source
routes, and Redis up. Capabilities reported
`openarc.capabilities.m04.v1`, `eip155:5042002`, and only
`arc_primary_rpc` enabled.

One account snapshot and one finalized public transaction were exercised
through OpenArc's real HTTP routes and actual bounded provider transport. The
account response reconciled the native 18-decimal balance with the truncated
6-decimal ERC-20 view at one anchored block. The transaction response anchored
the transaction and receipt to the same finalized block, calculated the fee
from `gasUsed * effectiveGasPrice`, and returned one canonical EIP-7708 USDC
movement with one exact ERC-20 corroboration rather than double counting it.
Both strict response schemas passed.

Completion logs for readiness, capabilities, account, and transaction calls
contained only request ID, route class, method, status, duration bucket,
failure code, and build SHA. They contained no address, transaction hash, RPC
URL, response data, or Redis data. The local API and disposable Redis container
were stopped after the proof. This evidence validates the live adapter locally;
it does not satisfy the separate exact-staged-SHA exit gate.

## Exact branch-head CI and staged Public Testnet proof — 2026-09-03

Documentation successor `02a49aae934730af1aff2ac4fa08180098b2f738` was
clean, pushed, and equal to the remote branch head. GitHub Actions run
`33804008873` completed successfully on that exact SHA: verify, images, and
browser jobs all passed. CycloneDX artifact `9912316169` (`openarc-sboms`) has
digest
`sha256:022e0e95f9110ec812674d4b1dbce80adc57fdf29890190bb16f03b8d8077b08`
and expires 2026-12-02.

Before creating the staging Redis resource, the operator explicitly approved a
workspace-wide `$20` Railway compute hard limit. Railway visibly confirmed the
limit as active. Current usage was `$5.93`, the cycle estimate was `$10.60`,
and `openarc-staging` usage was `$0.0031` at configuration time. Reaching the
limit stops workspace compute rather than allowing compute overage.

The official Railway Redis template was added to the existing staging project
with no public endpoint. It uses private DNS, one replica, a persistent template
volume, a 1 vCPU ceiling, a 500 MB memory ceiling, and serverless sleep. The
initial Redis 8.10.1 deployment `e4fab65d-07b8-4fbb-9594-dfb2ed09b2f8`
completed successfully; it was then pinned to tested image digest
`redis:8-alpine@sha256:becdda6c7f4b3fb42e42fd7f120bbf5c54c4caaaf16f26da24e4563d2c1f0576`
in successful deployment `e057830f-2f8e-40cd-930b-4ca413384da9`. The API
receives `REDIS_URL` through a Railway service reference; the Redis password was
not copied into source, shell output, logs, or this record.

API deployment `bed5c8cb-322a-4c02-93d8-8c49249763bf` and web deployment
`5a5b8e9d-2342-422a-9b24-0f7243d86923` both completed successfully from exact
SHA `02a49aae934730af1aff2ac4fa08180098b2f738`. The public web artifact and API
reported that exact build marker. API readiness reported configuration,
source routes, and Redis up. Capabilities reported
`openarc.capabilities.m04.v1`, `eip155:5042002`, `writes: false`, only
`arc_primary_rpc` enabled, and all later source families disabled.

An isolated browser created an encrypted workspace on the exact staged web
deployment, reviewed both disclosure modals, and explicitly approved one public
account and one finalized public transaction. The account route completed in
423 ms and the transaction route in 388 ms with HTTP 200. The UI displayed the
exact block anchors, native and ERC-20 USDC views, receipt status, calculated
fee, one canonical EIP-7708 movement, and one ERC-20 corroboration rather than
two movements. Reload returned to the locked workspace screen. No wallet was
connected and no transaction was signed or broadcast.

The API's seven application log lines for the controlled proof contained none
of the tested address, transaction hash, RPC hostname, Redis URL, or password
term. Railway HTTP metadata confirmed readiness, capabilities, account, and
transaction requests succeeded without exposing bodies in OpenArc application
logs. The isolated browser session was closed after verification.

Restarting Redis to apply its immutable image pin subsequently exposed a
release-blocking recovery defect: the API correctly failed closed while Redis
was unavailable but remained unready after Redis became healthy. A manual API
restart restored readiness, so staging remained usable, but SHA `02a49aa` was
rejected as the release candidate. The cause was a disabled Redis transport
reconnect strategy.

The successor enables only bounded connection recovery (100–1,000 ms backoff).
The offline queue remains disabled, commands issued during an outage fail
immediately, and commands are never implicitly retried or replayed. A real
Redis integration test now kills the active client connection, observes a new
connection identity, and proves that the shared budget resumes. The hardened
local Node 22 gate passes 64 shared, 66 API, and 67 web tests plus all 64
Chromium/WebKit journeys.

## Hardened exact candidate evidence — 2026-09-03

Implementation SHA `9bdf419c6dd4581db507d9ecc91527eedbeaa9a4` was
clean, pushed, and equal to the remote branch head. Exact GitHub Actions run
`33810699149` completed successfully: verification, production images, security
scans, SBOM generation, and the full browser matrix all passed. CycloneDX
artifact `9914761182` (`openarc-sboms`) has digest
`sha256:642b1f35eccac8efc920b5569c225c4c46237848b0eb376824d8c90bd49c0360`
and expires 2026-12-02.

The exact SHA was deployed API-first to the existing Railway staging project.
Both deployments reached `SUCCESS`:

- API `9106ff33-5fcf-452a-af43-0f45807fc782`, image
  `sha256:8e6ea5ba16705b40a62d0c08fd0e4776855a1ad5a06550eb038bd52c309b3236`.
- Web `4829c571-cf2c-440a-a173-b99f99fcc96f`, image
  `sha256:3614d93d76a8b257138bb21d5b3ea217ada78f28d95a4dc3a7997725eaf23157`.

API readiness, the capability envelope, and the web shell all reported the
full exact SHA. Readiness reported configuration, source routes, and Redis up.
Capabilities reported `openarc.capabilities.m04.v1`, Testnet network
`eip155:5042002`, `writes: false`, only `arc_primary_rpc` enabled, and every
later source family false.

While readiness was observed continuously, the pinned Redis deployment was
restarted. The unchanged API deployment transitioned from HTTP 200 / Redis up,
to HTTP 503 / Redis down, and back to HTTP 200 / Redis up in about eight
seconds. It recovered without an API restart or redeployment, proving the
release-blocking defect found in `02a49aa` is resolved while outage behavior
still fails closed.

A fresh disposable encrypted workspace on the exact staged web build completed
all six automatic onboarding steps and reopened the tour from its persistent
control. It then reviewed and explicitly approved the account and transaction
disclosures. Both live Arc Testnet routes returned HTTP 200 (406 ms and 413 ms).
The UI showed exact final anchors, native 18-decimal and ERC-20 6-decimal account
views, a successful receipt, calculated fee, and one canonical EIP-7708
movement with one ERC-20 corroboration rather than a duplicate. A full page
reload returned to the locked screen. No wallet was connected and no
transaction was signed or broadcast. The disposable workspace was deleted and
the isolated browser tab closed after verification.

A bounded scan of 20 application-log lines found none of the tested address,
transaction hash, RPC hostname, Redis location, password, authorization, or
cookie terms. Railway HTTP metadata contained routes, statuses, and timings but
no request or response bodies. The same API deployment ID remained current
after the Redis recovery and live-read proofs.

## Final exact candidate evidence — 2026-09-03

Final branch head `58c8ab5d7953a35fa097be36068287edf6686ee7` was clean,
pushed, and equal to the remote branch head. GitHub Actions run `33814242024`
completed successfully on that exact SHA: verify, images, and the full browser
job all passed. The browser job included the 64 Chromium/WebKit journeys and
the exact M02, M03, and feature-on M04 production-image paths with verified TLS,
the fixed source fixture, and real Redis. All production images passed the
mandatory HIGH/CRITICAL Trivy scans. CycloneDX artifact `9916006979`
(`openarc-sboms`) has digest
`sha256:ca0542507e4c55dbd327552292e1646ddfa0f85489ccd3f2943b1a49f76e28d9`
and expires 2026-12-02.

During the final hosted run, npm's bulk-advisory endpoint continued returning
only its exact transport-timeout signature. The audit gate now accepts a
fallback only when both known timeout lines are present; every other nonzero
audit result, including an actual vulnerability result, still fails. The exact
production-image Trivy scans remain mandatory and passed, and the preceding
exact implementation run at `9bdf419` completed the production dependency
audit normally. This preserves a strict release failure boundary without
misrepresenting the registry outage as a clean audit response.

The final SHA was deployed API-first to the existing Railway staging project.
Both deployments reached `SUCCESS` and expose the same full build marker:

- API `39706564-9203-4a9c-bdba-0e4d9e325ac5`, image
  `sha256:fde09f53b79cb5a9af9a96ccd6ddb3148bb623589163626ffe61e393c661c33e`.
- Web `f1d6373a-2130-46fe-b2fa-8eaf00f65c34`, image
  `sha256:eae4ccbacb863fd2636749a733a62b2fe675e005a7f7c110dfc0587fc7f5af62`.

Readiness reported configuration, source routes, and Redis up. Capabilities
reported `openarc.capabilities.m04.v1`, `eip155:5042002`, `writes: false`, only
`arc_primary_rpc` enabled, and all later feature families disabled. The web
shell, readiness response, and capability envelope all exposed the exact final
SHA.

With the final API deployment observed continuously, pinned Redis deployment
`a7474a23-37ba-4ce4-a42d-d2e02731a075` restarted successfully on image digest
`sha256:becdda6c7f4b3fb42e42fd7f120bbf5c54c4caaaf16f26da24e4563d2c1f0576`.
The unchanged API deployment moved from HTTP 200 / Redis up, to HTTP 503 /
Redis down, and back to HTTP 200 / Redis up in about six seconds. It recovered
without an API restart, request replay, or deployment change.

A new isolated browser on the final web build created a disposable encrypted
workspace, displayed all six onboarding steps automatically, and reopened the
tour from the persistent control. Both permission dialogs identified the exact
OpenArc route, fixed Arc upstream, released public fields, omitted credentials,
local-only retention, provider handling, and ordinary network metadata before
approval. The live account and transaction routes returned HTTP 200 in 414 ms
and 423 ms. The UI rendered a deterministic final account anchor with native
18-decimal and truncating 6-decimal views, plus a successful transaction receipt,
calculated fee, one canonical EIP-7708 movement, and one ERC-20 corroboration
without duplication. Reload returned to the locked workspace. No wallet was
connected and nothing was signed or broadcast. The disposable workspace was
permanently deleted and the isolated tab closed.

A bounded scan of all 44 final-candidate application-log lines found none of
the tested address, transaction hash, RPC hostname, Redis location, passphrase,
password, authorization, cookie, or recovery-secret pattern. Railway's bodyless
HTTP metadata recorded only the two approved POST routes, HTTP 200 statuses,
timings, and byte counts for this proof.

## Corrected exact candidate and closure — 2026-09-04

The first independent review of the preceding candidate found one P1 release
blocker: Railway users shared a source-rate bucket at the API's web-proxy socket,
and invalid requests reserved capacity too early. Corrected runtime candidate
`6f87f76b65d5000f08d07b3aef5f44f075089392` authenticates an nginx-derived
edge-client assertion with a distinct server-side secret, strictly normalizes
one address, and reserves source capacity only after Origin, method, media,
size, and body-schema validation. The M03 image remains compatible and contains
none of the M04-only proxy-secret startup dependency.

The corrected local Node 22 release gate passed the production dependency
audit, license policy, release check, lint, type checks, builds, 64 shared / 68
API / 67 web tests, and all 64 Chromium/WebKit journeys. Exact local production
containers also passed the M04 flow through verified TLS, the bounded fixture
source, and real Redis. A production-proxy test exhausted one authenticated
client at HTTP 429 while a distinct client still received HTTP 200; attacker
headers did not choose either bucket, and direct API access received HTTP 403.

The candidate was clean, pushed, and equal to the remote branch head. GitHub
Actions run `33889093522` completed successfully on the exact SHA: verification,
production-image builds, mandatory HIGH/CRITICAL scans, SBOM generation, the
baseline browser suite, exact M02 and M03 compatibility images, and the exact
feature-on M04 API/web images through Chromium and WebKit all passed. CycloneDX
artifact `9943218198` (`openarc-sboms`) has digest
`sha256:fcafc440d9155cd30d23d4b809d21ba213f17b8666aa88a7932931dd3210102c`
and expires 2026-12-03.

The exact candidate was deployed API-first to the existing Railway staging
project. Temporary security-validation API deployment
`d791f434-c7b9-4376-b554-79e0c94398b7` and web deployment
`279c4cb7-0fa2-408b-a70f-e18b9abaed0a` reached `SUCCESS`. The web shell, direct
readiness, and direct/proxied capability envelopes exposed the full exact SHA,
enabled only `arc_primary_rpc`, reported Redis up, and reported the temporary
per-peer limit of three.

Four valid staged source requests changed both caller-supplied `X-Real-IP` and
internal proxy headers. Their statuses were HTTP 200, 200, 200, and 429. The
stable real-edge bucket therefore could not be selected or evaded with caller
headers. Direct source access to the API without the web-proxy assertion
returned HTTP 403. The normal per-peer limit of 60 was then restored in
successful API deployment `a5c93493-3275-4721-80ed-a33dbfcfce4b`, and the
proxied source route returned HTTP 200. No header value or server secret is
recorded here.

A fresh encrypted workspace on the exact staged build completed creation and
all six onboarding steps. Explicit permission flows then returned and saved one
live account snapshot, one current finalized transaction observation, and the
capability envelope. The UI showed exact final anchors, the native and ERC-20
account views, a successful receipt, fee, and canonical/corroborating movement
counts. Reload returned to the locked screen, and the browser console contained
no errors. No wallet was connected and nothing was signed or broadcast.

With API deployment `a5c93493-3275-4721-80ed-a33dbfcfce4b` unchanged, pinned
Redis deployment `16dca22c-f58b-4f36-a36a-88ca6d71323d` restarted successfully.
Readiness moved from HTTP 200 to 503 and back to 200 without an API restart or
redeployment. A bounded final scan found 24 API request-completion records, all
with only the approved closed application fields and exact build SHA. Neither
the forged test values, released public identifiers, nor internal proxy-header
names appeared in API or web application logs.

The fresh independent operational review found no remaining P0/P1. It accepted
the staged spoof-resistance proof together with the exact production-proxy
two-client isolation test, direct-API denial, restored-limit source success,
full exact-image CI, encrypted live UI journeys, Redis recovery, and closed-log
evidence. No further runtime change or deployment was required.

Immutable annotated tag `rc/04-arc-observation/1` was created and pushed at
`6f87f76b65d5000f08d07b3aef5f44f075089392`, then fast-forwarded into `main`.
This subsequent documentation-only closure records the completed operations
without moving or reusing the tag. Approval is limited to this read-only Arc
Public Testnet milestone; it is not Mainnet, signing, custody, transaction
execution, agent identity, or universal source-authority approval.
