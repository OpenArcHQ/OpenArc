import { readFileSync } from "node:fs";
import { request as httpsRequest } from "node:https";

import {
  expect,
  test,
  type Browser,
  type CDPSession,
  type Page,
} from "@playwright/test";

import {
  ageAccountSessionProof,
  countMachineMutationRows,
  countMachineRows,
  convertAccountSessionToRecovery,
  expireMachineCredential,
  readDurableReceipt,
  readMachineCredentialRow,
  seedAccount,
  seedAgents,
  seedMachineCredential,
  seedOrganizationWithRole,
  seedOwnOrganizations,
  seedProviders,
} from "./fixture-db.js";

// Canonical strict machine wire schemas are imported through the
// workspace-relative shared source entry. The fixture MUST NOT maintain a
// second handwritten DTO mirror: every machine envelope is validated by the
// exact accepted Zod contracts before any safe projection is formed. These
// schemas are pure data contracts; importing them performs no I/O.
import { CommerceApiErrorEnvelopeSchema } from "../packages/shared/src/commerce/api.js";
import {
  CommerceMachineSessionExchangeResponseSchema,
  CommerceMachineSessionSelfResponseSchema,
  CommerceMachineSessionRevokeResponseSchema,
  type CommerceMachineSessionMetadata,
} from "../packages/shared/src/commerce/machine.js";

/**
 * PORT-01 actual production MACHINE credential acceptance.
 *
 * Every journey targets the REAL API + PostgreSQL + production nginx through
 * the lead-provisioned loopback origin (browser) and the fixed loopback
 * 127.0.0.1:9443 machine endpoint inside the SAME disposable namespace
 * (Node HTTPS). There is no route interception for the positive journeys, no
 * HTTP mock, no session-cookie injection and no test-only app endpoint. Human
 * accounts are created through the real passkey sign-up UI; only synthetic
 * machine data is seeded server-side by the guarded node fixture. The single
 * deterministic browser delivery fault (unknown outcome) is a CDP Fetch
 * response-stage failure applied AFTER the real API has processed the write
 * and the fixture has independently confirmed the commit.
 */

const MACHINE_PANEL_TITLE = {
  agent: "Agent credential",
  provider: "Provider credential",
} as const;

const ACCOUNT_ID_TESTID = "account-id";

