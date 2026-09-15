import { createHash, randomBytes, randomUUID } from "node:crypto";

// Type-only imports do not execute these modules.
import type { adminPool } from "../packages/db/test/postgres-fixture.js";
import type { createDatabasePool } from "../packages/db/src/index.js";

// Pure production primitives, imported READONLY so every hash crossing into the
// disposable database is the REAL production digest, never a mirror.
import { hashCommerceSessionToken } from "../apps/api/src/control/session-crypto.js";
import {
  generateCommerceGrantToken,
  hashCommerceGrantToken,
} from "../apps/api/src/control/grant-crypto.js";
import { generateSessionToken, hashSessionToken } from "../apps/api/src/machine/session-token.js";
import { createSessionIdempotencyKey } from "../apps/web/src/tenant/session-client.js";

// Accepted guarded fixtures, imported READONLY.
import {
  FIXTURE_ERRORS,
  TenantFixtureError,
  countDurableRows as countAcceptedDurableRows,
  readDurableReceipt as readAcceptedDurableReceipt,
  seedAccount as seedAcceptedAccount,
  seedAgents as seedAcceptedAgents,
  seedOwnOrganizations as seedAcceptedOwnOrganizations,
  seedProviders as seedAcceptedProviders,
} from "../e2e-tenant-write-production/fixture-db.js";
import { seedAgentMachineSession as seedAcceptedAgentMachineSession } from "../e2e-session-production/fixture-db.js";

export { FIXTURE_ERRORS, TenantFixtureError };
export type { SeededProfile } from "../e2e-tenant-production/fixture-db.js";

type AdminPool = ReturnType<typeof adminPool>;
type DbPool = ReturnType<typeof createDatabasePool>;

/**
 * Bounded, test-only PORT-03 commerce action/grant fixture.
 *
 * Never imported by the web app or the API. Every function runs behind
 * `OPENARC_COMMERCE_PRODUCTION_FIXTURE=1`, `OPENARC_SESSION_PRODUCTION_FIXTURE=1`
 * and `OPENARC_TENANT_PRODUCTION_FIXTURE=1`, and the accepted
 * `packages/db/test/postgres-fixture.ts` guard asserts the exact synthetic
 * loopback PostgreSQL URL before any connection.
 *
 * PROVENANCE, STATED PLAINLY. Production wrappers reject `internal_fixture`
 * requirement provenance (`P0D10`) and `is_canonical_source_kind` admits only
 * `internal_fixture`, so no production-path authorize/decide/issue/replace/
 * introspect/claim can succeed in schema 14. The functions named `fixture*`
 * below therefore call the migrator-only closed cores with the literal mode
 * `internal_fixture`, exactly as the accepted DB10/DB12/adversarial PostgreSQL
 * suites do. Nothing is relaxed: no GUC, flag, grant or bypass is added, and the
 * restricted runtime role still reaches only the `production` wrappers. Rows
 * created here are fixture rows and are never evidence of a production
 * purchase, grant, claim, payment, settlement or delivery.
 *
 * No raw handoff, commerce session, provider session or grant token is logged,
 * persisted or returned from a DB read. Raw tokens that a journey must present
 * to the real edge live only in the caller's test memory.
 */

const FLAGS = [
  "OPENARC_COMMERCE_PRODUCTION_FIXTURE",
  "OPENARC_SESSION_PRODUCTION_FIXTURE",
  "OPENARC_TENANT_PRODUCTION_FIXTURE",
] as const;

const ORG = /^openarc:org:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const ACCOUNT = /^openarc:account:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const AGENT = /^openarc:agent:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const PROVIDER = /^openarc:provider:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const LISTING = /^openarc:listing:[0-9a-f-]{36}$/u;
const POLICY = /^openarc:policy:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const ACTION = /^openarc:action:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const GRANT = /^openarc:grant:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const REQUIREMENT = /^openarc:requirement:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const UUID4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const AMOUNT = /^[1-9][0-9]{0,17}$/u;
const HEX64 = /^[0-9a-f]{64}$/u;

function fail(code: (typeof FIXTURE_ERRORS)[keyof typeof FIXTURE_ERRORS]): never {
  throw new TenantFixtureError(code);
}

