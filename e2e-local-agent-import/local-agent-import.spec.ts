import { readFile } from "node:fs/promises";
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { AgentImportSchema, type AgentAttemptEvent } from "../packages/shared/src/agent-import.js";
import { ARC_TESTNET } from "../packages/shared/src/network.js";

const passphrase = "local agent report browser passphrase";
const privateName = "PRIVATE_AGENT_IMPORT_CANARY";
const importId = "11111111-1111-4111-8111-111111111111";
const eventId = "22222222-2222-4222-8222-222222222222";
const recipient = `0x${"2".repeat(40)}`;
const contract = `0x${"3".repeat(40)}`;
const serviceDigest = `sha256:${"4".repeat(64)}`;
const exactSource = process.env.OPENARC_EXACT_SOURCE === "true";
function report(events: Partial<AgentAttemptEvent>[] = [{}], id = importId) {
  return AgentImportSchema.parse({ schemaVersion: "openarc.agent-import.v1", importId: id,
    capturedAt: "2026-09-05T12:03:00Z", connectorId: "synthetic-browser-reporter", authentication: "not_verified",
    events: events.map(event => ({ eventId, actionId: "synthetic-action-one", occurredAt: "2026-09-05T12:00:00Z",
      network: ARC_TESTNET.caip2, asset: ARC_TESTNET.contracts.usdc, decimals: 6, payer: `0x${"1".repeat(40)}`,
      recipient, amountBaseUnits: "1000", reportedStatus: "attempted", contract, serviceDigest,
      authorizationNonce: `0x${"a".repeat(64)}`, authorizationDomainDigest: `sha256:${"b".repeat(64)}`,
      approval: "reported_approved", ...event })) });
}
async function acknowledgeRecovery(page: Page) {
  const secret = await page.getByTestId("recovery-secret").innerText();
  await page.getByRole("checkbox", { name: /I saved it somewhere private/u }).check();
  await page.getByRole("button", { name: "Continue to workspace", exact: true }).click();
  return secret;
}
async function workspace(page: Page) {
  await page.goto("/workspace");
  if (exactSource) {
    expect(process.env.EXPECTED_BUILD_SHA).toMatch(/^[0-9a-f]{40}$/u);
    await expect(page.locator('meta[name="openarc-build-sha"]')).toHaveAttribute("content", process.env.EXPECTED_BUILD_SHA!);
  }
  await page.getByLabel("Workspace passphrase", { exact: false }).fill(passphrase);
  await page.getByLabel("Confirm passphrase").fill(passphrase);
  await page.getByRole("button", { name: "Create encrypted workspace" }).click();
  const recovery = await acknowledgeRecovery(page);
  await page.getByRole("button", { name: "Skip", exact: true }).click();
  await page.getByRole("button", { name: /^\d+ Agents /u }).click();
  await page.getByRole("button", { name: "Add agent profile", exact: true }).click();
  await page.getByLabel("Display name", { exact: true }).fill(privateName);
  await page.getByRole("button", { name: "Encrypt and save", exact: true }).click();
  await page.getByRole("navigation").getByRole("button", { name: /Agent reports/u }).click();
  return recovery;
}
function observeRequests(page: Page) {
  const requests: string[] = [];
  page.on("request", request => {
    if (["fetch", "xhr", "websocket"].includes(request.resourceType())) requests.push(`${request.method()} ${request.url()} ${request.postData() ?? ""}`);
  });
  return requests;
}
async function preview(page: Page, value: unknown) {
  await page.getByRole("textbox", { name: "Agent report JSON", exact: true }).fill(JSON.stringify(value));
  await page.getByRole("button", { name: "Preview report", exact: true }).click();
}
async function saveReport(page: Page, value = report()) {
  await preview(page, value);
  await page.getByLabel("Local agent association", { exact: true }).selectOption({ label: privateName });
  await page.getByRole("checkbox", { name: /I associate this report/u }).check();
  await page.getByRole("button", { name: "Encrypt report locally", exact: true }).click();
  await expect(page.getByRole("heading", { name: `Imported agent report ${value.importId}`, exact: true })).toBeVisible();
}
async function policy(page: Page, name: string, fields: Record<string, string> = {}, approval = false) {
  await page.getByRole("button", { name: "Add report monitoring policy", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Report monitoring policy", exact: true });
  await dialog.getByLabel("Policy name", { exact: true }).fill(name);
  await dialog.getByLabel("Policy agent", { exact: true }).selectOption({ label: privateName });
  await dialog.getByLabel("Policy enabled", { exact: true }).check();
  for (const [label, value] of Object.entries(fields)) await dialog.getByLabel(label, { exact: true }).fill(value);
  if (approval) await dialog.getByLabel("Require reported human approval", { exact: true }).check();
  await dialog.getByRole("button", { name: "Save monitoring policy", exact: true }).click();
  await expect(dialog).toHaveCount(0);
}
async function compare(page: Page, name: string, state: string, selectedEvent = eventId) {
  const events = page.getByLabel("Report event", { exact: true });
  const option = events.locator("option").filter({ hasText: selectedEvent });
  await events.selectOption(await option.first().getAttribute("value") ?? "");
  await page.getByLabel("Monitoring policy", { exact: true }).selectOption({ label: name });
  await page.getByRole("button", { name: "Compare locally", exact: true }).click();
  await expect(page.getByRole("heading", { name: `Comparison: ${state.replaceAll("_", " ")}`, exact: true })).toBeVisible();
}
async function encryptedRecords(page: Page) {
  return page.evaluate(async () => {
    const opening = indexedDB.open("openarc-vault");
    const db = await new Promise<IDBDatabase>((resolve, reject) => { opening.onsuccess = () => resolve(opening.result); opening.onerror = () => reject(opening.error); });
    const query = db.transaction("records", "readonly").objectStore("records").getAll();
    const values = await new Promise<unknown[]>((resolve, reject) => { query.onsuccess = () => resolve(query.result); query.onerror = () => reject(query.error); });
    db.close(); return values;
  });
}

test("local preview, explicit association, policy comparison and encrypted backup/recovery stay private", async ({ page }, info) => {
  const network = observeRequests(page);
  const recovery = await workspace(page);
  await preview(page, report());
  await expect(page.getByRole("button", { name: "Encrypt report locally", exact: true })).toBeDisabled();
  await saveReport(page);
  await policy(page, "Private exact rule", { "Per-action limit (USDC base units)": "1000" });
  await page.getByRole("navigation").getByRole("button", { name: /Overview/u }).click();
  for (const label of ["Monitoring policies", "Agent reports"]) {
    const stat = page.locator(".workspace-stat-grid article").filter({ has: page.getByText(label, { exact: true }) });
    await expect(stat.locator("strong")).toHaveText("1");
  }
  await page.getByRole("navigation").getByRole("button", { name: /Agent reports/u }).click();
  await compare(page, "Private exact rule", "within_supplied_rules");
  await page.getByText("Rules and evidence citations", { exact: true }).click();
  await expect(page.locator("details").filter({ hasText: "Rules and evidence citations" })).toContainText("not_verified");
  await page.getByText("Rules and evidence citations", { exact: true }).click();
  const raw = JSON.stringify(await encryptedRecords(page));
  for (const canary of [privateName, passphrase, recovery, importId, eventId, serviceDigest, "Private exact rule"])
    expect(raw).not.toContain(canary);
  const axe = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
  expect(axe.violations.filter(value => ["serious", "critical"].includes(value.impact ?? ""))).toEqual([]);
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath("agent-report-mobile.png"), fullPage: true });
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.reload();
  await expect(page.getByRole("heading", { name: "Unlock your private workspace" })).toBeVisible();
  await page.getByLabel("Workspace passphrase", { exact: false }).fill(passphrase);
  await page.getByRole("button", { name: "Unlock workspace", exact: true }).click();
  await page.getByRole("navigation").getByRole("button", { name: /Agent reports/u }).click();
  await compare(page, "Private exact rule", "within_supplied_rules");
  await page.getByRole("button", { name: /^\d+ Settings /u }).click();
  await page.getByLabel("Backup passphrase", { exact: true }).first().fill("private agent backup passphrase");
  const downloading = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download encrypted backup", exact: true }).click();
  const backup = await downloading;
  const backupPath = info.outputPath("agent-reports.openarc");
  await backup.saveAs(backupPath);
  const backupText = await readFile(backupPath, "utf8");
  for (const canary of [privateName, importId, eventId, serviceDigest]) expect(backupText).not.toContain(canary);
  await page.getByRole("button", { name: "Lock workspace", exact: true }).click();
  await page.getByRole("button", { name: "Recovery", exact: true }).click();
  await page.getByLabel("Recovery secret").fill(recovery);
  await page.getByLabel("New workspace passphrase").fill("recovered agent report passphrase");
  await page.getByLabel("Confirm new passphrase").fill("recovered agent report passphrase");
  await page.getByRole("button", { name: "Recover and rotate credentials", exact: true }).click();
  expect(await acknowledgeRecovery(page)).not.toBe(recovery);
  await page.getByRole("navigation").getByRole("button", { name: /Agent reports/u }).click();
  await compare(page, "Private exact rule", "within_supplied_rules");
  expect(network).toEqual([]);
  const restoredContext = await page.context().browser()!.newContext({ baseURL: new URL(page.url()).origin,
    ignoreHTTPSErrors: new URL(page.url()).hostname === "127.0.0.1", reducedMotion: "reduce" });
  try {
    const restored = await restoredContext.newPage();
    const restoredRequests = observeRequests(restored);
    await restored.goto("/workspace");
    await restored.getByRole("button", { name: "Import backup", exact: true }).click();
    await restored.getByLabel("Encrypted .openarc backup").setInputFiles({ name: "agent-reports.openarc", mimeType: "application/json", buffer: Buffer.from(backupText) });
    await restored.getByLabel("Backup passphrase").fill("private agent backup passphrase");
    await restored.getByLabel("New workspace passphrase").fill("restored report workspace passphrase");
    await restored.getByLabel("Confirm new passphrase").fill("restored report workspace passphrase");
    await restored.getByRole("button", { name: "Verify and restore backup", exact: true }).click();
    await acknowledgeRecovery(restored);
    await restored.getByRole("navigation").getByRole("button", { name: /Agent reports/u }).click();
    await compare(restored, "Private exact rule", "within_supplied_rules");
    expect(restoredRequests).toEqual([]);
  } finally { await restoredContext.close(); }
});

