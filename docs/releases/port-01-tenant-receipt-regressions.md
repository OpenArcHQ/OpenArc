# Tenant management receipt regressions

September 12, 2026. DeepSeek V4.1 Flash on OpenCode implemented and tested
the fixes; lead review accepted the resulting five source/test files.

Real production-browser testing found that a successful first organization
creation and a successful self-demotion could hide their committed receipts
when the surrounding view changed. Receipt-only views now preserve that
confirmation without retaining mutation forms or permitting another write.
Self-demotion still revokes the session and requires a new sign-in.

A synchronous render guard also suppresses both the prior mutation state and
write controller when the authenticated account changes. Seven pure unit tests
cover that guard; they are not a claim of a naturally triggered account-switch
browser journey. Same-account and self-demotion confirmation remain visible.

Final component checks passed: 45 focused unit tests, 35 Chromium/WebKit write
browser cases, typecheck, test-file typecheck, lint and web build. Earlier
unchanged component coverage includes 48 tenant-read browser cases and 48
deployment guards. Actual HTTPS/nginx/API/PostgreSQL retesting is pending a
fresh production web image. Neither the combined release gate nor deployment
of these fixes is claimed here.
