# OpenArc frontend architecture

Status: **normative frontend specification**  
Specification version: **0.2.1-draft**
Parent: `docs/engineering/openarc-engineering-source-of-truth.md`  
Runtime target: **React, Vite, TypeScript, browser WebCrypto and IndexedDB**

This document defines the OpenArc browser application. It is subordinate to the
engineering source of truth and owns frontend-specific behavior only.

## 1. Frontend mission

The browser is the private workspace and primary product. It owns the local
human context that must not become a server-side behavioral profile.

It:

- encrypts and stores the workspace locally;
- manages agent labels, monitoring policies, evidence, actions, and notes;
- records exact permission receipts before network calls;
- validates every API response at runtime;
- evaluates policy and reconciles evidence deterministically;
- presents an accessible timeline, graph, source view, and investigation report;
- aborts and discards work at every lock or session boundary.

It does not:

- store provider API credentials;
- collect wallet private keys, seed phrases, entity secrets, or OTPs;
- sign or broadcast transactions;
- automatically refresh wallet or provider data;
- send private labels, policies, notes, prompts, or cross-source relationships to
  the API;
- infer intent, agent identity, provider quality, or wallet enforcement.

## 2. Frontend package layout

M07 uses a dedicated Payments panel and strict local normalized metadata import,
not the M08 general agent connector. Receipt v5 discloses exactly network and
Gateway transfer UUID. A local bundle association is explicit and never released.
The encrypted `x402_bundle` and `gateway_observation` record variants share the
unchanged 6,602 global record ceiling and existing backup/recovery integrity rules.
Gateway observations require a matching completed v5 receipt and a valid optional
local bundle reference. Imported metadata never gains signature or fulfillment
verification. Reconciliation cites local input IDs and a rule version, separates
duplicate claims from contradictory replay-scope claims, and limits an explicitly
selected saved Arc transaction comparison to batch inclusion—not individual payment
settlement. No background queries or transaction controls are added.

```text
apps/web/
  src/
    main.tsx
    App.tsx
    app/
      routes.tsx
      availability.ts
      ProductShell.tsx
      ProductRail.tsx
      ErrorBoundary.tsx
    vault/
      types.ts
      crypto.ts
      db.ts
      service.ts
      archive.ts
      session.tsx
      errors.ts
    evidence/
      types.ts
      reconciliation.ts
      EvidenceTimeline.tsx
      EvidenceGraph.tsx
      EvidenceList.tsx
      EvidenceDetails.tsx
    agents/
      AgentsPanel.tsx
      AgentEditor.tsx
      AgentIdentityPanel.tsx
    activity/
      ActivityPanel.tsx
      RefreshDialog.tsx
      TransactionEvidence.tsx
    jobs/
      JobsPanel.tsx
      JobEvidence.tsx
    payments/
      PaymentsPanel.tsx
      GatewayEvidence.tsx
    policies/
      PoliciesPanel.tsx
      PolicyEditor.tsx
      evaluation.ts
    investigations/
      InvestigationsPanel.tsx
      ExpectedObserved.tsx
      ReportExport.tsx
    sources/
      SourcesPanel.tsx
      SourceStatus.tsx
    api/
      client.ts
      schemas.ts
      errors.ts
    components/
      Dialog.tsx
      InfoBubble.tsx
      EmptyState.tsx
      StatusBadge.tsx
      ExactValue.tsx
    styles/
      tokens.css
      global.css
  test/
  public/
  Dockerfile
```

Feature folders import `packages/shared` and shared components. They do not import
another feature's internal storage implementation.

## 3. Routes and product shell

Public routes:

```text
/                 product landing page
/guide            beginner product guide
/docs             product and technical documentation
/faq              FAQ
/legal            privacy, terms, and limitations
/status            source/build status or status-service handoff
```

Private local workspace route:

```text
/workspace?view=overview
/workspace?view=agents
/workspace?view=activity
/workspace?view=jobs
/workspace?view=payments
/workspace?view=policies
/workspace?view=investigations
/workspace?view=sources
/workspace?view=settings
```

The private workspace is outside any account, cloud, wallet-connect, or analytics
provider. It does not mount unrelated network clients.

### Navigation rules

- Persistent desktop rail and compact mobile drawer.
- Each workspace has title, one-sentence purpose, information bubble, status, and
  a `Learn how this works` link.
