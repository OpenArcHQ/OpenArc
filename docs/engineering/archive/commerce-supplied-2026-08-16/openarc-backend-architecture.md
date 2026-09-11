# OpenArc backend architecture

Status: **normative backend specification**  
Specification version: **0.2.0-draft**  
Parent: `docs/engineering/openarc-engineering-source-of-truth.md`  
Runtime target: **Node.js 22, TypeScript, Fastify, PostgreSQL, Redis**

This document defines the OpenArc API, worker, persistence, payment
coordination, and source-adapter implementation. It is subordinate to the
engineering source of truth.

## 1. Backend mission

The backend is the shared market and commerce control plane for OpenArc.

It:

- serves the public catalog and public profile views;
- authenticates human, provider, and agent clients;
- stores server-owned marketplace and commerce records;
- enforces tenant, role, session, policy, budget, expiry, and idempotency rules;
- issues scoped authorization grants for OpenArc-mediated actions;
- coordinates x402 payment verification without owning wallet keys;
- prepares allowlisted ERC-8183 transaction requests for external signing;
- observes Arc, Gateway, facilitator, provider, and evaluator evidence;
- issues and revokes entitlements;
- reconciles actions into source-labeled states;
- projects inspectable reputation from attributable outcomes;
- returns versioned DTOs with explicit privacy class and limitations.

It does not:

- custody funds or store wallet private keys;
- sign a user payment or contract transaction;
- persist raw x402 payment signatures after the request completes;
- persist prompts, private tool inputs, raw outputs, private job artifacts, or
  operator notes in normal server tables;
- proxy arbitrary provider data by default;
- accept arbitrary RPC URLs, provider URLs, contracts, methods, or calldata;
- claim to control wallet actions that bypass OpenArc-mediated authorization;
- turn provider claims into objective facts without source labels.

## 2. Service and package layout

```text
apps/
  api/
    src/
      app.ts
      server.ts
      config/
        env.ts
        network.ts
        features.ts
      http/
        auth.ts
        errors.ts
        origin.ts
        no-store.ts
        request-id.ts
        schemas.ts
      routes/
        health.ts
        public.ts
        auth.ts
        operator.ts
        agent.ts
        provider.ts
        payments.ts
        jobs.ts
        evidence.ts
      auth/
        human-session.ts
        agent-credentials.ts
        provider-credentials.ts
        authorization.ts
      marketplace/
        listings.ts
        manifests.ts
        profiles.ts
        moderation.ts
      control/
        budgets.ts
        reservations.ts
        grants.ts
        approvals.ts
      payments/
        x402.ts
        gateway.ts
        entitlements.ts
        receipts.ts
      jobs/
        erc8183.ts
        transaction-preparation.ts
        mirrors.ts
      identity/
        erc8004.ts
        linking.ts
      evidence/
        records.ts
        reconciliation.ts
        reputation.ts
      arc/
        rpc-client.ts
        anchors.ts
        events.ts
        usdc.ts
      ops/
        logging.ts
        metrics.ts
        health.ts
        readiness.ts
  worker/
    src/
      main.ts
      queue.ts
      outbox.ts
      arc-indexer.ts
      settlement-observer.ts
      reconciliation-worker.ts
      entitlement-expiry.ts
      reputation-projector.ts

packages/
  shared/
  db/
  chain/
  x402/
  contracts/
```

Provider and chain modules may import shared packages. Shared packages cannot
import application modules.

## 3. Runtime topology

Initial services:

```text
web        browser application and static assets
api        request/response control plane
worker     queued and chain-observation work
postgres   durable marketplace and commerce state
redis      rate limits, idempotency, reservations, and queue coordination
```

Normal capability content flows directly between agent and provider whenever
possible:

```text
agent -> OpenArc: request scoped authorization
OpenArc -> agent: one-use opaque grant
agent -> provider: grant + provider request + external payment payload
provider -> OpenArc: introspect grant and submit minimal receipt
provider/facilitator -> Arc: settlement
worker -> sources: observe settlement and normalize evidence
OpenArc -> operator/agent: action, entitlement, and reputation state
```

OpenArc is the control plane, not the default prompt/output data plane. A future
OpenArc-hosted provider adapter is a separate capability with explicit retention
and privacy terms.

## 4. Boot sequence

The API starts in this order:

