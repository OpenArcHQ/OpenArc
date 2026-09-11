# PORT-01 account foundation — verified September 11, 2026

Status: **foundation built, tested, merged and pushed; account login not enabled**.
This is one PORT-01 increment, not acceptance of the whole commerce port.

## Accepted scope

- Pinned PostgreSQL package, checksummed numbered migrations, explicit migrator
  and restricted application roles, and isolated real-database regression tests.
- Account/passkey/wallet/challenge/session/recovery-hash schema. Organization
  tenancy/RLS, spending authority, audit/outbox and commerce repositories are not
  included in this authentication-only schema.
- Maintained WebAuthn proof adapter with user verification and exact origin/RP
  checks; strict EOA SIWE login proof on Arc Testnet, with no payment permission.
- Public CI now runs the real PostgreSQL suite in a disposable, network-isolated
  database with synthetic fixture credentials. No external database is touched.

Application implementation and tests were authored by DeepSeek V4.1 Flash through
OpenCode Go. Lead work covered contracts, review, isolated verification and release.

## Candidate evidence

Private source candidate `08ce64a088fb2c5f36da38b8cacfd7875e70fbbb` passed the full
Node22 Docker release gate: structural checks, production dependency audit,
licenses, lint, source types, **748 unit/integration tests**, build, and **112
Chromium/WebKit browser cases**. The browser cases exercise the existing product,
not a new sign-in screen.

Public source candidate `5cd3b683ed7baeb873fbd8ad5ee8fb4b4e08cf46` passed
[source CI34657224179](https://github.com/OpenArcHQ/OpenArc/actions/runs/34657224179):
**752 unit/integration tests**, the same112 browser cases, and **15 additional real
PostgreSQL tests**. Four pre-existing public-only API tests explain the count
difference. [PR5](https://github.com/OpenArcHQ/OpenArc/pull/5) is merged.

Focused foundation checks passed: DB unit40; proof adapter79; real PostgreSQL15;
strict source/test type checks and lint. The proof tests include actual ephemeral
EOA signatures. WebAuthn verification tests use SDK mocks: real browser
registration/authentication remains a separate required acceptance step.

Public source/history secret scans and the10-commit identity guard passed. Public
author and committer use the OpenArc project identity. No private ancestry was
imported. No Railway configuration or real wallet/fund operation was performed.

## Boundaries and next dependencies

This increment does not expose account endpoints or enrollment. Durable account
operations, cookies/CSRF/rotation/recovery, the actual wallet/passkey interface and
real-browser cryptographic acceptance are subsequent PORT-01 work. Supplied frontend
integration is separate from existing browser regression coverage. Temporary
origins are for disposable test accounts; do not enroll real users before the
stable login origin is settled.

No mainnet, marketplace, agent-purchase, financial-budget or launch-ready claim
follows from these results. Subsequent source changes require their own evidence.
