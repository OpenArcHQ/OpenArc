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

for (const futureKind of ["investigation_note"]) {
  const sharedVaultSource = m02Sources.get("packages/shared/src/vault.ts") ?? "";
  if (sharedVaultSource.includes(futureKind)) {
    failures.push(`M02 record union implements later-milestone kind: ${futureKind}`);
  }
}

const m03Files = [
  "docs/releases/03-api-privacy-boundary.md",
  "packages/shared/src/api.ts",
  "packages/shared/src/permission.ts",
  "apps/api/src/http/origin.ts",
  "apps/api/src/http/source-route.ts",
  "apps/api/src/limits/budget.ts",
  "apps/api/src/ops/metrics.ts",
  "apps/api/src/providers/http.ts",
  "apps/api/test/budget.test.ts",
  "apps/api/test/provider.test.ts",
  "apps/web/src/api/capabilities.ts",
  "apps/web/src/api/permission-flow.ts",
  "apps/web/nginx-api.conf",
  "apps/web/proxy_params",
  "scripts/test-m02-receipt-compat.mjs",
];
const m03Sources = new Map();
for (const required of m03Files) {
  try {
    m03Sources.set(required, await readFile(path.join(root, required), "utf8"));
  } catch {
    failures.push(`Missing required M03 file: ${required}`);
  }
}
const m03Runtime = [...m03Sources].filter(([file]) => !file.includes("test/") && !file.startsWith("docs/"))
  .map(([, source]) => source).join("\n");
for (const requiredToken of [
  "openarc.api.v1", "openarc.permission-receipt.v1", "browser-v1", "credentials: \"omit\"",
  "disableOfflineQueue: true", "reconnectStrategy: (retries) => redisReconnectDelay(retries)",
  "timingSafeEqual", "proxy_ssl_verify on",
  "connect-src 'self'", "error_log /dev/null emerg", "access_log off",
  "add_header Cache-Control \"no-store\" always", "add_header Pragma \"no-cache\" always",
  "add_header Strict-Transport-Security \"max-age=31536000; includeSubDomains\" always",
]) {
  if (!m03Runtime.includes(requiredToken)) failures.push(`M03 privacy boundary is missing ${requiredToken}`);
}
for (const forbiddenToken of ["rejectUnauthorized: false", "credentials: \"include\"", "redirect: \"follow\""]) {
  if (m03Runtime.includes(forbiddenToken)) failures.push(`M03 privacy boundary contains forbidden behavior: ${forbiddenToken}`);
}

const m04Files = [
  "docs/releases/04-arc-observation.md",
  "packages/shared/src/arc-observation.ts",
  "packages/shared/test/arc-observation.test.ts",
  "packages/shared/test/permission.test.ts",
  "apps/api/src/arc/rpc-client.ts",
  "apps/api/src/arc/validation.ts",
  "apps/api/src/arc/account-service.ts",
  "apps/api/src/arc/transaction-service.ts",
  "apps/api/src/config.ts",
  "apps/api/src/http/source-route.ts",
  "apps/api/src/limits/budget.ts",
  "apps/api/test/arc-observation.test.ts",
  "apps/api/test/arc-routes.test.ts",
  "apps/web/src/api/client.ts",
  "apps/web/src/api/arc-observation.ts",
  "apps/web/src/api/arc-permission-flow.ts",
  "apps/web/Dockerfile",
  "apps/web/nginx-api.conf",
  "apps/web/nginx-arc.conf",
  "apps/web/test/arc-client.test.ts",
  "apps/web/test/arc-observation-flow.test.ts",
  "e2e-arc-observation/observation.spec.ts",
  "playwright.arc-observation.config.ts",
  "playwright.arc-observation.production.config.ts",
  "scripts/arc-rpc-fixture.mjs",
];
const m04Sources = new Map();
for (const required of m04Files) {
  try {
    m04Sources.set(required, await readFile(path.join(root, required), "utf8"));
  } catch {
    failures.push(`Missing required M04 file: ${required}`);
  }
}
const m04Runtime = [...m04Sources]
  .filter(([file]) => !file.includes("test/") && !file.startsWith("docs/"))
  .map(([, source]) => source).join("\n");
for (const requiredToken of [
  "openarc.arc-account-snapshot.v1", "openarc.arc-transaction-evidence.v1",
  "openarc.permission-receipt.v2", "openarc.arc-observation-record.v1",
  "arc_primary_rpc", "canonical_eip7708_usdc", "same_underlying_balance",
  "SOURCE_WRONG_NETWORK", "SOURCE_CONFLICT", "credentials: \"omit\"",
  "redirect: \"error\"", "cache: \"no-store\"", "referrerPolicy: \"no-referrer\"",
  "SOURCE_PROXY_SECRET", "X-OpenArc-Proxy-Client-IP", "timingSafeEqual", "preHandler",
]) {
  if (!m04Runtime.includes(requiredToken)) failures.push(`M04 Arc observation contract is missing ${requiredToken}`);
}
for (const forbiddenToken of [
  "sendTransaction", "broadcastTransaction", "window.ethereum", "setInterval(",
  "credentials: \"include\"", "redirect: \"follow\"", "rejectUnauthorized: false",
]) {
  if (m04Runtime.includes(forbiddenToken)) failures.push(`M04 Arc observation runtime contains forbidden behavior: ${forbiddenToken}`);
}