1. Parse and validate environment variables.
2. Load immutable Arc Testnet and contract configuration.
3. Validate every external origin and path allowlist.
4. Connect to PostgreSQL and verify the migration version.
5. Connect to Redis and load atomic scripts.
6. Initialize credential hashing, session, and grant-key material.
7. Create Arc, facilitator, Gateway, and registry clients for enabled features.
8. Register no-store, request ID, security, logging, auth, error, and rate hooks.
9. Register health and readiness routes.
10. Register feature routes only when their dependencies and flags are ready.
11. Start listening.

The worker starts only after database, Redis, queue, and enabled source adapters
are ready. A worker with stale migrations must refuse work.

Production startup fails when:

- the public app origin is not one exact HTTPS origin;
- database migrations are missing, ahead, or partially applied;
- Redis is unavailable for a feature that requires atomic reservation;
- Arc chain ID or reviewed RPC origin differs from configuration;
- an enabled provider or facilitator origin is not allowlisted;
- a required secret is missing, too short, or reused;
- Testnet and mainnet configuration are mixed;
- a feature is enabled without its required dependency.

## 5. Environment contract

The concrete schema lives in `apps/api/src/config/env.ts`.

```text
NODE_ENV                          development | test | production
PORT                              positive integer
APP_ORIGIN                        exact HTTPS origin in production
API_PUBLIC_ORIGIN                 exact HTTPS origin
BUILD_SHA                         full deployed commit marker
LOG_LEVEL                         bounded enum

DATABASE_URL                      required
REDIS_URL                         required
SESSION_SECRET                    32+ bytes
AGENT_CREDENTIAL_PEPPER           32+ bytes, unique
GRANT_TOKEN_PEPPER                32+ bytes, unique
METRICS_TOKEN                     32+ bytes, unique

ARC_TESTNET_RPC_URL               exact https://rpc.testnet.arc.io
ARC_TESTNET_EXPLORER_URL          reviewed explorer origin
ARC_EXPECTED_CHAIN_ID             5042002

MARKETPLACE_ENABLED               false by default
AGENT_SESSIONS_ENABLED            false by default
BUDGET_AUTHORIZATIONS_ENABLED     false by default
X402_PURCHASES_ENABLED            false by default
GATEWAY_NANOPAYMENTS_ENABLED      false by default
ERC8004_IDENTITY_ENABLED          false by default
ERC8183_JOBS_ENABLED              false by default
EVIDENCE_REPUTATION_ENABLED       false by default

X402_FACILITATOR_ORIGIN           fixed approved origin when enabled
X402_FACILITATOR_CREDENTIAL       server-only when required
GATEWAY_API_ORIGIN                fixed approved origin when enabled
GATEWAY_API_KEY                   server-only when required

SOURCE_TIMEOUT_MS                 bounded
SOURCE_MAX_RESPONSE_BYTES         bounded per adapter
SOURCE_MAX_SUBCALLS               bounded per route
REQUESTS_PER_PRINCIPAL_HOUR       bounded positive integer
GLOBAL_SOURCE_UNITS_PER_DAY       bounded positive integer
```

No server credential may be exposed through `VITE_` variables, DTOs, logs,
metrics, traces, health detail, or error messages.

## 6. Authentication and authorization

### 6.1 Human sessions

- Use one reviewed authentication provider or a first-party passwordless flow.
- The API stores a server session identifier in a `Secure`, `HttpOnly`,
  `SameSite=Lax` cookie.
- State-changing browser routes require exact Origin and CSRF validation.
- Session rotation occurs after login, privilege change, and recovery.
- Organization membership and role are resolved server-side on every protected
  request.

Human roles:

```text
owner
operator
provider_admin
provider_developer
viewer
```

### 6.2 Agent credentials

- Long-lived agent API credentials are shown once.
- PostgreSQL stores only a versioned password hash plus a non-secret key prefix.
- Credentials have organization, agent, environment, and maximum-scope bindings.
- A credential exchanges for a short-lived session token.
- Session tokens contain no secret budget policy text and can be revoked.
- Every agent request is tenant-scoped and rate-limited.

### 6.3 Provider credentials

Provider credentials are separate from agent credentials and can only manage or
service listings owned by that provider. A provider credential cannot approve an
operator budget or read another provider's private receipts.

### 6.4 Authorization grants

