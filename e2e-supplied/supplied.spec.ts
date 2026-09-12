import { expect, test, type Page } from "@playwright/test";

const ROUTES = ["/design", "/design/docs", "/design/faq"] as const;
const WIDTHS = [320, 390, 1280] as const;
const MOUNT_SELECTOR = "#supplied-main-content";
const MOUNT_TIMEOUT_MS = 20_000;

const ROUTE_HEADINGS: Record<(typeof ROUTES)[number], RegExp> = {
  "/design": /The commerce layer/u,
  "/design/docs": /Canonical engineering documents/u,
  "/design/faq": /Dedicated questions and answers/u,
};

async function waitForRoute(page: Page, route: (typeof ROUTES)[number]): Promise<void> {
  await page.goto(route);
  await waitForMount(page);
  await expect(page.getByRole("heading", { name: ROUTE_HEADINGS[route] })).toBeVisible();
}

/** Waits for the lazily-loaded design shell to actually mount before asserting. */
async function waitForMount(page: Page): Promise<void> {
  await page.waitForSelector(MOUNT_SELECTOR, { state: "visible", timeout: MOUNT_TIMEOUT_MS });
}

interface ProbeWindow {
  __walletCalls?: string[];
  __fetchCalls?: string[];
  __xhrCalls?: string[];
  __storageWrites?: string[];
  __cspViolations?: string[];
}

async function installProbes(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const w = window as typeof window & ProbeWindow;
    w.__walletCalls = [];
    w.__fetchCalls = [];
    w.__xhrCalls = [];
    w.__storageWrites = [];
    w.__cspViolations = [];

    window.addEventListener("securitypolicyviolation", (event) => {
      w.__cspViolations?.push(`${event.violatedDirective} ${event.blockedURI}`);
    });

    const walletProbe = new Proxy(
      {},
      {
        get(_target, property) {
          w.__walletCalls?.push(String(property));
          return () => {
            w.__walletCalls?.push(`invoke:${String(property)}`);
            return Promise.reject(new Error("wallet access blocked by test probe"));
          };
        },
      },
    );
    Object.defineProperty(window, "ethereum", {
      configurable: true,
      get() {
        w.__walletCalls?.push("ethereum");
        return walletProbe;
      },
    });

    const originalFetch = window.fetch.bind(window);
    Object.defineProperty(window, "fetch", {
      configurable: true,
      value: (input: RequestInfo | URL, init?: RequestInit) => {
        w.__fetchCalls?.push(String(input));
        return originalFetch(input, init);
      },
    });

    const originalOpen = XMLHttpRequest.prototype.open;
    Object.defineProperty(XMLHttpRequest.prototype, "open", {
      configurable: true,
      value(this: XMLHttpRequest, method: string, url: string | URL, ...rest: unknown[]) {
        w.__xhrCalls?.push(`${method} ${String(url)}`);
        (originalOpen as (...args: unknown[]) => void).apply(this, [method, url, ...rest]);
      },
    });

    for (const store of [window.localStorage, window.sessionStorage]) {
      const setItem = store.setItem.bind(store);
      store.setItem = (key: string, value: string) => {
        w.__storageWrites?.push(key);
        setItem(key, value);
      };
    }
  });
}

async function probeState(page: Page): Promise<Required<ProbeWindow>> {
  return page.evaluate(() => {
    const w = window as typeof window & ProbeWindow;
    return {
      __walletCalls: w.__walletCalls ?? [],
      __fetchCalls: w.__fetchCalls ?? [],
      __xhrCalls: w.__xhrCalls ?? [],
      __storageWrites: w.__storageWrites ?? [],
      __cspViolations: w.__cspViolations ?? [],
    };
  });
}

async function assertNoOverflow(page: Page): Promise<void> {
  const overflow = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    innerWidth: window.innerWidth,
  }));
  expect(overflow.scrollWidth, JSON.stringify(overflow)).toBeLessThanOrEqual(overflow.innerWidth);
}