- Disabled features are visible only when useful and labeled
  `BUILT - NOT ENABLED IN THIS BUILD`; they are not clickable.
- Invalid or disabled direct views fall back to the nearest enabled workspace.
- Browser back/forward changes views without locking the Vault.
- Leaving `/workspace`, manual lock, hidden/pagehide, workspace replacement, or
  deletion applies the relevant session boundary.

## 4. First-visit guidance

The first successful workspace creation shows an accessible guided tour:

1. What OpenArc can and cannot prove.
2. Where private workspace data lives.
3. How to add an agent wallet label.
4. Why refresh requires explicit permission.
5. How to read evidence classes and incomplete states.
6. How to lock, export, recover, and delete.

Tour state is local and non-sensitive. `Show tour again` remains available in the
rail and settings. While the accessible modal is open, the background workspace
is intentionally inert; Skip or Escape closes it immediately so lock and delete
remain available without completing the tour.

The dialog has initial focus, a focus trap, Escape close when safe, focus return,
background inertness, text-based progress, reduced-motion behavior, and full
contrast coverage.

## 5. Application state model

Top-level Vault phases:

```ts
type VaultPhase =
  | { kind: "probing" }
  | { kind: "unsupported"; reason: string }
  | { kind: "empty" }
  | { kind: "creating" }
  | { kind: "locked"; meta: PublicVaultMeta }
  | { kind: "unlocking"; meta: PublicVaultMeta }
  | { kind: "unlocked"; session: VaultSession }
  | { kind: "deleting"; vaultId: string; blocked: boolean }
  | { kind: "fatal"; code: string };
```

Session identity:

```ts
interface VaultSession {
  vaultId: string;
  generation: number;
  key: CryptoKey;
  revision: string;
  openedAt: number;
  inactivityDeadline: number;
}
```

The renderable generation state and internal generation ref advance together on:

- unlock;
- successful workspace replacement/import/recovery;
- manual or inactivity lock;
- visibility/pagehide lock;
- deletion start;
- remote cross-tab lock/deleting/deleted event;
- unexpected database close or version change.

Every session-bound async operation captures `{vaultId, generation, revision}`.
Network work, beginning in M03, also owns an `AbortSignal`; WebCrypto and
IndexedDB work that cannot be cancelled discards late results through the
generation check. The session identity is asserted before and after any future
network boundary, inside the final IndexedDB write transaction, and before
updating React state.

## 6. Browser capability gate

Before any create/unlock controls mount, require:

- secure context;
- `crypto.subtle`;
- `crypto.getRandomValues`;
- `crypto.randomUUID` or an approved local UUID implementation using secure RNG;
- IndexedDB;
- TextEncoder/TextDecoder;
- Blob and URL object URL support for encrypted exports.

Missing core capabilities show one unsupported page. There is no plaintext,
localStorage, cookie, or remote fallback.

BroadcastChannel, Storage Persistence, Web Locks, and File System Access are
optional enhancements and cannot be correctness dependencies.

## 7. IndexedDB structure

One origin-bound database:

```text
database: openarc-vault
version: 1

store vaultMeta
  key: "active"
  value: PublicVaultMeta

store records
  key: opaque record UUID
  value: EncryptedEnvelope
```

Plain public metadata contains only:

```ts
interface PublicVaultMeta {
  formatVersion: 1;
  databaseVersion: 1;
  vaultId: string;
  schemaVersion: number;
  keyVersion: number;
  revision: string;
  coordinationRevision: string;
  deletionPending: boolean;
  passphraseKdf: {
    version: "openarc.wrap-kdf.v1";
    algorithm: "PBKDF2-HMAC-SHA-256";
    iterations: number;
    salt: string;
  };
  passphraseWrapper: WrappedKey;
  recoveryKdf: {
    version: "openarc.wrap-kdf.v1";
    algorithm: "PBKDF2-HMAC-SHA-256";
    iterations: number;
    salt: string;
  };
  recoveryWrapper: WrappedKey;
  sentinelRecordId: string;
}
```

It contains no agent name, address, policy, record kind, record count, created
date, action date, provider name, or evidence timestamp. The opaque
`coordinationRevision` changes on every local lock signal so a tab without
BroadcastChannel can fail closed by polling. `deletionPending` is a public
one-bit lifecycle marker set before the uncancellable database deletion begins;
it reveals only that local deletion was requested.

