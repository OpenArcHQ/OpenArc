import { expect, test } from "@playwright/test";
test("disabled investigations deep link exposes no feature or automatic source call", async ({ page }) => {
  const requests: string[] = [];
  page.on("request", request => { if (["fetch", "xhr"].includes(request.resourceType())) requests.push(request.url()); });
  await page.goto("/workspace?view=investigations");
  await expect(page.getByRole("heading", { name: "Create a private workspace" })).toBeVisible();
  await page.getByLabel("Workspace passphrase", { exact: false }).fill("synthetic flag off passphrase");
  await page.getByLabel("Confirm passphrase").fill("synthetic flag off passphrase");
  await page.getByRole("button", { name: "Create encrypted workspace" }).click();
  await page.getByRole("checkbox", { name: /I saved it somewhere private/u }).check();
  await page.getByRole("button", { name: "Continue to workspace", exact: true }).click();
  await page.getByRole("button", { name: "Skip", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Your agent evidence, held here.", exact: true })).toBeVisible();
  await expect(page.getByRole("navigation").getByRole("button", { name: /Investigations/u })).toHaveCount(0);
  await expect(page.getByLabel("Search saved actions")).toHaveCount(0);
  expect(requests).toEqual([]);
});