An approved purchase creates a one-use opaque grant token:

- the raw token is returned once and never logged;
- PostgreSQL stores only its hash;
- the grant binds session, action, listing version, provider, asset, atomic
  amount, expiry, nonce, policy revision, and idempotency key;
- provider introspection returns only the minimum fields needed to service the
  action;
- revocation and expiry fail closed;
- successful commit consumes the grant exactly once.

## 7. HTTP contract

Every authenticated, mutation, payment, job, evidence, and control response
includes:

```text
Cache-Control: no-store
Pragma: no-cache
X-Content-Type-Options: nosniff
Referrer-Policy: no-referrer
X-OpenArc-Request-Id: <opaque UUID>
```

Public catalog GET responses may replace the no-store headers with bounded public
caching only after an explicit privacy review. All other responses remain
no-store.

Success envelope:

```json
{
  "ok": true,
  "data": {},
  "meta": {
    "schemaVersion": "openarc.api.v2",
    "requestId": "opaque-uuid",
    "buildSha": "full-commit-sha"
  }
}
```

Error envelope:

```json
{
  "ok": false,
  "error": {
    "code": "BUDGET_LIMIT_EXCEEDED",
    "message": "This action exceeds the active OpenArc budget policy.",
    "retryable": false
  },
  "meta": {
    "schemaVersion": "openarc.api.v2",
    "requestId": "opaque-uuid",
    "buildSha": "full-commit-sha"
  }
}
```

Errors never echo raw credential, payment payload, provider body, prompt,
deliverable, private URL, cookie, wallet signature, or stack trace.

Core error codes:

```text
FEATURE_DISABLED
UNAUTHENTICATED
FORBIDDEN
TENANT_MISMATCH
INVALID_ORIGIN
CSRF_REJECTED
INVALID_REQUEST
UNSUPPORTED_MEDIA_TYPE
REQUEST_TOO_LARGE
RATE_LIMITED
IDEMPOTENCY_CONFLICT
LISTING_NOT_ACTIVE
LISTING_VERSION_MISMATCH
POLICY_DENIED
APPROVAL_REQUIRED
BUDGET_LIMIT_EXCEEDED
BUDGET_RESERVATION_CONFLICT
GRANT_EXPIRED
GRANT_REVOKED
GRANT_ALREADY_USED
PAYMENT_REQUIRED
PAYMENT_INVALID
PAYMENT_UNVERIFIED
SETTLEMENT_PENDING
SOURCE_UNAVAILABLE
SOURCE_WRONG_NETWORK
SOURCE_CONFLICT
RECEIPT_MALFORMED
DELIVERY_UNVERIFIED
JOB_STATE_CONFLICT
INTERNAL_ERROR
```

## 8. Route families

### Health and capabilities

```text
GET /healthz
GET /readyz
GET /v1/public/capabilities
```

`/healthz` is process liveness. `/readyz` checks required database, Redis,
migration, queue, and enabled-adapter readiness without consuming metered source
budget on every probe.

### Public marketplace

```text
GET /v1/public/listings
GET /v1/public/listings/:listingId
GET /v1/public/providers/:providerId
GET /v1/public/agents/:agentId
GET /v1/public/reputation/:subjectType/:subjectId
```

Responses contain public fields only, identify the exact listing/profile version,
and never include private pricing overrides, organization policy, internal notes,
raw receipts, or non-public wallet relationships.

### Operator control

```text
GET    /v1/operator/overview
GET    /v1/operator/agents
POST   /v1/operator/agents
GET    /v1/operator/budgets
POST   /v1/operator/budgets
PATCH  /v1/operator/budgets/:policyId
POST   /v1/operator/sessions
POST   /v1/operator/sessions/:sessionId/revoke
GET    /v1/operator/approvals
POST   /v1/operator/approvals/:approvalId/decision
GET    /v1/operator/actions
GET    /v1/operator/actions/:actionId
```

### Agent commerce

```text
GET  /v1/agent/catalog
GET  /v1/agent/listings/:listingId
POST /v1/agent/authorizations
GET  /v1/agent/actions/:actionId
POST /v1/agent/actions/:actionId/cancel
GET  /v1/agent/entitlements
GET  /v1/agent/entitlements/:entitlementId
```

### Provider operations