Encrypted envelope:

```ts
interface EncryptedEnvelope {
  id: string;
  iv: string;
  keyVersion: number;
  schemaVersion: number;
  revision: string;
  ciphertext: string;
}
```

The encrypted plaintext contains a discriminated record union. Unknown kinds or
versions fail closed. A separately labeled opaque rescue export can copy the
already-encrypted metadata and envelopes without accepting or decrypting them;
it is not a normal logical backup and is not importable by the current build.

## 8. Cryptographic lifecycle

### Create

1. Normalize and bound the passphrase under a documented Unicode policy.
2. Generate a random 256-bit data-encryption key as extractable only during
   wrapping.
3. Derive a wrapping key with PBKDF2-HMAC-SHA-256, a random salt, and versioned
   iteration count.
4. Wrap the data key with AES-KW.
5. Create a separately derived recovery wrapper from a high-entropy recovery
   secret displayed once.
6. Discard extractable key material.
7. Unwrap the session key as nonextractable AES-GCM.
8. Encrypt and verify a manifest sentinel containing the opaque global revision
   and a sorted digest/revision entry for every non-sentinel envelope.
9. Commit metadata, settings, and sentinel atomically.

### Record encryption

- AES-256-GCM.
- Fresh random 96-bit IV on every write, including rewrites.
- 128-bit authentication tag.
- Canonical AAD:

```text
openarc|vault-v1|<vaultId>|<recordId>|<recordSchema>|<keyVersion>|<recordRevision>
```

- Canonical UTF-8 JSON serialization with bounded keys and arrays.
- IV collisions against every retained envelope are rejected. A fresh 96-bit
  CSPRNG IV is used on every write; the residual probability of repeating an IV
  from a previously deleted envelope is not described as impossible.

### Unlock

- Derive wrapping key.
- Unwrap to nonextractable session key.
- Decrypt and validate sentinel.
- Read one atomic snapshot of metadata and records.
- Decrypt and validate every required record before entering unlocked phase.
- Use generic user error: `Wrong passphrase or damaged workspace.`

### Lock

- abort all requests;
- invalidate generation;
- clear key and decrypted state;
- clear editors, dialogs, drafts, and report previews;
- revoke object URLs;
- clear timers and listeners;
- broadcast non-sensitive lock event;
- atomically rotate the public opaque coordination revision for same-origin
  polling fallback, accepting the latest revision for the same Vault so a
  racing writer either loses its CAS or is followed by the lock marker;
- return to locked UI.

Do not claim guaranteed JavaScript heap erasure.

### Recovery

Recovery unwraps the same data key, verifies every record, creates a new
passphrase wrapper and recovery wrapper in memory, then conditionally commits
metadata against the original vault ID, data revision, and coordination
revision, while requiring `deletionPending=false`. Old passphrase and old
recovery secret must fail after success. Any record error leaves original
wrappers valid.

### Export and import

- Decrypt and validate one atomic snapshot.
- Build a bounded canonical logical-record archive in memory; original Vault
  metadata, wrappers, envelope IVs, and the storage manifest are not archived.
- Encrypt the whole archive with a distinct user-supplied backup passphrase and
  fresh salt/IV.
- Clear header contains only magic, version, exact versioned backup KDF, salt,
  and IV, and that canonical header is authenticated as AES-GCM AAD.
- Import validates file size and KDF bounds before work.
- Decrypt and strictly validate every record, then create a fresh Vault ID, DEK,
  local passphrase/recovery wrappers, envelope revisions/IVs, and manifest before
  replacement. A new recovery secret is shown once.
- Replacement is one IndexedDB transaction with expected-empty or expected
  `{vaultId, revision, coordinationRevision}` precondition and
  `deletionPending=false`.
- No merge in the first release.

### Delete

- invalidate session and broadcast `deleting`;
- atomically set public `deletionPending=true` and rotate the coordination
  revision before requesting deletion;
- clear UI and close this tab's handles;
- enter dedicated non-interactive deleting phase;
- call `indexedDB.deleteDatabase`;
- treat `onblocked` as pending, not cancelled;
- report completion only on `onsuccess`;
- show close-other-tabs guidance while blocked;
- never expose create/unlock/import controls while an uncancellable delete is
  pending.
