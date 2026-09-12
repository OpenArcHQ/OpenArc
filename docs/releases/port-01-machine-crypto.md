# PORT-01 — machine credential crypto primitive

September 12, 2026. Component-accepted only; not an authentication endpoint,
durable credential issuer, scoped session service or completed machine feature.

The API-local helper generates separate agent/provider namespace credentials
using32 random bytes and canonical UUIDv4 lookup identifiers. Records use a
versioned peppered HMAC prehash followed by asynchronous Node scrypt with fixed
parameters, random salts, bounded concurrency and timing-safe comparison. Key
material and lifecycle state are runtime-private. Disposal suppresses in-flight
results; operational errors stay distinct from a valid nonmatching credential.
Owned temporary buffers are cleared; JavaScript token strings cannot be promised
zeroized. No raw secret is logged or stored by this helper.

Exact OpenCode DeepSeek V4.1 Flash authored the two source/test files. Bounded
review corrected pepper/version mismatch, disposal, canonical parsing, error
normalization and buffer cleanup. The final three residual cases—generation
UUID length, RNG failure normalization and failed-decode buffer clearing—were
checked against the actual final source.49 focused tests, types, test types,
lint and build passed. Tests use real scrypt for both namespaces; explicit
mocked barriers cover only native errors/concurrency and cleanup observations.

The initial correction attempt ended at its output limit without implementing
the changes and is not acceptance evidence. Final evidence comes from the later
applied corrections and49-test run. No production algorithm requirement was
relaxed to satisfy tests. This is not a professional external cryptography audit.

Database authority, one-time display/replay behavior, expiry/revocation, scoped
session exchange, protected credential-management UI and rate limits remain
separate required work before exposing a machine credential endpoint.
