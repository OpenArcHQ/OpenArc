# Commerce transition status

Updated September 11, 2026. Status: foundation in progress; not a commerce launch.

## Authoritative target

The three canonical engineering documents now describe the supplied marketplace,
control, proof and privacy product. Their exact source bytes are preserved:

| Document | SHA-256 |
| --- | --- |
| Engineering source of truth | `6192fd2a94b51bfd5cfeed86d8bbef787d2a4cc7ab9a57be6552cd37202fe711` |
| Backend architecture | `7c3d4b7b2ea939f683f084f02e8b233d5a92270c0bcfedcae51f7aeaca3a32f6` |
| Frontend architecture | `80710795f21226006ad734bf08bd7a2f12a5145b3df446f03b02b81436b0da61` |

Previous repository specifications are archived under `archive/pre-commerce/`.
They document the legacy investigation product, not completion of the new target.
Legacy release reports retain their historical scope regardless of milestone number.
Use **S-M00–S-M09** for supplied Testnet milestones and **PORT-*** for migration work.

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
