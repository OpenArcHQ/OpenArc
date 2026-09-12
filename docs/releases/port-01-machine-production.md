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

## Final actual-image result

The rebuilt source candidate `deeef7901d4f0d8ee6719bae5bfce485aac13f3e` passed
all **14 enabled production cases** in one 45-second run and the **1 disabled
production case** in a separate 3.1-second run. Both nginx configurations passed
syntax validation. API source remains `17f817071b17fb47afbab49d2590f0693841bb9d`;
the later change affects web lifecycle erasure and fixtures only. Schema5 remains
unchanged. No API or database was reset underneath the browser suite.

Verified web image digests:

- Enabled: `sha256:d168313aa71b304b435ec0b2087fd2c30814ce2048e629627c28f029ffb94bdb`.
- Disabled: `sha256:4b6fcdfd915844ef31498a85b15800eec8d313d86f561061651c5c9beb2dffc7`.

These are local isolated production-image results, not a Railway deployment,
mainnet payment test, real-device passkey certification or whole-port completion.
The combined source gate and publication are recorded separately.
