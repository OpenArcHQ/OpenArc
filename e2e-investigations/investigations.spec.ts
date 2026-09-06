import { expect, test, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { ARC_TESTNET } from "../packages/shared/src/network.js";
const passphrase = "synthetic investigations browser passphrase";
const privateName = "PRIVATE_INVESTIGATION_LABEL_CANARY";
const exactSource = process.env.OPENARC_EXACT_SOURCE === "true";
const nav = (page: Page, name: string) => page.getByRole("navigation").getByRole("button", { name: new RegExp(`^\\d+ ${name}\\b`, "u") });
function requests(page: Page) { const values: string[] = []; page.on("request", request => { if (["fetch", "xhr"].includes(request.resourceType())) values.push(`${request.method()} ${request.url()}`); }); return values; }
async function create(page: Page) {
  await page.goto("/workspace?view=investigations");
  if (exactSource) { expect(process.env.EXPECTED_BUILD_SHA).toMatch(/^[0-9a-f]{40}$/u); await expect(page.locator('meta[name="openarc-build-sha"]')).toHaveAttribute("content", process.env.EXPECTED_BUILD_SHA!); }
  await page.getByLabel("Workspace passphrase", { exact: false }).fill(passphrase); await page.getByLabel("Confirm passphrase").fill(passphrase);
  await page.getByRole("button", { name: "Create encrypted workspace" }).click();
  await page.getByRole("checkbox", { name: /I saved it somewhere private/u }).check(); await page.getByRole("button", { name: "Continue to workspace", exact: true }).click();
  await page.getByRole("button", { name: "Skip", exact: true }).click();
  await expect(page.getByText("Tour preference saved inside the encrypted workspace.", { exact: true })).toBeVisible();
}
async function fixtures(page: Page) {
  await nav(page, "Evidence").click();
  for (let i = 0; i < 2; i += 1) { await page.getByRole("button", { name: "Copy into workspace", exact: true }).first().click(); await expect(page.getByRole("button", { name: "Already encrypted", exact: true })).toHaveCount(i + 1); }
  await nav(page, "Investigations").click();
}
async function report(page: Page, count = 1) {
  await nav(page, "Agents").click(); await page.getByRole("button", { name: "Add agent profile", exact: true }).click();
  await page.getByLabel("Display name", { exact: true }).fill(privateName); await page.getByRole("button", { name: "Encrypt and save", exact: true }).click();
  await nav(page, "Agent reports").click();
  const data = { schemaVersion: "openarc.agent-import.v1", importId: "11111111-1111-4111-8111-111111111111", capturedAt: "2026-09-05T12:03:00Z", connectorId: "synthetic-investigation-reporter", authentication: "not_verified",
    events: Array.from({ length: count }, (_, index) => ({ eventId: `22222222-2222-4222-8222-${String(index).padStart(12, "0")}`, actionId: `synthetic-action-${String(index).padStart(2, "0")}`, occurredAt: "2026-09-05T12:00:00Z", network: ARC_TESTNET.caip2, asset: ARC_TESTNET.contracts.usdc, decimals: 6, payer: `0x${"1".repeat(40)}`, recipient: `0x${"2".repeat(40)}`, amountBaseUnits: "1000", reportedStatus: index === 0 ? "failed" : "attempted", contract: null, serviceDigest: null, authorizationNonce: null, authorizationDomainDigest: null, approval: "not_supplied" })) };
  await page.getByRole("textbox", { name: "Agent report JSON", exact: true }).fill(JSON.stringify(data)); await page.getByRole("button", { name: "Preview report", exact: true }).click();
  await page.getByLabel("Local agent association", { exact: true }).selectOption({ label: privateName }); await page.getByRole("checkbox", { name: /I associate this report/u }).check();
  await page.getByRole("button", { name: "Encrypt report locally", exact: true }).click(); await expect(page.getByRole("heading", { name: `Imported agent report ${data.importId}` })).toBeVisible();
  await nav(page, "Investigations").click();
  return data;
}
test("saved fixtures have identical graph/list facts, local filters and honest source history", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  const network = requests(page); await create(page); await fixtures(page);
  await page.getByRole("button", { name: /^Inspect /u }).first().click();
  await expect(page.getByRole("heading", { name: "Selected investigation", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Selected investigation", exact: true })).toBeFocused();
  await expect(page.getByRole("heading", { name: "Chronological evidence list", exact: true })).toBeVisible();
  await page.getByLabel("Show evidence graph", { exact: true }).check();
  for (let index = 0; index < 3; index += 1) {
    await expect(page.getByLabel("Show evidence graph", { exact: true })).toBeChecked();
    await page.getByLabel("Show evidence graph", { exact: true }).uncheck();
    await expect(page.getByLabel("Show evidence graph", { exact: true })).not.toBeChecked();
    await page.getByLabel("Show evidence graph", { exact: true }).check();
  }
  const list = await page.locator('.investigation-evidence > [data-node-key]').evaluateAll(elements => elements.map(element => element.getAttribute("data-node-key")));
  const graph = await page.locator('.investigation-graph svg [data-node-key]').evaluateAll(elements => elements.map(element => element.getAttribute("data-node-key")));
  expect(list.length).toBeGreaterThan(0); expect(graph).toEqual(list);
  const nodeTitles = await page.locator(".investigation-evidence > li > h5").allTextContents();
  for (const title of nodeTitles) await expect(page.locator(".investigation-graph svg text").filter({ hasText: title })).toHaveCount(1);
  expect(new Set(nodeTitles).size).toBeGreaterThan(1);
  await page.getByRole("button", { name: /^Evidence 1:/u }).click(); await expect(page.locator("#investigation-node-0")).toBeFocused();
  await page.getByRole("button", { name: "Preview redacted report", exact: true }).click();
  await expect(page.getByLabel("Redacted report preview", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: /^Inspect /u }).nth(1).click();
  await expect(page.getByLabel("Redacted report preview", { exact: true })).toHaveCount(0);
  await page.getByLabel("Source class filter", { exact: true }).selectOption("synthetic_fixture");
  await expect(page.locator(".investigation-results")).toContainText("synthetic fixture");
  await page.getByLabel("Search saved actions", { exact: true }).fill("no such private action"); await expect(page.locator(".investigation-results > li")).toHaveCount(0);
  expect(page.url()).not.toContain("no%20such"); await page.getByLabel("Search saved actions", { exact: true }).fill("");
  await page.getByLabel("Exceptions only", { exact: true }).check();
  await expect(page.locator(".investigation-results")).not.toContainText("synthetic complete");
  await expect(page.getByRole("heading", { name: "Saved source history", exact: true })).toBeVisible();
  await page.getByText("Review saved source checks", { exact: true }).click();
  await expect(page.locator(".investigation-source-history > li")).toHaveCount(6);
  await expect(page.locator(".investigation-source-history")).toContainText("never checked"); expect(network).toEqual([]);
  await page.getByRole("button", { name: "Preview redacted report", exact: true }).click();
  await nav(page, "Overview").click(); await nav(page, "Investigations").click();
  await expect(page.getByLabel("Redacted report preview", { exact: true })).toHaveCount(0);
  await expect(page.getByLabel("Exceptions only", { exact: true })).not.toBeChecked();
});
test("redacted preview is allowlisted, optional exact values require consent, cancellation and lock clear private state", async ({ page }) => {
  const network = requests(page); await create(page); const data = await report(page);
  await page.getByRole("button", { name: /^Inspect /u }).first().click();
  await page.getByRole("button", { name: "Preview redacted report", exact: true }).click();
  const preview = page.getByLabel("Redacted report preview", { exact: true });
  const redacted = await preview.locator("pre").innerText(); JSON.parse(redacted);
  for (const canary of [privateName, data.importId, data.events[0]!.payer, data.events[0]!.eventId, "synthetic-investigation-reporter", "2026-09-05", '"1000"']) expect(redacted).not.toContain(canary);
  await page.getByRole("button", { name: "Cancel report export", exact: true }).click(); await expect(preview).toHaveCount(0);
  for (const label of ["Include identifiers", "Include exact amounts", "Include timestamps"]) await page.getByLabel(label, { exact: true }).check();
  await page.getByRole("button", { name: "Preview redacted report", exact: true }).click(); const included = await preview.locator("pre").innerText();
  expect(included).toContain(data.events[0]!.payer); expect(included).toContain("1000"); expect(included).toContain("2026-09-05"); expect(included).not.toContain(privateName);
  const downloadPromise = page.waitForEvent("download"); await page.getByRole("button", { name: "Download plaintext report", exact: true }).click(); const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe("openarc-investigation-report.json");
  const stream = await download.createReadStream(); const chunks: Buffer[] = []; for await (const chunk of stream!) chunks.push(Buffer.from(chunk)); expect(Buffer.concat(chunks).toString("utf8")).toBe(included);
  await page.getByRole("button", { name: "Lock workspace", exact: true }).click(); await expect(preview).toHaveCount(0); await expect(page.getByLabel("Search saved actions", { exact: true })).toHaveCount(0);
  await page.getByLabel("Workspace passphrase", { exact: false }).fill(passphrase); await page.getByRole("button", { name: "Unlock workspace", exact: true }).click(); await nav(page, "Investigations").click();
  await expect(page.getByLabel("Search saved actions", { exact: true })).toHaveValue(""); await expect(page.getByRole("heading", { name: "Selected investigation", exact: true })).toHaveCount(0); expect(network).toEqual([]);
});
test("bounded reports paginate search and compare explicit monitoring rules without network", async ({ page }) => {
  const network = requests(page); await create(page); await report(page, 26);
  await expect(page.locator(".investigation-results > li")).toHaveCount(25); await page.getByRole("button", { name: "Next results", exact: true }).click(); await expect(page.locator(".investigation-results > li")).toHaveCount(1);
  await page.getByRole("button", { name: "Previous results", exact: true }).click(); await page.getByLabel("Status filter", { exact: true }).selectOption("reported_failure"); await expect(page.locator(".investigation-results > li")).toHaveCount(1);
  await nav(page, "Agent reports").click(); await page.getByRole("button", { name: "Add report monitoring policy", exact: true }).click();
  await page.getByLabel("Policy name", { exact: true }).fill("PRIVATE_POLICY_CANARY"); await page.getByLabel("Policy agent", { exact: true }).selectOption({ label: privateName });
  await page.getByLabel("Per-action limit (USDC base units)", { exact: true }).fill("999"); await page.getByRole("button", { name: "Save monitoring policy", exact: true }).click();
  await nav(page, "Investigations").click(); await page.getByRole("button", { name: /^Inspect /u }).first().click();
  await expect(page.locator(".investigation-comparison")).toHaveCount(0);
  await page.getByLabel("Investigation monitoring policy", { exact: true }).selectOption({ label: "PRIVATE_POLICY_CANARY" });
  await expect(page.locator(".investigation-comparison")).toHaveCount(0); await page.getByRole("button", { name: "Compare selected policy", exact: true }).click();
  await expect(page.locator(".investigation-comparison")).toContainText("PER_ACTION_LIMIT_EXCEEDED");
  await expect(page.locator(".investigation-comparison")).toContainText("needs review");
  await expect(page.locator(".investigation-evidence")).toContainText("1000"); expect(network).toEqual([]);
});
test("mobile, keyboard and reduced-motion investigations retain a semantic accessible list", async ({ page }, info) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  const network = requests(page); await create(page); await fixtures(page); await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: /^Inspect /u }).first().click(); await expect(page.locator(".investigation-graph")).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Selected investigation", exact: true })).toBeFocused();
  const fullFacts = page.locator(".investigation-evidence > li").first().getByText(/^Inspect all \d+ facts and limitations$/u);
  await fullFacts.focus(); await page.keyboard.press("Enter");
  await expect(page.locator(".investigation-evidence > li").first().getByRole("heading", { name: "expected", exact: true })).toBeVisible();
  await page.keyboard.press("Enter");
  await page.getByLabel("Search saved actions", { exact: true }).focus(); await page.keyboard.press("Tab"); await expect(page.getByLabel("Status filter", { exact: true })).toBeFocused();
  await page.getByLabel("Show evidence graph", { exact: true }).check();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  expect(await page.evaluate(() => matchMedia("(prefers-reduced-motion: reduce)").matches)).toBe(true);
  expect(await page.locator(".investigation-graph").evaluate(element => getComputedStyle(element).transitionDuration)).toBe("0s");
  const axe = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze(); expect(axe.violations.filter(violation => ["serious", "critical"].includes(violation.impact ?? ""))).toEqual([]);
  await page.screenshot({ path: info.outputPath("investigations-mobile.png"), fullPage: true }); expect(network).toEqual([]);
  await page.getByRole("heading", { name: "Selected investigation", exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: info.outputPath("investigations-mobile-viewport.png") });
  await page.setViewportSize({ width: 1440, height: 1000 }); await page.screenshot({ path: info.outputPath("investigations-desktop.png"), fullPage: true });
  await page.getByRole("heading", { name: "Selected investigation", exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: info.outputPath("investigations-desktop-viewport.png") });
});
