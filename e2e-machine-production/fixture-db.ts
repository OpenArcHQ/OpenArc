import { randomBytes, randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Type-only imports do not execute these modules. Pool types are derived from
// the workspace signatures, which resolve their own `pg` dependency.
import type { adminPool } from "../packages/db/test/postgres-fixture.js";
import type { createDatabasePool } from "../packages/db/src/index.js";

// The accepted PORT-01 production fixture owns the guarded bootstrap, seeding
// and session helpers. This machine fixture imports them READONLY and adds
// only the bounded machine credential/session observations and the explicit
// synthetic machine setup the credential journeys need; it does not copy the
// ~600-line guarded bootstrap.
import {
  FIXTURE_ERRORS,
  TenantFixtureError,
  ageAccountSessionProof,
  countAccountSessions,
  countDurableRows,
  deleteAccountSessions,
  expireAccountSessions,
  holdOrganizationRowLock,
  prepareProductionFixture,
  readAgentRow,
  readDurableReceipt,
  readMembershipRow,
  readOrganizationRow,
  readProviderRow,
  seedAccount,
  seedAgents,
  seedMembership,
  seedOrganizationWithRole,
  seedOwnOrganizations,
  seedProviders,
  seedRegisteredAccount,
  setMembershipRole,
  waitForAccountSessionExpiry,
  waitForBlockedTenantRead,
} from "../e2e-tenant-write-production/fixture-db.js";

export {
  FIXTURE_ERRORS,
  TenantFixtureError,
  ageAccountSessionProof,
  countAccountSessions,
  countDurableRows,
  deleteAccountSessions,
  expireAccountSessions,
  holdOrganizationRowLock,
  prepareProductionFixture,
  readAgentRow,
  readDurableReceipt,
  readMembershipRow,
  readOrganizationRow,
  readProviderRow,
  seedAccount,
  seedAgents,
  seedMembership,
  seedOrganizationWithRole,
  seedOwnOrganizations,
  seedProviders,
  seedRegisteredAccount,
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
} from "../e2e-tenant-write-production/fixture-db.js";

type AdminPool = ReturnType<typeof adminPool>;
type DbPool = ReturnType<typeof createDatabasePool>;

/**
 * Bounded, test-only durable MACHINE observations.
 *
 * This module is never imported by the web app or the API. Every function runs
 * behind the explicit `OPENARC_MACHINE_PRODUCTION_FIXTURE=1` /
 * `OPENARC_TENANT_PRODUCTION_FIXTURE=1` opt-in and the accepted
 * `packages/db/test/postgres-fixture.ts` guard that asserts the exact synthetic
 * loopback PostgreSQL URL BEFORE any connection. It exposes no arbitrary SQL,
 * no credential hash, no token, no session hash and no cookie. Every failure is
 * a fixed non-echoing text. The environment string below is the single frozen
 * non-secret classification used by every machine row.
 */

const MACHINE_FIXTURE_FLAG = "OPENARC_MACHINE_PRODUCTION_FIXTURE";
const TENANT_FIXTURE_FLAG = "OPENARC_TENANT_PRODUCTION_FIXTURE";

const MACHINE_ENVIRONMENT = "eip155:5042002";

const CANONICAL_ACCOUNT_ID =
  /^openarc:account:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const CANONICAL_ORGANIZATION_ID =
  /^openarc:org:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const CANONICAL_AGENT_ID =
  /^openarc:agent:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const CANONICAL_PROVIDER_ID =
  /^openarc:provider:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const CANONICAL_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

function fail(code: (typeof FIXTURE_ERRORS)[keyof typeof FIXTURE_ERRORS]): never {
  throw new TenantFixtureError(code);
}

function assertEnabled(): void {
  if (process.env[TENANT_FIXTURE_FLAG] !== "1") fail("FIXTURE_DISABLED");
  if (process.env[MACHINE_FIXTURE_FLAG] !== "1") fail("FIXTURE_DISABLED");
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

function requireCanonicalOrganizationId(value: unknown): string {
  if (typeof value !== "string" || !CANONICAL_ORGANIZATION_ID.test(value)) {
    fail("FIXTURE_INPUT_INVALID");
  }
  return value;
}

function requireCanonicalAccountId(value: unknown): string {
  if (typeof value !== "string" || !CANONICAL_ACCOUNT_ID.test(value)) {
    fail("FIXTURE_INPUT_INVALID");
  }
  return value;
}

function requireCanonicalProfileId(value: unknown, kind: "agent" | "provider"): string {
  if (kind === "agent") {
    if (typeof value !== "string" || !CANONICAL_AGENT_ID.test(value)) {
      fail("FIXTURE_INPUT_INVALID");
    }
    return value;
  }
  if (typeof value !== "string" || !CANONICAL_PROVIDER_ID.test(value)) {
    fail("FIXTURE_INPUT_INVALID");
  }
  return value;
}

function requireCanonicalUuid(value: unknown): string {
  if (typeof value !== "string" || !CANONICAL_UUID.test(value)) {
    fail("FIXTURE_INPUT_INVALID");
  }
  return value;
}

function requireDurationSeconds(value: unknown): number {
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < 1 ||
    value > 86_400
  ) {
    fail("FIXTURE_INPUT_INVALID");
  }
  return value;
}

/* -------------------------------------------------------------------------- */
/* Bounded machine credential rows                                            */
/* -------------------------------------------------------------------------- */

export interface MachineCredentialRow {
  readonly credentialId: string;
  readonly kind: "agent" | "provider";
  readonly profileId: string;
  readonly keyPrefix: string;
  readonly status: "active" | "revoked" | "expired";
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly revokedAt: string | null;
}

interface MachineCredentialQueryRow {
  readonly credential_id: string;
  readonly profile_id: string;
  readonly key_prefix: string;
  readonly status: string;
  readonly created_at: Date;
  readonly expires_at: Date;
  readonly revoked_at: Date | null;
}

function projectMachineStatus(raw: string): "active" | "revoked" | "expired" {
  if (raw === "active" || raw === "revoked" || raw === "expired") return raw;
  fail("FIXTURE_UNAVAILABLE");
}

function toIso(value: unknown): string {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    fail("FIXTURE_UNAVAILABLE");
  }
  return value.toISOString();
}