- a tab that starts, receives a message, or polls while the marker is set enters
  the same non-interactive phase and may safely resume the idempotent database
  deletion; normal read, unlock, write, and import paths fail closed.

## 9. Record schemas

Initial encrypted record kinds:

```ts
type VaultRecord =
  | AgentProfileRecord
  | MonitoringPolicyRecord
  | EvidenceRecordRecord
  | ActionEnvelopeRecord
  | WorkspaceSettingsRecord
  | SentinelRecord;
```

This M02 union is intentionally closed. `PermissionReceiptRecord` begins with
M03's permission-before-network work, and investigation notes begin only in
their later milestone. Unknown kinds remain opaque, exportable, and deletable,
but this build does not decrypt or silently drop them.

The cumulative M04 reader adds strict `permission_receipt` v1/v2 variants and
`arc_observation`. It does not mutate an older record merely by unlocking it.
An observation is valid only when its unique `permissionReceiptId` resolves to
a completed v2 receipt whose connector, network, and released public identifier
exactly match the observation. Orphans, mismatches, and one-receipt-to-many-
observation relationships fail before encryption and on every unlock/import.

Record IDs are opaque UUIDs and carry no domain meaning.

### Agent profile

```text
record ID
owner-supplied display name
wallet associations: network + canonical address + classification source
optional framework label
optional local purpose note
policy record IDs
```

### Monitoring policy

```text
policy ID and revision
owner-supplied name
status and validity window
per-action and rolling-window limits
allowed/blocked service origins
allowed/blocked recipient and contract addresses
human-approval requirement
enforcement evidence: none or source-linked proof
```

### Permission receipt

```text
receipt ID
connector ID
destination
exact public fields released
purpose
credential/cookie behavior
provider retention description
OpenArc no-store description
approvedAt
outcome: approved | completed | failed
resolvedAt
failure class, never raw provider message
```

## 10. API client boundary

One client module owns all fetch calls.

```ts
async function requestOpenArc<TReq, TRes>(input: {
  path: AllowedPath;
  requestSchema: ZodSchema<TReq>;
  responseSchema: ZodSchema<TRes>;
  body: TReq;
  signal: AbortSignal;
}): Promise<TRes>
```

Rules:

- same-origin relative path only;
- method fixed by `AllowedPath`;
- credentials omitted for credentialless source routes;
- JSON content type;
- request validated before serialization;
- response byte cap where browser streaming support allows;
- response envelope and DTO validated before use;
- no redirects to another origin;
- non-JSON and malformed error responses collapse to a bounded local error;
- no address, hash, ID, policy, or provider message enters console logs;
- abort is a neutral session event, not a visible provider failure after lock.

### M03 bootstrap and receipt contract

`VITE_API_BOUNDARY_ENABLED` defaults false and requires the encrypted workspace
flag. It adds an unlocked Sources view with an explicit capability-check action,
not an automatic fetch. Before confirmation, fixed local copy names the current
same-origin OpenArc API, no upstream provider, no user-entered released fields,
omitted cookies/credentials, and ordinary hosting/network metadata (including
IP and user-agent) visible to the API/host. No response is needed to display this
initial disclosure. A denied/cancelled prompt performs no request or write.

The new `permission_receipt` kind uses `recordSchema:
"openarc.permission-receipt.v1"`, opaque record/revision IDs, and the ordinary
created/updated timestamps. Its strict payload contains the fixed
`openarc_capabilities` connector, same-origin destination plus the exact GET
path, empty upstream/released-field arrays, fixed purpose/retention/credential
descriptions, approval time, and `approved | completed | failed` outcome.
`approved` has null resolution/failure; `completed` has a resolution no earlier
than approval and no failure; `failed` has a resolution and one bounded shared
failure code. Creation equals approval and update equals resolution or approval.
Unknown schema, keys, destinations, outcomes, or impossible times fail closed.
No wallet identifiers or live-source evidence are accepted by this M03 receipt.

Receipt capacity is 1,000 under the existing combined ceiling of 6,602 records
including the sentinel. Keep the existing 6,601-entry manifest and 32 MiB backup
cap; save/export/import enforce both per-kind and combined bounds. Existing M02
records retain their schemas and are not migrated merely by unlocking. M03
reads them, while M02 rejects a newer receipt without overwriting it and still
offers opaque rescue/delete. Outer crypto and backup formats remain unchanged.

