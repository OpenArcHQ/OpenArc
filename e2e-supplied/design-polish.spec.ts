import { expect, test, type Page } from "@playwright/test";

const MOUNT_SELECTOR = "#supplied-main-content";
const MOUNT_TIMEOUT_MS = 20_000;

interface ScrollProbeWindow {
  __scrollBehaviors?: string[];
}

async function gotoHome(page: Page): Promise<void> {
  await page.goto("/design");
  await page.waitForSelector(MOUNT_SELECTOR, { state: "visible", timeout: MOUNT_TIMEOUT_MS });
  await expect(page.getByRole("heading", { name: /The commerce layer/u })).toBeVisible();
}

async function noHorizontalOverflow(page: Page): Promise<void> {
  const overflow = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    innerWidth: window.innerWidth,
  }));
  expect(overflow.scrollWidth, JSON.stringify(overflow)).toBeLessThanOrEqual(overflow.innerWidth);
}

test("hero keeps its copy, readable video and a secondary motion control", async ({ page }) => {
  await gotoHome(page);

  await expect(page.getByRole("heading", {
    name: /The commerce layer\s*for AI agents on Arc/u,
  })).toBeVisible();
  await expect(page.getByText("The commerce layer is under development and is not a live capability.")).toBeVisible();

  const video = page.locator("video");
  await expect(video).toBeVisible();
  const videoStyle = await video.evaluate((el) => {
    const style = getComputedStyle(el);
    return { objectFit: style.objectFit, opacity: Number(style.opacity) };
  });
  expect(videoStyle.objectFit).toBe("cover");
  expect(videoStyle.opacity).toBeGreaterThan(0.5);

  const control = page.locator(".oa-motion-control");
  const fallback = page.getByText(/Background animation unavailable/u);
  await expect(control.or(fallback).first()).toBeVisible();
  if (await control.count()) {
    await expect(control).toHaveAccessibleName(/background animation/u);
    await expect(control.locator("svg")).toHaveAttribute("aria-hidden", "true");

    const box = await control.boundingBox();
    expect(box, "motion control has a box").not.toBeNull();
    expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);

    const position = await control.evaluate((el) => getComputedStyle(el).position);
    expect(position).not.toBe("fixed");
  }
});

test("hero header measure stays deliberate on desktop", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await gotoHome(page);
  const measure = await page.locator(".oa-hero__title").evaluate((el) => {
    const style = getComputedStyle(el);
    const fontSize = Number.parseFloat(style.fontSize);
    return {
      maxWidth: style.maxWidth,
      fontSize,
      rectWidth: el.getBoundingClientRect().width,
    };
  });
  expect(measure.maxWidth).not.toBe("none");
  expect(measure.fontSize).toBeGreaterThanOrEqual(56);
  expect(measure.rectWidth).toBeLessThanOrEqual(900);
});

test("hero reveal motion is a brief one-time transition", async ({ page }) => {
  await gotoHome(page);
  const timing = await page.locator(".oa-hero__title.reveal").evaluate((el) => {
    const style = getComputedStyle(el);
    return {
      duration: style.transitionDuration,
      property: style.transitionProperty,
    };
  });
  const durationMs = Number.parseFloat(timing.duration) * 1000;
  expect(durationMs).toBeGreaterThanOrEqual(450);
  expect(durationMs).toBeLessThanOrEqual(550);
  expect(timing.property).toContain("opacity");
  expect(timing.property).toContain("transform");
});

test("hero console is framed and never floats", async ({ page }) => {
  await gotoHome(page);
  const frame = page.locator(".oa-console__frame");
  await expect(frame).toBeVisible();

  const info = await frame.evaluate((el) => {
    const style = getComputedStyle(el);
    return {
      animationName: style.animationName,
      animationCount: el.getAnimations().length,
      boxShadow: style.boxShadow,
      borderTopWidth: style.borderTopWidth,
    };
  });
  expect(info.animationName).toBe("none");
  expect(info.animationCount).toBe(0);
  expect(info.boxShadow).not.toBe("none");
  expect(Number.parseFloat(info.borderTopWidth)).toBeGreaterThan(0);

  const width = await page.locator(".oa-console").evaluate((el) => el.getBoundingClientRect().width);
  expect(width).toBeLessThanOrEqual(1320);
});

for (const width of [320, 390] as const) {
  test(`small-width hero CTA and floating nav stay usable at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    await gotoHome(page);
    await noHorizontalOverflow(page);

    const panelTop = await page.locator(".oa-nav__panel").evaluate((el) => el.getBoundingClientRect().top);
    expect(panelTop).toBeGreaterThanOrEqual(8);
    expect(panelTop).toBeLessThanOrEqual(20);

    for (const name of ["Open workspace", "Read the Docs"]) {
      const cta = page.locator(".oa-hero__actions").getByRole("link", { name });
      await expect(cta).toBeVisible();
      const rect = await cta.evaluate((el) => {
        const r = el.getBoundingClientRect();
        return { left: r.left, right: r.right, width: r.width };
      });
      expect(rect.left).toBeGreaterThanOrEqual(-1);
      expect(rect.right).toBeLessThanOrEqual(width + 1);
      expect(rect.width).toBeGreaterThan(0);
    }

    const toggle = page.getByRole("button", { name: "Open menu" });
    const toggleBox = await toggle.boundingBox();
    expect(toggleBox?.width ?? 0).toBeGreaterThanOrEqual(44);
    expect(toggleBox?.height ?? 0).toBeGreaterThanOrEqual(44);
  });
}

test("reduced motion shows every revealed element immediately", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await gotoHome(page);

  const hidden = await page.locator(".reveal").evaluateAll((nodes) => nodes.filter((node) => {
    const style = getComputedStyle(node);
    return Number(style.opacity) < 1 || style.transform !== "none";
  }).length);
  expect(hidden).toBe(0);
});

test("reveals everything when IntersectionObserver is unavailable", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, "IntersectionObserver", {
      configurable: true,
      value: undefined,
    });
  });
  await gotoHome(page);

  const hidden = await page.locator(".reveal").count();
  expect(hidden).toBeGreaterThan(0);
  const stillHidden = await page.locator(".reveal").evaluateAll((nodes) => nodes.filter(
    (node) => Number(getComputedStyle(node).opacity) < 1,
  ).length);
  expect(stillHidden).toBe(0);
});

async function installScrollProbe(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const probe = window as typeof window & ScrollProbeWindow;
    probe.__scrollBehaviors = [];
    const original = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = function (this: Element, arg?: boolean | ScrollIntoViewOptions) {
      const behavior = arg && typeof arg === "object" ? (arg.behavior ?? "auto") : "auto";
      probe.__scrollBehaviors?.push(String(behavior));
      return original.call(this, arg as ScrollIntoViewOptions);
    };
  });
}

async function lastScrollBehavior(page: Page): Promise<string | undefined> {
  return page.evaluate(() => (window as typeof window & ScrollProbeWindow).__scrollBehaviors?.at(-1));
}

test("anchor navigation uses smooth scrolling by default", async ({ page }) => {
  await installScrollProbe(page);
  await gotoHome(page);
  await page.locator(".oa-nav__link", { hasText: "About" }).click();
  await expect.poll(() => lastScrollBehavior(page)).toBe("smooth");
});

test("anchor navigation respects reduced motion", async ({ page }) => {
  await installScrollProbe(page);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await gotoHome(page);
  await page.locator(".oa-nav__link", { hasText: "About" }).click();
  await expect.poll(() => lastScrollBehavior(page)).toBe("auto");
});
