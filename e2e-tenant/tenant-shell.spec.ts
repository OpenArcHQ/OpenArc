import { expect, test, type Page } from "@playwright/test";

/**
 * Protected organization workspace journeys (Chromium + WebKit).
 *
 * All four organization GET endpoints and the account session read are
 * intercepted with synthetic responses. These tests prove the UI contract
 * only; they do not prove a live API, PostgreSQL or nginx path.
 */

const META = {
  schemaVersion: "openarc.api.v2",
  requestId: "018f47a2-3b4c-7def-8123-456789abcdef",
  buildSha: "0123456789abcdef0123456789abcdef01234567",
};

const ORG_A = "openarc:org:aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa";
const ORG_B = "openarc:org:bbbbbbbb-bbbb-7bbb-8bbb-bbbbbbbbbbbb";
const ACCOUNT_A = "openarc:account:aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa";
const AGENT_A = "openarc:agent:aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa";
const PROVIDER_A = "openarc:provider:aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa";

/** Matches the organization list route by exact pathname, ignoring the query. */
const ORGANIZATIONS_LIST = (url: URL): boolean =>
  url.pathname === "/v1/operator/organizations";

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

function context(organizationId: string, role: string, membershipStatus = "active") {
  return {
    organization: organization(organizationId),
    access: {
      schemaVersion: "openarc.organization-access.v1",
      organizationId,
      accountId: ACCOUNT_A,
      role,
      membershipStatus,
      sessionExpiresAt: "2030-01-01T00:00:00.000Z",
    },
    network: "eip155:5042002",
  };
}

function agent(agentId: string): unknown {
  return {
    schemaVersion: "openarc.agent-profile.v1",
    agentId,
    organizationId: ORG_A,
    displayName: "Support Agent",
    status: "active",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-02T00:00:00.000Z",
  };
}

function provider(providerId: string): unknown {
  return {
    schemaVersion: "openarc.provider-profile.v1",
    providerId,
    organizationId: ORG_A,
    displayName: "Data Provider",
    status: "active",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-02T00:00:00.000Z",
  };
}

async function stubSession(page: Page, signedIn = true): Promise<void> {
  const session = signedIn
    ? {
        signedIn: true,
        accountId: ACCOUNT_A,
        method: "passkey",
        expiresAt: "2030-01-01T00:00:00.000Z",
      }
    : { signedIn: false };
  await page.route("**/v2/auth/session", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ok: true, data: { session }, meta: META }),
    });
  });
}

async function stubOrganizations(
  page: Page,
  items: Array<{ organizationId: string }>,
  nextCursor: string | null = null,
  onRequest?: (url: URL) => void,
): Promise<void> {
  await page.route(ORGANIZATIONS_LIST, async (route) => {
    onRequest?.(new URL(route.request().url()));
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: envelope({ items: items.map((item, index) => organization(item.organizationId, index)), nextCursor }),
    });
  });
}

async function stubContext(
  page: Page,
  organizationId: string,
  role: string,
  membershipStatus = "active",
): Promise<void> {
  await page.route("**/v1/operator/organizations/*", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (!path.endsWith(encodeURIComponent(organizationId)) && !path.endsWith(organizationId)) {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: envelope(context(organizationId, role, membershipStatus)),
    });
  });
}

async function installProbes(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const w = window as typeof window & { __fetches?: string[]; __storage?: string[]; __wallet?: string[] };
    w.__fetches = [];
    w.__storage = [];
    w.__wallet = [];
    const originalFetch = window.fetch.bind(window);
    window.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
      w.__fetches?.push(String(input));
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
    return {
      fetches: w.__fetches ?? [],
      storage: w.__storage ?? [],
      wallet: w.__wallet ?? [],
    };
  });
}

test("requires a signed-in session", async ({ page }) => {
  await stubSession(page, false);
  await page.goto("/app");
  await expect(page.getByRole("heading", { name: "Sign in required" })).toBeVisible();
});

test("shows a no-organizations state", async ({ page }) => {
  await stubSession(page);
  await stubOrganizations(page, []);
  await page.goto("/app/overview");
  await expect(page.getByRole("heading", { name: "No organizations available." })).toBeVisible();
});

