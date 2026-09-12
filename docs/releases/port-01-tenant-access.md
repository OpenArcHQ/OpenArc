# PORT-01 tenant access

Status: API and shared contracts accepted in the combined local release.
See [combined verification](port-01-tenant-combined.md) for the final scope and
test results; component counts below describe the original read-only slice.
Prepared September 12, 2026. This is not completion of the commerce port.

Protected cookie-authenticated organization list/context, agent list and provider
list now have four bounded GET endpoints under `/v1/operator/organizations` with
strict commerce v2 envelopes. Server-resolved tenant roles remain authoritative;
the API revalidates the same session after repository reads. Authentication and
tenant pools use distinct restricted database roles. Runtime readiness checks the
exact accepted schema. The new feature defaults off and needs account access.

Shared write-body, safe receipt and status contracts are also accepted. They do
not expose HTTP mutations or confer payment authority. Their consumers are a
subsequent PORT-01 implementation slice.

## Component evidence

Implementation and regression tests authored by exact DeepSeek V4.1 Flash through
OpenCode CLI. Astra reviewed integration/security contracts and closed all three
API findings: encoded canonical organization IDs, v2 parser errors, and actual
tenant-table lock expiry coverage. This is not an independent security audit.

- API: 336 unit/integration tests passed (299 prior plus 37 new).
- API real PostgreSQL: 16 passed (5 prior plus 11 new).
- Shared: 401 passed (370 prior plus 31 tenant-write contract tests).
- Relevant types, test types, lint and builds passed.
- Real PostgreSQL lock barrier observes a tenant repository query waiting after
  initial authorization, crosses database-clock session expiry, and confirms
  no tenant DTO or cookie delivery. A separate real revocation-after-read test
  covers final session validation.
- No prior DB migrations, auth proof adapters, browser account flow or Vault
  implementation changed in this API/shared increment.

No real browser/nginx tenant acceptance, deployment or live account activation is
claimed by these component results. Final combined gate and publication follow
the reviewed tenant durability and frontend integration. Existing staging still
serves its previously verified supplied frontend with account enrollment off.
