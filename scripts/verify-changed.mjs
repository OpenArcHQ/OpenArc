#!/usr/bin/env node
/**
 * Local fast lane: verify only what the current change can affect.
 *
 *   pnpm verify:changed                 # against origin/main
 *   pnpm verify:changed -- --base HEAD~3
 *   pnpm verify:changed -- --dry-run    # print the plan and commands only
 *
 * Runs lint, typecheck and the deployment/wiring guards, then unit tests for
 * affected workspaces, then the affected browser suites on Chromium. It is a
 * pre-push check, not a release gate: WebKit, production images and the
 * PostgreSQL lane stay in `pnpm release:gate` and the full CI lane.
 */
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";

import { changedFiles, plan } from "./e2e-plan.mjs";

const argv = process.argv.slice(2);
const baseIndex = argv.indexOf("--base");
const base = baseIndex === -1 ? "origin/main" : argv[baseIndex + 1];
const dryRun = argv.includes("--dry-run");

const files = changedFiles(base);
const result = plan(files);
const guards = readdirSync("scripts")
  .filter((name) => name.endsWith(".test.mjs"))
  .map((name) => `scripts/${name}`);

const steps = [];
if (result.docsOnly) {
  console.log(`${files.length} changed file(s), all documentation: nothing to verify.`);
} else {
  steps.push(["pnpm", ["lint"]], ["pnpm", ["typecheck"]], ["node", ["--test", ...guards]]);
  if (result.units !== "none") {
    steps.push(["pnpm", ["--filter", "@openarc/shared", "--filter", "@openarc/db", "--filter", "@openarc/x402", "build"]]);
    steps.push(
      result.units === "all"
        ? ["pnpm", ["-r", "--if-present", "test", "--maxWorkers=2"]]
        : ["pnpm", ["--filter", `...[${base}]`, "--filter", "!openarc", "--if-present", "test", "--maxWorkers=2"]],
    );
  } else if (result.suites.length > 0) {
    steps.push(["pnpm", ["--filter", "@openarc/shared", "--filter", "@openarc/db", "--filter", "@openarc/x402", "build"]]);
  }
  for (const suite of result.suites) {
    steps.push(["pnpm", ["exec", "playwright", "test", ...suite.args.split(" ")]]);
  }
  if (result.postgres) {
    console.log("Note: this change touches the database/API lane. Run the PostgreSQL suites or the full CI lane before release.");
  }
}

for (const [command, args] of steps) {
  console.log(`\n$ ${command} ${args.join(" ")}`);
  if (dryRun) continue;
  const run = spawnSync(command, args, { stdio: "inherit" });
  if (run.status !== 0) process.exit(run.status ?? 1);
}
console.log(dryRun ? "\n(dry run)" : `\nverify:changed passed (${result.suites.length} browser suite(s), units: ${result.units}).`);
