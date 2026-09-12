# PORT-01 foundation gate

Accepted locally September 12, 2026. This closes the first implementation phase
of the commerce port: shared foundations, first-party account access, tenant
ownership and management, durable mutations, agent/provider credentials,
notification outbox worker, protected consoles and public capability metadata.
It does not complete the marketplace, financial controls, purchases, reputation,
job execution or the whole target port.

## Exact candidate and checks

Source candidate: `deeef7901d4f0d8ee6719bae5bfce485aac13f3e`.
The later verification-record commit changes documentation only.

- `pnpm release:gate` in the pinned Node22 Docker runner: **passed**.
- Unit/integration tests: **1,442** (shared470, database126, API497, web321,
  worker28).
- Development-browser tests: **261**, including the supplied frontend, videos,
  private Vault compatibility, account/tenant integration and machine console.
- Release checks, production dependency audit, license policy, lint, type checks
  and builds: **passed**.
- Combined deployment/CI guard tests: **101 passed**, using the exact reviewed
  public workflow as an explicit local fixture.
- Real PostgreSQL suites: **236 database + 53 API + 9 worker tests passed**.
  Their tested source is `17f817071b17fb47afbab49d2590f0693841bb9d`; subsequent
  candidate changes touch web lifecycle clearing, browser fixtures and evidence
  only, not those database/API/worker inputs.
- Account-browser supplement: initially26/27 passed during local memory pressure;
  after retiring completed disposable test databases, the exact failed
  guest-refresh case passed alone without a source change. This is deliberately
  not reported as an uninterrupted27/27 run. Public CI repeats the complete suite.
- Actual production machine browser acceptance: **14 enabled + 1 disabled passed**
  against rebuilt nginx images, real API/schema5 and disposable passkey accounts.
  See [production evidence](port-01-machine-production.md).
- Source export screening:113 changed files plus the public workflow passed
  personal-identifier checks and a1.72MB redacted secret scan with no findings.

The isolated full-gate image is
`sha256:7f39b0895535ef8191e6e3b40e1ba3dac00ab1c53c568055b080d8c8272f3a0a`.
All application implementation and tests were authored through OpenCode Go
`opencode-go/deepseek-v4.1-flash`; the lead handled planning, review, integration
and independent test execution. No private Git ancestry is included in public
source exports, and public author/committer identities remain project-branded.

## Boundaries and next phase

Hosted account enrollment remains disabled; no hosted account database or new
recurring vendor spend has been enabled. Stable relying-party/domain setup and
deployment activation are separate from this local production-image gate.
Passkeys retain minimal pseudonymous/public-key security records, not zero data.
Guest access remains account-free. Human sign-in and current read-only machine
credentials do not authorize payments. No personal wallet or real funds were used.

PORT-02 may now implement marketplace/provider listing contracts, immutable
versions, catalog APIs and supplied-style screens. Purchases must remain visibly
unavailable until the later financial and payment phases are accepted. Publication
and its public CI result are distinct from this source gate and from deployment.
