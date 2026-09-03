import { expect, test } from "@playwright/test";

const passphrase = "production artifact workspace passphrase";
const privateCanary = "PRODUCTION_ARTIFACT_PRIVATE_CANARY";

test("runs M02 from the exact feature-on production image under its local-only CSP", async ({ page }) => {
  const requests: string[] = [];
  page.on("request", (request) => requests.push(`${request.method()} ${request.url()} ${request.postData() ?? ""}`));

  const response = await page.goto("/workspace");
  expect(response?.status()).toBe(200);
  const csp = response?.headers()["content-security-policy"] ?? "";
  expect(csp).toContain("connect-src 'none'");
  expect(csp).toContain("worker-src 'none'");
  expect(csp).toContain("object-src 'none'");
  await expect(page.getByRole("heading", { name: "Create a private workspace" })).toBeVisible();
  await expect(page.getByTestId("build-sha")).toContainText(
    process.env.EXPECTED_BUILD_SHA ?? "production-e2e",
  );

  await page.getByLabel("Workspace passphrase", { exact: false }).fill(passphrase);
  await page.getByLabel("Confirm passphrase").fill(passphrase);
  await page.getByRole("button", { name: "Create encrypted workspace" }).click();
  const recoverySecret = await page.getByTestId("recovery-secret").innerText();
  await page.getByRole("checkbox", { name: /I saved it somewhere private/u }).check();
  await page.getByRole("button", { name: "Continue to workspace" }).click();
  await page.getByRole("button", { name: "Skip" }).click();
  await page.getByRole("button", { name: /02 Agents/u }).click();
  await page.getByRole("button", { name: "Add agent profile" }).click();
  await page.getByLabel("Display name").fill(privateCanary);
  await page.getByRole("button", { name: "Encrypt and save" }).click();
  await expect(page.getByRole("heading", { name: privateCanary })).toBeVisible();

  const raw = await page.evaluate(async () => {
    const request = indexedDB.open("openarc-vault");
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      const transaction = database.transaction(["vaultMeta", "records"], "readonly");
      const metaRequest = transaction.objectStore("vaultMeta").get("active");
      const recordRequest = transaction.objectStore("records").getAll();
      return await Promise.all([
        new Promise((resolve, reject) => {
          metaRequest.onsuccess = () => resolve(metaRequest.result);
          metaRequest.onerror = () => reject(metaRequest.error);
        }),
        new Promise((resolve, reject) => {
          recordRequest.onsuccess = () => resolve(recordRequest.result);
          recordRequest.onerror = () => reject(recordRequest.error);
        }),
      ]);
    } finally {
      database.close();
    }
  });
  const rawText = JSON.stringify(raw);
  expect(rawText).not.toContain(privateCanary);
  expect(rawText).not.toContain(passphrase);
  expect(rawText).not.toContain(recoverySecret);
  expect(requests.join("\n")).not.toContain(privateCanary);

  await page.getByRole("button", { name: "Lock workspace" }).click();
  await expect(page.getByRole("heading", { name: "Unlock your private workspace" })).toBeVisible();
  await expect(page.getByText(privateCanary)).toHaveCount(0);
});
