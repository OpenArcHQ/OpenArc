# M09 — investigation operations

Status: **implementation and unlock-boundary regression verification complete; fresh full gates pending**.
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
- [ ] Full Node 22 gate, exact CI/scans/SBOM, exact staging build and live proof.
- [ ] Immutable RC and main closure before M10.

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

Hosted [CI run 34007821582](https://github.com/OpenArcHQ/OpenArc/actions/runs/34007821582)
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

- API deployment `<deployment-id>`, successful;
  image `sha256:4c6a177e93f815f84280869ac39c843fef79b005ef77693d2b65933c0c759ba3`.
- Web deployment `<deployment-id>`, successful;
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
