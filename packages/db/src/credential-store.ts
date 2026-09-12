import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import { loadMigrations } from './migrate.js';
import { TenantStore, type TenantClient, type TenantPool } from './tenant-store.js';
import { parseMutationId, type DurableReceiptRow } from './tenant-durability.js';
import {
  CREDENTIAL_RESOURCE_BY_OPERATION,
  credentialKeyPrefix,
  digestCredentialIdempotencyKey,
  digestCredentialIssueRequest,
  digestCredentialRevokeRequest,
  digestCredentialSessionContext,
  parseCanonicalBase64Url,
  parseCredentialHashInput,
  parseCredentialId,
  type CredentialHashInput,
  type CredentialKind,
  type CredentialMutationReceipt,
  type CredentialMutationResult,
  type CredentialMutationStatus,
  type CredentialOperation,
  type CredentialResourceType,
} from './credential-mutations.js';

/**
 * CredentialStore over the restricted tenant pool. Every method runs in one
 * connection/transaction through the reviewed SECURITY DEFINER helpers. It
 * never migrates, never accepts a principal/role/hash metadata object as
 * authority, and never imports the API crypto layer.
 */

export const CREDENTIAL_STORE_ERROR_MESSAGES = {
  CREDENTIAL_STORE_INPUT_INVALID: 'CredentialStore input is invalid.',
  CREDENTIAL_STORE_SESSION_INVALID: 'CredentialStore session is not valid.',
  CREDENTIAL_STORE_FORBIDDEN: 'CredentialStore caller is not permitted.',
  CREDENTIAL_STORE_NOT_FOUND: 'CredentialStore target was not found.',
  CREDENTIAL_STORE_CONFLICT: 'CredentialStore operation conflicts with existing state.',
  CREDENTIAL_STORE_IDEMPOTENCY_CONFLICT:
    'CredentialStore mutation conflicts with an existing idempotency record.',
  CREDENTIAL_STORE_UNAVAILABLE: 'CredentialStore is not available.',
  CREDENTIAL_STORE_OUTCOME_UNKNOWN:
    'CredentialStore mutation outcome could not be confirmed; it may have committed.',
} as const;

export type CredentialStoreErrorCode = keyof typeof CREDENTIAL_STORE_ERROR_MESSAGES;

export class CredentialStoreError extends Error {
  readonly code: CredentialStoreErrorCode;

  constructor(code: CredentialStoreErrorCode) {
    super(CREDENTIAL_STORE_ERROR_MESSAGES[code]);
    this.name = 'CredentialStoreError';
    this.code = code;
  }
}

export interface CredentialStorePort {
  connect(): Promise<TenantClient>;
}

export interface CredentialMutationMetadata {
  readonly idempotencyKey: string;
  readonly mutationId: string;
}

export interface IssueCredentialInput {
  readonly sessionHash: string;
  readonly organizationId: string;
  readonly profileId: string;
  readonly lookupId: string;
  readonly hash: CredentialHashInput;
  readonly expiresAt: string;
  readonly metadata: CredentialMutationMetadata;
}

export interface RevokeCredentialInput {
  readonly sessionHash: string;
  readonly organizationId: string;
  readonly credentialId: string;
  readonly metadata: CredentialMutationMetadata;
}

export interface ListCredentialsInput {
  readonly sessionHash: string;
  readonly organizationId: string;
  readonly profileId: string;
  readonly after?: string;
  readonly limit?: number;
}

export type CredentialStatus = 'active' | 'revoked' | 'expired';

export interface CredentialMetadata {
  readonly credentialId: string;
  readonly kind: CredentialKind;
  readonly profileId: string;
  readonly keyPrefix: string;
  readonly environment: 'eip155:5042002';
  readonly scope: string;
  readonly scopeVersion: 1;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly revokedAt: string | null;
  readonly status: CredentialStatus;
}

export interface ListCredentialsResult {
  readonly items: CredentialMetadata[];
  readonly nextCursor: string | null;
}

export interface CredentialVerifierSnapshot {
  readonly organizationId: string;
  readonly credentialId: string;
  readonly kind: CredentialKind;
  readonly profileId: string;
  readonly issuerAccountId: string;
  readonly scope: string;
  readonly scopeVersion: 1;
  readonly environment: 'eip155:5042002';
  readonly algorithm: 'scrypt';
  readonly hashVersion: 1;
  readonly pepperVersion: number;
  readonly N: 32768;
  readonly r: 8;
  readonly p: 1;
  readonly salt: string;
  readonly digest: string;
  readonly keyPrefix: string;
  readonly revocationVersion: number;
  readonly expiresAt: string;
}

export interface MachineSessionMetadata {
  readonly sessionId: string;
  readonly credentialId: string;
  readonly organizationId: string;
  readonly kind: CredentialKind;
  readonly profileId: string;
  readonly issuerAccountId?: string;
  readonly scope: string;
  readonly scopeVersion: 1;
  readonly environment: 'eip155:5042002';
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly revocationVersion: number;
}

export interface CreateSessionInput {
  readonly organizationId: string;
  readonly profileId: string;
  readonly credentialId: string;
  readonly expectedVersion: number;
  readonly sessionId: string;
  readonly tokenHash: string;
  readonly expiresAt: string;
}

export interface RevokeSessionResult {
  readonly sessionId: string;
  readonly organizationId: string;
  readonly revokedAt: string;
  readonly revocationVersion: number;
}

