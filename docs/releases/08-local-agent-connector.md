# M08 — local agent import and policy comparison

Status: **complete on staging; exact candidate verified for immutable RC and main closure**.
Branch: `codex/08-local-agent-connector`, from M07-complete main `2788de0`.

## Frozen scope

Local JSON import is the only connector. No localhost bridge, webhook, MCP,
public ingest route, provider, account, credential, signing, or execution is added.
The false-by-default web flag is `VITE_GENERIC_AGENT_IMPORT_ENABLED`; encrypted
workspace support is required. There is no corresponding server flag or route.
Mainnet remains unsupported. Existing M01 synthetic evidence and policy contracts
are unchanged; imported reports must never masquerade as synthetic fixtures.

### Reports and persistence

- Dedicated versioned strict report schema: import UUID, UTC capture time,
  connector ID (80 characters maximum), authentication `not_verified`, and 1–64
  payment-attempt events. Input is at most 256 KiB of UTF-8 JSON.
- Each event has a UUID, bounded external action ID, occurrence time, fixed Arc
  Testnet/6-decimal ERC-20 USDC, payer, recipient, integer base-unit amount,
  reported status, optional contract and service digest, optional authorization
  nonce/domain digest, and reported approval state. No URLs, raw signatures,
  keys, prompts, response bodies, or imported conclusions.
- The owner explicitly associates an import with a local agent profile. This is
  a local claim, not authenticated agent identity. Preview precedes an atomic
  encrypted save. No imported field is transmitted, including for remote metadata.
- At most 32 stored imports and 512 imported events across the workspace. Existing
  global vault/backup limits remain unchanged. Overflow is rejected, never silently
  truncated. Import identity and source-event identity are checked separately.
- Same connector/event ID and identical normalized event content is a duplicate;
  changed content is a visible conflict. Duplicate reports are not counted twice.
  Reusing a non-null authorization nonce and domain digest across distinct actions
  under the same network/asset/payer is a possible replay conflict, never proof of
  an executed replay. Missing nonce/domain cannot establish uniqueness.
- External action identity is the connector/action-ID pair. Equivalent timestamp
  spellings (trailing fractional zeroes) compare as the same instant for duplicate
  detection without changing stored reports; a real nanosecond difference does not.
- Report signatures are not verified in this milestone. Signed formats are
  explicitly rejected as unsupported rather than accepted as authenticated.
  Optional future signature verification requires a domain-separated format and
  proves only report authorship, not wallet authority or enforcement.

### Local monitoring policies

Dedicated policy v2 records have an immutable policy ID, incrementing revision,
local agent-profile scope, name, enabled state, validity window, optional per-action
and daily base-unit limits, recipient/contract/service allow/block lists (16 each),
and a reported-human-approval requirement. At most 100 such policies are stored.
Mode is always `local_monitoring_only`.

Daily means the **UTC calendar day of the selected event**, not a rolling 24 hours.
The sum is distinct supplied payment-attempt amounts across all reported statuses,
not actual wallet spend or confirmed settlement. Different attempt IDs under the
same action remain distinct attempts. Identical source-event duplicates count once.
All relevant stored imports are included, within the 512-event cap; there is no
background history discovery. Imported history cannot prove completeness, so an
under-limit daily total remains unevaluable. An already excessive supplied total
is flagged. Conflicting observations are not silently resolved into a passing total.

Block lists take precedence over allow lists. Missing facts needed by a configured
rule are unevaluable. A reported approval is not independently verified; reported
denial is flagged, absence is unevaluable. Policy validity is compared with the
selected event's reported occurrence time, so reopening a historical comparison
does not change its verdict merely because today's date changed. Expired or
not-yet-active policies at that reported attempt time are flagged;
disabled or differently scoped policies are not applicable. Monetary arithmetic uses
BigInt and exact pinned asset units, never floating point.

