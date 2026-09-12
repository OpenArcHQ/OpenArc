import { createHash, randomBytes } from "node:crypto";

import { AuthStore, createDatabasePool, migrate, TenantStore, asTenantPool } from "@openarc/db";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createApp } from "../src/app.js";
import { AuthService, type AuthServiceConfig } from "../src/auth/service.js";
import type { AuthProofPort, AuthRuntime } from "../src/auth/ports.js";
import type { AuthOriginConfig } from "../src/auth/proofs.js";
import { loadConfig } from "../src/config.js";
import { TenantReadService } from "../src/tenant/service.js";
import type { TenantReadStorePort } from "../src/tenant/ports.js";
import {
  adminPool,
  appUrl,
  ensureRoles,
  migratorUrl,
  resetSchema,
  tenantUrl,
} from "../../../packages/db/test/postgres-fixture.js";

/**
 * Real-PostgreSQL protected tenant read flows.
 *
 * The runtime repositories are the real `AuthStore` and `TenantStore` over the
 * disposable fixture roles. The WebAuthn/SIWE proof adapter is HONESTLY MOCKED
 * here (labelled): this suite proves role resolution, membership, pagination,
 * session binding and post-read revalidation against real RLS and locks, not
 * real crypto.
 */

type Pool = ReturnType<typeof adminPool>;

const ORIGIN = "http://localhost:5183";
const RP_ID = "localhost";
const SECRET = "synthetic_auth_secret_for_tenant_pg_tests_0123456789";
const BUILD_SHA = "0123456789abcdef0123456789abcdef01234567";
const CLIENT = { origin: ORIGIN, "x-openarc-client": "browser-v1" };

const A = "openarc:account:11111111-1111-4111-8111-111111111111";
const B = "openarc:account:22222222-2222-4222-8222-222222222222";
const C = "openarc:account:33333333-3333-4333-8333-333333333333";
const D = "openarc:account:44444444-4444-4444-8444-444444444444";
const E = "openarc:account:55555555-5555-4555-8555-555555555555";
const SUSPENDED = "openarc:account:66666666-6666-4666-8666-666666666666";
const ORG1 = "openarc:org:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ORG2 = "openarc:org:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

function b64(bytes: number): string {
  return randomBytes(bytes).toString("base64url");
}

function tokenHash(token: string): string {
  return createHash("sha256")
    .update(`openarc:session:v1:${token}`, "utf8")
    .digest("hex");
}

function fakeProofs(): AuthProofPort {
  return {
    validateAuthOriginConfig: (input: unknown): AuthOriginConfig => {
      return input as AuthOriginConfig;
    },
  } as unknown as AuthProofPort;
}

function fakeRuntime(): AuthRuntime {
  return { randomBytes: (size) => randomBytes(size), now: () => new Date() };
}

let admin: Pool;
let migrator: Pool;
let app: Pool;
let tenant: Pool;

beforeAll(async () => {
  admin = adminPool();
  await ensureRoles(admin);
  migrator = createDatabasePool(migratorUrl());
});

afterAll(async () => {
  try {
    await resetSchema(admin);
  } finally {
    await migrator.end();
    await admin.end();
  }
});

async function seedAccount(accountId: string): Promise<void> {
  await admin.query(
    `INSERT INTO openarc_auth.accounts (account_id, user_handle, status)
     VALUES ($1, $2, 'active')`,
    [accountId, b64(32)],
  );
}

async function seedSession(
  token: string,
  accountId: string,
  options: { method?: "passkey" | "wallet" | "recovery"; expiresInSeconds?: number } = {},
): Promise<void> {
  const expires = options.expiresInSeconds ?? 3600;
  await admin.query(
    `INSERT INTO openarc_auth.sessions (token_hash, account_id, method, created_at, expires_at)
     VALUES ($1, $2, $3, clock_timestamp(), clock_timestamp() + ($4 || ' seconds')::interval)`,
    [tokenHash(token), accountId, options.method ?? "passkey", String(expires)],
  );
}

async function seedOrganization(organizationId: string, createdBy: string, name: string) {
  await admin.query(
    `INSERT INTO openarc_tenant.organizations (organization_id, display_name, created_by)
     VALUES ($1, $2, $3)`,
    [organizationId, name, createdBy],
  );
}

async function seedMembership(
  organizationId: string,
  accountId: string,
  role: string,
  status = "active",
) {
  await admin.query(
    `INSERT INTO openarc_tenant.memberships (organization_id, account_id, role, status)
     VALUES ($1, $2, $3, $4)`,
    [organizationId, accountId, role, status],
  );
}

