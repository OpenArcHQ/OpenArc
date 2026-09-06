# Public Testnet operations runbook

Status: **M10 preparation, not public-launch approval**. Deployment-specific drills
and operator signoff are pending. This document describes procedures; it does not
claim they have been performed. Use the evidence ledger in
[M10](../releases/10-public-testnet-hardening.md) for actual results.

Latest completed milestone: M09, immutable `rc/09-investigation-operations/1`,
`3fecd6bb44dd71931e1e239b8e9e8b6d30cb19f8`. M10 starts from main
`a1c331a5d28b00ea7469bd015eaaef83797f134d`. Do not treat this document or an
announced Arc mainnet date as permission to change network parameters.

## Authority and release boundaries

- Local checks use disposable loopback services, synthetic data and task-owned
  browser profiles. Do not use personal vaults or read real secret values.
- Production configuration, restart, deployment, rollback and domain changes need
  explicit authorization and an identified operator. This runbook grants none.
- Incremental recurring vendor spend is $0. Do not enable PAYG, paid monitoring,
  auto-upgrades, a new provider or paid infrastructure to complete a drill.
- OpenArc does not sign, broadcast, execute payments or enforce agent policy.
  User-paid network/protocol costs in external tools are not free OpenArc actions.
- Never rotate secrets merely to reset limits, flush budget keys, disable TLS
  validation, relax CI gates or retry rejected source work automatically.

## Feature flags and authority matrix

Every feature flag below defaults false. Web `VITE_*` values are build-time
configuration: rebuild and deploy the web artifact to change them. API flags are
read at startup: restart/redeploy the API with a valid cumulative configuration.
They are not live dashboard switches. Hiding a UI is not a server-side kill switch.

| Capability | Web flag and prerequisites | API flag and prerequisites | Authority/evidence boundary |
| --- | --- | --- | --- |
| Encrypted workspace | `VITE_ENCRYPTED_WORKSPACE_ENABLED` | None | User unlocks local encrypted records; no account or server vault |
| Capability checks | `VITE_API_BOUNDARY_ENABLED` + workspace | `API_BOUNDARY_ENABLED` | Explicit request/consent; capability response is not provider health |
| Arc account/transaction | `VITE_ARC_OBSERVATION_ENABLED` + preceding web flags | `ARC_OBSERVATION_ENABLED` + API boundary | Exact consented public input; bounded named Testnet observation |
| ERC-8004 registry | `VITE_AGENT_REGISTRY_ENABLED` + Arc chain | `AGENT_REGISTRY_ENABLED` + Arc | Registry observation; external metadata untrusted and not fetched |
| ERC-8183 reference jobs | `VITE_AGENT_JOBS_ENABLED` + registry chain | `AGENT_JOBS_ENABLED` + registry | Fixed reference-contract evidence, not universal job coverage |
| x402/Gateway Payments section | `VITE_GATEWAY_EVIDENCE_ENABLED` + jobs chain | `GATEWAY_EVIDENCE_ENABLED` + jobs | Imported metadata local; separate explicit consent for Gateway lookup |
| Agent report imports/policies | `VITE_GENERIC_AGENT_IMPORT_ENABLED` + workspace | None | Local unauthenticated report and monitoring-only evaluation |
| Investigations/export/history | `VITE_INVESTIGATIONS_ENABLED` + workspace | None | Read-only supplied-record projection; no source refresh |

The API source chain is cumulative: Gateway → jobs → registry → Arc → API
boundary. Disabling an ancestor requires disabling its descendants in the same
configuration; otherwise startup validation rejects it. Arc requires configured
Redis, distinct abuse/proxy secrets and at least five source subcalls; registry
requires at least ten, jobs at least eleven. The default subcall cap is eight,
so it is not sufficient for registry/jobs. Maximum configured subcalls is sixteen.
Current defaults are 60 attempts per authenticated peer/route hour, 10,000 source
units per source-class day budget, a 5,000 ms source timeout and 256 KiB maximum
source response. These are application limits, not a vendor free-tier guarantee;
the actual deployment may configure stricter values. Keep the source-specific
accounting in `arc_rpc` and `gateway` distinct when reviewing allowances.

Production additionally requires an exact HTTPS `APP_ORIGIN`, a 40-character
commit SHA and a metrics secret. Abuse, proxy and metrics secrets must be distinct.
Never put secret values into a web build, repository, command transcript, screenshot
or ticket. The same-origin web proxy requires its configured upstream host/SNI,
verified trust bundle and source proxy boundary. Do not accept client-supplied
proxy identity as operator authentication.

