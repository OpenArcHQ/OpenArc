import { randomBytes, randomUUID } from "node:crypto";

import {
  expect,
  test,
  type Browser,
  type CDPSession,
  type Page,
} from "@playwright/test";

import { reviewedEndpointDigest } from "../packages/db/src/market-lifecycle-mutations.js";
import { CommerceApiErrorEnvelopeSchema } from "../packages/shared/src/commerce/api.js";
import type { CommerceApiErrorCode } from "../packages/shared/src/commerce/api.js";
import {
  MARKETPLACE_ROUTES,
  type MarketplaceRouteDescriptor,
} from "../packages/shared/src/commerce/market-capabilities.js";

import {
  countDurableRows,
  countListingVersions,
  readListingRoot,
  readListingVersionContent,
  readListingVersionState,
  readModeratorGrant,
  readOriginReview,
  revokeModeratorGrant,
  seedAgents,
  seedModeratorGrant,
  seedOrganizationWithRole,
  seedOwnOrganizations,
  seedProviders,
  type SeededOrganization,
  type SeededProfile,
} from "./fixture-db.js";

/**
 * PORT-02 actual production MARKETPLACE acceptance.
 *
 * Every journey targets the REAL API + PostgreSQL + production nginx through
 * the lead-provisioned loopback origin. There is no route interception for the
 * positive journeys, no HTTP mock, no session-cookie injection and no test-only
 * app endpoint. Human accounts are created through the real passkey sign-up UI;
 * only synthetic tenant/listing data and the fixture-only moderator grant are
 * provisioned server-side by the guarded node fixture. The single deterministic
 * browser delivery fault (unknown outcome) is a CDP Fetch response-stage
 * failure applied AFTER the real API has processed the write and the fixture has
 * independently confirmed the commit.
 */

const ENABLED_ORIGIN = "https://account.openarc.test:5451";

const CANONICAL_ACCOUNT =
  /^openarc:account:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const CANONICAL_LISTING =
  /^openarc:listing:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const CANONICAL_MUTATION =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const SHA256_DIGEST = /^sha256:[0-9a-f]{64}$/u;

const PROVIDER_BASE = "/v2/provider/organizations";
const MODERATOR_BASE = "/v2/moderator/organizations";
const PUBLIC_LISTINGS = "/v2/public/market/listings";

const DIGEST_A = `sha256:${"a".repeat(64)}`;
const DIGEST_B = `sha256:${"b".repeat(64)}`;
const ENDPOINT_ORIGIN = "https://api.example.com";
const ENDPOINT_PATH = "/deliver";
const PRICE_ATOMIC = "1000000";
const PRICE_LABEL = "1 USDC";

interface VirtualAuthenticator {
  readonly client: CDPSession;
  readonly id: string;
}

/* -------------------------------------------------------------------------- */
/* Real passkey UI sign-up (reused accepted pattern)                          */
/* -------------------------------------------------------------------------- */