function assertEnabled(): void {
  for (const flag of FLAGS) if (process.env[flag] !== "1") fail("FIXTURE_DISABLED");
}

function need(pattern: RegExp, value: unknown): string {
  if (typeof value !== "string" || !pattern.test(value)) fail("FIXTURE_INPUT_INVALID");
  return value;
}

async function loadFixtureModule() {
  assertEnabled();
  try {
    return await import("../packages/db/test/postgres-fixture.js");
  } catch {
    fail("FIXTURE_UNAVAILABLE");
  }
}

async function loadDbModule() {
  assertEnabled();
  try {
    return await import("../packages/db/src/index.js");
  } catch {
    fail("FIXTURE_UNAVAILABLE");
  }
}

async function withAdmin<T>(work: (admin: AdminPool) => Promise<T>): Promise<T> {
  const fixture = await loadFixtureModule();
  let admin: AdminPool | undefined;
  try {
    admin = fixture.adminPool();
    return await work(admin);
  } catch (error) {
    if (error instanceof TenantFixtureError) throw error;
    throw new TenantFixtureError("FIXTURE_UNAVAILABLE");
  } finally {
    if (admin !== undefined) await admin.end().catch(() => undefined);
  }
}

type DbModule = Awaited<ReturnType<typeof loadDbModule>>;

async function withPool<T>(
  role: "tenant" | "migrator",
  work: (db: DbModule, pool: DbPool) => Promise<T>,
): Promise<T> {
  const fixture = await loadFixtureModule();
  const db = await loadDbModule();
  let pool: DbPool | undefined;
  try {
    pool = db.createDatabasePool(role === "tenant" ? fixture.tenantUrl() : fixture.migratorUrl());
    return await work(db, pool);
  } catch (error) {
    if (error instanceof TenantFixtureError) throw error;
    if (error instanceof FixtureCoreRefusal) throw error;
    throw new TenantFixtureError("FIXTURE_UNAVAILABLE");
  } finally {
    if (pool !== undefined) await pool.end().catch(() => undefined);
  }
}

/** A closed-core refusal. Carries ONLY the non-secret SQLSTATE. */
export class FixtureCoreRefusal extends Error {
  readonly sqlstate: string;
  constructor(sqlstate: string) {
    super("FIXTURE_CORE_REFUSED");
    this.sqlstate = sqlstate;
  }
}

function sqlstateOf(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" && /^[0-9A-Z]{5}$/u.test(code) ? code : "UNKNOWN";
}

function randomHex64(): string {
  return randomBytes(32).toString("hex");
}

/* -------------------------------------------------------------------------- */
/* Accepted seed wrappers                                                      */
/* -------------------------------------------------------------------------- */

export async function seedOwnOrganizations(accountId: unknown, names: readonly string[]) {
  assertEnabled();
  return seedAcceptedOwnOrganizations(accountId, names);
}

export async function seedAgents(organizationId: unknown, count: unknown) {
  assertEnabled();
  return seedAcceptedAgents(organizationId, count);
}

export async function countDurableRows(organizationId: unknown, mutationId: unknown) {
  assertEnabled();
  return countAcceptedDurableRows(organizationId, mutationId);
}

export async function readDurableReceipt(organizationId: unknown, mutationId: unknown) {
  assertEnabled();
  return readAcceptedDurableReceipt(organizationId, mutationId);
}

/** Real agent credential + agent session via the accepted session fixture. */
export async function seedAgentMachineSession(
  accountId: unknown,
  organizationId: unknown,
  agentId: unknown,
) {
  assertEnabled();
  // Same value as the accepted session journeys: the credential must outlive
  // the 15-minute-capped agent session, or the DB rejects the session expiry.
  return seedAcceptedAgentMachineSession(accountId, organizationId, agentId, 3_600);
}

/* -------------------------------------------------------------------------- */
/* Human session hashes (internal only, never returned)                        */
/* -------------------------------------------------------------------------- */

const syntheticSessionHashes = new Map<string, string>();

async function liveSessionHash(accountId: string): Promise<string> {
  const synthetic = syntheticSessionHashes.get(accountId);
  if (synthetic !== undefined) return synthetic;
  return withAdmin(async (admin) => {
    const result = await admin.query<{ token_hash: string }>(
      `SELECT token_hash FROM openarc_auth.sessions
        WHERE account_id = $1 AND expires_at > clock_timestamp()
        ORDER BY created_at DESC LIMIT 1`,
      [accountId],
    );
    const row = result.rows[0];
    if (row === undefined || !HEX64.test(row.token_hash)) fail("FIXTURE_UNAVAILABLE");
    return row.token_hash;
  });
}

