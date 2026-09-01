# OpenArc product blueprint

Status: **concept and Arc Testnet implementation plan**  
Prepared: **2026-08-15**

Engineering authority: `docs/engineering/openarc-engineering-source-of-truth.md`.
This blueprint explains product intent; it does not override implementation
contracts or milestone order.

## Product promise

OpenArc is a private intelligence, policy, and investigation layer for economic
agents. It brings supplied intent, permissions, service requests, payment
authorizations, provider receipts, and blockchain settlement into one evidence
trail so a human can see:

- What the agent was allowed to do.
- What the agent attempted.
- What it authorized or paid.
- What service claimed to fulfill the request.
- What ultimately settled.
- Where the evidence agrees, conflicts, or remains incomplete.

OpenArc does not claim to read a model's hidden reasoning. It does not treat a
wallet address as an agent without evidence. It does not take custody, store seed
phrases, sign transactions, or broadcast transactions.

## Category

Primary category: **agent operations intelligence and investigation**.

Supporting descriptions:

- Private control plane for autonomous finance.
- Evidence and reconciliation layer for agent payments.
- Human-readable flight recorder for economic agents.

OpenArc is not an agent wallet, payment facilitator, blockchain explorer,
compliance certification, autonomous trader, custodian, or model-monitoring tool.

## Why Arc

Arc is being positioned by Circle as an economic operating system for stablecoin
payments, tokenized assets, foreign exchange, credit, and agentic commerce. Arc
Testnet currently offers an EVM environment and integration paths for Circle
Agent Stack, USDC, Gateway, and x402-style agent payments.

That environment creates a practical need between raw infrastructure and the
human owner: payments can be fast and programmatic, but permissions, attempts,
offchain fulfillment, and settlement still need to be reconciled and explained.

Arc is the initial network focus. The evidence model should remain protocol-aware
and portable rather than baking every concept into an Arc-only schema.

The implementation-level network and connector contract is maintained in
`docs/openarc-technical-spec.md`. The key current Testnet facts are chain ID
`5042002`, CAIP network `eip155:5042002`, deterministic one-block finality,
USDC-native gas, and the six-decimal USDC ERC-20 interface at
`0x3600000000000000000000000000000000000000`. Arc mainnet remains a separate,
future configuration and review.

Arc-specific behavior must be normalized rather than treated as generic Ethereum:
native and ERC-20 USDC share one balance but expose different precision, native
movements emit EIP-7708-style logs, block timestamps can repeat, `PREVRANDAO`
returns zero, and blob transactions are not supported on the current Testnet.

## The key product distinction

OpenArc is an interface over several sources of truth. It is not the sole source
of truth.

| Layer | Authoritative for | Not authoritative for |
|---|---|---|
| Local owner policy | Locally recorded limits and allowlists | Enforcement by another wallet |
| Signed mandate | The exact signed authorization | Whether the action executed |
| Agent/tool event | What the connected system says it attempted | Hidden model reasoning |
| x402 authorization | The payment payload that was signed | Final settlement or service quality |
| Provider receipt | The provider's fulfillment claim | Independent proof of quality |
| Gateway record | Gateway verification and batching state | The user's original purpose |
| Arc transaction | Onchain execution and settlement | Offchain intent or fulfillment |
| OpenArc analysis | Reconciliation of supplied evidence | Facts absent from every source |

Every conclusion must retain its evidence class.

## The evidence arc

```text
OWNER
  policy / mandate
       |
       v
AGENT
  request / tool action
       |
       v
SERVICE
  payment requirement → signed authorization → response receipt
       |                                      |
       +------------------+-------------------+
                          v
                     GATEWAY / ARC
                  verification + settlement
                          |
                          v
                       OPENARC
              reconcile + explain + flag gaps
```

## Core states

Each action uses a monotonic evidence state machine. A later state does not erase
earlier evidence.

1. `PROPOSED` — an action request exists.
2. `PERMITTED` — a matching local policy or supplied signed mandate exists.
3. `ATTEMPTED` — the connected agent/tool reports sending the request.
4. `AUTHORIZED` — a payment authorization was signed or accepted.
5. `FULFILLED` — the provider returned a bounded receipt or resource proof.
6. `SETTLING` — a facilitator accepted the authorization for settlement.
7. `SETTLED` — an authoritative settlement record exists.
8. `RECONCILED` — all evidence required by the action type agrees.

Parallel terminal or attention states:

- `DENIED_BY_POLICY`
- `EXPIRED`
- `FAILED`
- `REFUNDED`
- `CONFLICTING_EVIDENCE`
- `FULFILLMENT_UNVERIFIED`
- `SETTLEMENT_UNVERIFIED`
- `INTENT_NOT_SUPPLIED`
- `UNSUPPORTED`