```text
GET    /v1/provider/listings
POST   /v1/provider/listings
POST   /v1/provider/listings/:listingId/versions
POST   /v1/provider/listings/:listingId/publish
POST   /v1/provider/listings/:listingId/pause
POST   /v1/provider/grants/introspect
POST   /v1/provider/actions/:actionId/receipts
POST   /v1/provider/actions/:actionId/delivery
POST   /v1/provider/entitlements/:entitlementId/revoke
```

### Payment and job coordination

```text
POST /v1/payments/x402/requirements
POST /v1/payments/x402/observe
GET  /v1/payments/:paymentId

POST /v1/jobs/prepare-create
POST /v1/jobs/prepare-fund
POST /v1/jobs/prepare-accept
POST /v1/jobs/prepare-deliver
POST /v1/jobs/prepare-evaluate
POST /v1/jobs/prepare-settle
POST /v1/jobs/observe
GET  /v1/jobs/:jobId
```

Prepare routes return allowlisted typed transaction requests. They do not sign or
broadcast.

## 9. Marketplace model

Listings are immutable by version. A purchase binds one exact version.

Required listing fields:

```text
listing ID and version
provider ID
kind: api | mcp_tool | data | model | workflow | agent
public title and bounded description
capability manifest and input/output schema digest
pricing model and exact USDC amount
provider endpoint origin and reviewed path contract
supported payment lane
receipt contract and delivery fields
availability and rate limits
terms revision and privacy summary
status and publication timestamps
```

Provider endpoint origins are reviewed and stored server-side. Agents cannot make
OpenArc introspect or proxy an arbitrary URL from a listing payload.

Publishing requires:

- provider ownership;
- complete public and machine-readable metadata;
- compatible pricing and receipt schema;
- endpoint-origin review;
- terms and privacy revision;
- passing capability validation;
- moderator approval when enabled.

## 10. Budget and authorization engine

Budget enforcement uses a PostgreSQL transaction and, where required, a Redis
reservation script.

Authorization flow:

1. Authenticate the agent session.
2. Load the exact listing version and provider.
3. Lock the active policy and rolling counter rows.
4. Validate agent, listing, provider, asset, amount, time, and approval rules.
5. Reject or create a pending human approval.
6. Atomically reserve the exact amount.
7. Create the commerce action and authorization grant.
8. Return the one-use raw grant token.
9. Commit reservation after accepted settlement evidence.
10. Release reservation on explicit cancel, verified failure, or expiry.

Concurrent requests must not overspend. Every mutation is idempotent under an
organization-scoped idempotency key and immutable request digest.

The API reports the enforcement boundary:

```text
openarc_mediated_enforced
onchain_policy_proven
observed_only
outside_openarc
```

## 11. x402 purchase lane

The x402 lane preserves the protocol distinction between requirement,
authorization, payment, provider response, entitlement, and settlement.

Preferred direct flow:

1. Agent reads an active OpenArc listing.
2. Provider or capability returns a bounded x402 requirement.
3. Agent requests an OpenArc authorization grant for that exact requirement.
4. OpenArc reserves budget and returns a one-use grant.
5. Agent creates the payment payload with its external wallet or signer.
6. Agent calls the provider directly with grant and payment payload.
7. Provider introspects the grant and verifies/settles payment through the
   approved facilitator.
8. Provider returns content directly to the agent.
9. Provider submits a minimal delivery/payment receipt to OpenArc.
10. The worker observes facilitator, Gateway, or Arc settlement.
11. Reconciliation commits budget and issues or confirms the entitlement.

Raw payment headers are `secret_ephemeral`:

- never written to PostgreSQL, Redis, logs, traces, analytics, or error text;
- held only for the duration of the verification request;
- never returned through an evidence DTO;
- replaced by a digest and bounded normalized fields.

Provider content is not routed through OpenArc unless the listing explicitly uses
an OpenArc-hosted adapter with a separate privacy contract.

## 12. Entitlements

An entitlement binds:

```text
entitlement ID
organization and agent
listing version and provider
source action and payment
scope
issued, starts, expires, and revoked times
status
receipt IDs
```

Entitlement tokens are opaque, shown only to the authorized agent, stored as
hashes, scoped, expiring, and revocable. A payment may settle without an
entitlement being issued; that remains a visible exception.

## 13. ERC-8004 identity and reputation

The adapter uses reviewed Arc Testnet contracts and exact ABIs from
`packages/contracts`.

