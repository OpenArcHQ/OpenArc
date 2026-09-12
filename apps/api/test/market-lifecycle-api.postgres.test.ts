import { createHash, randomBytes, randomUUID } from "node:crypto";

import {
  asMarketPool,
  asTenantPool,
  AuthStore,
  createDatabasePool,
  MarketCatalogStore,
  MarketLifecycleStore,
  MarketStore,
  migrate,
  reviewedEndpointDigest,
  TenantStore,
} from "@openarc/db";
import {
  CommerceMarketPublicDetailResponseSchema,
  CommerceMarketPublicPageResponseSchema,
  CommerceMarketPublicProviderDetailResponseSchema,
  MarketplaceCapabilitiesSuccessEnvelopeSchema,
} from "@openarc/shared";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createApp } from "../src/app.js";
import { deriveCsrfToken, issueBindingCookie } from "../src/auth/cookies.js";
import type { AuthProofPort, AuthRuntime } from "../src/auth/ports.js";
import type { AuthOriginConfig } from "../src/auth/proofs.js";
import { AuthService, type AuthServiceConfig } from "../src/auth/service.js";
import { loadConfig } from "../src/config.js";
import { MarketCatalogService } from "../src/market/catalog-service.js";
import { MarketLifecycleService } from "../src/market/lifecycle-service.js";
import { startMarketRuntime } from "../src/market/runtime.js";
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
 * Real API + PostgreSQL integration for the protected marketplace lifecycle,
 * moderation and the public catalog.
 *
 * The runtime repositories, RLS, SECURITY DEFINER helpers, authority checks,
 * CAS tokens, idempotency records, audit/outbox events and lifecycle state are
 * the REAL accepted implementations over the disposable fixture roles. The
 * WebAuthn/SIWE proof adapter is HONESTLY MOCKED (labelled): these tests prove
 * HTTP-to-SQL orchestration and enforcement, not cryptography. `app.inject` is
 * HTTP/PostgreSQL integration, NOT actual TLS or production browser evidence.
 *
 * Only privileged fixture setup provisions the ONE independent moderator grant;
 * no test provisions authority through a runtime route.
 */

type Pool = ReturnType<typeof adminPool>;
type AppInstance = ReturnType<typeof createApp>;

const ORIGIN = "http://localhost:5183";
const RP_ID = "localhost";
const SECRET = "synthetic_auth_secret_for_market_lifecycle_pg_0123456789";
const BUILD_SHA = "0123456789abcdef0123456789abcdef01234567";
const CLIENT = { origin: ORIGIN, "x-openarc-client": "browser-v1" };
const SESSION_COOKIE = "openarc_session";
const BINDING_COOKIE = "openarc_binding";
const ENDPOINT_ORIGIN = "https://api.example.com";
const ENDPOINT_PATH = "/v1/run";

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
const A = accountId(201); // ORG1 owner
const B = accountId(202); // ORG1 operator
const F = accountId(203); // ORG2 owner
const M = accountId(204); // independent moderator, NO membership, active grant
const N = accountId(205); // non-member, NO grant
const V = accountId(206); // non-member, REVOKED grant

function b64(bytes: number): string {
  return randomBytes(bytes).toString("base64url");
}

function tokenHash(token: string): string {
  return createHash("sha256").update(`openarc:session:v1:${token}`, "utf8").digest("hex");
}

function idempotencyKey(): string {
  return randomBytes(32).toString("base64url");
}