Every evaluation names its rule version, policy ID/revision, input import/event
citations (including each event's ordinal within its import) and evaluation
timestamp. Conflicting same-ID variants remain separately selectable and cited.
Violations and gaps remain independently visible.
Aggregate precedence is `conflicting`, `flagged`, `unevaluable`,
`within_supplied_rules`, then `not_applicable`. The UI says **LOCAL MONITORING ONLY**
and enforcement remains `not_verified`; it never calls an action wallet-permitted.
Results are recomputed from local source records, not trusted imported caches.

## Compatibility and rollback

New additive record kinds require an M08-capable reader. Older readers must reject
unknown records without deletion and retain opaque rescue. Preserve the M08 reader
after any new records are written; disabling the feature hides controls but does
not remove data. Existing lock/replacement invalidation, encrypted backup/recovery,
capacity limits, and atomic integrity validation still apply.

## Required evidence

- [x] Shared schema/parser/evaluator boundaries and all failure states.
- [x] Atomic encrypted import, profile links, policy revisions and integrity tests.
- [x] Accessible preview/import/policy/comparison UI with zero outbound requests.
- [x] Unsigned, unsupported signed, expired, duplicate, replay, oversized,
  future-version and conflicting browser fixtures.
- [x] Lock/replacement cancellation, backup/recovery and incompatible-reader proof.
- [x] Independent review without unresolved P0/P1 findings.
- [x] Full Node 22 gate, exact-SHA CI, production scans/SBOM and staging journey.
- [x] Immutable RC and main closure before M09 begins (closure identifiers below).

M08's live proof is a local-only staging browser import/comparison/backup journey
using synthetic agent reports clearly labeled as such. A new onchain transaction
is not applicable: this milestone adds no source call or transaction path. M07's
separately documented authentic Testnet payment proof remains unchanged.

## Development verification

Independent review covered shared parsing/evaluation, vault integrity/lifecycle,
UI/privacy claims, and CI/older-reader boundaries without unresolved P0/P1 findings.
The final targeted suites passed 43 shared import/evaluation cases, nine new vault
cases, and the retained vault regressions. Root lint and type checks passed.

The uninterrupted M08 browser suite passed all 14 Chromium/WebKit journeys,
including normal-UI backup export, credential recovery, independent-context backup
restore, encrypted-storage canaries, zero fetch/XHR requests, mobile overflow checks,
and no serious/critical axe findings. Native-label test locators were corrected to
match actual accessible names; no product assertion was removed.

Testing also exposed and fixed a real own-creation polling race: the empty-screen
revision poll could observe this tab's committed vault before the completion
callback delivered its recovery secret, misclassifying it as peer creation. Empty
pending operations now fence polling before/after the await, and stale generation
or workspace-reference callbacks are discarded. Existing-session cross-tab polling
remains active. A deterministic browser regression delays only the initialization
transaction's completion notification after its real commit with BroadcastChannel
disabled; both browsers retain the recovery workflow. Overview counts now include
report monitoring policies and distinguish report records from individual events.

Earlier clean-room runs were superseded or failed and are not passing release
evidence. Unbounded worker discovery launched nine browsers in a 7.75 GiB Docker
VM; the baseline runner now uses two workers. ARM Linux WebKit still exhausted
the aggregate budget of several long scenarios. Verification therefore includes
the full native macOS Node 22 gate and independently built Linux CI images;
those earlier ARM Docker runs are not described as passing. The corrected final
ARM Docker run subsequently passed, as recorded below.

The clean-room gate also exposed an inherited Redis deadline gap: the client
library stops listening for cancellation after writing a command, so a stalled
reply could keep a request waiting beyond its deadline. The budget boundary now
owns its deadline race, consumes late replies/rejections, and never retries or
refunds a potentially executed reservation. The Redis fault fixture holds its
pause until rejection and drains the connection before inspecting counters;
deterministic pending-reply and caller-cancellation cases cover the same boundary.
The failed run is not release evidence; all gates must pass on the corrected SHA.

Saved WebKit traces isolated two inherited fixture issues: a crypto fault hook
could intercept the startup capability probe before its intended create operation,
and the combined backup/restore/recovery journey completed its successful steps
but exhausted a 30-second aggregate budget near the final unlock. The hook now
waits for the initial access form. Only the combined journey has a 60-second
total budget, with individual actions explicitly capped at 30 seconds and all
semantic assertions retained. Targeted runs completed in 3.1 and 33.3 seconds.

Cross-tab tests now acknowledge initial creation and the later tour-save revision
separately before entering credentials. Traces showed a pending change notification
correctly clearing drafts entered before that boundary. They also exposed an
actual stale-form usability issue: the BroadcastChannel handler could re-expose
unlock using old metadata, then polling would clear the draft a second time.
Changed/lock hints now immediately clear private state into a noninteractive
locking phase, read authoritative metadata, and only then expose the fresh access
form. Generation guards discard stale completions; missing, deleted, replaced,
and unreadable vault states remain fail-closed. No new write or network request
is introduced by this readback.

The deterministic regression covers a `changed` notification sent after a save.
An inherited lock-timing limitation remains for M10 hardening: the immediate lock
hint can precede its durable coordination write, so this readback alone does not
promise that every lock-related revision race is eliminated. Immediate private
state invalidation and conservative re-locking are preserved.

## Final candidate and hosted verification

Staging-tested candidate: `8ddef64fc982ad3542369eea0f2abb33e110524e`.
Its pinned Node 22 / Redis 8 clean-room `pnpm release:gate` passed all 466
unit/integration tests (167 shared, 185 API, 114 web) and 100 development-browser
checks, without retries, plus release checks, audit, licenses, lint, types and
builds. The gate image manifest is
`sha256:85b0e3a72e63090356507d879cd9544984f24b6b8c865fbdbd56e65beaf0de46`
(manifest list
`sha256:3e612227a93e9c89208119088017cac6485e36ebce70442bf722c9af87515ecd`).
The preceding application-equivalent `276849b` also passed the full native macOS
Node 22 gate and the isolated Linux gate. The final revision changes only the
inactivity-test setup synchronization and retention of synthetic CI diagnostics.

An earlier CI run passed only after retrying an inactivity test. The test had
advanced virtual time before acknowledging encrypted tour-preference persistence;
the late save can reset the deadline. The original ordering is inferred from code,
not claimed as trace-proven: that green-on-retry run did not retain diagnostics.
The corrected setup awaits the existing saved notice, retaining the exact deadline
assertions. Six targeted runs (three per browser, retries disabled) passed. CI now
retains synthetic browser diagnostics for three days even when a retry makes the
overall job green. Earlier retried runs do not establish a first-pass final gate.

Exact candidate CI: 34004971041 (pre-publication CI; private link omitted).
Its verify job passed the 466 tests and code/dependency checks. All nine blocking
HIGH/CRITICAL production-image scans passed and generated nine CycloneDX SBOMs.
SBOM artifact `9980707121`, 870960 bytes, digest
`sha256:36efe23f1433ddda4fc4e226012f4ce2e3872c4e071f4440889b27f85c5010a6`,
expires `2026-12-05T01:51:36Z`. All 100 development and 36 production browser
cases passed first attempt (16 fixture-only production cases intentionally skipped).
The compatibility seed passed, but the job failed before the old-reader phase:
immediate reuse of a stopped auto-removed container name raced Docker cleanup.
Distinct names for the seed, old-reader and restored-reader containers remove
that name collision. A fresh complete CI run is required before RC closure;
the failed run is not presented as a completed compatibility gate. Its retained
synthetic diagnostic artifact is `9980839212`.

### Existing Railway staging

Only the existing staging API and web were deployed. Redis, production, the plan,
and service count were unchanged. The additional web flag enables the local-only
agent-report interface; no provider or paid path was added.

- API deployment: successful (internal deployment reference omitted);
  image `sha256:a3d8e00fd568dc045531276742e1c9c4849b2dde14265abd1197d556d9394aeb`.
- Web deployment: `42256012-d6e9-4077-a5bd-ecf69fc3ecf0`, successful;
  image `sha256:2310fc2431b748bf64442e372602c1f95a26194d307fd8da4b178c541ac3a9c0`.
- Web HTML and API readiness expose the exact candidate SHA. Both returned HTTP
  200 with normal TLS validation; configuration, source routes and Redis are ready.
- All 14 production-mode M08 journeys passed against the actual staging origin in
  Chromium and WebKit, with zero retries (33.5 seconds). This includes normal-UI
  backup/recovery/restore, strict invalid imports, policy boundaries, duplicates,
  conflicts, same-ID variants and the own-initialization race regression.
- Live tests used fresh isolated browser contexts and synthetic reports. They
  asserted zero fetch/XHR/WebSocket source calls; no user vault, wallet, key,
  payment, TLS bypass or synthetic proxy-identity header was used.
- The retained M07 staging smoke also passed on this candidate: two explicitly
  approved read-only lookups of the previously generated Testnet evidence,
  Gateway status `completed`, complete metadata `consistent`, the expected three
  incomplete-evidence gaps, and successful batch inclusion at block `60654320`.
  Encrypted persistence survived, automatic refresh remained false, and individual
  settlement remained unverified. No new payment, deposit or signing occurred.
- Eight supplemental live Chromium/WebKit checks also passed, with valid TLS and
  no retries (29.3 seconds): cross-tab coordination, held post-save metadata
  readback, revision polling without BroadcastChannel, and inactivity locking.
  Their verification-only revision is
  `b18dede373ca371cce440e0921807540c88833f3`: two Settings locators use semantic
  navigation names because all-flags staging inserts Activity before Settings.
  The initial supplemental run expected the default configuration's item 05;
  staging correctly rendered item 06. No product change was made. That staging
  pass used `8ddef64fc982ad3542369eea0f2abb33e110524e`; it is superseded by the
  final verification candidate below, not the RC target.

The staging deployment followed the complete local gate, verified image scans
and CI code checks; live QA ran in parallel with the remaining CI browser checks.
At that point the immutable RC and main closure were held until the final gates
below passed.

### Final verification candidate

Candidate `16cd6f5cf557512cc373c2c5d1fb57dc89c0d63f` includes the semantic
navigation locators and distinct CI compatibility container names. Its complete
Node 22 Docker gate passed 466 unit/integration tests and 100 development browser
checks with zero retries, plus audit, licenses, lint, types, build and release checks.
Gate image manifest: `sha256:d80a69037bfbef21c0f64978e3eb8432f9ab5794aeaa20ba6e3aef31a4be9df2`.

The final candidate was deployed only to the existing staging services:

- API: successful (internal deployment reference omitted);
  image `sha256:5b3506681b926dbcf214510def66ebc4db263cc7924bf30a0d7f31df40f84985`.
- Web: `a79ba534-524a-416a-aa2f-59ca9892a4a8`, successful;
  image `sha256:ff1bb257a5f05995cde6a44327ed3cdaeff62eda4ed66223bb4aadc9d06aa23e`.
- API readiness and web HTML returned HTTP 200 with exact candidate markers and
  normal TLS validation. Redis and configured source routes remained ready.
- All 14 production-mode M08 journeys passed again on this exact build in
  Chromium and WebKit, zero retries (27.7 seconds), using only synthetic local
  reports in isolated vaults, with zero source calls.
- The eight supplemental cross-tab, held metadata-readback, no-BroadcastChannel
  polling and inactivity checks passed again on this exact staging build with
  normal TLS and zero retries (28.7 seconds).

Final CI run: 34005884137 (pre-publication CI; private link omitted).
Its verification and image jobs passed, including nine blocking HIGH/CRITICAL
image scans and nine CycloneDX SBOMs. Retained SBOM artifact `9980985243` has digest
`sha256:332122e05e6fec0ed22ad504d14c21b9b3adc25bf46fd53ca7803e8638d17625`
and expiry `2026-12-05T02:12:36Z`.

The final CI completed successfully: 100 development and 36 production browser
checks passed on their first attempt, with zero retries/flaky cases. Sixteen
production-only fixture exclusions are intentional skips, not passed tests;
the same failure cases run in the development suite. M02 compatibility also passed.
The separate M08 compatibility round trip passed seed on `16cd6f5`, refusal/rescue
on immutable M07 `2edbc9d2c4c9eec309603a4347e69fbe15974470`, and restore on
`16cd6f5`. Each phase reports zero source requests and preserved ciphertext.
Independent CI-log review confirmed the counts and absence of retry/failure
markers. Always-retained synthetic browser diagnostics are artifact `9981167027`,
digest `sha256:a1ef210cc39f7985e52c8bcad1b46ba01169165e8cf16a8bbdecf461c2ef58b6`,
expiry `2026-09-09T02:32:06Z`; the artifact name is not a failure indication.

The immutable RC is `rc/08-local-agent-connector/1`, targeting tested application
SHA `16cd6f5cf557512cc373c2c5d1fb57dc89c0d63f`. Main includes a subsequent
evidence-only closure commit; that documentation revision is not represented as
the deployed application SHA. M09 begins only after this closure reaches main.

Official Arc launch, RPC and contract references were rechecked on 2026-09-06
at approximately 02:31 UTC: the [public launch announcement](https://www.arc.io/blog/arc-mainnet-goes-live-on-september-16-2026)
still names September 16; [RPC parameters](https://docs.arc.io/arc/references/rpc-endpoints)
remain Testnet-specific, and [mainnet contract addresses](https://docs.arc.io/arc/references/contract-addresses)
are explicitly not yet available. No mainnet configuration was inferred or enabled.