It may normalize:

- identity ownership and metadata URI;
- observer-specific reputation records;
- validation requests and responses;
- exact contract, block, log, and observation context.

Rules:

- remote metadata is untrusted and not fetched by default;
- linking an OpenArc agent to ERC-8004 requires wallet proof or another named
  source;
- observer feedback retains observer, tag, value representation, and evidence
  reference;
- validation does not become regulatory, identity, or quality certification;
- OpenArc projections keep their rule version and contributing evidence IDs.

## 14. ERC-8183 job lane

The launch adapter integrates only reviewed Arc Testnet contracts.

Prepare routes validate and return exact transaction requests for:

- job creation;
- funding;
- provider acceptance;
- deliverable submission or digest anchoring;
- evaluator decision;
- settlement or refund when supported.

The externally signed transaction is submitted by a user wallet or agent signer.
The worker observes chain state and maps it into the OpenArc job mirror.

Job facts remain distinct:

```text
terms prepared
transaction submitted
job created
funded
accepted
delivered
evaluated
settled
refunded
expired
disputed
```

A deliverable hash proves a byte commitment, not quality, retrievability, or safe
content. Raw deliverables stay direct between parties or in a separately approved
end-to-end encrypted storage design.

## 15. Evidence and receipt model

Accepted receipt types:

```text
authorization_decision
x402_requirement
payment_submission
facilitator_result
gateway_transfer
arc_transaction
provider_delivery
entitlement_issue
entitlement_revoke
job_state
evaluator_result
refund
dispute
```

The API and worker use the canonical shared commerce states. In particular,
`AUTHORIZED`, `PAID`, `DELIVERED`, `ACCEPTED`, and `SETTLED` remain
separate values in storage, events, DTOs, and projections.

Every receipt includes:

- receipt ID and action ID;
- source class and source identifier;
- subject canonical ID;
- occurred and observed times;
- normalized bounded fields;
- digest of any external artifact;
- data class;
- limitations;
- signature or chain reference when available.

Provider-submitted receipts require provider authentication, listing ownership,
action match, schema validation, size caps, idempotency, and replay protection.

Reconciliation is deterministic, versioned, and idempotent. A derived state does
not overwrite source evidence.

## 16. PostgreSQL model

Initial schemas or tables:

```text
auth_accounts
auth_sessions
organizations
memberships
agents
agent_credentials
agent_sessions
providers
provider_credentials
listings
listing_versions
budget_policies
budget_counters
budget_reservations
approvals
authorization_grants
commerce_actions
payment_sessions
provider_receipts
entitlements
job_mirrors
evidence_records
reputation_signals
reputation_projections
disputes
audit_events
outbox_events
source_cursors
```

Rules:

- every protected row carries organization or provider ownership;
- repositories require explicit tenant context;
- foreign keys and unique constraints encode idempotency and ownership where
  possible;
- completed actions retain listing, policy, schema, and rule versions;
- audit rows contain bounded event metadata, not request or provider bodies;
- migrations are forward-reviewed and rollback-tested;
- deletion and retention rules are defined per table before public alpha.

## 17. Worker architecture

The worker processes durable outbox events and idempotent jobs:

- Arc transaction and log observation;
- x402/facilitator/Gateway settlement observation;
- ERC-8004 identity refresh;
- ERC-8183 job refresh;
- grant, reservation, entitlement, and session expiry;
- action reconciliation;
- reputation projection;
- bounded notification events;
- source cursor and health updates.

Worker rules:

- one job has a stable idempotency key;
- retries are capped and consume source budget;
- poison jobs enter a visible dead-letter state;
- no job payload contains raw secret or private capability content;
- state changes use compare-and-set or row locks;
- outbox publication and business mutation commit atomically.

## 18. Arc and provider clients

Shared client controls:

- HTTPS only;
- exact origin and path allowlists;
- no embedded URL credentials;
- no redirects unless the adapter explicitly revalidates the target;
- fixed method and content type;
- timeout and AbortSignal;
- compressed and decompressed size caps;
- bounded JSON depth and collection sizes;
- response schema validation;
- no automatic unbudgeted retry;
- request and response bodies excluded from logs.

Arc reads require:

1. `eth_chainId` equals decimal `5042002`.
2. Reads use an exact committed block anchor.
3. Transaction, receipt, log, and block identities agree.
4. Native USDC and ERC-20 interface values retain their precision and emitter.
5. Multi-read snapshots recheck the anchor before returning.

Arc USDC normalization uses the reviewed network registry:

```text
native internal decimals    18
display decimals             6
ERC-20 interface decimals    6
ERC-20 interface address     0x3600000000000000000000000000000000000000
```

All quantities are parsed to `bigint` and serialized as base-10 strings. Native
and ERC-20 interface views retain their precision and emitter and are never added
or compared before explicit conversion. Truncation below six display decimals is
disclosed.

## 19. Logging, metrics, and audit

Allowed structured log fields:

```text
requestId
route template
principal class
organization/provider opaque ID
status
duration bucket
feature ID
source ID
failure code
budget units
build SHA
```

Raw wallet addresses, transaction hashes from request bodies, API keys, grant
tokens, payment headers, prompts, provider content, deliverables, cookies,
authorization headers, and private browser values are forbidden.

Metrics use aggregate, low-cardinality labels. Audit events describe who changed
a policy, listing, session, approval, entitlement, or dispute without copying the
full object or secret.

## 20. Test architecture

### Unit tests

- exact money and decimal normalization;
- listing, policy, grant, action, entitlement, job, and receipt state machines;
- schema bounds and privacy classes;
- credential hashing and token lifecycle;
- reconciliation and reputation rules;
- Arc, x402, Gateway, ERC-8004, and ERC-8183 normalization;
- error redaction.

### Database and concurrency tests

- tenant isolation;
- migration and rollback;
- double-spend and concurrent budget reservation;
- idempotency conflict;
- grant commit/release/expiry races;
- outbox atomicity;
- entitlement issue/revoke races;
- reputation replay and rebuild.

### Integration tests

- Fastify injection with PostgreSQL and Redis;
- human, agent, provider, and role authorization;
- direct x402 flow with mocked provider and facilitator;
- wrong chain, wrong asset, wrong amount, replay, timeout, redirect, oversized,
  malformed, unavailable, and conflicting sources;
- raw-secret canaries absent from storage, Redis, logs, metrics, and traces;
- worker retries and dead-letter handling.

### Live Testnet tests

- exact deployed SHA across API, worker, and web;
- one controlled x402 purchase with provider receipt;
- one intentionally incomplete purchase;
- one controlled ERC-8004 observation;
- one controlled ERC-8183 job lifecycle when enabled;
- outage, revocation, budget exhaustion, and kill-switch drill;
- no production funds or mainnet claim.

## 21. Deployment architecture

- API and worker use separate non-root production images.
- Database migrations run as an explicit one-shot job before promotion.
- Web and API expose exact build SHA.
- Readiness fails when required database, Redis, migration, queue, or source
  initialization is unavailable.
- Secrets come from the deployment secret manager, never the image or repository.
- Network egress is restricted to approved Arc, facilitator, Gateway, auth, and
  provider origins.
- Backups, restore drills, retention, deletion, rollback, SBOM, vulnerability
  scan, and incident runbooks are release requirements.

## 22. Backend definition of done

A backend milestone is complete only when:

- shared schemas land first;
- migrations, repositories, routes, worker jobs, and docs agree;
- feature flags default false;
- tenant and role isolation are tested;
- money, budget, grant, and idempotency concurrency tests pass;
- no raw provider payload or secret escapes;
- logs, metrics, Redis, and database pass privacy canaries;
- unit, contract, database, integration, image scan, and SBOM pass;
- exact staging SHA and controlled Testnet proof are recorded;
- frontend availability matches API capabilities.

## 23. Prohibited shortcuts

- Generic `fetch(url)` from browser-supplied input.
- Generic contract call or calldata supplied by a browser.
- Storing raw x402 payment headers for debugging.
- Proxying prompts or outputs because it simplifies receipt collection.
- Marking a budget spent without atomic reservation and idempotency.
- Treating payment settlement as provider delivery.
- Treating a provider receipt as independent proof.
- Mutating a listing or policy version referenced by a completed action.
- Floating-point token or fee math.
- Logging request bodies, provider responses, or high-cardinality identifiers.
- Running a worker retry without source-budget accounting.
- Creating a universal OpenArc reputation score without inspectable inputs.
- Enabling a roadmap privacy feature behind only a UI flag.
