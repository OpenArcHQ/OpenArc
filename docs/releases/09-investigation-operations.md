# M09 — investigation operations

Status: **complete on controlled Testnet staging; not a public-launch or mainnet approval**.
RC: `rc/09-investigation-operations/1` at
`3fecd6bb44dd71931e1e239b8e9e8b6d30cb19f8`.
Branch: `codex/09-investigation-operations`, from M08-complete main
`8da23ba0350c932e7d5f68aba1169aea99117d1c`.
M08 RC: `rc/08-local-agent-connector/1` at `16cd6f5cf557512cc373c2c5d1fb57dc89c0d63f`.

## Frozen scope

This is a read-only, local projection of already-decrypted, validated workspace
records. It adds no provider, API route, background request, signing, credential,
new persistence kind or stored investigation grouping. Optional notes are omitted.
The false-by-default `VITE_INVESTIGATIONS_ENABLED` flag requires the encrypted
workspace. Existing source controls remain separately gated. M01 synthetic evidence
contracts are unchanged. No mainnet or public-release readiness is implied.

### Search and evidence views

- Separate typed roots: synthetic action, imported payment bundle, imported report
  event, saved Arc account/transaction, registry/job observation and standalone
  synthetic evidence. A report-event reference includes record ID/revision and
  event ordinal; conflicting same-ID variants remain distinct.
- A maximum 6,602 workspace records and 512 report events are accepted. The index
  has an independent 7,114-entry cap. Overflow fails explicitly; no silent omission.
  Search is bounded to 160 characters, local-only, and paginated at 25 entries.
  Search, selection and previews are never stored in URLs or plaintext storage.
- The exception inbox distinguishes conflicting, reported failure and incomplete
  or unverified evidence. It is not a full-history fraud/replay or wallet audit.
  Cheap index findings are not represented as completed policy evaluations.
- Each selected root has expected-versus-observed facts, explicit citations,
  source class, observation/report time and limitations. Source classes remain
  synthetic fixture, owner-supplied unauthenticated report, named Testnet
  observation, local policy result and explicit local association.
- Only existing explicit local links and exact cited evidence references form
  relationships. No wallet/amount/time heuristics. Multiple linked observations
  remain separate; a favorable observation never silently wins.
- M08 policy comparison requires explicit selection of a saved applicable policy
  and uses the unchanged evaluator over all bounded supplied events. Policy
  comparison remains monitoring only; daily history remains partial.
- M07 comparisons use the unchanged engine. At more than 64 stored bundles,
  duplicate/replay coverage is explicitly unavailable for the whole collection;
  selected-bundle metadata comparison may continue without claiming replay coverage.
  Gateway batch inclusion never proves an individual payment or fulfillment.
- The chronological semantic list is always rendered. An optional native SVG
  graph uses exactly the same page of nodes and edges; no extra graph conclusion.
  A page has at most 64 nodes and 128 edges, with explicit total/page counts and
  at most 2,048 normalized facts per node (including up to 128 transaction movements).
  Ordering is stable. Lists, graph, keyboard navigation and filtered results agree.
  Mobile defaults to list; reduced motion disables transitions.

### Redacted reports

- Versioned JSON export is built from an allowlist, never raw serialization with
  fields removed afterward. The fixed filename is `openarc-investigation-report.json`.
  Maximum 1 MiB; one selected detail page, at most 64 nodes and 128 edges.
- Default: report-local aliases, fixed source classes/statuses, typed relationships,
  allowlisted engine rule versions, limitations and omission counts. No persistent record/action/agent IDs, wallets,
  hashes, timestamps, amounts, user labels, policy text, URLs or arbitrary source text.
- Separate unchecked choices may include identifiers, exact amounts and timestamps.
  Identifier values are bounded ASCII tokens (letters, digits, underscore, colon,
  period and hyphen; at most 160 characters), not URLs or arbitrary descriptions.
  Amount values are canonical non-negative integer/decimal strings (at most 160
  characters); timestamps use the existing strict UTC timestamp schema. A selected
  value outside its grammar remains omitted with a category/reason count. Fact
  labels are not exported: fixed category names and field ordinals avoid leaking
  untrusted labels. Structural errors or dangling graph edges reject export.
  Local labels, descriptions, notes, arbitrary external metadata, permission released
  fields, signatures and vault internals are never included by this exporter.
