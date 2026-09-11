# OpenArc engineering source of truth

Status: **normative build specification**  
Specification version: **0.3.1-draft**  
Prepared: **2026-08-16**  
Amended: **2026-09-11 — human access and account-retention boundary**
Initial target: **Arc Testnet marketplace alpha, non-custodial**

This is the controlling engineering document for OpenArc. It translates the
current product direction into build scope, system boundaries, shared contracts,
implementation order, and release gates.

OpenArc is the confidential commerce layer for AI agents on Arc: a marketplace,
control system, and evidence layer where agents discover capabilities, hire other
agents, move USDC, and build reputation from attributable outcomes.

## 1. Document authority

Use this precedence order:

1. `docs/engineering/openarc-engineering-source-of-truth.md`
   - product boundary, architecture, shared contracts, build order, and release
     gates.
2. `docs/engineering/openarc-backend-architecture.md`
   - API, database, workers, payment coordination, indexing, security, and
     operations.
3. `docs/engineering/openarc-frontend-architecture.md`
   - public marketplace, operator control room, provider experience, local Vault,
     transaction handoff, accessibility, and frontend verification.
4. `docs/openarc-technical-spec.md`
   - reviewed Arc, Circle, x402, ERC-8004, ERC-8183, contract, and network facts.
5. `docs/openarc-product-blueprint.md`
   - longer-form product intent and evidence semantics.
6. Marketing, launch, and brand documents
   - communication context. They do not silently override an engineering
     contract.

No code change may silently change a normative contract. Change this document
and the affected subordinate architecture document in the same pull request.

## 2. Product boundary

OpenArc has four product pillars:

1. **Market** - agents and humans discover agents, paid APIs, MCP tools, data,
   models, workflows, and jobs.
2. **Control** - operators give agents bounded USDC budgets, scoped permissions,
   approvals, expiry, and revocation.
3. **Proof** - OpenArc links intent, authorization, payment, delivery, evaluation,
   settlement, and reputation through source-labeled receipts.
4. **Privacy** - private strategy and sensitive work context remain outside the
   public marketplace and are disclosed only when required.

The first complete Testnet product:

- publishes a curated marketplace catalog;
- creates provider, operator, and agent profiles;
- links compatible agent profiles to ERC-8004 identity and reputation evidence;
- issues scoped agent sessions and enforceable OpenArc authorization grants;
- supports paid capabilities through an x402-compatible payment lane;
- supports outcome-based work through an ERC-8183-compatible job lane;
- records payment, entitlement, delivery, evaluation, settlement, and exception
  receipts;
- exposes an operator control room for budgets, approvals, revocation, and action
  review;
- creates evidence-backed agent and provider track records;
- stores required marketplace and commerce state on the server;
- keeps prompts, raw tool inputs, raw outputs, private notes, private resource
  labels, and wallet keys out of normal server persistence;
- provides an encrypted local Vault for private operator context;
- runs on Arc Testnet only until the mainnet gate passes.

### 2.1 Human access amendment — September 11, 2026

Payment users have a first-class compatible external-wallet connection path.
Wallet sign-in, linking a payment wallet, and granting an agent spending permission
are separate actions; none silently implies another. A team member need not control
the organization's payment wallet merely to view its protected records.

Passkeys are the accepted access method for non-payment account users, without a
required real name, email address or wallet. Passkey accounts still require a
public verification key, credential identifier and minimal account/security state.
They must never be advertised as anonymous or as having zero account-data retention.
The owner accepted this minimum on September 11, alongside an account-free guest
path. Enrollment still requires the auth/security gate and a reviewed relying-party
origin; acceptance of retention is not a claim that login is already deployed.

Public browsing remains account-free. That path creates no server account record
or account credential and does not grant protected team access, shared persistence
or payment authority. This does not promise that hosting/network infrastructure
retains no request logs. Account deletion and required commerce-record retention
are separate, explicitly disclosed policies.

The original supplied specifications remain byte-preserved under
`archive/commerce-supplied-2026-08-16/`. This amendment changes build requirements,
not the current deployment status.

## 3. What OpenArc does not do

OpenArc does not:

- custody USDC or other user funds;
- collect or persist private keys, seed phrases, OTPs, or reusable wallet
  signatures;