test("asks for a choice without auto-selecting the first organization", async ({ page }) => {
  await stubSession(page);
  await stubOrganizations(page, [{ organizationId: ORG_A }, { organizationId: ORG_B }]);
  await page.goto("/app/overview");
  await expect(page.getByRole("heading", { name: "Choose an organization to continue." })).toBeVisible();
  await expect(page.locator(".tenant-org-select")).toHaveValue("");
});

test("owner reads overview, agents and providers", async ({ page }) => {
  await stubSession(page);
  await stubOrganizations(page, [{ organizationId: ORG_A }]);
  await stubContext(page, ORG_A, "owner");
  await page.route("**/v1/operator/organizations/*/agents*", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: envelope({ organizationId: ORG_A, items: [agent(AGENT_A)], nextCursor: null }),
    });
  });
  await page.route("**/v1/operator/organizations/*/providers*", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: envelope({ organizationId: ORG_A, items: [provider(PROVIDER_A)], nextCursor: null }),
    });
  });
  await page.goto("/app/overview");
  await page.locator(".tenant-org-select").selectOption(ORG_A);
  await expect(page.getByRole("heading", { name: "Organization 0" })).toBeVisible();
  await expect(page.locator(".tenant-org-role")).toContainText("Owner");
  await expect(page.getByText(/Arc Testnet \(5042002\)/u)).toBeVisible();
  await expect(page.getByText("Choose Agents or Provider to view this organization.")).toBeVisible();

  await page.getByRole("link", { name: "Agents" }).click();
  await page.getByRole("button", { name: "Load agents" }).click();
  const agentRow = page.getByRole("row", { name: /Support Agent/u });
  await expect(agentRow).toBeVisible();
  await expect(agentRow).toContainText(AGENT_A);

  await page.getByRole("link", { name: "Provider" }).click();
  await page.getByRole("button", { name: "Load providers" }).click();
  await expect(page.getByRole("row", { name: /Data Provider/u })).toContainText(PROVIDER_A);
});

test("a viewer is denied the provider panel without a provider request", async ({ page }) => {
  await stubSession(page);
  await stubOrganizations(page, [{ organizationId: ORG_A }]);
  await stubContext(page, ORG_A, "viewer");
  let providerRequests = 0;
  await page.route("**/v1/operator/organizations/*/providers*", async (route) => {
    providerRequests += 1;
    await route.fulfill({ status: 500, contentType: "application/json", body: "{}" });
  });
  await page.goto("/app/overview");
  await page.locator(".tenant-org-select").selectOption(ORG_A);
  await page.getByRole("link", { name: "Provider" }).click();
  await expect(page.getByRole("heading", { name: /cannot view providers/iu })).toBeVisible();
  expect(providerRequests).toBe(0);
});

test("operator and viewer may read agents, provider_admin may not", async ({ page }) => {
  await stubSession(page);
  await stubOrganizations(page, [{ organizationId: ORG_A }]);
  await page.route("**/v1/operator/organizations/*/agents*", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: envelope({ organizationId: ORG_A, items: [agent(AGENT_A)], nextCursor: null }),
    });
  });
  let contextRole = "operator";
  await page.route("**/v1/operator/organizations/*", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith("/agents") || path.endsWith("/providers")) {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: envelope(context(ORG_A, contextRole)),
    });
  });

  await page.goto("/app/overview");
  await page.locator(".tenant-org-select").selectOption(ORG_A);
  await page.getByRole("link", { name: "Agents" }).click();
  await page.getByRole("button", { name: "Load agents" }).click();
  await expect(page.getByRole("row", { name: /Support Agent/u })).toBeVisible();

  // Reload as a viewer: agents stay readable.
  contextRole = "viewer";
  await page.reload();
  await page.locator(".tenant-org-select").selectOption(ORG_A);
  await page.getByRole("link", { name: "Agents" }).click();
  await page.getByRole("button", { name: "Load agents" }).click();
  await expect(page.getByRole("row", { name: /Support Agent/u })).toBeVisible();

  // provider_admin must not read agents.
  contextRole = "provider_admin";
  await page.reload();
  await page.locator(".tenant-org-select").selectOption(ORG_A);
  await page.getByRole("link", { name: "Agents" }).click();
  await expect(page.getByRole("heading", { name: /cannot view agents/iu })).toBeVisible();
});

