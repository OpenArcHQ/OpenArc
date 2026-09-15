#!/usr/bin/env node
// Disposable PORT-03 commerce action/grant production acceptance stack.
//
// Mirrors the accepted session-production provisioning (prepare-session-
// production.cjs + start-session-production.cjs): real API and ON/OFF nginx web
// images built from the exact tracked source revision, one isolated PostgreSQL
// (network none), self-signed TLS forwarders for the fixed loopback origins and
// a browser/fixture container sharing that network namespace. Every resource is
// named `openarc-p03-accept-*`. No host port is published, no external network
// is used beyond already-pinned local images, and no token is ever printed.
// Only ONE application stack runs at a time (ON, then OFF) on one PostgreSQL.
//
// Usage (one action per call, from the worktree root):
//   node e2e-commerce-production/provision-stack.mjs build        # api + web-on + web-off images
//   node e2e-commerce-production/provision-stack.mjs db           # postgres + browser container + migrate
//   node e2e-commerce-production/provision-stack.mjs start on|off # api + tls forwarders + web
//   node e2e-commerce-production/provision-stack.mjs stop on|off
//   node e2e-commerce-production/provision-stack.mjs sync         # candidate + acceptance files into browser
//   node e2e-commerce-production/provision-stack.mjs test on|off  # playwright project
//   node e2e-commerce-production/provision-stack.mjs digests
//   node e2e-commerce-production/provision-stack.mjs teardown     # remove every openarc-p03-accept-* resource
import { randomBytes } from "node:crypto";
import { chmodSync, closeSync, mkdirSync, openSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const RUN = "/tmp/openarc-p03-accept-run";
const WORKTREE = "/tmp/openarc-p03-accept-wt";
const REVISION = process.env.OPENARC_P03_ACCEPT_REVISION || "86c2106";
const PREFIX = "openarc-p03-accept";
const DB = `${PREFIX}-db`;
const BROWSER = `${PREFIX}-browser`;
const VOLUME = `${PREFIX}-pg-data`;
const PG_IMAGE = "postgres@sha256:67f41722b7a8cbdb868a44a4995c846eddfdc2973bccb291ce937dce88ad5675";
const BROWSER_IMAGE = "openarc-port02-source-gate:local";
const PORTS = { on: "5491", off: "5492" };
const FIXTURE_ENV = [
  "-e", "OPENARC_TEST_DATABASE_URL=postgres://postgres:openarc_disposable_test@127.0.0.1:5432/openarc_auth_test",
  "-e", "OPENARC_TENANT_PRODUCTION_FIXTURE=1",
  "-e", "OPENARC_SESSION_PRODUCTION_FIXTURE=1",
  "-e", "OPENARC_COMMERCE_PRODUCTION_FIXTURE=1",
  "-e", `PLAYWRIGHT_COMMERCE_PRODUCTION_BASE_URL=https://account.openarc.test:${PORTS.on}`,
  "-e", `PLAYWRIGHT_COMMERCE_PRODUCTION_OFF_BASE_URL=https://account.openarc.test:${PORTS.off}`,
];

function run(exe, args, options = {}) {
  const r = spawnSync(exe, args, { encoding: "utf8", maxBuffer: 256 * 1024 * 1024, ...options });
  if (r.status !== 0) throw Error(`${exe} ${args[0]} failed: ${(r.stderr || r.stdout || "").slice(-2000)}`);
  return r.stdout;
}
const log = (o) => process.stdout.write(JSON.stringify(o) + "\n");
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

function archive() {
  const tar = spawnSync("git", ["archive", REVISION], { cwd: WORKTREE, maxBuffer: 512 * 1024 * 1024 });
  if (tar.status !== 0) throw Error("git archive failed");
  return tar.stdout;
}

function build() {
  mkdirSync(RUN, { recursive: true });
  const revision = run("git", ["rev-parse", REVISION], { cwd: WORKTREE }).trim();
  const src = join(RUN, "image-source");
  rmSync(src, { recursive: true, force: true });
  mkdirSync(src, { recursive: true });
  run("tar", ["-xf", "-", "-C", src], { input: archive() });
  for (const mode of ["api", "on", "off"]) {
    const fd = openSync(join(RUN, `build-${mode}.log`), "w");
    const image = `${PREFIX}-${mode === "api" ? "api" : `web-${mode}`}:local`;
    const args = ["build", "--progress=plain", "-f", `apps/${mode === "api" ? "api" : "web"}/Dockerfile`,
      "-t", image, "--build-arg", `COMMIT_SHA=${revision}`];
    if (mode !== "api") {
      const on = String(mode === "on");
      args.push("--build-arg", "VITE_API_BOUNDARY_ENABLED=true",
        "--build-arg", "VITE_ACCOUNT_ACCESS_ENABLED=true",
        "--build-arg", "VITE_TENANT_READS_ENABLED=true",
        "--build-arg", "VITE_POLICY_MANAGEMENT_ENABLED=false",
        "--build-arg", "VITE_COMMERCE_SESSIONS_ENABLED=true",
        "--build-arg", `VITE_COMMERCE_ACTIONS_ENABLED=${on}`,
        "--build-arg", `VITE_COMMERCE_GRANTS_ENABLED=${on}`);
    }
    log({ step: "build", image, revision });
    run("docker", [...args, "."], { cwd: src, stdio: ["ignore", fd, fd] });
    closeSync(fd);
  }
  rmSync(src, { recursive: true, force: true });
}

function digests() {
  const revision = run("git", ["rev-parse", REVISION], { cwd: WORKTREE }).trim();
  for (const image of ["api", "web-on", "web-off"]) {
    const id = run("docker", ["image", "inspect", "--format", "{{.Id}}", `${PREFIX}-${image}:local`]).trim();
    log({ image: `${PREFIX}-${image}:local`, id, revision });
  }
}

function sync() {
  // Candidate tracked source at REVISION, then ONLY the new acceptance files
  // from the worktree overlaid on top. Images never contain these test files.
  run("docker", ["exec", "-i", BROWSER, "tar", "--no-same-owner", "--no-same-permissions", "-xf", "-", "-C", "/workspace"],
    { input: archive() });
  const overlay = spawnSync("tar", ["--no-xattrs", "-C", WORKTREE, "-cf", "-",
    "e2e-commerce-production", "playwright.commerce.production.config.ts"],
  { env: { PATH: process.env.PATH, COPYFILE_DISABLE: "1" }, maxBuffer: 64 * 1024 * 1024 });
  if (overlay.status !== 0) throw Error("overlay archive failed");
  run("docker", ["exec", "-i", BROWSER, "tar", "--no-same-owner", "--no-same-permissions", "-xf", "-", "-C", "/workspace"],
    { input: overlay.stdout });
  const prefix = ["exec", "-w", "/workspace", ...FIXTURE_ENV, BROWSER, "pnpm"];
  run("docker", [...prefix, "--filter", "@openarc/shared", "build"]);
  run("docker", [...prefix, "--filter", "@openarc/db", "build"]);
  log({ step: "synced", revision: REVISION });
}

function db() {
  mkdirSync(RUN, { recursive: true });
  run("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-sha256", "-nodes", "-days", "2",
    "-subj", "/CN=account.openarc.test", "-addext", "subjectAltName=DNS:account.openarc.test",
    "-keyout", join(RUN, "test.key"), "-out", join(RUN, "test.crt")], { stdio: "ignore" });
  chmodSync(join(RUN, "test.key"), 0o644); // synthetic two-day loopback fixture only
  run("docker", ["run", "-d", "--name", DB, "--network", "none", "--memory", "1g", "--memory-swap", "1g",
    "-v", `${VOLUME}:/var/lib/postgresql/data`, "-e", "POSTGRES_PASSWORD=openarc_disposable_test",
    "-e", "POSTGRES_DB=openarc_auth_test", PG_IMAGE]);
  for (let n = 0; ; n++) {
    if (spawnSync("docker", ["exec", DB, "pg_isready", "-U", "postgres", "-d", "openarc_auth_test"]).status === 0) break;
    if (n >= 30) throw Error("PostgreSQL not ready");
    sleep(1000);
  }
  sleep(2000);
  run("docker", ["run", "-d", "--name", BROWSER, "--network", `container:${DB}`, "--memory", "1536m",
    "--memory-swap", "1536m", "--entrypoint", "tail", BROWSER_IMAGE, "-f", "/dev/null"]);
  run("docker", ["cp", join(RUN, "test.crt"), `${BROWSER}:/tmp/openarc-p03-accept-test.crt`]);
  sync();
  const prefix = ["exec", "-w", "/workspace", ...FIXTURE_ENV, BROWSER, "pnpm"];
  run("docker", [...prefix, "--filter", "@openarc/api", "exec", "tsx", "../../e2e-tenant-production/fixture-db.ts", "--prepare"]);
  log({ step: "db-ready-and-migrated" });
}