- create an OpenArc token for the first product;
- guarantee provider quality, investment returns, or job success;
- claim that payment proves delivery or that delivery proves quality;
- infer hidden model reasoning;
- proxy arbitrary RPC, provider, contract, URL, method, or calldata supplied by a
  browser;
- claim OpenArc guardrails control transactions that bypass OpenArc-mediated
  sessions;
- turn observer feedback into an objective universal reputation score;
- present proposed ZK, TEE, stealth-address, or private-order-flow work as launch
  functionality;
- copy Arc Testnet values into a mainnet configuration.

## 4. Launch scope and post-launch scope

### 4.1 Launch foundation

Launch scope may include:

- Arc Testnet and Arc-native USDC;
- public marketplace discovery;
- organization, provider, and agent accounts;
- API keys and short-lived scoped agent sessions;
- server-enforced budgets for OpenArc-mediated purchases;
- x402 requirements, payment verification, and entitlement issuance;
- ERC-8004 identity, reputation, and validation evidence;
- ERC-8183 job preparation, observation, deliverable references, evaluation, and
  settlement evidence;
- receipt ingestion, reconciliation, exceptions, and evidence-backed reputation;
- encrypted local workspace for private notes and private correlations;
- externally signed wallet transactions with explicit confirmation and no key
  custody by OpenArc.

### 4.2 Proposed post-launch privacy roadmap

The following are research or roadmap items until separately specified, built,
audited, and enabled:

- ZK payment and policy proofs;
- zkTLS receipts for authorized offchain data;
- selective-disclosure agent credentials;
- TEE-protected agent execution and attestations;
- encrypted intents and compatible private routing;
- stealth-address payment patterns;
- account abstraction and scoped session keys;
- proof-carrying transactions.

Each roadmap capability requires its own threat model, source-of-truth change,
feature flag, interoperability review, and release gate.

## 5. Non-negotiable invariants

### 5.1 Custody and execution invariants

- OpenArc never stores private keys or seed phrases.
- Backend services never sign a user transaction.
- A browser may request a signature from an external wallet only after showing
  the exact network, asset, amount, recipient, contract, method, expiry, and
  purpose.
- Agent clients sign with their own key infrastructure outside OpenArc.
- OpenArc may prepare allowlisted transaction data, verify signed payment
  payloads, submit a user-approved payload to an approved facilitator, and observe
  settlement.
- A prepared transaction is not an authorization to change its calldata.
- Unknown contract, method, recipient, asset, chain, or calldata fails closed.

### 5.2 Control invariants

- OpenArc guardrails are enforceable only inside an OpenArc-mediated session or a
  separately proven onchain policy mechanism.
- Every approved action uses a scoped authorization grant with subject, purpose,
  amount, currency, counterparty, expiry, nonce, and idempotency key.
- Budget reservation and budget commitment are atomic.
- Denial, expiry, revocation, and release are first-class states.
- The UI never describes local monitoring or post-hoc observation as prevention.

### 5.3 Evidence invariants

- `AUTHORIZED` is not `PAID`.
- `PAID` is not `DELIVERED`.
- `DELIVERED` is not `ACCEPTED`.
- `SETTLED` does not prove quality.
- Every derived conclusion cites its evidence IDs and rule version.
- Evidence classes remain distinct: local, signed, agent-reported, provider,
  facilitator, Gateway, onchain, evaluator, and OpenArc-derived.
- Missing evidence stays missing.
- Conflicting network, asset, amount, recipient, agent, job, nonce, expiry,
  transaction, block, or deliverable evidence fails closed.
- Provider receipts are claims by the provider unless independently anchored.

### 5.4 Privacy invariants

- Private keys, seed phrases, wallet recovery material, raw x402 payment payloads,
  reusable signatures, prompts, private tool inputs, raw tool outputs, private
  job artifacts, private URLs, and operator notes are excluded from normal server
  persistence.
- The server stores only the minimum commerce fields required to authenticate,
  authorize, settle, reconcile, entitle, and operate the marketplace.
- Private local records remain encrypted at rest in the browser Vault.
- Public, organization-protected, and local-private fields are explicitly labeled
  in shared schemas.
- A browser call to an external provider, connector, or metadata origin requires
  an encrypted local disclosure receipt before contact. If that receipt cannot
  be committed, the external request is not sent.
- Logs, metrics, Redis keys, traces, analytics, and error text contain no raw
  secret, signed payment payload, prompt, deliverable, or high-cardinality wallet
  identifier.
