# OpenArc marketing and technical product package

Status: **Milestone 02 encrypted workspace active; Arc Testnet fixture-only**
Prepared: **2026-08-15; network facts re-verified 2026-09-01**

OpenArc is the proposed private intelligence, policy, and investigation layer for
autonomous finance on Arc. It is designed to bring an agent's permissions,
requests, payments, service receipts, and settlement evidence into one coherent
view without taking custody or pretending that an onchain transfer proves why an
agent acted.

Nothing in this package is a claim that OpenArc is live, endorsed by Circle or
Arc, available on Arc mainnet, or able to enforce another wallet's policies.

Arc has announced public mainnet for September 16, 2026. OpenArc remains pinned
to Arc Testnet until official mainnet endpoints, contract addresses, capability
parity, and a separately reviewed mainnet release exist.

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

The immutable Milestone 00 foundation and Milestone 01 evidence engine are
complete. Milestone 02 is adding an encrypted local workspace around the strict,
fixture-only evidence engine without introducing any live connector:

- `packages/shared` owns the fail-closed Arc Testnet registry and primitive
  schemas, versioned evidence records, append-only action states, deterministic
  reconciliation, and exact local policy evaluation.
- `apps/api` is a Fastify health/readiness shell with no provider calls or user
  persistence.
- `apps/web` exposes six synthetic complete, missing, conflicting, expired,
  failed, and refunded cases as an accessible chronological list plus an exact
  graph summary. The separately flagged M02 workspace uses only browser-local
  WebCrypto and IndexedDB; neither surface makes an API, RPC, wallet, or
  analytics call.
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
active local-only M02 boundary is in
[`docs/releases/02-encrypted-workspace.md`](docs/releases/02-encrypted-workspace.md).

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
