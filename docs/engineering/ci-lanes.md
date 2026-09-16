# CI lanes

Every push used to run the whole catalogue: 18 browser suites one after
another, each on Chromium and WebKit, inside one Docker build that reinstalled
everything from scratch. That took 29–39 minutes against a 40-minute timeout,
whatever the change was. Verification is now split into lanes.

| Lane | Where | When | What |
|---|---|---|---|
| Local fast | `pnpm verify:changed` | before every push | lint, typecheck, guards, affected unit tests, affected browser suites on Chromium |
| CI fast | `Fast checks` workflow (`fast-checks.yml`) | on demand for a pushed branch | the same plan, with each browser suite in its own parallel job, plus the PostgreSQL lane when database, API or account code changed |
| Full | `Public source checks` and the private `Release gates` | once per release batch, before tagging or exporting | everything: every suite on Chromium and WebKit, production images, scans |

## How the plan is chosen

`scripts/e2e-plan.mjs` reads the root `e2e` script, so its suite list cannot
drift from the full gate. It maps each changed file to the suites it can
affect:

- documentation, the post harness and design prototypes → nothing
- workflows, guard tests, nginx and Dockerfiles → the static checks only
- `apps/web/src/tenant`, `market`, `supplied`, `vault`, `evidence` → their own journeys
- an `e2e-*` directory or a Playwright config → that suite (and configs that import it)
- API, worker and database code → units plus the PostgreSQL lane
- the app shell, shared packages, the lockfile, root config or any unknown path → every suite

Unknown paths always widen the plan; nothing is skipped by default.

```
pnpm e2e:plan -- --base origin/main      # show the plan
pnpm verify:changed -- --dry-run         # show the commands
pnpm verify:changed                      # run them
```

## Rules

- Do not dispatch the full lane per push. Batch changes, then run it once.
- The fast lane is Chromium-only development evidence with synthetic fixtures.
  It never counts as release, production-image or mainnet evidence.
- A red full lane blocks the release; fix forward and re-run only the full lane.