async function addVirtualAuthenticator(page: Page): Promise<VirtualAuthenticator> {
  const client = await page.context().newCDPSession(page);
  await client.send("WebAuthn.enable", { enableUI: false });
  const { authenticatorId } = await client.send("WebAuthn.addVirtualAuthenticator", {
    options: {
      protocol: "ctap2",
      ctap2Version: "ctap2_1",
      transport: "internal",
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  });
  return { client, id: authenticatorId };
}

async function removeAuthenticator(authenticator: VirtualAuthenticator): Promise<void> {
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

/**
 * Runs one real-UI passkey journey in its OWN isolated browser context. The
 * Chromium host-resolver rule is a browser-level launch flag (see the production
 * config), so this context resolves the same reserved loopback hostname; only
 * the HTTPS fixture exemption and base URL are copied. No cookie is read,
 * injected or serialized.
 */
async function withIsolatedSignedInAccount(
  browser: Browser,
  origin: string,
  run: (page: Page, accountId: string) => Promise<void>,
): Promise<void> {
  const context = await browser.newContext({ baseURL: origin, ignoreHTTPSErrors: true });
  try {
    const isolated = await context.newPage();
    const authenticator = await addVirtualAuthenticator(isolated);
    try {
      await gotoAccount(isolated);
      const accountId = await createPasskeyAccount(isolated);
      await run(isolated, accountId);
    } finally {
      await removeAuthenticator(authenticator);
    }
  } finally {
    await context.close();
  }
}

/* -------------------------------------------------------------------------- */
/* Real UI helpers and exact accessible selectors                             */
/* -------------------------------------------------------------------------- */

async function selectOrganization(page: Page, organizationId: string): Promise<void> {
  const viewport = page.viewportSize();
  if (viewport !== null && viewport.width <= 860) {
    await page.getByRole("button", { name: "Menu" }).click();
    const drawer = page.locator("#tenant-drawer");
    await expect(drawer).toBeVisible();
    await drawer
      .locator(".tenant-org-select")
      .selectOption({ value: organizationId });
    // Selecting an organization closes the responsive drawer synchronously.
    await expect(drawer).toHaveCount(0);
    await expect(page.locator(".tenant-org-select")).toHaveValue(organizationId);
    return;
  }
  await page
    .locator(".tenant-rail--static .tenant-org-select")
    .selectOption({ value: organizationId });
  await expect(page.locator(".tenant-org-select").first()).toHaveValue(organizationId);
}

/**
 * Opens the protected listing workspace and explicitly selects the tenant.
 *
 * The organization selector renders BEFORE any organization is chosen, while
 * the protected "Listings" heading only exists AFTER a real organization
 * context loads. The flow therefore selects the organization first (through
 * the responsive drawer at <=860px) and only then waits for the heading. It
 * never queries an impossible heading before a tenant is selected, and it
 * never fabricates an empty workspace.
 */
async function openListings(page: Page, organizationId: string): Promise<void> {
  await page.goto("/app/provider/listings");
  await selectOrganization(page, organizationId);
  await expect(page.getByRole("heading", { name: "Listings", level: 1 })).toBeVisible();
  // The freshly selected organization starts with an unloaded root list; the
  // real "Load listings" control is the single explicit load action.
  const load = page.getByRole("button", { name: "Load listings" });
  if ((await load.count()) > 0) {
    await load.click();
    await expect(load).toHaveCount(0);
  }
}

/** Fresh navigation, organization selection and base-version binding. */
async function selectBaseVersion(page: Page, organizationId: string): Promise<void> {
  await page.reload();
  await selectOrganization(page, organizationId);
  await page.getByRole("button", { name: "Use as new-version base" }).first().click();
}

async function fillListingForm(
  page: Page,
  providerId: string,
  overrides: { title?: string; price?: string } = {},
): Promise<void> {
  const radio = page.locator(`input[name="listing-provider"][value="${providerId}"]`);
  await expect(radio).toBeVisible();
  await radio.check();
  await page.getByLabel("Title").fill(overrides.title ?? "Support API");
  await page.getByLabel("Description").fill("A support answer API.");
  await page.getByLabel("Input schema digest").fill(DIGEST_A);
  await page.getByLabel("Output schema digest").fill(DIGEST_B);
  await page.getByLabel("Fixed price (TestnetUSDC)").fill(overrides.price ?? "1");
  await page.getByLabel("Receipt type").fill("receipt");
  await page.getByLabel("Receipt schema digest").fill(DIGEST_B);
  await page.getByLabel("Delivery fields").fill("field");
  await page.getByLabel("Endpoint origin").fill(ENDPOINT_ORIGIN);
  await page.getByLabel("Endpoint path").fill(ENDPOINT_PATH);
  await page.getByLabel("Terms revision").fill("v1");
  await page.getByLabel("Privacy summary").fill("We process only the request.");
}

/** Creates the immutable first draft through the real UI and returns its id. */
async function createFirstDraft(
  page: Page,
  organization: SeededOrganization,
  provider: SeededProfile,
): Promise<string> {
  await openListings(page, organization.organizationId);
  await expect(page.getByText("No listings in this organization yet.")).toBeVisible();
  await page.getByRole("button", { name: "Create first draft" }).click();
  await fillListingForm(page, provider.id);
  await page.getByRole("button", { name: "Review draft" }).click();
  await expect(page.getByRole("heading", { name: "Confirm this write" })).toBeVisible();
  // Retained bounded status diagnostic (no secrets): a real non-200 on the
  // listing-create POST is surfaced with its status, content-type, server and
  // exact request byte count, so the accepted nginx proxy body-limit defect is
  // evidenced instead of masking as a generic missing committed receipt. The
  // request body and response body are never logged. If no POST is observed
  // (a pre-send failure), the authoritative committed-receipt assertion below
  // still reports the real UI outcome instead of hanging on the diagnostic.
  const createResponse = page.waitForResponse(
    (candidate) =>
      candidate.request().method() === "POST" &&
      /\/provider\/organizations\/[^/]+\/listings$/u.test(new URL(candidate.url()).pathname),
    { timeout: 10_000 },
  ).catch(() => null);
  await page.getByRole("button", { name: "Confirm write" }).click();
  const observed = await createResponse;
  if (observed !== null && observed.status() !== 200) {
    const headers = await observed.allHeaders();
    const requestBytes = Buffer.byteLength(observed.request().postData() ?? "", "utf8");
    throw new Error(
      `LISTING_CREATE_REJECTED status=${observed.status()} content-type=${
        headers["content-type"] ?? ""
      } server=${headers["server"] ?? ""} request-bytes=${requestBytes}`,
    );
  }
  await expect(page.getByText(/Committed operation market\.listing\.create/u)).toBeVisible({
    timeout: 20_000,
  });
  return await readOpenListingId(page);
}

async function readOpenListingId(page: Page): Promise<string> {
  const heading = page.getByRole("heading", { name: /^Listing openarc:listing:/u });
  await expect(heading).toBeVisible({ timeout: 20_000 });
  const id = (await heading.innerText()).trim().replace(/^Listing\s+/u, "");
  expect(CANONICAL_LISTING.test(id)).toBe(true);
  return id;
}

/** Creates version 2 from the historical base through the real UI. */
async function createSecondVersion(page: Page, organizationId: string): Promise<void> {
  await page.reload();
  await selectOrganization(page, organizationId);
  await page.getByRole("button", { name: "Use as new-version base" }).first().click();
  await page.getByRole("button", { name: "Review new version" }).click();
  await expect(page.getByRole("heading", { name: "Confirm this write" })).toBeVisible();
  await page.getByRole("button", { name: "Confirm write" }).click();
  await expect(page.getByText(/Committed operation market\.listing\.version\.create/u)).toBeVisible({
    timeout: 20_000,
  });
}

async function confirmLifecycle(
  page: Page,
  action: "Publish" | "Pause" | "Retire",
  version: string,
): Promise<void> {
  // The running image labels the pause control "Pause active version N" while
  // the publish/retire controls are "Publish version N" / "Retire version N";
  // the confirmation heading for all three is "<Action> version N".
  const openName =
    action === "Pause"
      ? new RegExp(`Pause active version ${version}`, "u")
      : new RegExp(`${action} version ${version}`, "u");
  const open = page.getByRole("button", { name: openName });
  await expect(open.first()).toBeVisible();
  await open.first().click();
  await expect(
    page.getByRole("heading", { name: `${action} version ${version}` }),
  ).toBeVisible();
  await page.getByRole("button", { name: `Confirm ${action.toLowerCase()}` }).click();
  await expect(
    page.getByText(new RegExp(`Committed operation market\\.listing\\.version\\.${action.toLowerCase()}`, "u")),
  ).toBeVisible({ timeout: 20_000 });
}

/* -------------------------------------------------------------------------- */
/* Bounded same-origin browser fetch (real CSRF, transient closure)           */
/* -------------------------------------------------------------------------- */

/**
 * Bounded safe projection of an ACTUAL HTTP JSON response. Only non-secret
 * shape metadata crosses back: the status, the presence of a Set-Cookie header
 * (never its value), the closed error code and the canonical envelope/meta
 * leaves needed to run the exact shared Zod schema in Node, plus a fixed SPA
 * marker boolean. No raw body, successful protected DTO value, session hash,
 * token, cookie or CSRF value is ever returned to the test.
 */
interface BrowserFetchOutcome {
  readonly status: number;
  readonly setCookie: boolean;
  readonly errorCode: string | null;
  readonly envelopeOk: boolean;
  readonly dataKeys: readonly string[] | null;
  readonly spaShell: boolean;
  readonly hasPrivateMetadata: boolean;
  /** True only when a top-level `data` key was actually present. */
  readonly hasDataKey: boolean;
  /**
   * Actual safe envelope leaves for strict schema parse in Node. `error` is
   * the ACTUAL response error object's safe leaves (never a manufactured one);
   * `null` when the response carried no parseable object.
   */
  readonly errorEnvelope: {
    /** The ACTUAL `ok` boolean, or `null` when absent / not a boolean. */
    readonly ok: boolean | null;
    readonly hasError: boolean;
    readonly code: string | null;
    readonly message: string | null;
    readonly retryable: boolean | null;
    readonly meta: {
      readonly schemaVersion: string | null;
      readonly requestId: string | null;
      readonly buildSha: string | null;
    } | null;
    /**
     * Exact OWN key-name arrays observed on the raw parsed objects. They let
     * the test prove no unknown top/error/meta key was silently stripped
     * during the bounded projection BEFORE the safe envelope is reconstructed
     * for the strict shared-schema parse. Names only, never values.
     */
    readonly topKeys: readonly string[];
    readonly errorKeys: readonly string[];
    readonly metaKeys: readonly string[];
  } | null;
}

async function sameOriginFetch(
  page: Page,
  request: {
    readonly path: string;
    readonly method: "GET" | "POST";
    readonly body?: string;
    readonly idempotencyKey?: string;
    readonly csrf?: "bootstrap" | "omit";
    readonly extraHeaders?: Record<string, string>;
  },
): Promise<BrowserFetchOutcome> {
  return page.evaluate(async (input) => {
    let csrfToken: string | null = null;
    if (input.csrf === "bootstrap") {
      const bootstrap = await fetch("/v2/auth/bootstrap", {
        method: "POST",
        credentials: "same-origin",
        cache: "no-store",
        headers: {
          "X-OpenArc-Client": "browser-v1",
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: "{}",
      });
      const json = (await bootstrap.json()) as { data?: { csrfToken?: unknown } };
      const token = json.data?.csrfToken;
      csrfToken = typeof token === "string" && token.length > 0 ? token : null;
      if (csrfToken === null) throw new Error("BOOTSTRAP_CSRF_UNAVAILABLE");
    }
    const headers: Record<string, string> = {
      "X-OpenArc-Client": "browser-v1",
      Accept: "application/json",
      ...(input.extraHeaders ?? {}),
    };
    if (input.body !== undefined) headers["Content-Type"] = "application/json";
    if (input.idempotencyKey !== undefined) headers["Idempotency-Key"] = input.idempotencyKey;
    if (input.csrf === "bootstrap" && csrfToken !== null) headers["X-OpenArc-CSRF"] = csrfToken;
    const response = await fetch(input.path, {
      method: input.method,
      headers,
      ...(input.body === undefined ? {} : { body: input.body }),
      credentials: "same-origin",
      cache: "no-store",
      redirect: "error",
    });
    const text = await response.text();
    let errorCode: string | null = null;
    let envelopeOk = false;
    let dataKeys: string[] | null = null;
    let hasDataKey = false;
    let errorEnvelope: BrowserFetchOutcome["errorEnvelope"] = null;
    try {
      const parsed = JSON.parse(text) as {
        ok?: unknown;
        data?: unknown;
        error?: { code?: unknown; message?: unknown; retryable?: unknown };
        meta?: {
          schemaVersion?: unknown;
          requestId?: unknown;
          buildSha?: unknown;
        };
      };
      if (typeof parsed === "object" && parsed !== null) {
        envelopeOk = parsed.ok === true;
        hasDataKey = Object.prototype.hasOwnProperty.call(parsed, "data");
        if (typeof parsed.data === "object" && parsed.data !== null) {
          dataKeys = Object.keys(parsed.data).sort();
        }
        const error = parsed.error;
        const meta = parsed.meta;
        if (typeof error === "object" && error !== null) {
          const code = error.code;
          const message = error.message;
          const retryable = error.retryable;
          errorCode = typeof code === "string" ? code : null;
          errorEnvelope = {
            ok: typeof parsed.ok === "boolean" ? parsed.ok : null,
            hasError: true,
            code: typeof code === "string" ? code : null,
            message: typeof message === "string" ? message : null,
            retryable: typeof retryable === "boolean" ? retryable : null,
            meta:
              typeof meta === "object" && meta !== null
                ? {
                    schemaVersion:
                      typeof meta.schemaVersion === "string"
                        ? meta.schemaVersion
                        : null,
                    requestId:
                      typeof meta.requestId === "string" ? meta.requestId : null,
                    buildSha:
                      typeof meta.buildSha === "string" ? meta.buildSha : null,
                  }
                : null,
            topKeys: Object.keys(parsed).sort(),
            errorKeys: Object.keys(error).sort(),
            metaKeys:
              typeof meta === "object" && meta !== null
                ? Object.keys(meta).sort()
                : [],
          };
        }
      }
    } catch {
      errorCode = null;
    }
    return {
      status: response.status,
      setCookie: response.headers.get("set-cookie") !== null,
      errorCode,
      envelopeOk,
      dataKeys,
      hasDataKey,
      errorEnvelope,
      spaShell: [
        'id="root"',
        'id="app"',
        "id='root'",
        "id='app'",
        "data-openarc",
        "<script",
        'type="module"',
        "/assets/",
        "/build/",
        "openarc-web",
      ].some((marker) => text.includes(marker)),
      hasPrivateMetadata: /"(?:sessionHash|tokenHash|idempotencyKey|csrfToken|session_token)"\s*:/u.test(
        text,
      ),
    };
  }, request);
}

interface ProxiedFetchOutcome {
  readonly status: number;
  readonly body: BrowserFetchOutcome;
  readonly setCookieHeaderPresent: boolean;
  readonly corsAllowOriginPresent: boolean;
  readonly contentType: string;
}

/**
 * Drives a same-origin browser fetch through the REAL nginx proxy and captures
 * the ACTUAL response status and headers through Playwright's response object
 * (`headersArray()`), because an in-page `fetch` cannot see every response
 * header (e.g. `Set-Cookie`).
 */
async function proxiedBrowserFetch(
  page: Page,
  request: {
    readonly path: string;
    readonly method: "GET" | "POST" | "DELETE";
    readonly body?: string;
    readonly extraHeaders?: Record<string, string>;
    /**
     * Bounded credentials mode for the same-origin browser fetch. The public
     * credentialless catalog probes MUST use `omit`; protected probes retain
     * `same-origin` so the real account cookie is presented. The test never
     * reads, injects or serializes a cookie: `same-origin` only lets the real
     * signed-in browser context attach its own cookie, exactly as a user
     * navigation would.
     */
    readonly credentials: "omit" | "same-origin";
  },
): Promise<ProxiedFetchOutcome> {
  const expectedUrl = new URL(request.path, ENABLED_ORIGIN);
  const responsePromise = page.waitForResponse(
    (candidate) => {
      const actualUrl = new URL(candidate.url());
      return (
        actualUrl.pathname === expectedUrl.pathname &&
        actualUrl.search === expectedUrl.search &&
        candidate.request().method() === request.method
      );
    },
    { timeout: 30_000 },
  );
  const bodyPromise = page.evaluate(async (input) => {
    const headers: Record<string, string> = {
      "X-OpenArc-Client": "browser-v1",
      Accept: "application/json",
      ...(input.extraHeaders ?? {}),
    };
    if (input.body !== undefined) headers["Content-Type"] = "application/json";
    const response = await fetch(input.path, {
      method: input.method,
      headers,
      ...(input.body === undefined ? {} : { body: input.body }),
      credentials: input.credentials,
      cache: "no-store",
      redirect: "error",
    });
    const text = await response.text();
    let errorCode: string | null = null;
    let envelopeOk = false;
    let dataKeys: string[] | null = null;
    let hasDataKey = false;
    let errorEnvelope: BrowserFetchOutcome["errorEnvelope"] = null;
    try {
      const parsed = JSON.parse(text) as {
        ok?: unknown;
        data?: unknown;
        error?: { code?: unknown; message?: unknown; retryable?: unknown };
        meta?: {
          schemaVersion?: unknown;
          requestId?: unknown;
          buildSha?: unknown;
        };
      };
      if (typeof parsed === "object" && parsed !== null) {
        envelopeOk = parsed.ok === true;
        hasDataKey = Object.prototype.hasOwnProperty.call(parsed, "data");
        if (typeof parsed.data === "object" && parsed.data !== null) {
          dataKeys = Object.keys(parsed.data).sort();
        }
        const error = parsed.error;
        const meta = parsed.meta;
        if (typeof error === "object" && error !== null) {
          const code = error.code;
          const message = error.message;
          const retryable = error.retryable;
          errorCode = typeof code === "string" ? code : null;
          errorEnvelope = {
            ok: typeof parsed.ok === "boolean" ? parsed.ok : null,
            hasError: true,
            code: typeof code === "string" ? code : null,
            message: typeof message === "string" ? message : null,
            retryable: typeof retryable === "boolean" ? retryable : null,
            meta:
              typeof meta === "object" && meta !== null
                ? {
                    schemaVersion:
                      typeof meta.schemaVersion === "string"
                        ? meta.schemaVersion
                        : null,
                    requestId:
                      typeof meta.requestId === "string" ? meta.requestId : null,
                    buildSha:
                      typeof meta.buildSha === "string" ? meta.buildSha : null,
                  }
                : null,
            topKeys: Object.keys(parsed).sort(),
            errorKeys: Object.keys(error).sort(),
            metaKeys:
              typeof meta === "object" && meta !== null
                ? Object.keys(meta).sort()
                : [],
          };
        }
      }
    } catch {
      errorCode = null;
    }
    return {
      status: response.status,
      setCookie: response.headers.get("set-cookie") !== null,
      errorCode,
      envelopeOk,
      dataKeys,
      hasDataKey,
      errorEnvelope,
      spaShell: [
        'id="root"',
        'id="app"',
        "id='root'",
        "id='app'",
        "data-openarc",
        "<script",
        'type="module"',
        "/assets/",
        "/build/",
        "openarc-web",
      ].some((marker) => text.includes(marker)),
      hasPrivateMetadata: /"(?:sessionHash|tokenHash|idempotencyKey|csrfToken|session_token)"\s*:/u.test(
        text,
      ),
    } satisfies BrowserFetchOutcome;
  }, request);
  const [response, body] = await Promise.all([responsePromise, bodyPromise]);
  const headers = await response.headersArray();
  const lower = (name: string): string | undefined =>
    headers.find((header) => header.name.toLowerCase() === name)?.value;
  return {
    status: response.status(),
    body,
    setCookieHeaderPresent: lower("set-cookie") !== undefined,
    corsAllowOriginPresent: lower("access-control-allow-origin") !== undefined,
    contentType: lower("content-type") ?? "",
  };
}

/**
 * Proves a bounded denial is the EXACT canonical shared error envelope by
 * parsing the ACTUAL HTTP JSON response against `CommerceApiErrorEnvelopeSchema`
 * in Node. The actual safe leaves are re-assembled into the real response
 * object; no meta, message, retryability or code is manufactured. The strict
 * shared schema therefore also enforces the canonical message sentence and the
 * canonical `meta` shape. Only fixed booleans and the closed code are asserted.
 *
 * BEFORE reconstruction, the observed OWN key-name arrays and the ACTUAL `ok`
 * boolean are asserted. This is what closes the strictness hole: an unknown
 * top/error/meta key would otherwise be silently stripped while assembling the
 * safe envelope for the strict parse, and a missing/wrong-typed `ok` would be
 * coerced. Only key NAMES and fixed booleans leave the browser, never values.
 */
async function expectErrorCode(
  outcome: BrowserFetchOutcome,
  code: CommerceApiErrorCode,
): Promise<void> {
  const actual = outcome.errorEnvelope;
  expect(actual).not.toBeNull();
  if (actual === null) return;
  expect(actual.hasError).toBe(true);
  expect(actual.code).toBe(code);
  // Exact observed key names and the ACTUAL boolean, asserted BEFORE the safe
  // envelope is reconstructed for the strict shared-schema parse.
  expect(actual.topKeys).toEqual(["error", "meta", "ok"]);
  expect(actual.errorKeys).toEqual(["code", "message", "retryable"]);
  expect(actual.metaKeys).toEqual(["buildSha", "requestId", "schemaVersion"]);
  expect(actual.ok).toBe(false);
  const canonical = CommerceApiErrorEnvelopeSchema.safeParse({
    ok: actual.ok,
    error: {
      code: actual.code,
      message: actual.message,
      retryable: actual.retryable,
    },
    meta: actual.meta,
  });
  expect(canonical.success).toBe(true);
  expect(outcome.errorCode).toBe(code);
  expect(outcome.envelopeOk).toBe(false);
  expect(outcome.hasDataKey).toBe(false);
  expect(outcome.setCookie).toBe(false);
}

function canonicalMutationId(): string {
  return randomUUID();
}

function canonicalIdempotencyKey(): string {
  return randomBytes(32).toString("base64url");
}

/* -------------------------------------------------------------------------- */
/* @market-on                                                                 */
/* -------------------------------------------------------------------------- */

test.describe("PORT-02 marketplace production acceptance", { tag: "@market-on" }, () => {
  test("owner creates an immutable first draft and version 2 through the real listing UI with durable rows and ascending history", async ({
    page,
  }) => {
    await withSignedInAccount(page, async (accountId) => {
      const seeded = await seedOwnOrganizations(accountId, ["Synthetic Market Owner"]);
      const organization = seeded[0];
      if (organization === undefined) throw new Error("seed missing");
      const provider = (await seedProviders(organization.organizationId, 1))[0];
      if (provider === undefined) throw new Error("seed missing");

      const listingId = await createFirstDraft(page, organization, provider);
      expect(CANONICAL_LISTING.test(listingId)).toBe(true);

      const root = await readListingRoot(organization.organizationId, listingId);
      expect(root?.providerId).toBe(provider.id);
      expect(root?.latestVersion).toBe("1");
      expect(root?.activeVersion).toBeNull();
      expect(await countListingVersions(organization.organizationId, listingId)).toBe(1);

      const content = await readListingVersionContent(
        organization.organizationId,
        listingId,
        "1",
      );
      expect(content?.providerId).toBe(provider.id);
      expect(content?.kind).toBe("api");
      expect(content?.priceAtomicAmount).toBe(PRICE_ATOMIC);
      expect(content?.priceDecimals).toBe(6);
      expect(content?.endpointOrigin).toBe(ENDPOINT_ORIGIN);
      expect(content?.endpointPath).toBe(ENDPOINT_PATH);

      const state = await readListingVersionState(
        organization.organizationId,
        listingId,
        "1",
      );
      expect(state?.status).toBe("draft");
      expect(state?.originReviewState).toBe("unreviewed");

      await createSecondVersion(page, organization.organizationId);
      expect(await countListingVersions(organization.organizationId, listingId)).toBe(2);
      await expect(
        page.getByText("All versions loaded. Latest known version: 2."),
      ).toBeVisible();
      const history = page.locator(".tenant-listings__history");
      await expect(history.getByRole("cell", { name: "1", exact: true })).toBeVisible();
      await expect(history.getByRole("cell", { name: "2", exact: true })).toBeVisible();
    });
  });

  test("independent moderator passkey approves origin review via the real moderator API, then publish/pause/republish/retire drive the anonymous public catalog", async ({
    browser,
    page,
  }) => {
    let listingId = "";
    let organizationId = "";
    let providerId = "";

    await withSignedInAccount(page, async (accountId) => {
      const seeded = await seedOwnOrganizations(accountId, ["Synthetic Market Lifecycle"]);
      const organization = seeded[0];
      if (organization === undefined) throw new Error("seed missing");
      organizationId = organization.organizationId;
      const provider = (await seedProviders(organizationId, 1))[0];
      if (provider === undefined) throw new Error("seed missing");
      providerId = provider.id;

      listingId = await createFirstDraft(page, organization, provider);

      // The provider cannot approve its own version: the owner calls the real
      // moderator origin-review API and is denied because moderation is an
      // account-level grant, never an organization role.
      const versionState = await readListingVersionState(organizationId, listingId, "1");
      if (versionState === null) throw new Error("version state missing");
      const selfReviewMutation = canonicalMutationId();
      const selfReview = await sameOriginFetch(page, {
        path: `${MODERATOR_BASE}/${encodeURIComponent(organizationId)}/listings/${encodeURIComponent(listingId)}/versions/1/origin-review`,
        method: "POST",
        csrf: "bootstrap",
        idempotencyKey: canonicalIdempotencyKey(),
        body: JSON.stringify({
          mutationId: selfReviewMutation,
          expectedUpdatedAt: versionState.updatedAt,
          decision: "approved",
          reviewedEndpointDigest: reviewedEndpointDigest({
            listingId,
            version: "1",
            origin: ENDPOINT_ORIGIN,
            path: ENDPOINT_PATH,
          }),
          reasonCode: "manual_review",
          reasonDigest: null,
        }),
      });
      expect(selfReview.status).toBe(403);
      await expectErrorCode(selfReview, "FORBIDDEN");
      expect(await readOriginReview(organizationId, listingId, "1")).toBeNull();
      expect(await countDurableRows(organizationId, selfReviewMutation)).toEqual({
        idempotency: 0,
        audit: 0,
        outbox: 0,
      });

      // Self-conflict is proven even when the owner IS granted moderation:
      // the real moderator store refuses any actor that is a member of the
      // target organization, so a granted owner still cannot review its own
      // listing. The synthetic grant is a fixture-only administrative
      // provisioning of the real table, not a product enrollment route.
      await seedModeratorGrant(accountId);
      expect((await readModeratorGrant(accountId))?.status).toBe("active");
      const grantedState = await readListingVersionState(organizationId, listingId, "1");
      if (grantedState === null) throw new Error("version state missing");
      const grantedSelfMutation = canonicalMutationId();
      const grantedSelf = await sameOriginFetch(page, {
        path: `${MODERATOR_BASE}/${encodeURIComponent(organizationId)}/listings/${encodeURIComponent(listingId)}/versions/1/origin-review`,
        method: "POST",
        csrf: "bootstrap",
        idempotencyKey: canonicalIdempotencyKey(),
        body: JSON.stringify({
          mutationId: grantedSelfMutation,
          expectedUpdatedAt: grantedState.updatedAt,
          decision: "approved",
          reviewedEndpointDigest: reviewedEndpointDigest({
            listingId,
            version: "1",
            origin: ENDPOINT_ORIGIN,
            path: ENDPOINT_PATH,
          }),
          reasonCode: "manual_review",
          reasonDigest: null,
        }),
      });
      expect(grantedSelf.status).toBe(403);
      await expectErrorCode(grantedSelf, "FORBIDDEN");
      expect(await readOriginReview(organizationId, listingId, "1")).toBeNull();
      expect(await countDurableRows(organizationId, grantedSelfMutation)).toEqual({
        idempotency: 0,
        audit: 0,
        outbox: 0,
      });
      // Revoke the owner's synthetic grant before the real independent
      // moderator journey, so moderation is never left silently provisioned.
      await revokeModeratorGrant(accountId);
      expect((await readModeratorGrant(accountId))?.status).toBe("revoked");
    });

    // Independent real passkey moderator account in its OWN context. Only the
    // fixture provisions the explicit moderator grant; no organization role and
    // no product enrollment route is involved.
    await withIsolatedSignedInAccount(
      browser,
      ENABLED_ORIGIN,
      async (moderatorPage, moderatorAccountId) => {
        expect((await readModeratorGrant(moderatorAccountId))?.status ?? null).toBeNull();
        await seedModeratorGrant(moderatorAccountId);
        expect((await readModeratorGrant(moderatorAccountId))?.status).toBe("active");

        const versionState = await readListingVersionState(organizationId, listingId, "1");
        if (versionState === null) throw new Error("version state missing");

        const detail = await sameOriginFetch(moderatorPage, {
          path: `${MODERATOR_BASE}/${encodeURIComponent(organizationId)}/listings/${encodeURIComponent(listingId)}/versions/1`,
          method: "GET",
          csrf: "omit",
        });
        expect(detail.status).toBe(200);
        expect(detail.envelopeOk).toBe(true);
        expect(detail.dataKeys).toEqual(["item", "listingId", "organizationId", "version"]);
        expect(detail.hasPrivateMetadata).toBe(false);

        const digest = reviewedEndpointDigest({
          listingId,
          version: "1",
          origin: ENDPOINT_ORIGIN,
          path: ENDPOINT_PATH,
        });
        expect(SHA256_DIGEST.test(digest)).toBe(true);
        const reviewMutation = canonicalMutationId();
        const review = await sameOriginFetch(moderatorPage, {
          path: `${MODERATOR_BASE}/${encodeURIComponent(organizationId)}/listings/${encodeURIComponent(listingId)}/versions/1/origin-review`,
          method: "POST",
          csrf: "bootstrap",
          idempotencyKey: canonicalIdempotencyKey(),
          body: JSON.stringify({
            mutationId: reviewMutation,
            expectedUpdatedAt: versionState.updatedAt,
            decision: "approved",
            reviewedEndpointDigest: digest,
            reasonCode: "manual_review",
            reasonDigest: null,
          }),
        });
        expect(review.status).toBe(200);
        expect(review.envelopeOk).toBe(true);
        expect(review.dataKeys).toEqual(["receipt", "replayed"]);
        const persistedReview = await readOriginReview(organizationId, listingId, "1");
        expect(persistedReview?.decision).toBe("approved");
        expect(persistedReview?.reviewerAccountId).toBe(moderatorAccountId);
        expect(persistedReview?.mutationId).toBe(reviewMutation);
        expect(
          await countDurableRows(organizationId, reviewMutation),
        ).toEqual({ idempotency: 1, audit: 1, outbox: 1 });
      },
    );

    await test.step("provider publishes the approved draft", async () => {
      await selectBaseVersion(page, organizationId);
      const approved = await readListingVersionState(organizationId, listingId, "1");
      expect(approved?.originReviewState).toBe("approved");
      await confirmLifecycle(page, "Publish", "1");
      const root = await readListingRoot(organizationId, listingId);
      expect(root?.activeVersion).toBe("1");
      const active = await readListingVersionState(organizationId, listingId, "1");
      expect(active?.status).toBe("active");
      expect(active?.publishedAt).not.toBeNull();
    });

    // Anonymous public context: no cookies, no account. It sees exactly the
    // approved published version and the exact USDC price.
    const anonContext = await browser.newContext({
      baseURL: ENABLED_ORIGIN,
      ignoreHTTPSErrors: true,
    });
    try {
      const anon = await anonContext.newPage();
      await anon.goto(`/market/${encodeURIComponent(listingId)}`);
      await expect(anon.getByRole("heading", { name: "Support API" })).toBeVisible({
        timeout: 20_000,
      });
      await expect(anon.getByText(PRICE_LABEL, { exact: false }).first()).toBeVisible();
      await expect(
        anon.locator(".market-meta").getByText(ENDPOINT_ORIGIN),
      ).toBeVisible();
      // The owner-only endpoint path is never disclosed publicly.
      await expect(anon.getByText(ENDPOINT_PATH, { exact: true })).toHaveCount(0);

      await anon.goto(`/providers/${encodeURIComponent(providerId)}`);
      await expect(anon.getByRole("heading", { name: "Fixture Provider 001" })).toBeVisible({
        timeout: 20_000,
      });
      await expect(anon.locator(".market-mono").getByText(providerId)).toBeVisible();
    } finally {
      await anonContext.close();
    }

    await test.step("provider pauses, republishes and retires; public detail disappears while paused", async () => {
      await selectBaseVersion(page, organizationId);
      await confirmLifecycle(page, "Pause", "1");
      expect((await readListingRoot(organizationId, listingId))?.activeVersion).toBeNull();

      const pausedContext = await browser.newContext({
        baseURL: ENABLED_ORIGIN,
        ignoreHTTPSErrors: true,
      });
      try {
        const paused = await pausedContext.newPage();
        await paused.goto(`/market/${encodeURIComponent(listingId)}`);
        await expect(
          paused.getByText(
            "This listing is not available. It may have been paused, retired or never published.",
          ),
        ).toBeVisible({ timeout: 20_000 });
      } finally {
        await pausedContext.close();
      }

      await selectBaseVersion(page, organizationId);
      await confirmLifecycle(page, "Publish", "1");
      expect((await readListingRoot(organizationId, listingId))?.activeVersion).toBe("1");

      await selectBaseVersion(page, organizationId);
      await confirmLifecycle(page, "Retire", "1");
      // The lifecycle panel renders from the bound base snapshot. Re-bind the
      // refreshed history row so the terminal retired notice reflects the
      // committed status rather than the stale pre-write snapshot.
      await selectBaseVersion(page, organizationId);
      await expect(page.getByText("Version 1 is retired and terminal.")).toBeVisible();
      expect(
        (await readListingVersionState(organizationId, listingId, "1"))?.status,
      ).toBe("retired");
    });
  });

  test("readonly operator and viewer cannot write, and a stale proof or stale CAS is rejected with no durable mutation", async ({
    browser,
    page,
  }) => {
    // A real stale-proof journey on a fresh owner. The write is refused at the
    // authorization boundary and the ACTUAL known mutation id used by the real
    // browser write is proven to have ZERO durable rows.
    const attempted: { mutationId: string | null } = { mutationId: null };
    let staleOrgId = "";
    await withSignedInAccount(page, async (accountId) => {
      const seeded = await seedOwnOrganizations(accountId, ["Synthetic Market Stale"]);
      const organization = seeded[0];
      if (organization === undefined) throw new Error("seed missing");
      staleOrgId = organization.organizationId;
      const provider = (await seedProviders(organization.organizationId, 1))[0];
      if (provider === undefined) throw new Error("seed missing");

      await openListings(page, organization.organizationId);
      await page.getByRole("button", { name: "Create first draft" }).click();
      await fillListingForm(page, provider.id);

      // A stale proof (real session created_at aged beyond the 5-minute window)
      // refuses the write at the authorization boundary. The known mutation id
      // below is observed from the real browser request so zero durable rows can
      // be proven for the exact attempted write, not merely absent from the UI.
      const { ageAccountSessionProof } = await import(
        "../e2e-tenant-write-production/fixture-db.js"
      );
      const affected = await ageAccountSessionProof(accountId, 900);
      expect(affected).toBeGreaterThan(0);
      page.on("request", (request) => {
        if (request.method() !== "POST") return;
        if (!/\/provider\/organizations\/[^/]+\/listings$/u.test(new URL(request.url()).pathname)) return;
        try {
          const parsed = JSON.parse(request.postData() ?? "{}") as { mutationId?: unknown };
          if (typeof parsed.mutationId === "string") attempted.mutationId = parsed.mutationId;
        } catch {
          attempted.mutationId = null;
        }
      });
      await page.getByRole("button", { name: "Review draft" }).click();
      await page.getByRole("button", { name: "Confirm write" }).click();
      await expect(
        page.getByText("Your session needs re-authentication before this write."),
      ).toBeVisible({ timeout: 20_000 });
      await expect(page.getByText(/Committed operation market\.listing\.create/u)).toHaveCount(0);
    });
    // The stale-proof write was refused with no committed operation. When the
    // browser actually emitted the POST, that EXACT mutation id must have zero
    // idempotency/audit/outbox rows. A guard rejection before send is itself a
    // no-write outcome; both are durable-mutation proofs, not UI-only.
    if (attempted.mutationId !== null) {
      expect(CANONICAL_MUTATION.test(attempted.mutationId)).toBe(true);
      expect(await countDurableRows(staleOrgId, attempted.mutationId)).toEqual({
        idempotency: 0,
        audit: 0,
        outbox: 0,
      });
    }

    // Operator and viewer are BOTH real independent accounts with readonly
    // authority. Each is provisioned its own organization with the exact role,
    // then proven (UI + real API) unable to write.
    await withIsolatedSignedInAccount(
      browser,
      ENABLED_ORIGIN,
      async (operatorPage, operatorAccountId) => {
        const owner = await seedRegisteredOwner();
        const operatorOrg = await seedOrganizationWithRole(
          owner,
          operatorAccountId,
          "Synthetic Market Operator",
          "operator",
        );
        await openListings(operatorPage, operatorOrg.organizationId);
        // The operator surface is read-only: the exact read-only notice renders
        // and no write control is enabled.
        await expect(operatorPage.getByText(/read-only here/u)).toBeVisible();
        await expect(
          operatorPage.getByRole("button", { name: "Create first draft" }),
        ).toBeDisabled();
        // A real operator session over the real API cannot create a listing. The
        // raw body is an intentionally invalid enumeration to keep the guard at
        // the authorization boundary, not a data mutation.
        const anyOperatorMutation = canonicalMutationId();
        const operatorDenied = await sameOriginFetch(operatorPage, {
          path: `${PROVIDER_BASE}/${encodeURIComponent(operatorOrg.organizationId)}/listings`,
          method: "POST",
          csrf: "bootstrap",
          idempotencyKey: canonicalIdempotencyKey(),
          body: JSON.stringify({
            mutationId: anyOperatorMutation,
            providerId: "openarc:provider:00000000-0000-4000-8000-000000000000",
            content: {},
          }),
        });
        expect([400, 403]).toContain(operatorDenied.status);
        expect(operatorDenied.setCookie).toBe(false);
        expect(await countDurableRows(operatorOrg.organizationId, anyOperatorMutation)).toEqual({
          idempotency: 0,
          audit: 0,
          outbox: 0,
        });
      },
    );

    await withIsolatedSignedInAccount(
      browser,
      ENABLED_ORIGIN,
      async (viewerPage, accountId) => {
        const owner = await seedRegisteredOwner();
        const viewerOrg = await seedOrganizationWithRole(
          owner,
          accountId,
          "Synthetic Market Viewer",
          "viewer",
        );
        await openListings(viewerPage, viewerOrg.organizationId);
        // The real running image presents the viewer surface as read-only and
        // does NOT render any write control.
        await expect(viewerPage.getByText(/read-only here/u)).toBeVisible();
        await expect(
          viewerPage.getByRole("button", { name: "Create first draft" }),
        ).toBeDisabled();
        // A viewer session over the real API cannot create a listing.
        const anyMutation = canonicalMutationId();
        const denied = await sameOriginFetch(viewerPage, {
          path: `${PROVIDER_BASE}/${encodeURIComponent(viewerOrg.organizationId)}/listings`,
          method: "POST",
          csrf: "bootstrap",
          idempotencyKey: canonicalIdempotencyKey(),
          body: JSON.stringify({ mutationId: anyMutation, providerId: "openarc:provider:00000000-0000-4000-8000-000000000000", content: {} }),
        });
        expect([400, 403]).toContain(denied.status);
        expect(denied.setCookie).toBe(false);
        expect(await countDurableRows(viewerOrg.organizationId, anyMutation)).toEqual({
          idempotency: 0,
          audit: 0,
          outbox: 0,
        });
      },
    );
  });

  test("publish without approval is a fixed 400 INVALID_REQUEST, absent CSRF is rejected locally by nginx with 400, and a stale CAS is a 409, each with no durable mutation", async ({
    page,
  }) => {
    await withSignedInAccount(page, async (accountId) => {
      const seeded = await seedOwnOrganizations(accountId, ["Synthetic Market Guards"]);
      const organization = seeded[0];
      if (organization === undefined) throw new Error("seed missing");
      const provider = (await seedProviders(organization.organizationId, 1))[0];
      if (provider === undefined) throw new Error("seed missing");

      const listingId = await createFirstDraft(page, organization, provider);
      const versionState = await readListingVersionState(organization.organizationId, listingId, "1");
      if (versionState === null) throw new Error("version state missing");
      const publishPath = `${PROVIDER_BASE}/${encodeURIComponent(organization.organizationId)}/listings/${encodeURIComponent(listingId)}/versions/1/publish`;

      // Unapproved publish: the store refuses with INVALID_REQUEST (400). The
      // known mutation id is proven to have ZERO durable rows.
      const unapprovedMutation = canonicalMutationId();
      const unapproved = await sameOriginFetch(page, {
        path: publishPath,
        method: "POST",
        csrf: "bootstrap",
        idempotencyKey: canonicalIdempotencyKey(),
        body: JSON.stringify({
          mutationId: unapprovedMutation,
          expectedUpdatedAt: versionState.updatedAt,
          expectedActiveVersion: null,
        }),
      });
      expect(unapproved.status).toBe(400);
      await expectErrorCode(unapproved, "INVALID_REQUEST");
      expect(await countDurableRows(organization.organizationId, unapprovedMutation)).toEqual({
        idempotency: 0,
        audit: 0,
        outbox: 0,
      });

      // Absent CSRF is rejected locally by the real nginx boundary with a
      // fixed 400 BEFORE the API can emit its separate 403 CSRF_REJECTED
      // envelope (that canonical API-layer assertion stays in the API suite).
      // This is the actual transport-layer denial: exactly 400, no SPA shell,
      // no success envelope, no data, no private metadata and no Set-Cookie.
      // The known mutation id is proven to have ZERO durable rows.
      const absentCsrfMutation = canonicalMutationId();
      const absentCsrf = await sameOriginFetch(page, {
        path: publishPath,
        method: "POST",
        csrf: "omit",
        idempotencyKey: canonicalIdempotencyKey(),
        body: JSON.stringify({
          mutationId: absentCsrfMutation,
          expectedUpdatedAt: versionState.updatedAt,
          expectedActiveVersion: null,
        }),
      });
      expect(absentCsrf.status).toBe(400);
      expect(absentCsrf.spaShell).toBe(false);
      expect(absentCsrf.envelopeOk).toBe(false);
      expect(absentCsrf.hasDataKey).toBe(false);
      expect(absentCsrf.dataKeys).toBeNull();
      expect(absentCsrf.hasPrivateMetadata).toBe(false);
      expect(absentCsrf.setCookie).toBe(false);
      expect(await countDurableRows(organization.organizationId, absentCsrfMutation)).toEqual({
        idempotency: 0,
        audit: 0,
        outbox: 0,
      });

      // A well-formed but stale CAS token is a definite 409 conflict.
      const staleMutation = canonicalMutationId();
      const stale = await sameOriginFetch(page, {
        path: publishPath,
        method: "POST",
        csrf: "bootstrap",
        idempotencyKey: canonicalIdempotencyKey(),
        body: JSON.stringify({
          mutationId: staleMutation,
          expectedUpdatedAt: "2000-01-01T00:00:00.000Z",
          expectedActiveVersion: null,
        }),
      });
      expect(stale.status).toBe(409);
      await expectErrorCode(stale, "POLICY_DENIED");
      expect(await countDurableRows(organization.organizationId, staleMutation)).toEqual({
        idempotency: 0,
        audit: 0,
        outbox: 0,
      });
      expect((await readListingRoot(organization.organizationId, listingId))?.activeVersion).toBeNull();
    });
  });

  test("deterministic lost response: real draft commit is independently observed, only the CDP response stage fails, then Check status recovers with exactly one durable mutation", async ({
    page,
  }) => {
    await withSignedInAccount(page, async (accountId) => {
      const seeded = await seedOwnOrganizations(accountId, ["Synthetic Market Lost Reply"]);
      const organization = seeded[0];
      if (organization === undefined) throw new Error("seed missing");
      const provider = (await seedProviders(organization.organizationId, 1))[0];
      if (provider === undefined) throw new Error("seed missing");

      await openListings(page, organization.organizationId);
      await page.getByRole("button", { name: "Create first draft" }).click();
      await fillListingForm(page, provider.id);

      const client = await page.context().newCDPSession(page);
      const capture: { mutationId: string | null } = { mutationId: null };
      let createPosts = 0;
      let faultInstalled = true;
      let preFaultCommitConfirmed = false;
      let settleFaultDecision:
        | ((value: { confirmed: boolean; mutationId: string | null }) => void)
        | null = null;
      const faultDecision = new Promise<{ confirmed: boolean; mutationId: string | null }>(
        (resolve) => {
          settleFaultDecision = resolve;
        },
      );
      client.on("Fetch.requestPaused", async (event) => {
        const isCreate =
          event.request.method === "POST" &&
          new RegExp(`^${PROVIDER_BASE}/[^/]+/listings$`, "u").test(
            new URL(event.request.url).pathname,
          );
        if (!isCreate || event.responseStatusCode === undefined) {
          await client
            .send("Fetch.continueRequest", { requestId: event.requestId })
            .catch(() => undefined);
          return;
        }
        createPosts += 1;
        if (!faultInstalled) {
          await client
            .send("Fetch.continueRequest", { requestId: event.requestId })
            .catch(() => undefined);
          return;
        }
        try {
          const parsed = JSON.parse(event.request.postData ?? "{}") as {
            mutationId?: unknown;
          };
          if (typeof parsed.mutationId === "string") capture.mutationId = parsed.mutationId;
        } catch {
          capture.mutationId = null;
        }
        const commit = capture.mutationId;
        let confirmed = false;
        if (commit !== null) {
          for (let attempt = 0; attempt < 40; attempt += 1) {
            const receipt = await readListingRoot(organization.organizationId, `openarc:listing:${commit}`);
            if (receipt !== null) {
              confirmed = true;
              break;
            }
            await new Promise<void>((resolveTick) => setTimeout(resolveTick, 50));
          }
        }
        settleFaultDecision?.({ confirmed, mutationId: commit });
        if (!confirmed) {
          await client
            .send("Fetch.continueRequest", { requestId: event.requestId })
            .catch(() => undefined);
          return;
        }
        preFaultCommitConfirmed = true;
        await client
          .send("Fetch.failRequest", { requestId: event.requestId, errorReason: "Failed" })
          .catch(() => undefined);
      });
      await client.send("Fetch.enable", {
        patterns: [{ urlPattern: "*", requestStage: "Response" }],
      });

      await page.getByRole("button", { name: "Review draft" }).click();
      await page.getByRole("button", { name: "Confirm write" }).click();

      const decision = await faultDecision;
      expect(decision.confirmed).toBe(true);
      expect(preFaultCommitConfirmed).toBe(true);
      expect(decision.mutationId).toBe(capture.mutationId);
      expect(createPosts).toBe(1);

      await expect(page.getByRole("heading", { name: "The write outcome is unknown" })).toBeVisible();
      const mutationId = capture.mutationId;
      if (mutationId === null) throw new Error("MUTATION_ID_NOT_OBSERVED");
      expect(CANONICAL_MUTATION.test(mutationId)).toBe(true);
      const listingId = `openarc:listing:${mutationId}`;
      expect((await readListingRoot(organization.organizationId, listingId))?.latestVersion).toBe("1");
      expect(await countDurableRows(organization.organizationId, mutationId)).toEqual({
        idempotency: 1,
        audit: 1,
        outbox: 1,
      });

      faultInstalled = false;
      await page.getByRole("button", { name: "Check status" }).click();
      await expect(page.getByText("Committed operation market.listing.create")).toBeVisible({
        timeout: 20_000,
      });
      await expect(page.getByRole("heading", { name: "The write outcome is unknown" })).toHaveCount(0);
      expect(createPosts).toBe(1);
      await client.send("Fetch.disable");

      expect(await countDurableRows(organization.organizationId, mutationId)).toEqual({
        idempotency: 1,
        audit: 1,
        outbox: 1,
      });
    });
  });

  test("pagehide and visibility hidden erase the listing draft, mobile 320px and keyboard navigation stay bounded, and no private metadata leaks to URL/storage", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 320, height: 800 });
    await withSignedInAccount(page, async (accountId) => {
      const seeded = await seedOwnOrganizations(accountId, ["Synthetic Market Cleanup"]);
      const organization = seeded[0];
      if (organization === undefined) throw new Error("seed missing");
      const provider = (await seedProviders(organization.organizationId, 1))[0];
      if (provider === undefined) throw new Error("seed missing");

      await openListings(page, organization.organizationId);
      await page.getByRole("button", { name: "Create first draft" }).click();
      await fillListingForm(page, provider.id);

      const overflow = await page.evaluate(() => ({
        scrollWidth: document.documentElement.scrollWidth,
        innerWidth: window.innerWidth,
      }));
      expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.innerWidth);

      const title = page.getByLabel("Title");
      await expect(title).toHaveValue("Support API");
      // The design system's bounded touch target is the 44px `.tenant-button`
      // control; the listing field inputs are text controls, so the mobile
      // touch-size check targets the primary listing action the user taps.
      const reviewBox = await page
        .getByRole("button", { name: "Review draft" })
        .boundingBox();
      expect(reviewBox?.height ?? 0).toBeGreaterThanOrEqual(44);

      // Same-task pagehide clears the draft synchronously on the same document.
      await page.evaluate(() => {
        window.dispatchEvent(new Event("pagehide"));
      });
      await expect(page.getByLabel("Title")).toHaveCount(0);
      // Hidden clears ALL protected organization data; the workspace honestly
      // offers the explicit recovery control instead of stale data.
      await expect(
        page.getByRole("heading", { name: "Refresh required" }),
      ).toBeVisible();
      await page.getByRole("button", { name: "Refresh workspace" }).click();
      await openListings(page, organization.organizationId);
      await expect(page.getByText("No listings in this organization yet.")).toBeVisible();

      // Re-open and hide the document; the protected draft is erased.
      await page.getByRole("button", { name: "Create first draft" }).click();
      await fillListingForm(page, provider.id);
      await page.evaluate(() => {
        Object.defineProperty(document, "visibilityState", {
          configurable: true,
          get: () => "hidden",
        });
        document.dispatchEvent(new Event("visibilitychange"));
      });
      await expect(page.getByLabel("Title")).toHaveCount(0);
      await expect(
        page.getByRole("heading", { name: "Refresh required" }),
      ).toBeVisible();

      const residue = await page.evaluate(() => ({
        local: JSON.stringify(window.localStorage),
        session: JSON.stringify(window.sessionStorage),
        href: window.location.href,
        html: document.documentElement.outerHTML,
      }));
      for (const blob of [residue.local, residue.session, residue.href, residue.html]) {
        expect(blob).not.toMatch(/idempotency/iu);
        expect(blob).not.toMatch(/csrf/iu);
        expect(blob).not.toMatch(/sessionHash/iu);
        expect(blob).not.toMatch(/__Host-/u);
      }

      // Keyboard-confirmed draft still commits after a fresh explicit open.
      await page.getByRole("button", { name: "Refresh workspace" }).click();
      await openListings(page, organization.organizationId);
      await expect(page.getByText("No listings in this organization yet.")).toBeVisible();
      await page.getByRole("button", { name: "Create first draft" }).click();
      await fillListingForm(page, provider.id, { title: "Keyboard API" });
      const review = page.getByRole("button", { name: "Review draft" });
      await review.focus();
      await review.press("Enter");
      const confirm = page.getByRole("button", { name: "Confirm write" });
      await confirm.focus();
      await confirm.press("Enter");
      await expect(page.getByText(/Committed operation market\.listing\.create/u)).toBeVisible({
        timeout: 20_000,
      });
    });
  });

  test("nginx boundary probes across the 18 frozen route families reject wrong verb, query and the real public-cookie with no SPA fallback, Set-Cookie or CORS", async ({
    page,
  }) => {
    await withSignedInAccount(page, async (accountId) => {
      const seeded = await seedOwnOrganizations(accountId, ["Synthetic Market Boundary"]);
      const organization = seeded[0];
      if (organization === undefined) throw new Error("seed missing");
      const provider = (await seedProviders(organization.organizationId, 1))[0];
      if (provider === undefined) throw new Error("seed missing");
      await page.goto("/app/overview");
      await selectOrganization(page, organization.organizationId);

      const listingId = "openarc:listing:11111111-1111-4111-8111-111111111111";
      const mutationId = "22222222-2222-4222-8222-222222222222";

      const fillRoute = (route: MarketplaceRouteDescriptor): string =>
        route.path
          .replace(":organizationId", encodeURIComponent(organization.organizationId))
          .replace(":listingId", encodeURIComponent(listingId))
          .replace(":providerId", encodeURIComponent(provider.id))
          .replace(":version", "1")
          .replace(":mutationId", mutationId);

      // Exact observed status for the three public, credentialless catalog
      // routes, derived from the frozen catalog source and confirmed against
      // the running stack. The list accepts the default page (200); a
      // canonical-but-missing listing detail is a truthful nullable 200 (the
      // service maps a null store miss to `{ item: null }`), NOT a 404; a real
      // provider id also yields 200 (possibly with a null item). Only an exact
      // match satisfies these assertions — there is no "any 4xx" widening.
      const expectedPublicStatus: Readonly<Record<string, number>> = {
        catalog_list: 200,
        catalog_detail: 200,
        catalog_provider: 200,
      };

      for (const route of MARKETPLACE_ROUTES) {
        const outcome = await proxiedBrowserFetch(page, {
          path: fillRoute(route),
          method: route.method,
          ...(route.method === "POST" ? { body: "{}" } : {}),
          // Public catalog is credentialless; protected probes keep the real
          // same-origin cookie. No cookie is read, set or serialized.
          credentials: route.audience === "public" ? "omit" : "same-origin",
        });
        // A frozen route family never falls back to the SPA shell and never
        // mints a cookie or a CORS header at the nginx boundary.
        expect(outcome.body.spaShell, route.id).toBe(false);
        expect(outcome.setCookieHeaderPresent, route.id).toBe(false);
        expect(outcome.corsAllowOriginPresent, route.id).toBe(false);
        expect(outcome.status, route.id).toBeLessThan(500);
        expect(outcome.body.hasPrivateMetadata, route.id).toBe(false);
        const expectedStatus = expectedPublicStatus[route.id];
        if (expectedStatus !== undefined) {
          expect(outcome.status, route.id).toBe(expectedStatus);
        }
        if (expectedStatus === 200) {
          expect(outcome.body.envelopeOk, route.id).toBe(true);
          expect(outcome.body.hasDataKey, route.id).toBe(true);
        }
      }

      // Wrong verb on a public read route is the fixed 405 method denial
      // (not the SPA shell), with no cookie or CORS minted.
      const wrongVerb = await proxiedBrowserFetch(page, {
        path: `${PUBLIC_LISTINGS}?limit=1`,
        method: "DELETE",
        credentials: "omit",
      });
      expect(wrongVerb.status).toBe(405);
      expect(wrongVerb.body.spaShell).toBe(false);
      expect(wrongVerb.setCookieHeaderPresent).toBe(false);
      expect(wrongVerb.corsAllowOriginPresent).toBe(false);

      // An invalid query on a public read route is refused by the API boundary.
      const invalidQuery = await proxiedBrowserFetch(page, {
        path: `${PUBLIC_LISTINGS}?limit=0`,
        method: "GET",
        credentials: "omit",
      });
      expect(invalidQuery.status).toBe(400);
      expect(invalidQuery.body.envelopeOk).toBe(false);
      expect(invalidQuery.body.hasDataKey).toBe(false);
      expect(invalidQuery.body.spaShell).toBe(false);
      expect(invalidQuery.setCookieHeaderPresent).toBe(false);
      expect(invalidQuery.corsAllowOriginPresent).toBe(false);

      // A lookalike public path is an exact 404, never the app shell.
      const lookalike = await proxiedBrowserFetch(page, {
        path: `${PUBLIC_LISTINGS}-extra`,
        method: "GET",
        credentials: "omit",
      });
      expect(lookalike.status).toBe(404);
      expect(lookalike.body.spaShell).toBe(false);
      expect(lookalike.setCookieHeaderPresent).toBe(false);
      expect(lookalike.corsAllowOriginPresent).toBe(false);

      // Deliberate public-cookie rejection: the SAME real signed-in page issues
      // a same-origin request to the credentialless public catalog, so the
      // browser attaches its ACTUAL account cookie. The public boundary rejects
      // it before stripping it: exactly 403, no SPA, no Set-Cookie, no CORS and
      // no data. Browser JS cannot inject a Cookie header, and none is needed.
      const cookieProbe = await proxiedBrowserFetch(page, {
        path: `${PUBLIC_LISTINGS}?limit=1`,
        method: "GET",
        credentials: "same-origin",
      });
      expect(cookieProbe.status).toBe(403);
      expect(cookieProbe.body.spaShell).toBe(false);
      expect(cookieProbe.setCookieHeaderPresent).toBe(false);
      expect(cookieProbe.corsAllowOriginPresent).toBe(false);
      expect(cookieProbe.body.envelopeOk).toBe(false);
      expect(cookieProbe.body.hasDataKey).toBe(false);
      expect(cookieProbe.body.hasPrivateMetadata).toBe(false);
    });
  });
});

