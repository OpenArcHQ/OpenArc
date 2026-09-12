# PORT-02 marketplace lifecycle contracts

September 12, 2026. Component acceptance only; lifecycle HTTP/SQL, public catalog,
provider editor and the complete commerce port are not claimed implemented.

The shared contracts add strict review/publish/pause/retire request bodies, an
owner root-detail projection, and protected provider-picker pagination. Lifecycle
receipts permit version 1; the existing next-version creation receipt still
requires version 2 or later. Existing creation and idempotency bindings remain.

Concurrency binds the exact version-state timestamp and expected active pointer.
The subsequent repository must advance timestamps strictly monotonically. Publish
activates an existing reviewed version and atomically pauses the prior active
version; it does not edit content or manufacture a new version. Moderation is a
separate default-off authority, never inferred from a provider/organization role.
Review metadata does not prove safe DNS resolution, availability, fulfillment,
payment, or quality. Payment lanes remain unavailable.

Implementation: OpenCode CLI `opencode-go/deepseek-v4.1-flash`.

- Focused lifecycle schemas: 36 tests passed.
- Complete shared suite: 586 tests passed in 28 files.
- Shared typecheck, strict test types, lint and build: exit 0.
- Independent bounded review: no concrete defects; strictness, undefined/null,
  pagination, ID binding, receipt compatibility, exports and import cycles checked.

The only pre-existing schema change is adding four closed lifecycle receipt
branches to the marketplace mutation union. Existing tests and leaf schemas were
preserved. No network request, authorization check, SQL, API, UI or deployment
is implemented by these pure data contracts.
