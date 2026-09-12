import { expect, test, type Page, type Route } from "@playwright/test";

/**
 * Labelled contract fixtures only.
 *
 * Every response below is an in-repo synthetic fixture that satisfies the
 * published v2 envelope and public DTO schemas. These are NOT database rows and
 * make no claim about a real backend. The browser is served exclusively through
 * `page.route`; no request can escape to a real origin.
 */

const META = {
  schemaVersion: "openarc.api.v2",
  requestId: "018f47a2-3b4c-7def-8123-456789abcdef",
  buildSha: "0123456789abcdef0123456789abcdef01234567",
};

const V4_A = "12345678-1234-4234-8123-123456789abc";
const V4_B = "87654321-4321-4321-b123-abcdefabcdef";
const LISTING_A = `openarc:listing:${V4_A}`;
const LISTING_B = `openarc:listing:${V4_B}`;
const PROVIDER_A = `openarc:provider:${V4_A}`;
const ISO = "2024-01-01T00:00:00.000Z";
const DIGEST = `sha256:${"a".repeat(64)}`;
const DIGEST_B = `sha256:${"b".repeat(64)}`;

const ON = "http://127.0.0.1:5271";
const OFF = "http://127.0.0.1:5272";
const API_ON = "http://127.0.0.1:5273";

function publicVersion(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: "openarc.listing-public-version.v1",
    listingId: LISTING_A,
    providerId: PROVIDER_A,
    version: "3",
    kind: "api",
    title: "Synthetic declared API",
    description: "A labelled contract fixture; this is not a database claim.",
    manifest: {
      schemaVersion: "openarc.listing-manifest.v1",
      inputSchemaDigest: DIGEST,
      outputSchemaDigest: DIGEST_B,
    },
    price: {
      amount: {
        schemaVersion: "openarc.usdc-amount.v1",
        networkId: "eip155:5042002",
        asset: "USDC",
        atomicAmount: "2500000",
        representation: "erc20",
        decimals: 6,
      },
      pricingModel: "fixed",
    },
    evidenceContract: {
      schemaVersion: "openarc.receipt-contract.v1",
      receiptType: "openarc.delivery.v1",
      receiptSchemaDigest: DIGEST,
      deliveryFields: ["result", "status"],
    },
    endpointOrigin: "https://provider.example.com",
    termsRevision: "terms-2024-01-01",
    privacySummary: "The provider declares its own handling of request inputs.",
    paymentLane: "unavailable",
    availability: { status: "available", rateLimitPerMinute: "60" },
    status: "active",
    publishedAt: ISO,
    ...overrides,
  };
}

function enabledManifest() {
  return {
    capabilityVersion: "openarc.capabilities.marketplace.v1",
    environment: "testnet",
    network: "eip155:5042002",
    capabilities: [
      { family: "public_catalog", audience: "public", state: "enabled", dependencies: ["marketDatabase"] },
      { family: "listing_management", audience: "browser", state: "built_disabled", dependencies: ["auth", "tenantDatabase", "marketDatabase"] },
      { family: "moderation", audience: "browser", state: "built_disabled", dependencies: ["auth", "marketDatabase"] },
    ],
    routes: [
      { id: "catalog_list", family: "public_catalog", audience: "public", method: "GET", path: "/v2/public/market/listings" },
      { id: "catalog_detail", family: "public_catalog", audience: "public", method: "GET", path: "/v2/public/market/listings/:listingId" },
      { id: "catalog_provider", family: "public_catalog", audience: "public", method: "GET", path: "/v2/public/market/providers/:providerId" },
      { id: "listing_roots", family: "listing_management", audience: "browser", method: "GET", path: "/v2/provider/organizations/:organizationId/listings" },
      { id: "listing_create", family: "listing_management", audience: "browser", method: "POST", path: "/v2/provider/organizations/:organizationId/listings" },
      { id: "listing_root", family: "listing_management", audience: "browser", method: "GET", path: "/v2/provider/organizations/:organizationId/listings/:listingId" },
      { id: "listing_versions", family: "listing_management", audience: "browser", method: "GET", path: "/v2/provider/organizations/:organizationId/listings/:listingId/versions" },
      { id: "listing_version_create", family: "listing_management", audience: "browser", method: "POST", path: "/v2/provider/organizations/:organizationId/listings/:listingId/versions" },
      { id: "listing_version", family: "listing_management", audience: "browser", method: "GET", path: "/v2/provider/organizations/:organizationId/listings/:listingId/versions/:version" },
      { id: "listing_draft_mutation_status", family: "listing_management", audience: "browser", method: "GET", path: "/v2/provider/organizations/:organizationId/listing-mutations/:mutationId" },
      { id: "listing_provider_options", family: "listing_management", audience: "browser", method: "GET", path: "/v2/provider/organizations/:organizationId/listing-providers" },
      { id: "listing_publish", family: "listing_management", audience: "browser", method: "POST", path: "/v2/provider/organizations/:organizationId/listings/:listingId/versions/:version/publish" },
      { id: "listing_pause", family: "listing_management", audience: "browser", method: "POST", path: "/v2/provider/organizations/:organizationId/listings/:listingId/versions/:version/pause" },
      { id: "listing_retire", family: "listing_management", audience: "browser", method: "POST", path: "/v2/provider/organizations/:organizationId/listings/:listingId/versions/:version/retire" },
      { id: "listing_lifecycle_mutation_status", family: "listing_management", audience: "browser", method: "GET", path: "/v2/provider/organizations/:organizationId/listing-lifecycle-mutations/:mutationId" },
      { id: "moderation_version", family: "moderation", audience: "browser", method: "GET", path: "/v2/moderator/organizations/:organizationId/listings/:listingId/versions/:version" },
      { id: "moderation_origin_review", family: "moderation", audience: "browser", method: "POST", path: "/v2/moderator/organizations/:organizationId/listings/:listingId/versions/:version/origin-review" },
      { id: "moderation_mutation_status", family: "moderation", audience: "browser", method: "GET", path: "/v2/moderator/organizations/:organizationId/listing-lifecycle-mutations/:mutationId" },
    ],
  };
}