function start(mode) {
  const port = PORTS[mode];
  if (!port) throw Error("mode must be on or off");
  const enabled = mode === "on";
  const env = {
    NODE_ENV: "production",
    APP_ORIGIN: `https://account.openarc.test:${port}`, AUTH_RP_ID: "account.openarc.test",
    API_BOUNDARY_ENABLED: "true", AUTH_ENABLED: "true", TENANT_READS_ENABLED: "true",
    POLICY_MANAGEMENT_ENABLED: "false", COMMERCE_SESSIONS_ENABLED: "true",
    COMMERCE_ACTIONS_ENABLED: String(enabled), COMMERCE_GRANTS_ENABLED: String(enabled),
    TENANT_WRITES_ENABLED: "false", MACHINE_CREDENTIALS_ENABLED: "false", MARKET_CATALOG_ENABLED: "false",
    LISTING_MANAGEMENT_ENABLED: "false", MARKET_MODERATION_ENABLED: "false",
    AUTH_SECRET: randomBytes(32).toString("hex"), METRICS_TOKEN: randomBytes(32).toString("hex"),
    LOG_LEVEL: "silent", AUTH_RATE_PEER_PER_HOUR: "10000", AUTH_RATE_GLOBAL_PER_MINUTE: "10000",
    AUTH_RATE_BINDING_PER_HOUR: "10000",
    AUTH_DATABASE_URL: "postgres://openarc_auth_app:openarc_auth_app_test_pw@127.0.0.1:5432/openarc_auth_test",
    TENANT_DATABASE_URL: "postgres://openarc_tenant_app:openarc_tenant_app_test_pw@127.0.0.1:5432/openarc_auth_test",
  };
  // Synthetic per-run secrets go through a 0600 env file deleted right after
  // `docker run`, so no value is left on disk or visible in argv.
  const envFile = join(RUN, `api-${mode}.env`);
  writeFileSync(envFile, Object.entries(env).map(([k, v]) => `${k}=${v}`).join("\n") + "\n", { mode: 0o600 });
  try {
    run("docker", ["run", "-d", "--name", `${PREFIX}-api-${mode}`, "--network", `container:${DB}`, "--memory", "512m",
      "--env-file", envFile, `${PREFIX}-api:local`]);
  } finally {
    rmSync(envFile, { force: true });
  }
  for (const [kind, listen, target] of [["api", "9443", "3000"], ["web", port, "8080"]]) {
    const name = `${PREFIX}-${kind}-tls-${mode}`;
    run("docker", ["create", "--name", name, "--network", `container:${DB}`, "--memory", "128m",
      `${PREFIX}-api:local`, "node", "/tmp/tls-forwarder.mjs", listen, target, "/tmp/test.key", "/tmp/test.crt"]);
    run("docker", ["cp", join(WORKTREE, "scripts", "tls-forwarder.mjs"), `${name}:/tmp/tls-forwarder.mjs`]);
    for (const file of ["test.key", "test.crt"]) run("docker", ["cp", join(RUN, file), `${name}:/tmp/${file}`]);
    run("docker", ["start", name]);
  }
  const web = `${PREFIX}-web-${mode}`;
  run("docker", ["create", "--name", web, "--network", `container:${DB}`, "--memory", "128m",
    "-e", "API_UPSTREAM_HOST=127.0.0.1:9443", "-e", "API_UPSTREAM_SNI=account.openarc.test",
    "-e", "API_TRUST_BUNDLE=/tmp/test.crt", `${PREFIX}-web-${mode}:local`]);
  run("docker", ["cp", join(RUN, "test.crt"), `${web}:/tmp/test.crt`]);
  run("docker", ["start", web]);
  for (let n = 0; ; n++) {
    const probe = spawnSync("docker", ["exec", BROWSER, "node", "-e",
      `require('node:https').get({host:'127.0.0.1',port:${port},path:'/readyz',servername:'account.openarc.test',rejectUnauthorized:false},r=>{process.exit(r.statusCode===200?0:1)}).on('error',()=>process.exit(1))`]);
    if (probe.status === 0) break;
    if (n >= 60) {
      const state = spawnSync("docker", ["ps", "-a", "--filter", `name=${PREFIX}-api-${mode}`, "--format", "{{.Status}}"], { encoding: "utf8" });
      throw Error(`stack ${mode} not ready: api ${state.stdout.trim()}`);
    }
    sleep(1000);
  }
  log({ step: "stack-started", mode, port, revision: REVISION });
}

