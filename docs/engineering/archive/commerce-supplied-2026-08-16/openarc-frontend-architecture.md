# OpenArc frontend architecture

Status: **normative frontend specification**  
Specification version: **0.2.0-draft**  
Parent: `docs/engineering/openarc-engineering-source-of-truth.md`  
Runtime target: **React, Vite, TypeScript, WebCrypto, IndexedDB**

This document defines the OpenArc public marketplace, authenticated control
room, provider experience, evidence views, wallet handoff, and encrypted local
Vault. It is subordinate to the engineering source of truth.

## 1. Frontend mission

The browser makes the agent economy legible to humans without becoming a wallet
custodian or a sink for private agent data.

It:

- presents the public marketplace for agents, APIs, MCP tools, data, workflows,
  models, and jobs;
- provides operator, provider, and viewer workspaces;
- creates and revokes agent sessions and budget policies;
- shows approval, payment, delivery, settlement, entitlement, and reputation
  states separately;
- prepares explicit wallet handoffs for allowlisted Testnet transactions;
- validates every API response at runtime;
- keeps private notes, aliases, strategy, and optional raw artifacts inside an
  encrypted local Vault;
- presents complete accessible evidence and limitation views;
- aborts and discards private work at every Vault session boundary.

It does not:

- collect or persist wallet private keys, seed phrases, OTPs, or reusable
  signatures;
- silently sign or broadcast transactions;
- persist prompts, private tool inputs, raw outputs, or private deliverables in
  browser caches outside the encrypted Vault;
- claim OpenArc controls wallet activity outside an OpenArc-mediated session;
- present payment as delivery, delivery as acceptance, or settlement as quality;
- fetch arbitrary provider or metadata URLs;
- present proposed ZK, zkTLS, TEE, stealth-address, or account-abstraction work as
  launch functionality.

## 2. Frontend package layout

```text
apps/web/
  src/
    main.tsx
    App.tsx
    app/
      routes.tsx
      availability.ts
      AppShell.tsx
      PublicShell.tsx
      ErrorBoundary.tsx
      session.tsx
    auth/
      AuthProvider.tsx
      Login.tsx
      OrganizationSwitcher.tsx
      RoleGate.tsx
    market/
      MarketPage.tsx
      ListingPage.tsx
      ListingCard.tsx
      CapabilityManifest.tsx
      PriceDisplay.tsx
    profiles/
      AgentProfilePage.tsx
      ProviderProfilePage.tsx
      ReputationPanel.tsx
      IdentityEvidence.tsx
    operator/
      OverviewPage.tsx
      AgentsPage.tsx
      AgentSessionPage.tsx
      BudgetsPage.tsx
      ApprovalsPage.tsx
      ActionsPage.tsx
    provider/
      ProviderOverview.tsx
      ListingsPage.tsx
      ListingEditor.tsx
      ProviderActions.tsx
      ReceiptSubmission.tsx
    payments/
      PurchaseFlow.tsx
      PaymentRequirement.tsx
      WalletHandoff.tsx
      EntitlementPanel.tsx
    jobs/
      JobsPage.tsx
      JobDetail.tsx
      JobComposer.tsx
      JobTransactionHandoff.tsx
    evidence/
      ActionTimeline.tsx
      EvidenceList.tsx
      EvidenceGraph.tsx
      EvidenceDetails.tsx
      SourceLabel.tsx
      LimitationPanel.tsx
    vault/
      types.ts
      crypto.ts
      db.ts
      service.ts
      archive.ts
      session.tsx
      errors.ts
    wallet/
      provider.ts
      chain.ts
      transaction-review.ts
      errors.ts
    api/
      client.ts
      schemas.ts
      query-keys.ts
      errors.ts
    components/
      Dialog.tsx
      Drawer.tsx
      EmptyState.tsx
      StatusBadge.tsx
      ExactValue.tsx
      DataClassBadge.tsx
    styles/
      tokens.css
      global.css
  test/
  public/
  Dockerfile
```

Feature folders may import `packages/shared` and shared components. They cannot
import another feature's internal persistence or credential implementation.

## 3. Route model

### 3.1 Public routes

