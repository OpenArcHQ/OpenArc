import { createHash } from "node:crypto";

import { afterEach, describe, expect, it } from "vitest";

import type {
  CommerceAgentPage,
  CommerceOrganizationContext,
  CommerceOrganizationPage,
  CommerceProviderPage,
} from "@openarc/shared";
import { TenantStoreError } from "@openarc/db";

import { createApp, type CompletionLog } from "../src/app.js";
import { AUTH_ERRORS } from "../src/auth/errors.js";
import type { AuthApiError } from "../src/auth/errors.js";
import type { AuthService, AuthServiceConfig } from "../src/auth/service.js";
import { AuthService as RealAuthService } from "../src/auth/service.js";
import type { AuthProofPort, AuthRuntime, AuthStorePort } from "../src/auth/ports.js";
import type { AuthOriginConfig } from "../src/auth/proofs.js";
import { loadConfig } from "../src/config.js";
import { TenantReadService } from "../src/tenant/service.js";
import {
  TENANT_ROUTES,
  TENANT_ROUTE_PREFIX,
} from "../src/tenant/routes.js";
import type {
  TenantGetOrganizationAccessResult,
  TenantListAgentsResult,
  TenantListOrganizationsResult,
  TenantListProvidersResult,
  TenantReadAuthPort,
  TenantReadStorePort,
} from "../src/tenant/ports.js";

/**
 * Unit and HTTP-inject coverage for the protected tenant read family.
 *
 * The TenantStore and the auth store are HONESTLY MOCKED here: these tests
 * prove transport, strict path/query parsing, envelope shape, response
 * integrity checks, fail-closed error mapping and log hygiene. Real roles,
 * sessions, membership and locks are covered by tenant-reads.postgres.test.ts.
 */

const ORIGIN = "http://localhost:5183";
const RP_ID = "localhost";
const SECRET = "synthetic_auth_secret_for_tenant_tests_0123456789";
const BUILD_SHA = "0123456789abcdef0123456789abcdef01234567";
const HASH = "a".repeat(64);
const CLIENT = { origin: ORIGIN, "x-openarc-client": "browser-v1" };

const ORG = "openarc:org:11111111-1111-4111-8111-111111111111";
const ORG2 = "openarc:org:11111111-1111-4111-8111-111111111112";
const ACCOUNT = "openarc:account:22222222-2222-4222-8222-222222222222";
const ACCOUNT2 = "openarc:account:22222222-2222-4222-8222-222222222223";
const AGENT = "openarc:agent:33333333-3333-4333-8333-333333333333";
const CREATED = "2026-01-01T00:00:00.000Z";
const UPDATED = "2026-01-02T00:00:00.000Z";

function orgPage(): CommerceOrganizationPage {
  return {
    items: [
      {
        schemaVersion: "openarc.organization.v1",
        organizationId: ORG,
        displayName: "Acme",
        createdAt: CREATED,
        updatedAt: UPDATED,
      },
    ],
    nextCursor: null,
  };
}

function context(): CommerceOrganizationContext {
  return {
    organization: {
      schemaVersion: "openarc.organization.v1",
      organizationId: ORG,
      displayName: "Acme",
      createdAt: CREATED,
      updatedAt: UPDATED,
    },
    access: {
      schemaVersion: "openarc.organization-access.v1",
      organizationId: ORG,
      accountId: ACCOUNT,
      role: "owner",
      membershipStatus: "active",
      sessionExpiresAt: UPDATED,
    },
    network: "eip155:5042002",
  };
}

function agentPage(organizationId = ORG): CommerceAgentPage {
  return { organizationId, items: [], nextCursor: null };
}

function providerPage(organizationId = ORG): CommerceProviderPage {
  return { organizationId, items: [], nextCursor: null };
}

