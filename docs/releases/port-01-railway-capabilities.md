# PORT-01 Railway capability ingress correction

September 12, 2026. Narrow follow-up to public foundation source `4d022a1`.
This report does not claim completion of PORT-02 or the whole commerce port.

## Reproduction and change

Both existing Railway services deployed `4d022a1` successfully. Live HTML build
metadata and API health/readiness identified that exact source and returned 200.
Hosted account enrollment remained disabled (`/v2/auth/session` returned 404).
However, credentialless `/v2/public/capabilities` returned a fixed API 400.

The web proxy strips incoming metadata, but its public HTTPS API upstream passes
through a second Railway edge, which inserts new routing headers after stripping.
The API's strict header allowlist rejected those informational names. Railway's
[request-header specification](https://docs.railway.com/networking/public-networking/specs-and-limits)
documents six of them. The correction ignores those exact six names plus the two
standard forwarding names; it does not use their values for identity, request IDs,
Origin, routing, authorization, readiness, storage, or response content.

The existing credential/CSRF/idempotency rejection, Origin/Fetch-Site checks,
unknown-client rejection, duplicate critical-header checks, bounded request shape,
no-cookie/no-CORS behavior, fixed five-family manifest, and default-off flags remain.
No authentication, SQL, provider, payment, frontend, or deployment-setting change.

## Component evidence

Implementation and tests: OpenCode CLI `opencode-go/deepseek-v4.1-flash`.
Two source/test files changed. Existing 20 capability tests retained.

- Regression before the fix: 4 failed, 22 passed; reproduced second-edge rejection.
- Regression after the fix: all 26 capability tests passed.
- API unit suite: 507 tests passed in 28 files.
- API types, strict test types, lint and build: exit 0.
- Source diff reviewed: only fixed ignored-name set plus the allowlist branch;
  spoofed metadata does not authorize requests or get reflected by the API.

Combined public CI and post-fix live verification are separate pending gates at
the time of this source commit. No new hosted service or paid feature is enabled.
