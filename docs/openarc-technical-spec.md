# OpenArc technical specification

Status: **proposed Arc Testnet architecture**  
Specification version: **0.3-draft**  
Research verified: **2026-09-03**
Target: **a read-only, locally private evidence and investigation product**

This document turns the OpenArc product idea into a buildable technical plan. It
separates facts confirmed in current Arc and Circle documentation from proposed
OpenArc behavior. Contract addresses, endpoints, protocol versions, and network
behavior must be re-verified at every release and again before any Arc mainnet
deployment.

Normative implementation scope and sequencing are controlled by
`docs/engineering/openarc-engineering-source-of-truth.md`. Backend and frontend
details are controlled by the two architecture documents in that directory.

OpenArc is not Circle or Arc software. It is not endorsed by Circle. Nothing in
this draft is a claim that the product is deployed, audited, or available on Arc
mainnet.

## 1. System objective

OpenArc gives a human operator one evidence trail for an economic agent action:

```text
owner policy or mandate
        -> agent/tool attempt
        -> x402 payment requirement
        -> signed payment authorization
        -> provider response
        -> Gateway transfer state
        -> Arc transaction or contract state
        -> OpenArc reconciliation result
```

The product answers six bounded questions:

1. What identity and wallet were associated with the action?
2. What local policy or signed mandate was supplied?
3. What did a connected agent or tool report attempting?
4. What payment was requested and authorized?
5. What did the provider report returning?
6. What authoritative payment or onchain state can be observed?

OpenArc does not infer hidden chain-of-thought, prove offchain service quality, or
treat a transaction as proof of intent.

## 2. Confirmed Arc Testnet environment

The following values are taken from current official Arc and Circle developer
documentation and are valid only for Arc Testnet at the reviewed date.

| Property | Current Arc Testnet value | OpenArc handling |
|---|---|---|
| EVM chain ID | `5042002` | Pin exactly; reject responses from another chain. |
| CAIP-2 network | `eip155:5042002` | Canonical network identifier in evidence records. |
| Primary HTTP RPC | `https://rpc.testnet.arc.io` | Allowlisted HTTPS origin; no user-supplied RPC in the hosted MVP. |
| Primary WebSocket RPC | `wss://rpc.testnet.arc.io` | Optional bounded event monitor, never a sole source. |
| Explorer | `https://testnet.arcscan.app` | Human verification links only. |
| Faucet | `https://faucet.circle.com` | Test assets only; never describe them as real funds. |
| Consensus | Malachite BFT, permissioned validator set | Treat inclusion as deterministic finality after one committed block. |
| Observed block time | approximately `0.48 s` on Testnet | Display measured timestamps; do not promise a fixed SLA. |
| Execution | EVM, current Arc reference says Osaka baseline | Use standard JSON-RPC plus Arc-specific normalization. |
| Gas asset | USDC | Never label fees or native balance as ETH. |
| USDC ERC-20 interface | `0x3600000000000000000000000000000000000000` | Pin exact address and six-decimal ERC-20 interpretation. |
| EIP-7708 system emitter | `0xfffffffffffffffffffffffffffffffffffffffe` | Canonical 18-decimal movement stream; never add a matching ERC-20 event as another movement. |
| Native USDC precision | 18 decimals internally | Keep raw values as integers or exact decimal strings. |
| ERC-20 USDC precision | 6 decimals | Never compare raw native and ERC-20 values without conversion. |
| Gateway domain | `26` | Do not confuse with EVM chain ID. |
| GatewayWallet | `0x0077777d7EBA4688BDeF3E311b846F25870A19B9` | Verify from current Circle requirements before use. |
| GatewayMinter | `0x0022222ABE238Cc2C7Bb1f21003F0a260052475B` | Observe only in MVP. |

### Testnet facts that affect implementation

- Native USDC and the ERC-20 USDC interface are two views of the same underlying
  balance. They are not separate assets.
- Native movements use 18-decimal accounting while the ERC-20 interface uses 6
  decimals. The ERC-20 view can truncate sub-micro-USDC native precision.
