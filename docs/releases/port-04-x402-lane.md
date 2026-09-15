# PORT-04 P04-02a — `packages/x402` payment lane

Accepted 2026-09-15 UTC. Adds a pure, fail-closed package for Circle Gateway
x402 batching on **Arc testnet**. It prepares and signs locally, and it sends and
settles only through a transport the caller injects, invoked exactly once. **It
is not wired into any runtime.** Persistence, API routes and a live testnet run
come in later packets.

The authoritative contract is the P04-01 lane-contract research. Every claim in
it cites its source, and the key live facts were re-checked by the lead against
the testnet facilitator's `/v1/x402/supported`: Arc testnet `eip155:5042002`,
scheme `exact`, `x402Version` 2, EIP-712 domain `GatewayWalletBatched` version
`1`, verifying contract `0x0077777d7eba4688bdef3e311b846f25870a19b9`,
`minValiditySeconds` 604800, and USDC `0x3600…0000` with 6 decimals.

No funds, no real or persistent key, no wallet and no live endpoint were used.

## Pinned dependencies

`@circle-fin/x402-batching@3.4.0`, `@x402/core@2.25.0`, `@x402/evm@2.25.0` and
`viem@2.56.5`, all exact. Their lockfile integrity hashes match the contract.
`@x402/core` resolves to a single copy. Licences are Apache-2.0 and MIT only, and
the licence check passes with no allowlist change.

The root `pnpm-workspace.yaml` gains one override,
`"@x402/evm>viem": 2.56.5`. Without it `@x402/evm` would resolve the older viem
2.56.3 that `apps/api` pins. The override affects only this package's
dependency tree, and `apps/api` is unchanged.

**The SDK is imported only by one test**, which proves the package's signature is
byte-identical to the SDK's for the same fields. No file under `src/` imports it.

## Fail-closed rules and their proofs

**Manifest.** There is a single frozen Arc-testnet entry, and its RPC comes from
`ARC_TESTNET.rpcHttp` (`https://rpc.testnet.arc.io`). The SDK and viem default to
`rpc.testnet.arc.network`, and that default is never used. Anything other than
exactly `eip155:5042002` throws, including `eip155:1243` and a value with a
trailing space. The facilitator origin must be exactly the testnet URL; mainnet,
a trailing slash, a path, `http:`, a port and embedded credentials are all
refused. There is **no mainnet entry and no default fallback**.

A source-scan test fails if `src/` ever mentions the mainnet URL, `arc.network`,
`GatewayClient`, `.pay(`, `BatchFacilitatorClient`, `x402ResourceServer`,
`fallbackScheme`, a recovery hook, `console.`, `globalThis.fetch`, or imports the
SDK.

**Requirement parsing.** Only the exact shape is accepted, with the pinned asset,
GatewayWallet contract, `x402Version` 2 and a single `accepts` entry. Unknown
keys are refused, so an origin, URL, RPC, calldata, chain-id or decimals override
is rejected at any level. Amounts must be canonical uint256 strings, which rules
out `"0.01"`, `"$0.01"`, `1e6`, a bare number, leading zeros, zero and overflow.
Error messages never echo the value received.

**Signing without sending.** The package signs the typed data directly with
viem, using a nonce the caller supplies. `validBefore` is at least now + 604800
seconds + a buffer, and `validAfter` is now − 600 seconds. A stubbed global
`fetch` is never called during prepare or persist, and the signature is checked
to recover to the payer.

**`GatewayClient.pay()` is deliberately not used.** The contract documents that
it generates the nonce and sends in one step, only logs errors from its
post-sign hook, and re-signs with a new nonce and resends on `recovered`.

**Two-phase flow: prepare → persist → dispatch.** The signed payload is held in
an internal WeakMap, never on a returned object. Dispatch accepts only the handle
that persist returned, so an unpersisted, forged or type-cast handle is refused
and the transport is never called. A store that throws, or does not echo the
digest, leaves the payment unsendable, and the persist callback never receives
the signature. Dispatch happens once; a second attempt is refused. A send is also
refused if the signature has less than seven days of validity left.
**Releasing a payment after dispatch is refused at runtime and at compile time.**

