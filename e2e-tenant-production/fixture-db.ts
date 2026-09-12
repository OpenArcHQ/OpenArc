import { randomBytes, randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Type-only imports do not execute these modules. Pool types are derived from
// the workspace signatures, which resolve their own `pg` dependency.
import type { adminPool } from "../packages/db/test/postgres-fixture.js";
import type { createDatabasePool } from "../packages/db/src/index.js";

type AdminPool = ReturnType<typeof adminPool>;
type DbPool = ReturnType<typeof createDatabasePool>;

/**
 * Minimal structural client port. `pg`'s `connect` is overloaded (the
 * callback overload returns void), so the client type is stated directly and
 * the narrow cast below keeps this fixture independent of overload pick order.
 */
interface AdminClient {
  query<T extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    values?: unknown[],
  ): Promise<{ rows: T[]; rowCount: number | null }>;
  release(destroy?: boolean): void;
}

/**
 * NODE/TEST-ONLY disposable PostgreSQL fixture for PORT-01 tenant acceptance.
 *
 * This module is never imported by the web app or the API. It reuses the
 * accepted guarded `packages/db/test/postgres-fixture.ts` bootstrap (which
 * asserts the exact synthetic admin URL) and the source `@openarc/db`
 * exports. Every path here is behind an explicit production-fixture flag
 * guard that runs BEFORE any database operation.
 *
 * Boundaries enforced on purpose:
 *  - No generic arbitrary SQL is exposed to callers.
 *  - No raw session hash is ever returned, printed or logged. The membership
 *    helper mints its own synthetic admin-side session internally, hands it
 *    only to the accepted `TenantStore.setMembership`, and discards it.
 *  - Every failure is a fixed text; driver detail, URLs, stacks and cookie
 *    dumps are never surfaced.
 */

const FIXTURE_FLAG = "OPENARC_TENANT_PRODUCTION_FIXTURE";

const CANONICAL_ACCOUNT_ID =
  /^openarc:account:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const CANONICAL_ORGANIZATION_ID =
  /^openarc:org:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const HEX64 = /^[0-9a-f]{64}$/u;

export const FIXTURE_ERRORS = {
  FIXTURE_DISABLED: "FIXTURE_DISABLED",
  FIXTURE_INPUT_INVALID: "FIXTURE_INPUT_INVALID",
  FIXTURE_UNAVAILABLE: "FIXTURE_UNAVAILABLE",
} as const;

export type FixtureErrorCode =
  (typeof FIXTURE_ERRORS)[keyof typeof FIXTURE_ERRORS];

/** Fixed, non-echoing fixture error. Never carries driver detail. */
export class TenantFixtureError extends Error {
  readonly code: FixtureErrorCode;

  constructor(code: FixtureErrorCode) {
    super(code);
    this.name = "TenantFixtureError";
    this.code = code;
  }
}

export type FixtureHumanRole =
  | "owner"
  | "operator"
  | "provider_admin"
  | "provider_developer"
  | "viewer";

export type FixtureMembershipStatus = "active" | "suspended";

export interface SeededOrganization {
  readonly organizationId: string;
  readonly displayName: string;
}

export interface SeededProfile {
  readonly id: string;
  readonly displayName: string;
  readonly status: "active" | "suspended" | "revoked" | "retired";
}

/** A held real row lock; callers MUST release in a finally. */
export interface HeldTenantLock {
  release(): Promise<void>;
}

const MAX_SEEDED_PROFILES = 101;
const MAX_SEEDED_ORGANIZATIONS = 12;

function fail(code: FixtureErrorCode): never {
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

async function loadDbModule() {
  assertEnabled();
  try {
    return await import("../packages/db/src/index.js");
  } catch {
    fail("FIXTURE_UNAVAILABLE");
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

function requireRole(value: unknown): FixtureHumanRole {
  if (
    value !== "owner" &&
    value !== "operator" &&
    value !== "provider_admin" &&
    value !== "provider_developer" &&
    value !== "viewer"
  ) {
    fail("FIXTURE_INPUT_INVALID");
  }
  return value;
}

function requireStatus(value: unknown): FixtureMembershipStatus {
  if (value !== "active" && value !== "suspended") fail("FIXTURE_INPUT_INVALID");
  return value;
}

function requireDisplayName(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 100 ||
    value !== value.trim() ||
    /\p{Cc}/u.test(value)
  ) {
    fail("FIXTURE_INPUT_INVALID");
  }
  return value;
}

function requireProfileCount(value: unknown): number {
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < 0 ||
    value > MAX_SEEDED_PROFILES
  ) {
    fail("FIXTURE_INPUT_INVALID");
  }
  return value;
}

function requireExpirySeconds(value: unknown): number {
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < 1 ||
    value > 3_600
  ) {
    fail("FIXTURE_INPUT_INVALID");
  }
  return value;
}

