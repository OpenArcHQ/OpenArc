# M07 x402/Gateway preflight — 2026-09-05

Status: implementation active on `codex/07-x402-gateway-evidence`. M06 is complete.
Gateway remains disabled by default; no mainnet adapter or paid provider is enabled.
The controlling build order remains `openarc-engineering-source-of-truth.md`.

## Verified source changes

- Exact read route: `GET https://gateway-api-testnet.circle.com/v1/x402/transfers/{id}`.
  Use one UUID, not broad wallet/status searches or the generic transfer API.
- Preserve nonce and nullable batch transaction hash from the current REST schema.
  A batch hash is not a unique payment match. Amounts are atomic USDC units.
- Credential-free supported-kind discovery returned Arc Testnet, x402 v2/exact,
  GatewayWalletBatched v1, the existing GatewayWallet and USDC addresses,
  six decimals, and minimum validity 604800 seconds. This is capability evidence,
  not proof that a payment occurred.
- The documentation's illustrative transfer UUID returned 404. It cannot supply
  a positive live test or be presented as real payment evidence.

Sources: [current REST schema](https://developers.circle.com/api-reference/gateway/all/get-x402transfer-by-id),
[dated changes](https://developers.circle.com/release-notes/gateway-2026),
[supported-kind API](https://developers.circle.com/api-reference/gateway/all/get-supported-x402payment-kinds).

The current nanopayments FAQ describes settlement batches as periodic throughout
the day; no numeric Testnet interval or SLA was found. An accepted transfer can
remain `received` with a null batch hash while waiting. Do not infer failure from
elapsed minutes or send another payment to force settlement.
[Batch timing](https://www.circle.com/nanopayments).

SDK 3.4.0 contains a mainnet configuration entry, but this is not evidence of
public operational readiness. The official public launch remains September 16,
2026, and public RPC/contract references still lack mainnet parameters. Keep the
product Testnet-only until the separately gated mainnet milestone.
[Launch](https://www.arc.io/blog/arc-mainnet-goes-live-on-september-16-2026),
[RPC reference](https://docs.arc.io/arc/references/rpc-endpoints),
[Contract reference](https://docs.arc.io/arc/references/contract-addresses).

## Proposed implementation boundary

Keep M01's synthetic evidence engine unchanged. Introduce dedicated strict,
bounded normalized-metadata and Gateway-observation schemas. Imported requirement,
authorization metadata, and provider response remain imported claims, not verified
signatures or fulfillment. Reject raw signatures, private keys, raw headers,
resource URLs, paid bodies, and precomputed conclusions.

Only network and exact transfer UUID may leave the encrypted workspace after a
new permission receipt is saved. Keep local labels, action associations, resource
digests, and authorization metadata local. Correlate exact fields without inventing
requirement payer/nonce fields that x402 does not supply. Keep metadata agreement,
authorization verification, provider claim, Gateway state, and onchain batch
inclusion separate. Preserve missing evidence, conflicts, replay scope, old
authorization validity, cancellation, recovery, and atomic-save failure states.

## Live-proof permission boundary

On 2026-09-05 the user approved a disposable external Arc Testnet payer: at most
1 test USDC deposited and 0.01 test USDC paid in total, plus testnet gas. This
authorizes only valueless faucet tokens, not real funds, user wallets, paid
services, or product signing. CAPTCHA or another permission boundary requires
user action. Keys and signing stay outside the OpenArc repository.

Gateway reads require no API key according to Circle's explicit permissionless
product exception. No paid account or per-read fee was identified; this is not a
claim that deposits, payments, withdrawals, or crosschain operations have no cost.
[Authentication](https://developers.circle.com/api-reference/keys),
[fees](https://developers.circle.com/gateway/references/fees).

A full controlled live arc still requires either an expressly shared authentic
artifact bundle or an externally operated Testnet payer. The official self-managed
path creates/funds an EOA, deposits test USDC, and signs payment authorizations.
The seller submits them for settlement. These are execution steps, not read-only
OpenArc operations, and need separate explicit authorization before this agent
performs them. They must never access user wallets, real funds, PII, or paid services.
[Buyer prerequisites](https://developers.circle.com/gateway/nanopayments/quickstarts/buyer),
[seller flow](https://developers.circle.com/gateway/nanopayments/quickstarts/seller).

Do not substitute synthetic metadata plus an unrelated public transaction for this
proof. Complete/incomplete fixtures can test logic but cannot close the live gate.
Any test signer must stay outside OpenArc's product code, use disposable Testnet-only
keys and valueless faucet tokens, and disclose its exact spending/transaction bounds
before execution. Mainnet remains separately blocked on official configuration.
