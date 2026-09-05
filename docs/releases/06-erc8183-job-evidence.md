# M06 — ERC-8183 reference job evidence

Status: implementation in progress. Not an RC, not deployed, not a public-release readiness claim.
Branch: `codex/06-erc8183-job-evidence`, based on M05-complete main `e21ddae68e445bccadc5490593100dbd223bd9a1`.

## Source review — 2026-09-04

Primary references:

- [Arc's job tutorial](https://docs.arc.io/arc/tutorials/create-your-first-erc-8183-job)
- [ERC-8183 specification](https://ercs.ethereum.org/ERCS/erc-8183)
- [Verified reference proxy](https://testnet.arcscan.app/address/0x0747EEf0706327138c69792bF28Cd525089e4583?tab=contract)
- [Verified implementation](https://testnet.arcscan.app/address/0xA316fd02827242D537F84730F8a37D0BA5fd351a?tab=contract)

The deployed reference, not a generic/latest ABI, defines this adapter's semantics.
The verified implementation's main source SHA-256 is
`a16ae3290855910a4c06a59fa691d1d2b56b534e744f15b6f73a6a06ccb1bec4`.
Compiler: `v0.8.28+commit.7893614a`, optimization disabled. Public RPC review at block
`0x39b0417`, hash `0xf7a345674efa052c6f037c29fcb61b5809162d14b86b1d1f7bca98317489d47e`,
confirmed the EIP-1967 implementation address. Implementation runtime code Keccak-256
was `0x7054f89cadf92af85003313db92e9b29ef670ee2c7a20b5295cdddf66ecaa4b3`.
The adapter checks the implementation slot on every observation; the recorded source
fingerprint is review provenance, not a runtime code-verification claim.

### Corrections to the earlier product outline

- `getJob` returns ID, client, provider, evaluator, description, budget, expiry,
  status, and hook. It does **not** return or store a deliverable digest.
- An optional, explicitly released submission transaction hash allows a bounded
  receipt lookup. Only an exact `JobSubmitted` event emitted by the fixed proxy,
  matching job ID and provider, supplies the digest. No history scans or content fetches.
- An unknown job returns a zero-ID struct, rather than necessarily reverting.
- Zero budget is valid. `jobHasBudget` distinguishes assigned from default zero;
  neither zero nor a Funded status proves a positive escrow balance.
- `Open`, `Funded`, `Submitted`, `Completed`, `Rejected`, and `Expired` are recorded
  states. Crossing the deadline alone does not change the state. The reference's
  submit and complete methods do not check that deadline.
- A provider may be unassigned on an Open job, including one later Rejected.
- Completed is not proof of service quality or the net payment amount; fees may
  be deducted. Rejected is not by itself proof of a refund.
- Description and hook address are untrusted evidence, never rendered as markup,
  fetched, or executed. Private local descriptions must stay separate.

## Bounded contract

`POST /v1/private/arc/job-evidence` accepts only `network`, positive canonical
uint256 `jobId`, and optional `submissionTransactionHash`. Caller-selected
contracts, RPCs, methods, local labels, and action links are rejected.

Seven RPC calls for a job-only observation; at most eleven with a historical
submission receipt. Chain, fixed payment token, implementation slot, exact block
anchor, receipt/log identity, and repeated anchors are checked. Historical
submission blocks must also use the reviewed implementation. Maximum 256 receipt
logs and 4096 description characters, within the existing transport byte/time budget.
No signing, transaction broadcasts, payable integrations, new providers, or spend.

## Implementation/checklist

- [x] Shared strict request/response contract and literal limitations.
- [x] Bounded read-only job adapter with all six states and optional receipt digest.
- [x] Malformed numeric identifiers return validation failures rather than throwing.
- [x] API capability version and default-off route wiring.
- [x] Route, browser client, permission, encrypted-storage, and UI failure tests.
- [x] Jobs workspace with explicit local-only action association.
- [ ] Full local release gate, production-image tests, scans/SBOM, hosted CI.
- [ ] Exact RC tag and staging runtime verification; milestone closeout.

The pinned Node 22 / Redis 8 clean-room release gate passed with 282 shared/API/web
tests and 76 browser journeys, including audit, license, lint, typecheck, and build.
A subsequent default-off Jobs flag test passed separately (the cumulative suite
now contains 283 checks); final lint/typecheck also passed. Desktop and
390-pixel mobile screenshots were inspected; the inherited cramped multi-column
card was replaced with a dedicated readable job layout. No serious/critical axe
violations were found in the rendered Jobs view.

## Live read-only source proof

- Reference job `1`: Completed, exact budget `5000000` base units / `5` USDC,
  deadline reached, and digest explicitly not observed without a receipt.
  Anchor `60492142`, hash
  `0x1e0e5808c973434851ff0f24945def7acfa3981f6e789cd20e83f72551e8aca3`.
- Reference job `183309` with submission
  `0xcd5ce3462863f94dde78284c3a0bf4fcbbf339308513a7a3769351e7e1b81131`:
  Completed, submission digest
  `0x3d04f40cda87e9e0ef96d0808de55341fb244a178c81653903d8f55fd247c049`,
  submission block `60485405`, log `45`. Current anchor `60492823`, hash
  `0x03751f5e8cdfe302d52aaa6d97ab340f5fb2d8ec1e68b56ad373f1f32bb19fd5`.
  Exactly eleven fixed public RPC calls, including historical implementation and
  repeated block checks. No wallet, signing, faucet, or funding was used.
- Availability limitation: job `1`'s old submission transaction
  `0xfdeba8da4ff4d54f877b2dd89e626949438d707a6c9fd30139eaa03e0446e660`
  appears in the explorer index but its public-RPC receipt returned null during
  this check. The adapter correctly returned `SOURCE_NOT_FOUND`; it did not invent
  a digest or silently query another provider. Users can omit an unavailable
  historical receipt to inspect the job alone. The underlying cause was not established.

Explorer lookups were used only to locate public test examples during development;
they are not runtime providers. Runtime evidence above came from the fixed Arc RPC.
This document must be updated with hosted/image/staging evidence before release.
