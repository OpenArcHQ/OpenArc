import { chromium, expect } from "@playwright/test";
import path from "node:path";

const mode = process.argv[2];
if (mode !== "seed" && mode !== "verify") throw new Error("Expected seed or verify mode");
const baseURL = process.env.OPENARC_M02_COMPAT_BASE_URL ?? "https://127.0.0.1:8443";
const profile = path.resolve(process.env.OPENARC_M02_COMPAT_PROFILE ?? "tmp/m02-compat-profile");
const passphrase = "synthetic M02 receipt compatibility passphrase";
const context = await chromium.launchPersistentContext(profile, { headless: true, ignoreHTTPSErrors: true });
const page = context.pages()[0] ?? await context.newPage();
page.setDefaultTimeout(15_000);

try {
  await page.goto(`${baseURL}/workspace`);
  if (mode === "seed") {
    await page.getByLabel("Workspace passphrase", { exact: false }).fill(passphrase);
    await page.getByLabel("Confirm passphrase").fill(passphrase);
    await page.getByRole("button", { name: "Create encrypted workspace" }).click();
    await page.getByRole("checkbox", { name: /I saved it somewhere private/u }).check();
    await page.getByRole("button", { name: "Continue to workspace" }).click();
    await page.getByRole("button", { name: "Skip" }).click();
    await page.getByRole("button", { name: /06 Sources/u }).click();
    await page.getByRole("button", { name: "Review permission and check" }).click();
    await page.getByRole("button", { name: "Approve and check" }).click();
    await expect(page.getByText(/Latest: completed at/u)).toBeVisible();
  } else {
    await page.getByLabel("Workspace passphrase", { exact: false }).fill(passphrase);
    await page.getByRole("button", { name: "Unlock workspace" }).click();
    await expect(page.getByText("UNLOCKED LOCALLY")).toHaveCount(0);
    await expect(page.locator(".workspace-error")).toBeVisible();
    await page.getByRole("button", { name: "Rescue", exact: true }).click();
    const downloadPromise = page.waitForEvent("download");
    await page.getByRole("button", { name: "Download opaque rescue" }).click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toMatch(/^openarc-opaque-rescue-/u);
    await page.getByRole("button", { name: "Delete", exact: true }).click();
    await page.getByRole("checkbox", { name: "I understand this cannot be undone without a backup." }).check();
    await expect(page.getByRole("button", { name: "Permanently delete local workspace" })).toBeEnabled();
  }
} finally {
  await context.close();
}
