import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Type-only import: derives the admin pool shape without executing the module.
import type { adminPool } from "../packages/db/test/postgres-fixture.js";

// The accepted PORT-01 production fixtures own the guarded bootstrap, seeding,
// session and durable-row helpers. This market fixture imports them READONLY and
// adds only the bounded marketplace state/durability observations and the
// fixture-only synthetic moderator grant provisioning the market journeys need.
// It does not copy the guarded setup, and it never returns a session hash,
// token, cookie, CSRF value or idempotency key.
import {
  FIXTURE_ERRORS,
  TenantFixtureError,
  countDurableRows,
  seedAccount,
  seedAgents,
  seedOrganizationWithRole,
  seedOwnOrganizations,
  seedProviders,
} from "../e2e-tenant-write-production/fixture-db.js";

export {
  FIXTURE_ERRORS,
  TenantFixtureError,
  countDurableRows,
  seedAccount,
  seedAgents,
  seedOrganizationWithRole,
  seedOwnOrganizations,
  seedProviders,
};
export type {
  DurableMutationCounts,
} from "../e2e-tenant-write-production/fixture-db.js";
export type {
  FixtureHumanRole,
  SeededOrganization,
  SeededProfile,
} from "../e2e-tenant-production/fixture-db.js";

type AdminPool = ReturnType<typeof adminPool>;

/**
 * Bounded, test-only marketplace durable observations.
 *
 * This module is never imported by the web app or the API. Every function runs
 * behind BOTH `OPENARC_MARKET_PRODUCTION_FIXTURE=1` and
 * `OPENARC_TENANT_PRODUCTION_FIXTURE=1`, and the accepted
 * `packages/db/test/postgres-fixture.ts` guard asserts the exact synthetic
 * loopback PostgreSQL URL BEFORE any connection. It exposes no arbitrary SQL,
 * no session hash, no CSRF token, no idempotency key and no cookie. Every
 * failure is a fixed non-echoing text.
 *
 * The moderator grant insert here is fixture-only administrative provisioning
 * of the real `openarc_tenant.market_moderator_grants` table — it is NOT a
 * product enrollment route and no organization role can confer moderation.
 */

const MARKET_FIXTURE_FLAG = "OPENARC_MARKET_PRODUCTION_FIXTURE";
const TENANT_FIXTURE_FLAG = "OPENARC_TENANT_PRODUCTION_FIXTURE";

const CANONICAL_ACCOUNT_ID =
  /^openarc:account:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const CANONICAL_ORGANIZATION_ID =
  /^openarc:org:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const CANONICAL_LISTING_ID =
  /^openarc:listing:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const CANONICAL_VERSION = /^[1-9][0-9]{0,8}$/u;

function assertMarketEnabled(): void {
  if (process.env[MARKET_FIXTURE_FLAG] !== "1") {
    throw new TenantFixtureError("FIXTURE_DISABLED");
  }
  if (process.env[TENANT_FIXTURE_FLAG] !== "1") {
    throw new TenantFixtureError("FIXTURE_DISABLED");
  }
}

function invalidInput(): never {
  throw new TenantFixtureError("FIXTURE_INPUT_INVALID");
}

function requireCanonicalAccountId(value: unknown): string {
  if (typeof value !== "string" || !CANONICAL_ACCOUNT_ID.test(value)) invalidInput();
  return value;
}

function requireCanonicalOrganizationId(value: unknown): string {
  if (typeof value !== "string" || !CANONICAL_ORGANIZATION_ID.test(value)) invalidInput();
  return value;
}

function requireCanonicalListingId(value: unknown): string {
  if (typeof value !== "string" || !CANONICAL_LISTING_ID.test(value)) invalidInput();
  return value;
}

function requireCanonicalVersion(value: unknown): string {
  if (typeof value !== "string" || !CANONICAL_VERSION.test(value)) invalidInput();
  return value;
}

/**
 * Loads the accepted guarded fixture module (which asserts the exact synthetic
 * loopback database URL at import time) ONLY after both explicit opt-ins are
 * set. The guard runs before any connection.
 */
async function loadFixtureModule() {
  assertMarketEnabled();
  try {
    return await import("../packages/db/test/postgres-fixture.js");
  } catch {
    throw new TenantFixtureError("FIXTURE_UNAVAILABLE");
  }
}

