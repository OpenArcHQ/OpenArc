# Milestone 02 — encrypted local workspace

Status: **complete — immutable `rc/02-encrypted-workspace/1`**
Network review: **not applicable — local-only, zero live calls**
Base: `main` after immutable `rc/01-evidence-engine/1` and the M01 closure record

## Frozen boundary

Milestone 02 turns the M01 evidence engine into an origin-bound private browser
workspace. It adds creation, unlock, lock, local encrypted records, recovery,
encrypted export/import, revision conflicts, deletion, cross-tab coordination,
and an accessible workspace shell.

It does not call Arc RPC, Circle, Gateway, a provider, analytics, or the OpenArc
API. It does not create an account, persist a key or passphrase, connect a
wallet, sign, broadcast, infer an agent identity, or define mainnet behavior.
M03 owns every future network and permission-before-network control.

## Cryptographic and storage contract

- One IndexedDB database, `openarc-vault`, with `vaultMeta` and `records`
  stores. No plaintext workspace field appears in public metadata.
- A random 256-bit data-encryption key encrypts records with AES-256-GCM, a
  fresh 96-bit IV, a 128-bit tag, and canonical AAD binding the Vault, record,
  schema, key version, and opaque record revision. Stored-IV collisions fail
  closed; the residual chance of matching a previously deleted random IV is
  not claimed to be zero.
- Versioned wrapping and backup KDFs use PBKDF2-HMAC-SHA-256 with independent
  random 128-bit salts and 600,000 iterations. A 2026-09-02 local benchmark on
  the exact Playwright Chromium/WebKit engines measured three 600,000-iteration
  derivations at 38–39 ms and 68–70 ms respectively (310,000 iterations measured
  20 ms and 36–38 ms). The release gate will rerun bounded KDF behavior in both
  engines; production parameters can only change under a new format version.
  The passphrase and recovery secret wrap the data key separately with AES-KW.
- The unlocked CryptoKey is nonextractable. Lock invalidates the session,
  aborts pending work, clears decrypted React state/drafts, and never claims
  guaranteed JavaScript heap erasure.
- Public metadata contains only format/database/schema/key versions, opaque
  Vault and sentinel IDs, data and coordination revisions, a one-bit
  deletion-pending marker, KDF parameters, and key wrappers. The coordination
  revision supports same-origin lock polling; the marker reveals only that
  local deletion was requested.
- One opaque-random-revision-checked readwrite transaction owns every record
  change. A manifest sentinel authenticates the global revision plus a sorted
  digest/revision entry for every non-sentinel envelope; whole-database rollback
  remains outside the local threat claim. Import
  replaces the whole Vault only against expected-empty or exact
  `{vaultId, revision, coordinationRevision}` state with deletion not pending.
  Expected-empty creation or import additionally requires the record store to
  be empty, so orphan ciphertext is never silently overwritten.
- The M02 encrypted record union contains agent profiles, local monitoring
  policies, M01 evidence, M01 actions, workspace settings, and one sentinel.
  Permission receipts begin with M03; investigation notes begin with the later
  investigation milestone. Unknown kinds and versions fail closed while the
  encrypted bytes remain exportable and deletable.
- Per-kind limits are 100 agents, 500 policies, 5,000 evidence records, 1,000
  action envelopes, one settings record, and one sentinel. The encrypted backup
  remains capped at 32 MiB. Capacity is checked before save and download.

### Threat and metadata boundary

The locked-state claim covers plaintext confidentiality against casual
IndexedDB/file inspection, authenticated envelope contents, transactional local
consistency, and late-write rejection. It does not protect an unlocked tab,
XSS or hostile future same-origin code, a malicious extension, compromised
browser/OS, screen or clipboard capture, JavaScript heap recovery, deliberate
storage clearing, whole-database rollback, or availability. Password wrappers
permit offline guessing; the KDF raises cost but cannot rescue a weak password.

The database and backup can reveal their existence, format/KDF versions,
approximate record count, ciphertext sizes, access/write timing, and total file
size. Storage persistence is best effort and is not a backup. Any M02 Railway
Vault is disposable because IndexedDB is origin-bound; moving to another origin
requires an encrypted export/import.

