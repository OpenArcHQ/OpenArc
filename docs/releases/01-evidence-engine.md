# Milestone 01 — evidence engine and fixture explorer

Status: **active implementation**
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
| Limitations per record/result | 8 |
| Conflicts or gaps per result | 16 |
| Human-readable label/detail | 160 / 240 characters |
| Canonical integer | 78 digits |
| Canonical timestamp | UTC `Z` only |

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
- The graph is a progressive visual summary of exactly the same records; it
  adds no fact, conclusion, or control.
- Every conclusion cites input evidence IDs, ordered gaps/conflicts, the rule
  version, and limitations.
- Evidence authority classes remain distinct. `AUTHORIZED`, `SETTLED`, and
  `FULFILLED` are never collapsed.
- Policy results say `LOCAL MONITORING ONLY`; they do not claim wallet or
  protocol enforcement.
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
- [ ] Clean Node 22 release gate, image scan, and SBOM pass
- [ ] Exact pushed SHA and exact hosted CI pass
- [ ] Exact Railway staging markers and fixture walkthrough pass
- [ ] Independent review finds no P0/P1

No staging deployment or M02 work begins until the relevant gates above are
complete.

## Local implementation evidence

On 2026-09-01, the source-identical pre-commit implementation passed the full
clean-room Node 22 release gate in the pinned gate image: production audit and
license policy, lint, strict typecheck, 34 shared tests, 4 API tests, 6 web unit
tests, production builds, and 8 browser journeys split across Chromium and
WebKit. The browser gate includes full-document serious/critical Axe analysis,
keyboard tabs, graph/list parity, mobile target sizing, reduced motion, empty
browser storage, and zero external or dynamic evidence requests.

Exact pushed-SHA CI, production-image scans/SBOM, Railway staging markers, live
fixture walkthrough, and independent review remain pending and must be appended
without rewriting this implementation evidence.
