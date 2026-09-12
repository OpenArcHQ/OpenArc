import { createHash, randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import {
  CommerceAccountIdSchema,
  CommerceAgentIdSchema,
  CommerceAgentProfileSchema,
  CommerceHumanRoleSchema,
  CommerceOrganizationAccessViewSchema,
  CommerceOrganizationIdSchema,
  CommerceOrganizationSchema,
  CommerceProviderIdSchema,
  CommerceProviderProfileSchema,
  IsoTimestampSchema,
  compareIsoTimestamps,
  type CommerceAgentProfile,
  type CommerceHumanRole,
  type CommerceOrganization,
  type CommerceOrganizationAccessView,
  type CommerceProviderProfile,
} from '@openarc/shared';
import { loadMigrations, type SqlMigration } from './migrate.js';

export type {
  CommerceAgentProfile,
  CommerceHumanRole,
  CommerceOrganization,
  CommerceOrganizationAccessView,
  CommerceProviderProfile,
} from '@openarc/shared';

/**
 * Tenant repository over the frozen schema2 SQL surface.
 *
 * Every operation runs in exactly one connection/transaction and only ever
 * establishes transaction-local context through the reviewed `openarc_tenant`
 * bridge functions or explicit `set_config(..., true)` calls. The store never
 * migrates, never holds authority across calls, and accepts only internal
 * 64-lowercase-hex session hashes.
 *
 * Output projections enforce the canonical commerce DTO contracts (id
 * prefixes, role/status vocabularies, trimmed control-free display names, UTC
 * timestamps and non-decreasing updatedAt). The canonical shared
 * `commerce/identity` schemas are the source of truth for these constraints;
 * see the handoff note about the additive shared root export.
 */

export const TENANT_STORE_ERROR_MESSAGES = {
  TENANT_STORE_INPUT_INVALID: 'TenantStore input is invalid.',
  TENANT_STORE_SESSION_INVALID: 'TenantStore session is not valid.',
  TENANT_STORE_FORBIDDEN: 'TenantStore caller is not permitted.',
  TENANT_STORE_NOT_FOUND: 'TenantStore target was not found.',
  TENANT_STORE_CONFLICT: 'TenantStore operation conflicts with existing state.',
  TENANT_STORE_UNAVAILABLE: 'TenantStore is not available.',
  TENANT_STORE_OUTCOME_UNKNOWN:
    'TenantStore mutation outcome could not be confirmed; it may have committed.',
} as const;

export type TenantStoreErrorCode = keyof typeof TENANT_STORE_ERROR_MESSAGES;

/** Fixed, non-echoing repository error. Never carries driver detail. */
export class TenantStoreError extends Error {
  readonly code: TenantStoreErrorCode;

  constructor(code: TenantStoreErrorCode) {
    super(TENANT_STORE_ERROR_MESSAGES[code]);
    this.name = 'TenantStoreError';
    this.code = code;
  }
}

export interface TenantQueryResult<T> {
  readonly rows: T[];
  readonly rowCount: number | null;
}

/**
 * Narrow client port. Structurally satisfied by `pg` PoolClient; a fake port
 * in the unit suite exercises unknown-outcome and release-failure paths
 * without mocking authorization.
 */
export interface TenantClient {
  query<T extends Record<string, unknown>>(
    text: string,
    values?: unknown[],
  ): Promise<TenantQueryResult<T>>;
  release(destroy?: boolean): void;
}

export interface TenantPool {
  connect(): Promise<TenantClient>;
}

export interface ListOrganizationsInput {
  readonly afterOrganizationId?: string;
  readonly limit?: number;
}

export interface ListOrganizationsResult {
  readonly items: CommerceOrganization[];
  readonly nextCursor: string | null;
}

export interface GetOrganizationAccessResult {
  readonly organization: CommerceOrganization;
  readonly access: CommerceOrganizationAccessView;
}

export interface ListMembersInput {
  readonly afterAccountId?: string;
  readonly limit?: number;
}

export interface MembershipProjection {
  readonly organizationId: string;
  readonly accountId: string;
  readonly role: CommerceHumanRole;
  readonly status: 'active' | 'suspended';
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ListMembersResult {
  readonly items: MembershipProjection[];
  readonly nextCursor: string | null;
}

export interface ListAgentsInput {
  readonly afterAgentId?: string;
  readonly limit?: number;
}

export interface ListAgentsResult {
  readonly items: CommerceAgentProfile[];
  readonly nextCursor: string | null;
}

export interface ListProvidersInput {
  readonly afterProviderId?: string;
  readonly limit?: number;
}

export interface ListProvidersResult {
  readonly items: CommerceProviderProfile[];
  readonly nextCursor: string | null;
}

export interface UpdateAgentPatch {
  readonly displayName?: string;
  readonly status?: 'active' | 'suspended' | 'revoked';
}

export interface UpdateProviderPatch {
  readonly displayName?: string;
  readonly status?: 'active' | 'suspended' | 'retired';
}

const SESSION_HASH = /^[0-9a-f]{64}$/;

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 100;
const FRESH_PROOF_MILLIS = 5 * 60 * 1000;

const AGENT_MUTATE_ROLES: readonly CommerceHumanRole[] = ['owner', 'operator'];
const AGENT_READ_ROLES: readonly CommerceHumanRole[] = ['owner', 'operator', 'viewer'];
const OWNER_ONLY: readonly CommerceHumanRole[] = ['owner'];

const AGENT_STATUSES = ['active', 'suspended', 'revoked'] as const;
const PROVIDER_STATUSES = ['active', 'suspended', 'retired'] as const;

function fail(code: TenantStoreErrorCode): never {
  throw new TenantStoreError(code);
}

/**
 * Structural view of a canonical shared schema. Running every outbound DTO
 * through the exact shared validator keeps the canonical identity module the
 * single source of truth instead of a local mirror.
 */
interface CanonicalSchema<T> {
  safeParse(value: unknown):
    | { readonly success: true; readonly data: T }
    | { readonly success: false };
}

function parseCanonical<T>(schema: CanonicalSchema<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) fail('TENANT_STORE_UNAVAILABLE');
  return parsed.data;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint === undefined) continue;
    if (codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f)) return true;
  }
  return false;
}