test("unsupported signed, future version/time, secret fields and oversized imports fail before persistence", async ({ page }) => {
  const network = observeRequests(page); await workspace(page);
  const before = (await encryptedRecords(page)).length;
  for (const [value, code] of [
    [{ ...report(), signature: `0x${"d".repeat(130)}` }, "Signed reports are not supported"],
    [{ ...report(), schemaVersion: "openarc.agent-import.v99" }, "report version is not supported"],
    [{ ...report(), capturedAt: "2099-01-01T00:00:00Z" }, "report capture is in the future"],
    [{ ...report(), events: [{ ...report().events[0], occurredAt: "2026-09-05T12:04:00Z" }] }, "unsupported fields, invalid values"],
    [{ ...report(), privateKey: "NEVER_ACCEPT_SECRET_FIELD" }, "unsupported fields, invalid values"],
  ] as const) {
    await preview(page, value); await expect(page.getByRole("alert")).toContainText(code);
  }
  await page.getByLabel("Agent report JSON file", { exact: true }).setInputFiles({ name: "oversized.json", mimeType: "application/json", buffer: Buffer.alloc(256 * 1024 + 1, " ") });
  await expect(page.getByRole("alert")).toContainText("exceeds the 256 KiB");
  expect((await encryptedRecords(page)).length).toBe(before); expect(network).toEqual([]);
});

