# PORT-02 marketplace wire contracts — component acceptance

September12,2026. Additive over listing432aa17. All implementation/tests by
OpenCode Go opencode-go/deepseek-v4.1-flash, reviewed by the lead.

Strict request/response contracts cover public catalog/detail/provider metadata,
protected owner listing/history, immutable draft/version creation and safe
mutation receipts/status. Shared leaf schemas remain authoritative, with no
separate money/endpoint schema. Public and organization-protected data cannot be
interchanged. Version updates carry explicit expectedLatestVersion.

Review reproduced and closed three issues: nonempty final pages must allow a
null cursor; malformed history versions must fail validation without throwing
or unbounded numeric coercion; oversized version-resource input must stop before
splitting. Tests cover all three, retaining strict negative cases.

Final verification all exit0:47focused market tests;550shared tests total;
shared types/build, explicit test typechecking and ESLint. Evidence is the
market-contracts-TilYAf workspace/review-response.jsonl run completed September12.

These are wire contracts only, not implemented routes, production evidence or
complete PORT02. Public provider eligibility still requires an active publicly
eligible listing; a private provider's active status alone cannot authorize
publication. Purchases remain unavailable.