function newOrganizationId(): string {
  return `openarc:org:${randomUUID()}`;
}

function newAccountId(): string {
  return `openarc:account:${randomUUID()}`;
}

function newUserHandle(): string {
  return randomBytes(32).toString("base64url");
}

function newSessionHash(): string {
  const hash = randomBytes(32).toString("hex");
  if (!HEX64.test(hash)) fail("FIXTURE_UNAVAILABLE");
  return hash;
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

/**
 * Lead entry point. Reset ONLY the disposable fixture database, ensure the
 * four fixture roles and apply the bundled migrations exactly once BEFORE the
 * API starts. Never call this from a browser test while the API is running.
 */
export async function prepareProductionFixture(): Promise<void> {
  assertEnabled();
  const fixture = await loadFixtureModule();
  const db = await loadDbModule();
  const admin = fixture.adminPool();
  const migrator = db.createDatabasePool(fixture.migratorUrl());
  try {
    await fixture.ensureRoles(admin);
    await fixture.resetSchema(admin);
    await db.migrate(migrator, db.loadMigrations());
  } catch (error) {
    if (error instanceof TenantFixtureError) throw error;
    fail("FIXTURE_UNAVAILABLE");
  } finally {
    await Promise.allSettled([migrator.end(), admin.end()]);
  }
}

/** Create one synthetic active account with no credential. Returns its id. */
export async function seedAccount(): Promise<string> {
  return withAdmin(async (admin) => {
    const accountId = newAccountId();
    await admin.query(
      `INSERT INTO openarc_auth.accounts (account_id, user_handle, status)
       VALUES ($1, $2, 'active')`,
      [accountId, newUserHandle()],
    );
    return accountId;
  });
}

/**
 * Seed organizations OWNED by `accountId`, each with its own active owner
 * membership. Returns the canonical organization descriptors.
 */
export async function seedOwnOrganizations(
  accountId: unknown,
  displayNames: readonly string[],
): Promise<readonly SeededOrganization[]> {
  const owner = requireCanonicalAccountId(accountId);
  if (
    !Array.isArray(displayNames) ||
    displayNames.length < 1 ||
    displayNames.length > MAX_SEEDED_ORGANIZATIONS
  ) {
    fail("FIXTURE_INPUT_INVALID");
  }
  const names = displayNames.map((name) => requireDisplayName(name));
  return withAdmin(async (admin) => {
    const seeded: SeededOrganization[] = [];
    for (const displayName of names) {
      const organizationId = newOrganizationId();
      await admin.query(
        `INSERT INTO openarc_tenant.organizations (organization_id, display_name, created_by)
         VALUES ($1, $2, $3)`,
        [organizationId, displayName, owner],
      );
      await admin.query(
        `INSERT INTO openarc_tenant.memberships (organization_id, account_id, role, status)
         VALUES ($1, $2, 'owner', 'active')`,
        [organizationId, owner],
      );
      seeded.push({ organizationId, displayName });
    }
    return seeded;
  });
}

/**
 * Seed an organization owned by `ownerAccountId` where `memberAccountId` holds
 * the requested active role. Used for the accepted read matrix; this does NOT
 * claim a role-management UI journey.
 */
export async function seedOrganizationWithRole(
  ownerAccountId: unknown,
  memberAccountId: unknown,
  displayName: unknown,
  role: unknown,
): Promise<SeededOrganization> {
  const owner = requireCanonicalAccountId(ownerAccountId);
  const member = requireCanonicalAccountId(memberAccountId);
  const name = requireDisplayName(displayName);
  const seededRole = requireRole(role);
  return withAdmin(async (admin) => {
    const organizationId = newOrganizationId();
    await admin.query(
      `INSERT INTO openarc_tenant.organizations (organization_id, display_name, created_by)
       VALUES ($1, $2, $3)`,
      [organizationId, name, owner],
    );
    await admin.query(
      `INSERT INTO openarc_tenant.memberships (organization_id, account_id, role, status)
       VALUES ($1, $2, 'owner', 'active')`,
      [organizationId, owner],
    );
    if (member !== owner) {
      await admin.query(
        `INSERT INTO openarc_tenant.memberships (organization_id, account_id, role, status)
         VALUES ($1, $2, $3, 'active')`,
        [organizationId, member, seededRole],
      );
    }
    return { organizationId, displayName: name };
  });
}

/** Add or replace one active/suspended membership for an existing account. */
export async function seedMembership(
  organizationId: unknown,
  accountId: unknown,
  role: unknown,
  status: unknown = "active",
): Promise<void> {
  const organization = requireCanonicalOrganizationId(organizationId);
  const account = requireCanonicalAccountId(accountId);
  const seededRole = requireRole(role);
  const seededStatus = requireStatus(status);
  await withAdmin(async (admin) => {
    await admin.query(
      `INSERT INTO openarc_tenant.memberships (organization_id, account_id, role, status)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (organization_id, account_id)
       DO UPDATE SET role = EXCLUDED.role, status = EXCLUDED.status, updated_at = clock_timestamp()`,
      [organization, account, seededRole, seededStatus],
    );
  });
}

function profileName(kind: "agent" | "provider", index: number): string {
  const number = String(index + 1).padStart(3, "0");
  return kind === "agent" ? `Fixture Agent ${number}` : `Fixture Provider ${number}`;
}

/** Seed up to 101 active agents in one organization. */
export async function seedAgents(
  organizationId: unknown,
  count: unknown,
): Promise<readonly SeededProfile[]> {
  const organization = requireCanonicalOrganizationId(organizationId);
  const total = requireProfileCount(count);
  return withAdmin(async (admin) => {
    const seeded: SeededProfile[] = [];
    for (let index = 0; index < total; index += 1) {
      const id = `openarc:agent:${randomUUID()}`;
      const displayName = profileName("agent", index);
      await admin.query(
        `INSERT INTO openarc_tenant.agents (organization_id, agent_id, display_name, status)
         VALUES ($1, $2, $3, 'active')`,
        [organization, id, displayName],
      );
      seeded.push({ id, displayName, status: "active" });
    }
    return seeded;
  });
}

/** Seed up to 101 active providers in one organization. */
export async function seedProviders(
  organizationId: unknown,
  count: unknown,
): Promise<readonly SeededProfile[]> {
  const organization = requireCanonicalOrganizationId(organizationId);
  const total = requireProfileCount(count);
  return withAdmin(async (admin) => {
    const seeded: SeededProfile[] = [];
    for (let index = 0; index < total; index += 1) {
      const id = `openarc:provider:${randomUUID()}`;
      const displayName = profileName("provider", index);
      await admin.query(
        `INSERT INTO openarc_tenant.providers (organization_id, provider_id, display_name, status)
         VALUES ($1, $2, $3, 'active')`,
        [organization, id, displayName],
      );
      seeded.push({ id, displayName, status: "active" });
    }
    return seeded;
  });
}

/**
 * Owner-only membership mutation through the accepted `TenantStore`.
 * setMembership, so an actual role/status change performs the real session
 * revocation. A synthetic admin-side session is minted internally and never
 * returned or logged.
 */
export async function setMembershipRole(
  callerAccountId: unknown,
  organizationId: unknown,
  targetAccountId: unknown,
  role: unknown,
  status: unknown,
): Promise<void> {
  assertEnabled();
  const caller = requireCanonicalAccountId(callerAccountId);
  const organization = requireCanonicalOrganizationId(organizationId);
  const target = requireCanonicalAccountId(targetAccountId);
  const requestedRole = requireRole(role);
  const requestedStatus = requireStatus(status);
  const fixture = await loadFixtureModule();
  const db = await loadDbModule();
  const admin = fixture.adminPool();
  let tenantPool: DbPool | undefined;
  try {
    const sessionHash = newSessionHash();
    await admin.query(
      `INSERT INTO openarc_auth.sessions (token_hash, account_id, method, created_at, expires_at)
       VALUES ($1, $2, 'passkey', clock_timestamp(), clock_timestamp() + interval '30 minutes')`,
      [sessionHash, caller],
    );
    tenantPool = db.createDatabasePool(fixture.tenantUrl());
    const store = new db.TenantStore(db.asTenantPool(tenantPool));
    await store.setMembership(
      sessionHash,
      organization,
      target,
      requestedRole,
      requestedStatus,
    );
  } catch (error) {
    if (error instanceof TenantFixtureError) throw error;
    fail("FIXTURE_UNAVAILABLE");
  } finally {
    if (tenantPool !== undefined) await tenantPool.end().catch(() => undefined);
    await admin.end().catch(() => undefined);
  }
}

/**
 * Move every existing session for an account to a server-side expiry a few
 * seconds ahead (never already expired). Returns the affected count.
 */
export async function expireAccountSessions(
  accountId: unknown,
  expiresInSeconds: unknown,
): Promise<number> {
  const account = requireCanonicalAccountId(accountId);
  const seconds = requireExpirySeconds(expiresInSeconds);
  return withAdmin(async (admin) => {
    const result = await admin.query(
      `UPDATE openarc_auth.sessions
          SET expires_at = clock_timestamp() + ($2 || ' seconds')::interval
        WHERE account_id = $1`,
      [account, String(seconds)],
    );
    return result.rowCount ?? 0;
  });
}

/** Delete every session for an account. Returns the affected count. */
export async function deleteAccountSessions(accountId: unknown): Promise<number> {
  const account = requireCanonicalAccountId(accountId);
  return withAdmin(async (admin) => {
    const result = await admin.query(
      "DELETE FROM openarc_auth.sessions WHERE account_id = $1",
      [account],
    );
    return result.rowCount ?? 0;
  });
}

/**
 * Bounded, database-clock observation that at least one session for an
 * account has actually expired. No arbitrary client-side sleep is used for
 * authorization decisions.
 */
export async function waitForAccountSessionExpiry(
  accountId: unknown,
  timeoutMillis: number,
): Promise<boolean> {
  const account = requireCanonicalAccountId(accountId);
  if (
    !Number.isInteger(timeoutMillis) ||
    timeoutMillis < 1 ||
    timeoutMillis > 30_000
  ) {
    fail("FIXTURE_INPUT_INVALID");
  }
  return withAdmin(async (admin) => {
    const deadline = Date.now() + timeoutMillis;
    for (;;) {
      const result = await admin.query<{ expired: number }>(
        `SELECT count(*)::int AS expired
           FROM openarc_auth.sessions
          WHERE account_id = $1 AND expires_at <= clock_timestamp()`,
        [account],
      );
      if ((result.rows[0]?.expired ?? 0) > 0) return true;
      if (Date.now() >= deadline) return false;
      await new Promise<void>((resolveTick) => setTimeout(resolveTick, 50));
    }
  });
}

/**
 * Hold the real organization row lock used by the tenant read path, so a real
 * GET can be observed waiting on the lock barrier. Always release in a finally.
 */
export async function holdOrganizationRowLock(
  organizationId: unknown,
): Promise<HeldTenantLock> {
  const organization = requireCanonicalOrganizationId(organizationId);
  assertEnabled();
  const fixture = await loadFixtureModule();
  const pool = fixture.adminPool();
  let client: AdminClient;
  try {
    client = (await pool.connect()) as unknown as AdminClient;
    await client.query("BEGIN");
    await client.query(
      "SELECT 1 FROM openarc_tenant.organizations WHERE organization_id = $1 FOR UPDATE",
      [organization],
    );
  } catch (error) {
    await pool.end().catch(() => undefined);
    if (error instanceof TenantFixtureError) throw error;
    fail("FIXTURE_UNAVAILABLE");
  }
  let released = false;
  return {
    async release(): Promise<void> {
      if (released) return;
      released = true;
      try {
        await client.query("ROLLBACK");
      } catch {
        // ignore
      } finally {
        client.release();
        await pool.end().catch(() => undefined);
      }
    },
  };
}

/**
 * Bounded observation of a real tenant read waiting on the lock barrier.
 * Polls only `pg_stat_activity` for a lock wait on the tenant access helper.
 */
export async function waitForBlockedTenantRead(
  timeoutMillis: number,
): Promise<boolean> {
  assertEnabled();
  if (!Number.isInteger(timeoutMillis) || timeoutMillis < 1 || timeoutMillis > 30_000) {
    fail("FIXTURE_INPUT_INVALID");
  }
  const fixture = await loadFixtureModule();
  const admin = fixture.adminPool();
  const deadline = Date.now() + timeoutMillis;
  try {
    for (;;) {
      const result = await admin.query<{ blocked: number }>(
        `SELECT count(*)::int AS blocked
           FROM pg_stat_activity
          WHERE state = 'active'
            AND wait_event_type = 'Lock'
            AND query LIKE '%lock_organization_access%'`,
      );
      if ((result.rows[0]?.blocked ?? 0) > 0) return true;
      if (Date.now() >= deadline) return false;
      await new Promise<void>((resolveTick) => setTimeout(resolveTick, 50));
    }
  } catch (error) {
    if (error instanceof TenantFixtureError) throw error;
    fail("FIXTURE_UNAVAILABLE");
  } finally {
    await admin.end().catch(() => undefined);
  }
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
  if (process.argv[2] === "--prepare") {
    prepareProductionFixture()
      .then(() => {
        process.exitCode = 0;
      })
      .catch((error: unknown) => {
        const message =
          error instanceof TenantFixtureError
            ? error.code
            : FIXTURE_ERRORS.FIXTURE_UNAVAILABLE;
        console.error(message);
        process.exitCode = 1;
      });
  }
  // Any other direct invocation is import-only: no DB operation runs.
}