test("per-action, recipient, contract, service, expiry and approval rules remain local and deterministic", async ({ page }) => {
  const network = observeRequests(page); await workspace(page);
  const missingId = "88888888-8888-4888-8888-888888888888";
  const deniedId = "99999999-9999-4999-8999-999999999999";
  await saveReport(page, report([{}, { eventId: missingId, actionId: "missing-facts", contract: null, serviceDigest: null,
    approval: "not_supplied", authorizationNonce: `0x${"c".repeat(64)}` },
  { eventId: deniedId, actionId: "reported-denial", approval: "reported_denied", authorizationNonce: `0x${"d".repeat(64)}` }]));
  for (const [name, fields, approval, state] of [
    ["Amount flag", { "Per-action limit (USDC base units)": "999" }, false, "flagged"],
    ["Recipient block", { "Allowed recipients": recipient, "Blocked recipients": recipient }, false, "flagged"],
    ["Contract block", { "Allowed contracts": contract, "Blocked contracts": contract }, false, "flagged"],
    ["Service block", { "Allowed service digests": serviceDigest, "Blocked service digests": serviceDigest }, false, "flagged"],
    ["Historical expiry", { "Valid before (UTC)": "2026-09-05T11:59:00Z" }, false, "flagged"],
    ["Historical future policy", { "Valid after (UTC)": "2026-09-05T12:01:00Z" }, false, "flagged"],
    ["Reported approval only", {}, true, "within_supplied_rules"],
  ] as [string, Record<string, string>, boolean, string][]) {
    await policy(page, name, fields, approval); await compare(page, name, state);
  }
  await compare(page, "Contract block", "unevaluable", missingId);
  await compare(page, "Service block", "unevaluable", missingId);
  await compare(page, "Reported approval only", "unevaluable", missingId);
  await compare(page, "Reported approval only", "flagged", deniedId);
  expect(network).toEqual([]);
});