- Preview precedes explicit local download with a plaintext-sharing warning.
  An omitted-fields manifest names categories/counts and reasons, never omitted
  values or hashes. This report is not an encrypted workspace backup.
- Lock, unmount, selection or workspace revision changes invalidate the preview.
  Session guards fence deferred work; no upload, clipboard or automatic download.

### Saved source history

Source health is a projection of saved permission receipts and named observations,
not a live provider monitor. Show disabled, never checked, unresolved approval,
last saved attempt failed, saved observation, or aged snapshot. A snapshot older
than 24 hours is labeled aged by this UI convention, not invalid or a provider outage.
Display the observation time and age basis. No automatic capability refresh or
source request occurs. Failure history never erases prior saved evidence.
Capability-only completion is a saved check, not a chain observation. A completed
source receipt without a corresponding saved observation is explicitly labeled
completed without observation. These states do not infer a successful lookup result.

## Required verification

- [x] Bounded shared projection, reference integrity and mixed-provenance tests.
- [x] Exact graph/list filtering and pagination parity; no heuristic joins.
- [x] Strict export allowlist and adversarial private-field canaries.
- [x] Desktop/mobile/keyboard/reduced-motion/axe browser journeys.
- [x] Zero source calls, export cancellation, lock/revision invalidation.
- [x] Large bounded dataset responsiveness and explicit overflow failures.
- [x] Independent review; reproduced unlock-boundary P1 fixed and regression verified.
- [x] Full Node 22 gate, exact CI/scans/SBOM, exact staging build and live proof.
- [x] Immutable RC and main closure before M10.

## Development evidence

The shared projection suite covers full 6,602-record indexing, 512-event policy
comparison with paginated citations, 128 canonical transaction movements, and
multiple explicitly linked Gateway observations without choosing a favorable
winner. Report timestamps use exact fractional comparison; equivalent fractional
zero spellings are duplicates while real differences remain conflicting.

Privacy review found and corrected value-based timestamp classification: an
arbitrary description that resembles an ISO timestamp remains local-private.
Only known timestamp field names can enter the timestamp export category. The
review also added policy and selection-profile citations to synthetic comparisons;
policy/requirement facts are displayed as expected, not observed execution.

Independent export/source-history tests cover default private-field canaries,
separate optional categories, unsupported value omission, strict pagination and
reference bounds, one-MiB rejection, contradictory replay coverage, exact 24-hour
age boundaries and conservative handling of simultaneous success/failure receipts.
This is an internal engineering review, not a professional security certification.

Browser visual QA reduced dense raw-schema rendering to meaningful summaries plus
keyboard-operable full-fact disclosures. The semantic evidence list remains
present independently of the optional graph; graph and list use the same nodes
and edges. Source history starts collapsed, and selecting a result focuses the
detail heading. Final full-gate evidence is pending; these development checks do
not yet establish release completion or deployment.

## Exact-candidate verification

Application candidate: `fd449e62bbf05b7ee3438d4bfbd94757d0509a2b`.
The complete Node 22 Docker gate passed 520 unit/integration tests (221 shared,
185 API, 114 web) and 110 cumulative development browser checks, with zero retries.
Audit found no known production vulnerabilities; licenses (four groups), lint,
types, builds and structural release checks passed. The gate image manifest is
`sha256:0a820e401ac6a4cff75de162a8888b65aaad4d511fe13775005ffe0e2ca02f1b`;
manifest list `sha256:e0ec8b463aba8cec27b00d227bf2ef83a8aa51a29b549e3abe63b929970a3167`.
The existing bundle-size advisory remains visible; no warning threshold was raised.

