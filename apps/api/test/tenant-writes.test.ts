import { connect } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import type {
  CommerceOrganizationPage,
} from "@openarc/shared";
import {
  TenantStoreError,
  type DurableMutationResult,
  type DurableMutationStatus,
} from "@openarc/db";

import { createApp, type CompletionLog } from "../src/app.js";
import { AUTH_ERRORS, type AuthApiError } from "../src/auth/errors.js";
import type { AuthService } from "../src/auth/service.js";
import { loadConfig } from "../src/config.js";
import { TenantReadService } from "../src/tenant/service.js";
import type {
  TenantGetOrganizationAccessResult,
  TenantListAgentsResult,
  TenantListOrganizationsResult,
  TenantListProvidersResult,
  TenantReadAuthPort,
  TenantReadStorePort,
} from "../src/tenant/ports.js";
import { TenantWriteService } from "../src/tenant/write-service.js";
import type {
  TenantWriteAuthPort,
  TenantWriteStorePort,
} from "../src/tenant/write-ports.js";
import { TENANT_ROUTE_PREFIX } from "../src/tenant/routes.js";
import { isForbiddenRequestTarget } from "../src/tenant/write-routes.js";

/**
 * Unit and HTTP-inject coverage for the protected tenant write/status family.
 *
 * The TenantStore and AuthService are HONESTLY MOCKED here: this suite proves
 * transport strictness, the validate/CSRF/begin ordering, exactly-one durable
 * call per mutation, receipt projection integrity, error mapping and log
 * hygiene. Real roles, sessions, locks, idempotency rows and SQL enforcement
 * are covered by tenant-writes.postgres.test.ts.
 */

const ORIGIN = "http://localhost:5183";
const RP_ID = "localhost";
const SECRET = "synthetic_auth_secret_for_tenant_write_tests_0123456789";
const BUILD_SHA = "0123456789abcdef0123456789abcdef01234567";
const HASH = "a".repeat(64);
const CLIENT = { origin: ORIGIN, "x-openarc-client": "browser-v1" };
const COOKIE = "openarc_session=abc";
const CSRF = "csrf-token-value";
const IDEMPOTENCY = "A".repeat(43);

const MUTATION = "12345678-1234-4234-8123-123456789abc";
const ORG = `openarc:org:${MUTATION}`;
const AGENT = `openarc:agent:${MUTATION}`;
const PROVIDER = `openarc:provider:${MUTATION}`;
const ACCOUNT = `openarc:account:${MUTATION}`;
const ISO = "2026-01-01T00:00:00.000Z";

function receipt(
  operation: string,
  resourceType: string,
  resourceId: string,
): DurableMutationResult {
  return {
    replayed: false,
    receipt: {
      mutationId: MUTATION,
      operation,
      resourceType,
      resourceId,
      committedAt: ISO,
    },
  } as unknown as DurableMutationResult;
}

const RESULTS: Record<string, DurableMutationResult> = {
  createOrganizationDurably: receipt("tenant.organization.create", "organization", ORG),
  createAgentDurably: receipt("tenant.agent.create", "agent", AGENT),
  updateAgentDurably: receipt("tenant.agent.update", "agent", AGENT),
  createProviderDurably: receipt("tenant.provider.create", "provider", PROVIDER),
  updateProviderDurably: receipt("tenant.provider.update", "provider", PROVIDER),
  setMembershipDurably: receipt("tenant.membership.set", "membership", ACCOUNT),
};

class FakeWriteStore implements TenantWriteStorePort {
  calls: string[] = [];
  error: unknown;
  override: DurableMutationResult | undefined;
  status: DurableMutationStatus = { status: "not_found" };
  statusError: unknown;

