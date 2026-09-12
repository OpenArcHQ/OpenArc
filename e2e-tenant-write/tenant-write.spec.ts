import { expect, test, type Page, type Route } from "@playwright/test";

/**
 * Protected organization mutation journeys (Chromium + WebKit).
 *
 * Every account, read and write endpoint is intercepted with strict synthetic
 * fixtures. These tests prove the UI and transport contract only: they do NOT
 * prove a live API, PostgreSQL, a fresh passkey proof, TLS or the production
 * nginx proxy.
 */

const META = {
  schemaVersion: "openarc.api.v2",
  requestId: "018f47a2-3b4c-7def-8123-456789abcdef",
  buildSha: "0123456789abcdef0123456789abcdef01234567",
};

const ORG_A = "openarc:org:aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa";
const ACCOUNT_A = "openarc:account:aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa";
const AGENT_A = "openarc:agent:aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa";

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

function agent(agentId: string) {
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

function receipt(mutationId: string, operation: string, resourceType: string, resourceId: string) {
  return { mutationId, operation, resourceType, resourceId, committedAt: "2026-01-01T00:00:00.000Z" };
}

async function stubSession(page: Page, signedIn = true, method = "passkey"): Promise<void> {
  const session = signedIn
    ? {
        signedIn: true,
        accountId: ACCOUNT_A,
        method,
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

async function stubBootstrap(page: Page): Promise<void> {
  await page.route("**/v2/auth/bootstrap", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        ok: true,
        data: {
          csrfToken: "csrf-from-bootstrap",
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
}

async function stubReads(page: Page, role = "owner", organizations = [ORG_A]): Promise<void> {
  const list = { items: organizations.map((id, index) => organization(id, index)), nextCursor: null };
  await page.route("**/v1/operator/organizations?*", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: envelope(list),
    });
  });
  await page.route("**/v1/operator/organizations", async (route) => {
    if (route.request().method() === "GET") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: envelope(list),
      });
      return;
    }
    await route.fallback();
  });
  await page.route("**/v1/operator/organizations/*/agents*", async (route) => {
    if (route.request().method() === "GET") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: envelope({ organizationId: ORG_A, items: [agent(AGENT_A)], nextCursor: null }),
      });
      return;
    }
    await route.fallback();
  });
  await page.route("**/v1/operator/organizations/*/providers*", async (route) => {
    if (route.request().method() === "GET") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: envelope({ organizationId: ORG_A, items: [], nextCursor: null }),
      });
      return;
    }
    await route.fallback();
  });
  await page.route("**/v1/operator/organizations/*", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (route.request().method() !== "GET" || path.includes("/agents") || path.includes("/providers")) {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: envelope(context(ORG_A, role)),
    });
  });
}