- Arc's current EIP-7708 system emitter produces an 18-decimal `Transfer` for
  every USDC balance movement, including an ERC-20-initiated transfer. The
  ERC-20 contract also emits its ordinary 6-decimal event for ERC-20 calls.
  Indexers must use the emitter and exact `10^12` scaling rule to avoid counting
  the same balance movement twice.
- Blocks are deterministically final when committed. One confirmation is the
  current integration rule, but the observed block hash and number still remain
  in every evidence record.
- Block timestamps are non-decreasing, not strictly increasing. Several
  sub-second blocks can share the same timestamp, so OpenArc orders onchain facts
  by block number and log or transaction index.
- `PREVRANDAO` returns zero and must not be used as randomness.
- EIP-4844 blob transactions are not supported on the current network.
- USDC blocklist and Arc native-value rules can cause value-bearing calls to
  revert even when the sender has enough balance.
- The current minimum Testnet base fee is documented as 20 Gwei in native USDC
  accounting. The value is configuration, not a permanent mainnet promise.
- Arc Testnet activity is public. Private prompts, secrets, proprietary payloads,
  or personal information must not be placed onchain.

### Features that are not current dependencies

Arc documentation describes opt-in confidential transfers, selective disclosure,
post-quantum wallet signatures, and other privacy modules as roadmap or mainnet
features. They are not available OpenArc MVP dependencies. The first architecture
must remain safe on a public transparent testnet.

Re-verified 2026-09-05: Arc's dated August 5 announcement says private mainnet is
already operating and public mainnet is scheduled for September 16, 2026. This
supersedes the older deployment-model page's "upcoming" private-mainnet label.
The official RPC reference remains Testnet-only, and the contract reference says
mainnet addresses are not yet available. An announced launch date is not a
usable, verified public-mainnet configuration. Testnet values must not be copied forward.
A separate signed configuration release is required after those values exist
and the mainnet capability set has been re-verified.

