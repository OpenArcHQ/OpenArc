# PORT-01 account service and supplied design

Status: **accepted locally; combined release and account acceptance gates passed**.
This increment does not complete the commerce port or enable public enrollment.

## Scope

- Durable passkey/EOA-login accounts, opaque hash-only sessions, single-use
  origin/session-bound challenges, CSRF protection, rotation, logout and optional
  recovery codes. Login is not permission to pay or operate an agent.
- Exact `/v2/auth/*` routes with strict v2 envelopes and bounded errors, including
  parser/body-limit failures. Account access defaults off and fails closed when
  required runtime, database or origin configuration is missing.
- Supplied blue/gold public design at `/design`, the original local background
  video, three canonical technical-document tabs and a dedicated FAQ. Existing
  `/` and `/workspace` behavior is preserved; illustrative console images are
  labelled, not passed off as live commerce output.
- Same-origin production stylesheet assets and media, without permitting inline
  scripts/styles or eval. Schema validation is configured in CSP-safe mode before
  application modules load.
- Exact account proxy allowlist, verified upstream TLS, no body/access logging,
  no proxy retry/cache, and explicit request-header forwarding. Unknown account
  routes are rejected. Auth cannot be enabled without the API boundary.

Implementation and tests are authored by DeepSeek V4.1 Flash through OpenCode Go.
Lead work covers contracts, review, isolated verification and release integration.

## Completed component checks

Component-specific results:

| Component | Evidence |
| --- | --- |
| AuthStore | 65 real PostgreSQL cases, including 50 new durable-account cases; DB units/types/lint passed. |
| Shared/API account service | 340 shared tests, 299 API tests, 5 real-PostgreSQL API wiring cases; relevant types/lint/build passed. The 5 API wiring cases mock proof adapters and are not browser-cryptography evidence. |
| Supplied frontend | 133 web units, 40 Chromium/WebKit development cases and the same 40 cases against the real Docker/nginx production image; types/test types/lint/build passed. |
| Production proxy | 16 structural guards; actual nginx bootstrap and SDK registration-options requests passed through verified TLS. Unknown paths, wrong Origin, extra query data and an untrusted upstream certificate were rejected. Invalid account/API build-flag combinations failed. |
| Account UI | 65 focused account units; 194 web units in its isolated worker snapshot; 27 Chromium/WebKit account browser cases, including real CDP passkeys, real ephemeral EOA signatures and real PostgreSQL persistence. Relevant source/test types, lint and build passed. The final supplied frontend adds separate tests; combined totals remain pending. |
| Production account journeys | 11 Chromium cases against actual production API and nginx web images, with verified upstream TLS and a disposable database. Full passkey/recovery and EOA journeys, CSP, CSS, hardened cookies, storage/URL privacy and usable logout passed. No proof or database adapter was mocked. |

Manual inspection of the production frontend confirmed the supplied design and
playing local video. The Linux WebKit runner takes approximately 8.6 seconds on
the home-video journey with or without tracing; traces show the DOM mounting in
roughly 0.36 seconds. Assertions wait for the actual mount marker and retain
stylesheet, CSP, media, keyboard and route checks. This is not a measured Safari
performance claim.

Account review corrections cover intended-account binding, late-result guards,
continuous wallet-event cancellation, exact SIWE messages and expiry, recovery
display clearing and honest unknown mutation outcomes. Regression tests include
successful logout followed by usable sign-in controls and a disconnect while
the wallet's account recheck is pending.

The production fixture uses `https://account.openarc.test:5443`, resolved to
loopback only inside Chromium. It uses generated test certificates; browser
certificate exceptions apply only to that fixed fixture. The application still
rejects production localhost relying-party configuration, and nginx upstream
certificate verification remains enabled. No OS trust or DNS configuration was
changed. Traces, screenshots and video recording are disabled in account suites.

The clean combined gate initially exposed two integration issues: a legacy
assertion still prohibited all media, and account API tests consumed the new DB
package before it was built. The corrected checks require self-only media, and
development/test entry points now build shared and DB dependencies first.
The final clean Node22 Docker source gate passed dependency audit, license policy,
lint, typecheck, **877 unit/integration tests**, builds and **152 development
browser checks**. A separate run of that exact gate image passed **16 deployment
guards**, **65 database tests**, **5 PostgreSQL API tests** and **27 account browser
checks**. The separately assembled production stack passed the 11 account
journeys described above. No retries or skipped failures were used.

The source gate image digest is
`sha256:bbf3d4cc5824b50e2df0d1ae31f33cd106a95b864c5bb97ac39b17c52e1475f6`.
The production-account web image digest is
`sha256:7e76b1ebddc3aa0696d79925c396fde35639d7b0f8f37ce40c3573e6a50ea593`.
Source was frozen for these runs; subsequent README/evidence edits only describe
the results. Public CI, deployment, historical-reader/image-scan gates and real
enrollment are separate boundaries, not implied by this local acceptance.

## Boundaries

No real user wallet, private key, funded transaction or paid provider was used.
Database fixtures, EOA proofs and browser authenticators are disposable test
material. Passkeys retain credential public keys/IDs and necessary pseudonymous
security records; they are not anonymous or zero-retention accounts.

Temporary origins are for disposable enrollment only. A stable relying-party
origin is required before inviting real account holders. Organization/tenant
authorization is separate from account sign-in and remains a subsequent gate.
Marketplace, financial budgets, grants, purchases, entitlements and mainnet are
not enabled by this increment.