async function openWorkspace(page: Page, path = "/app/overview"): Promise<void> {
  await page.goto(path);
  const viewport = page.viewportSize();
  if (viewport !== null && viewport.width <= 860) {
    // The static rail is hidden on narrow viewports; select in the drawer.
    await page.getByRole("button", { name: "Menu" }).click();
    await page.locator(".tenant-drawer .tenant-org-select").selectOption(ORG_A);
    // Selecting in the drawer closes it automatically.
  } else {
    await page.locator(".tenant-rail--static .tenant-org-select").selectOption(ORG_A);
  }
  await expect(page.locator(".tenant-org-select").first()).toHaveValue(ORG_A);
  if (path === "/app/agents") {
    await expect(page.getByRole("heading", { name: "Agents", exact: true })).toBeVisible();
  } else if (path === "/app/provider") {
    await expect(page.getByRole("heading", { name: "Provider", exact: true })).toBeVisible();
  } else {
    await expect(page.getByRole("heading", { name: "Organization 0" })).toBeVisible();
  }
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

test("an owner sees the mutation panel and reviews before sending", async ({ page }) => {
  await stubSession(page);
  await stubReads(page);
  await stubBootstrap(page);
  await installProbes(page);
  await openWorkspace(page);
  const panel = page.getByRole("heading", { name: "Membership and tenant changes" });
  await expect(panel).toBeVisible();
  await page.getByLabel("Display name").fill("New Agent");
  await page.getByRole("button", { name: "Review change" }).click();
  await expect(page.getByText("Confirm this change")).toBeVisible();
  // Nothing was sent during review.
  const state = await probes(page);
  expect(state.fetches.filter((url) => url.includes("/agents") && url.startsWith("POST"))).toEqual([]);
});

test("a committed agent create shows a safe receipt and never the key or body", async ({ page }) => {
  await stubSession(page);
  await stubReads(page);
  await stubBootstrap(page);
  await installProbes(page);
  let capturedBody = "";
  let capturedKey = "";
  let capturedCsrf = "";
  await page.route("**/v1/operator/organizations/*/agents", async (route: Route) => {
    if (route.request().method() !== "POST") {
      await route.fallback();
      return;
    }
    capturedBody = route.request().postData() ?? "";
    capturedKey = route.request().headers()["idempotency-key"] ?? "";
    capturedCsrf = route.request().headers()["x-openarc-csrf"] ?? "";
    const parsed = JSON.parse(capturedBody) as { mutationId: string; displayName: string };
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: envelope({
        organizationId: ORG_A,
        replayed: false,
        receipt: receipt(parsed.mutationId, "tenant.agent.create", "agent", AGENT_A),
      }),
    });
  });
  await openWorkspace(page, "/app/agents");
  await page.getByRole("button", { name: "Load agents" }).click();
  await page.getByLabel("Display name").fill("New Agent");
  await page.getByRole("button", { name: "Review change" }).click();
  await page.getByRole("button", { name: "Confirm and send" }).click();
  await expect(page.getByText("Change committed")).toBeVisible();
  await expect(
    page.getByLabel("Membership and tenant changes").getByText(AGENT_A),
  ).toBeVisible();
  // The key and CSRF are headers only; the body carries neither.
  expect(capturedKey).not.toBe("");
  expect(capturedCsrf).toBe("csrf-from-bootstrap");
  expect(capturedBody).not.toContain(capturedKey);
  expect(capturedBody).not.toContain(capturedCsrf);
  const state = await probes(page);
  expect(state.storage).toEqual([]);
  expect(state.wallet).toEqual([]);
});

test("a lost write response offers only Check status and never resubmits", async ({ page }) => {
  await stubSession(page);
  await stubReads(page);
  await stubBootstrap(page);
  let agentPosts = 0;
  await page.route("**/v1/operator/organizations/*/agents", async (route: Route) => {
    if (route.request().method() !== "POST") {
      await route.fallback();
      return;
    }
    agentPosts += 1;
    await route.abort("failed");
  });
  await openWorkspace(page, "/app/agents");
  await page.getByRole("button", { name: "Load agents" }).click();
  await page.getByLabel("Display name").fill("New Agent");
  await page.getByRole("button", { name: "Review change" }).click();
  await page.getByRole("button", { name: "Confirm and send" }).click();
  await expect(page.getByText("Outcome unknown")).toBeVisible();
  await expect(page.getByText(/may still complete/u)).toBeVisible();
  // No resubmit control exists; only Check status and Dismiss.
  await expect(page.getByRole("button", { name: "Confirm and send" })).toHaveCount(0);
  expect(agentPosts).toBe(1);
});

test("Check status with not_found keeps the unknown warning and offers no dismiss", async ({ page }) => {
  await stubSession(page);
  await stubReads(page);
  await stubBootstrap(page);
  let agentPosts = 0;
  await page.route("**/v1/operator/organizations/*/agents", async (route: Route) => {
    if (route.request().method() !== "POST") {
      await route.fallback();
      return;
    }
    agentPosts += 1;
    await route.abort("failed");
  });
  await page.route("**/v1/operator/organizations/*/mutations/*", async (route: Route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: envelope({ status: "not_found", organizationId: ORG_A }),
    });
  });
  await openWorkspace(page, "/app/agents");
  await page.getByRole("button", { name: "Load agents" }).click();
  await page.getByLabel("Display name").fill("New Agent");
  await page.getByRole("button", { name: "Review change" }).click();
  await page.getByRole("button", { name: "Confirm and send" }).click();
  await page.getByRole("button", { name: "Check status" }).click();
  await expect(
    page.getByText("No committed result found yet; it may still complete. Check again."),
  ).toBeVisible();
  // The unknown outcome stays locked: no dismiss button that restores the
  // draft, no confirm control and no second write.
  await expect(page.getByRole("button", { name: "Dismiss" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Confirm and send" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Review change" })).toHaveCount(0);
  await expect(page.getByText("Outcome unknown")).toBeVisible();
  expect(agentPosts).toBe(1);
});

