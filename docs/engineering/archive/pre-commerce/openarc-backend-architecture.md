# OpenArc backend architecture

M09 investigation operations introduce no backend route, provider or persistence.
Search, evidence projection and report export use already-saved local records;
existing consent and source budgets remain unchanged.

M08 local agent import and policy comparison add no API route, source adapter,
server persistence or provider. All imported fields remain inside the encrypted
browser workspace; see [M08 scope](../releases/08-local-agent-connector.md).

Status: **normative backend specification**  
Specification version: **0.2.1-draft**
Parent: `docs/engineering/openarc-engineering-source-of-truth.md`  
Runtime target: **Node.js 22, TypeScript, Fastify**

This document defines the OpenArc API implementation. It is subordinate to the
engineering source of truth and owns backend-specific behavior only.

## 1. Backend mission

The API is a narrow read-only normalization and safety boundary between the
browser and approved Arc/Circle sources.

It:

- validates a single bounded public identifier;
- enforces feature, privacy, rate, budget, and provider boundaries;
- queries a fixed approved source;
- validates and normalizes the result;
- returns a versioned, source-linked DTO with no raw provider payload.

It does not:

- store the private OpenArc workspace;
- correlate local policies, labels, notes, and evidence relationships;
- sign, simulate for execution, or broadcast transactions;
- accept arbitrary RPC URLs, provider URLs, contracts, methods, or calldata;
- expose a generic proxy, GraphQL explorer, search API, or bulk wallet API;
- accept private keys, seed phrases, Circle entity secrets, OTPs, or reusable
  payment signatures from the browser.

## 2. Backend package layout

```text
apps/api/
  src/
    app.ts
    server.ts
    config/
      env.ts
      network.ts
    http/
      errors.ts
      origin.ts
      no-store.ts
      request-id.ts
      schemas.ts
    routes/
      health.ts
      capabilities.ts
      arc-account.ts
      arc-transaction.ts
      arc-agent.ts
      arc-job.ts
      gateway-transfer.ts
    arc/
      rpc-client.ts
      anchor.ts
      account-service.ts
      transaction-service.ts
      usdc.ts
      events.ts
      constants.ts
    agents/
      erc8004-service.ts
      schemas.ts
    jobs/
      erc8183-service.ts
      schemas.ts
    gateway/
      client.ts
      transfer-service.ts
      schemas.ts
    budgets/
      abuse-limiter.ts
      provider-budget.ts
      redis-scripts.ts
    ops/
      health.ts
      readiness.ts
      metrics.ts
      logging.ts
  test/
    fixtures/
    contract/
    integration/
  Dockerfile
  railway.json
```

Provider modules may import `packages/shared`; shared code cannot import provider
modules.

## 3. Boot sequence

The production process starts in this order:

1. Parse and validate all environment variables.
2. Load the immutable Arc Testnet configuration from `packages/shared`.
3. Verify every configured provider URL is HTTPS and exactly matches the approved
   origin and path contract.
4. Create Redis client when any enabled route requires Redis.
5. Ping Redis and initialize atomic scripts.
6. Create provider clients with fixed deadlines, response caps, and zero implicit
   retries.
7. Register global no-store, request-ID, logging, error, and security hooks.
8. Register health/readiness routes.
9. Register feature routes only when their server flag is true.
10. Start listening.

Startup fails in production when:

- the public app origin is missing or not an exact HTTPS origin;
- a required provider origin differs from the reviewed source;
- an enabled route lacks its required Redis or provider configuration;
- testnet and mainnet values are mixed;
- a secret is shorter than its documented minimum or reuses another secret;
- an unknown environment mode is supplied.

## 4. Environment contract

The concrete Zod schema lives in `apps/api/src/config.ts`.