const HEX64 = /^[0-9a-f]{64}$/;
const ORG_ID = /^openarc:org:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const AGENT_ID = /^openarc:agent:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const PROVIDER_ID = /^openarc:provider:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const CANONICAL_TS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

const DEFAULT_PAGE = 50;
const MAX_PAGE = 50;

function fail(code: CredentialStoreErrorCode): never {
  throw new CredentialStoreError(code);
}

function requireSessionHash(value: unknown): string {
  if (typeof value !== 'string' || !HEX64.test(value)) fail('CREDENTIAL_STORE_INPUT_INVALID');
  return value;
}

function requireOrganization(value: unknown): string {
  if (typeof value !== 'string' || !ORG_ID.test(value)) fail('CREDENTIAL_STORE_INPUT_INVALID');
  return value;
}

function requireAgent(value: unknown): string {
  if (typeof value !== 'string' || !AGENT_ID.test(value)) fail('CREDENTIAL_STORE_INPUT_INVALID');
  return value;
}

function requireProvider(value: unknown): string {
  if (typeof value !== 'string' || !PROVIDER_ID.test(value)) fail('CREDENTIAL_STORE_INPUT_INVALID');
  return value;
}

function requireProfile(kind: CredentialKind, value: unknown): string {
  return kind === 'agent' ? requireAgent(value) : requireProvider(value);
}

function requireCredentialId(value: unknown): string {
  try {
    return parseCredentialId(value);
  } catch {
    fail('CREDENTIAL_STORE_INPUT_INVALID');
  }
}

function requireExpiresAt(value: unknown): string {
  if (typeof value !== 'string' || !CANONICAL_TS.test(value) || Number.isNaN(Date.parse(value))) {
    fail('CREDENTIAL_STORE_INPUT_INVALID');
  }
  return value;
}

function requireTokenHash(value: unknown): string {
  if (typeof value !== 'string' || !HEX64.test(value)) fail('CREDENTIAL_STORE_INPUT_INVALID');
  return value;
}

function requireMetadata(value: unknown): CredentialMutationMetadata {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    fail('CREDENTIAL_STORE_INPUT_INVALID');
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    fail('CREDENTIAL_STORE_INPUT_INVALID');
  }
  const keys = Object.keys(value);
  if (keys.length !== 2 || !keys.includes('idempotencyKey') || !keys.includes('mutationId')) {
    fail('CREDENTIAL_STORE_INPUT_INVALID');
  }
  const record = value as Record<string, unknown>;
  let mutationId: string;
  try {
    mutationId = parseMutationId(record['mutationId']);
  } catch {
    fail('CREDENTIAL_STORE_INPUT_INVALID');
  }
  try {
    parseCanonicalBase64Url(record['idempotencyKey'], 32);
  } catch {
    fail('CREDENTIAL_STORE_INPUT_INVALID');
  }
  return { idempotencyKey: record['idempotencyKey'] as string, mutationId };
}

function requireLimit(value: unknown): number {
  if (value === undefined) return DEFAULT_PAGE;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > MAX_PAGE) {
    fail('CREDENTIAL_STORE_INPUT_INVALID');
  }
  return value;
}

function requireCredentialStatus(value: unknown): CredentialStatus {
  if (value !== 'active' && value !== 'revoked' && value !== 'expired') {
    fail('CREDENTIAL_STORE_UNAVAILABLE');
  }
  return value;
}

function normalizeError(error: unknown): CredentialStoreError {
  if (error instanceof CredentialStoreError) return error;
  if (typeof error === 'object' && error !== null && typeof (error as { code?: unknown }).code === 'string') {
    switch ((error as { code: string }).code) {
      case '28000':
        return new CredentialStoreError('CREDENTIAL_STORE_SESSION_INVALID');
      case '42501':
        return new CredentialStoreError('CREDENTIAL_STORE_FORBIDDEN');
      case '23503':
        return new CredentialStoreError('CREDENTIAL_STORE_NOT_FOUND');
      case '23505':
        return new CredentialStoreError('CREDENTIAL_STORE_CONFLICT');
      case 'P0D01':
        return new CredentialStoreError('CREDENTIAL_STORE_IDEMPOTENCY_CONFLICT');
      case '22023':
      case '22P02':
      case '22001':
      case '22003':
      case '23514':
        return new CredentialStoreError('CREDENTIAL_STORE_INPUT_INVALID');
      default:
        return new CredentialStoreError('CREDENTIAL_STORE_UNAVAILABLE');
    }
  }
  return new CredentialStoreError('CREDENTIAL_STORE_UNAVAILABLE');
}

interface ReceiptRow extends DurableReceiptRow {
  readonly out_replayed: boolean;
}

interface CredentialListRow extends Record<string, unknown> {
  readonly out_credential_id: string;
  readonly out_lookup_id: string;
  readonly out_scope: string;
  readonly out_environment: string;
  readonly out_key_prefix: string;
  readonly out_created_at: Date;
  readonly out_expires_at: Date;
  readonly out_revoked_at: Date | null;
  readonly out_status: string;
}

function iso(value: unknown): string {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) fail('CREDENTIAL_STORE_UNAVAILABLE');
  return value.toISOString();
}

function canonicalScope(kind: CredentialKind, value: unknown): string {
  if (typeof value !== 'string') fail('CREDENTIAL_STORE_UNAVAILABLE');
  const expected = kind === 'agent' ? 'agent:self.read' : 'provider:self.read';
  if (value !== expected) fail('CREDENTIAL_STORE_UNAVAILABLE');
  return value;
}

