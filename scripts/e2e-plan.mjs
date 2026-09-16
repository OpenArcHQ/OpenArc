#!/usr/bin/env node
/**
 * Change-scoped verification plan for the fast CI lane and `pnpm verify:changed`.
 *
 * The root `e2e` script stays the single definition of the full browser gate;
 * this module derives its suite list from that script, so the two cannot
 * drift. Given the files changed since a base ref, it answers:
 *   - which browser suites can be affected (unknown paths select every suite),
 *   - whether the PostgreSQL lane is needed,
 *   - whether the change is docs-only.
 *
 * The fast lane runs Chromium projects only. WebKit and every production-image
 * check remain in the full gate (`pnpm release:gate`, the `full` lane).
 *
 * Usage:
 *   node scripts/e2e-plan.mjs --base origin/main          # human summary
 *   node scripts/e2e-plan.mjs --base origin/main --json   # machine output
 *   node scripts/e2e-plan.mjs --files a.ts,b.css --json   # explicit file list
 *   node scripts/e2e-plan.mjs --full                      # full lane (JSON), both browsers
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (file) => readFileSync(path.join(ROOT, file), "utf8");

/** Every Playwright config the root `e2e` gate runs, in order. */
export function fullGateConfigs(e2eScript = JSON.parse(read("package.json")).scripts.e2e) {
  const configs = [];
  for (const step of e2eScript.split("&&").map((part) => part.trim())) {
    const direct = step.match(/^playwright test(?: -c (\S+))?$/u);
    if (direct) configs.push(direct[1] ?? "playwright.config.ts");
    else if (step === "pnpm e2e:tenant") configs.push("playwright.tenant.config.ts");
  }
  return configs;
}

/** Project names declared by a config, following a `base` import when it has none. */
export function projectNames(config) {
  const source = read(config);
  const names = [...source.matchAll(/name:\s*"([^"]+)"/gu)].map((match) => match[1]);
  if (names.length > 0) return names;
  const base = source.match(/import base from "\.\/([^"]+)\.js"/u);
  return base ? projectNames(`${base[1]}.ts`) : [];
}

function testDir(config) {
  const own = read(config).match(/testDir:\s*"\.\/([^"]+)"/u);
  if (own) return own[1];
  const base = read(config).match(/import base from "\.\/([^"]+)\.js"/u);
  return base ? testDir(`${base[1]}.ts`) : null;
}

const SUITE = {
  root: "playwright.config.ts",
  flagOff: "playwright.flag-off.config.ts",
  apiBoundary: "playwright.api-boundary.config.ts",
  arc: "playwright.arc-observation.config.ts",
  registry: "playwright.agent-registry.config.ts",
  jobs: "playwright.job-evidence.config.ts",
  gateway: "playwright.gateway-evidence.config.ts",
  agentImport: "playwright.local-agent-import.config.ts",
  investigations: "playwright.investigations.config.ts",
  investigationsOff: "playwright.investigations.flag-off.config.ts",
  policy: "playwright.policy-management.config.ts",
  sessions: "playwright.commerce-sessions.config.ts",
  market: "playwright.market-public.config.ts",
  listings: "playwright.listing-management.config.ts",
  machine: "playwright.machine-management.config.ts",
  tenantWrite: "playwright.tenant-write.config.ts",
  tenant: "playwright.tenant.config.ts",
  supplied: "playwright.supplied.config.ts",
};

const WORKSPACE_SUITES = [
  SUITE.root, SUITE.flagOff, SUITE.apiBoundary, SUITE.arc, SUITE.registry, SUITE.jobs,
  SUITE.gateway, SUITE.agentImport, SUITE.investigations, SUITE.investigationsOff,
];
const TENANT_SUITES = [
  SUITE.policy, SUITE.sessions, SUITE.listings, SUITE.machine, SUITE.tenantWrite, SUITE.tenant,
  SUITE.flagOff,
];

/** Paths that can never change runtime behaviour or a test result. */
const DOCS_ONLY = [
  /^docs\//u, /\.md$/u, /^post-harness\//u, /^design-prototype\//u, /^LICENSE/u, /^\.claude\//u,
];

/** Paths checked by the static lane only (lint, typecheck, guards, units). */
const STATIC_ONLY = [
  /^scripts\/.*\.test\.mjs$/u, /^scripts\/(release-check|check-licenses|check-public-history|e2e-plan|verify-changed)\.mjs$/u,
  /^\.github\//u, /^eslint\.config\.mjs$/u, /^apps\/web\/nginx[^/]*$/u, /^apps\/web\/[a-z_]+_params$/u,
  /^apps\/web\/(Dockerfile|railway\.json|validate-m04-runtime-env\.sh|market_response_headers)$/u,
  /^apps\/(api|worker)\/(Dockerfile|railway\.json)$/u, /^tools\//u, /\.test\.ts$/u, /^apps\/web\/test\//u,
];

/** Paths that feed the PostgreSQL / real-API lane. */
const POSTGRES = [
  /^packages\/(db|shared|x402)\//u, /^apps\/(api|worker)\//u, /^apps\/web\/src\/account\//u,
  /^e2e-account\//u, /^playwright\.account\.config\.ts$/u,
];

