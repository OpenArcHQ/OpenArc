import { createHash, randomBytes, randomUUID } from "node:crypto";

import {
  asTenantPool,
  asMarketPool,
  AuthStore,
  createDatabasePool,
  MarketLifecycleStore,
  MarketStore,
  MarketStoreError,
  migrate,
  TenantStore,
} from "@openarc/db";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createApp } from "../src/app.js";
import { AuthService, type AuthServiceConfig } from "../src/auth/service.js";
import { deriveCsrfToken, issueBindingCookie } from "../src/auth/cookies.js";
import type { AuthProofPort, AuthRuntime } from "../src/auth/ports.js";
import type { AuthOriginConfig } from "../src/auth/proofs.js";
import { loadConfig } from "../src/config.js";
import type { MarketStorePort } from "../src/market/ports.js";
import { MarketLifecycleService } from "../src/market/lifecycle-service.js";
import { MarketService } from "../src/market/service.js";
import { TenantReadService } from "../src/tenant/service.js";
import {
  adminPool,
  appUrl,
  ensureRoles,
  migratorUrl,
  resetSchema,
  tenantUrl,
} from "../../../packages/db/test/postgres-fixture.js";

/**
 * Real-PostgreSQL protected market owner listing flows.
 *
 * The runtime repositories are the real AuthStore and MarketStore over the
 * disposable fixture roles; RLS, locks, idempotency, CAS, audit/outbox and SQL
 * authorization are real. The WebAuthn/SIWE proof adapter is HONESTLY MOCKED
 * (labelled): these tests prove orchestration and SQL enforcement, not crypto.
 */

type Pool = ReturnType<typeof adminPool>;

const ORIGIN = "http://localhost:5183";
const RP_ID = "localhost";
const SECRET = "synthetic_auth_secret_for_market_pg_0123456789";
const BUILD_SHA = "0123456789abcdef0123456789abcdef01234567";
const CLIENT = { origin: ORIGIN, "x-openarc-client": "browser-v1" };

function uuid(seed: number): string {
  return `00000000-0000-4000-8000-${String(seed).padStart(12, "0")}`;
}

function accountId(seed: number): string {
  return `openarc:account:${uuid(seed)}`;
}

const ORG1 = `openarc:org:${uuid(1)}`;
const ORG2 = `openarc:org:${uuid(2)}`;
const PROVIDER1 = `openarc:provider:${uuid(1)}`;
const PROVIDER2 = `openarc:provider:${uuid(2)}`;
const PROVIDER_RETIRED = `openarc:provider:${uuid(3)}`;
const A = accountId(101); // ORG1 owner
const B = accountId(102); // ORG1 operator
const C = accountId(103); // ORG1 viewer
const D = accountId(104); // ORG1 provider_admin
const E = accountId(105); // ORG1 provider_developer
const F = accountId(106); // ORG2 owner
const G = accountId(107); // ORG1 owner, stale proof
const R = accountId(108); // ORG1 owner, recovery

function b64(bytes: number): string {
  return randomBytes(bytes).toString("base64url");
}

function tokenHash(token: string): string {
  return createHash("sha256").update(`openarc:session:v1:${token}`, "utf8").digest("hex");
}

function idempotencyKey(): string {
  return randomBytes(32).toString("base64url");
}

function fakeProofs(): AuthProofPort {
  return {
    validateAuthOriginConfig: (input: unknown): AuthOriginConfig => input as AuthOriginConfig,
  } as unknown as AuthProofPort;
}

function fakeRuntime(): AuthRuntime {
  return { randomBytes: (size) => randomBytes(size), now: () => new Date() };
}

function content(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: "api",
    title: "Example API",
    description: "A bounded description",
    manifest: {
      schemaVersion: "openarc.listing-manifest.v1",
      inputSchemaDigest: `sha256:${"1".repeat(64)}`,
      outputSchemaDigest: `sha256:${"2".repeat(64)}`,
    },
    price: {
      amount: {
        schemaVersion: "openarc.usdc-amount.v1",
        networkId: "eip155:5042002",
        asset: "USDC",
        atomicAmount: "1000000",
        representation: "erc20",
        decimals: 6,
      },
      pricingModel: "fixed",
    },
    evidenceContract: {
      schemaVersion: "openarc.receipt-contract.v1",
      receiptType: "receipt.v1",
      receiptSchemaDigest: `sha256:${"3".repeat(64)}`,
      deliveryFields: ["payload", "status"],
    },
    endpointContract: { origin: "https://api.example.com", path: "/v1/run" },
    termsRevision: "terms-v1",
    privacySummary: "We store nothing.",
    paymentLane: "unavailable",
    availability: { status: "available", rateLimitPerMinute: "60" },
    ...overrides,
  };
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

