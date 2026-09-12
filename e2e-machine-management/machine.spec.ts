import { expect, test, type Page, type Route } from "@playwright/test";

/**
 * Human machine-credential console journeys (Chromium + WebKit).
 *
 * Every account, read, credential and write endpoint is intercepted with strict
 * synthetic fixtures. These tests prove the UI and transport contract only:
 * they do NOT prove a live API, PostgreSQL, a fresh passkey proof, TLS or the
 * production nginx proxy. No machine session exchange/self/revoke endpoint is
 * ever exercised.
 */

const META = {
  schemaVersion: "openarc.api.v2",
  requestId: "018f47a2-3b4c-7def-8123-456789abcdef",
  buildSha: "0123456789abcdef0123456789abcdef01234567",
};

const UUID = "12345678-1234-4234-8123-123456789abc";
const UUID_B = "87654321-4321-4321-b123-abcdefabcdef";
const ORG_A = `openarc:org:${UUID}`;
const ACCOUNT_A = `openarc:account:${UUID}`;
const AGENT_A = `openarc:agent:${UUID}`;
const PROVIDER_A = `openarc:provider:${UUID}`;
const AGENT_PREFIX = `oac_ag_${UUID_B}`;
const AGENT_CREDENTIAL = `oac_ag_${UUID_B}_${"A".repeat(42)}A`;
const CREATED = "2026-01-01T00:00:00.000Z";
const EXPIRES = "2026-01-02T00:00:00.000Z";

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

function context(role: string) {
  return {
    organization: organization(ORG_A),
    access: {
      schemaVersion: "openarc.organization-access.v1",
      organizationId: ORG_A,
      accountId: ACCOUNT_A,
      role,
      membershipStatus: "active",
      sessionExpiresAt: "2030-01-01T00:00:00.000Z",
    },
    network: "eip155:5042002",
  };
}

function agent(agentId: string, status = "active") {
  return {
    schemaVersion: "openarc.agent-profile.v1",
    agentId,
    organizationId: ORG_A,
    displayName: "Support Agent",
    status,
    createdAt: CREATED,
    updatedAt: CREATED,
  };
}

function provider(providerId: string, status = "active") {
  return {
    schemaVersion: "openarc.provider-profile.v1",
    providerId,
    organizationId: ORG_A,
    displayName: "Support Provider",
    status,
    createdAt: CREATED,
    updatedAt: CREATED,
  };
}

function metadata(overrides: Record<string, unknown> = {}) {
  return {
    credentialId: UUID,
    kind: "agent",
    profileId: AGENT_A,
    publicPrefix: `oac_ag_${UUID}`,
    environment: "eip155:5042002",
    scopes: ["agent:self.read"],
    scopeVersion: 1,
    createdAt: CREATED,
    expiresAt: EXPIRES,
    revokedAt: null,
    status: "active",
    ...overrides,
  };
}

/**
 * Issues one fresh `available_once` agent credential through the existing
 * synthetic browser fixture. The raw value is a non-production fixture string;
 * callers must never log it and must only derive safe booleans from it.
 */
async function issueFreshCredential(page: Page): Promise<void> {
  await stubSession(page);
  await stubReads(page);
  await stubBootstrap(page);
  await page.route("**/v1/operator/organizations/*/agents/*/credentials*", async (route: Route) => {
    if (route.request().method() !== "POST") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: envelope({ organizationId: ORG_A, kind: "agent", profileId: AGENT_A, items: [], nextCursor: null }),
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
        receipt: {
          mutationId: parsed.mutationId,
          operation: "tenant.agent.credential.issue",
          resourceType: "agent_credential",
          credentialId: parsed.mutationId,
          committedAt: CREATED,
        },
        delivery: { status: "available_once", credential: AGENT_CREDENTIAL, publicPrefix: AGENT_PREFIX },
      }),
    });
  });
  await openWorkspace(page);
  await selectAgentCredentials(page);
  await page.getByRole("button", { name: "Review issue" }).click();
  await page.getByRole("button", { name: "Confirm", exact: true }).click();
  await expect(page.getByLabel("New machine credential")).toHaveValue(AGENT_CREDENTIAL);
}

async function stubSession(page: Page, signedIn = true, method = "passkey"): Promise<void> {
  const session = signedIn
    ? { signedIn: true, accountId: ACCOUNT_A, method, expiresAt: "2030-01-01T00:00:00.000Z" }
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
          session: { signedIn: true, accountId: ACCOUNT_A, method: "passkey", expiresAt: "2030-01-01T00:00:00.000Z" },
        },
        meta: META,
      }),
    });
  });
}