  #record(name: string): DurableMutationResult {
    this.calls.push(name);
    if (this.error) throw this.error;
    return this.override ?? RESULTS[name] ?? receipt("tenant.agent.create", "agent", AGENT);
  }

  async createOrganizationDurably(): Promise<DurableMutationResult> {
    return this.#record("createOrganizationDurably");
  }
  async createAgentDurably(): Promise<DurableMutationResult> {
    return this.#record("createAgentDurably");
  }
  async updateAgentDurably(): Promise<DurableMutationResult> {
    return this.#record("updateAgentDurably");
  }
  async createProviderDurably(): Promise<DurableMutationResult> {
    return this.#record("createProviderDurably");
  }
  async updateProviderDurably(): Promise<DurableMutationResult> {
    return this.#record("updateProviderDurably");
  }
  async setMembershipDurably(): Promise<DurableMutationResult> {
    return this.#record("setMembershipDurably");
  }
  async getTenantMutationStatus(): Promise<DurableMutationStatus> {
    this.calls.push("getTenantMutationStatus");
    if (this.statusError) throw this.statusError;
    return this.status;
  }
  async getOrganizationMutationStatus(): Promise<DurableMutationStatus> {
    this.calls.push("getOrganizationMutationStatus");
    if (this.statusError) throw this.statusError;
    return this.status;
  }
}

class FakeAuth implements TenantReadAuthPort, TenantWriteAuthPort {
  csrfCalls = 0;
  beginCalls = 0;
  finishCalls = 0;
  csrfError: AuthApiError | undefined;
  beginError: AuthApiError | undefined;
  finishError: AuthApiError | undefined;

  verifyCsrf(): string {
    this.csrfCalls += 1;
    if (this.csrfError) throw this.csrfError;
    return "binding";
  }
  async beginTenantRead(): Promise<{ sessionHash: string; accountId: string }> {
    this.beginCalls += 1;
    if (this.beginError) throw this.beginError;
    return { sessionHash: HASH, accountId: ACCOUNT };
  }
  async finishTenantRead(): Promise<void> {
    this.finishCalls += 1;
    if (this.finishError) throw this.finishError;
  }
}

const EMPTY_ORGS: CommerceOrganizationPage = { items: [], nextCursor: null };

class FakeReadStore implements TenantReadStorePort {
  async listOrganizations(): Promise<TenantListOrganizationsResult> {
    return EMPTY_ORGS;
  }
  async getOrganizationAccess(): Promise<TenantGetOrganizationAccessResult> {
    throw new Error("unused");
  }
  async listAgents(): Promise<TenantListAgentsResult> {
    return { items: [], nextCursor: null };
  }
  async listProviders(): Promise<TenantListProvidersResult> {
    return { items: [], nextCursor: null };
  }
}

const apps: ReturnType<typeof createApp>[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map(async (app) => app.close()));
});

interface HarnessOptions {
  readonly enabled?: boolean;
  readonly maxResponseBytes?: number;
}

function harness(options: HarnessOptions = {}) {
  const store = new FakeWriteStore();
  const auth = new FakeAuth();
  const writeService = new TenantWriteService({ auth, store });
  const readService = new TenantReadService({ auth, store: new FakeReadStore() });
  const logs: CompletionLog[] = [];
  const enabled = options.enabled ?? true;
  const config = loadConfig({
    NODE_ENV: "test",
    APP_ORIGIN: ORIGIN,
    COMMIT_SHA: BUILD_SHA,
    ...(enabled
      ? {
          AUTH_ENABLED: "true",
          AUTH_DATABASE_URL: "postgres://openarc_auth_app:x@127.0.0.1:5432/openarc_auth_test",
          AUTH_SECRET: SECRET,
          AUTH_RP_ID: RP_ID,
          TENANT_READS_ENABLED: "true",
          TENANT_DATABASE_URL: "postgres://openarc_tenant_app:y@127.0.0.1:5432/openarc_auth_test",
          TENANT_WRITES_ENABLED: "true",
        }
      : {
          AUTH_ENABLED: "true",
          AUTH_DATABASE_URL: "postgres://openarc_auth_app:x@127.0.0.1:5432/openarc_auth_test",
          AUTH_SECRET: SECRET,
          AUTH_RP_ID: RP_ID,
          TENANT_READS_ENABLED: "true",
          TENANT_DATABASE_URL: "postgres://openarc_tenant_app:y@127.0.0.1:5432/openarc_auth_test",
        }),
  });
  const app = createApp({
    config,
    logger: false,
    logSink: (entry) => logs.push(entry),
    authService: {} as AuthService,
    tenantReadService: readService,
    tenantReady: async () => true,
    ...(enabled
      ? {
          tenantWriteService: writeService,
          ...(options.maxResponseBytes !== undefined
            ? { tenantMaxResponseBytes: options.maxResponseBytes }
            : {}),
        }
      : {}),
  });
  apps.push(app);
  return { app, store, auth, logs };
}

