import { randomBytes } from "node:crypto";
import { connect } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import { createApp, type CompletionLog } from "../src/app.js";
import type { AuthService } from "../src/auth/service.js";
import { loadConfig } from "../src/config.js";
import type { MachineManagementService } from "../src/machine/management-service.js";
import type { MachineSessionService } from "../src/machine/session-service.js";
import type { TenantReadService } from "../src/tenant/service.js";
import type { TenantWriteService } from "../src/tenant/write-service.js";
import { TENANT_ROUTE_PREFIX } from "../src/tenant/routes.js";
import { isForbiddenMachineRequestTarget } from "../src/machine/management-routes.js";
import { isForbiddenSessionRequestTarget } from "../src/machine/session-routes.js";

/**
 * Unit and HTTP-inject coverage for the machine HTTP surfaces.
 *
 * The management/session services are HONESTLY MOCKED here: this suite proves
 * strict transport, method/query/body handling, duplicate-header rejection,
 * namespace separation and the fixed v2 error envelopes. Real services, SQL and
 * scrypt are covered by machine-api.postgres.test.ts.
 */

const ORIGIN = "http://localhost:5183";
const RP_ID = "localhost";
const AUTH_SECRET = "synthetic_auth_secret_for_machine_routes_tests_0123456789";
const BUILD_SHA = "0123456789abcdef0123456789abcdef01234567";
const CLIENT = { origin: ORIGIN, "x-openarc-client": "browser-v1" };
const COOKIE = "openarc_session=abc";
const CSRF = "csrf-token-value";
const IDEMPOTENCY = randomBytes(32).toString("base64url");

const MUTATION = "12345678-1234-4234-8123-123456789abc";
const CREDENTIAL = "87654321-4321-4321-8123-cba987654321";
const ORG = `openarc:org:${MUTATION}`;
const AGENT = `openarc:agent:${MUTATION}`;
const PROVIDER = `openarc:provider:${MUTATION}`;
const ISO = "2026-01-01T00:00:00.000Z";
const SESSION_EXPIRES = "2026-01-01T00:05:00.000Z";

const PREFIX = TENANT_ROUTE_PREFIX;
const URLS = {
  agentCredentials: `${PREFIX}/${ORG}/agents/${AGENT}/credentials`,
  providerCredentials: `${PREFIX}/${ORG}/providers/${PROVIDER}/credentials`,
  agentRevoke: `${PREFIX}/${ORG}/agent-credentials/${CREDENTIAL}/revoke`,
  agentMutation: `${PREFIX}/${ORG}/agent-credential-mutations/${MUTATION}`,
  agentExchange: "/v1/agent/sessions",
  providerExchange: "/v1/provider/sessions",
  agentSelf: "/v1/agent/self",
  agentSessionRevoke: "/v1/agent/sessions/current/revoke",
} as const;

const MANAGEMENT_CALLS: string[] = [];
const SESSION_CALLS: string[] = [];

const managementStub = {
  async listCredentials(kind: string) {
    MANAGEMENT_CALLS.push(`list:${kind}`);
    return {
      organizationId: ORG,
      kind,
      profileId: kind === "agent" ? AGENT : PROVIDER,
      items: [],
      nextCursor: null,
    };
  },
  async getMutationStatus(kind: string) {
    MANAGEMENT_CALLS.push(`status:${kind}`);
    return { organizationId: ORG, status: "not_found" as const };
  },
  async issueCredential(kind: string) {
    MANAGEMENT_CALLS.push(`issue:${kind}`);
    return {
      organizationId: ORG,
      replayed: true as const,
      receipt: {
        mutationId: MUTATION,
        operation: kind === "agent" ? "tenant.agent.credential.issue" : "tenant.provider.credential.issue",
        resourceType: kind === "agent" ? "agent_credential" : "provider_credential",
        credentialId: MUTATION,
        committedAt: ISO,
      },
      delivery: { status: "token_not_replayable" as const },
    };
  },
  async revokeCredential(kind: string) {
    MANAGEMENT_CALLS.push(`revoke:${kind}`);
    return {
      organizationId: ORG,
      replayed: false as const,
      receipt: {
        mutationId: MUTATION,
        operation: kind === "agent" ? "tenant.agent.credential.revoke" : "tenant.provider.credential.revoke",
        resourceType: kind === "agent" ? "agent_credential" : "provider_credential",
        credentialId: CREDENTIAL,
        committedAt: ISO,
      },
    };
  },
} as unknown as MachineManagementService;