```text
/                              product overview
/market                        public marketplace
/market/:listingId             public listing and exact active version
/agents/:agentId               public agent profile and inspectable reputation
/providers/:providerId         public provider profile and listings
/jobs/:jobId                   public job facts only when marked public
/docs                          product and integration documentation
/status                        build and source status
/legal                         privacy, terms, and limitations
```

Public pages contain public API fields only. They do not mount authenticated
query clients, wallet providers, private Vault state, or third-party analytics
that can observe protected workspace data.

### 3.2 Authenticated workspace routes

```text
/app/overview
/app/market
/app/agents
/app/agents/:agentId
/app/sessions
/app/budgets
/app/approvals
/app/actions
/app/actions/:actionId
/app/entitlements
/app/jobs
/app/jobs/:jobId
/app/reputation
/app/provider
/app/provider/listings
/app/provider/listings/:listingId
/app/provider/actions
/app/vault
/app/settings
```

Route access is based on authenticated organization membership and role. The UI
is not the authorization source; every API request is checked again server-side.

### 3.3 Navigation rules

- Desktop uses a persistent rail; mobile uses an accessible drawer.
- Organization context is visible on every protected screen.
- Agent, provider, and environment context cannot be changed implicitly.
- Testnet is always visible in the global status area.
- Disabled features may be shown only when useful and must be labeled with their
  exact status: unavailable, planned, or built but disabled.
- Direct routes to disabled or unauthorized features show a bounded explanation,
  not partial data.
- Public and authenticated routes use separate shells and data clients.

## 4. Application state boundaries

The frontend has four distinct state classes:

```text
public server state          catalog and public profiles
protected server state       organization, budgets, sessions, actions, receipts
ephemeral wallet state       connection, pending signature, transaction handoff
local private state          encrypted Vault records and unlocked plaintext
```

These classes never share a persistence mechanism by convenience.

All screens use the canonical shared commerce states. `AUTHORIZED`, `PAID`,
`DELIVERED`, `ACCEPTED`, and `SETTLED` are displayed as separate states and
are never collapsed into a generic success label.

### 4.1 Public and protected server state

- Runtime validation is mandatory before render.
- Protected server state is cached in memory only unless a field has an explicit
  local encrypted-copy feature.
- Query keys include organization and environment.
- Logout, organization change, role change, and session invalidation clear every
  protected query and mutation cache.
- Public catalog cache entries never become a source for protected fields.

### 4.2 Ephemeral wallet state

- Wallet connection is explicit and optional until a transaction handoff.
- Provider objects, signatures, payment payloads, and unsigned transactions are
  not persisted in localStorage, IndexedDB, URL, analytics, or logs.
- A page reload cancels an unsubmitted transaction flow.
- Submitted transaction hashes may be stored as protected server evidence after
  exact user confirmation.

### 4.3 Local private state

The Vault is independent of human login. Logging out locks it. Deleting a cloud
account does not silently delete the local Vault, and deleting the local Vault
does not silently delete required server commerce records. Each deletion flow
states its exact scope.

## 5. Authentication and organization session

The frontend uses the reviewed server authentication flow.

- Browser auth uses secure server sessions, not tokens in localStorage.
- State-changing requests include CSRF protection and exact same-origin behavior.
- Organization membership and role are refreshed after login and before showing
  protected navigation.
- Organization switching clears protected query state and any in-progress
  purchase, approval, or job transaction flow.
- Role loss immediately removes controls and cancels optimistic mutations.
- Agent API credentials are shown once and cannot be recovered from the browser.
- Credential creation requires reauthentication when the server policy requires
  it.

The UI never displays a role-based control merely because a feature flag is on.
Feature availability and authorization must both pass.

## 6. External wallet boundary

OpenArc may request a signature or transaction from a compatible external wallet
without taking custody.

Before any signature request, show:

```text
network and chain ID
asset and exact amount
recipient or contract
function and decoded parameters
listing or job purpose
authorization and policy reference
expiry and nonce when relevant
estimated fee source and limitations
```

Rules:

- only transaction requests returned by an allowlisted backend prepare route may
  enter the wallet handoff;
- the frontend revalidates the returned schema, chain, contract, method, asset,
  amount, and recipient;