**Facilitator client.** Configuration rejects `fallbackScheme`, extra
facilitators, `onSettleFailure`, `onVerifyFailure`, `retry`, custom headers, a URL
and a network list. There is no default `fetch`, requests use
`redirect: "error"`, and every request has a timeout. Each operation makes
**exactly one** HTTP call. That holds for acceptance, `nonce_already_used`,
`settlement_pending`, `insufficient_balance`, a 500, a 400, an HTML body, a thrown
fetch and a hung fetch, and a second settle makes no call at all. Any settle
result other than a clean acceptance is `unknown`, and `accepted` means accepted
and locked, **not** settled.

**Lost-settle resolution never releases.** The P04-01 contract found no
authoritative signal that an accepted payment will never settle. So every one of
these stays `unknown` and held:

- timeout, transport error, HTTP error and malformed data
- not found, and not found after expiry
- `failed`, with or without a hash, and after expiry
- `nonce_already_used`
- completed without a hash
- a mismatched record, two records or another page of results
- a transfer id that differs from the settle id
- any unrecognised status

`received`, `batched` and `confirmed` stay `pending` and held even past expiry.
**Only one fully matching `completed` transfer with a valid batch hash is
`committed`.**

This is enforced in the type system, not by convention. `LaneExposureAdmitsNoRelease`
and `LaneSettleAdmitsNoRelease` are asserted with `expectTypeOf`, and
`@ts-expect-error` covers `released`, `failed` and an unheld `unknown`. Adding a
release state would break compilation.

**No logging.** The full flow and every failure path make no console, stdout or
stderr call. The key and signature appear in no inspected handle, no JSON, no
error message and no error issue.

## Decisions recorded

**Signature buffer.** The contract mentions at least 100 seconds. The package
sets a minimum of 400 seconds (the 300-second grant plus the SDK's 100), a default
of 900 and a maximum of 3600. With only 100 seconds, a normal 300-second claim
would push the signature under the seven-day floor before settle. Whether
Gateway accepts a buffer above 100 seconds has **not** been checked live, and the
P04-07 testnet run must confirm it.

**Crash between persist and dispatch.** The signature is never persisted, so an
in-process release is the only possible release. A crash after persist has to be
treated as possibly sent, which holds that exposure. This is the conservative
choice: a crash can strand exposure but can never falsely release it.

## Unverified and kept fail-closed

- **`committed` rests on Gateway's word** (`onchainReceiptVerified: false`). An
  Arc receipt or `BatchProcessed` check is later work.
- **Settle id equals transfer id** is assumed; a disagreement is held.
- **`completed`, not `confirmed`,** is the commit point.
- **`failed` as final, expiry as voiding and nonce retention** are unverified, and
  none of them can release.
- **The transfer-search response shape** is taken from the SDK types; any
  unexpected shape, extra page or multiple records is held.
- **`minValiditySeconds` stability:** `checkSupported()` compares the live
  advertisement with the manifest and reports drift.
- **OpenArc's requirement digest** is not recomputed. The binding carries the
  grant's digest unchanged, next to a separate lane digest of the requirement, and
  does not claim the two are equal.

## Verification

| Gate | Result |
| --- | --- |
| `packages/x402` typecheck (source and test configs) | exit 0 |
| `packages/x402` build | exit 0 |
| `packages/x402` ESLint `--max-warnings=0` | exit 0 |
| `packages/x402` tests | 6 files / **91** |
| `@openarc/shared` tests | 42 files / 1,466 (no regression) |
| licence check | pass |
| gitleaks over the package | no findings |

The lead re-ran typecheck, build, lint and tests independently, and confirmed
that the only `src/` matches for the forbidden names are comments documenting the
prohibitions.

## Boundary

Inert and offline. No runtime wiring, no database, no API, no funds, and no live
endpoint. Real testnet payments need a disposable buyer wallet that the user
creates and funds, plus its approve and deposit transactions. The assistant does
not move funds.