/** Synthetic active account with a synthetic live session row (hash kept internal). */
async function seedSyntheticHuman(): Promise<string> {
  const accountId = await seedAcceptedAccount();
  const hash = createHash("sha256").update(randomBytes(32)).digest("hex");
  await withAdmin(async (admin) => {
    await admin.query(
      `INSERT INTO openarc_auth.sessions (token_hash, account_id, method, created_at, expires_at)
       VALUES ($1, $2, 'passkey', now(), now() + interval '2 hours')`,
      [hash, accountId],
    );
  });
  syntheticSessionHashes.set(accountId, hash);
  return accountId;
}

/* -------------------------------------------------------------------------- */
/* Seller: real published, origin-approved listing through the real stores     */
/* -------------------------------------------------------------------------- */

export interface SeededSeller {
  readonly sellerAccountId: string;
  readonly sellerOrganizationId: string;
  readonly providerId: string;
  readonly listingId: string;
}

const LISTING_ORIGIN = "https://api.example.com";
const LISTING_PATH = "/v1/run";

function listingContent(): Record<string, unknown> {
  return {
    kind: "api",
    title: "Synthetic acceptance API",
    description: "A bounded synthetic acceptance listing",
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
    endpointContract: { origin: LISTING_ORIGIN, path: LISTING_PATH },
    termsRevision: "terms-v1",
    privacySummary: "We store nothing.",
    paymentLane: "unavailable",
    availability: { status: "available", rateLimitPerMinute: "60" },
  };
}

const meta = () => ({ idempotencyKey: createSessionIdempotencyKey(), mutationId: randomUUID() });

export async function seedSellerListing(): Promise<SeededSeller> {
  assertEnabled();
  const sellerAccountId = await seedSyntheticHuman();
  const orgs = await seedAcceptedOwnOrganizations(sellerAccountId, ["Synthetic Seller"]);
  const sellerOrganizationId = need(ORG, orgs[0]?.organizationId);
  const providerId = need(PROVIDER, (await seedAcceptedProviders(sellerOrganizationId, 1))[0]?.id);
  const moderatorAccountId = await seedSyntheticHuman();
  await withAdmin(async (admin) => {
    await admin.query(
      "INSERT INTO openarc_tenant.market_moderator_grants (account_id, status) VALUES ($1, 'active')",
      [moderatorAccountId],
    );
  });
  const sellerHash = await liveSessionHash(sellerAccountId);
  const moderatorHash = await liveSessionHash(moderatorAccountId);
  const listingId = await withPool("tenant", async (db, pool) => {
    const market = new db.MarketStore(db.asMarketPool(pool));
    const lifecycle = new db.MarketLifecycleStore(db.asLifecyclePool(pool));
    await market.initialize();
    await lifecycle.initialize();
    const draft = await market.createListingDraft(sellerHash, sellerOrganizationId, providerId, listingContent(), meta());
    const listing = need(LISTING, draft.receipt.resourceId);
    const updatedAt = async (): Promise<string> =>
      withAdmin(async (admin) => {
        const result = await admin.query<{ updated_at: string }>(
          `SELECT to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS updated_at
             FROM openarc_tenant.listing_version_states
            WHERE organization_id = $1 AND listing_id = $2 AND version = '1'`,
          [sellerOrganizationId, listing],
        );
        const value = result.rows[0]?.updated_at;
        if (value === undefined) fail("FIXTURE_UNAVAILABLE");
        return value;
      });
    await lifecycle.recordOriginReview(
      moderatorHash, sellerOrganizationId, listing, "1",
      {
        expectedUpdatedAt: await updatedAt(),
        decision: "approved",
        reviewedEndpointDigest: db.reviewedEndpointDigest({
          listingId: listing, version: "1", origin: LISTING_ORIGIN, path: LISTING_PATH,
        }),
        reasonCode: "manual_review",
        reasonDigest: null,
      },
      meta(),
    );
    await lifecycle.publishListingVersion(
      sellerHash, sellerOrganizationId, listing, "1",
      { expectedUpdatedAt: await updatedAt(), expectedActiveVersion: null },
      meta(),
    );
    return listing;
  });
  return { sellerAccountId, sellerOrganizationId, providerId, listingId };
}

