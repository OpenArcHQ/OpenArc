# Milestone 00 — repository and verification foundation

Status: **pushed engineering candidate; remote CI/review pending**
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
- [ ] Independent review finds no P0/P1

## Local candidate evidence

Run on 2026-09-01 from the current local tree:

- `pnpm release:gate` passed inside the repository's Node 22/Linux gate image.
- Eleven unit/contract tests passed: five shared-network/primitive tests, four
  API/configuration tests, and two web build-marker tests.
- The foundation browser journey passed in Chromium and WebKit.
- `pnpm audit --prod --audit-level high` reported no known vulnerabilities, and
  the production-license policy passed.
- Production API and web images built, started, and exposed the supplied
  `m00-local` marker.
- Final Trivy scans reported zero HIGH or CRITICAL findings in both images.
- CycloneDX JSON SBOMs were generated for both production images.
- The API production closure excludes TypeScript, Vitest, `tsx`, and the Prisma
  CLI.

## Pushed candidate evidence

- Implementation commit
  `d4c5610bd4eeca3def06ae1527202c287993cded` is pushed to the private remote.
- The pushed implementation is source-identical to the locally gated tree;
  this evidence update changes documentation only.
- No staging or production deployment was created.
- Remote CI was intentionally skipped on the first private push so no hosted
  runner charge could be incurred without an explicit no-cost confirmation.
- The hosted workflow is manual-only, cancels superseded runs, and applies a
  strict timeout to every job so ordinary pushes cannot consume runner minutes.

Remote CI and independent-review evidence are not yet available. Do not begin
Milestone 01 until the complete gate passes for an exact pushed candidate and
the remaining review checkbox is closed.
