# OpenArc engineering source of truth

Status: **normative build specification**
Specification version: **0.2.1-draft**
Prepared: **2026-08-16; Arc facts re-verified 2026-09-03**
Initial target: **Arc Testnet, read-only, non-custodial**

This is the controlling engineering document for OpenArc. It defines what gets
built, which document owns each decision, the system boundaries, the shared
contracts, and the order of implementation.

If another OpenArc document conflicts with this one, this document wins for
engineering scope and sequencing. Arc network facts remain controlled by the
verified network registry in `docs/openarc-technical-spec.md`.

## 1. Document authority

Use this precedence order:

1. `docs/engineering/openarc-engineering-source-of-truth.md`
   - product boundary, architecture, shared contracts, dependencies, build order,
     and release gates.
2. `docs/engineering/openarc-backend-architecture.md`
   - API runtime, routes, adapters, security controls, operations, and backend
     verification.
3. `docs/engineering/openarc-frontend-architecture.md`
   - local Vault, UI state, routes, network consent, visualizations,
     accessibility, and frontend verification.
4. `docs/openarc-technical-spec.md`
   - reviewed Arc Testnet and Circle facts, contract addresses, protocol behavior,
     and mainnet migration inputs.
5. `docs/openarc-product-blueprint.md`
   - product intent and evidence semantics.
6. Marketing, launch, roadmap, and brand documents
   - communication and planning; never implementation authority.

No code change may silently change a normative contract. Change this document
and the relevant backend or frontend document in the same pull request.

## 2. Product boundary

OpenArc is a locally private evidence, policy, and investigation interface for
economic agent activity.

The first complete product:

- creates an encrypted local workspace;
- lets the owner label one Arc Testnet address as an agent wallet;
- records local monitoring policies;
- reads bounded Arc Testnet account, transaction, ERC-8004, and ERC-8183 facts;
- imports or receives bounded agent-reported evidence;
- reconciles one controlled x402/Gateway payment path;
- displays permission, attempt, authorization, fulfillment, and settlement as
  separate evidence states;
- exports, imports, recovers, locks, and deletes the encrypted workspace.

OpenArc does not:

- hold or move funds;
- collect private keys, seed phrases, Circle entity secrets, or OTPs;
- sign or broadcast transactions;
- make cart, checkout, swap, bridge, transfer, or contract-write calls;
- infer hidden model reasoning;
- call a wallet address a verified agent without a named source;
- call observer feedback an objective reputation score;
- persist private workspace data on the server;
- copy Arc Testnet values into a mainnet configuration;
- expose a general public blockchain or agent-data API in the MVP.

## 3. Non-negotiable invariants

### Evidence invariants

- Every conclusion cites one or more evidence records.
- Evidence classes remain distinct: local, signed, agent-reported, provider,
  Gateway, onchain, and OpenArc-derived.
- `AUTHORIZED` is not `SETTLED`.
- `SETTLED` is not `FULFILLED`.
- `FULFILLED` does not prove quality.
- Missing evidence stays missing; the UI cannot infer the missing link.
- Conflicting network, asset, recipient, amount, nonce, validity, action ID,
  transaction, or block evidence fails closed.
- Every derived conclusion records its rule version and input evidence IDs.

### Privacy invariants

- Agent labels, policies, notes, private resource labels, evidence relationships,
  and investigation context persist only inside encrypted local storage.
- Optional network calls occur only after an encrypted permission receipt is
  committed locally.
- If receipt persistence fails, the request is not sent.
- A provider that was attempted remains named even when it fails.
- Lock, delete, import, recovery, and workspace replacement invalidate all
  pending async work before it can write.
- Server logs, metrics, Redis keys, error text, and traces contain no raw wallet
  addresses, transaction hashes from request bodies, payment signatures, private
  URLs, prompts, policy text, or provider response bodies.

### Execution invariants

- OpenArc product code has no signing or broadcasting interface.
- Server adapters are read-only.
- Public RPC and provider URLs are fixed configuration, not user input.
- Mainnet is a separate immutable network definition and false-by-default flag.
- Testnet and mainnet records cannot share a network identifier or capability
  instance.

### Numeric invariants

- Monetary and token values use base-unit integer strings or canonical decimal
  strings.
- JavaScript `number` is forbidden for money, token quantity, gas value, block
  number, nonce, job ID, or agent ID.
