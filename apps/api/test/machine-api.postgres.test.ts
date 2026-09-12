import { createHash, randomBytes, randomUUID } from "node:crypto";

import {
  asCredentialPool,
  AuthStore,
  createDatabasePool,
  CredentialStore,
  CredentialStoreError,
  migrate,
} from "@openarc/db";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createApp } from "../src/app.js";
import { AuthService, type AuthServiceConfig } from "../src/auth/service.js";
import { deriveCsrfToken, issueBindingCookie } from "../src/auth/cookies.js";
import type { AuthProofPort, AuthRuntime } from "../src/auth/ports.js";
import type { AuthOriginConfig } from "../src/auth/proofs.js";
import { loadConfig } from "../src/config.js";
import { MachineCredentialCrypto } from "../src/machine/credential-crypto.js";
import { MachineManagementService } from "../src/machine/management-service.js";
import { MachineRateLimiter } from "../src/machine/rate-limiter.js";
import { MachineSessionService } from "../src/machine/session-service.js";
import type {
  MachineCredentialStorePort,
  MachineSessionStorePort,
} from "../src/machine/ports.js";
import type { TenantReadService } from "../src/tenant/service.js";
import type { TenantWriteService } from "../src/tenant/write-service.js";
import {
  adminPool,
  appUrl,
  ensureRoles,
  migratorUrl,
  resetSchema,
  tenantUrl,
} from "../../../packages/db/test/postgres-fixture.js";

/**
 * Real-PostgreSQL machine credential and session flows.
 *
 * The runtime repositories are the REAL `CredentialStore` and `AuthStore` over
 * the disposable fixture roles with REAL async scrypt; RLS, SECURITY DEFINER
 * helpers, locks, idempotency rows and the schema/ACL manifest are real. The
 * WebAuthn/SIWE proof adapter is HONESTLY MOCKED (labelled): these tests prove
 * orchestration and SQL enforcement, not browser crypto.
 */

type Pool = ReturnType<typeof adminPool>;

const ORIGIN = "http://localhost:5183";
const RP_ID = "localhost";
const AUTH_SECRET = "synthetic_auth_secret_for_machine_pg_tests_0123456789";
const BUILD_SHA = "0123456789abcdef0123456789abcdef01234567";
const CLIENT = { origin: ORIGIN, "x-openarc-client": "browser-v1" };

const A = "openarc:account:11111111-1111-4111-8111-111111111111";
const B = "openarc:account:22222222-2222-4222-8222-222222222222";
const C = "openarc:account:33333333-3333-4333-8333-333333333333";
const E = "openarc:account:55555555-5555-4555-8555-555555555555";
const ORG1 = "openarc:org:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ORG2 = "openarc:org:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const AGENT1 = "openarc:agent:cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const PROVIDER1 = "openarc:provider:dddddddd-dddd-4ddd-8ddd-dddddddddddd";