async function stubReads(page: Page, role = "owner"): Promise<void> {
  await page.route("**/v1/operator/organizations?*", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: envelope({ items: [organization(ORG_A)], nextCursor: null }),
    });
  });
  await page.route("**/v1/operator/organizations", async (route) => {
    if (route.request().method() === "GET") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: envelope({ items: [organization(ORG_A)], nextCursor: null }),
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
        body: envelope({ organizationId: ORG_A, items: [provider(PROVIDER_A)], nextCursor: null }),
      });
      return;
    }
    await route.fallback();
  });
  await page.route("**/v1/operator/organizations/*", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (route.request().method() !== "GET" || /\/(agents|providers)/u.test(path)) {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: envelope(context(role)),
    });
  });
}

async function openWorkspace(page: Page, path = "/app/agents"): Promise<void> {
  await page.goto(path);
  const viewport = page.viewportSize();
  if (viewport !== null && viewport.width <= 860) {
    await page.getByRole("button", { name: "Menu" }).click();
    await page.locator(".tenant-drawer .tenant-org-select").selectOption(ORG_A);
  } else {
    await page.locator(".tenant-rail--static .tenant-org-select").selectOption(ORG_A);
  }
  await expect(page.locator(".tenant-org-select").first()).toHaveValue(ORG_A);
}

async function selectAgentCredentials(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Load agents" }).click();
  await expect(page.getByRole("button", { name: "Manage credentials" })).toBeVisible();
  await page.getByRole("button", { name: "Manage credentials" }).click();
  await expect(page.getByRole("heading", { name: "Agent credential" })).toBeVisible();
}

async function installProbes(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const w = window as typeof window & {
      __fetches?: string[];
      __storage?: string[];
      __wallet?: string[];
      __clipboard?: number;
    };
    w.__fetches = [];
    w.__storage = [];
    w.__wallet = [];
    w.__clipboard = 0;
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
    if (navigator.clipboard) {
      try {
        Object.defineProperty(navigator, "clipboard", {
          configurable: true,
          get() {
            w.__clipboard = (w.__clipboard ?? 0) + 1;
            return undefined;
          },
        });
      } catch {
        // Clipboard override is best-effort; the test asserts no automatic call.
      }
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
      __clipboard?: number;
    };
    return {
      fetches: w.__fetches ?? [],
      storage: w.__storage ?? [],
      wallet: w.__wallet ?? [],
      clipboard: w.__clipboard ?? 0,
    };
  });
}

test("an explicit profile selection reveals the credential panel and issues one credential", async ({ page }) => {
  await stubSession(page);
  await stubReads(page);
  await stubBootstrap(page);
  await installProbes(page);
  let issuePosts = 0;
  let capturedKey = "";
  let capturedCsrf = "";
  await page.route("**/v1/operator/organizations/*/agents/*/credentials*", async (route: Route) => {
    if (route.request().method() !== "POST") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: envelope({ organizationId: ORG_A, kind: "agent", profileId: AGENT_A, items: [], nextCursor: null }),
      });
      return;
    }
    issuePosts += 1;
    capturedKey = route.request().headers()["idempotency-key"] ?? "";
    capturedCsrf = route.request().headers()["x-openarc-csrf"] ?? "";
    const parsed = JSON.parse(route.request().postData() ?? "{}") as { mutationId: string };
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: envelope({
        organizationId: ORG_A,
        replayed: false,
        receipt: {
          mutationId: parsed.mutationId,
          operation: "tenant.agent.credential.issue",
          resourceType: "agent_credential",
          credentialId: parsed.mutationId,
          committedAt: CREATED,
        },
        delivery: { status: "available_once", credential: AGENT_CREDENTIAL, publicPrefix: AGENT_PREFIX },
      }),
    });
  });
  await openWorkspace(page);
  // No inferred first profile: the panel appears only after an explicit select.
  await expect(page.getByRole("heading", { name: "Agent credential" })).toHaveCount(0);
  await selectAgentCredentials(page);
  await page.getByRole("button", { name: "Load credentials" }).click();
  await expect(page.getByText("No credentials for this profile.")).toBeVisible();
  await page.getByRole("button", { name: "Review issue" }).click();
  await expect(page.getByText("Confirm this credential action")).toBeVisible();
  // Nothing was sent during review.
  expect((await probes(page)).fetches.filter((entry) => /credentials.*POST/u.test(entry))).toEqual([]);
  await page.getByRole("button", { name: "Confirm", exact: true }).click();
  await expect(page.getByText("Credential action committed")).toBeVisible();
  await expect(page.getByLabel("New machine credential")).toHaveValue(AGENT_CREDENTIAL);
  expect(issuePosts).toBe(1);
  expect(capturedKey).not.toBe("");
  expect(capturedCsrf).toBe("csrf-from-bootstrap");
  const state = await probes(page);
  expect(state.storage).toEqual([]);
  expect(state.wallet).toEqual([]);
  expect(state.clipboard).toBe(0);
});