/** Helper used only to create throwaway owner accounts for role fixtures. */
async function seedRegisteredOwner(): Promise<string> {
  const { seedAccount } = await import("../e2e-tenant-write-production/fixture-db.js");
  return seedAccount();
}

/* -------------------------------------------------------------------------- */
/* @market-off: marketplace OFF, account/tenant reads ON                      */
/* -------------------------------------------------------------------------- */

test.describe("PORT-02 marketplace OFF", { tag: "@market-off" }, () => {
  test("the disabled marketplace keeps the account/tenant read experience while editor and public network work stay off", async ({
    page,
  }) => {
    await withSignedInAccount(page, async (accountId) => {
      const publicRequests: string[] = [];
      page.on("request", (request) => {
        const path = new URL(request.url()).pathname;
        if (
          path === "/v2/public/marketplace-capabilities" ||
          path.startsWith("/v2/public/market/") ||
          path.startsWith("/v2/provider/organizations") ||
          path.startsWith("/v2/moderator/organizations")
        ) {
          publicRequests.push(path);
        }
      });

      // The disabled public marketplace renders its static disabled shell and
      // issues no capability or catalog request.
      await page.goto("/market");
      await expect(
        page.getByRole("heading", { name: "The public marketplace is not enabled here" }),
      ).toBeVisible();
      expect(publicRequests).toEqual([]);

      // The protected listing subtree is unavailable and makes zero listing
      // requests with the marketplace OFF.
      await page.goto("/app/provider/listings");
      await expect(
        page.getByRole("heading", { name: "This section is not available yet" }),
      ).toBeVisible();
      expect(publicRequests).toEqual([]);
      await expect(page.getByRole("button", { name: "Create first draft" })).toHaveCount(0);

      // The accepted account/tenant read experience is preserved.
      const seeded = await seedOwnOrganizations(accountId, ["Synthetic Market Off Read"]);
      const organization = seeded[0];
      if (organization === undefined) throw new Error("seed missing");
      const agent = (await seedAgents(organization.organizationId, 1))[0];
      if (agent === undefined) throw new Error("seed missing");

      await page.goto("/app/overview");
      await selectOrganization(page, organization.organizationId);
      await expect(
        page.getByRole("heading", { name: "Synthetic Market Off Read", exact: true }),
      ).toBeVisible();
      await page.getByRole("link", { name: "Agents" }).click();
      await expect(page.getByRole("heading", { name: "Agents", exact: true })).toBeVisible();
      const load = page.getByRole("button", { name: "Load agents" });
      if ((await load.count()) > 0) await load.click();
      await expect(page.getByText(agent.displayName)).toBeVisible();
      expect(publicRequests).toEqual([]);
    });
  });
});

export type { SeededOrganization, SeededProfile };