const m05Files = [
  "docs/releases/05-erc8004-agent-evidence.md",
  "packages/shared/src/agent-registry-evidence.ts",
  "packages/shared/src/permission.ts",
  "packages/shared/src/vault.ts",
  "packages/shared/test/agent-registry-evidence.test.ts",
  "apps/api/src/arc/agent-registry-service.ts",
  "apps/api/src/arc/rpc-client.ts",
  "apps/api/src/config.ts",
  "apps/api/src/app.ts",
  "apps/api/test/agent-registry.test.ts",
  "apps/api/test/agent-registry-routes.test.ts",
  "apps/web/src/api/agent-registry.ts",
  "apps/web/src/api/agent-registry-permission-flow.ts",
  "apps/web/src/vault/VaultWorkspace.tsx",
  "apps/web/src/vault/service.ts",
  "apps/web/test/agent-registry-flow.test.ts",
  "e2e-agent-registry/agent-registry.spec.ts",
  "playwright.agent-registry.config.ts",
  "playwright.agent-registry.production.config.ts",
];
const m05Sources = new Map();
for (const required of m05Files) {
  try {
    m05Sources.set(required, await readFile(path.join(root, required), "utf8"));
  } catch {
    failures.push(`Missing required M05 file: ${required}`);
  }
}
const m05Runtime = [...m05Sources]
  .filter(([file]) => !file.includes("test/") && !file.startsWith("docs/") && !file.startsWith("e2e-"))
  .map(([, source]) => source).join("\n");
for (const requiredToken of [
  "openarc.agent-registry-evidence.v1", "openarc.permission-receipt.v3",
  "openarc.agent-registry-observation-record.v1", "openarc.capabilities.m05.v1",
  "arc_agent_registry_evidence", "erc8004_registries", "observer_specific_claim",
  "validator_specific_response", "untrusted_external_metadata", "fetched: z.literal(false)",
  "revertAsNotFound", "SOURCE_NOT_FOUND", "SOURCE_CONFLICT", "SOURCE_MAX_SUBCALLS < 10",
  "linkedAgentProfileRecordId", "Local profile and label", "Not released",
]) {
  if (!m05Runtime.includes(requiredToken)) failures.push(`M05 ERC-8004 evidence contract is missing ${requiredToken}`);
}
for (const forbiddenToken of [
  "getClients(", "readAllFeedback(", "getAgentValidations(", "getSummary(",
  "sendTransaction", "broadcastTransaction", "writeContract", "window.ethereum",
  "dangerouslySetInnerHTML", "credentials: \"include\"", "redirect: \"follow\"",
]) {
  if (m05Runtime.includes(forbiddenToken)) failures.push(`M05 ERC-8004 runtime contains forbidden behavior: ${forbiddenToken}`);
}