The UI must never label `AUTHORIZED` as `SETTLED` or `FULFILLED` as
`RECONCILED`.

## First useful vertical

The MVP is one Arc Testnet agent-payment investigation:

1. The user creates a local encrypted OpenArc workspace.
2. The user labels one Arc Testnet address as an agent wallet.
3. OpenArc reads bounded USDC balance and activity evidence.
4. The user defines a local sample policy such as a per-action maximum and an
   allowed service.
5. A controlled agent requests one x402-compatible test resource.
6. OpenArc records the payment requirement, authorization, provider response,
   Gateway state, and eventual settlement reference.
7. The result is compared with the local policy and shown as a complete or
   incomplete evidence arc.
8. The workspace can be locked, exported in encrypted form, or deleted.

This proves the product thesis without pretending to support every framework or
putting production funds at risk.

## MVP workspaces

### Overview

- Agent wallets and current evidence health.
- USDC balances and settled movement totals.
- Pending authorizations and unreconciled actions.
- Policy exceptions and missing evidence.
- Source freshness and service availability.

### Agent activity

- Timeline of requests, authorizations, receipts, and settlements.
- Filter by agent, service, state, value, and date.
- Expandable raw identifiers with source links.
- Explanation of what is fact, supplied evidence, or interpretation.

### Policies

- Per-action and time-window spending limits.
- Recipient and contract allowlists/blocklists.
- Approved services and endpoint origins.
- Expiration and human-approval requirements.
- Local simulation against an action before it is attempted.

MVP policy controls are observational unless a supported wallet integration
explicitly confirms enforcement. The interface must say `LOCAL MONITORING POLICY`
rather than `ENFORCED` in that case.

### Investigation

- Search by transaction, authorization, service, or local action ID.
- Side-by-side expected versus observed values.
- Evidence graph and chronological timeline.
- Exportable redacted incident report.
- Missing-evidence checklist.

### Sources

- Connection health and last successful observation.
- Exact provider and network destination.
- Capability and retention description.
- Data classes released to each source.
- Kill switch and degraded-state visibility.

## Data model

### AgentProfile

```text
id                    opaque local identifier
displayName           owner-supplied local label
wallets[]             chain + address + evidence for classification
framework             optional owner-supplied value
purpose               optional local note
policyIds[]           local policy references
createdAt              local timestamp
```

The `agent` classification is owner-supplied or explicitly sourced. It is never
inferred solely from transaction frequency or contract interaction.

### ActionEnvelope

```text
id                    opaque local action identifier
agentId               local relationship
actionType            api_request | transfer | contract_call | bridge | swap
createdAt             first observed time
states[]              append-only evidence-state transitions
policyEvaluation      matched rule IDs + local result
intentEvidence        optional signed mandate or local declaration reference
attemptEvidence       optional connected-system event reference
paymentEvidence       optional x402/Gateway references
fulfillmentEvidence   optional provider receipt reference
settlementEvidence    optional chain transaction reference
reconciliation        result + exact gaps/conflicts
```

### EvidenceRecord

```text
id                    opaque identifier
class                 local | signed | agent_reported | provider | gateway | onchain
source                exact origin/system/network
observedAt            OpenArc observation time
occurredAt            source event time when available
subject               action/wallet/payment/transaction reference
digest                canonical record digest where appropriate
payload               bounded, versioned normalized fields
limitations           explicit non-claims
```

Sensitive prompts, private model reasoning, service response bodies, API secrets,
wallet private keys, and seed phrases are excluded from the default data model.

## Privacy architecture

Personal agent labels, policies, investigation notes, and cross-source
associations should be encrypted locally before persistent browser storage.

The server may process bounded public identifiers or user-approved payment
evidence only for a specific request. Every optional network operation should
show an exact permission receipt describing:

- Destination.
- Public fields released.
- Purpose.
- Expected retention or no-store behavior.
- Whether a provider account can associate the request.

Do not log wallet addresses, resource URLs containing private identifiers,
authorization bodies, prompts, response contents, or local policy details.

An unlocked browser, compromised device, malicious extension, XSS, or malicious
future same-origin deployment remains outside the protection claim.

## Integration layers

### Arc network adapter

- Configured chain ID and testnet/mainnet identity.
- RPC and explorer source identity.
- USDC and supported Circle contract registry.
- Block/finality and reorganization handling.
- Exact-decimal balances, fees, and transaction values.
- Capability-based degradation when data is unavailable.

Never copy Arc Testnet constants into a future mainnet configuration without an
official mainnet source and an exact deployment review.

### Circle Agent Stack adapter

