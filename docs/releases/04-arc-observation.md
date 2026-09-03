# Milestone 04 — Arc account and transaction observation

Status: **active — implementation and fixture verification in progress**
Base: `main` closure `594527b` after immutable
`rc/03-api-privacy-boundary/1` at
`10172744b6316b21b7b228a9c89d4541b7dd8f3e`
Active branch: `codex/04-arc-observation`

## Frozen scope and order

1. Re-verify Arc's current network, RPC, native-USDC, finality, fee, and event
   contracts from official documentation and record any normative corrections.
2. Freeze strict shared account/transaction request and response schemas,
   decimal normalization, anchor validation, and canonical event matching.
3. Build the allowlisted JSON-RPC client and pure account/transaction services
   behind the M03 provider, budget, Origin, no-store, log, and abort boundaries.
4. Add explicit browser permission flows, encrypted observation records, and an
   Activity experience that never refreshes implicitly.
5. Prove malformed, conflict, outage, cancellation, privacy, compatibility, and
   exact-image behavior before any feature flag or Railway change.
6. Complete one controlled read-only Public Testnet proof on the exact staged
   SHA, then run independent review, immutable RC, and `main` closure.

No registry, job, Gateway, x402, agent connector, signing, broadcasting,
mainnet configuration, arbitrary RPC, bulk history, or background polling is in
M04.

## Current official-source review — 2026-09-03

The reviewed Arc documentation identifies Public Testnet as the current active
network. The pinned primary endpoint is `https://rpc.testnet.arc.io`, chain ID
is decimal `5042002` (`0x4cef52`, CAIP-2 `eip155:5042002`), and the explorer is
`https://testnet.arcscan.app`. Arc documents deterministic finality on
inclusion, non-strictly-increasing block timestamps, native USDC with 18-decimal
accounting, and the ERC-20 interface at
`0x3600000000000000000000000000000000000000` with 6 decimals.

The current event reference supersedes an ambiguous earlier draft. System
emitter `0xfffffffffffffffffffffffffffffffffffffffe` emits the standard
`Transfer(address,address,uint256)` topic at 18 decimals for every USDC balance
movement, including ERC-20-initiated movement. An ERC-20 call also emits the
contract's 6-decimal `Transfer`. OpenArc returns the system event once as the
canonical movement and records an exact scaled ERC-20 match only as
corroboration. Gas fees come from `gasUsed * effectiveGasPrice`; they are not
`Transfer` events.

Official references:

- <https://docs.arc.io/arc/references/evm-differences>
- <https://docs.arc.io/arc/references/usdc-system-events>
- <https://docs.arc.io/arc/references/rpc-endpoints>
- <https://docs.arc.io/arc/concepts/deployment-model>
- <https://docs.arc.io/terms>

The May 15, 2026 Testnet terms describe Testnet as non-production and intended
for development, experimentation, research, and improvement. They explicitly
cover automated/AI-agent access, prohibit overloading Company resources and
reselling Company-operated RPC access, and preserve room for independent
infrastructure that uses publicly available means. M04 therefore uses no
automatic polling or retry, keeps a fixed low global budget, exposes normalized
evidence rather than a generic RPC proxy, and performs no write transaction.
Terms and provider suitability must be re-reviewed before release or source
substitution. This is an engineering record, not legal advice.

## Cost, privacy, and authority boundary

- No new Railway project, service, database, volume, provider account, PAYG
  path, or recurring resource may be created.
- Source routes remain false by default. Fixture implementation uses only the
  existing disposable test Redis path and injected provider transports.
- A production-enabled source route fails startup/readiness without a real
  Redis budget store and a distinct abuse secret; there is no in-memory
  fallback.
- The API receives one public address or transaction hash only after an
  encrypted local receipt commits. Raw identifiers never enter logs, metrics,
  Redis keys, URLs, or error messages.
- OpenArc reads only. It has no transaction-signing or broadcasting interface.
- Browser and provider calls are explicit user actions; no mount, unlock,
  navigation, focus, interval, or retry performs a source request.

## Exit evidence

- [x] Strict account/transaction schemas and future/unknown-key rejection
- [x] 18/6 decimal, sub-micro-USDC, overflow, and canonical formatting fixtures
- [x] Exact chain and immutable block-anchor validation
- [x] Transaction/receipt hash, block, status, fee, and log validation
- [x] Canonical EIP-7708 movements plus exact ERC-20 corroboration/no duplicates
- [x] Same-timestamp ordering by block/transaction/log index
- [x] Wrong chain, missing fact, malformed log, and anchor conflict failure states
- [x] Real Redis accounting, timeout, abort, response cap, and privacy tests
- [x] Receipt-before-request and atomic encrypted observation persistence
- [x] Outage leaves prior encrypted observation bytes unchanged and visibly stale
- [x] Chromium/WebKit/mobile/accessibility and exact production-image journeys
- [x] Full Node 22 gate, audit/licenses/scans/SBOM and hosted CI
- [ ] Controlled live Testnet read on exact staged SHA with no write transaction
- [ ] Independent no-P0/P1 review, immutable RC, and `main` closure