test("a signed-in zero-org user can create the first organization", async ({ page }) => {
  await stubSession(page);
  await stubReads(page, "owner", []);
  await stubBootstrap(page);
  let orgPosts = 0;
  await page.route("**/v1/operator/organizations", async (route: Route) => {
    if (route.request().method() !== "POST") {
      await route.fallback();
      return;
    }
    orgPosts += 1;
    const parsed = JSON.parse(route.request().postData() ?? "{}") as { mutationId: string };
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: envelope({
        organizationId: `openarc:org:${parsed.mutationId}`,
        replayed: false,
        receipt: receipt(parsed.mutationId, "tenant.organization.create", "organization", `openarc:org:${parsed.mutationId}`),
      }),
    });
  });
  await page.goto("/app/overview");
  // No organization exists yet, but the first-organization form is offered.
  await expect(page.getByRole("heading", { name: "No organizations available." })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Membership and tenant changes" })).toBeVisible();
  await page.getByLabel("Display name").fill("First Org");
  await page.getByRole("button", { name: "Review change" }).click();
  await page.getByRole("button", { name: "Confirm and send" }).click();
  await expect(page.getByText("Change committed")).toBeVisible();
  expect(orgPosts).toBe(1);
});

test("a zero-org recovery session never sees the bootstrap form", async ({ page }) => {
  await stubSession(page, true, "recovery");
  await stubReads(page, "owner", []);
  await stubBootstrap(page);
  await page.goto("/app/overview");
  await expect(page.getByRole("heading", { name: "No organizations available." })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Membership and tenant changes" })).toHaveCount(0);
  await expect(page.getByLabel("Display name")).toHaveCount(0);
});

test("a confirmed commit stays confirmed when the follow-up read fails", async ({ page }) => {
  await stubSession(page);
  await stubReads(page);
  await stubBootstrap(page);
  await page.route("**/v1/operator/organizations/*/agents", async (route: Route) => {
    if (route.request().method() === "GET") {
      await route.fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify({ ok: false, error: { code: "INTERNAL_ERROR", message: "x", retryable: false }, meta: META }),
      });
      return;
    }
    const parsed = JSON.parse(route.request().postData() ?? "{}") as { mutationId: string };
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: envelope({
        organizationId: ORG_A,
        replayed: false,
        receipt: receipt(parsed.mutationId, "tenant.agent.create", "agent", AGENT_A),
      }),
    });
  });
  await openWorkspace(page, "/app/agents");
  await page.getByLabel("Display name").fill("New Agent");
  await page.getByRole("button", { name: "Review change" }).click();
  await page.getByRole("button", { name: "Confirm and send" }).click();
  // The write committed; the failed reload never turns it into unknown.
  await expect(page.getByText("Change committed")).toBeVisible();
  await expect(page.getByText("Outcome unknown")).toHaveCount(0);
});

test("a committed status check clears the input draft without a new write", async ({ page }) => {
  await stubSession(page);
  await stubReads(page);
  await stubBootstrap(page);
  let agentPosts = 0;
  await page.route("**/v1/operator/organizations/*/agents", async (route: Route) => {
    if (route.request().method() !== "POST") {
      await route.fallback();
      return;
    }
    agentPosts += 1;
    await route.abort("failed");
  });
  let statusGets = 0;
  await page.route("**/v1/operator/organizations/*/mutations/*", async (route: Route) => {
    statusGets += 1;
    const mutationId = new URL(route.request().url()).pathname.split("/").pop() ?? "";
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: envelope({
        status: "committed",
        organizationId: ORG_A,
        receipt: receipt(mutationId, "tenant.agent.create", "agent", AGENT_A),
      }),
    });
  });
  await openWorkspace(page, "/app/agents");
  await page.getByLabel("Display name").fill("New Agent");
  await page.getByRole("button", { name: "Review change" }).click();
  await page.getByRole("button", { name: "Confirm and send" }).click();
  await expect(page.getByText("Outcome unknown")).toBeVisible();
  await page.getByRole("button", { name: "Check status" }).click();
  await expect(page.getByText("Change already committed")).toBeVisible();
  // The recovered commit cleared the input draft and never created a second
  // write; exactly one status GET was issued.
  await expect(page.getByLabel("Display name")).toHaveValue("");
  expect(agentPosts).toBe(1);
  expect(statusGets).toBe(1);
});

