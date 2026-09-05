# M06 — ERC-8183 reference job evidence

Status: implementation, hosted gates, and staging verification passed.
Not an RC or a public-release readiness claim. Independent review is still required.
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
- [x] Full local release gate, production-image tests, scans/SBOM, hosted CI.
- [x] Exact candidate staging runtime verification.
- [ ] Independent review without unresolved P0/P1 findings.
- [ ] Exact RC tag and milestone closeout.

The pinned Node 22 / Redis 8 clean-room release gate passed with 282 shared/API/web
tests and 76 browser journeys, including audit, license, lint, typecheck, and build.
The final host release gate then passed with 284 checks and all 76 browser
journeys after the default-off flag and source-invariant regressions were added.
The staging smoke script uses an isolated disposable browser and two bounded
public lookups; it never opens the user's browser vault. Desktop and
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
## Hosted candidate verification

Candidate `f9729acd63175d4abb246802b392a00f8e120989` passed all three jobs in
[GitHub Actions run 33932526330](https://github.com/OpenArcHQ/OpenArc/actions/runs/33932526330)
before staging configuration changed. This includes 284 shared/API/web tests,
76 browser journeys, exact production-image source tests through M06, the
immutable older-reader compatibility gate, dependency/license checks, and
HIGH/CRITICAL image scans. Production tests use verified TLS and real disposable
Redis. The CycloneDX artifact `9959126354` (`openarc-sboms`) has digest
`sha256:58af99daf81b989e9938c9b30cbe8ff3013f77285dcbaac9cd795ed4939bceab`
and expires `2026-12-04T00:18:17Z`.

## Rollback boundary

After a workspace saves M06 job observations or v4 permission receipts, do not
replace its browser with the M05 reader: that older build cannot read these new
record schemas. To stop new source observations, retain the M06 browser/vault
reader and disable the API's `AGENT_JOBS_ENABLED` flag. Existing encrypted evidence,
export, recovery, and deletion must remain available. Do not delete or rewrite
user records to make an old build appear compatible.

## Staging verification — 2026-09-05 UTC

The existing staging services reached `SUCCESS` on candidate
`f9729acd63175d4abb246802b392a00f8e120989`:

- API deployment `<deployment-id>`, image
  `sha256:a179a57aafc46ccc450664dbb1bebe830bc5cb3634e813632a9b6fe005b29e87`.
- Web deployment `<deployment-id>`, image
  `sha256:d1261c5c0485c3f65a1c1d643fd7d305588a90ce58f1457161836a1c5e03e80c`.
- API `/readyz`: ready, configuration up, source routes enabled, Redis up, exact
  candidate SHA. Both browser build marker and job response marker matched it.

`scripts/smoke-job-staging.mjs` passed on the deployed application in an isolated
disposable browser, with two explicitly consented public lookups, encrypted
record checks, reload/lock/unlock persistence, and no automatic repeat lookups.
Job `1` was Completed with 5 USDC recorded budget and no observed digest at block
`60495186`, hash `0xb46a787eee1bc887730192dca7c3151f4e33370d2e285619be2c3290e5dc10a5`.
Job `183309` was Completed and its supplied submission receipt yielded the exact
digest documented above, anchored at block `60495188`, hash
`0x46a7c2bbab33347eabf7cf1c1597d2db9e6c479c38fe37b384d1c5c7c8585b42`.
Desktop and 390-pixel mobile staging screenshots were visually inspected; no
horizontal page overflow was found. The user's browser/vault was not opened.

The first smoke attempt stopped after one successful response because Nginx and
the API both supply `no-store`, yielding `no-store, no-store`. The smoke assertion
was corrected to accept repeated identical no-store directives while rejecting
other directives; the complete second run passed. This verification-script-only
correction and this evidence document follow the deployed application candidate;
they do not change application runtime code. Syntax, ESLint, and diff checks passed.

Only existing staging API/web settings were changed: cumulative Jobs flags,
the eleven-subcall source budget, and exact build markers. No production service,
new service, paid provider, plan, or billing configuration was changed. Independent
review remains pending, so no M06 RC tag, main merge, or M07 implementation has
been made.

Staging proof and independent review must be recorded before milestone closeout;
M07 must not begin before this milestone is closed.