- the user must take an explicit confirmation action;
- the wallet performs signing and submission;
- OpenArc does not request seed phrases or private keys;
- unexpected chain change, account change, calldata change, user rejection,
  wallet error, or timeout cancels the flow;
- no automatic retry reopens a wallet prompt;
- a submitted transaction remains `SUBMITTED`, not `SETTLED`, until observed.

For agent-driven transactions, the browser displays the result but does not act
as the agent's signer.

## 7. Encrypted local Vault

The Vault stores private operator context that is not required for shared market,
authorization, settlement, entitlement, or reputation truth.

### 7.1 Record kinds

```text
private_agent_alias
private_provider_alias
private_policy_note
private_action_note
private_resource_label
private_evidence_relationship
private_artifact
private_report_draft
external_disclosure_receipt
workspace_settings
sentinel
```

Do not duplicate full server objects into the Vault. A private record may hold a
canonical server object ID and private annotation.

### 7.2 IndexedDB structure

```text
database: openarc-vault

store vaultMeta
  key: "active"
  value: PublicVaultMeta

store records
  key: opaque UUID
  value: EncryptedEnvelope
```

Public metadata contains only cryptographic bootstrap and schema information. It
contains no organization, agent, provider, wallet, action, policy, note, record
count, or timestamp that reveals user activity.

### 7.3 Cryptographic lifecycle

- AES-256-GCM record encryption;
- fresh random 96-bit IV for every write;
- nonextractable session key after unwrap;
- passphrase-derived wrapping key with versioned reviewed KDF parameters;
- separate high-entropy recovery wrapper;
- canonical AAD binds Vault, record, schema, and key version;
- atomic sentinel verification before unlock;
- revision-checked IndexedDB transactions;
- bounded encrypted export, strict import, recovery, lock, and deletion.

### 7.4 Session invalidation

Every async Vault operation captures `{vaultId, generation, revision}` and an
`AbortSignal`. Lock, logout, workspace replacement, recovery, delete, pagehide,
cross-tab invalidation, database close, or version change advances the generation
and prevents late plaintext writes or renders.

Do not claim guaranteed JavaScript heap erasure.

### 7.5 Permission before external network contact

Any browser call to a provider, connector, metadata origin, or other non-OpenArc
service follows this transaction:

1. Show the exact destination, fields, purpose, credential behavior, and stated
   retention.
2. Create an `external_disclosure_receipt` in memory.
3. Encrypt and commit the receipt with the expected Vault revision.
4. Recheck the active Vault generation.
5. Send only the approved fields.
6. Validate the response and atomically update the receipt outcome when the Vault
   session is still active.

If the receipt cannot be committed, nothing is sent. OpenArc API calls required
for the authenticated marketplace are governed by the account privacy contract;
they do not create a per-request Vault receipt.

## 8. Public marketplace experience

The marketplace supports human browsing and machine-readable capability truth.

### 8.1 Market index

Shows:

- active listings only;
- capability kind;
- provider identity and source-labeled reputation;
- exact USDC pricing model;
- compatible payment and job lanes;
- availability and version;
- evidence and delivery contract summary;
- public limitations.

Filters are derived from bounded server enums. Search does not send private Vault
labels or local history.

### 8.2 Listing detail

Shows:

- listing version and provider;
- human description and machine-readable manifest;
- input/output schema summary without private example payloads;
- price and payment model;
- endpoint origin, not secret paths or credentials;
- receipt and delivery expectations;
- entitlement behavior;
- reputation inputs and disputes;
- terms, privacy summary, status, and limitations.

The purchase action always binds the exact displayed version.

### 8.3 Profile pages

Agent and provider profiles separate:

- OpenArc account or profile facts;
- wallet-link proof;
- ERC-8004 identity facts;
- observer-supplied reputation;
- OpenArc-derived outcome projections;
- disputes and limitations.

No single verification badge collapses these sources.

## 9. Operator control room

### 9.1 Overview

Shows:

- active agents and sessions;
- available, reserved, committed, and released budget amounts;
- pending approvals;
- active and expired grants;
- purchases and jobs by state;
- unsettled, undelivered, disputed, and conflicting actions;
- entitlement state;
- source or worker degradation;
- Testnet and feature availability.

There is no fake global health score.