test("renders supplied home, docs and FAQ on direct navigation", async ({ page }) => {
  await installProbes(page);

  await page.goto("/design");
  await waitForMount(page);
  await expect(page.getByRole("heading", { name: /The commerce layer/ })).toBeVisible();
  await expect(page.getByText(/under development and is not a live capability/u)).toBeVisible();
  await expect(page.getByRole("link", { name: "Skip to main content" })).toHaveCount(1);

  await page.goto("/design/docs");
  await waitForMount(page);
  await expect(page.getByRole("heading", { name: "Canonical engineering documents" })).toBeVisible();
  await expect(page.getByRole("tab", { name: "Source of truth" })).toHaveAttribute("aria-selected", "true");

  await page.goto("/design/faq");
  await waitForMount(page);
  await expect(page.getByRole("heading", { name: "Dedicated questions and answers" })).toBeVisible();

  const state = await probeState(page);
  expect(state.__walletCalls).toEqual([]);
  expect(state.__fetchCalls).toEqual([]);
  expect(state.__xhrCalls).toEqual([]);
  expect(state.__storageWrites).toEqual([]);
  expect(await page.context().cookies()).toEqual([]);
});

test("keeps home, docs and FAQ navigation coherent", async ({ page }) => {
  await page.goto("/design");
  await waitForMount(page);
  const nav = page.locator("header");
  await nav.getByRole("link", { name: "Docs", exact: true }).click();
  await expect(page).toHaveURL(/\/design\/docs$/u);
  await expect(page.getByRole("heading", { name: "Canonical engineering documents" })).toBeVisible();

  await page.getByRole("link", { name: "Read the FAQ" }).click();
  await expect(page).toHaveURL(/\/design\/faq$/u);
  await expect(page.getByRole("heading", { name: "Dedicated questions and answers" })).toBeVisible();

  await page.getByRole("link", { name: "Back to overview" }).click();
  await expect(page).toHaveURL(/\/design$/u);
});