```text
NODE_ENV                         development | test | production
PORT                             positive integer
APP_ORIGIN                       exact HTTPS origin in production
COMMIT_SHA                       exact deployed commit marker (existing M00 name)
LOG_LEVEL                        bounded enum

API_BOUNDARY_ENABLED             false by default; M03 capabilities only
ARC_OBSERVATION_ENABLED          false by default
AGENT_REGISTRY_ENABLED           false by default
AGENT_JOBS_ENABLED               false by default
GATEWAY_EVIDENCE_ENABLED         false by default

ARC_TESTNET_RPC_URL              exact https://rpc.testnet.arc.io
ARC_TESTNET_EXPLORER_URL         exact https://testnet.arcscan.app

REDIS_URL                        required for any enabled source route
ABUSE_LIMIT_SECRET               32+ chars, unique
SOURCE_PROXY_SECRET              32+ chars, unique; shared only by web proxy and API
REQUESTS_PER_IP_HOUR             bounded positive integer
GLOBAL_SOURCE_UNITS_PER_DAY      bounded positive integer

SOURCE_TIMEOUT_MS                bounded, recommended 5000
SOURCE_MAX_RESPONSE_BYTES        bounded per adapter
SOURCE_MAX_SUBCALLS              bounded per route

GATEWAY_API_URL                  fixed official environment when enabled
GATEWAY_API_KEY                  server-only when required

METRICS_TOKEN                    32+ chars, unique, production required
```

Do not expose provider credentials through `VITE_` variables, response payloads,
logs, readiness detail, or metrics labels.

## 5. HTTP application contract

### Common response headers

Every success and error response includes:

```text
Cache-Control: no-store
Pragma: no-cache
X-Content-Type-Options: nosniff
Referrer-Policy: no-referrer
X-OpenArc-Request-Id: <opaque UUID>
```

Security headers at the reverse proxy include a restrictive CSP, HSTS in
production, frame denial, permissions policy, and no MIME sniffing.

### Origin and CORS

- Product routes are same-origin browser routes.
- Production accepts one exact `APP_ORIGIN`.
- No wildcard CORS.
- No `Access-Control-Allow-Credentials` for credentialless source calls.
- Disallowed Origin is rejected before route logic but still receives no-store.
- Automatic `OPTIONS` behavior is tested for every protected route.
- A future server-to-server API requires a separate prefix, auth scheme, quota,
  terms, and source-of-truth update.

### Content type and body parsing

- Mutation routes accept `application/json` including a standards-valid charset.
- Unknown keys are rejected.
- Body limit is set before parsing.
- JSON arrays at the root are rejected.
- Parser errors use a bounded public error without echoing source input.
- Credentials such as `Cookie` or `Authorization` are rejected on explicitly
  credentialless source routes after the route's abuse limiter has counted the
  attempt.

### Success envelope

```json
{
  "ok": true,
  "data": {},
  "meta": {
    "schemaVersion": "openarc.api.v1",
    "requestId": "opaque-uuid",
    "buildSha": "full-commit-sha"
  }
}
```

### Error envelope

```json
{
  "ok": false,
  "error": {
    "code": "SOURCE_UNAVAILABLE",
    "message": "The approved source is temporarily unavailable.",
    "retryable": true,
    "retryAfterSeconds": 30
  },
  "meta": {
    "schemaVersion": "openarc.api.v1",
    "requestId": "opaque-uuid",
    "buildSha": "full-commit-sha"
  }
}
```

Error messages never contain a request address, transaction hash, agent ID, job
ID, provider URL with query, response body, API credential, or stack trace.

### Error taxonomy

```text
FEATURE_DISABLED               503
INVALID_ORIGIN                 403
CREDENTIALS_NOT_ALLOWED        400
UNSUPPORTED_MEDIA_TYPE         415
REQUEST_TOO_LARGE              413
INVALID_REQUEST                400
RATE_LIMITED                   429
GLOBAL_BUDGET_EXHAUSTED        503
BUDGET_STORE_UNAVAILABLE       503
SOURCE_UNAVAILABLE             503
SOURCE_RATE_LIMITED            503
SOURCE_RESPONSE_TOO_LARGE      503
SOURCE_MALFORMED               502
SOURCE_WRONG_NETWORK           502
SOURCE_CONFLICT                502
SOURCE_NOT_FOUND               404
UNSUPPORTED_EVIDENCE           422
INTERNAL_ERROR                 500
```