/* -------------------------------------------------------------------------- */
/* Buyer policy through the REAL ControlPolicyStore                            */
/* -------------------------------------------------------------------------- */

export const POLICY_PER_ACTION_LIMIT = "5000000";
export const POLICY_ROLLING_LIMIT = "10000000";
export const POLICY_APPROVAL_THRESHOLD = "2000000";

export async function seedBuyerPolicy(
  accountId: unknown,
  organizationId: unknown,
  agentId: unknown,
  providerId: unknown,
): Promise<string> {
  assertEnabled();
  const account = need(ACCOUNT, accountId);
  const organization = need(ORG, organizationId);
  const agent = need(AGENT, agentId);
  const provider = need(PROVIDER, providerId);
  const sessionHash = await liveSessionHash(account);
  return withPool("tenant", async (db, pool) => {
    const store = new db.ControlPolicyStore(db.asControlPolicyPool(pool));
    await store.initialize();
    const result = await store.createPolicy(sessionHash, organization, {
      organizationId: organization,
      subjectAgentId: agent,
      networkId: "eip155:5042002",
      asset: "USDC",
      representation: "erc20",
      decimals: 6,
      perActionLimit: POLICY_PER_ACTION_LIMIT,
      rollingLimit: POLICY_ROLLING_LIMIT,
      rollingWindowSeconds: "3600",
      feeLimit: "0",
      allowedProviderIds: [provider],
      allowedListingIds: [],
      approval: { mode: "above", threshold: POLICY_APPROVAL_THRESHOLD, separateApprover: false },
      expiresAt: null,
    }, meta());
    return need(POLICY, result.receipt.resourceId);
  });
}

/* -------------------------------------------------------------------------- */
/* Provider machine session through the REAL CredentialStore                   */
/* -------------------------------------------------------------------------- */

export interface SeededProviderSession {
  readonly sessionId: string;
  /** Raw synthetic `oas_pr_` token: caller test memory ONLY, never logged. */
  readonly providerToken: string;
}

export async function seedProviderMachineSession(seller: SeededSeller): Promise<SeededProviderSession> {
  assertEnabled();
  const sellerHash = await liveSessionHash(need(ACCOUNT, seller.sellerAccountId));
  const rawToken = generateSessionToken("provider");
  const tokenHash = hashSessionToken("provider", rawToken);
  return withPool("tenant", async (db, pool) => {
    const store = new db.CredentialStore(db.asCredentialPool(pool));
    await store.initialize();
    const credentialId = randomUUID();
    const hash = {
      algorithm: "scrypt" as const, hashVersion: 1 as const, pepperVersion: 1,
      N: 32768 as const, r: 8 as const, p: 1 as const,
      salt: randomBytes(16).toString("base64url"), digest: randomBytes(32).toString("base64url"),
    };
    db.parseCredentialHashInput(hash);
    await store.issueProviderCredentialDurably({
      sessionHash: sellerHash,
      organizationId: seller.sellerOrganizationId,
      profileId: seller.providerId,
      lookupId: randomUUID(),
      hash,
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      metadata: { idempotencyKey: createSessionIdempotencyKey(), mutationId: credentialId },
    });
    const session = await store.createProviderSession({
      organizationId: seller.sellerOrganizationId,
      profileId: seller.providerId,
      credentialId,
      expectedVersion: 1,
      sessionId: randomUUID(),
      tokenHash,
      // Inside the 15-minute session ceiling with margin, and inside the credential.
      expiresAt: new Date(Date.now() + 600_000).toISOString(),
    });
    return { sessionId: session.sessionId, providerToken: rawToken };
  });
}

/* -------------------------------------------------------------------------- */
/* FIXTURE-SEEDED rows via migrator-only closed cores (mode internal_fixture)  */
/* -------------------------------------------------------------------------- */