Hosted CI run 34007821582 (pre-publication CI; private link omitted)
has passed verification and all ten blocking HIGH/CRITICAL image scans. Ten
CycloneDX SBOMs are retained in exact-SHA artifact `9981592826`, 975,941 bytes,
digest `sha256:7a210a92793e82d210fda5b045b2949a815d75e6dc1e6215141f7eba21054d8d`,
expiry `2026-12-05T02:58:38Z`. The browser job subsequently failed during the M08
reader-compatibility restore: its broad Agent reports locator matched both the
sidebar and compact navigation. Before this failure, 110 development and 36
production browser checks passed without retries (16 intentional fixture-only
production skips); compatibility seed and M07 rejection/rescue passed with
unchanged ciphertext and no source queries. M09's eight production checks were
not reached. The harness now scopes navigation to the named Workspace navigation
sidebar in both seed and restore; no product assertion or older-reader check is
removed. A fresh complete hosted run is required before RC and main closure.

### Existing Railway staging

Only the existing staging API and web were deployed after the full local gate,
hosted code checks and scans passed. Live QA ran alongside remaining hosted browser
checks. Redis, production, service count and the hosting plan were unchanged.

- API deployment `8fb7b143-f5b1-487a-b3ff-0654b63b303d`, successful;
  image `sha256:4c6a177e93f815f84280869ac39c843fef79b005ef77693d2b65933c0c759ba3`.
- Web deployment `0801a629-0d5c-4212-9065-cae3fc276849`, successful;
  image `sha256:e3b893302384f01154926ccbaafa08fd4b6d33cd8f0e1d676e3a9afa81aace5e`.
- Both web HTML and API readiness expose the exact candidate SHA with HTTP 200 and
  normal TLS validation. Redis, source routes and configuration remain ready.
- All eight M09 live journeys passed in Chromium/WebKit without retries (19.9s):
  local filtering, graph/list parity, exact policy comparison, redacted and opt-in
  plaintext downloads, cancellation/lock/unmount, keyboard, mobile and axe checks.
- All 14 M08 live regression journeys passed on the same build without retries
  (32.8s), including encrypted backup/recovery/restore and own-creation polling.
- Eight supplemental live Chromium/WebKit checks passed without retries (29.9s):
  cross-tab coordination, held post-save metadata readback, polling without
  BroadcastChannel, and exact inactivity locking. Total live checks: 30 passed.
- Live tests used isolated synthetic workspaces, not the user's vault. M09 asserts
  zero fetch/XHR source requests; no payment, signing, new provider, TLS bypass or
  synthetic proxy header was used on the public staging origin.

M09 adds no persisted record kind. Hiding Investigations does not remove evidence,
and the M08 reader remains the minimum reader for M08 agent-report records. The
downloaded plaintext report is not a backup and is never automatically uploaded.

### Additional pre-release session-boundary finding

The selector-only candidate `20e6d016b41aad8b0e9e0f921c4a29801ff6663e` passed
the complete local Node 22 gate (520 unit/integration and 110 browser tests,
zero retries); its gate image manifest is
`sha256:ab4198e0eaed9892a4b63cfd976a3ac4e8157e7a8bac5505836831ad616c97a1`.
Independent local seed and restore checks also passed at that exact SHA with
unchanged ciphertext and no source requests. Historical-reader verification is
reserved for the hosted compatibility sequence, not inferred from those two checks.

A separate deterministic Chromium review reproduced an inherited P1 session-boundary
race twice: a peer lock committed while another tab was deriving its unlock key,
but that tab accepted the stale decrypted snapshot before its next revision poll.
The correct passphrase was still required; this was not a password bypass. No
user workspace or real data was used. This finding blocks RC/main closure even
though it predates M09. The fix rereads durable metadata after decryption and
rejects changed vault identity, record revision, coordination revision or pending
deletion before returning the decrypted workspace. Unit and browser regression
proof plus fresh exact-candidate gates are required. The separate precommit lock
hint/form-reset timing annoyance remains a hardening follow-up; it is not a
substitute for this release-blocking stale-session check.