Potential inputs include wallet identity supplied by the connected owner,
transaction history, service-payment results, and supported network metadata.
Authentication and account data require a separate privacy and commercial review.

OpenArc must not request or store wallet private keys. Circle or another approved
wallet remains responsible for signing and execution.

### x402 and Gateway adapter

Capture normalized, bounded fields from:

- Payment requirements.
- Signed-authorization metadata without persisting reusable secrets.
- Verification response.
- Resource/fulfillment response metadata.
- Settlement identifier and state.
- Gateway balance and withdrawal state when explicitly connected.

Resource URLs can contain sensitive query data. Store a safe origin plus a local
redacted label by default; include a full URL only through an explicit local-only
choice.

### AP2 adapter

AP2 is a candidate source for signed intent, cart, payment mandates, and receipts.
Support should be versioned and optional. OpenArc must validate signatures and
schema versions before calling a mandate authoritative.

AP2 absence is an incomplete-evidence state, not proof that an action was
unauthorized.

### Generic agent connector

Offer a minimal event schema for other frameworks:

```text
agent_id
action_id
event_type
occurred_at
tool_or_service
public_parameters_digest
policy_reference
result_state
evidence_signature (optional)
```

Unsigned connector events remain `agent_reported`, not cryptographic proof.

## Chain abstraction

OpenArc should begin on Arc Testnet but use a capability registry:

```text
NetworkConfig
  networkId
  environment
  nativeFeeAsset
  stablecoins
  rpcCapabilities
  explorerCapabilities
  circleCapabilities
  x402Capabilities
  finalityModel
  sourceDisclosures
```

This avoids rebuilding the evidence engine if an action spans Arc, another
Gateway-supported chain, or a future mainnet deployment.

## What the MVP does not do

- Sign, broadcast, bridge, swap, or execute agent actions.
- Store seed phrases, private keys, or reusable payment signatures.
- Claim to see private prompts or hidden model reasoning.
- Assign universal agent identity, reputation, or credit scores.
- Certify regulatory compliance.
- Guarantee that provider fulfillment was useful or correct.
- Offer investment, legal, tax, or security advice.
- Support arbitrary wallets, frameworks, chains, or protocols.
- Claim Arc mainnet support before official production parameters are available.
- Monetize an endpoint through x402 before a separate security, commercial, and
  accounting review.

## Verification plan

### Evidence logic

- Every state transition is monotonic and source-linked.
- Authorization never becomes settlement without settlement evidence.
- Settlement never becomes fulfillment without a provider receipt.
- Missing intent remains visible after settlement.
- Conflicting amounts, recipients, assets, networks, or action IDs fail closed.
- Duplicate and replayed authorizations are detected.
- Expired requirements and mandates are rejected.

### Privacy

- No private policy, label, note, prompt, or response body enters network calls.
- No wallet cookies or account identity enter credentialless requests.
- Request logs use route templates and omit bodies.
- Raw encrypted storage contains no plaintext canaries.
- Lock aborts pending requests and invalidates late writes.
- Export, import, recovery, and deletion preserve or remove every evidence type.

### Arc Testnet integration

- Exact configured network and USDC contract.
- Balance and transaction values remain exact decimal strings.
- Reorganization/finality behavior is explicit.
- Provider outage preserves prior evidence and labels it stale.
- Gateway and onchain settlement references reconcile where expected.
- A controlled x402 test produces a complete evidence arc.

### UX and accessibility

- Every state has text and icon treatment, not color alone.
- Keyboard and screen-reader journeys cover the complete investigation.
- Mobile timelines remain chronological and readable.
- Reduced motion preserves meaning.
- Unknown, stale, partial, failed, and conflicting states are understandable.

## Mainnet activation conditions

Do not claim Arc mainnet availability until all of the following are recorded:

1. Official chain ID, RPC, explorer, fee-asset, USDC, Gateway, and relevant
   contract addresses.
2. Official confirmation of the Circle capabilities OpenArc depends on.
3. Provider terms, cost ceilings, authentication, privacy, and retention review.
4. Trademark and non-affiliation review for Arc, Circle, USDC, x402, and partner
   names.
5. Independent application and local-encryption security review.
6. Exact mainnet staging, source-discrepancy, outage, budget, and rollback tests.
7. Monitoring, backups, incident ownership, and support contact.
8. An explicit human decision to enable the mainnet feature flag.

## Success criteria

The first prototype succeeds when a test user can answer, without opening five
systems:

- Who or what initiated this action?
- Which policy or mandate applied?
- What amount and destination were authorized?
- Was the resource returned?
- Did the payment settle?
- Which sources support each statement?
- What remains unknown?

That is the smallest defensible expression of OpenArc.