- Optional disclosure occurs only after the user or agent has a clear purpose and
  destination.

### 5.5 Identity and reputation invariants

- An OpenArc profile is not automatically an onchain identity.
- ERC-8004 ownership, metadata, feedback, and validation retain their exact
  source and observer.
- Reputation aggregates are views over attributable signals, not universal truth.
- An agent or provider can inspect which outcomes contributed to a displayed
  track record.
- Deleted or disputed evidence is not silently removed from aggregate history;
  its status changes according to a versioned rule.

### 5.6 Numeric and network invariants

- Money, token amounts, gas, block numbers, nonces, agent IDs, and job IDs use
  integer strings or canonical decimal strings, never JavaScript `number`.
- Native Arc USDC 18-decimal values and ERC-20 USDC 6-decimal views are never
  compared without explicit conversion.
- The launch network is `eip155:5042002`.
- The reviewed Arc Testnet RPC origin is `https://rpc.testnet.arc.io`.
- Network and contract facts come from immutable reviewed configuration.
- Mainnet uses a separate configuration, deployment, database partition, feature
  flag, and public availability statement.

## 6. System roles

```text
operator       human or organization that funds and controls agents
agent          machine client that discovers and purchases capabilities or jobs
provider       seller of an API, MCP tool, dataset, workflow, model, or labor
evaluator      party or mechanism that evaluates a job deliverable
facilitator    approved x402 or Gateway payment verification/settlement service
observer       source that emits identity, reputation, validation, or settlement facts
OpenArc        market, policy, coordination, evidence, and presentation layer
```

One account may act in multiple roles, but permissions and receipts remain
role-specific.

## 7. Proposed repository and runtime

The repository is a pnpm TypeScript monorepo:

```text
openarc/
  apps/
    api/                 Fastify API and commerce coordination
    web/                 React/Vite marketplace and control room
    worker/              indexing, reconciliation, expiry, and projections
  packages/
    shared/              schemas, state machines, exact math, privacy labels
    db/                  migrations, repositories, and transaction helpers
    chain/               Arc clients, event decoding, and reviewed constants
    x402/                 requirements, verification, settlement, and receipts
    contracts/            ABIs, typed transaction preparation, deployment records
    config/               lint, TypeScript, test, and build configuration
  e2e/                    browser and agent-client journeys
  docs/                   product, engineering, security, and release records
  scripts/                fixtures, releases, verification, and operational drills
```

Baseline:

- Node.js 22 and TypeScript strict mode until a separately gated runtime upgrade;
- pnpm with a committed lockfile;
- Zod schemas shared by API, worker, and web;
- Fastify for the API;
- React and Vite for the browser application;
- PostgreSQL for server-owned marketplace and commerce state;
- Redis for rate limits, idempotency, short-lived reservations, and queues;
- IndexedDB and WebCrypto for the local private Vault;
- Vitest for unit and contract tests;
- Playwright for browser journeys;
- Docker multi-stage production images with pruned dependencies.

## 8. Persistence and source-of-truth boundaries

### 8.1 PostgreSQL owns

- accounts, organizations, memberships, and role grants;
- agent and provider profiles;
- ERC-8004 links and last normalized observations;
- listings, versions, pricing, manifests, and availability;
- API credentials as hashes and scoped agent sessions;
- enforceable budget policies and atomic spend counters;
- authorization grants, orders, payment sessions, and idempotency records;
- minimal provider receipts and delivery digests;
- entitlements and revocations;
- job mirrors and chain-observation cursors;
- evidence records that are public or required for shared commerce truth;
- reputation signals, disputes, and versioned projections;
- audit events containing bounded identifiers and no private payloads.

### 8.2 The browser Vault owns

- private aliases and notes;
- private strategy, rationale, and investigation context;
- private cross-source relationships not required for shared settlement;
- private resource labels and URLs;
- raw artifacts a user explicitly chooses to retain locally;
- local report drafts and private annotations;
- optional private copies of normalized receipts.

### 8.3 Arc and approved protocols own

- canonical chain transactions, logs, contract state, and finality;
- ERC-8004 registry facts;
- ERC-8183 job and settlement facts;
- Gateway or facilitator facts controlled by those systems.

OpenArc mirrors and interprets external facts. It never rewrites their source.

## 9. Shared domain contracts

All enums, string bounds, array caps, privacy classes, and state transitions become
strict TypeScript and Zod schemas in `packages/shared`.

