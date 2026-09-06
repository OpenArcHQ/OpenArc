# M06 — ERC-8183 reference job evidence

Status: **complete** — immutable `rc/06-erc8183-job-evidence/1`.
This is an M06 Testnet milestone, not public-release or mainnet readiness.
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
- [x] Final reviewed candidate staging runtime verification.
- [x] Independent review without unresolved P0/P1 findings.
- [x] Exact RC tag and milestone closeout.

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
GitHub Actions run 33932526330 (pre-publication CI; private link omitted)
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

- API deployment `d1aeb42b-d2bf-4fc9-8518-775df9ea5c28`, image
  `sha256:a179a57aafc46ccc450664dbb1bebe830bc5cb3634e813632a9b6fe005b29e87`.
- Web deployment `d272c2a3-7df0-4842-9758-478eb98cd908`, image
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
review was pending at this earlier-candidate checkpoint, so no M06 RC tag, main
merge, or M07 implementation had then been made. Final closeout follows below.

## Independent engineering review — 2026-09-05

A separate review agent inspected the M06 changes against M05, the deployed
reference source, privacy/session boundaries, strict schemas, encrypted record
integrity, and feature gates. It ran 105 focused tests and found no P0/P1 issues.
Two smaller findings were fixed before the final candidate:

- A malformed source could combine an unassigned provider on a Rejected job with
  a submission event. The shared schema now requires an assigned provider whenever
  a submission event is present. Both schema and adapter regression checks reject
  this combination while preserving legitimate unassigned-provider rejection.
- Network availability labels now honor every cumulative feature gate; all 16
  flag combinations are covered instead of claiming lookups in a disabled build.

An additional shipped-copy audit found no material overclaim; its stale M04
landing badge was updated to describe the cumulative M05/M06 build only when the
matching flags are enabled. The Jobs browser journey checks that feature-on copy.

The independent reviewer rechecked both fixes and passed 66 focused tests, with
no additional P0/P1 findings. This is engineering peer review, not the external
application-security audit required for public hardening. Updated Arc/Circle
primary-source documentation was also reviewed; M07 runtime and mainnet remain off.

Final hosted gates and exact-SHA staging proof passed before the immutable RC
was tagged. M07 runtime work did not begin before this milestone closed.

### Fresh image-advisory gate

Hosted run `33994662432` rejected the candidate's web image with six HIGH
util-linux advisories on inherited `libuuid 2.41.4-r0`. Fixed versions begin at
`2.41.6-r0`; the official Alpine 3.23 repository currently supplies `2.41.6-r1`.
The web runtime and release guard now pin that available patched version. No
advisory suppression, scan-severity relaxation, broad package upgrade, or failed
candidate deployment was performed. Fresh image scans remain mandatory.

## Final release evidence — 2026-09-05

RC `rc/06-erc8183-job-evidence/1` points immutably to application commit
`134a3a720494b134d8bfc01ff4751d65ed8384c3`. It passed
CI run 33994931544 (pre-publication CI; private link omitted):
verify 1m39s, images 4m33s, browser 13m03s. Checks included 67 shared, 133 API,
and 86 web tests (286 total), 76 Chromium/WebKit journeys, exact production-image
source flows, older-reader compatibility, verified TLS, real disposable Redis,
audit/license checks, and all seven blocking HIGH/CRITICAL image scans.
SBOM artifact `9977819293` has digest
`sha256:f19c003debc26ce2553f6fead7fd57c5fab11a77755abdde3d5a759837536328`
and expires `2026-12-04T22:06:06Z`.

The final pinned Node 22/Redis 8 clean-room gate passed as image
`sha256:6d793aab6292734bb527dc5ecfbc09052c5bc40e9604415bb09d99b2e77b0b8e`.
The patched local web image also passed a fresh blocking HIGH/CRITICAL scan.
Independent review confirmed Alpine's v3.23 security database requires
`libuuid 2.41.6-r1` for CVE-2026-78408; five other findings were fixed in r0.
Source: [Alpine v3.23 security database](https://secdb.alpinelinux.org/v3.23/main.json).

Final staging deployments both reached `SUCCESS`:

- API `4fd4450c-81f5-4045-aeab-e86ad04c193e`, image
  `sha256:c99e7c91e588b2bcb72e899ded17cac4d5e2e0b215eb36255d4b178b2f5c1e46`.
- Web `b450ed60-5240-4e84-8d85-8706bf6fc290`, image
  `sha256:1677163c9d00b7a822b416da9be809f12fe84817a00ce510d14610718d6107d1`.

API readiness reported configuration and Redis up, source routes enabled, and
the exact RC marker. The landing browser also verified that marker and the M06
badge. Two completed disposable-browser smoke runs confirmed exact public job
results, encrypted-only storage, mobile overflow bounds, and lock/reload/unlock
persistence with no automatic repeat lookups. The final run anchored job `1` at
`60647610` / `0x581a4b5783fefbb473acae175186c90f6479faffb5cbd15b57f1ba94d1be2bf7`
and job `183309` at
`60647612` / `0x6fef3bd9107dac56ba0f6bedae09dc6446c4deb01c5571fb8d07d9811dc9087b`.
The latter retained the exact submission digest recorded above. Staging desktop,
mobile, and landing screenshots were checked. No user vault or keys were accessed.

Verification tooling is versioned separately: follow-up commit `fc9d3e4` captures
response bodies immediately rather than after Playwright click auto-waiting.
The first final smoke attempt encountered Chromium's unavailable-response-body
error and was not counted as passing. The corrected harness passed against the
same deployed application; syntax, ESLint, and independent review also passed.
No application/runtime file differs between the RC and this verification-only
follow-up. The tag points to the CI-verified/deployed application, not the later
verification or evidence-document commits. The branch and RC were pushed and
fast-forwarded into `main`; no tag was moved or reused.

Only existing staging build markers changed in the final deployment. Production
has no services in this project; no billing setting or additional service changed.
M07's external live-payment proof requires an authentic artifact bundle or separate
authorization for an isolated Testnet payer. See the
[M07 preflight](../engineering/m07-x402-preflight.md).
