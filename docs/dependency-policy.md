# OpenArc dependency and image policy

Status: **Milestone 00 baseline**  
Reviewed: **2026-09-01**

- Production dependencies must use permissive licenses compatible with the
  intended distribution. AGPL, GPL, SSPL, BUSL, Commons Clause, and Elastic
  License families fail the automated policy check pending an explicit legal
  review.
- `pnpm audit --prod --audit-level high` must pass for a candidate.
- API production images contain the pruned `@openarc/api` dependency closure;
  web production images contain only Nginx and compiled static assets.
- CI scans both images for high and critical vulnerabilities with Trivy and
  generates CycloneDX JSON SBOMs with Syft.
- No provider SDK, signing library, wallet SDK, database client, or mainnet
  configuration belongs in Milestone 00.

An automated license result is inventory and policy enforcement, not legal
advice. Final distribution still requires review of direct licenses, notices,
brand use, and the supplied logo rights.