- Native Arc USDC 18-decimal values and ERC-20 USDC 6-decimal values are never
  compared before explicit conversion.
- Timestamps are ISO 8601 UTC strings, but onchain ordering uses block number,
  transaction index, and log index because Arc block timestamps can repeat.

## 4. Proposed technology stack

The initial repository is a pnpm TypeScript monorepo:

```text
openarc/
  apps/
    api/                 Fastify API and source adapters
    web/                 React/Vite browser application
  packages/
    shared/              normative schemas, constants, and pure logic
    config/              lint, TypeScript, and test configuration
  e2e/                   Playwright browser journeys
  docs/                  engineering and product records
  scripts/               release, fixture, and verification tooling
```

Chosen baseline:

- Node.js 22 LTS.
- pnpm workspace with a committed lockfile.
- TypeScript strict mode.
- `zod` for runtime schemas shared by API and web.
- Fastify for the API.
- React and Vite for the web application.
- Native IndexedDB and WebCrypto for the local Vault.
- Redis only for abuse limits, provider budgets, and short-lived distributed
  coordination.
- Vitest for unit and contract tests.
- Playwright for Chromium and WebKit journeys; Firefox can be added before public
  beta.
- Docker multi-stage production images with pruned production dependencies.

No relational database is required for MVP user evidence. Do not add Prisma or
Postgres until a separate requirement identifies server-owned data that cannot
remain local.

## 5. Package ownership

### `packages/shared`

This package is the only owner of:

- Arc network constants and capability IDs;
- request and response schemas;
- error codes;
- evidence classes and state-machine values;
- canonical address, integer, decimal, timestamp, and digest utilities;
- deterministic reconciliation and policy-evaluation functions;
- encrypted plaintext record schemas, but not cryptographic implementation;
- feature identifiers and schema versions.

It must not import React, Fastify, Redis, IndexedDB, Node filesystem APIs, provider
SDKs, or environment variables.

### `apps/api`

The API owns:

- environment validation;
- HTTP, Origin, CSRF, CORS, and no-store behavior;
- provider networking and normalization;
- Redis abuse and global-budget controls;
- health, readiness, metrics, and structured logs;
- source capability discovery;
- read-only Arc, registry, job, and optional Gateway adapters.

It cannot own private evidence relationships or user-facing reconciliation.

### `apps/web`

The web application owns:

- the encrypted local Vault and session lifecycle;
- local agent profiles, policies, evidence records, and action envelopes;
- permission receipts;
- client-side policy evaluation and reconciliation;
- all human-facing evidence labels and limitations;
- export, import, recovery, lock, and deletion;
- UI routing, accessibility, and visualizations.

It cannot hold provider API credentials or trust an API response without shared
runtime validation.

## 6. Shared domain contracts

The following contracts are implemented as strict TypeScript and Zod schemas in
`packages/shared`. All string bounds, enums, and array caps are explicit in
code. `openarc.evidence.v1` is intentionally the M01 synthetic-fixture contract;
M03 live-source evidence must introduce a reviewed version instead of silently
changing the meaning of v1.

