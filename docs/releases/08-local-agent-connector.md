# M08 — local agent import and policy comparison

Status: **implementation active; not deployed or release-ready**.
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
- [ ] Lock/replacement cancellation, backup/recovery and incompatible-reader proof.
- [x] Independent review without unresolved P0/P1 findings.
- [ ] Full Node 22 gate, exact-SHA CI, production scans/SBOM and staging journey.
- [ ] Immutable RC and main closure before M09 begins.

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

An earlier clean-room run was cancelled after these source changes superseded its
snapshot and concurrent local browser work caused severe test timing contention.
It is not release evidence. The final clean-room gate runs alone against the fixed
source before any M08 staging deployment.