```ts
type NetworkId = "eip155:5042002";

type DataClass = "public" | "organization_protected" | "local_private" |
  "secret_ephemeral";

type EvidenceClass =
  | "local"
  | "signed"
  | "agent_reported"
  | "provider"
  | "facilitator"
  | "gateway"
  | "onchain"
  | "evaluator"
  | "openarc_derived";

type CommerceState =
  | "PROPOSED"
  | "DENIED"
  | "AUTHORIZED"
  | "PAYMENT_REQUIRED"
  | "PAYMENT_SUBMITTED"
  | "PAID"
  | "DELIVERY_PENDING"
  | "DELIVERED"
  | "ACCEPTED"
  | "SETTLING"
  | "SETTLED"
  | "RECONCILED"
  | "EXPIRED"
  | "FAILED"
  | "REFUNDED"
  | "DISPUTED"
  | "CONFLICTING_EVIDENCE";

interface ListingVersion {
  listingId: string;
  version: string;
  providerId: string;
  kind: "api" | "mcp_tool" | "data" | "model" | "workflow" | "agent";
  manifest: Record<string, unknown>;
  price: { asset: "USDC"; atomicAmount: string; pricingModel: string };
  evidenceContract: { receiptType: string; deliveryFields: string[] };
  status: "draft" | "active" | "paused" | "retired";
}

interface BudgetPolicy {
  policyId: string;
  organizationId: string;
  subjectAgentId: string;
  perActionLimit: string | null;
  rollingLimit: string | null;
  rollingWindowSeconds: string | null;
  allowedListingIds: string[];
  allowedProviderIds: string[];
  expiresAt: string | null;
  revision: string;
}

interface AuthorizationGrant {
  grantId: string;
  sessionId: string;
  actionId: string;
  policyRevision: string;
  listingVersion: string;
  asset: "USDC";
  atomicAmount: string;
  recipient: string;
  nonce: string;
  expiresAt: string;
  status: "reserved" | "committed" | "released" | "expired" | "revoked";
}

interface EvidenceRecord {
  schemaVersion: "openarc.evidence.v2";
  evidenceId: string;
  actionId: string;
  evidenceClass: EvidenceClass;
  sourceId: string;
  subject: { kind: string; canonicalId: string };
  occurredAt: string | null;
  observedAt: string;
  digest: string;
  normalized: Record<string, unknown>;
  limitations: string[];
  dataClass: Exclude<DataClass, "secret_ephemeral">;
}

interface CommerceAction {
  schemaVersion: "openarc.action.v2";
  actionId: string;
  organizationId: string;
  agentId: string;
  providerId: string | null;
  listingVersion: string | null;
  jobId: string | null;
  actionType: "x402_purchase" | "agent_job" | "entitlement_use" | "other";
  state: CommerceState;
  authorizationGrantId: string | null;
  evidenceIds: string[];
  reconciliationRuleVersion: string;
  createdAt: string;
  updatedAt: string;
}
```

## 10. Canonical identifiers

```text
organization  openarc:org:<opaque UUID>
agent         openarc:agent:<opaque UUID>
erc8004       eip155:5042002:erc8004:<base-10 agent ID>
provider      openarc:provider:<opaque UUID>
listing       openarc:listing:<opaque UUID>:<version>
action        openarc:action:<opaque UUID>
entitlement   openarc:entitlement:<opaque UUID>
transaction   eip155:5042002:tx:0x<64 lowercase hex>
job           eip155:5042002:erc8183:<contract lowercase>:<base-10 job ID>
gateway       gateway:<environment>:<opaque transfer ID>
```

Wallet addresses use lowercase canonical comparison and may retain checksum
casing only as display metadata.

## 11. API surfaces

The initial API is split by trust and audience:

```text
/healthz                      liveness
/readyz                       readiness
/v1/public/*                  catalog, public profiles, public reputation views
/v1/auth/*                    human session and credential lifecycle
/v1/operator/*                organizations, budgets, agents, approvals, actions
/v1/agent/*                   scoped discovery, authorization, status, entitlements
/v1/provider/*                listings, availability, receipts, delivery metadata
/v1/payments/*                x402 coordination and settlement observation
/v1/jobs/*                    ERC-8183 preparation and observation
/v1/evidence/*                bounded receipt and evidence access
```

