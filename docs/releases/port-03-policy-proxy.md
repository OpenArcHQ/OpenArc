# PORT-03 policy proxy acceptance checkpoint

September 12, 2026. Exact OpenCode `opencode-go/deepseek-v4.1-flash` authored
the default-off policy proxy and its deployment guards. Independent source
review passed. Nineteen focused guards and 153 combined deployment/CI guards
passed; focused lint and shared build passed (all exit 0).

The ten policy routes retain bounded methods, headers, body and encoded-path
handling. The two mixed GET/POST parents enforce 16 KiB before internal POST
dispatch while GET remains bodyless. Policy-only proxy installation does not
depend on unrelated tenant/machine/market flags. Credentialless capability and
deny-only fallbacks are installed without exposing business routes when off.

The source gate timeout increases from 25 to 40 minutes because the preceding
verified gate took 24m14s. Three existing exact timeout assertions were aligned
with that deliberate change; no assertions or gates were removed.

This records static/source acceptance only. Actual combined-source nginx image,
API/PostgreSQL and production-browser checks are pending, as is the full control
phase. No deployment or financial enforcement is established by these checks.