async function seedAgent(organizationId: string, suffix: string, name: string) {
  const agentId = `openarc:agent:${suffix}`;
  await admin.query(
    `INSERT INTO openarc_tenant.agents (organization_id, agent_id, display_name)
     VALUES ($1, $2, $3)`,
    [organizationId, agentId, name],
  );
  return agentId;
}

async function seedProvider(organizationId: string, suffix: string, name: string) {
  const providerId = `openarc:provider:${suffix}`;
  await admin.query(
    `INSERT INTO openarc_tenant.providers (organization_id, provider_id, display_name)
     VALUES ($1, $2, $3)`,
    [organizationId, providerId, name],
  );
  return providerId;
}

const tokens = new Map<string, string>();

beforeEach(async () => {
  await resetSchema(admin);
  await migrate(migrator);
  app = createDatabasePool(appUrl());
  tenant = createDatabasePool(tenantUrl());

  for (const accountId of [A, B, C, D, E, SUSPENDED]) {
    await seedAccount(accountId);
  }
  await seedOrganization(ORG1, A, "Primary");
  await seedOrganization(ORG2, E, "Foreign");
  await seedMembership(ORG1, A, "owner");
  await seedMembership(ORG1, B, "operator");
  await seedMembership(ORG1, C, "viewer");
  await seedMembership(ORG1, D, "provider_admin");
  await seedMembership(ORG1, SUSPENDED, "viewer", "suspended");
  await seedMembership(ORG2, E, "owner");

  await seedAgent(ORG1, "11111111-1111-4111-8111-111111111111", "Agent One");
  await seedAgent(ORG1, "11111111-1111-4111-8111-111111111112", "Agent Two");
  await seedProvider(ORG1, "22222222-2222-4222-8222-222222222222", "Provider One");

  tokens.clear();
  for (const [label, accountId] of [
    ["a", A],
    ["b", B],
    ["c", C],
    ["d", D],
    ["e", E],
    ["suspended", SUSPENDED],
  ] as const) {
    const token = b64(32);
    tokens.set(label, token);
    await seedSession(token, accountId);
  }
});

afterEach(async () => {
  await tenant.end();
  await app.end();
});

interface Built {
  instance: ReturnType<typeof createApp>;
  store: TenantStore;
  service: TenantReadService;
}

async function buildApp(
  decorate?: (store: TenantReadStorePort) => TenantReadStorePort,
): Promise<Built> {
  const store = new TenantStore(asTenantPool(tenant));
  await store.initialize();
  const authService = new AuthService({
    config: {
      authSecret: SECRET,
      appOrigin: ORIGIN,
      rpId: RP_ID,
      environment: "development",
      secureCookies: false,
      cookieNames: { session: "openarc_session", binding: "openarc_binding" },
    } satisfies AuthServiceConfig,
    store: new AuthStore(app),
    proofs: fakeProofs(),
    runtime: fakeRuntime(),
  });
  const service = new TenantReadService({
    auth: authService,
    store: decorate ? decorate(store) : store,
  });
  const config = loadConfig({
    NODE_ENV: "test",
    APP_ORIGIN: ORIGIN,
    COMMIT_SHA: BUILD_SHA,
    AUTH_ENABLED: "true",
    AUTH_DATABASE_URL: appUrl(),
    AUTH_SECRET: SECRET,
    AUTH_RP_ID: RP_ID,
    TENANT_READS_ENABLED: "true",
    TENANT_DATABASE_URL: tenantUrl(),
  });
  const instance = createApp({
    config,
    logger: false,
    authService,
    tenantReadService: service,
    tenantReady: async () => true,
  });
  return { instance, store, service };
}

function headers(label: string, extra: Record<string, string> = {}) {
  const token = tokens.get(label);
  return {
    ...CLIENT,
    ...(token !== undefined ? { cookie: `openarc_session=${token}` } : {}),
    ...extra,
  };
}

const url = (suffix = "") => `/v1/operator/organizations${suffix}`;

/**
 * Poll pg_stat_activity until the real repository call issued by this request
 * is blocked on a lock. Observing `list_account_organization_ids` also proves
 * that `beginTenantRead` completed: the store is only reached after begin
 * returns. The poll query intentionally excludes its own backend because the
 * `query LIKE` pattern would otherwise match itself.
 */