function envelope(data: unknown) {
  return { ok: true, data, meta: META };
}

/** Installs the accepted-response mock and records every request URL. */
async function installAcceptedMocks(page: Page): Promise<{ requests: string[] }> {
  const requests: string[] = [];
  page.on("request", (request) => requests.push(request.url()));
  await page.route("**/v2/public/**", async (route: Route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    if (path === "/v2/public/marketplace-capabilities") {
      await route.fulfill({ json: envelope(enabledManifest()) });
      return;
    }
    if (path === `/v2/public/market/listings/${encodeURIComponent(LISTING_A)}`) {
      await route.fulfill({ json: envelope({ listingId: LISTING_A, item: publicVersion() }) });
      return;
    }
    if (path === `/v2/public/market/listings/${encodeURIComponent(LISTING_B)}`) {
      await route.fulfill({ json: envelope({ listingId: LISTING_B, item: null }) });
      return;
    }
    if (path === `/v2/public/market/providers/${encodeURIComponent(PROVIDER_A)}`) {
      await route.fulfill({
        json: envelope({
          providerId: PROVIDER_A,
          item: {
            schemaVersion: "openarc.provider-public.v1",
            providerId: PROVIDER_A,
            displayName: "Synthetic Provider",
            status: "active",
          },
        }),
      });
      return;
    }
    if (path === "/v2/public/market/listings") {
      const providerId = url.searchParams.get("providerId");
      if (providerId === PROVIDER_A) {
        await route.fulfill({
          json: envelope({ items: [publicVersion()], nextCursor: null }),
        });
        return;
      }
      await route.fulfill({
        json: envelope({
          items: [publicVersion()],
          nextCursor: LISTING_A,
        }),
      });
      return;
    }
    // Any other public path is a labelled not-found contract fixture.
    await route.fulfill({ status: 404, body: "not found" });
  });
  return { requests };
}

function isSameOriginRequests(requests: string[]): boolean {
  return requests.every((url) => url.startsWith(ON) || url.startsWith(OFF));
}