function isDisplayName(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length >= 1 &&
    value.length <= 100 &&
    value === value.trim() &&
    !hasControlCharacter(value)
  );
}

function requireSessionHash(value: unknown): string {
  if (typeof value !== 'string' || value.length !== 64 || !SESSION_HASH.test(value)) {
    fail('TENANT_STORE_INPUT_INVALID');
  }
  return value;
}

function requireDisplayName(value: unknown): string {
  if (!isDisplayName(value)) fail('TENANT_STORE_INPUT_INVALID');
  return value;
}

const AGENT_PATCH_KEYS = ['displayName', 'status'] as const;
const PROVIDER_PATCH_KEYS = ['displayName', 'status'] as const;

/**
 * Strictly validate an update patch before any checkout.
 *
 * A patch must be a plain non-null object, may contain only allowed own
 * enumerable keys, and must carry at least one allowed key whose value is
 * actually defined. Arrays, class instances, unknown keys, inherited-only
 * shapes, `{}` and `{ field: undefined }` all normalize to INPUT_INVALID
 * without touching the pool.
 */
function requireUpdatePatch(value: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    fail('TENANT_STORE_INPUT_INVALID');
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    fail('TENANT_STORE_INPUT_INVALID');
  }
  const keys = Object.keys(value);
  for (const key of keys) {
    if (!allowed.includes(key)) fail('TENANT_STORE_INPUT_INVALID');
  }
  const owned = value as Record<string, unknown>;
  if (!keys.some((key) => owned[key] !== undefined)) fail('TENANT_STORE_INPUT_INVALID');
  return owned;
}

function requireOrganizationId(value: unknown): string {
  const parsed = CommerceOrganizationIdSchema.safeParse(value);
  if (!parsed.success) fail('TENANT_STORE_INPUT_INVALID');
  return parsed.data;
}

function requireAccountId(value: unknown): string {
  const parsed = CommerceAccountIdSchema.safeParse(value);
  if (!parsed.success) fail('TENANT_STORE_INPUT_INVALID');
  return parsed.data;
}

function requireAgentId(value: unknown): string {
  const parsed = CommerceAgentIdSchema.safeParse(value);
  if (!parsed.success) fail('TENANT_STORE_INPUT_INVALID');
  return parsed.data;
}

function requireProviderId(value: unknown): string {
  const parsed = CommerceProviderIdSchema.safeParse(value);
  if (!parsed.success) fail('TENANT_STORE_INPUT_INVALID');
  return parsed.data;
}

function requireHumanRole(value: unknown): CommerceHumanRole {
  const parsed = CommerceHumanRoleSchema.safeParse(value);
  if (!parsed.success) fail('TENANT_STORE_INPUT_INVALID');
  return parsed.data;
}

function requireMembershipStatus(value: unknown): 'active' | 'suspended' {
  if (value !== 'active' && value !== 'suspended') fail('TENANT_STORE_INPUT_INVALID');
  return value;
}

function requireAgentStatus(value: unknown): 'active' | 'suspended' | 'revoked' {
  if (typeof value !== 'string' || !AGENT_STATUSES.includes(value as (typeof AGENT_STATUSES)[number])) {
    fail('TENANT_STORE_INPUT_INVALID');
  }
  return value as 'active' | 'suspended' | 'revoked';
}

function requireProviderStatus(value: unknown): 'active' | 'suspended' | 'retired' {
  if (
    typeof value !== 'string' ||
    !PROVIDER_STATUSES.includes(value as (typeof PROVIDER_STATUSES)[number])
  ) {
    fail('TENANT_STORE_INPUT_INVALID');
  }
  return value as 'active' | 'suspended' | 'retired';
}

function requirePageSize(value: unknown): number {
  if (value === undefined) return DEFAULT_PAGE_SIZE;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > MAX_PAGE_SIZE) {
    fail('TENANT_STORE_INPUT_INVALID');
  }
  return value;
}

function requireDate(value: unknown): Date {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    fail('TENANT_STORE_UNAVAILABLE');
  }
  return value;
}

function requireString(value: unknown): string {
  if (typeof value !== 'string') fail('TENANT_STORE_UNAVAILABLE');
  return value;
}

function isoUtc(value: unknown): string {
  return requireDate(value).toISOString();
}

function requireCanonicalTimestamp(value: string): string {
  const parsed = IsoTimestampSchema.safeParse(value);
  if (!parsed.success) fail('TENANT_STORE_UNAVAILABLE');
  return parsed.data;
}