Public, operator, agent, and provider schemas are separate. A field becoming
public requires an explicit shared-schema and privacy review.

## 12. Smart-contract and wallet boundary

- Launch may integrate reviewed ERC-8004 and ERC-8183 contracts on Arc Testnet.
- OpenArc-owned contracts are not required for the first x402 purchase loop.
- Any OpenArc contract must live in `packages/contracts`, include a threat model,
  tests, deployment manifest, verification record, pause/upgrade decision, and
  independent review before being enabled.
- Backend endpoints may prepare typed, allowlisted transaction requests.
- The browser or agent signer performs signing and submission.
- OpenArc observes the transaction by hash and waits for the exact required final
  state before updating shared commerce truth.
- Account abstraction and session-key contracts are post-launch until separately
  approved.

## 13. Feature flags

Flags default false and exist on every surface that exposes a paired capability.

```text
MARKETPLACE_ENABLED
AGENT_SESSIONS_ENABLED
BUDGET_AUTHORIZATIONS_ENABLED
X402_PURCHASES_ENABLED
GATEWAY_NANOPAYMENTS_ENABLED
ERC8004_IDENTITY_ENABLED
ERC8183_JOBS_ENABLED
EVIDENCE_REPUTATION_ENABLED
LOCAL_PRIVATE_VAULT_ENABLED
ZK_PROOFS_ENABLED
ZKTLS_ENABLED
TEE_EXECUTION_ENABLED
STEALTH_PAYMENTS_ENABLED
ACCOUNT_ABSTRACTION_ENABLED
ARC_MAINNET_ENABLED
```

UI availability must agree with API capabilities. A compiled component is not a
released feature.

## 14. Implementation order

```text
M00 repository and verification foundation
  -> M01 shared domain, PostgreSQL, auth, and audit foundation
  -> M02 marketplace catalog, providers, and agent profiles
  -> M03 agent sessions, budget policies, and authorization grants
  -> M04 x402 purchase, entitlement, and provider receipt loop
  -> M05 evidence graph, reconciliation, and operator control room
  -> M06 ERC-8004 identity and evidence-backed reputation
  -> M07 ERC-8183 job preparation, observation, and settlement
  -> M08 encrypted private Vault and private operator context
  -> M09 public Testnet alpha hardening
  -> M10 separately gated confidential-compute roadmap items
  -> M11 separately approved Arc mainnet deployment
```

### M00 - repository foundation

Build the monorepo, shared configuration, CI, Docker images, health markers,
testing shells, dependency policy, SBOM, and immutable Arc Testnet registry.

Exit: clean install, strict typecheck, lint, unit, build, image, and empty browser
journeys pass from the committed lockfile.

### M01 - domain, persistence, and authentication

Build shared schemas and state machines first, then PostgreSQL migrations,
repositories, human auth, organizations, memberships, hashed API credentials,
Redis idempotency, and bounded audit events.

Exit: migration up/down tests, tenant isolation, credential rotation, exact money
math, privacy-class tests, and replay/idempotency suites pass.

### M02 - marketplace and profiles

Build provider profiles, agent profiles, listings, manifest versions, price
models, availability, public catalog, and admin moderation.

Exit: only active immutable listing versions can be purchased; provider ownership,
publishing, retirement, and public-field privacy tests pass.

### M03 - sessions and control

Build scoped agent sessions, budget policies, reservations, authorization grants,
approval queues, expiry, revocation, and operator views.

Exit: atomic concurrency tests prove no overspend; bypassed actions are labeled
uncontrolled; revoked and expired grants cannot commit.

### M04 - x402 purchase loop

Build payment requirements, direct agent-to-provider handoff, ephemeral signed
payment verification, settlement observation, provider receipts, entitlements,
refund states, and one controlled Testnet capability.

Exit: one complete and one intentionally incomplete live Testnet action pass;
payment payloads and private tool content are absent from storage and logs.

### M05 - evidence and control room

Build action timelines, source-labeled evidence, exceptions, reconciliation,
operator search, and export of bounded reports.

Exit: paid/delivered/accepted/settled distinctions survive every fixture;
conflicts fail closed; every conclusion cites evidence.

### M06 - identity and reputation

Build ERC-8004 observation, profile linking, observer-specific signals, outcome
projections, disputes, and inspectable reputation views.

Exit: no profile claims universal verification; every aggregate can be expanded to
its contributing signals and limitations.

### M07 - agent jobs