/** Inserts one `internal_fixture` requirement reference (admin, fixture only). */
export async function seedFixtureRequirement(
  buyerOrganizationId: unknown,
  seller: SeededSeller,
  amountAtomic: unknown,
): Promise<string> {
  assertEnabled();
  const organization = need(ORG, buyerOrganizationId);
  const amount = need(AMOUNT, amountAtomic);
  const requirementId = `openarc:requirement:${randomUUID()}`;
  await withAdmin(async (admin) => {
    await admin.query(
      `INSERT INTO openarc_durable.commerce_requirement_references (
         organization_id, requirement_id, seller_organization_id, provider_id, listing_id,
         listing_version, network_id, asset, representation, decimals, amount_atomic,
         fee_atomic, requirement_digest, source_kind, created_at, valid_until)
       VALUES ($1, $2, $3, $4, $5, '1', 'eip155:5042002', 'USDC', 'erc20', 6, $6, '0',
               $7, 'internal_fixture', clock_timestamp(), clock_timestamp() + interval '30 minutes')`,
      [organization, requirementId, seller.sellerOrganizationId, seller.providerId, seller.listingId,
        amount, `sha256:${randomHex64()}`],
    );
  });
  return requirementId;
}

export interface FixtureAction {
  readonly actionId: string;
  readonly mutationId: string;
  readonly status: string;
  readonly approvalId: string | null;
  readonly reservationId: string | null;
}

/**
 * FIXTURE authorize through `authorize_commerce_action_core('internal_fixture', ...)`
 * with the exact production key-hash and session-context digests (so the real
 * agent mutation-status reader can recover the receipt). The request digest is
 * random: it only feeds replay comparison, which this fixture never exercises.
 */
export async function fixtureAuthorize(rawCommerceToken: string, requirementId: unknown): Promise<FixtureAction> {
  assertEnabled();
  const requirement = need(REQUIREMENT, requirementId);
  const tokenHash = hashCommerceSessionToken(rawCommerceToken);
  const actionId = `openarc:action:${randomUUID()}`;
  const mutationId = randomUUID();
  return withPool("migrator", async (db, pool) => {
    try {
      const result = await pool.query<{ out_status: string; out_approval_id: string | null; out_reservation_id: string | null }>(
        `SELECT out_status, out_approval_id, out_reservation_id
           FROM openarc_durable.authorize_commerce_action_core(
             'internal_fixture', $1, $2, $3, $4::uuid, $5, $6, $7)`,
        [tokenHash, requirement, actionId, mutationId,
          db.digestCommerceActionIdempotencyKey("control.commerce_action.authorize", createSessionIdempotencyKey()),
          randomHex64(), db.digestCommerceActionMachineContext(tokenHash)],
      );
      const row = result.rows[0];
      if (row === undefined) fail("FIXTURE_UNAVAILABLE");
      return { actionId, mutationId, status: row.out_status, approvalId: row.out_approval_id, reservationId: row.out_reservation_id };
    } catch (error) {
      if (error instanceof TenantFixtureError) throw error;
      throw new FixtureCoreRefusal(sqlstateOf(error));
    }
  });
}

export interface FixtureGrant {
  readonly grantId: string;
  readonly mutationId: string;
  readonly expiresAt: string;
  /** Raw one-use `oag_v1_` token from the PRODUCTION generator: test memory only. */
  readonly grantToken: string;
}

/** FIXTURE issue through `issue_authorization_grant_core('internal_fixture', ...)`. */
export async function fixtureIssueGrant(rawCommerceToken: string, actionId: unknown): Promise<FixtureGrant> {
  assertEnabled();
  const action = need(ACTION, actionId);
  const tokenHash = hashCommerceSessionToken(rawCommerceToken);
  const grantToken = generateCommerceGrantToken();
  const mutationId = randomUUID();
  return withPool("migrator", async (db, pool) => {
    try {
      const result = await pool.query<{ out_grant_id: string; out_expires_at: string }>(
        `SELECT out_grant_id, out_expires_at::text AS out_expires_at
           FROM openarc_durable.issue_authorization_grant_core(
             'internal_fixture', $1, $2, $3, 1, $4::uuid, $5, $6, $7)`,
        [tokenHash, action, hashCommerceGrantToken(grantToken), mutationId,
          db.digestCommerceGrantIdempotencyKey("control.grant.issue", createSessionIdempotencyKey()),
          randomHex64(), db.digestCommerceGrantSessionContext("control.grant.issue", tokenHash)],
      );
      const row = result.rows[0];
      if (row === undefined) fail("FIXTURE_UNAVAILABLE");
      return { grantId: need(GRANT, row.out_grant_id), mutationId, expiresAt: row.out_expires_at, grantToken };
    } catch (error) {
      if (error instanceof TenantFixtureError) throw error;
      throw new FixtureCoreRefusal(sqlstateOf(error));
    }
  });
}

