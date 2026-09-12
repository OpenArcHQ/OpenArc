# PORT-01 — combined tenant access acceptance

September 12, 2026. Accepted locally for source publication. This is a verified
PORT-01 increment, not completion of the commerce port or live account launch.

## Included

Schema-four atomic tenant mutations, audit/outbox repositories, strict shared
contracts, protected organization/agent/provider reads, default-off durable write
HTTP routes, and the supplied-style read-only tenant console and bounded nginx
proxy. Account access remains passkey or wallet proof; neither authorizes payment.
Tenant-management forms, machine credentials and the worker process are separate
pending increments and are not included in this acceptance.

All application, test and CI changes were authored by
`opencode-go/deepseek-v4.1-flash` through OpenCode CLI. Astra planned, reviewed and
integrated the changes. Review is not an independent professional security audit.

## Exact verification boundary

The complete source gate used revision
`ef396656467a591bcc3e9d04a17780841e5a3499` and image
`sha256:34909b7609df424908d857167836a1c675a5f5969e3321bdfd2646fc4319b1c0`.

- Release structural checks, production dependency audit, license policy, lint,
  types and builds passed.
- 1,103 unit/integration tests passed: shared401, database108, web230, API364.
- 200 development-browser tests passed, including48 mocked tenant journeys.
- The same image passed34 deployment/CI guards,211 database PostgreSQL tests and
  26 API/PostgreSQL tests against a new isolated disposable database.
- The supplementary account browser suite initially passed26/27. The failed
  wallet-confirmation fixture derived its issue/expiry timestamps from separate
  clock reads, occasionally violating the deliberately exact five-minute policy.
  The unchanged focused test passed, then the fixture was corrected to one clock
  read. All27 account-browser tests, focused reproduction, lint and test types
  passed with that test-only delta. Production validation and assertions remain
  unchanged; no retry or timeout was added.
- A subsequent nonexported alphabet-variable rename (revision `a66a162`) leaves
  its public alphabet literal and behavior unchanged;401 shared tests, types and
  lint passed. These two deltas and evidence edits are explicitly distinguished
  from the frozen full-image gate; public CI runs on the final public candidate.

Separately, the actual production API/web images from application revision
`3f09d5f5ae2ff99401248ebd156395cee537f96a` passed19 enabled and1 disabled tenant
browser journeys with real virtual-authenticator passkey signup, HttpOnly
cookies, restricted PostgreSQL roles and nginx upstream TLS verification. This
is not HTTP-mocked or Vite evidence. See [production tenant acceptance](port-01-tenant-web.md).

## Publication and hosting

Source-only public export passed secret and public-history checks. Public CI and
merge are recorded separately after completion; no private Git ancestry is
exported. Commit authors and committers use the OpenArc project identity.

Existing Railway staging still serves `f9c3792` with account and tenant features
off. No hosted database, new service, paid resource, real-wallet action or
mainnet operation was enabled. Live enrollment and full PORT-01/PORT-02–09
acceptance remain outstanding.
