# Milestone 01 — evidence engine and fixture explorer

Status: **complete — immutable `rc/01-evidence-engine/1`**
Network review: **not applicable — fixture-only, zero live calls**
Base: `main` after immutable `rc/00-foundation/1`

## Frozen boundary

Milestone 01 introduces the versioned local evidence contract, opaque canonical
IDs, an append-only action-state validator, deterministic reconciliation, a
local monitoring-policy evaluator, and a read-only browser fixture explorer.

It does not call Arc RPC, Circle, Gateway, a provider, or the OpenArc API. It
does not create a Vault, persist browser data, accept a wallet, sign, broadcast,
send analytics, or define mainnet configuration. M02 owns encrypted local
storage; M03 owns network and privacy controls.

## Contract caps

| Field | Bound |
|---|---:|
| Evidence records supplied to one reconciliation | 64 |
| Evidence IDs in one action relationship list | 8 |
| Action state transitions | 16 |
| Monitoring policies supplied to one reconciliation | 32 |
| Limitations per record/result | 1–8 |
| Conflicts or gaps per result | 16 |
| Evidence citations in one conflict | 64 |
| Human-readable label/detail | 160 / 240 characters |
| Canonical integer | 78 digits |
| Canonical timestamp | UTC `Z` only, <=30 characters, <=9 fractional digits |

IDs are bounded lower-case opaque identifiers. Payment comparison uses exact
base-unit strings and exact Arc Testnet network, address, nonce, resource digest,
and action relationships. JavaScript floating point is forbidden.

## Deterministic fixture matrix

The shipped explorer contains synthetic, visibly labeled fixtures for:

- complete and reconciled;
- missing intent after settlement;
- conflicting recipient evidence;
- expired authorization;
- provider-reported failure;
- settled then refunded.

Malformed, unknown-version, duplicate-ID, dangling-reference, non-monotonic,
and replayed-nonce fixtures fail closed in automated tests and are not rendered
as accepted evidence.

## Presentation contract

- The chronological semantic evidence list is always present and is the source
  of truth.
- Every semantic record exposes its exact normalized payload facts: network,
  token, parties, base-unit amount, nonce, resource, validity window, status,
  response, transaction, and block fields as applicable.
- The graph is a progressive visual summary of exactly the same records; it
  adds no fact, conclusion, or control.
- Every conclusion cites input evidence IDs, ordered gaps/conflicts, the rule
  version, and limitations.
- Evidence authority classes remain distinct. `AUTHORIZED`, `SETTLED`, and
  `FULFILLED` are never collapsed.
- Source kind, fixture environment, adapter version, and pinned Testnet network
  are validated against each evidence type; mislabeled authority fails closed.
- Action history uses an exact pairwise-tested edge matrix. Every non-proposed
  state has typed citations; unlisted state edges or semantically incompatible
  citations fail closed.
- Evidence occurrence cannot follow its observation, causal source times cannot
  run backwards, the first `PROPOSED` state equals the action-creation instant,
  a transition cannot predate the evidence it cites, and evaluation cannot
  predate any used evidence or the final action transition.
- Refund conclusions require exactly one full refund linked to a cited settled
  transaction with exact amount and a valid same-or-later block reference.
- Reconciliation input must be unresolved: cached policy or result objects are
  rejected rather than trusted during recomputation.
- More than 16 material conflict groups collapse to one explicit
  `CONFLICT_SET_OVERFLOW` result citing every involved record; no overflow is
  silently truncated or allowed to become reconciliation.
- Policy results say `LOCAL MONITORING ONLY`; they do not claim wallet or
  protocol enforcement. A matched policy with no usable payment facts is
  `unevaluable`, never `permitted`.
- Reduced motion preserves all information without animated transitions.

## Exit evidence required before M02

- [x] Exact transition matrix and terminal-state tests pass
- [x] Complete/missing/conflict/expired/failed/refunded fixture tests pass
- [x] Malformed, unknown-version, duplicate, replay, and dangling inputs fail closed
- [x] Every rendered conclusion cites evidence and limitations
- [x] Graph/list record and ordering parity passes
- [x] Chromium and WebKit keyboard/mobile/reduced-motion journeys pass
- [x] Full-document serious Axe scan passes
- [x] Static guard proves fixture explorer makes zero network/storage calls
- [x] Clean Node 22 release gate, image scan, and SBOM pass
- [x] Exact pushed SHA and exact hosted CI pass
- [x] Exact Railway staging markers and fixture walkthrough pass
- [x] Independent review finds no P0/P1