Source flags permit a route; they do not grant permission to release a user's
input. The workspace still requires the relevant explicit approval. Existing saved
evidence remains encrypted locally when a source is disabled. Local imports and
Investigations need neither Redis nor a live provider.

## What results mean

- M01 examples remain synthetic fixtures, not live payment proof.
- Arc snapshots are time/block-bounded observations, not complete wallet history.
  Registry and job facts have their own fixed contract/source limitations.
- M07 receipt bundles are imported, unauthenticated metadata. Gateway status and
  successful matching Arc batch inclusion do not prove individual settlement,
  verified authorization signatures or resource fulfillment.
- M08 reports do not verify reporter identity, execution or human approval.
  Daily rules sum supplied attempted amounts for the selected UTC day across
  reported statuses; totals are not confirmed spend. Partial history cannot prove
  an under-limit result. Possible replay findings are not execution proof.
- M09 compares supplied records and explicit links only. At more than 64 stored
  bundles, collection replay coverage is unavailable. Detail/export pagination
  and omissions remain visible; an exception inbox is not a complete-history audit.
- Saved source history is not current provider availability. “Aged” means over
  24 hours by a UI convention, not invalid evidence or an outage. A capability
  check, unresolved approval, failed attempt and saved observation are distinct.

## Health, readiness and protected monitoring

| Surface | Interpretation | Operator action |
| --- | --- | --- |
| `GET /healthz` | Process liveness and build marker only | Match expected SHA; do not infer Redis/provider readiness |
| `GET /readyz` | Redis dependency check when Arc/source routes enabled; otherwise Redis not required | Enabled routes + failed Redis must return 503; no upstream provider probe |
| `GET /metrics` | Aggregate process-local counters and build/source gauges | Protected Bearer header only; no query-string token; scrape destination TBD |

API responses set `Cache-Control: no-store`. Metrics reject query strings and
unauthorized access; do not expose the credential in URLs or dashboards. Process
metrics reset with an API restart and are not the authoritative budget ledger.

Application completion logs are limited to generated request ID, fixed route
class, safe method, status, duration bucket, failure code and build SHA. Metrics
use bounded route/status/failure/source labels. Never add request bodies, raw
URLs/query strings, wallet identifiers, provider response bodies, cookies, proxy
secrets, report contents or vault plaintext to diagnostics. Hosting/proxy logs are
a separate operational surface: their configuration and retention need review;
the application allowlist is not a claim that third-party logs retain nothing.

Monitoring destination, alert thresholds, on-call recipient and retention period
are **TBD**. No subscription or background monitor is provisioned by this document.

## Source incident and shutdown

1. Record UTC incident time, exact web/API build markers, fixed failure codes and
   aggregate counts. Do not collect private inputs or ask users for passphrases.
2. Separate live-process, Redis-readiness, budget-exhaustion, provider-timeout and
   source-schema failures. A 200 liveness response cannot clear a source incident.
3. With authorized deployment access, disable the affected API source and all
   dependent descendants, then restart/redeploy. For all external sources, disable
   Arc, registry, jobs and Gateway together; capability checks can remain separate.
   If the whole private API must be closed, disable API boundary as well.
4. Match UI flags in a rebuilt web artifact as needed, but do not rely on the UI
   alone. A request already dispatched before shutdown cannot be recalled.
5. Verify exact build/configuration, source rejection and readiness semantics using
   approved synthetic checks. Leave local saved-evidence access available when safe.
6. Do not replay previously rejected requests on recovery. Re-enable only after
   the cause, remaining budget and release checks are established and approved.

## Redis outage, restart and loss

Redis is shared budget coordination, not a user-vault store. Source reservations
must fail closed when it is unavailable or misses its deadline. Reconnection is
not permission to queue/retry commands or refund uncertain reservations.

An API restart with the same intact Redis preserves its shared counters; a fresh
Redis instance does not. Keep source traffic disabled after loss, flushing,
eviction or uncertain restoration of budget data. A successful PING proves neither
counter continuity nor remaining vendor allowance. Do not describe an empty store
as “restored.”

The current code does not automatically distinguish an empty replacement Redis
from a legitimate new budget store. This is an operator gate, not an implemented
automatic loss detector: disable sources before reconnecting/replacing an uncertain
store, and do not claim budget continuity across loss from the passing restart test.

