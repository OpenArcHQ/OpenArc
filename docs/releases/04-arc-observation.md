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
- [ ] Chromium/WebKit/mobile/accessibility and exact production-image journeys
- [ ] Full Node 22 gate, audit/licenses/scans/SBOM and hosted CI
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
hosted claims remain unchecked until the exact candidate workflow succeeds.