const CANONICAL_ACCOUNT =
  /^openarc:account:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const CANONICAL_MUTATION =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const CANONICAL_CREDENTIAL_TOKEN =
  /^oac_(?:ag|pr)_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}_[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/u;
const CANONICAL_SESSION_TOKEN =
  /^oas_(?:ag|pr)_[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/u;

const TENANT_API_PREFIX = "/v1/operator/organizations";

const MACHINE_ENABLED_ORIGIN = "https://account.openarc.test:5445";
const MACHINE_NODE_HOST = "127.0.0.1";
const MACHINE_NODE_PORT = 9443;
const MACHINE_NODE_SERVERNAME = "account.openarc.test";
const MACHINE_CA_PATH = "/tmp/openarc-machine-fixture.crt";

/* -------------------------------------------------------------------------- */
/* Real passkey UI sign-up (reused pattern from the accepted write fixture)   */
/* -------------------------------------------------------------------------- */

interface VirtualAuthenticator {
  readonly client: CDPSession;
  readonly id: string;
}

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
  const accountIdElement = page.getByTestId(ACCOUNT_ID_TESTID);
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
 * Chromium host-resolver rule is a browser-level launch flag (see the
 * production config), so this context resolves the same reserved loopback
 * hostname; only the HTTPS fixture exemption and base URL are copied. No cookie
 * is read, injected or serialized.
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

async function selectOrganization(page: Page, organizationId: string): Promise<void> {
  await page.locator(".tenant-org-select").selectOption({ value: organizationId });
  await expect(page.locator(".tenant-org-select").first()).toHaveValue(organizationId);
}

async function openAgents(page: Page, organizationId: string): Promise<void> {
  await page.goto("/app/agents");
  await selectOrganization(page, organizationId);
  await expect(page.getByRole("heading", { name: "Agents", exact: true })).toBeVisible();
  // Selecting an organization resets the profile list to `none`; the real UI
  // requires ONE explicit visible "Load agents" control before any profile row
  // exists. Without it the profile table is never rendered. This is a fixture
  // selector gap, not a product defect.
  const load = page.getByRole("button", { name: "Load agents" });
  if ((await load.count()) > 0) {
    await load.click();
  }
  await expect(page.locator(".tenant-table tbody tr").first()).toBeVisible();
}

async function openProvider(page: Page, organizationId: string): Promise<void> {
  await page.goto("/app/provider");
  await selectOrganization(page, organizationId);
  await expect(page.getByRole("heading", { name: "Provider", exact: true })).toBeVisible();
  // Same explicit "Load providers" control as agents (see `openAgents`).
  const load = page.getByRole("button", { name: "Load providers" });
  if ((await load.count()) > 0) {
    await load.click();
  }
  await expect(page.locator(".tenant-table tbody tr").first()).toBeVisible();
}

/** Explicitly bind the machine panel to one seeded profile. */
async function selectProfile(page: Page, profileId: string): Promise<void> {
  const row = page.getByRole("row").filter({ hasText: profileId });
  await expect(row).toBeVisible();
  await row.getByRole("button", { name: "Manage credentials" }).click();
  await expect(page.getByRole("button", { name: "Close credentials" })).toBeVisible();
}

async function expectMachinePanel(page: Page, kind: "agent" | "provider"): Promise<void> {
  await expect(
    page.getByRole("heading", { name: MACHINE_PANEL_TITLE[kind], exact: true }),
  ).toBeVisible();
}

async function loadCredentials(page: Page): Promise<void> {
  // The list starts in `none` and the real panel renders a visible "Load
  // credentials" control only then. The panel mounts asynchronously after the
  // profile selection, so a bare `count()` can race the mount and silently skip
  // the load. Wait (bounded) for EITHER the explicit control OR an already-ready
  // list, then click the control exactly once and wait until `none`/`loading`
  // is gone. This is a fixture wait for the real UI state machine.
  const load = page.getByRole("button", { name: "Load credentials" });
  const readyEmpty = page.getByText("No credentials for this profile.");
  const list = page.locator(".machine-credential-list");
  await expect
    .poll(
      async () =>
        (await load.count()) + (await readyEmpty.count()) + (await list.count()),
      { message: "credential list reached a demonstrable state" },
    )
    .toBeGreaterThan(0);
  if ((await load.count()) > 0) {
    await load.click();
    await expect(load).toHaveCount(0);
  }
}

/** Open the explicit profile credential panel and load its bounded list. */
async function openMachineConsole(
  page: Page,
  kind: "agent" | "provider",
  profileId: string,
): Promise<void> {
  await selectProfile(page, profileId);
  await expectMachinePanel(page, kind);
  await loadCredentials(page);
}

/** Visible two-step review/confirm issue flow. */
async function reviewIssue(page: Page, expiryDays = 7): Promise<void> {
  await page.getByLabel("Expires in").selectOption(String(expiryDays));
  await page.getByRole("button", { name: "Review issue" }).click();
  await expect(page.getByText("Confirm this credential action")).toBeVisible();
  await page.getByRole("button", { name: "Confirm", exact: true }).click();
}

interface CommittedCredential {
  readonly credentialId: string;
  readonly mutationId: string;
  readonly operation: string;
}

/**
 * Reads the committed receipt metadata from the visible panel. The one-time raw
 * credential is only ever read transiently by `captureRawOnce`; it is never
 * persisted or logged.
 */
async function readCommittedCredential(page: Page): Promise<CommittedCredential> {
  await expect(page.getByText("Credential action committed")).toBeVisible({
    timeout: 20_000,
  });
  const receipt = page.locator(".tenant-receipt");
  await expect(receipt).toBeVisible();
  const dds = receipt.locator("dl.tenant-meta dd");
  const operation = (await dds.nth(0).innerText()).trim();
  const credentialId = (await dds.nth(1).innerText()).trim();
  const mutationId = (await dds.nth(2).innerText()).trim();
  expect(operation).toMatch(/^tenant\.(?:agent|provider)\.credential\.(?:issue|revoke)$/u);
  expect(CANONICAL_MUTATION.test(credentialId)).toBe(true);
  return { credentialId, mutationId, operation };
}

/**
 * Transiently reads the one-time raw credential exactly once. The value is
 * returned to the caller only; it is not written anywhere, and the caller MUST
 * NOT persist, print or embed it in a URL/storage.
 */
async function captureRawOnce(page: Page): Promise<string> {
  const secret = page.locator("#machine-secret-value");
  await expect(secret).toBeVisible();
  const raw = (await secret.inputValue()).trim();
  expect(CANONICAL_CREDENTIAL_TOKEN.test(raw)).toBe(true);
  return raw;
}

async function dismissCredential(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Dismiss" }).click();
  await expect(page.locator("#machine-secret-value")).toHaveCount(0);
}

/** Revokes the first active credential through the explicit UI confirm. */
async function revokeFirstCredential(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Revoke", exact: true }).first().click();
  await expect(page.getByText("Revoke this credential?")).toBeVisible();
  await page.getByRole("button", { name: "Confirm revoke" }).click();
  // The inline confirmation only enters the shared review stage; the actual
  // mutation is sent by the explicit global "Confirm" control, exactly like
  // `reviewIssue`. Without it no request is sent and no receipt is committed.
  await expect(page.getByText("Confirm this credential action")).toBeVisible();
  await page.getByRole("button", { name: "Confirm", exact: true }).click();
}

/**
 * Bounded PRIVACY leak check. Every comparison happens INSIDE the page and
 * only fixed booleans cross back, so the matcher diagnostics can never contain
 * the raw secret, the full HTML, the whole storage or the whole console.
 *
 * `intendedOneTimeControl` is the `#machine-secret-value` element while the
 * one-time credential is legitimately visible. It is the ONLY element excluded
 * from the DOM scan in that state; the URL, both storages and every other DOM
 * node must still be free of the secret. After cleanup pass `null` so the scan
 * covers ALL DOM. The exclusion removes exactly that one element from a cloned
 * document; no other node or text is deleted or rewritten.
 */
async function expectNoBrowserLeak(
  page: Page,
  secrets: readonly string[],
  intendedOneTimeControl: "visible" | null,
): Promise<void> {
  const result = await page.evaluate(
    (input) => {
      const rawNeedles = input.secrets.filter((value) => value.length > 0);
      const tokenPattern = /oac_(?:ag|pr)_[0-9a-f-]{36}_[A-Za-z0-9_-]{43}/u;
      const containsAny = (value: string): boolean =>
        rawNeedles.some((needle) => value.includes(needle)) || tokenPattern.test(value);

      // Clone the whole document and remove ONLY the intended one-time control
      // element from the clone. No other node, attribute or text is touched, so
      // any extra DOM copy of the secret would still be detected.
      const clone = document.documentElement.cloneNode(true) as HTMLElement;
      if (input.intendedOneTimeControl === "visible") {
        clone.querySelector("#machine-secret-value")?.remove();
      }
      const domExcerpt = clone.outerHTML;

      return {
        url: containsAny(window.location.href),
        local: containsAny(JSON.stringify(window.localStorage)),
        session: containsAny(JSON.stringify(window.sessionStorage)),
        dom: containsAny(domExcerpt),
      };
    },
    { secrets, intendedOneTimeControl },
  );
  expect(result).toEqual({ url: false, local: false, session: false, dom: false });
}

/**
 * Proves the leak check is NON-VACUOUS without ever touching the real secret:
 * a distinct synthetic sentinel is placed in and removed from the DOM, and the
 * same detection predicate must report it. This shows removing the real DOM
 * handler would fail the privacy check, while never persisting or logging the
 * actual credential.
 */
async function expectPrivacyCheckWouldCatch(page: Page): Promise<boolean> {
  const sentinel = `synthetic-leak-${Date.now()}-oac_ag_00000000-0000-4000-8000-000000000000_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA`;
  return page.evaluate((value) => {
    const tokenPattern = /oac_(?:ag|pr)_[0-9a-f-]{36}_[A-Za-z0-9_-]{43}/u;
    const node = document.createElement("div");
    node.textContent = value;
    document.body.append(node);
    const detected = tokenPattern.test(document.body.outerHTML);
    node.remove();
    const cleaned = !tokenPattern.test(document.body.outerHTML);
    return detected && cleaned;
  }, sentinel);
}

/* -------------------------------------------------------------------------- */
/* Actual Node HTTPS machine client (fixed loopback endpoint)                 */
/* -------------------------------------------------------------------------- */

type MachineKind = "agent" | "provider";
type MachineAction = "exchange" | "self" | "revoke";

interface MachineResponse {
  readonly status: number;
  readonly setCookie: boolean;
  readonly ok: boolean;
  /** True only when the full strict action-specific envelope validated. */
  readonly valid: boolean;
  readonly dataKeys: readonly string[] | null;
  readonly errorCode: string | null;
  readonly sessionId: string | null;
  readonly credentialId: string | null;
  readonly profileId: string | null;
  readonly kind: string | null;
  readonly scopes: readonly string[];
  readonly deliveryStatus: string | null;
  readonly sessionToken: string | null;
  readonly revokedKind: string | null;
}

let machineCaCache: Buffer | null = null;

/**
 * Guarded read of the synthetic PUBLIC fixture CA. The exact fixture opt-ins
 * MUST be set before the certificate is read, and the CA path is fixed. No
 * custom destination, redirect, proxy or env URL is accepted anywhere.
 */
function machineCa(): Buffer {
  if (process.env["OPENARC_MACHINE_PRODUCTION_FIXTURE"] !== "1") {
    throw new Error("MACHINE_FIXTURE_DISABLED");
  }
  if (process.env["OPENARC_TENANT_PRODUCTION_FIXTURE"] !== "1") {
    throw new Error("MACHINE_FIXTURE_DISABLED");
  }
  if (machineCaCache === null) {
    machineCaCache = readFileSync(MACHINE_CA_PATH);
  }
  return machineCaCache;
}

interface MachineRequestInput {
  readonly method: "GET" | "POST";
  readonly path: string;
  readonly kind: MachineKind;
  readonly action: MachineAction;
  readonly bearer: string | null;
  readonly body: "{}" | null;
}

interface ProjectedResponse {
  readonly valid: boolean;
  readonly ok: boolean;
  readonly dataKeys: readonly string[] | null;
  readonly errorCode: string | null;
  readonly session: CommerceMachineSessionMetadata | null;
  readonly deliveryStatus: string | null;
  readonly sessionToken: string | null;
  readonly revokedKind: string | null;
}

const EMPTY_PROJECTION: ProjectedResponse = {
  valid: false,
  ok: false,
  dataKeys: null,
  errorCode: null,
  session: null,
  deliveryStatus: null,
  sessionToken: null,
  revokedKind: null,
};

function parseObject(text: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * Validates the COMPLETE canonical machine envelope with the accepted shared
 * strict Zod schemas, then forms the bounded non-secret projection. Unknown
 * fields are rejected by the canonical `strictObject` envelopes (which also
 * require the canonical `meta`), the kind/action/context binding is asserted
 * against the requested call, and only safe metadata crosses back. There is no
 * second handwritten DTO mirror and no permissive partial cast.
 */
function projectMachineResponse(
  kind: MachineKind,
  action: MachineAction,
  status: number,
  setCookie: string[] | undefined,
  text: string,
): ProjectedResponse {
  void setCookie;
  const body = parseObject(text);
  if (body === null) return EMPTY_PROJECTION;

  if (status === 401) {
    const parsed = CommerceApiErrorEnvelopeSchema.safeParse(body);
    if (!parsed.success) return EMPTY_PROJECTION;
    return {
      ...EMPTY_PROJECTION,
      valid: true,
      ok: false,
      errorCode: parsed.data.error.code,
    };
  }

  if (status !== 200) return EMPTY_PROJECTION;

  if (action === "exchange") {
    const parsed = CommerceMachineSessionExchangeResponseSchema.safeParse(body);
    if (!parsed.success) return EMPTY_PROJECTION;
    const { session, delivery } = parsed.data.data;
    if (session.kind !== kind) return EMPTY_PROJECTION;
    return {
      valid: true,
      ok: true,
      dataKeys: Object.keys(parsed.data.data).sort(),
      errorCode: null,
      session,
      deliveryStatus: "available_once",
      sessionToken: delivery.token,
      revokedKind: null,
    };
  }

  if (action === "self") {
    const parsed = CommerceMachineSessionSelfResponseSchema.safeParse(body);
    if (!parsed.success) return EMPTY_PROJECTION;
    const { session } = parsed.data.data;
    if (session.kind !== kind) return EMPTY_PROJECTION;
    return {
      valid: true,
      ok: true,
      dataKeys: Object.keys(parsed.data.data).sort(),
      errorCode: null,
      session,
      deliveryStatus: null,
      sessionToken: null,
      revokedKind: null,
    };
  }

  // revoke
  const parsed = CommerceMachineSessionRevokeResponseSchema.safeParse(body);
  if (!parsed.success) return EMPTY_PROJECTION;
  const data = parsed.data.data;
  if (data.kind !== kind) return EMPTY_PROJECTION;
  return {
    valid: true,
    ok: true,
    dataKeys: Object.keys(data).sort(),
    errorCode: null,
    session: null,
    deliveryStatus: null,
    sessionToken: null,
    revokedKind: data.kind,
  };
}

/**
 * Performs ONE Node HTTPS machine request against the fixed loopback endpoint.
 *
 * The destination host/port/servername are compile-time constants; no caller
 * can override them, and no redirect/proxy/env URL is used. The response body
 * is capped before parsing; a timeout aborts a stalled connection. Only
 * canonical non-secret projections cross back to the caller. A raw session
 * token is captured into a transient local variable and returned only where the
 * journey needs to drive a subsequent machine call; it is never logged.
 */
async function machineRequest(input: MachineRequestInput): Promise<MachineResponse> {
  const ca = machineCa();
  return await new Promise<MachineResponse>((resolve, reject) => {
    const request = httpsRequest(
      {
        host: MACHINE_NODE_HOST,
        port: MACHINE_NODE_PORT,
        servername: MACHINE_NODE_SERVERNAME,
        method: input.method,
        path: input.path,
        ca,
        rejectUnauthorized: true,
        agent: false,
        timeout: 10_000,
        headers: {
          Accept: "application/json",
          ...(input.bearer === null ? {} : { Authorization: `Bearer ${input.bearer}` }),
          ...(input.body === null
            ? {}
            : { "Content-Type": "application/json", "Content-Length": "2" }),
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        let length = 0;
        response.on("data", (chunk: Buffer) => {
          length += chunk.length;
          if (length > 64 * 1024) {
            request.destroy();
            reject(new Error("MACHINE_RESPONSE_TOO_LARGE"));
            return;
          }
          chunks.push(chunk);
        });
        response.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          const projection = projectMachineResponse(
            input.kind,
            input.action,
            response.statusCode ?? 0,
            response.headers["set-cookie"],
            text,
          );
          resolve({
            status: response.statusCode ?? 0,
            setCookie:
              response.headers["set-cookie"] !== undefined &&
              response.headers["set-cookie"].length > 0,
            valid: projection.valid,
            ok: projection.ok,
            dataKeys: projection.dataKeys,
            errorCode: projection.errorCode,
            sessionId: projection.session?.sessionId ?? null,
            credentialId: projection.session?.credentialId ?? null,
            profileId: projection.session?.profileId ?? null,
            kind: projection.session?.kind ?? projection.revokedKind,
            scopes:
              projection.session === null
                ? []
                : [`${projection.session.kind}:self.read`],
            deliveryStatus: projection.deliveryStatus,
            sessionToken: projection.sessionToken,
            revokedKind: projection.revokedKind,
          });
        });
        response.on("error", reject);
      },
    );
    request.on("timeout", () => {
      request.destroy(new Error("MACHINE_TIMEOUT"));
    });
    request.on("error", reject);
    if (input.body !== null) request.write(input.body);
    request.end();
  });
}

function exchangePath(kind: MachineKind): string {
  return kind === "agent" ? "/v1/agent/sessions" : "/v1/provider/sessions";
}
function selfPath(kind: MachineKind): string {
  return kind === "agent" ? "/v1/agent/self" : "/v1/provider/self";
}
function revokePath(kind: MachineKind): string {
  return kind === "agent"
    ? "/v1/agent/sessions/current/revoke"
    : "/v1/provider/sessions/current/revoke";
}

interface MachineSession {
  readonly token: string;
  readonly response: MachineResponse;
}

async function exchange(kind: MachineKind, credential: string): Promise<MachineSession> {
  const response = await machineRequest({
    method: "POST",
    path: exchangePath(kind),
    kind,
    action: "exchange",
    bearer: credential,
    body: "{}",
  });
  const token = response.sessionToken;
  if (token === null) throw new Error("MACHINE_EXCHANGE_NO_TOKEN");
  return { token, response };
}

function expectExchangeOk(response: MachineResponse, kind: MachineKind): void {
  expect(response.status).toBe(200);
  expect(response.valid).toBe(true);
  expect(response.ok).toBe(true);
  expect(response.setCookie).toBe(false);
  expect(response.dataKeys).toEqual(["delivery", "session"]);
  expect(response.deliveryStatus).toBe("available_once");
  expect(response.kind).toBe(kind);
  expect(response.scopes).toEqual([
    kind === "agent" ? "agent:self.read" : "provider:self.read",
  ]);
  expect(CANONICAL_SESSION_TOKEN.test(response.sessionToken ?? "")).toBe(true);
}

function expectUnauthorized(response: MachineResponse): void {
  expect(response.status).toBe(401);
  expect(response.valid).toBe(true);
  expect(response.ok).toBe(false);
  expect(response.setCookie).toBe(false);
  expect(response.errorCode).not.toBeNull();
}

/* -------------------------------------------------------------------------- */
/* Browser same-origin JSON fetch (real browser transport, transient CSRF)    */
/* -------------------------------------------------------------------------- */

interface BrowserFetchOutcome {
  readonly status: number;
  readonly setCookie: boolean;
  readonly errorCode: string | null;
  readonly envelopeOk: boolean;
  readonly dataKeys: readonly string[] | null;
  readonly hasRawCredential: boolean;
  /**
   * True when the response text looks like the application shell (SPA
   * fallback). Computed INSIDE the page over the raw body; only the fixed
   * boolean crosses back. A normal generic nginx 404 body is text/html but is
   * NOT an app shell, so it must not be rejected merely for being HTML.
   */
  readonly spaShell: boolean;
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
    try {
      const parsed = JSON.parse(text) as {
        ok?: unknown;
        data?: unknown;
        error?: { code?: unknown };
      };
      if (typeof parsed === "object" && parsed !== null) {
        envelopeOk = parsed.ok === true;
        if (typeof parsed.data === "object" && parsed.data !== null) {
          dataKeys = Object.keys(parsed.data).sort();
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
      envelopeOk,
      dataKeys,
      hasRawCredential: /oac_(?:ag|pr)_[0-9a-f-]{36}_[A-Za-z0-9_-]{43}/u.test(text),
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
 * header (e.g. `Set-Cookie`). This proves the nginx boundary itself, not just
 * the API JSON. The method is intentionally open-ended so an unsupported verb
 * (e.g. DELETE) can be exercised.
 */
async function proxiedBrowserFetch(
  page: Page,
  request: {
    readonly path: string;
    readonly method: "GET" | "POST" | "DELETE";
    readonly body?: string;
    readonly extraHeaders?: Record<string, string>;
  },
): Promise<ProxiedFetchOutcome> {
  // `request.path` may carry a query string (e.g. `?limit=1`). Normalize the
  // expected path once and compare BOTH pathname and search on the real
  // response URL, so `?limit=1` / `?limit=0` cannot time out.
  const expectedUrl = new URL(request.path, MACHINE_ENABLED_ORIGIN);
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
      credentials: "same-origin",
      cache: "no-store",
      redirect: "error",
    });
    const text = await response.text();
    let errorCode: string | null = null;
    let envelopeOk = false;
    let dataKeys: string[] | null = null;
    try {
      const parsed = JSON.parse(text) as {
        ok?: unknown;
        data?: unknown;
        error?: { code?: unknown };
      };
      if (typeof parsed === "object" && parsed !== null) {
        envelopeOk = parsed.ok === true;
        if (typeof parsed.data === "object" && parsed.data !== null) {
          dataKeys = Object.keys(parsed.data).sort();
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
      envelopeOk,
      dataKeys,
      hasRawCredential: /oac_(?:ag|pr)_[0-9a-f-]{36}_[A-Za-z0-9_-]{43}/u.test(text),
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

/* -------------------------------------------------------------------------- */
/* @machine-on                                                                */
/* -------------------------------------------------------------------------- */

test.describe("PORT-01 machine credential production acceptance", { tag: "@machine-on" }, () => {
  test("explicit agent profile selection shows a safe empty list, and one visible issue commits with one durable receipt and a one-time raw secret", async ({
    page,
  }) => {
    await withSignedInAccount(page, async (accountId) => {
      const seeded = await seedOwnOrganizations(accountId, ["Synthetic Machine Agent"]);
      const organization = seeded[0];
      if (organization === undefined) throw new Error("seed missing");
      const seedAgent = (await seedAgents(organization.organizationId, 1))[0];
      if (seedAgent === undefined) throw new Error("seed missing");

      await openAgents(page, organization.organizationId);
      await openMachineConsole(page, "agent", seedAgent.id);
      await expect(page.getByText("No credentials for this profile.")).toBeVisible();

      const writeRequests: string[] = [];
      page.on("request", (request) => {
        if (
          request.method() === "POST" &&
          /\/credentials$/u.test(new URL(request.url()).pathname)
        ) {
          writeRequests.push(new URL(request.url()).pathname);
        }
      });

      await reviewIssue(page);
      const committed = await readCommittedCredential(page);
      expect(committed.operation).toBe("tenant.agent.credential.issue");
      expect(committed.credentialId).toBe(committed.mutationId);
      const raw = await captureRawOnce(page);
      expect(CANONICAL_CREDENTIAL_TOKEN.test(raw)).toBe(true);

      expect(writeRequests.length).toBe(1);

      const row = await readMachineCredentialRow(
        "agent",
        organization.organizationId,
        committed.credentialId,
      );
      expect(row?.profileId).toBe(seedAgent.id);
      expect(row?.status).toBe("active");
      expect(row?.keyPrefix).toMatch(/^oac_ag_[0-9a-f-]{36}$/u);
      expect(
        await countMachineMutationRows(organization.organizationId, committed.mutationId),
      ).toEqual({ idempotency: 1, audit: 1, outbox: 1 });
      const receipt = await readDurableReceipt(organization.organizationId, committed.mutationId);
      expect(receipt?.resourceType).toBe("agent_credential");

      // The single intended one-time control is legitimately visible here; it
      // is the ONLY node excluded from the DOM scan.
      await expectNoBrowserLeak(page, [raw], "visible");

      await dismissCredential(page);
      await page.reload();
      // After a real reload the agent list is empty until the explicit visible
      // "Load agents" control is used again; re-run the canonical opener so the
      // profile table is loaded before binding the machine console.
      await openAgents(page, organization.organizationId);
      await openMachineConsole(page, "agent", seedAgent.id);
      await expect(page.locator("#machine-secret-value")).toHaveCount(0);
      await expect(page.getByText(seedAgent.displayName)).toBeVisible();
      await expectNoBrowserLeak(page, [raw], null);
    });
  });

  test("the fresh agent credential drives Node exchange/self/revoke, with metadata correlation, wrong-kind denial and revoked-session 401", async ({
    page,
  }) => {
    await withSignedInAccount(page, async (accountId) => {
      const seeded = await seedOwnOrganizations(accountId, ["Synthetic Agent Node"]);
      const organization = seeded[0];
      if (organization === undefined) throw new Error("seed missing");
      const seedAgent = (await seedAgents(organization.organizationId, 1))[0];
      if (seedAgent === undefined) throw new Error("seed missing");

      await openAgents(page, organization.organizationId);
      await openMachineConsole(page, "agent", seedAgent.id);
      await reviewIssue(page);
      const committed = await readCommittedCredential(page);
      const raw = await captureRawOnce(page);

      const machineBrowserRequests: string[] = [];
      page.on("request", (request) => {
        const url = new URL(request.url());
        if (/^\/v1\/(?:agent|provider)\//u.test(url.pathname)) {
          machineBrowserRequests.push(url.pathname);
        }
      });

      const exchangeResult = await exchange("agent", raw);
      expectExchangeOk(exchangeResult.response, "agent");
      expect(exchangeResult.response.credentialId).toBe(committed.credentialId);
      expect(exchangeResult.response.profileId).toBe(seedAgent.id);
      expect((exchangeResult.response.sessionId ?? "").length).toBe(36);

      const wrongKind = await machineRequest({
        method: "GET",
        path: selfPath("provider"),
        kind: "provider",
        action: "self",
        bearer: exchangeResult.token,
        body: null,
      });
      expectUnauthorized(wrongKind);

      const self = await machineRequest({
        method: "GET",
        path: selfPath("agent"),
        kind: "agent",
        action: "self",
        bearer: exchangeResult.token,
        body: null,
      });
      expect(self.status).toBe(200);
      expect(self.valid).toBe(true);
      expect(self.setCookie).toBe(false);
      expect(self.dataKeys).toEqual(["session"]);
      expect(self.sessionId).toBe(exchangeResult.response.sessionId);
      expect(self.credentialId).toBe(committed.credentialId);

      const longAsSession = await machineRequest({
        method: "GET",
        path: selfPath("agent"),
        kind: "agent",
        action: "self",
        bearer: raw,
        body: null,
      });
      expectUnauthorized(longAsSession);

      const revoke = await machineRequest({
        method: "POST",
        path: revokePath("agent"),
        kind: "agent",
        action: "revoke",
        bearer: exchangeResult.token,
        body: "{}",
      });
      expect(revoke.status).toBe(200);
      expect(revoke.valid).toBe(true);
      expect(revoke.ok).toBe(true);
      expect(revoke.revokedKind).toBe("agent");

      const revokedSelf = await machineRequest({
        method: "GET",
        path: selfPath("agent"),
        kind: "agent",
        action: "self",
        bearer: exchangeResult.token,
        body: null,
      });
      expectUnauthorized(revokedSelf);

      // Session revocation is independent of credential revocation.
      const second = await exchange("agent", raw);
      expectExchangeOk(second.response, "agent");

      expect(machineBrowserRequests).toEqual([]);
      await expect(page.locator("#machine-secret-value")).toHaveCount(1);
      await expectNoBrowserLeak(page, [raw, exchangeResult.token], "visible");
    });
  });

  test("provider owner issue drives Node provider exchange/self/revoke with wrong-kind isolation", async ({
    page,
  }) => {
    await withSignedInAccount(page, async (accountId) => {
      const seeded = await seedOwnOrganizations(accountId, ["Synthetic Machine Provider"]);
      const organization = seeded[0];
      if (organization === undefined) throw new Error("seed missing");
      const seedProvider = (await seedProviders(organization.organizationId, 1))[0];
      if (seedProvider === undefined) throw new Error("seed missing");

      await openProvider(page, organization.organizationId);
      await openMachineConsole(page, "provider", seedProvider.id);
      await expect(page.getByText("No credentials for this profile.")).toBeVisible();
      await reviewIssue(page);
      const committed = await readCommittedCredential(page);
      expect(committed.operation).toBe("tenant.provider.credential.issue");
      const raw = await captureRawOnce(page);
      expect(/^oac_pr_/u.test(raw)).toBe(true);

      const row = await readMachineCredentialRow(
        "provider",
        organization.organizationId,
        committed.credentialId,
      );
      expect(row?.profileId).toBe(seedProvider.id);
      expect(row?.status).toBe("active");

      const exchangeResult = await exchange("provider", raw);
      expectExchangeOk(exchangeResult.response, "provider");
      expect(exchangeResult.response.credentialId).toBe(committed.credentialId);
      expect(exchangeResult.response.profileId).toBe(seedProvider.id);

      const wrongKind = await machineRequest({
        method: "GET",
        path: selfPath("agent"),
        kind: "agent",
        action: "self",
        bearer: exchangeResult.token,
        body: null,
      });
      expectUnauthorized(wrongKind);

      const self = await machineRequest({
        method: "GET",
        path: selfPath("provider"),
        kind: "provider",
        action: "self",
        bearer: exchangeResult.token,
        body: null,
      });
      expect(self.status).toBe(200);
      expect(self.valid).toBe(true);
      expect(self.kind).toBe("provider");
      expect(self.profileId).toBe(seedProvider.id);

      const revoke = await machineRequest({
        method: "POST",
        path: revokePath("provider"),
        kind: "provider",
        action: "revoke",
        bearer: exchangeResult.token,
        body: "{}",
      });
      expect(revoke.status).toBe(200);
      expect(revoke.valid).toBe(true);
      expect(revoke.revokedKind).toBe("provider");
      const revoked = await machineRequest({
        method: "GET",
        path: selfPath("provider"),
        kind: "provider",
        action: "self",
        bearer: exchangeResult.token,
        body: null,
      });
      expectUnauthorized(revoked);

      await expectNoBrowserLeak(page, [raw, exchangeResult.token], "visible");
    });
  });

  test("agent operator may issue while a viewer has no issue control, and provider issue is owner-only", async ({
    browser,
    page,
  }) => {
    // The main-page passkey authenticator stays active for the whole
    // `withSignedInAccount` callback below. A second real passkey sign-up in an
    // isolated context must therefore run ONLY after the first authenticator has
    // been removed, otherwise the two virtual authenticators contend and the
    // real sign-up hangs. This mirrors the accepted tenant-write fixture.
    let origin = MACHINE_ENABLED_ORIGIN;
    await withSignedInAccount(page, async (accountId) => {
      const owner = await seedAccount();
      const operatorOrg = await seedOrganizationWithRole(
        owner,
        accountId,
        "Synthetic Machine Operator",
        "operator",
      );
      const seedAgent = (await seedAgents(operatorOrg.organizationId, 1))[0];
      if (seedAgent === undefined) throw new Error("seed missing");
      await openAgents(page, operatorOrg.organizationId);
      await openMachineConsole(page, "agent", seedAgent.id);
      await expect(page.getByRole("button", { name: "Review issue" })).toBeVisible();

      // Merely seeing the form is not issuance acceptance: the operator
      // completes a real visible issue and the committed credential/receipt is
      // proven directly in the database.
      await reviewIssue(page);
      const operatorIssued = await readCommittedCredential(page);
      expect(operatorIssued.operation).toBe("tenant.agent.credential.issue");
      expect(operatorIssued.credentialId).toBe(operatorIssued.mutationId);
      const operatorRaw = await captureRawOnce(page);
      expect(CANONICAL_CREDENTIAL_TOKEN.test(operatorRaw)).toBe(true);

      const operatorRow = await readMachineCredentialRow(
        "agent",
        operatorOrg.organizationId,
        operatorIssued.credentialId,
      );
      expect(operatorRow?.profileId).toBe(seedAgent.id);
      expect(operatorRow?.status).toBe("active");
      expect(
        await countMachineMutationRows(operatorOrg.organizationId, operatorIssued.mutationId),
      ).toEqual({ idempotency: 1, audit: 1, outbox: 1 });
      const operatorReceipt = await readDurableReceipt(
        operatorOrg.organizationId,
        operatorIssued.mutationId,
      );
      expect(operatorReceipt?.resourceType).toBe("agent_credential");
      await expectNoBrowserLeak(page, [operatorRaw], "visible");
      await dismissCredential(page);
      await expectNoBrowserLeak(page, [operatorRaw], null);
      origin = new URL(page.url()).origin;
    });

    // Independent journeys use their OWN sequential real-UI contexts, created
    // only after the main-page authenticator is gone (see the note above). No
    // cookie is read, injected or serialized; each account is still created
    // through the visible `/account` passkey UI.
    await test.step("viewer role in an isolated context has no issue control", () =>
      withIsolatedSignedInAccount(
        browser,
        origin,
        async (viewerPage, viewerAccountId) => {
        const owner = await seedAccount();
        const viewerOrg = await seedOrganizationWithRole(
          owner,
          viewerAccountId,
          "Synthetic Machine Viewer",
          "viewer",
        );
        const viewerAgent = (await seedAgents(viewerOrg.organizationId, 1))[0];
        if (viewerAgent === undefined) throw new Error("seed missing");
        await test.step("viewer: load agents", () =>
          openAgents(viewerPage, viewerOrg.organizationId),
        );
        // The real running image does NOT render the credentials column /
        // "Manage credentials" control for a viewer, so the negative journey
        // must NOT click a deliberately absent button. It proves the seeded
        // profile ROW is really visible, then asserts every machine control and
        // the credential panel are absent.
        await test.step("viewer: profile row visible, machine controls absent", async () => {
          const row = viewerPage.getByRole("row").filter({ hasText: viewerAgent.id });
          await expect(row).toBeVisible();
          await expect(
            viewerPage.getByRole("button", { name: "Manage credentials" }),
          ).toHaveCount(0);
          await expect(
            viewerPage.getByRole("heading", { name: MACHINE_PANEL_TITLE.agent, exact: true }),
          ).toHaveCount(0);
          await expect(
            viewerPage.getByRole("button", { name: "Review issue" }),
          ).toHaveCount(0);
          await expect(
            viewerPage.getByRole("button", { name: "Revoke", exact: true }),
          ).toHaveCount(0);
        });
        },
      ),
    );

    await test.step("provider admin role in an isolated context has no issue control", () =>
      withIsolatedSignedInAccount(
        browser,
        MACHINE_ENABLED_ORIGIN,
        async (providerAdminPage, accountId) => {
        const owner = await seedAccount();
        const adminOrg = await seedOrganizationWithRole(
          owner,
          accountId,
          "Synthetic Machine ProviderAdmin",
          "provider_admin",
        );
        const seedProvider = (await seedProviders(adminOrg.organizationId, 1))[0];
        if (seedProvider === undefined) throw new Error("seed missing");
        // The running image denies a provider_admin the whole provider panel
        // (the same role gate the accepted tenant fixture asserts for operator),
        // so no profile row, credentials column or machine control can exist.
        // Assert the exact role-denied heading and every machine control absent;
        // do NOT click a deliberately absent "Manage credentials" button.
        await test.step("provider-admin: provider panel denied, machine controls absent", async () => {
          await providerAdminPage.goto("/app/provider");
          await selectOrganization(providerAdminPage, adminOrg.organizationId);
          await expect(
            providerAdminPage.getByRole("heading", {
              name: "Your role cannot view providers",
              exact: true,
            }),
          ).toBeVisible();
          await expect(
            providerAdminPage.getByRole("button", { name: "Manage credentials" }),
          ).toHaveCount(0);
          await expect(
            providerAdminPage.getByRole("heading", {
              name: MACHINE_PANEL_TITLE.provider,
              exact: true,
            }),
          ).toHaveCount(0);
          await expect(
            providerAdminPage.getByRole("button", { name: "Review issue" }),
          ).toHaveCount(0);
          await expect(
            providerAdminPage.getByRole("button", { name: "Revoke", exact: true }),
          ).toHaveCount(0);
          // The seeded provider is real, so its absence from the DOM is due to
          // the role gate, not a missing fixture row.
          await expect(providerAdminPage.getByText(seedProvider.id)).toHaveCount(0);
        });
        },
      ),
    );
  });

  test("explicit agent revoke commits a durable receipt, makes the already-issued session self 401, and blocks long-credential exchange", async ({
    page,
  }) => {
    await withSignedInAccount(page, async (accountId) => {
      const seeded = await seedOwnOrganizations(accountId, ["Synthetic Agent Revoke"]);
      const organization = seeded[0];
      if (organization === undefined) throw new Error("seed missing");
      const seedAgent = (await seedAgents(organization.organizationId, 1))[0];
      if (seedAgent === undefined) throw new Error("seed missing");

      await openAgents(page, organization.organizationId);
      await openMachineConsole(page, "agent", seedAgent.id);
      await reviewIssue(page);
      const issued = await readCommittedCredential(page);
      const raw = await captureRawOnce(page);
      await dismissCredential(page);
      await loadCredentials(page);

      const liveSession = await exchange("agent", raw);
      expectExchangeOk(liveSession.response, "agent");
      expect(
        (await countMachineRows("agent", organization.organizationId, issued.credentialId))
          .sessions,
      ).toBeGreaterThan(0);

      await revokeFirstCredential(page);
      const revoked = await readCommittedCredential(page);
      expect(revoked.operation).toBe("tenant.agent.credential.revoke");
      expect(revoked.credentialId).toBe(issued.credentialId);

      const afterRevoke = await machineRequest({
        method: "GET",
        path: selfPath("agent"),
        kind: "agent",
        action: "self",
        bearer: liveSession.token,
        body: null,
      });
      expectUnauthorized(afterRevoke);

      const exchangeAfter = await machineRequest({
        method: "POST",
        path: exchangePath("agent"),
        kind: "agent",
        action: "exchange",
        bearer: raw,
        body: "{}",
      });
      expectUnauthorized(exchangeAfter);

      const row = await readMachineCredentialRow(
        "agent",
        organization.organizationId,
        issued.credentialId,
      );
      expect(row?.status).toBe("revoked");
      expect(row?.revokedAt).not.toBeNull();
      expect(
        (await countMachineRows("agent", organization.organizationId, issued.credentialId))
          .sessions,
      ).toBe(0);
      expect(
        await countMachineMutationRows(organization.organizationId, revoked.mutationId),
      ).toEqual({ idempotency: 1, audit: 1, outbox: 1 });
      await expectNoBrowserLeak(page, [raw, liveSession.token], null);
    });
  });

  test("explicit provider revoke commits a durable receipt, makes the provider session self 401, and blocks long-credential exchange", async ({
    page,
  }) => {
    await withSignedInAccount(page, async (accountId) => {
      const seeded = await seedOwnOrganizations(accountId, ["Synthetic Provider Revoke"]);
      const organization = seeded[0];
      if (organization === undefined) throw new Error("seed missing");
      const seedProvider = (await seedProviders(organization.organizationId, 1))[0];
      if (seedProvider === undefined) throw new Error("seed missing");

      await openProvider(page, organization.organizationId);
      await openMachineConsole(page, "provider", seedProvider.id);
      await reviewIssue(page);
      const issued = await readCommittedCredential(page);
      const raw = await captureRawOnce(page);
      await dismissCredential(page);
      await loadCredentials(page);

      const liveSession = await exchange("provider", raw);
      expectExchangeOk(liveSession.response, "provider");

      await revokeFirstCredential(page);
      const revoked = await readCommittedCredential(page);
      expect(revoked.operation).toBe("tenant.provider.credential.revoke");
      expect(revoked.credentialId).toBe(issued.credentialId);

      const afterRevoke = await machineRequest({
        method: "GET",
        path: selfPath("provider"),
        kind: "provider",
        action: "self",
        bearer: liveSession.token,
        body: null,
      });
      expectUnauthorized(afterRevoke);
      const exchangeAfter = await machineRequest({
        method: "POST",
        path: exchangePath("provider"),
        kind: "provider",
        action: "exchange",
        bearer: raw,
        body: "{}",
      });
      expectUnauthorized(exchangeAfter);
      expect(
        (
          await readMachineCredentialRow(
            "provider",
            organization.organizationId,
            issued.credentialId,
          )
        )?.status,
      ).toBe("revoked");
      await expectNoBrowserLeak(page, [raw, liveSession.token], null);
    });
  });

  test("stale proof older than five minutes fails an agent issue safely with no token, success or extra mutation", async ({
    page,
  }) => {
    await withSignedInAccount(page, async (accountId) => {
      const seeded = await seedOwnOrganizations(accountId, ["Synthetic Machine Stale"]);
      const organization = seeded[0];
      if (organization === undefined) throw new Error("seed missing");
      const seedAgent = (await seedAgents(organization.organizationId, 1))[0];
      if (seedAgent === undefined) throw new Error("seed missing");

      await openAgents(page, organization.organizationId);
      await openMachineConsole(page, "agent", seedAgent.id);
      const affected = await ageAccountSessionProof(accountId, 900);
      expect(affected).toBeGreaterThan(0);

      const mutationId = "11111111-1111-4111-8111-111111111111";
      const path = `${TENANT_API_PREFIX}/${encodeURIComponent(organization.organizationId)}/agents/${encodeURIComponent(seedAgent.id)}/credentials`;
      const outcome = await sameOriginFetch(page, {
        path,
        method: "POST",
        csrf: "bootstrap",
        idempotencyKey: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        body: JSON.stringify({
          mutationId,
          expiresAt: new Date(Date.now() + 7 * 86_400_000).toISOString(),
        }),
      });
      expect(outcome.status).toBe(401);
      expect(outcome.setCookie).toBe(false);
      expect(outcome.hasRawCredential).toBe(false);

      expect(
        (await countMachineRows("agent", organization.organizationId, mutationId)).credentials,
      ).toBe(0);
      expect(await countMachineMutationRows(organization.organizationId, mutationId)).toEqual({
        idempotency: 0,
        audit: 0,
        outbox: 0,
      });
      await expect(page.locator("#machine-secret-value")).toHaveCount(0);
    });
  });

  test("recovery-blocked issue is refused while recovery revoke is still permitted, and revocation never demands a fresh proof", async ({
    page,
  }) => {
    await withSignedInAccount(page, async (accountId) => {
      const seeded = await seedOwnOrganizations(accountId, ["Synthetic Machine Recovery"]);
      const organization = seeded[0];
      if (organization === undefined) throw new Error("seed missing");
      const seedAgent = (await seedAgents(organization.organizationId, 1))[0];
      if (seedAgent === undefined) throw new Error("seed missing");

      // Seed a committed credential through the accepted restricted-pool helper
      // so the recovery path can prove revoke still succeeds. This uses its own
      // internal fresh passkey session and must run BEFORE the browser session
      // is converted, because the issue proof would otherwise be stale.
      const seededCredential = await seedMachineCredential(
        accountId,
        organization.organizationId,
        "agent",
        seedAgent.id,
        3_600,
      );
      expect(CANONICAL_MUTATION.test(seededCredential.credentialId)).toBe(true);

      // Labeled SYNTHETIC conversion of THIS fixture account's actual existing
      // active browser session metadata: the browser keeps using the very same
      // passkey session it created through the real sign-up UI, while the
      // server-side method is converted to `recovery` and the proof timestamp is
      // aged past the frozen 5-minute window. No unrelated session is minted and
      // no cookie, token hash or browser state is read or injected. This is a
      // synthetic metadata conversion, NOT cryptographic recovery proof.
      const converted = await convertAccountSessionToRecovery(accountId, 400);
      expect(converted).toBeGreaterThan(0);

      // Reload the ACTUAL UI so the account/session read observes `recovery`.
      await openAgents(page, organization.organizationId);
      await openMachineConsole(page, "agent", seedAgent.id);
      // The recovery guard runs when the explicit review action starts the
      // draft, so the first "Review issue" click is refused directly and never
      // reaches the shared confirmation stage.
      await page.getByRole("button", { name: "Review issue" }).click();
      await expect(page.getByText(/Recovery sign-in cannot authorize it/u)).toBeVisible();

      // Revocation is permitted WITHOUT a fresh proof even under recovery.
      await revokeFirstCredential(page);
      const revoked = await readCommittedCredential(page);
      expect(revoked.operation).toBe("tenant.agent.credential.revoke");
      expect(
        (
          await readMachineCredentialRow(
            "agent",
            organization.organizationId,
            seededCredential.credentialId,
          )
        )?.status,
      ).toBe("revoked");
    });
  });

  test("a deterministic lost issue reply after an independently confirmed commit yields unknown, then check status recovers safely, then a separately initiated new issue is distinct", async ({
    page,
  }) => {
    await withSignedInAccount(page, async (accountId) => {
      const seeded = await seedOwnOrganizations(accountId, ["Synthetic Machine Unknown"]);
      const organization = seeded[0];
      if (organization === undefined) throw new Error("seed missing");
      const seedAgent = (await seedAgents(organization.organizationId, 1))[0];
      if (seedAgent === undefined) throw new Error("seed missing");

      await openAgents(page, organization.organizationId);
      await openMachineConsole(page, "agent", seedAgent.id);

      const client = await page.context().newCDPSession(page);
      const capture: { mutationId: string | null } = { mutationId: null };
      // Counts EVERY outgoing issue POST seen from before the issue through the
      // status check, the explicit revoke and the distinct new issue. This is
      // independent of the CDP response-stage fault below, so a hidden retry or
      // duplicate issue POST would be caught even while the fault is installed.
      let outgoingIssuePosts = 0;
      page.on("request", (request) => {
        if (
          request.method() === "POST" &&
          /\/agents\/[^/]+\/credentials$/u.test(new URL(request.url()).pathname)
        ) {
          outgoingIssuePosts += 1;
        }
      });
      let issuePosts = 0;
      let faultInstalled = true;
      let preFaultDbCommitConfirmed = false;
      let settleFaultDecision:
        | ((value: { confirmed: boolean; mutationId: string | null }) => void)
        | null = null;
      const faultDecision = new Promise<{ confirmed: boolean; mutationId: string | null }>(
        (resolve) => {
          settleFaultDecision = resolve;
        },
      );
      client.on("Fetch.requestPaused", async (event) => {
        const isIssue =
          event.request.method === "POST" &&
          /\/agents\/[^/]+\/credentials$/u.test(new URL(event.request.url).pathname);
        if (!isIssue || event.responseStatusCode === undefined) {
          await client
            .send("Fetch.continueRequest", { requestId: event.requestId })
            .catch(() => undefined);
          return;
        }
        issuePosts += 1;
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
            if ((await readDurableReceipt(organization.organizationId, commit)) !== null) {
              confirmed = true;
              break;
            }
            await new Promise<void>((resolveTick) => setTimeout(resolveTick, 50));
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
          .send("Fetch.failRequest", { requestId: event.requestId, errorReason: "Failed" })
          .catch(() => undefined);
      });
      await client.send("Fetch.enable", {
        patterns: [{ urlPattern: "*", requestStage: "Response" }],
      });

      await test.step("install fetch and issue", () => reviewIssue(page));
      const decision = await test.step("await pre-fault DB commit confirmation", () =>
        faultDecision,
      );
      expect(decision.confirmed).toBe(true);
      expect(preFaultDbCommitConfirmed).toBe(true);
      expect(decision.mutationId).toBe(capture.mutationId);
      expect(issuePosts).toBe(1);
      // Exactly the first issue POST was observed; there is no retry.
      expect(outgoingIssuePosts).toBe(1);

      await test.step("outcome unknown visible", () =>
        expect(page.getByText("Outcome unknown")).toBeVisible(),
      );
      const mutationId = capture.mutationId;
      if (mutationId === null) throw new Error("MUTATION_ID_NOT_OBSERVED");
      expect(CANONICAL_MUTATION.test(mutationId)).toBe(true);
      expect(
        (await countMachineMutationRows(organization.organizationId, mutationId)).idempotency,
      ).toBe(1);

      faultInstalled = false;
      await test.step("check status", () =>
        page.getByRole("button", { name: "Check status" }).click(),
      );
      await expect(page.getByText("Credential action already committed")).toBeVisible();
      await expect(page.getByText("Outcome unknown")).toHaveCount(0);
      await expect(page.locator("#machine-secret-value")).toHaveCount(0);
      expect(issuePosts).toBe(1);
      // The status check is a GET and never repeats the issue POST.
      expect(outgoingIssuePosts).toBe(1);

      await client.send("Fetch.disable");
      await test.step("reload list and revoke", async () => {
        // A committed status reloads the PROFILE list, not the bounded
        // credential list, so the pre-issue empty credential list can otherwise
        // survive. Re-open the same explicitly selected profile from a fresh
        // navigation (real UI, no mock) so the list starts in its real `none`
        // state, then invoke the VISIBLE "Load credentials" control and require
        // the exact committed credential row before clicking its Revoke.
        await test.step("reopen machine console and explicitly load credentials", async () => {
          await page.reload();
          await openAgents(page, organization.organizationId);
          await selectProfile(page, seedAgent.id);
          await expectMachinePanel(page, "agent");
          const load = page.getByRole("button", { name: "Load credentials" });
          await expect(load).toBeVisible();
          await load.click();
          await expect(load).toHaveCount(0);
        });
        await test.step("confirm exact committed credential row then revoke", async () => {
          // Independent DB proof of the exact committed credential: the issue
          // mutation id is the credential id, and the durable row must map to
          // the seeded profile and be active. The accepted production UI list
          // NEVER displays credentialId, so the visible row is matched by the
          // safe `keyPrefix` (management-service publicPrefix -> key_prefix)
          // projection, not by the raw id. No token/hash/salt is read.
          const committedRow = await readMachineCredentialRow(
            "agent",
            organization.organizationId,
            mutationId,
          );
          if (committedRow === null) {
            throw new Error("COMMITTED_CREDENTIAL_ROW_MISSING");
          }
          expect(committedRow.credentialId).toBe(mutationId);
          expect(committedRow.profileId).toBe(seedAgent.id);
          expect(committedRow.status).toBe("active");
          expect(committedRow.keyPrefix).toMatch(/^oac_ag_[0-9a-f-]{36}$/u);
          const row = page
            .locator(".machine-credential-list .machine-credential")
            .filter({ hasText: committedRow.keyPrefix });
          await expect(row).toHaveCount(1);
          await row.getByRole("button", { name: "Revoke", exact: true }).click();
          await expect(page.getByText("Revoke this credential?")).toBeVisible();
          await page.getByRole("button", { name: "Confirm revoke" }).click();
          await expect(page.getByText("Confirm this credential action")).toBeVisible();
          await page.getByRole("button", { name: "Confirm", exact: true }).click();
        });
      });
      const revoked = await readCommittedCredential(page);
      expect(revoked.operation).toBe("tenant.agent.credential.revoke");
      expect(revoked.credentialId).toBe(mutationId);
      // The explicit revoke is a different resource path, not an issue POST.
      expect(outgoingIssuePosts).toBe(1);

      await test.step("second distinct issue", async () => {
        await loadCredentials(page);
        await reviewIssue(page);
      });
      const secondIssue = await readCommittedCredential(page);
      expect(secondIssue.operation).toBe("tenant.agent.credential.issue");
      expect(secondIssue.mutationId).not.toBe(mutationId);
      // Exactly one additional, distinct, separately initiated issue POST.
      expect(outgoingIssuePosts).toBe(2);
      const secondRaw = await captureRawOnce(page);
      expect(secondRaw.startsWith("oac_ag_")).toBe(true);
      await expectNoBrowserLeak(page, [secondRaw], "visible");
    });
  });

  test("dismiss, page hide, visibility hidden, profile switch, organization switch and logout each clear a FRESHLY issued one-time credential", async ({
    page,
  }) => {
    await withSignedInAccount(page, async (accountId) => {
      const seeded = await seedOwnOrganizations(accountId, [
        "Synthetic Machine Cleanup A",
        "Synthetic Machine Cleanup B",
      ]);
      const orgA = seeded[0];
      const orgB = seeded[1];
      if (orgA === undefined || orgB === undefined) throw new Error("seed missing");
      const agentsA = await seedAgents(orgA.organizationId, 2);
      const first = agentsA[0];
      const second = agentsA[1];
      const agentB = (await seedAgents(orgB.organizationId, 1))[0];
      if (first === undefined || second === undefined || agentB === undefined) {
        throw new Error("seed missing");
      }

      // The privacy check is non-vacuous: it would catch a synthetic sentinel
      // placed in the DOM (and that sentinel is removed immediately).
      expect(await expectPrivacyCheckWouldCatch(page)).toBe(true);

      const consoleLines: string[] = [];
      page.on("console", (message) => consoleLines.push(message.text()));
      const raws: string[] = [];

      // Each transition below starts from a FRESH visible one-time credential,
      // so the state being cleaned up is real and not already empty. The fixed
      // 10 issues/account/minute machine limit stays respected (six issues).
      const issueFresh = async (
        organizationId: string,
        profileId: string,
      ): Promise<string> => {
        // A fresh navigation leaves the profile list unloaded; re-run the
        // canonical explicit "Load agents" opener before binding the console.
        await openAgents(page, organizationId);
        await openMachineConsole(page, "agent", profileId);
        await reviewIssue(page);
        const raw = await captureRawOnce(page);
        await expectNoBrowserLeak(page, [raw], "visible");
        raws.push(raw);
        return raw;
      };

      // 1. Explicit dismiss.
      const rawDismiss = await issueFresh(orgA.organizationId, first.id);
      await dismissCredential(page);
      await expect(page.locator("#machine-secret-value")).toHaveCount(0);
      await expectNoBrowserLeak(page, [rawDismiss], null);

      // 2. Profile switch with a fresh credential.
      const rawProfile = await issueFresh(orgA.organizationId, first.id);
      await selectProfile(page, second.id);
      await expect(page.locator("#machine-secret-value")).toHaveCount(0);
      await expectNoBrowserLeak(page, [rawProfile], null);

      // 3. pagehide with a fresh credential. The event is dispatched on the
      // VERY document that still shows the one-time control; there is no
      // navigation first, so the cleanup handler is actually exercised on the
      // same DOM and the control/raw token must be gone THERE.
      const rawPagehide = await issueFresh(orgA.organizationId, first.id);
      await expect(page.locator("#machine-secret-value")).toHaveCount(1);
      const pagehideCleared = await page.evaluate((needle) => {
        window.dispatchEvent(new Event("pagehide"));
        const controlGone = document.querySelector("#machine-secret-value") === null;
        const rawGone = !document.documentElement.outerHTML.includes(needle);
        return controlGone && rawGone;
      }, rawPagehide);
      expect(pagehideCleared).toBe(true);
      await expect(page.locator("#machine-secret-value")).toHaveCount(0);
      await expectNoBrowserLeak(page, [rawPagehide], null);

      // 4. Document hidden (synthetic visibility transition) with a fresh credential.
      const rawHidden = await issueFresh(orgA.organizationId, first.id);
      await page.evaluate(() => {
        Object.defineProperty(document, "visibilityState", {
          configurable: true,
          get: () => "hidden",
        });
        document.dispatchEvent(new Event("visibilitychange"));
      });
      await expectNoBrowserLeak(page, [rawHidden], null);

      // 5. Organization switch with a fresh credential on the second org.
      const rawOrg = await issueFresh(orgB.organizationId, agentB.id);
      await selectOrganization(page, orgA.organizationId);
      await expect(page.locator("#machine-secret-value")).toHaveCount(0);
      await expectNoBrowserLeak(page, [rawOrg], null);

      // 6. Logout with a fresh credential.
      const rawLogout = await issueFresh(orgA.organizationId, first.id);
      await page.goto("/account");
      await page.getByRole("button", { name: "Sign out" }).click();
      await expect(
        page.getByRole("heading", { name: "Sign in or create an account" }),
      ).toBeVisible();
      await expectNoBrowserLeak(page, [rawLogout], null);

      // Compute the boolean INSIDE the page from the captured console text and
      // the transient raws, then assert ONLY the fixed boolean. The raw token,
      // the console lines and the whole storage are never fed to a matcher.
      const consoleLeak = await page.evaluate(
        (input) => {
          const tokenPattern = /oac_(?:ag|pr)_[0-9a-f-]{36}_[A-Za-z0-9_-]{43}/u;
          const needles = input.secrets.filter((value) => value.length > 0);
          return input.lines.some(
            (line) =>
              needles.some((needle) => line.includes(needle)) || tokenPattern.test(line),
          );
        },
        { lines: consoleLines, secrets: raws },
      );
      expect(consoleLeak).toBe(false);
    });
  });

  test("explicit credential list refresh shows only safe metadata and never redisplays the raw secret", async ({
    page,
  }) => {
    await withSignedInAccount(page, async (accountId) => {
      const seeded = await seedOwnOrganizations(accountId, ["Synthetic Machine List"]);
      const organization = seeded[0];
      if (organization === undefined) throw new Error("seed missing");
      const seedAgent = (await seedAgents(organization.organizationId, 1))[0];
      if (seedAgent === undefined) throw new Error("seed missing");

      await openAgents(page, organization.organizationId);
      await openMachineConsole(page, "agent", seedAgent.id);
      await reviewIssue(page);
      const committed = await readCommittedCredential(page);
      const raw = await captureRawOnce(page);
      await dismissCredential(page);

      await loadCredentials(page);
      await expect(page.locator(".machine-credential-list")).toBeVisible();
      await expect(page.locator("#machine-secret-value")).toHaveCount(0);
      const listText = await page.locator(".machine-credential-list").innerText();
      expect(listText).not.toContain(raw);
      expect(listText).toContain("oac_ag_");
      expect(listText).toContain("active");

      await page.reload();
      await selectOrganization(page, organization.organizationId);
      await expect(page.locator("#machine-secret-value")).toHaveCount(0);
      expect(
        (
          await readMachineCredentialRow(
            "agent",
            organization.organizationId,
            committed.credentialId,
          )
        )?.status,
      ).toBe("active");
      await expectNoBrowserLeak(page, [raw], null);
    });
  });

  test("browser proxy itself denies the six machine session paths with an exact nginx 404, while the canonical human management route is proxied and its method/query guards stay bounded", async ({
    page,
  }) => {
    await withSignedInAccount(page, async (accountId) => {
      const seeded = await seedOwnOrganizations(accountId, ["Synthetic Machine Boundary"]);
      const organization = seeded[0];
      if (organization === undefined) throw new Error("seed missing");
      await page.goto("/app/overview");
      await selectOrganization(page, organization.organizationId);

      // Exact statuses come from the reviewed nginx/API boundary. They are the
      // specific documented denials, never a general "not 200".
      const NGINX_MACHINE_ROUTE_NOT_FOUND = 404;
      const NGINX_METHOD_NOT_ALLOWED = 405;
      const API_QUERY_VALIDATION_FAILED = 400;

      const machinePaths: ReadonlyArray<{
        readonly path: string;
        readonly method: "GET" | "POST";
      }> = [
        { path: "/v1/agent/sessions", method: "POST" },
        { path: "/v1/provider/sessions", method: "POST" },
        { path: "/v1/agent/self", method: "GET" },
        { path: "/v1/provider/self", method: "GET" },
        { path: "/v1/agent/sessions/current/revoke", method: "POST" },
        { path: "/v1/provider/sessions/current/revoke", method: "POST" },
      ];
      for (const entry of machinePaths) {
        const outcome = await proxiedBrowserFetch(page, {
          path: entry.path,
          method: entry.method,
          ...(entry.method === "POST" ? { body: "{}" } : {}),
          extraHeaders: { Authorization: "Bearer synthetic-machine-token" },
        });
        // The denial is the nginx boundary itself, not an API 400/401.
        expect(outcome.status, entry.path).toBe(NGINX_MACHINE_ROUTE_NOT_FOUND);
        expect(outcome.body.status, entry.path).toBe(NGINX_MACHINE_ROUTE_NOT_FOUND);
        expect(outcome.setCookieHeaderPresent, entry.path).toBe(false);
        expect(outcome.corsAllowOriginPresent, entry.path).toBe(false);
        // Nginx 404 is allowed to be a normal generic HTML error page, so the
        // content type is NOT rejected for merely being HTML. What must be
        // absent is the SPA app shell / SPA asset references / app root, i.e. a
        // static fallback serving the application instead of a 404.
        expect(outcome.body.spaShell, entry.path).toBe(false);
        expect(outcome.contentType.toLowerCase(), entry.path).not.toContain("application/json");
        // No protected DTO surface.
        expect(outcome.body.envelopeOk, entry.path).toBe(false);
        expect(outcome.body.hasRawCredential, entry.path).toBe(false);
        expect(outcome.body.dataKeys, entry.path).toBeNull();
        expect(
          outcome.body.dataKeys === null || !outcome.body.dataKeys.includes("delivery"),
          entry.path,
        ).toBe(true);
      }

      const seedAgent = (await seedAgents(organization.organizationId, 1))[0];
      if (seedAgent === undefined) throw new Error("seed missing");
      await openAgents(page, organization.organizationId);
      await openMachineConsole(page, "agent", seedAgent.id);
      await expect(page.getByText("No credentials for this profile.")).toBeVisible();

      const scoped = `${TENANT_API_PREFIX}/${encodeURIComponent(organization.organizationId)}/agents/${encodeURIComponent(seedAgent.id)}/credentials`;

      // Canonical GET success counterproof: the human management route IS
      // proxied to the real API and returns its valid success envelope.
      const canonicalGet = await proxiedBrowserFetch(page, {
        path: `${scoped}?limit=1`,
        method: "GET",
      });
      expect(canonicalGet.status).toBe(200);
      expect(canonicalGet.body.envelopeOk).toBe(true);
      expect(canonicalGet.body.dataKeys).toEqual(
        expect.arrayContaining(["organizationId", "kind", "profileId", "items", "nextCursor"]),
      );
      expect(canonicalGet.setCookieHeaderPresent).toBe(false);
      expect(canonicalGet.body.hasRawCredential).toBe(false);

      // A genuinely unsupported verb on the canonical route is the reviewed
      // nginx method guard, not a valid GET.
      const unsupportedVerb = await proxiedBrowserFetch(page, {
        path: scoped,
        method: "DELETE",
      });
      expect(unsupportedVerb.status).toBe(NGINX_METHOD_NOT_ALLOWED);
      expect(unsupportedVerb.body.hasRawCredential).toBe(false);
      expect(unsupportedVerb.setCookieHeaderPresent).toBe(false);

      // An invalid query (`limit=0` is below the frozen minimum) is rejected by
      // the API validation boundary and never yields a protected DTO.
      const invalidQuery = await proxiedBrowserFetch(page, {
        path: `${scoped}?limit=0`,
        method: "GET",
      });
      expect(invalidQuery.status).toBe(API_QUERY_VALIDATION_FAILED);
      expect(invalidQuery.body.envelopeOk).toBe(false);
      expect(invalidQuery.body.dataKeys).toBeNull();
      expect(invalidQuery.body.hasRawCredential).toBe(false);
      expect(invalidQuery.setCookieHeaderPresent).toBe(false);
    });
  });

  test("mobile 320px machine console keeps 16px controls and 44px targets, no overflow, and a keyboard-confirmed issue", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 320, height: 800 });
    await withSignedInAccount(page, async (accountId) => {
      const seeded = await seedOwnOrganizations(accountId, ["Synthetic Machine Mobile"]);
      const organization = seeded[0];
      if (organization === undefined) throw new Error("seed missing");
      const seedAgent = (await seedAgents(organization.organizationId, 1))[0];
      if (seedAgent === undefined) throw new Error("seed missing");

      await page.goto("/app/agents");
      const viewport = page.viewportSize();
      if (viewport !== null && viewport.width <= 860) {
        await page.getByRole("button", { name: "Menu" }).click();
        const drawer = page.locator("#tenant-drawer");
        await expect(drawer).toBeVisible();
        await drawer
          .locator(".tenant-org-select")
          .selectOption({ value: organization.organizationId });
        // Selecting an organization closes the mobile drawer synchronously
        // (TenantApp's drawer Rail calls closeDrawer before selectOrganization),
        // so the "Close navigation menu" control is already gone here.
        await expect(drawer).toHaveCount(0);
        await expect(page.getByRole("button", { name: "Menu" })).toHaveAttribute(
          "aria-expanded",
          "false",
        );
        await expect(page.locator(".tenant-org-select")).toHaveValue(
          organization.organizationId,
        );
      } else {
        await selectOrganization(page, organization.organizationId);
      }
      await expect(page.getByRole("heading", { name: "Agents", exact: true })).toBeVisible();
      // The freshly selected organization starts with an unloaded profile list,
      // so the explicit visible "Load agents" control must be used before any
      // profile row can be bound.
      const loadAgents = page.getByRole("button", { name: "Load agents" });
      const agentRows = page.locator(".tenant-table tbody tr");
      await expect
        .poll(async () => (await loadAgents.count()) + (await agentRows.count()))
        .toBeGreaterThan(0);
      if ((await loadAgents.count()) > 0) {
        await loadAgents.click();
        await expect(loadAgents).toHaveCount(0);
      }
      await expect(agentRows.first()).toBeVisible();
      await selectProfile(page, seedAgent.id);
      await expectMachinePanel(page, "agent");

      const expiry = page.getByLabel("Expires in");
      await expiry.focus();
      const fontSize = await expiry.evaluate((element) =>
        Number.parseFloat(getComputedStyle(element).fontSize),
      );
      expect(fontSize).toBeGreaterThanOrEqual(16);
      const box = await expiry.boundingBox();
      expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);

      const overflow = await page.evaluate(() => ({
        scrollWidth: document.documentElement.scrollWidth,
        innerWidth: window.innerWidth,
      }));
      expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.innerWidth);

      const review = page.getByRole("button", { name: "Review issue" });
      const reviewBox = await review.boundingBox();
      expect(reviewBox?.height ?? 0).toBeGreaterThanOrEqual(44);
      await review.press("Enter");
      const confirm = page.getByRole("button", { name: "Confirm", exact: true });
      const confirmBox = await confirm.boundingBox();
      expect(confirmBox?.height ?? 0).toBeGreaterThanOrEqual(44);
      await confirm.press("Enter");
      const committed = await readCommittedCredential(page);
      expect(committed.operation).toBe("tenant.agent.credential.issue");
      const raw = await captureRawOnce(page);
      const dismiss = page.getByRole("button", { name: "Dismiss" });
      const dismissBox = await dismiss.boundingBox();
      expect(dismissBox?.height ?? 0).toBeGreaterThanOrEqual(44);
      await dismiss.click();
      await expect(page.locator("#machine-secret-value")).toHaveCount(0);
      await expectNoBrowserLeak(page, [raw], null);
    });
  });

  test("actual machine credentials expire under the database clock and are rejected by exchange and self", async ({
    page,
  }) => {
    await withSignedInAccount(page, async (accountId) => {
      const seeded = await seedOwnOrganizations(accountId, ["Synthetic Machine Expiry"]);
      const organization = seeded[0];
      if (organization === undefined) throw new Error("seed missing");
      const seedAgent = (await seedAgents(organization.organizationId, 1))[0];
      if (seedAgent === undefined) throw new Error("seed missing");

      await openAgents(page, organization.organizationId);
      await openMachineConsole(page, "agent", seedAgent.id);
      await reviewIssue(page);
      const committed = await readCommittedCredential(page);
      const raw = await captureRawOnce(page);
      await dismissCredential(page);

      const exchangeResult = await exchange("agent", raw);
      expectExchangeOk(exchangeResult.response, "agent");

      // Synthetic DB fixture: move the REAL expires_at two seconds ahead of the
      // database clock. This is not a stale client-clock assumption.
      const affected = await expireMachineCredential(
        "agent",
        organization.organizationId,
        committed.credentialId,
        2,
      );
      expect(affected).toBe(1);

      // Bounded, database-clock observation that it is actually expired.
      let expired = false;
      for (let attempt = 0; attempt < 40; attempt += 1) {
        const row = await readMachineCredentialRow(
          "agent",
          organization.organizationId,
          committed.credentialId,
        );
        if (row?.status === "expired") {
          expired = true;
          break;
        }
        await new Promise<void>((resolveTick) => setTimeout(resolveTick, 100));
      }
      expect(expired).toBe(true);

      const exchangeAfter = await machineRequest({
        method: "POST",
        path: exchangePath("agent"),
        kind: "agent",
        action: "exchange",
        bearer: raw,
        body: "{}",
      });
      expectUnauthorized(exchangeAfter);

      const selfAfter = await machineRequest({
        method: "GET",
        path: selfPath("agent"),
        kind: "agent",
        action: "self",
        bearer: exchangeResult.token,
        body: null,
      });
      expect(selfAfter.status).toBe(401);

      await expectNoBrowserLeak(page, [raw, exchangeResult.token], null);
    });
  });
});

/* -------------------------------------------------------------------------- */
/* @machine-off: machine management OFF, tenant reads/writes ON               */
/* -------------------------------------------------------------------------- */

test.describe("PORT-01 machine management OFF", { tag: "@machine-off" }, () => {
  test("signed-in tenant reads/writes still work with no machine form or request, and the credential route is 404 not proxied", async ({
    page,
  }) => {
    await withSignedInAccount(page, async (accountId) => {
      const seeded = await seedOwnOrganizations(accountId, ["Synthetic Machine Off"]);
      const organization = seeded[0];
      if (organization === undefined) throw new Error("seed missing");
      const seedAgent = (await seedAgents(organization.organizationId, 1))[0];
      if (seedAgent === undefined) throw new Error("seed missing");

      const machineRequests: string[] = [];
      page.on("request", (request) => {
        const url = new URL(request.url());
        if (
          /^\/v1\/(?:agent|provider)\//u.test(url.pathname) ||
          /\/credentials$/u.test(url.pathname)
        ) {
          machineRequests.push(url.pathname);
        }
      });

      // Ordinary tenant reads still work.
      await openAgents(page, organization.organizationId);
      await expect(page.getByText(seedAgent.displayName)).toBeVisible();
      // No machine panel, profile-selection control or issue form exists.
      await expect(page.getByRole("heading", { name: "Agent credential" })).toHaveCount(0);
      await expect(page.getByRole("button", { name: "Manage credentials" })).toHaveCount(0);
      await expect(page.getByRole("button", { name: "Review issue" })).toHaveCount(0);
      await expect(page.getByLabel("Expires in")).toHaveCount(0);
      expect(machineRequests).toEqual([]);

      // Ordinary tenant writes still work through the real UI.
      await openAgents(page, organization.organizationId);
      await page.getByLabel("Operation").selectOption("tenant.agent.create");
      await page.getByLabel("Display name").fill("Machine Off Agent");
      await page.getByRole("button", { name: "Review change" }).click();
      await expect(page.getByText("Confirm this change")).toBeVisible();
      await page.getByRole("button", { name: "Confirm and send" }).click();
      await expect(page.getByText("Change committed")).toBeVisible();
      expect(machineRequests).toEqual([]);

      // The machine credential route is 404 in the OFF image, not proxied.
      const credentialPath = `${TENANT_API_PREFIX}/${encodeURIComponent(organization.organizationId)}/agents/${encodeURIComponent(seedAgent.id)}/credentials`;
      // Zero UI-generated machine requests BEFORE the single explicit boundary
      // probe below. Every assertion above this point already proved there was
      // no machine panel, form or request from ordinary reads/writes.
      expect(machineRequests).toEqual([]);
      const outcome = await sameOriginFetch(page, {
        path: credentialPath,
        method: "GET",
        csrf: "omit",
      });
      expect(outcome.status).toBe(404);
      expect(outcome.setCookie).toBe(false);
      expect(outcome.envelopeOk).toBe(false);
      expect(outcome.hasRawCredential).toBe(false);
      expect(outcome.dataKeys).toBeNull();
      // ONLY the one explicit boundary probe was observed afterward, and it is
      // exactly the credential path we deliberately fetched. No unexpected app
      // request is hidden or waved through.
      expect(machineRequests).toHaveLength(1);
      expect(machineRequests[0]).toBe(new URL(credentialPath, page.url()).pathname);
    });
  });
});