```ts
type NetworkId = "eip155:5042002";

type EvidenceClass =
  | "local"
  | "signed"
  | "agent_reported"
  | "provider"
  | "gateway"
  | "onchain"
  | "openarc_derived";

type EvidenceState =
  | "PROPOSED"
  | "PERMITTED"
  | "ATTEMPTED"
  | "AUTHORIZED"
  | "FULFILLED"
  | "SETTLING"
  | "SETTLED"
  | "RECONCILED"
  | "DENIED_BY_POLICY"
  | "EXPIRED"
  | "FAILED"
  | "REFUNDED"
  | "CONFLICTING_EVIDENCE"
  | "FULFILLMENT_UNVERIFIED"
  | "SETTLEMENT_UNVERIFIED"
  | "INTENT_NOT_SUPPLIED"
  | "UNSUPPORTED";

interface SourceRef {
  kind: "owner" | "agent_connector" | "provider" | "gateway" |
    "arc_rpc" | "arc_contract";
  sourceId: string;                    // 2..64 bounded source key
  label: string;                       // 1..80
  reference: `fixture:${string}`;      // bounded local fixture reference only
  origin: null;                        // M01 performs no live call
  environment: "synthetic_fixture";
  adapterVersion: "m01.fixture.v1";
  network: NetworkId | null;
}

interface PaymentCorrelation {
  network: NetworkId;
  asset: "0x3600000000000000000000000000000000000000";
  payer: `0x${string}`;
  payTo: `0x${string}`;
  amountBaseUnits: string;             // canonical positive integer, <=78 digits
  authorizationNonce: `0x${string}`;   // lower-case bytes32
  resourceDigest: `sha256:${string}`;
}

interface EvidenceBase {
  schemaVersion: "openarc.evidence.v1";
  evidenceId: `evd_${string}`;         // 32 lower-case hex characters
  actionId: `act_${string}`;           // 32 lower-case hex characters
  class: EvidenceClass;
  source: SourceRef;
  observedAt: string;                  // UTC Z, <=30 chars, <=9 fractional digits
  occurredAt: string | null;           // same bound; cannot follow observedAt
  limitations: string[];               // 1..8, each <=240
}

type EvidenceRecord =
  | EvidenceBase & { evidenceType: "intent"; class: "local" | "signed";
      payload: PaymentCorrelation & { mandateDigest: string } }
  | EvidenceBase & { evidenceType: "attempt"; class: "agent_reported";
      payload: PaymentCorrelation & { connectorEventId: string } }
  | EvidenceBase & { evidenceType: "payment_requirement"; class: "provider";
      payload: PaymentCorrelation & ValidityWindow & { requirementDigest: string } }
  | EvidenceBase & { evidenceType: "authorization"; class: "signed";
      payload: PaymentCorrelation & ValidityWindow & { authorizationDigest: string } }
  | EvidenceBase & { evidenceType: "fulfillment"; class: "provider";
      payload: { resourceDigest: string; providerStatus: "fulfilled" | "failed";
        responseDigest: string | null } }
  | EvidenceBase & { evidenceType: "settlement"; class: "gateway" | "onchain";
      payload: PaymentCorrelation & { transactionHash: string; blockHash: string;
        blockNumber: string; settlementStatus: "pending" | "settled" | "failed" } }
  | EvidenceBase & { evidenceType: "refund"; class: "gateway" | "onchain";
      payload: { originalTransactionHash: string; refundTransactionHash: string;
        amountBaseUnits: string; blockHash: string; blockNumber: string } };

interface ValidityWindow {
  validAfter: string;
  validBefore: string;                 // must be chronologically after validAfter
}

interface StateTransition {
  sequence: number;                    // contiguous 1..16
  state: EvidenceState;
  at: string;                          // UTC Z; epoch-monotonic, fractions allowed
  evidenceIds: `evd_${string}`[];      // <=8; typed by state
}

interface ActionEnvelope {
  schemaVersion: "openarc.action.v1";
  actionId: `act_${string}`;
  agentId: `agent_${string}`;
  kind: "paid_api_request" | "transfer" | "contract_call" | "bridge" | "swap";
  createdAt: string;
  states: StateTransition[];
  intentEvidenceIds: string[];
  attemptEvidenceIds: string[];
  paymentEvidenceIds: string[];
  fulfillmentEvidenceIds: string[];
  settlementEvidenceIds: string[];
  policyEvaluation: PolicyEvaluation | null;
  reconciliation: ReconciliationResult | null;
}
```

M01 relationship lists make evidence role explicit and prevent one record from
appearing under multiple roles. Every non-`PROPOSED` transition cites one or
more records from a state-compatible relationship; `RECONCILED` cites both
fulfilled-provider and settled-payment evidence, and `CONFLICTING_EVIDENCE`
cites at least two records. Exact allowed state edges are exported as
`AllowedActionStateEdges` and exercised pairwise. The reconciliation result,
not each historical transition, carries the derived rule version and every
evidence ID actually used by its conclusion, including external replay evidence.
Reconciliation accepts only unresolved actions whose cached policy evaluation
and reconciliation are both null; stored output is never trusted as engine input.
M01 has no persisted revision because persistence and optimistic revision control
begin in M02.

Source authority is part of validation, not display metadata: owner, connector,
provider, Gateway, and onchain evidence each require their matching source kind;
Gateway/onchain records also require the pinned Arc Testnet network. M01 accepts
only synthetic fixture references and null origins. The semantic browser list
renders every normalized payload field so a person can inspect the exact facts
behind a conflict or gap.