## 6. Route matrix

### `GET /healthz`

Purpose: process liveness only.

Response:

```json
{
  "ok": true,
  "service": "openarc-api",
  "buildSha": "full-commit-sha"
}
```

No provider or Redis call.

### `GET /readyz`

Purpose: deployment readiness.

Checks:

- environment loaded;
- required Redis reachable for enabled routes;
- provider configuration identity valid;
- source budget scripts loaded;
- no known fatal adapter initialization error.

Readiness does not call a metered provider on every probe.

### `GET /v1/private/capabilities`

Returns enabled connector manifests, network configuration summary, limits, and
source revisions. It returns no secrets and performs no upstream call.

### `POST /v1/private/arc/account-snapshot`

Request:

```json
{
  "network": "eip155:5042002",
  "address": "0x1111111111111111111111111111111111111111"
}
```

Returns:

- exact final anchor number/hash/time;
- native USDC balance as 18-decimal base-unit string and canonical decimal;
- exact ERC-20 six-decimal view with the same-underlying-balance and truncation
  limitation;
- source origin, observation time, and explorer link;
- no full transaction history.

The adapter performs exactly five bounded subcalls: chain ID, latest block,
native balance at that exact block tag, fixed-contract `balanceOf` at that tag,
and the same block by number. It requires the two anchor reads to agree and
requires `nativeBaseUnits / 10^12 == erc20BaseUnits`. A conflict returns no
partial observation.

### `POST /v1/private/arc/transaction-evidence`

Request:

```json
{
  "network": "eip155:5042002",
  "transactionHash": "0x<64 hex>"
}
```

Returns:

- exact transaction envelope;
- exact receipt and final block anchor;
- success or failure;
- sender, recipient, native value, fee, and bounded decoded USDC movements;
- emitter-specific movement class;
- coverage and truncation fields;
- limitations.

The adapter performs exactly five bounded subcalls: chain ID, transaction by
hash, receipt by hash, block by hash, and that block by number. It cross-checks
the requested/returned transaction hash, transaction and receipt block hash,
block number, transaction index, sender, recipient, both anchor reads, receipt
status, every log's transaction/block/index ownership, and uint256 fee bounds.
Pending/missing facts, removed logs, impossible fee products, malformed values,
or disagreements return a bounded failure and no partial evidence.

For USDC, only `0xfffffffffffffffffffffffffffffffffffffffe` plus the exact
standard `Transfer` topic is canonical. Its amount is interpreted at 18
decimals. A matching event from fixed ERC-20 interface
`0x3600000000000000000000000000000000000000` is a 6-decimal corroboration only
when sender, recipient, order, and `erc20Amount * 10^12` match one unconsumed
canonical event. It never becomes a second movement. Gas fee is
`gasUsed * effectiveGasPrice`, never inferred from a Transfer event.

### `POST /v1/private/arc/agent-registry-evidence`

Request contains network plus one base-10 agent ID. Contracts are fixed in the
adapter. The browser cannot select a registry address or ABI.

Returns identity owner and metadata URI plus bounded reputation and validation
facts only when requested by route version and within fixed caps.

### `POST /v1/private/arc/job-evidence`

Request contains network, one positive canonical uint256 decimal job ID, and
optional `submissionTransactionHash`. The Testnet reference contract and reviewed
EIP-1967 implementation are fixed. Seven bounded calls read the job; at most
eleven also verify the exact submission receipt and its historical implementation.
The payment token must be the fixed six-decimal USDC contract. Zero budget is
valid; `jobHasBudget` distinguishes default from explicitly assigned zero.
Response includes exact job fields and the explicit reference-contract limitation.
`getJob` does not return a deliverable digest: without an exact matching
`JobSubmitted` receipt event the response says `not_observed`. Deadline timing
is not a synthesized status transition. See the M06 release source review.