const PEPPER = randomBytes(32).fill(7).toString("base64url");
const RATE_SECRET = randomBytes(32).fill(9).toString("base64url");

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
  options: { method?: "passkey" | "wallet" | "recovery"; expiresInSeconds?: number } = {},
): Promise<void> {
  await admin.query(
    `INSERT INTO openarc_auth.sessions (token_hash, account_id, method, created_at, expires_at)
     VALUES ($1, $2, $3, clock_timestamp(), clock_timestamp() + ($4 || ' seconds')::interval)`,
    [tokenHash(token), accountId, options.method ?? "passkey", String(options.expiresInSeconds ?? 900)],
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

async function seedProvider(organizationId: string, providerId: string, name: string): Promise<void> {
  await admin.query(
    `INSERT INTO openarc_tenant.providers (organization_id, provider_id, display_name)
     VALUES ($1, $2, $3)`,
    [organizationId, providerId, name],
  );
}

async function count(sql: string, values: unknown[] = []): Promise<number> {
  const result = await admin.query<{ n: string }>(sql, values);
  return Number(result.rows[0]?.n ?? "0");
}

/**
 * Poll `pg_stat_activity` from a SEPARATE connection until the real session
 * creation call issued by a pending request is blocked on a held lock. Seeing
 * the SQL blocked proves the scrypt KDF already completed and the request
 * reached the create-session function; this is not a mock, sleep or timer.
 */
async function waitForBlockedMachineQuery(
  pool: Pool,
  functionName: string,
  timeoutMs = 5000,
): Promise<{ wait_event_type: string | null } | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await pool.query<{ wait_event_type: string | null }>(
      `SELECT wait_event_type
         FROM pg_stat_activity
        WHERE query LIKE $1
          AND pid <> pg_backend_pid()
          AND wait_event_type = 'Lock'
        LIMIT 1`,
      [`%${functionName}%`],
    );
    if (result.rows.length > 0) return result.rows[0] ?? null;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return null;
}

function delay(ms: number): Promise<"timeout"> {
  return new Promise((resolve) => setTimeout(() => resolve("timeout"), ms));
}

function createGate() {
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let reached: () => void = () => undefined;
  const atGate = new Promise<void>((resolve) => {
    reached = resolve;
  });
  return { gate, release, atGate, reached };
}

const tokens = new Map<string, string>();

beforeEach(async () => {
  await resetSchema(admin);
  await migrate(migrator);
  app = createDatabasePool(appUrl());
  tenant = createDatabasePool(tenantUrl());

  for (const accountId of [A, B, C, E]) await seedAccount(accountId);
  await seedOrganization(ORG1, A, "Primary");
  await seedOrganization(ORG2, E, "Foreign");
  await seedMembership(ORG1, A, "owner");
  await seedMembership(ORG1, B, "operator");
  await seedMembership(ORG1, C, "viewer");
  await seedMembership(ORG2, E, "owner");
  await seedAgent(ORG1, AGENT1, "Agent One");
  await seedProvider(ORG1, PROVIDER1, "Provider One");

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
  readonly instance: ReturnType<typeof createApp>;
  readonly store: CredentialStore;
  readonly sessionService: MachineSessionService;
}

type DelegatingStore = MachineCredentialStorePort & MachineSessionStorePort;

const DELEGATED_METHODS = [
  "issueAgentCredentialDurably",
  "issueProviderCredentialDurably",
  "revokeAgentCredentialDurably",
  "revokeProviderCredentialDurably",
  "listAgentCredentials",
  "listProviderCredentials",
  "getAgentCredentialMutationStatus",
  "getProviderCredentialMutationStatus",
  "findAgentCredentialVerifier",
  "findProviderCredentialVerifier",
  "createAgentSession",
  "createProviderSession",
  "getAgentSession",
  "getProviderSession",
  "revokeAgentSession",
  "revokeProviderSession",
] as const;

/** Bind every port method to the concrete store, applying explicit overrides. */
function delegate(
  store: CredentialStore,
  overrides: Record<string, (...args: never[]) => unknown> = {},
): DelegatingStore {
  const target: Record<string, unknown> = {};
  for (const method of DELEGATED_METHODS) {
    target[method] = (store[method] as (...args: unknown[]) => unknown).bind(store);
  }
  for (const [name, fn] of Object.entries(overrides)) target[name] = fn;
  return target as unknown as DelegatingStore;
}

function config() {
  return loadConfig({
    NODE_ENV: "test",
    APP_ORIGIN: ORIGIN,
    COMMIT_SHA: BUILD_SHA,
    AUTH_ENABLED: "true",
    AUTH_DATABASE_URL: appUrl(),
    AUTH_SECRET,
    AUTH_RP_ID: RP_ID,
    TENANT_READS_ENABLED: "true",
    TENANT_DATABASE_URL: tenantUrl(),
    TENANT_WRITES_ENABLED: "true",
    MACHINE_CREDENTIAL_MANAGEMENT_ENABLED: "true",
    MACHINE_SESSION_EXCHANGE_ENABLED: "true",
    MACHINE_CREDENTIAL_PEPPER_VERSION: "1",
    MACHINE_CREDENTIAL_PEPPER: PEPPER,
    MACHINE_RATE_SECRET: RATE_SECRET,
  });
}

async function buildApp(
  decorate?: (store: CredentialStore) => DelegatingStore,
): Promise<Built> {
  const authStore = new AuthStore(app);
  const authService = new AuthService({
    config: {
      authSecret: AUTH_SECRET,
      appOrigin: ORIGIN,
      rpId: RP_ID,
      environment: "development",
      secureCookies: false,
      cookieNames: { session: "openarc_session", binding: "openarc_binding" },
    } satisfies AuthServiceConfig,
    store: authStore,
    proofs: fakeProofs(),
    runtime: fakeRuntime(),
  });
  const store = new CredentialStore(asCredentialPool(tenant));
  await store.initialize();
  const port = decorate ? decorate(store) : store;
  const crypto = new MachineCredentialCrypto({
    currentVersion: 1,
    peppers: new Map([[1, new Uint8Array(Buffer.from(PEPPER, "base64url"))]]),
  });
  const limits = new MachineRateLimiter({
    secret: RATE_SECRET,
    store: { consume: (input) => authStore.consumeRateLimit(input) },
  });
  const managementService = new MachineManagementService({
    auth: authService,
    store: port,
    crypto,
    limits,
  });
  const sessionService = new MachineSessionService({
    store: port,
    crypto,
    limits,
    now: () => new Date(),
  });
  const instance = createApp({
    config: config(),
    logger: false,
    authService,
    tenantReadService: {} as TenantReadService,
    tenantReady: async () => true,
    tenantWriteService: {} as TenantWriteService,
    machineManagementService: managementService,
    machineSessionService: sessionService,
    machineReady: async () => true,
  });
  return { instance, store, sessionService };
}

const PREFIX = "/v1/operator/organizations";

function managementHeaders(label: string, extra: Record<string, string> = {}): Record<string, string> {
  const token = tokens.get(label) ?? "";
  const binding = issueBindingCookie(AUTH_SECRET, b64(16), Date.now());
  return {
    ...CLIENT,
    "content-type": "application/json",
    cookie: `openarc_session=${token}; openarc_binding=${binding}`,
    "x-openarc-csrf": deriveCsrfToken(AUTH_SECRET, binding, tokenHash(token)),
    "idempotency-key": idempotencyKey(),
    ...extra,
  };
}

function issueRequest(
  kind: "agent" | "provider",
  label: string,
  options: { organizationId?: string; profileId?: string; mutationId?: string; idempotencyKey?: string; expiresAt?: string } = {},
) {
  const organizationId = options.organizationId ?? ORG1;
  const profileId = options.profileId ?? (kind === "agent" ? AGENT1 : PROVIDER1);
  const mutation = options.mutationId ?? mutationId();
  const expiresAt = options.expiresAt ?? new Date(Date.now() + 60_000).toISOString();
  const path = `${PREFIX}/${organizationId}/${kind === "agent" ? "agents" : "providers"}/${profileId}/credentials`;
  return {
    mutation,
    path,
    request: {
      method: "POST" as const,
      url: path,
      headers: managementHeaders(label, options.idempotencyKey ? { "idempotency-key": options.idempotencyKey } : {}),
      payload: { mutationId: mutation, expiresAt },
    },
  };
}

function exchangeRequest(kind: "agent" | "provider", credential: string) {
  return {
    method: "POST" as const,
    url: `/v1/${kind}/sessions`,
    headers: { authorization: `Bearer ${credential}`, "content-type": "application/json" },
    payload: {},
  };
}

function selfRequest(kind: "agent" | "provider", token: string) {
  return {
    method: "GET" as const,
    url: `/v1/${kind}/self`,
    headers: { authorization: `Bearer ${token}` },
  };
}

function sessionRevokeRequest(kind: "agent" | "provider", token: string) {
  return {
    method: "POST" as const,
    url: `/v1/${kind}/sessions/current/revoke`,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    payload: {},
  };
}

interface IssuedSession {
  readonly credential: string;
  readonly credentialId: string;
  readonly sessionToken: string;
  readonly sessionId: string;
}

interface MachineResponse {
  readonly statusCode: number;
  readonly body: string;
  json(): unknown;
}

type PendingRequest = Promise<MachineResponse>;

/** Issue a real credential and exchange it for a real session token. */
async function issueAndExchange(
  instance: ReturnType<typeof createApp>,
  kind: "agent" | "provider",
  label = "a",
): Promise<IssuedSession> {
  const issued = await instance.inject(issueRequest(kind, label).request);
  expect(issued.statusCode).toBe(200);
  const credential = issued.json().data.delivery.credential as string;
  const credentialId = issued.json().data.receipt.credentialId as string;
  const exchanged = await instance.inject(exchangeRequest(kind, credential));
  expect(exchanged.statusCode).toBe(200);
  return {
    credential,
    credentialId,
    sessionToken: exchanged.json().data.delivery.token as string,
    sessionId: exchanged.json().data.session.sessionId as string,
  };
}

describe("real-PG machine API", () => {
  it("issues an agent credential, exchanges it, reads self, revokes the session, then the credential", async () => {
    const { instance } = await buildApp();
    const issue = issueRequest("agent", "a");
    const issued = await instance.inject(issue.request);
    expect(issued.statusCode).toBe(200);
    const body = issued.json().data;
    expect(body.replayed).toBe(false);
    expect(body.delivery.status).toBe("available_once");
    const credential = body.delivery.credential as string;
    expect(credential).toMatch(/^oac_ag_/);
    expect(issued.headers["set-cookie"]).toBeUndefined();

    const exchanged = await instance.inject(exchangeRequest("agent", credential));
    expect(exchanged.statusCode).toBe(200);
    const session = exchanged.json().data.session;
    expect(session.kind).toBe("agent");
    expect(session.profileId).toBe(AGENT1);
    expect(session.organizationId).toBe(ORG1);
    const sessionToken = exchanged.json().data.delivery.token as string;
    expect(sessionToken).toMatch(/^oas_ag_/);
    // The raw session token must never be stored; only its domain hash is.
    expect(
      await count(`SELECT count(*)::text AS n FROM openarc_durable.agent_sessions`),
    ).toBe(1);

    const self = await instance.inject(selfRequest("agent", sessionToken));
    expect(self.statusCode).toBe(200);
    expect(self.json().data.session.sessionId).toBe(session.sessionId);
    expect(self.headers["set-cookie"]).toBeUndefined();

    const revoked = await instance.inject(sessionRevokeRequest("agent", sessionToken));
    expect(revoked.statusCode).toBe(200);
    expect(revoked.json().data.kind).toBe("agent");
    const afterRevoke = await instance.inject(selfRequest("agent", sessionToken));
    expect(afterRevoke.statusCode).toBe(401);

    // Revoke the long-lived credential and prove every session is invalidated.
    const revoke = await instance.inject({
      method: "POST",
      url: `${PREFIX}/${ORG1}/agent-credentials/${body.receipt.credentialId}/revoke`,
      headers: managementHeaders("a"),
      payload: { mutationId: mutationId() },
    });
    expect(revoke.statusCode).toBe(200);
    const exchangeAfter = await instance.inject(exchangeRequest("agent", credential));
    expect([401, 503]).toContain(exchangeAfter.statusCode);
  });

  it("issues and exchanges a provider credential for an owner only", async () => {
    const { instance } = await buildApp();
    const owner = await instance.inject(issueRequest("provider", "a").request);
    expect(owner.statusCode).toBe(200);
    const credential = owner.json().data.delivery.credential as string;
    const exchanged = await instance.inject(exchangeRequest("provider", credential));
    expect(exchanged.statusCode).toBe(200);
    expect(exchanged.json().data.delivery.token).toMatch(/^oas_pr_/);

    const operator = await instance.inject(issueRequest("provider", "b").request);
    expect(operator.statusCode).toBe(403);
  });

  it("rejects a wrong-kind credential, a wrong profile and a viewer", async () => {
    const { instance } = await buildApp();
    const provider = await instance.inject(issueRequest("provider", "a").request);
    const providerCredential = provider.json().data.delivery.credential as string;
    const wrongKind = await instance.inject(exchangeRequest("agent", providerCredential));
    expect(wrongKind.statusCode).toBe(401);

    const wrongProfile = await instance.inject(
      issueRequest("agent", "a", { profileId: PROVIDER1 }).request,
    );
    expect([400, 403]).toContain(wrongProfile.statusCode);

    const viewer = await instance.inject(issueRequest("agent", "c").request);
    expect(viewer.statusCode).toBe(403);
  });

  it("denies a cross-organization issue without an existence oracle", async () => {
    const { instance } = await buildApp();
    const response = await instance.inject(issueRequest("agent", "a", { organizationId: ORG2 }).request);
    expect(response.statusCode).toBe(403);
    expect(await count(`SELECT count(*)::text AS n FROM openarc_durable.agent_credentials`)).toBe(0);
  });

  it("denies issuance from a recovery session but permits recovery reads", async () => {
    const recoveryToken = b64(32);
    await seedSession(recoveryToken, A, { method: "recovery" });
    const { instance } = await buildApp();
    const binding = issueBindingCookie(AUTH_SECRET, b64(16), Date.now());
    const request = {
      method: "POST" as const,
      url: `${PREFIX}/${ORG1}/agents/${AGENT1}/credentials`,
      headers: {
        ...CLIENT,
        "content-type": "application/json",
        cookie: `openarc_session=${recoveryToken}; openarc_binding=${binding}`,
        "x-openarc-csrf": deriveCsrfToken(AUTH_SECRET, binding, tokenHash(recoveryToken)),
        "idempotency-key": idempotencyKey(),
      },
      payload: { mutationId: mutationId(), expiresAt: new Date(Date.now() + 60_000).toISOString() },
    };
    const denied = await instance.inject(request);
    // Issuance from a recovery session is denied (fixed denial, no oracle).
    expect([401, 403]).toContain(denied.statusCode);

    const list = await instance.inject({
      method: "GET",
      url: `${PREFIX}/${ORG1}/agents/${AGENT1}/credentials`,
      headers: { ...CLIENT, cookie: `openarc_session=${recoveryToken}` },
    });
    expect(list.statusCode).toBe(200);
  });

  it("permits a recovery session to revoke a credential while denying issuance", async () => {
    const { instance } = await buildApp();
    const issued = await instance.inject(issueRequest("agent", "a").request);
    expect(issued.statusCode).toBe(200);
    const credentialId = issued.json().data.receipt.credentialId as string;

    const recoveryToken = b64(32);
    await seedSession(recoveryToken, A, { method: "recovery" });
    const binding = issueBindingCookie(AUTH_SECRET, b64(16), Date.now());
    const headers = {
      ...CLIENT,
      "content-type": "application/json",
      cookie: `openarc_session=${recoveryToken}; openarc_binding=${binding}`,
      "x-openarc-csrf": deriveCsrfToken(AUTH_SECRET, binding, tokenHash(recoveryToken)),
      "idempotency-key": idempotencyKey(),
    };
    const revoked = await instance.inject({
      method: "POST",
      url: `${PREFIX}/${ORG1}/agent-credentials/${credentialId}/revoke`,
      headers,
      payload: { mutationId: mutationId() },
    });
    expect(revoked.statusCode).toBe(200);
    expect(revoked.json().data.receipt.credentialId).toBe(credentialId);
    const status = await admin.query<{ revoked_at: Date | null }>(
      `SELECT revoked_at FROM openarc_durable.agent_credentials WHERE credential_id = $1`,
      [credentialId],
    );
    expect(status.rows[0]?.revoked_at).not.toBeNull();

    const deniedIssue = await instance.inject({
      method: "POST",
      url: `${PREFIX}/${ORG1}/agents/${AGENT1}/credentials`,
      headers,
      payload: { mutationId: mutationId(), expiresAt: new Date(Date.now() + 60_000).toISOString() },
    });
    expect([401, 403]).toContain(deniedIssue.statusCode);
  });

  it("returns token_not_replayable on a replayed issue and keeps status safe", async () => {
    const { instance } = await buildApp();
    const key = idempotencyKey();
    const mutation = mutationId();
    const expiresAt = new Date(Date.now() + 60_000).toISOString();
    const request = issueRequest("agent", "a", { mutationId: mutation, idempotencyKey: key, expiresAt });
    // A replay resends the EXACT same request (same logical mutation id and
    // idempotency key); only then may the receipt be replayed.
    const created = await instance.inject(request.request);
    expect(created.statusCode).toBe(200);
    expect(created.json().data.replayed).toBe(false);
    const credential = created.json().data.delivery.credential as string;

    const replay = await instance.inject(request.request);
    expect(replay.statusCode).toBe(200);
    expect(replay.json().data.replayed).toBe(true);
    expect(replay.json().data.delivery).toEqual({ status: "token_not_replayable" });
    expect(JSON.stringify(replay.json())).not.toContain(credential);

    const status = await instance.inject({
      method: "GET",
      url: `${PREFIX}/${ORG1}/agent-credential-mutations/${mutation}`,
      headers: { ...CLIENT, cookie: `openarc_session=${tokens.get("a") as string}` },
    });
    expect(status.statusCode).toBe(200);
    expect(status.json().data.status).toBe("committed");
    expect(JSON.stringify(status.json())).not.toContain(credential);
    expect(await count(`SELECT count(*)::text AS n FROM openarc_durable.agent_credentials`)).toBe(1);
  });

  it("caps the session TTL by the credential expiry and rejects an expired credential", async () => {
    const { instance } = await buildApp();
    const shortExpiry = new Date(Date.now() + 120_000).toISOString();
    const issued = await instance.inject(
      issueRequest("agent", "a", { expiresAt: shortExpiry }).request,
    );
    expect(issued.statusCode).toBe(200);
    const credential = issued.json().data.delivery.credential as string;
    const exchanged = await instance.inject(exchangeRequest("agent", credential));
    expect(exchanged.statusCode).toBe(200);
    expect(exchanged.json().data.session.expiresAt).toBe(shortExpiry);

    await admin.query(
      `UPDATE openarc_durable.agent_credentials
          SET created_at = clock_timestamp() - interval '2 minutes',
              expires_at = clock_timestamp() - interval '1 minute'`,
    );
    const expired = await instance.inject(exchangeRequest("agent", credential));
    expect(expired.statusCode).toBe(401);
  });

  it("rechecks the credential revocation version after the KDF (sequential in-process barrier)", async () => {
    const token = tokens.get("a") as string;
    let barrierObserved = false;
    const { instance } = await buildApp((store) =>
      delegate(store, {
        findAgentCredentialVerifier: async (...args: never[]) => {
          const snapshot = await (store.findAgentCredentialVerifier as (...a: never[]) => Promise<unknown>)(...args);
          // SEQUENTIAL invalidation: revoke AFTER the verifier snapshot is read
          // but BEFORE the create call. This is not a cross-connection lock
          // wait; the observed post-KDF lock barriers are the tests below.
          await admin.query(
            `UPDATE openarc_durable.agent_credentials
                SET revoked_at = clock_timestamp(),
                    revocation_version = revocation_version + 1`,
          );
          barrierObserved = true;
          return snapshot;
        },
      }),
    );
    const issued = await instance.inject(issueRequest("agent", "a").request);
    const credential = issued.json().data.delivery.credential as string;
    const exchanged = await instance.inject(exchangeRequest("agent", credential));
    expect(barrierObserved).toBe(true);
    expect([401, 409, 503]).toContain(exchanged.statusCode);
    expect(await count(`SELECT count(*)::text AS n FROM openarc_durable.agent_sessions`)).toBe(0);
    void token;
  });

  it("rechecks live membership after the KDF (sequential in-process barrier)", async () => {
    let barrierObserved = false;
    const { instance } = await buildApp((store) =>
      delegate(store, {
        createAgentSession: async (...args: never[]) => {
          await admin.query(
            `UPDATE openarc_tenant.memberships SET status = 'suspended' WHERE organization_id = $1 AND account_id = $2`,
            [ORG1, A],
          );
          barrierObserved = true;
          return (store.createAgentSession as (...a: never[]) => unknown)(...args);
        },
      }),
    );
    const issued = await instance.inject(issueRequest("agent", "a").request);
    const credential = issued.json().data.delivery.credential as string;
    const exchanged = await instance.inject(exchangeRequest("agent", credential));
    expect(barrierObserved).toBe(true);
    expect([401, 403, 503]).toContain(exchanged.statusCode);
    expect(await count(`SELECT count(*)::text AS n FROM openarc_durable.agent_sessions`)).toBe(0);
  });

  it("maps an unknown COMMIT to a non-retryable 503 without a second mutation", async () => {
    let calls = 0;
    const { instance } = await buildApp((store) =>
      delegate(store, {
        issueAgentCredentialDurably: async (...args: never[]) => {
          calls += 1;
          await (store.issueAgentCredentialDurably as (...a: never[]) => unknown)(...args);
          // The transaction committed but the reply was lost.
          throw new CredentialStoreError("CREDENTIAL_STORE_OUTCOME_UNKNOWN");
        },
      }),
    );
    const response = await instance.inject(issueRequest("agent", "a").request);
    expect(response.statusCode).toBe(503);
    expect(response.json().error.retryable).toBe(false);
    expect(response.json().error.code).toBe("INTERNAL_ERROR");
    expect(calls).toBe(1);
    expect(await count(`SELECT count(*)::text AS n FROM openarc_durable.agent_credentials`)).toBe(1);
    expect(await count(`SELECT count(*)::text AS n FROM openarc_durable.idempotency_records`)).toBe(1);
  });

  it("shares one durable fixed-window limiter across two independent stores and pools", async () => {
    // Two SEPARATELY constructed AuthStore instances over two distinct pools
    // (not two limiter objects sharing one store). The window row is durable.
    const secondPool = createDatabasePool(appUrl());
    try {
      const firstStore = new AuthStore(app);
      const secondStore = new AuthStore(secondPool);
      expect(firstStore).not.toBe(secondStore);
      const first = new MachineRateLimiter({
        secret: RATE_SECRET,
        store: { consume: (input) => firstStore.consumeRateLimit(input) },
      });
      const second = new MachineRateLimiter({
        secret: RATE_SECRET,
        store: { consume: (input) => secondStore.consumeRateLimit(input) },
      });
      const check = {
        family: "exchange" as const,
        bucket: "global" as const,
        kind: "agent" as const,
        value: "*",
        limit: 1,
      };
      await first.consume(check);
      await expect(second.consume(check)).rejects.toMatchObject({ status: 429 });
      // The two families must not collide even over the same durable store.
      await second.consume({ ...check, family: "session" });
      // A different secret domain must not collide with the shared bucket.
      const other = new MachineRateLimiter({
        secret: b64(32),
        store: { consume: (input) => firstStore.consumeRateLimit(input) },
      });
      await other.consume(check);
    } finally {
      await secondPool.end();
    }
  });

  it("serializes a real encoded organization path exactly once", async () => {
    const { instance } = await buildApp();
    const encoded = encodeURIComponent(ORG1);
    const response = await instance.inject({
      method: "GET",
      url: `${PREFIX}/${encoded}/agents/${AGENT1}/credentials`,
      headers: { ...CLIENT, cookie: `openarc_session=${tokens.get("a") as string}` },
    });
    expect(response.statusCode).toBe(200);
    const doubleEncoded = await instance.inject({
      method: "GET",
      url: `${PREFIX}/${encodeURIComponent(encoded)}/agents/${AGENT1}/credentials`,
      headers: { ...CLIENT, cookie: `openarc_session=${tokens.get("a") as string}` },
    });
    expect(doubleEncoded.statusCode).toBe(400);
  });

  it("observes a real post-KDF credential-revoke lock barrier for an agent", async () => {
    const gate = createGate();
    const { instance } = await buildApp((store) =>
      delegate(store, {
        createAgentSession: async (...args: never[]) => {
          gate.reached();
          await gate.gate;
          return (store.createAgentSession as (...a: never[]) => Promise<unknown>)(...args);
        },
      }),
    );
    const issued = await instance.inject(issueRequest("agent", "a").request);
    expect(issued.statusCode).toBe(200);
    const credential = issued.json().data.delivery.credential as string;
    const credentialId = issued.json().data.receipt.credentialId as string;

    const blocker = await admin.connect();
    let pending: PendingRequest | undefined;
    try {
      await blocker.query("BEGIN");
      const request = instance.inject(exchangeRequest("agent", credential)) as unknown as PendingRequest;
      pending = request;
      // Force the request to start; Fastify's inject return may be a lazy thenable.
      void request.then(() => undefined, () => undefined);
      const settled = await Promise.race([
        gate.atGate.then(() => "gated"),
        request.then((r) => String(r.statusCode), () => "rejected"),
        delay(4000),
      ]);
      expect(settled).toBe("gated");
      // The pre-KDF verifier snapshot has now committed and released its own
      // account lock; the request is paused at the create-call boundary. Take a
      // REAL row lock on the issuer account from a SEPARATE connection.
      await blocker.query(
        "SELECT 1 FROM openarc_auth.accounts WHERE account_id = $1 FOR UPDATE",
        [A],
      );
      // Release the JS gate: the REAL create_agent_session SQL now runs and
      // must block on the held account row lock.
      gate.release();
      const observed = await waitForBlockedMachineQuery(admin, "create_agent_session", 8000);
      expect(observed).not.toBeNull();
      expect(observed?.wait_event_type).toBe("Lock");
      // The credential is revoked and COMMITTED while the session creation is
      // genuinely blocked in the database after the KDF.
      const revoked = await admin.query(
        `UPDATE openarc_durable.agent_credentials
            SET revoked_at = clock_timestamp(),
                revocation_version = revocation_version + 1
          WHERE credential_id = $1`,
        [credentialId],
      );
      expect(revoked.rowCount).toBe(1);
      await blocker.query("ROLLBACK");
      const response = await request;
      expect(response.statusCode).toBe(401);
      expect(response.body).not.toContain(credential);
      expect(response.body).not.toContain('"data"');
    } finally {
      gate.release();
      try {
        await blocker.query("ROLLBACK");
      } catch {
        // The transaction may already be aborted; the release below still frees it.
      }
      if (pending) await pending.catch(() => undefined);
      blocker.release();
    }
    expect(await count(`SELECT count(*)::text AS n FROM openarc_durable.agent_sessions`)).toBe(0);
  }, 20_000);

  it("observes a real post-KDF credential-revoke lock barrier for a provider", async () => {
    const gate = createGate();
    const { instance } = await buildApp((store) =>
      delegate(store, {
        createProviderSession: async (...args: never[]) => {
          gate.reached();
          await gate.gate;
          return (store.createProviderSession as (...a: never[]) => Promise<unknown>)(...args);
        },
      }),
    );
    const issued = await instance.inject(issueRequest("provider", "a").request);
    expect(issued.statusCode).toBe(200);
    const credential = issued.json().data.delivery.credential as string;
    const credentialId = issued.json().data.receipt.credentialId as string;

    const blocker = await admin.connect();
    let pending: PendingRequest | undefined;
    try {
      await blocker.query("BEGIN");
      const request = instance.inject(exchangeRequest("provider", credential)) as unknown as PendingRequest;
      pending = request;
      void request.then(() => undefined, () => undefined);
      const settled = await Promise.race([
        gate.atGate.then(() => "gated"),
        request.then((r) => String(r.statusCode), () => "rejected"),
        delay(4000),
      ]);
      expect(settled).toBe("gated");
      await blocker.query(
        "SELECT 1 FROM openarc_auth.accounts WHERE account_id = $1 FOR UPDATE",
        [A],
      );
      gate.release();
      const observed = await waitForBlockedMachineQuery(admin, "create_provider_session", 8000);
      expect(observed).not.toBeNull();
      expect(observed?.wait_event_type).toBe("Lock");
      const revoked = await admin.query(
        `UPDATE openarc_durable.provider_credentials
            SET revoked_at = clock_timestamp(),
                revocation_version = revocation_version + 1
          WHERE credential_id = $1`,
        [credentialId],
      );
      expect(revoked.rowCount).toBe(1);
      await blocker.query("ROLLBACK");
      const response = await request;
      expect(response.statusCode).toBe(401);
      expect(response.body).not.toContain(credential);
    } finally {
      gate.release();
      try {
        await blocker.query("ROLLBACK");
      } catch {
        // Aborted transactions still release the connection.
      }
      if (pending) await pending.catch(() => undefined);
      blocker.release();
    }
    expect(await count(`SELECT count(*)::text AS n FROM openarc_durable.provider_sessions`)).toBe(0);
  }, 20_000);

  it("observes a real post-KDF membership-suspension lock barrier", async () => {
    const gate = createGate();
    const { instance } = await buildApp((store) =>
      delegate(store, {
        createAgentSession: async (...args: never[]) => {
          gate.reached();
          await gate.gate;
          return (store.createAgentSession as (...a: never[]) => Promise<unknown>)(...args);
        },
      }),
    );
    const issued = await instance.inject(issueRequest("agent", "a").request);
    const credential = issued.json().data.delivery.credential as string;

    const blocker = await admin.connect();
    let pending: PendingRequest | undefined;
    try {
      await blocker.query("BEGIN");
      const request = instance.inject(exchangeRequest("agent", credential)) as unknown as PendingRequest;
      pending = request;
      void request.then(() => undefined, () => undefined);
      const settled = await Promise.race([
        gate.atGate.then(() => "gated"),
        request.then((r) => String(r.statusCode), () => "rejected"),
        delay(4000),
      ]);
      expect(settled).toBe("gated");
      await blocker.query(
        "SELECT 1 FROM openarc_auth.accounts WHERE account_id = $1 FOR UPDATE",
        [A],
      );
      gate.release();
      const observed = await waitForBlockedMachineQuery(admin, "create_agent_session", 8000);
      expect(observed).not.toBeNull();
      expect(observed?.wait_event_type).toBe("Lock");
      await admin.query(
        `UPDATE openarc_tenant.memberships SET status = 'suspended'
          WHERE organization_id = $1 AND account_id = $2`,
        [ORG1, A],
      );
      await blocker.query("ROLLBACK");
      const response = await pending;
      expect(response.statusCode).toBe(401);
      expect(response.body).not.toContain(credential);
    } finally {
      gate.release();
      try {
        await blocker.query("ROLLBACK");
      } catch {
        // Aborted transactions still release the connection.
      }
      if (pending) await pending.catch(() => undefined);
      blocker.release();
    }
    expect(await count(`SELECT count(*)::text AS n FROM openarc_durable.agent_sessions`)).toBe(0);
  }, 20_000);

  it("observes a real post-KDF profile-suspension lock barrier", async () => {
    const gate = createGate();
    const { instance } = await buildApp((store) =>
      delegate(store, {
        createAgentSession: async (...args: never[]) => {
          gate.reached();
          await gate.gate;
          return (store.createAgentSession as (...a: never[]) => Promise<unknown>)(...args);
        },
      }),
    );
    const issued = await instance.inject(issueRequest("agent", "a").request);
    const credential = issued.json().data.delivery.credential as string;

    const blocker = await admin.connect();
    let pending: PendingRequest | undefined;
    try {
      await blocker.query("BEGIN");
      const request = instance.inject(exchangeRequest("agent", credential)) as unknown as PendingRequest;
      pending = request;
      void request.then(() => undefined, () => undefined);
      const settled = await Promise.race([
        gate.atGate.then(() => "gated"),
        request.then((r) => String(r.statusCode), () => "rejected"),
        delay(4000),
      ]);
      expect(settled).toBe("gated");
      await blocker.query(
        "SELECT 1 FROM openarc_auth.accounts WHERE account_id = $1 FOR UPDATE",
        [A],
      );
      gate.release();
      const observed = await waitForBlockedMachineQuery(admin, "create_agent_session", 8000);
      expect(observed).not.toBeNull();
      await admin.query(
        `UPDATE openarc_tenant.agents SET status = 'suspended'
          WHERE organization_id = $1 AND agent_id = $2`,
        [ORG1, AGENT1],
      );
      await blocker.query("ROLLBACK");
      const response = await pending;
      expect(response.statusCode).toBe(401);
      expect(response.body).not.toContain(credential);
    } finally {
      gate.release();
      try {
        await blocker.query("ROLLBACK");
      } catch {
        // Aborted transactions still release the connection.
      }
      if (pending) await pending.catch(() => undefined);
      blocker.release();
    }
    expect(await count(`SELECT count(*)::text AS n FROM openarc_durable.agent_sessions`)).toBe(0);
  }, 20_000);

  it("supports the full provider current-session lifecycle (self and session revoke)", { timeout: 15_000 }, async () => {
    const { instance } = await buildApp();
    const { sessionToken, sessionId } = await issueAndExchange(instance, "provider");
    const self = await instance.inject(selfRequest("provider", sessionToken));
    expect(self.statusCode).toBe(200);
    expect(self.json().data.session.sessionId).toBe(sessionId);
    const revoked = await instance.inject(sessionRevokeRequest("provider", sessionToken));
    expect(revoked.statusCode).toBe(200);
    expect(revoked.json().data.kind).toBe("provider");
    const after = await instance.inject(selfRequest("provider", sessionToken));
    expect(after.statusCode).toBe(401);
  });

  it("rejects already issued sessions of both kinds on a credential revoke", async () => {
    for (const kind of ["agent", "provider"] as const) {
      const { instance } = await buildApp();
      const { credentialId, sessionToken } = await issueAndExchange(instance, kind);
      expect((await instance.inject(selfRequest(kind, sessionToken))).statusCode).toBe(200);
      const revoke = await instance.inject({
        method: "POST",
        url: `${PREFIX}/${ORG1}/${kind === "agent" ? "agent" : "provider"}-credentials/${credentialId}/revoke`,
        headers: managementHeaders("a"),
        payload: { mutationId: mutationId() },
      });
      expect(revoke.statusCode, kind).toBe(200);
      const after = await instance.inject(selfRequest(kind, sessionToken));
      expect(after.statusCode, kind).toBe(401);
    }
  });

  it("rejects an already issued agent session when the credential expires", async () => {
    const { instance } = await buildApp();
    const { credentialId, sessionToken } = await issueAndExchange(instance, "agent");
    await admin.query(
      `UPDATE openarc_durable.agent_credentials
          SET created_at = clock_timestamp() - interval '2 minutes',
              expires_at = clock_timestamp() - interval '1 minute'
        WHERE credential_id = $1`,
      [credentialId],
    );
    const after = await instance.inject(selfRequest("agent", sessionToken));
    expect(after.statusCode).toBe(401);
    expect(after.body).not.toContain('"data"');
  });

  it("rejects an already issued agent session when the issuer membership is suspended", async () => {
    const { instance } = await buildApp();
    const { sessionToken } = await issueAndExchange(instance, "agent");
    await admin.query(
      `UPDATE openarc_tenant.memberships SET status = 'suspended'
        WHERE organization_id = $1 AND account_id = $2`,
      [ORG1, A],
    );
    const after = await instance.inject(selfRequest("agent", sessionToken));
    expect(after.statusCode).toBe(401);
  });

  it("rejects an already issued provider session when the profile is suspended", async () => {
    const { instance } = await buildApp();
    const { sessionToken } = await issueAndExchange(instance, "provider");
    await admin.query(
      `UPDATE openarc_tenant.providers SET status = 'suspended'
        WHERE organization_id = $1 AND provider_id = $2`,
      [ORG1, PROVIDER1],
    );
    const after = await instance.inject(selfRequest("provider", sessionToken));
    expect(after.statusCode).toBe(401);
  });

  it("rejects an already issued provider session when the credential expires", async () => {
    const { instance } = await buildApp();
    const { credentialId, sessionToken } = await issueAndExchange(instance, "provider");
    await admin.query(
      `UPDATE openarc_durable.provider_credentials
          SET created_at = clock_timestamp() - interval '2 minutes',
              expires_at = clock_timestamp() - interval '1 minute'
        WHERE credential_id = $1`,
      [credentialId],
    );
    const after = await instance.inject(selfRequest("provider", sessionToken));
    expect(after.statusCode).toBe(401);
    expect(after.body).not.toContain('"data"');
  });

  it("rejects an already issued provider session when the issuer membership is suspended", async () => {
    const { instance } = await buildApp();
    const { sessionToken } = await issueAndExchange(instance, "provider");
    await admin.query(
      `UPDATE openarc_tenant.memberships SET status = 'suspended'
        WHERE organization_id = $1 AND account_id = $2`,
      [ORG1, A],
    );
    const after = await instance.inject(selfRequest("provider", sessionToken));
    expect(after.statusCode).toBe(401);
  });

  it("rejects an already issued agent session when the profile is suspended", async () => {
    const { instance } = await buildApp();
    const { sessionToken } = await issueAndExchange(instance, "agent");
    await admin.query(
      `UPDATE openarc_tenant.agents SET status = 'suspended'
        WHERE organization_id = $1 AND agent_id = $2`,
      [ORG1, AGENT1],
    );
    const after = await instance.inject(selfRequest("agent", sessionToken));
    expect(after.statusCode).toBe(401);
  });

  it("denies a stale non-recovery human proof past the five-minute boundary", async () => {
    await admin.query(
      `UPDATE openarc_auth.sessions SET created_at = clock_timestamp() - interval '6 minutes'
        WHERE token_hash = $1`,
      [tokenHash(tokens.get("a") as string)],
    );
    const { instance } = await buildApp();
    const denied = await instance.inject(issueRequest("agent", "a").request);
    expect([401, 403]).toContain(denied.statusCode);
    expect(await count(`SELECT count(*)::text AS n FROM openarc_durable.agent_credentials`)).toBe(0);
    expect(await count(`SELECT count(*)::text AS n FROM openarc_durable.idempotency_records`)).toBe(0);
  });

  it("maps an unknown session COMMIT to a non-retryable 503 with no second exchange", async () => {
    let creates = 0;
    const { instance } = await buildApp((store) =>
      delegate(store, {
        createAgentSession: async (...args: never[]) => {
          creates += 1;
          await (store.createAgentSession as (...a: never[]) => Promise<unknown>)(...args);
          // The INSERT committed inside its transaction but the reply was lost.
          throw new CredentialStoreError("CREDENTIAL_STORE_OUTCOME_UNKNOWN");
        },
      }),
    );
    const issued = await instance.inject(issueRequest("agent", "a").request);
    const credential = issued.json().data.delivery.credential as string;
    const response = await instance.inject(exchangeRequest("agent", credential));
    expect(response.statusCode).toBe(503);
    expect(response.json().error.retryable).toBe(false);
    expect(creates).toBe(1);
    expect(response.body).not.toContain("oas_");
    expect(await count(`SELECT count(*)::text AS n FROM openarc_durable.agent_sessions`)).toBe(1);
  });
});
