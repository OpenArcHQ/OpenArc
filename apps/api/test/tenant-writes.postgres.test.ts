import { createHash, randomBytes, randomUUID } from "node:crypto";

import { AuthStore, createDatabasePool, migrate, TenantStore, asTenantPool, TenantStoreError } from "@openarc/db";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createApp } from "../src/app.js";
import { AuthService, type AuthServiceConfig } from "../src/auth/service.js";
import { deriveCsrfToken, issueBindingCookie } from "../src/auth/cookies.js";
import type { AuthProofPort, AuthRuntime } from "../src/auth/ports.js";
import type { AuthOriginConfig } from "../src/auth/proofs.js";
import { loadConfig } from "../src/config.js";
import { TenantReadService } from "../src/tenant/service.js";
import type { TenantReadStorePort } from "../src/tenant/ports.js";
import { TenantWriteService } from "../src/tenant/write-service.js";
import type { TenantWriteStorePort } from "../src/tenant/write-ports.js";
import {
  adminPool,
  appUrl,
  ensureRoles,
  migratorUrl,
  resetSchema,
  tenantUrl,
} from "../../../packages/db/test/postgres-fixture.js";

/**
 * Real-PostgreSQL tenant write/status flows.
 *
 * The runtime repositories are the real AuthStore and TenantStore over the
 * disposable fixture roles; RLS, locks, idempotency rows, audit/outbox and SQL
 * authorization are real. The WebAuthn/SIWE proof adapter is HONESTLY MOCKED
 * (labelled): these tests prove orchestration and SQL enforcement, not crypto.
 */

type Pool = ReturnType<typeof adminPool>;

const ORIGIN = "http://localhost:5183";
const RP_ID = "localhost";
const SECRET = "synthetic_auth_secret_for_tenant_write_pg_0123456789";
const BUILD_SHA = "0123456789abcdef0123456789abcdef01234567";
const CLIENT = { origin: ORIGIN, "x-openarc-client": "browser-v1" };

const A = "openarc:account:11111111-1111-4111-8111-111111111111";
const B = "openarc:account:22222222-2222-4222-8222-222222222222";
const C = "openarc:account:33333333-3333-4333-8333-333333333333";
const E = "openarc:account:55555555-5555-4555-8555-555555555555";
const F = "openarc:account:66666666-6666-4666-8666-666666666666";
const ORG1 = "openarc:org:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ORG2 = "openarc:org:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const AGENT1 = "openarc:agent:cccccccc-cccc-4ccc-8ccc-cccccccccccc";

function b64(bytes: number): string {
  return randomBytes(bytes).toString("base64url");
}

function mutationId(): string {
  return randomUUID();
}

function idempotencyKey(): string {
  return randomBytes(32).toString("base64url");
}

function tokenHash(token: string): string {
  return createHash("sha256").update(`openarc:session:v1:${token}`, "utf8").digest("hex");
}