### `POST /v1/private/gateway/transfer`

Optional, default disabled. Request contains one UUID transfer ID plus expected
network. It cannot search arbitrary wallet history in MVP.

Response includes only:

```text
transfer ID
status
token
sending network
recipient network
from and to address
amount in atomic USDC units
EIP-3009 nonce
nullable batch settlement transaction hash (not individual payment proof)
created and updated times
fixed source identity and observation time
```

Evidence limitations are fixed local UI/reconciliation copy, not provider-supplied
text. The adapter accepts only the flat current REST fields; no arbitrary nested
metadata, resource content, credentials, or raw authorization payload is returned.

Authentication, account association, terms, retention, and rate behavior must be
approved before this route can be enabled outside isolated staging.

## 7. Route hook order

Enabled source requests pass through this exact order:

1. assign request ID;
2. attach no-store/security headers;
3. verify feature flag;
4. consume HMAC per-IP and global budget reservation;
5. validate Origin and reject credentials where required;
6. validate content type and body size;
7. parse and validate shared request schema;
8. execute adapter with timeout and AbortSignal;
9. validate normalized result schema;
10. emit bounded metrics and structured completion log;
11. return result.

Rejected traffic must not bypass the dedicated abuse ceiling. Budget accounting
distinguishes attempted route units from actual provider subcalls.

## 8. Provider HTTP client

One shared client enforces:

- HTTPS only;
- exact origin and allowed path prefix;
- no embedded credentials;
- no redirects, or exact revalidation if a route explicitly permits one;
- fixed method and content type;
- request timeout with AbortSignal;
- compressed and decompressed response-size caps;
- status allowlist;
- bounded JSON depth and collection sizes after parsing;
- zero automatic retries in MVP;
- request and response body exclusion from logs;
- source-specific error mapping.

If retries are introduced later, every attempt consumes provider and global
budget units independently.

The Arc JSON-RPC client additionally:

- pins JSON-RPC version `2.0`;
- generates opaque request IDs unrelated to user identifiers;
- permits only adapter-owned method enums;
- rejects extra response objects, batch cardinality mismatch, and wrong IDs;
- counts every batch element as a subcall;
- rejects a body that includes an unexpected chain result.

## 9. Arc anchor algorithm

For any multi-read snapshot:

1. Call `eth_chainId`; require `0x4cef52` / decimal `5042002`.
2. Read the current committed block by number and capture number/hash/timestamp.
3. Use that exact block number for every state read.
4. Fetch required transactions, receipts, logs, or contract calls within the
   route's fixed cap.
5. Re-read the anchor block by hash or number.
6. Require the same number and hash.
7. Normalize and validate all facts.
8. Return one source envelope or fail the whole route as `SOURCE_CONFLICT`.

Although Arc documents deterministic finality, the same-anchor check prevents a
misconfigured or inconsistent provider response from becoming a mixed snapshot.

## 10. USDC normalization

Shared constants define:

```text
native internal decimals    18
display decimals             6
ERC-20 interface decimals    6
ERC-20 address               0x3600000000000000000000000000000000000000
EIP-7708 system emitter      0xfffffffffffffffffffffffffffffffffffffffe
Transfer topic0              0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef
```

Rules:

- parse hex quantities to `bigint`;
- serialize base units to base-10 strings;
- use shared exact formatting; never `Number`;
- retain the source interface and precision;
- disclose ERC-20 truncation;
- do not add native and ERC-20 views;
- classify EIP-7708 and ERC-20 events by exact emitter;
- emit one canonical movement for each valid EIP-7708 system event;
- treat an ERC-20 event only as corroboration after an exact sender, recipient,
  and `6-decimal amount * 10^12` match to one earlier unmatched system event;
- require every ERC-20 USDC `Transfer` to have exactly one system-event match;
- never dedupe by token symbol, amount alone, timestamp, or adjacency;
- reject negative, non-canonical, overflow, and exponent values.

