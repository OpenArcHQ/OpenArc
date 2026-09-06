import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, expect } from "@playwright/test";

// Only the synthetic fixture HTTPS server may be contacted. This is not a
// production rollback tool and cannot select an existing personal profile.
const origin = "https://127.0.0.1:8444";
const readers = Object.freeze({
  m09: "3fecd6bb44dd71931e1e239b8e9e8b6d30cb19f8",
  m08: "16cd6f5cf557512cc373c2c5d1fb57dc89c0d63f",
});
const markerSchema = "openarc.synthetic-compatible-reader-drill.v1";
const passphrase = "synthetic M10 compatible reader drill passphrase";
const canary = "SYNTHETIC_PRIVATE_ROLLBACK_CANARY";
const policyName = "Synthetic rollback policy";
let context;
let stage = "validate-inputs";
// Bound IndexedDB evaluations and browser shutdown too, not only UI actions.
const watchdog = setTimeout(() => {
  console.error(JSON.stringify({ passed: false, stage: "whole-run-deadline" }));
  const exit = () => process.exit(1);
  setTimeout(exit, 2_000).unref();
  void (context ? context.close() : Promise.resolve()).then(exit, exit);
}, 120_000);
watchdog.unref();
try {
  const mode = process.argv[2];
  assert.ok(["seed", "verify", "restore"].includes(mode));
  // M08 is schema compatibility evidence ONLY: it predates the fixed stale
  // unlock boundary and must not be interpreted as a safe deployment rollback.
  const reader = process.env.OPENARC_COMPAT_READER ?? "m09";
  assert.ok(Object.hasOwn(readers, reader));
  const oldReader = readers[reader];
  const currentSha = process.env.EXPECTED_BUILD_SHA;
  assert.match(currentSha ?? "", /^[0-9a-f]{40}$/u);
  assert.notEqual(currentSha, oldReader);
  const spki = process.env.OPENARC_TEST_TLS_SPKI;
  if (spki !== undefined) assert.match(spki, /^[A-Za-z0-9+/]{43}=$/u);
  const expected = mode === "verify" ? oldReader : currentSha;
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../tmp");
  await mkdir(root, { recursive: true });
  assert.equal(await realpath(root), root, "Task root cannot be a symlink");
  let directory;
  let marker;
  if (mode === "seed") {
    assert.equal(process.env.OPENARC_COMPAT_TASK_DIR, undefined, "Seed must allocate a fresh profile");
    directory = await mkdtemp(path.join(root, "m10-reader-drill-"));
    marker = { schema: markerSchema, taskId: randomUUID(), origin, reader, oldReader, currentSha, phase: "initial" };
    await writeFile(path.join(directory, "owner.json"), JSON.stringify(marker), { flag: "wx", mode: 0o600 });
  } else {
    directory = path.resolve(process.env.OPENARC_COMPAT_TASK_DIR ?? "");
    assert.equal(path.dirname(directory), root);
    assert.match(path.basename(directory), /^m10-reader-drill-[A-Za-z0-9]{6}$/u);
    assert.equal(await realpath(directory), directory);
    const markerPath = path.join(directory, "owner.json");
    assert.ok((await lstat(markerPath)).isFile());
    marker = JSON.parse(await readFile(markerPath, "utf8"));
    assert.equal(marker.schema, markerSchema);
    assert.match(marker.taskId, /^[0-9a-f-]{36}$/u);
    assert.equal(marker.origin, origin);
    assert.equal(marker.reader, reader);
    assert.equal(marker.oldReader, oldReader);
    assert.equal(marker.currentSha, currentSha);
    assert.equal(marker.phase, mode === "verify" ? "seed" : "verify");
    assert.match(marker.ciphertextDigest, /^[0-9a-f]{64}$/u);
    assert.match(marker.reportHeading, /^Imported agent report [0-9a-f-]{36}$/u);
    const profile = path.join(directory, "profile");
    assert.ok((await lstat(profile)).isDirectory());
    assert.equal(await realpath(profile), profile);
  }
  // Optional pin permits exactly the disposable fixture certificate, never a
  // global TLS bypass. Omit when the fixture CA is already trusted by Chromium.
  stage = "launch-synthetic-profile";
  context = await chromium.launchPersistentContext(path.join(directory, "profile"), {
    headless: true, serviceWorkers: "block", ignoreHTTPSErrors: false,
    args: spki ? [`--ignore-certificate-errors-spki-list=${spki}`] : [],
  });
  let sourceRequests = 0;
  let outsideRequests = 0;
  await context.route("**/*", async route => {
    const request = route.request();
    if (["fetch", "xhr"].includes(request.resourceType())) { sourceRequests += 1; await route.abort(); return; }
    if (new URL(request.url()).origin !== origin) { outsideRequests += 1; await route.abort(); return; }
    await route.continue();
  });
  const page = context.pages()[0] ?? await context.newPage();
  page.setDefaultTimeout(20_000);
  page.setDefaultNavigationTimeout(20_000);
  const navigation = page.getByRole("complementary", { name: "Workspace navigation", exact: true });
  const nav = name => navigation.getByRole("button", { name: new RegExp(`^\\d+ ${name}\\b`, "u") });
  async function digest() {
    const encrypted = await page.evaluate(async () => {
      const request = globalThis.indexedDB.open("openarc-vault");
      const db = await new Promise((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(new Error("Database unavailable")); });
      try {
        const query = db.transaction("records", "readonly").objectStore("records").getAll();
        return await new Promise((resolve, reject) => { query.onsuccess = () => resolve(query.result); query.onerror = () => reject(new Error("Read unavailable")); });
      } finally { db.close(); }
    });
    assert.ok(encrypted.length >= 4, "Synthetic records must exist");
    return createHash("sha256").update(JSON.stringify(encrypted)).digest("hex");
  }
  async function recordsVisible() {
    await nav("Agent reports").click();
    await expect(page.getByRole("heading", { name: /^Imported agent report /u })).toHaveCount(1);
    await expect(page.getByRole("heading", { name: policyName, exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: /^Imported agent report /u })).toHaveText(marker.reportHeading);
    await expect(page.locator(".report-policy")).toContainText("Revision 1");
  }
  async function investigationsVisible() {
    await nav("Investigations").click();
    await expect(page.locator(".investigation-results > li")).toHaveCount(1);
    await page.getByRole("button", { name: /^Inspect /u }).click();
    await expect(page.getByRole("heading", { name: "Selected investigation", exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Chronological evidence list", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Preview redacted report", exact: true }).click();
    const preview = page.getByLabel("Redacted report preview", { exact: true });
    await expect(preview).toBeVisible();
    await expect(preview).not.toContainText(canary);
    await page.getByRole("button", { name: "Cancel report export", exact: true }).click();
  }
  stage = "load-exact-build";
  await page.goto(`${origin}/workspace`);
  await expect(page.locator('meta[name="openarc-build-sha"]')).toHaveAttribute("content", expected);
  if (mode === "seed") {
    stage = "seed-synthetic-records";
    await page.getByLabel("Workspace passphrase", { exact: false }).fill(passphrase);
    await page.getByLabel("Confirm passphrase").fill(passphrase);
    await page.getByRole("button", { name: "Create encrypted workspace", exact: true }).click();
    await page.getByRole("checkbox", { name: /I saved it somewhere private/u }).check();
    await page.getByRole("button", { name: "Continue to workspace", exact: true }).click();
    await page.getByRole("button", { name: "Skip", exact: true }).click();
    await expect(page.getByText("Tour preference saved inside the encrypted workspace.", { exact: true })).toBeVisible();
    await nav("Agents").click();
    await page.getByRole("button", { name: "Add agent profile", exact: true }).click();
    await page.getByLabel("Display name", { exact: true }).fill(canary);
    await page.getByRole("button", { name: "Encrypt and save", exact: true }).click();
    await nav("Agent reports").click();
    await page.getByRole("button", { name: "Load example report", exact: true }).click();
    await page.getByRole("button", { name: "Preview report", exact: true }).click();
    await page.getByLabel("Local agent association", { exact: true }).selectOption({ label: canary });
    await page.getByRole("checkbox", { name: /I associate this report/u }).check();
    await page.getByRole("button", { name: "Encrypt report locally", exact: true }).click();
    const report = page.getByRole("heading", { name: /^Imported agent report /u });
    await expect(report).toBeVisible();
    marker.reportHeading = await report.textContent();
    await page.getByRole("button", { name: "Add report monitoring policy", exact: true }).click();
    await page.getByLabel("Policy name", { exact: true }).fill(policyName);
    await page.getByRole("button", { name: "Save monitoring policy", exact: true }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await recordsVisible();
    marker.ciphertextDigest = await digest();
    stage = "inspect-and-preview";
    await investigationsVisible();
  } else {
    stage = "unlock-compatible-reader";
    assert.equal(await digest(), marker.ciphertextDigest);
    await page.getByLabel("Workspace passphrase", { exact: false }).fill(passphrase);
    await page.getByRole("button", { name: "Unlock workspace", exact: true }).click();
    await expect(page.getByText("UNLOCKED LOCALLY", { exact: true })).toBeVisible();
    await recordsVisible();
    if (mode === "verify" && reader === "m08") {
      await expect(nav("Investigations")).toHaveCount(0);
      await expect(page.getByRole("button", { name: "Preview redacted report", exact: true })).toHaveCount(0);
    } else await investigationsVisible();
  }
  stage = "assert-no-mutation-or-source-traffic";
  assert.equal(await digest(), marker.ciphertextDigest);
  assert.equal(sourceRequests, 0);
  assert.equal(outsideRequests, 0);
  await context.close(); context = undefined;
  marker.phase = mode;
  await writeFile(path.join(directory, "owner.json"), JSON.stringify(marker), { mode: 0o600 });
  console.log(JSON.stringify({ passed: true, mode, reader, exactBuildSha: expected, taskDirectory: directory,
    proofScope: reader === "m08" ? "schema_compatibility_only_not_safe_rollback" : "local_rollback_rollforward",
    sourceRequests: 0, ciphertextPreserved: true, investigationsAvailable: mode !== "verify" || reader === "m09" }));
} catch {
  console.error(JSON.stringify({ passed: false, stage }));
  process.exitCode = 1;
} finally {
  try { await context?.close(); }
  catch { console.error(JSON.stringify({ passed: false, stage: "close-synthetic-profile" })); process.exitCode = 1; }
  clearTimeout(watchdog);
}
