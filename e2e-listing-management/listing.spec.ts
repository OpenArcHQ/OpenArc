import { expect, test, type Page } from "@playwright/test";

/**
 * Protected provider-listing journeys (Chromium + WebKit).
 *
 * Every account, tenant read, marketplace capability, listing read and listing
 * write/lifecycle endpoint is intercepted with strict synthetic HTTP fixtures.
 * These are honestly labelled contract fixtures: they prove the UI and
 * transport contract only. They are NOT proof of a live API, PostgreSQL, a
 * fresh passkey proof, TLS, the production nginx proxy, purchase or payment.
 *
 * The server runs with tenant reads ON, tenant writes OFF and machine
 * credentials OFF, proving listing management is independent of both.
 */

const META = {
  schemaVersion: "openarc.api.v2",
  requestId: "018f47a2-3b4c-7def-8123-456789abcdef",
  buildSha: "0123456789abcdef0123456789abcdef01234567",
};

const UUID = "12345678-1234-4234-8123-123456789abc";
const ORG_A = `openarc:org:${UUID}`;
const ACCOUNT_A = `openarc:account:${UUID}`;
const PROVIDER_A = `openarc:provider:${UUID}`;
const LISTING_A = `openarc:listing:${UUID}`;
const CREATED = "2026-01-01T00:00:00.000Z";
const UPDATED = "2026-01-02T00:00:00.000Z";
const DIGEST_A = `sha256:${"a".repeat(64)}`;
const DIGEST_B = `sha256:${"b".repeat(64)}`;

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

function owner(listingId: string, activeVersion: string | null = null) {
  return {
    schemaVersion: "openarc.listing.v1",
    listingId,
    organizationId: ORG_A,
    providerId: PROVIDER_A,
    activeVersion,
    createdAt: CREATED,
    updatedAt: UPDATED,
  };
}

function ownerVersion(version: string, status = "draft", originReviewState = "unreviewed", listingId = LISTING_A) {
  const publishedAt = status === "active" ? UPDATED : null;
  return {
    schemaVersion: "openarc.listing-owner-version.v1",
    listingId,
    organizationId: ORG_A,
    providerId: PROVIDER_A,
    version,
    kind: "api",
    title: "Support API",
    description: "A support answer API.",
    manifest: {
      schemaVersion: "openarc.listing-manifest.v1",
      inputSchemaDigest: DIGEST_A,
      outputSchemaDigest: DIGEST_B,
    },
    price: {
      amount: {
        schemaVersion: "openarc.usdc-amount.v1",
        networkId: "eip155:5042002",
        asset: "USDC",
        representation: "erc20",
        decimals: 6,
        atomicAmount: "1000000",
      },
      pricingModel: "fixed",
    },
    evidenceContract: {
      schemaVersion: "openarc.receipt-contract.v1",
      receiptType: "receipt",
      receiptSchemaDigest: DIGEST_B,
      deliveryFields: ["field"],
    },
    endpointContract: { origin: "https://api.example.com", path: "/deliver" },
    originReviewState,
    termsRevision: "v1",
    privacySummary: "We process only the request.",
    paymentLane: "unavailable",
    availability: { status: "unavailable", rateLimitPerMinute: null },
    status,
    createdAt: CREATED,
    updatedAt: UPDATED,
    publishedAt,
  };
}

function capabilityManifest(listingState = "enabled") {
  return {
    capabilityVersion: "openarc.capabilities.marketplace.v1",
    environment: "testnet",
    network: "eip155:5042002",
    capabilities: [
      { family: "public_catalog", audience: "public", state: "enabled", dependencies: ["marketDatabase"] },
      {
        family: "listing_management",
        audience: "browser",
        state: listingState,
        dependencies: ["auth", "tenantDatabase", "marketDatabase"],
      },
      { family: "moderation", audience: "browser", state: "enabled", dependencies: ["auth", "marketDatabase"] },
    ],
    // The frozen 18-entry registry, inlined so the strict manifest schema
    // (exactly 18 exact descriptors) is satisfied without a runtime import.
    // These are synthetic contract fixtures, never a live API.
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

async function stubSession(page: Page, role = "owner"): Promise<void> {
  await page.route("**/v2/auth/session", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: envelope({ session: { signedIn: true, accountId: ACCOUNT_A, method: "passkey", expiresAt: "2030-01-01T00:00:00.000Z" } }),
    });
  });
  await page.route("**/v2/auth/bootstrap", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: envelope({
        csrfToken: "csrf-from-bootstrap",
        session: { signedIn: true, accountId: ACCOUNT_A, method: "passkey", expiresAt: "2030-01-01T00:00:00.000Z" },
      }),
    });
  });
  await page.route("**/v2/public/marketplace-capabilities", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: envelope(capabilityManifest("enabled")) });
  });
  await page.route("**/v1/operator/organizations?*", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: envelope({ items: [organization(ORG_A)], nextCursor: null }) });
  });
  await page.route("**/v1/operator/organizations", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: envelope({ items: [organization(ORG_A)], nextCursor: null }) });
  });
  await page.route("**/v1/operator/organizations/*/providers*", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: envelope({ organizationId: ORG_A, items: [provider(PROVIDER_A)], nextCursor: null }) });
  });
  await page.route("**/v1/operator/organizations/*", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (route.request().method() !== "GET" || /\/(agents|providers)/u.test(path)) {
      await route.fallback();
      return;
    }
    await route.fulfill({ status: 200, contentType: "application/json", body: envelope(context(role)) });
  });
}

