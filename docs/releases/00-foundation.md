# Milestone 00 — repository and verification foundation

Status: **complete — immutable `rc/00-foundation/1`**
Network review: **2026-09-01**

## Frozen boundary

Milestone 00 creates the pnpm/TypeScript repository, shared primitive schemas,
one Arc Testnet registry, a Fastify health/readiness shell, a React/Vite web
shell, production Docker images, CI, and verification tooling.

It does not call Arc RPC, create an encrypted Vault, accept agent identifiers,
connect a wallet, sign or broadcast, persist user data, or define Arc mainnet.

## Current official network review

- Arc public mainnet is announced for September 16, 2026; at this review date it
  is operating as private mainnet and public parameters are not in the network
  references.
- Arc Testnet chain ID is decimal `5042002`, hexadecimal `0x4cef52`.
- The current primary endpoint is `https://rpc.testnet.arc.io`.
- ERC-8004 remains the documented identity/reputation/validation path and
  ERC-8183 remains the documented job/escrow settlement path on Testnet.
- Mainnet values are not inferred from Testnet.

## Required evidence before M01

- [x] Clean Node 22 install from the frozen lockfile
- [x] Release check, production audit, and license policy pass
- [x] Lint, strict typecheck, unit tests, and builds pass
- [x] Chromium and WebKit foundation journeys pass
- [x] Pruned API and static web images build and start
- [x] API and web expose the exact supplied build marker
- [x] Trivy high/critical image scans pass
- [x] CycloneDX SBOM artifacts are generated
- [x] Corrected exact pushed implementation SHA passes the hosted release workflow
- [x] Independent review finds no P0/P1

## Local candidate evidence

Run on 2026-09-01 from the current local tree:

- `pnpm release:gate` passed inside the repository's Node 22/Linux gate image.
- Thirteen unit/contract tests passed: seven shared-network/primitive tests, four
  API/configuration tests, and two web build-marker tests.
- The foundation browser journey passed in Chromium and WebKit.
- `pnpm audit --prod --audit-level high` reported no known vulnerabilities, and
  the production-license policy passed.
- Production API and web images built, started, and exposed the supplied
  `m00-review-fix` marker; the API ran as UID 100 without package-manager
  binaries in its production closure.
- Final Trivy 0.73.0 scans, including findings with no fix recorded, reported
  zero HIGH or CRITICAL findings in both images. Runtime base images and
  patched Alpine packages are version/digest pinned; broad `apk upgrade` is
  forbidden by the release check.
- CycloneDX JSON SBOMs were generated for both production images.
- The API production closure excludes TypeScript, Vitest, `tsx`, and the Prisma
  CLI.

## Pushed candidate evidence

- Corrected implementation candidate
  `61895d2297f0e201a5a8f876f5b442276ed5f388` is pushed to the private remote
  and matched its remote branch head at verification time.
- GitHub Actions run `33560328346` completed successfully on that exact SHA:
  verification, Chromium/WebKit, production image smoke, Trivy, and CycloneDX
  SBOM jobs all passed.
- The generated `openarc-sboms` artifact is present and unexpired. GitHub's
  timing endpoint reports zero billable milliseconds for all three jobs.
- Third-party actions are pinned to immutable full commit SHAs at their reviewed
  release versions; the rerun emitted no deprecated action-runtime warning.
- The account's Actions product has a hard `$0` budget with stop-usage enabled,
  so paid overage is blocked. This workflow consumed included usage only.
- The hosted workflow is manual-only, cancels superseded runs, and applies a
  strict timeout to every job so ordinary pushes cannot consume runner minutes.
- No staging or production deployment was created.

The first independent review correctly held predecessor
`69797d001e0b3c1f68b379c10f62ccf3c373f44c` for a mutable nested
network registry, unbounded/non-UTC primitives, and an impossible release-rule
conflict. The corrected implementation deep-freezes the registry, caps canonical
integer/decimal strings at 78/78 digits, requires `Z` UTC timestamps, and records
the M00-only staging/live-proof exception. Its full Linux/Node 22 gate and exact
hosted workflow pass.

The evidence and CI-hardening successor
`dc4fc76ac1f7995e6a8e050e232a27c16fdafdc9` passed exact GitHub Actions run
`33560934386`: verification, Chromium/WebKit, bounded API and web startup,
unrestricted HIGH/CRITICAL scans, and SBOM upload all succeeded. GitHub reported
zero billable milliseconds. Independent re-review found no P0/P1 and approved
immutable annotated tag `rc/00-foundation/1`, which was created and pushed at
that exact SHA. The tag must never be moved or reused. Milestone 01 may now begin
from updated `main`.