test("a definite 400 shows a fixed validation error with no optimistic row", async ({ page }) => {
  await stubSession(page);
  await stubReads(page);
  await stubBootstrap(page);
  await page.route("**/v1/operator/organizations/*/agents", async (route: Route) => {
    if (route.request().method() !== "POST") {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 400,
      contentType: "application/json",
      body: JSON.stringify({
        ok: false,
        error: { code: "INVALID_REQUEST", message: "The request failed validation against the published contract.", retryable: false },
        meta: META,
      }),
    });
  });
  await openWorkspace(page, "/app/agents");
  await page.getByRole("button", { name: "Load agents" }).click();
  await page.getByLabel("Display name").fill("New Agent");
  await page.getByRole("button", { name: "Review change" }).click();
  await page.getByRole("button", { name: "Confirm and send" }).click();
  await expect(page.getByText(/server rejected the request as invalid/u)).toBeVisible();
  await expect(page.getByText("The request failed validation against the published contract.")).toHaveCount(0);
});

test("a known-recovery session blocks org creation and membership locally", async ({ page }) => {
  await stubSession(page, true, "recovery");
  await stubReads(page);
  await stubBootstrap(page);
  await openWorkspace(page);
  await page.getByLabel("Operation").selectOption("tenant.organization.create");
  await page.getByLabel("Display name").fill("New Org");
  await page.getByRole("button", { name: "Review change" }).click();
  await expect(page.getByText(/fresh passkey or wallet sign-in/u).first()).toBeVisible();
  await expect(page.getByRole("button", { name: "Confirm and send" })).toHaveCount(0);
});

test("a viewer sees no mutation panel and issues no write", async ({ page }) => {
  await stubSession(page);
  await stubReads(page, "viewer");
  await installProbes(page);
  await openWorkspace(page);
  await expect(page.getByRole("heading", { name: "Membership and tenant changes" })).toHaveCount(0);
  const state = await probes(page);
  expect(state.fetches.filter((url) => /POST|PUT|PATCH/u.test(url))).toEqual([]);
});

test("mobile keyboard does not zoom and reduced motion keeps controls usable", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 780 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await stubSession(page);
  await stubReads(page);
  await stubBootstrap(page);
  await openWorkspace(page);
  const input = page.getByLabel("Display name");
  await input.focus();
  const fontSize = await input.evaluate((element) => getComputedStyle(element).fontSize);
  expect(Number.parseFloat(fontSize)).toBeGreaterThanOrEqual(16);
  const size = await input.boundingBox();
  expect(size?.height ?? 0).toBeGreaterThanOrEqual(44);
});

test("no horizontal overflow at 320px and 200% text", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 800 });
  await stubSession(page);
  await stubReads(page);
  await stubBootstrap(page);
  await openWorkspace(page);
  await page.addStyleTag({ content: "html { font-size: 200%; }" });
  const overflow = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    innerWidth: window.innerWidth,
  }));
  expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.innerWidth);
});

test("account navigation clears the draft", async ({ page }) => {
  await stubSession(page);
  await stubReads(page);
  await stubBootstrap(page);
  await openWorkspace(page);
  await page.getByLabel("Display name").fill("Draft Agent");
  await page.getByRole("link", { name: "Account", exact: true }).first().click();
  await page.goBack();
  await page.locator(".tenant-org-select").selectOption(ORG_A);
  await expect(page.getByLabel("Display name")).toHaveValue("");
});