function toIsoOrNull(value: unknown): string | null {
  return value === null ? null : toIso(value);
}

/**
 * Read one committed credential row by its canonical credential id, exposed as
 * safe metadata only. The lookup/hash/salt/digest columns are never selected.
 */
export async function readMachineCredentialRow(
  kind: unknown,
  organizationId: unknown,
  credentialId: unknown,
): Promise<MachineCredentialRow | null> {
  if (kind !== "agent" && kind !== "provider") fail("FIXTURE_INPUT_INVALID");
  const organization = requireCanonicalOrganizationId(organizationId);
  const credential = requireCanonicalUuid(credentialId);
  const table =
    kind === "agent"
      ? "openarc_durable.agent_credentials"
      : "openarc_durable.provider_credentials";
  const profileColumn = kind === "agent" ? "agent_id" : "provider_id";
  return withAdmin(async (admin) => {
    const result = await admin.query<MachineCredentialQueryRow>(
      `SELECT credential_id::text AS credential_id,
              ${profileColumn} AS profile_id,
              key_prefix,
              CASE
                WHEN revoked_at IS NOT NULL THEN 'revoked'
                WHEN expires_at <= clock_timestamp() THEN 'expired'
                ELSE 'active'
              END AS status,
              created_at, expires_at, revoked_at
         FROM ${table}
        WHERE organization_id = $1 AND credential_id = $2::uuid`,
      [organization, credential],
    );
    const row = result.rows[0];
    if (row === undefined) return null;
    const status = projectMachineStatus(row.status);
    return {
      credentialId: requireCanonicalUuid(row.credential_id),
      kind,
      profileId: requireCanonicalProfileId(row.profile_id, kind),
      keyPrefix: row.key_prefix,
      status,
      createdAt: toIso(row.created_at),
      expiresAt: toIso(row.expires_at),
      revokedAt: toIsoOrNull(row.revoked_at),
    };
  });
}

export interface MachineReceiptCounts {
  readonly credentials: number;
  readonly sessions: number;
}

/**
 * Exact bounded counts for a credential: one credential row and the number of
 * live sessions referencing it. No token, hash or cookie is read.
 */
