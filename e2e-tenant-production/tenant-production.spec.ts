import { request as httpsRequest } from "node:https";
import {
  expect,
  test,
  type CDPSession,
  type Page,
} from "@playwright/test";

import {
  expireAccountSessions,
  holdOrganizationRowLock,
  seedAccount,
  seedAgents,
  seedMembership,
  seedOrganizationWithRole,
  seedOwnOrganizations,
  seedProviders,
  setMembershipRole,
  waitForAccountSessionExpiry,
  waitForBlockedTenantRead,
  type FixtureHumanRole,
  type SeededOrganization,
  type SeededProfile,
} from "./fixture-db.js";

/**
 * PORT-01 protected tenant production acceptance.
 *
 * Every journey targets the REAL API + PostgreSQL + production nginx through
 * the lead-provisioned loopback origin. There is no route interception, no
 * HTTP mock, no session-cookie injection and no test-only app endpoint. The
 * account used by these journeys is created through the real passkey sign-up
 * UI; only synthetic tenant data is seeded server-side by the node fixture.
 */

test.describe.configure({ mode: "serial" });

const ORIGIN = "https://account.openarc.test:5443";
const TENANT_API_PREFIX = "/v1/operator/organizations";
const CLIENT_HEADER = "browser-v1";
const CANONICAL_ACCOUNT =
  /^openarc:account:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

interface VirtualAuthenticator {
  readonly client: CDPSession;
  readonly id: string;
}

interface ObservedResponse {
  readonly path: string;
  readonly status: number;
  readonly setCookie: boolean;
}

interface BrowserFetchResult {
  readonly status: number;
  readonly bodyText: string;
  readonly setCookie: boolean;
  readonly contentType: string | null;
}

interface NodeResponse {
  readonly status: number;
  readonly contentType: string | null;
  readonly bodyText: string;
}

async function addVirtualAuthenticator(
  page: Page,
): Promise<VirtualAuthenticator> {
  const client = await page.context().newCDPSession(page);
  await client.send("WebAuthn.enable", { enableUI: false });
  const { authenticatorId } = await client.send(
    "WebAuthn.addVirtualAuthenticator",
    {
      options: {
        protocol: "ctap2",
        ctap2Version: "ctap2_1",
        transport: "internal",
        hasResidentKey: true,
        hasUserVerification: true,
        isUserVerified: true,
        automaticPresenceSimulation: true,
      },
    },
  );
  return { client, id: authenticatorId };
}

async function removeAuthenticator(
  authenticator: VirtualAuthenticator,
): Promise<void> {
  await authenticator.client.send("WebAuthn.removeVirtualAuthenticator", {
    authenticatorId: authenticator.id,
  });
}

async function gotoAccount(page: Page): Promise<void> {
  await page.goto("/account");
  await expect(
    page.getByRole("heading", { name: "Sign in or create an account" }),
  ).toBeVisible();
}

/**
 * Real UI-only account creation. The displayed canonical account id is read
 * from the DOM; the HttpOnly cookie, storageState and raw WebAuthn credential
 * are never read, saved or logged.
 */
async function createPasskeyAccount(page: Page): Promise<string> {
  await page.getByRole("checkbox").check();
  await page.getByRole("button", { name: "Create a passkey" }).click();
  const accountIdElement = page.getByTestId("account-id");
  await expect(accountIdElement).toBeVisible();
  const accountId = (await accountIdElement.innerText()).trim();
  expect(CANONICAL_ACCOUNT.test(accountId)).toBe(true);
  return accountId;
}

async function withSignedInAccount(
  page: Page,
  run: (accountId: string) => Promise<void>,
): Promise<void> {
  await gotoAccount(page);
  const authenticator = await addVirtualAuthenticator(page);
  try {
    const accountId = await createPasskeyAccount(page);
    await run(accountId);
  } finally {
    await removeAuthenticator(authenticator);
  }
}

function observeTenantResponses(page: Page, sink: ObservedResponse[]): void {
  page.on("response", (response) => {
    let url: URL;
    try {
      url = new URL(response.url());
    } catch {
      return;
    }
    if (!url.pathname.startsWith(TENANT_API_PREFIX)) return;
    sink.push({
      path: url.pathname,
      status: response.status(),
      setCookie: response.headers()["set-cookie"] !== undefined,
    });
  });
}

function observeAuthRequests(page: Page, sink: string[]): void {
  page.on("request", (request) => {
    let url: URL;
    try {
      url = new URL(request.url());
    } catch {
      return;
    }
    if (url.pathname.startsWith("/v2/auth")) sink.push(url.pathname);
  });
}

function expectAllTenantResponsesSafe(sink: readonly ObservedResponse[]): void {
  expect(sink.length).toBeGreaterThan(0);
  for (const entry of sink) {
    expect(entry.status).toBe(200);
    expect(entry.setCookie).toBe(false);
  }
}

/**
 * The accepted nginx fail-closed routes deliberately return their generic
 * error document (which is HTML), NOT the SPA shell. The contract is
 * "no SPA bootstrap, assets, root document or protected DTO", so assert the
 * response body is bounded and generic rather than asserting a content type.
 */