for (const width of WIDTHS) {
  test(`has no horizontal page overflow at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    for (const route of ROUTES) {
      await waitForRoute(page, route);
      await assertNoOverflow(page);
    }
  });
}

test("mobile menu supports keyboard open, Escape dismissal and focus return", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/design");
  await waitForMount(page);

  const toggle = page.getByRole("button", { name: "Open menu" });
  const panel = page.locator("#supplied-mobile-menu");
  await expect(panel).toHaveAttribute("inert", "");

  await toggle.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("button", { name: "Close menu" })).toHaveAttribute("aria-expanded", "true");
  await expect(panel).not.toHaveAttribute("inert", "");
  await expect(panel.getByRole("link", { name: "Docs", exact: true })).toBeVisible();

  await page.keyboard.press("Escape");
  await expect(page.getByRole("button", { name: "Open menu" })).toHaveAttribute("aria-expanded", "false");
  await expect(panel).toHaveAttribute("inert", "");
  const focusReturned = await page.evaluate(() => document.activeElement?.getAttribute("aria-label") === "Open menu");
  expect(focusReturned).toBe(true);
});

test("hidden mobile panel links are not tabbable", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/design");
  await waitForMount(page);
  const hidden = page.locator("#supplied-mobile-menu").getByRole("link", { name: "Docs" });
  await expect(hidden).not.toBeVisible();
  const inert = await page.locator("#supplied-mobile-menu").evaluate((el) => (el as HTMLElement).inert);
  expect(inert).toBe(true);
});

test("skip link moves focus into main content", async ({ page }) => {
  await page.goto("/design");
  await waitForMount(page);
  const skip = page.getByRole("link", { name: "Skip to main content" });
  await expect(skip).toBeVisible();
  await page.keyboard.press("Tab");
  await expect(skip).toBeFocused();
  await page.keyboard.press("Enter");
  const focused = await page.evaluate(() => ({
    id: document.activeElement?.id ?? "",
    tagName: document.activeElement?.tagName ?? "",
  }));
  expect(focused.id).toBe("supplied-main-content");
  expect(focused.tagName).toBe("MAIN");
});

test("design styles are removed on same-document navigation to legacy routes", async ({ page }) => {
  await waitForRoute(page, "/design");
  await expect(page.locator('link[rel="stylesheet"][data-supplied-style="supplied"]')).toHaveCount(1);
  await expect(page.locator('link[rel="stylesheet"][data-supplied-style="staging"]')).toHaveCount(1);
  await expect(page.locator(".supplied-home")).toHaveCount(1);

  await page.evaluate(() => {
    window.history.pushState(null, "", "/");
    window.dispatchEvent(new PopStateEvent("popstate"));
  });

  await expect(page.getByRole("heading", { name: "See the full arc of every agent action." })).toBeVisible();
  await expect(page.locator('link[rel="stylesheet"][data-supplied-style="supplied"]')).toHaveCount(0);
  await expect(page.locator('link[rel="stylesheet"][data-supplied-style="staging"]')).toHaveCount(0);
  await expect(page.locator(".supplied-home")).toHaveCount(0);
});

test("docs tabs switch canonical content and render as escaped text", async ({ page }) => {
  await page.goto("/design/docs");
  const panel = page.locator('[role="tabpanel"]');
  await expect(panel.getByText("# OpenArc engineering source of truth", { exact: false })).toBeVisible();

  const childCount = await panel.locator("pre").evaluate((el) => el.children.length);
  expect(childCount).toBe(0);

  await page.getByRole("tab", { name: "Backend" }).click();
  await expect(page.getByRole("tab", { name: "Backend" })).toHaveAttribute("aria-selected", "true");
  await expect(page).toHaveURL(/doc=backend/u);
  await expect(panel.getByText("# OpenArc backend architecture", { exact: false })).toBeVisible();

  await page.getByRole("tab", { name: "Frontend" }).press("ArrowLeft");
  await expect(page.getByRole("tab", { name: "Backend" })).toHaveAttribute("aria-selected", "true");
});

test("FAQ uses disclosure semantics and hides closed answers", async ({ page }) => {
  await page.goto("/design/faq");
  const item = page.getByTestId("supplied-faq-item-today-what");
  await expect(item).not.toHaveAttribute("open", "");
  await expect(item.locator("p")).not.toBeVisible();

  await item.locator("summary").click();
  await expect(item).toHaveAttribute("open", "");
  await expect(item.locator("p")).toBeVisible();

  const group = page.getByRole("heading", { name: "What is available today" });
  await expect(group).toBeVisible();
});

test("dashboard links resolve to the working workspace", async ({ page }) => {
  await page.goto("/design");
  await waitForMount(page);
  const dashboard = page.locator('a[href="/workspace"]').first();
  await expect(dashboard).toBeVisible();
  await expect(dashboard).toHaveAttribute("href", "/workspace");
});

test("design workspace route redirects to the working workspace", async ({ page }) => {
  await page.goto("/design/workspace");
  await expect(page).toHaveURL(/\/workspace$/u);
  await expect(page.getByRole("heading", { name: "Create a private workspace" })).toBeVisible();
});

test("hero video stays a same-origin local asset", async ({ page, baseURL }) => {
  await page.goto("/design");
  await waitForMount(page);
  const video = page.locator("video");
  const src = await video.getAttribute("src");
  expect(src ?? "").toMatch(/hero-bg[^/]*\.mp4$/u);
  const origin = new URL(baseURL ?? "http://127.0.0.1:5199").origin;
  const resolved = new URL(src ?? "", origin);
  expect(resolved.origin).toBe(origin);
  const control = page.locator(".oa-motion-control");
  const fallback = page.getByText(/Background animation unavailable/u);
  await expect(control.or(fallback).first()).toBeVisible();
});

test("reduced motion disables autoplay and shows a manual control", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/design");
  await waitForMount(page);
  const paused = await page.locator("video").evaluate((el) => (el as HTMLVideoElement).paused);
  expect(paused).toBe(true);
  const matches = await page.evaluate(() => window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  expect(matches).toBe(true);
  const control = page.locator(".oa-motion-control");
  const fallback = page.getByText(/Background animation unavailable/u);
  await expect(control.or(fallback).first()).toBeVisible();
});

test("shows a visible fallback when local media fails", async ({ page }) => {
  await page.route("**/hero-bg*.mp4", (route) =>
    route.fulfill({ status: 404, contentType: "text/plain", body: "missing" }),
  );
  await page.goto("/design");
  await waitForMount(page);
  await expect(page.getByText(/Background animation unavailable/u)).toBeVisible();
});

test("design stylesheets load same-origin and apply at computed level", async ({ page, baseURL }) => {
  await waitForRoute(page, "/design");
  const origin = new URL(baseURL ?? "http://127.0.0.1:5199").origin;
  const hrefs = await page
    .locator('link[rel="stylesheet"][data-supplied-style]')
    .evaluateAll((links) => links.map((link) => (link as HTMLLinkElement).href));
  expect(hrefs).toHaveLength(2);
  for (const href of hrefs) expect(new URL(href).origin).toBe(origin);

  const sheetHrefs = await page.evaluate(() =>
    Array.from(document.styleSheets)
      .map((sheet) => sheet.href)
      .filter((href): href is string => href !== null),
  );
  for (const href of hrefs) {
    expect(sheetHrefs.some((sheet) => sheet.split("?")[0] === href.split("?")[0])).toBe(true);
  }

  const overlay = page.locator(".oa-hero .bg-gradient-to-b");
  await expect(overlay).toBeVisible();
  const backgroundImage = await overlay.evaluate((el) =>
    getComputedStyle(el).getPropertyValue("background-image"),
  );
  expect(backgroundImage).toContain("linear-gradient");

  const skip = page.getByRole("link", { name: "Skip to main content" });
  expect(await skip.evaluate((el) => getComputedStyle(el).getPropertyValue("position"))).toBe("fixed");

  await page.goto("/design/docs");
  await waitForMount(page);
  await expect(page.getByRole("heading", { name: "Canonical engineering documents" })).toBeVisible();
  const markdown = await page.locator(".supplied-docs__markdown").evaluate((el) => ({
    whiteSpace: getComputedStyle(el).getPropertyValue("white-space"),
    overflow: getComputedStyle(el).getPropertyValue("overflow"),
  }));
  expect(markdown.whiteSpace).toBe("pre-wrap");
  expect(markdown.overflow).toBe("auto");

  await page.goto("/design/faq");
  await waitForMount(page);
  await expect(page.getByRole("heading", { name: "Dedicated questions and answers" })).toBeVisible();
  const summaryDisplay = await page
    .locator(".supplied-faq-item__summary")
    .first()
    .evaluate((el) => getComputedStyle(el).getPropertyValue("display"));
  expect(summaryDisplay).toBe("flex");
});

test("design routes produce no content security policy violations", async ({ page }) => {
  await installProbes(page);
  for (const route of ROUTES) {
    await waitForRoute(page, route);
    const state = await probeState(page);
    expect(state.__cspViolations, `${route}: ${state.__cspViolations.join(", ")}`).toEqual([]);
  }
});

test("same-origin hero media and stylesheets are served with correct types", async ({ page }) => {
  const response = await page.goto("/design");
  await waitForMount(page);
  await expect(page.getByRole("heading", { name: /The commerce layer/ })).toBeVisible();

  const csp = response?.headers()["content-security-policy"];
  if (csp) {
    expect(csp).toContain("media-src 'self'");
    expect(csp).not.toContain("media-src 'none'");
  }

  const videoUrl = await page.locator("video").evaluate((el) => (el as HTMLVideoElement).src);
  const videoResponse = await page.request.get(videoUrl);
  expect([200, 206]).toContain(videoResponse.status());
  expect((videoResponse.headers()["content-type"] ?? "").toLowerCase()).toContain("video/mp4");

  const linkHref = await page
    .locator('link[rel="stylesheet"][data-supplied-style="supplied"]')
    .getAttribute("href");
  // Match a real browser stylesheet request; Vite dev content-negotiates CSS.
  const cssResponse = await page.request.get(new URL(linkHref ?? "", page.url()).toString(), {
    headers: { "sec-fetch-dest": "style", accept: "text/css,*/*;q=0.1" },
  });
  expect(cssResponse.status()).toBe(200);
  if (csp) {
    expect((cssResponse.headers()["content-type"] ?? "").toLowerCase()).toContain("text/css");
  }
});

test("media requests stay same-origin and no fetch or XHR is issued", async ({ page, baseURL }) => {
  await installProbes(page);
  const origin = new URL(baseURL ?? "http://127.0.0.1:5199").origin;
  const foreign: string[] = [];
  const fetchLike: string[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.origin !== origin) foreign.push(request.url());
    if (request.resourceType() === "fetch" || request.resourceType() === "xhr") fetchLike.push(request.url());
  });

  await page.goto("/design");
  await page.waitForLoadState("domcontentloaded");
  await page.goto("/design/docs");
  await page.goto("/design/faq");

  expect(foreign).toEqual([]);
  expect(fetchLike).toEqual([]);
  const state = await probeState(page);
  expect(state.__fetchCalls).toEqual([]);
  expect(state.__xhrCalls).toEqual([]);
  expect(state.__walletCalls).toEqual([]);
  expect(await page.context().cookies()).toEqual([]);
});