test("hidden clears protected data and return requires an explicit refresh", async ({ page }) => {
  await stubSession(page);
  await stubOrganizations(page, [{ organizationId: ORG_A }]);
  await stubContext(page, ORG_A, "owner");
  await page.goto("/app/overview");
  await page.locator(".tenant-org-select").selectOption(ORG_A);
  await expect(page.getByRole("heading", { name: "Organization 0" })).toBeVisible();

  // Hide, then become visible again with no automatic data read.
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await expect(page.getByRole("heading", { name: "Refresh required" })).toBeVisible();
  await expect(page.getByText("No organizations available.")).toHaveCount(0);
  await page.getByRole("button", { name: "Refresh workspace" }).click();
  await expect(page.getByRole("heading", { name: "Choose an organization to continue." })).toBeVisible();
});

test("an unknown /app route makes no auth or tenant request", async ({ page }) => {
  await installProbes(page);
  await stubSession(page);
  await stubOrganizations(page, [{ organizationId: ORG_A }]);
  await page.goto("/app/unknown-section");
  await expect(page.getByRole("heading", { name: "This section is not available yet" })).toBeVisible();
  const state = await probes(page);
  expect(state.fetches.filter((url) => url.includes("/v1/operator/"))).toEqual([]);
  expect(state.fetches.filter((url) => url.includes("/v2/auth/"))).toEqual([]);
  expect(state.storage).toEqual([]);
  expect(state.wallet).toEqual([]);
});

test("a suspended membership clears data and never fetches children", async ({ page }) => {
  await stubSession(page);
  await stubOrganizations(page, [{ organizationId: ORG_A }]);
  await page.route("**/v1/operator/organizations/*", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: envelope(context(ORG_A, "owner", "suspended")),
    });
  });
  let childRequests = 0;
  await page.route("**/v1/operator/organizations/*/agents*", async (route) => {
    childRequests += 1;
    await route.fulfill({ status: 500, contentType: "application/json", body: "{}" });
  });
  await page.goto("/app/overview");
  await page.locator(".tenant-org-select").selectOption(ORG_A);
  await page.getByRole("link", { name: "Agents" }).click();
  await expect(page.getByRole("heading", { name: "Choose an organization to continue." })).toBeVisible();
  expect(childRequests).toBe(0);
});

test("pagination replaces the page and refuses a replay", async ({ page }) => {
  await stubSession(page);
  let listCalls = 0;
  await page.route(ORGANIZATIONS_LIST, async (route) => {
    const url = new URL(route.request().url());
    listCalls += 1;
    if (url.searchParams.get("afterOrganizationId") === ORG_A) {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: envelope({ items: [organization(ORG_B, 1)], nextCursor: null }),
      });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: envelope({ items: [organization(ORG_A)], nextCursor: ORG_A }),
    });
  });
  await page.goto("/app/overview");
  await expect(page.getByRole("heading", { name: "Choose an organization to continue." })).toBeVisible();
  await expect(page.getByRole("button", { name: /Organization 0/u })).toBeVisible();
  await page.getByRole("button", { name: "Next page" }).click();
  await expect(page.getByRole("button", { name: /Organization 1/u })).toBeVisible();
  await expect(page.getByRole("button", { name: /Organization 0/u })).toHaveCount(0);
  expect(listCalls).toBe(2);
});