## Backup, recovery, and deletion

- Export decrypts and validates one atomic snapshot before building a canonical
  logical-record archive. A distinct user-supplied backup passphrase encrypts
  the entire archive with a fresh salt and IV; the clear header contains only
  magic, version, KDF, salt, and IV and is authenticated as AAD.
- Import bounds bytes and KDF work before decrypting, validates the entire
  archive and every encrypted record, and performs no merge. M01 conclusions
  are recomputed from the same-action evidence and policies linked to that
  action's agent; cached results, cross-action citations, and cross-agent policy
  links are rejected unless they exactly match deterministic recomputation.
- Import creates a fresh Vault ID, DEK, local passphrase wrapper, recovery
  wrapper, record revisions/IVs, and manifest, then shows a new recovery secret.
- Local recovery verifies every record before rotating passphrase and recovery
  wrappers in memory. Any failure preserves the original wrappers. A new
  recovery secret is shown once; the old passphrase and secret fail afterward.
- Delete enters a non-interactive pending phase. `onblocked` never reports a
  cancelled deletion; controls stay unavailable until the uncancellable request
  succeeds or fails. A public marker is committed before deletion, so locked,
  unlocked, BroadcastChannel-disabled, restarted, and recovering tabs fail
  closed and can resume deletion rather than reopening the workspace. Database
  version changes and unexpected closes are classified separately; external
  browser-storage eviction clears decrypted state and returns to the honest
  empty state without leaving private workspace controls mounted.
- Opaque rescue opens the existing database without requesting an older schema
  version and copies only the known stores as unparsed values. A future database
  version therefore remains rescuable and deletable even when this build cannot
  decrypt or unlock it.

## User-visible workspace

- First creation shows the recovery secret and a keyboard-accessible six-step
  tour covering proof limits, local data location, owner-supplied wallet labels,
  the future permission-before-refresh rule, evidence/incomplete states, and
  lock/export/recovery/deletion.
- A persistent desktop rail and compact mobile navigation expose Overview,
  Agents, Policies, Evidence, and Settings.
- Users can create bounded owner-supplied agent profiles and local monitoring
  policies, and can copy a synthetic M01 fixture into encrypted records.
- Reload begins locked. Hidden/pagehide navigation locks immediately; the
  inactivity deadline is checked on visibility/pageshow restoration.
- Every private draft, dialog, decrypted record, and object URL is cleared at a
  session boundary.
- Hosted CI separately builds the exact production Nginx image with M02 enabled
  and runs Chromium and WebKit against its local-only CSP. The normal production
  image default remains disabled until the exact staging gate is approved.

## Exit evidence required before M03

### Local candidate evidence — 2026-09-03

The source-identical pre-commit tree passed `pnpm release:gate` under Node
22: release boundary checks, production dependency audit, license policy,
lint, typecheck, all builds, 49 shared tests, 4 API tests, 40 web tests, 46
feature-on Chromium/WebKit journeys, and 2 feature-off Chromium/WebKit
journeys. This local gate does not imply production-image, exact hosted-SHA,
or Railway verification; that evidence is recorded separately below.

The initial pushed implementation `bda162b90787f206eacd95a537c9befb65693b1f`
passed hosted verification and all three image scans/SBOMs in run
`33775618131`, but its browser job failed. It is not staging-approved. The
corrective candidate stabilizes modal focus across parent renders, waits for
the encrypted tour preference before cross-tab test operations, and isolates
the submit-before-poll deletion fixture. The four affected browser scenarios
passed three repeats in each engine with one worker (24 checks), followed by
the complete local gate above. Test servers use dedicated ports and never
reuse an unrelated running app. The corrective candidate's exact hosted
evidence is recorded below.

- [x] Shared record schemas reject unknown kinds, versions, overlong fields,
      invalid record relationships, and malformed timestamps
- [x] Crypto roundtrip, wrong passphrase, tamper, AAD, IV uniqueness,
      nonextractable key, Unicode, and KDF/size bounds pass