async function seedAccount(account: string): Promise<void> {
  await admin.query(
    `INSERT INTO openarc_auth.accounts (account_id, user_handle, status)
     VALUES ($1, $2, 'active')`,
    [account, b64(32)],
  );
}

async function seedSession(
  token: string,
  account: string,
  options: { method?: "passkey" | "wallet" | "recovery"; ageSeconds?: number; expiresInSeconds?: number } = {},
): Promise<void> {
  await admin.query(
    `INSERT INTO openarc_auth.sessions (token_hash, account_id, method, created_at, expires_at)
     VALUES ($1, $2, $3, clock_timestamp() - ($4 || ' seconds')::interval,
             clock_timestamp() + ($5 || ' seconds')::interval)`,
    [
      tokenHash(token),
      account,
      options.method ?? "passkey",
      String(options.ageSeconds ?? 0),
      String(options.expiresInSeconds ?? 900),
    ],
  );
}

async function seedOrganization(organizationId: string, createdBy: string): Promise<void> {
  await admin.query(
    `INSERT INTO openarc_tenant.organizations (organization_id, display_name, created_by)
     VALUES ($1, 'Org', $2)`,
    [organizationId, createdBy],
  );
}

async function seedMembership(organizationId: string, account: string, role: string): Promise<void> {
  await admin.query(
    `INSERT INTO openarc_tenant.memberships (organization_id, account_id, role, status)
     VALUES ($1, $2, $3, 'active')`,
    [organizationId, account, role],
  );
}

async function seedProvider(organizationId: string, providerId: string, status: string): Promise<void> {
  await admin.query(
    `INSERT INTO openarc_tenant.providers (organization_id, provider_id, display_name, status)
     VALUES ($1, $2, $3, $4)`,
    [organizationId, providerId, `Provider ${providerId.slice(-4)}`, status],
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

  for (const account of [A, B, C, D, E, F, G, R]) {
    await seedAccount(account);
  }
  await seedOrganization(ORG1, A);
  await seedOrganization(ORG2, F);
  await seedMembership(ORG1, A, "owner");
  await seedMembership(ORG1, B, "operator");
  await seedMembership(ORG1, C, "viewer");
  await seedMembership(ORG1, D, "provider_admin");
  await seedMembership(ORG1, E, "provider_developer");
  await seedMembership(ORG1, G, "owner");
  await seedMembership(ORG1, R, "owner");
  await seedMembership(ORG2, F, "owner");
  await seedProvider(ORG1, PROVIDER1, "active");
  await seedProvider(ORG1, PROVIDER_RETIRED, "retired");
  await seedProvider(ORG2, PROVIDER2, "active");

  tokens.clear();
  const seeds: ReadonlyArray<readonly [string, string]> = [
    ["a", A],
    ["b", B],
    ["c", C],
    ["d", D],
    ["e", E],
    ["f", F],
  ];
  for (const [label, account] of seeds) {
    const token = b64(32);
    tokens.set(label, token);
    await seedSession(token, account);
  }

  // Stale passkey proof: reads work, writes fail the fresh-proof check.
  const stale = b64(32);
  tokens.set("g", stale);
  await seedSession(stale, G, { ageSeconds: 360 });

  // Recovery session: reads work, writes are denied.
  const recovery = b64(32);
  tokens.set("r", recovery);
  await seedSession(recovery, R, { method: "recovery" });
});

afterEach(async () => {
  await tenant.end();
  await app.end();
});

interface Built {
  instance: ReturnType<typeof createApp>;
  store: MarketStore;
}