export async function countMachineRows(
  kind: unknown,
  organizationId: unknown,
  credentialId: unknown,
): Promise<MachineReceiptCounts> {
  if (kind !== "agent" && kind !== "provider") fail("FIXTURE_INPUT_INVALID");
  const organization = requireCanonicalOrganizationId(organizationId);
  const credential = requireCanonicalUuid(credentialId);
  const credentialTable =
    kind === "agent"
      ? "openarc_durable.agent_credentials"
      : "openarc_durable.provider_credentials";
  const sessionTable =
    kind === "agent"
      ? "openarc_durable.agent_sessions"
      : "openarc_durable.provider_sessions";
  return withAdmin(async (admin) => {
    const result = await admin.query<{ credentials: number; sessions: number }>(
      `SELECT
         (SELECT count(*)::int FROM ${credentialTable}
           WHERE organization_id = $1 AND credential_id = $2::uuid) AS credentials,
         (SELECT count(*)::int FROM ${sessionTable}
           WHERE organization_id = $1 AND credential_id = $2::uuid
             AND revoked_at IS NULL AND expires_at > clock_timestamp()) AS sessions`,
      [organization, credential],
    );
    const row = result.rows[0];
    return {
      credentials: row?.credentials ?? 0,
      sessions: row?.sessions ?? 0,
    };
  });
}

export interface MachineMutationCounts {
  readonly idempotency: number;
  readonly audit: number;
  readonly outbox: number;
}

/**
 * Exact per-mutation durable counts restricted to one credential resource, so a
 * machine issue/revoke can be proven committed without reading any secret.
 */