test("daily UTC totals include supplied attempts once and never imply complete history", async ({ page }) => {
  const network = observeRequests(page); await workspace(page);
  const secondId = "33333333-3333-4333-8333-333333333333";
  await saveReport(page, report([{}, { eventId: secondId, actionId: "synthetic-action-two", amountBaseUnits: "2000", reportedStatus: "failed", authorizationNonce: null,
    authorizationDomainDigest: null }, { eventId: "44444444-4444-4444-8444-444444444444", actionId: "previous-utc-day", occurredAt: "2026-09-04T23:59:59Z",
    amountBaseUnits: "9000", authorizationNonce: null, authorizationDomainDigest: null }]));
  await policy(page, "UTC limit exact partial", { "Daily limit (USDC base units)": "3000" });
  await compare(page, "UTC limit exact partial", "unevaluable");
  await saveReport(page, report([{}], "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"));
  await compare(page, "UTC limit exact partial", "unevaluable");
  await page.getByText("Rules and evidence citations", { exact: true }).click();
  await expect(page.locator("details").filter({ hasText: "Rules and evidence citations" })).toContainText('"observedAttemptTotalBaseUnits": "3000"');
  await policy(page, "UTC supplied exceeds", { "Daily limit (USDC base units)": "2999" });
  await compare(page, "UTC supplied exceeds", "flagged");
  expect(network).toEqual([]);
});