function writeHeaders(extra: Record<string, string | string[]> = {}) {
  return {
    ...CLIENT,
    "content-type": "application/json",
    cookie: COOKIE,
    "x-openarc-csrf": CSRF,
    "idempotency-key": IDEMPOTENCY,
    ...extra,
  };
}

const PREFIX = TENANT_ROUTE_PREFIX;
const URLS = {
  organization: PREFIX,
  agents: `${PREFIX}/${ORG}/agents`,
  agent: `${PREFIX}/${ORG}/agents/${AGENT}`,
  providers: `${PREFIX}/${ORG}/providers`,
  provider: `${PREFIX}/${ORG}/providers/${PROVIDER}`,
  membership: `${PREFIX}/${ORG}/memberships/${ACCOUNT}`,
  mutation: `${PREFIX}/${ORG}/mutations/${MUTATION}`,
  bootstrapMutation: `${PREFIX}/bootstrap-mutations/${MUTATION}`,
} as const;

function v2ErrorCode(response: { json: () => unknown }): string {
  const body = response.json() as { error?: { code?: string } };
  return body.error?.code ?? "";
}

/**
 * Send a verbatim HTTP/1.1 request over a real TCP socket to the listening
 * app. `net.connect` lets us write DUPLICATE header lines that a high-level
 * client (or Node's own header map) would collapse, which is exactly the wire
 * condition the raw-header duplicate guard must see.
 */
function rawHttp(
  port: number,
  method: string,
  path: string,
  headers: readonly string[],
  body = "",
): Promise<{ status: number; text: string }> {
  const payload = Buffer.from(body, "utf8");
  const lines = [
    `${method} ${path} HTTP/1.1`,
    "Host: 127.0.0.1",
    ...headers,
    `Content-Length: ${payload.byteLength}`,
    "Connection: close",
    "",
    "",
  ];
  const wire = Buffer.concat([Buffer.from(lines.join("\r\n"), "utf8"), payload]);
  return new Promise((resolve, reject) => {
    const socket = connect({ host: "127.0.0.1", port });
    const chunks: Buffer[] = [];
    socket.on("connect", () => socket.write(wire));
    socket.on("data", (chunk: Buffer) => chunks.push(chunk));
    socket.on("error", reject);
    socket.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      const status = Number.parseInt(text.slice(9, 12), 10);
      resolve({ status, text });
    });
  });
}

async function listeningPort(app: ReturnType<typeof createApp>): Promise<number> {
  await app.listen({ port: 0, host: "127.0.0.1" });
  const address = app.server.address();
  if (address === null || typeof address === "string") {
    throw new Error("expected a TCP address");
  }
  return address.port;
}

