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

if (failures.length > 0) {
  for (const failure of failures) console.error(`[release-check] ${failure}`);
  process.exit(1);
}

console.log("[release-check] M00 repository and Testnet-only registry verified");