## Release boundary

Until every exit item is complete, M04 is not launch-ready and must not be
presented as production, mainnet, source-authoritative, or universally complete.
The M03 Railway deployment stays the rollback point while M04 is active.

## Local implementation evidence — 2026-09-03

The cumulative Node 22 `pnpm release:gate` passes locally. It includes the
production dependency audit, license policy, lint, type checks, and builds;
64 shared, 65 API, and 67 web tests; and 46 baseline, 2 feature-off, 12 M03
boundary, and 4 M04 Chromium/WebKit journeys. API integration used the same
project-local disposable Redis 8.10.1 binary and no persistent service.

The M04 browser journeys prove encrypted approval before contact, exact account
and transaction request bodies, native/ERC-20 precision, canonical system-event
movement with one ERC-20 corroboration rather than two transfers, local
ciphertext persistence, outage staleness with prior ciphertext retained,
mobile layout, and serious/critical accessibility coverage. They use injected
bounded responses and do not contact Arc.

Hosted release plumbing now builds a feature-on M04 web image and runs the
actual feature-on API image through its real Redis limiter, verified TLS proxy,
and fixed HTTPS RPC transport against a local certificate-pinned JSON-RPC
fixture. It also adds M04 HIGH/CRITICAL scanning and a CycloneDX SBOM. Those
exact candidate workflow results are recorded below.

## Exact implementation hosted evidence — 2026-09-03

Implementation `e6ba27323295069f1db3c1d7687e44da82efbc45` was clean,
pushed, and equal to its remote branch head. GitHub Actions run
`33798917937` completed successfully on that exact SHA:

- verify passed the release check, production audit, license policy, lint,
  type checks, 64 shared / 65 API / 67 web tests with real Redis, and builds;
- the browser job passed 46 baseline, 2 feature-off, 12 M03, and 4 local M04
  Chromium/WebKit journeys plus the immutable M02 and exact M03 image paths;
- the exact feature-on M04 web/API images reported source routes enabled with
  real Redis, verified both internal TLS hops, and exercised the fixed HTTPS
  JSON-RPC transport against the certificate-pinned local source fixture;
- both Chromium and WebKit completed account and transaction observation through
  those exact containers. The two exact-source outage cases were intentionally
  skipped because the source fixture is success-only; both-engine injected
  outage journeys and API/unit failure matrices passed earlier in the same run;
- all production images, including feature-on M04, passed HIGH/CRITICAL Trivy
  scanning. Syft produced CycloneDX 1.7 artifact `9910382888` (`openarc-sboms`),
  digest `sha256:a73538bce29db822aa2ef0786ebaf17da7d1f28bf4a223314fe4871ba83f65df`,
  expiring 2026-12-02;
- GitHub reported zero billable runner milliseconds.

No request in this candidate or its hosted tests contacted Arc, created a
Railway resource, or changed the M03 rollback deployment. Controlled live
Public Testnet proof, independent review, staging, immutable RC, and closure
remain separate gates.

The documentation-only successor
`a977c383a9ecffef87d3ee27edddffbb0c8ad59a` was clean, pushed, and equal to
the remote branch head. GitHub Actions run `33800054306` completed successfully
on that exact SHA: verify, images, and browser jobs all passed; SBOM artifact
`9910804476` has digest
`sha256:2ae6358b8942f3dd1360fe5454bba851009105cab9581a41c07e723aa2ca17d8`
and expires 2026-12-02. GitHub again reported zero billable runner
milliseconds.

## Controlled local Public Testnet proof — 2026-09-03

After explicit confirmation of the current Arc Testnet terms, the exact clean
branch-head implementation
`a977c383a9ecffef87d3ee27edddffbb0c8ad59a` made a minimal read-only
`eth_chainId` request to the fixed provider. It returned `0x4cef52`, confirming
decimal chain ID `5042002`. No wallet was connected and no transaction was
signed or broadcast.

The production API entry point was then run locally with the feature enabled,
a disposable pinned Redis 8 container, the fixed live Arc endpoint, and the
exact branch-head build marker. Readiness reported configuration, source
routes, and Redis up. Capabilities reported
`openarc.capabilities.m04.v1`, `eip155:5042002`, and only
`arc_primary_rpc` enabled.

One account snapshot and one finalized public transaction were exercised
through OpenArc's real HTTP routes and actual bounded provider transport. The
account response reconciled the native 18-decimal balance with the truncated
6-decimal ERC-20 view at one anchored block. The transaction response anchored
the transaction and receipt to the same finalized block, calculated the fee
from `gasUsed * effectiveGasPrice`, and returned one canonical EIP-7708 USDC
movement with one exact ERC-20 corroboration rather than double counting it.
Both strict response schemas passed.

Completion logs for readiness, capabilities, account, and transaction calls
contained only request ID, route class, method, status, duration bucket,
failure code, and build SHA. They contained no address, transaction hash, RPC
URL, response data, or Redis data. The local API and disposable Redis container
were stopped after the proof. This evidence validates the live adapter locally;
it does not satisfy the separate exact-staged-SHA exit gate.
