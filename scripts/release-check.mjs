import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const root = path.resolve(import.meta.dirname, "..");
const failures = [];

if (Number.parseInt(process.versions.node.split(".")[0] ?? "0", 10) !== 22) {
  failures.push(`Node 22 is required; found ${process.version}`);
}

for (const required of ["pnpm-lock.yaml", "pnpm-workspace.yaml", "apps/api/Dockerfile", "apps/web/Dockerfile"]) {
  try {
    await stat(path.join(root, required));
  } catch {
    failures.push(`Missing required foundation file: ${required}`);
  }
}

const m01Files = [
  "docs/releases/01-evidence-engine.md",
  "packages/shared/src/evidence.ts",
  "packages/shared/src/reconciliation.ts",
  "packages/shared/src/fixtures.ts",
  "apps/web/src/evidence/FixtureExplorer.tsx",
  "apps/web/src/evidence/view-model.ts",
];
const m01Sources = [];
for (const required of m01Files) {
  try {
    m01Sources.push(await readFile(path.join(root, required), "utf8"));
  } catch {
    failures.push(`Missing required M01 file: ${required}`);
  }
}
const m01Source = m01Sources.join("\n");
for (const fixtureId of ["complete", "missing", "conflict", "expired", "failed", "refunded"]) {
  if (!m01Source.includes(`"${fixtureId}"`)) failures.push(`M01 fixture matrix is missing ${fixtureId}`);
}
for (const forbiddenToken of [
  "fetch(",
  "XMLHttpRequest",
  "WebSocket",
  "localStorage",
  "sessionStorage",
  "indexedDB",
  "sendTransaction",
  "broadcastTransaction",
]) {
  if (m01Source.includes(forbiddenToken)) {
    failures.push(`M01 fixture implementation contains forbidden network/storage/execution API: ${forbiddenToken}`);
  }
}

const m02Files = [
  "docs/releases/02-encrypted-workspace.md",
  "packages/shared/src/vault.ts",
  "packages/shared/test/vault.test.ts",
  "apps/web/src/app/availability.ts",
  "apps/web/src/vault/types.ts",
  "apps/web/src/vault/crypto.ts",
  "apps/web/src/vault/db.ts",
  "apps/web/src/vault/errors.ts",
  "apps/web/src/vault/service.ts",
  "apps/web/src/vault/VaultWorkspace.tsx",
  "apps/web/test/availability.test.ts",
  "apps/web/test/vault.test.ts",
  "e2e/workspace.spec.ts",
  "e2e-flag-off/workspace-flag-off.spec.ts",
  "e2e-production/workspace-production.spec.ts",
  "playwright.production.config.ts",
  "playwright.flag-off.config.ts",
];
const m02Sources = new Map();
for (const required of m02Files) {
  try {
    m02Sources.set(required, await readFile(path.join(root, required), "utf8"));
  } catch {
    failures.push(`Missing required M02 file: ${required}`);
  }
}

const m02Runtime = [
  "packages/shared/src/vault.ts",
  "apps/web/src/app/availability.ts",
  "apps/web/src/vault/types.ts",
  "apps/web/src/vault/crypto.ts",
  "apps/web/src/vault/db.ts",
  "apps/web/src/vault/errors.ts",
  "apps/web/src/vault/service.ts",
  "apps/web/src/vault/VaultWorkspace.tsx",
]
  .map((relativePath) => m02Sources.get(relativePath) ?? "")
  .join("\n");

for (const requiredToken of [
  "openarc.encrypted-vault",
  "OPENARC-ENCRYPTED-BACKUP",
  "openarc.logical-backup",
  "VAULT_WRAP_KDF_ITERATIONS = 600_000",
  "VAULT_BACKUP_KDF_ITERATIONS = 600_000",
  "recordRevision: VaultRevisionSchema",
  "coordinationRevision: string",
  "deletionPending: boolean",
  "assertActive",
]) {
  if (!m02Runtime.includes(requiredToken)) {
    failures.push(`M02 encrypted-workspace contract is missing ${requiredToken}`);
  }
}

for (const forbiddenToken of [
  "fetch(",
  "XMLHttpRequest",
  "WebSocket",
  "EventSource",
  "sendBeacon",
  "localStorage",
  "sessionStorage",
  "dangerouslySetInnerHTML",
  "src=\"http",
  "src={'http",
  'src={"http',
  "window.ethereum",
  "sendTransaction",
  "broadcastTransaction",
]) {
  if (m02Runtime.includes(forbiddenToken)) {
    failures.push(`M02 runtime contains forbidden network/plaintext-storage/execution API: ${forbiddenToken}`);
  }
}

for (const futureKind of ["permission_receipt", "investigation_note"]) {
  const sharedVaultSource = m02Sources.get("packages/shared/src/vault.ts") ?? "";
  if (sharedVaultSource.includes(futureKind)) {
    failures.push(`M02 record union implements later-milestone kind: ${futureKind}`);
  }
}

const envExample = await readFile(path.join(root, ".env.example"), "utf8");
const dockerignoreSource = await readFile(path.join(root, ".dockerignore"), "utf8");
const webDockerfile = await readFile(path.join(root, "apps/web/Dockerfile"), "utf8");
if (!envExample.includes("VITE_ENCRYPTED_WORKSPACE_ENABLED=false")) {
  failures.push("M02 feature flag must default to false in .env.example");
}
if (!dockerignoreSource.includes("!.env.example")) {
  failures.push("The clean-room release image must include .env.example for release:check");
}
if (!webDockerfile.includes("ARG VITE_ENCRYPTED_WORKSPACE_ENABLED=false")) {
  failures.push("M02 feature flag must default to false in the web image");
}