function requireNonDecreasing(createdAt: string, updatedAt: string): void {
  if (compareIsoTimestamps(updatedAt, createdAt) < 0) fail('TENANT_STORE_UNAVAILABLE');
}

function normalizeError(error: unknown): TenantStoreError {
  if (error instanceof TenantStoreError) return error;
  if (isRecord(error) && typeof error.code === 'string') {
    switch (error.code) {
      case '28000':
        return new TenantStoreError('TENANT_STORE_SESSION_INVALID');
      case '42501':
        return new TenantStoreError('TENANT_STORE_FORBIDDEN');
      case '23503':
        return new TenantStoreError('TENANT_STORE_NOT_FOUND');
      case '23505':
        return new TenantStoreError('TENANT_STORE_CONFLICT');
      case '22023':
      case '22P02':
      case '22001':
      case '22003':
      case '23514':
        return new TenantStoreError('TENANT_STORE_INPUT_INVALID');
      default:
        return new TenantStoreError('TENANT_STORE_UNAVAILABLE');
    }
  }
  return new TenantStoreError('TENANT_STORE_UNAVAILABLE');
}

interface SessionRow extends Record<string, unknown> {
  readonly account_id: string;
  readonly method: string;
  readonly session_created_at: Date;
  readonly session_expires_at: Date;
}

interface OrganizationRow extends Record<string, unknown> {
  readonly organization_id: string;
  readonly display_name: string;
  readonly created_at: Date;
  readonly updated_at: Date;
}

interface MembershipRow extends Record<string, unknown> {
  readonly organization_id: string;
  readonly account_id: string;
  readonly role: string;
  readonly status: string;
  readonly created_at: Date;
  readonly updated_at: Date;
}

interface AgentRow extends Record<string, unknown> {
  readonly agent_id: string;
  readonly organization_id: string;
  readonly display_name: string;
  readonly status: string;
  readonly created_at: Date;
  readonly updated_at: Date;
}

interface ProviderRow extends Record<string, unknown> {
  readonly provider_id: string;
  readonly organization_id: string;
  readonly display_name: string;
  readonly status: string;
  readonly created_at: Date;
  readonly updated_at: Date;
}

interface LockAccessRow extends Record<string, unknown> {
  readonly out_organization_id: string;
  readonly out_role: string;
}

/**
 * Tenant repository. Construct with a pool bound to `openarc_tenant_app`.
 */
export class TenantStore {
  readonly #pool: TenantPool;
  #initialized = false;

  constructor(pool: TenantPool) {
    if (pool === null || typeof pool !== 'object' || typeof pool.connect !== 'function') {
      fail('TENANT_STORE_INPUT_INVALID');
    }
    this.#pool = pool;
  }

