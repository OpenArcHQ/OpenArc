# Marketplace capability contract

September 12, 2026. Component acceptance only; PORT-02 is not yet complete.

The marketplace has a separate versioned capability contract with three
families and 18 fixed routes. The existing commerce contract remains five
families and 41 routes. Availability is not authorization or payment authority.

The new contract covers public catalog reads, protected listing management and
independent moderation. Catalog availability does not depend on accounts;
listing management does not depend on the unrelated tenant-write feature flag.
All families can remain built-but-disabled. This pure contract is not exposed
by an HTTP handler until its underlying routes are implemented and verified.

Implementation: DeepSeek V4.1 Flash through OpenCode Go. The lead reviewed the
bounded handoff and an independent read-only review found no actionable issues.

Checks on the source copied into this commit:

- Focused contract suite: 25 passed, including all 256 boolean combinations.
- Complete shared suite: 611 passed.
- Source and test TypeScript checks, lint and build: passed.
- Existing commerce registry unchanged; only an additive shared export.

An initial test-only TypeScript indexing error was corrected and the focused
suite rerun successfully. No database, application handler, frontend flag,
deployment, account enrollment or payment capability is enabled by this commit.