async function withAdmin<T>(work: (admin: AdminPool) => Promise<T>): Promise<T> {
  assertMarketEnabled();
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

/* -------------------------------------------------------------------------- */
/* Fixture-only synthetic moderator grant provisioning                        */
/* -------------------------------------------------------------------------- */

export interface ModeratorGrantRow {
  readonly accountId: string;
  readonly status: string;
}

/**
 * Fixture-only administrative grant of account-level moderation authority.
 * The browser account is still created through the real passkey UI; this only
 * provisions the explicit real table the accepted moderator store reads. It is
 * never a product route and never derives moderation from an organization role.
 */
export async function seedModeratorGrant(accountId: unknown): Promise<void> {
  const account = requireCanonicalAccountId(accountId);
  await withAdmin(async (admin) => {
    await admin.query(
      `INSERT INTO openarc_tenant.market_moderator_grants (account_id, status)
       VALUES ($1, 'active')
       ON CONFLICT (account_id)
       DO UPDATE SET status = 'active', updated_at = clock_timestamp()`,
      [account],
    );
  });
}

/** Fixture-only revocation of a synthetic moderator grant. */
export async function revokeModeratorGrant(accountId: unknown): Promise<void> {
  const account = requireCanonicalAccountId(accountId);
  await withAdmin(async (admin) => {
    await admin.query(
      `UPDATE openarc_tenant.market_moderator_grants
          SET status = 'revoked', updated_at = clock_timestamp()
        WHERE account_id = $1`,
      [account],
    );
  });
}

export async function readModeratorGrant(
  accountId: unknown,
): Promise<ModeratorGrantRow | null> {
  const account = requireCanonicalAccountId(accountId);
  return withAdmin(async (admin) => {
    const result = await admin.query<{ account_id: string; status: string }>(
      `SELECT account_id, status
         FROM openarc_tenant.market_moderator_grants
        WHERE account_id = $1`,
      [account],
    );
    const row = result.rows[0];
    if (row === undefined) return null;
    return { accountId: row.account_id, status: row.status };
  });
}

/* -------------------------------------------------------------------------- */
/* Bounded marketplace state observations                                     */
/* -------------------------------------------------------------------------- */

export interface ListingRootRow {
  readonly organizationId: string;
  readonly providerId: string;
  readonly listingId: string;
  readonly latestVersion: string;
  readonly activeVersion: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export async function readListingRoot(
  organizationId: unknown,
  listingId: unknown,
): Promise<ListingRootRow | null> {
  const organization = requireCanonicalOrganizationId(organizationId);
  const listing = requireCanonicalListingId(listingId);
  return withAdmin(async (admin) => {
    const result = await admin.query<{
      organization_id: string;
      provider_id: string;
      listing_id: string;
      latest_version: string;
      active_version: string | null;
      created_at: string;
      updated_at: string;
    }>(
      `SELECT organization_id, provider_id, listing_id, latest_version,
              active_version,
              to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at,
              to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS updated_at
         FROM openarc_tenant.listings
        WHERE organization_id = $1 AND listing_id = $2`,
      [organization, listing],
    );
    const row = result.rows[0];
    if (row === undefined) return null;
    return {
      organizationId: row.organization_id,
      providerId: row.provider_id,
      listingId: row.listing_id,
      latestVersion: row.latest_version,
      activeVersion: row.active_version,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  });
}

export interface ListingVersionStateRow {
  readonly status: string;
  readonly originReviewState: string;
  readonly publishedAt: string | null;
  readonly updatedAt: string;
}

export async function readListingVersionState(
  organizationId: unknown,
  listingId: unknown,
  version: unknown,
): Promise<ListingVersionStateRow | null> {
  const organization = requireCanonicalOrganizationId(organizationId);
  const listing = requireCanonicalListingId(listingId);
  const parsedVersion = requireCanonicalVersion(version);
  return withAdmin(async (admin) => {
    const result = await admin.query<{
      status: string;
      origin_review_state: string;
      published_at: string | null;
      updated_at: string;
    }>(
      `SELECT status, origin_review_state,
              to_char(published_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS published_at,
              to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS updated_at
         FROM openarc_tenant.listing_version_states
        WHERE organization_id = $1 AND listing_id = $2 AND version = $3`,
      [organization, listing, parsedVersion],
    );
    const row = result.rows[0];
    if (row === undefined) return null;
    return {
      status: row.status,
      originReviewState: row.origin_review_state,
      publishedAt: row.published_at,
      updatedAt: row.updated_at,
    };
  });
}

export interface ListingVersionContentRow {
  readonly providerId: string;
  readonly kind: string;
  readonly title: string;
  readonly description: string;
  readonly priceAtomicAmount: string;
  readonly priceDecimals: number;
  readonly endpointOrigin: string;
  readonly endpointPath: string;
  readonly termsRevision: string;
  readonly privacySummary: string;
}

/**
 * Reads only the bounded non-secret content fields needed to prove the exact
 * published price/kind/origin and the owner-only endpoint path. No account,
 * session, key or arbitrary record is exposed.
 */
export async function readListingVersionContent(
  organizationId: unknown,
  listingId: unknown,
  version: unknown,
): Promise<ListingVersionContentRow | null> {
  const organization = requireCanonicalOrganizationId(organizationId);
  const listing = requireCanonicalListingId(listingId);
  const parsedVersion = requireCanonicalVersion(version);
  return withAdmin(async (admin) => {
    const result = await admin.query<{
      provider_id: string;
      kind: string;
      title: string;
      description: string;
      price: { amount?: { atomicAmount?: unknown; decimals?: unknown } };
      endpoint_contract: { origin?: unknown; path?: unknown };
      terms_revision: string;
      privacy_summary: string;
    }>(
      `SELECT provider_id, kind, title, description, price,
              endpoint_contract, terms_revision, privacy_summary
         FROM openarc_tenant.listing_versions
        WHERE organization_id = $1 AND listing_id = $2 AND version = $3`,
      [organization, listing, parsedVersion],
    );
    const row = result.rows[0];
    if (row === undefined) return null;
    const atomic = row.price.amount?.atomicAmount;
    const decimals = row.price.amount?.decimals;
    const origin = row.endpoint_contract.origin;
    const path = row.endpoint_contract.path;
    if (typeof atomic !== "string" || typeof decimals !== "number") invalidInput();
    if (typeof origin !== "string" || typeof path !== "string") invalidInput();
    return {
      providerId: row.provider_id,
      kind: row.kind,
      title: row.title,
      description: row.description,
      priceAtomicAmount: atomic,
      priceDecimals: decimals,
      endpointOrigin: origin,
      endpointPath: path,
      termsRevision: row.terms_revision,
      privacySummary: row.privacy_summary,
    };
  });
}

export async function countListingVersions(
  organizationId: unknown,
  listingId: unknown,
): Promise<number> {
  const organization = requireCanonicalOrganizationId(organizationId);
  const listing = requireCanonicalListingId(listingId);
  return withAdmin(async (admin) => {
    const result = await admin.query<{ count: number }>(
      `SELECT count(*)::int AS count
         FROM openarc_tenant.listing_versions
        WHERE organization_id = $1 AND listing_id = $2`,
      [organization, listing],
    );
    return result.rows[0]?.count ?? 0;
  });
}

export interface OriginReviewRow {
  readonly decision: string;
  readonly reviewerAccountId: string;
  readonly mutationId: string;
  readonly reviewedEndpointDigest: string;
}

export async function readOriginReview(
  organizationId: unknown,
  listingId: unknown,
  version: unknown,
): Promise<OriginReviewRow | null> {
  const organization = requireCanonicalOrganizationId(organizationId);
  const listing = requireCanonicalListingId(listingId);
  const parsedVersion = requireCanonicalVersion(version);
  return withAdmin(async (admin) => {
    const result = await admin.query<{
      decision: string;
      reviewer_account_id: string;
      mutation_id: string;
      reviewed_endpoint_digest: string;
    }>(
      `SELECT decision, reviewer_account_id, mutation_id, reviewed_endpoint_digest
         FROM openarc_tenant.listing_origin_reviews
        WHERE organization_id = $1 AND listing_id = $2 AND version = $3
        ORDER BY created_at DESC
        LIMIT 1`,
      [organization, listing, parsedVersion],
    );
    const row = result.rows[0];
    if (row === undefined) return null;
    return {
      decision: row.decision,
      reviewerAccountId: row.reviewer_account_id,
      mutationId: row.mutation_id,
      reviewedEndpointDigest: row.reviewed_endpoint_digest,
    };
  });
}

function isDirectRun(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return realpathSync(resolve(entry)) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isDirectRun()) {
  // Any direct invocation is import-only: no DB operation runs. Prepare/migrate
  // stays owned by the accepted read production fixture and runs once BEFORE
  // API startup, never from a test hook.
  void FIXTURE_ERRORS;
}
