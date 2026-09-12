import { randomBytes, randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Type-only imports do not execute these modules. Pool types are derived from
// the workspace signatures, which resolve their own `pg` dependency.
import type { adminPool } from "../packages/db/test/postgres-fixture.js";

// The accepted PORT-01 production fixture owns the guarded bootstrap, seeding
// and session helpers. This write fixture imports them READONLY and adds only
// the bounded durable-row/session observations the write journeys need; it
// does not copy the ~600-line guarded setup.
import {
  FIXTURE_ERRORS,
  TenantFixtureError,
  deleteAccountSessions,
  expireAccountSessions,
  holdOrganizationRowLock,
  prepareProductionFixture,
  seedAccount,
  seedAgents,
  seedMembership,
  seedOrganizationWithRole,
  seedOwnOrganizations,
  seedProviders,
  setMembershipRole,
  waitForAccountSessionExpiry,
  waitForBlockedTenantRead,
} from "../e2e-tenant-production/fixture-db.js";

export {
  FIXTURE_ERRORS,
  TenantFixtureError,
  deleteAccountSessions,
  expireAccountSessions,
  holdOrganizationRowLock,
  prepareProductionFixture,
  seedAccount,
  seedAgents,
  seedMembership,
  seedOrganizationWithRole,
  seedOwnOrganizations,
  seedProviders,
  setMembershipRole,
  waitForAccountSessionExpiry,
  waitForBlockedTenantRead,
};
export type {
  FixtureHumanRole,
  FixtureMembershipStatus,
  HeldTenantLock,
  SeededOrganization,
  SeededProfile,
} from "../e2e-tenant-production/fixture-db.js";

type AdminPool = ReturnType<typeof adminPool>;

/**
 * Bounded, test-only durable tenant-write observations.
 *
 * This module is never imported by the web app or the API. Every function
 * runs behind the explicit `OPENARC_TENANT_PRODUCTION_FIXTURE=1` opt-in and
 * the accepted `packages/db/test/postgres-fixture.ts` guard that asserts the
 * exact synthetic loopback PostgreSQL URL BEFORE any connection. It exposes
 * no arbitrary SQL, no session hash, no CSRF token, no idempotency key and no
 * cookie. Every failure is a fixed non-echoing text.
 */

const FIXTURE_FLAG = "OPENARC_TENANT_PRODUCTION_FIXTURE";

const CANONICAL_ACCOUNT_ID =
  /^openarc:account:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const CANONICAL_ORGANIZATION_ID =
  /^openarc:org:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const CANONICAL_MUTATION_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

function fail(code: (typeof FIXTURE_ERRORS)[keyof typeof FIXTURE_ERRORS]): never {
  throw new TenantFixtureError(code);
}

function assertEnabled(): void {
  if (process.env[FIXTURE_FLAG] !== "1") fail("FIXTURE_DISABLED");
}

async function loadFixtureModule() {
  assertEnabled();
  try {
    return await import("../packages/db/test/postgres-fixture.js");
  } catch {
    fail("FIXTURE_UNAVAILABLE");
  }
}

async function withAdmin<T>(work: (admin: AdminPool) => Promise<T>): Promise<T> {
  assertEnabled();
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

function requireCanonicalAccountId(value: unknown): string {
  if (typeof value !== "string" || !CANONICAL_ACCOUNT_ID.test(value)) {
    fail("FIXTURE_INPUT_INVALID");
  }
  return value;
}

function requireCanonicalOrganizationId(value: unknown): string {
  if (typeof value !== "string" || !CANONICAL_ORGANIZATION_ID.test(value)) {
    fail("FIXTURE_INPUT_INVALID");
  }
  return value;
}

function requireCanonicalMutationId(value: unknown): string {
  if (typeof value !== "string" || !CANONICAL_MUTATION_ID.test(value)) {
    fail("FIXTURE_INPUT_INVALID");
  }
  return value;
}

export interface DurableMutationCounts {
  readonly idempotency: number;
  readonly audit: number;
  readonly outbox: number;
}

/**
 * Exact per-receipt durable counts. A committed write must have exactly one
 * idempotency row, one audit row and one outbox row for its mutation id.
 */
export async function countDurableRows(
  organizationId: unknown,
  mutationId: unknown,
): Promise<DurableMutationCounts> {
  const organization = requireCanonicalOrganizationId(organizationId);
  const mutation = requireCanonicalMutationId(mutationId);
  return withAdmin(async (admin) => {
    const result = await admin.query<{
      idempotency: number;
      audit: number;
      outbox: number;
    }>(
      `SELECT
         (SELECT count(*)::int FROM openarc_durable.idempotency_records r
           WHERE r.organization_id = $1 AND r.mutation_id = $2) AS idempotency,
         (SELECT count(*)::int FROM openarc_durable.audit_events a
           WHERE a.organization_id = $1 AND a.mutation_id = $2) AS audit,
         (SELECT count(*)::int FROM openarc_durable.outbox_events o
           WHERE o.organization_id = $1 AND o.mutation_id = $2) AS outbox`,
      [organization, mutation],
    );
    const row = result.rows[0];
    return {
      idempotency: row?.idempotency ?? 0,
      audit: row?.audit ?? 0,
      outbox: row?.outbox ?? 0,
    };
  });
}

/** Exact committed receipt fields for a mutation, or null when absent. */
export interface DurableReceiptRow {
  readonly mutationId: string;
  readonly operation: string;
  readonly resourceType: string;
  readonly resourceId: string;
}

export async function readDurableReceipt(
  organizationId: unknown,
  mutationId: unknown,
): Promise<DurableReceiptRow | null> {
  const organization = requireCanonicalOrganizationId(organizationId);
  const mutation = requireCanonicalMutationId(mutationId);
  return withAdmin(async (admin) => {
    const result = await admin.query<{
      mutation_id: string;
      operation: string;
      resource_type: string;
      resource_id: string;
    }>(
      `SELECT r.mutation_id, r.operation, r.resource_type, r.resource_id
         FROM openarc_durable.idempotency_records r
        WHERE r.organization_id = $1 AND r.mutation_id = $2
          AND r.status = 'committed'`,
      [organization, mutation],
    );
    const row = result.rows[0];
    if (row === undefined) return null;
    return {
      mutationId: row.mutation_id,
      operation: row.operation,
      resourceType: row.resource_type,
      resourceId: row.resource_id,
    };
  });
}

export interface OrganizationRow {
  readonly organizationId: string;
  readonly displayName: string;
  readonly createdBy: string;
}

export async function readOrganizationRow(
  organizationId: unknown,
): Promise<OrganizationRow | null> {
  const organization = requireCanonicalOrganizationId(organizationId);
  return withAdmin(async (admin) => {
    const result = await admin.query<{
      organization_id: string;
      display_name: string;
      created_by: string;
    }>(
      `SELECT organization_id, display_name, created_by
         FROM openarc_tenant.organizations WHERE organization_id = $1`,
      [organization],
    );
    const row = result.rows[0];
    if (row === undefined) return null;
    return {
      organizationId: row.organization_id,
      displayName: row.display_name,
      createdBy: row.created_by,
    };
  });
}

export interface ProfileRow {
  readonly displayName: string;
  readonly status: string;
}

export async function readAgentRow(
  organizationId: unknown,
  agentId: unknown,
): Promise<ProfileRow | null> {
  const organization = requireCanonicalOrganizationId(organizationId);
  if (
    typeof agentId !== "string" ||
    !/^openarc:agent:[0-9a-f-]{36}$/u.test(agentId)
  ) {
    fail("FIXTURE_INPUT_INVALID");
  }
  return withAdmin(async (admin) => {
    const result = await admin.query<{ display_name: string; status: string }>(
      `SELECT display_name, status FROM openarc_tenant.agents
        WHERE organization_id = $1 AND agent_id = $2`,
      [organization, agentId],
    );
    const row = result.rows[0];
    if (row === undefined) return null;
    return { displayName: row.display_name, status: row.status };
  });
}

export async function readProviderRow(
  organizationId: unknown,
  providerId: unknown,
): Promise<ProfileRow | null> {
  const organization = requireCanonicalOrganizationId(organizationId);
  if (
    typeof providerId !== "string" ||
    !/^openarc:provider:[0-9a-f-]{36}$/u.test(providerId)
  ) {
    fail("FIXTURE_INPUT_INVALID");
  }
  return withAdmin(async (admin) => {
    const result = await admin.query<{ display_name: string; status: string }>(
      `SELECT display_name, status FROM openarc_tenant.providers
        WHERE organization_id = $1 AND provider_id = $2`,
      [organization, providerId],
    );
    const row = result.rows[0];
    if (row === undefined) return null;
    return { displayName: row.display_name, status: row.status };
  });
}

export interface MembershipRow {
  readonly role: string;
  readonly status: string;
}

export async function readMembershipRow(
  organizationId: unknown,
  accountId: unknown,
): Promise<MembershipRow | null> {
  const organization = requireCanonicalOrganizationId(organizationId);
  const account = requireCanonicalAccountId(accountId);
  return withAdmin(async (admin) => {
    const result = await admin.query<{ role: string; status: string }>(
      `SELECT role, status FROM openarc_tenant.memberships
        WHERE organization_id = $1 AND account_id = $2`,
      [organization, account],
    );
    const row = result.rows[0];
    if (row === undefined) return null;
    return { role: row.role, status: row.status };
  });
}

/**
 * Count an account's live sessions. Used to prove a self-demotion actually
 * revoked the committing session at the database, without ever reading a hash.
 */
export async function countAccountSessions(
  accountId: unknown,
): Promise<number> {
  const account = requireCanonicalAccountId(accountId);
  return withAdmin(async (admin) => {
    const result = await admin.query<{ sessions: number }>(
      `SELECT count(*)::int AS sessions FROM openarc_auth.sessions
        WHERE account_id = $1 AND expires_at > clock_timestamp()`,
      [account],
    );
    return result.rows[0]?.sessions ?? 0;
  });
}

/**
 * Test-only stale-proof setup. Moves every session for an account to a
 * server-side `created_at` older than the 5-minute proof window while keeping
 * `expires_at` in the future and inside the schema's created/expiry bound.
 * This changes the real proof timestamp; it does NOT fake a proof or expiry.
 */
export async function ageAccountSessionProof(
  accountId: unknown,
  ageSeconds: unknown,
): Promise<number> {
  const account = requireCanonicalAccountId(accountId);
  if (
    typeof ageSeconds !== "number" ||
    !Number.isInteger(ageSeconds) ||
    ageSeconds < 300 ||
    ageSeconds > 3_600
  ) {
    fail("FIXTURE_INPUT_INVALID");
  }
  return withAdmin(async (admin) => {
    const result = await admin.query(
      `UPDATE openarc_auth.sessions
          SET created_at = clock_timestamp() - ($2 || ' seconds')::interval,
              expires_at = clock_timestamp() + interval '30 minutes'
        WHERE account_id = $1`,
      [account, String(ageSeconds)],
    );
    return result.rowCount ?? 0;
  });
}

/**
 * Seed one additional synthetic registered account with no credential. Reuses
 * the accepted `seedAccount` shape so membership targets are real accounts.
 */
export async function seedRegisteredAccount(): Promise<string> {
  return seedAccount();
}

/**
 * Mint a fresh synthetic passkey-method session for a seeded account without
 * exposing the hash. Used ONLY by the write fixture to drive the real durable
 * helpers where a test needs a second owner with its own session. The hash is
 * internal to this call and is never returned.
 */
export async function seedFreshPasskeySession(
  accountId: unknown,
): Promise<void> {
  const account = requireCanonicalAccountId(accountId);
  await withAdmin(async (admin) => {
    const hash = randomBytes(32).toString("hex");
    await admin.query(
      `INSERT INTO openarc_auth.sessions (token_hash, account_id, method, created_at, expires_at)
       VALUES ($1, $2, 'passkey', clock_timestamp(), clock_timestamp() + interval '30 minutes')`,
      [hash, account],
    );
  });
}

function isDirectRun(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return (
      realpathSync(resolve(entry)) === realpathSync(fileURLToPath(import.meta.url))
    );
  } catch {
    return false;
  }
}

if (isDirectRun()) {
  // Any direct invocation is import-only: no DB operation runs. The accepted
  // prepare entry point stays owned by the read production fixture.
  void randomUUID;
}
