import { connect } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import {
  API_CLIENT_HEADER,
  COMMERCE_CAPABILITIES_PATH,
  COMMERCE_CAPABILITY_ENVIRONMENT,
  COMMERCE_CAPABILITY_FAMILY_ORDER,
  COMMERCE_CAPABILITY_NETWORK,
  COMMERCE_CAPABILITY_VERSION,
  COMMERCE_ROUTES,
  CommerceCapabilitiesSuccessEnvelopeSchema,
  type CommerceCapabilityFamily,
  type CommerceCapabilityState,
} from "@openarc/shared";

import { createApp, type CompletionLog } from "../src/app.js";
import type { AuthService } from "../src/auth/service.js";
import { AUTH_ROUTES } from "../src/auth/routes.js";
import { loadConfig } from "../src/config.js";
import type { MachineManagementService } from "../src/machine/management-service.js";
import { MACHINE_MANAGEMENT_ROUTES } from "../src/machine/management-routes.js";
import type { MachineSessionService } from "../src/machine/session-service.js";
import { MACHINE_SESSION_ROUTES } from "../src/machine/session-routes.js";
import type { TenantReadService } from "../src/tenant/service.js";
import { TENANT_ROUTES } from "../src/tenant/routes.js";
import type { TenantWriteService } from "../src/tenant/write-service.js";
import { TENANT_WRITE_ROUTES } from "../src/tenant/write-routes.js";

/**
 * Focused unit/inject coverage for the public `GET /v2/public/capabilities`
 * surface. Config and readiness callbacks are SYNTHETIC and honestly labelled:
 * no PostgreSQL, AuthService or network is required. This suite proves the
 * manifest/registry contract, the five-flag readiness mapping, the single
 * in-flight probe batch with a fail-closed deadline, and the strict
 * credentialless transport. It also re-asserts the EXISTING `/readyz`
 * fail-closed semantics for auth/tenant/machine failures.
 */

const ORIGIN = "http://localhost:5183";
const BUILD_SHA = "0123456789abcdef0123456789abcdef01234567";
const SECRET_CANARY = "SECRET_CANARY_DO_NOT_ECHO";

const apps: ReturnType<typeof createApp>[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map(async (app) => app.close()));
});

interface HarnessOptions {
  readonly authEnabled?: boolean;
  readonly tenantReads?: boolean;
  readonly tenantWrites?: boolean;
  readonly machineManagement?: boolean;
  readonly machineSessions?: boolean;
  readonly authReady?: () => Promise<boolean>;
  readonly tenantReady?: () => Promise<boolean>;
  readonly machineReady?: () => Promise<boolean>;
  readonly omitAuthReady?: boolean;
  readonly omitTenantReady?: boolean;
  readonly omitMachineReady?: boolean;
}

function harness(options: HarnessOptions = {}) {
  const authEnabled = options.authEnabled ?? false;
  const tenantReads = options.tenantReads ?? false;
  const tenantWrites = options.tenantWrites ?? false;
  const machineManagement = options.machineManagement ?? false;
  const machineSessions = options.machineSessions ?? false;
  const logs: CompletionLog[] = [];
  const config = loadConfig({
    NODE_ENV: "test",
    APP_ORIGIN: ORIGIN,
    COMMIT_SHA: BUILD_SHA,
    API_BOUNDARY_ENABLED: "true",
    ...(authEnabled
      ? {
          AUTH_ENABLED: "true",
          AUTH_DATABASE_URL: "postgres://openarc_auth_app:x@127.0.0.1:5432/openarc_auth_test",
          AUTH_SECRET: "synthetic_auth_secret_for_capability_tests_0123456789",
          AUTH_RP_ID: "localhost",
        }
      : {}),
    ...(tenantReads
      ? {
          TENANT_READS_ENABLED: "true",
          TENANT_DATABASE_URL: "postgres://openarc_tenant_app:y@127.0.0.1:5432/openarc_auth_test",
        }
      : {}),
    ...(tenantWrites ? { TENANT_WRITES_ENABLED: "true" } : {}),
    ...(machineManagement ? { MACHINE_CREDENTIAL_MANAGEMENT_ENABLED: "true" } : {}),
    ...(machineSessions ? { MACHINE_SESSION_EXCHANGE_ENABLED: "true" } : {}),
    ...(machineManagement || machineSessions
      ? {
          MACHINE_CREDENTIAL_PEPPER_VERSION: "1",
          MACHINE_CREDENTIAL_PEPPER: Buffer.alloc(32, 7).toString("base64url"),
          MACHINE_RATE_SECRET: Buffer.alloc(32, 9).toString("base64url"),
        }
      : {}),
  });
  const app = createApp({
    config,
    logger: false,
    logSink: (entry) => logs.push(entry),
    // Honest synthetic stubs: createApp only checks their presence when the
    // matching flag is on; no service method is invoked by this surface.
    ...(authEnabled ? { authService: {} as AuthService } : {}),
    ...(tenantReads ? { tenantReadService: {} as TenantReadService } : {}),
    ...(tenantWrites ? { tenantWriteService: {} as TenantWriteService } : {}),
    ...(machineManagement
      ? { machineManagementService: {} as MachineManagementService }
      : {}),
    ...(machineSessions
      ? { machineSessionService: {} as MachineSessionService }
      : {}),
    ...(options.authReady !== undefined && !options.omitAuthReady
      ? { authReady: options.authReady }
      : {}),
    ...(options.tenantReady !== undefined && !options.omitTenantReady
      ? { tenantReady: options.tenantReady }
      : {}),
    ...(options.machineReady !== undefined && !options.omitMachineReady
      ? { machineReady: options.machineReady }
      : {}),
  });
  apps.push(app);
  return { app, logs };
}

