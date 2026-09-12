import { expect, test, type Page } from "@playwright/test";

/**
 * Machine credential management OFF but tenant reads/writes ON (Chromium).
 *
 * The machine flag off must produce no machine controller, no credential
 * panel, no profile-selection controls and no machine request, while the
 * existing Agents/Provider tables stay byte-identical.
 */

const META = {
  schemaVersion: "openarc.api.v2",
  requestId: "018f47a2-3b4c-7def-8123-456789abcdef",
  buildSha: "0123456789abcdef0123456789abcdef01234567",
};

const UUID = "12345678-1234-4234-8123-123456789abc";
const ORG_A = `openarc:org:${UUID}`;
const ACCOUNT_A = `openarc:account:${UUID}`;
const AGENT_A = `openarc:agent:${UUID}`;
const PROVIDER_A = `openarc:provider:${UUID}`;
const CREATED = "2026-01-01T00:00:00.000Z";

function envelope(data: unknown): string {
  return JSON.stringify({ ok: true, data, meta: META });
}

function organization(organizationId: string, index = 0) {
  return {
    schemaVersion: "openarc.organization.v1",
    organizationId,
    displayName: `Organization ${index}`,
    createdAt: CREATED,
    updatedAt: CREATED,
  };
}

function context() {
  return {
    organization: organization(ORG_A),
    access: {
      schemaVersion: "openarc.organization-access.v1",
      organizationId: ORG_A,
      accountId: ACCOUNT_A,
      role: "owner",
      membershipStatus: "active",
      sessionExpiresAt: "2030-01-01T00:00:00.000Z",
    },
    network: "eip155:5042002",
  };
}

function agent() {
  return {
    schemaVersion: "openarc.agent-profile.v1",
    agentId: AGENT_A,
    organizationId: ORG_A,
    displayName: "Support Agent",
    status: "active",
    createdAt: CREATED,
    updatedAt: CREATED,
  };
}

function provider() {
  return {
    schemaVersion: "openarc.provider-profile.v1",
    providerId: PROVIDER_A,
    organizationId: ORG_A,
    displayName: "Support Provider",
    status: "active",
    createdAt: CREATED,
    updatedAt: CREATED,
  };
}

async function installProbes(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const w = window as typeof window & { __fetches?: string[]; __storage?: string[]; __wallet?: string[] };
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
    const w = window as typeof window & { __fetches?: string[]; __storage?: string[]; __wallet?: string[] };
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
        data: { session: { signedIn: true, accountId: ACCOUNT_A, method: "passkey", expiresAt: "2030-01-01T00:00:00.000Z" } },
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
  await page.route("**/v1/operator/organizations/*/agents*", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: envelope({ organizationId: ORG_A, items: [agent()], nextCursor: null }),
    });
  });
  await page.route("**/v1/operator/organizations/*/providers*", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: envelope({ organizationId: ORG_A, items: [provider()], nextCursor: null }),
    });
  });
  await page.route("**/v1/operator/organizations/*", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (/\/(agents|providers)/u.test(path)) {
      await route.fallback();
      return;
    }
    await route.fulfill({ status: 200, contentType: "application/json", body: envelope(context()) });
  });
}

async function openAgents(page: Page): Promise<void> {
  await page.goto("/app/agents");
  await page.locator(".tenant-rail--static .tenant-org-select").selectOption(ORG_A);
  await expect(page.locator(".tenant-org-select").first()).toHaveValue(ORG_A);
}

test("the machine OFF surface shows the legacy table and makes zero machine requests", async ({ page }) => {
  await installProbes(page);
  await stubReads(page);
  await openAgents(page);
  await page.getByRole("button", { name: "Load agents" }).click();
  // The legacy read-only table renders unchanged.
  await expect(page.getByRole("table", { name: /Agents in this organization/u })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Support Agent" })).toHaveCount(0);
  // No machine console, no profile-selection control and no credential request.
  await expect(page.getByRole("button", { name: "Manage credentials" })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Agent credential" })).toHaveCount(0);
  await expect(page.getByText(/credentials/u)).toHaveCount(0);
  const state = await probes(page);
  expect(state.fetches.filter((entry) => /credentials|credential-mutations/u.test(entry))).toEqual([]);
  expect(state.fetches.some((entry) => /\/v1\/agent| \/v1\/provider/u.test(entry))).toBe(false);
  expect(state.storage).toEqual([]);
  expect(state.wallet).toEqual([]);
});

test("the machine OFF provider surface shows the legacy table without a credential panel", async ({ page }) => {
  await installProbes(page);
  await stubReads(page);
  await page.goto("/app/provider");
  await page.locator(".tenant-rail--static .tenant-org-select").selectOption(ORG_A);
  await page.getByRole("button", { name: "Load providers" }).click();
  await expect(page.getByRole("table", { name: /Providers in this organization/u })).toBeVisible();
  await expect(page.getByRole("button", { name: "Manage credentials" })).toHaveCount(0);
  const state = await probes(page);
  expect(state.fetches.filter((entry) => /credentials/u.test(entry))).toEqual([]);
  expect(state.storage).toEqual([]);
  expect(state.wallet).toEqual([]);
});