const envExample = await readFile(path.join(root, ".env.example"), "utf8");
const dockerignoreSource = await readFile(path.join(root, ".dockerignore"), "utf8");
const webDockerfile = await readFile(path.join(root, "apps/web/Dockerfile"), "utf8");
if (!envExample.includes("VITE_ENCRYPTED_WORKSPACE_ENABLED=false")) {
  failures.push("M02 feature flag must default to false in .env.example");
}
for (const featureFlag of ["API_BOUNDARY_ENABLED=false", "VITE_API_BOUNDARY_ENABLED=false"]) {
  if (!envExample.includes(featureFlag)) failures.push(`M03 feature flag must default false: ${featureFlag}`);
}
for (const featureFlag of ["ARC_OBSERVATION_ENABLED=false", "VITE_ARC_OBSERVATION_ENABLED=false"]) {
  if (!envExample.includes(featureFlag)) failures.push(`M04 feature flag must default false: ${featureFlag}`);
}
for (const featureFlag of ["AGENT_REGISTRY_ENABLED=false", "VITE_AGENT_REGISTRY_ENABLED=false"]) {
  if (!envExample.includes(featureFlag)) failures.push(`M05 feature flag must default false: ${featureFlag}`);
}
if (!dockerignoreSource.includes("!.env.example")) {
  failures.push("The clean-room release image must include .env.example for release:check");
}
if (!webDockerfile.includes("ARG VITE_ENCRYPTED_WORKSPACE_ENABLED=false")) {
  failures.push("M02 feature flag must default to false in the web image");
}
if (!webDockerfile.includes("ARG VITE_API_BOUNDARY_ENABLED=false")) {
  failures.push("M03 API boundary must default to false in the web image");
}
if (!webDockerfile.includes("ARG VITE_ARC_OBSERVATION_ENABLED=false")) {
  failures.push("M04 Arc observation must default to false in the web image");
}
if (!webDockerfile.includes("ARG VITE_AGENT_REGISTRY_ENABLED=false")) {
  failures.push("M05 agent registry evidence must default to false in the web image");
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
if (!packageSource.includes("playwright test -c playwright.arc-observation.config.ts")) {
  failures.push("M04 browser gate must exercise explicit Arc observation journeys");
}
if (!packageSource.includes("playwright test -c playwright.arc-observation.production.config.ts")) {
  failures.push("M04 browser gate must define an exact production-source image journey");
}
if (!packageSource.includes("playwright test -c playwright.agent-registry.config.ts")) {
  failures.push("M05 browser gate must exercise explicit agent-registry journeys");
}
if (!packageSource.includes("playwright test -c playwright.agent-registry.production.config.ts")) {
  failures.push("M05 browser gate must define an exact production-source image journey");
}
const m02WorkflowSource = await readFile(path.join(root, ".github/workflows/release-gates.yml"), "utf8");
for (const requiredToken of [
  "openarc-web-m03:ci", "VITE_API_BOUNDARY_ENABLED=true", "pnpm e2e:api-boundary:production",
  "API_UPSTREAM_SNI=wrong.openarc.test", "image --exit-code 1 --severity HIGH,CRITICAL openarc-web-m03:ci",
  "api_ready=0", "test \"${api_ready}\" = \"1\"",
  "shell.headers", "proxy.headers", "proxy-502.headers", "Strict-Transport-Security: max-age=31536000; includeSubDomains",
  "OPENARC_TEST_REDIS_URL: redis://127.0.0.1:6379", "OPENARC_TEST_REDIS_DISPOSABLE: \"true\"",
  "openarc-web-m02-reader:ci", "m02_reader_ready=0", "test-m02-receipt-compat.mjs seed",
  "test-m02-receipt-compat.mjs verify", "fetch-depth: 0",
  "openarc-web-m03:ci -o cyclonedx-json > sbom-web-m03.cdx.json",
]) {
  if (!m02WorkflowSource.includes(requiredToken)) failures.push(`Hosted M03 image/proxy gate is missing ${requiredToken}`);
}
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
for (const requiredToken of [
  "openarc-web-m04:ci", "VITE_ARC_OBSERVATION_ENABLED=true",
  "ARC_OBSERVATION_ENABLED=true", "e2e:arc-observation:production",
  "test -x /docker-entrypoint.d/05-openarc-m04-env.sh",
  "arc-rpc-fixture.mjs", "NODE_EXTRA_CA_CERTS=/tmp/rpc-ca.crt",
  "REDIS_URL=redis://openarc-redis-m04:6379", '"arcObservation":true',
  "SOURCE_PROXY_SECRET=synthetic_source_proxy_secret_for_ci_0004", "X-Real-IP: 192.0.2.20",
  'test "${exhausted_status}" = "429"', 'test "${independent_status}" = "200"',
  'test "${direct_status}" = "403"',
  "image --exit-code 1 --severity HIGH,CRITICAL openarc-web-m04:ci",
  "openarc-web-m04:ci -o cyclonedx-json > sbom-web-m04.cdx.json",
]) {
  if (!m02WorkflowSource.includes(requiredToken)) failures.push(`Hosted M04 exact-source/image gate is missing ${requiredToken}`);
}
for (const requiredToken of [
  "openarc-web-m05:ci", "VITE_AGENT_REGISTRY_ENABLED=true", "AGENT_REGISTRY_ENABLED=true",
  "SOURCE_MAX_SUBCALLS=10", "e2e:agent-registry:production", '"agentRegistry":true',
  "image --exit-code 1 --severity HIGH,CRITICAL openarc-web-m05:ci",
  "openarc-web-m05:ci -o cyclonedx-json > sbom-web-m05.cdx.json",
]) {
  if (!m02WorkflowSource.includes(requiredToken)) failures.push(`Hosted M05 exact-source/image gate is missing ${requiredToken}`);
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

const cleanRoomGate = dockerfiles.find(([candidate]) => candidate === "scripts/Dockerfile.node22-gate")?.[1] ?? "";
for (const requiredToken of ["redis:8-bookworm@sha256:", "COPY --from=redis-test /usr/local/bin/redis-server",
  "OPENARC_TEST_REDIS_SERVER=/usr/local/bin/redis-server"]) {
  if (!cleanRoomGate.includes(requiredToken)) failures.push(`Clean-room gate is missing disposable Redis fixture wiring: ${requiredToken}`);
}

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
      "curl=8.22.0-r0",
      "libcrypto3=3.5.8-r0",
      "libcurl=8.22.0-r0",
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
for (const auditGuard of [
  "pnpm audit:prod 2>&1 | tee",
  "audit_status=${PIPESTATUS[0]}",
  "[23] The operation was aborted due to timeout",
  "TimeoutError: The operation was aborted due to timeout",
  "mandatory pinned Trivy production-image scans",
]) {
  if (!workflowSource.includes(auditGuard)) {
    failures.push(`Release workflow is missing the strict audit transport guard: ${auditGuard}`);
  }
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

console.log("[release-check] M05 ERC-8004 agent evidence, M04 Arc observation, M03 API/privacy boundary, M02 workspace, M01 engine, and M00 foundation verified");