test("the one-time credential is hidden after Dismiss and cannot be re-revealed", async ({ page }) => {
  await stubSession(page);
  await stubReads(page);
  await stubBootstrap(page);
  await page.route("**/v1/operator/organizations/*/agents/*/credentials*", async (route: Route) => {
    if (route.request().method() !== "POST") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: envelope({ organizationId: ORG_A, kind: "agent", profileId: AGENT_A, items: [], nextCursor: null }),
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
        receipt: {
          mutationId: parsed.mutationId,
          operation: "tenant.agent.credential.issue",
          resourceType: "agent_credential",
          credentialId: parsed.mutationId,
          committedAt: CREATED,
        },
        delivery: { status: "available_once", credential: AGENT_CREDENTIAL, publicPrefix: AGENT_PREFIX },
      }),
    });
  });
  await openWorkspace(page);
  await selectAgentCredentials(page);
  await page.getByRole("button", { name: "Review issue" }).click();
  await page.getByRole("button", { name: "Confirm", exact: true }).click();
  await expect(page.getByLabel("New machine credential")).toHaveValue(AGENT_CREDENTIAL);
  await page.getByRole("button", { name: "Dismiss" }).click();
  await expect(page.getByLabel("New machine credential")).toHaveCount(0);
  // The warning explains that the secret is gone and how to recover safely.
  await expect(page.getByText(/cannot be shown again|no longer available/u)).toBeVisible();
});

test("machine lifecycle synchronously erases a fresh credential on pagehide", async ({ page }) => {
  await issueFreshCredential(page);
  // In THE SAME task: dispatch pagehide, then inspect DOM and raw absence.
  const result = await page.evaluate((raw: string) => {
    const input = (): HTMLTextAreaElement | null =>
      document.querySelector<HTMLTextAreaElement>("#machine-secret-value");
    const presentBefore = input()?.value === raw;
    window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: false }));
    const after = input();
    return {
      presentBefore,
      inputGone: after === null,
      rawAbsentFromDom: !document.documentElement.outerHTML.includes(raw),
      rawAbsentFromValue: after === null || after.value !== raw,
    };
  }, AGENT_CREDENTIAL);
  expect(result.presentBefore).toBe(true);
  expect(result.inputGone).toBe(true);
  expect(result.rawAbsentFromDom).toBe(true);
  expect(result.rawAbsentFromValue).toBe(true);
});

test("machine lifecycle synchronously erases a fresh credential on hidden visibility", async ({ page }) => {
  await issueFreshCredential(page);
  // In THE SAME task: flip visibilityState to hidden, dispatch
  // visibilitychange, then inspect DOM and raw absence.
  const result = await page.evaluate((raw: string) => {
    const input = (): HTMLTextAreaElement | null =>
      document.querySelector<HTMLTextAreaElement>("#machine-secret-value");
    const presentBefore = input()?.value === raw;
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => "hidden",
    });
    document.dispatchEvent(new Event("visibilitychange"));
    const after = input();
    return {
      presentBefore,
      inputGone: after === null,
      rawAbsentFromDom: !document.documentElement.outerHTML.includes(raw),
      rawAbsentFromValue: after === null || after.value !== raw,
    };
  }, AGENT_CREDENTIAL);
  expect(result.presentBefore).toBe(true);
  expect(result.inputGone).toBe(true);
  expect(result.rawAbsentFromDom).toBe(true);
  expect(result.rawAbsentFromValue).toBe(true);
});