const SPA_DOCUMENT_MARKERS: readonly RegExp[] = [
  /<!doctype html/iu,
  /id=["']root["']/iu,
  /\/assets\/[a-z0-9._-]+\.(?:js|css)/iu,
];

function expectBoundedGenericErrorBody(
  bodyText: string,
  status: number,
  label: string,
): void {
  expect(bodyText.length, `${label}: non-empty`).toBeGreaterThan(0);
  expect(bodyText.length, `${label}: bounded body`).toBeLessThanOrEqual(4096);
  // The generic error document names its own status; the SPA shell never does.
  expect(bodyText, `${label}: generic error status`).toContain(String(status));
  for (const marker of SPA_DOCUMENT_MARKERS) {
    expect(bodyText, `${label}: no SPA bootstrap/asset/root`).not.toMatch(marker);
  }
  // No protected organization DTO field may appear in the fail-closed body.
  expect(bodyText, `${label}: no protected DTO`).not.toMatch(
    /"(?:organizationId|displayName|membershipStatus|access)"\s*:/u,
  );
}

function tenantPath(organizationId: string): string {
  return `${TENANT_API_PREFIX}/${encodeURIComponent(organizationId)}`;
}

async function browserGet(
  page: Page,
  path: string,
  headers: Record<string, string> = {},
): Promise<BrowserFetchResult> {
  return page.evaluate(
    async ({ requestPath, requestHeaders }) => {
      const response = await fetch(requestPath, {
        method: "GET",
        headers: requestHeaders,
        credentials: "same-origin",
        cache: "no-store",
        redirect: "error",
      });
      const text = await response.text();
      return {
        status: response.status,
        bodyText: text,
        setCookie: response.headers.get("set-cookie") !== null,
        contentType: response.headers.get("content-type"),
      };
    },
    {
      requestPath: path,
      requestHeaders: { "X-OpenArc-Client": CLIENT_HEADER, ...headers },
    },
  );
}

/**
 * Fixed loopback HTTPS fixture transport. The destination host/port is not
 * parameterized; only the request method/path/headers are. Used for Node body
 * requests the browser cannot send. No request or response is logged.
 */
function loopbackRequest(input: {
  readonly method: string;
  readonly path: string;
  readonly headers?: Record<string, string>;
  readonly body?: string;
}): Promise<NodeResponse> {
  return new Promise<NodeResponse>((resolvePromise, rejectPromise) => {
    const request = httpsRequest(
      {
        hostname: "127.0.0.1",
        port: 5443,
        method: input.method,
        path: input.path,
        headers: { Host: "account.openarc.test", ...input.headers },
        rejectUnauthorized: false,
        timeout: 5_000,
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => {
          resolvePromise({
            status: response.statusCode ?? 0,
            contentType: response.headers["content-type"] ?? null,
            bodyText: Buffer.concat(chunks).toString("utf8"),
          });
        });
      },
    );
    request.on("timeout", () => request.destroy(new Error("timeout")));
    request.on("error", () => rejectPromise(new Error("TRANSPORT_UNAVAILABLE")));
    if (input.body !== undefined) request.write(input.body);
    request.end();
  });
}

async function selectOrganization(
  page: Page,
  organization: SeededOrganization,
): Promise<void> {
  await page.locator(".tenant-org-select").selectOption({
    value: organization.organizationId,
  });
  await expect(
    page.getByRole("heading", { name: organization.displayName, exact: true }),
  ).toBeVisible();
}

/**
 * Navigate through the real rail to a workspace panel and require the exact
 * heading for that role. A role that may not read the panel lands on the
 * explicit "Your role cannot view …" heading, so callers state which panel
 * outcome they expect rather than assuming an allowed panel.
 */
async function gotoPanel(
  page: Page,
  linkName: "Agents" | "Provider",
  headingName: string,
): Promise<void> {
  await page.getByRole("link", { name: linkName }).click();
  await expect(
    page.getByRole("heading", { name: headingName, exact: true }),
  ).toBeVisible();
}

function roleLabel(role: FixtureHumanRole): string {
  switch (role) {
    case "owner":
      return "Owner";
    case "operator":
      return "Operator";
    case "provider_admin":
      return "Provider admin";
    case "provider_developer":
      return "Provider developer";
    case "viewer":
      return "Viewer";
  }
}

/**
 * The overview Role definition. The rail also renders the same role text in
 * `.tenant-org-role`, so role assertions are scoped to the overview meta
 * `<dl>` (its `Role` `dd`), never the whole page.
 */
function overviewMeta(page: Page) {
  return page.locator(".tenant-meta");
}

async function expectOverviewRole(
  page: Page,
  role: FixtureHumanRole,
): Promise<void> {
  await expect(overviewMeta(page).getByText(roleLabel(role))).toBeVisible();
}

/**
 * Lexical order used by the accepted list reads (`ORDER BY agent_id` /
 * `provider_id`) and by the API client's code-unit cursor comparison. The
 * seeded ids share a constant prefix, so ordering the full canonical ids gives
 * the expected server page order regardless of random insertion time.
 */
function lexicalOrder(ids: readonly string[]): string[] {
  return [...ids].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
}

/** Expected page sets for a fixed profile count and bounded page size. */
function expectedProfilePages(
  profiles: readonly SeededProfile[],
  pageSize = 50,
): string[][] {
  const ordered = lexicalOrder(profiles.map((profile) => profile.id));
  const pages: string[][] = [];
  for (let start = 0; start < ordered.length; start += pageSize) {
    pages.push(ordered.slice(start, start + pageSize));
  }
  return pages;
}

/** Reads the rendered Agent/Provider ID column (third cell) of each row. */
async function renderedProfileIds(page: Page): Promise<string[]> {
  const rows = page.locator(".tenant-table tbody tr");
  const total = await rows.count();
  const ids: string[] = [];
  for (let index = 0; index < total; index += 1) {
    ids.push((await rows.nth(index).locator("td").nth(2).innerText()).trim());
  }
  return ids;
}

function expectSameIds(
  actual: readonly string[],
  expected: readonly string[],
): void {
  expect(lexicalOrder(actual)).toEqual(lexicalOrder(expected));
}

