import { expect, test, type Page } from "@playwright/test";

/**
 * Default-disabled account access.
 *
 * With `VITE_ACCOUNT_ACCESS_ENABLED` unset/false, `/account` must render a
 * clear unavailable state and make no auth API call, cookie write or wallet
 * access, and the public design routes must stay untouched.
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

test("shows an unavailable state without any auth, wallet or storage activity", async ({ page }) => {
  await installProbes(page);
  await page.goto("/account");
  await expect(page.getByRole("heading", { name: "Accounts are not available here yet" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Read the docs" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Continue as guest" })).toBeVisible();
  const state = await probes(page);
  expect(state.__walletCalls).toEqual([]);
  expect(state.__fetchCalls).toEqual([]);
  expect(state.__xhrCalls).toEqual([]);
  expect(state.__storageWrites).toEqual([]);
  expect(await page.context().cookies()).toEqual([]);
});

test("public design routes never mount auth or call the wallet", async ({ page }) => {
  await installProbes(page);
  for (const route of ["/design", "/design/docs", "/design/faq", "/"]) {
    await page.goto(route);
    await page.waitForLoadState("networkidle");
  }
  const state = await probes(page);
  expect(state.__walletCalls).toEqual([]);
  expect(state.__fetchCalls).toEqual([]);
  expect(state.__xhrCalls).toEqual([]);
  expect(state.__storageWrites).toEqual([]);
});