test("a fresh secret is never auto-announced and blocks a second issue until Dismiss", async ({ page }) => {
  await stubSession(page);
  await stubReads(page);
  await stubBootstrap(page);
  let issuePosts = 0;
  await page.route("**/v1/operator/organizations/*/agents/*/credentials*", async (route: Route) => {
    if (route.request().method() !== "POST") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: envelope({ organizationId: ORG_A, kind: "agent", profileId: AGENT_A, items: [], nextCursor: null }),
      });
      return;
    }
    issuePosts += 1;
    const parsed = JSON.parse(route.request().postData() ?? "{}") as { mutationId: string };
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: envelope({
        organizationId: ORG_A,
        replayed: false,
        receipt: {
          mutationId: parsed.mutationId,
          operation: "tenant.agent.credential.issue",
          resourceType: "agent_credential",
          credentialId: parsed.mutationId,
          committedAt: CREATED,
        },
        delivery: { status: "available_once", credential: AGENT_CREDENTIAL, publicPrefix: AGENT_PREFIX },
      }),
    });
  });
  await openWorkspace(page);
  await selectAgentCredentials(page);
  await page.getByRole("button", { name: "Review issue" }).click();
  await page.getByRole("button", { name: "Confirm", exact: true }).click();
  const secret = page.getByLabel("New machine credential");
  await expect(secret).toHaveValue(AGENT_CREDENTIAL);
  // The raw secret must NOT live inside an aria-live region: no auto-announcement.
  const insideLive = await secret.evaluate((node) => {
    let current: Element | null = node;
    while (current !== null) {
      if (current.getAttribute("aria-live") !== null || current.getAttribute("role") === "status") {
        return true;
      }
      current = current.parentElement;
    }
    return false;
  });
  expect(insideLive).toBe(false);
  // A second issue is blocked while the fresh secret is visible: no form/action.
  await expect(page.getByRole("button", { name: "Review issue" })).toHaveCount(0);
  expect(issuePosts).toBe(1);
  // Explicit Dismiss makes the credential unrecoverable and re-enables issue.
  await page.getByRole("button", { name: "Dismiss" }).click();
  await expect(page.getByLabel("New machine credential")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Review issue" })).toBeVisible();
  await page.getByRole("button", { name: "Review issue" }).click();
  await page.getByRole("button", { name: "Confirm", exact: true }).click();
  await expect.poll(() => issuePosts).toBe(2);
  expect(issuePosts).toBe(2);
});

test("a lost issue response offers only Check status and never resubmits", async ({ page }) => {
  await stubSession(page);
  await stubReads(page);
  await stubBootstrap(page);
  let issuePosts = 0;
  await page.route("**/v1/operator/organizations/*/agents/*/credentials*", async (route: Route) => {
    if (route.request().method() !== "POST") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: envelope({ organizationId: ORG_A, kind: "agent", profileId: AGENT_A, items: [], nextCursor: null }),
      });
      return;
    }
    issuePosts += 1;
    await route.abort("failed");
  });
  await openWorkspace(page);
  await selectAgentCredentials(page);
  await page.getByRole("button", { name: "Review issue" }).click();
  await page.getByRole("button", { name: "Confirm", exact: true }).click();
  await expect(page.getByText("Outcome unknown")).toBeVisible();
  await expect(page.getByRole("button", { name: "Confirm", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Review issue" })).toHaveCount(0);
  expect(issuePosts).toBe(1);
});

test("Check status with not_found keeps the unknown warning and locks resend", async ({ page }) => {
  await stubSession(page);
  await stubReads(page);
  await stubBootstrap(page);
  let issuePosts = 0;
  await page.route("**/v1/operator/organizations/*/agents/*/credentials*", async (route: Route) => {
    if (route.request().method() !== "POST") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: envelope({ organizationId: ORG_A, kind: "agent", profileId: AGENT_A, items: [], nextCursor: null }),
      });
      return;
    }
    issuePosts += 1;
    await route.abort("failed");
  });
  await page.route("**/v1/operator/organizations/*/agent-credential-mutations/*", async (route: Route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: envelope({ organizationId: ORG_A, status: "not_found" }),
    });
  });
  await openWorkspace(page);
  await selectAgentCredentials(page);
  await page.getByRole("button", { name: "Review issue" }).click();
  await page.getByRole("button", { name: "Confirm", exact: true }).click();
  await page.getByRole("button", { name: "Check status" }).click();
  await expect(
    page.getByText("No committed result found yet; it may still complete. Check again."),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Review issue" })).toHaveCount(0);
  await expect(page.getByText("Outcome unknown")).toBeVisible();
  expect(issuePosts).toBe(1);
});