test("organization pagination walks to page 3 and restores the exact first page", async ({ page }) => {
  await installProbes(page);
  await stubSession(page);
  const requestedCursors: Array<string | null> = [];
  await page.route(ORGANIZATIONS_LIST, async (route) => {
    const url = new URL(route.request().url());
    const after = url.searchParams.get("afterOrganizationId");
    requestedCursors.push(after);
    if (after === ORG_A) {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: envelope({ items: [organization(ORG_B, 11)], nextCursor: ORG_B }),
      });
      return;
    }
    if (after === ORG_B) {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: envelope({
          items: [organization("openarc:org:cccccccc-cccc-7ccc-8ccc-cccccccccccc", 12)],
          nextCursor: null,
        }),
      });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: envelope({ items: [organization(ORG_A, 10)], nextCursor: ORG_A }),
    });
  });
  await page.goto("/app/overview");
  await expect(page.getByRole("button", { name: /Organization 10/u })).toBeVisible();
  await expect(page.getByRole("button", { name: "Back to page 1" })).toHaveCount(0);

  await page.getByRole("button", { name: "Next page" }).click();
  await expect(page.getByRole("button", { name: /Organization 11/u })).toBeVisible();
  await page.getByRole("button", { name: "Next page" }).click();
  await expect(page.getByRole("button", { name: /Organization 12/u })).toBeVisible();
  await expect(page.getByRole("button", { name: /Organization 10/u })).toHaveCount(0);

  await page.getByRole("button", { name: "Back to page 1" }).click();
  await expect(page.getByRole("button", { name: /Organization 10/u })).toBeVisible();
  await expect(page.getByRole("button", { name: /Organization 11/u })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /Organization 12/u })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Back to page 1" })).toHaveCount(0);

  expect(requestedCursors).toEqual([null, ORG_A, ORG_B, null]);
  expect(new URL(page.url()).search).toBe("");
  const state = await probes(page);
  expect(state.storage).toEqual([]);
  expect(state.wallet).toEqual([]);
});

test("agent and provider pagination restore the exact first page after page 3", async ({ page }) => {
  await installProbes(page);
  await stubSession(page);
  await stubOrganizations(page, [{ organizationId: ORG_A }]);
  await stubContext(page, ORG_A, "owner");
  const AGENT_B = "openarc:agent:bbbbbbbb-bbbb-7bbb-8bbb-bbbbbbbbbbbb";
  const AGENT_C = "openarc:agent:cccccccc-cccc-7ccc-8ccc-cccccccccccc";
  const PROVIDER_B = "openarc:provider:bbbbbbbb-bbbb-7bbb-8bbb-bbbbbbbbbbbb";
  const PROVIDER_C = "openarc:provider:cccccccc-cccc-7ccc-8ccc-cccccccccccc";
  await page.route("**/v1/operator/organizations/*/agents*", async (route) => {
    const url = new URL(route.request().url());
    const after = url.searchParams.get("afterAgentId");
    if (after === AGENT_A) {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: envelope({ organizationId: ORG_A, items: [agent(AGENT_B)], nextCursor: AGENT_B }),
      });
      return;
    }
    if (after === AGENT_B) {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: envelope({ organizationId: ORG_A, items: [agent(AGENT_C)], nextCursor: null }),
      });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: envelope({ organizationId: ORG_A, items: [agent(AGENT_A)], nextCursor: AGENT_A }),
    });
  });
  await page.route("**/v1/operator/organizations/*/providers*", async (route) => {
    const url = new URL(route.request().url());
    const after = url.searchParams.get("afterProviderId");
    if (after === PROVIDER_A) {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: envelope({ organizationId: ORG_A, items: [provider(PROVIDER_B)], nextCursor: PROVIDER_B }),
      });
      return;
    }
    if (after === PROVIDER_B) {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: envelope({ organizationId: ORG_A, items: [provider(PROVIDER_C)], nextCursor: null }),
      });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: envelope({ organizationId: ORG_A, items: [provider(PROVIDER_A)], nextCursor: PROVIDER_A }),
    });
  });

  await page.goto("/app/overview");
  await page.locator(".tenant-org-select").selectOption(ORG_A);

  await page.getByRole("link", { name: "Agents" }).click();
  await page.getByRole("button", { name: "Load agents" }).click();
  await expect(page.getByRole("row", { name: new RegExp(AGENT_A, "u") })).toBeVisible();
  await page.getByRole("button", { name: "Next page" }).click();
  await expect(page.getByRole("row", { name: new RegExp(AGENT_B, "u") })).toBeVisible();
  await page.getByRole("button", { name: "Next page" }).click();
  await expect(page.getByRole("row", { name: new RegExp(AGENT_C, "u") })).toBeVisible();
  await page.getByRole("button", { name: "Back to page 1" }).click();
  await expect(page.getByRole("row", { name: new RegExp(AGENT_A, "u") })).toBeVisible();
  await expect(page.getByRole("row", { name: new RegExp(AGENT_B, "u") })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Back to page 1" })).toHaveCount(0);

  await page.getByRole("link", { name: "Provider" }).click();
  await page.getByRole("button", { name: "Load providers" }).click();
  await expect(page.getByRole("row", { name: new RegExp(PROVIDER_A, "u") })).toBeVisible();
  await page.getByRole("button", { name: "Next page" }).click();
  await expect(page.getByRole("row", { name: new RegExp(PROVIDER_B, "u") })).toBeVisible();
  await page.getByRole("button", { name: "Next page" }).click();
  await expect(page.getByRole("row", { name: new RegExp(PROVIDER_C, "u") })).toBeVisible();
  await page.getByRole("button", { name: "Back to page 1" }).click();
  await expect(page.getByRole("row", { name: new RegExp(PROVIDER_A, "u") })).toBeVisible();
  await expect(page.getByRole("row", { name: new RegExp(PROVIDER_B, "u") })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Back to page 1" })).toHaveCount(0);

  const state = await probes(page);
  expect(state.storage).toEqual([]);
  expect(state.wallet).toEqual([]);
});