function sessionMetadata(kind: "agent" | "provider") {
  return {
    sessionId: MUTATION,
    credentialId: CREDENTIAL,
    organizationId: ORG,
    kind,
    profileId: kind === "agent" ? AGENT : PROVIDER,
    environment: "eip155:5042002" as const,
    scopes: [kind === "agent" ? "agent:self.read" : "provider:self.read"],
    scopeVersion: 1 as const,
    createdAt: ISO,
    expiresAt: SESSION_EXPIRES,
  };
}

const sessionStub = {
  async exchange(kind: "agent" | "provider") {
    SESSION_CALLS.push(`exchange:${kind}`);
    return {
      session: sessionMetadata(kind),
      delivery: { status: "available_once" as const, token: kind === "agent" ? `oas_ag_${"A".repeat(43)}` : `oas_pr_${"A".repeat(43)}` },
    };
  },
  async self(kind: "agent" | "provider") {
    SESSION_CALLS.push(`self:${kind}`);
    return { session: sessionMetadata(kind) };
  },
  async revoke(kind: "agent" | "provider") {
    SESSION_CALLS.push(`revoke:${kind}`);
    return { kind, sessionId: MUTATION, organizationId: ORG, revokedAt: ISO };
  },
} as unknown as MachineSessionService;

const tenantReadStub = {} as unknown as TenantReadService;
const tenantWriteStub = {} as unknown as TenantWriteService;

const apps: ReturnType<typeof createApp>[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map(async (app) => app.close()));
  MANAGEMENT_CALLS.length = 0;
  SESSION_CALLS.length = 0;
});

function machineSecret(byte: number): string {
  return randomBytes(32).fill(byte).toString("base64url");
}

function harness(options: { enabled?: boolean } = {}) {
  const enabled = options.enabled ?? true;
  const logs: CompletionLog[] = [];
  const config = loadConfig({
    NODE_ENV: "test",
    APP_ORIGIN: ORIGIN,
    COMMIT_SHA: BUILD_SHA,
    AUTH_ENABLED: "true",
    AUTH_DATABASE_URL: "postgres://openarc_auth_app:x@127.0.0.1:5432/openarc_auth_test",
    AUTH_SECRET,
    AUTH_RP_ID: RP_ID,
    TENANT_READS_ENABLED: "true",
    TENANT_DATABASE_URL: "postgres://openarc_tenant_app:y@127.0.0.1:5432/openarc_auth_test",
    ...(enabled
      ? {
          TENANT_WRITES_ENABLED: "true",
          MACHINE_CREDENTIAL_MANAGEMENT_ENABLED: "true",
          MACHINE_SESSION_EXCHANGE_ENABLED: "true",
          MACHINE_CREDENTIAL_PEPPER_VERSION: "1",
          MACHINE_CREDENTIAL_PEPPER: machineSecret(1),
          MACHINE_RATE_SECRET: machineSecret(2),
        }
      : {}),
  });
  const app = createApp({
    config,
    logger: false,
    logSink: (entry) => logs.push(entry),
    authService: {} as AuthService,
    tenantReadService: tenantReadStub,
    tenantReady: async () => true,
    ...(enabled
      ? {
          tenantWriteService: tenantWriteStub,
          machineManagementService: managementStub,
          machineSessionService: sessionStub,
          machineReady: async () => true,
        }
      : {}),
  });
  apps.push(app);
  return { app, logs };
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

function readHeaders(extra: Record<string, string | string[]> = {}) {
  return { ...CLIENT, cookie: COOKIE, ...extra };
}

function bearer(token: string, extra: Record<string, string> = {}) {
  return {
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
    ...extra,
  };
}

function validCredential(kind: "agent" | "provider"): string {
  const prefix = kind === "agent" ? "oac_ag_" : "oac_pr_";
  return `${prefix}${CREDENTIAL}_${randomBytes(32).toString("base64url")}`;
}

function realSessionToken(kind: "agent" | "provider"): string {
  const prefix = kind === "agent" ? "oas_ag_" : "oas_pr_";
  return `${prefix}${randomBytes(32).toString("base64url")}`;
}

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
      resolve({ status: Number.parseInt(text.slice(9, 12), 10), text });
    });
  });
}

