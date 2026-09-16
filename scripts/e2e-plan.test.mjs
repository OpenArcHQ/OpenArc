import assert from "node:assert/strict";
import test from "node:test";

import { fullGateConfigs, fullPlan, plan, projectNames } from "./e2e-plan.mjs";

const configs = fullGateConfigs();
const ids = (files) => plan(files).suites.map((suite) => suite.config);

test("the plan derives its suite list from the root e2e gate", () => {
  assert.equal(configs.length, 18);
  assert.equal(configs[0], "playwright.config.ts");
  assert.ok(configs.includes("playwright.tenant.config.ts"), "pnpm e2e:tenant maps to its config");
  assert.equal(configs.at(-1), "playwright.supplied.config.ts");
});

test("documentation-only changes need no verification", () => {
  const result = plan(["docs/roadmap.md", "README.md", "post-harness/index.html"]);
  assert.equal(result.docsOnly, true);
  assert.equal(result.units, "none");
  assert.deepEqual(result.suites, []);
});

test("scoped web sources select only their journeys", () => {
  const tenant = ids(["apps/web/src/tenant/tenant.css"]);
  assert.ok(tenant.includes("playwright.tenant.config.ts"));
  assert.ok(!tenant.includes("playwright.supplied.config.ts"));
  assert.deepEqual(ids(["apps/web/src/supplied/brand.css"]), ["playwright.flag-off.config.ts", "playwright.supplied.config.ts"]);
});

test("a test file selects its own suite and nothing else", () => {
  assert.deepEqual(ids(["e2e-supplied/supplied.spec.ts"]), ["playwright.supplied.config.ts"]);
  assert.deepEqual(ids(["e2e-production/workspace-production.spec.ts"]), []);
});

test("a config change also selects configs that import it", () => {
  assert.deepEqual(ids(["playwright.investigations.config.ts"]), [
    "playwright.investigations.config.ts",
    "playwright.investigations.flag-off.config.ts",
  ]);
});

test("shared or unknown paths fall back to every journey", () => {
  for (const file of ["apps/web/src/App.tsx", "packages/shared/src/index.ts", "pnpm-lock.yaml", "something/new.txt"]) {
    const result = plan([file]);
    assert.equal(result.suites.length, configs.length, file);
    assert.ok(result.reasons.length > 0, file);
  }
});

test("workflow and guard edits stay in the static lane", () => {
  const result = plan([".github/workflows/source-checks.yml", "scripts/tenant-ci-wiring.test.mjs"]);
  assert.equal(result.docsOnly, false);
  assert.deepEqual(result.suites, []);
});

test("database and API changes open the PostgreSQL lane without browser suites", () => {
  const result = plan(["apps/api/src/server.ts", "packages/db/migrations/0019.sql"]);
  assert.equal(result.postgres, true);
  assert.equal(result.units, "affected");
  assert.deepEqual(result.suites, []);
});

test("the fast lane drops WebKit projects but keeps flag-off Chromium projects", () => {
  assert.deepEqual(plan(["e2e-tenant/tenant-shell.spec.ts"]).suites[0].projects, ["chromium-tenant", "chromium-tenant-off"]);
  assert.deepEqual(projectNames("playwright.investigations.flag-off.config.ts"), ["chromium-investigations", "webkit-investigations"]);
  for (const suite of plan(["apps/web/src/App.tsx"]).suites) {
    assert.ok(suite.projects.every((name) => !/webkit/iu.test(name)), suite.config);
  }
});

test("the full lane runs every suite with WebKit, all units and PostgreSQL", () => {
  const result = fullPlan();
  assert.equal(result.suites.length, configs.length);
  assert.equal(result.units, "all");
  assert.equal(result.postgres, true);
  assert.ok(result.suites.some((suite) => suite.projects.some((name) => /webkit/iu.test(name))));
});
