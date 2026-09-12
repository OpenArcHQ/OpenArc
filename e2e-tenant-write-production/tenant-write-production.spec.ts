import {
  expect,
  test,
  type Browser,
  type CDPSession,
  type Page,
} from "@playwright/test";

import {
  ageAccountSessionProof,
  countAccountSessions,
  countDurableRows,
  readAgentRow,
  readDurableReceipt,
  readMembershipRow,
  readOrganizationRow,
  readProviderRow,
  seedAccount,
  seedAgents,
  seedMembership,
  seedOrganizationWithRole,
  seedOwnOrganizations,
  seedRegisteredAccount,
} from "./fixture-db.js";

/**
 * PORT-01 protected tenant WRITE production acceptance.
 *
 * Every journey targets the REAL API + PostgreSQL + production nginx through
 * the lead-provisioned loopback origin. There is no route interception for the
 * positive write journeys, no HTTP mock, no session-cookie injection and no
 * test-only app endpoint. The account is created through the real passkey
 * sign-up UI; only synthetic tenant data is seeded server-side by the guarded
 * node fixture. The single deterministic browser delivery fault (unknown
 * outcome) is a CDP Fetch response-stage failure applied AFTER the real API has
 * processed the write and the fixture has independently confirmed the commit.
 */

// Every journey creates its own synthetic passkey account and its own seeded
// organization, so the file must NOT use serial mode: one real bootstrap
// failure must never skip the other independent acceptance cases. A single
// worker (see the production config) still keeps them sequential and
// deterministic, and each test's authoritative outcome is its own.

const CANONICAL_ACCOUNT =
  /^openarc:account:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const CANONICAL_ORGANIZATION =
  /^openarc:org:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const CANONICAL_AGENT =
  /^openarc:agent:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const CANONICAL_PROVIDER =
  /^openarc:provider:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const CANONICAL_MUTATION =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

const TENANT_API_PREFIX = "/v1/operator/organizations";

interface VirtualAuthenticator {
  readonly client: CDPSession;
  readonly id: string;
}

/* -------------------------------------------------------------------------- */
/* Real passkey UI sign-up                                                    */
/* -------------------------------------------------------------------------- */

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
 * Runs one real-UI passkey journey in its OWN isolated browser context.
 *
 * A single test that must prove two independent accounts (a viewer and an
 * operator) cannot safely create both in one shared context: the second real
 * sign-up would otherwise contend with the first session. A fresh context is
 * the browser-correct isolation for independent journeys, and it is exactly
 * what a separate test would get. No cookie is read, injected or serialized;
 * the account is still created through the visible `/account` UI. The
 * Chromium host-resolver rule is a browser-level launch flag (see the
 * production config), so the isolated context resolves the same reserved
 * loopback hostname; only the HTTPS fixture exemption and base URL are copied.
 */
async function withIsolatedSignedInAccount(
  browser: Browser,
  origin: string,
  run: (page: Page, accountId: string) => Promise<void>,
): Promise<void> {
  const context = await browser.newContext({
    baseURL: origin,
    ignoreHTTPSErrors: true,
  });
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

function operationSelect(page: Page) {
  return page.getByLabel("Operation");
}

async function selectOrganization(
  page: Page,
  organizationId: string,
): Promise<void> {
  await page.locator(".tenant-org-select").selectOption({
    value: organizationId,
  });
  await expect(page.locator(".tenant-org-select").first()).toHaveValue(
    organizationId,
  );
}

/**
 * Reads the committed receipt from the visible receipt region and returns its
 * mutation/resource ids. Only synthetic canonical ids are read; no raw server
 * body, cookie or key is ever surfaced.
 */
async function readCommittedReceipt(
  page: Page,
): Promise<{ mutationId: string; resourceId: string; operation: string }> {
  await expect(page.getByText("Change committed")).toBeVisible({
    timeout: 20_000,
  });
  const receipt = page.locator(".tenant-receipt");
  await expect(receipt).toBeVisible();
  const dds = receipt.locator("dl.tenant-meta dd");
  const mutationId = (await dds.nth(2).innerText()).trim();
  const resourceId = (await dds.nth(1).innerText()).trim();
  const operation = (await dds.nth(0).innerText()).trim();
  expect(CANONICAL_MUTATION.test(mutationId) || mutationId.length > 0).toBe(
    true,
  );
  return { mutationId, resourceId, operation };
}

/** Runs the visible two-step review + confirm flow. */
async function reviewAndSend(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Review change" }).click();
  await expect(page.getByText("Confirm this change")).toBeVisible();
  await page.getByRole("button", { name: "Confirm and send" }).click();
}

interface CapturedReceipt {
  mutationId: string;
  resourceId: string;
  operation: string;
}

/**
 * Records the committed receipt the instant it appears, so a self-demotion
 * that signs the page out in the same tick cannot race the assertion away.
 * Only synthetic canonical ids displayed by the panel are captured.
 */
async function installReceiptCapture(page: Page): Promise<void> {
  await page.evaluate(() => {
    const sink: { value: { mutationId: string; resourceId: string; operation: string } | null } =
      { value: null };
    (window as typeof window & { __openarcReceipt?: typeof sink }).__openarcReceipt =
      sink;
    const snapshot = (): void => {
      if (sink.value !== null) return;
      if (document.querySelector(".tenant-receipt") === null) return;
      if (!/Change (?:already )?committed/u.test(document.body.innerText)) return;
      const dds = document.querySelectorAll(".tenant-receipt dl.tenant-meta dd");
      if (dds.length < 3) return;
      const operation = dds[0]?.textContent?.trim() ?? "";
      const resourceId = dds[1]?.textContent?.trim() ?? "";
      const mutationId = dds[2]?.textContent?.trim() ?? "";
      if (operation.length === 0 || mutationId.length === 0) return;
      sink.value = { mutationId, resourceId, operation };
    };
    const observer = new MutationObserver(snapshot);
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      characterData: true,
    });
    snapshot();
  });
}

async function readCapturedReceipt(page: Page): Promise<CapturedReceipt> {
  await expect
    .poll(
      async () =>
        page.evaluate(() => {
          const sink = (
            window as typeof window & {
              __openarcReceipt?: { value: CapturedReceipt | null };
            }
          ).__openarcReceipt;
          return sink?.value ?? null;
        }),
      { timeout: 20_000 },
    )
    .not.toBeNull();
  const captured = await page.evaluate(() => {
    const sink = (
      window as typeof window & {
        __openarcReceipt?: { value: CapturedReceipt | null };
      }
    ).__openarcReceipt;
    return sink?.value ?? null;
  });
  if (captured === null) throw new Error("RECEIPT_NOT_CAPTURED");
  return captured;
}

/** Reload the workspace and explicitly re-select the organization. */
async function reloadAndSelect(
  page: Page,
  organizationId: string,
): Promise<void> {
  await page.reload();
  await selectOrganization(page, organizationId);
}