function states(
  body: { data: { capabilities: ReadonlyArray<{ family: string; state: string }> } },
): Record<string, string> {
  const output: Record<string, string> = {};
  for (const entry of body.data.capabilities) output[entry.family] = entry.state;
  return output;
}

describe("public capability manifest", () => {
  it("serves the exact frozen manifest and route registry with all flags off", async () => {
    const { app } = harness();
    const response = await app.inject({
      method: "GET",
      url: COMMERCE_CAPABILITIES_PATH,
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.headers["pragma"]).toBe("no-cache");
    expect(response.headers["x-content-type-options"]).toBe("nosniff");
    expect(response.headers["referrer-policy"]).toBe("no-referrer");
    expect(response.headers["set-cookie"]).toBeUndefined();
    expect(response.headers["access-control-allow-origin"]).toBeUndefined();

    const parsed = CommerceCapabilitiesSuccessEnvelopeSchema.parse(response.json());
    expect(parsed.data.capabilityVersion).toBe(COMMERCE_CAPABILITY_VERSION);
    expect(parsed.data.environment).toBe(COMMERCE_CAPABILITY_ENVIRONMENT);
    expect(parsed.data.network).toBe(COMMERCE_CAPABILITY_NETWORK);
    expect(parsed.data.capabilities).toHaveLength(5);
    expect(parsed.data.routes).toHaveLength(41);
    expect(parsed.data.routes).toEqual(COMMERCE_ROUTES);
    expect(states(response.json())).toEqual(
      Object.fromEntries(
        COMMERCE_CAPABILITY_FAMILY_ORDER.map((family) => [family, "built_disabled"]),
      ),
    );
    expect(parsed.meta.buildSha).toBe(BUILD_SHA);
    expect(response.body).not.toContain(SECRET_CANARY);
  });

  it("compares the published registry both directions to the actual route constants", () => {
    const actual: ReadonlyArray<{ method: string; path: string }> = [
      { path: AUTH_ROUTES.bootstrap, method: "POST" },
      { path: AUTH_ROUTES.session, method: "GET" },
      { path: AUTH_ROUTES.registerOptions, method: "POST" },
      { path: AUTH_ROUTES.registerVerify, method: "POST" },
      { path: AUTH_ROUTES.loginOptions, method: "POST" },
      { path: AUTH_ROUTES.loginVerify, method: "POST" },
      { path: AUTH_ROUTES.addOptions, method: "POST" },
      { path: AUTH_ROUTES.addVerify, method: "POST" },
      { path: AUTH_ROUTES.walletLoginOptions, method: "POST" },
      { path: AUTH_ROUTES.walletLoginVerify, method: "POST" },
      { path: AUTH_ROUTES.walletLinkOptions, method: "POST" },
      { path: AUTH_ROUTES.walletLinkVerify, method: "POST" },
      { path: AUTH_ROUTES.recoveryCodes, method: "POST" },
      { path: AUTH_ROUTES.recoveryRedeem, method: "POST" },
      { path: AUTH_ROUTES.logout, method: "POST" },
      { path: TENANT_ROUTES.organizations, method: "GET" },
      { path: TENANT_ROUTES.organization, method: "GET" },
      { path: TENANT_ROUTES.agents, method: "GET" },
      { path: TENANT_ROUTES.providers, method: "GET" },
      { path: TENANT_WRITE_ROUTES.organizations, method: "POST" },
      { path: TENANT_WRITE_ROUTES.agents, method: "POST" },
      { path: TENANT_WRITE_ROUTES.agent, method: "PATCH" },
      { path: TENANT_WRITE_ROUTES.providers, method: "POST" },
      { path: TENANT_WRITE_ROUTES.provider, method: "PATCH" },
      { path: TENANT_WRITE_ROUTES.membership, method: "PUT" },
      { path: TENANT_WRITE_ROUTES.mutation, method: "GET" },
      { path: TENANT_WRITE_ROUTES.bootstrapMutation, method: "GET" },
      { path: MACHINE_MANAGEMENT_ROUTES.agentCredentials, method: "GET" },
      { path: MACHINE_MANAGEMENT_ROUTES.agentCredentials, method: "POST" },
      { path: MACHINE_MANAGEMENT_ROUTES.providerCredentials, method: "GET" },
      { path: MACHINE_MANAGEMENT_ROUTES.providerCredentials, method: "POST" },
      { path: MACHINE_MANAGEMENT_ROUTES.agentCredentialRevoke, method: "POST" },
      { path: MACHINE_MANAGEMENT_ROUTES.providerCredentialRevoke, method: "POST" },
      { path: MACHINE_MANAGEMENT_ROUTES.agentMutation, method: "GET" },
      { path: MACHINE_MANAGEMENT_ROUTES.providerMutation, method: "GET" },
      { path: MACHINE_SESSION_ROUTES.agentExchange, method: "POST" },
      { path: MACHINE_SESSION_ROUTES.providerExchange, method: "POST" },
      { path: MACHINE_SESSION_ROUTES.agentSelf, method: "GET" },
      { path: MACHINE_SESSION_ROUTES.providerSelf, method: "GET" },
      { path: MACHINE_SESSION_ROUTES.agentRevoke, method: "POST" },
      { path: MACHINE_SESSION_ROUTES.providerRevoke, method: "POST" },
    ];
    // The registry is derived from the accepted shared module; every published
    // route id/path/method must appear in the actual route constants, and no
    // actual business route may be missing from the published registry. The
    // auth constants are matched by path with the declared method.
    const published = COMMERCE_ROUTES.map((route) => ({
      path: route.path,
      method: route.method,
    })).sort((a, b) => `${a.path}|${a.method}`.localeCompare(`${b.path}|${b.method}`));
    const expected = [...actual].sort((a, b) =>
      `${a.path}|${a.method}`.localeCompare(`${b.path}|${b.method}`),
    );
    expect(published).toEqual(expected);
    expect(COMMERCE_ROUTES).toHaveLength(41);
    expect(new Set(COMMERCE_ROUTES.map((route) => route.family))).toEqual(
      new Set(COMMERCE_CAPABILITY_FAMILY_ORDER),
    );
  });
});

describe("readiness mapping", () => {
  it("maps each flag chain, missing callback, false, rejection and deadline to the right state", async () => {
    const cases: ReadonlyArray<{
      readonly options: HarnessOptions;
      readonly expected: Record<CommerceCapabilityFamily, CommerceCapabilityState>;
    }> = [
      {
        options: { authEnabled: true, authReady: async () => true },
        expected: {
          human_accounts: "enabled",
          tenant_reads: "built_disabled",
          tenant_writes: "built_disabled",
          machine_credentials: "built_disabled",
          machine_sessions: "built_disabled",
        },
      },
      {
        options: { authEnabled: true, authReady: async () => false },
        expected: {
          human_accounts: "unavailable",
          tenant_reads: "built_disabled",
          tenant_writes: "built_disabled",
          machine_credentials: "built_disabled",
          machine_sessions: "built_disabled",
        },
      },
      {
        options: { authEnabled: true, omitAuthReady: true },
        expected: {
          human_accounts: "unavailable",
          tenant_reads: "built_disabled",
          tenant_writes: "built_disabled",
          machine_credentials: "built_disabled",
          machine_sessions: "built_disabled",
        },
      },
      {
        options: { authEnabled: true, authReady: async () => { throw new Error("boom"); } },
        expected: {
          human_accounts: "unavailable",
          tenant_reads: "built_disabled",
          tenant_writes: "built_disabled",
          machine_credentials: "built_disabled",
          machine_sessions: "built_disabled",
        },
      },
      {
        options: {
          authEnabled: true,
          tenantReads: true,
          authReady: async () => true,
          tenantReady: async () => true,
        },
        expected: {
          human_accounts: "enabled",
          tenant_reads: "enabled",
          tenant_writes: "built_disabled",
          machine_credentials: "built_disabled",
          machine_sessions: "built_disabled",
        },
      },
      {
        options: {
          authEnabled: true,
          tenantReads: true,
          authReady: async () => true,
          tenantReady: async () => false,
        },
        expected: {
          human_accounts: "enabled",
          tenant_reads: "unavailable",
          tenant_writes: "built_disabled",
          machine_credentials: "built_disabled",
          machine_sessions: "built_disabled",
        },
      },
      {
        options: {
          authEnabled: true,
          tenantReads: true,
          tenantWrites: true,
          machineSessions: true,
          authReady: async () => true,
          tenantReady: async () => true,
          machineReady: async () => true,
        },
        expected: {
          human_accounts: "enabled",
          tenant_reads: "enabled",
          tenant_writes: "enabled",
          machine_credentials: "built_disabled",
          machine_sessions: "enabled",
        },
      },
    ];

    for (const entry of cases) {
      const { app } = harness(entry.options);
      const response = await app.inject({
        method: "GET",
        url: COMMERCE_CAPABILITIES_PATH,
      });
      expect(response.statusCode).toBe(200);
      expect(states(response.json()), JSON.stringify(entry.options)).toEqual(
        entry.expected,
      );
    }
  });

  it("keeps machine sessions independent of tenant writes and credential management", async () => {
    const { app } = harness({
      authEnabled: true,
      tenantReads: true,
      machineSessions: true,
      authReady: async () => true,
      tenantReady: async () => true,
      machineReady: async () => true,
    });
    const response = await app.inject({ method: "GET", url: COMMERCE_CAPABILITIES_PATH });
    const mapped = states(response.json());
    expect(mapped.machine_credentials).toBe("built_disabled");
    expect(mapped.machine_sessions).toBe("enabled");
    expect(mapped.tenant_writes).toBe("built_disabled");
  });

  it("invokes disabled-flag callbacks zero times and each required callback at most once", async () => {
    let authCalls = 0;
    let tenantCalls = 0;
    let machineCalls = 0;
    const { app } = harness({
      authEnabled: true,
      tenantReads: true,
      machineSessions: true,
      authReady: async () => { authCalls += 1; return true; },
      tenantReady: async () => { tenantCalls += 1; return true; },
      machineReady: async () => { machineCalls += 1; return true; },
    });
    await app.inject({ method: "GET", url: COMMERCE_CAPABILITIES_PATH });
    expect(authCalls).toBe(1);
    expect(tenantCalls).toBe(1);
    expect(machineCalls).toBe(1);
  });

  it("starts no readiness batch when every flag is off", async () => {
    let calls = 0;
    const { app } = harness({
      authReady: async () => { calls += 1; return true; },
      tenantReady: async () => { calls += 1; return true; },
      machineReady: async () => { calls += 1; return true; },
    });
    const response = await app.inject({ method: "GET", url: COMMERCE_CAPABILITIES_PATH });
    expect(response.statusCode).toBe(200);
    expect(calls).toBe(0);
  });
});

describe("readiness batch coordination", () => {
  it("shares one in-flight probe batch across concurrent calls and re-checks after it settles", async () => {
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const { app } = harness({
      authEnabled: true,
      authReady: async () => {
        calls += 1;
        await gate;
        return true;
      },
    });

    const first = app.inject({ method: "GET", url: COMMERCE_CAPABILITIES_PATH });
    const second = app.inject({ method: "GET", url: COMMERCE_CAPABILITIES_PATH });
    await new Promise((resolve) => setImmediate(resolve));
    expect(calls).toBe(1);
    release();
    const [a, b] = await Promise.all([first, second]);
    expect(a.statusCode).toBe(200);
    expect(b.statusCode).toBe(200);

    const third = await app.inject({ method: "GET", url: COMMERCE_CAPABILITIES_PATH });
    expect(third.statusCode).toBe(200);
    expect(calls).toBe(2);
  });

  it("fails closed after the deadline without launching a second overlapping batch, and a late result cannot promote", async () => {
    let calls = 0;
    let lateResolve!: (value: boolean) => void;
    const { app } = harness({
      authEnabled: true,
      authReady: () => {
        calls += 1;
        return new Promise<boolean>((resolve) => { lateResolve = resolve; });
      },
    });

    const started = Date.now();
    const response = await app.inject({
      method: "GET",
      url: COMMERCE_CAPABILITIES_PATH,
    });
    const elapsed = Date.now() - started;
    expect(response.statusCode).toBe(200);
    expect(states(response.json()).human_accounts).toBe("unavailable");
    expect(elapsed).toBeGreaterThanOrEqual(1900);
    expect(calls).toBe(1);

    // The underlying callback is still pending; the late completion must not
    // mutate the already-returned response, and a second request while it is
    // still pending must NOT start a second overlapping batch.
    const concurrent = await app.inject({
      method: "GET",
      url: COMMERCE_CAPABILITIES_PATH,
    });
    expect(concurrent.statusCode).toBe(200);
    expect(calls).toBe(1);
    lateResolve(true);
    await new Promise((resolve) => setImmediate(resolve));
  }, 15_000);

  it("preserves independently settled auth/tenant readiness across the deadline while a hung machine dependency fails closed", async () => {
    let machineCalls = 0;
    let authCalls = 0;
    let tenantCalls = 0;
    let releaseMachine!: (value: boolean) => void;
    const { app } = harness({
      authEnabled: true,
      tenantReads: true,
      machineSessions: true,
      authReady: async () => { authCalls += 1; return true; },
      tenantReady: async () => { tenantCalls += 1; return true; },
      machineReady: () => {
        machineCalls += 1;
        if (machineCalls > 1) return Promise.resolve(true);
        return new Promise<boolean>((resolve) => { releaseMachine = resolve; });
      },
    });

    // Two concurrent requests with auth/tenant settled true and machine hung.
    const started = Date.now();
    const first = app.inject({ method: "GET", url: COMMERCE_CAPABILITIES_PATH });
    const second = app.inject({ method: "GET", url: COMMERCE_CAPABILITIES_PATH });
    // Give the batch a moment to settle auth/tenant before the deadline snapshots.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(authCalls).toBe(1);
    expect(tenantCalls).toBe(1);
    expect(machineCalls).toBe(1);

    const [a, b] = await Promise.all([first, second]);
    expect(Date.now() - started).toBeGreaterThanOrEqual(1900);
    const firstBody = a.json();
    const firstStates = states(firstBody);
    // Independently ready human/tenant families are preserved; machine fails
    // closed because it is still unresolved at the deadline.
    expect(firstStates.human_accounts).toBe("enabled");
    expect(firstStates.tenant_reads).toBe("enabled");
    expect(firstStates.tenant_writes).toBe("built_disabled");
    expect(firstStates.machine_credentials).toBe("built_disabled");
    expect(firstStates.machine_sessions).toBe("unavailable");
    // Concurrent requests joined the SAME single underlying batch.
    expect(machineCalls).toBe(1);
    expect(states(b.json())).toEqual(firstStates);

    // Late settlement must not mutate the already-returned response.
    releaseMachine(true);
    await new Promise((resolve) => setImmediate(resolve));
    expect(states(firstBody)).toEqual(firstStates);
    // The batch reference is cleared only on actual settlement, so a new
    // request after settlement re-checks with a fresh batch.
    const third = await app.inject({ method: "GET", url: COMMERCE_CAPABILITIES_PATH });
    expect(third.statusCode).toBe(200);
    expect(states(third.json()).machine_sessions).toBe("enabled");
    expect(machineCalls).toBe(2);
  }, 15_000);
});

describe("public capability transport", () => {
  it("accepts credentialless exact GET originless and with the browser marker", async () => {
    const { app } = harness();
    for (const headers of [
      {},
      { "x-openarc-client": API_CLIENT_HEADER },
      { origin: ORIGIN },
      { origin: ORIGIN, "x-openarc-client": API_CLIENT_HEADER },
    ]) {
      const response = await app.inject({
        method: "GET",
        url: COMMERCE_CAPABILITIES_PATH,
        headers: headers as Record<string, string>,
      });
      expect(response.statusCode, JSON.stringify(headers)).toBe(200);
    }
  });

  it("rejects cookies, Authorization, CSRF, idempotency and unknown client metadata", async () => {
    const { app } = harness();
    const forbidden: Record<string, string>[] = [
      { cookie: "openarc_session=abc" },
      { authorization: "Bearer x" },
      { "x-openarc-csrf": "t" },
      { "idempotency-key": "k" },
      { "x-openarc-client": "other" },
      { "x-unknown-client": "x" },
    ];
    for (const headers of forbidden) {
      const response = await app.inject({
        method: "GET",
        url: COMMERCE_CAPABILITIES_PATH,
        headers: headers as Record<string, string>,
      });
      expect(response.statusCode, JSON.stringify(headers)).toBe(400);
    }
  });

  it("accepts default credentialless fetch negotiation headers and still rejects unknown client metadata", async () => {
    const { app } = harness();
    // Undici's default credentialless GET sends this exact negotiation set:
    // Accept, Accept-Language, Accept-Encoding, User-Agent. Accept-Language is
    // standard content negotiation, not arbitrary client metadata, so the
    // public GET must remain usable with default fetch.
    const fetchDefaults = {
      accept: "*/*",
      "accept-language": "*",
      "accept-encoding": "gzip, deflate",
      "user-agent": "undici",
    };
    const accepted = await app.inject({
      method: "GET",
      url: COMMERCE_CAPABILITIES_PATH,
      headers: fetchDefaults,
    });
    expect(accepted.statusCode).toBe(200);
    // Accept-Language is permitted but never echoed, persisted or trusted.
    expect(accepted.headers["set-cookie"]).toBeUndefined();
    expect(accepted.headers["access-control-allow-origin"]).toBeUndefined();
    expect(accepted.body).not.toContain("accept-language");
    expect(accepted.body).not.toContain("undici");

    const unknown = await app.inject({
      method: "GET",
      url: COMMERCE_CAPABILITIES_PATH,
      headers: { ...fetchDefaults, "x-unknown-client": "x" },
    });
    expect(unknown.statusCode).toBe(400);
  });

  it("rejects a cross origin with the fixed v2 INVALID_ORIGIN envelope", async () => {
    const { app } = harness();
    const response = await app.inject({
      method: "GET",
      url: COMMERCE_CAPABILITIES_PATH,
      headers: { origin: "https://evil.example" },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe("INVALID_ORIGIN");
    expect(response.headers["access-control-allow-origin"]).toBeUndefined();
    expect(response.headers["set-cookie"]).toBeUndefined();
  });

  it("rejects wrong methods with a fixed 405 v2 INVALID_REQUEST", async () => {
    const { app } = harness();
    for (const method of ["POST", "PUT", "DELETE", "PATCH"] as const) {
      const response = await app.inject({
        method,
        url: COMMERCE_CAPABILITIES_PATH,
        ...(method === "POST" || method === "PUT" || method === "PATCH"
          ? { payload: {} }
          : {}),
      });
      expect(response.statusCode, method).toBe(405);
      expect(response.json().meta.schemaVersion, method).toBe("openarc.api.v2");
      expect(response.json().error.code, method).toBe("INVALID_REQUEST");
    }
  });

  it("rejects any query including a bare ? and oversized URLs, with no raw echo", async () => {
    const { app } = harness();
    const queried = await app.inject({
      method: "GET",
      url: `${COMMERCE_CAPABILITIES_PATH}?x=1`,
    });
    expect(queried.statusCode).toBe(400);
    expect(queried.body).not.toContain("x=1");
    // A bare `?` may be normalized away by the inject transport, so exercise
    // the exact raw request target over a real socket instead.
    const port = await listeningPort(app);
    const bare = await rawHttp(port, "GET", `${COMMERCE_CAPABILITIES_PATH}?`, []);
    expect(bare.status).toBe(400);
    expect(bare.text).toContain('"code":"INVALID_REQUEST"');
    // The exact route still matches a very long query; the URL byte bound
    // rejects it as INVALID_REQUEST with no raw echo.
    const oversized = await app.inject({
      method: "GET",
      url: `${COMMERCE_CAPABILITIES_PATH}?${"x".repeat(2100)}`,
    });
    expect(oversized.statusCode).toBe(400);
    expect(oversized.json().meta.schemaVersion).toBe("openarc.api.v2");
    expect(oversized.json().error.code).toBe("INVALID_REQUEST");
    expect(oversized.body).not.toContain("x".repeat(2100));
  });

  it("locks the route family: no wildcard, unknown and lookalike paths keep legacy behavior", async () => {
    const { app } = harness();
    for (const url of [
      `${COMMERCE_CAPABILITIES_PATH}/extra`,
      "/v2/public/capabilitiesXYZ",
      "/v2/public/other",
    ]) {
      const response = await app.inject({ method: "GET", url });
      expect(response.statusCode, url).toBe(404);
      expect(response.json().meta.schemaVersion, url).toBe("openarc.api.v1");
    }
  });

  it("rejects raw duplicate critical headers before the parser even collapses names", async () => {
    const { app } = harness();
    const port = await listeningPort(app);
    const duplicates: ReadonlyArray<readonly string[]> = [
      ["Cookie: a=1", "Cookie: b=2"],
      ["Authorization: Bearer x", "Authorization: Bearer y"],
      ["Origin: " + ORIGIN, "Origin: " + ORIGIN],
      ["Idempotency-Key: a", "Idempotency-Key: b"],
      ["X-OpenArc-Csrf: a", "X-OpenArc-Csrf: b"],
      ["X-OpenArc-Client: browser-v1", "X-OpenArc-Client: browser-v1"],
    ];
    for (const headers of duplicates) {
      const response = await rawHttp(port, "GET", COMMERCE_CAPABILITIES_PATH, headers);
      expect(response.status, headers.join("|")).toBe(400);
      expect(response.text).toContain('"code":"INVALID_REQUEST"');
      expect(response.text.toLowerCase()).not.toContain("set-cookie");
    }
  });

  it("keeps the legacy capabilities handler and its schema unchanged", async () => {
    const { app } = harness();
    const legacy = await app.inject({
      method: "GET",
      url: "/v1/private/capabilities",
      headers: { origin: ORIGIN, "x-openarc-client": API_CLIENT_HEADER },
    });
    expect(legacy.statusCode).toBe(200);
    expect(legacy.json().data.capabilityVersion).toBe("openarc.capabilities.m04.v1");
    expect(legacy.json().meta.schemaVersion).toBe("openarc.api.v1");
    // The public route uses only the new v2 capability contract and never
    // claims a pending later domain.
    const publicResponse = await app.inject({
      method: "GET",
      url: COMMERCE_CAPABILITIES_PATH,
    });
    expect(publicResponse.json().data.capabilityVersion).toBe(
      "openarc.capabilities.commerce.v1",
    );
    const families = publicResponse.json().data.capabilities.map(
      (entry: { family: string }) => entry.family,
    );
    expect(families).not.toContain("marketplace");
    expect(families).not.toContain("payments");
    expect(families).not.toContain("settlement");
  });
});

describe("public capability manifest stays independent of readyz fail-closed semantics", () => {
  it("returns 200 with unavailable families while /readyz still fails closed", async () => {
    const { app } = harness({
      authEnabled: true,
      tenantReads: true,
      machineSessions: true,
      authReady: async () => false,
      tenantReady: async () => false,
      machineReady: async () => false,
    });
    const capability = await app.inject({ method: "GET", url: COMMERCE_CAPABILITIES_PATH });
    expect(capability.statusCode).toBe(200);
    expect(states(capability.json()).human_accounts).toBe("unavailable");

    const ready = await app.inject({ method: "GET", url: "/readyz" });
    expect(ready.statusCode).toBe(503);
    expect(ready.json().status).toBe("not_ready");
  });

  it("keeps /readyz fail-closed on auth failure and leaves the all-off defaults intact", async () => {
    const { app } = harness({
      authEnabled: true,
      authReady: async () => false,
    });
    const ready = await app.inject({ method: "GET", url: "/readyz" });
    expect(ready.statusCode).toBe(503);
    expect(ready.json().checks.authDatabase).toBe("down");

    const capability = await app.inject({ method: "GET", url: COMMERCE_CAPABILITIES_PATH });
    expect(capability.statusCode).toBe(200);
    expect(capability.json().data.capabilities).toHaveLength(5);
  });
});

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
    ...(payload.byteLength > 0 ? [`Content-Length: ${payload.byteLength}`] : []),
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
