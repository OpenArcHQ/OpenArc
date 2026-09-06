# OpenArc roadmap

Status: **concept roadmap**  
Prepared: **2026-08-15**

The sequence below is a dependency order, not a public date promise. Every phase
begins only after the preceding phase's privacy, evidence, and failure-state gates
are complete.

The normative engineering sequence is maintained in
`docs/engineering/openarc-engineering-source-of-truth.md`. If this concept roadmap
and the engineering milestones differ, the engineering source of truth wins.

## Phase 0: Evidence foundation

Promise: **Define what every record proves.**

- Versioned action envelope and six-class evidence model.
- Deterministic reconciliation state machine.
- Local agent profiles and monitoring policies.
- Encrypted local workspace, backup, recovery, lock, and deletion.
- Simulated complete, incomplete, conflicting, expired, refunded, and failed
  action fixtures.
- Redacted investigation report.

Exit result: OpenArc can explain test evidence without a live network.

## Phase 1: Arc Testnet activity

Promise: **See what an agent wallet did on Arc Testnet.**

- Capability-based Arc Testnet adapter.
- User-labeled agent wallet.
- Exact USDC balances, transfers, fees, timestamps, and settlement references.
- Explorer/RPC source links and freshness.
- Reorganization, provider outage, and stale-evidence states.
- No automatic address-to-agent inference.

Exit result: One bounded public-wallet investigation works read-only.

## Phase 2: Payment reconciliation

Promise: **Follow one API payment from requirement to settlement.**

- x402 payment-requirement and authorization normalization.
- Controlled provider fulfillment receipt.
- Gateway verification/batching state where supported.
- Arc settlement reconciliation.
- Amount, asset, recipient, network, expiry, and replay checks.
- First complete controlled evidence arc.

Exit result: One Arc Testnet x402 action can be investigated end to end.

## Phase 3: Agent policy and connectors

Promise: **Compare what agents did with the boundaries owners supplied.**

- Bounded generic agent-event connector.
- Local per-action, daily, recipient, contract, and service policies.
- Optional signed-mandate support, including AP2 only after versioned validation.
- Human approval and policy-expiry states.
- Connector capability and privacy receipts.
- Explicit local-monitoring versus wallet-enforced status.

Exit result: Multiple frameworks can contribute evidence without becoming trusted
by default.

## Phase 4: Investigation operations

Promise: **Turn scattered failures into a clear incident trail.**

- Search across local action IDs, transactions, services, and authorizations.
- Evidence graph and expected-versus-observed view.
- Exception inbox and unresolved-action queue.
- Redacted team reports and export.
- Source-health, freshness, and reconciliation dashboards.
- Optional encrypted team sharing only after a dedicated security design.

Exit result: OpenArc supports repeatable operator workflows, not only individual
transaction views.

## Phase 5: Machine-readable OpenArc

Promise: **Let tools consume bounded evidence conclusions.**

- Versioned read-only schema for action status and evidence gaps.
- Strictly scoped MCP/A2A-compatible surfaces where useful.
- No private workspace data in public endpoints.
- Source class, timestamp, limitation, and confidence on every result.
- Credential, rate, budget, and abuse controls.
- Optional x402-paid service only after security, legal, tax, accounting, and
  commercial review.

Exit result: Agents can ask OpenArc for a bounded conclusion without receiving
private operator context or raw restricted payloads.

## Phase 6: Arc mainnet

Promise: **Bring the proven investigation model to production Arc activity.**

- Official mainnet network and Circle capability registry.
- Testnet/mainnet isolation and false-by-default flag.
- Production provider, privacy, legal, budget, and retention review.
- Read-only observation before authenticated account connectors.
- Independent security review.
- Mainnet staging, soak, outage, discrepancy, rollback, and incident drills.

Exit result: A separately certified mainnet release—not a configuration flip.

## Later opportunities

These are not committed features:

- Crosschain Gateway and CCTP reconciliation.
- Agent-to-agent payment graphs.
- Verifiable policy/proof integrations such as ZK attestations.
- Service reliability based on observable evidence, without inventing universal
  reputation scores.
- Tokenized-asset and RWA treasury views.
- Organizational policy packs and approval workflows.
- Private multi-device operations workspace.

## Permanent exclusions unless the product boundary changes

- OpenArc custody of user or agent funds.
- Seed-phrase collection.
- Hidden transaction signing or broadcasting.
- Storage of model chain-of-thought.
- Universal agent reputation based on opaque scoring.
- “Compliance certified” conclusions generated solely from OpenArc evidence.
- Guaranteed fulfillment, settlement, security, or investment outcomes.

## Strategic checkpoints

After Phase 2:

- Is payment reconciliation a repeated problem or only a compelling demo?
- Which evidence is unavailable without privileged Circle/provider accounts?
- Can a useful investigation be completed without collecting sensitive prompts?

After Phase 3:

- Are builders willing to emit the bounded connector events?
- Which controls are actually enforceable by wallet infrastructure?
- Does AP2 adoption justify a production adapter?

Before Phase 5:

- Do operators need a machine interface, or is the human investigation UI the
  core value?
- Would x402 monetization strengthen the product or distract from oversight?

Before Phase 6:

- Are official mainnet capabilities stable?
- Can OpenArc operate within its privacy, cost, and provider constraints?
- Have security, legal, support, and incident owners approved enablement?
