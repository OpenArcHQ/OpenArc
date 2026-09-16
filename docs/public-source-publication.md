# Public source publication

This repository is a curated export of OpenArc's development history. Commit
dates are real; every commit is authored and committed by OpenArc. Private
branches, tags, deployment records, handoff notes and Actions history are not
included.

## Licence

The source is available under the PolyForm Noncommercial License 1.0.0
([LICENSE.md](../LICENSE.md)). Package metadata stays `UNLICENSED` so no
workspace package is published to a registry by accident. Third-party
dependencies keep their own licences; bundled fonts ship with their SIL Open
Font License files under `assets/fonts`.

## Checks

- **Fast checks** (`fast-checks.yml`) verify only what a change can affect:
  static checks, affected unit tests and the affected browser journeys on
  Chromium, in parallel. See [ci-lanes.md](engineering/ci-lanes.md).
- **Public source checks** (`source-checks.yml`) run the full Node 22 Docker
  source gate once per release batch: release-contract checks, dependency
  audit, licence policy, lint, typecheck, unit and integration tests, builds,
  every development browser journey and the PostgreSQL suites.

The private release workflow is kept at
[release-gates.reference.yml](engineering/release-gates.reference.yml) as a
structural reference. It is not installed here; its historical-reader jobs
need private release objects that are not distributed. The release checker
inspects that file, which does not prove its jobs ran in public CI. Neither
public workflow is a production-image, deployed-service or mainnet result.

## Identity boundary

Public commits must use OpenArc as both author and committer with the project
alias. Personal co-author trailers are rejected; the only accepted trailer is
the assistant attribution `Co-Authored-By: Claude … <noreply@anthropic.com>`. Run
`node scripts/check-public-history.mjs` before pushing; the public workflows
check it too. Branded commit metadata is not account anonymity: the account
that pushes can still be visible in activity.
