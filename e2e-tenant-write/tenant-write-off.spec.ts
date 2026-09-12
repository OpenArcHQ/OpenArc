import { expect, test, type Page } from "@playwright/test";

/**
 * Protected organization workspace with the write flag OFF but reads ON.
 *
 * The accepted read surface must be unchanged, no write client/controller/form
 * may be constructed, and no ADDITIONAL auth/write call may be made. The
 * existing read-only app may still read the session and tenant.
 */

const META = {
  schemaVersion: "openarc.api.v2",
  requestId: "018f47a2-3b4c-7def-8123-456789abcdef",
  buildSha: "0123456789abcdef0123456789abcdef01234567",
};

const ORG_A = "openarc:org:aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa";
const ACCOUNT_A = "openarc:account:aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa";

function envelope(data: unknown): string {
  return JSON.stringify({ ok: true, data, meta: META });
}

function organization(organizationId: string, index = 0) {
  return {
    schemaVersion: "openarc.organization.v1",
    organizationId,
    displayName: `Organization ${index}`,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

function context(organizationId: string, role: string) {
  return {
    organization: organization(organizationId),
    access: {
      schemaVersion: "openarc.organization-access.v1",
      organizationId,
      accountId: ACCOUNT_A,
      role,
      membershipStatus: "active",
      sessionExpiresAt: "2030-01-01T00:00:00.000Z",
    },
    network: "eip155:5042002",
  };
}

async function installProbes(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const w = window as typeof window & {
      __fetches?: string[];
      __storage?: string[];
      __wallet?: string[];
    };
    w.__fetches = [];
    w.__storage = [];
    w.__wallet = [];
    const originalFetch = window.fetch.bind(window);
    window.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
      w.__fetches?.push(`${init?.method ?? "GET"} ${String(input)}`);
      return originalFetch(input, init);
    };
    for (const store of [window.localStorage, window.sessionStorage]) {
      const setItem = store.setItem.bind(store);
      store.setItem = (key: string, value: string) => {
        w.__storage?.push(key);
        setItem(key, value);
      };
    }
    Object.defineProperty(window, "ethereum", {
      configurable: true,
      get() {
        w.__wallet?.push("ethereum");
        return undefined;
      },
    });
  });
}

async function probes(page: Page) {
  return page.evaluate(() => {
    const w = window as typeof window & {
      __fetches?: string[];
      __storage?: string[];
      __wallet?: string[];
    };
    return { fetches: w.__fetches ?? [], storage: w.__storage ?? [], wallet: w.__wallet ?? [] };
  });
}

async function stubReads(page: Page): Promise<void> {
  await page.route("**/v2/auth/session", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        ok: true,
        data: {
          session: {
            signedIn: true,
            accountId: ACCOUNT_A,
            method: "passkey",
            expiresAt: "2030-01-01T00:00:00.000Z",
          },
        },
        meta: META,
      }),
    });
  });
  await page.route("**/v1/operator/organizations?*", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: envelope({ items: [organization(ORG_A)], nextCursor: null }),
    });
  });
  await page.route("**/v1/operator/organizations", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: envelope({ items: [organization(ORG_A)], nextCursor: null }),
    });
  });
  await page.route("**/v1/operator/organizations/*", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.includes("/agents") || path.includes("/providers")) {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: envelope(context(ORG_A, "owner")),
    });
  });
  await page.route("**/v1/operator/organizations/*/agents*", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: envelope({ organizationId: ORG_A, items: [], nextCursor: null }),
    });
  });
  await page.route("**/v1/operator/organizations/*/providers*", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: envelope({ organizationId: ORG_A, items: [], nextCursor: null }),
    });
  });
}

test("reads still work with no mutation panel, form or write call", async ({ page }) => {
  await installProbes(page);
  await stubReads(page);
  await page.goto("/app/overview");
  await page.locator(".tenant-org-select").selectOption(ORG_A);
  await expect(page.getByRole("heading", { name: "Organization 0" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Membership and tenant changes" })).toHaveCount(0);
  await expect(page.getByLabel("Display name")).toHaveCount(0);
  const state = await probes(page);
  // The read-only app may read the session and tenant, but never bootstrap or
  // issue any write.
  expect(state.fetches.some((entry) => entry.includes("/v2/auth/bootstrap"))).toBe(false);
  expect(state.fetches.some((entry) => /^(POST|PUT|PATCH) /u.test(entry))).toBe(false);
  expect(state.storage).toEqual([]);
  expect(state.wallet).toEqual([]);
});

test("agents and provider panels keep the read-only surface", async ({ page }) => {
  await installProbes(page);
  await stubReads(page);
  await page.goto("/app/agents");
  await page.locator(".tenant-org-select").selectOption(ORG_A);
  await page.getByRole("button", { name: "Load agents" }).click();
  await expect(page.getByText("No agents in this organization.")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Membership and tenant changes" })).toHaveCount(0);
  const state = await probes(page);
  expect(state.fetches.some((entry) => entry.includes("/v2/auth/bootstrap"))).toBe(false);
  expect(state.fetches.some((entry) => /^(POST|PUT|PATCH) /u.test(entry))).toBe(false);
  expect(state.storage).toEqual([]);
  expect(state.wallet).toEqual([]);
});

test("a zero-org user with writes off sees no create-organization form", async ({ page }) => {
  await installProbes(page);
  await page.route("**/v2/auth/session", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        ok: true,
        data: {
          session: {
            signedIn: true,
            accountId: ACCOUNT_A,
            method: "passkey",
            expiresAt: "2030-01-01T00:00:00.000Z",
          },
        },
        meta: META,
      }),
    });
  });
  await page.route("**/v1/operator/organizations?*", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: envelope({ items: [], nextCursor: null }),
    });
  });
  await page.route("**/v1/operator/organizations", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: envelope({ items: [], nextCursor: null }),
    });
  });
  await page.goto("/app/overview");
  await expect(page.getByRole("heading", { name: "No organizations available." })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Membership and tenant changes" })).toHaveCount(0);
  await expect(page.getByLabel("Display name")).toHaveCount(0);
  const state = await probes(page);
  expect(state.fetches.some((entry) => entry.includes("/v2/auth/bootstrap"))).toBe(false);
  expect(state.fetches.some((entry) => /^(POST|PUT|PATCH) /u.test(entry))).toBe(false);
  expect(state.storage).toEqual([]);
  expect(state.wallet).toEqual([]);
});