class FakeAuth implements TenantReadAuthPort {
  beginCalls = 0;
  finishCalls = 0;
  beginError: AuthApiError | undefined;
  finishError: AuthApiError | undefined;
  accountId = ACCOUNT;
  async beginTenantRead(): Promise<{ sessionHash: string; accountId: string }> {
    this.beginCalls += 1;
    if (this.beginError) throw this.beginError;
    return { sessionHash: HASH, accountId: this.accountId };
  }
  async finishTenantRead(): Promise<void> {
    this.finishCalls += 1;
    if (this.finishError) throw this.finishError;
  }
}

class FakeStore implements TenantReadStorePort {
  calls: string[] = [];
  orgResult: unknown = orgPage();
  contextResult: unknown = context();
  agentsResult: unknown = agentPage();
  providersResult: unknown = providerPage();
  error: unknown;

  async listOrganizations(): Promise<TenantListOrganizationsResult> {
    this.calls.push("listOrganizations");
    if (this.error) throw this.error;
    return this.orgResult as TenantListOrganizationsResult;
  }
  async getOrganizationAccess(): Promise<TenantGetOrganizationAccessResult> {
    this.calls.push("getOrganizationAccess");
    if (this.error) throw this.error;
    return this.contextResult as TenantGetOrganizationAccessResult;
  }
  async listAgents(): Promise<TenantListAgentsResult> {
    this.calls.push("listAgents");
    if (this.error) throw this.error;
    return this.agentsResult as TenantListAgentsResult;
  }
  async listProviders(): Promise<TenantListProvidersResult> {
    this.calls.push("listProviders");
    if (this.error) throw this.error;
    return this.providersResult as TenantListProvidersResult;
  }
}

const apps: ReturnType<typeof createApp>[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map(async (app) => app.close()));
});

interface HarnessOptions {
  readonly tenantEnabled?: boolean;
  readonly maxResponseBytes?: number;
}

function harness(options: HarnessOptions = {}) {
  const store = new FakeStore();
  const auth = new FakeAuth();
  const service = new TenantReadService({ auth, store });
  const logs: CompletionLog[] = [];
  const tenantEnabled = options.tenantEnabled ?? true;
  const config = loadConfig({
    NODE_ENV: "test",
    APP_ORIGIN: ORIGIN,
    COMMIT_SHA: BUILD_SHA,
    ...(tenantEnabled
      ? {
          AUTH_ENABLED: "true",
          AUTH_DATABASE_URL:
            "postgres://openarc_auth_app:x@127.0.0.1:5432/openarc_auth_test",
          AUTH_SECRET: SECRET,
          AUTH_RP_ID: RP_ID,
          TENANT_READS_ENABLED: "true",
          TENANT_DATABASE_URL:
            "postgres://openarc_tenant_app:y@127.0.0.1:5432/openarc_auth_test",
        }
      : {}),
  });
  const app = createApp({
    config,
    logger: false,
    logSink: (entry) => logs.push(entry),
    ...(tenantEnabled
      ? {
          authService: {} as AuthService,
          tenantReadService: service,
          tenantReady: async () => true,
          ...(options.maxResponseBytes !== undefined
            ? { tenantMaxResponseBytes: options.maxResponseBytes }
            : {}),
        }
      : {}),
  });
  apps.push(app);
  return { app, store, auth, logs };
}

function sessionHeaders(extra: Record<string, string> = {}) {
  return {
    ...CLIENT,
    cookie: "openarc_session=abc",
    ...extra,
  };
}

function v2ErrorCode(response: { json: () => unknown }): string {
  const body = response.json() as { error?: { code?: string } };
  return body.error?.code ?? "";
}