## 11. Transaction normalization

The transaction service requires:

- a valid direct transaction hash;
- matching `receipt.transactionHash`;
- matching transaction and receipt block hash/number;
- receipt status exactly success or failure;
- logs present as a bounded array;
- every log has valid address, topics, data, transaction hash, and log index;
- anchor identity agrees with the receipt block.

Movement decoding is allowlisted:

- Arc EIP-7708 system emitter at
  `0xfffffffffffffffffffffffffffffffffffffffe`, 18 decimals, as the canonical
  movement stream for every native and ERC-20-initiated balance change;
- exact USDC ERC-20 interface at
  `0x3600000000000000000000000000000000000000`, 6 decimals, as a corroborating
  event stream that is never returned as an additional movement;
- no arbitrary ABI decoding in MVP.

A failed transaction has no successful native or token movement conclusion. Fees
can still be reported from receipt gas usage and effective gas price.

Coverage fields distinguish complete decoded coverage from unsupported logs or
UI truncation.

## 12. ERC-8004 adapter

The adapter owns exact ABIs and fixed Testnet addresses.

Identity read:

- validate uint256 agent ID string;
- read `ownerOf` and `tokenURI` at one anchor;
- return metadata URI as untrusted text only;
- do not fetch remote JSON or images in MVP.

Reputation read:

- fixed bounded query path;
- retain observer address, tag, value/score representation, and evidence URI;
- label each record observer-supplied;
- never aggregate into a universal OpenArc score.

Validation read:

- require exact request hash;
- retain validator, agent ID, response, response hash, tag, and update time;
- never translate a response into regulatory or identity certification.

## 13. ERC-8183 adapter

The adapter reads only the documented Arc Testnet reference contract.

It validates:

- uint256 job ID;
- client, provider, evaluator, and hook addresses;
- USDC budget as a base-unit integer string;
- expiry as a bounded timestamp;
- exact supported status enum;
- contract and anchor identity.

Deliverable hashes are bytes32 claims emitted in a matching submission event,
not proof that the underlying content exists, has a particular quality, or is
retrievable. Local action linking occurs in the browser, not server.

## 14. Gateway adapter

The adapter remains compile-time and runtime disabled until approved.

Source refresh (2026-09-05): use the exact
`GET https://gateway-api-testnet.circle.com/v1/x402/transfers/{id}` REST contract,
not generic Gateway transfer endpoints or outdated SDK response examples. The
July 10 API update added nonce and nullable batch transaction hash; the August 26
search restriction does not require broad search because OpenArc accepts one UUID.
See the technical specification's dated primary-source links. This clarification
does not enable M07 or satisfy its account, privacy, cost, and live-proof gates.

When enabled it:

- uses the exact official Testnet API origin;
- authenticates server-side if required;
- accepts one UUID transfer ID, not broad address search;
- validates status as `received`, `batched`, `confirmed`, `completed`, or
  `failed`;
- validates token `USDC` and exact network identifiers;
- validates exact addresses, amount string, and timestamps;
- returns no authorization payload or reusable signature;
- never asserts that Gateway completion proves provider fulfillment.
- never treats a batch transaction hash as a unique individual-payment match.

## 15. Rate and budget controls

Two atomic Redis controls apply to enabled source routes:

### Abuse limit

- key: HMAC(secret, trusted client IP bucket + route class);
- no raw IP, wallet, transaction, agent, job, or transfer ID;
- fixed hourly window for MVP;
- `Retry-After` returned on 429;
- session cookies cannot change or reset the identity.

### Global source budget

- counts route source units and actual JSON-RPC/provider subcalls;
- one Lua transaction reserves units before network access;
- date bucket uses UTC;
- hard daily limit;
- provider call cannot start when reservation fails;
- Redis outage fails closed in production;
- metrics expose only aggregate counts and failure reason.