  /**
   * Verify the frozen schema and the restricted runtime role exactly once.
   * This never migrates and never mutates tenant data.
   */
  async initialize(): Promise<void> {
    if (this.#initialized) return;
    await this.#withTransaction(async (client) => {
      await this.#assertReady(client);
    });
    this.#initialized = true;
  }

  /** Read-only readiness re-check; safe to call repeatedly. */
  async readiness(): Promise<void> {
    await this.#withTransaction(async (client) => {
      await this.#assertReady(client);
    });
  }

  /** Fresh passkey/wallet bootstrap of an organization and initial owner. */
  async createOrganization(
    sessionHash: unknown,
    displayName: unknown,
  ): Promise<GetOrganizationAccessResult> {
    const hash = requireSessionHash(sessionHash);
    const name = requireDisplayName(displayName);

    return this.#withTransaction(async (client) => {
      const session = await this.#lockFreshBootstrapSession(client, hash);
      const actor = requireString(session.account_id);
      const organizationId = `openarc:org:${randomUUID()}`;
      await this.#setConfig(client, 'openarc.account_id', actor);
      await this.#setConfig(client, 'openarc.organization_id', organizationId);
      await client.query(
        `INSERT INTO openarc_tenant.organizations (organization_id, display_name, created_by)
         VALUES ($1, $2, $3)`,
        [organizationId, name, actor],
      );

      await this.#setConfig(client, 'openarc.role', 'owner');
      await client.query(
        `INSERT INTO openarc_tenant.memberships (organization_id, account_id, role, status)
         VALUES ($1, $2, 'owner', 'active')`,
        [organizationId, actor],
      );

      // The INSERTs above may have waited on row/table or index locks past the
      // passkey/wallet proof and session boundary. Re-validate the SAME held
      // session and account against the database clock before COMMIT; any
      // failure rolls both inserts back.
      const recheck = await this.#lockFreshBootstrapSession(client, hash);
      if (requireString(recheck.account_id) !== actor) fail('TENANT_STORE_SESSION_INVALID');

      const organization = await this.#readOrganization(client, organizationId);
      return {
        organization,
        access: this.#projectAccess({
          organizationId,
          accountId: actor,
          role: 'owner',
          membershipStatus: 'active',
          sessionExpiresAt: isoUtc(session.session_expires_at),
        }),
      };
    });
  }

  /** Bounded, stable, own-membership organization list. */
  async listOrganizations(
    sessionHash: unknown,
    input?: ListOrganizationsInput,
  ): Promise<ListOrganizationsResult> {
    const hash = requireSessionHash(sessionHash);
    const limit = requirePageSize(input?.limit);
    const after =
      input?.afterOrganizationId === undefined
        ? null
        : requireOrganizationId(input.afterOrganizationId);

    return this.#withTransaction(async (client) => {
      const page = await this.#listOwnedOrganizationIds(client, hash, after, limit);
      const ids = page.rows.map((row) => requireOrganizationId(row.organization_id));
      const items: CommerceOrganization[] = [];
      for (const organizationId of ids) {
        await this.#lockOrganizationAccess(client, hash, organizationId);
        items.push(await this.#readOrganization(client, organizationId));
      }
      let nextCursor: string | null = null;
      if (ids.length === limit && ids.length > 0) {
        const last = ids[ids.length - 1] ?? null;
        const probe = await this.#listOwnedOrganizationIds(client, hash, last, 1);
        nextCursor = probe.rows.length > 0 ? last : null;
      }
      return { items, nextCursor };
    });
  }

  /** Resolve the caller's active access to one organization. */
  async getOrganizationAccess(
    sessionHash: unknown,
    organizationId: unknown,
  ): Promise<GetOrganizationAccessResult> {
    const hash = requireSessionHash(sessionHash);
    const organization = requireOrganizationId(organizationId);

    return this.#withTransaction(async (client) => {
      const session = await this.#lockSession(client, hash);
      const access = await this.#lockOrganizationAccess(client, hash, organization);
      const projected = await this.#readOrganization(client, organization);
      return {
        organization: projected,
        access: this.#projectAccess({
          organizationId: access.out_organization_id,
          accountId: requireString(session.account_id),
          role: requireHumanRole(access.out_role),
          membershipStatus: 'active',
          sessionExpiresAt: isoUtc(session.session_expires_at),
        }),
      };
    });
  }

  /** Owner-only member enumeration, including suspended members. */
  async listMembers(
    sessionHash: unknown,
    organizationId: unknown,
    input?: ListMembersInput,
  ): Promise<ListMembersResult> {
    const hash = requireSessionHash(sessionHash);
    const organization = requireOrganizationId(organizationId);
    const limit = requirePageSize(input?.limit);
    const after = input?.afterAccountId === undefined ? null : requireAccountId(input.afterAccountId);

    return this.#withTransaction(async (client) => {
      const access = await this.#lockOrganizationAccess(client, hash, organization);
      this.#requireRole(access.out_role, OWNER_ONLY);
      const rows = await client.query<MembershipRow>(
        `SELECT organization_id, account_id, role, status, created_at, updated_at
           FROM openarc_tenant.memberships
          WHERE organization_id = $1
            AND ($2::text IS NULL OR account_id > $2)
          ORDER BY account_id
          LIMIT $3`,
        [organization, after, limit + 1],
      );
      const visible = rows.rows.slice(0, limit);
      const nextCursor =
        rows.rows.length > limit ? requireString(visible[visible.length - 1]?.account_id) : null;
      return { items: visible.map((row) => this.#projectMembership(row)), nextCursor };
    });
  }

  /** Owner/operator create an active agent. */
  async createAgent(
    sessionHash: unknown,
    organizationId: unknown,
    displayName: unknown,
  ): Promise<CommerceAgentProfile> {
    const hash = requireSessionHash(sessionHash);
    const organization = requireOrganizationId(organizationId);
    const name = requireDisplayName(displayName);

    return this.#withTransaction(async (client) => {
      const session = await this.#lockSession(client, hash);
      const access = await this.#lockOrganizationAccess(client, hash, organization);
      this.#requireRole(access.out_role, AGENT_MUTATE_ROLES);
      await this.#recheckSession(client, hash, requireString(session.account_id));
      const agentId = `openarc:agent:${randomUUID()}`;
      const inserted = await client.query<AgentRow>(
        `INSERT INTO openarc_tenant.agents (organization_id, agent_id, display_name)
         VALUES ($1, $2, $3)
         RETURNING agent_id, organization_id, display_name, status, created_at, updated_at`,
        [organization, agentId, name],
      );
      const row = inserted.rows[0];
      if (row === undefined) fail('TENANT_STORE_UNAVAILABLE');
      // The INSERT may have waited on locks past the session boundary. Re-check
      // the same held session/account before COMMIT so a stale session cannot
      // commit an agent row.
      await this.#recheckSession(client, hash, requireString(session.account_id));
      return this.#projectAgent(row);
    });
  }

  /** Owner/operator update a non-terminal agent. */
  async updateAgent(
    sessionHash: unknown,
    organizationId: unknown,
    agentId: unknown,
    patch: UpdateAgentPatch,
  ): Promise<CommerceAgentProfile> {
    const hash = requireSessionHash(sessionHash);
    const organization = requireOrganizationId(organizationId);
    const agent = requireAgentId(agentId);
    const patchFields = requireUpdatePatch(patch, AGENT_PATCH_KEYS);
    const hasName = patchFields['displayName'] !== undefined;
    const hasStatus = patchFields['status'] !== undefined;
    const name = hasName ? requireDisplayName(patchFields['displayName']) : null;
    const status = hasStatus ? requireAgentStatus(patchFields['status']) : null;

    return this.#withTransaction(async (client) => {
      const session = await this.#lockSession(client, hash);
      const access = await this.#lockOrganizationAccess(client, hash, organization);
      this.#requireRole(access.out_role, AGENT_MUTATE_ROLES);
      const current = await client.query<AgentRow>(
        `SELECT agent_id, organization_id, display_name, status, created_at, updated_at
           FROM openarc_tenant.agents
          WHERE organization_id = $1 AND agent_id = $2
          FOR UPDATE`,
        [organization, agent],
      );
      const row = current.rows[0];
      if (row === undefined) fail('TENANT_STORE_NOT_FOUND');
      if (row.status === 'revoked') fail('TENANT_STORE_CONFLICT');
      await this.#recheckSession(client, hash, requireString(session.account_id));
      const updated = await client.query<AgentRow>(
        `UPDATE openarc_tenant.agents
            SET display_name = COALESCE($3, display_name),
                status = COALESCE($4, status),
                updated_at = clock_timestamp()
          WHERE organization_id = $1 AND agent_id = $2
          RETURNING agent_id, organization_id, display_name, status, created_at, updated_at`,
        [organization, agent, name, status],
      );
      const result = updated.rows[0];
      if (result === undefined) fail('TENANT_STORE_UNAVAILABLE');
      return this.#projectAgent(result);
    });
  }

  /** Owner/operator/viewer read agents. */
  async listAgents(
    sessionHash: unknown,
    organizationId: unknown,
    input?: ListAgentsInput,
  ): Promise<ListAgentsResult> {
    const hash = requireSessionHash(sessionHash);
    const organization = requireOrganizationId(organizationId);
    const limit = requirePageSize(input?.limit);
    const after = input?.afterAgentId === undefined ? null : requireAgentId(input.afterAgentId);

    return this.#withTransaction(async (client) => {
      const access = await this.#lockOrganizationAccess(client, hash, organization);
      this.#requireRole(access.out_role, AGENT_READ_ROLES);
      const rows = await client.query<AgentRow>(
        `SELECT agent_id, organization_id, display_name, status, created_at, updated_at
           FROM openarc_tenant.agents
          WHERE organization_id = $1
            AND ($2::text IS NULL OR agent_id > $2)
          ORDER BY agent_id
          LIMIT $3`,
        [organization, after, limit + 1],
      );
      const visible = rows.rows.slice(0, limit);
      const nextCursor =
        rows.rows.length > limit ? requireString(visible[visible.length - 1]?.agent_id) : null;
      return { items: visible.map((row) => this.#projectAgent(row)), nextCursor };
    });
  }

  /** Owner-only create an active provider. */
  async createProvider(
    sessionHash: unknown,
    organizationId: unknown,
    displayName: unknown,
  ): Promise<CommerceProviderProfile> {
    const hash = requireSessionHash(sessionHash);
    const organization = requireOrganizationId(organizationId);
    const name = requireDisplayName(displayName);

    return this.#withTransaction(async (client) => {
      const session = await this.#lockSession(client, hash);
      const access = await this.#lockOrganizationAccess(client, hash, organization);
      this.#requireRole(access.out_role, OWNER_ONLY);
      await this.#recheckSession(client, hash, requireString(session.account_id));
      const providerId = `openarc:provider:${randomUUID()}`;
      const inserted = await client.query<ProviderRow>(
        `INSERT INTO openarc_tenant.providers (organization_id, provider_id, display_name)
         VALUES ($1, $2, $3)
         RETURNING provider_id, organization_id, display_name, status, created_at, updated_at`,
        [organization, providerId, name],
      );
      const row = inserted.rows[0];
      if (row === undefined) fail('TENANT_STORE_UNAVAILABLE');
      // Same post-wait guard as createAgent: the provider INSERT may block, so
      // re-validate the held session before COMMIT.
      await this.#recheckSession(client, hash, requireString(session.account_id));
      return this.#projectProvider(row);
    });
  }

  /** Owner-only update a non-terminal provider. */
  async updateProvider(
    sessionHash: unknown,
    organizationId: unknown,
    providerId: unknown,
    patch: UpdateProviderPatch,
  ): Promise<CommerceProviderProfile> {
    const hash = requireSessionHash(sessionHash);
    const organization = requireOrganizationId(organizationId);
    const provider = requireProviderId(providerId);
    const patchFields = requireUpdatePatch(patch, PROVIDER_PATCH_KEYS);
    const hasName = patchFields['displayName'] !== undefined;
    const hasStatus = patchFields['status'] !== undefined;
    const name = hasName ? requireDisplayName(patchFields['displayName']) : null;
    const status = hasStatus ? requireProviderStatus(patchFields['status']) : null;

    return this.#withTransaction(async (client) => {
      const session = await this.#lockSession(client, hash);
      const access = await this.#lockOrganizationAccess(client, hash, organization);
      this.#requireRole(access.out_role, OWNER_ONLY);
      const current = await client.query<ProviderRow>(
        `SELECT provider_id, organization_id, display_name, status, created_at, updated_at
           FROM openarc_tenant.providers
          WHERE organization_id = $1 AND provider_id = $2
          FOR UPDATE`,
        [organization, provider],
      );
      const row = current.rows[0];
      if (row === undefined) fail('TENANT_STORE_NOT_FOUND');
      if (row.status === 'retired') fail('TENANT_STORE_CONFLICT');
      await this.#recheckSession(client, hash, requireString(session.account_id));
      const updated = await client.query<ProviderRow>(
        `UPDATE openarc_tenant.providers
            SET display_name = COALESCE($3, display_name),
                status = COALESCE($4, status),
                updated_at = clock_timestamp()
          WHERE organization_id = $1 AND provider_id = $2
          RETURNING provider_id, organization_id, display_name, status, created_at, updated_at`,
        [organization, provider, name, status],
      );
      const result = updated.rows[0];
      if (result === undefined) fail('TENANT_STORE_UNAVAILABLE');
      return this.#projectProvider(result);
    });
  }

  /** Owner-only read providers. */
  async listProviders(
    sessionHash: unknown,
    organizationId: unknown,
    input?: ListProvidersInput,
  ): Promise<ListProvidersResult> {
    const hash = requireSessionHash(sessionHash);
    const organization = requireOrganizationId(organizationId);
    const limit = requirePageSize(input?.limit);
    const after =
      input?.afterProviderId === undefined ? null : requireProviderId(input.afterProviderId);

    return this.#withTransaction(async (client) => {
      const access = await this.#lockOrganizationAccess(client, hash, organization);
      this.#requireRole(access.out_role, OWNER_ONLY);
      const rows = await client.query<ProviderRow>(
        `SELECT provider_id, organization_id, display_name, status, created_at, updated_at
           FROM openarc_tenant.providers
          WHERE organization_id = $1
            AND ($2::text IS NULL OR provider_id > $2)
          ORDER BY provider_id
          LIMIT $3`,
        [organization, after, limit + 1],
      );
      const visible = rows.rows.slice(0, limit);
      const nextCursor =
        rows.rows.length > limit ? requireString(visible[visible.length - 1]?.provider_id) : null;
      return { items: visible.map((row) => this.#projectProvider(row)), nextCursor };
    });
  }

  /**
   * Owner-only membership mutation through the self-validating SQL helper.
   * No org/caller/account prelock is performed here: the helper owns the
   * fixed sorted-account -> session -> organization -> membership order and
   * all freshness/last-owner/revocation invariants.
   */
  async setMembership(
    sessionHash: unknown,
    organizationId: unknown,
    existingAccountId: unknown,
    role: unknown,
    status: unknown,
  ): Promise<MembershipProjection> {
    const hash = requireSessionHash(sessionHash);
    const organization = requireOrganizationId(organizationId);
    const account = requireAccountId(existingAccountId);
    const requestedRole = requireHumanRole(role);
    const requestedStatus = requireMembershipStatus(status);

    return this.#withTransaction(async (client) => {
      const result = await client.query<MembershipRow>(
        `SELECT out_organization_id AS organization_id,
                out_account_id AS account_id,
                out_role AS role,
                out_status AS status,
                out_created_at AS created_at,
                out_updated_at AS updated_at
           FROM openarc_tenant.set_membership($1, $2, $3, $4, $5)`,
        [hash, organization, account, requestedRole, requestedStatus],
      );
      const row = result.rows[0];
      if (row === undefined) fail('TENANT_STORE_UNAVAILABLE');
      return this.#projectMembership(row);
    });
  }

  /* ---------------------------------------------------------------- */
  /* Internal helpers                                                  */
  /* ---------------------------------------------------------------- */

  async #withTransaction<T>(work: (client: TenantClient) => Promise<T>): Promise<T> {
    let client: TenantClient;
    try {
      client = await this.#pool.connect();
    } catch {
      fail('TENANT_STORE_UNAVAILABLE');
    }

    try {
      await client.query('BEGIN');
    } catch {
      this.#release(client, true);
      fail('TENANT_STORE_UNAVAILABLE');
    }

    let result: T;
    try {
      result = await work(client);
    } catch (error) {
      let rolledBack = false;
      try {
        await client.query('ROLLBACK');
        rolledBack = true;
      } catch {
        rolledBack = false;
      }
      this.#release(client, !rolledBack);
      throw normalizeError(error);
    }

    // A lost COMMIT reply means the mutation may actually have committed; the
    // transaction is never rolled back and the outcome is explicitly unknown.
    try {
      await client.query('COMMIT');
    } catch {
      this.#release(client, true);
      fail('TENANT_STORE_OUTCOME_UNKNOWN');
    }

    // Already committed: a release failure must not be reported as a failure.
    this.#release(client, false);
    return result;
  }

  #release(client: TenantClient, destroy: boolean): void {
    try {
      client.release(destroy);
    } catch {
      // A release failure after a confirmed outcome cannot change that outcome.
    }
  }

  async #setConfig(client: TenantClient, key: string, value: string): Promise<void> {
    await client.query('SELECT set_config($1, $2, true)', [key, value]);
  }

  async #databaseNow(client: TenantClient): Promise<Date> {
    const result = await client.query<{ now: Date }>('SELECT clock_timestamp() AS now');
    return requireDate(result.rows[0]?.now);
  }

  async #lockSession(client: TenantClient, hash: string): Promise<SessionRow> {
    const result = await client.query<SessionRow>(
      `SELECT account_id, method, session_created_at, session_expires_at
         FROM openarc_tenant.lock_auth_session($1, NULL)`,
      [hash],
    );
    const row = result.rows[0];
    if (row === undefined) fail('TENANT_STORE_SESSION_INVALID');
    return row;
  }

  async #recheckSession(client: TenantClient, hash: string, expectedActor: string): Promise<void> {
    const row = await this.#lockSession(client, hash);
    if (row.account_id !== expectedActor) fail('TENANT_STORE_SESSION_INVALID');
  }

  /**
   * Lock the same bootstrap proof and validate it against the database clock:
   * a live passkey/wallet session bound to the active account with a proof no
   * older than five minutes. Safe to call again in the same transaction after
   * a wait; no new account is locked.
   */
  async #lockFreshBootstrapSession(client: TenantClient, hash: string): Promise<SessionRow> {
    const session = await this.#lockSession(client, hash);
    if (session.method !== 'passkey' && session.method !== 'wallet') {
      fail('TENANT_STORE_SESSION_INVALID');
    }
    const now = await this.#databaseNow(client);
    if (!(requireDate(session.session_created_at).getTime() > now.getTime() - FRESH_PROOF_MILLIS)) {
      fail('TENANT_STORE_SESSION_INVALID');
    }
    return session;
  }

  async #lockOrganizationAccess(
    client: TenantClient,
    hash: string,
    organization: string,
  ): Promise<LockAccessRow> {
    const result = await client.query<LockAccessRow>(
      `SELECT out_organization_id, out_role
         FROM openarc_tenant.lock_organization_access($1, $2)`,
      [hash, organization],
    );
    const row = result.rows[0];
    if (row === undefined) fail('TENANT_STORE_FORBIDDEN');
    return row;
  }

  #requireRole(actual: string, allowed: readonly CommerceHumanRole[]): void {
    const role = requireHumanRole(actual);
    if (!allowed.includes(role)) fail('TENANT_STORE_FORBIDDEN');
  }

  async #readOrganization(
    client: TenantClient,
    organizationId: string,
  ): Promise<CommerceOrganization> {
    const result = await client.query<OrganizationRow>(
      `SELECT organization_id, display_name, created_at, updated_at
         FROM openarc_tenant.organizations
        WHERE organization_id = $1`,
      [organizationId],
    );
    const row = result.rows[0];
    if (row === undefined) fail('TENANT_STORE_NOT_FOUND');
    return this.#projectOrganization(row);
  }

  async #listOwnedOrganizationIds(
    client: TenantClient,
    hash: string,
    after: string | null,
    pageSize: number,
  ): Promise<TenantQueryResult<{ organization_id: string }>> {
    return client.query<{ organization_id: string }>(
      `SELECT organization_id
         FROM openarc_tenant.list_account_organization_ids($1, $2, $3)`,
      [hash, after, pageSize],
    );
  }

  #projectOrganization(row: OrganizationRow): CommerceOrganization {
    return parseCanonical(CommerceOrganizationSchema, {
      schemaVersion: 'openarc.organization.v1',
      organizationId: requireOrganizationId(row.organization_id),
      displayName: requireDisplayName(row.display_name),
      createdAt: requireCanonicalTimestamp(isoUtc(row.created_at)),
      updatedAt: requireCanonicalTimestamp(isoUtc(row.updated_at)),
    });
  }

  #projectAccess(value: {
    organizationId: string;
    accountId: string;
    role: CommerceHumanRole;
    membershipStatus: 'active' | 'suspended';
    sessionExpiresAt: string;
  }): CommerceOrganizationAccessView {
    return parseCanonical(CommerceOrganizationAccessViewSchema, {
      schemaVersion: 'openarc.organization-access.v1',
      organizationId: requireOrganizationId(value.organizationId),
      accountId: requireAccountId(value.accountId),
      role: requireHumanRole(value.role),
      membershipStatus: requireMembershipStatus(value.membershipStatus),
      sessionExpiresAt: requireCanonicalTimestamp(value.sessionExpiresAt),
    });
  }

  #projectMembership(row: MembershipRow): MembershipProjection {
    const createdAt = requireCanonicalTimestamp(isoUtc(row.created_at));
    const updatedAt = requireCanonicalTimestamp(isoUtc(row.updated_at));
    requireNonDecreasing(createdAt, updatedAt);
    return {
      organizationId: requireOrganizationId(row.organization_id),
      accountId: requireAccountId(row.account_id),
      role: requireHumanRole(row.role),
      status: requireMembershipStatus(row.status),
      createdAt,
      updatedAt,
    };
  }

  #projectAgent(row: AgentRow): CommerceAgentProfile {
    return parseCanonical(CommerceAgentProfileSchema, {
      schemaVersion: 'openarc.agent-profile.v1',
      agentId: requireAgentId(row.agent_id),
      organizationId: requireOrganizationId(row.organization_id),
      displayName: requireDisplayName(row.display_name),
      status: requireAgentStatus(row.status),
      createdAt: requireCanonicalTimestamp(isoUtc(row.created_at)),
      updatedAt: requireCanonicalTimestamp(isoUtc(row.updated_at)),
    });
  }

  #projectProvider(row: ProviderRow): CommerceProviderProfile {
    return parseCanonical(CommerceProviderProfileSchema, {
      schemaVersion: 'openarc.provider-profile.v1',
      providerId: requireProviderId(row.provider_id),
      organizationId: requireOrganizationId(row.organization_id),
      displayName: requireDisplayName(row.display_name),
      status: requireProviderStatus(row.status),
      createdAt: requireCanonicalTimestamp(isoUtc(row.created_at)),
      updatedAt: requireCanonicalTimestamp(isoUtc(row.updated_at)),
    });
  }

  /**
   * Exact compatibility between the applied migration metadata and the
   * bundled manifest. Reuses loadMigrations() and the migrator's ordered
   * ID + SHA-256 checksum semantics, never runs a migration, and rejects
   * fewer (older), more (newer), reordered/mismatched and drifted rows.
   */
  #assertExactManifest(
    applied: readonly { readonly id: string; readonly checksum: string }[],
  ): void {
    let migrations: readonly SqlMigration[];
    try {
      migrations = loadMigrations();
    } catch {
      fail('TENANT_STORE_UNAVAILABLE');
    }
    if (applied.length !== migrations.length) fail('TENANT_STORE_UNAVAILABLE');
    for (let index = 0; index < applied.length; index += 1) {
      const record = applied[index];
      const manifest = migrations[index];
      if (record === undefined || manifest === undefined) fail('TENANT_STORE_UNAVAILABLE');
      if (record.id !== manifest.id) fail('TENANT_STORE_UNAVAILABLE');
      const checksum = createHash('sha256').update(manifest.sql, 'utf8').digest('hex');
      if (record.checksum !== checksum) fail('TENANT_STORE_UNAVAILABLE');
    }
  }

  /**
   * Read-only role/schema readiness. The runtime must be the exact restricted
   * tenant role, transitively a member of no elevated role, and the owner of
   * no tenant object. It must not be a member of the auth or migrator roles.
   */
  async #assertReady(client: TenantClient): Promise<void> {
    const roleResult = await client.query<{
      role: string;
      rolsuper: boolean;
      rolbypassrls: boolean;
      rolcreatedb: boolean;
      rolcreaterole: boolean;
      elevated_memberships: number;
      migrator_member: boolean;
      auth_member: boolean;
    }>(
      `SELECT current_user AS role,
              r.rolsuper, r.rolbypassrls, r.rolcreatedb, r.rolcreaterole,
              (SELECT count(*)::int
                 FROM pg_roles g
                WHERE (g.rolsuper OR g.rolbypassrls OR g.rolcreatedb OR g.rolcreaterole)
                  AND pg_has_role(current_user, g.oid, 'MEMBER')) AS elevated_memberships,
              pg_has_role(current_user, 'openarc_migrator', 'MEMBER') AS migrator_member,
              pg_has_role(current_user, 'openarc_auth_app', 'MEMBER') AS auth_member
         FROM pg_roles r
        WHERE r.rolname = current_user`,
    );
    const role = roleResult.rows[0];
    if (role === undefined) fail('TENANT_STORE_UNAVAILABLE');
    const ready =
      role.role === 'openarc_tenant_app' &&
      role.rolsuper === false &&
      role.rolbypassrls === false &&
      role.rolcreatedb === false &&
      role.rolcreaterole === false &&
      role.elevated_memberships === 0 &&
      role.migrator_member === false &&
      role.auth_member === false;
    if (!ready) fail('TENANT_STORE_UNAVAILABLE');

    const schemaOwner = await client.query<{ owner: string }>(
      `SELECT pg_get_userbyid(nspowner) AS owner
         FROM pg_namespace WHERE nspname = 'openarc_tenant'`,
    );
    if (schemaOwner.rows[0]?.owner === role.role) fail('TENANT_STORE_UNAVAILABLE');

    const tables = await client.query<{ n: number; all_enabled: boolean; all_forced: boolean }>(
      `SELECT count(*)::int AS n,
              bool_and(c.relrowsecurity) AS all_enabled,
              bool_and(c.relforcerowsecurity) AS all_forced
         FROM pg_class c
         JOIN pg_namespace ns ON ns.oid = c.relnamespace
        WHERE ns.nspname = 'openarc_tenant'
          AND c.relkind = 'r'
          AND c.relname IN ('organizations', 'memberships', 'agents', 'providers')`,
    );
    const tableState = tables.rows[0];
    if (
      tableState === undefined ||
      tableState.n !== 4 ||
      tableState.all_enabled !== true ||
      tableState.all_forced !== true
    ) {
      fail('TENANT_STORE_UNAVAILABLE');
    }

    const owned = await client.query<{ n: number }>(
      `SELECT count(*)::int AS n
         FROM pg_class c
         JOIN pg_namespace ns ON ns.oid = c.relnamespace
        WHERE ns.nspname = 'openarc_tenant' AND pg_get_userbyid(c.relowner) = current_user`,
    );
    if ((owned.rows[0]?.n ?? 0) !== 0) fail('TENANT_STORE_UNAVAILABLE');

    const functions = await client.query<{ name: string }>(
      `SELECT p.proname AS name
         FROM pg_proc p
         JOIN pg_namespace ns ON ns.oid = p.pronamespace
        WHERE ns.nspname = 'openarc_tenant' AND p.prorettype <> 'trigger'::regtype
        ORDER BY p.proname`,
    );
    const expected = [
      'current_context_access_kind',
      'list_account_organization_ids',
      'lock_auth_session',
      'lock_organization_access',
      'set_membership',
    ];
    if (functions.rows.map((row) => row.name).join(',') !== expected.join(',')) {
      fail('TENANT_STORE_UNAVAILABLE');
    }

    const applied = await client.query<{ id: string; checksum: string }>(
      `SELECT id, checksum
         FROM openarc_meta.schema_migrations
        ORDER BY id`,
    );
    this.#assertExactManifest(applied.rows);
  }
}

/** Structural adapter for callers that hold a raw `pg` Pool. */
export function asTenantPool(pool: Pool): TenantPool {
  return pool as unknown as TenantPool;
}

export type { PoolClient };
