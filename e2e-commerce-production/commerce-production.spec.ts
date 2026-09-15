import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { request as httpsRequest } from "node:https";

import { expect, test, type CDPSession, type Page } from "@playwright/test";

import {
  POLICY_ROLLING_LIMIT,
  FixtureCoreRefusal,
  countCommerceRows,
  countDurableRows,
  fixtureAuthorize,
  fixtureClaimGrant,
  fixtureConcurrentClaims,
  fixtureIssueGrant,
  readActionState,
  readDurableReceipt,
  readGrantState,
  seedAgentMachineSession,
  seedAgents,
  seedBuyerPolicy,
  seedFixtureRequirement,
  seedOwnOrganizations,
  seedProviderMachineSession,
  seedSellerListing,
  type SeededSeller,
} from "./fixture-db.js";

import { createSessionIdempotencyKey } from "../apps/web/src/tenant/session-client.js";

/**
 * PORT-03 whole-phase commerce action / authorization grant acceptance against
 * the REAL production API image, REAL ON/OFF nginx web images, REAL PostgreSQL
 * and REAL passkeys (Chromium virtual authenticator through the real sign-up UI).
 *
 * WHAT RUNS WHERE, STATED PLAINLY
 *  - Production wrappers through the real edge: passkey sign-up, commerce
 *    session issue (UI) and exchange (headless), every browser/agent/provider
 *    READ, action cancel, grant revoke, both mutation-status readers, provider
 *    attempt recovery, all credential-separation probes and the OFF surface.
 *  - Production wrappers that REFUSE by construction in schema 14 (P0D10:
 *    `internal_fixture` requirement provenance is the only admitted kind and
 *    production rejects it): agent authorize, human approve/reject, agent grant
 *    issue/replace, provider introspect/claim. Each is attempted through the
 *    real edge, its refusal and zero committed mutation are asserted, and the
 *    step is recorded as BLOCKED evidence (`[p03-evidence] BLOCKED ...`).
 *  - Fixture-seeded rows (migrator-only closed cores, mode `internal_fixture`,
 *    exactly as the DB10/DB12/adversarial PostgreSQL suites): requirement
 *    references, authorized actions, issued grants, claims and the concurrent
 *    claim drill. These are never production purchase/grant/claim evidence.
 *
 * No route interception or HTTP mock exists for any journey. The single
 * deterministic browser fault (lost revoke response) is a CDP response-stage
 * failure applied AFTER the fixture independently observes the real commit.
 * Raw `oach_v1_`, `oacs_v1_`, `oas_ag_`, `oas_pr_` and `oag_v1_` values exist
 * only in test memory; evidence lines carry statuses, closed codes and ids only.
 */

const ENABLED_ORIGIN = "https://account.openarc.test:5491";
const NODE_HOST = "127.0.0.1";
const NODE_PORT = 5491;
const OFF_NODE_PORT = 5492;
const NODE_SERVERNAME = "account.openarc.test";
const FIXTURE_CA_PATH = "/tmp/openarc-p03-accept-test.crt";

const CONTROL = "/v2/control/organizations";
const AGENT_EXCHANGE = "/v2/agent/commerce-sessions/exchange";
const ACTION_CAPABILITIES = "/v2/public/action-capabilities";
const GRANT_CAPABILITIES = "/v2/public/grant-capabilities";