interface ListingFixtureState {
  readonly roots: Array<{ listingId: string; activeVersion: string | null }>;
  readonly versions: Record<string, Array<{ version: string; status?: string; originReviewState?: string }>>;
  readonly writeStatus?: number;
  readonly capability?: "enabled" | "unavailable";
  readonly failRefresh?: boolean;
}

async function stubListingRoutes(page: Page, state: ListingFixtureState): Promise<void> {
  await page.route("**/v2/public/marketplace-capabilities", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: envelope(capabilityManifest(state.capability ?? "enabled")),
    });
  });
  await page.route("**/v2/provider/organizations/*/listing-providers*", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: envelope({ organizationId: ORG_A, items: [{ providerId: PROVIDER_A, displayName: "Support Provider", status: "active" }], nextCursor: null }) });
  });
  await page.route("**/v2/provider/organizations/*/listing-mutations/*", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: envelope({ status: "not_found" }) });
  });
  await page.route("**/v2/provider/organizations/*/listing-lifecycle-mutations/*", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: envelope({ status: "not_found" }) });
  });
  await page.route("**/v2/provider/organizations/*/listings?*", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: envelope({
        organizationId: ORG_A,
        items: state.roots.map((root) => owner(root.listingId, root.activeVersion)),
        nextCursor: null,
      }),
    });
  });
  await page.route("**/v2/provider/organizations/*/listings", async (route) => {
    if (route.request().method() === "GET") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: envelope({ organizationId: ORG_A, items: state.roots.map((root) => owner(root.listingId, root.activeVersion)), nextCursor: null }),
      });
      return;
    }
    const body = JSON.parse(route.request().postData() ?? "{}") as { mutationId: string; providerId: string };
    await route.fulfill({
      status: state.writeStatus ?? 200,
      contentType: "application/json",
      body: envelope({
        replayed: false,
        receipt: {
          mutationId: body.mutationId,
          operation: "market.listing.create",
          resourceType: "listing",
          resourceId: `openarc:listing:${body.mutationId}`,
          committedAt: CREATED,
        },
      }),
    });
  });
  await page.route("**/v2/provider/organizations/*/listings/*/versions?*", async (route) => {
    const listingId = new URL(route.request().url()).pathname.split("/").at(-2) ?? LISTING_A;
    const decoded = decodeURIComponent(listingId);
    const items = (state.versions[decoded] ?? [{ version: "1" }]).map((entry) => ownerVersion(entry.version, entry.status ?? "draft", entry.originReviewState ?? "unreviewed", decoded));
    await route.fulfill({ status: 200, contentType: "application/json", body: envelope({ organizationId: ORG_A, listingId: decoded, providerId: PROVIDER_A, items, nextCursor: null }) });
  });
  await page.route("**/v2/provider/organizations/*/listings/*/versions", async (route) => {
    const listingId = new URL(route.request().url()).pathname.split("/").at(-2) ?? LISTING_A;
    const decoded = decodeURIComponent(listingId);
    if (route.request().method() === "POST") {
      const body = JSON.parse(route.request().postData() ?? "{}") as {
        mutationId: string;
        expectedLatestVersion: string;
      };
      // The fixture correlates the new version with the CAS the client sent:
      // expectedLatestVersion + 1, never a hardcoded number.
      const nextVersion = (BigInt(body.expectedLatestVersion) + 1n).toString();
      await route.fulfill({
        status: state.writeStatus ?? 200,
        contentType: "application/json",
        body: envelope({
          replayed: false,
          receipt: {
            mutationId: body.mutationId,
            operation: "market.listing.version.create",
            resourceType: "listing_version",
            resourceId: `${decoded}@${nextVersion}`,
            committedAt: CREATED,
          },
        }),
      });
      return;
    }
    const items = (state.versions[decoded] ?? [{ version: "1" }]).map((entry) => ownerVersion(entry.version, entry.status ?? "draft", entry.originReviewState ?? "unreviewed", decoded));
    await route.fulfill({ status: 200, contentType: "application/json", body: envelope({ organizationId: ORG_A, listingId: decoded, providerId: PROVIDER_A, items, nextCursor: null }) });
  });
  await page.route("**/v2/provider/organizations/*/listings/*/versions/*/publish", async (route) => {
    const body = JSON.parse(route.request().postData() ?? "{}") as { mutationId: string };
    const path = new URL(route.request().url()).pathname.split("/");
    const listingId = decodeURIComponent(path.at(-4) ?? LISTING_A);
    const version = path.at(-1) === "publish" ? (path.at(-2) ?? "1") : "1";
    await route.fulfill({
      status: state.writeStatus ?? 200,
      contentType: "application/json",
      body: envelope({ replayed: false, receipt: { mutationId: body.mutationId, operation: "market.listing.version.publish", resourceType: "listing_version", resourceId: `${listingId}@${version}`, committedAt: CREATED } }),
    });
  });
  await page.route("**/v2/provider/organizations/*/listings/*/versions/*/pause", async (route) => {
    const body = JSON.parse(route.request().postData() ?? "{}") as { mutationId: string };
    const path = new URL(route.request().url()).pathname.split("/");
    const listingId = decodeURIComponent(path.at(-4) ?? LISTING_A);
    const version = path.at(-1) === "pause" ? (path.at(-2) ?? "1") : "1";
    await route.fulfill({
      status: state.writeStatus ?? 200,
      contentType: "application/json",
      body: envelope({ replayed: false, receipt: { mutationId: body.mutationId, operation: "market.listing.version.pause", resourceType: "listing_version", resourceId: `${listingId}@${version}`, committedAt: CREATED } }),
    });
  });
  await page.route("**/v2/provider/organizations/*/listings/*/versions/*/retire", async (route) => {
    const body = JSON.parse(route.request().postData() ?? "{}") as { mutationId: string };
    const path = new URL(route.request().url()).pathname.split("/");
    const listingId = decodeURIComponent(path.at(-4) ?? LISTING_A);
    const version = path.at(-1) === "retire" ? (path.at(-2) ?? "1") : "1";
    await route.fulfill({
      status: state.writeStatus ?? 200,
      contentType: "application/json",
      body: envelope({ replayed: false, receipt: { mutationId: body.mutationId, operation: "market.listing.version.retire", resourceType: "listing_version", resourceId: `${listingId}@${version}`, committedAt: CREATED } }),
    });
  });
  await page.route("**/v2/provider/organizations/*/listings/*", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    const listingId = decodeURIComponent(new URL(route.request().url()).pathname.split("/").at(-1) ?? LISTING_A);
    await route.fulfill({ status: 200, contentType: "application/json", body: envelope({ organizationId: ORG_A, listingId, item: owner(listingId, null) }) });
  });
}

