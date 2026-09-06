# M05 — ERC-8004 agent evidence

Status: **complete** — immutable `rc/05-erc8004-agent-evidence/1`

Branch: `codex/05-erc8004-agent-evidence`

## Frozen scope

M05 adds read-only, bounded ERC-8004 evidence on Arc Testnet. It reads one agent
identity at one exact final block and may additionally read one exact
observer-feedback record and one exact validation request. It does not enumerate
observers or validations, calculate an aggregate score, fetch remote metadata,
label an agent as verified, sign, or broadcast a transaction.

The Agents UI keeps an owner-supplied local label visibly separate from on-chain
registry facts. Every reputation or validation claim identifies its observer or
validator and retains its exact source anchor.

## Frozen official sources

- Arc tutorial, reviewed 2026-09-04:
  `https://docs.arc.io/arc/tutorials/register-your-first-ai-agent`
- ERC-8004 draft, reviewed 2026-09-04:
  `https://eips.ethereum.org/EIPS/eip-8004`
- Official contract repository revision:
  `b9e466c250744a7e06b13dff9d3c2844ed64f825`

Pinned Arc Testnet registries:

- Identity: `0x8004A818BFB912233c491871b3d84c89A494BD9e`
- Reputation: `0x8004B663056A597Dffe9eCcC1965A193B7388713`
- Validation: `0x8004Cb1BF31DAf7788923b405b754f57acEB4272`

The reputation and validation contracts must report the pinned IdentityRegistry
at the selected block. A mismatch is a source conflict.

## Privacy, safety, and cost boundary

- The API receives only public registry identifiers explicitly disclosed in a
  permission receipt. A local profile link or display label is never released.
- The API retains no request or response body. Approved results are encrypted in
  the local browser vault.
- Metadata URI text is returned as untrusted data but is never fetched or
  rendered by OpenArc.
- Exactly one identity is queried. Optional feedback and validation inputs are
  exact record identifiers; unbounded registry arrays and summaries are banned.
- The feature has no new hosted provider, PAYG path, or recurring vendor spend.
- OpenArc remains read-only and never signs or broadcasts transactions.

## Exit evidence

- [x] Wrong contract binding fails closed.
- [x] Unknown agent fails as not found without leaking an RPC error.
- [x] Changed owner or block anchor fails closed.
- [x] Empty and malformed metadata URIs remain bounded untrusted text and trigger
      no network fetch.
- [x] Self feedback fails as a source conflict.
- [x] Conflicting validation fixtures fail closed.
- [x] UI labels every feedback claim with its observer and every validation claim
      with its validator.
- [x] Capability truth, feature-off behavior, privacy receipts, atomic encrypted
      storage, CSP, and browser flows pass the clean-room release gate.
- [x] Exact production API/web images pass the synthetic source journey and image
      policy checks.
- [x] Exact candidate SHA passes hosted CI before staging is changed.
- [x] Staging exact-SHA provenance and runtime smoke pass before an immutable RC.

Local clean-room evidence on 2026-09-04: `pnpm release:gate` passed under the
pinned Node 22 and Redis 8 images with 222 shared/API/web checks and 68
Chromium/WebKit journeys. Production-image, hosted exact-SHA, and staging
evidence are recorded below.

The hosted compatibility gate rebuilds the immutable M02 browser source from
`rc/02-encrypted-workspace/1` at its asserted commit. Its disposable Dockerfile
refreshes only the unavailable Alpine `curl` and `libcurl` revisions to the same
exact patched versions used by M05; the historical tag and application source
are never changed.

## Final release evidence — 2026-09-04

The immutable RC resolves to
`866962c4999813870339e24522ec808e2b54e3e4`. The branch was clean, pushed, and
equal to its remote head before the tag was created. GitHub Actions run
`33909645179` passed on that exact SHA before Railway changed: verify completed
in 1m35s, images in 3m55s, and the full browser job in 10m14s. The browser job
included the 68 Chromium/WebKit journeys, production-image compatibility from
M02 through M05, verified TLS, a real disposable Redis, the fixed Arc source
fixture, and the exact M05 registry journey. Every production image passed the
mandatory HIGH/CRITICAL Trivy scans.

CycloneDX artifact `9950961688` (`openarc-sboms`) has digest
`sha256:b2bd228ada451a822567010b6dfa515e1fd5b201826feea7d024075edbd04496`
and expires 2026-12-03. The compatibility reader asserted immutable M02 commit
`298c695ae615ea090b02b0410b7ae37125c625b1`, refreshed only its unavailable
runtime `curl` packages in a disposable worktree, proved receipt compatibility,
and removed that modified worktree explicitly.

The exact RC was deployed API-first to the existing Railway staging project.
Both deployments reached `SUCCESS` and expose the same full build marker:

- API `93f01d8f-2af2-4974-b04d-c76a85d918a4`, image
  `sha256:3a53bc3ccdf14989de1f406af65c983cbc58682648ac759ed86377f3d127cc22`.
- Web `570b33be-64b9-4309-aa41-027d4ff5c4ba`, image
  `sha256:8110678e86f04e65fd474ae8bc3bbef271eb7d694ce7da66814e95dd731753fc`.

Readiness reported configuration, source routes, and Redis up. Capabilities
reported `openarc.capabilities.m05.v1`, Testnet network `eip155:5042002`,
`writes: false`, only `arc_primary_rpc` and `erc8004_registries` enabled,
`sourceMaxSubcalls: 10`, and both later feature families disabled. A direct API
source request without the trusted web proxy secret returned HTTP 403.

A strict shared-schema check read public Arc Testnet agent `1` at exact block
`60459118`, retained its block-hash anchor, returned no unrequested feedback or
validation claim, classified its empty metadata URI as `none`, and confirmed
that metadata was not fetched. Fresh isolated Chromium and WebKit workspaces
each displayed the exact RC SHA, required the registry disclosure, released
only `{ network, agentId }`, encrypted the approval before contact, rendered
the identity as registry evidence rather than verification, retained no
plaintext registry value in IndexedDB, loaded the exact identifier for an
explicit refresh, deleted the evidence and receipt together, locked on reload,
and permanently deleted the disposable workspace.

The live negative boundary returned the expected statuses: malformed agent ID
400, extra field 400, hostile Origin 403, unsupported media type 415, unknown
agent 404, and self-feedback source conflict 502. Security headers included
HSTS, CSP, and `nosniff`. A bounded scan of all 20 application-log lines found
none of the tested address, hash, registry-field, RPC/Redis location,
authorization, cookie, password, passphrase, or recovery-secret patterns.
Railway's bodyless HTTP metadata recorded 12 registry-route requests without
request or response bodies. The API, web, and pinned Redis deployment IDs
remained unchanged after testing. No wallet was connected and OpenArc signed
or broadcast nothing.