Build ERC-8183 job transaction preparation, external signing handoff, chain
observation, deliverable digests, evaluation, settlement, refund, and dispute
states.

Exit: all supported job states and wrong-network, wrong-contract, timeout,
duplicate, reorg/conflict, and failed-wallet journeys pass.

### M08 - encrypted private Vault

Build local encryption, private aliases, notes, raw-artifact opt-in, export,
import, recovery, lock, deletion, and cross-tab invalidation.

Exit: plaintext canaries are absent from storage, network, logs, analytics, and
post-lock DOM in supported browsers.

### M09 - public Testnet alpha

Complete security review, accessibility, incident drills, budget drills, provider
outage handling, privacy documentation, feature matrix, exact deployment markers,
and design-partner fixes.

Exit: no unresolved P0/P1 issue; production-funds and mainnet claims remain off.

### M10 - confidential-compute roadmap

Each ZK, zkTLS, TEE, selective-disclosure, encrypted-intent, stealth-address,
session-key, or proof-carrying feature becomes its own sub-milestone.

Exit: threat model, prototype, interoperability proof, independent review, user
disclosure, and exact feature flag pass for that capability only.

### M11 - Arc mainnet

Blocked until official mainnet parameters, contracts, provider support, legal and
security reviews, and production operational gates exist. Mainnet never reuses a
Testnet config or deployment record.

## 15. Definition of ready

A work item is ready only when it has:

- a named milestone and owner;
- shared schema and privacy-class impact;
- exact inputs, outputs, caps, and state transitions;
- server, local, chain, or ephemeral persistence decision;
- source authority and limitations;
- feature-flag behavior;
- authorization and tenant-isolation behavior;
- failure, retry, idempotency, and reconciliation expectations;
- unit, integration, browser, contract, and live-test evidence where applicable;
- no unresolved dependency on a later milestone.

## 16. Definition of done

A milestone is done only when:

- implementation and normative docs agree;
- database migrations and rollback tests pass;
- lint, typecheck, unit, contract, integration, build, and required browser suites
  pass;
- dependency audit, license policy, image scan, and SBOM pass;
- authorization, privacy, concurrency, replay, timeout, outage, and conflict
  states are tested;
- exact build SHA is deployed and visible across web, API, and worker;
- logs, metrics, traces, Redis, and storage pass privacy canaries;
- live controlled Testnet proof is recorded when the milestone touches Arc;
- no unresolved P0/P1 review issue remains;
- user-visible claims match the enabled build.

## 17. Decision rules

When a decision is not covered:

1. Prefer non-custodial coordination over custody.
2. Prefer direct agent-to-provider data flow over proxying private payloads.
3. Prefer minimum server persistence over convenience copies.
4. Prefer exact source evidence over inferred identity, intent, delivery, or
   quality.
5. Prefer atomic reservation and idempotency over optimistic budget math.
6. Prefer immutable listing and policy versions for completed actions.
7. Prefer explicit failure states over a generic success badge.
8. Prefer false-by-default flags over exposing partial workflows.
9. Prefer an accessible chronological view over a decorative evidence graph.
10. Stop release when custody, authorization, privacy, payment, contract, legal,
    security, or cost boundaries are unresolved.

## 18. Change control

Every normative change answers:

- Which product pillar changes: Market, Control, Proof, or Privacy?
- Which shared schema and state machine changes first?
- Does the server persist a new field or receive a new secret?
- Does the browser Vault store a new record kind?
- Does an external source, wallet, facilitator, or contract receive new data?
- Can an older client interpret, export, and delete the new state?
- What concurrency, replay, timeout, and conflict cases are new?
- Which feature matrix and public product claim changes?
- Does the marketing brief require a product-truth update?

## 19. Open decisions

- Human authentication provider and recovery model.
- Exact provider verification and moderation policy.
- Whether Gateway nanopayments are enabled in the first public alpha or a later
  Testnet milestone.
- Which ERC-8183 deployment is used for the first controlled job flow.
- Whether provider delivery artifacts stay direct-only or support optional
  end-to-end encrypted object storage.
- Exact reputation projection formulas and dispute windows.
- Whether the public catalog requires server rendering before beta.
- Final canonical origin for the browser Vault.
- Operator entity, jurisdiction, security contact, legal review, and independent
  security reviewer.

An unresolved decision cannot be replaced by a silent implementation assumption.