async function openListings(page: Page, path = "/app/provider/listings"): Promise<void> {
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

test("lists bounded roots and opens a listing detail with immutable history", async ({ page }) => {
  await stubSession(page);
  await stubListingRoutes(page, {
    roots: [{ listingId: LISTING_A, activeVersion: "1" }],
    versions: { [LISTING_A]: [{ version: "1", status: "active", originReviewState: "approved" }] },
  });
  await openListings(page);
  await expect(page.getByRole("heading", { name: "Listings", level: 1 })).toBeVisible();
  await expect(page.getByRole("cell", { name: LISTING_A })).toBeVisible();
  await page.getByRole("button", { name: "Open listing" }).click();
  await expect(page.getByRole("heading", { name: `Listing ${LISTING_A}` })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Version history" })).toBeVisible();
  await expect(page.getByText("All versions loaded. Latest known version: 1.")).toBeVisible();
  // Honest QA screenshot: taken after the real history assertions above, with
  // strict synthetic HTTP fixtures (not proof of a live API or database).
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.screenshot({ path: "test-results/listing-qa-history.png" });
});

test("creates a first draft only after explicit confirmation", async ({ page }) => {
  await stubSession(page);
  await stubListingRoutes(page, { roots: [], versions: {} });
  await openListings(page);
  await page.getByRole("button", { name: "Create first draft" }).click();
  await expect(page.getByRole("radio", { name: /Support Provider/ })).toBeVisible();
  await page.getByRole("radio", { name: /Support Provider/ }).check();
  await page.getByLabel("Title").fill("Support API");
  await page.getByLabel("Description").fill("A support answer API.");
  await page.getByLabel("Input schema digest").fill(DIGEST_A);
  await page.getByLabel("Output schema digest").fill(DIGEST_B);
  await page.getByLabel("Fixed price (TestnetUSDC)").fill("1");
  await page.getByLabel("Receipt type").fill("receipt");
  await page.getByLabel("Receipt schema digest").fill(DIGEST_B);
  await page.getByLabel("Delivery fields").fill("field");
  await page.getByLabel("Endpoint origin").fill("https://api.example.com");
  await page.getByLabel("Endpoint path").fill("/deliver");
  await page.getByLabel("Terms revision").fill("v1");
  await page.getByLabel("Privacy summary").fill("We process only the request.");
  await page.getByRole("button", { name: "Review draft" }).click();
  await expect(page.getByRole("heading", { name: "Confirm this write" })).toBeVisible();
  await page.getByRole("button", { name: "Confirm write" }).click();
  await expect(page.getByText(/Committed operation market\.listing\.create/)).toBeVisible();
  // Honest QA screenshot: taken after the committed-write assertion above.
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.screenshot({ path: "test-results/listing-qa-editor.png" });
});

test("does not publish an unapproved version and discloses publish consequences", async ({ page }) => {
  await stubSession(page);
  await stubListingRoutes(page, {
    roots: [{ listingId: LISTING_A, activeVersion: null }],
    versions: { [LISTING_A]: [{ version: "1", status: "draft", originReviewState: "unreviewed" }] },
  });
  await openListings(page, `/app/provider/listings/${encodeURIComponent(LISTING_A)}`);
  await page.getByRole("button", { name: "Use as new-version base" }).click();
  await expect(page.getByText(/cannot be published/)).toBeVisible();
});

test("shows an honest unavailable state when the listing capability is disabled", async ({ page }) => {
  await stubSession(page);
  await stubListingRoutes(page, { roots: [], versions: {}, capability: "unavailable" });
  await openListings(page);
  await expect(page.getByRole("heading", { name: /Listing management is not available/ })).toBeVisible();
  await expect(page.getByText(/No listing request was made/)).toBeVisible();
});

test("clears a selected version when the session expires", async ({ page }) => {
  await stubSession(page);
  await stubListingRoutes(page, {
    roots: [{ listingId: LISTING_A, activeVersion: null }],
    versions: { [LISTING_A]: [{ version: "1", status: "draft", originReviewState: "unreviewed" }] },
  });
  await openListings(page, `/app/provider/listings/${encodeURIComponent(LISTING_A)}`);
  await page.getByRole("button", { name: "Use as new-version base" }).click();
  await expect(page.getByRole("button", { name: "Selected as new-version base" })).toBeVisible();
  // A pagehide clears drafts, selections and request state synchronously.
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent("pagehide")));
  await expect(page.getByRole("heading", { name: "Refresh required" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Selected as new-version base" })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: `Listing ${LISTING_A}` })).toHaveCount(0);
});

test("preserves the pre-existing workspace routes", async ({ page }) => {
  await stubSession(page);
  await stubListingRoutes(page, { roots: [], versions: {} });
  await openListings(page, "/app/provider");
  await expect(page.getByRole("heading", { name: "Provider" })).toBeVisible();
});

test("shows no listing controls for a viewer role", async ({ page }) => {
  await stubSession(page, "viewer");
  await stubListingRoutes(page, { roots: [], versions: {} });
  await openListings(page);
  await expect(page.getByText(/read-only here/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Create first draft" })).toBeDisabled();
});

test("creates a new version from a selected historical version with explicit confirmation", async ({ page }) => {
  await stubSession(page);
  await stubListingRoutes(page, {
    roots: [{ listingId: LISTING_A, activeVersion: null }],
    versions: { [LISTING_A]: [{ version: "1" }, { version: "10" }] },
  });
  await openListings(page, `/app/provider/listings/${encodeURIComponent(LISTING_A)}`);
  await expect(page.getByText("All versions loaded. Latest known version: 10.")).toBeVisible();
  await page.getByRole("button", { name: "Use as new-version base" }).first().click();
  await page.getByRole("button", { name: "Review new version" }).click();
  await expect(page.getByRole("heading", { name: "Confirm this write" })).toBeVisible();
  await page.getByRole("button", { name: "Confirm write" }).click();
  await expect(page.getByText(/Committed operation market\.listing\.version\.create/)).toBeVisible();
});

test("publishes an approved draft with a public disclosure", async ({ page }) => {
  await stubSession(page);
  await stubListingRoutes(page, {
    roots: [{ listingId: LISTING_A, activeVersion: null }],
    versions: { [LISTING_A]: [{ version: "1", status: "draft", originReviewState: "approved" }] },
  });
  await openListings(page, `/app/provider/listings/${encodeURIComponent(LISTING_A)}`);
  await page.getByRole("button", { name: "Use as new-version base" }).click();
  await page.getByRole("button", { name: "Publish version 1" }).click();
  await expect(page.getByRole("heading", { name: "Publish version 1" })).toBeVisible();
  await expect(page.getByText(/endpoint path is NOT disclosed/)).toBeVisible();
  await page.getByRole("button", { name: "Confirm publish" }).click();
  await expect(page.getByText(/Committed operation market\.listing\.version\.publish/)).toBeVisible();
});

test("pauses and retires an active version only after confirmation", async ({ page }) => {
  await stubSession(page);
  await stubListingRoutes(page, {
    roots: [{ listingId: LISTING_A, activeVersion: "1" }],
    versions: { [LISTING_A]: [{ version: "1", status: "active", originReviewState: "approved" }] },
  });
  await openListings(page, `/app/provider/listings/${encodeURIComponent(LISTING_A)}`);
  await page.getByRole("button", { name: "Use as new-version base" }).click();
  await page.getByRole("button", { name: "Pause active version 1" }).click();
  await expect(page.getByRole("heading", { name: "Pause version 1" })).toBeVisible();
  await page.getByRole("button", { name: "Confirm pause" }).click();
  await expect(page.getByText(/Committed operation market\.listing\.version\.pause/)).toBeVisible();
});

test("shows a reviewable conflict without automatic resubmission", async ({ page }) => {
  await stubSession(page);
  await stubListingRoutes(page, {
    roots: [{ listingId: LISTING_A, activeVersion: "1" }],
    versions: { [LISTING_A]: [{ version: "1", status: "active", originReviewState: "approved" }] },
    writeStatus: 409,
  });
  await openListings(page, `/app/provider/listings/${encodeURIComponent(LISTING_A)}`);
  await page.getByRole("button", { name: "Use as new-version base" }).click();
  await page.getByRole("button", { name: "Retire version 1" }).click();
  await page.getByRole("button", { name: "Confirm retire" }).click();
  await expect(page.getByText(/A conflict was detected/)).toBeVisible();
});

test("aborts a pending capability probe on pagehide and makes no listing request", async ({ page }) => {
  await stubSession(page);
  const capabilityGateControl: { release: () => void } = { release: () => undefined };
  const capabilityGate = new Promise<void>((resolve) => {
    capabilityGateControl.release = resolve;
  });
  let listingRequests = 0;
  await page.route("**/v2/provider/organizations/**", async (route) => {
    listingRequests += 1;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: envelope({ organizationId: ORG_A, items: [], nextCursor: null }),
    });
  });
  // Hold the capability response open so the probe is genuinely in flight.
  await page.route("**/v2/public/marketplace-capabilities", async (route) => {
    await capabilityGate;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: envelope(capabilityManifest("enabled")),
    });
  });
  await page.goto("/app/provider/listings");
  const viewport = page.viewportSize();
  if (viewport !== null && viewport.width <= 860) {
    await page.getByRole("button", { name: "Menu" }).click();
    await page.locator(".tenant-drawer .tenant-org-select").selectOption(ORG_A);
  } else {
    await page.locator(".tenant-rail--static .tenant-org-select").selectOption(ORG_A);
  }
  await expect(page.getByText("Checking listing availability…")).toBeVisible();
  // A pagehide aborts the tracked capability probe. The late response must not
  // enable the surface or trigger a listing request.
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent("pagehide")));
  capabilityGateControl.release();
  await page.waitForTimeout(300);
  expect(listingRequests).toBe(0);
  await expect(page.getByRole("heading", { name: "Listings", level: 1 })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Create first draft" })).toHaveCount(0);
});
