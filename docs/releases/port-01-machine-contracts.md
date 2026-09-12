# PORT-01 — machine credential and session wire contracts

September 12, 2026. Component accepted; not HTTP or browser acceptance.

Strict, browser-safe DTOs now distinguish human credential management, one-time
credential delivery, safe replay/status, machine session exchange and self-read.
Agent/provider namespaces and Testnet self-read scopes cannot be interchanged.
Existing identity and tenant-write contracts remain unchanged; the new receipt
union cannot carry a raw credential on replay, status or revocation.

DeepSeek V4.1 Flash on OpenCode authored the schemas and tests. Review corrected
independent lookup-versus-credential ID handling, empty-page namespace validation
and reuse of existing profile-ID grammar. Final checks passed:46 focused and447
total shared tests, types, test types, lint and build. Distinct lookup/credential
IDs, both principal kinds, strict private-field rejection, canonical encoding,
lifetime bounds and one-time response variants are covered.

These parsers do not authorize a caller, verify a password hash, access storage,
read a clock or enable routes. The HTTP/runtime layer remains a separate gate.