test("forbidden context clears the selection and requires a reselect", async ({ page }) => {
  await stubSession(page);
  await stubOrganizations(page, [{ organizationId: ORG_A }, { organizationId: ORG_B }]);
  await page.route("**/v1/operator/organizations/*", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith(encodeURIComponent(ORG_B)) || path.endsWith(ORG_B)) {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: envelope(context(ORG_B, "owner")),
      });
      return;
    }
    await route.fulfill({
      status: 403,
      contentType: "application/json",
      body: JSON.stringify({
        ok: false,
        error: { code: "TENANT_MISMATCH", message: "The request targets a tenant that does not match the caller.", retryable: false },
        meta: META,
      }),
    });
  });
  await page.goto("/app/overview");
  await page.locator(".tenant-org-select").selectOption(ORG_A);
  await expect(page.getByRole("heading", { name: "Choose an organization to continue." })).toBeVisible();
  await expect(page.locator(".tenant-org-select")).toHaveValue("");
  await page.locator(".tenant-org-select").selectOption(ORG_B);
  await expect(page.getByRole("heading", { name: "Organization 0" })).toBeVisible();
});

test("an outage shows a fixed safe error and never a false empty success", async ({ page }) => {
  await stubSession(page);
  await page.route(ORGANIZATIONS_LIST, async (route) => {
    await route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({
        ok: false,
        error: { code: "SOURCE_UNAVAILABLE", message: "The external source is currently unavailable.", retryable: false },
        meta: META,
      }),
    });
  });
  await page.goto("/app/overview");
  await expect(page.getByRole("heading", { name: "Organizations could not be loaded" })).toBeVisible();
  await expect(page.getByText("No organizations available.")).toHaveCount(0);
});

test("a malformed response shows an error, never raw text", async ({ page }) => {
  await stubSession(page);
  await page.route(ORGANIZATIONS_LIST, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ok: true, data: { unexpected: true }, meta: {} }),
    });
  });
  await page.goto("/app/overview");
  await expect(page.getByRole("heading", { name: "Organizations could not be loaded" })).toBeVisible();
  await expect(page.getByText("unexpected", { exact: false })).toHaveCount(0);
});

test("an expired session read returns to sign-in", async ({ page }) => {
  let reads = 0;
  await page.route("**/v2/auth/session", async (route) => {
    reads += 1;
    const session =
      reads === 1
        ? { signedIn: true, accountId: ACCOUNT_A, method: "passkey", expiresAt: "2030-01-01T00:00:00.000Z" }
        : { signedIn: false };
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ok: true, data: { session }, meta: META }),
    });
  });
  await stubOrganizations(page, [{ organizationId: ORG_A }]);
  await page.goto("/app/overview");
  // A remount re-reads the session; the now-guest response must resolve to
  // sign-in, not stale data.
  await page.reload();
  await expect(page.getByRole("heading", { name: "Sign in required" })).toBeVisible();
});

