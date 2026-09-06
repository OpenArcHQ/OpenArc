# M09 — investigation operations

Status: **active implementation**.
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

- [ ] Bounded shared projection, reference integrity and mixed-provenance tests.
- [ ] Exact graph/list filtering and pagination parity; no heuristic joins.
- [ ] Strict export allowlist and adversarial private-field canaries.
- [ ] Desktop/mobile/keyboard/reduced-motion/axe browser journeys.
- [ ] Zero source calls, export cancellation, lock/revision invalidation.
- [ ] Large bounded dataset responsiveness and explicit overflow failures.
- [ ] Independent review; no unresolved P0/P1 findings.
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
