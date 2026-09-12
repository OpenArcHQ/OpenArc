# PORT-01 capability contracts

September 12, 2026. Component-accepted pure shared contract, not yet an exposed
API endpoint or completion of the capability integration.

DeepSeek V4.1 Flash on OpenCode implemented the strict five-family manifest and
fixed41 principal route/method descriptors. Lead review checked the complete
registry against the actual auth, tenant and machine route templates, including
the organization-bootstrap status route's distinct nesting. Legacy m04–m07
capability schemas and their private endpoint remain unchanged.

The new contract distinguishes enabled, built-disabled and unavailable features;
current implemented families cannot report planned. Explicit flag and readiness
inputs determine availability, independently of caller authorization. Machine
sessions do not depend on the management/write toggle. No worker-health,
marketplace, payment or settlement capability is implied.

All23 new tests and470 total shared tests passed, plus typecheck, test-file
typecheck, lint and build. Pure tests cover all256 flag/readiness combinations,
complete strict route/family mapping, nested immutable registry data, rejected
extra/private fields and legacy compatibility. Runtime route parity, public
transport, frontend consumption and combined CI remain separate acceptance work.