function endpointDigest(listingId: string, version: string): string {
  return reviewedEndpointDigest({
    listingId,
    version,
    origin: ENDPOINT_ORIGIN,
    path: ENDPOINT_PATH,
  });
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
    endpointContract: { origin: ENDPOINT_ORIGIN, path: ENDPOINT_PATH },
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
  options: { method?: "passkey" | "wallet" | "recovery"; ageSeconds?: number } = {},
): Promise<void> {
  await admin.query(
    `INSERT INTO openarc_auth.sessions (token_hash, account_id, method, created_at, expires_at)
     VALUES ($1, $2, $3, clock_timestamp() - ($4 || ' seconds')::interval,
             clock_timestamp() + interval '900 seconds')`,
    [tokenHash(token), account, options.method ?? "passkey", String(options.ageSeconds ?? 0)],
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

/** Privileged fixture-only moderator grant; never provisioned through a route. */
async function seedModeratorGrant(account: string, status: "active" | "revoked"): Promise<void> {
  await admin.query(
    `INSERT INTO openarc_tenant.market_moderator_grants (account_id, status)
     VALUES ($1, $2)`,
    [account, status],
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

  for (const account of [A, B, F, M, N, V]) {
    await seedAccount(account);
  }
  await seedOrganization(ORG1, A);
  await seedOrganization(ORG2, F);
  await seedMembership(ORG1, A, "owner");
  await seedMembership(ORG1, B, "operator");
  await seedMembership(ORG2, F, "owner");
  await seedProvider(ORG1, PROVIDER1, "active");
  await seedProvider(ORG1, PROVIDER_RETIRED, "retired");
  await seedProvider(ORG2, PROVIDER2, "active");

  // ONE independent moderator grant; migrations seed zero grants.
  await seedModeratorGrant(M, "active");
  await seedModeratorGrant(V, "revoked");
  // A is an ORG1 member AND explicitly granted: moderation must still deny.
  await seedModeratorGrant(A, "active");

  tokens.clear();
  for (const [label, account] of [
    ["a", A],
    ["b", B],
    ["f", F],
    ["m", M],
    ["n", N],
    ["v", V],
  ] as ReadonlyArray<readonly [string, string]>) {
    const token = b64(32);
    tokens.set(label, token);
    await seedSession(token, account);
  }
});

afterEach(async () => {
  await tenant.end();
  await app.end();
});

function authService(): AuthService {
  return new AuthService({
    config: {
      authSecret: SECRET,
      appOrigin: ORIGIN,
      rpId: RP_ID,
      environment: "development",
      secureCookies: false,
      cookieNames: { session: SESSION_COOKIE, binding: BINDING_COOKIE },
    } satisfies AuthServiceConfig,
    store: new AuthStore(app),
    proofs: fakeProofs(),
    runtime: fakeRuntime(),
  });
}

interface AppFlags {
  readonly auth?: boolean;
  readonly tenantReads?: boolean;
  readonly listing?: boolean;
  readonly moderation?: boolean;
  readonly catalog?: boolean;
}

/** Wire the REAL stores/services over the shared restricted fixture pools. */
async function buildApp(flags: AppFlags = {}): Promise<AppInstance> {
  const authEnabled = flags.auth ?? true;
  const tenantReads = flags.tenantReads ?? true;
  const listing = flags.listing ?? true;
  const moderation = flags.moderation ?? true;
  const catalog = flags.catalog ?? true;

  const service = authEnabled ? authService() : undefined;

  let marketService: MarketService | undefined;
  if (listing) {
    const store = new MarketStore(asMarketPool(tenant));
    await store.initialize();
    marketService = new MarketService({ auth: service!, store });
  }

  let lifecycleService: MarketLifecycleService | undefined;
  if (listing || moderation) {
    const store = new MarketLifecycleStore(asMarketPool(tenant));
    await store.initialize();
    lifecycleService = new MarketLifecycleService({ auth: service!, store });
  }

  let catalogService: MarketCatalogService | undefined;
  if (catalog) {
    const store = new MarketCatalogStore(asMarketPool(tenant));
    await store.initialize();
    catalogService = new MarketCatalogService({ store });
  }

  let readService: TenantReadService | undefined;
  if (tenantReads) {
    const store = new TenantStore(asTenantPool(tenant));
    await store.initialize();
    readService = new TenantReadService({ auth: service!, store });
  }

  const config = loadConfig({
    NODE_ENV: "test",
    APP_ORIGIN: ORIGIN,
    COMMIT_SHA: BUILD_SHA,
    AUTH_ENABLED: String(authEnabled),
    AUTH_DATABASE_URL: appUrl(),
    AUTH_SECRET: SECRET,
    AUTH_RP_ID: RP_ID,
    TENANT_READS_ENABLED: String(tenantReads),
    TENANT_WRITES_ENABLED: "false",
    TENANT_DATABASE_URL: tenantUrl(),
    LISTING_MANAGEMENT_ENABLED: String(listing),
    MARKET_MODERATION_ENABLED: String(moderation),
    MARKET_CATALOG_ENABLED: String(catalog),
  });

  return createApp({
    config,
    logger: false,
    ...(service !== undefined ? { authService: service } : {}),
    ...(authEnabled ? { authReady: async () => true } : {}),
    ...(readService !== undefined ? { tenantReadService: readService } : {}),
    ...(tenantReads ? { tenantReady: async () => true } : {}),
    ...(marketService !== undefined ? { marketService } : {}),
    ...(lifecycleService !== undefined ? { marketLifecycleService: lifecycleService } : {}),
    ...(catalogService !== undefined ? { marketCatalogService: catalogService } : {}),
    ...(listing || moderation || catalog ? { marketReady: async () => true } : {}),
  });
}

function headersFor(label: string, extra: Record<string, string> = {}): Record<string, string> {
  const token = tokens.get(label) ?? "";
  const binding = issueBindingCookie(SECRET, b64(16), Date.now());
  return {
    ...CLIENT,
    "content-type": "application/json",
    cookie: `${SESSION_COOKIE}=${token}; ${BINDING_COOKIE}=${binding}`,
    "x-openarc-csrf": deriveCsrfToken(SECRET, binding, tokenHash(token)),
    "idempotency-key": idempotencyKey(),
    ...extra,
  };
}

function readHeadersFor(label: string): Record<string, string> {
  return { ...CLIENT, cookie: `${SESSION_COOKIE}=${tokens.get(label) ?? ""}` };
}

const providerUrl = (organizationId: string, suffix = "") =>
  `/v2/provider/organizations/${organizationId}${suffix}`;
const moderatorUrl = (organizationId: string, suffix = "") =>
  `/v2/moderator/organizations/${organizationId}${suffix}`;
const publicUrl = (suffix = "") => `/v2/public/market${suffix}`;

type InjectResponse = Awaited<ReturnType<AppInstance["inject"]>>;

interface DraftResult {
  readonly response: InjectResponse;
  readonly listingId: string;
  readonly mutationId: string;
}

async function createDraft(
  instance: AppInstance,
  label: string,
  organizationId = ORG1,
  providerId = PROVIDER1,
): Promise<DraftResult> {
  const mutationId = randomUUID();
  const response = await instance.inject({
    method: "POST",
    url: providerUrl(organizationId, "/listings"),
    headers: headersFor(label),
    payload: { mutationId, providerId, content: content() },
  });
  return { response, listingId: `openarc:listing:${mutationId}`, mutationId };
}

async function createVersion(
  instance: AppInstance,
  label: string,
  listingId: string,
  expectedLatestVersion: string,
  title = "Example API v2",
  organizationId = ORG1,
) {
  const mutationId = randomUUID();
  const response = await instance.inject({
    method: "POST",
    url: providerUrl(organizationId, `/listings/${listingId}/versions`),
    headers: headersFor(label),
    payload: { mutationId, expectedLatestVersion, content: content({ title }) },
  });
  return { response, mutationId };
}

async function readOwnerVersion(
  instance: AppInstance,
  label: string,
  listingId: string,
  version: string,
  organizationId = ORG1,
) {
  return instance.inject({
    method: "GET",
    url: providerUrl(organizationId, `/listings/${listingId}/versions/${version}`),
    headers: readHeadersFor(label),
  });
}

async function readModeratorVersion(
  instance: AppInstance,
  label: string,
  listingId: string,
  version: string,
  organizationId = ORG1,
) {
  return instance.inject({
    method: "GET",
    url: moderatorUrl(organizationId, `/listings/${listingId}/versions/${version}`),
    headers: readHeadersFor(label),
  });
}

async function recordOriginReview(
  instance: AppInstance,
  label: string,
  listingId: string,
  version: string,
  expectedUpdatedAt: string,
  decision: "approved" | "rejected",
  overrides: Record<string, unknown> = {},
) {
  const mutationId = randomUUID();
  const response = await instance.inject({
    method: "POST",
    url: moderatorUrl(ORG1, `/listings/${listingId}/versions/${version}/origin-review`),
    headers: headersFor(label),
    payload: {
      mutationId,
      expectedUpdatedAt,
      decision,
      reviewedEndpointDigest: endpointDigest(listingId, version),
      reasonCode: "manual_review",
      reasonDigest: null,
      ...overrides,
    },
  });
  return { response, mutationId };
}

async function transition(
  instance: AppInstance,
  label: string,
  listingId: string,
  version: string,
  operation: "publish" | "pause" | "retire",
  body: Record<string, unknown>,
  extra: Record<string, string> = {},
) {
  return instance.inject({
    method: "POST",
    url: providerUrl(ORG1, `/listings/${listingId}/versions/${version}/${operation}`),
    headers: headersFor(label, extra),
    payload: body,
  });
}

interface PublishedSetup {
  readonly listingId: string;
  /** Post-publish state token. */
  readonly updatedAt: string;
  readonly publishMutationId: string;
  readonly publishBody: Readonly<Record<string, unknown>>;
  readonly publishKey: string;
}

/** Owner draft -> immutable v2 -> moderator approval -> exact-CAS v2 publish. */
async function setupPublishedV2(
  instance: AppInstance,
  publishKey: string = idempotencyKey(),
): Promise<PublishedSetup> {
  const draft = await createDraft(instance, "a");
  expect(draft.response.statusCode).toBe(200);
  const listingId = draft.listingId;
  const version = await createVersion(instance, "a", listingId, "1");
  expect(version.response.statusCode).toBe(200);

  const modRead = await readModeratorVersion(instance, "m", listingId, "2");
  expect(modRead.statusCode).toBe(200);
  const review = await recordOriginReview(
    instance,
    "m",
    listingId,
    "2",
    modRead.json().data.item.updatedAt,
    "approved",
  );
  expect(review.response.statusCode).toBe(200);

  const afterReview = await readOwnerVersion(instance, "a", listingId, "2");
  expect(afterReview.statusCode).toBe(200);
  const publishMutationId = randomUUID();
  const publishBody = {
    mutationId: publishMutationId,
    expectedUpdatedAt: afterReview.json().data.item.updatedAt,
    expectedActiveVersion: null,
  };
  const publish = await transition(
    instance,
    "a",
    listingId,
    "2",
    "publish",
    publishBody,
    { "idempotency-key": publishKey },
  );
  expect(publish.statusCode).toBe(200);

  const afterPublish = await readOwnerVersion(instance, "a", listingId, "2");
  return {
    listingId,
    updatedAt: afterPublish.json().data.item.updatedAt,
    publishMutationId,
    publishBody,
    publishKey,
  };
}

async function assertNoDurableRecord(mutationId: string): Promise<void> {
  expect(
    await count(
      `SELECT count(*)::text AS n FROM openarc_durable.idempotency_records
        WHERE organization_id = $1 AND mutation_id = $2`,
      [ORG1, mutationId],
    ),
  ).toBe(0);
  expect(
    await count(
      `SELECT count(*)::text AS n FROM openarc_durable.outbox_events
        WHERE organization_id = $1 AND mutation_id = $2`,
      [ORG1, mutationId],
    ),
  ).toBe(0);
  expect(
    await count(
      `SELECT count(*)::text AS n FROM openarc_durable.audit_events
        WHERE organization_id = $1 AND mutation_id = $2`,
      [ORG1, mutationId],
    ),
  ).toBe(0);
}

function errorCode(response: InjectResponse): string {
  return response.json().error.code as string;
}

describe("real-PG marketplace lifecycle end-to-end", () => {
  it("publishes an approved immutable v2 and exposes only eligible active v2 publicly", async () => {
    const instance = await buildApp();

    const draft = await createDraft(instance, "a");
    expect(draft.response.statusCode).toBe(200);
    expect(draft.response.json().data.receipt.operation).toBe("market.listing.create");
    expect(draft.response.json().data.receipt.resourceId).toBe(draft.listingId);
    const listingId = draft.listingId;

    const roots = await instance.inject({
      method: "GET",
      url: providerUrl(ORG1, "/listings"),
      headers: readHeadersFor("a"),
    });
    expect(roots.statusCode).toBe(200);
    expect(
      roots.json().data.items.map((item: { listingId: string }) => item.listingId),
    ).toContain(listingId);

    const picker = await instance.inject({
      method: "GET",
      url: providerUrl(ORG1, "/listing-providers?limit=50"),
      headers: readHeadersFor("a"),
    });
    expect(picker.statusCode).toBe(200);
    expect(
      picker.json().data.items.map((item: { providerId: string }) => item.providerId),
    ).toContain(PROVIDER1);

    const rootDetail = await instance.inject({
      method: "GET",
      url: providerUrl(ORG1, `/listings/${listingId}`),
      headers: readHeadersFor("a"),
    });
    expect(rootDetail.statusCode).toBe(200);
    expect(rootDetail.json().data.item.activeVersion).toBeNull();

    const v2 = await createVersion(instance, "a", listingId, "1");
    expect(v2.response.statusCode).toBe(200);
    expect(v2.response.json().data.receipt.resourceId).toBe(`${listingId}@2`);

    const history = await instance.inject({
      method: "GET",
      url: providerUrl(ORG1, `/listings/${listingId}/versions`),
      headers: readHeadersFor("a"),
    });
    expect(history.statusCode).toBe(200);
    expect(
      history.json().data.items.map((item: { version: string }) => item.version),
    ).toEqual(["1", "2"]);

    const v2Detail = await readOwnerVersion(instance, "a", listingId, "2");
    expect(v2Detail.statusCode).toBe(200);
    expect(v2Detail.json().data.item.status).toBe("draft");
    expect(v2Detail.json().data.item.version).toBe("2");

    const draftStatus = await instance.inject({
      method: "GET",
      url: providerUrl(ORG1, `/listing-mutations/${draft.mutationId}`),
      headers: readHeadersFor("a"),
    });
    expect(draftStatus.statusCode).toBe(200);
    expect(draftStatus.json().data.status).toBe("committed");
    expect(draftStatus.json().data.receipt.operation).toBe("market.listing.create");
    expect(draftStatus.json().data.receipt.resourceId).toBe(listingId);

    const modRead = await readModeratorVersion(instance, "m", listingId, "2");
    expect(modRead.statusCode).toBe(200);
    expect(modRead.json().data.item.title).toBe("Example API v2");
    expect(modRead.json().data.item.version).toBe("2");

    const review = await recordOriginReview(
      instance,
      "m",
      listingId,
      "2",
      modRead.json().data.item.updatedAt,
      "approved",
    );
    expect(review.response.statusCode).toBe(200);
    expect(review.response.json().data.receipt.operation).toBe(
      "market.listing.origin_review.record",
    );
    expect(review.response.json().data.receipt.resourceId).toBe(`${listingId}@2`);

    const modStatus = await instance.inject({
      method: "GET",
      url: moderatorUrl(ORG1, `/listing-lifecycle-mutations/${review.mutationId}`),
      headers: readHeadersFor("m"),
    });
    expect(modStatus.statusCode).toBe(200);
    expect(modStatus.json().data.status).toBe("committed");
    expect(modStatus.json().data.receipt.operation).toBe(
      "market.listing.origin_review.record",
    );

    const afterReview = await readOwnerVersion(instance, "a", listingId, "2");
    const publishMutationId = randomUUID();
    const publish = await transition(instance, "a", listingId, "2", "publish", {
      mutationId: publishMutationId,
      expectedUpdatedAt: afterReview.json().data.item.updatedAt,
      expectedActiveVersion: null,
    });
    expect(publish.statusCode).toBe(200);
    expect(publish.json().data.receipt.operation).toBe("market.listing.version.publish");
    expect(publish.json().data.receipt.resourceId).toBe(`${listingId}@2`);
    expect(publish.json().data.replayed).toBe(false);

    const lifecycleStatus = await instance.inject({
      method: "GET",
      url: providerUrl(ORG1, `/listing-lifecycle-mutations/${publishMutationId}`),
      headers: readHeadersFor("a"),
    });
    expect(lifecycleStatus.statusCode).toBe(200);
    expect(lifecycleStatus.json().data.status).toBe("committed");
    expect(lifecycleStatus.json().data.receipt.operation).toBe(
      "market.listing.version.publish",
    );
    expect(lifecycleStatus.json().data.receipt.resourceId).toBe(`${listingId}@2`);

    const publicList = await instance.inject({ method: "GET", url: publicUrl("/listings") });
    expect(publicList.statusCode).toBe(200);
    CommerceMarketPublicPageResponseSchema.parse(publicList.json());
    expect(publicList.json().data.items).toHaveLength(1);
    expect(publicList.json().data.items[0].listingId).toBe(listingId);
    expect(publicList.json().data.items[0].version).toBe("2");
    expect(publicList.json().data.items[0].status).toBe("active");
    expect(publicList.json().data.items[0].price.amount.atomicAmount).toBe("1000000");

    const publicDetail = await instance.inject({
      method: "GET",
      url: publicUrl(`/listings/${listingId}`),
    });
    expect(publicDetail.statusCode).toBe(200);
    CommerceMarketPublicDetailResponseSchema.parse(publicDetail.json());
    expect(publicDetail.json().data.item.version).toBe("2");
    expect(publicDetail.body).not.toContain(ORG1);
    expect(publicDetail.body).not.toContain(A);
    expect(publicDetail.body).not.toContain(ENDPOINT_PATH);
    expect(publicDetail.body).not.toContain("originReviewState");
    expect(publicDetail.body).not.toContain("organizationId");
    expect(publicDetail.body).not.toContain("reviewer");

    const publicProvider = await instance.inject({
      method: "GET",
      url: publicUrl(`/providers/${PROVIDER1}`),
    });
    expect(publicProvider.statusCode).toBe(200);
    CommerceMarketPublicProviderDetailResponseSchema.parse(publicProvider.json());
    expect(publicProvider.json().data.item.providerId).toBe(PROVIDER1);
  });

  it("pauses an active version, republishes it with exact CAS and cannot resurrect a retired version", async () => {
    const instance = await buildApp();
    const { listingId } = await setupPublishedV2(instance);

    const activeRead = await readOwnerVersion(instance, "a", listingId, "2");
    const pause = await transition(instance, "a", listingId, "2", "pause", {
      mutationId: randomUUID(),
      expectedUpdatedAt: activeRead.json().data.item.updatedAt,
      expectedActiveVersion: "2",
    });
    expect(pause.statusCode).toBe(200);
    expect(pause.json().data.receipt.operation).toBe("market.listing.version.pause");

    const publicAfterPause = await instance.inject({ method: "GET", url: publicUrl("/listings") });
    expect(publicAfterPause.statusCode).toBe(200);
    expect(publicAfterPause.json().data.items).toHaveLength(0);

    const history = await instance.inject({
      method: "GET",
      url: providerUrl(ORG1, `/listings/${listingId}/versions`),
      headers: readHeadersFor("a"),
    });
    expect(history.statusCode).toBe(200);
    expect(
      history.json().data.items.map((item: { version: string }) => item.version),
    ).toEqual(["1", "2"]);
    expect(history.json().data.items[1].status).toBe("paused");

    const pausedRead = await readOwnerVersion(instance, "a", listingId, "2");
    const republish = await transition(instance, "a", listingId, "2", "publish", {
      mutationId: randomUUID(),
      expectedUpdatedAt: pausedRead.json().data.item.updatedAt,
      expectedActiveVersion: null,
    });
    expect(republish.statusCode).toBe(200);
    expect(republish.json().data.receipt.operation).toBe("market.listing.version.publish");

    const activeAgain = await readOwnerVersion(instance, "a", listingId, "2");
    const retire = await transition(instance, "a", listingId, "2", "retire", {
      mutationId: randomUUID(),
      expectedUpdatedAt: activeAgain.json().data.item.updatedAt,
      expectedActiveVersion: "2",
    });
    expect(retire.statusCode).toBe(200);
    expect(retire.json().data.receipt.operation).toBe("market.listing.version.retire");

    const publicAfterRetire = await instance.inject({ method: "GET", url: publicUrl("/listings") });
    expect(publicAfterRetire.json().data.items).toHaveLength(0);

    const retiredRead = await readOwnerVersion(instance, "a", listingId, "2");
    const resurrect = await transition(instance, "a", listingId, "2", "publish", {
      mutationId: randomUUID(),
      expectedUpdatedAt: retiredRead.json().data.item.updatedAt,
      expectedActiveVersion: null,
    });
    expect(resurrect.statusCode).toBeGreaterThanOrEqual(400);
    expect(resurrect.statusCode).toBeLessThan(500);

    const stillRetired = await readOwnerVersion(instance, "a", listingId, "2");
    expect(stillRetired.json().data.item.status).toBe("retired");
    expect(publicAfterRetire.json().data.items).toHaveLength(0);

    // An earlier UNREVIEWED immutable version never becomes active accidentally.
    const v3 = await createVersion(instance, "a", listingId, "2", "Example API v3");
    expect(v3.response.statusCode).toBe(200);
    const v3Read = await readOwnerVersion(instance, "a", listingId, "3");
    const publishV3 = await transition(instance, "a", listingId, "3", "publish", {
      mutationId: randomUUID(),
      expectedUpdatedAt: v3Read.json().data.item.updatedAt,
      expectedActiveVersion: null,
    });
    expect(publishV3.statusCode).toBe(400);
    const v3After = await readOwnerVersion(instance, "a", listingId, "3");
    expect(v3After.json().data.item.status).toBe("draft");
    const publicFinal = await instance.inject({ method: "GET", url: publicUrl("/listings") });
    expect(publicFinal.json().data.items).toHaveLength(0);
  });

  it("rejection of an active version pauses it atomically and blocks publication", async () => {
    const instance = await buildApp();
    const { listingId } = await setupPublishedV2(instance);

    const activeRead = await readOwnerVersion(instance, "a", listingId, "2");
    const reject = await recordOriginReview(
      instance,
      "m",
      listingId,
      "2",
      activeRead.json().data.item.updatedAt,
      "rejected",
      { reasonCode: "origin_policy" },
    );
    expect(reject.response.statusCode).toBe(200);
    expect(reject.response.json().data.receipt.operation).toBe(
      "market.listing.origin_review.record",
    );

    const rejectedRead = await readOwnerVersion(instance, "a", listingId, "2");
    expect(rejectedRead.json().data.item.status).toBe("paused");
    expect(rejectedRead.json().data.item.originReviewState).toBe("rejected");
    expect(rejectedRead.json().data.item.publishedAt).not.toBeNull();

    const root = await instance.inject({
      method: "GET",
      url: providerUrl(ORG1, `/listings/${listingId}`),
      headers: readHeadersFor("a"),
    });
    expect(root.json().data.item.activeVersion).toBeNull();

    const publicList = await instance.inject({ method: "GET", url: publicUrl("/listings") });
    expect(publicList.json().data.items).toHaveLength(0);

    const publish = await transition(instance, "a", listingId, "2", "publish", {
      mutationId: randomUUID(),
      expectedUpdatedAt: rejectedRead.json().data.item.updatedAt,
      expectedActiveVersion: null,
    });
    expect(publish.statusCode).toBe(400);
    expect(errorCode(publish)).toBe("INVALID_REQUEST");

    const rejectRead = await readOwnerVersion(instance, "a", listingId, "2");
    const reapprove = await recordOriginReview(
      instance,
      "m",
      listingId,
      "2",
      rejectRead.json().data.item.updatedAt,
      "approved",
    );
    expect(reapprove.response.statusCode).toBe(200);
    const approvedRead = await readOwnerVersion(instance, "a", listingId, "2");
    const republish = await transition(instance, "a", listingId, "2", "publish", {
      mutationId: randomUUID(),
      expectedUpdatedAt: approvedRead.json().data.item.updatedAt,
      expectedActiveVersion: null,
    });
    expect(republish.statusCode).toBe(200);
    const publicAfter = await instance.inject({ method: "GET", url: publicUrl("/listings") });
    expect(publicAfter.json().data.items).toHaveLength(1);
  });

  it("denies publication of an unreviewed version with the accepted fixed mapping and no durable mutation", async () => {
    const instance = await buildApp();
    const draft = await createDraft(instance, "a");
    const listingId = draft.listingId;
    const v2 = await createVersion(instance, "a", listingId, "1");
    expect(v2.response.statusCode).toBe(200);

    const read = await readOwnerVersion(instance, "a", listingId, "2");
    const publishMutationId = randomUUID();
    const publish = await transition(instance, "a", listingId, "2", "publish", {
      mutationId: publishMutationId,
      expectedUpdatedAt: read.json().data.item.updatedAt,
      expectedActiveVersion: null,
    });
    // Accepted frozen mapping: lifecycle_review_required -> SQLSTATE 23514 ->
    // MARKET_STORE_INPUT_INVALID -> 400 INVALID_REQUEST.
    expect(publish.statusCode).toBe(400);
    expect(errorCode(publish)).toBe("INVALID_REQUEST");
    await assertNoDurableRecord(publishMutationId);

    const after = await readOwnerVersion(instance, "a", listingId, "2");
    expect(after.json().data.item.status).toBe("draft");
    const publicList = await instance.inject({ method: "GET", url: publicUrl("/listings") });
    expect(publicList.json().data.items).toHaveLength(0);
  });
});

describe("real-PG lifecycle CAS, idempotency and replay", () => {
  it("rejects a stale expectedUpdatedAt with 409 and no durable mutation", async () => {
    const instance = await buildApp();
    const { listingId, publishBody } = await setupPublishedV2(instance);

    const staleMutationId = randomUUID();
    const stale = await transition(instance, "a", listingId, "2", "pause", {
      mutationId: staleMutationId,
      expectedUpdatedAt: publishBody["expectedUpdatedAt"],
      expectedActiveVersion: "2",
    });
    expect(stale.statusCode).toBe(409);
    expect(errorCode(stale)).toBe("POLICY_DENIED");
    await assertNoDurableRecord(staleMutationId);

    const state = await readOwnerVersion(instance, "a", listingId, "2");
    expect(state.json().data.item.status).toBe("active");
  });

  it("rejects a stale expectedActiveVersion with 409 and no durable mutation", async () => {
    const instance = await buildApp();
    const { listingId } = await setupPublishedV2(instance);

    const v3 = await createVersion(instance, "a", listingId, "2", "Example API v3");
    expect(v3.response.statusCode).toBe(200);
    const modRead = await readModeratorVersion(instance, "m", listingId, "3");
    const review = await recordOriginReview(
      instance,
      "m",
      listingId,
      "3",
      modRead.json().data.item.updatedAt,
      "approved",
    );
    expect(review.response.statusCode).toBe(200);

    const v3Read = await readOwnerVersion(instance, "a", listingId, "3");
    const staleMutationId = randomUUID();
    const stale = await transition(instance, "a", listingId, "3", "publish", {
      mutationId: staleMutationId,
      expectedUpdatedAt: v3Read.json().data.item.updatedAt,
      // Actual active version is "2"; this pointer is stale.
      expectedActiveVersion: "1",
    });
    expect(stale.statusCode).toBe(409);
    expect(errorCode(stale)).toBe("POLICY_DENIED");
    await assertNoDurableRecord(staleMutationId);
  });

  it("replays the original successful transition after a later state change without a duplicate event", async () => {
    const instance = await buildApp();
    const { listingId, publishMutationId, publishBody, publishKey } =
      await setupPublishedV2(instance);

    const activeRead = await readOwnerVersion(instance, "a", listingId, "2");
    const retire = await transition(instance, "a", listingId, "2", "retire", {
      mutationId: randomUUID(),
      expectedUpdatedAt: activeRead.json().data.item.updatedAt,
      expectedActiveVersion: "2",
    });
    expect(retire.statusCode).toBe(200);

    expect(
      await count(
        `SELECT count(*)::text AS n FROM openarc_durable.outbox_events
          WHERE organization_id = $1 AND mutation_id = $2`,
        [ORG1, publishMutationId],
      ),
    ).toBe(1);

    const replay = await transition(
      instance,
      "a",
      listingId,
      "2",
      "publish",
      { ...publishBody },
      { "idempotency-key": publishKey },
    );
    expect(replay.statusCode).toBe(200);
    expect(replay.json().data.replayed).toBe(true);
    expect(replay.json().data.receipt.operation).toBe("market.listing.version.publish");
    expect(replay.json().data.receipt.resourceId).toBe(`${listingId}@2`);

    expect(
      await count(
        `SELECT count(*)::text AS n FROM openarc_durable.outbox_events
          WHERE organization_id = $1 AND mutation_id = $2`,
        [ORG1, publishMutationId],
      ),
    ).toBe(1);
    expect(
      await count(
        `SELECT count(*)::text AS n FROM openarc_durable.audit_events
          WHERE organization_id = $1 AND mutation_id = $2`,
        [ORG1, publishMutationId],
      ),
    ).toBe(1);
  });

  it("conflicts when the body or the key changes for one committed mutation", async () => {
    const instance = await buildApp();
    const { listingId, publishMutationId, publishBody, publishKey } =
      await setupPublishedV2(instance);

    // Same key, changed body => request-digest conflict.
    const changedBody = await transition(
      instance,
      "a",
      listingId,
      "2",
      "publish",
      { ...publishBody, expectedActiveVersion: "1" },
      { "idempotency-key": publishKey },
    );
    expect(changedBody.statusCode).toBe(409);
    expect(errorCode(changedBody)).toBe("IDEMPOTENCY_CONFLICT");

    // Changed key, same mutationId => mutation-id conflict.
    const changedKey = await transition(instance, "a", listingId, "2", "publish", {
      ...publishBody,
    });
    expect(changedKey.statusCode).toBe(409);
    expect(errorCode(changedKey)).toBe("IDEMPOTENCY_CONFLICT");

    const state = await readOwnerVersion(instance, "a", listingId, "2");
    expect(state.json().data.item.status).toBe("active");
    expect(
      await count(
        `SELECT count(*)::text AS n FROM openarc_durable.outbox_events
          WHERE organization_id = $1 AND mutation_id = $2`,
        [ORG1, publishMutationId],
      ),
    ).toBe(1);
  });
});

describe("real-PG moderator authority over HTTP", () => {
  it("lets the independent moderator read, record and read back only its own status", async () => {
    const instance = await buildApp();
    const draft = await createDraft(instance, "a");
    const listingId = draft.listingId;
    const version = await createVersion(instance, "a", listingId, "1");
    expect(version.response.statusCode).toBe(200);

    const modRead = await readModeratorVersion(instance, "m", listingId, "2");
    expect(modRead.statusCode).toBe(200);
    expect(modRead.json().data.item.version).toBe("2");

    const review = await recordOriginReview(
      instance,
      "m",
      listingId,
      "2",
      modRead.json().data.item.updatedAt,
      "approved",
    );
    expect(review.response.statusCode).toBe(200);

    const ownStatus = await instance.inject({
      method: "GET",
      url: moderatorUrl(ORG1, `/listing-lifecycle-mutations/${review.mutationId}`),
      headers: readHeadersFor("m"),
    });
    expect(ownStatus.statusCode).toBe(200);
    expect(ownStatus.json().data.status).toBe("committed");
    expect(ownStatus.json().data.receipt.mutationId).toBe(review.mutationId);

    const otherStatus = await instance.inject({
      method: "GET",
      url: moderatorUrl(ORG1, `/listing-lifecycle-mutations/${review.mutationId}`),
      headers: readHeadersFor("a"),
    });
    expect(otherStatus.statusCode).toBe(200);
    expect(otherStatus.json().data.status).toBe("not_found");
  });

  it("denies self-review, a no-grant moderator and a revoked-grant moderator", async () => {
    const instance = await buildApp();
    const draft = await createDraft(instance, "a");
    const listingId = draft.listingId;
    const version = await createVersion(instance, "a", listingId, "1");
    expect(version.response.statusCode).toBe(200);

    const modRead = await readModeratorVersion(instance, "m", listingId, "2");
    const updatedAt = modRead.json().data.item.updatedAt as string;

    // A is an ORG1 member AND explicitly granted: self-review is denied.
    const selfReview = await recordOriginReview(instance, "a", listingId, "2", updatedAt, "approved");
    expect(selfReview.response.statusCode).toBe(403);
    expect(errorCode(selfReview.response)).toBe("FORBIDDEN");

    // N has no membership and no grant.
    const noGrant = await recordOriginReview(instance, "n", listingId, "2", updatedAt, "approved");
    expect(noGrant.response.statusCode).toBe(403);
    expect(errorCode(noGrant.response)).toBe("FORBIDDEN");

    // V has a revoked grant.
    const revoked = await recordOriginReview(instance, "v", listingId, "2", updatedAt, "approved");
    expect(revoked.response.statusCode).toBe(403);
    expect(errorCode(revoked.response)).toBe("FORBIDDEN");

    expect(
      await count(
        `SELECT count(*)::text AS n FROM openarc_tenant.listing_origin_reviews
          WHERE organization_id = $1 AND listing_id = $2`,
        [ORG1, listingId],
      ),
    ).toBe(0);
  });

  it("denies a cross-organization provider request", async () => {
    const instance = await buildApp();
    const foreign = await createDraft(instance, "a", ORG2, PROVIDER2);
    expect(foreign.response.statusCode).toBe(403);
    expect(errorCode(foreign.response)).toBe("FORBIDDEN");

    const roots = await instance.inject({
      method: "GET",
      url: providerUrl(ORG2, "/listings"),
      headers: readHeadersFor("a"),
    });
    expect(roots.statusCode).toBe(403);

    const foreignProvider = await createDraft(instance, "a", ORG1, PROVIDER2);
    expect(foreignProvider.response.statusCode).toBe(403);

    const retired = await createDraft(instance, "a", ORG1, PROVIDER_RETIRED);
    expect(retired.response.statusCode).toBe(403);

    expect(await count(`SELECT count(*)::text AS n FROM openarc_tenant.listings`)).toBe(0);
  });
});

describe("real-PG marketplace family flags and runtime", () => {
  const ALL_12_PROVIDER_ROUTES: ReadonlyArray<{
    readonly method: "GET" | "POST";
    readonly build: (listingId: string) => string;
  }> = [
    { method: "GET", build: () => providerUrl(ORG1, "/listings") },
    { method: "POST", build: () => providerUrl(ORG1, "/listings") },
    { method: "GET", build: (l) => providerUrl(ORG1, `/listings/${l}`) },
    { method: "GET", build: (l) => providerUrl(ORG1, `/listings/${l}/versions`) },
    { method: "POST", build: (l) => providerUrl(ORG1, `/listings/${l}/versions`) },
    { method: "GET", build: (l) => providerUrl(ORG1, `/listings/${l}/versions/1`) },
    { method: "GET", build: () => providerUrl(ORG1, `/listing-mutations/${uuid(9)}`) },
    { method: "GET", build: () => providerUrl(ORG1, "/listing-providers") },
    { method: "POST", build: (l) => providerUrl(ORG1, `/listings/${l}/versions/1/publish`) },
    { method: "POST", build: (l) => providerUrl(ORG1, `/listings/${l}/versions/1/pause`) },
    { method: "POST", build: (l) => providerUrl(ORG1, `/listings/${l}/versions/1/retire`) },
    { method: "GET", build: () => providerUrl(ORG1, `/listing-lifecycle-mutations/${uuid(9)}`) },
  ];

  it("registers all twelve provider routes and the real lifecycle dependency with tenant writes OFF", async () => {
    const instance = await buildApp({
      auth: true,
      tenantReads: true,
      listing: true,
      moderation: false,
      catalog: false,
    });

    const draft = await createDraft(instance, "a");
    expect(draft.response.statusCode).toBe(200);
    const listingId = draft.listingId;
    const version = await createVersion(instance, "a", listingId, "1");
    expect(version.response.statusCode).toBe(200);

    for (const route of ALL_12_PROVIDER_ROUTES) {
      const response = await instance.inject({
        method: route.method,
        url: route.build(listingId),
        headers: route.method === "GET" ? readHeadersFor("a") : headersFor("a"),
        ...(route.method === "POST" ? { payload: {} } : {}),
      });
      expect(response.statusCode, `${route.method} ${route.build(listingId)}`).not.toBe(404);
    }

    const picker = await instance.inject({
      method: "GET",
      url: providerUrl(ORG1, "/listing-providers?limit=50"),
      headers: readHeadersFor("a"),
    });
    expect(picker.statusCode).toBe(200);
    expect(
      picker.json().data.items.map((item: { providerId: string }) => item.providerId),
    ).toContain(PROVIDER1);

    const v1Read = await readOwnerVersion(instance, "a", listingId, "1");
    const publish = await transition(instance, "a", listingId, "1", "publish", {
      mutationId: randomUUID(),
      expectedUpdatedAt: v1Read.json().data.item.updatedAt,
      expectedActiveVersion: null,
    });
    expect(publish.statusCode).toBe(400);
    expect(errorCode(publish)).toBe("INVALID_REQUEST");

    expect((await instance.inject({ method: "GET", url: publicUrl("/listings") })).statusCode).toBe(404);
    const moderator = await instance.inject({
      method: "GET",
      url: moderatorUrl(ORG1, `/listings/${listingId}/versions/1`),
      headers: readHeadersFor("m"),
    });
    expect(moderator.statusCode).toBe(404);
  });

  it("runs moderation-only with independent moderator auth while provider and catalog stay 404", async () => {
    const seeder = await buildApp({ listing: true, moderation: true, catalog: false });
    const draft = await createDraft(seeder, "a");
    const listingId = draft.listingId;
    const version = await createVersion(seeder, "a", listingId, "1");
    expect(version.response.statusCode).toBe(200);

    const instance = await buildApp({
      auth: true,
      tenantReads: false,
      listing: false,
      moderation: true,
      catalog: false,
    });

    const modRead = await readModeratorVersion(instance, "m", listingId, "2");
    expect(modRead.statusCode).toBe(200);
    expect(modRead.json().data.item.version).toBe("2");

    const review = await recordOriginReview(
      instance,
      "m",
      listingId,
      "2",
      modRead.json().data.item.updatedAt,
      "approved",
    );
    expect(review.response.statusCode).toBe(200);

    const status = await instance.inject({
      method: "GET",
      url: moderatorUrl(ORG1, `/listing-lifecycle-mutations/${review.mutationId}`),
      headers: readHeadersFor("m"),
    });
    expect(status.statusCode).toBe(200);
    expect(status.json().data.status).toBe("committed");

    const provider = await instance.inject({
      method: "GET",
      url: providerUrl(ORG1, "/listings"),
      headers: readHeadersFor("a"),
    });
    expect(provider.statusCode).toBe(404);
    expect((await instance.inject({ method: "GET", url: publicUrl("/listings") })).statusCode).toBe(404);

    const anonymous = await instance.inject({
      method: "GET",
      url: moderatorUrl(ORG1, `/listings/${listingId}/versions/2`),
      headers: { ...CLIENT },
    });
    expect(anonymous.statusCode).toBe(401);
  });

  it("initializes a real catalog-only runtime with no AuthService and reports accurate capabilities", async () => {
    const runtime = await startMarketRuntime({
      marketDatabaseUrl: tenantUrl(),
      catalogEnabled: true,
      listingManagementEnabled: false,
      moderationEnabled: false,
    });
    expect(runtime.service).toBeUndefined();
    expect(runtime.lifecycleService).toBeUndefined();
    expect(runtime.catalogService).toBeDefined();
    await expect(runtime.ready()).resolves.toBe(true);
    const catalogService = runtime.catalogService;
    if (catalogService === undefined) throw new Error("catalog service unavailable");

    const config = loadConfig({
      NODE_ENV: "test",
      APP_ORIGIN: ORIGIN,
      COMMIT_SHA: BUILD_SHA,
      AUTH_ENABLED: "false",
      TENANT_READS_ENABLED: "false",
      TENANT_WRITES_ENABLED: "false",
      TENANT_DATABASE_URL: tenantUrl(),
      LISTING_MANAGEMENT_ENABLED: "false",
      MARKET_MODERATION_ENABLED: "false",
      MARKET_CATALOG_ENABLED: "true",
    });
    const instance = createApp({
      config,
      logger: false,
      marketCatalogService: catalogService,
      marketReady: runtime.ready,
    });

    const capability = await instance.inject({
      method: "GET",
      url: "/v2/public/marketplace-capabilities",
    });
    expect(capability.statusCode).toBe(200);
    const manifest = MarketplaceCapabilitiesSuccessEnvelopeSchema.parse(capability.json());
    const states = new Map(manifest.data.capabilities.map((entry) => [entry.family, entry.state]));
    expect(states.get("public_catalog")).toBe("enabled");
    expect(states.get("listing_management")).toBe("built_disabled");
    expect(states.get("moderation")).toBe("built_disabled");
    expect(manifest.data.routes).toHaveLength(18);

    const list = await instance.inject({ method: "GET", url: publicUrl("/listings") });
    expect(list.statusCode).toBe(200);
    expect(list.json().data.items).toEqual([]);
    const detail = await instance.inject({
      method: "GET",
      url: publicUrl(`/listings/openarc:listing:${uuid(7)}`),
    });
    expect(detail.statusCode).toBe(200);
    expect(detail.json().data.item).toBeNull();

    await instance.close();
    await runtime.close();
  });

  it("reports healthy readiness and fails closed on a stale schema without enabling routes", async () => {
    const runtime = await startMarketRuntime({
      marketDatabaseUrl: tenantUrl(),
      catalogEnabled: true,
      listingManagementEnabled: false,
      moderationEnabled: false,
    });
    await expect(runtime.ready()).resolves.toBe(true);
    await runtime.close();

    // One focused representative tamper: schema7 force-RLS posture drift.
    await admin.query(
      "ALTER TABLE openarc_tenant.market_moderator_grants NO FORCE ROW LEVEL SECURITY",
    );
    await expect(
      startMarketRuntime({
        marketDatabaseUrl: tenantUrl(),
        catalogEnabled: true,
        listingManagementEnabled: false,
        moderationEnabled: false,
      }),
    ).rejects.toThrow("MARKET_RUNTIME_UNAVAILABLE");
  });

  it("constructs an all-off app with no market runtime and an all built_disabled manifest", async () => {
    const instance = await buildApp({
      auth: false,
      tenantReads: false,
      listing: false,
      moderation: false,
      catalog: false,
    });

    expect((await instance.inject({ method: "GET", url: publicUrl("/listings") })).statusCode).toBe(404);
    expect(
      (
        await instance.inject({
          method: "GET",
          url: providerUrl(ORG1, "/listings"),
          headers: readHeadersFor("a"),
        })
      ).statusCode,
    ).toBe(404);

    const ready = await instance.inject({ method: "GET", url: "/readyz" });
    expect(ready.statusCode).toBe(200);
    expect(ready.json().checks["marketDatabase"]).toBeUndefined();

    const capability = await instance.inject({
      method: "GET",
      url: "/v2/public/marketplace-capabilities",
    });
    expect(capability.statusCode).toBe(200);
    const manifest = MarketplaceCapabilitiesSuccessEnvelopeSchema.parse(capability.json());
    for (const entry of manifest.data.capabilities) {
      expect(entry.state).toBe("built_disabled");
    }
  });
});

describe("real-PG public and protected separation", () => {
  it("rejects credentials on the public read, a protected write without CSRF and never mints a cookie", async () => {
    const instance = await buildApp();

    const credentialedPublic = await instance.inject({
      method: "GET",
      url: publicUrl("/listings"),
      headers: { cookie: `${SESSION_COOKIE}=${tokens.get("a") ?? ""}` },
    });
    expect(credentialedPublic.statusCode).toBe(400);
    expect(errorCode(credentialedPublic)).toBe("INVALID_REQUEST");

    const headers = headersFor("a");
    delete headers["x-openarc-csrf"];
    const withoutCsrf = await instance.inject({
      method: "POST",
      url: providerUrl(ORG1, "/listings"),
      headers,
      payload: { mutationId: randomUUID(), providerId: PROVIDER1, content: content() },
    });
    expect(withoutCsrf.statusCode).toBe(403);
    expect(errorCode(withoutCsrf)).toBe("CSRF_REJECTED");
    expect(await count(`SELECT count(*)::text AS n FROM openarc_tenant.listings`)).toBe(0);

    // No Set-Cookie and no CORS grant on success or on a market error.
    for (const response of [credentialedPublic, withoutCsrf]) {
      expect(response.headers["set-cookie"]).toBeUndefined();
      expect(response.headers["access-control-allow-origin"]).toBeUndefined();
    }
    const success = await instance.inject({ method: "GET", url: publicUrl("/listings") });
    expect(success.statusCode).toBe(200);
    expect(success.headers["set-cookie"]).toBeUndefined();
    expect(success.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("returns real-store v2 output and a truthful not-found without fake success", async () => {
    const instance = await buildApp();

    const missing = await instance.inject({
      method: "GET",
      url: publicUrl(`/listings/openarc:listing:${uuid(9)}`),
    });
    expect(missing.statusCode).toBe(200);
    CommerceMarketPublicDetailResponseSchema.parse(missing.json());
    expect(missing.json().data.item).toBeNull();
    expect(missing.json().meta.schemaVersion).toBe("openarc.api.v2");

    // A protected write against a nonexistent listing is denied, not "succeeded".
    const bogus = `openarc:listing:${uuid(9)}`;
    const bogusMutationId = randomUUID();
    const publish = await transition(instance, "a", bogus, "1", "publish", {
      mutationId: bogusMutationId,
      expectedUpdatedAt: new Date().toISOString(),
      expectedActiveVersion: null,
    });
    expect(publish.statusCode).toBe(403);
    await assertNoDurableRecord(bogusMutationId);

    const list = await instance.inject({ method: "GET", url: publicUrl("/listings") });
    expect(list.statusCode).toBe(200);
    CommerceMarketPublicPageResponseSchema.parse(list.json());
    expect(list.json().data.items).toHaveLength(0);
  });
});