test("a late A context response cannot overwrite a newer B selection", async ({ page }) => {
  await stubSession(page);
  await stubOrganizations(page, [{ organizationId: ORG_A }, { organizationId: ORG_B }]);
  await page.route("**/v1/operator/organizations/*", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith(encodeURIComponent(ORG_A)) || path.endsWith(ORG_A)) {
      await new Promise((resolve) => setTimeout(resolve, 400));
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: envelope(context(ORG_A, "owner")),
      });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: envelope(context(ORG_B, "owner")),
    });
  });
  await page.goto("/app/overview");
  await page.locator(".tenant-org-select").selectOption(ORG_A);
  await page.locator(".tenant-org-select").selectOption(ORG_B);
  await expect(page.getByRole("heading", { name: "Organization 0" })).toBeVisible();
  await page.waitForTimeout(600);
  await expect(page.locator(".tenant-org-select")).toHaveValue(ORG_B);
});

test("public routes make no tenant, auth, storage or wallet access", async ({ page }) => {
  await installProbes(page);
  for (const route of ["/", "/design", "/design/docs"]) {
    await page.goto(route);
    await page.waitForLoadState("networkidle");
  }
  const state = await probes(page);
  expect(state.fetches.filter((url) => url.includes("/v1/operator/"))).toEqual([]);
  expect(state.fetches.filter((url) => url.includes("/v2/auth/"))).toEqual([]);
  expect(state.storage).toEqual([]);
  expect(state.wallet).toEqual([]);
});

test("no browser storage is written after organization reads", async ({ page }) => {
  await installProbes(page);
  await stubSession(page);
  await stubOrganizations(page, [{ organizationId: ORG_A }]);
  await stubContext(page, ORG_A, "owner");
  await page.goto("/app/overview");
  await page.locator(".tenant-org-select").selectOption(ORG_A);
  await expect(page.getByRole("heading", { name: "Organization 0" })).toBeVisible();
  const state = await probes(page);
  expect(state.storage).toEqual([]);
  expect(await page.context().cookies()).toEqual([]);
});

test("an unknown /app path shows a bounded not-available state", async ({ page }) => {
  await stubSession(page);
  await stubOrganizations(page, [{ organizationId: ORG_A }]);
  await page.goto("/app/unknown-section");
  await expect(page.getByRole("heading", { name: "This section is not available yet" })).toBeVisible();
  await page.getByRole("link", { name: "Go to overview" }).click();
  await expect(page).toHaveURL(/\/app\/overview$/u);
});

test("mobile navigation closes with Escape and restores focus", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 780 });
  await stubSession(page);
  await stubOrganizations(page, [{ organizationId: ORG_A }]);
  await page.goto("/app/overview");
  const menu = page.getByRole("button", { name: "Menu" });
  await expect(menu).toHaveAttribute("aria-controls", "tenant-drawer");
  await menu.click();
  const dialog = page.getByRole("dialog", { name: "Workspace navigation" });
  await expect(dialog).toBeVisible();
  // Initial focus lands on the dialog's close control.
  await expect(dialog.getByRole("button", { name: "Close navigation menu" })).toBeFocused();
  // Shift+Tab at the first control wraps to the last control.
  await page.keyboard.press("Shift+Tab");
  const focusedShift = await page.evaluate(() => document.activeElement?.textContent ?? "");
  expect(focusedShift).toContain("Local workspace");
  // Tab at the last control wraps back to the first control.
  await page.keyboard.press("Tab");
  await expect(dialog.getByRole("button", { name: "Close navigation menu" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Menu" })).toBeFocused();
});

test("has no horizontal overflow at 320px and 200% text", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 800 });
  await stubSession(page);
  await stubOrganizations(page, [{ organizationId: ORG_A }]);
  await page.goto("/app/overview");
  await page.addStyleTag({ content: "html { font-size: 200%; }" });
  const overflow = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    innerWidth: window.innerWidth,
  }));
  expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.innerWidth);
});

test("honours reduced motion without breaking controls", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await stubSession(page);
  await stubOrganizations(page, [{ organizationId: ORG_A }]);
  await page.goto("/app/overview");
  await expect(page.getByRole("heading", { name: "Choose an organization to continue." })).toBeVisible();
});
