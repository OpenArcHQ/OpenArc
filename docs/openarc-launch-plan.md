# OpenArc testnet and public-launch plan

Status: **planning document**  
Prepared: **2026-08-15**

This is a product, engineering, and communications risk record—not legal advice.

Implementation order and technical release gates are controlled by
`docs/engineering/openarc-engineering-source-of-truth.md`. This document cannot
authorize work from a later engineering milestone.

## Launch principle

OpenArc should not launch as a broad “control center for every agent.” It should
earn that category through one narrow, inspectable Arc Testnet investigation.

The first public proof should answer:

> Can OpenArc reconcile one owner-supplied policy, one agent request, one x402
> payment authorization, one provider response, and one settlement path without
> inventing evidence?

## Stage 0: concept validation

Public status: **research/design**

Deliverables:

- Product blueprint and evidence taxonomy.
- Ten interviews across agent builders, operators, finance, and security.
- Three real failure narratives stripped of private data.
- Confirmed availability and terms for every proposed Testnet source.
- Trademark search and naming decision.
- Cost model that defaults to zero incremental recurring vendor spend during the
  prototype.

Exit criteria:

- At least five interviewees independently describe reconciliation or
  investigation as a recurring problem.
- The evidence model represents their failure cases without a universal-agent or
  hidden-reasoning assumption.
- One viable controlled Arc Testnet x402 flow exists.

## Stage 1: local evidence simulator

Public status: **private prototype**

Build:

- Encrypted local workspace.
- Agent profile and local policy.
- Versioned action and evidence schemas.
- Simulated authorization, fulfillment, settlement, conflict, and missing-data
  fixtures.
- Investigation timeline and evidence graph.
- Exportable redacted report.

No live wallet connection is necessary for this stage.

Exit criteria:

- Every state transition is deterministic and tested.
- The UI never collapses authorization into settlement or settlement into
  fulfillment.
- Lock, export, recovery, and deletion cover every record type.
- Full keyboard, screen-reader, reduced-motion, and mobile journeys pass.

## Stage 2: controlled Arc Testnet vertical

Public status: **closed Testnet alpha**

Build:

- One user-labeled Arc Testnet wallet.
- Bounded USDC balance and activity.
- One controlled x402-compatible test resource.
- Payment requirement, authorization metadata, provider response, Gateway state,
  and settlement evidence.
- Local policy comparison.
- Provider outage, expired request, mismatch, delayed settlement, and incomplete
  evidence states.

Safety boundary:

- Testnet funds only.
- No seed phrase or private-key entry into OpenArc.
- No automatic signing or transaction submission.
- Exact source destinations disclosed before network calls.
- No raw prompt or service-response storage by default.

Exit criteria:

- The complete controlled action reconciles from policy to settlement.
- Deliberately incomplete actions remain incomplete.
- Conflicting evidence fails closed.
- Late responses cannot write after lock or session replacement.
- Source outage preserves prior evidence and marks it stale.
- No private canary appears in logs, requests, raw local metadata, or analytics.

## Stage 3: design-partner alpha

Public status: **invite-only Testnet alpha**

Scope:

- Three to five approved design partners.
- Bounded generic agent-event connector.
- Per-connector capability and privacy disclosure.
- Structured feedback and incident channel.
- No production funds and no mainnet promise.

Entry criteria:

- Independent application-security review of the local-encryption, connector,
  and request boundaries.
- Named support and incident owner.
- Alerting, backups for service-owned operational data, and rollback procedure.
- Published privacy notice and Testnet terms.

Exit criteria:

- At least three distinct agent workflows produce useful investigation trails.
- Connector failures do not create false `RECONCILED` conclusions.
- Operators can identify a failed evidence layer faster than with the underlying
  systems alone.
- No unresolved high-severity security or privacy issue.

## Stage 4: public Arc Testnet beta

Public status: **public Testnet beta**

Requirements:

- Permanent beta origin before users create encrypted browser workspaces.
- Exact version and deployed SHA visible in the product.
- Product and documentation agree on supported agents, networks, evidence states,
  retention, and threat model.
- Rate, budget, and provider kill switches.
- Public status page and security contact.
- Tested export, recovery, deletion, provider outage, and rollback.
- No unsupported connector shown as available.
- Every public screenshot and demo uses controlled Testnet data.

Testnet beta still does not justify production-funds or mainnet claims.

## Stage 5: Arc mainnet candidate

Do not schedule this stage against an assumed mainnet date.

Required network evidence:

- Official Arc mainnet chain ID, RPC, explorer, finality model, fee asset, and
  supported contracts.
- Official Circle support for every required Agent Stack, USDC, Gateway, and x402
  capability.
- Exact differences from Arc Testnet documented and tested.
- Independent provider/source identity and failover plan.

Required product evidence:

- Mainnet mode is a separate false-by-default feature flag.
- No Testnet address, domain ID, contract, or faucet path can enter mainnet mode.
- Read-only mainnet observation passes before any authenticated Circle connector.
- Monetary values remain exact strings with explicit currency and network.
- Reorganizations, delayed settlement, duplicate authorization, replay, refunds,
  and source conflicts are covered.
- Production load, retention, privacy, monitoring, and rollback gates pass.

Required external approvals:

- Legal operator and jurisdiction.
- Privacy policy and terms.
- Trademark/non-affiliation language for OpenArc, Arc, Circle, USDC, Gateway,
  x402, and connected products.
- Provider API terms, data-use, retention, and commercial review.
- Independent security review and documented findings.
- Incident response and responsible-disclosure process.
- Accounting/tax review before OpenArc accepts any payment.

## Feature enablement matrix

| Feature | Concept | Testnet alpha | Public Testnet | Mainnet |
|---|---:|---:|---:|---:|
| Local encrypted workspace | planned | required | required | required |
| Simulated evidence arcs | planned | enabled | enabled | enabled |
| Arc wallet observation | planned | one controlled path | bounded supported path | separate gate |
| x402 investigation | planned | one controlled path | documented support | separate gate |
| Gateway reconciliation | planned | where supported | documented support | separate gate |
| Generic agent connector | schema only | bounded pilot | allowlisted | separate gate |
| AP2 mandates | research | fixture/optional | versioned if verified | separate gate |
| Wallet-enforced policy | no claim | no claim unless proven | connector-specific | connector-specific |
| OpenArc signing/execution | excluded | excluded | excluded | excluded |
| Paid OpenArc API | excluded | excluded | excluded | separate future review |

## Operational gates

Before any external user test:

- Structured route-template logs with no wallet/address/body leakage.
- Health and readiness endpoints.
- Connector latency, error, stale-state, and reconciliation metrics.
- Alerts for source outage, rate/budget exhaustion, retention failure, and repeated
  conflicting evidence.
- Exact deploy marker and reversible rollback.
- Dependency inventory, license policy, vulnerability scan, and SBOM.
- Backup/restore proof for service-owned operational data.
- No private local workspace material in server backups.

## Privacy gates

- Exact permission receipt before optional network disclosure.
- Agent labels, local policies, notes, prompts, and evidence associations stay
  local unless the user explicitly exports them.
- Credentialless calls omit account cookies and authorization headers.
- Connected account tokens remain server-side or in an approved secure session,
  never in browser-readable persistent storage.
- Raw payment signatures are not persisted unless a narrowly reviewed protocol
  requirement makes it unavoidable.
- Full resource URLs are redacted by default.
- Data export and deletion are real, tested operations.

## Product-truth gates

- “Agent” classification names its source.
- “Enforced” names the enforcing wallet/control.
- “Verified” names the validation performed.
- “Settled” requires the defined authoritative settlement source.
- “Fulfilled” names the provider receipt and its limitation.
- “Reconciled” requires every mandatory evidence layer for that action type.
- “Current” includes observation time and stale threshold.
- “Private” names what is local/encrypted and what remains exposed.

## Communications gate

Before announcing availability:

- Replace every `[CONFIRM BEFORE POSTING]` field used in the announcement.
- Publish non-affiliation language.
- Link the exact supported-capability matrix.
- Mark Testnet clearly in the hero, navigation, screenshots, and CTA.
- State that OpenArc does not sign or broadcast.
- State that incomplete evidence remains possible.
- Avoid mainnet countdowns, transaction-volume claims, and invented customer
  numbers.

## Incident priorities

P0:

- Key or reusable authorization exposure.
- OpenArc submits or signs an unintended action.
- Private policy/prompt/URL appears in logs or public responses.
- Incorrect network/contract causes a mainnet-versus-Testnet action confusion.
- A false reconciled state hides a material recipient or amount mismatch.

P1:

- Authorization shown as settled.
- Settlement shown as fulfilled without a receipt.
- Local monitoring policy shown as wallet-enforced.
- Source outage silently produces a valid-empty result.
- Late response writes after workspace lock.
- Mainnet copy appears while only Testnet is supported.

## Launch definition

OpenArc is ready for a public Arc Testnet beta only when a new user can:

1. Understand the product boundary before connecting anything.
2. Create and recover an encrypted local workspace.
3. Label one controlled Testnet agent wallet.
4. Review an exact network-permission receipt.
5. Follow one action from policy through available evidence and settlement.
6. Distinguish fact, supplied evidence, interpretation, and unknown.
7. Export a redacted report.
8. Lock and delete the workspace.
9. Recover safely from connector outage and stale evidence.

Mainnet readiness is a later release with its own evidence; it is not inherited
from a successful Testnet beta.
