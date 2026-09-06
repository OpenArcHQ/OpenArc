import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { jobTestEnvelope, JOB_TEST_REQUEST } from "../test-fixtures/job-evidence.js";

const passphrase = "synthetic job evidence workspace passphrase";
const path = "/v1/private/arc/job-evidence";
const exactSource = process.env.OPENARC_EXACT_SOURCE === "true";

async function createWorkspace(page: Page) {
  await page.goto("/workspace");
  await page.getByLabel("Workspace passphrase", { exact: false }).fill(passphrase);
  await page.getByLabel("Confirm passphrase").fill(passphrase);
  await page.getByRole("button", { name: "Create encrypted workspace" }).click();
  await page.getByRole("checkbox", { name: /I saved it somewhere private/u }).check();
  await page.getByRole("button", { name: "Continue to workspace" }).click();
  await page.getByRole("button", { name: "Skip" }).click();
  await page.getByRole("button", { name: /08 Jobs/u }).click();
}

async function rawRecords(page: Page) {
  return page.evaluate(async () => {
    const opened = indexedDB.open("openarc-vault");
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      opened.onsuccess = () => resolve(opened.result); opened.onerror = () => reject(opened.error);
    });
    const query = db.transaction("records", "readonly").objectStore("records").getAll();
    const records = await new Promise<unknown[]>((resolve, reject) => {
      query.onsuccess = () => resolve(query.result); query.onerror = () => reject(query.error);
    });
    db.close(); return records;
  });
}

