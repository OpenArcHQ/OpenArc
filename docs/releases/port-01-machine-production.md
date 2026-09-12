# PORT-01 machine production acceptance

September 12, 2026. Implementation and fixtures authored with OpenCode Go
`opencode-go/deepseek-v4.1-flash`. This record concerns the account/tenant/machine
foundation, not the whole commerce port, payment authority or a hosted rollout.

The fixture uses real production nginx, API and PostgreSQL images in isolated
loopback namespaces, synthetic TLS, disposable accounts created through visible
passkey UI and restricted database roles. It never touches a personal wallet,
real funds or a live account database. Machine sessions are exercised separately
from browser transport. Recovery-session metadata conversion is explicitly
synthetic, not evidence of cryptographic recovery.

Focused actual-image journeys cover role boundaries, agent/provider issuance and
revocation, short-lived exchange/self access, expiry, fresh-proof restrictions,
recovery refusal, safe lost-response status recovery without resubmission,
credential list reads, proxy rejection and 320px keyboard/mobile interaction.
Database commit is independently confirmed before deliberately dropping an issue
response. Replays/status/list reads never recover the raw credential.

Production testing found a lifecycle privacy defect: controller memory cleared
on pagehide while React deferred erasing the rendered credential. The fix commits
the pagehide and hidden-visibility state clearing synchronously. Four focused
Chromium/WebKit regressions pass; they inspect fresh-secret disappearance and
raw DOM/value absence in the same event-dispatch task. Types, test types and lint
pass. The actual-production assertion is retained unchanged.

Final rebuilt-image 14-case enabled acceptance, disabled-image acceptance, the
combined source gate and publication remain pending at this source checkpoint.
Earlier focused passing runs are not substituted for those final checks.