Source time is also evidence: occurrence cannot follow observation, supported
causal stages cannot run backwards, the first `PROPOSED` state equals the action
creation instant, a transition cannot predate the evidence it cites, and the
evaluation cannot predate used observations or the final transition. M01
supports exactly one full refund, linked to a cited settled
transaction with equal base-unit amount and a valid same-or-later block
reference. Any contradiction remains `CONFLICTING_EVIDENCE`.

Conflict output is closed over every accepted bounded input. A conflict may cite
all 64 input records. If more than 16 material conflict groups are derived, the
engine emits one explicit `CONFLICT_SET_OVERFLOW` conflict citing every involved
record rather than truncating details or throwing an untyped schema error.

Local policy evaluation distinguishes `permitted`, `flagged`, `unevaluable`, and
`not_applicable`. A matching policy without a usable payment-correlation record
is `unevaluable`; absence of facts can never be reported as permission.

### Canonical identifiers

Use these canonical forms:

```text
M01 action   act_<32 lower-case hex>
M01 evidence evd_<32 lower-case hex>
M01 policy   pol_<32 lower-case hex>
wallet       eip155:5042002:0x<40 lowercase hex>
transaction  eip155:5042002:tx:0x<64 lowercase hex>
block        eip155:5042002:block:<base-10 integer>:0x<64 lowercase hex>
log          <transaction canonical ID>:log:<base-10 index>
agent        eip155:5042002:erc8004:<base-10 agent ID>
job          eip155:5042002:erc8183:<contract lowercase>:<base-10 job ID>
gateway      gateway:x402:<UUID>
local        openarc:<vault ID>:<opaque UUID>
```

The three M01 identifiers are opaque local container identifiers, not claims
about a live wallet, transaction, block, agent registry entry, or job. The live
subject identifiers below are introduced only with the milestone that observes
their named source.

Checksum casing may be retained as display metadata, but comparison uses the
canonical lowercase address.

## 7. Network configuration contract

Every environment uses an immutable `NetworkConfig` from `packages/shared`:

```ts
interface NetworkConfig {
  key: "arcTestnet" | "arcMainnet";
  environment: "testnet" | "mainnet";
  chainId: string;
  caip2: string;
  rpcOrigin: string;
  webSocketOrigin: string | null;
  explorerOrigin: string;
  nativeFeeAsset: {
    symbol: "USDC";
    internalDecimals: 18;
    displayDecimals: 6;
  };
  contracts: Record<string, string>;
  gatewayDomain: string;
  finality: { kind: "deterministic"; confirmations: 1 };
  sourceRevision: string;
  reviewedAt: string;
}
```

Only `arcTestnet` exists during MVP. `arcMainnet` must not be created with
placeholder or copied values. Unknown config is a build or startup failure.

## 8. API boundary

The initial app-only API surface is:

```text
GET  /healthz
GET  /readyz
GET  /v1/private/capabilities
POST /v1/private/arc/account-snapshot
POST /v1/private/arc/transaction-evidence
POST /v1/private/arc/agent-registry-evidence
POST /v1/private/arc/job-evidence
POST /v1/private/gateway/transfer            optional, flag off by default
```

Common route behavior:

- strict JSON and unknown-key rejection;
- small route-specific body limits;
- one public identifier per request;
- exact production Origin validation;
- `Cache-Control: no-store` on success and errors;
- no account cookie on credentialless source routes;
- request ID returned, but request body omitted from logs;
- shared success and error schemas;
- no raw provider payloads;
- no generic proxy URL, method, contract, or RPC call supplied by the browser.

The full route contract is owned by the backend architecture document.

## 9. Local Vault boundary

The Vault stores encrypted records in one IndexedDB database:

```text
vaultMeta      plain cryptographic bootstrap only
records        opaque ID + IV + key version + ciphertext + revision
```

Encrypted plaintext record kinds:

```text
agent_profile
monitoring_policy
evidence_record
action_envelope
permission_receipt
investigation_note
workspace_settings
sentinel
```

The crypto and lifecycle contract is owned by the frontend architecture
document. Database version, encrypted record schema version, and evidence schema
version are separate values.

Milestone 02 freezes `openarc.wrap-kdf.v1` and `openarc.backup-kdf.v1` as
PBKDF2-HMAC-SHA-256 with independent 128-bit salts and exactly 600,000
iterations. This value followed a 2026-09-02 Chromium/WebKit benchmark recorded
in the M02 release evidence; changing it requires a new KDF/format version. M02
writes only agent profiles, monitoring policies, evidence records, action
envelopes, workspace settings, and the manifest sentinel. Permission receipts
and investigation notes remain reserved for their later milestones.