Tests must prove cross-process atomicity, multi-IP global exhaustion, reset/TTL,
and raw-identifier absence.

## 16. Logging, metrics, and readiness

### Logs

Allowed structured fields:

```text
requestId
route template
method
status
duration bucket
feature ID
source ID
failure code
budget units
build SHA
```

Forbidden fields include request body, raw URL query, Origin beyond allowed/denied
classification, Cookie, Authorization, provider payload, wallet address,
transaction hash, agent/job/transfer ID, or private browser data.

### Metrics

Aggregate counters/histograms:

- request total by route/status;
- source request total by adapter/result;
- source latency histogram;
- rate-limit and global-budget exhaustion;
- provider timeout, malformed, wrong-network, and conflict;
- readiness status;
- build info.

No high-cardinality user or source identifier labels.

### Readiness

Railway or another deployment platform uses `/readyz`, not `/healthz`, as the
promotion health check. A required Redis or adapter initialization failure keeps
the deployment unready.

## 17. Test architecture

### Unit tests

- env production guards;
- exact constants and immutable network config;
- canonical identifiers and exact arithmetic;
- error mapping and redaction;
- provider URL and redirect validation;
- Arc quantity and event normalization;
- ERC-8004 and ERC-8183 schema parsing;
- Gateway status and network parsing.

### Contract tests

- every request and response against shared Zod schemas;
- unknown fields and future schema rejection;
- success/error headers including no-store;
- feature-disabled shape;
- OpenAPI or generated contract parity if documentation is published.

### Integration tests

- Fastify injection with mocked upstreams;
- real disposable Redis for atomic limits and global budget;
- wrong chain, inconsistent anchor, timeout, 429, redirect, oversized, malformed,
  partial, and unavailable providers;
- outbound-call canary proving disabled and invalid requests send nothing;
- log sink canaries proving identifiers are absent.

### Live staging tests

- exact SHA in `/healthz` and web marker;
- `/readyz` with required dependencies up;
- one controlled public Arc Testnet address and transaction;
- exact chain, block, USDC, ERC-8004/8183 evidence where milestone enabled;
- source outage and budget/kill-switch drill;
- no production funds or private test data.

## 18. Deployment architecture

Initial services:

```text
web      static Vite build behind Nginx
api      pruned Node production image
redis    managed Redis for limits and budgets
```

Nginx proxies `/v1`, `/healthz`, and `/readyz` to the API so browser calls remain
same-origin. Upstream TLS uses certificate verification and SNI.

API runtime image:

- build shared package and API;
- materialize a production-only dependency closure;
- contain no test runner, compiler, package manager cache, or dev server;
- run as a non-root user;
- expose no shell-dependent predeploy command;
- include exact build SHA;
- pass vulnerability scan and SBOM generation.

## 19. Backend definition of done

A backend milestone is complete only when:

- shared schemas landed first;
- feature flag defaults false;
- routes use the required hook order;
- all outputs validate against shared schemas;
- no raw provider payload escapes;
- rate, budget, timeout, size, redirect, malformed, and outage states are tested;
- logs and Redis pass privacy canaries;
- build, typecheck, lint, unit, integration, image scan, and SBOM pass on Node 22;
- exact staging SHA, readiness, and live controlled-source proof are recorded;
- frontend capability truth matches the API.

## 20. Backend prohibited shortcuts

- Generic `fetch(url)` using browser input.
- Provider-object spread into a response.
- `Promise.all` fanout without a fixed cap and budget reservation.
- Automatic provider retries not counted as new budget units.
- Floating-point token or fee math.
- Source caching keyed by wallet or transaction identifier.
- Raw body, provider response, or identifier logging.
- Treating a public RPC response as trusted before schema and chain validation.
- Treating Arc deterministic finality as permission to combine different anchors.
- Adding server evidence persistence because it is convenient.
- Enabling Gateway or Circle credentials without the documented review gate.

## 21. M03 frozen boundary decisions

### HTTP and capability bootstrap