async function waitForBlockedTenantQuery(
  pool: Pool,
  timeoutMs = 3000,
): Promise<{ wait_event_type: string | null } | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await pool.query<{ wait_event_type: string | null }>(
      `SELECT wait_event_type
         FROM pg_stat_activity
        WHERE query LIKE '%list_account_organization_ids%'
          AND pid <> pg_backend_pid()
          AND wait_event_type = 'Lock'
        LIMIT 1`,
    );
    if (result.rows.length > 0) return result.rows[0] ?? null;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return null;
}

/** Cross the session expiry by the database clock, deterministically. */
async function waitUntilSessionExpired(
  pool: Pool,
  hash: string,
  timeoutMs = 3000,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await pool.query<{ expired: boolean }>(
      `SELECT (expires_at <= clock_timestamp()) AS expired
         FROM openarc_auth.sessions
        WHERE token_hash = $1`,
      [hash],
    );
    if (result.rows[0]?.expired === true) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return false;
}

describe("real-PG tenant reads", () => {
  it("lists only the caller's own active organizations", async () => {
    const { instance } = await buildApp();
    const response = await instance.inject({
      method: "GET",
      url: url(),
      headers: headers("a"),
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().data.items.map((item: { organizationId: string }) => item.organizationId)).toEqual([ORG1]);
  });

  it("resolves the owner context and binds the account", async () => {
    const { instance } = await buildApp();
    const response = await instance.inject({
      method: "GET",
      url: url(`/${ORG1}`),
      headers: headers("a"),
    });
    expect(response.statusCode).toBe(200);
    const data = response.json().data;
    expect(data.organization.organizationId).toBe(ORG1);
    expect(data.access.accountId).toBe(A);
    expect(data.access.role).toBe("owner");
    expect(data.network).toBe("eip155:5042002");
  });

  it("permits owner/operator/viewer agents but forbids a suspended member", async () => {
    const { instance } = await buildApp();
    for (const label of ["a", "b", "c"]) {
      const response = await instance.inject({
        method: "GET",
        url: url(`/${ORG1}/agents`),
        headers: headers(label),
      });
      expect(response.statusCode, label).toBe(200);
    }
    const suspended = await instance.inject({
      method: "GET",
      url: url(`/${ORG1}/agents`),
      headers: headers("suspended"),
    });
    expect(suspended.statusCode).toBe(403);
  });

  it("returns providers to owners only", async () => {
    const { instance } = await buildApp();
    const owner = await instance.inject({
      method: "GET",
      url: url(`/${ORG1}/providers`),
      headers: headers("a"),
    });
    expect(owner.statusCode).toBe(200);
    expect(owner.json().data.items[0].providerId).toContain("openarc:provider:");
    for (const label of ["b", "c", "d"]) {
      const forbidden = await instance.inject({
        method: "GET",
        url: url(`/${ORG1}/providers`),
        headers: headers(label),
      });
      expect(forbidden.statusCode, label).toBe(403);
    }
  });

  it("denies cross-organization, forged and suspended access without an oracle", async () => {
    const { instance } = await buildApp();
    const forged = "openarc:org:dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    // A is not a member of ORG2 (owned by E): foreign organization is denied.
    const foreignOrg = await instance.inject({
      method: "GET",
      url: url(`/${ORG2}`),
      headers: headers("a"),
    });
    expect(foreignOrg.statusCode).toBe(403);
    // A forged canonical id is the same fixed denial, not an existence oracle.
    const forgedId = await instance.inject({
      method: "GET",
      url: url(`/${forged}`),
      headers: headers("a"),
    });
    expect(forgedId.statusCode).toBe(403);
    expect(foreignOrg.body).not.toContain(ORG2);
    expect(foreignOrg.body).not.toContain(forged);
    // E has no membership in ORG1.
    const foreignAgentList = await instance.inject({
      method: "GET",
      url: url(`/${ORG1}/agents`),
      headers: headers("e"),
    });
    expect(foreignAgentList.statusCode).toBe(403);
  });

  it("paginates agents with a stable cursor and after-key", async () => {
    const { instance } = await buildApp();
    const first = await instance.inject({
      method: "GET",
      url: url(`/${ORG1}/agents?limit=1`),
      headers: headers("b"),
    });
    expect(first.statusCode).toBe(200);
    const page = first.json().data;
    expect(page.items).toHaveLength(1);
    expect(page.nextCursor).toBe(page.items[0].agentId);
    const second = await instance.inject({
      method: "GET",
      url: url(`/${ORG1}/agents?limit=1&afterAgentId=${encodeURIComponent(page.nextCursor)}`),
      headers: headers("b"),
    });
    expect(second.statusCode).toBe(200);
    expect(second.json().data.items[0].agentId).not.toBe(page.nextCursor);
    expect(second.json().data.nextCursor).toBeNull();
  });

  it("rejects missing, revoked and expired session cookies", async () => {
    const { instance } = await buildApp();
    const missing = await instance.inject({
      method: "GET",
      url: url(),
      headers: { ...CLIENT },
    });
    expect(missing.statusCode).toBe(401);

    const revokedToken = tokens.get("a") as string;
    await admin.query("DELETE FROM openarc_auth.sessions WHERE token_hash = $1", [tokenHash(revokedToken)]);
    const revoked = await instance.inject({
      method: "GET",
      url: url(),
      headers: headers("a"),
    });
    expect(revoked.statusCode).toBe(401);
    expect(revoked.headers["set-cookie"]).toBeUndefined();
  });

  it("does not leak transaction context after a denied read on one pool", async () => {
    const { instance } = await buildApp();
    const denied = await instance.inject({
      method: "GET",
      url: url(`/${ORG2}`),
      headers: headers("a"),
    });
    expect(denied.statusCode).toBe(403);
    const allowed = await instance.inject({
      method: "GET",
      url: url(`/${ORG1}/agents`),
      headers: headers("a"),
    });
    expect(allowed.statusCode).toBe(200);
  });

  it("revalidates the session after the read and never mints a cookie", async () => {
    const token = b64(32);
    await seedSession(token, A);
    const { instance } = await buildApp((store) => ({
      listOrganizations: async (sessionHash, input) => {
        const result = await store.listOrganizations(sessionHash, input);
        await admin.query("DELETE FROM openarc_auth.sessions WHERE account_id = $1", [A]);
        return result;
      },
      getOrganizationAccess: (h, o) => store.getOrganizationAccess(h, o),
      listAgents: (h, o, i) => store.listAgents(h, o, i),
      listProviders: (h, o, i) => store.listProviders(h, o, i),
    }));
    tokens.set("stale", token);
    const response = await instance.inject({
      method: "GET",
      url: url(),
      headers: headers("stale"),
    });
    expect(response.statusCode).toBe(401);
    expect(response.headers["set-cookie"]).toBeUndefined();
    expect(response.body).not.toContain(ORG1);
  });

  it("fails closed after a real tenant table lock wait beyond session expiry", async () => {
    const token = b64(32);
    // Expiry is long enough that begin authorization still observes a live
    // session, yet short enough that the DB clock crosses it during the lock
    // wait and stays within the 5000ms statement timeout.
    await seedSession(token, A, { expiresInSeconds: 3 });
    const hash = tokenHash(token);
    const { instance } = await buildApp();
    tokens.set("locking", token);

    const blocker = await admin.connect();
    try {
      await blocker.query("BEGIN");
      // A real TENANT data table lock. The repository's own membership query
      // must wait, and that can only happen AFTER beginTenantRead authorized
      // the request. This is not an auth.sessions lock and not a timer/mock.
      await blocker.query(
        "LOCK TABLE openarc_tenant.memberships IN ACCESS EXCLUSIVE MODE",
      );

      const pending = instance.inject({
        method: "GET",
        url: url(),
        headers: headers("locking"),
      });

      // Establish that begin authorization completed and the real repository
      // query is waiting on the tenant lock.
      const observed = await waitForBlockedTenantQuery(admin);
      expect(observed).not.toBeNull();
      expect(observed?.wait_event_type).toBe("Lock");

      // Cross session expiry by the database clock while the read waits.
      expect(await waitUntilSessionExpired(admin, hash)).toBe(true);

      await blocker.query("ROLLBACK");
      const response = await pending;
      expect(response.statusCode).toBe(401);
      expect(response.headers["set-cookie"]).toBeUndefined();
      expect(response.body).not.toContain(ORG1);
      expect(response.body).not.toContain('"data"');
    } finally {
      await blocker.release();
    }
  });

  it("supports a recovery session for reads according to role", async () => {
    const token = b64(32);
    await seedSession(token, A, { method: "recovery" });
    const { instance } = await buildApp();
    tokens.set("recovery", token);
    const response = await instance.inject({
      method: "GET",
      url: url(`/${ORG1}`),
      headers: headers("recovery"),
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().data.access.role).toBe("owner");
  });
});