function fakeProofs(): AuthProofPort {
  return {
    validateAuthOriginConfig: (input: unknown): AuthOriginConfig => input as AuthOriginConfig,
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
  options: { method?: "passkey" | "wallet" | "recovery"; expiresInSeconds?: number; ageSeconds?: number } = {},
): Promise<void> {
  await admin.query(
    `INSERT INTO openarc_auth.sessions (token_hash, account_id, method, created_at, expires_at)
     VALUES ($1, $2, $3, clock_timestamp() - ($4 || ' seconds')::interval,
             clock_timestamp() + ($5 || ' seconds')::interval)`,
    [tokenHash(token), accountId, options.method ?? "passkey", String(options.ageSeconds ?? 0), String(options.expiresInSeconds ?? 600)],
  );
}

async function seedOrganization(organizationId: string, createdBy: string, name: string): Promise<void> {
  await admin.query(
    `INSERT INTO openarc_tenant.organizations (organization_id, display_name, created_by)
     VALUES ($1, $2, $3)`,
    [organizationId, name, createdBy],
  );
}

async function seedMembership(organizationId: string, accountId: string, role: string, status = "active"): Promise<void> {
  await admin.query(
    `INSERT INTO openarc_tenant.memberships (organization_id, account_id, role, status)
     VALUES ($1, $2, $3, $4)`,
    [organizationId, accountId, role, status],
  );
}

async function seedAgent(organizationId: string, agentId: string, name: string): Promise<void> {
  await admin.query(
    `INSERT INTO openarc_tenant.agents (organization_id, agent_id, display_name)
     VALUES ($1, $2, $3)`,
    [organizationId, agentId, name],
  );
}

async function count(sql: string, values: unknown[] = []): Promise<number> {
  const result = await admin.query<{ n: string }>(sql, values);
  return Number(result.rows[0]?.n ?? "0");
}

const tokens = new Map<string, string>();

beforeEach(async () => {
  await resetSchema(admin);
  await migrate(migrator);
  app = createDatabasePool(appUrl());
  tenant = createDatabasePool(tenantUrl());

  for (const accountId of [A, B, C, E, F]) {
    await seedAccount(accountId);
  }
  await seedOrganization(ORG1, A, "Primary");
  await seedOrganization(ORG2, E, "Foreign");
  await seedMembership(ORG1, A, "owner");
  await seedMembership(ORG1, B, "operator");
  await seedMembership(ORG1, C, "viewer");
  await seedMembership(ORG2, E, "owner");
  await seedAgent(ORG1, AGENT1, "Agent One");

  tokens.clear();
  for (const [label, accountId] of [["a", A], ["b", B], ["c", C], ["e", E]] as const) {
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
}

async function buildApp(
  decorate?: (store: TenantWriteStorePort) => TenantWriteStorePort,
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
  const writeService = new TenantWriteService({
    auth: authService,
    store: decorate ? decorate(store) : store,
  });
  const readService = new TenantReadService({
    auth: authService,
    store: store as unknown as TenantReadStorePort,
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
    TENANT_WRITES_ENABLED: "true",
  });
  const instance = createApp({
    config,
    logger: false,
    authService,
    tenantReadService: readService,
    tenantReady: async () => true,
    tenantWriteService: writeService,
  });
  return { instance, store };
}

function headersFor(
  label: string,
  extra: Record<string, string> = {},
): Record<string, string> {
  const token = tokens.get(label) ?? "";
  const binding = issueBindingCookie(SECRET, b64(16), Date.now());
  return {
    ...CLIENT,
    "content-type": "application/json",
    cookie: `openarc_session=${token}; openarc_binding=${binding}`,
    "x-openarc-csrf": deriveCsrfToken(SECRET, binding, tokenHash(token)),
    "idempotency-key": idempotencyKey(),
    ...extra,
  };
}

const url = (suffix = "") => `/v1/operator/organizations${suffix}`;

function post(urlPath: string, label: string, body: Record<string, unknown>, extra: Record<string, string> = {}) {
  return { method: "POST" as const, url: urlPath, headers: headersFor(label, extra), payload: body };
}

async function bootstrap(instance: ReturnType<typeof createApp>, label: string, name = "Boot Org") {
  const id = mutationId();
  const response = await instance.inject(post(url(), label, { mutationId: id, displayName: name }));
  return { id, response, organizationId: `openarc:org:${id}` };
}

describe("real-PG tenant writes", () => {
  it("bootstraps, creates/updates agent and provider, and revokes a target membership", async () => {
    const { instance } = await buildApp();
    const boot = await bootstrap(instance, "a", "Boot Org");
    expect(boot.response.statusCode).toBe(200);
    expect(boot.response.json().data.receipt.resourceId).toBe(boot.organizationId);
    expect(boot.response.headers["set-cookie"]).toBeUndefined();

    const created = await instance.inject(
      post(url(`/${boot.organizationId}/agents`), "a", { mutationId: mutationId(), displayName: "New Agent" }),
    );
    expect(created.statusCode).toBe(200);
    const agentId = created.json().data.receipt.resourceId as string;

    const updated = await instance.inject({
      method: "PATCH",
      url: url(`/${boot.organizationId}/agents/${agentId}`),
      headers: headersFor("a"),
      payload: { mutationId: mutationId(), patch: { status: "suspended", displayName: "Renamed" } },
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json().data.receipt.operation).toBe("tenant.agent.update");

    const provider = await instance.inject(
      post(url(`/${boot.organizationId}/providers`), "a", { mutationId: mutationId(), displayName: "New Provider" }),
    );
    expect(provider.statusCode).toBe(200);
    const providerId = provider.json().data.receipt.resourceId as string;
    const providerUpdate = await instance.inject({
      method: "PATCH",
      url: url(`/${boot.organizationId}/providers/${providerId}`),
      headers: headersFor("a"),
      payload: { mutationId: mutationId(), patch: { status: "retired" } },
    });
    expect(providerUpdate.statusCode).toBe(200);

    const membership = await instance.inject({
      method: "PUT",
      url: url(`/${boot.organizationId}/memberships/${F}`),
      headers: headersFor("a"),
      payload: { mutationId: mutationId(), role: "viewer", membershipStatus: "active" },
    });
    expect(membership.statusCode).toBe(200);
    const revoke = await instance.inject({
      method: "PUT",
      url: url(`/${boot.organizationId}/memberships/${F}`),
      headers: headersFor("a"),
      payload: { mutationId: mutationId(), role: "viewer", membershipStatus: "suspended" },
    });
    expect(revoke.statusCode).toBe(200);
    const status = await admin.query<{ status: string }>(
      `SELECT status FROM openarc_tenant.memberships WHERE organization_id = $1 AND account_id = $2`,
      [boot.organizationId, F],
    );
    expect(status.rows[0]?.status).toBe("suspended");
  });

  it("enforces operator/provider/viewer/cross-org roles", async () => {
    const { instance } = await buildApp();
    const operatorAgent = await instance.inject(
      post(url(`/${ORG1}/agents`), "b", { mutationId: mutationId(), displayName: "Op Agent" }),
    );
    expect(operatorAgent.statusCode).toBe(200);

    const operatorProvider = await instance.inject(
      post(url(`/${ORG1}/providers`), "b", { mutationId: mutationId(), displayName: "Op Provider" }),
    );
    expect(operatorProvider.statusCode).toBe(403);

    const viewerAgent = await instance.inject(
      post(url(`/${ORG1}/agents`), "c", { mutationId: mutationId(), displayName: "Viewer Agent" }),
    );
    expect(viewerAgent.statusCode).toBe(403);

    const foreign = await instance.inject(
      post(url(`/${ORG1}/agents`), "e", { mutationId: mutationId(), displayName: "Foreign" }),
    );
    expect(foreign.statusCode).toBe(403);

    const operatorUpdate = await instance.inject({
      method: "PATCH",
      url: url(`/${ORG1}/agents/${AGENT1}`),
      headers: headersFor("b"),
      payload: { mutationId: mutationId(), patch: { status: "active" } },
    });
    expect(operatorUpdate.statusCode).toBe(200);
  });

  it("replays one business mutation with exactly one audit and outbox row", async () => {
    const { instance } = await buildApp();
    const id = mutationId();
    const key = idempotencyKey();
    const first = await instance.inject(
      post(url(`/${ORG1}/agents`), "a", { mutationId: id, displayName: "Replay Agent" }, { "idempotency-key": key }),
    );
    expect(first.statusCode).toBe(200);
    expect(first.json().data.replayed).toBe(false);
    const agentId = first.json().data.receipt.resourceId as string;

    const second = await instance.inject(
      post(url(`/${ORG1}/agents`), "a", { mutationId: id, displayName: "Replay Agent" }, { "idempotency-key": key }),
    );
    expect(second.statusCode).toBe(200);
    expect(second.json().data.replayed).toBe(true);
    expect(second.json().data.receipt.resourceId).toBe(agentId);

    expect(await count(`SELECT count(*)::text AS n FROM openarc_tenant.agents WHERE organization_id = $1 AND display_name = 'Replay Agent'`, [ORG1])).toBe(1);
    expect(await count(`SELECT count(*)::text AS n FROM openarc_durable.audit_events WHERE organization_id = $1 AND mutation_id = $2::uuid`, [ORG1, id])).toBe(1);
    expect(await count(`SELECT count(*)::text AS n FROM openarc_durable.outbox_events WHERE organization_id = $1 AND mutation_id = $2::uuid`, [ORG1, id])).toBe(1);
  });

  it("rejects changed key, body, logical id and principal conflicts with 409", async () => {
    const { instance } = await buildApp();
    const id = mutationId();
    const key = idempotencyKey();
    const first = await instance.inject(
      post(url(`/${ORG1}/agents`), "a", { mutationId: id, displayName: "First" }, { "idempotency-key": key }),
    );
    expect(first.statusCode).toBe(200);

    const changedKey = await instance.inject(
      post(url(`/${ORG1}/agents`), "a", { mutationId: id, displayName: "First" }, { "idempotency-key": idempotencyKey() }),
    );
    expect(changedKey.statusCode).toBe(409);
    expect(changedKey.json().error.code).toBe("IDEMPOTENCY_CONFLICT");

    const changedBody = await instance.inject(
      post(url(`/${ORG1}/agents`), "a", { mutationId: id, displayName: "Different" }, { "idempotency-key": key }),
    );
    expect(changedBody.statusCode).toBe(409);

    const changedPrincipal = await instance.inject(
      post(url(`/${ORG1}/agents`), "b", { mutationId: id, displayName: "First" }, { "idempotency-key": key }),
    );
    expect(changedPrincipal.statusCode).toBe(409);
  });

  it("commits a self-demotion receipt but the old cookie is unauthorized afterwards", async () => {
    const { instance } = await buildApp();
    // Promote B to owner so A retaining owner is not the last-owner case.
    const promote = await instance.inject({
      method: "PUT",
      url: url(`/${ORG1}/memberships/${B}`),
      headers: headersFor("a"),
      payload: { mutationId: mutationId(), role: "owner", membershipStatus: "active" },
    });
    expect(promote.statusCode).toBe(200);

    const demote = await instance.inject({
      method: "PUT",
      url: url(`/${ORG1}/memberships/${A}`),
      headers: headersFor("a"),
      payload: { mutationId: mutationId(), role: "viewer", membershipStatus: "active" },
    });
    expect(demote.statusCode).toBe(200);
    expect(demote.json().data.receipt.operation).toBe("tenant.membership.set");

    const after = await instance.inject({
      method: "GET",
      url: url(`/${ORG1}`),
      headers: { ...CLIENT, cookie: `openarc_session=${tokens.get("a")}` },
    });
    expect(after.statusCode).toBe(401);
  });

  it("rejects the last owner demotion and rolls the mutation back", async () => {
    const { instance } = await buildApp();
    const id = mutationId();
    const response = await instance.inject({
      method: "PUT",
      url: url(`/${ORG2}/memberships/${E}`),
      headers: headersFor("e"),
      payload: { mutationId: id, role: "viewer", membershipStatus: "active" },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe("POLICY_DENIED");
    const role = await admin.query<{ role: string }>(
      `SELECT role FROM openarc_tenant.memberships WHERE organization_id = $1 AND account_id = $2`,
      [ORG2, E],
    );
    expect(role.rows[0]?.role).toBe("owner");
    expect(await count(`SELECT count(*)::text AS n FROM openarc_durable.idempotency_records WHERE organization_id = $1 AND mutation_id = $2::uuid`, [ORG2, id])).toBe(0);
  });

  it("re-reads the live session after a status repository result and rejects expiry", async () => {
    const token = tokens.get("a") as string;
    const { instance } = await buildApp((store) => ({
      createOrganizationDurably: (h, n, m) => store.createOrganizationDurably(h, n, m),
      createAgentDurably: (h, o, n, m) => store.createAgentDurably(h, o, n, m),
      updateAgentDurably: (h, o, a, p, m) => store.updateAgentDurably(h, o, a, p, m),
      createProviderDurably: (h, o, n, m) => store.createProviderDurably(h, o, n, m),
      updateProviderDurably: (h, o, p, patch, m) => store.updateProviderDurably(h, o, p, patch, m),
      setMembershipDurably: (h, o, a, r, s, m) => store.setMembershipDurably(h, o, a, r, s, m),
      // Revoke the SESSION only after the status read returned, so a service
      // that skipped finishTenantRead would still deliver a receipt/DTO.
      getTenantMutationStatus: async (h, o, m) => {
        const result = await store.getTenantMutationStatus(h, o, m);
        await admin.query("DELETE FROM openarc_auth.sessions WHERE token_hash = $1", [tokenHash(token)]);
        return result;
      },
      getOrganizationMutationStatus: async (h, m) => {
        const result = await store.getOrganizationMutationStatus(h, m);
        await admin.query("DELETE FROM openarc_auth.sessions WHERE token_hash = $1", [tokenHash(token)]);
        return result;
      },
    }));

    for (const urlPath of [url(`/${ORG1}/mutations/${mutationId()}`), url(`/bootstrap-mutations/${mutationId()}`)]) {
      // Re-seed the session before each status call (the previous call revoked it).
      await admin.query("DELETE FROM openarc_auth.sessions WHERE token_hash = $1", [tokenHash(token)]);
      await admin.query(
        `INSERT INTO openarc_auth.sessions (token_hash, account_id, method, created_at, expires_at)
         VALUES ($1, $2, 'passkey', clock_timestamp(), clock_timestamp() + interval '600 seconds')`,
        [tokenHash(token), A],
      );
      const response = await instance.inject({
        method: "GET",
        url: urlPath,
        headers: { ...CLIENT, cookie: `openarc_session=${token}` },
      });
      expect(response.statusCode).toBe(401);
      expect(response.headers["set-cookie"]).toBeUndefined();
      expect(response.body).not.toContain('"data"');
      expect(response.body).not.toContain(ORG1);
    }
  });

  it("recovers a lost-reply commit via status without a second mutation", async () => {
    const id = mutationId();
    const key = idempotencyKey();
    const { instance } = await buildApp((store) => {
      const decorate = <K extends keyof TenantWriteStorePort>(
        name: K,
      ): TenantWriteStorePort[K] =>
        ((...args: Parameters<TenantWriteStorePort[K]>) =>
          (store[name] as (...a: Parameters<TenantWriteStorePort[K]>) => ReturnType<TenantWriteStorePort[K]>)(...args)) as TenantWriteStorePort[K];
      return {
        createOrganizationDurably: decorate("createOrganizationDurably"),
        updateAgentDurably: decorate("updateAgentDurably"),
        createProviderDurably: decorate("createProviderDurably"),
        updateProviderDurably: decorate("updateProviderDurably"),
        setMembershipDurably: decorate("setMembershipDurably"),
        getTenantMutationStatus: decorate("getTenantMutationStatus"),
        getOrganizationMutationStatus: decorate("getOrganizationMutationStatus"),
        createAgentDurably: async (...args) => {
          await store.createAgentDurably(...args);
          // HONEST transport fault: the commit succeeded, the reply was lost.
          throw new TenantStoreError("TENANT_STORE_OUTCOME_UNKNOWN");
        },
      };
    });
    const lost = await instance.inject(
      post(url(`/${ORG1}/agents`), "a", { mutationId: id, displayName: "Lost Reply" }, { "idempotency-key": key }),
    );
    expect(lost.statusCode).toBe(503);
    expect(lost.json().error.retryable).toBe(false);
    expect(await count(`SELECT count(*)::text AS n FROM openarc_tenant.agents WHERE organization_id = $1 AND display_name = 'Lost Reply'`, [ORG1])).toBe(1);

    const status = await instance.inject({
      method: "GET",
      url: url(`/${ORG1}/mutations/${id}`),
      headers: { ...CLIENT, cookie: `openarc_session=${tokens.get("a")}` },
    });
    expect(status.statusCode).toBe(200);
    expect(status.json().data.status).toBe("committed");
    expect(status.json().data.receipt.operation).toBe("tenant.agent.create");
    expect(await count(`SELECT count(*)::text AS n FROM openarc_tenant.agents WHERE organization_id = $1 AND display_name = 'Lost Reply'`, [ORG1])).toBe(1);
  });

  it("keeps status not_found for another actor and forbidden cross-org without leak", async () => {
    const { instance } = await buildApp();
    const id = mutationId();
    const created = await instance.inject(
      post(url(`/${ORG1}/agents`), "a", { mutationId: id, displayName: "Private" }),
    );
    expect(created.statusCode).toBe(200);

    const otherActor = await instance.inject({
      method: "GET",
      url: url(`/${ORG1}/mutations/${id}`),
      headers: { ...CLIENT, cookie: `openarc_session=${tokens.get("b")}` },
    });
    expect(otherActor.statusCode).toBe(200);
    expect(otherActor.json().data.status).toBe("not_found");
    expect(JSON.stringify(otherActor.json().data)).not.toContain("receipt");

    const crossOrg = await instance.inject({
      method: "GET",
      url: url(`/${ORG2}/mutations/${id}`),
      headers: { ...CLIENT, cookie: `openarc_session=${tokens.get("a")}` },
    });
    expect(crossOrg.statusCode).toBe(403);
    expect(crossOrg.body).not.toContain(id);
  });

  it("never echoes a display-name canary or the raw idempotency key", async () => {
    const logs: unknown[] = [];
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
      TENANT_WRITES_ENABLED: "true",
    });
    const instance = createApp({
      config,
      logger: false,
      logSink: (entry) => logs.push(entry),
      authService,
      tenantReadService: new TenantReadService({ auth: authService, store: store as unknown as TenantReadStorePort }),
      tenantReady: async () => true,
      tenantWriteService: new TenantWriteService({ auth: authService, store }),
    });
    const canary = "PRIVATE_NAME_CANARY";
    const key = idempotencyKey();
    const response = await instance.inject(
      post(url(`/${ORG1}/agents`), "a", { mutationId: mutationId(), displayName: canary }, { "idempotency-key": key }),
    );
    expect(response.statusCode).toBe(200);
    expect(response.body).not.toContain(canary);
    expect(response.body).not.toContain(key);
    for (const entry of logs) {
      const serialized = JSON.stringify(entry);
      expect(serialized).not.toContain(canary);
      expect(serialized).not.toContain(key);
    }
  });
});