function decorateStore(
  store: MarketStore,
  overrides: Partial<MarketStorePort>,
): MarketStorePort {
  return {
    createListingDraft: (hash, org, provider, body, metadata) =>
      (overrides.createListingDraft ?? ((h, o, p, b, m) => store.createListingDraft(h, o, p, b, m)))(
        hash,
        org,
        provider,
        body,
        metadata,
      ),
    createListingVersion: (hash, org, listing, input, metadata) =>
      (overrides.createListingVersion ??
        ((h, o, l, i, m) => store.createListingVersion(h, o, l, i, m)))(
        hash,
        org,
        listing,
        input,
        metadata,
      ),
    listOwnerListings: (hash, org, input) =>
      (overrides.listOwnerListings ?? ((h, o, i) => store.listOwnerListings(h, o, i)))(hash, org, input),
    listOwnerListingVersions: (hash, org, listing, input) =>
      (overrides.listOwnerListingVersions ??
        ((h, o, l, i) => store.listOwnerListingVersions(h, o, l, i)))(hash, org, listing, input),
    getOwnerListingVersion: (hash, org, listing, version) =>
      (overrides.getOwnerListingVersion ??
        ((h, o, l, v) => store.getOwnerListingVersion(h, o, l, v)))(hash, org, listing, version),
    getMarketMutationStatus: (hash, org, mutation) =>
      (overrides.getMarketMutationStatus ??
        ((h, o, m) => store.getMarketMutationStatus(h, o, m)))(hash, org, mutation),
  };
}