Four deterministic unit regressions passed for lock, deletion, record-save and
workspace-replacement changes during held key derivation; the full vault suite
passed 45 tests. Ciphertext is not rewritten by a rejected unlock, and a fresh
current-revision unlock succeeds where the workspace remains available.
The permanent Chromium and WebKit regression failed against a task-only served
baseline with only this guard removed: both detected an actual stale private UI
mount, not a fixture timeout. With the guard present, both passed first time after
the fixture was finalized (1.3s / 1.9s), asserting no stale mount, the exact revision
conflict notice and successful fresh unlock. Original fixture development required
a WebKit-compatible IndexedDB interception; no production assertion was weakened.
Review confirms the proven P1 path is resolved. The final candidate still requires
the full 524-unit/integration, 112-development-browser and hosted production gates,
plus live staging regression verification before RC/main closure.

### Corrected candidate verification

Intermediate unlock-fix candidate: `5fe1bc47d1870c541d64bf042c0a9cec98c3307f`.
The complete Node 22 Docker gate passed 524 unit/integration tests (221 shared,
185 API, 118 web) and 112 development browser tests with no retries, including
both browsers' permanent unlock-boundary regression. Production audit, four-group
license policy, lint, types, builds and structural checks passed. Gate image:
`sha256:596479f86388679b2e9d7dc131c977e5d8a8fb0e7b412dcda130931ee6dd5693`;
manifest list `sha256:545d8d6b72455faf57a7fdf7b6870f62b4dae99923fc98240e0b0ee4a021b78b`.

CI run 34009370487 (pre-publication CI; private link omitted)
passed code verification and all ten blocking image scans. Its ten CycloneDX SBOMs
are in exact-SHA artifact `9982058952`, 975,890 bytes, digest
`sha256:12ec8ee60f17ee2d58918feefb1fd53ee9a52c49a316882a3af95093418bd6f9`,
expiry `2026-12-05T03:35:26Z`. The hosted browser job failed on WebKit's first
M09 development journey: the graph checkbox click did not change its state after
the target moved during scrolling/focus. Production and compatibility completion
are not established by this run. Investigation and a fresh gate are required;
no RC has been created. The intermediate selector-only CI run
`34009026442` was superseded by this corrected candidate and is not release proof.

The same existing Railway staging services were updated only after the local gate,
hosted code verification and scans passed:

- API deployment `dcecf072-13b8-42cd-8e54-2a28cb093df0`, successful, image
  `sha256:718c7e7c071d11c965e8713dba161c8bb26905547e7934ecc4af6cd1645e4e41`.
- Web deployment `70b46507-5fc0-4ef0-a8b7-92aa78fa11cb`, successful, image
  `sha256:12d7a29daf52207b9a3132e6fe5e9c0256090f1eb10a95ba4cc52dd17d64434c`.
- API readiness and web HTML expose exact `5fe1bc47…` with HTTP 200 and valid TLS;
  Redis, source routes and configuration are ready.
- Eight live M09 journeys passed first try (19.0s); fourteen live M08 regressions
  passed first try (25.8s), both asserting the exact build marker.
- Ten supplemental live cross-tab/inactivity checks passed first try (30.4s),
  including both browsers' stale-decrypted-session regression. Total: 32 live
  checks passed. The supplemental suite used the same public origin with normal
  TLS and markers checked before the sequence; it does not internally assert SHA.
- These tests used fresh synthetic local vaults, no user vault, no payments or
  signing, and no source fetch/XHR requests. No public-origin TLS bypass or proxy
  test header was used. Redis, production, service count and plan were unchanged.

The failed hosted run reached 110 development cases: 109 passed and one failed;
the final two flag-off cases and all 44 production cases were not reached. There
were no retries. Its exact-SHA diagnostics artifact `9982115185` is 9,055,851 bytes,
digest `sha256:c28b0f527e64afb23cc7727ce73cadd0a307ed9b36916429962499968d1c581b`,
expiry `2026-09-09T03:46:57Z`. The trace shows the viewport moved 17 pixels during
checkbox dispatch. Selection focus now runs before paint, prevents implicit focus
scrolling and explicitly positions the selected heading instantly. Other site
motion is unchanged. The graph journey explicitly exercises normal motion,
heading focus and repeated ordinary checkbox clicks without forced actions or
test retries; reduced-motion/mobile coverage remains separate.
The normal-motion journey passed six focused runs (three per browser, 27.8s), each
with three uncheck/check cycles. Typecheck, lint and independent focused review
passed; the final full gate remains required rather than inferred from stress QA.