test("a first-organization commit keeps its receipt until the user explicitly chooses the organization", async ({ page }) => {
  await stubSession(page);
  await stubBootstrap(page);
  // The first-organization list is empty until the realistic create commit,
  // then the reload reports exactly one item, as a real API list does. The old
  // bootstrap branch stopped matching at that point and unmounted the panel
  // with the committed receipt still only in memory.
  let organizations: string[] = [];
  const pageOf = () => ({
    items: organizations.map((id, index) => organization(id, index)),
    nextCursor: null,
  });
  await page.route("**/v1/operator/organizations?*", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: envelope(pageOf()) });
  });
  await page.route("**/v1/operator/organizations", async (route) => {
    if (route.request().method() === "GET") {
      await route.fulfill({ status: 200, contentType: "application/json", body: envelope(pageOf()) });
      return;
    }
    const parsed = JSON.parse(route.request().postData() ?? "{}") as { mutationId: string };
    const created = `openarc:org:${parsed.mutationId}`;
    organizations = [created];
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: envelope({
        organizationId: created,
        replayed: false,
        receipt: receipt(parsed.mutationId, "tenant.organization.create", "organization", created),
      }),
    });
  });
  await page.route("**/v1/operator/organizations/*", async (route) => {
    const encoded = new URL(route.request().url()).pathname.split("/").pop() ?? "";
    const organizationId = decodeURIComponent(encoded);
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: envelope(context(organizationId, "owner")),
    });
  });

  await page.goto("/app/overview");
  await expect(page.getByRole("heading", { name: "No organizations available." })).toBeVisible();
  await page.getByLabel("Display name").fill("First Org");
  await page.getByRole("button", { name: "Review change" }).click();
  await page.getByRole("button", { name: "Confirm and send" }).click();

  // The list reload now reports one organization, but nothing is auto-selected
  // and the committed receipt stays visible with no create form re-enabled.
  await expect(page.getByText("Change committed")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Choose an organization to continue." })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Organization 0" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Confirm and send" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Review change" })).toHaveCount(0);

  // Only an explicit human choice clears the receipt and selects the context.
  await page.getByRole("button", { name: /Organization 0/ }).click();
  await expect(page.getByText("Change committed")).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Organization 0" })).toBeVisible();
});

test("a self-membership commit survives a revoked session with the receipt and sign-in guidance", async ({ page }) => {
  await stubSession(page);
  await stubBootstrap(page);
  await stubReads(page, "owner", [ORG_A]);
  // After the self-demotion commits the runtime revokes this session: the
  // follow-up context read and session refresh both 401. The authoritative
  // commit must stay visible with sign-in guidance and no protected surface.
  let revoked = false;
  await page.route("**/v2/auth/session", async (route) => {
    if (!revoked) {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 401,
      contentType: "application/json",
      body: JSON.stringify({
        ok: false,
        error: { code: "UNAUTHENTICATED", message: "Session revoked.", retryable: false },
        meta: META,
      }),
    });
  });
  await page.route("**/v1/operator/organizations/*", async (route) => {
    if (!revoked) {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 401,
      contentType: "application/json",
      body: JSON.stringify({
        ok: false,
        error: { code: "UNAUTHENTICATED", message: "Session revoked.", retryable: false },
        meta: META,
      }),
    });
  });
  await page.route("**/v1/operator/organizations/*/memberships/*", async (route: Route) => {
    if (route.request().method() !== "PUT") {
      await route.fallback();
      return;
    }
    const parsed = JSON.parse(route.request().postData() ?? "{}") as { mutationId: string };
    revoked = true;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: envelope({
        organizationId: ORG_A,
        replayed: false,
        receipt: receipt(parsed.mutationId, "tenant.membership.set", "membership", ACCOUNT_A),
      }),
    });
  });

  await openWorkspace(page);
  await page.getByLabel("Operation").selectOption("tenant.membership.set");
  await page.getByLabel("Target account ID").fill(ACCOUNT_A);
  await page.getByRole("button", { name: "Review change" }).click();
  await page.getByRole("button", { name: "Confirm and send" }).click();

  // The commit is authoritative even though every follow-up read is 401.
  await expect(page.getByText("Change committed")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Sign in required" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Go to account" }).first()).toBeVisible();
  await expect(page.getByText("Outcome unknown")).toHaveCount(0);
  // No protected rows or mutation controls survive the revocation.
  await expect(page.getByLabel("Operation")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Review change" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Confirm and send" })).toHaveCount(0);
  await expect(page.locator(".tenant-org-select")).toHaveCount(0);
});