function stop(mode) {
  const names = ["web", "web-tls", "api-tls", "api"].map((k) => `${PREFIX}-${k}-${mode}`);
  spawnSync("docker", ["rm", "-f", ...names], { stdio: "ignore" });
  log({ step: "stack-stopped", mode });
}

function test(mode) {
  const project = mode === "on" ? "chromium-commerce-production" : "chromium-commerce-production-off";
  const extra = process.argv.slice(4);
  const r = spawnSync("docker", ["exec", "-w", "/workspace", ...FIXTURE_ENV, BROWSER, "pnpm", "exec", "playwright", "test",
    "-c", "playwright.commerce.production.config.ts", `--project=${project}`, ...extra], { stdio: "inherit", timeout: 1_500_000 });
  log({ step: "test", mode, exit: r.status });
  process.exit(r.status ?? 1);
}

function teardown() {
  const names = run("docker", ["ps", "-a", "--filter", `name=${PREFIX}`, "--format", "{{.Names}}"]).split("\n").filter(Boolean);
  if (names.length) spawnSync("docker", ["rm", "-f", "-v", ...names], { stdio: "ignore" });
  spawnSync("docker", ["volume", "rm", "-f", VOLUME], { stdio: "ignore" });
  for (const image of ["api", "web-on", "web-off"]) spawnSync("docker", ["image", "rm", "-f", `${PREFIX}-${image}:local`], { stdio: "ignore" });
  log({ step: "teardown", removedContainers: names.length });
}

const [action, arg] = process.argv.slice(2);
const actions = { build, db, sync, digests, teardown, start: () => start(arg), stop: () => stop(arg), test: () => test(arg) };
if (!Object.hasOwn(actions, action)) throw Error("unknown action");
actions[action]();