async function claimOnPool(
  db: DbModule,
  pool: DbPool,
  rawProviderToken: string,
  rawGrantToken: string,
  action: string,
  attempt: string,
): Promise<void> {
  const providerHash = hashSessionToken("provider", rawProviderToken);
  const context = db.digestCommerceGrantSessionContext("control.grant.claim", providerHash);
  const mutationId = randomUUID();
  await pool.query(
    `SELECT out_grant_id FROM openarc_durable.claim_authorization_grant_core(
       'internal_fixture', $1, $2, $3, $4::uuid, $5::uuid, $6, $7, $8)`,
    [providerHash, hashCommerceGrantToken(rawGrantToken), action, attempt, mutationId,
      db.digestCommerceGrantIdempotencyKey("control.grant.claim", createSessionIdempotencyKey()),
      db.digestCommerceGrantClaimRequest(context, action, attempt, mutationId), context],
  );
}

/** FIXTURE two-token claim through `claim_authorization_grant_core('internal_fixture', ...)`. */
export async function fixtureClaimGrant(
  rawProviderToken: string,
  rawGrantToken: string,
  actionId: unknown,
  attemptId: unknown,
): Promise<void> {
  assertEnabled();
  const action = need(ACTION, actionId);
  const attempt = need(UUID4, attemptId);
  await withPool("migrator", async (db, pool) => {
    try {
      await claimOnPool(db, pool, rawProviderToken, rawGrantToken, action, attempt);
    } catch (error) {
      throw new FixtureCoreRefusal(sqlstateOf(error));
    }
  });
}

/**
 * FIXTURE concurrency drill: two claims of one grant on two SEPARATE migrator
 * connections released together. Returns only counts and SQLSTATEs.
 */
export async function fixtureConcurrentClaims(
  rawProviderToken: string,
  rawGrantToken: string,
  actionId: unknown,
): Promise<{ readonly winners: number; readonly loserStates: readonly string[] }> {
  assertEnabled();
  const action = need(ACTION, actionId);
  return withPool("migrator", async (db, first) => {
    const fixture = await loadFixtureModule();
    const second = db.createDatabasePool(fixture.migratorUrl());
    try {
      await Promise.all([first.query("SELECT 1"), second.query("SELECT 1")]);
      const outcomes = await Promise.allSettled([
        claimOnPool(db, first, rawProviderToken, rawGrantToken, action, randomUUID()),
        claimOnPool(db, second, rawProviderToken, rawGrantToken, action, randomUUID()),
      ]);
      return {
        winners: outcomes.filter((o) => o.status === "fulfilled").length,
        loserStates: outcomes.flatMap((o) => (o.status === "rejected" ? [sqlstateOf(o.reason)] : [])),
      };
    } finally {
      await second.end().catch(() => undefined);
    }
  });
}

/* -------------------------------------------------------------------------- */
/* Bounded non-secret observations                                             */
/* -------------------------------------------------------------------------- */

export interface CommerceCounts {
  readonly actions: number;
  readonly reservations: number;
  readonly approvals: number;
  readonly decidedApprovals: number;
  readonly grants: number;
  readonly tokens: number;
  readonly claims: number;
  readonly releasedEvents: number;
}