### Final lock-and-focus candidate

Application SHA: `3fecd6bb44dd71931e1e239b8e9e8b6d30cb19f8`.
The full Node 22 Docker gate passed 524 unit/integration and 112 development
browser checks with no retries, plus production audit, license policy, lint,
typecheck, builds and release checks. Image manifest:
`sha256:40d8d99e852a4bb83c85b69d821a85dca714b497ff917031ca3c3b945d8e717e`;
manifest list `sha256:65d01720915dd48b869d299589b1df2d8ce60c02cc16a13dd7a52300361aff28`.
Hosted CI 34010030123 (pre-publication CI; private link omitted)
has passed verification and all ten image scans. Hosted browser completion is
recorded below; prior failed candidates are not treated as completed CI proof.
The ten CycloneDX SBOMs are retained in exact-SHA artifact `9982244019`,
975,901 bytes, digest
`sha256:6f916e9cd1105024f9bc4e08a0a5ef96f6c6bec931e224cdb10c0ca0dccdee6f`,
expiry `2026-12-05T03:51:14Z`.

Only the existing staging API/web services were updated after those gates passed:

- API deployment `a8b69ae4-5d96-44c8-b44e-3b0e7ed03fde`, successful, image
  `sha256:69aad7a5d343580eab3f4f99bdc15be7d0a27abf72b6ca010f9e35e9d55488a0`.
- Web deployment `1b1e5e39-33d3-4be2-b263-ce269c564ddb`, successful, image
  `sha256:6b77d45f16b6d8906128a75be0bf5e4e62d28d75309f4b32fbfd6cc2e7d7a0c8`.
- API readiness and web HTML expose exact `3fecd6bb…`, HTTP 200, normal TLS;
  configuration, source routes and Redis are ready.
- Eight live investigation checks passed first try (13.5s), including normal-motion
  repeated graph toggles, focus, graph/list parity, private export canaries and
  real downloaded bytes. Fourteen import/recovery regressions passed (35.3s).
  Both suites assert the exact build SHA.
- Ten supplemental cross-tab/inactivity checks passed first try (30.9s), including
  the stale-decrypted-session regression in Chromium and WebKit. Total live: 32.
  As above, supplemental SHA binding is by public markers verified immediately
  before the suite sequence, not an internal supplemental-suite assertion.
- Fresh synthetic contexts only, zero source fetch/XHR queries, no real vault,
  no payments/signing, no public-origin TLS bypass or synthetic proxy headers.
  Redis, production, service count and plan were not changed.

Final hosted CI completed successfully on the exact application SHA. All 112
development browser cases passed first try (50 baseline, 2 workspace flag-off,
12 API boundary, 4 Arc, 4 registry, 8 jobs, 8 Gateway, 14 imports, 8 investigations,
2 investigation flag-off). All 44 production cases passed first try (2 workspace,
12 API boundary, 2 Arc, 2 registry, 2 jobs, 2 Gateway, 14 imports, 8 investigations),
with 16 intentional fixture-only production skips and no retries/flaky results.
Compatibility seed at `3fecd6bb…`, immutable M07 reader rejection/rescue at
`2edbc9d2c4c9eec309603a4347e69fbe15974470`, and restore at `3fecd6bb…` all passed,
each with zero source requests and preserved encrypted bytes.
Exact-SHA browser diagnostics artifact `9982437619` is 6,490,522 bytes, digest
`sha256:ca643fb3c28f0630c1530a43953dc41493b58c23d590fd17b828f7b19e8c8f43`,
expiry `2026-09-09T04:14:16Z`.

Independent final review found no unresolved P0/P1 in M09 or its corrected unlock
path. M09 adds no live source route; its live proof is the exact staging local
workflow and regression suite. The already-recorded M07 controlled Testnet payment
proof remains unchanged and was not repeated. Public Testnet hardening is M10;
mainnet remains separately gated on official parameters and external approvals.