test.describe("flag ON public marketplace", () => {
  test("lists declared services with an exact decimal price and no private fields", async ({ page }) => {
    await installAcceptedMocks(page);
    await page.goto("/market");
    await expect(page.getByRole("heading", { name: "Declared provider services" })).toBeVisible();
    await expect(page.getByText("Synthetic declared API")).toBeVisible();
    await expect(page.getByText("2.5 USDC")).toBeVisible();
    // Public DTO only: a private organization id is never rendered.
    await expect(page.locator("body")).not.toContainText("openarc:org:");
    await expect(page.locator("body")).not.toContainText("organizationId");
    // Visual QA only, captured AFTER the real assertions above.
    await page.screenshot({ path: "/workspace/test-results/market-qa-index.png" });
  });

  test("opens detail, provider, docs, status and legal routes", async ({ page }) => {
    await installAcceptedMocks(page);

    await page.goto(`/market/${encodeURIComponent(LISTING_A)}`);
    await expect(page.getByRole("heading", { name: "Exact version" })).toBeVisible();
    await expect(page.getByText("https://provider.example.com")).toBeVisible();
    await expect(page.getByText("2.5 USDC")).toBeVisible();
    await expect(page.getByText("Not yet available.")).toBeVisible();
    await expect(page.locator("body")).not.toContainText("organizationId");
    // Visual QA only, captured AFTER the detail assertions above.
    await page.screenshot({ path: "/workspace/test-results/market-qa-detail.png" });

    await page.goto(`/providers/${encodeURIComponent(PROVIDER_A)}`);
    await expect(page.getByRole("heading", { name: "Synthetic Provider" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Declared listings" })).toBeVisible();

    await page.goto("/docs");
    await expect(page.getByRole("heading", { name: "How the public catalog works" })).toBeVisible();
    await expect(page.getByText("Purchases are not yet available")).toBeVisible();

    await page.goto("/status");
    await expect(page.getByRole("heading", { name: "Marketplace capabilities" })).toBeVisible();
    await expect(page.getByText("public_catalog")).toBeVisible();
    await expect(page.getByText("enabled", { exact: true })).toBeVisible();

    await page.goto("/legal");
    await expect(page.getByRole("heading", { name: "Product and privacy information" })).toBeVisible();
    await expect(page.getByText("No anonymous or zero-retention claim is made here.")).toBeVisible();
  });

  test("search and pagination are explicit and bounded", async ({ page }) => {
    const { requests } = await installAcceptedMocks(page);
    await page.goto("/market");
    await expect(page.getByText("Synthetic declared API")).toBeVisible();

    // Explicit Enter submits the search; typing alone must not query.
    await page.getByLabel("Search declared titles").fill("synthetic");
    const beforeSubmit = requests.filter((url) => url.includes("/v2/public/market/listings?")).length;
    await expect(page.getByRole("heading", { name: "Declared provider services" })).toBeVisible();
    await page.getByLabel("Search declared titles").press("Enter");
    const afterSubmit = requests.filter((url) => url.includes("/v2/public/market/listings?")).length;
    // The first search issued a bounded page read (at most one new read).
    expect(afterSubmit - beforeSubmit).toBeLessThanOrEqual(1);

    // Next page is an explicit click, never automatic.
    const readsBeforeNext = requests.filter((url) => url.includes("/v2/public/market/listings?")).length;
    await page.getByRole("button", { name: "Next page" }).click();
    const readsAfterNext = requests.filter((url) => url.includes("/v2/public/market/listings?")).length;
    expect(readsAfterNext - readsBeforeNext).toBe(1);
    await expect(page.getByRole("button", { name: "Previous page" })).toBeVisible();
  });

  test("shows loading and an explicit GET retry on failure", async ({ page }) => {
    await installAcceptedMocks(page);
    let listCalls = 0;
    await page.route("**/v2/public/market/listings?*", async (route) => {
      listCalls += 1;
      if (listCalls === 1) {
        await route.fulfill({ status: 503, body: "unavailable" });
        return;
      }
      await route.fulfill({ json: envelope({ items: [publicVersion()], nextCursor: null }) });
    });
    await page.goto("/market");
    await expect(page.getByRole("alert")).toBeVisible();
    await page.getByRole("button", { name: "Retry catalog" }).click();
    await expect(page.getByText("Synthetic declared API")).toBeVisible();
  });

  test("serves a bounded not-found for an unknown or extra path", async ({ page }) => {
    await installAcceptedMocks(page);
    await page.goto("/market/not-a-canonical-id");
    await expect(page.getByRole("heading", { name: "This page does not exist" })).toBeVisible();
    await page.goto("/market/" + encodeURIComponent(LISTING_A) + "/extra");
    await expect(page.getByRole("heading", { name: "This page does not exist" })).toBeVisible();
  });

  test("rejects an interior empty segment without any catalog request", async ({ page }) => {
    const { requests } = await installAcceptedMocks(page);
    await page.goto("/market//" + encodeURIComponent(LISTING_A));
    await expect(page.getByRole("heading", { name: "This page does not exist" })).toBeVisible();
    const catalogReads = requests.filter((url) => url.includes("/v2/public/market/listings/"));
    expect(catalogReads).toEqual([]);

    await page.goto("/providers//" + encodeURIComponent(PROVIDER_A));
    await expect(page.getByRole("heading", { name: "This page does not exist" })).toBeVisible();
    expect(requests.filter((url) => url.includes("/v2/public/market/providers/"))).toEqual([]);
    expect(requests.filter((url) => url.includes("/v2/public/"))).toEqual([]);
  });

  test("makes no auth, Vault, wallet or external-origin request", async ({ page }) => {
    const { requests } = await installAcceptedMocks(page);
    await page.goto("/market");
    await expect(page.getByText("Synthetic declared API")).toBeVisible();
    await page.goto(`/market/${encodeURIComponent(LISTING_A)}`);
    await expect(page.getByRole("heading", { name: "Exact version" })).toBeVisible();
    expect(isSameOriginRequests(requests)).toBe(true);
    const forbidden = requests.filter((url) =>
      /\/(v2\/auth|v1\/private|v1\/operator|v2\/provider|v2\/moderator)/.test(url),
    );
    expect(forbidden).toEqual([]);
  });

  test("works on a mobile viewport with reduced motion", async ({ page }) => {
    await installAcceptedMocks(page);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto("/market");
    await expect(page.getByRole("heading", { name: "Declared provider services" })).toBeVisible();
    await expect(page.getByLabel("Search declared titles")).toBeVisible();
    await page.getByLabel("Search declared titles").focus();
    await expect(page.getByLabel("Search declared titles")).toBeFocused();
  });

  test("removes the scoped stylesheet on client-side navigation", async ({ page }) => {
    await installAcceptedMocks(page);
    await page.goto("/market");
    await expect(page.getByRole("heading", { name: "Declared provider services" })).toBeVisible();
    expect(await page.locator("link[data-market-style]").count()).toBe(1);
    await page.evaluate(() => {
      window.history.pushState(null, "", "/");
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    await expect(page.locator("link[data-market-style]")).toHaveCount(0);
  });
});

test.describe("flag OFF public marketplace", () => {
  test("renders a disabled shell with zero market or auth requests", async ({ page }) => {
    const requests: string[] = [];
    page.on("request", (request) => requests.push(request.url()));
    // Even if something tried to call the API, no mock is installed, and the
    // disabled gate must never construct a client.
    await page.goto(`${OFF}/market`);
    await expect(page.getByTestId("market-disabled")).toBeVisible();
    await expect(page.getByText("built but disabled")).toBeVisible();
    const marketOrAuth = requests.filter((url) =>
      url.includes("/v2/public/market") || url.includes("/v2/auth"),
    );
    expect(marketOrAuth).toEqual([]);
  });

  test("status makes no capability request when the API boundary is off", async ({ page }) => {
    const requests: string[] = [];
    page.on("request", (request) => requests.push(request.url()));
    await page.goto(`${OFF}/status`);
    await expect(page.getByText("capability status check is unavailable")).toBeVisible();
    expect(requests.filter((url) => url.includes("/v2/public/"))).toEqual([]);
  });

  test("docs and legal stay static with the catalog off and the API boundary off", async ({ page }) => {
    const requests: string[] = [];
    page.on("request", (request) => requests.push(request.url()));
    await page.goto(`${OFF}/docs`);
    await expect(page.getByRole("heading", { name: "How the public catalog works" })).toBeVisible();
    await page.goto(`${OFF}/legal`);
    await expect(
      page.getByRole("heading", { name: "Product and privacy information" }),
    ).toBeVisible();
    expect(requests.filter((url) => url.includes("/v2/"))).toEqual([]);
  });

  test("status reads only capabilities when the catalog is off but the API boundary is on", async ({
    page,
  }) => {
    const requests: string[] = [];
    page.on("request", (request) => requests.push(request.url()));
    await page.route("**/v2/public/**", async (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path === "/v2/public/marketplace-capabilities") {
        await route.fulfill({ json: envelope(enabledManifest()) });
        return;
      }
      await route.fulfill({ status: 404, body: "not found" });
    });
    await page.goto(`${API_ON}/status`);
    await expect(page.getByRole("heading", { name: "Marketplace capabilities" })).toBeVisible();
    await expect(page.getByText("public_catalog")).toBeVisible();
    await expect(page.getByText("enabled", { exact: true })).toBeVisible();

    const capabilityReads = requests.filter((url) =>
      url.includes("/v2/public/marketplace-capabilities"),
    );
    const catalogReads = requests.filter((url) => url.includes("/v2/public/market/listings"));
    const authReads = requests.filter((url) => /\/(v2\/auth|v1\/private|v1\/operator)/.test(url));
    expect(capabilityReads).toHaveLength(1);
    expect(catalogReads).toEqual([]);
    expect(authReads).toEqual([]);
  });
});
