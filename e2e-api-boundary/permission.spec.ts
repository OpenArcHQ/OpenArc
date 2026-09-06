import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

const passphrase = "api boundary encrypted workspace passphrase";

test("requires explicit disclosure and encrypted approval before a capability request", async ({ page }) => {
  const capabilityRequests: string[] = [];
  page.on("request", (request) => {
    if (request.url().includes("/v1/private/capabilities")) capabilityRequests.push(`${request.method()} ${request.url()} ${request.postData() ?? ""}`);
  });
  await page.goto("/workspace");
  await page.getByLabel("Workspace passphrase", { exact: false }).fill(passphrase);
  await page.getByLabel("Confirm passphrase").fill(passphrase);
  await page.getByRole("button", { name: "Create encrypted workspace" }).click();
  await page.getByRole("checkbox", { name: /I saved it somewhere private/u }).check();
  await page.getByRole("button", { name: "Continue to workspace" }).click();
  await page.getByRole("button", { name: "Skip" }).click();
  await expect(page.getByRole("button", { name: /Activity/u })).toHaveCount(0);
  await page.getByRole("button", { name: /06 Sources/u }).click();
  expect(capabilityRequests).toEqual([]);
  await expect(page.getByText("No network permissions have been approved")).toBeVisible();
  await page.getByRole("button", { name: "Review permission and check" }).click();
  await expect(page.getByRole("heading", { name: "Allow this capability check?" })).toBeVisible();
  await expect(page.getByText("Released workspace fields")).toBeVisible();
  await expect(page.getByText("None", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("No cookies or account token")).toBeVisible();
  await expect(page.getByText("GET /v1/private/capabilities", { exact: true })).toBeVisible();
  await expect(page.getByText("No upstream provider is contacted by this check.", { exact: true })).toBeVisible();
  expect(capabilityRequests).toEqual([]);
  await page.getByRole("button", { name: "Approve and check" }).click();
  await expect(page.getByText("Capability check completed", { exact: false })).toBeVisible();
  expect(capabilityRequests).toHaveLength(1);
  expect(capabilityRequests[0]).toContain("GET");
  await expect(page.getByText("1 encrypted receipt stored locally.")).toBeVisible();
  await expect(page.getByText(/Latest: completed at/u)).toBeVisible();
  await expect(page.getByText("eip155:5042002")).toBeVisible();
  const raw = await page.evaluate(async () => {
    const opened = indexedDB.open("openarc-vault");
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      opened.onsuccess = () => resolve(opened.result); opened.onerror = () => reject(opened.error);
    });
    const transaction = database.transaction(["vaultMeta", "records"], "readonly");
    const records = transaction.objectStore("records").getAll();
    const value = await new Promise<unknown[]>((resolve, reject) => {
      records.onsuccess = () => resolve(records.result); records.onerror = () => reject(records.error);
    });
    database.close();
    return value;
  });
  expect(JSON.stringify(raw)).not.toContain("openarc.permission-receipt.v1");
  expect(JSON.stringify(raw)).not.toContain("/v1/private/capabilities");
});

test("a failed encrypted approval write sends no request", async ({ page }) => {
  const requests: string[] = [];
  page.on("request", (request) => { if (request.url().includes("/v1/private/capabilities")) requests.push(request.url()); });
  await page.goto("/workspace");
  await page.getByLabel("Workspace passphrase", { exact: false }).fill(passphrase);
  await page.getByLabel("Confirm passphrase").fill(passphrase);
  await page.getByRole("button", { name: "Create encrypted workspace" }).click();
  await page.getByRole("checkbox", { name: /I saved it somewhere private/u }).check();
  await page.getByRole("button", { name: "Continue to workspace" }).click();
  await page.getByRole("button", { name: "Skip" }).click();
  await page.getByRole("button", { name: /06 Sources/u }).click();
  await page.evaluate(() => {
    const original = IDBObjectStore.prototype.put;
    Object.defineProperty(IDBObjectStore.prototype, "put", { configurable: true, value(...args: Parameters<IDBObjectStore["put"]>) {
      if (this.name === "records") throw new DOMException("Synthetic quota failure", "QuotaExceededError");
      return original.apply(this, args);
    } });
  });
  await page.getByRole("button", { name: "Review permission and check" }).click();
  await page.getByRole("button", { name: "Approve and check" }).click();
  await expect(page.getByRole("alert")).toContainText("local storage quota is full");
  expect(requests).toEqual([]);
});

test("a failed completion write reports post-network uncertainty and preserves approval", async ({ page }) => {
  const requests: string[] = [];
  page.on("request", (request) => { if (request.url().includes("/v1/private/capabilities")) requests.push(request.url()); });
  await page.goto("/workspace");
  await page.getByLabel("Workspace passphrase", { exact: false }).fill(passphrase);
  await page.getByLabel("Confirm passphrase").fill(passphrase);
  await page.getByRole("button", { name: "Create encrypted workspace" }).click();
  await page.getByRole("checkbox", { name: /I saved it somewhere private/u }).check();
  await page.getByRole("button", { name: "Continue to workspace" }).click();
  await page.getByRole("button", { name: "Skip" }).click();
  await page.getByRole("button", { name: /06 Sources/u }).click();
  await page.evaluate(() => {
    const original = IDBObjectStore.prototype.put;
    let recordWrites = 0;
    Object.defineProperty(IDBObjectStore.prototype, "put", { configurable: true, value(...args: Parameters<IDBObjectStore["put"]>) {
      if (this.name === "records" && ++recordWrites === 3) throw new DOMException("Synthetic completion quota failure", "QuotaExceededError");
      return original.apply(this, args);
    } });
  });
  await page.getByRole("button", { name: "Review permission and check" }).click();
  await page.getByRole("button", { name: "Approve and check" }).click();
  await expect(page.getByRole("alert")).toContainText("request reached OpenArc");
  expect(requests).toHaveLength(1);
  await expect(page.getByText("1 encrypted receipt stored locally.")).toBeVisible();
  await expect(page.getByText(/Latest: approved at/u)).toBeVisible();
});