const nginxSource = await readFile(path.join(root, "apps/web/nginx.conf"), "utf8");
for (const directive of ["connect-src 'none'", "worker-src 'none'", "media-src 'none'"]) {
  if (!nginxSource.includes(directive)) {
    failures.push(`M02 web CSP is missing local-only directive: ${directive}`);
  }
}

const packageSource = await readFile(path.join(root, "package.json"), "utf8");
if (!packageSource.includes("playwright test -c playwright.flag-off.config.ts")) {
  failures.push("M02 browser gate must exercise the feature-disabled build");
}
if (!packageSource.includes("playwright test -c playwright.production.config.ts")) {
  failures.push("M02 browser gate must define an exact production-artifact check");
}
const m02WorkflowSource = await readFile(path.join(root, ".github/workflows/release-gates.yml"), "utf8");
for (const requiredToken of [
  "VITE_ENCRYPTED_WORKSPACE_ENABLED=true",
  "openarc-web-m02:ci",
  "pnpm e2e:production",
  "image --exit-code 1 --severity HIGH,CRITICAL openarc-web-m02:ci",
  "openarc-web-m02:ci -o cyclonedx-json > sbom-web-m02.cdx.json",
]) {
  if (!m02WorkflowSource.includes(requiredToken)) {
    failures.push(`Hosted M02 production-artifact gate is missing ${requiredToken}`);
  }
}

const networkSource = await readFile(path.join(root, "packages/shared/src/network.ts"), "utf8");
for (const requiredValue of ["5042002", "0x4cef52", "https://rpc.testnet.arc.io"]) {
  if (!networkSource.includes(requiredValue)) failures.push(`Network registry is missing ${requiredValue}`);
}

if (/mainnet\s*[:=]/iu.test(networkSource) || /ARC_MAINNET/u.test(networkSource)) {
  failures.push("M00 must not contain a mainnet network configuration");
}

const dockerfiles = await Promise.all(
  ["apps/api/Dockerfile", "apps/web/Dockerfile", "scripts/Dockerfile.node22-gate"].map(
    async (relativePath) => [relativePath, await readFile(path.join(root, relativePath), "utf8")],
  ),
);

for (const [relativePath, source] of dockerfiles) {
  for (const instruction of source.matchAll(/^FROM\s+(\S+)/gmu)) {
    if (!/@sha256:[0-9a-f]{64}$/u.test(instruction[1] ?? "")) {
      failures.push(`${relativePath} contains an unpinned base image: ${instruction[1] ?? "unknown"}`);
    }
  }
  if (/\bapk\s+upgrade\b/u.test(source)) {
    failures.push(`${relativePath} must not perform a nondeterministic apk upgrade`);
  }
}

for (const [relativePath, requiredPackages] of [
  ["apps/api/Dockerfile", ["libcrypto3=3.5.8-r0", "libssl3=3.5.8-r0"]],
  [
    "apps/web/Dockerfile",
    [
      "c-ares=1.34.8-r0",
      "curl=8.20.0-r0",
      "libcrypto3=3.5.8-r0",
      "libcurl=8.20.0-r0",
      "libexpat=2.8.4-r0",
      "libssl3=3.5.8-r0",
      "libxml2=2.13.9-r1",
      "nghttp2-libs=1.69.0-r0",
    ],
  ],
]) {
  const source = dockerfiles.find(([candidate]) => candidate === relativePath)?.[1] ?? "";
  for (const runtimePackage of requiredPackages) {
    if (!source.includes(runtimePackage)) {
      failures.push(`${relativePath} is missing pinned runtime patch package ${runtimePackage}`);
    }
  }
}

const workflowSource = await readFile(
  path.join(root, ".github/workflows/release-gates.yml"),
  "utf8",
);
for (const action of workflowSource.matchAll(/^\s*-\s*uses:\s*([^\s#]+)/gmu)) {
  const reference = action[1]?.split("@")[1] ?? "";
  if (!/^[0-9a-f]{40}$/u.test(reference)) {
    failures.push(`Release workflow action is not pinned to a full commit SHA: ${action[1]}`);
  }
}
for (const requiredDigest of [
  "redis:8-alpine@sha256:",
  "aquasec/trivy:0.73.0@sha256:",
  "anchore/syft:v1.51.0@sha256:",
]) {
  if (!workflowSource.includes(requiredDigest)) {
    failures.push(`Release workflow is missing an immutable container reference for ${requiredDigest}`);
  }
}
if (workflowSource.includes("--ignore-unfixed")) {
  failures.push("Release image scans must not ignore unfixed HIGH/CRITICAL findings");
}
for (const readinessGuard of ["api_ready=0", "test \"${api_ready}\" = \"1\"", "web_ready=0", "test \"${web_ready}\" = \"1\""]) {
  if (!workflowSource.includes(readinessGuard)) {
    failures.push(`Release image smoke is missing bounded readiness guard: ${readinessGuard}`);
  }
}

if (failures.length > 0) {
  for (const failure of failures) console.error(`[release-check] ${failure}`);
  process.exit(1);
}

console.log("[release-check] M02 encrypted workspace, M01 evidence engine, and M00 foundation verified");