Sources: [launch announcement](https://www.arc.io/blog/arc-mainnet-goes-live-on-september-16-2026),
[RPC reference](https://docs.arc.io/arc/references/rpc-endpoints),
[contract reference](https://docs.arc.io/arc/references/contract-addresses).

## 3. Confirmed agentic and payment surfaces

### ERC-8004 identity, reputation, and validation

Arc currently documents these Testnet contracts:

| Contract | Address | OpenArc use |
|---|---|---|
| IdentityRegistry | `0x8004A818BFB912233c491871b3d84c89A494BD9e` | Optional evidence that an agent identity token exists. |
| ReputationRegistry | `0x8004B663056A597Dffe9eCcC1965A193B7388713` | Display source-linked external feedback, never a universal trust score. |
| ValidationRegistry | `0x8004Cb1BF31DAf7788923b405b754f57acEB4272` | Display exact validator, request, response, tag, and update time. |

An ERC-8004 registration proves that a registry record exists and identifies its
current owner. Metadata fields remain application-defined. Reputation is an
attestation from a particular observer, not objective proof that an agent is safe
or competent. Owner-supplied labels remain visibly distinct from registry facts.

### ERC-8183 job settlement

Arc documents a Testnet `AgenticCommerce` reference implementation at:

```text
0x0747EEf0706327138c69792bF28Cd525089e4583
```

The documented lifecycle includes `Open`, `Funded`, `Submitted`, `Completed`,
`Rejected`, and `Expired`, with client, provider, evaluator, budget, expiry,
deliverable hash, and settlement state. OpenArc can observe this reference
contract as an optional evidence source, but must label it a Testnet reference
implementation rather than a universal Arc job standard or production guarantee.

The deployed `getJob()` tuple does not include a deliverable digest. M06 only
extracts it from an explicitly supplied, matching `JobSubmitted` transaction
receipt, with fixed implementation and anchor checks. Otherwise the digest is
not observed. Zero budget is valid; passing the deadline does not automatically
change the recorded job state. See the controlling engineering specification
and M06 release source review for exact deployed semantics.

### x402 and Gateway Nanopayments

x402 is the HTTP payment negotiation protocol. It does not by itself settle
funds. The relevant flow is:

```text
GET resource
<- 402 + PAYMENT-REQUIRED
sign exact payment authorization
GET resource + PAYMENT-SIGNATURE
<- resource + PAYMENT-RESPONSE
Gateway state: received -> batched -> confirmed -> completed | failed
```

Circle Gateway Nanopayments currently supports Arc Testnet as `arcTestnet`,
Gateway domain `26`, and CAIP network `eip155:5042002`. The method uses a custom
EIP-3009 authorization under the `GatewayWalletBatched` EIP-712 domain.

OpenArc stores normalized requirement and response fields plus a digest. It does
not persist a reusable payment signature, API secret, private key, full paid
resource body, or sensitive resource URL by default.

September 5 source refresh for the upcoming M07 gate: the exact read endpoint is
`GET https://gateway-api-testnet.circle.com/v1/x402/transfers/{id}`. Its REST
response includes a required nonce and a nullable batch-level `txHash`; a shared
batch hash is not individual-payment or fulfillment proof. Amount is atomic USDC
units. The July 10 additions supersede older SDK response examples. August 26
restricted status-only searches; OpenArc's single-UUID boundary avoids them.
Gateway still lists Arc as Testnet only. No Gateway route or mainnet capability
is enabled by this documentation update.

Sources: [Gateway release notes](https://developers.circle.com/release-notes/gateway-2026),
[exact x402 transfer schema](https://developers.circle.com/api-reference/gateway/all/get-x402transfer-by-id),
[supported blockchains](https://developers.circle.com/gateway/references/supported-blockchains).

### Circle Wallets and Agent Stack

Circle Wallets currently lists `ARC-TESTNET` support for EOA, SCA, and MSCA
account types. Circle Agent Stack exposes wallet operations and transaction
history through Circle CLI and related APIs.

Important boundary: the current CLI command reference describes spending-policy
inspection and configuration as mainnet-only. Therefore an OpenArc Testnet local
policy must be labeled `LOCAL MONITORING POLICY` unless a connected wallet returns
specific enforcement evidence for that action.

OpenArc never collects wallet key shares, seed phrases, private keys, or OTPs.
Circle or another approved wallet remains responsible for custody, authorization,
signing, screening, sponsorship, and execution.

## 4. Proposed deployment architecture

```text
+-------------------------- BROWSER ---------------------------+
| React/TypeScript workspace                                   |
| - local encrypted Vault                                      |
| - evidence timeline and graph                                |
| - policy evaluator                                            |
| - correlation engine for private associations                 |
| - export/import/delete                                        |
+-----------------------------|---------------------------------+
                              | exact consented requests
                              v
+------------------------ OPENARC API --------------------------+
| TypeScript/Fastify boundary                                   |
| - strict request schemas and Origin checks                    |
| - Arc RPC normalization                                       |
| - optional Circle/Gateway connector                           |
| - global/provider budgets and timeouts                        |
| - no-store responses and route-template logs                  |
+--------------|-------------------|----------------------------+
               |                   |
               v                   v
        Arc JSON-RPC / WS     Circle/Gateway APIs
               |                   |
               +---------+---------+
                         v
                  source-linked facts
```

### Browser responsibilities

- Own the local encrypted workspace and cross-source associations.
- Store human labels, notes, policies, evidence records, and action envelopes.
- Perform policy comparison and evidence reconciliation locally.
- Render raw identifiers only on explicit expansion.
- Abort connector calls and discard late results on lock or workspace replacement.
- Export, import, recover, and delete the complete encrypted workspace.

### API responsibilities

- Accept one bounded public identifier or evidence fragment per explicit request.
- Pin Arc Testnet chain, contracts, and provider hosts.
- Normalize external responses into versioned allowlisted DTOs.
- Re-read block identity where needed before returning a source-linked fact.
- Enforce timeouts, response-size limits, subcall caps, rate limits, and global
  daily budgets.
- Return `Cache-Control: no-store` and never persist the private workspace.
- Log route template, status, latency, and failure class, not body values.

### Storage responsibilities

MVP persistent user data is local encrypted browser storage. A server database is
not required for action evidence. Server-side stores, if introduced for accounts
or operations later, must not receive labels, policies, prompts, evidence
associations, provider response bodies, or reusable payment signatures.

Redis can be used only for abuse limits, provider budgets, and short-lived locks
whose keys are HMAC-derived and cannot be reversed into wallet addresses.

## 5. Connector capability model

Every connector publishes a versioned capability manifest:

```text
ConnectorCapability
  id                  arc_rpc | gateway_x402 | circle_wallets | agent_event
  version             exact adapter schema version
  environment         testnet | mainnet
  network             CAIP-2 identifier
  reads               bounded fact classes
  writes              always false for OpenArc MVP
  authentication      none | operator_api_key | user_session
  releasedFields      exact fields that leave the browser
  retention           provider and OpenArc behavior
  freshness           source timestamps and observation rules
  limits              rate, size, subcall, and time caps
  sourceRevision      reviewed configuration or contract revision
```

The UI checks capabilities rather than assuming all connectors expose identity,
policy, fulfillment, or settlement. A missing connector becomes an explicit
evidence gap.

## 6. Proposed application interfaces

The hosted MVP uses app-only endpoints. They are not a general public data API.

```text
GET  /v1/private/capabilities
POST /v1/private/arc/account-snapshot
POST /v1/private/arc/transaction-evidence
POST /v1/private/arc/agent-registry-evidence
POST /v1/private/arc/job-evidence
POST /v1/private/gateway/transfer-evidence
```

### Request constraints

- Same-origin browser requests unless a server-to-server connector is explicitly
  documented.
- `Content-Type: application/json` with a small hard body limit.
- Unknown keys rejected.
- One address, transaction, agent ID, job ID, or Gateway transfer ID per request.
- No labels, policy text, notes, prompts, resource bodies, private resource URLs,
  wallet cookies, or unrelated action history.
- Exact permission receipt saved locally before an optional network request.

### Example account snapshot request

```json
{
  "network": "eip155:5042002",
  "address": "0x1111111111111111111111111111111111111111"
}
```

### Example normalized source envelope

```json
{
  "schemaVersion": "openarc.source.v1",
  "source": {
    "kind": "arc_rpc",
    "origin": "https://rpc.testnet.arc.io",
    "observedAt": "2026-08-15T16:00:00Z"
  },
  "anchor": {
    "network": "eip155:5042002",
    "blockNumber": "123456",
    "blockHash": "0x...",
    "finality": "deterministic_committed"
  },
  "facts": [],
  "limitations": [
    "Onchain evidence does not prove offchain intent or fulfillment."
  ]
}
```

The production schema uses bounded exact values; ellipses above are explanatory
placeholders, not accepted payloads.

## 7. Evidence model

This section describes the target live-source model as well as the narrower M01
foundation. M01's exact `openarc.evidence.v1` contract is synthetic-fixture only:
it has no live origin, signer-domain claim, Gateway transfer ID, or generic
subject object. The implemented v1 shape is frozen in the engineering source of
truth; M03 and later must add reviewed versions for live-source fields rather
than silently broadening v1.

### Evidence classes

| Class | Authority | Required presentation |
|---|---|---|
| `local` | Owner-supplied policy, label, or note | `OWNER SUPPLIED` |
| `signed` | Exact signed mandate or authorization | Signer, domain, digest, validity |
| `agent_reported` | Connected agent or tool event | Connector identity and signature status |
| `provider` | Service requirement or response claim | Provider origin, time, limitation |
| `gateway` | Gateway transfer or settlement state | Transfer ID, exact status, update time |
| `onchain` | Arc block, log, receipt, or contract read | Chain, block, hash, contract, method |
| `openarc_derived` | Deterministic comparison of cited records | Rule version and all input evidence IDs |

### Action envelope

```json
{
  "schemaVersion": "openarc.action.v1",
  "actionId": "act_01000000000000000000000000000000",
  "agentId": "agent_01000000000000000000000000000000",
  "kind": "paid_api_request",
  "createdAt": "2026-09-01T11:59:00Z",
  "states": [
    {
      "sequence": 1,
      "state": "PROPOSED",
      "at": "2026-09-01T11:59:00Z",
      "evidenceIds": []
    }
  ],
  "policyEvaluation": null,
  "intentEvidenceIds": [],
  "attemptEvidenceIds": [],
  "paymentEvidenceIds": [],
  "fulfillmentEvidenceIds": [],
  "settlementEvidenceIds": [],
  "reconciliation": null
}
```

This is the unresolved M01 engine-input shape. M01 identifiers are bounded local
fixture containers rather than live subjects, and both cached result fields must
be null when reconciliation is recomputed. The derived result carries the fixed
`openarc.reconcile.v1` rule version and every evidence ID actually used.

### State machine

The common full positive path is monotonic:

```text
PROPOSED -> PERMITTED -> ATTEMPTED -> AUTHORIZED
         -> FULFILLED -> SETTLING -> SETTLED -> RECONCILED
```

Attention or terminal states include:

```text
DENIED_BY_POLICY
EXPIRED
FAILED
REFUNDED
CONFLICTING_EVIDENCE
FULFILLMENT_UNVERIFIED
SETTLEMENT_UNVERIFIED
INTENT_NOT_SUPPLIED
UNSUPPORTED
```

A later state never deletes earlier evidence. `AUTHORIZED` cannot be rendered as
`SETTLED`; `SETTLED` cannot be rendered as `FULFILLED`; a matching provider
receipt cannot prove service quality.

The exported v1 transition matrix also permits a small, explicit set of shortcut
edges for incomplete fixture evidence. Every unlisted edge fails closed and every
non-`PROPOSED` transition requires typed evidence that occurred no later than the
transition. A derived result cannot be timestamped before any evidence it used or
before the final action transition.

## 8. Correlation and reconciliation

OpenArc correlates only when exact fields agree. The minimum key for an x402 Arc
payment is:

```text
network = eip155:5042002
asset = exact Arc Testnet USDC address
payer = exact address
payTo = exact address
amount = exact base-unit integer
authorization nonce = exact bytes32
validity window = validAfter + validBefore
resource = safe origin + local digest
gateway transfer ID = exact UUID when returned
onchain reference = exact block/transaction/log tuple when available
```

Matching amount and addresses alone is insufficient when multiple payments can
share those values. A missing nonce, transfer ID, or source relationship remains
an explicit ambiguity.

### Reconciliation rules

- Compare integer base units, never JavaScript floating point.
- Reject network, token, recipient, amount, nonce, validity, or action-ID
  mismatches.
- Detect duplicate or replayed authorization nonces.
- Treat Gateway `received`, `batched`, and `confirmed` as intermediate states;
  use `completed` only for Gateway completion.
- Treat Gateway `failed` as a failure source, not proof that every possible
  onchain transaction failed.
- Verify Arc receipts against exact transaction hash, block hash, block number,
  status, and expected contract or event emitter.
- Preserve provider response and onchain settlement as independent evidence.
- Surface conflicting source times; do not rewrite the source timestamp with the
  observation time.
- Reject occurrence after observation and causal evidence stages that run
  backwards.
- Report a matched local policy as `unevaluable`, never `permitted`, when no
  usable payment-correlation facts are cited.
- Accept a refund conclusion only for exactly one full refund linked to a cited
  settled transaction with equal amount and a valid same-or-later block
  reference.
- Bound detailed conflict output to 16 groups. If valid bounded input exceeds
  that closure, emit one explicit overflow conflict citing every involved record;
  never silently truncate or throw a generic output-schema error.

## 9. Arc indexing strategy

### Bounded reads

The MVP does not crawl the full chain. It performs explicit, bounded reads for a
single approved wallet, transaction, agent ID, or job ID.

Typical RPC methods:

```text
eth_chainId
eth_getBlockByNumber
eth_getBlockByHash
eth_getBalance
eth_call
eth_getTransactionByHash
eth_getTransactionReceipt
eth_getLogs
```

### Unified USDC handling

- Primary balance display uses the exact configured rule and clearly states
  whether the read came from native 18-decimal balance or ERC-20 6-decimal view.
- A `0` ERC-20 balance does not prove a zero native balance below 1 micro-USDC.
- Native EIP-7708 and ERC-20 events are classified by exact emitter address.
- Deduplication uses transaction hash, log index, emitter, and normalized amount;
  it is never symbol-based.
- Fees are displayed as USDC with source gas limit, effective gas price, and exact
  arithmetic available in an expanded evidence panel.

### Finality

One committed Arc block is currently deterministic finality, but OpenArc still
stores block identity and re-reads it during a response when multiple source calls
must share one anchor. An unexpected mismatch fails the whole normalized result
as `SOURCE_CONFLICT` rather than returning a mixed snapshot.

## 10. Local encrypted workspace

The proposed browser Vault uses:

- WebCrypto AES-256-GCM for record encryption.
- A random data-encryption key wrapped by a passphrase-derived key.
- Separate `openarc.wrap-kdf.v1` and `openarc.backup-kdf.v1`
  PBKDF2-HMAC-SHA-256 derivations, each with an independent random 128-bit salt
  and exactly 600,000 iterations. The value is frozen from the 2026-09-02
  Chromium/WebKit benchmark in the M02 release record; a future change requires
  a new version.
- A fresh 96-bit IV for every encrypted write.
- Authenticated additional data binding vault ID, record ID, schema version, key
  version, and opaque per-record revision.
- A nonextractable session key after unlock.
- IndexedDB for encrypted envelopes only.

Plain metadata contains only crypto bootstrap and version data. Agent names,
wallet associations, policies, action counts, timestamps, notes, resource labels,
and evidence records remain encrypted.

Lock clears React/module state, revokes object URLs, aborts network requests, and
invalidates session generation so a late result cannot be persisted. JavaScript
heap erasure, a compromised device, malicious extensions, XSS, and hostile future
same-origin code remain outside the protection claim.

Encrypted export decrypts and validates one atomic snapshot, excludes the local
manifest/wrappers, and encrypts a bounded logical-record archive under a
distinct backup passphrase with its clear header authenticated as AAD. Import
creates a fresh Vault ID, data key, wrappers, recovery secret, revisions, IVs,
and manifest. No import replaces an existing workspace until the complete
archive is authenticated, decrypted, bounded, and validated in memory.

## 11. Privacy and security boundaries

### Never collected

- Seed phrases or raw private keys.
- Circle entity secrets or OTP codes in the browser.
- Reusable payment signatures in persistent storage.
- Hidden model reasoning or chain-of-thought.
- Full private prompts or paid resource bodies by default.
- Arbitrary browser history, wallet history, or unrelated addresses.

### Network permission receipt

Before each optional connector call, OpenArc records locally:

```text
destination
exact public identifiers released
purpose
authentication/cookie behavior
expected provider retention
OpenArc no-store behavior
approval time
outcome: approved | completed | failed
```

The receipt is persisted before the call. If local persistence fails, the network
request is not sent. If the request later fails, the attempted destination remains
visible.

### Hosted API controls

- Exact production HTTPS origin allowlist and CSRF boundary.
- Credentials omitted for credentialless public-source calls.
- Provider credentials remain server-side and are never returned.
- Response schemas are strict allowlists; no raw upstream object spreading.
- Redirects rejected or revalidated against an exact host allowlist.
- Per-request subcall caps, concurrency caps, response-size caps, and timeouts.
- Atomic Redis daily budgets where a provider or service has a finite allowance.
- Fail closed in production when a required budget store is unavailable.
- HMAC-derived abuse keys without raw wallet or IP values in Redis.
- Route-template logs and redacted structured errors.

## 12. Failure and degraded behavior

| Condition | Product behavior |
|---|---|
| Arc RPC unavailable | Keep prior encrypted evidence, mark it stale, return no new conclusion. |
| Wrong chain ID | Reject the source response and show configuration failure. |
| Anchor/hash mismatch | Discard the entire multi-call result as `SOURCE_CONFLICT`. |
| Circle/Gateway unavailable | Preserve requirement/authorization evidence; settlement remains unverified. |
| Provider response missing | Payment can still be settled; fulfillment remains unverified. |
| Arc receipt missing | Provider/Gateway evidence remains, settlement stays unverified. |
| Conflicting amount or recipient | Mark `CONFLICTING_EVIDENCE`; never choose a convenient source. |
| Unknown agent identity | Show wallet or registry facts without calling it a verified agent. |
| Local quota exceeded | Abort transaction and say the new evidence was not saved. |
| Vault locks mid-request | Abort and discard the late result; no write after lock. |
| Rate or global budget exhausted | Return actionable 429/503 and keep prior evidence unchanged. |
| Unsupported schema/version | Fail closed; preserve encrypted source data for export/delete. |

## 13. User interface structure

### Overview

- Agent and wallet list with evidence-health summary.
- Current USDC balance source and observation time.
- Pending authorization, settlement, and reconciliation counts.
- Policy exceptions and source outages.

### Actions

- Chronological timeline ordered by source time and onchain index.
- Evidence graph showing local, signed, provider, Gateway, and Arc nodes.
- State badge plus plain-language explanation.
- Expandable exact facts, source links, and limitations.

### Policies

- Local per-action, daily, service, recipient, contract, and expiry rules.
- Simulation result before an action when a connected agent can provide a draft.
- Enforcement evidence field. Without it, show `LOCAL MONITORING ONLY`.

### Investigations

- Search by local action ID, transaction hash, authorization nonce, Gateway
  transfer ID, ERC-8004 agent ID, or ERC-8183 job ID.
- Expected versus observed comparison.
- Redacted incident export with a manifest of omitted private fields.

### Sources

- Connector status and capability manifest.
- Exact destination, last successful observation, and data classes released.
- Kill-switch, budget, stale, and degraded status.

## 14. Build sequence

### Phase A - deterministic local engine

1. Versioned evidence types and state machine.
2. Exact-decimal and canonical digest utilities.
3. Local encrypted Vault, lock, export, import, recovery, and delete.
4. Synthetic evidence fixture importer.
5. Timeline, graph, and conflict explanations.

### Phase B - Arc Testnet facts

1. Exact chain and contract registry.
2. One-address account snapshot.
3. Transaction receipt and USDC event normalization.
4. ERC-8004 read-only evidence.
5. ERC-8183 read-only job evidence.
6. Source health, budgets, and failure states.

### Phase C - controlled x402 investigation

1. Controlled test resource with a bounded x402 price.
2. Capture the requirement and safe response metadata.
3. Connect one approved wallet flow without collecting its keys.
4. Read Gateway transfer state.
5. Reconcile with Arc transaction evidence.
6. Produce a complete and an intentionally incomplete investigation fixture.

### Phase D - partner connectors

1. Signed generic agent-event adapter.
2. Optional Circle Wallets transaction adapter after privacy and commercial
   review.
3. Optional AP2 mandate adapter after a frozen schema and signature review.
4. Connector SDK only after the evidence engine and abuse boundary are audited.

## 15. Test and release gates

### Unit and contract tests

- Exact Arc constants and source origins.
- Native 18-decimal versus ERC-20 6-decimal conversion.
- Sub-micro-USDC truncation and zero-display edge cases.
- EIP-7708 versus ERC-20 emitter classification and deduplication.
- Shared block anchor and deterministic ordering when timestamps match.
- x402 requirement, authorization, response, and Gateway status validation.
- ERC-8004 owner, metadata URI, feedback observer, and validation response.
- ERC-8183 state and budget normalization.
- Every allowed and forbidden state transition.
- Duplicate/replayed nonce, expiry, source conflict, and missing evidence.

### Privacy tests

- Private canaries absent from request URLs, bodies, headers, logs, Redis keys,
  plaintext IndexedDB, and server persistence.
- Permission receipt persisted before network.
- Failed destination remains in the encrypted receipt.
- Lock, tab replacement, deletion, and import invalidate pending work.
- No cookie or account credential on credentialless source requests.
- Raw provider payload keys cannot pass response validation.

### Browser tests

- Create, lock, unlock, export, delete, import, and recover.
- Complete controlled x402 evidence arc in Chromium and WebKit.
- Stale, partial, conflict, outage, rate, budget, and kill-switch states.
- Keyboard and screen-reader path through timeline and graph.
- Reduced-motion mode and mobile layout.

### Live Testnet evidence

- Exact deployed SHA and Arc Testnet configuration.
- RPC chain ID, USDC interface, one committed block, and explorer link.
- Controlled x402 test amount with no real-value implication.
- Requirement, authorization, provider response, Gateway transfer, and Arc
  evidence correlation.
- Provider outage, wrong-chain, budget, and late-lock drills.
- Proof that no private prompt, note, policy, key, or raw paid resource was sent.

## 16. Mainnet migration plan

Arc mainnet is a new capability, not a Testnet flag flip.

Required inputs:

1. Official mainnet chain ID, CAIP identifier, RPC, WebSocket, explorer, and
   status page.
2. Official USDC interface, native precision rules, Gateway domain and contracts,
   CCTP contracts, ERC-8004/8183 deployments, and supported Wallets/Agent Stack
   operations.
3. Finality, fee, privacy, signature, and EVM-difference documentation.
4. Provider terms, rate limits, authentication, retention, and cost ceilings.
5. Independent security review of the browser Vault, API, connector boundaries,
   schema validators, and deployment.
6. Legal review for operator identity, privacy terms, Circle/Arc/USDC marks,
   agent-payment claims, and jurisdiction.

Migration mechanics:

- Add a new immutable `NetworkConfig`; do not overwrite Testnet constants.
- Keep Testnet and mainnet records cryptographically and visually distinct.
- Require explicit workspace opt-in before any mainnet request.
- Start read-only and no-custody.
- Run discrepancy tests between at least two approved observations where terms
  and budget allow.
- Deploy behind separate API and web feature flags, default false.
- Prove rollback preserves unlock, export, and delete for records created under
  the newer schema.
- Enable publicly only after exact-SHA staging, production readiness, monitoring,
  backup, incident ownership, and human approval.

## 17. Open technical decisions

- Whether the first agent-event adapter is a local file import, localhost
  bridge, signed webhook, or MCP tool. Local import has the smallest privacy and
  authentication surface.
- Whether Gateway evidence is user-supplied export, authenticated Circle API
  lookup, or both. The product should support provenance for either route.
- Whether raw evidence artifacts are stored encrypted or only their normalized
  allowlist plus digest. Default recommendation: normalized fields plus digest,
  with raw local-only attachment as an explicit advanced option.
- Whether OpenArc provides an SDK in the first public release. Default
  recommendation: no; stabilize schemas against real Testnet fixtures first.
- Whether any local policy can be enforced through Circle Agent Wallets on the
  target environment. Current Testnet UI must not imply enforcement without a
  returned proof.
- Which independent security reviewer and legal operator own the mainnet gate.

## 18. Source registry

Primary references reviewed for this specification:

- Arc network overview: https://docs.arc.io/arc-chain
- Arc deployment model: https://docs.arc.io/arc/concepts/deployment-model
- Arc RPC endpoints: https://docs.arc.io/arc/references/rpc-endpoints
- Arc EVM differences: https://docs.arc.io/arc/references/evm-differences
- Arc stablecoin-native model: https://docs.arc.io/arc/concepts/stablecoin-native-model
- Arc gas and fees: https://docs.arc.io/arc/references/gas-and-fees
- Arc contract addresses: https://docs.arc.io/arc/references/contract-addresses
- Arc opt-in privacy: https://docs.arc.io/arc/concepts/opt-in-privacy
- Arc post-quantum roadmap: https://docs.arc.io/arc/concepts/post-quantum-security
- Arc agentic economy: https://docs.arc.io/build/agentic-economy
- Arc ERC-8004 quickstart: https://docs.arc.io/arc/tutorials/register-your-first-ai-agent
- Arc ERC-8183 quickstart: https://docs.arc.io/arc/tutorials/create-your-first-erc-8183-job
- Circle Wallets supported chains: https://developers.circle.com/wallets/supported-blockchains
- Circle Agent Stack: https://developers.circle.com/agent-stack
- Circle Agent Wallets: https://developers.circle.com/agent-stack/agent-wallets
- Circle CLI reference: https://developers.circle.com/agent-stack/circle-cli/command-reference
- Circle x402 concepts: https://developers.circle.com/gateway/nanopayments/concepts/x402
- Circle Gateway supported chains: https://developers.circle.com/gateway/references/supported-blockchains
- Circle Gateway contracts: https://developers.circle.com/gateway/references/contract-addresses
- Circle Gateway x402 SDK: https://developers.circle.com/gateway/nanopayments/references/sdk
- Circle Gateway x402 transfer search: https://developers.circle.com/api-reference/gateway/all/search-x402transfers
- Arc Testnet terms: https://docs.arc.io/terms

This specification is product and engineering planning, not legal, regulatory,
security, or financial advice.