/**
 * Credential repository bound to a pool authenticated as openarc_tenant_app.
 */
export class CredentialStore {
  readonly #pool: TenantPool;
  readonly #base: TenantStore;
  #initialized = false;

  constructor(pool: CredentialStorePort) {
    if (pool === null || typeof pool !== 'object' || typeof pool.connect !== 'function') {
      fail('CREDENTIAL_STORE_INPUT_INVALID');
    }
    this.#pool = pool as TenantPool;
    this.#base = new TenantStore(this.#pool);
  }

  /** Verify the frozen schema, restricted role and credential ACLs exactly once. */
  async initialize(): Promise<void> {
    if (this.#initialized) return;
    await this.#baseChecks(() => this.#base.initialize());
    await this.#withTransaction(async (client) => {
      await this.#assertCredentialReady(client);
    });
    this.#initialized = true;
  }

  async readiness(): Promise<void> {
    await this.#baseChecks(() => this.#base.readiness());
    await this.#withTransaction(async (client) => {
      await this.#assertCredentialReady(client);
    });
  }

  /**
   * Compose the accepted TenantStore checks but normalize any of its fixed
   * errors to this store's fixed vocabulary so no tenant error leaks.
   */
  async #baseChecks(run: () => Promise<void>): Promise<void> {
    try {
      await run();
    } catch {
      fail('CREDENTIAL_STORE_UNAVAILABLE');
    }
  }

  async issueAgentCredentialDurably(input: IssueCredentialInput): Promise<CredentialMutationResult> {
    return this.#issue('agent', input);
  }

  async issueProviderCredentialDurably(input: IssueCredentialInput): Promise<CredentialMutationResult> {
    return this.#issue('provider', input);
  }

  async revokeAgentCredentialDurably(input: RevokeCredentialInput): Promise<CredentialMutationResult> {
    return this.#revoke('agent', input);
  }

  async revokeProviderCredentialDurably(input: RevokeCredentialInput): Promise<CredentialMutationResult> {
    return this.#revoke('provider', input);
  }

  async listAgentCredentials(input: ListCredentialsInput): Promise<ListCredentialsResult> {
    return this.#list('agent', input);
  }

  async listProviderCredentials(input: ListCredentialsInput): Promise<ListCredentialsResult> {
    return this.#list('provider', input);
  }

  async getAgentCredentialMutationStatus(
    sessionHash: unknown,
    organizationId: unknown,
    mutationId: unknown,
  ): Promise<CredentialMutationStatus> {
    return this.#status('agent', sessionHash, organizationId, mutationId);
  }

  async getProviderCredentialMutationStatus(
    sessionHash: unknown,
    organizationId: unknown,
    mutationId: unknown,
  ): Promise<CredentialMutationStatus> {
    return this.#status('provider', sessionHash, organizationId, mutationId);
  }

  async findAgentCredentialVerifier(lookupId: unknown): Promise<CredentialVerifierSnapshot> {
    return this.#verifier('agent', lookupId);
  }

  async findProviderCredentialVerifier(lookupId: unknown): Promise<CredentialVerifierSnapshot> {
    return this.#verifier('provider', lookupId);
  }

  async createAgentSession(input: CreateSessionInput): Promise<MachineSessionMetadata> {
    return this.#createSession('agent', input);
  }

  async createProviderSession(input: CreateSessionInput): Promise<MachineSessionMetadata> {
    return this.#createSession('provider', input);
  }

  async getAgentSession(tokenHash: unknown): Promise<MachineSessionMetadata> {
    return this.#getSession('agent', tokenHash);
  }

  async getProviderSession(tokenHash: unknown): Promise<MachineSessionMetadata> {
    return this.#getSession('provider', tokenHash);
  }

  async revokeAgentSession(tokenHash: unknown): Promise<RevokeSessionResult> {
    return this.#revokeSession('agent', tokenHash);
  }

  async revokeProviderSession(tokenHash: unknown): Promise<RevokeSessionResult> {
    return this.#revokeSession('provider', tokenHash);
  }

  async #issue(kind: CredentialKind, input: IssueCredentialInput): Promise<CredentialMutationResult> {
    if (typeof input !== 'object' || input === null) fail('CREDENTIAL_STORE_INPUT_INVALID');
    const sessionHash = requireSessionHash(input.sessionHash);
    const organization = requireOrganization(input.organizationId);
    const profile = requireProfile(kind, input.profileId);
    const lookup = requireCredentialId(input.lookupId);
    const hash = parseHashInput(input.hash);
    const expiresAt = requireExpiresAt(input.expiresAt);
    const metadata = requireMetadata(input.metadata);
    const operation: CredentialOperation =
      kind === 'agent' ? 'tenant.agent.credential.issue' : 'tenant.provider.credential.issue';
    const sessionContextDigest = digestCredentialSessionContext(operation, sessionHash);
    const keyHash = digestCredentialIdempotencyKey(operation, metadata.idempotencyKey);
    const keyPrefix = credentialKeyPrefix(kind, lookup);
    const helper = kind === 'agent'
      ? 'openarc_durable.commit_agent_credential_issue'
      : 'openarc_durable.commit_provider_credential_issue';

    return this.#withTransaction(async (client) => {
      const actor = await this.#lockSessionActor(client, sessionHash);
      const role = await this.#lockOrganizationRole(client, sessionHash, organization, actor);
      const requestDigest = digestCredentialIssueRequest(
        operation as 'tenant.agent.credential.issue',
        {
          organizationId: organization,
          actorAccountId: actor,
          actorRole: role,
          sessionContextDigest,
          mutationId: metadata.mutationId,
        },
        profile,
        expiresAt,
      );
      const result = await client.query<ReceiptRow>(
        `SELECT out_replayed, out_mutation_id, out_operation, out_resource_type,
                out_resource_id, out_committed_at
           FROM ${helper}($1, $2, $3, $4::uuid, $5::uuid, $6, $7, $8, $9, $10::timestamptz,
                          $11::uuid, $12, $13, $14)`,
        [
          sessionHash,
          organization,
          profile,
          metadata.mutationId,
          lookup,
          keyPrefix,
          hash.pepperVersion,
          hash.salt,
          hash.digest,
          expiresAt,
          metadata.mutationId,
          keyHash,
          requestDigest,
          sessionContextDigest,
        ],
      );
      const row = result.rows[0];
      if (row === undefined) fail('CREDENTIAL_STORE_UNAVAILABLE');
      return {
        replayed: row.out_replayed === true,
        receipt: this.#projectReceipt(row, operation),
      };
    });
  }

  async #revoke(kind: CredentialKind, input: RevokeCredentialInput): Promise<CredentialMutationResult> {
    if (typeof input !== 'object' || input === null) fail('CREDENTIAL_STORE_INPUT_INVALID');
    const sessionHash = requireSessionHash(input.sessionHash);
    const organization = requireOrganization(input.organizationId);
    const credential = requireCredentialId(input.credentialId);
    const metadata = requireMetadata(input.metadata);
    const operation: CredentialOperation =
      kind === 'agent' ? 'tenant.agent.credential.revoke' : 'tenant.provider.credential.revoke';
    const sessionContextDigest = digestCredentialSessionContext(operation, sessionHash);
    const keyHash = digestCredentialIdempotencyKey(operation, metadata.idempotencyKey);
    const helper = kind === 'agent'
      ? 'openarc_durable.commit_agent_credential_revoke'
      : 'openarc_durable.commit_provider_credential_revoke';

    return this.#withTransaction(async (client) => {
      const actor = await this.#lockSessionActor(client, sessionHash);
      const role = await this.#lockOrganizationRole(client, sessionHash, organization, actor);
      const requestDigest = digestCredentialRevokeRequest(
        operation as 'tenant.agent.credential.revoke',
        {
          organizationId: organization,
          actorAccountId: actor,
          actorRole: role,
          sessionContextDigest,
          mutationId: metadata.mutationId,
        },
        credential,
      );
      const result = await client.query<ReceiptRow>(
        `SELECT out_replayed, out_mutation_id, out_operation, out_resource_type,
                out_resource_id, out_committed_at
           FROM ${helper}($1, $2, $3::uuid, $4::uuid, $5, $6, $7)`,
        [sessionHash, organization, credential, metadata.mutationId, keyHash, requestDigest, sessionContextDigest],
      );
      const row = result.rows[0];
      if (row === undefined) fail('CREDENTIAL_STORE_UNAVAILABLE');
      return {
        replayed: row.out_replayed === true,
        receipt: this.#projectReceipt(row, operation),
      };
    });
  }

  async #list(kind: CredentialKind, input: ListCredentialsInput): Promise<ListCredentialsResult> {
    if (typeof input !== 'object' || input === null) fail('CREDENTIAL_STORE_INPUT_INVALID');
    const sessionHash = requireSessionHash(input.sessionHash);
    const organization = requireOrganization(input.organizationId);
    const profile = requireProfile(kind, input.profileId);
    const after = input.after === undefined ? null : requireCredentialId(input.after);
    const limit = requireLimit(input.limit);
    const helper = kind === 'agent'
      ? 'openarc_durable.list_agent_credentials'
      : 'openarc_durable.list_provider_credentials';
    const profileColumn = kind === 'agent' ? 'out_agent_id' : 'out_provider_id';

    return this.#withTransaction(async (client) => {
      const query = (afterId: string | null, take: number) =>
        client.query<CredentialListRow>(
        `SELECT out_credential_id, out_lookup_id, ${profileColumn}, out_scope,
                out_environment, out_key_prefix, out_created_at, out_expires_at,
                out_revoked_at, out_status
           FROM ${helper}($1, $2, $3, $4::uuid, $5)`,
          [sessionHash, organization, profile, afterId, take],
        );
      const result = await query(after, limit);
      const visible = result.rows.slice(0, limit);
      const items = visible.map((row) => this.#projectListRow(kind, row));
      let nextCursor: string | null = null;
      if (result.rows.length === limit && visible.length > 0) {
        const last = requireCredentialId(visible[visible.length - 1]?.out_credential_id);
        const probe = await query(last, 1);
        nextCursor = probe.rows.length > 0 ? last : null;
      }
      return { items, nextCursor };
    });
  }

  async #status(
    kind: CredentialKind,
    sessionHash: unknown,
    organizationId: unknown,
    mutationId: unknown,
  ): Promise<CredentialMutationStatus> {
    const hash = requireSessionHash(sessionHash);
    const organization = requireOrganization(organizationId);
    let mutation: string;
    try {
      mutation = parseMutationId(mutationId);
    } catch {
      fail('CREDENTIAL_STORE_INPUT_INVALID');
    }
    const helper = kind === 'agent'
      ? 'openarc_durable.read_agent_credential_mutation_status'
      : 'openarc_durable.read_provider_credential_mutation_status';
    return this.#withTransaction(async (client) => {
      const result = await client.query<DurableReceiptRow>(
        `SELECT out_mutation_id, out_operation, out_resource_type,
                out_resource_id, out_committed_at
           FROM ${helper}($1, $2, $3::uuid)`,
        [hash, organization, mutation],
      );
      const row = result.rows[0];
      if (row === undefined) return { status: 'not_found' } as const;
      return { status: 'committed' as const, receipt: this.#projectReceipt(row, row.out_operation as CredentialOperation) };
    });
  }

  async #verifier(kind: CredentialKind, lookupId: unknown): Promise<CredentialVerifierSnapshot> {
    const lookup = requireCredentialId(lookupId);
    const helper = kind === 'agent'
      ? 'openarc_durable.find_agent_credential_verifier'
      : 'openarc_durable.find_provider_credential_verifier';
    const profileColumn = kind === 'agent' ? 'out_agent_id' : 'out_provider_id';
    return this.#withTransaction(async (client) => {
      const result = await client.query<Record<string, unknown>>(
        `SELECT out_organization_id, out_credential_id, ${profileColumn}, out_issuer_account_id,
                out_scope, out_scope_version, out_environment, out_algorithm,
                out_hash_version, out_pepper_version, out_kdf_n, out_kdf_r, out_kdf_p,
                out_salt, out_digest, out_key_prefix, out_revocation_version, out_expires_at
           FROM ${helper}($1::uuid)`,
        [lookup],
      );
      const row = result.rows[0];
      if (row === undefined) fail('CREDENTIAL_STORE_NOT_FOUND');
      return this.#projectVerifier(kind, row);
    });
  }

  async #createSession(kind: CredentialKind, input: CreateSessionInput): Promise<MachineSessionMetadata> {
    if (typeof input !== 'object' || input === null) fail('CREDENTIAL_STORE_INPUT_INVALID');
    const organization = requireOrganization(input.organizationId);
    const profile = requireProfile(kind, input.profileId);
    const credential = requireCredentialId(input.credentialId);
    const sessionId = requireCredentialId(input.sessionId);
    const tokenHash = requireTokenHash(input.tokenHash);
    const expiresAt = requireExpiresAt(input.expiresAt);
    if (
      typeof input.expectedVersion !== 'number' ||
      !Number.isInteger(input.expectedVersion) ||
      input.expectedVersion < 1
    ) {
      fail('CREDENTIAL_STORE_INPUT_INVALID');
    }
    const helper = kind === 'agent'
      ? 'openarc_durable.create_agent_session'
      : 'openarc_durable.create_provider_session';
    const profileColumn = kind === 'agent' ? 'out_agent_id' : 'out_provider_id';
    return this.#withTransaction(async (client) => {
      const result = await client.query<Record<string, unknown>>(
        `SELECT out_session_id, out_credential_id, out_organization_id, ${profileColumn},
                out_scope, out_scope_version, out_environment, out_created_at,
                out_expires_at, out_revocation_version
           FROM ${helper}($1, $2, $3::uuid, $4, $5::uuid, $6, $7::timestamptz)`,
        [organization, profile, credential, input.expectedVersion, sessionId, tokenHash, expiresAt],
      );
      const row = result.rows[0];
      if (row === undefined) fail('CREDENTIAL_STORE_UNAVAILABLE');
      return this.#projectSession(kind, row, null);
    });
  }

  async #getSession(kind: CredentialKind, tokenHash: unknown): Promise<MachineSessionMetadata> {
    const token = requireTokenHash(tokenHash);
    const helper = kind === 'agent'
      ? 'openarc_durable.read_agent_session'
      : 'openarc_durable.read_provider_session';
    const profileColumn = kind === 'agent' ? 'out_agent_id' : 'out_provider_id';
    return this.#withTransaction(async (client) => {
      const result = await client.query<Record<string, unknown>>(
        `SELECT out_session_id, out_organization_id, ${profileColumn}, out_credential_id,
                out_issuer_account_id, out_scope, out_scope_version, out_environment,
                out_created_at, out_expires_at, out_revocation_version
           FROM ${helper}($1)`,
        [token],
      );
      const row = result.rows[0];
      if (row === undefined) fail('CREDENTIAL_STORE_NOT_FOUND');
      return this.#projectSession(kind, row, row['out_issuer_account_id'] as string);
    });
  }

  async #revokeSession(kind: CredentialKind, tokenHash: unknown): Promise<RevokeSessionResult> {
    const token = requireTokenHash(tokenHash);
    const helper = kind === 'agent'
      ? 'openarc_durable.revoke_agent_session'
      : 'openarc_durable.revoke_provider_session';
    return this.#withTransaction(async (client) => {
      const result = await client.query<Record<string, unknown>>(
        `SELECT out_session_id, out_organization_id, out_revoked_at, out_revocation_version
           FROM ${helper}($1)`,
        [token],
      );
      const row = result.rows[0];
      if (row === undefined) fail('CREDENTIAL_STORE_NOT_FOUND');
      const sessionId = row['out_session_id'];
      const organizationId = row['out_organization_id'];
      const revokedAt = row['out_revoked_at'];
      const version = row['out_revocation_version'];
      if (
        typeof sessionId !== 'string' ||
        typeof organizationId !== 'string' ||
        !(revokedAt instanceof Date) ||
        typeof version !== 'number'
      ) {
        fail('CREDENTIAL_STORE_UNAVAILABLE');
      }
      return {
        sessionId: requireCredentialId(sessionId),
        organizationId: requireOrganization(organizationId),
        revokedAt: iso(revokedAt),
        revocationVersion: version,
      };
    });
  }

  async #lockSessionActor(client: TenantClient, hash: string): Promise<string> {
    const result = await client.query<{ account_id: string }>(
      `SELECT account_id, method, session_created_at, session_expires_at
         FROM openarc_tenant.lock_auth_session($1, NULL)`,
      [hash],
    );
    const row = result.rows[0];
    if (row === undefined || typeof row.account_id !== 'string') {
      fail('CREDENTIAL_STORE_SESSION_INVALID');
    }
    return row.account_id;
  }

  async #lockOrganizationRole(
    client: TenantClient,
    hash: string,
    organization: string,
    actor: string,
  ): Promise<string> {
    const result = await client.query<{ out_organization_id: string; out_role: string }>(
      `SELECT out_organization_id, out_role
         FROM openarc_tenant.lock_organization_access($1, $2)`,
      [hash, organization],
    );
    const row = result.rows[0];
    if (row === undefined || typeof row.out_role !== 'string') fail('CREDENTIAL_STORE_FORBIDDEN');
    // Recheck the resolved actor against the held session.
    const recheck = await client.query<{ account_id: string }>(
      `SELECT account_id FROM openarc_tenant.lock_auth_session($1, NULL)`,
      [hash],
    );
    if (recheck.rows[0]?.account_id !== actor) fail('CREDENTIAL_STORE_SESSION_INVALID');
    return row.out_role;
  }

  #projectReceipt(row: DurableReceiptRow, operation: CredentialOperation): CredentialMutationReceipt {
    if (row.out_operation !== operation) fail('CREDENTIAL_STORE_UNAVAILABLE');
    const expected = CREDENTIAL_RESOURCE_BY_OPERATION[operation];
    if (row.out_resource_type !== expected) fail('CREDENTIAL_STORE_UNAVAILABLE');
    const credentialId = requireCredentialId(row.out_resource_id);
    return {
      mutationId: parseMutationIdSafe(row.out_mutation_id),
      operation,
      resourceType: expected as CredentialResourceType,
      credentialId,
      committedAt: iso(row.out_committed_at),
    };
  }

  #projectListRow(kind: CredentialKind, row: CredentialListRow): CredentialMetadata {
    const credentialId = requireCredentialId(row.out_credential_id);
    const profile = kind === 'agent'
      ? requireAgent((row as Record<string, unknown>)['out_agent_id'])
      : requireProvider((row as Record<string, unknown>)['out_provider_id']);
    const scope = canonicalScope(kind, row.out_scope);
    if (row.out_environment !== 'eip155:5042002') fail('CREDENTIAL_STORE_UNAVAILABLE');
    const createdAt = iso(row.out_created_at);
    const expiresAt = iso(row.out_expires_at);
    const revokedAt = row.out_revoked_at === null ? null : iso(row.out_revoked_at);
    // Status is computed by the SQL helper under the database clock; the
    // repository never derives authorization/status from the local wall clock.
    const status = requireCredentialStatus(row.out_status);
    return {
      credentialId,
      kind,
      profileId: profile,
      keyPrefix: (() => {
        if (typeof row.out_key_prefix !== 'string') fail('CREDENTIAL_STORE_UNAVAILABLE');
        return row.out_key_prefix;
      })(),
      environment: 'eip155:5042002',
      scope,
      scopeVersion: 1,
      createdAt,
      expiresAt,
      revokedAt,
      status,
    };
  }

  #projectVerifier(kind: CredentialKind, row: Record<string, unknown>): CredentialVerifierSnapshot {
    const profileRaw = kind === 'agent' ? row['out_agent_id'] : row['out_provider_id'];
    const profile = requireProfile(kind, profileRaw);
    const scope = canonicalScope(kind, row['out_scope']);
    if (row['out_scope_version'] !== 1 || row['out_environment'] !== 'eip155:5042002') {
      fail('CREDENTIAL_STORE_UNAVAILABLE');
    }
    if (row['out_algorithm'] !== 'scrypt' || row['out_hash_version'] !== 1) {
      fail('CREDENTIAL_STORE_UNAVAILABLE');
    }
    if (
      row['out_kdf_n'] !== 32768 ||
      row['out_kdf_r'] !== 8 ||
      row['out_kdf_p'] !== 1
    ) {
      fail('CREDENTIAL_STORE_UNAVAILABLE');
    }
    const pepperVersion = row['out_pepper_version'];
    const revocationVersion = row['out_revocation_version'];
    if (
      typeof pepperVersion !== 'number' ||
      pepperVersion < 1 ||
      pepperVersion > 16 ||
      typeof revocationVersion !== 'number' ||
      revocationVersion < 1
    ) {
      fail('CREDENTIAL_STORE_UNAVAILABLE');
    }
    return {
      organizationId: requireOrganization(row['out_organization_id']),
      credentialId: requireCredentialId(row['out_credential_id']),
      kind,
      profileId: profile,
      issuerAccountId: (() => {
        const issuer = row['out_issuer_account_id'];
        if (typeof issuer !== 'string') fail('CREDENTIAL_STORE_UNAVAILABLE');
        return issuer;
      })(),
      scope,
      scopeVersion: 1,
      environment: 'eip155:5042002',
      algorithm: 'scrypt',
      hashVersion: 1,
      pepperVersion,
      N: 32768,
      r: 8,
      p: 1,
      salt: parseSalt(row['out_salt']),
      digest: parseDigest(row['out_digest']),
      keyPrefix: (() => {
        const prefix = row['out_key_prefix'];
        if (typeof prefix !== 'string') fail('CREDENTIAL_STORE_UNAVAILABLE');
        return prefix;
      })(),
      revocationVersion,
      expiresAt: iso(row['out_expires_at']),
    };
  }

  #projectSession(
    kind: CredentialKind,
    row: Record<string, unknown>,
    issuer: string | null,
  ): MachineSessionMetadata {
    const profileRaw = kind === 'agent' ? row['out_agent_id'] : row['out_provider_id'];
    const profile = requireProfile(kind, profileRaw);
    const scope = canonicalScope(kind, row['out_scope']);
    if (row['out_scope_version'] !== 1 || row['out_environment'] !== 'eip155:5042002') {
      fail('CREDENTIAL_STORE_UNAVAILABLE');
    }
    const revocationVersion = row['out_revocation_version'];
    if (typeof revocationVersion !== 'number' || revocationVersion < 1) {
      fail('CREDENTIAL_STORE_UNAVAILABLE');
    }
    return {
      sessionId: requireCredentialId(row['out_session_id']),
      credentialId: requireCredentialId(row['out_credential_id']),
      organizationId: requireOrganization(row['out_organization_id']),
      kind,
      profileId: profile,
      ...(issuer === null ? {} : { issuerAccountId: issuer }),
      scope,
      scopeVersion: 1,
      environment: 'eip155:5042002',
      createdAt: iso(row['out_created_at']),
      expiresAt: iso(row['out_expires_at']),
      revocationVersion,
    };
  }

  async #assertCredentialReady(client: TenantClient): Promise<void> {
    const tables = await client.query<{ n: number; all_enabled: boolean; all_forced: boolean }>(
      `SELECT count(*)::int AS n,
              bool_and(c.relrowsecurity) AS all_enabled,
              bool_and(c.relforcerowsecurity) AS all_forced
         FROM pg_class c
         JOIN pg_namespace ns ON ns.oid = c.relnamespace
        WHERE ns.nspname = 'openarc_durable'
          AND c.relkind = 'r'
          AND c.relname IN ('agent_credentials', 'provider_credentials', 'agent_sessions', 'provider_sessions')`,
    );
    const state = tables.rows[0];
    if (state === undefined || state.n !== 4 || state.all_enabled !== true || state.all_forced !== true) {
      fail('CREDENTIAL_STORE_UNAVAILABLE');
    }

    const expected: readonly { name: string; args: string }[] = [
      { name: 'commit_agent_credential_issue', args: 'session_hash text, organization_id text, agent_id text, credential_id uuid, lookup_id uuid, key_prefix text, pepper_version integer, salt text, digest text, expires_at timestamp with time zone, mutation_id uuid, key_hash text, request_digest text, session_context_digest text' },
      { name: 'commit_agent_credential_revoke', args: 'session_hash text, organization_id text, credential_id uuid, mutation_id uuid, key_hash text, request_digest text, session_context_digest text' },
      { name: 'commit_provider_credential_issue', args: 'session_hash text, organization_id text, provider_id text, credential_id uuid, lookup_id uuid, key_prefix text, pepper_version integer, salt text, digest text, expires_at timestamp with time zone, mutation_id uuid, key_hash text, request_digest text, session_context_digest text' },
      { name: 'commit_provider_credential_revoke', args: 'session_hash text, organization_id text, credential_id uuid, mutation_id uuid, key_hash text, request_digest text, session_context_digest text' },
      { name: 'create_agent_session', args: 'organization_id text, agent_id text, credential_id uuid, expected_version integer, session_id uuid, token_hash text, expires_at timestamp with time zone' },
      { name: 'create_provider_session', args: 'organization_id text, provider_id text, credential_id uuid, expected_version integer, session_id uuid, token_hash text, expires_at timestamp with time zone' },
      { name: 'find_agent_credential_verifier', args: 'lookup_id uuid' },
      { name: 'find_provider_credential_verifier', args: 'lookup_id uuid' },
      { name: 'list_agent_credentials', args: 'session_hash text, organization_id text, agent_id text, after_credential_id uuid, page_limit integer' },
      { name: 'list_provider_credentials', args: 'session_hash text, organization_id text, provider_id text, after_credential_id uuid, page_limit integer' },
      { name: 'read_agent_credential_mutation_status', args: 'session_hash text, organization_id text, mutation_id uuid' },
      { name: 'read_agent_session', args: 'token_hash text' },
      { name: 'read_provider_credential_mutation_status', args: 'session_hash text, organization_id text, mutation_id uuid' },
      { name: 'read_provider_session', args: 'token_hash text' },
      { name: 'revoke_agent_session', args: 'token_hash text' },
      { name: 'revoke_provider_session', args: 'token_hash text' },
    ];
    const helpers = await client.query<{
      proname: string;
      args: string;
      owner: string;
      prosecdef: boolean;
      config: string[];
      app_exec: boolean;
      public_grants: number;
    }>(
      `SELECT p.proname,
              pg_get_function_identity_arguments(p.oid) AS args,
              r.rolname AS owner,
              p.prosecdef,
              coalesce(p.proconfig, ARRAY[]::text[]) AS config,
              has_function_privilege(current_user, p.oid, 'EXECUTE') AS app_exec,
              (SELECT count(*)::int
                 FROM aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE') AS public_grants
         FROM pg_proc p
         JOIN pg_namespace n ON n.oid = p.pronamespace
         JOIN pg_roles r ON r.oid = p.proowner
        WHERE n.nspname = 'openarc_durable'
          AND p.prokind = 'f'
          AND p.proname IN (
            'commit_agent_credential_issue', 'commit_agent_credential_revoke',
            'commit_provider_credential_issue', 'commit_provider_credential_revoke',
            'create_agent_session', 'create_provider_session',
            'find_agent_credential_verifier', 'find_provider_credential_verifier',
            'list_agent_credentials', 'list_provider_credentials',
            'read_agent_credential_mutation_status', 'read_agent_session',
            'read_provider_credential_mutation_status', 'read_provider_session',
            'revoke_agent_session', 'revoke_provider_session'
          )
        ORDER BY p.proname, p.oid`,
    );
    const byName = new Map(helpers.rows.map((row) => [row.proname, row]));
    for (const expectedHelper of expected) {
      const row = byName.get(expectedHelper.name);
      if (row === undefined) fail('CREDENTIAL_STORE_UNAVAILABLE');
      if (
        row.args !== expectedHelper.args ||
        row.owner !== 'openarc_migrator' ||
        row.prosecdef !== true ||
        !Array.isArray(row.config) ||
        !row.config.includes('search_path=pg_catalog') ||
        row.app_exec !== true ||
        row.public_grants !== 0
      ) {
        fail('CREDENTIAL_STORE_UNAVAILABLE');
      }
    }
    if (helpers.rows.length !== expected.length) fail('CREDENTIAL_STORE_UNAVAILABLE');

    // No effective direct table access to the credential/session tables for the
    // runtime or any role it can reach through membership.
    const access = await client.query<{ n: number }>(
      `WITH reachable AS (
         SELECT r.oid FROM pg_roles r
          WHERE r.oid = (SELECT oid FROM pg_roles WHERE rolname = current_user)
             OR pg_has_role(current_user, r.oid, 'MEMBER')
       )
       SELECT count(*)::int AS n
         FROM pg_class c
         JOIN pg_namespace ns ON ns.oid = c.relnamespace
        WHERE ns.nspname = 'openarc_durable'
          AND c.relname IN ('agent_credentials', 'provider_credentials', 'agent_sessions', 'provider_sessions')
          AND c.relkind = 'r'
          AND EXISTS (
            SELECT 1 FROM reachable x
             WHERE has_table_privilege(x.oid, c.oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
          )`,
    );
    if ((access.rows[0]?.n ?? -1) !== 0) fail('CREDENTIAL_STORE_UNAVAILABLE');

    const applied = await client.query<{ id: string; checksum: string }>(
      `SELECT id, checksum FROM openarc_meta.schema_migrations ORDER BY id`,
    );
    this.#assertExactManifest(applied.rows);
  }

  #assertExactManifest(applied: readonly { readonly id: string; readonly checksum: string }[]): void {
    let migrations: readonly { readonly id: string; readonly sql: string }[];
    try {
      migrations = loadMigrations();
    } catch {
      fail('CREDENTIAL_STORE_UNAVAILABLE');
    }
    if (applied.length !== migrations.length) fail('CREDENTIAL_STORE_UNAVAILABLE');
    for (let index = 0; index < applied.length; index += 1) {
      const record = applied[index];
      const manifest = migrations[index];
      if (record === undefined || manifest === undefined) fail('CREDENTIAL_STORE_UNAVAILABLE');
      if (record.id !== manifest.id) fail('CREDENTIAL_STORE_UNAVAILABLE');
      const checksum = createHash('sha256').update(manifest.sql, 'utf8').digest('hex');
      if (record.checksum !== checksum) fail('CREDENTIAL_STORE_UNAVAILABLE');
    }
  }

  async #withTransaction<T>(work: (client: TenantClient) => Promise<T>): Promise<T> {
    let client: TenantClient;
    try {
      client = await this.#pool.connect();
    } catch {
      fail('CREDENTIAL_STORE_UNAVAILABLE');
    }
    try {
      await client.query('BEGIN');
    } catch {
      this.#release(client, true);
      fail('CREDENTIAL_STORE_UNAVAILABLE');
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
    try {
      await client.query('COMMIT');
    } catch {
      this.#release(client, true);
      fail('CREDENTIAL_STORE_OUTCOME_UNKNOWN');
    }
    this.#release(client, false);
    return result;
  }

  #release(client: TenantClient, destroy: boolean): void {
    try {
      client.release(destroy);
    } catch {
      // A release failure after a confirmed outcome cannot change it.
    }
  }
}

function parseHashInput(value: unknown): CredentialHashInput {
  try {
    return parseCredentialHashInput(value);
  } catch {
    fail('CREDENTIAL_STORE_INPUT_INVALID');
  }
}

function parseSalt(value: unknown): string {
  try {
    return parseCanonicalBase64Url(value, 16);
  } catch {
    fail('CREDENTIAL_STORE_UNAVAILABLE');
  }
}

function parseDigest(value: unknown): string {
  try {
    return parseCanonicalBase64Url(value, 32);
  } catch {
    fail('CREDENTIAL_STORE_UNAVAILABLE');
  }
}

function parseMutationIdSafe(value: unknown): string {
  try {
    return parseMutationId(value);
  } catch {
    fail('CREDENTIAL_STORE_UNAVAILABLE');
  }
}

/** Structural adapter for callers that hold a raw `pg` Pool. */
export function asCredentialPool(pool: Pool): CredentialStorePort {
  return pool as unknown as CredentialStorePort;
}

export type { Pool };