Before resuming, the operator must document a conservative budget-recovery basis:
which counters/windows were preserved, what requests could already have been
reserved/dispatched, and how remaining allowance is bounded. Where that cannot be
established, remain paused until a safe reset/window basis is confirmed. The Lua
guard uses Redis TIME aligned UTC-hour/day windows, with expiry sixty seconds
after each window ends; this does not establish a vendor's allowance reset time.
Do not recover allowance by changing secrets. Redis
persistence/backup policy and deployment-specific restore evidence remain TBD.

## Local vault backup, recovery and origin changes

The vault belongs to the exact browser origin and profile. A new domain, scheme
or port cannot automatically access it. Server/Redis backups cannot restore user
vaults. A recovery secret alone does not recreate missing encrypted records.

Before an approved origin move: keep the old origin available, ask the owner to
export an encrypted backup there, verify the new build/origin, import the backup
through the normal UI, and verify records before removing old-origin data. The
owner retains their own backup passphrase/recovery material; support must not
receive it. Backup import/replacement is an explicit local operation, not automatic
cross-origin migration. Do not clear site data as an incident workaround.

If a reader cannot unlock supported encrypted bytes, preserve them and use opaque
rescue export where available. An opaque rescue is not decrypted proof of data
integrity. An M09 redacted plaintext report is not an encrypted backup and cannot
restore a vault. Warn before sharing optional identifiers/amounts/timestamps.

## Rollback and roll-forward

M08 is the minimum reader for stored M08 agent-report/policy records. The immutable
compatible checkpoint is `rc/08-local-agent-connector/1` at
`16cd6f5cf557512cc373c2c5d1fb57dc89c0d63f`. M09 adds no persisted record kind.
M07 `2edbc9d2c4c9eec309603a4347e69fbe15974470` is an incompatible-reader
rejection/rescue test target, not an approved reader rollback for those records.

Compatibility is not security approval: M08 predates M09's post-decryption
coordination check. Prefer disabling a problematic feature on a current safe build
over restoring an older vulnerability. Any actual rollback requires assessment
of security fixes, exact source/image identity, configuration, source budgets and
explicit authorization. Never move an immutable RC tag.

The operational rollback checkpoint for M10 is the security-fixed M09 RC
`3fecd6bb44dd71931e1e239b8e9e8b6d30cb19f8`, not M08. The separate M08 test
establishes format compatibility only and explicitly expects Investigations to be
absent. The M09 checkpoint retains Investigations.

The local drill must use the same disposable origin/profile, pin its synthetic TLS
certificate, check exact build markers at each phase, preserve ciphertext and
verify the selected reader's actual feature availability, then roll forward.
Do not apply the local certificate exception to a public origin. Preserve the
separate M07 fail-closed/rescue proof. Do not count a local drill as a production
rollback or declare the current deployment restored without deployment evidence.

## Unresolved public-launch decisions

| Decision | Current state |
| --- | --- |
| Permanent domain and approved origin migration | User confirmed retaining temporary Railway staging; no permanent domain or migration approved |
| Operator/entity, jurisdiction and incident owner | Project-facing name approved: OpenArc; legal entity, jurisdiction and incident owner remain unconfirmed |
| Support and security contacts | A dedicated SimpleLogin alias is configured for GitHub organization notices only; no public support/security channel or response commitment designated |
| Privacy/Testnet terms, non-affiliation and trademark review | Legal review pending |
| Independent application-security reviewer and findings | Pending; internal tests are not an independent audit |
| Hosting/application/Redis retention and backup policy | TBD |
| Monitoring destination, thresholds and response ownership | TBD |
| Three–five approved design partners and useful workflow feedback | Pending; synthetic tests do not substitute |
| Deployment-specific drills and release signoff | Pending; consult M10 ledger |

## Implementation references

- [API configuration](../../apps/api/src/config.ts), [HTTP/health surface](../../apps/api/src/app.ts),
  [metrics](../../apps/api/src/ops/metrics.ts), [budget guard](../../apps/api/src/limits/budget.ts).
- [Web gates](../../apps/web/src/App.tsx), [build/runtime proxy configuration](../../apps/web/Dockerfile),
  [vault service](../../apps/web/src/vault/service.ts).
- [M09 evidence and limitations](../releases/09-investigation-operations.md),
  [M10 frozen scope and approvals](../releases/10-public-testnet-hardening.md).