async function listeningPort(app: ReturnType<typeof createApp>): Promise<number> {
  await app.listen({ port: 0, host: "127.0.0.1" });
  const address = app.server.address();
  if (address === null || typeof address === "string") throw new Error("expected TCP address");
  return address.port;
}

describe("machine management routes", () => {
  it("serves management list/status GETs that omit Origin with same-origin fetch site", async () => {
    const { app } = harness();
    const browserGet = (extra: Record<string, string>) => ({
      "x-openarc-client": "browser-v1",
      cookie: COOKIE,
      "sec-fetch-site": "same-origin",
      "sec-fetch-mode": "cors",
      "sec-fetch-dest": "empty",
      ...extra,
    });
    const agentList = await app.inject({
      method: "GET",
      url: URLS.agentCredentials,
      headers: browserGet({}),
    });
    expect(agentList.statusCode).toBe(200);
    expect(agentList.json().data.kind).toBe("agent");
    const providerList = await app.inject({
      method: "GET",
      url: URLS.providerCredentials,
      headers: browserGet({}),
    });
    expect(providerList.statusCode).toBe(200);
    expect(providerList.json().data.kind).toBe("provider");
    const agentStatus = await app.inject({
      method: "GET",
      url: URLS.agentMutation,
      headers: browserGet({}),
    });
    expect(agentStatus.statusCode).toBe(200);
    expect(agentStatus.json().data.status).toBe("not_found");
    const providerStatus = await app.inject({
      method: "GET",
      url: `${PREFIX}/${ORG}/provider-credential-mutations/${MUTATION}`,
      headers: browserGet({}),
    });
    expect(providerStatus.statusCode).toBe(200);
    expect(providerStatus.json().data.status).toBe("not_found");
    expect(MANAGEMENT_CALLS).toEqual([
      "list:agent",
      "list:provider",
      "status:agent",
      "status:provider",
    ]);
  });

  it("still accepts an exact Origin on management reads", async () => {
    const { app } = harness();
    const response = await app.inject({
      method: "GET",
      url: URLS.agentCredentials,
      headers: readHeaders({ "sec-fetch-site": "same-origin" }),
    });
    expect(response.statusCode).toBe(200);
    expect(MANAGEMENT_CALLS).toEqual(["list:agent"]);
  });

  it("fails closed on management reads with a bad or absent transport", async () => {
    const { app } = harness();
    const originless: Record<string, string> = {
      "x-openarc-client": "browser-v1",
      cookie: COOKIE,
    };
    const cases: Array<{ label: string; url: string; headers: Record<string, string>; status: number[] }> = [
      // Missing Origin AND missing same-origin fetch site.
      { label: "missing both", url: URLS.agentCredentials, headers: originless, status: [403] },
      // Missing Origin with a cross-site fetch site.
      {
        label: "cross-site",
        url: URLS.agentCredentials,
        headers: { ...originless, "sec-fetch-site": "cross-site" },
        status: [403],
      },
      // Explicit literal Origin: null.
      {
        label: "origin null",
        url: URLS.agentCredentials,
        headers: { ...originless, origin: "null", "sec-fetch-site": "same-origin" },
        status: [403],
      },
      // Foreign supplied Origin.
      {
        label: "foreign origin",
        url: URLS.providerCredentials,
        headers: { ...originless, origin: "https://evil.example", "sec-fetch-site": "same-origin" },
        status: [403],
      },
      // Empty supplied Origin.
      {
        label: "empty origin",
        url: URLS.providerCredentials,
        headers: { ...originless, origin: "", "sec-fetch-site": "same-origin" },
        status: [403],
      },
      // Bad mode even with an allowed originless same-origin request.
      {
        label: "bad mode",
        url: URLS.agentMutation,
        headers: { ...originless, "sec-fetch-site": "same-origin", "sec-fetch-mode": "navigate" },
        status: [403],
      },
      // Bad destination even with an allowed originless same-origin request.
      {
        label: "bad dest",
        url: URLS.agentMutation,
        headers: { ...originless, "sec-fetch-site": "same-origin", "sec-fetch-dest": "document" },
        status: [403],
      },
    ];
    for (const entry of cases) {
      const response = await app.inject({ method: "GET", url: entry.url, headers: entry.headers });
      expect(entry.status, entry.label).toContain(response.statusCode);
    }
    expect(MANAGEMENT_CALLS).toEqual([]);
  });

  it("keeps issuance and revocation POSTs strict when Origin is omitted despite same-origin site", async () => {
    const { app } = harness();
    // Exact browser write headers MINUS Origin: the read fallback must not leak
    // into writes even with an explicit same-origin fetch site.
    const originlessWrite = {
      "x-openarc-client": "browser-v1",
      cookie: COOKIE,
      "content-type": "application/json",
      "sec-fetch-site": "same-origin",
      "sec-fetch-mode": "cors",
      "sec-fetch-dest": "empty",
      "x-openarc-csrf": CSRF,
      "idempotency-key": IDEMPOTENCY,
    };
    const issue = await app.inject({
      method: "POST",
      url: URLS.agentCredentials,
      headers: originlessWrite,
      payload: { mutationId: MUTATION, expiresAt: SESSION_EXPIRES },
    });
    expect(issue.statusCode).toBe(403);
    const revoke = await app.inject({
      method: "POST",
      url: URLS.agentRevoke,
      headers: originlessWrite,
      payload: { mutationId: MUTATION },
    });
    expect(revoke.statusCode).toBe(403);
    expect(MANAGEMENT_CALLS).toEqual([]);
  });

  it("serves list GET and issue POST on the shared path with a strict v2 envelope", async () => {
    const { app } = harness();
    const list = await app.inject({ method: "GET", url: URLS.agentCredentials, headers: readHeaders() });
    expect(list.statusCode).toBe(200);
    expect(list.json().meta.schemaVersion).toBe("openarc.api.v2");
    expect(list.json().data.kind).toBe("agent");
    const issue = await app.inject({
      method: "POST",
      url: URLS.agentCredentials,
      headers: writeHeaders(),
      payload: { mutationId: MUTATION, expiresAt: SESSION_EXPIRES },
    });
    expect(issue.statusCode).toBe(200);
    expect(issue.json().data.delivery.status).toBe("token_not_replayable");
    expect(issue.headers["set-cookie"]).toBeUndefined();
    expect(MANAGEMENT_CALLS).toEqual(["list:agent", "issue:agent"]);
  });

  it("serves revoke POST and mutation status GET", async () => {
    const { app } = harness();
    const revoke = await app.inject({
      method: "POST",
      url: URLS.agentRevoke,
      headers: writeHeaders(),
      payload: { mutationId: MUTATION },
    });
    expect(revoke.statusCode).toBe(200);
    expect(revoke.json().data.receipt.credentialId).toBe(CREDENTIAL);
    const status = await app.inject({ method: "GET", url: URLS.agentMutation, headers: readHeaders() });
    expect(status.statusCode).toBe(200);
    expect(status.json().data.status).toBe("not_found");
    expect(JSON.stringify(status.json())).not.toContain("receipt");
    expect(MANAGEMENT_CALLS).toEqual(["revoke:agent", "status:agent"]);
  });

  it("allows only the list query keys, exactly once, with a canonical limit and cursor", async () => {
    const { app } = harness();
    const ok = await app.inject({
      method: "GET",
      url: `${URLS.agentCredentials}?limit=50&after=${MUTATION}`,
      headers: readHeaders(),
    });
    expect(ok.statusCode).toBe(200);
    const cases = [
      `${URLS.agentCredentials}?limit=51`,
      `${URLS.agentCredentials}?limit=0`,
      `${URLS.agentCredentials}?limit=01`,
      `${URLS.agentCredentials}?limit=10&limit=10`,
      `${URLS.agentCredentials}?after=not-a-uuid`,
      `${URLS.agentCredentials}?unknown=1`,
      `${URLS.agentCredentials}?limit=`,
    ];
    for (const url of cases) {
      const response = await app.inject({ method: "GET", url, headers: readHeaders() });
      expect(response.statusCode, url).toBe(400);
    }
  });

  it("rejects a status query including a bare ?", async () => {
    // Some HTTP injectors normalize a bare `?` away; a real request target
    // preserves it, so the exact rule is asserted on the target predicate.
    expect(isForbiddenMachineRequestTarget(`${URLS.agentMutation}?`)).toBe(true);
    expect(isForbiddenMachineRequestTarget(`${URLS.agentMutation}?x=1`)).toBe(true);
    expect(isForbiddenMachineRequestTarget(URLS.agentMutation)).toBe(false);
    const { app } = harness();
    const response = await app.inject({
      method: "GET",
      url: `${URLS.agentMutation}?x=1`,
      headers: readHeaders(),
    });
    expect(response.statusCode).toBe(400);
  });

  it("rejects wrong methods, transports, media, bodies, auth headers and CSRF absence", async () => {
    const { app } = harness();
    const cases: Array<{ method: "GET" | "POST" | "DELETE"; url: string; headers: Record<string, string>; payload?: Record<string, unknown>; status: number[] }> = [
      { method: "DELETE", url: URLS.agentCredentials, headers: writeHeaders(), status: [405] },
      { method: "POST", url: URLS.agentCredentials, headers: writeHeaders({ origin: "https://evil.example" }), payload: { mutationId: MUTATION, expiresAt: SESSION_EXPIRES }, status: [403] },
      { method: "POST", url: URLS.agentCredentials, headers: writeHeaders({ "x-openarc-client": "other" }), payload: { mutationId: MUTATION, expiresAt: SESSION_EXPIRES }, status: [403] },
      { method: "POST", url: URLS.agentCredentials, headers: writeHeaders({ authorization: "Bearer x" }), payload: { mutationId: MUTATION, expiresAt: SESSION_EXPIRES }, status: [400] },
      { method: "POST", url: URLS.agentCredentials, headers: writeHeaders({ "content-type": "text/plain" }), payload: { mutationId: MUTATION, expiresAt: SESSION_EXPIRES }, status: [415] },
      { method: "POST", url: URLS.agentCredentials, headers: writeHeaders({ "idempotency-key": "short" }), payload: { mutationId: MUTATION, expiresAt: SESSION_EXPIRES }, status: [400] },
      { method: "POST", url: URLS.agentCredentials, headers: writeHeaders({ "x-openarc-csrf": "" }), payload: { mutationId: MUTATION, expiresAt: SESSION_EXPIRES }, status: [400] },
      { method: "GET", url: `${URLS.agentCredentials}?limit=1`, headers: readHeaders(), status: [200] },
      { method: "POST", url: `${URLS.agentCredentials}?x=1`, headers: writeHeaders(), payload: { mutationId: MUTATION, expiresAt: SESSION_EXPIRES }, status: [400] },
      { method: "POST", url: URLS.agentCredentials, headers: writeHeaders(), payload: { mutationId: MUTATION, expiresAt: SESSION_EXPIRES, extra: 1 }, status: [400] },
      { method: "POST", url: URLS.agentCredentials, headers: writeHeaders(), payload: { mutationId: "nope", expiresAt: SESSION_EXPIRES }, status: [400] },
    ];
    for (const entry of cases) {
      const response = await app.inject({
        method: entry.method,
        url: entry.url,
        headers: entry.headers,
        ...(entry.payload !== undefined ? { payload: entry.payload } : {}),
      });
      expect(entry.status, `${entry.method} ${entry.url}`).toContain(response.statusCode);
    }
  });

  it("rejects duplicate critical headers on the raw wire", async () => {
    const { app } = harness();
    const port = await listeningPort(app);
    const payload = JSON.stringify({ mutationId: MUTATION, expiresAt: SESSION_EXPIRES });
    const base = [
      `Origin: ${ORIGIN}`,
      "X-OpenArc-Client: browser-v1",
      "Content-Type: application/json",
      `Cookie: ${COOKIE}`,
      `X-OpenArc-Csrf: ${CSRF}`,
      `Idempotency-Key: ${IDEMPOTENCY}`,
    ];
    const duplicates = [
      [...base, `Origin: ${ORIGIN}`],
      [...base, "Content-Type: application/json"],
      [...base, "Authorization: Bearer x"],
      [...base, "Authorization: Bearer y"],
      [...base, "Cookie: other=1", "Cookie: other=2"],
    ];
    for (const headers of duplicates) {
      const response = await rawHttp(port, "POST", URLS.agentCredentials, headers, payload);
      expect([400, 403, 415], headers.join("|")).toContain(response.status);
    }
    expect(MANAGEMENT_CALLS).toEqual([]);
  });

  it("returns a fixed 404 for the whole family when the flag is off", async () => {
    const { app } = harness({ enabled: false });
    const response = await app.inject({
      method: "GET",
      url: URLS.agentCredentials,
      headers: readHeaders(),
    });
    expect(response.statusCode).toBe(404);
    expect(response.json().meta.schemaVersion).toBe("openarc.api.v2");
    expect(response.json().error.code).toBe("FEATURE_DISABLED");
    expect(response.json().error.retryable).toBe(false);
    expect(response.headers["set-cookie"]).toBeUndefined();
    expect(MANAGEMENT_CALLS).toEqual([]);
  });

  it("keeps the whole disabled family on the bounded v2 404 envelope for every method", async () => {
    const { app } = harness({ enabled: false });
    for (const method of ["GET", "POST", "PUT", "DELETE"] as const) {
      const response = await app.inject({
        method,
        url: URLS.providerCredentials,
        headers: method === "GET" ? readHeaders() : writeHeaders(),
        ...(method === "POST" || method === "PUT" ? { payload: {} } : {}),
      });
      expect(response.statusCode, method).toBe(404);
      expect(response.json().meta.schemaVersion, method).toBe("openarc.api.v2");
      expect(response.json().error.code, method).toBe("FEATURE_DISABLED");
      expect(response.body, method).not.toContain(ORG);
    }
    expect(MANAGEMENT_CALLS).toEqual([]);
  });

  it("classifies unsupported and malformed machine-management paths as v2, not legacy", async () => {
    const { app } = harness();
    const unsupported = await app.inject({
      method: "GET",
      url: `${URLS.agentCredentials}/extra`,
      headers: readHeaders(),
    });
    expect(unsupported.statusCode).toBe(404);
    expect(unsupported.json().meta.schemaVersion).toBe("openarc.api.v2");
    expect(unsupported.json().error.code).toBe("FEATURE_DISABLED");

    const malformed = await app.inject({
      method: "GET",
      url: `${PREFIX}/${ORG}/agents/%zz/credentials`,
      headers: readHeaders(),
    });
    expect(malformed.statusCode).toBe(400);
    expect(malformed.json().meta.schemaVersion).toBe("openarc.api.v2");
    expect(malformed.json().error.code).toBe("INVALID_REQUEST");
    expect(malformed.body).not.toContain("%zz");

    // A lookalike outside the frozen machine family keeps the legacy envelope.
    const lookalike = await app.inject({
      method: "GET",
      url: `${PREFIX}XYZ/agents/some/credentials`,
      headers: readHeaders(),
    });
    expect(lookalike.statusCode).toBe(404);
    expect(lookalike.json().meta.schemaVersion).toBe("openarc.api.v1");
  });
});

