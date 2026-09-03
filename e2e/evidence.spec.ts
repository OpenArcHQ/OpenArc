import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

test("explores every fixture with graph/list parity, keyboard tabs, and no private side effects", async ({
  page,
  baseURL,
}) => {
  const appOrigin = new URL(baseURL ?? "").origin;
  const externalRequests: string[] = [];
  const dynamicRequests: string[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.origin !== appOrigin) externalRequests.push(request.url());
    if (/\/(v1|rpc|graphql)(\/|\?|$)/u.test(url.pathname)) dynamicRequests.push(request.url());
  });

  await page.goto("/");
  await expect(page.getByText("M02 · ENCRYPTED WORKSPACE")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Read the evidence before the conclusion." })).toBeVisible();

  const selectedTab = page.getByRole("tab", { selected: true });
  await expect(selectedTab).toContainText("Complete evidence arc");
  await selectedTab.press("ArrowRight");
  await expect(page.getByRole("tab", { selected: true })).toContainText("Settlement without intent");
  await expect(page.getByRole("heading", { name: "INTENT NOT SUPPLIED" })).toBeVisible();
  await page.getByRole("tab", { selected: true }).press("End");
  await expect(page.getByRole("tab", { selected: true })).toContainText("Settled, then refunded");
  await expect(page.getByRole("heading", { name: "REFUNDED", exact: true })).toBeVisible();
  await page.getByRole("tab", { selected: true }).press("Home");

  const graphLinks = page.getByTestId("evidence-graph").getByRole("link");
  const listItems = page.getByTestId("evidence-list").locator(":scope > li");
  await expect(graphLinks).toHaveCount(await listItems.count());
  const graphTargets = await graphLinks.evaluateAll((links) =>
    links.map((link) => (link as HTMLAnchorElement).hash.slice(1)),
  );
  const listIds = await listItems.evaluateAll((items) => items.map((item) => item.id));
  expect(graphTargets).toEqual(listIds);

  await graphLinks.first().focus();
  await graphLinks.first().press("Enter");
  await expect(listItems.first()).toBeFocused();
  await expect(page.getByTestId("result-evidence-citation")).not.toBeEmpty();

  const firstFacts = listItems.first().getByRole("region", { name: /normalized facts/iu });
  await expect(firstFacts.getByText("Network", { exact: true })).toBeVisible();
  await expect(firstFacts.getByText("Authorization nonce", { exact: true })).toBeVisible();

  await page.getByRole("tab", { name: /Recipient conflict/u }).click();
  const conflictRecipients = page.getByTestId("evidence-list").getByText("Recipient", { exact: true });
  await expect(conflictRecipients).toHaveCount(5);
  await expect(page.getByRole("heading", { name: "CONFLICTING EVIDENCE" })).toBeVisible();

  const storage = await page.evaluate(async () => ({
    local: localStorage.length,
    session: sessionStorage.length,
    caches: await caches.keys(),
    databases: await indexedDB.databases(),
  }));
  expect(storage).toEqual({ local: 0, session: 0, caches: [], databases: [] });
  expect(externalRequests).toEqual([]);
  expect(dynamicRequests).toEqual([]);
});

test("passes a full-document serious accessibility scan with the explorer rendered", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("tab", { name: /Recipient conflict/u }).click();

  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();
  expect(results.violations.filter((violation) => ["serious", "critical"].includes(violation.impact ?? ""))).toEqual([]);
});

test("keeps essential controls usable on mobile and under reduced motion", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/");

  const tabs = page.getByRole("tab");
  for (let index = 0; index < (await tabs.count()); index += 1) {
    const box = await tabs.nth(index).boundingBox();
    expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
    expect(box?.width ?? 0).toBeGreaterThanOrEqual(44);
  }
  await tabs.nth(2).click();
  await expect(page.getByRole("heading", { name: "CONFLICTING EVIDENCE" })).toBeVisible();
  await expect(page.locator(".fixture-tabs button").first()).toHaveCSS("transition-duration", "0s");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});