## 10. Feature flags

Feature flags fail closed and exist on both sides when a server route and UI are
paired.

```text
API_BOUNDARY_ENABLED
VITE_API_BOUNDARY_ENABLED

ARC_OBSERVATION_ENABLED
VITE_ARC_OBSERVATION_ENABLED
SOURCE_PROXY_SECRET (server-only web-to-API trust boundary when observation is enabled)

AGENT_REGISTRY_ENABLED
VITE_AGENT_REGISTRY_ENABLED

AGENT_JOBS_ENABLED
VITE_AGENT_JOBS_ENABLED

GATEWAY_EVIDENCE_ENABLED
VITE_GATEWAY_EVIDENCE_ENABLED

VITE_GENERIC_AGENT_IMPORT_ENABLED
```

Missing is false. The UI must not advertise an unavailable route as functional.
Direct URLs fall back to the nearest enabled workspace. Capabilities returned by
the API are the runtime truth; build flags are the navigation truth. A local-only
feature such as bounded file import has no server flag or route.

## 11. Exact implementation order

The order below is mandatory. A milestone begins only when the previous
milestone's exit gate is recorded. Backend and frontend tasks listed within one
milestone may proceed in parallel after their shared schemas land.

```text
M00 repository
  -> M01 evidence engine
  -> M02 encrypted workspace
  -> M03 API/privacy boundary
  -> M04 Arc account + transaction evidence
  -> M05 ERC-8004 agent evidence
  -> M06 ERC-8183 job evidence
  -> M07 x402 + Gateway evidence
  -> M08 local agent import + policy comparison
  -> M09 investigation operations
  -> M10 public Testnet hardening
  -> M11 separately approved Arc mainnet adapter
```

### Milestone 00 - repository and verification foundation

Build:

- pnpm monorepo structure;
- Node 22 and TypeScript strict configuration;
- lint, typecheck, unit, build, and Playwright commands;
- CI with Redis service and Chromium/WebKit;
- Dockerfiles, deployment marker, health/readiness shells;
- dependency license policy, vulnerability audit, and SBOM job;
- `packages/shared` with primitive schemas and Arc Testnet config.

Exit gate:

- clean install from lockfile;
- all empty-shell gates pass in CI;
- production images start with pruned dependencies;
- API and web expose exact commit markers;
- no mainnet config exists.

Milestone 00 is the sole foundation exception to the universal staging and live
Testnet proof requirements in Section 14. It exposes no product route, makes no
network call, and has no persistent state to validate in a hosted environment.
For M00 only, exact-SHA production-image startup, marker, browser, scan, and SBOM
evidence in hosted CI replace staging deployment and live Testnet proof. This
exception does not permit a public availability claim and does not carry forward
to later milestones.

### Milestone 01 - evidence engine and fixture explorer

Build:

- evidence types and canonical IDs;
- state machine and deterministic reconciliation;
- policy schema and local pure evaluator;
- fixture set for complete, missing, conflicting, expired, failed, and refunded
  actions;
- frontend read-only fixture timeline and accessible evidence list;
- no live source calls.

Exit gate:

- transition matrix tests cover every state;
- malformed, unknown-version, duplicate, and replay fixtures fail closed;
- every rendered conclusion cites evidence IDs and limitations;
- graph is an enhancement over a complete accessible list.

### Milestone 02 - encrypted local workspace

Build:

- Vault creation, unlock, lock, inactivity lock, and feature detection;
- record encryption and revision-checked IndexedDB writes;
- agent profiles, local policies, evidence, and actions;
- backup, import, recovery, and deletion;
- cross-tab lock/change/delete coordination;
- no server persistence.

Exit gate:

- wrong passphrase, tamper, corrupt record, quota, blocked delete, eviction, and
  concurrent revision tests;
- lock invalidates pending async work and clears plaintext UI;
- mixed-record export/delete/import/recovery passes in Chromium and WebKit;
- plaintext canaries are absent from IndexedDB and browser storage.

### Milestone 03 - API shell and privacy boundary

Build:

- Fastify app, environment schema, Origin/CSRF/CORS controls;
- no-store success/error handling;
- provider HTTP client with host pinning, timeouts, body caps, and no redirects;
- Redis HMAC abuse limiter and global daily source budget;
- health, readiness, metrics, retention-free startup, and structured logs;
- capabilities route;
- frontend permission-receipt transaction and typed API client.