const CANONICAL_ACCOUNT =
  /^openarc:account:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const CANONICAL_HANDOFF = /^oach_v1_[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/u;
const CANONICAL_SESSION_TOKEN = /^oacs_v1_[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/u;
const CANONICAL_GRANT_TOKEN = /^oag_v1_[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/u;

function evidence(label: string, value: Readonly<Record<string, unknown>>): void {
  // Non-secret only: statuses, closed codes, booleans and canonical ids.
  process.stdout.write(`[p03-evidence] ${label} ${JSON.stringify(value)}\n`);
}

function syntheticToken(prefix: "oacs_v1_" | "oas_pr_" | "oas_ag_" | "oag_v1_"): string {
  // Well-formed but never registered anywhere: not a credential.
  return `${prefix}${randomBytes(32).toString("base64url")}`;
}

/* -------------------------------------------------------------------------- */
/* Real passkey UI sign-up (accepted pattern)                                  */
/* -------------------------------------------------------------------------- */

async function withSignedInAccount(page: Page, run: (accountId: string) => Promise<void>): Promise<void> {
  await page.goto("/account");
  await expect(page.getByRole("heading", { name: "Sign in or create an account" })).toBeVisible();
  const client: CDPSession = await page.context().newCDPSession(page);
  await client.send("WebAuthn.enable", { enableUI: false });
  const { authenticatorId } = await client.send("WebAuthn.addVirtualAuthenticator", {
    options: {
      protocol: "ctap2", ctap2Version: "ctap2_1", transport: "internal", hasResidentKey: true,
      hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true,
    },
  });
  try {
    await page.getByRole("checkbox").check();
    await page.getByRole("button", { name: "Create a passkey" }).click();
    const accountIdElement = page.getByTestId("account-id");
    await expect(accountIdElement).toBeVisible();
    const accountId = (await accountIdElement.innerText()).trim();
    expect(CANONICAL_ACCOUNT.test(accountId)).toBe(true);
    await run(accountId);
  } finally {
    await client.send("WebAuthn.removeVirtualAuthenticator", { authenticatorId }).catch(() => undefined);
  }
}

async function selectOrganization(page: Page, organizationId: string): Promise<void> {
  await page.locator(".tenant-rail--static .tenant-org-select").selectOption({ value: organizationId });
  await expect(page.locator(".tenant-org-select").first()).toHaveValue(organizationId);
}

/* -------------------------------------------------------------------------- */
/* Node HTTPS through the REAL nginx at the fixed loopback origins             */
/* -------------------------------------------------------------------------- */

let fixtureCaCache: Buffer | null = null;
function fixtureCa(): Buffer {
  if (process.env["OPENARC_COMMERCE_PRODUCTION_FIXTURE"] !== "1") throw new Error("FIXTURE_DISABLED");
  fixtureCaCache ??= readFileSync(FIXTURE_CA_PATH);
  return fixtureCaCache;
}

interface NodeResponse {
  readonly status: number;
  readonly contentType: string;
  readonly setCookie: boolean;
  readonly corsAllowOrigin: boolean;
  readonly envelopeOk: boolean;
  readonly errorCode: string | null;
  readonly dataStatus: string | null;
  readonly itemStatus: string | null;
  readonly grantRevoked: boolean | null;
  readonly receiptOperation: string | null;
  readonly capabilityStates: readonly string[] | null;
  readonly hasGrantToken: boolean;
  readonly spaShell: boolean;
  readonly html404: boolean;
  /** Transient raw commerce session token from a first exchange delivery. */
  readonly sessionToken: string | null;
}

function safe(response: NodeResponse): Record<string, unknown> {
  return {
    status: response.status, contentType: response.contentType.split(";")[0] ?? "",
    errorCode: response.errorCode, dataStatus: response.dataStatus, itemStatus: response.itemStatus,
    grantRevoked: response.grantRevoked, receiptOperation: response.receiptOperation,
    capabilityStates: response.capabilityStates, hasGrantToken: response.hasGrantToken,
    spaShell: response.spaShell, html404: response.html404,
  };
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function project(status: number, contentType: string, setCookie: boolean, cors: boolean, text: string): NodeResponse {
  let body: Record<string, unknown> | null = null;
  try {
    body = record(JSON.parse(text));
  } catch {
    body = null;
  }
  const data = record(body?.["data"]);
  const item = record(data?.["item"]);
  const receipt = record(data?.["receipt"]);
  const delivery = record(data?.["delivery"]);
  const rawSession = delivery?.["sessionToken"];
  const rawGrant = data?.["grantToken"];
  if (typeof rawSession === "string") expect(CANONICAL_SESSION_TOKEN.test(rawSession)).toBe(true);
  if (typeof rawGrant === "string") expect(CANONICAL_GRANT_TOKEN.test(rawGrant)).toBe(true);
  const capabilities = data?.["capabilities"];
  return {
    status,
    contentType,
    setCookie,
    corsAllowOrigin: cors,
    envelopeOk: body?.["ok"] === true,
    errorCode: typeof record(body?.["error"])?.["code"] === "string" ? String(record(body?.["error"])?.["code"]) : null,
    dataStatus: typeof data?.["status"] === "string" ? String(data["status"]) : null,
    itemStatus: typeof item?.["status"] === "string" ? String(item["status"]) : null,
    grantRevoked: typeof item?.["grantRevoked"] === "boolean" ? Boolean(item["grantRevoked"]) : null,
    receiptOperation: typeof receipt?.["operation"] === "string" ? String(receipt["operation"]) : null,
    capabilityStates: Array.isArray(capabilities)
      ? capabilities.map((entry) => String(record(entry)?.["state"] ?? ""))
      : null,
    hasGrantToken: typeof rawGrant === "string",
    spaShell: ['id="root"', "<script", 'type="module"', "/assets/"].some((marker) => text.includes(marker)),
    html404: text.includes("404 Not Found"),
    sessionToken: typeof rawSession === "string" ? rawSession : null,
  };
}

async function nodeRequest(input: {
  readonly method: "GET" | "POST";
  readonly path: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string | null;
  readonly port?: number;
}): Promise<NodeResponse> {
  const ca = fixtureCa();
  const port = input.port ?? NODE_PORT;
  if (port !== NODE_PORT && port !== OFF_NODE_PORT) throw new Error("NODE_PORT_NOT_FIXED");
  return await new Promise<NodeResponse>((resolve, reject) => {
    const request = httpsRequest(
      {
        host: NODE_HOST, port, servername: NODE_SERVERNAME, method: input.method, path: input.path,
        ca, rejectUnauthorized: true, agent: false, timeout: 15_000,
        headers: {
          Host: NODE_SERVERNAME, Accept: "application/json", ...input.headers,
          ...(input.body === null ? {} : { "Content-Length": String(Buffer.byteLength(input.body, "utf8")) }),
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        let length = 0;
        response.on("data", (chunk: Buffer) => {
          length += chunk.length;
          if (length > 256 * 1024) {
            request.destroy();
            reject(new Error("NODE_RESPONSE_TOO_LARGE"));
            return;
          }
          chunks.push(chunk);
        });
        response.on("end", () => {
          const setCookie = response.headers["set-cookie"];
          resolve(project(
            response.statusCode ?? 0,
            response.headers["content-type"] ?? "",
            setCookie !== undefined && setCookie.length > 0,
            response.headers["access-control-allow-origin"] !== undefined,
            Buffer.concat(chunks).toString("utf8"),
          ));
        });
        response.on("error", reject);
      },
    );
    request.on("timeout", () => request.destroy(new Error("NODE_TIMEOUT")));
    request.on("error", reject);
    if (input.body !== null) request.write(input.body);
    request.end();
  });
}

const json = (value: unknown): string => JSON.stringify(value);
const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });
const headlessWrite = (token: string) => ({
  ...bearer(token), "Content-Type": "application/json", "Idempotency-Key": createSessionIdempotencyKey(),
});
const browserHeaders = {
  "X-OpenArc-Client": "browser-v1", Origin: ENABLED_ORIGIN,
  "Sec-Fetch-Site": "same-origin", "Sec-Fetch-Mode": "cors", "Sec-Fetch-Dest": "empty",
};

const agent = {
  authorize: (commerceToken: string, actionId: string, requirementId: string) => nodeRequest({
    method: "POST", path: "/v2/agent/commerce-actions", headers: headlessWrite(commerceToken),
    body: json({ mutationId: randomUUID(), actionId, requirementId }),
  }),
  actionDetail: (token: string, actionId: string, extra: Record<string, string> = {}) => nodeRequest({
    method: "GET", path: `/v2/agent/commerce-actions/${actionId}`, headers: { ...bearer(token), ...extra }, body: null,
  }),
  actionMutation: (token: string, mutationId: string) => nodeRequest({
    method: "GET", path: `/v2/agent/commerce-action-mutations/${mutationId}`, headers: bearer(token), body: null,
  }),
  issue: (token: string, actionId: string) => nodeRequest({
    method: "POST", path: "/v2/agent/commerce-grants", headers: headlessWrite(token),
    body: json({ mutationId: randomUUID(), actionId }),
  }),
  replace: (token: string, grantId: string) => nodeRequest({
    method: "POST", path: `/v2/agent/commerce-grants/${grantId}/replace`, headers: headlessWrite(token),
    body: json({ mutationId: randomUUID() }),
  }),
  grantMutation: (token: string, mutationId: string) => nodeRequest({
    method: "GET", path: `/v2/agent/commerce-grant-mutations/${mutationId}`, headers: bearer(token), body: null,
  }),
};

const provider = {
  introspect: (providerToken: string | null, grantToken: string) => nodeRequest({
    method: "POST", path: "/v2/provider/grants/introspect",
    headers: { ...(providerToken === null ? {} : bearer(providerToken)), "Content-Type": "application/json" },
    body: json({ grantToken }),
  }),
  claim: (providerToken: string | null, grantToken: string, actionId: string, attemptId: string) => nodeRequest({
    method: "POST", path: "/v2/provider/grants/claim",
    headers: {
      ...(providerToken === null ? {} : bearer(providerToken)),
      "Content-Type": "application/json", "Idempotency-Key": createSessionIdempotencyKey(),
    },
    body: json({ mutationId: randomUUID(), grantToken, expectedActionId: actionId, attemptId }),
  }),
  attempt: (providerToken: string, attemptId: string, extra: Record<string, string> = {}) => nodeRequest({
    method: "GET", path: `/v2/provider/grant-attempts/${attemptId}`, headers: { ...bearer(providerToken), ...extra }, body: null,
  }),
};

/* -------------------------------------------------------------------------- */
/* Buyer chain: real passkey owner, real policy store, UI issue, edge exchange */
/* -------------------------------------------------------------------------- */

interface BuyerChain {
  readonly accountId: string;
  readonly organizationId: string;
  readonly agentId: string;
  readonly policyId: string;
  readonly seller: SeededSeller;
  /** Raw `oacs_v1_` from the one-time exchange delivery: test memory only. */
  readonly commerceToken: string;
  /** Raw `oas_ag_` machine session token: test memory only. */
  readonly agentToken: string;
}

async function establishBuyerChain(page: Page, accountId: string, label: string): Promise<BuyerChain> {
  const organizationId = (await seedOwnOrganizations(accountId, [`Synthetic Buyer ${label}`]))[0]?.organizationId;
  if (organizationId === undefined) throw new Error("SEED_ORGANIZATION_MISSING");
  const agentProfile = (await seedAgents(organizationId, 1))[0];
  if (agentProfile === undefined) throw new Error("SEED_AGENT_MISSING");
  const seller = await seedSellerListing();
  const policyId = await seedBuyerPolicy(accountId, organizationId, agentProfile.id, seller.providerId);

  // Production path: human issues the commerce session through the real UI.
  await page.goto("/app/sessions/new");
  await selectOrganization(page, organizationId);
  await expect(page.getByRole("heading", { name: "One-time handoff" })).toBeVisible();
  const loadAgents = page.getByRole("button", { name: "Load agents" });
  if ((await loadAgents.count()) > 0) await loadAgents.click();
  const agentSelect = page.getByLabel("Active agent");
  await expect(agentSelect.locator(`option[value="${agentProfile.id}"]`)).toBeAttached();
  await agentSelect.selectOption(agentProfile.id);
  await page.getByLabel("Policy ID").fill(policyId);
  await page.getByLabel("Duration (seconds, 1–900)").fill("900");
  await page.getByRole("button", { name: "Review issue" }).click();
  await page.getByRole("button", { name: "Confirm issue" }).click();
  const secret = page.getByLabel("New one-time handoff token");
  await expect(secret).toBeVisible({ timeout: 20_000 });
  const handoffToken = (await secret.inputValue()).trim();
  expect(CANONICAL_HANDOFF.test(handoffToken)).toBe(true);

  // Production path: headless agent exchanges through the real nginx edge.
  const machine = await seedAgentMachineSession(accountId, organizationId, agentProfile.id);
  const exchange = await nodeRequest({
    method: "POST", path: AGENT_EXCHANGE, headers: headlessWrite(machine.agentToken),
    body: json({ mutationId: randomUUID(), handoffToken }),
  });
  evidence(`${label} production exchange`, safe(exchange));
  expect(exchange.status).toBe(200);
  expect(exchange.sessionToken).not.toBeNull();
  return {
    accountId, organizationId, agentId: agentProfile.id, policyId, seller,
    commerceToken: exchange.sessionToken as string, agentToken: machine.agentToken,
  };
}

async function fixtureReservedGrant(chain: BuyerChain, amount = "1000000") {
  const requirementId = await seedFixtureRequirement(chain.organizationId, chain.seller, amount);
  const action = await fixtureAuthorize(chain.commerceToken, requirementId);
  expect(action.status).toBe("reserved_not_granted");
  const grant = await fixtureIssueGrant(chain.commerceToken, action.actionId);
  return { requirementId, action, grant };
}

async function openGrant(page: Page, organizationId: string, grantId: string): Promise<void> {
  await page.goto("/app/grants");
  await selectOrganization(page, organizationId);
  await page.getByLabel("Grant ID").fill(grantId);
  await page.getByRole("button", { name: "Open this grant" }).click();
  await expect(page.getByRole("heading", { name: new RegExp(`Grant\\s+${grantId}`, "u") })).toBeVisible({ timeout: 20_000 });
}

/* ========================================================================== */

test.describe("PORT-03 commerce actions and grants, production ON", { tag: "@commerce-on" }, () => {
  test("J1 human: passkey owner, organization, agent, policy and UI commerce session; browse action console and approval queue; approve/reject refused by P0D10, cancel commits; exposure view shows exact values", async ({ page }) => {
    await withSignedInAccount(page, async (accountId) => {
      const chain = await establishBuyerChain(page, accountId, "J1");

      // BLOCKED by construction: production authorize of a fixture requirement.
      const pendingRequirements = await Promise.all(
        ["3000000", "3000000", "3000000"].map((amount) => seedFixtureRequirement(chain.organizationId, chain.seller, amount)),
      );
      const reservedRequirement = await seedFixtureRequirement(chain.organizationId, chain.seller, "1000000");
      const refused = await agent.authorize(chain.commerceToken, `openarc:action:${randomUUID()}`, reservedRequirement);
      evidence("BLOCKED J1 production authorize (P0D10)", safe(refused));
      expect(refused.status).toBe(503);
      expect(refused.errorCode).toBe("INTERNAL_ERROR");
      expect((await countCommerceRows(chain.organizationId)).actions).toBe(0);

      // FIXTURE-SEEDED: three above-threshold (pending approval) + one reserved action.
      const pending = [];
      for (const requirement of pendingRequirements) pending.push(await fixtureAuthorize(chain.commerceToken, requirement));
      const reserved = await fixtureAuthorize(chain.commerceToken, reservedRequirement);
      for (const action of pending) expect(action.status).toBe("pending_approval");
      expect(reserved.status).toBe("reserved_not_granted");
      const [toApprove, toReject, toCancel] = pending;
      if (toApprove === undefined || toReject === undefined || toCancel === undefined) throw new Error("SEED_ACTIONS_MISSING");

      // Production reads: action console and approval queue.
      await page.goto("/app/actions");
      await selectOrganization(page, chain.organizationId);
      for (const action of [...pending, reserved]) {
        await expect(page.getByRole("button", { name: `Open action ${action.actionId}`, exact: true })).toBeVisible({ timeout: 20_000 });
      }
      await page.goto("/app/actions/approvals");
      await selectOrganization(page, chain.organizationId);
      for (const action of pending) {
        await expect(page.getByRole("button", { name: `Open approval ${action.approvalId}`, exact: true })).toBeVisible({ timeout: 20_000 });
      }
      await expect(page.getByRole("button", { name: `Open action ${reserved.actionId}`, exact: true })).toHaveCount(0);

      const decide = async (actionId: string, verb: "Approve" | "Reject" | "Cancel action") => {
        await page.goto(`/app/actions/${encodeURIComponent(actionId)}`);
        await selectOrganization(page, chain.organizationId);
        await expect(page.getByRole("heading", { name: new RegExp(`Action\\s+${actionId}`, "u") })).toBeVisible({ timeout: 20_000 });
        await page.getByRole("button", { name: verb, exact: true }).click();
        await expect(page.getByRole("heading", { name: `Confirm: ${verb}` })).toBeVisible();
        const posted = page.waitForRequest((r) => r.method() === "POST" && r.url().includes("/actions/"));
        const responded = page.waitForResponse((r) => r.request().method() === "POST" && r.url().includes("/actions/"));
        await page.getByRole("button", { name: `${verb} now`, exact: true }).click();
        const request = await posted;
        const response = await responded;
        const mutationId = String((JSON.parse(request.postData() ?? "{}") as { mutationId?: unknown }).mutationId);
        return { status: response.status(), mutationId };
      };

      // Approve and reject: production decide wrappers refuse fixture provenance.
      for (const [action, verb] of [[toApprove, "Approve"], [toReject, "Reject"]] as const) {
        const outcome = await decide(action.actionId, verb);
        await expect(page.getByRole("heading", { name: "The outcome is unknown" })).toBeVisible({ timeout: 20_000 });
        await page.getByRole("button", { name: "Check status once" }).click();
        await expect(page.getByText(/No committed result found yet\./u)).toBeVisible({ timeout: 20_000 });
        const state = await readActionState(chain.organizationId, action.actionId);
        const durable = await countDurableRows(chain.organizationId, outcome.mutationId);
        evidence(`BLOCKED J1 production ${verb} (P0D10)`, { httpStatus: outcome.status, state, durable });
        expect(outcome.status).toBe(503);
        expect(state).toMatchObject({ status: "pending_approval", approvalStatus: "pending", reservationStatus: null });
        expect(durable).toEqual({ idempotency: 0, audit: 0, outbox: 0 });
      }
      expect((await countCommerceRows(chain.organizationId)).decidedApprovals).toBe(0);

      // Cancel: production wrapper (no provenance mode) commits through the console.
      const cancelled = await decide(toCancel.actionId, "Cancel action");
      await expect(page.getByRole("heading", { name: "Decision committed" })).toBeVisible({ timeout: 20_000 });
      const cancelState = await readActionState(chain.organizationId, toCancel.actionId);
      const cancelDurable = await countDurableRows(chain.organizationId, cancelled.mutationId);
      evidence("PASS J1 production cancel", { httpStatus: cancelled.status, cancelState, cancelDurable });
      expect(cancelled.status).toBe(200);
      expect(cancelState?.status).toBe("cancelled");
      expect(cancelDurable).toEqual({ idempotency: 1, audit: 1, outbox: 1 });

      // Exposure view: exact atomic values, cross-checked against the API read.
      await page.goto("/app/actions/exposure");
      await selectOrganization(page, chain.organizationId);
      await page.getByLabel("Subject agent ID").fill(chain.agentId);
      await page.getByLabel("Policy ID").fill(chain.policyId);
      await page.getByRole("button", { name: "Read exposure" }).click();
      const atomic = page.locator(".tenant-actions-console__atomic");
      await expect(atomic.first()).toBeVisible({ timeout: 20_000 });
      const shown = (await atomic.allInnerTexts()).map((text) => text.trim());
      const api = await page.evaluate(async (path) => {
        const response = await fetch(path, {
          credentials: "same-origin", cache: "no-store",
          headers: { "X-OpenArc-Client": "browser-v1", Accept: "application/json" },
        });
        const body = (await response.json()) as { data?: { item?: Record<string, unknown> | null } };
        const item = body.data?.item ?? null;
        return item === null ? null : {
          committedAtomic: item["committedAtomic"], unresolvedAtomic: item["unresolvedAtomic"],
          totalExposureAtomic: item["totalExposureAtomic"], availableAtomic: item["availableAtomic"],
          deficitAtomic: item["deficitAtomic"],
        };
      }, `${CONTROL}/${encodeURIComponent(chain.organizationId)}/agents/${encodeURIComponent(chain.agentId)}/policies/${encodeURIComponent(chain.policyId)}/exposure`);
      const expected = {
        committedAtomic: "0", unresolvedAtomic: "1000000", totalExposureAtomic: "1000000",
        availableAtomic: String(BigInt(POLICY_ROLLING_LIMIT) - 1000000n), deficitAtomic: "0",
      };
      evidence("PASS J1 exposure", { shown, api });
      expect(api).toEqual(expected);
      for (const value of Object.values(expected)) {
        expect(shown).toContain(`${value} atomic (6 decimals)`);
      }
    });
  });

  test("J2 headless agent: exchange (production), authorize refused by P0D10, status reads of a fixture action, grant issue/replace refused by P0D10, grant mutation recovery never re-delivers the token", async ({ page }) => {
    await withSignedInAccount(page, async (accountId) => {
      const chain = await establishBuyerChain(page, accountId, "J2");

      for (const [path, count] of [[ACTION_CAPABILITIES, 2], [GRANT_CAPABILITIES, 3]] as const) {
        const manifest = await nodeRequest({ method: "GET", path, headers: {}, body: null });
        evidence(`PASS J2 capability ${path}`, safe(manifest));
        expect(manifest.status).toBe(200);
        expect(manifest.capabilityStates).toEqual(Array.from({ length: count }, () => "enabled"));
      }

      const requirementId = await seedFixtureRequirement(chain.organizationId, chain.seller, "1000000");
      const authorize = await agent.authorize(chain.commerceToken, `openarc:action:${randomUUID()}`, requirementId);
      evidence("BLOCKED J2 production authorize (P0D10)", safe(authorize));
      expect(authorize.status).toBe(503);
      expect(authorize.errorCode).toBe("INTERNAL_ERROR");
      expect(await countCommerceRows(chain.organizationId)).toMatchObject({ actions: 0, reservations: 0 });

      const action = await fixtureAuthorize(chain.commerceToken, requirementId);
      const detail = await agent.actionDetail(chain.commerceToken, action.actionId);
      const mutation = await agent.actionMutation(chain.commerceToken, action.mutationId);
      const missing = await agent.actionMutation(chain.commerceToken, randomUUID());
      evidence("PASS J2 agent action status reads (fixture action)", { detail: safe(detail), mutation: safe(mutation), missing: safe(missing) });
      expect(detail.status).toBe(200);
      expect(detail.itemStatus).toBe("reserved_not_granted");
      expect(mutation.status).toBe(200);
      expect(mutation.dataStatus).toBe("committed");
      expect(mutation.receiptOperation).toBe("control.commerce_action.authorize");
      expect(missing.dataStatus).toBe("not_found");

      const issue = await agent.issue(chain.commerceToken, action.actionId);
      evidence("BLOCKED J2 production grant issue (P0D10)", safe(issue));
      expect(issue.status).toBe(503);
      expect(issue.errorCode).toBe("INTERNAL_ERROR");
      expect(issue.hasGrantToken).toBe(false);
      expect(await countCommerceRows(chain.organizationId)).toMatchObject({ grants: 0, tokens: 0 });

      const grant = await fixtureIssueGrant(chain.commerceToken, action.actionId);
      const replace = await agent.replace(chain.commerceToken, grant.grantId);
      const afterReplace = await readGrantState(chain.organizationId, grant.grantId);
      evidence("BLOCKED J2 production grant replace (P0D10)", { replace: safe(replace), afterReplace });
      expect(replace.status).toBe(503);
      expect(replace.hasGrantToken).toBe(false);
      expect(afterReplace).toMatchObject({ status: "issued", generation: 1, claims: 0 });
      expect((await countCommerceRows(chain.organizationId)).tokens).toBe(1);

      const recovered = await agent.grantMutation(chain.commerceToken, grant.mutationId);
      evidence("PASS J2 agent grant mutation recovery (fixture issue)", safe(recovered));
      expect(recovered.status).toBe(200);
      expect(recovered.dataStatus).toBe("committed");
      expect(recovered.receiptOperation).toBe("control.grant.issue");
      expect(recovered.hasGrantToken).toBe(false);
    });
  });

  test("J3+J5 provider: two-token introspect/claim refused by P0D10 through the edge, each single credential denied, fixture claim recovered by attempt id; concurrent edge claims elect no winner while concurrent fixture-core claims elect exactly one", async ({ page }) => {
    await withSignedInAccount(page, async (accountId) => {
      const chain = await establishBuyerChain(page, accountId, "J3");
      const first = await fixtureReservedGrant(chain);
      const second = await fixtureReservedGrant(chain);
      const session = await seedProviderMachineSession(chain.seller);

      const introspect = await provider.introspect(session.providerToken, first.grant.grantToken);
      const claim = await provider.claim(session.providerToken, first.grant.grantToken, first.action.actionId, randomUUID());
      evidence("BLOCKED J3 production two-token introspect/claim (P0D10)", { introspect: safe(introspect), claim: safe(claim) });
      expect(introspect.status).toBe(503);
      expect(claim.status).toBe(503);

      const singles = {
        grantTokenOnlyIntrospect: await provider.introspect(null, first.grant.grantToken),
        grantTokenOnlyClaim: await provider.claim(null, first.grant.grantToken, first.action.actionId, randomUUID()),
        grantTokenWithUnknownProviderSession: await provider.claim(syntheticToken("oas_pr_"), first.grant.grantToken, first.action.actionId, randomUUID()),
        providerSessionOnlyIntrospect: await provider.introspect(session.providerToken, syntheticToken("oag_v1_")),
        providerSessionOnlyClaim: await provider.claim(session.providerToken, syntheticToken("oag_v1_"), first.action.actionId, randomUUID()),
      };
      evidence("PASS J3 single-credential denials", Object.fromEntries(Object.entries(singles).map(([k, v]) => [k, safe(v)])));
      expect(singles.grantTokenOnlyIntrospect.status).toBe(403);
      expect(singles.grantTokenOnlyClaim.status).toBe(403);
      for (const denied of [singles.grantTokenWithUnknownProviderSession, singles.providerSessionOnlyIntrospect, singles.providerSessionOnlyClaim]) {
        expect([401, 403]).toContain(denied.status);
        expect(denied.spaShell).toBe(false);
      }
      expect(await readGrantState(chain.organizationId, first.grant.grantId)).toMatchObject({ status: "issued", claims: 0 });

      const attemptId = randomUUID();
      await fixtureClaimGrant(session.providerToken, first.grant.grantToken, first.action.actionId, attemptId);
      const recovered = await provider.attempt(session.providerToken, attemptId);
      const unknown = await provider.attempt(session.providerToken, randomUUID());
      evidence("PASS J3 provider attempt recovery (fixture claim)", { recovered: safe(recovered), unknown: safe(unknown) });
      expect(recovered.status).toBe(200);
      expect(recovered.itemStatus).toBe("claimed");
      expect(recovered.grantRevoked).toBe(false);
      expect(unknown.status).toBe(200);
      expect(unknown.itemStatus).toBe("not_found");

      // J5 through the real edge: two simultaneous two-token claims.
      const [edgeA, edgeB] = await Promise.all([
        provider.claim(session.providerToken, second.grant.grantToken, second.action.actionId, randomUUID()),
        provider.claim(session.providerToken, second.grant.grantToken, second.action.actionId, randomUUID()),
      ]);
      const afterEdge = await readGrantState(chain.organizationId, second.grant.grantId);
      evidence("BLOCKED J5 concurrent edge claims (P0D10: zero winners)", { a: safe(edgeA), b: safe(edgeB), afterEdge });
      expect([edgeA.status, edgeB.status].filter((status) => status === 200)).toHaveLength(0);
      expect(afterEdge?.claims).toBe(0);

      // J5 FIXTURE: the same race on two separate migrator connections.
      const drill = await fixtureConcurrentClaims(session.providerToken, second.grant.grantToken, second.action.actionId);
      const afterDrill = await readGrantState(chain.organizationId, second.grant.grantId);
      evidence("FIXTURE J5 concurrent core claims", { ...drill, afterDrill });
      expect(drill.winners).toBe(1);
      expect(drill.loserStates).toHaveLength(1);
      expect(afterDrill).toMatchObject({ status: "claimed", claims: 1 });
    });
  });

  test("J4 revocation after claim: the browser console revokes a claimed grant and states the claim is retained and the grant may still have been paid, never a refund", async ({ page }) => {
    await withSignedInAccount(page, async (accountId) => {
      const chain = await establishBuyerChain(page, accountId, "J4");
      const { action, grant } = await fixtureReservedGrant(chain);
      const session = await seedProviderMachineSession(chain.seller);
      const attemptId = randomUUID();
      await fixtureClaimGrant(session.providerToken, grant.grantToken, action.actionId, attemptId);

      await openGrant(page, chain.organizationId, grant.grantId);
      await expect(page.getByText("Claimed", { exact: true }).first()).toBeVisible();
      await page.getByRole("button", { name: "Revoke this grant" }).click();
      await expect(page.getByRole("heading", { name: "Confirm: revoke this grant" })).toBeVisible();
      const responded = page.waitForResponse((r) => r.request().method() === "POST" && r.url().endsWith("/revoke"));
      await page.getByRole("button", { name: "Revoke now" }).click();
      const response = await responded;
      await expect(page.getByRole("heading", { name: /^Grant (already )?revoked$/u })).toBeVisible({ timeout: 20_000 });
      await page.getByRole("button", { name: "Refresh from the server" }).click();
      const notice = page.getByText(/This grant was claimed before it was revoked\./u).first();
      await expect(notice).toBeVisible({ timeout: 20_000 });
      const noticeText = await notice.innerText();
      expect(noticeText).toContain("the claim fact is retained");
      expect(noticeText).toContain("this grant may still have been paid");
      expect(noticeText).toContain("Revocation is not a refund");
      const bodyText = await page.locator("body").innerText();
      expect(bodyText).not.toMatch(/\b(?:was|were|has been|have been|is being) refunded\b|\brefund (?:issued|completed|processed)\b|\bmoney (?:was )?(?:returned|given back)\b/iu);

      const state = await readGrantState(chain.organizationId, grant.grantId);
      const status = await provider.attempt(session.providerToken, attemptId);
      evidence("PASS J4 revoke after claim", { httpStatus: response.status(), state, attempt: safe(status) });
      expect(response.status()).toBe(200);
      expect(state).toMatchObject({ status: "revoked", claimed: true, revoked: true, claims: 1, releasedEvents: 0, revokeRecords: 1 });
      expect(state?.reservationStatus).not.toBe("released");
      expect(status.itemStatus).toBe("claimed");
      expect(status.grantRevoked).toBe(true);
    });
  });

  test("J6 safe recovery: a revoke whose response is dropped after the real commit recovers through one explicit status check with the original mutation id and no second mutation", async ({ page }) => {
    await withSignedInAccount(page, async (accountId) => {
      const chain = await establishBuyerChain(page, accountId, "J6");
      const { grant } = await fixtureReservedGrant(chain);
      await openGrant(page, chain.organizationId, grant.grantId);
      await page.getByRole("button", { name: "Revoke this grant" }).click();
      await expect(page.getByRole("heading", { name: "Confirm: revoke this grant" })).toBeVisible();

      const revokePosts: string[] = [];
      const statusGets: string[] = [];
      page.on("request", (request) => {
        const url = new URL(request.url());
        if (!url.pathname.startsWith(`${CONTROL}/`)) return;
        if (request.method() === "POST") revokePosts.push(url.pathname);
        if (request.method() === "GET" && /\/grant-mutations\/[^/]+$/u.test(url.pathname)) statusGets.push(url.pathname);
      });

      const client = await page.context().newCDPSession(page);
      try {
        let faultInstalled = true;
        let settle: ((value: { confirmed: boolean; mutationId: string | null }) => void) | null = null;
        const decision = new Promise<{ confirmed: boolean; mutationId: string | null }>((resolve) => { settle = resolve; });
        client.on("Fetch.requestPaused", async (event) => {
          const isRevoke = event.request.method === "POST" && new URL(event.request.url).pathname.endsWith("/revoke");
          if (!isRevoke || event.responseStatusCode === undefined || !faultInstalled) {
            await client.send("Fetch.continueRequest", { requestId: event.requestId }).catch(() => undefined);
            return;
          }
          let mutationId: string | null = null;
          try {
            const parsed = JSON.parse(event.request.postData ?? "{}") as { mutationId?: unknown };
            mutationId = typeof parsed.mutationId === "string" ? parsed.mutationId : null;
          } catch {
            mutationId = null;
          }
          let confirmed = false;
          for (let attempt = 0; mutationId !== null && attempt < 40; attempt += 1) {
            if ((await readDurableReceipt(chain.organizationId, mutationId))?.operation === "control.grant.revoke") {
              confirmed = true;
              break;
            }
            await new Promise<void>((resolve) => setTimeout(resolve, 50));
          }
          settle?.({ confirmed, mutationId });
          await client
            .send(confirmed ? "Fetch.failRequest" : "Fetch.continueRequest",
              confirmed ? { requestId: event.requestId, errorReason: "Failed" } : { requestId: event.requestId })
            .catch(() => undefined);
        });
        await client.send("Fetch.enable", { patterns: [{ urlPattern: "*", requestStage: "Response" }] });

        await page.getByRole("button", { name: "Revoke now" }).click();
        const observed = await decision;
        expect(observed.confirmed).toBe(true);
        const mutationId = observed.mutationId as string;
        await expect(page.getByRole("heading", { name: "The outcome is unknown" })).toBeVisible({ timeout: 20_000 });
        expect(revokePosts).toHaveLength(1);
        expect(await countDurableRows(chain.organizationId, mutationId)).toEqual({ idempotency: 1, audit: 1, outbox: 1 });

        faultInstalled = false;
        await page.getByRole("button", { name: "Check status once" }).click();
        await expect(page.getByRole("heading", { name: /^Grant (already )?revoked$/u })).toBeVisible({ timeout: 20_000 });
        await expect(page.getByRole("heading", { name: "The outcome is unknown" })).toHaveCount(0);
        const state = await readGrantState(chain.organizationId, grant.grantId);
        const durable = await countDurableRows(chain.organizationId, mutationId);
        evidence("PASS J6 lost revoke response recovery", { revokePosts: revokePosts.length, statusGets: statusGets.length, state, durable });
        expect(revokePosts).toHaveLength(1);
        expect(statusGets).toEqual([`${CONTROL}/${encodeURIComponent(chain.organizationId)}/grant-mutations/${mutationId}`]);
        expect(durable).toEqual({ idempotency: 1, audit: 1, outbox: 1 });
        expect(state).toMatchObject({ status: "revoked", claimed: false, revokeRecords: 1 });
      } finally {
        await client.send("Fetch.disable").catch(() => undefined);
        await client.detach().catch(() => undefined);
      }
    });
  });

  test("J7 credential separation at the real edge: oas_ag_ rejected on agent action/grant routes, commerce bearer rejected on provider routes, cookie rejected on headless routes, bearer rejected on browser routes; each correct credential still succeeds", async ({ page }) => {
    await withSignedInAccount(page, async (accountId) => {
      const chain = await establishBuyerChain(page, accountId, "J7");
      const { action, grant } = await fixtureReservedGrant(chain);
      const session = await seedProviderMachineSession(chain.seller);
      const attemptId = randomUUID();
      await fixtureClaimGrant(session.providerToken, grant.grantToken, action.actionId, attemptId);
      const before = await countCommerceRows(chain.organizationId);
      const org = chain.organizationId;

      const machineOnAgent = {
        authorize: await agent.authorize(chain.agentToken, `openarc:action:${randomUUID()}`, `openarc:requirement:${randomUUID()}`),
        actionDetail: await agent.actionDetail(chain.agentToken, action.actionId),
        actionMutation: await agent.actionMutation(chain.agentToken, action.mutationId),
        grantIssue: await agent.issue(chain.agentToken, action.actionId),
        grantReplace: await agent.replace(chain.agentToken, grant.grantId),
        grantMutation: await agent.grantMutation(chain.agentToken, grant.mutationId),
      };
      const commerceOnProvider = {
        introspect: await provider.introspect(chain.commerceToken, grant.grantToken),
        claim: await provider.claim(chain.commerceToken, grant.grantToken, action.actionId, randomUUID()),
        attempt: await provider.attempt(chain.commerceToken, attemptId),
      };
      const cookieOnHeadless = {
        agentDetailWithCookie: await agent.actionDetail(chain.commerceToken, action.actionId, { Cookie: "openarc_session=synthetic" }),
        providerAttemptWithCookie: await provider.attempt(session.providerToken, attemptId, { Cookie: "openarc_session=synthetic" }),
        realBrowserCookie: await page.evaluate(async (paths) => {
          const statuses: number[] = [];
          for (const path of paths) {
            const response = await fetch(path, { credentials: "same-origin", cache: "no-store", headers: { Accept: "application/json" } });
            statuses.push(response.status);
          }
          return statuses;
        }, [`/v2/agent/commerce-actions/${action.actionId}`, `/v2/agent/commerce-grant-mutations/${grant.mutationId}`, `/v2/provider/grant-attempts/${attemptId}`]),
      };
      const bearerOnBrowser = {
        actionListCommerce: await nodeRequest({ method: "GET", path: `${CONTROL}/${org}/actions`, headers: { ...browserHeaders, ...bearer(chain.commerceToken) }, body: null }),
        grantDetailCommerce: await nodeRequest({ method: "GET", path: `${CONTROL}/${org}/grants/${grant.grantId}`, headers: { ...browserHeaders, ...bearer(chain.commerceToken) }, body: null }),
        grantRevokeProvider: await nodeRequest({ method: "POST", path: `${CONTROL}/${org}/grants/${grant.grantId}/revoke`, headers: { ...browserHeaders, ...bearer(session.providerToken), "Content-Type": "application/json", "X-OpenArc-CSRF": "synthetic", "Idempotency-Key": createSessionIdempotencyKey() }, body: json({ mutationId: randomUUID() }) }),
        actionCancelMachine: await nodeRequest({ method: "POST", path: `${CONTROL}/${org}/actions/${action.actionId}/cancel`, headers: { ...browserHeaders, ...bearer(chain.agentToken), "Content-Type": "application/json", "X-OpenArc-CSRF": "synthetic", "Idempotency-Key": createSessionIdempotencyKey() }, body: json({ mutationId: randomUUID() }) }),
      };
      const counterproofs = {
        agentDetail: await agent.actionDetail(chain.commerceToken, action.actionId),
        providerAttempt: await provider.attempt(session.providerToken, attemptId),
        browserActionList: await page.evaluate(async (path) => (await fetch(path, { credentials: "same-origin", cache: "no-store", headers: { "X-OpenArc-Client": "browser-v1", Accept: "application/json" } })).status, `${CONTROL}/${encodeURIComponent(org)}/actions`),
        browserGrantDetail: await page.evaluate(async (path) => (await fetch(path, { credentials: "same-origin", cache: "no-store", headers: { "X-OpenArc-Client": "browser-v1", Accept: "application/json" } })).status, `${CONTROL}/${encodeURIComponent(org)}/grants/${encodeURIComponent(grant.grantId)}`),
      };
      const summarize = (group: Record<string, NodeResponse>) => Object.fromEntries(Object.entries(group).map(([k, v]) => [k, safe(v)]));
      evidence("J7 oas_ag_ on agent routes", summarize(machineOnAgent));
      evidence("J7 oacs_v1_ on provider routes", summarize(commerceOnProvider));
      evidence("J7 cookie on headless routes", { ...summarize({ a: cookieOnHeadless.agentDetailWithCookie, b: cookieOnHeadless.providerAttemptWithCookie }), realBrowserCookie: cookieOnHeadless.realBrowserCookie });
      evidence("J7 bearer on browser routes", summarize(bearerOnBrowser));
      evidence("J7 counterproofs", { agentDetail: safe(counterproofs.agentDetail), providerAttempt: safe(counterproofs.providerAttempt), browserActionList: counterproofs.browserActionList, browserGrantDetail: counterproofs.browserGrantDetail });

      for (const denied of [
        ...Object.values(machineOnAgent), ...Object.values(commerceOnProvider),
        cookieOnHeadless.agentDetailWithCookie, cookieOnHeadless.providerAttemptWithCookie, ...Object.values(bearerOnBrowser),
      ]) {
        expect(denied.status).toBe(403);
        expect(denied.spaShell).toBe(false);
        expect(denied.setCookie).toBe(false);
        expect(denied.corsAllowOrigin).toBe(false);
      }
      expect(cookieOnHeadless.realBrowserCookie).toEqual([403, 403, 403]);
      expect(counterproofs.agentDetail.status).toBe(200);
      expect(counterproofs.providerAttempt.itemStatus).toBe("claimed");
      expect(counterproofs.browserActionList).toBe(200);
      expect(counterproofs.browserGrantDetail).toBe(200);
      expect(await countCommerceRows(chain.organizationId)).toEqual(before);
      expect(await readGrantState(chain.organizationId, grant.grantId)).toMatchObject({ status: "claimed", revokeRecords: 0 });
    });
  });
});

/* ========================================================================== */

test.describe("PORT-03 commerce actions and grants, production OFF", { tag: "@commerce-off" }, () => {
  test("J8 OFF: every action and grant route fails closed at the real edge, both capability manifests report built_disabled, the consoles make zero business calls and no route answers 200 text/html", async ({ page }) => {
    await withSignedInAccount(page, async (accountId) => {
      const businessCalls: string[] = [];
      page.on("request", (request) => {
        const path = new URL(request.url()).pathname;
        if (/^\/v2\/control\/organizations\/[^/]+\/(?:actions|approvals|agents|action-mutations|grants|grant-mutations)(?:\/|$)/u.test(path) ||
          path.startsWith("/v2/agent/commerce-action") || path.startsWith("/v2/agent/commerce-grant") || path.startsWith("/v2/provider/grant")) {
          businessCalls.push(path);
        }
      });
      const organizationId = (await seedOwnOrganizations(accountId, ["Synthetic Commerce Off"]))[0]?.organizationId;
      if (organizationId === undefined) throw new Error("SEED_ORGANIZATION_MISSING");
      const agentId = (await seedAgents(organizationId, 1))[0]?.id;
      if (agentId === undefined) throw new Error("SEED_AGENT_MISSING");

      for (const route of ["/app/actions", "/app/actions/approvals", "/app/actions/exposure", "/app/grants"]) {
        await page.goto(route);
        await expect(page.getByRole("heading", { name: "This section is not available yet" })).toBeVisible();
      }
      expect(businessCalls).toEqual([]);

      const off = { port: OFF_NODE_PORT };
      const actionManifest = await nodeRequest({ method: "GET", path: ACTION_CAPABILITIES, headers: {}, body: null, ...off });
      const grantManifest = await nodeRequest({ method: "GET", path: GRANT_CAPABILITIES, headers: {}, body: null, ...off });
      evidence("J8 OFF manifests", { action: safe(actionManifest), grant: safe(grantManifest) });
      expect(actionManifest.status).toBe(200);
      expect(actionManifest.capabilityStates).toEqual(["built_disabled", "built_disabled"]);
      expect(grantManifest.status).toBe(200);
      expect(grantManifest.capabilityStates).toEqual(["built_disabled", "built_disabled", "built_disabled"]);

      const org = organizationId;
      const actionId = `openarc:action:${randomUUID()}`;
      const grantId = `openarc:grant:${randomUUID()}`;
      const policyId = `openarc:policy:${randomUUID()}`;
      const browserWrite = { ...browserHeaders, Origin: "https://account.openarc.test:5492", "Content-Type": "application/json", "X-OpenArc-CSRF": "synthetic", "Idempotency-Key": createSessionIdempotencyKey() };
      const browserRead = { ...browserHeaders, Origin: "https://account.openarc.test:5492" };
      const body = json({ mutationId: randomUUID() });
      const commerce = syntheticToken("oacs_v1_");
      const providerToken = syntheticToken("oas_pr_");
      const routes: readonly { id: string; method: "GET" | "POST"; path: string; headers: Record<string, string>; body: string | null }[] = [
        { id: "action_list", method: "GET", path: `${CONTROL}/${org}/actions`, headers: browserRead, body: null },
        { id: "action_detail", method: "GET", path: `${CONTROL}/${org}/actions/${actionId}`, headers: browserRead, body: null },
        { id: "approval_list", method: "GET", path: `${CONTROL}/${org}/approvals`, headers: browserRead, body: null },
        { id: "approval_detail", method: "GET", path: `${CONTROL}/${org}/approvals/openarc:approval:${randomUUID()}`, headers: browserRead, body: null },
        { id: "action_exposure", method: "GET", path: `${CONTROL}/${org}/agents/${agentId}/policies/${policyId}/exposure`, headers: browserRead, body: null },
        { id: "action_mutation_status", method: "GET", path: `${CONTROL}/${org}/action-mutations/${randomUUID()}`, headers: browserRead, body: null },
        { id: "action_approve", method: "POST", path: `${CONTROL}/${org}/actions/${actionId}/approve`, headers: browserWrite, body },
        { id: "action_reject", method: "POST", path: `${CONTROL}/${org}/actions/${actionId}/reject`, headers: browserWrite, body },
        { id: "action_cancel", method: "POST", path: `${CONTROL}/${org}/actions/${actionId}/cancel`, headers: browserWrite, body },
        { id: "action_authorize", method: "POST", path: "/v2/agent/commerce-actions", headers: headlessWrite(commerce), body: json({ mutationId: randomUUID(), actionId, requirementId: `openarc:requirement:${randomUUID()}` }) },
        { id: "agent_action_detail", method: "GET", path: `/v2/agent/commerce-actions/${actionId}`, headers: bearer(commerce), body: null },
        { id: "agent_action_mutation_status", method: "GET", path: `/v2/agent/commerce-action-mutations/${randomUUID()}`, headers: bearer(commerce), body: null },
        { id: "grant_issue", method: "POST", path: "/v2/agent/commerce-grants", headers: headlessWrite(commerce), body: json({ mutationId: randomUUID(), actionId }) },
        { id: "grant_replace", method: "POST", path: `/v2/agent/commerce-grants/${grantId}/replace`, headers: headlessWrite(commerce), body },
        { id: "agent_grant_mutation_status", method: "GET", path: `/v2/agent/commerce-grant-mutations/${randomUUID()}`, headers: bearer(commerce), body: null },
        { id: "provider_grant_introspect", method: "POST", path: "/v2/provider/grants/introspect", headers: { ...bearer(providerToken), "Content-Type": "application/json" }, body: json({ grantToken: syntheticToken("oag_v1_") }) },
        { id: "provider_grant_claim", method: "POST", path: "/v2/provider/grants/claim", headers: { ...headlessWrite(providerToken) }, body: json({ mutationId: randomUUID(), grantToken: syntheticToken("oag_v1_"), expectedActionId: actionId, attemptId: randomUUID() }) },
        { id: "provider_grant_attempt_status", method: "GET", path: `/v2/provider/grant-attempts/${randomUUID()}`, headers: bearer(providerToken), body: null },
        { id: "grant_detail", method: "GET", path: `${CONTROL}/${org}/grants/${grantId}`, headers: browserRead, body: null },
        { id: "grant_mutation_status", method: "GET", path: `${CONTROL}/${org}/grant-mutations/${randomUUID()}`, headers: browserRead, body: null },
        { id: "grant_revoke", method: "POST", path: `${CONTROL}/${org}/grants/${grantId}/revoke`, headers: browserWrite, body },
      ];
      expect(routes).toHaveLength(21);
      const outcomes: Record<string, Record<string, unknown>> = {};
      for (const route of routes) {
        const outcome = await nodeRequest({ method: route.method, path: route.path, headers: route.headers, body: route.body, ...off });
        outcomes[route.id] = safe(outcome);
        expect(outcome.status === 200 && outcome.contentType.startsWith("text/html"), route.id).toBe(false);
        expect(outcome.status, route.id).toBe(404);
        expect(outcome.contentType.startsWith("text/html"), route.id).toBe(true);
        expect(outcome.html404, route.id).toBe(true);
        expect(outcome.spaShell, route.id).toBe(false);
        expect(outcome.setCookie, route.id).toBe(false);
        expect(outcome.corsAllowOrigin, route.id).toBe(false);
      }
      evidence("J8 OFF routes", outcomes);
      expect(businessCalls).toEqual([]);
    });
  });
});

// Referenced so a refusal type from the fixture is part of the typed surface.
void FixtureCoreRefusal;