describe("tenant read success envelopes", () => {
  it("lists organizations through the accepted strict envelope", async () => {
    const { app, store } = harness();
    const response = await app.inject({
      method: "GET",
      url: TENANT_ROUTES.organizations,
      headers: sessionHeaders(),
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.ok).toBe(true);
    expect(body.meta.schemaVersion).toBe("openarc.api.v2");
    expect(body.data.items[0].organizationId).toBe(ORG);
    expect(store.calls).toEqual(["listOrganizations"]);
    expect(response.headers["set-cookie"]).toBeUndefined();
  });

  it("returns the requested organization context with the fixed network", async () => {
    const { app, store } = harness();
    const response = await app.inject({
      method: "GET",
      url: `${TENANT_ROUTES.organizations}/${ORG}`,
      headers: sessionHeaders(),
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().data.network).toBe("eip155:5042002");
    expect(response.json().data.access.accountId).toBe(ACCOUNT);
    expect(store.calls).toEqual(["getOrganizationAccess"]);
  });

  it("returns agent and provider pages bound to the requested organization", async () => {
    const { app } = harness();
    const agents = await app.inject({
      method: "GET",
      url: `${TENANT_ROUTES.organizations}/${ORG}/agents`,
      headers: sessionHeaders(),
    });
    expect(agents.statusCode).toBe(200);
    expect(agents.json().data.organizationId).toBe(ORG);
    const providers = await app.inject({
      method: "GET",
      url: `${TENANT_ROUTES.organizations}/${ORG}/providers`,
      headers: sessionHeaders(),
    });
    expect(providers.statusCode).toBe(200);
    expect(providers.json().data.organizationId).toBe(ORG);
  });

  it("accepts the frontend's encodeURIComponent organization on every scoped route", async () => {
    const { app, store } = harness();
    const encoded = encodeURIComponent(ORG);
    const scoped = [
      { suffix: "", store: ["getOrganizationAccess"] },
      { suffix: "/agents", store: ["listAgents"] },
      { suffix: "/providers", store: ["listProviders"] },
    ] as const;
    for (const route of scoped) {
      const response = await app.inject({
        method: "GET",
        url: `${TENANT_ROUTES.organizations}/${encoded}${route.suffix}`,
        headers: sessionHeaders(),
      });
      expect(response.statusCode, route.suffix).toBe(200);
      if (route.suffix === "") {
        expect(response.json().data.organization.organizationId).toBe(ORG);
        expect(response.json().data.access.organizationId).toBe(ORG);
      } else {
        expect(response.json().data.organizationId).toBe(ORG);
      }
    }
    expect(store.calls).toEqual([
      "getOrganizationAccess",
      "listAgents",
      "listProviders",
    ]);
  });

  it("passes a canonical limit and a canonical cursor to the store", async () => {
    const { app, store } = harness();
    const response = await app.inject({
      method: "GET",
      url: `${TENANT_ROUTES.organizations}?limit=100&afterOrganizationId=${ORG}`,
      headers: sessionHeaders(),
    });
    expect(response.statusCode).toBe(200);
    expect(store.calls).toEqual(["listOrganizations"]);
  });
});

describe("strict path and query parsing", () => {
  const badQueries = [
    "?limit=1&limit=2",
    "?limit=1&unknown=2",
    "?limit=",
    "?limit=%zz",
    "?limit=0",
    "?limit=101",
    "?limit=01",
    "?limit=+1",
    "?limit=1e1",
    "?limit=1.0",
    "?afterOrganizationId=openarc%3Aorg%3Abad",
  ];

  it("rejects repeated, unknown, empty, noncanonical and invalid-encoding queries", async () => {
    const { app, store, auth } = harness();
    for (const query of badQueries) {
      const response = await app.inject({
        method: "GET",
        url: `${TENANT_ROUTES.organizations}${query}`,
        headers: sessionHeaders(),
      });
      expect(response.statusCode, query).toBe(400);
    }
    expect(store.calls).toEqual([]);
    expect(auth.beginCalls).toBe(0);
  });

  it("rejects a query on the context route", async () => {
    const { app } = harness();
    const response = await app.inject({
      method: "GET",
      url: `${TENANT_ROUTES.organizations}/${ORG}?limit=1`,
      headers: sessionHeaders(),
    });
    expect(response.statusCode).toBe(400);
  });

  it("rejects encoded separators and noncanonical organization paths", async () => {
    const { app, store } = harness();
    for (const suffix of [
      "openarc:org:11111111-1111-4111-8111-111111111111%2Fagents",
      "not-a-real-id",
    ]) {
      const response = await app.inject({
        method: "GET",
        url: `${TENANT_ROUTES.organizations}/${suffix}`,
        headers: sessionHeaders(),
      });
      expect([400, 404], suffix).toContain(response.statusCode);
    }
    expect(store.calls).toEqual([]);
  });

  it("rejects malformed, double-encoded and encoded-separator organization segments", async () => {
    const { app, store, auth } = harness();
    const failures = [
      "%zz",
      "%2",
      "%",
      "openarc%253Aorg%253A11111111-1111-4111-8111-111111111111",
      "openarc%3Aorg%3A11111111-1111-4111-8111-111111111111%2Fagents",
      "openarc%3Aorg%3A11111111-1111-4111-8111-111111111111%2Fproviders",
      "openarc%3Aorg%3A11111111-1111-4111-8111-111111111111%00",
      "%3Cscript%3E",
    ];
    for (const suffix of failures) {
      for (const route of ["", "/agents", "/providers"] as const) {
        const response = await app.inject({
          method: "GET",
          url: `${TENANT_ROUTES.organizations}/${suffix}${route}`,
          headers: sessionHeaders(),
        });
        expect(response.statusCode, `${suffix}${route}`).toBe(400);
      }
    }
    expect(store.calls).toEqual([]);
    expect(auth.beginCalls).toBe(0);
  });
});

describe("bounded v2 errors for the tenant family", () => {
  it("returns a strict v2 error for a malformed percent path before the handler", async () => {
    const { app, store, auth } = harness();
    const canary = "PRIVATE_PATH_CANARY";
    const response = await app.inject({
      method: "GET",
      url: `${TENANT_ROUTES.organizations}/%zz?x=${canary}`,
      headers: sessionHeaders(),
    });
    expect(response.statusCode).toBe(400);
    const body = response.json();
    expect(body.meta?.schemaVersion, response.body).toBe("openarc.api.v2");
    expect(body.error.code).toBe("INVALID_REQUEST");
    expect(response.body).not.toContain(canary);
    expect(response.body).not.toContain("%zz");
    expect(store.calls).toEqual([]);
    expect(auth.beginCalls).toBe(0);
  });

  it("keeps lookalike prefixes and paths outside the family on the legacy envelope", async () => {
    const { app } = harness();
    const response = await app.inject({
      method: "GET",
      url: `${TENANT_ROUTE_PREFIX}XYZ`,
      headers: sessionHeaders(),
    });
    expect(response.statusCode).toBe(404);
    expect(response.json().meta.schemaVersion).toBe("openarc.api.v1");

    // A malformed URL on the lookalike prefix is NOT the bounded tenant family:
    // it keeps the legacy v1 400 shape instead of a v2 envelope or a 500.
    const malformed = await app.inject({
      method: "GET",
      url: `${TENANT_ROUTE_PREFIX}XYZ/%zz`,
      headers: sessionHeaders(),
    });
    expect(malformed.statusCode).toBe(400);
    expect(malformed.json().meta.schemaVersion).toBe("openarc.api.v1");
  });
});

describe("transport enforcement", () => {
  it("rejects wrong methods with a fixed 405 and no auth call", async () => {
    const { app, auth, store } = harness();
    for (const method of ["HEAD", "POST", "PUT", "OPTIONS"] as const) {
      const response = await app.inject({
        method,
        url: TENANT_ROUTES.organizations,
        headers: sessionHeaders(),
        ...(method === "POST" || method === "PUT" ? { payload: {} } : {}),
      });
      expect(response.statusCode, method).toBe(405);
      expect(v2ErrorCode(response)).toBe("INVALID_REQUEST");
    }
    expect(auth.beginCalls).toBe(0);
    expect(store.calls).toEqual([]);
  });

  it("rejects wrong origin, client header and fetch metadata before any auth call", async () => {
    const { app, auth, store } = harness();
    const cases: Array<Record<string, string>> = [
      { ...CLIENT, origin: "https://evil.example", cookie: "openarc_session=abc" },
      { ...CLIENT, "x-openarc-client": "other", cookie: "openarc_session=abc" },
      { ...CLIENT, "sec-fetch-site": "cross-site", cookie: "openarc_session=abc" },
      { ...CLIENT, "sec-fetch-mode": "navigate", cookie: "openarc_session=abc" },
      { ...CLIENT, "sec-fetch-dest": "document", cookie: "openarc_session=abc" },
      { ...CLIENT, authorization: "Bearer x", cookie: "openarc_session=abc" },
      { ...CLIENT, cookie: "openarc_session=a; openarc_session=b" },
    ];
    for (const headers of cases) {
      const response = await app.inject({
        method: "GET",
        url: TENANT_ROUTES.organizations,
        headers,
      });
      expect([400, 403]).toContain(response.statusCode);
    }
    expect(auth.beginCalls).toBe(0);
    expect(store.calls).toEqual([]);
  });

  it("allows an originless same-origin GET and rejects a body", async () => {
    const { app, store } = harness();
    const originless = await app.inject({
      method: "GET",
      url: TENANT_ROUTES.organizations,
      headers: {
        "x-openarc-client": "browser-v1",
        "sec-fetch-site": "same-origin",
        cookie: "openarc_session=abc",
      },
    });
    expect(originless.statusCode).toBe(200);
    const withBody = await app.inject({
      method: "GET",
      url: TENANT_ROUTES.organizations,
      headers: { ...sessionHeaders(), "content-type": "text/plain" },
      payload: "hello",
    });
    expect(withBody.statusCode).toBe(400);
    expect(store.calls).toEqual(["listOrganizations"]);
  });
});

describe("disabled family", () => {
  it("returns 503 FEATURE_DISABLED and performs no store call", async () => {
    const { app } = harness({ tenantEnabled: false });
    for (const url of [
      TENANT_ROUTES.organizations,
      `${TENANT_ROUTES.organizations}/${ORG}`,
      `${TENANT_ROUTES.organizations}/${ORG}/agents`,
      `${TENANT_ROUTES.organizations}/${ORG}/providers`,
    ]) {
      const response = await app.inject({
        method: "GET",
        url,
        headers: sessionHeaders(),
      });
      expect(response.statusCode, url).toBe(503);
      expect(v2ErrorCode(response), url).toBe("FEATURE_DISABLED");
    }
  });
});

describe("response integrity", () => {
  it("fails closed when the repository returns forged or mixed-organization data", async () => {
    const forged = harness();
    forged.store.orgResult = {
      items: [{ ...orgPage().items[0], secret: "PRIVATE_CANARY" }],
      nextCursor: null,
    };
    const forgedResponse = await forged.app.inject({
      method: "GET",
      url: TENANT_ROUTES.organizations,
      headers: sessionHeaders(),
    });
    expect(forgedResponse.statusCode).toBe(500);
    expect(forgedResponse.body).not.toContain("PRIVATE_CANARY");

    const mixed = harness();
    mixed.store.agentsResult = {
      organizationId: ORG,
      items: [
        {
          schemaVersion: "openarc.agent-profile.v1",
          agentId: AGENT,
          organizationId: ORG2,
          displayName: "X",
          status: "active",
          createdAt: CREATED,
          updatedAt: UPDATED,
        },
      ],
      nextCursor: AGENT,
    };
    const mixedResponse = await mixed.app.inject({
      method: "GET",
      url: `${TENANT_ROUTES.organizations}/${ORG}/agents`,
      headers: sessionHeaders(),
    });
    expect(mixedResponse.statusCode).toBe(500);
  });

  it("fails closed when the resolved account differs from the session account", async () => {
    const { app, store } = harness();
    store.contextResult = {
      ...context(),
      access: { ...context().access, accountId: ACCOUNT2 },
    };
    const response = await app.inject({
      method: "GET",
      url: `${TENANT_ROUTES.organizations}/${ORG}`,
      headers: sessionHeaders(),
    });
    expect(response.statusCode).toBe(500);
  });

  it("fails closed when the serialized envelope exceeds the response bound", async () => {
    const { app } = harness({ maxResponseBytes: 16 });
    const response = await app.inject({
      method: "GET",
      url: TENANT_ROUTES.organizations,
      headers: sessionHeaders(),
    });
    expect(response.statusCode).toBe(500);
  });
});

describe("repository error mapping", () => {
  it("maps forbidden and session failures to fixed v2 errors with no cause", async () => {
    const forbiddenStore = harness();
    forbiddenStore.store.error = new TenantStoreError("TENANT_STORE_FORBIDDEN");
    const forbidden = await forbiddenStore.app.inject({
      method: "GET",
      url: TENANT_ROUTES.organizations,
      headers: sessionHeaders(),
    });
    expect(forbidden.statusCode).toBe(403);
    expect(v2ErrorCode(forbidden)).toBe("FORBIDDEN");
    expect(forbidden.body).not.toContain("raw detail");
  });

  it("blocks delivery when the session is revoked after the repository read", async () => {
    const { app, store, auth } = harness();
    auth.finishError = AUTH_ERRORS.unauthenticated();
    const response = await app.inject({
      method: "GET",
      url: TENANT_ROUTES.organizations,
      headers: sessionHeaders(),
    });
    expect(response.statusCode).toBe(401);
    expect(store.calls).toEqual(["listOrganizations"]);
    expect(response.body).not.toContain(ORG);
  });

  it("blocks delivery when the begin session guard rejects", async () => {
    const { app, auth, store } = harness();
    auth.beginError = AUTH_ERRORS.unauthenticated();
    const response = await app.inject({
      method: "GET",
      url: TENANT_ROUTES.organizations,
      headers: sessionHeaders(),
    });
    expect(response.statusCode).toBe(401);
    expect(store.calls).toEqual([]);
  });
});

describe("log hygiene", () => {
  it("never logs raw query, cookie, header or repository detail", async () => {
    const { app, logs, auth } = harness();
    auth.finishError = AUTH_ERRORS.unauthenticated();
    const canary = "PRIVATE_QUERY_CANARY";
    const response = await app.inject({
      method: "GET",
      url: `${TENANT_ROUTES.organizations}?afterOrganizationId=${canary}`,
      headers: sessionHeaders({ "x-openarc-csrf": canary }),
    });
    expect([400, 401]).toContain(response.statusCode);
    expect(response.body).not.toContain(canary);
    for (const entry of logs) {
      const serialized = JSON.stringify(entry);
      expect(serialized).not.toContain(canary);
      expect(serialized).not.toContain("openarc_session");
    }
    expect(logs.length).toBeGreaterThan(0);
    expect(logs[0]?.route).toBe("tenant");
  });
});

/* ------------------------------------------------------------------ */
/* Real AuthService internal seam                                      */
/* ------------------------------------------------------------------ */

const AUTH_CONFIG: AuthServiceConfig = {
  authSecret: SECRET,
  appOrigin: ORIGIN,
  rpId: RP_ID,
  environment: "development",
  secureCookies: false,
  cookieNames: { session: "openarc_session", binding: "openarc_binding" },
};

function fakeProofs(): AuthProofPort {
  return {
    validateAuthOriginConfig: (input: unknown): AuthOriginConfig => {
      const value = input as AuthOriginConfig;
      return value;
    },
  } as unknown as AuthProofPort;
}

function fakeRuntime(): AuthRuntime {
  return { randomBytes: (size) => new Uint8Array(size), now: () => new Date() };
}

function authStore(partial: Partial<AuthStorePort>): AuthStorePort {
  return {
    issueChallenge: async () => { throw new Error("unused"); },
    consumeChallenge: async () => { throw new Error("unused"); },
    createPasskeyAccount: async () => { throw new Error("unused"); },
    findPasskey: async () => null,
    loginWallet: async () => { throw new Error("unused"); },
    loginPasskey: async () => { throw new Error("unused"); },
    logout: async () => undefined,
    addPasskey: async () => { throw new Error("unused"); },
    linkWallet: async () => undefined,
    replaceRecoveryCodes: async () => undefined,
    redeemRecoveryCode: async () => { throw new Error("unused"); },
    purgeExpired: async () => ({ challenges: 0, sessions: 0, rateLimits: 0 }),
    ...partial,
    getSession: partial.getSession ?? (async () => null),
    consumeRateLimit:
      partial.consumeRateLimit ?? (async () => ({ allowed: true })),
  } as AuthStorePort;
}

function cookies(session: string | null, binding: string | null = null) {
  return { session, binding };
}

const SESSION_TOKEN = Buffer.alloc(32, 7).toString("base64url");

function presentedHash(token: string): string {
  return createHash("sha256")
    .update(`openarc:session:v1:${token}`, "utf8")
    .digest("hex");
}

describe("AuthService tenant read seam", () => {
  it("resolves a live session without requiring a binding cookie or fresh proof", async () => {
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000);
    const service = new RealAuthService({
      config: AUTH_CONFIG,
      store: authStore({
        getSession: async () => ({
          accountId: ACCOUNT,
          userHandle: "handle",
          method: "recovery",
          createdAt: new Date(Date.now() - 60 * 60 * 1000),
          expiresAt,
        }),
      }),
      proofs: fakeProofs(),
      runtime: fakeRuntime(),
    });
    const begun = await service.beginTenantRead({
      peerIp: "127.0.0.1",
      cookies: cookies(SESSION_TOKEN),
    });
    expect(begun.accountId).toBe(ACCOUNT);
    expect(begun.sessionHash).toMatch(/^[0-9a-f]{64}$/u);
    await expect(
      service.finishTenantRead(
        { peerIp: "127.0.0.1", cookies: cookies(SESSION_TOKEN) },
        begun,
      ),
    ).resolves.toBeUndefined();
  });

  it("fails closed when the rate limiter store is unavailable", async () => {
    const service = new RealAuthService({
      config: AUTH_CONFIG,
      store: authStore({
        consumeRateLimit: async () => {
          throw Object.assign(new Error("db"), { code: "AUTH_STORE_DATABASE" });
        },
        getSession: async () => null,
      }),
      proofs: fakeProofs(),
      runtime: fakeRuntime(),
    });
    await expect(
      service.beginTenantRead({
        peerIp: "127.0.0.1",
        cookies: cookies(SESSION_TOKEN),
      }),
    ).rejects.toMatchObject({ status: 503 });
  });

  it("rejects a revoked, expired or wrong-account session at finish", async () => {
    const revoked = new RealAuthService({
      config: AUTH_CONFIG,
      store: authStore({ getSession: async () => null }),
      proofs: fakeProofs(),
      runtime: fakeRuntime(),
    });
    await expect(
      revoked.beginTenantRead({
        peerIp: "127.0.0.1",
        cookies: cookies(SESSION_TOKEN),
      }),
    ).rejects.toMatchObject({ status: 401 });

    const service = new RealAuthService({
      config: AUTH_CONFIG,
      store: authStore({
        getSession: async () => ({
          accountId: ACCOUNT2,
          userHandle: "handle",
          method: "passkey",
          createdAt: new Date(),
          expiresAt: new Date(Date.now() + 60_000),
        }),
      }),
      proofs: fakeProofs(),
      runtime: fakeRuntime(),
    });
    await expect(
      service.finishTenantRead(
        { peerIp: "127.0.0.1", cookies: cookies(SESSION_TOKEN) },
        { sessionHash: presentedHash(SESSION_TOKEN), accountId: ACCOUNT },
      ),
    ).rejects.toMatchObject({ status: 401 });
  });
});