### 9.2 Agent sessions

Operators can:

- create a scoped session;
- choose agent, environment, capability scope, policy, and expiry;
- copy the one-time credential only at creation;
- view last-used time without raw request history;
- revoke immediately;
- distinguish OpenArc-mediated control from activity observed outside OpenArc.

### 9.3 Budgets

Policy editor fields are exact and bounded:

```text
subject agent
USDC per-action limit
USDC rolling limit and window
allowed listing IDs
allowed provider IDs
approval threshold
validity window
status and revision
```

Private rationale and notes belong in the Vault. The enforceable server policy
contains only the fields needed for authorization.

Budget presentation always separates:

```text
available
reserved
committed
released
expired
```

### 9.4 Approvals

Approval views show the exact listing version, agent, provider, amount, asset,
purpose, policy rule, expiry, and consequence. Approving does not sign a payment;
it allows creation of a scoped grant.

### 9.5 Actions and exceptions

Action detail contains an accessible chronological timeline and complete evidence
list. Exceptions include:

- denied by policy;
- approval waiting or expired;
- payment submitted but unverified;
- paid but not delivered;
- delivered but not accepted;
- settlement pending;
- entitlement missing or revoked;
- conflicting source evidence;
- provider, facilitator, Gateway, Arc, or worker outage.

## 10. Provider experience

Providers can:

- create and version listings;
- validate machine-readable manifests;
- submit endpoint origins for review;
- define price, delivery, receipt, entitlement, availability, and terms behavior;
- publish, pause, and retire listings;
- inspect actions involving their listings;
- introspect grants through the provider API, not by exposing operator policy;
- submit bounded receipts and delivery metadata;
- revoke entitlements when terms allow;
- inspect provider reputation inputs and disputes.

The UI cannot edit a listing version referenced by an existing action. Changes
create a new version.

Provider receipt forms never accept raw prompts or full outputs. They accept only
the normalized fields and artifact digests defined by the listing's receipt
contract.

## 11. Agent profile and reputation presentation

Reputation views show:

- completed and accepted jobs;
- successful paid capability actions;
- refunds, disputes, failed delivery, and unresolved states;
- repeat counterparties and recency when privacy rules allow;
- source coverage and limitations;
- observer and evaluator identity;
- projection rule version.

Every aggregate expands into the contributing signals. The UI labels whether a
signal is onchain, provider-supplied, evaluator-supplied, or OpenArc-derived.

Do not render:

- an objective universal trust score;
- identity verification without a named source;
- provider delivery as independent proof;
- hidden or private evidence as a mysterious score contribution.

## 12. x402 purchase experience

Human-assisted purchase flow:

1. Select an exact listing version and agent.
2. Display price, provider, receipt contract, and policy context.
3. Request authorization from OpenArc.
4. Show denial, approval required, or reserved grant state.
5. If a human wallet payment is required, display the exact external wallet
   handoff.
6. If an agent completes payment directly, observe status without requesting a
   browser signature.
7. Display requirement, authorization, submission, payment, provider delivery,
   entitlement, settlement, and reconciliation separately.
8. Never display provider output unless it arrived directly in the user's
   context or was explicitly saved in the private Vault.

The primary machine flow occurs between agent and provider. The browser is the
control and evidence surface, not the default content proxy.

## 13. ERC-8183 job experience

Job creation captures:

- client and intended provider;
- evaluator;
- exact USDC budget;
- terms digest and human-readable summary;
- expiry;
- deliverable digest rules;
- public/private visibility;
- reviewed contract and network.

The frontend requests a prepared transaction, validates it, shows the decoded
review, and hands it to an external wallet. It then observes the transaction and
job state through the API.

Job detail separates:

```text
terms prepared
wallet rejected
transaction submitted
job created
funded
accepted
delivery referenced
evaluated
settled
refunded
expired
disputed
```

Raw deliverables are not loaded from arbitrary URIs. A digest is not presented as
proof of quality or retrievability.

## 14. Evidence visualization

The semantic evidence list is always the source of truth. A graph is a progressive
enhancement.

```text
listing/version -> policy -> authorization -> payment
                                          |         |
                                          v         v
                                      delivery -> entitlement
                                          |         |
                                          v         v
                                      evaluation -> settlement
                                               \    /
                                           reconciliation
                                                |
                                           reputation signal
```