/**
 * The required first-page control. A missing control must fail the run and be
 * reported for lead correction, never silently skipped.
 */
function firstPageControl(page: Page) {
  return page.getByRole("button", {
    name: /back to page 1|first page|previous page|go to page 1/iu,
  });
}

interface PrivacyCounts {
  readonly localReads: number;
  readonly localWrites: number;
  readonly sessionReads: number;
  readonly sessionWrites: number;
  readonly indexedDbOpens: number;
  readonly walletProviderAccess: number;
}

/**
 * Counts storage access/writes, IndexedDB opens and wallet-provider access.
 * It never reads a stored value, an account id or a request body, and it does
 * NOT touch `navigator.credentials`, so the genuine WebAuthn ceremony is not
 * misreported as external wallet access. Installed before the first navigation
 * so every protected and public document is covered.
 */
async function installPrivacyInstrumentation(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const counts = {
      localReads: 0,
      localWrites: 0,
      sessionReads: 0,
      sessionWrites: 0,
      indexedDbOpens: 0,
      walletProviderAccess: 0,
    };
    (window as typeof window & { __openarcPrivacy?: typeof counts }).__openarcPrivacy =
      counts;

    try {
      const local = window.localStorage;
      const rawLocalGet = local.getItem.bind(local);
      local.getItem = (name) => {
        counts.localReads += 1;
        return rawLocalGet(name);
      };
      const rawLocalSet = local.setItem.bind(local);
      local.setItem = (name, value) => {
        counts.localWrites += 1;
        rawLocalSet(name, value);
      };
      const rawLocalRemove = local.removeItem.bind(local);
      local.removeItem = (name) => {
        counts.localWrites += 1;
        rawLocalRemove(name);
      };
      const rawLocalClear = local.clear.bind(local);
      local.clear = () => {
        counts.localWrites += 1;
        rawLocalClear();
      };
    } catch {
      // Storage instrumentation is best-effort; a patch failure keeps the
      // remaining counters meaningful and never changes app behavior.
    }

    try {
      const session = window.sessionStorage;
      const rawSessionGet = session.getItem.bind(session);
      session.getItem = (name) => {
        counts.sessionReads += 1;
        return rawSessionGet(name);
      };
      const rawSessionSet = session.setItem.bind(session);
      session.setItem = (name, value) => {
        counts.sessionWrites += 1;
        rawSessionSet(name, value);
      };
      const rawSessionRemove = session.removeItem.bind(session);
      session.removeItem = (name) => {
        counts.sessionWrites += 1;
        rawSessionRemove(name);
      };
      const rawSessionClear = session.clear.bind(session);
      session.clear = () => {
        counts.sessionWrites += 1;
        rawSessionClear();
      };
    } catch {
      // See above.
    }

    try {
      const idb = window.indexedDB;
      const rawOpen = idb.open.bind(idb);
      idb.open = ((...args: unknown[]) => {
        counts.indexedDbOpens += 1;
        return (rawOpen as (...inner: unknown[]) => IDBOpenDBRequest)(...args);
      }) as typeof idb.open;
    } catch {
      // See above.
    }

    try {
      Object.defineProperty(window, "ethereum", {
        configurable: true,
        get() {
          counts.walletProviderAccess += 1;
          return undefined;
        },
      });
    } catch {
      // No injected-provider hook available; wallet access stays uncounted.
    }
  });
}

async function readPrivacyCounts(page: Page): Promise<PrivacyCounts> {
  return page.evaluate(() => {
    const state = (
      window as typeof window & { __openarcPrivacy?: Partial<PrivacyCounts> }
    ).__openarcPrivacy;
    return {
      localReads: state?.localReads ?? 0,
      localWrites: state?.localWrites ?? 0,
      sessionReads: state?.sessionReads ?? 0,
      sessionWrites: state?.sessionWrites ?? 0,
      indexedDbOpens: state?.indexedDbOpens ?? 0,
      walletProviderAccess: state?.walletProviderAccess ?? 0,
    };
  });
}

/**
 * Every field must be zero for the named scope. The `scope` label is included
 * so a failure names the phase without printing any stored value, id or token.
 */
function expectNoSensitiveStorage(counts: PrivacyCounts, scope: string): void {
  expect({
    scope,
    localReads: counts.localReads,
    localWrites: counts.localWrites,
    sessionReads: counts.sessionReads,
    sessionWrites: counts.sessionWrites,
    indexedDbOpens: counts.indexedDbOpens,
    walletProviderAccess: counts.walletProviderAccess,
  }).toEqual({
    scope,
    localReads: 0,
    localWrites: 0,
    sessionReads: 0,
    sessionWrites: 0,
    indexedDbOpens: 0,
    walletProviderAccess: 0,
  });
}

