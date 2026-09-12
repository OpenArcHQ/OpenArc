import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

/**
 * Static wiring guards for the tenant CI packet.
 *
 * These assertions read only the root package.json. They prove the two tenant
 * aliases exist verbatim, that the tenant journey runs in the root e2e gate
 * exactly once immediately before the supplied journey that still ends it, and
 * that the release gate still runs both e2e and the existing security steps.
 * They do not exercise a browser, a database or the release workflow itself.
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scripts = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")).scripts;

const TENANT_ALIAS = "playwright test -c playwright.tenant.config.ts";
const TENANT_PRODUCTION_ALIAS = "playwright test -c playwright.tenant.production.config.ts";
const SUPPLIED = "playwright test -c playwright.supplied.config.ts";

/** Every development journey the root e2e gate ran before the tenant packet. */
const ORIGINAL_JOURNEYS = [
  "playwright test",
  "playwright test -c playwright.flag-off.config.ts",
  "playwright test -c playwright.api-boundary.config.ts",
  "playwright test -c playwright.arc-observation.config.ts",
  "playwright test -c playwright.agent-registry.config.ts",
  "playwright test -c playwright.job-evidence.config.ts",
  "playwright test -c playwright.gateway-evidence.config.ts",
  "playwright test -c playwright.local-agent-import.config.ts",
  "playwright test -c playwright.investigations.config.ts",
  "playwright test -c playwright.investigations.flag-off.config.ts",
  "playwright test -c playwright.supplied.config.ts",
];

test("tenant aliases run the exact frozen Playwright configs", () => {
  assert.equal(scripts["e2e:tenant"], TENANT_ALIAS);
  assert.equal(scripts["e2e:tenant:production"], TENANT_PRODUCTION_ALIAS);
});

test("e2e gate includes the tenant journey exactly once", () => {
  const e2e = scripts["e2e"];
  assert.equal(typeof e2e, "string");
  const occurrences = e2e.split("pnpm e2e:tenant").length - 1;
  assert.equal(occurrences, 1, "root e2e must invoke pnpm e2e:tenant exactly once");
});

test("e2e gate keeps every original journey with the supplied ending last", () => {
  const e2e = scripts["e2e"];
  for (const journey of ORIGINAL_JOURNEYS) {
    assert.ok(e2e.includes(journey), `root e2e must keep the journey: ${journey}`);
  }
  assert.ok(
    e2e.includes(`pnpm e2e:tenant && ${SUPPLIED}`),
    "the tenant journey must run immediately before the supplied journey",
  );
  assert.ok(e2e.endsWith(SUPPLIED), "the supplied journey must remain the final step");
});

test("release gate still runs e2e and the existing security steps", () => {
  const releaseGate = scripts["release:gate"];
  assert.equal(typeof releaseGate, "string");
  for (const step of ["release:check", "audit:prod", "licenses:check", "lint", "typecheck"]) {
    assert.ok(releaseGate.includes(`pnpm ${step}`), `release gate must keep: pnpm ${step}`);
  }
  assert.ok(releaseGate.includes("pnpm e2e"), "release gate must still run the root e2e gate");
});

test("release gate does not run the tenant production alias", () => {
  assert.ok(
    !scripts["release:gate"].includes("e2e:tenant:production"),
    "the production tenant alias needs a real external fixture and must stay out of the release gate",
  );
});