M03 enables only `GET /v1/private/capabilities`, behind the false-by-default
`API_BOUNDARY_ENABLED` flag. Its `openarc.api.v1` envelope has a fresh UUID
request ID, the existing `COMMIT_SHA` marker, and strict metadata: Testnet
configuration/review revision, empty enabled connectors, false source-feature
flags, and bounded operational limits. There are no provider URLs supplied by
the browser, identifiers, user data, or upstream calls. Known later source
routes return bounded `FEATURE_DISABLED`; unknown paths return `NOT_FOUND`.
Setting any not-yet-implemented source flag true is a startup failure.

Protected requests require `X-OpenArc-Client: browser-v1`. A supplied Origin must
equal `APP_ORIGIN` byte-for-byte; `null`, arrays, multiple values, and mismatches
fail. Same-origin browser GET normally omits Origin, so only the capabilities
GET may omit it, and only with `Sec-Fetch-Site: same-origin` plus the custom
header. Supplied Fetch-Metadata cannot be cross-site, same-site, or navigation.
Source POST requires the exact Origin. Missing Fetch-Metadata may coexist with
an exact Origin for clients whose browser omits it; it never authorizes a
missing-Origin GET. This is a browser/CSRF boundary, not user authentication.

Credentialless routes reject Cookie, Authorization, and Proxy-Authorization.
They reject query strings, root arrays, unknown keys, and unexpected bodies.
Allowed preflights require the exact Origin, the exact route method, and only
`content-type` / `x-openarc-client` requested headers; they emit the exact
allow-origin, no credentials, no-store, and no caching grant. Disabled routes
stay disabled on OPTIONS; HEAD never bypasses a protected GET guard. Status
405 uses `METHOD_NOT_ALLOWED`; metrics auth failure uses `METRICS_UNAUTHORIZED`.
All application errors use fixed shared messages, never raw parser/provider
errors. Fastify hooks run privacy/limit checks before parsing request bodies.

The initial maximum request body is 16 KiB, response 64 KiB for capabilities,
provider request 16 KiB, and provider response 256 KiB. Source timeout defaults
to 5 seconds (bounded 100–10,000 ms); maximum route subcalls defaults to 8
(bounded 1–16). The provider client accepts the exact approved HTTPS endpoint,
fixed POST JSON, identity content encoding only, no redirects/retries, and
bounded streamed bytes and JSON structure. Compressed bodies fail closed rather
than being implicitly decompressed without a separate verified bound.

The generic M03 transport also caps response headers at 8 KiB, JSON depth at
16, visited JSON nodes at 8,192, each collection at 2,048 entries, and each
string or key at 65,536 code units. UTF-8 is decoded strictly. Duplicate
media-type headers, invalid Content-Length, and unsafe object keys fail closed.
An early declared-size failure does not consume the body. The 64 KiB normalized
API-response ceiling applies to the reusable source boundary as well. No M03
production route instantiates a provider adapter; method, chain, and anchor
validation are introduced only in M04.

### Abuse identity and budget accounting

`trustProxy` remains false and the API ignores ordinary `Forwarded`,
`X-Forwarded-For`, and `X-Real-IP` request headers. Railway documents the
`X-Real-IP` value delivered to the web service as the client's remote IP. The web nginx proxy removes
ordinary forwarding headers and overwrites any caller-supplied internal proxy
assertions with that edge value plus `SOURCE_PROXY_SECRET`. The API accepts the
client address only when the internal secret matches in constant time and the
address parses as exactly one IPv4 or IPv6 address. Missing, duplicate, forged,
or malformed assertions fail before Redis or an upstream call. Direct calls to
the public API cannot create a budget identity because they do not possess the
web-to-API secret. The API never logs the address and Redis receives only its
route-scoped HMAC digest.

This trust boundary depends on Railway overwriting its edge-owned header, as
documented in Railway's public-networking specification:
<https://docs.railway.com/networking/public-networking/specs-and-limits>.
Moving the web service to another edge requires re-verification or a new
authenticated identity design before source routes may remain enabled.