test.describe(
  "PORT-01 protected tenant production acceptance",
  { tag: "@tenant-on" },
  () => {
    test("signed-out /app/overview requires sign in and makes no tenant request", async ({
      page,
    }) => {
      const tenantResponses: ObservedResponse[] = [];
      observeTenantResponses(page, tenantResponses);

      await page.goto("/app/overview");
      await expect(
        page.getByRole("heading", { name: "Sign in required" }),
      ).toBeVisible();
      await expect(page.getByRole("link", { name: "Go to account" })).toBeVisible();
      expect(tenantResponses).toEqual([]);
    });

    test("an unknown /app route makes no auth or tenant request", async ({
      page,
    }) => {
      const tenantResponses: ObservedResponse[] = [];
      const authRequests: string[] = [];
      observeTenantResponses(page, tenantResponses);
      observeAuthRequests(page, authRequests);

      await page.goto("/app/definitely-unknown");
      await expect(
        page.getByRole("heading", {
          name: "This section is not available yet",
        }),
      ).toBeVisible();
      expect(authRequests).toEqual([]);
      expect(tenantResponses).toEqual([]);
    });

    test("real signup shows zero organizations, then seeded orgs require an explicit choice", async ({
      page,
    }) => {
      await withSignedInAccount(page, async (accountId) => {
        await page.goto("/app/overview");
        await expect(
          page.getByRole("heading", { name: "No organizations available." }),
        ).toBeVisible();

        const seeded = await seedOwnOrganizations(accountId, [
          "Tenant Fixture Alpha",
          "Tenant Fixture Beta",
        ]);
        expect(seeded).toHaveLength(2);

        await page.reload();
        await expect(
          page.getByRole("heading", {
            name: "Choose an organization to continue.",
          }),
        ).toBeVisible();
        const chooser = page.locator(".tenant-org-select");
        await expect(chooser).toBeVisible();
        await expect(chooser).toHaveValue("");
        await expect(
          page.getByRole("option", { name: "Tenant Fixture Alpha" }),
        ).toBeAttached();
        await expect(
          page.getByRole("option", { name: "Tenant Fixture Beta" }),
        ).toBeAttached();
      });
    });

    test("selecting a seeded organization loads overview, agents and providers with safe responses", async ({
      page,
    }) => {
      await withSignedInAccount(page, async (accountId) => {
        const seeded = await seedOwnOrganizations(accountId, [
          "Tenant Fixture Omega",
          "Tenant Fixture Delta",
        ]);
        const organization = seeded[0];
        expect(organization).toBeDefined();
        if (organization === undefined) throw new Error("seed missing");
        const agents = await seedAgents(organization.organizationId, 3);
        const providers = await seedProviders(organization.organizationId, 2);

        const tenantResponses: ObservedResponse[] = [];
        observeTenantResponses(page, tenantResponses);

        await page.goto("/app/overview");
        await selectOrganization(page, organization);
        await expectOverviewRole(page, "owner");
        await expect(
          overviewMeta(page).getByText(/Arc Testnet \(5042002\)/u),
        ).toBeVisible();
        await expect(page.locator(".tenant-testnet")).toHaveText("TESTNET");
        expect(page.url()).not.toContain("openarc:org");
        expect(new URL(page.url()).search).toBe("");

        await gotoPanel(page, "Agents", "Agents");
        await page.getByRole("button", { name: "Load agents" }).click();
        await expect(
          page.getByRole("cell", { name: agents[0]?.displayName ?? "" }),
        ).toBeVisible();
        await expect(
          page.getByRole("cell", { name: agents[0]?.id ?? "" }),
        ).toBeVisible();

        await gotoPanel(page, "Provider", "Provider");
        await page.getByRole("button", { name: "Load providers" }).click();
        await expect(
          page.getByRole("cell", { name: providers[0]?.displayName ?? "" }),
        ).toBeVisible();
        await expect(
          page.getByRole("cell", { name: providers[0]?.id ?? "" }),
        ).toBeVisible();

        expectAllTenantResponsesSafe(tenantResponses);
      });
    });

    test("reload clears the selected organization and requires a new explicit choice", async ({
      page,
    }) => {
      await withSignedInAccount(page, async (accountId) => {
        const seeded = await seedOwnOrganizations(accountId, [
          "Tenant Fixture Reload",
        ]);
        const organization = seeded[0];
        if (organization === undefined) throw new Error("seed missing");

        await page.goto("/app/overview");
        await selectOrganization(page, organization);
        await page.reload();

        await expect(
          page.getByRole("heading", {
            name: "Choose an organization to continue.",
          }),
        ).toBeVisible();
        await expect(page.locator(".tenant-org-select")).toHaveValue("");
      });
    });

    test("agents paginate with a bounded default 50 that replaces the page", async ({
      page,
    }) => {
      await withSignedInAccount(page, async (accountId) => {
        const seeded = await seedOwnOrganizations(accountId, [
          "Tenant Fixture Agents Page",
        ]);
        const organization = seeded[0];
        if (organization === undefined) throw new Error("seed missing");
        const agents = await seedAgents(organization.organizationId, 101);
        expect(agents).toHaveLength(101);
        const [page1, page2, page3] = expectedProfilePages(agents);
        expect(page1).toHaveLength(50);
        expect(page2).toHaveLength(50);
        expect(page3).toHaveLength(1);

        await page.goto("/app/overview");
        await selectOrganization(page, organization);
        await gotoPanel(page, "Agents", "Agents");
        await page.getByRole("button", { name: "Load agents" }).click();

        const rows = page.locator(".tenant-table tbody tr");
        await expect(rows).toHaveCount(50);
        expectSameIds(await renderedProfileIds(page), page1 ?? []);
        expect(new URL(page.url()).search).toBe("");
        expect(page.url()).not.toContain("openarc:agent");

        await page.getByRole("button", { name: "Next page" }).click();
        await expect(
          page.getByRole("cell", { name: page2?.[0] ?? "", exact: true }),
        ).toBeVisible();
        await expect(rows).toHaveCount(50);
        const secondPage = await renderedProfileIds(page);
        expectSameIds(secondPage, page2 ?? []);
        // The response REPLACES the page: no first-page id may survive.
        for (const id of page1 ?? []) expect(secondPage).not.toContain(id);
        expect(new URL(page.url()).search).toBe("");
        expect(page.url()).not.toContain("openarc:agent");

        await page.getByRole("button", { name: "Next page" }).click();
        await expect(
          page.getByRole("cell", { name: page3?.[0] ?? "", exact: true }),
        ).toBeVisible();
        await expect(rows).toHaveCount(1);
        expectSameIds(await renderedProfileIds(page), page3 ?? []);
        expect(new URL(page.url()).search).toBe("");
        expect(page.url()).not.toContain("openarc:agent");

        const back = firstPageControl(page);
        if ((await back.count()) === 0) {
          throw new Error(
            "MISSING_FRONTEND_CONTROL: pagination requires a first-page control",
          );
        }
        await back.first().click();
        await expect(
          page.getByRole("cell", { name: page1?.[0] ?? "", exact: true }),
        ).toBeVisible();
        await expect(rows).toHaveCount(50);
        expectSameIds(await renderedProfileIds(page), page1 ?? []);
      });
    });

    test("providers paginate with a bounded default 50 that replaces the page", async ({
      page,
    }) => {
      await withSignedInAccount(page, async (accountId) => {
        const seeded = await seedOwnOrganizations(accountId, [
          "Tenant Fixture Providers Page",
        ]);
        const organization = seeded[0];
        if (organization === undefined) throw new Error("seed missing");
        const providers = await seedProviders(organization.organizationId, 101);
        expect(providers).toHaveLength(101);
        const [page1, page2, page3] = expectedProfilePages(providers);
        expect(page1).toHaveLength(50);
        expect(page2).toHaveLength(50);
        expect(page3).toHaveLength(1);

        await page.goto("/app/overview");
        await selectOrganization(page, organization);
        await gotoPanel(page, "Provider", "Provider");
        await page.getByRole("button", { name: "Load providers" }).click();

        const rows = page.locator(".tenant-table tbody tr");
        await expect(rows).toHaveCount(50);
        expectSameIds(await renderedProfileIds(page), page1 ?? []);
        expect(new URL(page.url()).search).toBe("");
        expect(page.url()).not.toContain("openarc:provider");

        await page.getByRole("button", { name: "Next page" }).click();
        await expect(
          page.getByRole("cell", { name: page2?.[0] ?? "", exact: true }),
        ).toBeVisible();
        await expect(rows).toHaveCount(50);
        const secondPage = await renderedProfileIds(page);
        expectSameIds(secondPage, page2 ?? []);
        for (const id of page1 ?? []) expect(secondPage).not.toContain(id);
        expect(new URL(page.url()).search).toBe("");
        expect(page.url()).not.toContain("openarc:provider");

        await page.getByRole("button", { name: "Next page" }).click();
        await expect(
          page.getByRole("cell", { name: page3?.[0] ?? "", exact: true }),
        ).toBeVisible();
        await expect(rows).toHaveCount(1);
        expectSameIds(await renderedProfileIds(page), page3 ?? []);
        expect(new URL(page.url()).search).toBe("");
        expect(page.url()).not.toContain("openarc:provider");

        const back = firstPageControl(page);
        if ((await back.count()) === 0) {
          throw new Error(
            "MISSING_FRONTEND_CONTROL: pagination requires a first-page control",
          );
        }
        await back.first().click();
        await expect(
          page.getByRole("cell", { name: page1?.[0] ?? "", exact: true }),
        ).toBeVisible();
        await expect(rows).toHaveCount(50);
        expectSameIds(await renderedProfileIds(page), page1 ?? []);
      });
    });

    test("operator can read agents but a provider read is denied without a provider GET", async ({
      page,
    }) => {
      await withSignedInAccount(page, async (accountId) => {
        const owner = await seedAccount();
        const organization = await seedOrganizationWithRole(
          owner,
          accountId,
          "Tenant Fixture Operator",
          "operator",
        );
        const tenantResponses: ObservedResponse[] = [];
        observeTenantResponses(page, tenantResponses);

        await page.goto("/app/overview");
        await selectOrganization(page, organization);
        await expectOverviewRole(page, "operator");

        await gotoPanel(page, "Agents", "Agents");
        await page.getByRole("button", { name: "Load agents" }).click();
        await expect(page.getByText("No agents in this organization.")).toBeVisible();

        await gotoPanel(page, "Provider", "Your role cannot view providers");
        await expect(
          page.getByRole("heading", {
            name: "Your role cannot view providers",
          }),
        ).toBeVisible();
        expect(
          tenantResponses.filter((entry) => entry.path.endsWith("/providers")),
        ).toEqual([]);
      });
    });

    test("viewer can read agents but a provider read is denied without a provider GET", async ({
      page,
    }) => {
      await withSignedInAccount(page, async (accountId) => {
        const owner = await seedAccount();
        const organization = await seedOrganizationWithRole(
          owner,
          accountId,
          "Tenant Fixture Viewer",
          "viewer",
        );
        const tenantResponses: ObservedResponse[] = [];
        observeTenantResponses(page, tenantResponses);

        await page.goto("/app/overview");
        await selectOrganization(page, organization);
        await expectOverviewRole(page, "viewer");

        await gotoPanel(page, "Agents", "Agents");
        await page.getByRole("button", { name: "Load agents" }).click();
        await expect(page.getByText("No agents in this organization.")).toBeVisible();

        await gotoPanel(page, "Provider", "Your role cannot view providers");
        await expect(
          page.getByRole("heading", {
            name: "Your role cannot view providers",
          }),
        ).toBeVisible();
        expect(
          tenantResponses.filter((entry) => entry.path.endsWith("/providers")),
        ).toEqual([]);
      });
    });

    for (const role of ["provider_admin", "provider_developer"] as const) {
      test(`${role} resolves organization context but agents and providers are denied`, async ({
        page,
      }) => {
        await withSignedInAccount(page, async (accountId) => {
          const owner = await seedAccount();
          const organization = await seedOrganizationWithRole(
            owner,
            accountId,
            `Tenant Fixture ${role}`,
            role,
          );
          const tenantResponses: ObservedResponse[] = [];
          observeTenantResponses(page, tenantResponses);

          await page.goto("/app/overview");
          await selectOrganization(page, organization);
          await expectOverviewRole(page, role);

          await gotoPanel(page, "Agents", "Your role cannot view agents");
          await expect(
            page.getByRole("heading", {
              name: "Your role cannot view agents",
            }),
          ).toBeVisible();
          await gotoPanel(page, "Provider", "Your role cannot view providers");
          await expect(
            page.getByRole("heading", {
              name: "Your role cannot view providers",
            }),
          ).toBeVisible();
          expect(
            tenantResponses.filter(
              (entry) =>
                entry.path.endsWith("/agents") ||
                entry.path.endsWith("/providers"),
            ),
          ).toEqual([]);
        });
      });
    }

    test("foreign and suspended memberships fail closed with 403 and no other org data", async ({
      page,
    }) => {
      await withSignedInAccount(page, async (accountId) => {
        const owner = await seedAccount();
        const foreign = await seedOwnOrganizations(owner, [
          "Tenant Fixture Foreign",
        ]);
        const foreignOrganization = foreign[0];
        if (foreignOrganization === undefined) throw new Error("seed missing");
        const suspended = await seedOwnOrganizations(owner, [
          "Tenant Fixture Suspended",
        ]);
        const suspendedOrganization = suspended[0];
        if (suspendedOrganization === undefined) throw new Error("seed missing");
        await seedMembership(
          suspendedOrganization.organizationId,
          accountId,
          "viewer",
          "suspended",
        );

        const foreignResult = await browserGet(
          page,
          tenantPath(foreignOrganization.organizationId),
        );
        expect(foreignResult.status).toBe(403);
        expect(foreignResult.setCookie).toBe(false);
        expect(foreignResult.bodyText).not.toContain(foreignOrganization.organizationId);
        expect(foreignResult.bodyText).not.toContain(
          foreignOrganization.displayName,
        );

        const suspendedResult = await browserGet(
          page,
          tenantPath(suspendedOrganization.organizationId),
        );
        expect(suspendedResult.status).toBe(403);
        expect(suspendedResult.setCookie).toBe(false);
        expect(suspendedResult.bodyText).not.toContain(
          suspendedOrganization.organizationId,
        );

        const listResult = await browserGet(page, TENANT_API_PREFIX);
        expect(listResult.status).toBe(200);
        expect(listResult.bodyText).not.toContain(
          foreignOrganization.organizationId,
        );
      });
    });

    test("real membership demotion revokes the target session and clears old data", async ({
      page,
    }) => {
      await withSignedInAccount(page, async (accountId) => {
        const coOwner = await seedAccount();
        const seeded = await seedOwnOrganizations(accountId, [
          "Tenant Fixture Demotion",
        ]);
        const organization = seeded[0];
        if (organization === undefined) throw new Error("seed missing");
        await seedMembership(organization.organizationId, coOwner, "owner", "active");
        await seedAgents(organization.organizationId, 2);

        await page.goto("/app/overview");
        await selectOrganization(page, organization);
        await gotoPanel(page, "Agents", "Agents");
        await page.getByRole("button", { name: "Load agents" }).click();
        await expect(page.getByRole("cell", { name: "Fixture Agent 001" })).toBeVisible();

        await setMembershipRole(
          coOwner,
          organization.organizationId,
          accountId,
          "viewer",
          "active",
        );

        const afterDemotion = await browserGet(
          page,
          tenantPath(organization.organizationId),
        );
        expect(afterDemotion.status).toBe(401);

        await page.reload();
        await expect(
          page.getByRole("heading", { name: "Sign in required" }),
        ).toBeVisible();
        await expect(
          page.getByRole("cell", { name: "Fixture Agent 001" }),
        ).toHaveCount(0);
      });
    });

    test("account logout then workspace reentry clears the selected organization", async ({
      page,
    }) => {
      await withSignedInAccount(page, async (accountId) => {
        const seeded = await seedOwnOrganizations(accountId, [
          "Tenant Fixture Logout",
        ]);
        const organization = seeded[0];
        if (organization === undefined) throw new Error("seed missing");

        await page.goto("/app/overview");
        await selectOrganization(page, organization);

        await page.goto("/account");
        await page.getByRole("button", { name: "Sign out" }).click();
        await expect(
          page.getByRole("heading", { name: "Sign in or create an account" }),
        ).toBeVisible();

        await page.goto("/app/overview");
        await expect(
          page.getByRole("heading", { name: "Sign in required" }),
        ).toBeVisible();
        await expect(page.locator(".tenant-org-select")).toHaveCount(0);
      });
    });

    test("short-lived session clears protected data on the timer and the server returns 401", async ({
      page,
    }) => {
      await withSignedInAccount(page, async (accountId) => {
        const seeded = await seedOwnOrganizations(accountId, [
          "Tenant Fixture Expiry",
        ]);
        const organization = seeded[0];
        if (organization === undefined) throw new Error("seed missing");
        await seedAgents(organization.organizationId, 1);
        const affected = await expireAccountSessions(accountId, 6);
        expect(affected).toBeGreaterThan(0);

        await page.goto("/app/overview");
        await selectOrganization(page, organization);
        await gotoPanel(page, "Agents", "Agents");
        await page.getByRole("button", { name: "Load agents" }).click();
        await expect(page.getByRole("cell", { name: "Fixture Agent 001" })).toBeVisible();

        await expect(
          page.getByRole("heading", { name: "Session expired. Sign in again." }),
        ).toBeVisible({ timeout: 15_000 });
        expect(await waitForAccountSessionExpiry(accountId, 5_000)).toBe(true);

        const expired = await browserGet(page, TENANT_API_PREFIX);
        expect(expired.status).toBe(401);
        expect(expired.bodyText).not.toContain("Tenant Fixture Expiry");
      });
    });

    test("hidden then visible workspace clears data and requires an explicit refresh", async ({
      page,
    }) => {
      await withSignedInAccount(page, async (accountId) => {
        const seeded = await seedOwnOrganizations(accountId, [
          "Tenant Fixture Hidden",
        ]);
        const organization = seeded[0];
        if (organization === undefined) throw new Error("seed missing");

        await page.goto("/app/overview");
        await selectOrganization(page, organization);

        await page.evaluate(() => {
          Object.defineProperty(document, "visibilityState", {
            configurable: true,
            get: () => "hidden",
          });
          document.dispatchEvent(new Event("visibilitychange"));
        });
        await page.evaluate(() => {
          Object.defineProperty(document, "visibilityState", {
            configurable: true,
            get: () => "visible",
          });
          document.dispatchEvent(new Event("visibilitychange"));
        });

        await expect(
          page.getByRole("heading", { name: "Refresh required" }),
        ).toBeVisible();
        await expect(
          page.getByRole("button", { name: "Refresh workspace" }),
        ).toBeVisible();
        await expect(
          page.getByRole("heading", { name: organization.displayName, exact: true }),
        ).toHaveCount(0);
      });
    });

    test("a locked tenant read crossing database expiry returns 401 with no DTO", async ({
      page,
    }) => {
      await withSignedInAccount(page, async (accountId) => {
        const seeded = await seedOwnOrganizations(accountId, [
          "Tenant Fixture Lock",
        ]);
        const organization = seeded[0];
        if (organization === undefined) throw new Error("seed missing");

        await page.goto("/app/overview");
        await selectOrganization(page, organization);

        // Expire the session only AFTER the workspace has loaded and just
        // before the blocked read. The read acquires the session lock while the
        // session is still valid, waits on the organization row lock, then
        // rechecks expiry once the lock is released. A 2s expiry keeps the wait
        // well inside the server's 5s statement timeout, so the final 401 is
        // the database-expiry proof rather than a statement timeout.
        const affected = await expireAccountSessions(accountId, 2);
        expect(affected).toBeGreaterThan(0);

        const lock = await holdOrganizationRowLock(organization.organizationId);
        const readPromise = browserGet(
          page,
          tenantPath(organization.organizationId),
        );
        // Mark any early rejection handled; the explicit await below still
        // observes it when the lock/expiry observations succeed.
        void readPromise.catch(() => undefined);
        try {
          expect(await waitForBlockedTenantRead(5_000)).toBe(true);
          expect(await waitForAccountSessionExpiry(accountId, 10_000)).toBe(true);
        } finally {
          // Release the held organization lock before awaiting the blocked
          // read, so the following 401 is the database-expiry authorization
          // proof rather than merely a statement timeout.
          await lock.release();
        }
        const read = await readPromise;
        expect(read.status).toBe(401);
        expect(read.setCookie).toBe(false);
        expect(read.bodyText).not.toContain("organizationId");
      });
    });

    test("proxy rejects methods, authorization, bodies, hostile metadata and unknown paths", async () => {
      const root = TENANT_API_PREFIX;

      expect((await loopbackRequest({ method: "HEAD", path: root })).status).toBe(405);
      expect((await loopbackRequest({ method: "POST", path: root })).status).toBe(405);
      expect((await loopbackRequest({ method: "PUT", path: root })).status).toBe(405);
      expect((await loopbackRequest({ method: "OPTIONS", path: root })).status).toBe(405);

      const authorized = await loopbackRequest({
        method: "GET",
        path: root,
        headers: { Authorization: "Bearer synthetic" },
      });
      expect(authorized.status).toBe(403);

      const withLength = await loopbackRequest({
        method: "GET",
        path: root,
        headers: { "Content-Length": "1" },
        body: "x",
      });
      expect(withLength.status).toBe(400);

      const withChunked = await loopbackRequest({
        method: "GET",
        path: root,
        body: "x",
      });
      expect(withChunked.status).toBe(400);

      const hostileOrigin = await loopbackRequest({
        method: "GET",
        path: root,
        headers: {
          Origin: "https://hostile.example",
          "X-OpenArc-Client": CLIENT_HEADER,
        },
      });
      expect(hostileOrigin.status).toBe(403);

      const hostileSite = await loopbackRequest({
        method: "GET",
        path: root,
        headers: {
          "Sec-Fetch-Site": "cross-site",
          "X-OpenArc-Client": CLIENT_HEADER,
        },
      });
      expect(hostileSite.status).toBe(403);

      const failClosedPaths = [
        `${TENANT_API_PREFIX}/not-a-canonical-org`,
        `${TENANT_API_PREFIX}/openarc%253Aorg%253Aaaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa`,
        `${TENANT_API_PREFIX}/%zz`,
        `${TENANT_API_PREFIX}/openarc:org:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/unknown`,
      ];
      for (const path of failClosedPaths) {
        const result = await loopbackRequest({ method: "GET", path });
        expect([400, 404], path).toContain(result.status);
        expectBoundedGenericErrorBody(result.bodyText, result.status, path);
      }
    });

    test("strict CSP, scoped tenant style, and private storage across signup, protected reads and the public route", async ({
      page,
    }) => {
      const violations: string[] = [];
      // Instrumentation is installed BEFORE the first navigation so the
      // protected signup/tenant reads and the public route are all covered.
      await installPrivacyInstrumentation(page);
      await page.addInitScript(() => {
        const sink: string[] = [];
        (window as typeof window & { __csp?: string[] }).__csp = sink;
        document.addEventListener("securitypolicyviolation", (event) => {
          sink.push(event.effectiveDirective);
        });
      });

      const response = await page.goto("/app/overview");
      expect(response).not.toBeNull();
      const csp = response?.headers()["content-security-policy"] ?? null;
      expect(csp).not.toBeNull();
      expect(csp ?? "").toContain("'self'");
      expect(csp ?? "").not.toContain("'unsafe-inline'");
      expect(csp ?? "").not.toContain("'unsafe-eval'");

      const shell = page.locator(".tenant-shell");
      await expect(shell).toBeVisible();
      // Prove the actual scoped tenant stylesheet is applied by the stable
      // tenant grid declaration, not merely that the element is not hidden.
      const display = await shell.evaluate(
        (element) => getComputedStyle(element).display,
      );
      expect(display).toBe("grid");

      const documentUrl = new URL(page.url());
      const styleHref = await page
        .locator('link[data-tenant-style="true"]')
        .getAttribute("href");
      expect(styleHref).not.toBeNull();
      // The built asset href may be relative (`/assets/...`); resolve it
      // against the actual document URL before comparing same-origin.
      const styleUrl = new URL(styleHref ?? "", documentUrl);
      expect(styleUrl.origin).toBe(documentUrl.origin);
      expect(styleUrl.origin).toBe(ORIGIN);

      violations.push(
        ...(await page.evaluate(
          () => (window as typeof window & { __csp?: string[] }).__csp ?? [],
        )),
      );
      expect(violations).toEqual([]);

      // Genuine UI-only passkey signup under the strict CSP and instrumentation.
      await gotoAccount(page);
      const authenticator = await addVirtualAuthenticator(page);
      let accountId: string;
      try {
        accountId = await createPasskeyAccount(page);
      } finally {
        await removeAuthenticator(authenticator);
      }
      expectNoSensitiveStorage(
        await readPrivacyCounts(page),
        "account-signup",
      );

      // Authenticated tenant profile reads: agents and providers are loaded
      // through the real protected API and must not touch browser storage or
      // any wallet provider.
      const seeded = await seedOwnOrganizations(accountId, [
        "Tenant Fixture Privacy",
      ]);
      const organization = seeded[0];
      if (organization === undefined) throw new Error("seed missing");
      const agents = await seedAgents(organization.organizationId, 2);
      const providers = await seedProviders(organization.organizationId, 2);

      await page.goto("/app/overview");
      await selectOrganization(page, organization);
      await gotoPanel(page, "Agents", "Agents");
      await page.getByRole("button", { name: "Load agents" }).click();
      await expect(
        page.getByRole("cell", { name: agents[0]?.displayName ?? "" }),
      ).toBeVisible();
      await gotoPanel(page, "Provider", "Provider");
      await page.getByRole("button", { name: "Load providers" }).click();
      await expect(
        page.getByRole("cell", { name: providers[0]?.displayName ?? "" }),
      ).toBeVisible();

      expectNoSensitiveStorage(
        await readPrivacyCounts(page),
        "protected-tenant-reads",
      );

      // Public/design route: zero auth or tenant requests, and zero storage or
      // wallet access scoped separately from the protected document.
      await page.goto("/design");
      const authRequests: string[] = [];
      const tenantResponses: ObservedResponse[] = [];
      observeAuthRequests(page, authRequests);
      observeTenantResponses(page, tenantResponses);
      await page.reload();
      await page.waitForLoadState("networkidle");
      expect(authRequests).toEqual([]);
      expect(tenantResponses).toEqual([]);
      expect(
        await page.locator('link[data-tenant-style="true"]').count(),
      ).toBe(0);
      expectNoSensitiveStorage(await readPrivacyCounts(page), "public-design");

      const storageKeys = await page.evaluate(() => ({
        localKeys: Object.keys(window.localStorage),
        sessionKeys: Object.keys(window.sessionStorage),
      }));
      expect(
        [...storageKeys.localKeys, ...storageKeys.sessionKeys].filter((key) =>
          /session|csrf|token/iu.test(key),
        ),
      ).toEqual([]);
    });
  },
);

test.describe(
  "PORT-01 tenant flag OFF",
  { tag: "@tenant-off" },
  () => {
    test("flag off renders the unavailable workspace, makes no requests and denies the tenant API", async ({
      page,
    }) => {
      const tenantResponses: ObservedResponse[] = [];
      const authRequests: string[] = [];
      observeTenantResponses(page, tenantResponses);
      observeAuthRequests(page, authRequests);

      await page.goto("/app/overview");
      await expect(
        page.getByRole("heading", {
          name: "Organization workspace is not available in this deployment",
        }),
      ).toBeVisible();
      expect(authRequests).toEqual([]);
      expect(tenantResponses).toEqual([]);

      const direct = await browserGet(page, TENANT_API_PREFIX);
      expect(direct.status).toBe(404);
      expect(direct.setCookie).toBe(false);
      // The disabled image deliberately returns nginx's generic error document
      // (HTML), never the SPA shell and never a protected DTO.
      expectBoundedGenericErrorBody(
        direct.bodyText,
        direct.status,
        "tenant-off direct API",
      );
    });
  },
);