Requirements:

- graph and list derive from the same validated records;
- no graph-only conclusion or action;
- color is not the only state channel;
- every node exposes source class, state, time, and limitations;
- edges distinguish reported, signed, onchain, provider, evaluator, and
  OpenArc-derived relationships;
- keyboard order is chronological;
- screen-reader equivalents name every relationship;
- reduced motion disables layout and edge animation;
- mobile defaults to the list when space is limited.

## 15. API client and mutation boundary

One client module owns same-origin API calls.

```ts
async function requestOpenArc<TReq, TRes>(input: {
  path: AllowedPath;
  method: AllowedMethod;
  requestSchema: ZodSchema<TReq> | null;
  responseSchema: ZodSchema<TRes>;
  body?: TReq;
  idempotencyKey?: string;
  signal: AbortSignal;
}): Promise<TRes>
```

Rules:

- only allowlisted relative paths;
- request validation before serialization;
- response envelope and DTO validation before render;
- CSRF behavior for cookie-authenticated mutations;
- agent/provider credential management never uses the browser human client;
- no raw body or provider message in console logs;
- mutation retries are off unless the operation is explicitly idempotent;
- organization or auth change aborts in-flight requests;
- non-JSON, redirect, oversized, or malformed responses collapse to bounded
  local errors.

## 16. Privacy-safe presentation

- Private aliases, notes, policy rationale, prompts, artifacts, and relationships
  never appear in URL, page title, analytics, browser notification, console,
  crash report, or public share card.
- Protected pages use no third-party analytics by default.
- Addresses and hashes are visually truncated but available through explicit
  accessible reveal/copy controls.
- Clipboard controls disclose the copied field class.
- Remote agent metadata, avatars, images, and embeds do not load automatically.
- External links use exact displayed origins and `noopener noreferrer`.
- Public share actions include only fields from public schemas.
- Roadmap privacy features are visibly labeled `PROPOSED POST-LAUNCH` until their
  release flag and source-of-truth gate pass.

## 17. Styling and motion

The product uses the established OpenArc system:

- off-white canvas;
- deep navy structure;
- signal blue for facts and active controls;
- cyan for machine flow and connected state;
- lime used sparingly for completed economic loops;
- high-contrast dark text;
- monospace for exact identifiers, amounts, and source states.

Motion communicates state only:

- short route and panel transitions;
- no perpetual decorative motion in protected workspaces;
- no celebratory success animation before settlement is proven;
- conflict and denial are clear without flashing;
- `prefers-reduced-motion` removes nonessential transitions.

## 18. Accessibility contract

Required from the first functional milestone:

- semantic headings, landmarks, and skip links;
- visible focus and logical keyboard order;
- accessible drawers and dialogs with focus management;
- status communicated with text and icon, never color alone;
- exact amounts and identifiers with accessible labels;
- tables with captions and headers;
- graph with complete list equivalent;
- error summaries focused after invalid submissions;
- wallet handoff reviewed without requiring visual-only calldata inspection;
- live regions that announce state changes without reading private values aloud;
- full-page automated accessibility scans;
- manual keyboard and VoiceOver journeys before public alpha.

## 19. Error and degraded-state copy contract

Every state answers:

- Was authorization created?
- Was budget reserved or committed?
- Was a wallet prompt opened?
- Was a transaction submitted?
- Was payment verified?
- Was delivery observed?
- Was an entitlement issued?
- Is retry safe?
- Which source or evidence remains missing?

Examples:

```text
Policy denial:
"OpenArc denied this action under budget policy revision 7. No payment was sent."

Wallet rejection:
"The wallet rejected the transaction. OpenArc did not mark it submitted or paid."

Settlement pending:
"The payment was submitted, but settlement is not yet verified. The reserved
budget remains pending."

Paid but not delivered:
"Payment evidence is complete. Provider delivery evidence is still missing."

Source conflict:
"The cited sources disagree on the recipient. OpenArc did not reconcile this
action."

Vault lock:
No late private result or toast renders after the Vault returns to locked state.
```

## 20. Capacity and performance

Initial server-backed UI targets:

```text
catalog page size                 50
operator agents                  500
active sessions                 1000
budget policies                 2000
actions per paginated query      100
evidence records per action      200
job events per job               200
```

Initial local Vault targets:

```text
private annotations             5000
private artifacts                500
encrypted backup              32 MiB maximum
single private artifact         4 MiB maximum
```

Large lists use pagination or virtualization without changing semantic order.
The evidence graph renders one bounded action at a time.

## 21. Frontend tests

### Unit tests

- runtime schemas and privacy classes;
- exact amount formatting;
- role and feature availability;
- budget and action state presentation;
- listing-version binding;
- wallet transaction validation;
- evidence ordering and reputation expansion;
- Vault crypto, tamper, wrong passphrase, revision, and bounds;
- error redaction.

### Component tests

- market search and listing detail;
- organization and role switching;
- agent session and budget forms;
- approval decision review;
- purchase state progression;
- wallet handoff and rejection;
- job state progression;
- evidence list/graph parity;
- public/protected/local-private field separation;
- empty, stale, partial, conflict, outage, disabled, and unauthorized states.

### Browser tests

- browse market -> login -> create agent session -> assign budget;
- controlled x402 purchase -> receipt -> entitlement -> reconciliation;
- denied and approval-required purchase;
- wallet reject -> no submitted/paid state;
- prepared ERC-8183 job -> external wallet -> observed lifecycle;
- organization switch clears protected state;
- logout locks Vault and clears protected caches;
- Vault create -> annotate -> reload locked -> unlock -> export/import/delete;
- delayed Vault or API response -> lock/logout -> no late private render;
- external disclosure receipt save failure -> zero external provider requests;
- private canaries absent from requests, console, unencrypted storage, title, URL,
  analytics, and post-lock DOM;
- full keyboard, mobile, reduced-motion, contrast, and screen-reader paths.

### Static privacy tests

Feature modules are scanned for forbidden direct use of:

```text
localStorage for protected or private data
sessionStorage for credentials
document.cookie
navigator.sendBeacon in protected routes
fetch outside api/client.ts and approved direct-provider adapters
wallet signing outside wallet/provider.ts
dangerouslySetInnerHTML
remote image rendering from untrusted metadata
```

## 22. Deployment

- Vite feature flags are explicit build arguments and default false.
- Nginx serves the SPA, build marker, and same-origin API proxy.
- Private workspace and authenticated API responses are no-store.
- Public immutable assets use content hashes.
- CSP excludes third-party scripts, frames, and unreviewed image origins.
- The canonical origin is frozen before real users create Vaults because
  IndexedDB is origin-bound.
- Web, API, and worker expose matching build SHA and capability versions.
- Public availability text comes from the API capability manifest, not hardcoded
  marketing claims.

## 23. Frontend definition of done

A frontend milestone is complete only when:

- shared schemas land first;
- public, protected, wallet-ephemeral, and local-private state remain separate;
- role and capability gates match the API;
- no key, raw signature, prompt, private artifact, or private note crosses an
  unapproved boundary;
- wallet handoff validates exact transaction data and never auto-signs;
- every economic conclusion shows state, source, time, and limitations;
- evidence list and graph agree;
- logout and Vault lock clear the correct data without false deletion claims;
- unit, component, browser, mobile, accessibility, and privacy-canary gates pass;
- exact staging SHA matches API and worker;
- public copy matches the enabled Testnet build.

## 24. Prohibited shortcuts

- Storing auth tokens, wallet state, private data, or credentials in localStorage.
- Persisting a Vault key for quick unlock.
- Calling an arbitrary wallet method or contract from component code.
- Accepting a backend-prepared transaction without independent client validation.
- Displaying a payment as delivered or accepted.
- Showing a universal trust badge without inspectable sources.
- Mutating a listing version already referenced by an action.
- Sending private Vault text into market search, analytics, telemetry, or support
  tools.
- Proxying provider prompts or outputs through the OpenArc API for convenience.
- Fetching remote metadata or images from registry records.
- Rendering a graph without an equivalent accessible list.
- Enabling a direct route because the component exists when the feature flag is
  false.
- Labeling a privacy roadmap item as live before its engineering and release gate
  passes.
