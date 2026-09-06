import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { chromium } from "@playwright/test";
import { JobEvidenceEnvelopeSchema } from "../packages/shared/dist/index.js";

// An isolated disposable browser: never opens, imports, or edits the user's vault.
// At most two consented public job lookups. No signing, funding, or history scans.
const origin = "https://web-staging-1275.up.railway.app";
const expectedSha = process.env.EXPECTED_BUILD_SHA;
assert.match(expectedSha ?? "", /^[0-9a-f]{40}$/u, "An exact expected Git SHA is required");
const path = "/v1/private/arc/job-evidence";
const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: "reduce" });
const page = await context.newPage();
page.setDefaultTimeout(20_000);
const bodies = [];
page.on("request", (request) => {
  if (new URL(request.url()).pathname === path) bodies.push(JSON.parse(request.postData() ?? "null"));
});
const passphrase = `disposable-staging-${randomUUID()}`;
try {
  await page.goto(`${origin}/workspace?view=jobs`);
  assert.equal(await page.locator('meta[name="openarc-build-sha"]').getAttribute("content"), expectedSha);
  await page.getByLabel("Workspace passphrase", { exact: false }).fill(passphrase);
  await page.getByLabel("Confirm passphrase").fill(passphrase);
  await page.getByRole("button", { name: "Create encrypted workspace" }).click();
  await page.getByRole("checkbox", { name: /I saved it somewhere private/u }).check();
  await page.getByRole("button", { name: "Continue to workspace" }).click();
  await page.getByRole("button", { name: "Skip" }).click();
  await page.getByRole("button", { name: /08 Jobs/u }).click();
  assert.equal(bodies.length, 0);

  const observations = [];
  for (const request of [
    { network: "eip155:5042002", jobId: "1" },
    { network: "eip155:5042002", jobId: "183309",
      submissionTransactionHash: "0xcd5ce3462863f94dde78284c3a0bf4fcbbf339308513a7a3769351e7e1b81131" },
  ]) {
    await page.getByLabel("ERC-8183 job ID").fill(request.jobId);
    await page.getByLabel("Submission transaction hash (optional)").fill(request.submissionTransactionHash ?? "");
    await page.getByRole("button", { name: "Review job permission" }).click();
    assert.equal(bodies.length, observations.length);
    // Consume the body as soon as it arrives, before click auto-waiting can let
    // the application update navigation and Chromium discard the response body.
    const pending = page.waitForResponse((response) => new URL(response.url()).pathname === path && response.request().method() === "POST")
      .then(async (response) => ({ response, body: await response.json() }));
    const [{ response, body }] = await Promise.all([
      pending, page.getByRole("button", { name: "Approve and observe job" }).click(),
    ]);
    assert.equal(response.status(), 200, "Staging job lookup must succeed");
    // Nginx and the API each add no-store; repeated identical directives are safe.
    const cacheDirectives = (response.headers()["cache-control"] ?? "").split(",").map((value) => value.trim());
    assert.ok(cacheDirectives.length > 0 && cacheDirectives.every((value) => value === "no-store"));
    const envelope = JobEvidenceEnvelopeSchema.parse(body);
    assert.equal(envelope.meta.buildSha, expectedSha);
    assert.equal(envelope.data.jobId, request.jobId);
    assert.equal(envelope.data.status, "Completed");
    assert.deepEqual(bodies.at(-1), request);
    if (request.jobId === "1") {
      assert.equal(envelope.data.budget.baseUnits, "5000000");
      assert.equal(envelope.data.deliverable.availability, "not_observed");
    } else {
      assert.equal(envelope.data.deliverable.availability, "submission_event");
      assert.equal(envelope.data.deliverable.transactionHash, request.submissionTransactionHash);
    }
    await page.getByRole("heading", { name: `Job ${request.jobId}`, exact: true }).waitFor();
    observations.push({ jobId: envelope.data.jobId, status: envelope.data.status,
      anchor: envelope.data.anchor, deliverable: envelope.data.deliverable });
  }

  const raw = await page.evaluate(async () => {
    const opened = globalThis.indexedDB.open("openarc-vault");
    const db = await new Promise((resolve, reject) => { opened.onsuccess = () => resolve(opened.result); opened.onerror = () => reject(opened.error); });
    const query = db.transaction("records", "readonly").objectStore("records").getAll();
    const records = await new Promise((resolve, reject) => { query.onsuccess = () => resolve(query.result); query.onerror = () => reject(query.error); });
    db.close(); return JSON.stringify(records);
  });
  assert.equal(raw.includes(passphrase), false);
  assert.equal(raw.includes("openarc.job-evidence.v1"), false);
  await mkdir("tmp/m06-staging", { recursive: true });
  await page.screenshot({ path: "tmp/m06-staging/jobs-desktop.png", fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => globalThis.document.documentElement.scrollWidth <= globalThis.document.documentElement.clientWidth), true);
  await page.screenshot({ path: "tmp/m06-staging/jobs-mobile.png", fullPage: true });
  await page.reload();
  await page.getByRole("heading", { name: "Unlock your private workspace" }).waitFor();
  await page.getByLabel("Workspace passphrase", { exact: false }).fill(passphrase);
  await page.getByRole("button", { name: "Unlock workspace", exact: true }).click();
  await page.getByRole("heading", { name: "Job 183309", exact: true }).waitFor();
  assert.equal(bodies.length, 2);
  process.stdout.write(`${JSON.stringify({ passed: true, buildSha: expectedSha, publicLookups: bodies.length, observations })}\n`);
} finally {
  await context.close();
  await browser.close();
}