export async function countMachineMutationRows(
  organizationId: unknown,
  mutationId: unknown,
): Promise<MachineMutationCounts> {
  const organization = requireCanonicalOrganizationId(organizationId);
  const mutation = requireCanonicalUuid(mutationId);
  return withAdmin(async (admin) => {
    const result = await admin.query<{
      idempotency: number;
      audit: number;
      outbox: number;
    }>(
      `SELECT
         (SELECT count(*)::int FROM openarc_durable.idempotency_records r
           WHERE r.organization_id = $1 AND r.mutation_id = $2::uuid
             AND r.status = 'committed') AS idempotency,
         (SELECT count(*)::int FROM openarc_durable.audit_events a
           WHERE a.organization_id = $1 AND a.mutation_id = $2::uuid) AS audit,
         (SELECT count(*)::int FROM openarc_durable.outbox_events o
           WHERE o.organization_id = $1 AND o.mutation_id = $2::uuid) AS outbox`,
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

/**
 * Bounded proof that a machine session for a credential is live. Never returns
 * the token hash; only a boolean.
 */
export async function hasLiveMachineSession(
  kind: unknown,
  organizationId: unknown,
  credentialId: unknown,
): Promise<boolean> {
  const counts = await countMachineRows(kind, organizationId, credentialId);
  return counts.sessions > 0;
}

/**
 * Test-only synthetic expiry setup. Moves a committed credential's server-side
 * `expires_at` to a few seconds ahead of the database clock while keeping the
 * strict `expires_at > created_at` invariant, so the REAL API expires it under
 * the database clock without any stale client-clock assumption. This changes
 * the synthetic fixture row, NOT an authorization check.
 */
export async function expireMachineCredential(
  kind: unknown,
  organizationId: unknown,
  credentialId: unknown,
  expiresInSeconds: unknown,
): Promise<number> {
  if (kind !== "agent" && kind !== "provider") fail("FIXTURE_INPUT_INVALID");
  const organization = requireCanonicalOrganizationId(organizationId);
  const credential = requireCanonicalUuid(credentialId);
  const seconds = requireDurationSeconds(expiresInSeconds);
  const table =
    kind === "agent"
      ? "openarc_durable.agent_credentials"
      : "openarc_durable.provider_credentials";
  return withAdmin(async (admin) => {
    const result = await admin.query(
      `UPDATE ${table}
          SET expires_at = clock_timestamp() + ($3 || ' seconds')::interval,
              created_at = least(created_at, clock_timestamp())
        WHERE organization_id = $1 AND credential_id = $2::uuid
          AND revoked_at IS NULL`,
      [organization, credential, String(seconds)],
    );
    return result.rowCount ?? 0;
  });
}

/**
 * Test-only SYNTHETIC conversion of THIS fixture account's actual existing
 * active session metadata so the real recovery guard can be observed.
 *
 * It does NOT mint an unrelated random session and it never reads or writes a
 * token hash, cookie or browser state: the browser keeps using the very same
 * passkey session it established through the real sign-up UI, while the
 * server-side `method` for that session is converted to `recovery` and its
 * `created_at` proof timestamp is aged past the frozen 5-minute proof window.
 *
 * This is a synthetic metadata conversion, NOT cryptographic recovery proof:
 * it does not prove how a real recovery sign-in is established (the accepted
 * auth browser-27 journey owns that elsewhere). It changes only this account's
 * own session rows and returns the exact affected row count so the caller can
 * assert the conversion really happened. The 24-hour expiry window and the
 * `expires_at > created_at` constraint are both preserved.
 */
export async function convertAccountSessionToRecovery(
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
          SET method = 'recovery',
              created_at = clock_timestamp() - ($2 || ' seconds')::interval,
              expires_at = clock_timestamp() + interval '30 minutes'
        WHERE account_id = $1
          AND expires_at > clock_timestamp()`,
      [account, String(ageSeconds)],
    );
    return result.rowCount ?? 0;
  });
}

/* -------------------------------------------------------------------------- */
/* Bounded machine setup through the accepted restricted tenant pool          */
/* -------------------------------------------------------------------------- */

/**
 * Issue one machine credential through the accepted real `CredentialStore`
 * restricted-pool helpers, so the fixture can place a committed credential in
 * the database for expiry/revocation journeys. A synthetic admin-side session
 * is minted internally and never returned. The lookup id, secret material and
 * hash are internal to this call and are never returned or logged; only the
 * credential id and public prefix (non-secret) are returned.
 */
export interface SeededMachineCredential {
  readonly credentialId: string;
  readonly publicPrefix: string;
}

export async function seedMachineCredential(
  callerAccountId: unknown,
  organizationId: unknown,
  kind: unknown,
  profileId: unknown,
  expiresInSeconds: unknown,
): Promise<SeededMachineCredential> {
  assertEnabled();
  const caller = requireCanonicalAccountId(callerAccountId);
  const organization = requireCanonicalOrganizationId(organizationId);
  if (kind !== "agent" && kind !== "provider") fail("FIXTURE_INPUT_INVALID");
    const profile = requireCanonicalProfileId(profileId, kind);
  const seconds = requireDurationSeconds(expiresInSeconds);
  const fixture = await loadFixtureModule();
  const db = await loadDbModule();
  const admin = fixture.adminPool();
  let tenantPool: DbPool | undefined;
  try {
    const sessionHash = randomBytes(32).toString("hex");
    await admin.query(
      `INSERT INTO openarc_auth.sessions (token_hash, account_id, method, created_at, expires_at)
       VALUES ($1, $2, 'passkey', clock_timestamp(), clock_timestamp() + interval '30 minutes')`,
      [sessionHash, caller],
    );
    tenantPool = db.createDatabasePool(fixture.tenantUrl());
    const store = new db.CredentialStore(db.asCredentialPool(tenantPool));
    await store.initialize();
    const credentialId = randomUUID();
    const lookupId = randomUUID();
    const expiresAt = new Date(Date.now() + seconds * 1000).toISOString();
    // The accepted CredentialStore requires an EXACT closed hash input. This
    // fixture never holds real credential material: it stores only a synthetic
    // scrypt-parameter-shaped hash of random bytes. The salt (16 bytes) and
    // digest (32 bytes) are canonical unpadded base64url, and every value is
    // internal to this call and never returned or logged.
    const hashInput = {
      algorithm: "scrypt" as const,
      hashVersion: 1 as const,
      pepperVersion: 1,
      N: 32768 as const,
      r: 8 as const,
      p: 1 as const,
      salt: randomBytes(16).toString("base64url"),
      digest: randomBytes(32).toString("base64url"),
    };
    db.parseCredentialHashInput(hashInput);
    const metadata = {
      idempotencyKey: randomBytes(32).toString("base64url"),
      mutationId: credentialId,
    };
    const issueInput = {
      sessionHash,
      organizationId: organization,
      profileId: profile,
      lookupId,
      hash: hashInput,
      expiresAt,
      metadata,
    };
    if (kind === "agent") {
      await store.issueAgentCredentialDurably(issueInput);
    } else {
      await store.issueProviderCredentialDurably(issueInput);
    }
    return {
      credentialId,
      publicPrefix: `${kind === "agent" ? "oac_ag_" : "oac_pr_"}${lookupId}`,
    };
  } catch (error) {
    if (error instanceof TenantFixtureError) throw error;
    throw fail("FIXTURE_UNAVAILABLE");
  } finally {
    if (tenantPool !== undefined) await tenantPool.end().catch(() => undefined);
    await admin.end().catch(() => undefined);
  }
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
  void MACHINE_ENVIRONMENT;
}