Capability fetch uses only the fixed relative route, `credentials: "omit"`,
`redirect: "error"`, `cache: "no-store"`, `referrerPolicy: "no-referrer"`, and
the fixed client header. It is bounded to 64 KiB and a 10-second total deadline,
validates the strict envelope/DTO, and accepts no response-supplied URL as a
future destination. A persisted completed receipt proves this configuration
check completed, not that Arc was contacted or any agent was verified.

Receipt commit updates the active local revision before dispatch. The same
generation/abort guard covers the request and final receipt commit. Lock,
hidden/pagehide, delete, import, recovery, cross-tab changes, and replacement
abort work and prevent all late UI/writes. Failure after dispatch preserves the
approved receipt if the failed/completed update cannot save; UI distinguishes
"nothing sent" from "request may have reached OpenArc; result not saved".
Source-feature capability values remain false and live connector controls absent.

### M04 Arc observation and receipt contract

`VITE_ARC_OBSERVATION_ENABLED` defaults false and is effective only with the
encrypted workspace and M03 API-boundary flags. The enabled Activity view offers
two explicit actions: one account snapshot or one transaction evidence lookup.
It performs no call on mount, unlock, navigation, focus, visibility change,
timer, or retry.

Each approval creates `openarc.permission-receipt.v2`. The account variant pins
`POST /v1/private/arc/account-snapshot`, Arc's fixed primary RPC upstream, and
only `network` plus the approved public address. The transaction variant pins
`POST /v1/private/arc/transaction-evidence` and only `network` plus the approved
public transaction hash. Both pin omitted credentials, OpenArc local/no-store
handling, provider-handling copy, ordinary host/network metadata disclosure,
purpose, approval/result timestamps, and a bounded failure code. Unknown keys,
routes, upstreams, released fields, and impossible lifecycles fail closed.

A successful response becomes `openarc.arc-observation-record.v1` and the
completed receipt in one conditional IndexedDB transaction. Account records
contain the exact native 18-decimal and truncating ERC-20 6-decimal views at one
final block. Transaction records contain the exact transaction/receipt/anchor,
fee, canonical 18-decimal system-emitter movements, optional scaled ERC-20
corroboration, coverage, source identity, and limitations. Raw JSON-RPC payloads
are never stored. The response address/hash must equal the approved request even
when the response is otherwise schema-valid.

Observation capacity is 1,000 and receipt capacity remains 1,000 under the
unchanged combined 6,602-record and backup-size ceilings. Existing crypto,
backup, recovery, rescue, and deletion formats remain unchanged. Deleting a
completed receipt while retaining its observation is rejected; deleting both in
one coherent transaction is allowed.

Freshness is presentation metadata derived locally from the saved observation
time and later matching failed receipts. A failed refresh saves only the failed
receipt and leaves the prior encrypted observation envelope byte-for-byte
unchanged; the UI labels the prior result stale/outage rather than replacing it.
Successful explicit refreshes append independently anchored observations.

## 11. Permission-before-network transaction

All source refreshes use the same flow:

1. User supplies or selects one public identifier.
2. UI shows exact destination split and fields.
3. User confirms.
4. Create `approved` permission receipt in memory.
5. Encrypt and write receipt using expected session revision.
6. Assert the same Vault session.
7. Create/register AbortController.
8. Send the minimum request.
9. Validate response.
   The normalized public identifier must exactly equal the approved identifier.
10. Build source evidence and completed receipt update in memory.
11. Assert session and conditionally write all affected records atomically.
12. Update UI from the committed local result.

On provider failure, update the existing receipt to `failed` when the session is
still active. If the failure update cannot commit, the earlier approved receipt
still truthfully proves that disclosure was authorized and may have been sent.

On post-network local-save failure, copy says the public identifier was sent but
the new result was not saved. Pre-network local-save failure says nothing was
sent.

## 12. Evidence reconciliation in the browser

The API returns source facts. The browser creates private relationships and
conclusions.

Reconciliation function:

```ts
function reconcileAction(input: {
  action: ActionEnvelope;
  evidence: EvidenceRecord[];
  policies: MonitoringPolicy[];
  evaluatedAt: string;
}): ReconciliationResult
```

The function is pure, deterministic, exact, and fully covered by fixtures. It:

- validates every referenced evidence ID exists;
- confirms source authority, action ID, and network match;
- compares exact integer/decimal fields;
- checks authorization nonce and validity;
- checks provider/Gateway/onchain source relationship;
- evaluates local policy without calling it wallet enforcement;
- reports a matched policy as `unevaluable`, never `permitted`, when correlation
  facts are missing;
- emits ordered gaps, conflicts, and limitations;
- never mutates source evidence;
- never makes a network call.

M02 fixture actions are persisted with the deterministic result and policy
evaluation cached for display. Unlock, import, save, and replacement do not
trust that cache: they require same-action citations and agent-linked policies,
recompute from the unresolved action plus stored evidence at the cached
evaluation time, and require an exact result match. A terminal action with a
missing, cross-action, cross-agent, or semantically inconsistent cache fails
closed while its opaque encrypted bytes remain rescuable and deletable.

Presentation preserves the normative distinction:

- `AUTHORIZED` is not rendered as `SETTLED`;
- `SETTLED` is not rendered as `FULFILLED`;
- a disagreement becomes `CONFLICTING_EVIDENCE`, not a source-preference guess;
- a fully matched action becomes `RECONCILED` only under the versioned rule for
  that action type.

## 13. Workspace structure

### Overview

Shows:

- labeled agents and wallets;
- evidence health;
- pending authorization/settlement/reconciliation counts;
- policy exceptions;
- source outage or stale state;
- no fake aggregate health score.

### Agents

Shows owner label separately from wallet, ERC-8004 identity, registry owner,
observer feedback, and validation evidence. Metadata URIs are untrusted text links
with no automatic preview or remote image.

### Activity

Explicit refresh of one approved wallet or transaction. Displays exact source,
anchor, USDC interface/precision, fee, finality, coverage, and limitations.

### Jobs

Displays one fixed-contract ERC-8183 job with roles, budget, expiry, state,
deliverable digest, source, and Testnet reference limitation.

The digest is shown only when an explicitly supplied submission transaction has
a matching anchored event; otherwise it is marked not observed because `getJob`
does not return it. Recorded status, deadline timing, and service quality are
separate concepts. Default zero and explicitly assigned zero budgets remain
distinct. A local action link requires an explicit checkbox and never leaves the
browser, overwrites the action, or asserts matching intent/fulfillment. Permission
receipt v4 must be encrypted before network contact; observation and completed
receipt are saved atomically. Lock, import, replacement, and recovery invalidate
in-flight callbacks. Failed refreshes retain earlier evidence, labeled stale.

### Payments

Displays requirement, authorization metadata, provider response metadata,
Gateway state, and Arc settlement as separate rows. No execution control.

### Policies

Creates local monitoring rules and shows simulated comparison. Each result says
either `LOCAL MONITORING ONLY` or cites exact enforcement evidence.

M08 adds dedicated local agent-report import and monitoring-policy v2 records;
M01 fixture policies remain unchanged. The exact contract and bounds are frozen in
[`08-local-agent-connector.md`](../releases/08-local-agent-connector.md). M08 uses
UTC calendar-day reported-attempt totals, not rolling windows or confirmed spend.
Partial history cannot pass a daily-limit rule. All M08 evaluations are local
monitoring only, with no verified enforcement. Preview/import, comparisons and
service digests perform no network requests. A false-by-default
`VITE_GENERIC_AGENT_IMPORT_ENABLED` flag requires encrypted workspace support.

### Investigations

Searches only decrypted local records plus explicit one-ID source lookup. Shows
expected versus observed, gaps, conflicts, source links, and redacted report.
M09 itself performs no source lookup: existing source panels retain their explicit
consent flow. Its bounded local projection, graph/list parity, default-redacted
JSON export and saved source-history semantics are frozen in
[`09-investigation-operations.md`](../releases/09-investigation-operations.md).
`VITE_INVESTIGATIONS_ENABLED` is false by default and requires the encrypted workspace.

### Sources

Displays API capability manifest, exact provider destination, source revision,
last completed observation, data classes released, stale/outage status, and
feature flags.

### Settings

Lock, storage persistence status, encrypted export/import/recovery/delete,
threat-model limitations, tour restart, build SHA, and documentation links.

## 14. Evidence visualization

The semantic evidence list is the source of truth. It is always rendered and
accessible.

The graph is a progressive enhancement:

```text
policy/mandate -> attempt -> requirement -> authorization
                                   |              |
                                   v              v
                              fulfillment     Gateway
                                   \              /
                                    -> settlement -> reconciliation
```

Graph requirements:

- nodes derive directly from the same sorted records as the list;
- no graph-only conclusion or control;
- color is never the only state channel;
- each node has evidence type, source class, time, and limitation indicator;
- the semantic list exposes every normalized fact represented by the node;
- M01 edges distinguish `chronological evidence sequence`, `signed-field
  comparison`, and `OpenArc-derived field comparison`;
- `signed-field comparison` is neutral presentation: the strict engine may find
  the compared normalized fields equal or conflicting, and the label does not
  claim OpenArc verified a cryptographic signature or digest-to-digest proof;
- `OpenArc-derived field comparison` is likewise not a graph-level conclusion;
  only the cited reconciliation result states match, gap, or conflict;
- keyboard navigation follows chronological order;
- screen-reader equivalent names every edge relationship;
- reduced motion disables animated edges and layout transitions;
- mobile may default to the list and offer graph on demand.

Library decision remains open. Preferred candidates are an accessible reviewed
`@xyflow/react` configuration for node-edge interaction or a small custom SVG
layer over semantic HTML. Any choice requires license, bundle, keyboard,
screen-reader, zoom, reduced-motion, and theme review.

For simple exact charts such as action counts by state, use semantic HTML plus a
small SVG or a reviewed modular library such as Visx. No chart may fabricate time
series or smooth sparse evidence into an implied continuous measurement.

## 15. Styling and motion

The UI follows the OpenArc brand system:

- off-white paper background;
- deep blue structure;
- signal blue facts and active controls;
- horizon gold for attention, not generic decoration;
- high-contrast dark text;
- restrained grain and soft gradients from the logo;
- technical monospace for exact identifiers and source states.

Motion communicates state:

- short route/view transition;
- staggered evidence-node reveal only after committed data;
- gentle graph layout transition;
- clear but non-flashing conflict emphasis;
- no perpetual decorative animation in the workspace;
- `prefers-reduced-motion` disables nonessential movement and preserves all
  content immediately.

GSAP is optional and must pass license and bundle review. Native CSS transitions
are sufficient for MVP.

Custom scrollbars can be used as progressive visual styling, but native scrolling,
keyboard scrolling, touch momentum, high-contrast mode, and platform fallback
must remain intact.

## 16. Accessibility contract

Required from Milestone 01:

- semantic headings and landmarks;
- skip links that move programmatic focus;
- visible focus and logical tab order;
- minimum target sizes for essential controls;
- dialogs with initial focus, trap, Escape behavior, inert background, and focus
  return;
- status communicated with text and icon, not color only;
- exact identifiers have accessible labels and safe copy controls;
- tables have captions and headers;
- graph has complete list equivalent;
- error summary focuses after invalid submit;
- live regions announce completed refresh without reading private values aloud;
- full-document Axe scans including rail, dialogs, tour, locked state, and error
  states;
- manual VoiceOver and keyboard walkthrough before public Testnet beta.

## 17. Privacy-safe presentation

- Addresses and hashes are truncated visually but accessible/copyable on explicit
  action.
- Private labels never appear in document title, URL, query, analytics, browser
  notification, console, or crash report.
- Clipboard actions are explicit and disclose copied field class.
- External links use `noopener noreferrer` and exact approved origins.
- Resource URLs display origin plus local label; full private path remains local
  and collapsed by default.
- No remote image, avatar, metadata, favicon, or embed loads from an evidence URI.
- Error UI uses local error taxonomy, not raw server/provider messages.

## 18. Performance and capacity

Initial bounded workspace targets:

```text
agents                         100
policies                       500
evidence records             5000
action envelopes             1000
workspace settings              1
manifest sentinel               1
encrypted backup               32 MiB maximum
```

Later record kinds receive their own versioned limits when their milestone is
active; their future capacity is not preallocated or implemented in M02.

The exact serialized encrypted archive must remain below the import maximum.
Capacity is checked before every save and again before download. Accepted local
state must always be exportable and importable by the same build.

Large lists use pagination or virtualization without changing semantic ordering.
The graph defaults to one action at a time and has a strict node/edge cap.

## 19. Error and degraded-state copy

Every message answers:

- Was anything sent?
- Was anything saved?
- Is prior evidence unchanged?
- Is retry safe?
- Which evidence remains missing?

Examples:

```text
Pre-network local failure:
"OpenArc could not save the permission receipt. Nothing was sent."

Provider failure:
"The approved public identifier may have reached Arc RPC, but no new source
evidence was accepted. Your prior encrypted evidence is unchanged."

Post-network local failure:
"The source response completed, but OpenArc could not save it locally. The public
identifier was sent; your prior encrypted evidence remains unchanged."

Conflict:
"The cited sources disagree on the recipient. OpenArc did not reconcile this
action."

Locked during request:
No late result or toast is rendered after returning to the locked state.
```

## 20. Frontend test architecture

### Unit tests

- Vault crypto roundtrip, wrong passphrase, tamper, AAD, IV uniqueness, key
  nonextractability, Unicode, and bounds;
- IndexedDB revision conflict, quota rollback, blocked delete, eviction,
  versionchange, and onclose;
- record schema and unknown-kind rejection;
- exact arithmetic, policy evaluation, state machine, correlation, ordering, and
  report redaction;
- API response validation and malicious source/handoff rejection;
- feature availability and direct-view fallback.

### Component tests

- permission modal destination split;
- info bubbles and guide links;
- evidence class/state/limitations;
- error summaries and focus behavior;
- graph/list parity;
- empty, stale, partial, conflict, unsupported, and disabled states.

### Browser tests in Chromium and WebKit

- create -> add fixture -> reload locked -> unlock exact values;
- export -> delete -> import and recovery;
- blocked deletion and cross-tab lock/change/delete;
- delayed source response -> lock -> no write or render;
- receipt save failure -> zero network;
- success -> local quota/conflict -> honest copy and unchanged prior state;
- explicit refresh sends only approved public fields;
- planted cookie absent on credentialless call;
- private canaries absent from requests, console, raw IndexedDB, page title, URL,
  and post-lock DOM;
- full action timeline and graph keyboard path;
- mobile layout, reduced motion, contrast, and minimum action sizes;
- flag-off tab/direct-route fallback with zero route requests.

### Static privacy tests

Vault and feature modules are scanned for forbidden direct use of:

```text
localStorage
sessionStorage
document.cookie
navigator.sendBeacon
WebSocket outside approved source module
fetch outside api/client.ts
wallet signing or transaction APIs
dangerouslySetInnerHTML
remote image URL rendering
```

## 21. Frontend deployment

Vite feature flags are build-time and must be declared as Docker build args and
environment variables. Production defaults are false.

Nginx:

- serves the SPA and exact build marker;
- same-origin proxies API routes;
- verifies HTTPS upstream certificates;
- sets strict CSP with no third-party script, frame, or image origins;
- allows `blob:` only when required for local encrypted download/preview;
- sends no-store for private workspace shell and API responses;
- provides immutable caching only for content-hashed static assets.

The canonical public origin must be frozen before real users create local Vaults,
because IndexedDB is origin-bound and cannot migrate cross-origin automatically.

## 22. Frontend definition of done

A frontend milestone is complete only when:

- shared schemas landed first;
- the enabled navigation matches API capabilities;
- no private field crosses the network boundary;
- every optional network call persists permission before contact;
- all session-bound async work fails closed on lock/replace/delete;
- plaintext is absent from raw storage and post-lock DOM;
- every conclusion has source, time, class, and limitation;
- accessible list and graph agree;
- unit, component, Chromium, WebKit, mobile, Axe, keyboard, and reduced-motion
  gates pass on Node 22;
- exact staging build and API SHA markers match;
- docs and tour describe the enabled build truthfully.

## 23. Frontend prohibited shortcuts

- Persisting a key or passphrase for a "quick unlock" mode.
- Persisting private data in localStorage, sessionStorage, Cache API, URL, or
  unencrypted IndexedDB metadata.
- Rendering a graph without an equivalent semantic list.
- Calling local policy wallet-enforced without source evidence.
- Auto-refreshing on page load, unlock, focus, or interval.
- Using stale imported provider URLs as current links.
- Fetching remote metadata or images from registry records.
- Reusing React editor state across agent, policy, action, or Vault identity.
- Allowing an in-flight request to write after a session boundary.
- Showing raw provider errors or private identifier values in telemetry.
- Enabling a direct route because the component exists when the feature flag is
  false.