No staging deployment or M02 work begins until the relevant gates above are
complete.

## Local implementation evidence

On 2026-09-01, the corrected source-identical pre-commit implementation passed
the full clean-room Node 22 release gate in the pinned gate image: production
audit and license policy, lint, strict typecheck, 46 shared tests, 4 API tests,
7 web unit tests, production builds, and 8 browser journeys split across
Chromium and WebKit. The browser gate includes full-document serious/critical
Axe analysis, keyboard tabs, graph/list parity, exact normalized-fact rendering,
mobile target sizing, reduced motion, empty browser storage, and zero external
or dynamic evidence requests.

The corrected gate includes regressions for fulfillment-resource, validity,
transaction/block, source-authority, bounded fractional timestamps, causal
source time, transition time, refund linkage/count/status, replay citation,
cached-result, state-edge, typed-citation, and conclusion-consistency failures.
It also proves that a reconciliation cannot be emitted without at least one
cited evidence record and that missing payment facts cannot produce a permitted
policy result.

## Exact candidate and staging evidence

The corrected implementation was committed and pushed at exact SHA
`56619d1badfabfe33fab54799954adbca8768dac`. GitHub Actions run
`33566745921` completed successfully on that exact SHA on 2026-09-01. Its
`verify`, `browser`, and `images` jobs all passed: sequencing, production audit,
license policy, lint, strict typecheck, all 46 shared / 4 API / 7 web tests,
production builds, all 8 Chromium/WebKit journeys, exact-image-marker smoke,
container vulnerability scans, and CycloneDX SBOM generation. The unexpired
`openarc-sboms` artifact is attached to the run. GitHub reported zero billable
runner milliseconds.

An independent adversarial review of the exact corrective diff found no P0 or
P1 issue. It independently reproduced the formerly failing conflict-overflow
and 19-citation cases and confirmed deterministic bounded results with complete
citations, no runtime network or storage API, no signing or execution surface,
and no mainnet configuration.

The exact implementation SHA was then deployed to the isolated Railway project
`openarc-staging`, environment `staging`, with no database or volume. API
deployment `a5e603a5-4d1f-4ecb-b704-df06178d5db8` and web deployment
`8408da1e-49d0-4e45-8e82-e19160794d69` both reached `SUCCESS`. The API
`/healthz` and `/readyz` responses and the web footer all exposed the full exact
SHA. The web response returned `Cache-Control: no-store` plus the expected CSP,
permissions, referrer, content-type, and frame protections.

The live fixture walkthrough at
`https://web-staging-1275.up.railway.app/` confirmed all six deterministic
results: `RECONCILED`, `INTENT NOT SUPPLIED`, `CONFLICTING EVIDENCE`, `EXPIRED`,
`FAILED`, and `REFUNDED`. Each view retained its semantic source-of-truth list,
normalized facts, evidence citations, limitations, and neutral graph labels.
The staging API is available at
`https://api-staging-539a.up.railway.app/` and exposes only the M01 health and
readiness surface.

Both services are constrained to one replica with a 1 vCPU / 1 GB memory
ceiling and Railway serverless sleep. No provider, database, volume, mainnet,
wallet, signing, or broadcast integration is enabled. These limits and the
serverless setting were applied before the first deployment.

The evidence-only successor
`e8091bf141d6a651d582059a45efa72c47652159` passed exact GitHub Actions run
`33640047056` on 2026-09-02. Its verification, Chromium/WebKit, production-image
scan, and SBOM jobs all succeeded, and GitHub reported zero billable runner
milliseconds. Final Railway API deployment
`ee8c19c1-1a9a-41c6-a85c-b4ab68dfa3da` and web deployment
`9af689f7-000d-4781-9ac8-1bb0801a2a24` both reached `SUCCESS`; `/healthz`,
`/readyz`, and the web build marker exposed that full exact SHA, and the light
asset/security-header smoke passed. Independent final review found no P0/P1 and
approved immutable annotated tag `rc/01-evidence-engine/1`, which was created
and pushed at that exact SHA. The tag must never be moved or reused. Milestone
02 may now begin only from this updated `main` closure.
