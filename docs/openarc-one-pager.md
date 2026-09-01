# OpenArc

## See the full arc of every agent action

OpenArc is a proposed private intelligence, policy, and investigation layer for
economic agents on Arc. It connects supplied permissions, actions, payments,
service receipts, and settlement evidence so people can understand what an agent
was allowed to do, what it attempted, and what actually happened.

Status: **Arc Testnet concept; not a live or mainnet product**

## The problem

Economic agents can discover services, initiate payments, and interact with
onchain systems at machine speed. The evidence those actions create is fragmented:

- Owner policy may live in one application.
- Agent requests and tool calls may live in another.
- Payment authorization may be carried through x402.
- Service fulfillment may be recorded offchain.
- Gateway settlement and Arc transactions may appear later.

A transaction hash proves that something executed. It does not independently
prove who authorized it, why the agent acted, or whether the requested service
was fulfilled.

## The answer

OpenArc gives every supported action one evidence arc:

```text
Permission → Attempt → Authorization → Fulfillment → Settlement → Reconciliation
```

Each state retains its source. OpenArc distinguishes local declarations, signed
authorizations, agent-reported events, provider receipts, facilitator records,
and onchain facts instead of flattening everything into one “verified” label.

## The first product

One controlled Arc Testnet investigation:

- Label one test wallet as an agent.
- Record a local monitoring policy.
- Follow one x402-compatible USDC service payment.
- Reconcile the payment requirement, authorization, provider response, Gateway
  state, and settlement reference.
- Flag missing, expired, stale, or conflicting evidence.
- Keep local labels, policies, and notes in an encrypted workspace.

## Why it matters

Arc and Circle infrastructure are creating programmable stablecoin rails for
agents. Faster economic execution creates a corresponding need for human-readable
oversight. OpenArc is designed to occupy that missing layer without becoming the
wallet, custodian, or transaction executor.

## Who it serves

- Agent builders debugging paid workflows.
- Operators monitoring budgets and exceptions.
- Finance teams reconciling authorized and settled activity.
- Security teams investigating mismatched evidence.
- Arc builders who need a readable operator surface.

## Product principles

- Evidence before interpretation.
- Authorization is not settlement.
- Settlement is not fulfillment.
- Unknown is a valid state.
- Human authority remains visible.
- Private operating context stays local by default.
- No custody, seed phrases, signing, or broadcasting.

## Positioning

> Arc is the settlement environment. OpenArc is the evidence and investigation
> interface above it.

OpenArc is not an Arc or Circle product. Initial work is planned for Arc Testnet.
Mainnet support requires official network parameters, supported integrations,
privacy and provider review, independent security work, and a separately verified
release.

## Working brand language

- **Primary:** See the full arc of every agent action.
- **Plain English:** See what was allowed. See what happened.
- **Developer:** One evidence model for intent, execution, fulfillment, and settlement.
- **Category:** Agent operations intelligence and investigation.

## Near-term milestones

1. Validate the evidence model with agent builders and operators.
2. Build the encrypted local simulator and failure fixtures.
3. Connect one controlled Arc Testnet wallet and x402 flow.
4. Run a small design-partner alpha.
5. Certify a public Testnet beta.
6. Evaluate Arc mainnet only after official production support is available.

## Contact fields

```text
PRODUCT_URL=[CONFIRM BEFORE POSTING]
OFFICIAL_X_HANDLE=[CONFIRM BEFORE POSTING]
OFFICIAL_GITHUB=[CONFIRM BEFORE POSTING]
CONTACT=[CONFIRM BEFORE POSTING]
```