describe("machine session routes", () => {
  it("exchanges a long-lived credential and returns one-time session metadata", async () => {
    const { app } = harness();
    const response = await app.inject({
      method: "POST",
      url: URLS.agentExchange,
      headers: bearer(validCredential("agent")),
      payload: {},
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().data.session.kind).toBe("agent");
    expect(response.json().data.delivery.token).toMatch(/^oas_ag_/);
    expect(response.headers["set-cookie"]).toBeUndefined();
    expect(response.headers["access-control-allow-origin"]).toBeUndefined();
    expect(SESSION_CALLS).toEqual(["exchange:agent"]);
  });

  it("serves self and current revoke with a short session token", async () => {
    const { app } = harness();
    const self = await app.inject({
      method: "GET",
      url: URLS.agentSelf,
      headers: { authorization: `Bearer ${realSessionToken("agent")}` },
    });
    expect(self.statusCode).toBe(200);
    expect(self.json().data.session.kind).toBe("agent");
    const revoke = await app.inject({
      method: "POST",
      url: URLS.agentSessionRevoke,
      headers: bearer(realSessionToken("agent")),
      payload: {},
    });
    expect(revoke.statusCode).toBe(200);
    expect(SESSION_CALLS).toEqual(["self:agent", "revoke:agent"]);
  });

  it("rejects browser headers, cookies, origin, CSRF, idempotency and fetch metadata", async () => {
    const { app } = harness();
    const forbidden: Record<string, string>[] = [
      { cookie: COOKIE },
      { origin: ORIGIN },
      { "x-openarc-client": "browser-v1" },
      { "x-openarc-csrf": CSRF },
      { "idempotency-key": IDEMPOTENCY },
      { "sec-fetch-site": "same-origin" },
    ];
    for (const extra of forbidden) {
      const response = await app.inject({
        method: "POST",
        url: URLS.agentExchange,
        headers: bearer(validCredential("agent"), extra),
        payload: {},
      });
      expect(response.statusCode, JSON.stringify(extra)).toBe(400);
    }
    expect(SESSION_CALLS).toEqual([]);
  });

  it("rejects wrong methods, malformed tokens, wrong namespace, media, bodies and queries", async () => {
    const { app } = harness();
    const cases: Array<{ method: "GET" | "POST" | "DELETE"; url: string; headers: Record<string, string>; payload?: Record<string, unknown>; status: number[] }> = [
      { method: "GET", url: URLS.agentExchange, headers: { authorization: `Bearer ${validCredential("agent")}` }, status: [405] },
      { method: "POST", url: URLS.agentSelf, headers: bearer(realSessionToken("agent")), payload: {}, status: [405] },
      { method: "POST", url: URLS.agentExchange, headers: { authorization: `Bearer ${validCredential("agent")}`, "content-type": "text/plain" }, payload: {}, status: [415] },
      { method: "POST", url: URLS.agentExchange, headers: bearer(validCredential("agent")), payload: { token: "x" }, status: [400] },
      { method: "POST", url: `${URLS.agentExchange}?x=1`, headers: bearer(validCredential("agent")), payload: {}, status: [400] },
      { method: "GET", url: `${URLS.agentSelf}?x=1`, headers: { authorization: `Bearer ${realSessionToken("agent")}` }, status: [400] },
      { method: "POST", url: URLS.agentExchange, headers: { "content-type": "application/json" }, payload: {}, status: [400] },
    ];
    for (const entry of cases) {
      const response = await app.inject({
        method: entry.method,
        url: entry.url,
        headers: entry.headers,
        ...(entry.payload !== undefined ? { payload: entry.payload } : {}),
      });
      expect(entry.status, `${entry.method} ${entry.url}`).toContain(response.statusCode);
    }
    expect(isForbiddenSessionRequestTarget(`${URLS.agentSelf}?`)).toBe(true);
    expect(isForbiddenSessionRequestTarget(URLS.agentSelf)).toBe(false);
    // Only the provider-namespace call reaches the service as a valid shape.
    expect(SESSION_CALLS).toEqual([]);
  });

  it("rejects duplicate Authorization lines on the raw wire", async () => {
    const { app } = harness();
    const port = await listeningPort(app);
    const response = await rawHttp(
      port,
      "POST",
      URLS.agentExchange,
      [
        `Authorization: Bearer ${validCredential("agent")}`,
        `Authorization: Bearer ${validCredential("agent")}`,
        "Content-Type: application/json",
      ],
      "{}",
    );
    expect(response.status).toBe(400);
    expect(SESSION_CALLS).toEqual([]);
  });

  it("returns a fixed FEATURE_DISABLED v2 envelope when the flag is off", async () => {
    const { app } = harness({ enabled: false });
    const response = await app.inject({
      method: "POST",
      url: URLS.agentExchange,
      headers: bearer(validCredential("agent")),
      payload: {},
    });
    expect(response.statusCode).toBe(503);
    expect(response.json().error.code).toBe("FEATURE_DISABLED");
    expect(SESSION_CALLS).toEqual([]);
  });

  it("keeps unsupported machine-session paths on the bounded v2 404 envelope", async () => {
    const { app } = harness();
    for (const url of ["/v1/agent/unknown", "/v1/provider/sessions/extra"]) {
      const response = await app.inject({
        method: "GET",
        url,
        headers: { authorization: `Bearer ${realSessionToken("agent")}` },
      });
      expect(response.statusCode, url).toBe(404);
      expect(response.json().meta.schemaVersion, url).toBe("openarc.api.v2");
      expect(response.json().error.code, url).toBe("FEATURE_DISABLED");
      expect(response.headers["set-cookie"], url).toBeUndefined();
      expect(response.headers["access-control-allow-origin"], url).toBeUndefined();
    }
    expect(SESSION_CALLS).toEqual([]);
  });
});