describe("tenant write success envelopes", () => {
  it("maps every write route to exactly one durable call and a strict v2 receipt", async () => {
    const { app, store } = harness();
    const cases = [
      {
        method: "POST" as const,
        url: URLS.organization,
        body: { mutationId: MUTATION, displayName: "Acme" },
        call: "createOrganizationDurably",
        operation: "tenant.organization.create",
      },
      {
        method: "POST" as const,
        url: URLS.agents,
        body: { mutationId: MUTATION, displayName: "Agent" },
        call: "createAgentDurably",
        operation: "tenant.agent.create",
      },
      {
        method: "PATCH" as const,
        url: URLS.agent,
        body: { mutationId: MUTATION, patch: { status: "suspended" } },
        call: "updateAgentDurably",
        operation: "tenant.agent.update",
      },
      {
        method: "POST" as const,
        url: URLS.providers,
        body: { mutationId: MUTATION, displayName: "Provider" },
        call: "createProviderDurably",
        operation: "tenant.provider.create",
      },
      {
        method: "PATCH" as const,
        url: URLS.provider,
        body: { mutationId: MUTATION, patch: { displayName: "P2" } },
        call: "updateProviderDurably",
        operation: "tenant.provider.update",
      },
      {
        method: "PUT" as const,
        url: URLS.membership,
        body: { mutationId: MUTATION, role: "viewer", membershipStatus: "active" },
        call: "setMembershipDurably",
        operation: "tenant.membership.set",
      },
    ];
    for (const entry of cases) {
      const response = await app.inject({
        method: entry.method,
        url: entry.url,
        headers: writeHeaders(),
        payload: entry.body,
      });
      expect(response.statusCode, entry.url).toBe(200);
      const body = response.json();
      expect(body.meta.schemaVersion).toBe("openarc.api.v2");
      expect(body.data.receipt.operation).toBe(entry.operation);
      expect(body.data.receipt.mutationId).toBe(MUTATION);
      expect(response.headers["set-cookie"]).toBeUndefined();
    }
    expect(store.calls).toEqual(cases.map((entry) => entry.call));
  });

  it("returns committed and not_found status through the read ordering", async () => {
    const { app, store, auth } = harness();
    store.status = {
      status: "committed",
      receipt: {
        mutationId: MUTATION,
        operation: "tenant.agent.update",
        resourceType: "agent",
        resourceId: AGENT,
        committedAt: ISO,
      },
    } as DurableMutationStatus;
    const committed = await app.inject({
      method: "GET",
      url: URLS.mutation,
      headers: { ...CLIENT, cookie: COOKIE },
    });
    expect(committed.statusCode).toBe(200);
    expect(committed.json().data.status).toBe("committed");
    expect(committed.json().data.receipt.resourceId).toBe(AGENT);
    expect(auth.beginCalls).toBe(1);
    expect(auth.finishCalls).toBe(1);

    store.status = { status: "not_found" };
    const missing = await app.inject({
      method: "GET",
      url: URLS.mutation,
      headers: { ...CLIENT, cookie: COOKIE },
    });
    expect(missing.statusCode).toBe(200);
    expect(missing.json().data.status).toBe("not_found");
    expect(JSON.stringify(missing.json().data)).not.toContain("receipt");
    expect(auth.finishCalls).toBe(2);
  });

  it("derives the bootstrap organization from the logical mutation id", async () => {
    const { app, store } = harness();
    store.status = {
      status: "committed",
      receipt: {
        mutationId: MUTATION,
        operation: "tenant.organization.create",
        resourceType: "organization",
        resourceId: ORG,
        committedAt: ISO,
      },
    } as DurableMutationStatus;
    const response = await app.inject({
      method: "GET",
      url: URLS.bootstrapMutation,
      headers: { ...CLIENT, cookie: COOKIE },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().data.organizationId).toBe(ORG);
    expect(store.calls).toEqual(["getOrganizationMutationStatus"]);
  });
});

describe("strict transport", () => {
  it("rejects a missing key, array header, bad origin, auth header and query", async () => {
    const { app, store, auth } = harness();
    const payload = { mutationId: MUTATION, displayName: "Acme" };
    const cases: Array<{ headers: Record<string, string | string[]>; url?: string }> = [
      { headers: writeHeaders({ origin: "https://evil.example" }) },
      { headers: writeHeaders({ "x-openarc-client": "other" }) },
      { headers: writeHeaders({ authorization: "Bearer x" }) },
      { headers: writeHeaders({ "sec-fetch-site": "cross-site" }) },
      { headers: writeHeaders({ "content-type": "text/plain" }) },
      { headers: writeHeaders({ "idempotency-key": "short" }) },
      { headers: writeHeaders({ "idempotency-key": [`${"A".repeat(42)}B`] }) },
      { headers: writeHeaders(), url: `${URLS.organization}?x=1` },
    ];
    for (const entry of cases) {
      const response = await app.inject({
        method: "POST",
        url: entry.url ?? URLS.organization,
        headers: entry.headers as Record<string, string>,
        payload,
      });
      expect([400, 403, 415], JSON.stringify(entry.headers)).toContain(response.statusCode);
    }
    expect(store.calls).toEqual([]);
    expect(auth.beginCalls).toBe(0);
  });

  it("rejects a bare empty query request target directly", () => {
    // Some HTTP injectors normalize a bare `?` away; a real request target
    // preserves it, so the exact rule is asserted on the target predicate.
    expect(isForbiddenRequestTarget(`${PREFIX}?`)).toBe(true);
    expect(isForbiddenRequestTarget(`${PREFIX}?limit=1`)).toBe(true);
    expect(isForbiddenRequestTarget(PREFIX)).toBe(false);
    expect(isForbiddenRequestTarget(`/${"x".repeat(2100)}`)).toBe(true);
  });

  it("rejects a real HTTP request with duplicate Content-Type header lines", async () => {
    const { app, store, auth } = harness();
    const port = await listeningPort(app);
    const payload = JSON.stringify({ mutationId: MUTATION, displayName: "Acme" });
    const response = await rawHttp(
      port,
      "POST",
      URLS.organization,
      [
        `Origin: ${ORIGIN}`,
        "X-OpenArc-Client: browser-v1",
        "Content-Type: application/json",
        "Content-Type: text/plain",
        `Cookie: ${COOKIE}`,
        `X-OpenArc-Csrf: ${CSRF}`,
        `Idempotency-Key: ${IDEMPOTENCY}`,
      ],
      payload,
    );
    expect(response.status).toBe(400);
    expect(response.text).not.toContain("text/plain");
    expect(response.text).toContain('"code":"INVALID_REQUEST"');
    expect(store.calls).toEqual([]);
    expect(auth.beginCalls).toBe(0);
    expect(auth.csrfCalls).toBe(0);
  });

  it("rejects duplicate wire instances of every critical header", async () => {
    const { app, store, auth } = harness();
    const port = await listeningPort(app);
    const payload = JSON.stringify({ mutationId: MUTATION, displayName: "Acme" });
    const base = [
      `Origin: ${ORIGIN}`,
      "X-OpenArc-Client: browser-v1",
      "Content-Type: application/json",
      `Cookie: ${COOKIE}`,
      `X-OpenArc-Csrf: ${CSRF}`,
      `Idempotency-Key: ${IDEMPOTENCY}`,
    ];
    const duplicates: ReadonlyArray<readonly string[]> = [
      [...base, `Origin: ${ORIGIN}`],
      [...base, "X-OpenArc-Client: browser-v1"],
      [...base, `X-OpenArc-Csrf: ${CSRF}`],
      [...base, `Idempotency-Key: ${IDEMPOTENCY}`],
      [...base, "Authorization: Bearer x"],
      [...base, "Authorization: Bearer y"],
      [...base, "Sec-Fetch-Site: same-origin", "Sec-Fetch-Site: cross-site"],
    ];
    for (const headers of duplicates) {
      const response = await rawHttp(port, "POST", URLS.organization, headers, payload);
      expect([400, 403, 415], headers.join("|")).toContain(response.status);
    }
    expect(store.calls).toEqual([]);
    expect(auth.beginCalls).toBe(0);
  });

  it("rejects duplicate critical headers on a status GET", async () => {
    const { app, store } = harness();
    const port = await listeningPort(app);
    const response = await rawHttp(
      port,
      "GET",
      URLS.mutation,
      [
        `Origin: ${ORIGIN}`,
        "X-OpenArc-Client: browser-v1",
        `Cookie: ${COOKIE}`,
        `Authorization: Bearer x`,
        `Authorization: Bearer y`,
      ],
    );
    expect(response.status).toBe(400);
    expect(store.calls).toEqual([]);
    expect(response.text).not.toContain(MUTATION);
  });

  it("denies an originless write and accepts the exact origin", async () => {
    const { app, store } = harness();
    const originless = await app.inject({
      method: "POST",
      url: URLS.organization,
      headers: {
        "x-openarc-client": "browser-v1",
        "sec-fetch-site": "same-origin",
        "content-type": "application/json",
        cookie: COOKIE,
        "x-openarc-csrf": CSRF,
        "idempotency-key": IDEMPOTENCY,
      },
      payload: { mutationId: MUTATION, displayName: "Acme" },
    });
    expect(originless.statusCode).toBe(403);
    expect(store.calls).toEqual([]);
  });

  it("rejects wrong methods with 405", async () => {
    const { app, store } = harness();
    // DELETE on a shared read path keeps the read handler's fixed 405.
    const shared = await app.inject({
      method: "DELETE",
      url: URLS.organization,
      headers: { ...CLIENT, cookie: COOKIE },
    });
    expect(shared.statusCode).toBe(405);
    // Wrong method on a write-only path is also a fixed 405.
    const put = await app.inject({
      method: "PUT",
      url: URLS.agent,
      headers: writeHeaders(),
      payload: { mutationId: MUTATION, patch: { status: "active" } },
    });
    expect(put.statusCode).toBe(405);
    const membershipGet = await app.inject({
      method: "GET",
      url: URLS.membership,
      headers: { ...CLIENT, cookie: COOKIE },
    });
    expect(membershipGet.statusCode).toBe(405);
    expect(store.calls).toEqual([]);
  });

  it("rejects oversized bodies before the repository", async () => {
    const { app, store } = harness();
    const response = await app.inject({
      method: "POST",
      url: URLS.organization,
      headers: writeHeaders(),
      payload: JSON.stringify({ mutationId: MUTATION, displayName: "x".repeat(20_000) }),
    });
    expect(response.statusCode).toBe(413);
    expect(store.calls).toEqual([]);
  });
});

describe("authorization ordering", () => {
  it("stops before CSRF and the repository on invalid body or path", async () => {
    const { app, store, auth } = harness();
    const badBodies = [
      { mutationId: MUTATION },
      { mutationId: MUTATION, displayName: "" },
      { mutationId: MUTATION.toUpperCase(), displayName: "Acme" },
      { mutationId: MUTATION, displayName: "Acme", organizationId: ORG },
      { mutationId: MUTATION, displayName: "Acme", role: "owner" },
    ];
    for (const payload of badBodies) {
      const response = await app.inject({
        method: "POST",
        url: URLS.organization,
        headers: writeHeaders(),
        payload,
      });
      expect(response.statusCode, JSON.stringify(payload)).toBe(400);
    }
    const badPath = await app.inject({
      method: "POST",
      url: `${PREFIX}/not-an-organization/agents`,
      headers: writeHeaders(),
      payload: { mutationId: MUTATION, displayName: "Acme" },
    });
    expect(badPath.statusCode).toBe(400);
    expect(store.calls).toEqual([]);
    expect(auth.csrfCalls).toBe(0);
    expect(auth.beginCalls).toBe(0);
  });

  it("runs CSRF before begin and never touches the repository when CSRF fails", async () => {
    const { app, store, auth } = harness();
    auth.csrfError = AUTH_ERRORS.csrfRejected();
    const response = await app.inject({
      method: "POST",
      url: URLS.organization,
      headers: writeHeaders(),
      payload: { mutationId: MUTATION, displayName: "Acme" },
    });
    expect(response.statusCode).toBe(403);
    expect(auth.csrfCalls).toBe(1);
    expect(auth.beginCalls).toBe(0);
    expect(store.calls).toEqual([]);
  });

  it("never touches the repository when begin rejects", async () => {
    const { app, store, auth } = harness();
    auth.beginError = AUTH_ERRORS.unauthenticated();
    const response = await app.inject({
      method: "POST",
      url: URLS.organization,
      headers: writeHeaders(),
      payload: { mutationId: MUTATION, displayName: "Acme" },
    });
    expect(response.statusCode).toBe(401);
    expect(store.calls).toEqual([]);
  });
});

describe("repository error mapping", () => {
  const cases: Array<[string, number, string]> = [
    ["TENANT_STORE_INPUT_INVALID", 400, "INVALID_REQUEST"],
    ["TENANT_STORE_SESSION_INVALID", 401, "UNAUTHENTICATED"],
    ["TENANT_STORE_FORBIDDEN", 403, "FORBIDDEN"],
    ["TENANT_STORE_NOT_FOUND", 403, "FORBIDDEN"],
    ["TENANT_STORE_CONFLICT", 409, "POLICY_DENIED"],
    ["TENANT_STORE_IDEMPOTENCY_CONFLICT", 409, "IDEMPOTENCY_CONFLICT"],
    ["TENANT_STORE_UNAVAILABLE", 503, "INTERNAL_ERROR"],
    ["TENANT_STORE_OUTCOME_UNKNOWN", 503, "INTERNAL_ERROR"],
  ];
  it("maps each fixed store code without echoing detail", async () => {
    for (const [code, status, envelopeCode] of cases) {
      const store = new FakeWriteStore();
      store.error = new TenantStoreError(code as never);
      const auth = new FakeAuth();
      const service = new TenantWriteService({ auth, store });
      const config = loadConfig({
        NODE_ENV: "test",
        APP_ORIGIN: ORIGIN,
        COMMIT_SHA: BUILD_SHA,
        AUTH_ENABLED: "true",
        AUTH_DATABASE_URL: "postgres://openarc_auth_app:x@127.0.0.1:5432/openarc_auth_test",
        AUTH_SECRET: SECRET,
        AUTH_RP_ID: RP_ID,
        TENANT_READS_ENABLED: "true",
        TENANT_DATABASE_URL: "postgres://openarc_tenant_app:y@127.0.0.1:5432/openarc_auth_test",
        TENANT_WRITES_ENABLED: "true",
      });
      const local = createApp({
        config,
        logger: false,
        authService: {} as AuthService,
        tenantReadService: new TenantReadService({ auth, store: new FakeReadStore() }),
        tenantReady: async () => true,
        tenantWriteService: service,
      });
      apps.push(local);
      const response = await local.inject({
        method: "POST",
        url: URLS.organization,
        headers: writeHeaders(),
        payload: { mutationId: MUTATION, displayName: "Acme" },
      });
      expect(response.statusCode, code).toBe(status);
      expect(v2ErrorCode(response), code).toBe(envelopeCode);
    }
  });
});

describe("receipt projection integrity", () => {
  it("fails closed on a wrong operation, mutation id or target id", async () => {
    const variants: DurableMutationResult[] = [
      receipt("tenant.agent.create", "agent", AGENT),
      {
        replayed: false,
        receipt: {
          mutationId: "87654321-4321-4321-b123-abcdefabcdef",
          operation: "tenant.organization.create",
          resourceType: "organization",
          resourceId: `openarc:org:87654321-4321-4321-b123-abcdefabcdef`,
          committedAt: ISO,
        },
      } as unknown as DurableMutationResult,
      {
        replayed: false,
        receipt: {
          mutationId: MUTATION,
          operation: "tenant.provider.update",
          resourceType: "provider",
          resourceId: PROVIDER,
          committedAt: ISO,
        },
      } as unknown as DurableMutationResult,
    ];
    for (const override of variants) {
      const { app, store } = harness();
      store.override = override;
      const response = await app.inject({
        method: "POST",
        url: URLS.organization,
        headers: writeHeaders(),
        payload: { mutationId: MUTATION, displayName: "Acme" },
      });
      expect(response.statusCode).toBe(500);
      expect(response.body).not.toContain("PRIVATE");
    }

    const target = harness();
    target.store.override = receipt("tenant.agent.update", "agent", PROVIDER);
    const wrongTarget = await target.app.inject({
      method: "PATCH",
      url: URLS.agent,
      headers: writeHeaders(),
      payload: { mutationId: MUTATION, patch: { status: "suspended" } },
    });
    expect(wrongTarget.statusCode).toBe(500);
  });

  it("returns 200 for a replayed committed receipt", async () => {
    const { app, store } = harness();
    store.override = { ...RESULTS["createOrganizationDurably"], replayed: true } as DurableMutationResult;
    const response = await app.inject({
      method: "POST",
      url: URLS.organization,
      headers: writeHeaders(),
      payload: { mutationId: MUTATION, displayName: "Acme" },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().data.replayed).toBe(true);
  });
});

describe("status finishTenantRead after the awaited repository result", () => {
  const COMMITTED = {
    status: "committed",
    receipt: {
      mutationId: MUTATION,
      operation: "tenant.agent.update",
      resourceType: "agent",
      resourceId: AGENT,
      committedAt: ISO,
    },
  } as DurableMutationStatus;

  const cases: ReadonlyArray<{
    readonly name: string;
    readonly url: string;
    readonly status: DurableMutationStatus;
    readonly call: string;
  }> = [
    { name: "scoped committed", url: URLS.mutation, status: COMMITTED, call: "getTenantMutationStatus" },
    { name: "scoped not_found", url: URLS.mutation, status: { status: "not_found" }, call: "getTenantMutationStatus" },
    {
      name: "bootstrap committed",
      url: URLS.bootstrapMutation,
      status: {
        status: "committed",
        receipt: {
          mutationId: MUTATION,
          operation: "tenant.organization.create",
          resourceType: "organization",
          resourceId: ORG,
          committedAt: ISO,
        },
      },
      call: "getOrganizationMutationStatus",
    },
    { name: "bootstrap not_found", url: URLS.bootstrapMutation, status: { status: "not_found" }, call: "getOrganizationMutationStatus" },
  ];

  it("rejects 401 with no receipt or cookie when finish fails after the read", async () => {
    for (const entry of cases) {
      const { app, store, auth } = harness();
      store.status = entry.status;
      auth.finishError = AUTH_ERRORS.unauthenticated();
      const response = await app.inject({
        method: "GET",
        url: entry.url,
        headers: { ...CLIENT, cookie: COOKIE },
      });
      expect(response.statusCode, entry.name).toBe(401);
      expect(response.headers["set-cookie"], entry.name).toBeUndefined();
      expect(response.body, entry.name).not.toContain('"data"');
      expect(response.body, entry.name).not.toContain(AGENT);
      expect(response.body, entry.name).not.toContain(ORG);
      expect(store.calls, entry.name).toEqual([entry.call]);
      expect(auth.beginCalls, entry.name).toBe(1);
      expect(auth.finishCalls, entry.name).toBe(1);
    }
  });
});

describe("disabled family and log hygiene", () => {
  it("keeps the read POST behavior and fails new write paths with FEATURE_DISABLED", async () => {
    const { app } = harness({ enabled: false });
    const post = await app.inject({
      method: "POST",
      url: URLS.organization,
      headers: writeHeaders(),
      payload: { mutationId: MUTATION, displayName: "Acme" },
    });
    expect(post.statusCode).toBe(405);
    for (const url of [URLS.agent, URLS.membership, URLS.mutation, URLS.bootstrapMutation]) {
      const method = url === URLS.mutation || url === URLS.bootstrapMutation ? "GET" : "PATCH";
      const response = await app.inject({
        method,
        url,
        headers: writeHeaders(),
        ...(method === "GET" ? {} : { payload: { mutationId: MUTATION, patch: {} } }),
      });
      expect(response.statusCode, url).toBe(503);
      expect(v2ErrorCode(response), url).toBe("FEATURE_DISABLED");
    }
  });

  it("never logs or returns the idempotency key or a display-name canary", async () => {
    const { app, logs } = harness();
    const canary = "PRIVATE_NAME_CANARY";
    const response = await app.inject({
      method: "POST",
      url: URLS.organization,
      headers: writeHeaders(),
      payload: { mutationId: MUTATION, displayName: canary },
    });
    expect(response.statusCode).toBe(200);
    expect(response.body).not.toContain(canary);
    expect(response.body).not.toContain(IDEMPOTENCY);
    for (const entry of logs) {
      const serialized = JSON.stringify(entry);
      expect(serialized).not.toContain(IDEMPOTENCY);
      expect(serialized).not.toContain(canary);
      expect(serialized).not.toContain(COOKIE);
    }
    expect(logs[0]?.route).toBe("tenant");
  });
});