/** Browser suites selected by a source path; `null` means "not a web source path". */
function suitesForWebSource(file) {
  if (/^apps\/web\/src\/tenant\//u.test(file)) return TENANT_SUITES;
  if (/^apps\/web\/src\/market\//u.test(file)) return [SUITE.market, SUITE.listings];
  if (/^apps\/web\/src\/supplied\//u.test(file)) return [SUITE.supplied, SUITE.flagOff];
  if (/^apps\/web\/src\/account\//u.test(file)) return [SUITE.tenant, SUITE.tenantWrite, SUITE.machine];
  if (/^apps\/web\/src\/(vault|evidence)\//u.test(file)) return WORKSPACE_SUITES;
  return null;
}

/** Everything: every suite with every project, all units, the PostgreSQL lane. */
export function fullPlan(configs = fullGateConfigs()) {
  return {
    docsOnly: false,
    postgres: true,
    units: "all",
    reasons: ["full lane"],
    suites: configs.map((config) => {
      const projects = projectNames(config);
      return {
        config,
        id: config === "playwright.config.ts" ? "root" : config.replace(/^playwright\./u, "").replace(/\.config\.ts$/u, ""),
        projects,
        args: ["-c", config, ...projects.flatMap((name) => ["--project", name])].join(" "),
      };
    }),
  };
}

export function plan(files, configs = fullGateConfigs()) {
  const suites = new Set();
  let postgres = false;
  let docsOnly = true;
  // Unit tests: "affected" runs changed workspaces and their dependents
  // (`pnpm --filter "...[base]"`); root-level changes need every workspace.
  let units = "none";
  const reasons = [];
  const all = (why) => {
    for (const config of configs) suites.add(config);
    reasons.push(why);
  };

  for (const file of files) {
    if (DOCS_ONLY.some((pattern) => pattern.test(file))) continue;
    docsOnly = false;
    if (/^(apps|packages|tools)\//u.test(file)) {
      if (units === "none") units = "affected";
    } else if (!/^(scripts|\.github|e2e[^/]*|assets)\//u.test(file) && !/^playwright\.[^/]*config\.ts$/u.test(file)) {
      units = "all";
    }
    if (POSTGRES.some((pattern) => pattern.test(file))) postgres = true;
    if (STATIC_ONLY.some((pattern) => pattern.test(file))) continue;

    // Test directories and configs map to their own suites. Suites outside the
    // development gate (production, account, payment) belong to other lanes.
    const e2eDir = file.match(/^(e2e[^/]*)\//u)?.[1];
    if (e2eDir) {
      configs.filter((config) => testDir(config) === e2eDir).forEach((config) => suites.add(config));
      continue;
    }
    if (/^playwright\.[^/]*config\.ts$/u.test(file)) {
      const stem = file.replace(/\.ts$/u, "");
      configs
        .filter((config) => config === file || read(config).includes(`./${stem}.js`))
        .forEach((config) => suites.add(config));
      continue;
    }
    const scoped = suitesForWebSource(file);
    if (scoped) {
      scoped.forEach((config) => suites.add(config));
      continue;
    }
    if (/^apps\/(api|worker)\//u.test(file) || /^packages\/(db|x402)\//u.test(file)) continue;
    if (/^assets\/(brand|fonts)\//u.test(file)) {
      [SUITE.supplied, SUITE.tenant].forEach((config) => suites.add(config));
      continue;
    }
    // App shell, shared packages, lockfile, root config or anything unknown:
    // every browser journey can be affected.
    all(`shared or unknown path ${file}`);
  }

  const ordered = configs.filter((config) => suites.has(config));
  return {
    docsOnly,
    postgres,
    units,
    reasons: [...new Set(reasons)],
    suites: ordered.map((config) => {
      // Fast lane: every non-WebKit project; an empty list means "the config's default project".
      const projects = projectNames(config).filter((name) => !/webkit/iu.test(name));
      return {
        config,
        id: config === "playwright.config.ts" ? "root" : config.replace(/^playwright\./u, "").replace(/\.config\.ts$/u, ""),
        projects,
        args: ["-c", config, ...projects.flatMap((name) => ["--project", name])].join(" "),
      };
    }),
  };
}

export function changedFiles(base) {
  const range = `${execFileSync("git", ["merge-base", base, "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim()}...HEAD`;
  const committed = execFileSync("git", ["diff", "--name-only", range], { cwd: ROOT, encoding: "utf8" });
  const working = execFileSync("git", ["status", "--porcelain", "--untracked-files=all"], { cwd: ROOT, encoding: "utf8" })
    .split("\n")
    .filter(Boolean)
    .map((line) => line.slice(3).split(" -> ").pop());
  return [...new Set([...committed.split("\n").filter(Boolean), ...working])];
}

function main(argv) {
  const arg = (name) => {
    const index = argv.indexOf(name);
    return index === -1 ? undefined : argv[index + 1];
  };
  if (argv.includes("--full")) {
    process.stdout.write(`${JSON.stringify({ files: 0, ...fullPlan() })}\n`);
    return;
  }
  const explicit = arg("--files");
  const files = explicit !== undefined ? explicit.split(",").filter(Boolean) : changedFiles(arg("--base") ?? "origin/main");
  const result = { files: files.length, ...plan(files) };
  if (argv.includes("--json")) {
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }
  console.log(`${files.length} changed file(s); docs-only: ${result.docsOnly}; units: ${result.units}; postgres lane: ${result.postgres}`);
  for (const reason of result.reasons) console.log(`  full browser set because: ${reason}`);
  console.log(`${result.suites.length} browser suite(s) (Chromium only):`);
  for (const suite of result.suites) console.log(`  ${suite.config}${suite.projects.length ? `  [${suite.projects.join(", ")}]` : ""}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url) && existsSync(path.join(ROOT, "package.json"))) {
  main(process.argv.slice(2));
}
