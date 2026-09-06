# M10 — public Testnet hardening

Status: **local hardening and hosted CI verified; M10 remains active with public launch blocked on external decisions**.
Branch: `codex/10-public-testnet-hardening`, from M09-complete main
`a1c331a5d28b00ea7469bd015eaaef83797f134d`.
M09 RC: `rc/09-investigation-operations/1` at
`3fecd6bb44dd71931e1e239b8e9e8b6d30cb19f8`.

## Frozen boundary

This milestone hardens the existing read-only Testnet product. It does not add
mainnet, transaction signing, payment collection, a provider, analytics, accounts,
external monitoring subscriptions or a new persistence kind. All existing feature
flags remain false by default. No public domain, operator identity, legal approval,
support address, security reviewer or design partner is invented.

Arc's announced September 16 public-mainnet date is not adapter configuration.
M11 still requires published official parameters and separate release approval.

## Local engineering work, before public launch decisions

1. Exercise the running HTTP API with disposable loopback Redis and synthetic
   fixture providers: health versus readiness during failure, bounded responses,
   shared budget across API instances/restart, connector kill switches, and no
   request-body canaries in operational output. Never contact a real provider.
2. Record a same-origin browser rollback/roll-forward drill using the immutable
   security-fixed M09 reader and current build. Synthetic encrypted records must
   survive; feature availability and exact build markers must match each phase.
   A separate M08 format-compatibility check does not authorize operational rollback
   to M08, which predates M09's session-boundary fix. Retain the separate M07
   incompatible-reader rejection/rescue proof.
3. Keep encrypted backup/recovery coverage and document origin migration: a new
   origin cannot automatically access the previous origin's browser vault.
4. Write an exact feature/flag/authority matrix and operational runbooks covering
   monitoring, incident handling, source shutdown, Redis loss, rollback and restore.
   Distinguish tested local drills from unperformed production operational actions.
5. Correct misleading availability wording in existing help without adding an
   unapproved public operator or implying authentication/enforcement.

## Drill contracts

- Inputs: fixed loopback origins, task-owned processes/directories, synthetic
  credentials and records, explicit immutable reader commits. No real environment
  secret values, personal browser profiles or user vaults.
- Outputs: pass/fail assertions and sanitized counts/build markers; no private
  request bodies or vault contents in logs, metrics or reports.
- Timing: each request uses existing configured deadlines plus a bounded transport
  allowance. No unbounded polling, hidden retries or real provider dispatch.
- Redis failure must not make readiness appear healthy or replay rejected work.
  Shared request counters survive an API restart while Redis remains intact.
  Empty Redis replacement is not equivalent to restored counters: keep source
  traffic disabled until an operator has established a safe budget-recovery basis.
- Kill switches require a controlled restart/redeploy, not an invented dynamic
  runtime toggle. Existing evidence remains local and readable.
- Browser rollback remains on a task-only origin with pinned local fixture TLS;
  no production rollback or paid infrastructure is performed by the drill.
- Tests fail explicitly when required local prerequisites are missing. No silent
  skips may be counted as operational proof.
- API test files run serially because the existing Redis fault tests intentionally
  pause the whole disposable Redis server. Key prefixes alone cannot isolate that
  failure. Web/shared suites retain their normal parallelism; no assertion is skipped.

## Public launch gates — unresolved, not implementation assumptions

User decisions recorded September 6, 2026: retain the temporary Railway origin
(no current permanent domain), use **OpenArc** as the project-facing organization
name, and leave email/contact selection unresolved. This does not establish a
registered entity, jurisdiction or operational contact. The requested public
repository is conditional on preventing personal-username disclosure; the existing
private repository must not be made public as-is.

GitHub organization `OpenArcHQ` was subsequently created on the Free plan with
display name OpenArc and a dedicated standard-domain SimpleLogin forwarding alias
for organization notices. Public membership count was zero and no public profile
email was configured when checked. No repository was published or transferred.
The alias is not yet a designated public support/security channel. Private
membership does not suppress personal identities in public GitHub activity or
existing commit history; the no-personal-usernames publication condition remains.

- [ ] Permanent product domain and encrypted-vault origin/migration plan approved.
- [ ] Public operator/entity, jurisdiction, support and security contacts supplied.
- [ ] Privacy/Testnet terms and non-affiliation/trademark language legally reviewed.
- [ ] Independent application-security review with a named reviewer and findings.
- [ ] Named incident/support owner, monitoring destination and retention decisions.
- [ ] Three to five approved design partners and three useful workflow feedback
  trails; synthetic self-tests do not substitute for external user feedback.
