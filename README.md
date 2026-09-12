# OpenArc marketing and technical product package

Status: **legacy investigation app on controlled staging; commerce port in progress**
Prepared: **2026-08-15; Arc and Gateway sources reviewed 2026-09-06**

OpenArc is the proposed private intelligence, policy, and investigation layer for
autonomous finance on Arc. It is designed to bring an agent's permissions,
requests, payments, service receipts, and settlement evidence into one coherent
view without taking custody or pretending that an onchain transfer proves why an
agent acted.

Nothing in this package is a claim that OpenArc is publicly launched, endorsed by Circle or
Arc, available on Arc mainnet, or able to enforce another wallet's policies.

OpenArc remains pinned to Arc Testnet. A launch-date expectation does not enable
mainnet: official endpoints, contract addresses, capability parity and a separately
reviewed mainnet release are required first.

![OpenArc concept logo](assets/openarc-logo.jpeg)

## Documents

- [`output/pdf/OpenArc-Marketing-Brief.pdf`](output/pdf/OpenArc-Marketing-Brief.pdf) — polished, visually verified 45-page marketing and technical distribution brief.
- [`docs/engineering/openarc-engineering-source-of-truth.md`](docs/engineering/openarc-engineering-source-of-truth.md) — controlling engineering scope, shared contracts, mandatory implementation order, release mechanics, and definitions of ready/done.
- [`docs/engineering/openarc-backend-architecture.md`](docs/engineering/openarc-backend-architecture.md) — normative API, adapter, privacy, rate/budget, observability, testing, and deployment specification.
- [`docs/engineering/openarc-frontend-architecture.md`](docs/engineering/openarc-frontend-architecture.md) — normative Vault, UI state, consent flow, evidence visualization, accessibility, testing, and deployment specification.
- [`docs/openarc-marketing-sourcebook.md`](docs/openarc-marketing-sourcebook.md) — canonical Testnet facts, proposed architecture, positioning, messages, claims, campaign copy, FAQ, and content system.
- [`docs/openarc-technical-spec.md`](docs/openarc-technical-spec.md) — detailed Arc Testnet parameters, integration surfaces, schemas, data flow, privacy boundary, failure states, verification plan, and mainnet migration gate.
- [`docs/openarc-one-pager.md`](docs/openarc-one-pager.md) — compact team, partner, and early pitch narrative.
- [`docs/openarc-product-blueprint.md`](docs/openarc-product-blueprint.md) — proposed product boundary, evidence model, architecture, MVP, and verification plan.
- [`docs/openarc-brand-system.md`](docs/openarc-brand-system.md) — logo interpretation, palette, typography, interface language, graphics, and motion guidance.
- [`docs/openarc-launch-plan.md`](docs/openarc-launch-plan.md) — testnet launch stages, operational gates, external approvals, and incident language.
- [`docs/openarc-roadmap.md`](docs/openarc-roadmap.md) — staged development from evidence explorer to optional machine-readable services and mainnet support.

## Current implementation

The supplied commerce specification is now the target. Shared contracts, durable
account/session/recovery foundations, passkey/wallet login and the supplied public
design are implemented. Organization authorization, marketplace, financial
controls and the protected frontend transition remain in progress. Account access
defaults off. Milestone results below describe the legacy investigation product,
not supplied S-M00–S-M09.
See [commerce transition and build order](docs/engineering/commerce-transition.md).

Milestones 00–09 are complete: foundation, evidence engine, encrypted local
workspace, consent-first API boundary, Arc account/transaction observations,
ERC-8004 registry evidence, fixed-reference ERC-8183 job evidence, and private
x402/Gateway metadata comparison, local agent-report/policy comparison, and local
investigation operations.
Gateway controls are behind the default-off
`GATEWAY_EVIDENCE_ENABLED` / `VITE_GATEWAY_EVIDENCE_ENABLED` flags.
The completed release gates and controlled live Testnet evidence are recorded in
[`docs/releases/07-x402-gateway-evidence.md`](docs/releases/07-x402-gateway-evidence.md).
This is not a public-release or mainnet readiness claim.

[M07 preflight](docs/engineering/m07-x402-preflight.md) records the refreshed
Gateway contract and external live-payment proof boundary. M08 adds bounded local
agent reports and monitoring-policy comparison behind the default-off
`VITE_GENERIC_AGENT_IMPORT_ENABLED` flag; it introduces no execution path.
Its completed scope and verification evidence are recorded in
[`docs/releases/08-local-agent-connector.md`](docs/releases/08-local-agent-connector.md).

M09 adds local search, exception views, graph/list evidence inspection, saved source
history and explicit redacted JSON reports. Its active contract and verification
ledger are in [`docs/releases/09-investigation-operations.md`](docs/releases/09-investigation-operations.md).
M09 is complete on controlled staging; no new API or execution path is added.
Its final gate includes 524 unit/integration tests, 112 development and 44 production
browser checks, ten image scans, historical-reader compatibility and 32 live staging
checks. Public Testnet hardening and external launch decisions remain M10; this is
not public-launch or mainnet approval.

- `packages/shared` owns the fail-closed Arc Testnet registry and primitive
  schemas, versioned evidence records, append-only action states, deterministic
  reconciliation, and exact local policy evaluation.
- `apps/api` uses bounded, fixed public Testnet reads only when the corresponding
  connector is enabled and a browser request crosses the consent/proxy/rate-limit
  boundary. It does not persist workspace or evidence bodies.
- `apps/web` exposes six synthetic complete, missing, conflicting, expired,
  failed, and refunded cases as an accessible chronological list plus an exact
  graph summary. The encrypted workspace uses browser-local WebCrypto and
  IndexedDB. Source-enabled builds require explicit consent per API lookup;
  approval is encrypted before contact. These legacy flows make no wallet-signing
  or analytics calls. The separate optional account route can request a wallet
  login signature, never a transaction or payment authorization.
- `.github/workflows/release-gates.yml`, production Dockerfiles, Chromium and
  WebKit journeys, license/audit checks, image scans, and SBOM generation form
  the initial verification boundary.

With Node 22 and Corepack available:

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm release:gate
```

The foundation evidence record is in
[`docs/releases/00-foundation.md`](docs/releases/00-foundation.md). The Milestone
01 boundary and completed exit evidence are in
[`docs/releases/01-evidence-engine.md`](docs/releases/01-evidence-engine.md). The
completed local-only M02 boundary is in
[`docs/releases/02-encrypted-workspace.md`](docs/releases/02-encrypted-workspace.md).
The completed M03 boundary and ordered work are in
[`docs/releases/03-api-privacy-boundary.md`](docs/releases/03-api-privacy-boundary.md).

## Logo

The supplied concept logo is preserved at [`assets/openarc-logo.jpeg`](assets/openarc-logo.jpeg).
It is a raster concept with deliberate grain. Obtain a vector master, trademark
search, and small-size optical variants before public launch.

## Canonical short description

> OpenArc brings an agent's permissions, actions, payments, receipts, and
> settlements into one evidence trail—so people can understand what was allowed,
> what was attempted, and what actually happened.

## Working tagline

> **See the full arc of every agent action.**