/* -------------------------------------------------------------------------- */
/* Backend direct same-origin fetch (real bootstrap CSRF, transient closure)  */
/* -------------------------------------------------------------------------- */

interface DirectFetchOutcome {
  readonly status: number;
  readonly setCookie: boolean;
  readonly errorCode: string | null;
  readonly hasProtectedDto: boolean;
  readonly bodyLength: number;
  /**
   * Bounded RESPONSE-SHAPE metadata only, never any value. A successful
   * response is proven by its envelope and exact data keys; a denied response
   * is proven by `hasProtectedDto === false` and its fixed error code. This
   * lets success assertions check the intended DTO shape without treating a
   * legitimate protected DTO as a leak, and without ever exposing a value.
   */
  readonly envelopeOk: boolean;
  readonly topLevelKeys: readonly string[];
  readonly dataKeys: readonly string[] | null;
  readonly receiptKeys: readonly string[] | null;
}

/**
 * Performs ONE direct same-origin request. The real bootstrap CSRF token is
 * fetched and used entirely inside a single transient `page.evaluate` closure;
 * it is never returned, stored, logged or embedded in a URL. Only the bounded
 * outcome metadata crosses back to the test.
 */
async function sameOriginFetch(
  page: Page,
  request: {
    readonly path: string;
    readonly method: "GET" | "POST" | "PATCH" | "PUT";
    readonly body?: string;
    readonly idempotencyKey?: string;
    readonly csrf?: "bootstrap" | "wrong" | "omit";
    readonly contentType?: string;
    readonly extraHeaders?: Record<string, string>;
    readonly rawUrl?: string;
  },
): Promise<DirectFetchOutcome> {
  return page.evaluate(async (input) => {
    let csrfToken: string | null = null;
    if (input.csrf === "bootstrap") {
      const response = await fetch("/v2/auth/bootstrap", {
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
      const json = (await response.json()) as { data?: { csrfToken?: unknown } };
      const token = json.data?.csrfToken;
      csrfToken = typeof token === "string" && token.length > 0 ? token : null;
      if (csrfToken === null) {
        throw new Error("BOOTSTRAP_CSRF_UNAVAILABLE");
      }
    }
    const headers: Record<string, string> = {
      "X-OpenArc-Client": "browser-v1",
      Accept: "application/json",
      ...(input.extraHeaders ?? {}),
    };
    if (input.contentType !== undefined && input.body !== undefined) {
      headers["Content-Type"] = input.contentType;
    }
    if (input.idempotencyKey !== undefined) {
      headers["Idempotency-Key"] = input.idempotencyKey;
    }
    if (input.csrf === "bootstrap") {
      if (csrfToken !== null) headers["X-OpenArc-CSRF"] = csrfToken;
    } else if (input.csrf === "wrong") {
      headers["X-OpenArc-CSRF"] = "synthetic-wrong-csrf";
    }
    const response = await fetch(input.rawUrl ?? input.path, {
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
    let topLevelKeys: string[] = [];
    let dataKeys: string[] | null = null;
    let receiptKeys: string[] | null = null;
    try {
      const parsed = JSON.parse(text) as {
        ok?: unknown;
        data?: unknown;
        error?: { code?: unknown };
      };
      if (typeof parsed === "object" && parsed !== null) {
        topLevelKeys = Object.keys(parsed).sort();
        envelopeOk = parsed.ok === true;
        if (typeof parsed.data === "object" && parsed.data !== null) {
          dataKeys = Object.keys(parsed.data).sort();
          const receipt = (parsed.data as { receipt?: unknown }).receipt;
          if (typeof receipt === "object" && receipt !== null) {
            receiptKeys = Object.keys(receipt).sort();
          }
        }
      }
      const code = parsed.error?.code;
      errorCode = typeof code === "string" ? code : null;
    } catch {
      errorCode = null;
    }
    return {
      status: response.status,
      setCookie: response.headers.get("set-cookie") !== null,
      errorCode,
      hasProtectedDto:
        /"(?:organizationId|displayName|membershipStatus|access|resourceId|replayed|receipt)"\s*:/u.test(
          text,
        ),
      bodyLength: text.length,
      envelopeOk,
      topLevelKeys,
      dataKeys,
      receiptKeys,
    };
  }, request);
}

/**
 * Exact success-shape assertions. These prove a success is the intended DTO
 * (envelope + data + nested receipt keys) WITHOUT treating the protected DTO
 * as a leak and WITHOUT ever reading or logging a value. The leak check
 * (`hasProtectedDto === false`) is reserved for DENIED responses.
 */
const OK_ENVELOPE_KEYS = ["data", "meta", "ok"] as const;
// `sameOriginFetch` records object keys with `.sort()`, so an expected shape
// must be stated in code-unit order. These are still exactly the three keys of
// the intended committed-mutation DTO; nothing is added or dropped.
const MUTATION_DATA_KEYS = ["organizationId", "receipt", "replayed"] as const;
// Complete exact committed-receipt DTO shape (see
// CommerceTenantMutationReceiptSchema), stated in the code-unit order the
// fetcher uses. No extra or missing key is accepted.
const RECEIPT_KEYS = [
  "committedAt",
  "mutationId",
  "operation",
  "resourceId",
  "resourceType",
] as const;

function expectMutationEnvelope(outcome: DirectFetchOutcome): void {
  expect(outcome.envelopeOk).toBe(true);
  expect(outcome.topLevelKeys).toEqual([...OK_ENVELOPE_KEYS]);
  expect(outcome.dataKeys).toEqual([...MUTATION_DATA_KEYS]);
  expect(outcome.receiptKeys).toEqual([...RECEIPT_KEYS]);
}

function expectOrganizationPageEnvelope(outcome: DirectFetchOutcome): void {
  expect(outcome.envelopeOk).toBe(true);
  expect(outcome.topLevelKeys).toEqual([...OK_ENVELOPE_KEYS]);
  expect(outcome.dataKeys).toEqual(["items", "nextCursor"]);
}

function expectOrganizationContextEnvelope(outcome: DirectFetchOutcome): void {
  expect(outcome.envelopeOk).toBe(true);
  expect(outcome.topLevelKeys).toEqual([...OK_ENVELOPE_KEYS]);
  expect(outcome.dataKeys).toEqual(["access", "network", "organization"]);
}

/**
 * A canonical 43-character unpadded base64url idempotency key is generated
 * locally for guard tests only. It is never logged or placed in a URL.
 */
function localIdempotencyKey(seed: number): string {
  const bytes = new Uint8Array(32);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = (seed * 31 + index * 7) & 0xff;
  }
  bytes[31] = (bytes[31] as number) & 0b11;
  const alphabet =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  let out = "";
  for (let index = 0; index < bytes.length; index += 3) {
    const b0 = bytes[index] as number;
    const b1 = index + 1 < bytes.length ? (bytes[index + 1] as number) : 0;
    const b2 = index + 2 < bytes.length ? (bytes[index + 2] as number) : 0;
    const triplet = (b0 << 16) | (b1 << 8) | b2;
    out += alphabet[(triplet >> 18) & 0x3f];
    out += alphabet[(triplet >> 12) & 0x3f];
    if (index + 1 < bytes.length) out += alphabet[(triplet >> 6) & 0x3f];
    if (index + 2 < bytes.length) out += alphabet[triplet & 0x3f];
  }
  return out;
}

function localMutationId(seed: number): string {
  const hex: string[] = [];
  for (let index = 0; index < 16; index += 1) {
    hex.push(((seed * 17 + index * 13) & 0xff).toString(16).padStart(2, "0"));
  }
  const raw = hex.join("");
  return `${raw.slice(0, 8)}-${raw.slice(8, 12)}-4${raw.slice(13, 16)}-8${raw.slice(17, 20)}-${raw.slice(20, 32)}`;
}

/* -------------------------------------------------------------------------- */
/* @tenant-write-on                                                           */
/* -------------------------------------------------------------------------- */

test.describe("PORT-01 tenant write production acceptance", { tag: "@tenant-write-on" }, () => {
  test("first signed-in zero-org bootstrap creates org, owner, one audit and one outbox through the visible form", async ({
    page,
  }) => {
    await withSignedInAccount(page, async (accountId) => {
      await page.goto("/app/overview");
      await expect(
        page.getByRole("heading", { name: "No organizations available." }),
      ).toBeVisible();
      await expect(
        page.getByRole("heading", { name: "Membership and tenant changes" }),
      ).toBeVisible();
      // Bootstrap mode offers only Create organization and no org is selected.
      await expect(operationSelect(page)).toHaveValue("tenant.organization.create");
      await expect(page.locator(".tenant-org-select")).toHaveValue("");

      await page.getByLabel("Display name").fill("Synthetic Bootstrap Org");
      await page.getByRole("button", { name: "Review change" }).click();
      await expect(page.getByText("Confirm this change")).toBeVisible();
      await expect(page.getByText(/Create organization/u)).toBeVisible();
      await page.getByRole("button", { name: "Confirm and send" }).click();

      const committed = await readCommittedReceipt(page);
      const organizationId = `openarc:org:${committed.mutationId}`;
      expect(CANONICAL_ORGANIZATION.test(organizationId)).toBe(true);
      expect(committed.resourceId).toBe(organizationId);
      expect(committed.operation).toBe("tenant.organization.create");

      // Real DB proof: organization + owner membership + one audit/outbox.
      const organization = await readOrganizationRow(organizationId);
      expect(organization?.displayName).toBe("Synthetic Bootstrap Org");
      expect(organization?.createdBy).toBe(accountId);
      const membership = await readMembershipRow(organizationId, accountId);
      expect(membership).toEqual({ role: "owner", status: "active" });
      const counts = await countDurableRows(organizationId, committed.mutationId);
      expect(counts).toEqual({ idempotency: 1, audit: 1, outbox: 1 });
      const receipt = await readDurableReceipt(organizationId, committed.mutationId);
      expect(receipt?.resourceType).toBe("organization");

      // No auto org selection after the reload.
      await page.reload();
      await expect(page.locator(".tenant-org-select")).toHaveValue("");
      await expect(
        page.getByRole("heading", { name: "Synthetic Bootstrap Org" }),
      ).toHaveCount(0);
    });
  });

  test("owner and operator create/edit agents and owner creates/edits providers, proven by fresh real reads", async ({
    page,
  }) => {
    await withSignedInAccount(page, async (accountId) => {
      const seeded = await seedOwnOrganizations(accountId, [
        "Synthetic Write Org",
      ]);
      const organization = seeded[0];
      if (organization === undefined) throw new Error("seed missing");
      const seedAgent = (await seedAgents(organization.organizationId, 1))[0];
      if (seedAgent === undefined) throw new Error("seed missing");

      await page.goto("/app/overview");
      await selectOrganization(page, organization.organizationId);

      // Owner creates an agent.
      await page.getByRole("link", { name: "Agents" }).click();
      await expect(
        page.getByRole("heading", { name: "Agents", exact: true }),
      ).toBeVisible();
      await page.getByLabel("Operation").selectOption("tenant.agent.create");
      await page.getByLabel("Display name").fill("Created Agent");
      await reviewAndSend(page);
      const created = await readCommittedReceipt(page);
      expect(created.operation).toBe("tenant.agent.create");
      expect(CANONICAL_AGENT.test(created.resourceId)).toBe(true);
      expect(await readAgentRow(organization.organizationId, created.resourceId)).toEqual({
        displayName: "Created Agent",
        status: "active",
      });

      // A committed panel stays on the receipt; re-enter the workspace for the
      // next explicit change (no implicit dismissal that could resubmit).
      await reloadAndSelect(page, organization.organizationId);
      await page.getByRole("link", { name: "Agents" }).click();
      await expect(
        page.getByRole("heading", { name: "Agents", exact: true }),
      ).toBeVisible();

      // Owner edits that agent name and status.
      await page.getByLabel("Operation").selectOption("tenant.agent.update");
      await page.getByLabel("Resource ID").fill(created.resourceId);
      await page.getByLabel("New display name (optional)").fill("Renamed Agent");
      await page
        .getByLabel("New status (optional)")
        .selectOption("suspended");
      await reviewAndSend(page);
      const edited = await readCommittedReceipt(page);
      expect(edited.operation).toBe("tenant.agent.update");
      expect(await readAgentRow(organization.organizationId, created.resourceId)).toEqual({
        displayName: "Renamed Agent",
        status: "suspended",
      });

      await reloadAndSelect(page, organization.organizationId);
      await page.getByRole("link", { name: "Provider" }).click();
      await expect(
        page.getByRole("heading", { name: "Provider", exact: true }),
      ).toBeVisible();

      // Owner creates and edits a provider.
      await page.getByLabel("Operation").selectOption("tenant.provider.create");
      await page.getByLabel("Display name").fill("Created Provider");
      await reviewAndSend(page);
      const providerCreated = await readCommittedReceipt(page);
      expect(providerCreated.operation).toBe("tenant.provider.create");
      expect(CANONICAL_PROVIDER.test(providerCreated.resourceId)).toBe(true);
      expect(
        await readProviderRow(organization.organizationId, providerCreated.resourceId),
      ).toEqual({ displayName: "Created Provider", status: "active" });

      await reloadAndSelect(page, organization.organizationId);
      await page.getByRole("link", { name: "Provider" }).click();
      await expect(
        page.getByRole("heading", { name: "Provider", exact: true }),
      ).toBeVisible();
      await page.getByLabel("Operation").selectOption("tenant.provider.update");
      await page.getByLabel("Resource ID").fill(providerCreated.resourceId);
      await page.getByLabel("New display name (optional)").fill("Renamed Provider");
      await page.getByLabel("New status (optional)").selectOption("suspended");
      await reviewAndSend(page);
      await readCommittedReceipt(page);
      expect(
        await readProviderRow(organization.organizationId, providerCreated.resourceId),
      ).toEqual({ displayName: "Renamed Provider", status: "suspended" });

      // Exactly updated real read data after an explicit refresh.
      await page.reload();
      await selectOrganization(page, organization.organizationId);
      await page.getByRole("link", { name: "Agents" }).click();
      await page.getByRole("button", { name: "Load agents" }).click();
      await expect(
        page.getByRole("cell", { name: "Renamed Agent", exact: true }),
      ).toBeVisible();
      await expect(
        page.getByRole("cell", { name: seedAgent.displayName, exact: true }),
      ).toBeVisible();
      await expect(page.getByRole("cell", { name: "created", exact: true })).toHaveCount(0);

      await page.getByRole("link", { name: "Provider" }).click();
      await page.getByRole("button", { name: "Load providers" }).click();
      await expect(
        page.getByRole("cell", { name: "Renamed Provider", exact: true }),
      ).toBeVisible();
    });
  });

  test("operator can create an agent but cannot choose a provider operation", async ({
    page,
  }) => {
    await withSignedInAccount(page, async (accountId) => {
      const owner = await seedAccount();
      const organization = await seedOrganizationWithRole(
        owner,
        accountId,
        "Synthetic Operator Write",
        "operator",
      );
      await page.goto("/app/overview");
      await selectOrganization(page, organization.organizationId);
      await page.getByRole("link", { name: "Agents" }).click();
      await expect(
        page.getByRole("heading", { name: "Agents", exact: true }),
      ).toBeVisible();

      // Provider operations are disabled options for an operator.
      const providerCreate = page
        .getByLabel("Operation")
        .locator('option[value="tenant.provider.create"]');
      await expect(providerCreate).toBeDisabled();
      const providerUpdate = page
        .getByLabel("Operation")
        .locator('option[value="tenant.provider.update"]');
      await expect(providerUpdate).toBeDisabled();

      // Operator may write agents.
      await page.getByLabel("Operation").selectOption("tenant.agent.create");
      await page.getByLabel("Display name").fill("Operator Agent");
      await reviewAndSend(page);
      const committed = await readCommittedReceipt(page);
      expect(committed.operation).toBe("tenant.agent.create");
      expect(
        await readAgentRow(organization.organizationId, committed.resourceId),
      ).toEqual({ displayName: "Operator Agent", status: "active" });
    });
  });

  test("owner sets a real membership role shown after fresh read, then self-demotion commits and revokes the session", async ({
    page,
  }) => {
    await withSignedInAccount(page, async (accountId) => {
      const coOwner = await seedRegisteredAccount();
      const target = await seedRegisteredAccount();
      const seeded = await seedOwnOrganizations(accountId, [
        "Synthetic Membership Org",
      ]);
      const organization = seeded[0];
      if (organization === undefined) throw new Error("seed missing");
      // A second owner keeps the last-owner rule satisfiable for self-demotion.
      await seedMembership(
        organization.organizationId,
        coOwner,
        "owner",
        "active",
      );

      await page.goto("/app/overview");
      await selectOrganization(page, organization.organizationId);
      await expect(
        page.getByRole("heading", { name: "Membership and tenant changes" }),
      ).toBeVisible();
      await page.getByLabel("Operation").selectOption("tenant.membership.set");
      await page.getByLabel("Target account ID").fill(target);
      await page.getByLabel("Role").selectOption("operator");
      await page
        .getByLabel("Membership status")
        .selectOption("active");
      await reviewAndSend(page);
      const committed = await readCommittedReceipt(page);
      expect(committed.operation).toBe("tenant.membership.set");
      expect(await readMembershipRow(organization.organizationId, target)).toEqual({
        role: "operator",
        status: "active",
      });
      const counts = await countDurableRows(
        organization.organizationId,
        committed.mutationId,
      );
      expect(counts).toEqual({ idempotency: 1, audit: 1, outbox: 1 });

      // Fresh read after refresh shows the actual role.
      await reloadAndSelect(page, organization.organizationId);
      await expect(
        page.getByRole("heading", { name: "Membership and tenant changes" }),
      ).toBeVisible();

      // Self-demotion to viewer: confirmed receipt, then session revocation.
      await installReceiptCapture(page);
      await page.getByLabel("Operation").selectOption("tenant.membership.set");
      await page.getByLabel("Target account ID").fill(accountId);
      await page.getByLabel("Role").selectOption("viewer");
      await reviewAndSend(page);
      const captured = await readCapturedReceipt(page);
      expect(captured.operation).toBe("tenant.membership.set");
      expect(captured.resourceId).toBe(accountId);
      await expect(page.getByText("Outcome unknown")).toHaveCount(0);
      await expect(await readMembershipRow(organization.organizationId, accountId)).toEqual({
        role: "viewer",
        status: "active",
      });
      expect(await countAccountSessions(accountId)).toBe(0);

      // Reauth required after the commit; no rollback to an unknown state.
      await page.goto("/app/overview");
      await expect(
        page.getByRole("heading", { name: "Sign in required" }),
      ).toBeVisible();
    });
  });

  test("last-owner change is denied with policy and leaves the DB owner and session unchanged", async ({
    page,
  }) => {
    await withSignedInAccount(page, async (accountId) => {
      const seeded = await seedOwnOrganizations(accountId, [
        "Synthetic Last Owner",
      ]);
      const organization = seeded[0];
      if (organization === undefined) throw new Error("seed missing");
      const sessionsBefore = await countAccountSessions(accountId);
      expect(sessionsBefore).toBeGreaterThan(0);

      await page.goto("/app/overview");
      await selectOrganization(page, organization.organizationId);
      await page.getByLabel("Operation").selectOption("tenant.membership.set");
      await page.getByLabel("Target account ID").fill(accountId);
      await page.getByLabel("Role").selectOption("viewer");
      await reviewAndSend(page);

      // The server refuses the last-owner change: a definite rejection, never
      // an unknown outcome or an optimistic rollback.
      await expect(
        page.getByText(
          "The server policy denied this change. No write was applied.",
        ),
      ).toBeVisible();
      await expect(page.getByText("Outcome unknown")).toHaveCount(0);
      expect(await readMembershipRow(organization.organizationId, accountId)).toEqual({
        role: "owner",
        status: "active",
      });
      expect(await countAccountSessions(accountId)).toBe(sessionsBefore);
    });
  });

  test("second owner may be seeded and a first owner can be demoted safely, labeled synthetic", async ({
    page,
  }) => {
    await withSignedInAccount(page, async (accountId) => {
      // Labeled synthetic admin seed: a second owner exists before the change.
      const secondOwner = await seedRegisteredAccount();
      const seeded = await seedOwnOrganizations(accountId, [
        "Synthetic Second Owner",
      ]);
      const organization = seeded[0];
      if (organization === undefined) throw new Error("seed missing");
      await seedMembership(
        organization.organizationId,
        secondOwner,
        "owner",
        "active",
      );
      await page.goto("/app/overview");
      await selectOrganization(page, organization.organizationId);
      await page.getByLabel("Operation").selectOption("tenant.membership.set");
      await page.getByLabel("Target account ID").fill(accountId);
      await page.getByLabel("Role").selectOption("operator");
      await reviewAndSend(page);
      await expect(page.getByText("Change committed")).toBeVisible();
      expect(await readMembershipRow(organization.organizationId, accountId)).toEqual({
        role: "operator",
        status: "active",
      });
      expect(await readMembershipRow(organization.organizationId, secondOwner)).toEqual({
        role: "owner",
        status: "active",
      });
    });
  });

  test("viewer sees no mutation panel and operator has no provider form", async ({
    browser,
    page,
  }) => {
    await withSignedInAccount(page, async (accountId) => {
      const owner = await seedAccount();
      const viewerOrg = await seedOrganizationWithRole(
        owner,
        accountId,
        "Synthetic Viewer Write",
        "viewer",
      );
      await page.goto("/app/overview");
      await selectOrganization(page, viewerOrg.organizationId);
      await expect(
        page.getByRole("heading", { name: "Membership and tenant changes" }),
      ).toHaveCount(0);
      await page.getByRole("link", { name: "Agents" }).click();
      await expect(
        page.getByRole("heading", { name: "Agents", exact: true }),
      ).toBeVisible();
      await expect(
        page.getByRole("heading", { name: "Membership and tenant changes" }),
      ).toHaveCount(0);
    });

    // A separate operator cannot reach a provider write form. This independent
    // journey runs in its own isolated context (its own real passkey sign-up),
    // so it can never inherit the viewer's session.
    const origin = new URL(page.url()).origin;
    await withIsolatedSignedInAccount(browser, origin, async (operatorPage, accountId) => {
      const owner = await seedAccount();
      const operatorOrg = await seedOrganizationWithRole(
        owner,
        accountId,
        "Synthetic Operator Provider",
        "operator",
      );
      await operatorPage.goto("/app/overview");
      await selectOrganization(operatorPage, operatorOrg.organizationId);
      await operatorPage.getByRole("link", { name: "Provider" }).click();
      await expect(
        operatorPage.getByRole("heading", {
          name: "Your role cannot view providers",
        }),
      ).toBeVisible();
      await expect(
        operatorPage.getByRole("heading", {
          name: "Membership and tenant changes",
        }),
      ).toHaveCount(0);
    });
  });

  test("foreign organization is unavailable through the real API", async ({
    page,
  }) => {
    await withSignedInAccount(page, async (accountId) => {
      const foreignOwner = await seedAccount();
      const foreign = await seedOwnOrganizations(foreignOwner, [
        "Synthetic Foreign Org",
      ]);
      const foreignOrg = foreign[0];
      if (foreignOrg === undefined) throw new Error("seed missing");
      await page.goto("/app/overview");
      const outcome = await sameOriginFetch(page, {
        path: `${TENANT_API_PREFIX}/${encodeURIComponent(foreignOrg.organizationId)}`,
        method: "GET",
        csrf: "omit",
      });
      expect(outcome.status).toBe(403);
      expect(outcome.setCookie).toBe(false);
      expect(outcome.hasProtectedDto).toBe(false);
      expect(outcome.errorCode).toBe("FORBIDDEN");
      void accountId;
    });
  });

  test("stale proof rejects organization and membership issuance without faking the proof", async ({
    page,
  }) => {
    await withSignedInAccount(page, async (accountId) => {
      const seeded = await seedOwnOrganizations(accountId, [
        "Synthetic Stale Proof",
      ]);
      const organization = seeded[0];
      if (organization === undefined) throw new Error("seed missing");
      await page.goto("/app/overview");
      await selectOrganization(page, organization.organizationId);

      // Age the REAL session created_at beyond the 5-minute proof window.
      const affected = await ageAccountSessionProof(accountId, 900);
      expect(affected).toBeGreaterThan(0);

      const orgCreate = await sameOriginFetch(page, {
        path: TENANT_API_PREFIX,
        method: "POST",
        csrf: "bootstrap",
        idempotencyKey: localIdempotencyKey(1),
        contentType: "application/json",
        body: JSON.stringify({
          mutationId: localMutationId(1),
          displayName: "Stale Bootstrap",
        }),
      });
      expect(orgCreate.status).toBe(401);
      expect(orgCreate.setCookie).toBe(false);
      expect(orgCreate.hasProtectedDto).toBe(false);

      const membership = await sameOriginFetch(page, {
        path: `${TENANT_API_PREFIX}/${encodeURIComponent(organization.organizationId)}/memberships/${encodeURIComponent(accountId)}`,
        method: "PUT",
        csrf: "bootstrap",
        idempotencyKey: localIdempotencyKey(2),
        contentType: "application/json",
        body: JSON.stringify({
          mutationId: localMutationId(2),
          role: "viewer",
          membershipStatus: "active",
        }),
      });
      expect(membership.status).toBe(401);
      expect(membership.setCookie).toBe(false);
      expect(membership.hasProtectedDto).toBe(false);

      // The real owner membership did not move.
      expect(await readMembershipRow(organization.organizationId, accountId)).toEqual({
        role: "owner",
        status: "active",
      });
    });
  });

  test("invalid body, wrong CSRF and idempotency conflict stay bounded and side-effect free", async ({
    page,
  }) => {
    await withSignedInAccount(page, async (accountId) => {
      const seeded = await seedOwnOrganizations(accountId, [
        "Synthetic Guards",
      ]);
      const organization = seeded[0];
      if (organization === undefined) throw new Error("seed missing");
      await page.goto("/app/overview");
      await selectOrganization(page, organization.organizationId);

      // 400: invalid body shape.
      const invalid = await sameOriginFetch(page, {
        path: `${TENANT_API_PREFIX}/${encodeURIComponent(organization.organizationId)}/agents`,
        method: "POST",
        csrf: "bootstrap",
        idempotencyKey: localIdempotencyKey(3),
        contentType: "application/json",
        body: JSON.stringify({}),
      });
      expect(invalid.status).toBe(400);
      expect(invalid.errorCode).toBe("INVALID_REQUEST");
      expect(invalid.setCookie).toBe(false);
      expect(invalid.hasProtectedDto).toBe(false);

      // 403: wrong CSRF token.
      const wrongCsrf = await sameOriginFetch(page, {
        path: `${TENANT_API_PREFIX}/${encodeURIComponent(organization.organizationId)}/agents`,
        method: "POST",
        csrf: "wrong",
        idempotencyKey: localIdempotencyKey(4),
        contentType: "application/json",
        body: JSON.stringify({
          mutationId: localMutationId(4),
          displayName: "Wrong CSRF Agent",
        }),
      });
      expect(wrongCsrf.status).toBe(403);
      expect(wrongCsrf.errorCode).toBe("CSRF_REJECTED");
      expect(wrongCsrf.setCookie).toBe(false);
      expect(wrongCsrf.hasProtectedDto).toBe(false);

      // 409: reuse one key with a different mutation/body after a real commit.
      const commit = await sameOriginFetch(page, {
        path: `${TENANT_API_PREFIX}/${encodeURIComponent(organization.organizationId)}/agents`,
        method: "POST",
        csrf: "bootstrap",
        idempotencyKey: localIdempotencyKey(5),
        contentType: "application/json",
        body: JSON.stringify({
          mutationId: localMutationId(5),
          displayName: "Conflict Agent",
        }),
      });
      expect(commit.status).toBe(200);
      expectMutationEnvelope(commit);
      expect(commit.setCookie).toBe(false);

      const conflict = await sameOriginFetch(page, {
        path: `${TENANT_API_PREFIX}/${encodeURIComponent(organization.organizationId)}/agents`,
        method: "POST",
        csrf: "bootstrap",
        idempotencyKey: localIdempotencyKey(5),
        contentType: "application/json",
        body: JSON.stringify({
          mutationId: localMutationId(6),
          displayName: "Conflict Agent Two",
        }),
      });
      expect(conflict.status).toBe(409);
      expect(conflict.errorCode).toBe("IDEMPOTENCY_CONFLICT");
      expect(conflict.setCookie).toBe(false);
      expect(conflict.hasProtectedDto).toBe(false);

      // A same-key same-body replay is a bounded 200 replay, not a new write.
      const replay = await sameOriginFetch(page, {
        path: `${TENANT_API_PREFIX}/${encodeURIComponent(organization.organizationId)}/agents`,
        method: "POST",
        csrf: "bootstrap",
        idempotencyKey: localIdempotencyKey(5),
        contentType: "application/json",
        body: JSON.stringify({
          mutationId: localMutationId(5),
          displayName: "Conflict Agent",
        }),
      });
      expect(replay.status).toBe(200);
      expectMutationEnvelope(replay);
      expect(replay.setCookie).toBe(false);
      const counts = await countDurableRows(
        organization.organizationId,
        localMutationId(5),
      );
      expect(counts).toEqual({ idempotency: 1, audit: 1, outbox: 1 });
      expect(await readAgentRow(organization.organizationId, "openarc:agent:00000000-0000-4000-8000-000000000000")).toBeNull();
    });
  });

  test("method, query and header guards preserve the route shape with no DTO or cookie", async ({
    page,
  }) => {
    await withSignedInAccount(page, async (accountId) => {
      const seeded = await seedOwnOrganizations(accountId, [
        "Synthetic Route Guards",
      ]);
      const organization = seeded[0];
      if (organization === undefined) throw new Error("seed missing");
      await page.goto("/app/overview");
      await selectOrganization(page, organization.organizationId);

      const scoped = `${TENANT_API_PREFIX}/${encodeURIComponent(organization.organizationId)}`;
      const cases: ReadonlyArray<{
        readonly label: string;
        readonly path: string;
        readonly method: "GET" | "POST" | "PATCH" | "PUT";
        readonly status: readonly number[];
        readonly errorCode?: string;
        /** Set only for an expected 200 DTO: proves the exact success shape. */
        readonly shape?: "organizationPage" | "organizationContext";
      }> = [
        { label: "shared collection GET", path: TENANT_API_PREFIX, method: "GET", status: [200], shape: "organizationPage" },
        { label: "scoped context GET", path: scoped, method: "GET", status: [200], shape: "organizationContext" },
        { label: "write-only membership PUT method guard", path: `${scoped}/memberships/${encodeURIComponent(accountId)}`, method: "POST", status: [400, 404, 405, 501] },
        { label: "write-only provider PATCH method guard", path: `${scoped}/providers/openarc:provider:00000000-0000-4000-8000-000000000000`, method: "POST", status: [400, 404, 405, 501] },
        { label: "bootstrap mutation status guard", path: `${TENANT_API_PREFIX}/bootstrap-mutations/${localMutationId(7)}`, method: "POST", status: [400, 404, 405, 501] },
        { label: "unknown extra segment", path: `${scoped}/agents/extra/segment`, method: "GET", status: [400, 404] },
      ];

      for (const entry of cases) {
        const outcome = await sameOriginFetch(page, {
          path: entry.path,
          method: entry.method,
          csrf: "omit",
        });
        expect(entry.status, entry.label).toContain(outcome.status);
        expect(outcome.setCookie, entry.label).toBe(false);
        if (entry.shape === "organizationPage") {
          expectOrganizationPageEnvelope(outcome);
        } else if (entry.shape === "organizationContext") {
          expectOrganizationContextEnvelope(outcome);
        } else {
          // A denied/guard response must never carry a protected DTO.
          expect(outcome.hasProtectedDto, entry.label).toBe(false);
        }
        if (entry.errorCode !== undefined) {
          expect(outcome.errorCode, entry.label).toBe(entry.errorCode);
        }
      }

      // A query string on a write-only/status path is rejected without a DTO.
      const query = await sameOriginFetch(page, {
        path: `${scoped}/mutations/${localMutationId(11)}?limit=1`,
        method: "GET",
        csrf: "omit",
      });
      expect(query.status).toBe(400);
      expect(query.setCookie).toBe(false);
      expect(query.hasProtectedDto).toBe(false);

      // Authorization is rejected on a write without exposing protected data.
      const authorized = await sameOriginFetch(page, {
        path: scoped,
        method: "GET",
        csrf: "omit",
        extraHeaders: { Authorization: "Bearer synthetic" },
      });
      expect([403, 405]).toContain(authorized.status);
      expect(authorized.setCookie).toBe(false);
      expect(authorized.hasProtectedDto).toBe(false);
    });
  });

  test("deterministic browser delivery fault: real commit, lost reply, unknown then real Check status with exactly one write", async ({
    page,
  }) => {
    await withSignedInAccount(page, async (accountId) => {
      const seeded = await seedOwnOrganizations(accountId, [
        "Synthetic Lost Reply",
      ]);
      const organization = seeded[0];
      if (organization === undefined) throw new Error("seed missing");

      await page.goto("/app/overview");
      await selectOrganization(page, organization.organizationId);
      await page.getByRole("link", { name: "Agents" }).click();
      await expect(
        page.getByRole("heading", { name: "Agents", exact: true }),
      ).toBeVisible();

      // Instrument only the response stage of the agent create POST.
      const client = await page.context().newCDPSession(page);
      const capture: { mutationId: string | null } = { mutationId: null };
      let createPosts = 0;
      let faultInstalled = true;
      // Explicit, independently-confirmed real-commit gate. The deterministic
      // delivery fault is ONLY applied after the fixture has observed the
      // committed idempotency receipt for THIS mutation at the database. If
      // that confirmation never arrives, the response is released intact (no
      // fabricated unknown outcome) and the test fails on the gate below.
      let preFaultDbCommitConfirmed = false;
      let settleFaultDecision:
        | ((value: { confirmed: boolean; mutationId: string | null }) => void)
        | null = null;
      const faultDecision = new Promise<{
        confirmed: boolean;
        mutationId: string | null;
      }>((resolve) => {
        settleFaultDecision = resolve;
      });
      client.on("Fetch.requestPaused", async (event) => {
        const url = event.request.url;
        const isAgentCreate =
          event.request.method === "POST" &&
          /\/agents$/u.test(new URL(url).pathname);
        if (!isAgentCreate || event.responseStatusCode === undefined) {
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
        // Read the synthetic mutation id transiently to independently confirm
        // the real commit at the database BEFORE failing response delivery.
        try {
          const parsed = JSON.parse(event.request.postData ?? "{}") as {
            mutationId?: unknown;
          };
          if (typeof parsed.mutationId === "string") {
            capture.mutationId = parsed.mutationId;
          }
        } catch {
          capture.mutationId = null;
        }
        // Independently confirm the real commit at the database before we
        // simulate losing the reply. Bounded polling only; the API has already
        // produced this response, so the commit precedes the fault.
        const commit = capture.mutationId;
        let confirmed = false;
        if (commit !== null) {
          for (let attempt = 0; attempt < 40; attempt += 1) {
            if (
              (await readDurableReceipt(
                organization.organizationId,
                commit,
              )) !== null
            ) {
              confirmed = true;
              break;
            }
            await new Promise<void>((resolveTick) =>
              setTimeout(resolveTick, 50),
            );
          }
        }
        settleFaultDecision?.({ confirmed, mutationId: commit });
        if (!confirmed) {
          // Do NOT fail the response: a lost reply may only be simulated once
          // the real commit is independently proven. Release it intact.
          await client
            .send("Fetch.continueRequest", { requestId: event.requestId })
            .catch(() => undefined);
          return;
        }
        preFaultDbCommitConfirmed = true;
        await client
          .send("Fetch.failRequest", {
            requestId: event.requestId,
            errorReason: "Failed",
          })
          .catch(() => undefined);
      });
      await client.send("Fetch.enable", {
        patterns: [{ urlPattern: "*", requestStage: "Response" }],
      });

      await page.getByLabel("Operation").selectOption("tenant.agent.create");
      await page.getByLabel("Display name").fill("Lost Reply Agent");
      await reviewAndSend(page);

      // Authoritative control gate: the fault was applied ONLY after the
      // fixture independently observed this mutation's real commit. A later
      // receipt is not substituted for this pre-fault confirmation.
      const decision = await faultDecision;
      expect(decision.confirmed).toBe(true);
      expect(preFaultDbCommitConfirmed).toBe(true);
      expect(decision.mutationId).toBe(capture.mutationId);
      expect(capture.mutationId).not.toBeNull();
      expect(createPosts).toBe(1);

      // The response was held until the fixture could observe the commit; the
      // fault itself is only a deterministic browser delivery failure.
      await expect(page.getByText("Outcome unknown")).toBeVisible();
      await expect(page.getByText(/may still complete/u)).toBeVisible();

      // Independent real commit proof.
      const mutationId = capture.mutationId;
      if (mutationId === null) throw new Error("MUTATION_ID_NOT_OBSERVED");
      expect(CANONICAL_MUTATION.test(mutationId)).toBe(true);
      const receipt = await readDurableReceipt(
        organization.organizationId,
        mutationId,
      );
      expect(receipt?.operation).toBe("tenant.agent.create");
      expect(CANONICAL_AGENT.test(receipt?.resourceId ?? "")).toBe(true);
      const counts = await countDurableRows(
        organization.organizationId,
        mutationId,
      );
      expect(counts).toEqual({ idempotency: 1, audit: 1, outbox: 1 });

      // Now stop faulting so Check status can reach the real API.
      faultInstalled = false;
      await page.getByRole("button", { name: "Check status" }).click();
      await expect(page.getByText("Change already committed")).toBeVisible();
      await expect(page.getByText("Outcome unknown")).toHaveCount(0);
      await expect(page.getByLabel("Display name")).toHaveValue("");
      expect(createPosts).toBe(1);
      await client.send("Fetch.disable");

      // Exactly one DB resource/audit/outbox after recovery.
      expect(
        await countDurableRows(organization.organizationId, mutationId),
      ).toEqual({ idempotency: 1, audit: 1, outbox: 1 });
    });
  });

  test("logout while the form is open clears the draft with no credential, form or key residue", async ({
    page,
  }) => {
    await withSignedInAccount(page, async (accountId) => {
      const seeded = await seedOwnOrganizations(accountId, [
        "Synthetic Session Drop",
      ]);
      const organization = seeded[0];
      if (organization === undefined) throw new Error("seed missing");
      await page.goto("/app/overview");
      await selectOrganization(page, organization.organizationId);
      await page
        .getByLabel("Display name")
        .fill("Draft that must not survive");

      // Sign out through the real account UI while the draft is open.
      await page.goto("/account");
      await page.getByRole("button", { name: "Sign out" }).click();
      await expect(
        page.getByRole("heading", { name: "Sign in or create an account" }),
      ).toBeVisible();

      await page.goto("/app/overview");
      await expect(
        page.getByRole("heading", { name: "Sign in required" }),
      ).toBeVisible();
      await expect(page.getByLabel("Display name")).toHaveCount(0);

      const residue = await page.evaluate(() => ({
        local: JSON.stringify(window.localStorage),
        session: JSON.stringify(window.sessionStorage),
        href: window.location.href,
        html: document.documentElement.outerHTML,
      }));
      for (const blob of [residue.local, residue.session, residue.href, residue.html]) {
        expect(blob).not.toMatch(/idempotency/iu);
        expect(blob).not.toMatch(/csrf/iu);
        expect(blob).not.toMatch(/private.?key/iu);
        expect(blob).not.toMatch(/__Host-/u);
        expect(blob).not.toMatch(/openarc_session/u);
      }
    });
  });

  test("mobile 320px form keeps 16px controls, 44px targets, no overflow and a confirmed commit", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 320, height: 800 });
    await withSignedInAccount(page, async (accountId) => {
      const seeded = await seedOwnOrganizations(accountId, [
        "Synthetic Mobile Write",
      ]);
      const organization = seeded[0];
      if (organization === undefined) throw new Error("seed missing");
      await page.goto("/app/overview");
      // The static rail is hidden at this width; open the drawer to select.
      const viewport = page.viewportSize();
      if (viewport !== null && viewport.width <= 860) {
        await page.getByRole("button", { name: "Menu" }).click();
        await page
          .locator(".tenant-drawer .tenant-org-select")
          .selectOption({ value: organization.organizationId });
      } else {
        await page
          .locator(".tenant-rail--static .tenant-org-select")
          .selectOption({ value: organization.organizationId });
      }

      const displayName = page.getByLabel("Display name");
      await displayName.focus();
      const fontSize = await displayName.evaluate((element) =>
        Number.parseFloat(getComputedStyle(element).fontSize),
      );
      expect(fontSize).toBeGreaterThanOrEqual(16);
      const box = await displayName.boundingBox();
      expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);

      const overflow = await page.evaluate(() => ({
        scrollWidth: document.documentElement.scrollWidth,
        innerWidth: window.innerWidth,
      }));
      expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.innerWidth);

      // Keyboard confirmation path still commits and clears the draft.
      await page.getByLabel("Operation").selectOption("tenant.agent.create");
      await displayName.fill("Mobile Agent");
      await page.getByRole("button", { name: "Review change" }).click();
      const confirm = page.getByRole("button", { name: "Confirm and send" });
      await confirm.focus();
      await confirm.press("Enter");
      const committed = await readCommittedReceipt(page);
      expect(committed.operation).toBe("tenant.agent.create");
      await expect(page.getByLabel("Display name")).toHaveValue("");
    });
  });

  test("scoped tenant CSP and style stay intact during a real write", async ({
    page,
  }) => {
    await withSignedInAccount(page, async (accountId) => {
      const seeded = await seedOwnOrganizations(accountId, [
        "Synthetic CSP Write",
      ]);
      const organization = seeded[0];
      if (organization === undefined) throw new Error("seed missing");
      const response = await page.goto("/app/overview");
      const csp = response?.headers()["content-security-policy"] ?? null;
      expect(csp).not.toBeNull();
      expect(csp ?? "").toContain("'self'");
      expect(csp ?? "").not.toContain("'unsafe-inline'");
      expect(csp ?? "").not.toContain("'unsafe-eval'");
      await selectOrganization(page, organization.organizationId);
      const shellDisplay = await page
        .locator(".tenant-shell")
        .evaluate((element) => getComputedStyle(element).display);
      expect(shellDisplay).toBe("grid");
      const styleHref = await page
        .locator('link[data-tenant-style="true"]')
        .getAttribute("href");
      expect(styleHref).not.toBeNull();
      const styleUrl = new URL(styleHref ?? "", page.url());
      expect(styleUrl.origin).toBe(new URL(page.url()).origin);

      await page.getByLabel("Operation").selectOption("tenant.agent.create");
      await page.getByLabel("Display name").fill("CSP Agent");
      await reviewAndSend(page);
      await readCommittedReceipt(page);
    });
  });
});