test("duplicate imports do not double count and changed events or replayed nonces stay conflicting", async ({ page }) => {
  const network = observeRequests(page); await workspace(page); await saveReport(page);
  const before = (await encryptedRecords(page)).length;
  await preview(page, report());
  await page.getByLabel("Local agent association", { exact: true }).selectOption({ label: privateName });
  await page.getByRole("checkbox", { name: /I associate this report/u }).check();
  await page.getByRole("button", { name: "Encrypt report locally", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText(/duplicate|already|DUPLICATE/iu);
  expect((await encryptedRecords(page)).length).toBe(before);
  await saveReport(page, report([{ eventId: "55555555-5555-4555-8555-555555555555", actionId: "synthetic-replayed-action" }], "66666666-6666-4666-8666-666666666666"));
  await policy(page, "Replay review", { "Per-action limit (USDC base units)": "999999" });
  await compare(page, "Replay review", "conflicting");
  await saveReport(page, report([{ amountBaseUnits: "1001" }], "77777777-7777-4777-8777-777777777777"));
  await compare(page, "Replay review", "conflicting");
  expect(network).toEqual([]);
});

test("same-ID variants remain separately selectable and the second amount is evaluated", async ({ page }) => {
  const network = observeRequests(page); await workspace(page);
  await saveReport(page, report([{ amountBaseUnits: "1" }, { amountBaseUnits: "9" }]));
  await policy(page, "Variant amount boundary", { "Per-action limit (USDC base units)": "5" });
  await compare(page, "Variant amount boundary", "conflicting");
  await page.getByText("Rules and evidence citations", { exact: true }).click();
  const citations = page.locator("details").filter({ hasText: "Rules and evidence citations" });
  await expect(citations).toContainText("REPORTED_AMOUNT_WITHIN_PER_ACTION_LIMIT");
  const selector = page.getByLabel("Report event", { exact: true });
  const options = selector.locator("option").filter({ hasText: eventId });
  await expect(options).toHaveCount(2);
  expect(await options.nth(0).getAttribute("value")).not.toBe(await options.nth(1).getAttribute("value"));
  await selector.selectOption(await options.nth(1).getAttribute("value") ?? "");
  await page.getByRole("button", { name: "Compare locally", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Comparison: conflicting", exact: true })).toBeVisible();
  await expect(citations).toContainText("PER_ACTION_LIMIT_EXCEEDED");
  await expect(citations).toContainText('"eventIndex": 1');
  expect(network).toEqual([]);
});

test("own initialization completion cannot be mistaken for another tab by the revision poll", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(globalThis, "BroadcastChannel", { configurable: true, value: undefined });
    const descriptor = Object.getOwnPropertyDescriptor(IDBTransaction.prototype, "oncomplete")!;
    let delayed = false;
    Object.defineProperty(IDBTransaction.prototype, "oncomplete", { ...descriptor,
      set(this: IDBTransaction, callback: ((this: IDBTransaction, event: Event) => unknown) | null) {
        if (!delayed && callback && this.db.name === "openarc-vault" && this.mode === "readwrite" &&
          this.objectStoreNames.contains("vaultMeta") && this.objectStoreNames.contains("records")) {
          delayed = true;
          descriptor.set!.call(this, (event: Event) => {
            Object.assign(globalThis, { __openArcInitializationCompletionDelayed: true });
            // Delay notification, not the actual committed database transaction.
            // This exposes the own-create window to the real two-second poll.
            setTimeout(() => callback.call(this, event), 2600);
          });
        } else descriptor.set!.call(this, callback);
      },
    });
  });
  const network = observeRequests(page);
  const secret = await workspace(page);
  expect(secret).toMatch(/^OA1-[A-Za-z0-9_-]{43}$/u);
  expect(await page.evaluate(() => (globalThis as typeof globalThis & { __openArcInitializationCompletionDelayed?: boolean }).__openArcInitializationCompletionDelayed)).toBe(true);
  await expect(page.getByText("An encrypted workspace was created or restored in another tab. Unlock it here to continue.", { exact: true })).toHaveCount(0);
  await saveReport(page);
  expect(network).toEqual([]);
});
