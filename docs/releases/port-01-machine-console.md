# PORT-01 machine credential console

Component accepted September 12, 2026. Implementation and tests authored with
OpenCode Go `opencode-go/deepseek-v4.1-flash`; five material review findings were
corrected and their closure independently reviewed. This is not whole-port or
hosted deployment acceptance.

The explicitly enabled organization console supports agent/provider credential
issuance, one-time in-memory display, metadata lists, revocation and explicit
status recovery. Agent/provider machine session routes are never browser-proxied.
The feature and all parent flags default off. Human sign-in does not grant
payment authority, and these credentials do not authorize purchases.

Final component verification: 46 focused tests, 321 web unit tests, 22 mocked
machine browser tests, 48 existing tenant-read browser tests, 35 tenant-write
browser tests and 62 deployment guards passed. Web types, test types, lint and
build passed. The five corrected issues cover exact profile binding, role-change
invalidation, after-send abort uncertainty, secret accessibility boundaries and
explicit dismissal before reissuance. No retry is inferred from an uncertain
write result.

The candidate was tested against the accepted machine wire contracts. Actual
HTTPS/nginx/API/PostgreSQL browser acceptance, the combined release gate and
publication are separate pending gates. Component browser results use labelled
mocked HTTP responses and are not evidence of real credential exchange.
