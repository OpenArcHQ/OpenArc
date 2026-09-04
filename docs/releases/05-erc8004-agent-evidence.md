# M05 — ERC-8004 agent evidence

Status: **active**

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
- [ ] Exact production API/web images pass the synthetic source journey and image
      policy checks.
- [ ] Exact candidate SHA passes hosted CI before staging is changed.
- [ ] Staging exact-SHA provenance and runtime smoke pass before an immutable RC.

Local clean-room evidence on 2026-09-04: `pnpm release:gate` passed under the
pinned Node 22 and Redis 8 images with 222 shared/API/web checks and 68
Chromium/WebKit journeys. Production-image and hosted exact-SHA evidence remain
required before staging changes.