test("explicit consent saves encrypted job evidence and preserves exact meanings across unlock", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByText("M06 · JOB EVIDENCE", { exact: true })).toBeVisible();
  await expect(page.getByLabel("Current build status")).toContainText("agent-registry, and reference-job observations");
  const bodies: string[] = [];
  let release: () => void = () => undefined;
  let contact: () => void = () => undefined;
  const waiting = new Promise<void>((resolve) => { release = resolve; });
  const contacted = new Promise<void>((resolve) => { contact = resolve; });
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === path) { bodies.push(request.postData() ?? ""); contact(); }
  });
  if (!exactSource) await page.route(`**${path}`, async (route) => {
    await waiting;
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(jobTestEnvelope()) });
  });
  await createWorkspace(page);
  await page.getByLabel("ERC-8183 job ID").fill("1");
  await page.getByRole("button", { name: "Review job permission" }).click();
  await expect(page.getByRole("dialog")).toContainText("Local action link, labels, and notes");
  expect(bodies).toEqual([]);
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  expect(bodies).toEqual([]);
  await page.getByRole("button", { name: "Review job permission" }).click();
  await page.getByRole("button", { name: "Approve and observe job" }).click();
  await contacted;
  if (!exactSource) {
    expect((await rawRecords(page)).length).toBe(3); // sentinel, settings, encrypted approval
    release();
  }
  await expect(page.getByRole("heading", { name: "Job 1", exact: true })).toBeVisible();
  await expect(page.getByText("Recorded status:", { exact: false })).toContainText("Submitted");
  await expect(page.getByText("Recorded budget", { exact: true }).locator("..")).toContainText("1234567890123456789.012345 USDC");
  await expect(page.getByText("Deadline", { exact: true }).locator("..")).toContainText("Reached at observation block");
  await expect(page.getByText("Not observed. getJob does not return a digest.", { exact: true })).toBeVisible();
  await expect(page.getByText("<script>PUBLIC_UNTRUSTED_JOB_DESCRIPTION</script>", { exact: true })).toBeVisible();
  expect(JSON.parse(bodies[0]!)).toEqual(JOB_TEST_REQUEST);
  const raw = JSON.stringify(await rawRecords(page));
  for (const canary of [passphrase, "PUBLIC_UNTRUSTED_JOB_DESCRIPTION", jobTestEnvelope().data.client, "openarc.job-evidence.v1"]) expect(raw).not.toContain(canary);
  const a11y = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
  expect(a11y.violations.filter((violation) => ["serious", "critical"].includes(violation.impact ?? ""))).toEqual([]);
  if (!exactSource) {
    await page.screenshot({ path: `tmp/m06-jobs-${test.info().project.name}.png`, fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    await page.screenshot({ path: `tmp/m06-jobs-mobile-${test.info().project.name}.png`, fullPage: true });
    await page.setViewportSize({ width: 1280, height: 900 });
  }
  await page.reload();
  await expect(page.getByRole("heading", { name: "Unlock your private workspace" })).toBeVisible();
  await page.getByLabel("Workspace passphrase", { exact: false }).fill(passphrase);
  await page.getByRole("button", { name: "Unlock workspace", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Job 1", exact: true })).toBeVisible();
  expect(bodies).toHaveLength(1);
});

test("malformed input and canceled permission send nothing; mobile has no horizontal overflow", async ({ page }) => {
  test.skip(exactSource, "Local failure-path journey.");
  const requests: string[] = [];
  page.on("request", (request) => { if (new URL(request.url()).pathname === path) requests.push(request.url()); });
  await createWorkspace(page);
  for (const value of ["1.0", "garbage", "01", "0"]) {
    await page.getByLabel("ERC-8183 job ID").fill(value);
    await page.getByRole("button", { name: "Review job permission" }).click();
    await expect(page.getByRole("alert")).toContainText("positive decimal job ID");
  }
  expect(requests).toEqual([]);
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
});

test("a failed refresh preserves earlier evidence and records failure without leaking private fields", async ({ page }) => {
  test.skip(exactSource, "Local failure-path journey.");
  let calls = 0;
  await page.route(`**${path}`, async (route) => {
    calls += 1;
    await route.fulfill({ status: calls === 1 ? 200 : 404, contentType: "application/json",
      body: JSON.stringify(calls === 1 ? jobTestEnvelope() : { ok: false,
        error: { code: "SOURCE_NOT_FOUND", message: "Source evidence was not found." }, meta: jobTestEnvelope().meta }) });
  });
  await createWorkspace(page);
  await page.getByLabel("ERC-8183 job ID").fill("1");
  await page.getByRole("button", { name: "Review job permission" }).click();
  await page.getByRole("button", { name: "Approve and observe job" }).click();
  await expect(page.getByRole("heading", { name: "Job 1", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Load identifiers to refresh" }).click();
  await page.getByRole("button", { name: "Review job permission" }).click();
  await page.getByRole("button", { name: "Approve and observe job" }).click();
  await expect(page.getByText("STALE · LAST REFRESH FAILED", { exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Job 1", exact: true })).toHaveCount(1);
  await page.getByRole("button", { name: "Delete job evidence" }).click();
  await expect(page.getByRole("heading", { name: "No job evidence yet" })).toBeVisible();
});

test("explicit local action association never changes or releases the private action", async ({ page }) => {
  test.skip(exactSource, "Local association journey.");
  const bodies: string[] = [];
  await page.route(`**${path}`, async (route) => {
    bodies.push(route.request().postData() ?? "");
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(jobTestEnvelope()) });
  });
  await createWorkspace(page);
  await page.getByRole("button", { name: /05 Evidence/u }).click();
  await page.getByRole("button", { name: "Copy into workspace", exact: true }).first().click();
  await expect(page.getByRole("button", { name: "Already encrypted", exact: true }).first()).toBeVisible();
  await page.getByRole("button", { name: /08 Jobs/u }).click();
  await page.getByLabel("ERC-8183 job ID").fill("1");
  await page.getByLabel("Link to a local action (optional)").selectOption({ index: 1 });
  await page.getByRole("button", { name: "Review job permission" }).click();
  expect(bodies).toEqual([]);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.getByRole("checkbox", { name: /I explicitly associate this job/u }).check();
  await page.getByRole("button", { name: "Review job permission" }).click();
  await page.getByRole("button", { name: "Approve and observe job" }).click();
  await expect(page.getByText("EXPLICIT LOCAL ASSOCIATION · NOT VERIFIED", { exact: true })).toBeVisible();
  await expect(page.getByText("does not overwrite this action", { exact: false })).toBeVisible();
  expect(JSON.parse(bodies[0]!)).toEqual(JOB_TEST_REQUEST);
  expect(bodies[0]).not.toContain("action_");
});
