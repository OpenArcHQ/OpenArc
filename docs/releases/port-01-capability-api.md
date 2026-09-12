# PORT-01 public capability API

Component accepted September 12, 2026. OpenCode Go
`opencode-go/deepseek-v4.1-flash` authored the three-file API packet. Final
verification passed: 19 focused tests, 492 API unit tests, source/test types,
lint and build. The legacy private capability API is unchanged.

`GET /v2/public/capabilities` returns the strict five-family, 41-route versioned
manifest without account data. Own flags off report built-disabled; enabled
families require their actual configured dependencies. Readiness callbacks share
one underlying in-flight batch. Each response has a two-second deadline and an
immutable snapshot: one hung dependency cannot demote independently ready
families or mutate an earlier response. There is no success cache, background
probe, extra pool, provider request or claim of worker-process health.

The route rejects credentials, cross-origin requests, unsupported methods,
query/body data and duplicate critical headers using fixed v2 errors. The
manifest is advisory public metadata, never a grant of authority. It describes
implemented Testnet identity/tenant/machine access only, not future marketplace,
budget, payment or mainnet functionality.

Production proxy reachability, the combined PostgreSQL/release gate and public
publication remain separate acceptance steps. These unit results do not prove a
hosted deployment or completion of the whole port.

Production compatibility follow-up: the standard credentialless Node fetch
negotiation header Accept-Language is accepted without being echoed or used.
The focused suite now has 20 passing tests; source/test types, lint and build
passed. The previous full 492-test API result predates this narrow change; the
final combined gate must include its additional regression.

The two API-enabled nginx templates now expose only the exact public GET with
explicit request-header allowlisting, upstream TLS verification, no retries,
no credential forwarding and no Set-Cookie/CORS response forwarding. Legitimate
Railway forwarding headers are stripped rather than trusted or rejected. The
plain API-off template returns 404 at this exact path. Static verification passed
75 deployment guards (including 13 new capability guards) and 40 CI-wiring
guards. Actual-image reachability remains a separate check. The public workflow
includes the new guard; its export is managed separately from private history.
