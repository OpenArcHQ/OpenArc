import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium, expect } from "@playwright/test";

const mode = process.argv[2];
assert.ok(mode === "seed" || mode === "verify" || mode === "restore");
const expected = mode === "verify" ? "2edbc9d2c4c9eec309603a4347e69fbe15974470" : process.env.EXPECTED_BUILD_SHA;
assert.match(expected ?? "", /^[0-9a-f]{40}$/u);
// Fixed task-only profile and loopback origin; never a user's existing browser.
const origin = "https://127.0.0.1:8444";
const directory = path.resolve("tmp/m08-reader-compat");
await mkdir(directory, { recursive: true });
const context = await chromium.launchPersistentContext(path.join(directory, "profile"), { headless: true, ignoreHTTPSErrors: true });
const page = context.pages()[0] ?? await context.newPage();
// Both sidebar and compact navigation may be rendered; select the named sidebar.
const workspaceNavigation = page.getByRole("complementary", { name: "Workspace navigation", exact: true });
page.setDefaultTimeout(20_000);
const passphrase = "synthetic M08 older reader compatibility passphrase";
const network = [];
page.on("request", request => {
  if (["fetch", "xhr"].includes(request.resourceType())) network.push(request.url());
});
async function ciphertextDigest() {
  const records = await page.evaluate(async () => {
    const request = globalThis.indexedDB.open("openarc-vault");
    const db = await new Promise((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
    try {
      const query = db.transaction("records", "readonly").objectStore("records").getAll();
      return await new Promise((resolve, reject) => { query.onsuccess = () => resolve(query.result); query.onerror = () => reject(query.error); });
    } finally { db.close(); }
  });
  return createHash("sha256").update(JSON.stringify(records)).digest("hex");
}
try {
  await page.goto(`${origin}/workspace`);
  await expect(page.locator('meta[name="openarc-build-sha"]')).toHaveAttribute("content", expected);
  if (mode === "seed") {
    await page.getByLabel("Workspace passphrase", { exact: false }).fill(passphrase);
    await page.getByLabel("Confirm passphrase").fill(passphrase);
    await page.getByRole("button", { name: "Create encrypted workspace" }).click();
    await page.getByRole("checkbox", { name: /I saved it somewhere private/u }).check();
    await page.getByRole("button", { name: "Continue to workspace" }).click();
    await page.getByRole("button", { name: "Skip", exact: true }).click();
    await workspaceNavigation.getByRole("button", { name: /^\d+ Agents\b/u }).click();
    await page.getByRole("button", { name: "Add agent profile", exact: true }).click();
    await page.getByLabel("Display name", { exact: true }).fill("Synthetic compatibility agent");
    await page.getByRole("button", { name: "Encrypt and save", exact: true }).click();
    await workspaceNavigation.getByRole("button", { name: /Agent reports/u }).click();
    await page.getByRole("button", { name: "Load example report", exact: true }).click();
    await page.getByRole("button", { name: "Preview report", exact: true }).click();
    await page.getByLabel("Local agent association", { exact: true }).selectOption({ label: "Synthetic compatibility agent" });
    await page.getByRole("checkbox", { name: /I associate this report/u }).check();
    await page.getByRole("button", { name: "Encrypt report locally", exact: true }).click();
    await expect(page.getByRole("heading", { name: /Imported agent report/u })).toBeVisible();
    await page.getByRole("button", { name: "Add report monitoring policy", exact: true }).click();
    await page.getByLabel("Policy name", { exact: true }).fill("Synthetic compatibility policy");
    await page.getByRole("button", { name: "Save monitoring policy", exact: true }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await writeFile(path.join(directory, "ciphertext.sha256"), await ciphertextDigest(), { flag: "wx", mode: 0o600 });
  } else {
    const before = await readFile(path.join(directory, "ciphertext.sha256"), "utf8");
    assert.equal(await ciphertextDigest(), before);
    await page.getByLabel("Workspace passphrase", { exact: false }).fill(passphrase);
    await page.getByRole("button", { name: "Unlock workspace", exact: true }).click();
    if (mode === "restore") {
      await expect(page.getByText("UNLOCKED LOCALLY", { exact: true })).toBeVisible();
      await workspaceNavigation.getByRole("button", { name: /Agent reports/u }).click();
      await expect(page.getByRole("heading", { name: /Imported agent report/u })).toBeVisible();
      await expect(page.getByRole("heading", { name: "Synthetic compatibility policy", exact: true })).toBeVisible();
    } else {
      await expect(page.getByText("UNLOCKED LOCALLY", { exact: true })).toHaveCount(0);
      await expect(page.locator(".workspace-error")).toContainText("Wrong passphrase or damaged workspace.");
      assert.equal(await ciphertextDigest(), before, "An incompatible reader must preserve every encrypted record");
      await page.getByRole("button", { name: "Rescue", exact: true }).click();
      const pending = page.waitForEvent("download");
      await page.getByRole("button", { name: "Download opaque rescue", exact: true }).click();
      assert.match((await pending).suggestedFilename(), /^openarc-opaque-rescue-/u);
    }
    assert.equal(await ciphertextDigest(), before);
  }
  assert.equal(network.length, 0, "Local compatibility checks must make no fetch/XHR requests");
  console.log(JSON.stringify({ passed: true, mode, exactBuildSha: expected, sourceRequests: 0, ciphertextPreserved: true }));
} finally { await context.close(); }