Exit gate:

- malformed, oversized, credentialed, cross-origin, rate, budget, Redis outage,
  provider timeout, redirect, and invalid-response tests;
- every enabled attempt consumes the correct limit;
- logs and Redis contain no raw privacy canaries;
- receipt save failure proves zero outbound calls;
- lock during a delayed call proves zero late writes.

M03's frozen implementation boundary:

- `API_BOUNDARY_ENABLED` and `VITE_API_BOUNDARY_ENABLED` default false. When
  enabled, the only functional product route is credentialless
  `GET /v1/private/capabilities`. It returns strict, versioned configuration
  metadata with an empty enabled-connector list and every source feature false.
  Source adapters and live-source evidence records are not implemented early.
- Capability discovery is an explicit unlocked-workspace action, never startup,
  navigation, unlock, focus, or interval work. A locally fixed disclosure names
  the same-origin API and hosting/network metadata it receives. An encrypted
  `openarc_capabilities` receipt is committed before the first request; it has
  no user-entered released fields and no upstream provider destination.
- `openarc.permission-receipt.v1` is a new encrypted record schema, not a change
  to the six frozen `openarc.workspace-record.v1` kinds or M01 evidence v1.
  M03 accepts existing M02 records without rewriting them. A workspace containing
  a receipt fails closed in M02, whose opaque rescue/delete paths remain usable.
  The outer crypto/database/backup formats are unchanged. Receipt capacity is
  1,000, within a combined ceiling of 6,602 records including the sentinel; the
  6,601-entry manifest and 32 MiB backup bounds are not widened.
- Redis is required for enabled source routes, not for the source-disabled
  capabilities shell. M03 nevertheless implements real Redis atomic controls
  and tests them with disposable Redis. There is no in-memory production
  fallback, new managed Redis deployment, or live provider call in M03.
- Missing/null Origin handling, a browser-only custom-header/Fetch-Metadata
  check, conservative socket-peer abuse identity, attempt/subcall accounting,
  metrics authentication, and verified-TLS same-origin proxying are frozen in
  the backend specification before implementation. Consent/session behavior is
  owned by the frontend specification.
- Staging uses the existing disposable web/API services only. It is not a
  permanent-origin, live-source, public-launch, or mainnet approval.

### Milestone 04 - Arc account and transaction observation

Build:

- one-address account snapshot;
- exact block anchor and chain-ID verification;
- native USDC balance and fee normalization;
- transaction plus receipt validation;
- canonical native EIP-7708 movement classification plus ERC-20 corroboration
  without double counting;
- user-visible source, freshness, finality, and limitations;
- explicit refresh only.

Exit gate:

- 18/6 decimal and sub-micro-USDC fixtures;
- same-timestamp block ordering;
- wrong chain, mismatched receipt hash/block, malformed logs, and anchor mismatch;
- outage keeps prior encrypted evidence stale and unchanged;
- live controlled Testnet wallet proof on an exact deployed SHA.

M04's frozen source rule follows the current Arc `USDC system events`
reference. The system emitter at
`0xfffffffffffffffffffffffffffffffffffffffe` emits an 18-decimal `Transfer`
for every USDC balance movement, including movements initiated through the
ERC-20 interface. The ERC-20 contract at
`0x3600000000000000000000000000000000000000` additionally emits its ordinary
6-decimal `Transfer` for ERC-20 calls. OpenArc therefore treats the system event
as the one canonical movement and, when an exact scaled address/amount match is
present, records the ERC-20 event only as corroboration. An unmatched ERC-20
USDC transfer is a source conflict; equal amounts, token symbols, or adjacency
alone are never deduplication rules.

### Milestone 05 - ERC-8004 agent evidence

Build:

- fixed-contract identity, reputation, and validation reads;
- owner-supplied agent label plus source-linked registry identity;
- metadata URI displayed as untrusted external metadata;
- observer-specific feedback and validation presentation;
- no universal score or verification badge.

Exit gate:

- wrong contract, unknown agent, changed owner, malformed metadata URI, self
  feedback, and conflicting validation fixtures;
- UI labels source and observer for every claim;
- no remote metadata fetch without a new consent and content-security review.

### Milestone 06 - ERC-8183 job evidence