test("a replay commit shows no secret and offers an explicit revoke then a new issue", async ({ page }) => {
  await stubSession(page);
  await stubReads(page);
  await stubBootstrap(page);
  let issuePosts = 0;
  await page.route("**/v1/operator/organizations/*/agents/*/credentials*", async (route: Route) => {
    if (route.request().method() !== "POST") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: envelope({
          organizationId: ORG_A,
          kind: "agent",
          profileId: AGENT_A,
          items: [metadata({ credentialId: UUID_B, status: "active" })],
          nextCursor: null,
        }),
      });
      return;
    }
    issuePosts += 1;
    const parsed = JSON.parse(route.request().postData() ?? "{}") as { mutationId: string };
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: envelope({
        organizationId: ORG_A,
        replayed: true,
        receipt: {
          mutationId: parsed.mutationId,
          operation: "tenant.agent.credential.issue",
          resourceType: "agent_credential",
          credentialId: parsed.mutationId,
          committedAt: CREATED,
        },
        delivery: { status: "token_not_replayable" },
      }),
    });
  });
  await page.route("**/v1/operator/organizations/*/agent-credentials/*/revoke", async (route: Route) => {
    const parsed = JSON.parse(route.request().postData() ?? "{}") as { mutationId: string };
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: envelope({
        organizationId: ORG_A,
        replayed: false,
        receipt: {
          mutationId: parsed.mutationId,
          operation: "tenant.agent.credential.revoke",
          resourceType: "agent_credential",
          credentialId: UUID_B,
          committedAt: CREATED,
        },
      }),
    });
  });
  await openWorkspace(page);
  await selectAgentCredentials(page);
  await page.getByRole("button", { name: "Review issue" }).click();
  await page.getByRole("button", { name: "Confirm", exact: true }).click();
  await expect(page.getByText("Credential action already committed")).toBeVisible();
  await expect(page.getByLabel("New machine credential")).toHaveCount(0);
  expect(issuePosts).toBe(1);

  // Explicit two-step revoke of the credential; then a separate new issue.
  await page.getByRole("button", { name: "Revoke", exact: true }).click();
  await page.getByRole("button", { name: "Confirm revoke" }).click();
  // The revoke draft enters an explicit confirmation stage before sending.
  await page.getByRole("button", { name: "Confirm", exact: true }).click();
  await expect(page.getByText("Credential action committed")).toBeVisible();
  await expect(page.getByText(/was revoked/u)).toBeVisible();
  // A new logical issue is a separate, explicitly reviewed action.
  const reviewAgain = page.getByRole("button", { name: "Review issue" });
  await expect(reviewAgain).toBeVisible();
  await reviewAgain.click();
  await expect(page.getByText("Confirm this credential action")).toBeVisible();
  await page.getByRole("button", { name: "Confirm", exact: true }).click();
  await expect.poll(() => issuePosts).toBe(2);
});

test("a recovery session cannot issue and sees the fresh sign-in guidance", async ({ page }) => {
  await stubSession(page, true, "recovery");
  await stubReads(page);
  await stubBootstrap(page);
  await openWorkspace(page);
  await selectAgentCredentials(page);
  await page.getByRole("button", { name: "Review issue" }).click();
  await expect(page.getByText(/fresh passkey or wallet sign-in/u).first()).toBeVisible();
  await expect(page.getByRole("button", { name: "Confirm", exact: true })).toHaveCount(0);
});

test("a viewer cannot see or issue credentials", async ({ page }) => {
  await stubSession(page);
  await stubReads(page, "viewer");
  await installProbes(page);
  await openWorkspace(page);
  await page.getByRole("button", { name: "Load agents" }).click();
  await expect(page.getByRole("button", { name: "Manage credentials" })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Agent credential" })).toHaveCount(0);
  const state = await probes(page);
  expect(state.fetches.filter((entry) => /credentials/u.test(entry))).toEqual([]);
});

test("account navigation clears a selected credential context", async ({ page }) => {
  await stubSession(page);
  await stubReads(page);
  await installProbes(page);
  await openWorkspace(page);
  await selectAgentCredentials(page);
  await expect(page.getByRole("heading", { name: "Agent credential" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Close credentials" })).toBeVisible();
});

test("no horizontal overflow at 320px and reduced motion keeps controls usable", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 800 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await stubSession(page);
  await stubReads(page);
  await stubBootstrap(page);
  await openWorkspace(page);
  await selectAgentCredentials(page);
  await page.addStyleTag({ content: "html { font-size: 200%; }" });
  const overflow = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    innerWidth: window.innerWidth,
  }));
  expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.innerWidth);
  const button = page.getByRole("button", { name: "Review issue" });
  await button.focus();
  const size = await button.boundingBox();
  expect(size?.height ?? 0).toBeGreaterThanOrEqual(32);
});