- [ ] Deployment-specific operational drills, rollback/restore evidence and signoff.
- [ ] Full exact Node 22/CI/scans/SBOM/staging gate and no unresolved P0/P1.

Local technical checks cannot mark these approvals complete. The existing Railway
staging domain remains the controlled test origin, not the permanent public launch.

## Verification ledger

Local hardening candidate: `1e61cab41f1c3166bf5d0f23afdcc1d9c3b9786a`.
No M10 RC or public deployment is authorized by this document. M09 remains the
latest completed release and staging candidate.

- Four real HTTP/Redis operational tests passed alongside all twenty existing
  budget tests (24/24, serial, 1.59s). They use actual Redis/Lua via isolated test
  key prefixes, a task-owned TCP fault proxy and loopback provider fixtures.
  The production API implementation was not changed. Exact failure codes and
  metrics/log counts, source-call counts, bounded deadlines, restart budgets and
  private canary exclusions are asserted. This is HTTP integration proof, not a
  deployed-image outage/recovery exercise.
- The compatible-reader harness completed all six phases without retries:
  current → M09 RC → current, and separately current → M08 RC → current.
  Each phase checks exact build identity, unchanged ciphertext, synthetic report
  and policy readability, and zero fetch/XHR or off-origin requests. M09 retains
  Investigations; M08 lacks it; current restores it and its redacted preview.
- Both historical production bundles were built from separate `git archive`
  extracts of their exact immutable commits, with Node 22 and frozen lockfiles.
  This local drill served production Vite bundles, not Railway deployment images.
  The origin was fixed `https://127.0.0.1:8444`, using a one-day synthetic
  certificate pinned by SPKI, without a global TLS bypass or system trust change.
  Only fresh task-owned browser profiles were used. The preview and TLS servers
  were stopped afterward; no real browser profile, secret, wallet or provider was used.
- M09 rollback profile: `tmp/m10-reader-drill-sv9WYv`; separate M08 compatibility
  profile: `tmp/m10-reader-drill-drTzv9`. Each phase marker binds the exact current
  and reader commits and refuses out-of-order or cross-reader reuse.
- Syntax, lint, typecheck and focused independent review passed. A 120-second
  whole-run watchdog also bounds storage evaluation/browser shutdown, with a
  two-second shutdown grace. Public-launch approvals remain unresolved.
- CI 34011606167 (pre-publication CI; private link omitted)
  passed on exact candidate `1e61cab41f1c3166bf5d0f23afdcc1d9c3b9786a`:
  528 unit/integration tests (221 shared, 189 API, 118 web), 112 development
  browser checks and 44 production browser checks, all first-pass with no retries
  or flakes. The 16 intentional production fixture-only skips are not counted as
  passes. Verification, browser and image jobs all concluded successfully.
  The incompatible-reader drill seeded the current build, verified safe rejection
  and rescue under immutable M07 `2edbc9d2c4c9eec309603a4347e69fbe15974470`,
  then restored the current build. Each phase passed with zero source requests
  and preserved ciphertext.
- The full Node 22 Docker gate passed 528 unit/integration and 112 development
  browser checks without retries, plus audit, license policy, lint, typecheck,
  builds and release checks. Gate image manifest:
  `sha256:41ad3838b8af05dade43009d1d34a9d09a1418ad23e6faf4b7303e6b99474eae`;
  manifest list `sha256:9c890886ae0087986117cc0ce998e75c71e3e7e5f703271acd76f2c064c51c6d`.
  The existing bundle-size advisory remains visible; no threshold was increased.
- Hosted verification and all ten image scans passed. Exact-SHA CycloneDX SBOM
  artifact `9982715070` contains ten SBOMs, 975,888 bytes, digest
  `sha256:bf612f380b4b6ec3b1b0c7ef8c117a1bf5743b2a5d5aa8466c0c3eb12f4bd8a4`,
  expiry `2026-12-05T04:28:58Z`.
- Exact-candidate browser diagnostics artifact `9982908273`: 6,393,859 bytes,
  digest `sha256:db0e3623d0167f81838b18aa0cdce7e8d7a61f0a4a28246b2b4d2ab2b666ca1a`,
  expiry `2026-09-09T04:51:46Z`. Both artifacts were unexpired when verified.
- No M10 staging deployment, RC, main merge or public launch was performed.
  Staging still exposes the verified M09 application commit on both services;
  its readiness check was healthy. M10's technical checks do not close the
  unresolved operator, domain, legal, independent-review, user-feedback or
  deployment-specific operational gates above.