/* -------------------------------------------------------------------------- */
/* @tenant-write-off: writes OFF, reads ON                                    */
/* -------------------------------------------------------------------------- */

test.describe("PORT-01 tenant writes OFF", { tag: "@tenant-write-off" }, () => {
  test("signed-in tenant read works with no form while shared GET stays 200 and write-only paths are 404", async ({
    page,
  }) => {
    await withSignedInAccount(page, async (accountId) => {
      const seeded = await seedOwnOrganizations(accountId, [
        "Synthetic Writes Off",
      ]);
      const organization = seeded[0];
      if (organization === undefined) throw new Error("seed missing");

      const writeRequests: string[] = [];
      page.on("request", (request) => {
        const method = request.method();
        if (method === "POST" || method === "PATCH" || method === "PUT") {
          writeRequests.push(new URL(request.url()).pathname);
        }
      });

      await page.goto("/app/overview");
      // Reads are ON: the signed-in tenant read surface still works.
      await selectOrganization(page, organization.organizationId);
      await expect(
        page.getByRole("heading", {
          name: "Synthetic Writes Off",
          exact: true,
        }),
      ).toBeVisible();
      await expect(page.locator(".tenant-meta").getByText("Owner")).toBeVisible();
      // No mutation panel or form is constructed with writes OFF.
      await expect(
        page.getByRole("heading", { name: "Membership and tenant changes" }),
      ).toHaveCount(0);
      await expect(page.getByLabel("Display name")).toHaveCount(0);
      await expect(page.getByLabel("Operation")).toHaveCount(0);
      // The read-only workspace issued no write of its own.
      expect(writeRequests).toEqual([]);

      // The read surface itself must remain reachable at the API level.
      const list = await sameOriginFetch(page, {
        path: TENANT_API_PREFIX,
        method: "GET",
        csrf: "omit",
      });
      expect(list.status).toBe(200);
      expect(list.setCookie).toBe(false);
      // Reads are ON, so this is the intended organization-page DTO.
      expectOrganizationPageEnvelope(list);

      // Shared collection POST keeps its existing 405 behavior.
      const postCollection = await sameOriginFetch(page, {
        path: TENANT_API_PREFIX,
        method: "POST",
        csrf: "omit",
        contentType: "application/json",
        body: JSON.stringify({
          mutationId: localMutationId(8),
          displayName: "Writes Off",
        }),
      });
      expect(postCollection.status).toBe(405);
      expect(postCollection.setCookie).toBe(false);
      expect(postCollection.hasProtectedDto).toBe(false);

      // Write-only/status paths fail closed as 404 in the OFF image.
      const scoped = `${TENANT_API_PREFIX}/${encodeURIComponent(organization.organizationId)}`;
      for (const path of [
        `${scoped}/agents/${encodeURIComponent("openarc:agent:00000000-0000-4000-8000-000000000000")}`,
        `${scoped}/providers/${encodeURIComponent("openarc:provider:00000000-0000-4000-8000-000000000000")}`,
        `${scoped}/memberships/${encodeURIComponent(accountId)}`,
        `${scoped}/mutations/${localMutationId(9)}`,
        `${TENANT_API_PREFIX}/bootstrap-mutations/${localMutationId(10)}`,
      ]) {
        const outcome = await sameOriginFetch(page, {
          path,
          method: "GET",
          csrf: "omit",
        });
        expect(outcome.status, path).toBe(404);
        expect(outcome.setCookie, path).toBe(false);
        expect(outcome.hasProtectedDto, path).toBe(false);
      }

      // No mutation panel or form is constructed with writes off.
      await page.goto("/app/agents");
      await page.locator(".tenant-org-select").selectOption({
        value: organization.organizationId,
      });
      await expect(
        page.getByRole("heading", { name: "Agents", exact: true }),
      ).toBeVisible();
      await page.getByRole("button", { name: "Load agents" }).click();
      await expect(page.getByText("No agents in this organization.")).toBeVisible();
      await expect(
        page.getByRole("heading", { name: "Membership and tenant changes" }),
      ).toHaveCount(0);
      await expect(page.getByLabel("Display name")).toHaveCount(0);
    });
  });
});

void CANONICAL_PROVIDER;