- [x] IndexedDB initialization, revision conflict, quota rollback, replacement,
      blocked delete, versionchange, and close behavior pass
- [x] Recovery validates before rotation and invalidates old credentials only
      after success
- [x] Mixed-record export, delete, import, and recovery pass in Chromium and
      WebKit
- [x] Cross-tab lock/change/delete and blocked-delete UI pass
- [x] Lock, hidden/pagehide, inactivity, and late-write guards pass
- [x] Plaintext canaries are absent from raw IndexedDB, browser storage,
      requests, console, URL/title, backup clear header, and post-lock DOM
- [x] Mobile, keyboard, tour focus, reduced-motion, contrast, and minimum target
      checks pass
- [x] Static guard proves the M02 runtime makes zero network calls and uses no
      plaintext browser-storage fallback
- [x] Full Node 22 release gate, production images, scans, and SBOM pass
- [x] Exact pushed SHA, Railway staging markers, lifecycle walkthrough, and
      independent no-P0/P1 review pass

No M03 implementation begins until every applicable gate above is complete and
the immutable M02 release candidate is merged into `main` with a closed record.

## Exact corrective candidate evidence — 2026-09-03

Corrective implementation `968c804f37903fb9ebae07a2701790c744f533e1` was
clean, pushed, and equal to its live remote branch head before staging.
GitHub Actions run `33776922243` completed successfully on that exact SHA:

- Node 22 release checks, production audit, license policy, lint, typecheck,
  49 shared / 4 API / 40 web tests, and production builds passed.
- All 46 feature-on Chromium/WebKit journeys and 2 feature-off journeys passed
  with one worker and no retries or flaky result.
- The exact feature-on production Nginx image passed both additional Chromium
  and WebKit journeys under `connect-src 'none'`.
- API, default-disabled web, and M02-enabled web images built; exact-marker
  smoke and all HIGH/CRITICAL Trivy scans passed with zero findings.
- All three CycloneDX 1.7 SBOMs were generated by Syft 1.51.0. Unexpired artifact
  `9902029229` (`openarc-sboms`) has digest
  `sha256:54e01b7d3dba9d4406081e4654949fdaadfba6c1190f0a2bcafcd75df13818db`.
- GitHub's timing endpoint reported zero billable runner milliseconds.

Independent read-only review verified the exact local/tracking/remote identity,
corrective diff, complete hosted results, image scans, and all three SBOMs. It
found no P0/P1 blocker and approved only exact-SHA staging. Immutable tagging,
final deployment evidence, release closure, and M03 remain separately gated.

## Exact implementation staging evidence — 2026-09-03

The same implementation SHA `968c804f37903fb9ebae07a2701790c744f533e1`
was deployed to the existing `openarc-staging` project's `staging` environment.
Both deployments reached `SUCCESS`:

- API deployment `97d785d3-8ac6-4ec4-b597-d90e3ac12ca0`, image
  `sha256:4a077d4b7ae7771ee2f0aeb51b24858b8eac60851354aab9751784cde8fefa3e`.
- Web deployment `59392e73-5688-4051-9df7-ac679fc5e8d0`, image
  `sha256:1cacfcebfec6e82fe8a5fa2526a7d07bb7957aed73368bca8e216e03d93b6d91`.

API `/healthz` and `/readyz` and the web HTML/footer exposed the full exact SHA.
The web returned `Cache-Control: no-store`, the local-only CSP, denied camera,
microphone, geolocation and payment permissions, no-referrer, nosniff, and frame
denial. Both referenced static assets returned successfully. The future
`/v1/capabilities` API route remained a no-store 404; no product API route was
enabled by M02.

Chromium and WebKit production-image browser checks also passed against the
actual Railway web origin. A separate, isolated Chromium context completed:

1. Workspace creation, recovery acknowledgement, and encrypted tour preference.
2. A synthetic private agent profile and a copied six-record M01 fixture.
3. Encrypted backup download, reload-locked behavior, and local unlock.
4. Local deletion, whole-backup import with new credentials, and restoration of
   the synthetic private profile.