Deployed-reference clarification (2026-09-04): `getJob()` does not expose a
deliverable digest. Accept an optional explicit `submissionTransactionHash` on
the job-evidence request and extract only an exact, successful, anchored
`JobSubmitted` event from the fixed reference contract. Without that receipt,
show the digest as not observed. No broad event scanning or external content
fetching. Pin the reviewed EIP-1967 implementation at observation/submission
anchors and validate the fixed USDC payment token. Zero budgets are valid;
deadline timing is separate from recorded status. See
[`06-erc8183-job-evidence.md`](../releases/06-erc8183-job-evidence.md) for the
deployed source review and precise bounds.

Build:

- fixed Testnet reference-contract job reads;
- client, provider, evaluator, budget, expiry, status, and deliverable digest;
- job-to-action linking only with exact local confirmation or signed evidence;
- reference-implementation limitation in UI.

Exit gate:

- every documented job state;
- wrong contract, missing job, invalid budget, expired job, and conflicting local
  description;
- no claim that all Arc agent jobs use ERC-8183 or this deployment.

### Milestone 07 - controlled x402 and Gateway evidence

Implementation contracts are dedicated `openarc.x402-receipt-bundle.v1` and
`openarc.gateway-transfer-observation.v1` schemas, not widened M01 synthetic
evidence. Imported metadata is always `authentication: not_verified`. Permission
receipt v5 releases only network and exact transfer UUID; local bundle associations
are never sent. The strict REST route replaces the unimplemented placeholder
`transfer-evidence` route. Both Gateway flags remain false by default and require
the cumulative M06 capabilities. Detailed boundaries and gates are recorded in
`docs/releases/07-x402-gateway-evidence.md` and `m07-x402-preflight.md`.

Build:

- normalized x402 requirement, authorization metadata, and response metadata;
- controlled test resource and safe resource-origin digest;
- optional Gateway transfer lookup behind server and web flags;
- exact correlation of network, asset, payer, recipient, amount, nonce, validity,
  transfer ID, and onchain evidence;
- no signing inside OpenArc.

Exit gate:

- requirement, signature-metadata, response, received, batched, confirmed,
  completed, failed, replay, expiry, and mismatch fixtures;
- reusable payment signature and paid response body absent from persistence;
- one complete and one intentionally incomplete live Testnet evidence arc;
- provider fulfillment and payment settlement remain separately labeled.

### Milestone 08 - local agent connector and policy comparison

The frozen local-only contracts, bounds, UTC-day attempt-total semantics,
partial-history limitations, unsupported-signature behavior and release evidence
are recorded in [`08-local-agent-connector.md`](../releases/08-local-agent-connector.md).
Dedicated import and policy v2 schemas preserve M01 synthetic contracts. Imported
agent identity/approval are unverified claims; source-proven wallet enforcement
is not available in this milestone. No imported evaluation cache is trusted.

Build:

- bounded local JSON import first;
- optional connector signature verification;
- local per-action, daily, recipient, contract, service, expiry, and approval rules;
- explicit `LOCAL MONITORING ONLY` versus source-proven enforcement;
- imported-event provenance and duplicate detection.

Exit gate:

- unsigned, signed, expired, duplicate, replayed, oversized, future-version, and
  conflicting imports;
- no localhost bridge, webhook, MCP, or public ingest API yet;
- policy evaluation is deterministic and never presented as wallet enforcement
  without evidence.

### Milestone 09 - investigation operations

The active contract, explicit local-only boundaries, projection/export limits and
verification ledger are frozen in
[`09-investigation-operations.md`](../releases/09-investigation-operations.md).
M09 adds no stored record kind; optional notes are omitted. Existing typed evidence
classes remain separate, and redacted export is an explicit plaintext operation.

Build:

- action search and exception inbox;
- expected-versus-observed view;
- evidence graph with accessible chronological equivalent;
- redacted report export and manifest of omitted fields;
- source-health and unresolved-action dashboard;
- optional local-only investigation notes.

Exit gate:

- reports never contain fields marked local-private unless explicitly selected;
- filtering and graph/list results are identical;
- keyboard, screen-reader, mobile, and reduced-motion journeys pass;
- large bounded fixture set remains responsive.

### Milestone 10 - public Testnet hardening

Build:

- permanent product origin;
- operator, legal, privacy, support, security, and status information;
- production monitoring, alerts, budget controls, rollback, and restore evidence;
- independent application-security review;
- exact docs and feature-availability matrix;
- design-partner feedback fixes.

Exit gate:

- full Node 22 release gate;
- exact Git CI and exact staging deployment markers;
- complete browser journey on desktop and mobile;
- load, outage, Redis, budget, rollback, backup, and incident drills;
- no unresolved P0/P1 review finding;
- still Testnet-only and no production-funds claim.

### Milestone 11 - Arc mainnet adapter

This milestone remains blocked until official mainnet parameters and the external
gates in `docs/openarc-technical-spec.md` exist.

Arc has announced a September 16, 2026 public-mainnet launch and was operating a
private mainnet at the September 5 review date. That announcement does not supply
the public RPC, CAIP identifier, explorer, contract registry, or capability
parity needed by this milestone. Milestones 00-10 therefore remain Testnet-only.

It creates a new network config and read-only mode. It does not overwrite
Testnet, enable signing, or make mainnet a default.

## 12. Release mechanics

Each milestone uses one active release branch and immutable release-candidate
tags. The exact mechanics should be scaffolded with the repository, but the
invariants are:

- one active milestone at a time;
- later milestone branches are not created early;
- each milestone begins from updated production `main`;
- every feature is false by default until its own gate passes;
- no staging deploy before the complete local release gate passes;
- exact deployed SHA is visible in API and web;
- evidence-only documentation commits still require exact CI and deployment
  markers before tagging;
- tags are immutable and never reused.

## 13. Definition of ready

A work item is ready only when it has:

- a named milestone;
- shared schema impact identified;
- exact inputs, outputs, caps, and error states;
- privacy release fields and destination;
- local versus server persistence decision;
- source authority and limitation;
- feature flag behavior;
- unit, integration, browser, and live-test evidence expectations;
- no unresolved dependency on a later milestone.

## 14. Definition of done

A milestone is done only when the following requirements apply, except where a
milestone's own exit gate explicitly records a narrower not-applicable case and
its reason:

- implementation and normative docs agree;
- lint, typecheck, unit, integration, build, and required browser suites pass on
  Node 22;
- dependency audit, license policy, image scan, and SBOM pass;
- failure states are tested, not only success;
- privacy canaries are absent from network, logs, metrics, Redis, and plaintext
  storage;
- exact SHA is clean, pushed, deployed to staging, and visible in both services;
- the live controlled Testnet proof and rollback conditions are recorded;
- independent review finds no P0/P1 blocker;
- user-visible claims match the enabled build.

## 15. Decision rules

When a design choice is not covered:

1. Prefer no custody and no execution.
2. Prefer local encrypted storage over server persistence.
3. Prefer explicit user action over background refresh.
4. Prefer one bounded identifier over bulk discovery.
5. Prefer exact source evidence over inferred identity or intent.
6. Prefer omission or `UNSUPPORTED` over a plausible fallback.
7. Prefer a strict allowlist DTO over passing through provider objects.
8. Prefer a false-by-default flag over exposing a partial workflow.
9. Prefer an accessible semantic list as the source of truth over a decorative
   graph.
10. Stop the active milestone when a required current-source, privacy, legal,
    security, or cost condition cannot be satisfied.

## 16. Change-control checklist

Every pull request that changes a normative behavior answers:

- Which section of this source of truth changes?
- Does `packages/shared` change first?
- Does the API release a new field or destination?
- Does the Vault store a new plaintext record kind or schema version?
- Can an older build still unlock, export, and delete the new record?
- Does the feature availability matrix change?
- What new failure state appears?
- Which exact tests prove the privacy and evidence invariants?
- Is a new external term, credential, cost, or approval required?
- Does the marketing sourcebook need a truth update?

## 17. Open decisions

These decisions remain intentionally unresolved until their milestone:

- Final product domain and permanent encrypted-Vault origin.
- Whether authenticated Circle/Gateway transfer lookup is permitted and viable
  under the required account, terms, privacy, and cost boundary.
- Whether raw provider artifacts may be attached locally, or only normalized
  fields plus digests.
- Which visualization library passes accessibility, bundle, license, and styling
  review.
- Whether a connector beyond local file import is justified after design-partner
  testing.
- Operator entity, jurisdiction, security contact, legal review, and independent
  security reviewer.

An unresolved decision cannot be replaced by an implementation assumption.
