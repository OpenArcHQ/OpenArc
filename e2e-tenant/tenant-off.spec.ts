import { expect, test, type Page } from "@playwright/test";

/**
 * Default-disabled protected organization workspace.
 *
 * With `VITE_TENANT_READS_ENABLED=false`, `/app` renders a clear unavailable
 * state and makes no auth or tenant request, no storage write and no wallet
 * access. Public and legacy routes stay unchanged.
 */

interface Probes {
  __walletCalls?: string[];
  __fetchCalls?: string[];
  __xhrCalls?: string[];
  __storageWrites?: string[];
}

async function installProbes(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const w = window as typeof window & Probes;
    w.__walletCalls = [];
    w.__fetchCalls = [];
    w.__xhrCalls = [];
    w.__storageWrites = [];
    Object.defineProperty(window, "ethereum", {
      configurable: true,
      get() {
        w.__walletCalls?.push("ethereum");
        return undefined;
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

async function probes(page: Page): Promise<Required<Probes>> {
  return page.evaluate(() => {
    const w = window as typeof window & Probes;
    return {
      __walletCalls: w.__walletCalls ?? [],
      __fetchCalls: w.__fetchCalls ?? [],
      __xhrCalls: w.__xhrCalls ?? [],
      __storageWrites: w.__storageWrites ?? [],
    };
  });
}

test("shows an unavailable state without any auth, tenant, wallet or storage activity", async ({ page }) => {
  await installProbes(page);
  await page.goto("/app");
  await expect(
    page.getByRole("heading", { name: "Organization workspace is not available in this deployment" }),
  ).toBeVisible();
  await expect(page.getByRole("link", { name: "Read the docs" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Local workspace" })).toBeVisible();
  const state = await probes(page);
  expect(state.__walletCalls).toEqual([]);
  expect(state.__fetchCalls).toEqual([]);
  expect(state.__xhrCalls).toEqual([]);
  expect(state.__storageWrites).toEqual([]);
  expect(await page.context().cookies()).toEqual([]);
});

test("public and legacy routes stay unchanged", async ({ page }) => {
  await installProbes(page);
  for (const route of ["/", "/design", "/design/docs", "/account"]) {
    await page.goto(route);
    await page.waitForLoadState("networkidle");
  }
  const state = await probes(page);
  expect(state.__walletCalls).toEqual([]);
  expect(state.__storageWrites).toEqual([]);
});