5. Recovery credential rotation, rejection of the previous passphrase, and
   successful unlock with the rotated passphrase.
6. Desktop/mobile visual review, no mobile horizontal overflow, pagehide lock,
   and final deletion of the isolated test workspace.

The QA-only post-delete reader was corrected to check database existence rather
than reopen a successfully deleted database. The complete rerun passed without
any product-code change. It found zero private-canary leaks in raw IndexedDB,
backup bytes, captured request URLs/headers/bodies, or browser console; zero
browser errors; only same-origin static GET requests; and no provider or product
API calls. After final deletion there was no active Vault metadata or remaining
record.
The context was closed; no user browser profile or existing Vault was touched.
A bounded scan of the exact deployments' application logs (3 API and 100 web
lines) also found no synthetic private-label or passphrase canary.

Only the known non-secret build marker and M02 web flag were changed. Both
existing services retained one replica, 1 vCPU / 1 GB ceilings, serverless
sleep, and zero volumes. No project, service, database, paid provider, or new
recurring resource was created. The staging workspace remains disposable and
origin-bound at `https://web-staging-1275.up.railway.app/workspace`; this is not
a permanent-origin or public-launch approval.

### Live proof and rollback boundary

Live Arc Testnet transaction proof is not applicable to M02: the enabled web
has `connect-src 'none'` and only local encrypted operations. M04 owns the first
live chain-read proof. M02 has no Redis, provider, or private API persistence to
claim tested.

If a production-only Vault failure is discovered, stop further promotion and
retain the failing exact build and encrypted bytes. Roll back the web to the
last known-good immutable image or rebuild with M02 disabled, verifying its
exact marker and local-only headers before use. A disabled/M01 shell cannot
read M02 Vault data; it must not delete, rewrite, downgrade, or claim to recover
that data. Preserve the same origin and return to a validated M02 build for
unlock/rescue. An origin change requires a separately verified encrypted
export/import first. No destructive live rollback drill was needed or claimed
for this local-only milestone.

## Final exact candidate and closure — 2026-09-03

The evidence-only successor
`298c695ae615ea090b02b0410b7ae37125c625b1` passed exact GitHub Actions run
`33778011261`. All verification, browser, and image jobs succeeded, including
49 shared / 4 API / 40 web tests, 46 feature-on journeys, 2 flag-off journeys,
and both feature-on production-image browser tests. There were no retries or
flaky browser results. All three HIGH/CRITICAL scans reported zero findings;
the three CycloneDX 1.7 SBOMs are in artifact `9902464732`, with digest
`sha256:1416fe73b9c0fb1445abddae4116b198326f000fc4482abd46549f7fc1ec15cb`.
GitHub reported zero billable runner milliseconds.

Final exact Railway deployments both reached `SUCCESS`:

- API `e9f839c8-fb9a-4a9e-952a-f54c593deb48`, image
  `sha256:15525a3388ba2c018bd9a41dd157fb5d6457bf8b5fe95f276a5bc52ee710dee0`.
- Web `1c8aaf86-ad6d-4c42-9d18-fa8095950354`, image
  `sha256:8a416d7d55328d72a7eeefffe0452f23860aa8c28d6caf4300c5db90cf765c58`.

API health/readiness and the web marker exposed the full final SHA. The bounded
asset/security-header/disabled-route smoke passed, and both Chromium and WebKit
production browser journeys passed again against that live origin. The full
implementation lifecycle evidence above belongs to `968c804`; the only change
in `298c695` is this release-evidence document.

Independent final review verified clean/pushed identity, exact CI, scans/SBOMs,
zero billable runner time, and live markers/headers/assets. It found no P0/P1
and approved immutable annotated tag `rc/02-encrypted-workspace/1`, which was
created and pushed at `298c695ae615ea090b02b0410b7ae37125c625b1`. The tag is
merged into `main`; this subsequent closure records the completed operations
without moving or reusing the tag. M03 may now begin only from the updated
`main` containing this closure. This is not public-launch or mainnet approval.
