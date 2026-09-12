# PORT-02 HTTP and public UI component evidence

September 12, 2026. Implementation and tests were authored through OpenCode Go
using `opencode-go/deepseek-v4.1-flash`; integration and review were separate.

## Implemented

- Six protected draft/version/history/status endpoints, strict transport and
  complete output validation, current-account checks, and durable-write handling.
- Twelve lifecycle, moderation and public catalog route contracts and services.
  Moderator authority is separate from provider publication authority.
- Public market, listing and provider pages with isolated styles, plus public
  docs, status and information pages. No public account or wallet controller is
  mounted. Purchases remain explicitly unavailable.

## Component verification

The draft API passed 63 focused and 570 API unit tests plus type checking,
test type checking, lint and build. Review fixes cover complete output binding,
duplicate Cookie transport, bounded readiness, and startup resource cleanup.

Lifecycle/catalog HTTP passed 90 focused tests. The consistent combined draft
and lifecycle source passed 655 API unit tests before five final-read rejection
tests were added; those five passed in the final focused run. The addition did
not change implementation. Final-read session rejection publishes no protected
DTO and performs no retry.

The public UI passed 47 focused tests, 368 web unit tests and 13 development
browser cases, plus type checking, test type checking, lint and build. Desktop
catalog and listing screenshots were visually inspected. Browser cases use
clearly labelled synthetic HTTP fixtures, including mobile/reduced-motion,
private-data canaries, disabled flags, static docs and capability-only status.
Review corrected info-page flag coupling, stalled body deadlines and interior
empty route segments. Browser configurations must run sequentially because
their isolated development-server port ranges overlap.

## Acceptance boundary

This is component evidence, not full PORT-02 acceptance. The final schema7
readiness correction, real API/PostgreSQL role tests, lifecycle runtime wiring,
reverse proxy, protected listing editor, full integrated release gate and actual
production-image browser journeys remain separate. The API role tests retain
required successful provider-admin/developer writes; an earlier permission
failure is not accepted as expected behavior. No hosted account enrollment,
payment lane, new service or recurring spend was enabled by this component.