async function buildApp(
  decorate?: (store: MarketStore) => MarketStorePort,
): Promise<Built> {
  const store = new MarketStore(asMarketPool(tenant));
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
  const port = decorate ? decorate(store) : store;
  const marketService = new MarketService({ auth: authService, store: port });
  // The listing flag requires the real lifecycle dependency at startup. This
  // suite exercises the six draft routes; the lifecycle service/store are the
  // real reviewed implementations over the same restricted market pool.
  const lifecycleStore = new MarketLifecycleStore(asMarketPool(tenant));
  await lifecycleStore.initialize();
  const marketLifecycleService = new MarketLifecycleService({
    auth: authService,
    store: lifecycleStore,
  });
  const tenantStore = new TenantStore(asTenantPool(tenant));
  await tenantStore.initialize();
  const readService = new TenantReadService({ auth: authService, store: tenantStore });
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
    LISTING_MANAGEMENT_ENABLED: "true",
  });
  const instance = createApp({
    config,
    logger: false,
    authService,
    tenantReadService: readService,
    tenantReady: async () => true,
    marketService,
    marketLifecycleService,
    marketReady: async () => true,
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

function readHeadersFor(label: string): Record<string, string> {
  return { ...CLIENT, cookie: `openarc_session=${tokens.get(label) ?? ""}` };
}

const url = (organizationId: string, suffix = "") =>
  `/v2/provider/organizations/${organizationId}/listings${suffix}`;
const mutationUrl = (organizationId: string, mutationId: string) =>
  `/v2/provider/organizations/${organizationId}/listing-mutations/${mutationId}`;

function post(
  organizationId: string,
  label: string,
  body: Record<string, unknown>,
  extra: Record<string, string> = {},
) {
  return {
    method: "POST" as const,
    url: url(organizationId),
    headers: headersFor(label, extra),
    payload: body,
  };
}

async function createDraft(
  instance: ReturnType<typeof createApp>,
  label: string,
  organizationId: string,
  providerId: string,
  options: { mutationId?: string; key?: string; title?: string } = {},
) {
  const mutationId = options.mutationId ?? randomUUID();
  const response = await instance.inject(
    post(
      organizationId,
      label,
      { mutationId, providerId, content: content(options.title !== undefined ? { title: options.title } : {}) },
      options.key !== undefined ? { "idempotency-key": options.key } : {},
    ),
  );
  return { response, listingId: `openarc:listing:${mutationId}`, mutationId };
}

function postVersion(
  organizationId: string,
  listingId: string,
  label: string,
  body: Record<string, unknown>,
  extra: Record<string, string> = {},
) {
  return {
    method: "POST" as const,
    url: url(organizationId, `/${listingId}/versions`),
    headers: headersFor(label, extra),
    payload: body,
  };
}

describe("real-PG market role matrix and reads", () => {
  it("allows owner, provider_admin and provider_developer writes and denies operator/viewer", async () => {
    const { instance } = await buildApp();
    const owner = await createDraft(instance, "a", ORG1, PROVIDER1);
    expect(owner.response.statusCode).toBe(200);
    expect(owner.response.json().data.receipt.resourceId).toBe(owner.listingId);

    const operator = await createDraft(instance, "b", ORG1, PROVIDER1);
    expect(operator.response.statusCode).toBe(403);
    const viewer = await createDraft(instance, "c", ORG1, PROVIDER1);
    expect(viewer.response.statusCode).toBe(403);

    // REQUIRED CONTRACT: the write-role matrix admits provider_admin and
    // provider_developer, and the DB7 migrator-only UPDATE RLS policy lets the
    // definer resolve the same-org active provider for those roles. Both roles
    // must commit a draft.
    for (const label of ["d", "e"]) {
      const allowed = await createDraft(instance, label, ORG1, PROVIDER1);
      expect(allowed.response.statusCode, label).toBe(200);
      expect(allowed.response.json().data.receipt.operation, label).toBe(
        "market.listing.create",
      );
      expect(allowed.response.json().data.receipt.resourceId, label).toBe(
        allowed.listingId,
      );
    }

    expect(await count(`SELECT count(*)::text AS n FROM openarc_tenant.listings WHERE organization_id = $1`, [ORG1])).toBe(3);
  });

  it("lets provider_admin and provider_developer allocate versions", async () => {
    const { instance } = await buildApp();
    for (const label of ["d", "e"]) {
      const draft = await createDraft(instance, label, ORG1, PROVIDER1);
      expect(draft.response.statusCode, label).toBe(200);

      const version = await instance.inject(
        postVersion(
          ORG1,
          draft.listingId,
          label,
          {
            mutationId: randomUUID(),
            expectedLatestVersion: "1",
            content: content({ title: `Example API ${label}` }),
          },
          { "idempotency-key": idempotencyKey() },
        ),
      );
      expect(version.statusCode, label).toBe(200);
      expect(version.json().data.receipt.operation, label).toBe(
        "market.listing.version.create",
      );
      expect(version.json().data.receipt.resourceId, label).toBe(
        `${draft.listingId}@2`,
      );
      expect(version.json().data.replayed, label).toBe(false);
    }
  });

  it("lets all five active roles read listings, history and explicit detail", async () => {
    const { instance } = await buildApp();
    const draft = await createDraft(instance, "a", ORG1, PROVIDER1);
    expect(draft.response.statusCode).toBe(200);

    for (const label of ["a", "b", "c", "d", "e"]) {
      const listings = await instance.inject({ method: "GET", url: url(ORG1), headers: readHeadersFor(label) });
      expect(listings.statusCode, label).toBe(200);
      expect(listings.json().data.organizationId).toBe(ORG1);

      const versions = await instance.inject({
        method: "GET",
        url: url(ORG1, `/${draft.listingId}/versions`),
        headers: readHeadersFor(label),
      });
      expect(versions.statusCode, label).toBe(200);
      expect(versions.json().data.providerId).toBe(PROVIDER1);

      const detail = await instance.inject({
        method: "GET",
        url: url(ORG1, `/${draft.listingId}/versions/1`),
        headers: readHeadersFor(label),
      });
      expect(detail.statusCode, label).toBe(200);
      expect(detail.json().data.item.status).toBe("draft");
    }
  });

  it("denies cross-org, cross-provider and inactive-provider writes", async () => {
    const { instance } = await buildApp();
    const retired = await createDraft(instance, "a", ORG1, PROVIDER_RETIRED);
    expect(retired.response.statusCode).toBe(403);
    const foreignProvider = await createDraft(instance, "a", ORG1, PROVIDER2);
    expect(foreignProvider.response.statusCode).toBe(403);
    const foreignActor = await createDraft(instance, "f", ORG1, PROVIDER1);
    expect(foreignActor.response.statusCode).toBe(403);
    const crossOrg = await createDraft(instance, "a", ORG2, PROVIDER2);
    expect(crossOrg.response.statusCode).toBe(403);
    expect(await count(`SELECT count(*)::text AS n FROM openarc_tenant.listings`)).toBe(0);
  });

  it("denies stale-proof and recovery writes while allowing their reads", async () => {
    const { instance } = await buildApp();
    const draft = await createDraft(instance, "a", ORG1, PROVIDER1);
    expect(draft.response.statusCode).toBe(200);

    for (const label of ["g", "r"]) {
      const read = await instance.inject({ method: "GET", url: url(ORG1), headers: readHeadersFor(label) });
      expect(read.statusCode, label).toBe(200);
      const write = await createDraft(instance, label, ORG1, PROVIDER1);
      expect(write.response.statusCode, label).toBe(401);
    }
    expect(await count(`SELECT count(*)::text AS n FROM openarc_tenant.listings`)).toBe(1);
  });

  it("keeps a truthful provider id on an empty page is covered by service tests", async () => {
    // Explicit detail miss stays a truthful {item:null} 200.
    const { instance } = await buildApp();
    const draft = await createDraft(instance, "a", ORG1, PROVIDER1);
    const detail = await instance.inject({
      method: "GET",
      url: url(ORG1, `/${draft.listingId}/versions/7`),
      headers: readHeadersFor("a"),
    });
    expect(detail.statusCode).toBe(200);
    expect(detail.json().data.item).toBeNull();
  });
});

describe("real-PG market version lifecycle", () => {
  it("allocates versions immutably with replay and exact CAS conflict", async () => {
    const { instance } = await buildApp();
    const draft = await createDraft(instance, "a", ORG1, PROVIDER1);
    const listingId = draft.listingId as string;

    const key = idempotencyKey();
    const versionMutation = randomUUID();
    const versionBody = {
      mutationId: versionMutation,
      expectedLatestVersion: "1",
      content: content({ title: "Example API v2" }),
    };
    const first = await instance.inject(
      postVersion(ORG1, listingId, "a", versionBody, { "idempotency-key": key }),
    );
    expect(first.statusCode).toBe(200);
    expect(first.json().data.receipt.operation).toBe("market.listing.version.create");
    expect(first.json().data.receipt.resourceId).toBe(`${listingId}@2`);
    expect(first.json().data.replayed).toBe(false);

    const replay = await instance.inject(
      postVersion(ORG1, listingId, "a", versionBody, { "idempotency-key": key }),
    );
    expect(replay.statusCode).toBe(200);
    expect(replay.json().data.replayed).toBe(true);
    expect(replay.json().data.receipt.resourceId).toBe(`${listingId}@2`);

    const staleCas = await instance.inject(
      postVersion(ORG1, listingId, "a", {
        mutationId: randomUUID(),
        expectedLatestVersion: "1",
        content: content({ title: "Stale" }),
      }),
    );
    expect(staleCas.statusCode).toBe(409);
    expect(staleCas.json().error.code).toBe("POLICY_DENIED");

    const next = await instance.inject(
      postVersion(ORG1, listingId, "a", {
        mutationId: randomUUID(),
        expectedLatestVersion: "2",
        content: content({ title: "Example API v3" }),
      }),
    );
    expect(next.statusCode).toBe(200);
    expect(next.json().data.receipt.resourceId).toBe(`${listingId}@3`);

    expect(await count(`SELECT count(*)::text AS n FROM openarc_tenant.listing_versions WHERE listing_id = $1`, [listingId])).toBe(3);
  });

  it("keeps status isolated between actors and organizations", async () => {
    const { instance } = await buildApp();
    const draft = await createDraft(instance, "a", ORG1, PROVIDER1);
    const mutationId = draft.mutationId as string;

    const owner = await instance.inject({
      method: "GET",
      url: mutationUrl(ORG1, mutationId),
      headers: readHeadersFor("a"),
    });
    expect(owner.statusCode).toBe(200);
    expect(owner.json().data.status).toBe("committed");
    expect(owner.json().data.receipt.resourceId).toBe(draft.listingId);

    const otherActor = await instance.inject({
      method: "GET",
      url: mutationUrl(ORG1, mutationId),
      headers: readHeadersFor("b"),
    });
    expect(otherActor.statusCode).toBe(200);
    expect(otherActor.json().data.status).toBe("not_found");
    expect(JSON.stringify(otherActor.json().data)).not.toContain("receipt");

    const crossOrg = await instance.inject({
      method: "GET",
      url: mutationUrl(ORG2, mutationId),
      headers: readHeadersFor("a"),
    });
    expect(crossOrg.statusCode).toBe(403);
    expect(crossOrg.body).not.toContain(mutationId);
  });
});

describe("real-PG market read barrier and unknown outcome", () => {
  it("blocks delivery when the session is revoked after the repository read", async () => {
    const token = tokens.get("a") as string;
    const { instance } = await buildApp((store) =>
      decorateStore(store, {
        listOwnerListings: async (hash, org, input) => {
          const result = await store.listOwnerListings(hash, org, input);
          await admin.query("DELETE FROM openarc_auth.sessions WHERE token_hash = $1", [tokenHash(token)]);
          return result;
        },
        getMarketMutationStatus: async (hash, org, mutation) => {
          const result = await store.getMarketMutationStatus(hash, org, mutation);
          await admin.query("DELETE FROM openarc_auth.sessions WHERE token_hash = $1", [tokenHash(token)]);
          return result;
        },
      }),
    );
    const draft = await createDraft(instance, "a", ORG1, PROVIDER1);
    expect(draft.response.statusCode).toBe(200);

    const listings = await instance.inject({ method: "GET", url: url(ORG1), headers: readHeadersFor("a") });
    expect(listings.statusCode).toBe(401);
    expect(listings.body).not.toContain('"data"');
    expect(listings.body).not.toContain(ORG1);
    expect(listings.headers["set-cookie"]).toBeUndefined();

    // Re-seed the session and observe the status barrier too.
    await seedSession(token, A);
    const status = await instance.inject({
      method: "GET",
      url: mutationUrl(ORG1, draft.mutationId as string),
      headers: readHeadersFor("a"),
    });
    expect(status.statusCode).toBe(401);
    expect(status.body).not.toContain(draft.listingId as string);
  });

  it("recovers a lost-reply commit via status with one committed row and no extra POST", async () => {
    const key = idempotencyKey();
    const mutationId = randomUUID();
    let commits = 0;
    const { instance } = await buildApp((store) =>
      decorateStore(store, {
        createListingDraft: async (hash, org, provider, body, metadata) => {
          commits += 1;
          await store.createListingDraft(hash, org, provider, body, metadata);
          // HONEST transport fault: the commit succeeded, the reply was lost.
          throw new MarketStoreError("MARKET_STORE_OUTCOME_UNKNOWN");
        },
      }),
    );

    const lost = await instance.inject(
      post(
        ORG1,
        "a",
        { mutationId, providerId: PROVIDER1, content: content() },
        { "idempotency-key": key },
      ),
    );
    expect(lost.statusCode).toBe(503);
    expect(lost.json().error.retryable).toBe(false);
    expect(commits).toBe(1);

    expect(await count(`SELECT count(*)::text AS n FROM openarc_tenant.listings WHERE listing_id = $1`, [`openarc:listing:${mutationId}`])).toBe(1);

    const status = await instance.inject({
      method: "GET",
      url: mutationUrl(ORG1, mutationId),
      headers: readHeadersFor("a"),
    });
    expect(status.statusCode).toBe(200);
    expect(status.json().data.status).toBe("committed");
    expect(status.json().data.receipt.operation).toBe("market.listing.create");
    expect(status.json().data.receipt.resourceId).toBe(`openarc:listing:${mutationId}`);

    // Recovery is read-only: exactly one commit attempt and one listing row.
    expect(commits).toBe(1);
    expect(await count(`SELECT count(*)::text AS n FROM openarc_tenant.listings`)).toBe(1);
  });

  it("never echoes the idempotency key or a content canary", async () => {
    const logs: unknown[] = [];
    const store = new MarketStore(asMarketPool(tenant));
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
    const marketService = new MarketService({ auth: authService, store });
    const lifecycleStore = new MarketLifecycleStore(asMarketPool(tenant));
    await lifecycleStore.initialize();
    const marketLifecycleService = new MarketLifecycleService({
      auth: authService,
      store: lifecycleStore,
    });
    const tenantStore = new TenantStore(asTenantPool(tenant));
    await tenantStore.initialize();
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
      LISTING_MANAGEMENT_ENABLED: "true",
    });
    const instance = createApp({
      config,
      logger: false,
      logSink: (entry) => logs.push(entry),
      authService,
      tenantReadService: new TenantReadService({ auth: authService, store: tenantStore }),
      tenantReady: async () => true,
      marketService,
      marketLifecycleService,
      marketReady: async () => true,
    });
    const canary = "PRIVATE_CONTENT_CANARY";
    const key = idempotencyKey();
    const response = await instance.inject(
      post(
        ORG1,
        "a",
        { mutationId: randomUUID(), providerId: PROVIDER1, content: content({ title: canary }) },
        { "idempotency-key": key },
      ),
    );
    expect(response.statusCode).toBe(200);
    expect(response.body).not.toContain(canary);
    expect(response.body).not.toContain(key);
    for (const entry of logs) {
      const serialized = JSON.stringify(entry);
      expect(serialized).not.toContain(canary);
      expect(serialized).not.toContain(key);
    }
    await instance.close();
  });
});
