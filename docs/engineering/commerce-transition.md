# Commerce transition status

Updated September 12, 2026. Status: PORT00/PORT01 accepted; PORT02 implemented in
integrated source and awaiting final production-browser/release validation;
PORT03–PORT09 not implemented. Not a commerce launch and not deployed.

## Authoritative target

The three canonical engineering documents now describe the supplied marketplace,
control, proof and privacy product. Original supplied bytes are preserved under
`archive/commerce-supplied-2026-08-16/`; these are the original-source hashes,
not hashes of the subsequently amended canonical files:

| Document | SHA-256 |
| --- | --- |
| Engineering source of truth | `6192fd2a94b51bfd5cfeed86d8bbef787d2a4cc7ab9a57be6552cd37202fe711` |
| Backend architecture | `7c3d4b7b2ea939f683f084f02e8b233d5a92270c0bcfedcae51f7aeaca3a32f6` |
| Frontend architecture | `80710795f21226006ad734bf08bd7a2f12a5145b3df446f03b02b81436b0da61` |

Previous repository specifications are archived under `archive/pre-commerce/`.
They document the legacy investigation product, not completion of the new target.
Legacy release reports retain their historical scope regardless of milestone number.
Use **S-M00–S-M09** for supplied Testnet milestones and **PORT-*** for migration work.

Canonical specifications are now version 0.3.1-draft. The September 11 amendment
requires wallet connection for payment users, separates sign-in from spending
authority, and records the accepted passkey path for non-payment accounts.
The owner accepted minimal credential/account/security records and a separate
account-free guest path. This is not an anonymous or zero-retention account.
These are build requirements, not deployed authentication or payment features.

## Current implementation

PORT00 and PORT01 are accepted. PORT02 is implemented in the integrated source
and undergoing final production-browser and release validation; PORT03–PORT09
are not implemented. This section describes integrated source, not deployment:
no port, release, mainnet or payment completion is claimed, and the marketplace
is not live.

The foundation now includes account, passkey and wallet sign-in; tenant role and
read/write controls; agent/provider credentials with scoped machine sessions;
durable idempotency, audit and outbox records; worker reliability; and truthfully
bounded capability manifests. The marketplace source includes immutable listing
versions, owner/provider-admin/developer draft and version management,
independent origin review, publish/pause/retire, an allowlisted public catalog
with provider profiles, search and pagination, and a protected editor with
history. Public `/market`, `/market/:listingId` and `/providers/:providerId`
routes require flags; the `/docs`, `/status` and `/legal` shells exist. Supplied
`/design` and videos/legacy workspace are preserved.

Hosted account enrollment and new marketplace features remain disabled; purchases
are unavailable. Listing review by an independent moderator is independent
origin-metadata moderation, not a security endorsement or execution authority;
provider self-review is not permitted. Reference-sum artifacts are contract or
synthetic fixtures only, not a working service, payment or retrieval path. Legacy
investigation staging remains unchanged.

## Accepted first contract slice

P01-01a adds strict commerce data-class/audience metadata, nine evidence classes,
17 target summary states, independent evidence dimensions and versioned schema
descriptor metadata. It adds no payment, database, authentication or frontend route.

The new contracts live under `packages/shared/src/commerce/`; existing public
exports and legacy evidence parsers remain unchanged. Privacy labels are not
authorization or automatic redaction. Payment, delivery, evaluation and settlement
are separate facts. A list of states is not a transition algorithm.

The initial focused suite contains 29 tests, including wrong-audience rejection,
private/secret persistence rejection, unknown-field and version rejection, legacy
enum compatibility and preservation of unresolved/contradictory dimensions.
CI results apply to their exact source revision; previous staging checks are not
evidence that the target commerce product is finished.

## Implementation order and boundaries

P01-01b adds the strict `openarc.api.v2` response contract: exact build/request
metadata, 31 fixed non-echoing error messages, canonical error construction and
a typed success-envelope factory for reviewed DTOs. Its 16 new tests bring the
two commerce contract suites to 45 tests. Retry flags remain conservatively false;
there is no automatic write retry. Legacy API v1 remains unchanged. This does not
activate any API route or complete the field-level domain DTO registry.

P01-01c adds strict, organization-protected organization, access-view, agent and
provider DTOs, canonical prefixed identifiers and frozen field-class maps. Its 15
tests bring the commerce suites to 60 tests. Invalid dates return validation errors
without throwing; timestamp ordering preserves sub-millisecond precision. These
are presentation/data contracts, not login, tenant isolation or spending authority.

P01-01d adds an executable, explicitly four-DTO identity registry, checked field
maps and typed API v2 success envelopes; its 11 tests verify strict boundaries and
preserved timestamp refinements. It does not accept arbitrary future DTOs.

P01-02a adds strict Testnet USDC quantities, exact BigInt arithmetic, explicit
native/ERC-20 conversion and lossless decimal formatting. Its 34 tests cover
overflow, underflow, precision loss, wrong units, malformed inputs and deterministic
round trips. The commerce suites now contain 105 tests. This is amount handling,
not wallet execution, a balance aggregator, a budget lock or payment authorization.

Arc's September 10 compatibility guidance confirms native and ERC-20 USDC are two
precision views of one balance (18 versus 6 decimals), not separate deposits.
Transfer-amount conversion rejects precision loss rather than silently imitating
the truncated ERC-20 balance view. See [Arc's compatibility guide](https://www.arc.io/blog/arc-compatibility-guide-for-existing-evm-apps)
and [stablecoin model](https://docs.arc.io/arc/concepts/stablecoin-native-model).

1. Complete field-level shared DTOs, identifiers, exact money and digest contracts.
2. Add PostgreSQL tenant/auth/session storage and transactional outbox/worker foundations.
3. Add provider/catalog models and public/protected frontend shells.
4. Add scoped sessions, financial budgets, approvals and one-use grants.
5. Integrate one supported purchase lane, receipts, entitlements and recovery.
6. Build shared evidence/control-room, identity/reputation and reviewed job support.
7. Complete vault compatibility, full visual parity and Testnet hardening.

PostgreSQL will be durable commerce authority; Redis cannot authorize financial
release. External signers retain wallet custody. Expiry or silence cannot erase
uncertain payment exposure. Public, organization, provider-minimal, local and
ephemeral state remain separate. Existing vault formats are not silently migrated.

The human identity provider/recovery policy, exact payment connector and deployed
protocol contracts require explicit acceptance before their live gates. No mainnet
configuration, real-funds testing, paid provider upgrade or automatic deployment
is enabled by this change. Full DTO/state reconciliation and frontend porting are
not complete.

## Contribution and release policy

Completed, reviewed increments are pushed on scoped branches and merged only
after relevant checks pass. Unfinished local work is excluded. The public project
uses its designated OpenArc author/committer identity and does not import private
development history, personal paths, credentials or internal operational records.