Standalone Redis Lua uses Redis server time and atomic fixed UTC hour/day
windows. Keys contain only a versioned namespace, a fixed source/route class,
or an HMAC digest; values contain only window numbers and bounded counters.
Expiry is the window end plus a 60-second cleanup grace, and counters reset
inside the same script when the window changes.

Only a source POST that passes the exact Origin, credential, method, query,
media, declared-size, authenticated proxy-identity, parser, and strict-schema
checks consumes one per-peer/hour attempt and one daily route unit. Preflights,
malformed requests, and boundary failures consume no shared capacity and never
execute an adapter. An already exhausted hourly bucket is charged/clamped
without consuming more daily units. Each prospective upstream subcall then
reserves one further daily unit atomically, and a per-request lease caps
subcalls. A reservation is never refunded, even if cancellation or transport
failure prevents completion; this is conservative spend control, not a claim
that every reservation reached a provider. Metrics distinguish reservations
from dispatched calls. Missing Redis, script errors, disconnection, or timeout
fail closed without outbound calls.
There is no offline queue or implicit command retry that can perform a late
operation. A dropped Redis transport reconnects with bounded 100–1,000 ms
backoff so readiness can recover after the same private store returns; commands
issued while the socket is unavailable still fail immediately and are never
replayed.

An already transmitted Redis command cannot be recalled: a timeout may consume
one reservation after the caller has failed closed. It must never cause a retry
or a provider dispatch. Exceeding a per-request subcall lease fails with the
fixed `SOURCE_UNAVAILABLE` error. Dispatch metrics count transport invocations,
not proof that the provider received a packet. The Redis command deadline is
750 ms (internally bounded 25–2,000 ms), with a bounded connection-only
reconnect strategy and at most 256 pending commands. The offline queue remains
disabled. Lease closure and route cancellation prevent further calls.

Defaults are 60 attempts/hour and 10,000 combined units/day, both bounded at
configuration time. Capability metadata is not a source route and requires no
Redis or provider budget. Its payload and request lifetime remain bounded.
Disposable real Redis tests must cover concurrent independent clients, global
exhaustion across peers, window reset/TTL, dropped-connection recovery, outage,
and raw-canary absence.

### Operational/privacy surface

Production requires an exact HTTPS `APP_ORIGIN`, an exact commit SHA, and a
unique 32–128-character `METRICS_TOKEN`. Any supplied abuse secret meets the
same bound and cannot equal the metrics token; it becomes required with source
routes. Values are never logged. Configuration errors emit a fixed startup
failure, not the environment or a Zod/provider stack.

`GET /metrics` is direct-API only, authenticated with a constant-time bearer
comparison. It is never proxied into the browser shell. Labels come exclusively
from bounded route/status/source/error enums; counts and duration buckets are
aggregate. Automatic Fastify request/error logs and Nginx request logs are off;
application completion logs are built from an allowlist. Nginx upstream/error
logs must also be suppressed or proven not to contain URI/query/referrer
canaries; access-log suppression alone is insufficient. Health/readiness keep
the existing `commitSha` field. Readiness distinguishes Redis-not-required from
verified Redis availability and never probes a metered source.

The enabled web build proxies only the named `/v1/private` routes and health/
readiness paths to one configured HTTPS API origin with SNI and certificate
verification. No browser-supplied upstream, redirect, or general proxy exists.
Only this build changes CSP from `connect-src 'none'` to `connect-src 'self'`.
External browser sources remain blocked. The disabled web build retains its
local-only configuration. Production proxy tests use an isolated trusted test
CA/HTTPS fixture, never a live provider or a shipped test trust root.

Design references reviewed 2026-09-03: [browser Origin behavior](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Origin),
[Fastify hook lifecycle](https://fastify.dev/docs/latest/Reference/Hooks/), and
[Redis atomic Lua execution](https://redis.io/docs/latest/develop/programmability/eval-intro/).