test("a final receipt revision conflict immediately invalidates the stale unlocked session", async ({ context, page }) => {
  await context.addInitScript(() => { Object.defineProperty(window, "BroadcastChannel", { configurable: true, value: undefined }); });
  let releaseResponse: () => void = () => undefined;
  let sawRequest: () => void = () => undefined;
  const responseGate = new Promise<void>((resolve) => { releaseResponse = resolve; });
  const requestGate = new Promise<void>((resolve) => { sawRequest = resolve; });
  await page.route("**/v1/private/capabilities", async (route) => {
    sawRequest();
    await responseGate;
    const response = await route.fetch();
    await route.fulfill({ response });
  });
  await page.goto("/workspace");
  await page.getByLabel("Workspace passphrase", { exact: false }).fill(passphrase);
  await page.getByLabel("Confirm passphrase").fill(passphrase);
  await page.getByRole("button", { name: "Create encrypted workspace" }).click();
  await page.getByRole("checkbox", { name: /I saved it somewhere private/u }).check();
  await page.getByRole("button", { name: "Continue to workspace" }).click();
  await page.getByRole("button", { name: "Skip" }).click();
  await page.getByRole("button", { name: /06 Sources/u }).click();
  await page.getByRole("button", { name: "Review permission and check" }).click();
  await page.getByRole("button", { name: "Approve and check" }).click();
  await requestGate;

  const competing = await context.newPage();
  await competing.goto("/workspace");
  await competing.getByLabel("Workspace passphrase", { exact: false }).fill(passphrase);
  await competing.getByRole("button", { name: "Unlock workspace" }).click();
  await competing.getByRole("button", { name: /02 Agents/u }).click();
  await competing.getByRole("button", { name: "Add agent profile" }).click();
  await competing.getByLabel("Display name").fill("Synthetic competing revision");
  await competing.getByRole("button", { name: "Encrypt and save" }).click();
  await expect(competing.getByRole("heading", { name: "Synthetic competing revision" })).toBeVisible();
  releaseResponse();

  await expect(page.getByRole("heading", { name: "Unlock your private workspace" })).toBeVisible({ timeout: 1_500 });
  await expect(page.getByText("Capability check completed", { exact: false })).toHaveCount(0);
  await expect(page.getByText("Latest accepted result")).toHaveCount(0);
});

test("locking during a delayed request cancels the operation and preserves only its encrypted approval", async ({ page }) => {
  let releaseResponse: () => void = () => undefined;
  let sawRequest: () => void = () => undefined;
  const responseGate = new Promise<void>((resolve) => { releaseResponse = resolve; });
  const requestGate = new Promise<void>((resolve) => { sawRequest = resolve; });
  await page.route("**/v1/private/capabilities", async (route) => {
    sawRequest();
    await responseGate;
    try {
      const response = await route.fetch();
      await route.fulfill({ response });
    } catch { await route.abort().catch(() => undefined); }
  });
  await page.goto("/workspace");
  await page.getByLabel("Workspace passphrase", { exact: false }).fill(passphrase);
  await page.getByLabel("Confirm passphrase").fill(passphrase);
  await page.getByRole("button", { name: "Create encrypted workspace" }).click();
  await page.getByRole("checkbox", { name: /I saved it somewhere private/u }).check();
  await page.getByRole("button", { name: "Continue to workspace" }).click();
  await page.getByRole("button", { name: "Skip" }).click();
  await page.getByRole("button", { name: /06 Sources/u }).click();
  await page.getByRole("button", { name: "Review permission and check" }).click();
  await page.getByRole("button", { name: "Approve and check" }).click();
  await requestGate;
  await page.getByRole("button", { name: "Lock workspace" }).click();
  await expect(page.getByRole("heading", { name: "Unlock your private workspace" })).toBeVisible();
  releaseResponse();
  await page.getByLabel("Workspace passphrase", { exact: false }).fill(passphrase);
  await page.getByRole("button", { name: "Unlock workspace" }).click();
  await page.getByRole("button", { name: /06 Sources/u }).click();
  await expect(page.getByText(/Latest: approved at/u)).toBeVisible();
  await expect(page.getByText("Capability check completed", { exact: false })).toHaveCount(0);
  await expect(page.getByText("eip155:5042002")).toHaveCount(0);
});

test("the Sources disclosure is readable and passes serious accessibility checks on mobile", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/workspace");
  await page.getByLabel("Workspace passphrase", { exact: false }).fill(passphrase);
  await page.getByLabel("Confirm passphrase").fill(passphrase);
  await page.getByRole("button", { name: "Create encrypted workspace" }).click();
  await page.getByRole("checkbox", { name: /I saved it somewhere private/u }).check();
  await page.getByRole("button", { name: "Continue to workspace" }).click();
  await page.getByRole("button", { name: "Skip" }).click();
  await page.getByRole("button", { name: "Sources", exact: true }).click();
  await page.getByRole("button", { name: "Review permission and check" }).click();
  await expect(page.getByRole("heading", { name: "Allow this capability check?" })).toBeVisible();
  await expect(page.getByText("No cookies or account token")).toBeVisible();
  await expect(page.getByText("GET /v1/private/capabilities", { exact: true })).toBeVisible();
  await expect(page.getByText("No upstream provider is contacted by this check.", { exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();
  expect(results.violations.filter((violation) => ["serious", "critical"].includes(violation.impact ?? ""))).toEqual([]);
});