export async function countCommerceRows(organizationId: unknown): Promise<CommerceCounts> {
  assertEnabled();
  const organization = need(ORG, organizationId);
  return withAdmin(async (admin) => {
    const result = await admin.query<CommerceCounts>(
      `SELECT
         (SELECT count(*)::int FROM openarc_durable.commerce_actions WHERE organization_id = $1) AS actions,
         (SELECT count(*)::int FROM openarc_durable.budget_reservations WHERE organization_id = $1) AS reservations,
         (SELECT count(*)::int FROM openarc_durable.commerce_approvals WHERE organization_id = $1) AS approvals,
         (SELECT count(*)::int FROM openarc_durable.commerce_approvals WHERE organization_id = $1 AND decided_at IS NOT NULL) AS "decidedApprovals",
         (SELECT count(*)::int FROM openarc_durable.authorization_grants WHERE organization_id = $1) AS grants,
         (SELECT count(*)::int FROM openarc_durable.authorization_grant_tokens WHERE organization_id = $1) AS tokens,
         (SELECT count(*)::int FROM openarc_durable.authorization_grant_claims WHERE organization_id = $1) AS claims,
         (SELECT count(*)::int FROM openarc_durable.budget_events WHERE organization_id = $1 AND event_kind = 'released') AS "releasedEvents"`,
      [organization],
    );
    const row = result.rows[0];
    if (row === undefined) fail("FIXTURE_UNAVAILABLE");
    return row;
  });
}

export interface ActionState {
  readonly status: string;
  readonly sourceKind: string;
  readonly reservationStatus: string | null;
  readonly approvalStatus: string | null;
}

export async function readActionState(organizationId: unknown, actionId: unknown): Promise<ActionState | null> {
  assertEnabled();
  const organization = need(ORG, organizationId);
  const action = need(ACTION, actionId);
  return withAdmin(async (admin) => {
    const result = await admin.query<{ status: string; source_kind: string; reservation_status: string | null; approval_status: string | null }>(
      `SELECT a.status, a.source_kind, r.status AS reservation_status, ap.status AS approval_status
         FROM openarc_durable.commerce_actions a
         LEFT JOIN openarc_durable.budget_reservations r
           ON r.organization_id = a.organization_id AND r.action_id = a.action_id
         LEFT JOIN openarc_durable.commerce_approvals ap
           ON ap.organization_id = a.organization_id AND ap.action_id = a.action_id
        WHERE a.organization_id = $1 AND a.action_id = $2`,
      [organization, action],
    );
    const row = result.rows[0];
    if (row === undefined) return null;
    return { status: row.status, sourceKind: row.source_kind, reservationStatus: row.reservation_status, approvalStatus: row.approval_status };
  });
}

export interface GrantState {
  readonly status: string;
  readonly generation: number;
  readonly claimed: boolean;
  readonly revoked: boolean;
  readonly claims: number;
  readonly reservationStatus: string | null;
  readonly releasedEvents: number;
  readonly revokeRecords: number;
}

export async function readGrantState(organizationId: unknown, grantId: unknown): Promise<GrantState | null> {
  assertEnabled();
  const organization = need(ORG, organizationId);
  const grant = need(GRANT, grantId);
  return withAdmin(async (admin) => {
    const result = await admin.query<{
      status: string; generation: number; claimed: boolean; revoked: boolean; claims: number;
      reservation_status: string | null; released: number; revoke_records: number;
    }>(
      `SELECT g.status, g.current_generation AS generation,
              g.claimed_at IS NOT NULL AS claimed, g.revoked_at IS NOT NULL AS revoked,
              (SELECT count(*)::int FROM openarc_durable.authorization_grant_claims c
                WHERE c.organization_id = g.organization_id AND c.grant_id = g.grant_id) AS claims,
              r.status AS reservation_status,
              (SELECT count(*)::int FROM openarc_durable.budget_events e
                WHERE e.organization_id = g.organization_id AND e.action_id = g.action_id
                  AND e.event_kind = 'released') AS released,
              (SELECT count(*)::int FROM openarc_durable.idempotency_records i
                WHERE i.organization_id = g.organization_id AND i.resource_id = g.grant_id
                  AND i.operation = 'control.grant.revoke') AS revoke_records
         FROM openarc_durable.authorization_grants g
         LEFT JOIN openarc_durable.budget_reservations r
           ON r.organization_id = g.organization_id AND r.reservation_id = g.reservation_id
        WHERE g.organization_id = $1 AND g.grant_id = $2`,
      [organization, grant],
    );
    const row = result.rows[0];
    if (row === undefined) return null;
    return {
      status: row.status, generation: row.generation, claimed: row.claimed, revoked: row.revoked,
      claims: row.claims, reservationStatus: row.reservation_status, releasedEvents: row.released,
      revokeRecords: row.revoke_records,
    };
  });
}
