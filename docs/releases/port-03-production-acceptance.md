# PORT-03 whole-phase production-image acceptance

Run 2026-09-15 UTC against real images built from `86c21060d3e843a5dfa368ea78df6b206d0b0e64`:
the real API image, real nginx web images for the flags-ON and flags-OFF builds,
real PostgreSQL with migrations `0001`-`0014`, real passkeys in Chromium, and
headless agent and provider clients going through the real edge.

Suite: `e2e-commerce-production/` with `playwright.commerce.production.config.ts`,
mirroring the accepted session production acceptance. Host-resolver rules only,
a TLS exemption only for the loopback test origins, and traces, screenshots,
video and storageState all off, so no token can be captured. `maxFailures` is 0
so one failing journey cannot hide the others.

## Result

| Stack | Playwright project | Exit | Tests |
| --- | --- | --- | --- |
| ON | `chromium-commerce-production` | 0 | 6 passed |
| OFF | `chromium-commerce-production-off` | 0 | 1 passed |

Strict `tsc` and ESLint `--max-warnings=0` both exit 0 on the suite. A regex scan
found no raw token material in any log. **No journey failed on a product defect.**

The first ON run failed on a harness bug: the fixture gave the agent credential
a 900-second expiry, which the database correctly rejected as
`durable_expiry_invalid`. It was changed to the accepted 3600 seconds, and no
assertion was touched.

## Journeys

| # | Journey | Result |
| --- | --- | --- |
| 1 | Human console | PASS; approve and reject BLOCKED by P0D10 |
| 2 | Headless agent | PASS for exchange and reads; authorize, issue and replace BLOCKED by P0D10 |
| 3 | Provider | PASS for every denial and for recovery; two-token claim BLOCKED by P0D10 |
| 4 | Revoke after claim | PASS |
| 5 | Concurrent claim | BLOCKED at the edge; one winner proven on the fixture cores |
| 6 | Lost revoke response | PASS |
| 7 | Credential separation at the real edge | PASS |
| 8 | OFF stack | PASS |

**Human.** Passkey sign-up, session issue through the UI and exchange through
the edge all succeed. The action and approval queues list the seeded actions.
A cancel committed on the production path, with one row each written to
idempotency, audit and outbox. The exposure view and the API agree exactly:
committed 0, unresolved 1000000, total 1000000, available 9000000, deficit 0.

**Revoke after claim.** On a fixture-seeded claim, the revoke went through the
console on the production path. The console said the grant was "claimed before it
was revoked", that the "claim fact is retained", that it "may still have been
paid" and that this is "not a refund", with no refund wording anywhere. The
database kept the claim, the reservation stayed `claimed`, no release events were
written, and provider recovery reported `grantRevoked: true`.

**Lost revoke response.** The response was dropped only after the commit was
observed. The console showed "outcome is unknown", and "Check status once" sent
exactly one GET with the original mutation id and recovered the receipt. Exactly
one revoke POST was sent, and the idempotency, audit and outbox rows stayed at
one each.

**Credential separation.** nginx rejected all of these with 403, with no
Set-Cookie, no CORS headers and no SPA fallback:

- `oas_ag_` on all six agent action and grant routes
- a commerce bearer on all three provider routes
- a synthetic cookie and a real browser cookie on headless routes
- bearers on browser routes

The correct credential still returned 200 on each route, and no rows changed.

**OFF stack.** Both capability manifests report `built_disabled`. All 21 action
and grant routes return a 404 from nginx, and none returns 200 `text/html`. All
four console routes show "not available yet" and make zero business calls.

## Why the spending success paths are blocked (P0D10), and why that is correct

A successful authorize, approve, reject, issue, replace, introspect or claim
cannot run through the production path in schema 14. The production wrappers
reject `internal_fixture` requirement provenance (`P0D10`), and
`is_canonical_source_kind` currently accepts only `internal_fixture`. So there is
no requirement a production caller can spend against yet.

This is the designed boundary, not a defect: production must never mint spending
authority from test-only data. PORT-04 closes it by adding a reviewed, verified
requirement provenance source. Each blocked call returned 503 with **zero**
mutations, which the suite checked.

The success mechanics of those operations are proven elsewhere on
migrator-only fixture cores, in the same way as the DB10, DB12 and P03-06
adversarial suites. That includes the concurrent claim electing exactly one
winner, with the loser getting `P0D14`.

**Ran on the production path:** passkey sign-up, UI session issue and edge
exchange; every browser, agent and provider read, including exposure and both
mutation-status readers; action cancel, grant revoke and provider attempt
recovery; every separation probe; the whole OFF surface; and the refusals above.

**Set up through the real stores:** the buyer policy, agent and provider machine
sessions, and a reviewed, published seller listing.

**Fixture-seeded rows** (migrator-only cores, with no GUC, flag or bypass added):
requirement references, authorized actions, issued grants, claims and the
concurrent-claim drill.

## A UX observation, not a defect

When approve or reject hits P0D10, the API answers 503, and the console shows
"The outcome is unknown" rather than a clear refusal. This is safe: "Check status
once" correctly finds nothing committed. It follows the designed rule of treating
any 5xx on a write as unknown. It will stop appearing in normal use once PORT-04
supplies verified provenance. If the refusal needs to read clearly before then,
map `REQUIREMENT_UNAVAILABLE` to a distinct non-retryable response the console
can render as unavailable. Weigh that against the provenance-oracle concern
recorded in `port-03-action-http.md`.

## Provisioning

`e2e-commerce-production/provision-stack.mjs` builds three images, starts one
PostgreSQL instance and runs one app stack at a time (`build`, `db`,
`start on|off`, `test on|off`, `stop on`, `teardown`). The ON stack enables auth,
tenant reads, sessions, actions and grants, with a `TENANT_DATABASE_URL`
separate from the auth database. The OFF stack keeps sessions on and turns
actions and grants off in both the API and the web build.

Images built for this run:

- `api` `sha256:4d9afaff586447ee2c004b6feb5c75b32921f118f7e9af282db2f411f50a35b2`
- `web-on` `sha256:84908d16fbcd920f1472d38a08ebda325d7ca25d31a1bb4d17e772e8df5b309d`
- `web-off` `sha256:e06ded9a7e356c67dc7fac70c90457ec75191e6b9c9bc02ae6885aac125741d8`

Teardown removed all six containers, the data volume and all three images. The
synthetic TLS key was deleted.

## Acceptance decision

PORT-03 is **accepted** for everything the production path can reach: every
safety, separation, refusal, recovery and disabled-state property passed on the
real images. Successful spending through the production path is **not** claimed.
It is gated on PORT-04's verified requirement provenance.

Arc mainnet is not claimed, and remains externally blocked.
