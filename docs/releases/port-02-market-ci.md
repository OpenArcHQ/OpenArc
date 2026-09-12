# PORT-02 marketplace CI component evidence

September 12, 2026. OpenCode Go `opencode-go/deepseek-v4.1-flash` added root
marketplace and listing browser aliases and a reference-contract test alias.
The release gate now runs the reference contract after build, then the existing
browser gate. Public marketplace and protected listing browser suites run
sequentially before the unchanged machine/tenant/supplied sequence.

The public source workflow adds marketplace deployment and wiring guards while
retaining its manual trigger, pinned dependencies, read-only permissions,
privacy/history checks and disposable PostgreSQL sequence. Its summary explicitly
distinguishes synthetic browser fixtures from real PostgreSQL and separate
production-image testing. No workflow or deployment was launched by this slice.

Eight new static wiring tests and all 34 combined marketplace/tenant/machine/
worker wiring guards passed. Application builds, new browser journeys, reference
fixtures and the final integrated release gate remain independently verified
steps; static wiring is not execution evidence. The workflow is based on the
accepted public source workflow; private historical commits must never be
exported to the public repository.
