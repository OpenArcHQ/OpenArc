import { createHash } from 'node:crypto';
import { DurabilityInputError, parseMutationId } from './tenant-durability.js';

/**
 * Pure metadata authority for the durable machine-credential operations.
 *
 * This module is SEPARATE from the legacy tenant operation/resource/receipt
 * unions and exports its own closed union. It accepts no callback, no raw
 * credential, no pepper, no pre-hash, no principal and no arbitrary SQL. All
 * server-side resolution happens inside the reviewed SQL definer helpers.
 */

export const CREDENTIAL_NETWORK = 'eip155:5042002' as const;

export type CredentialOperation =
  | 'tenant.agent.credential.issue'
  | 'tenant.agent.credential.revoke'
  | 'tenant.provider.credential.issue'
  | 'tenant.provider.credential.revoke';

export type CredentialResourceType = 'agent_credential' | 'provider_credential';

export type CredentialKind = 'agent' | 'provider';

export const CREDENTIAL_RESOURCE_BY_OPERATION = {
  'tenant.agent.credential.issue': 'agent_credential',
  'tenant.agent.credential.revoke': 'agent_credential',
  'tenant.provider.credential.issue': 'provider_credential',
  'tenant.provider.credential.revoke': 'provider_credential',
} as const satisfies Record<CredentialOperation, CredentialResourceType>;

export const CREDENTIAL_EVENT_BY_OPERATION = {
  'tenant.agent.credential.issue': 'tenant.agent.credential.created',
  'tenant.agent.credential.revoke': 'tenant.agent.credential.revoked',
  'tenant.provider.credential.issue': 'tenant.provider.credential.created',
  'tenant.provider.credential.revoke': 'tenant.provider.credential.revoked',
} as const;

export const CREDENTIAL_KIND_BY_OPERATION = {
  'tenant.agent.credential.issue': 'agent',
  'tenant.agent.credential.revoke': 'agent',
  'tenant.provider.credential.issue': 'provider',
  'tenant.provider.credential.revoke': 'provider',
} as const satisfies Record<CredentialOperation, CredentialKind>;

export const CREDENTIAL_SCOPE_BY_KIND = {
  agent: 'agent:self.read',
  provider: 'provider:self.read',
} as const;

/** The bounded public receipt. It never carries hash/salt/prefix/session/body. */
export interface CredentialMutationReceipt {
  readonly mutationId: string;
  readonly operation: CredentialOperation;
  readonly resourceType: CredentialResourceType;
  readonly credentialId: string;
  readonly committedAt: string;
}

export interface CredentialMutationResult {
  readonly replayed: boolean;
  readonly receipt: CredentialMutationReceipt;
}

export type CredentialMutationStatus =
  | { readonly status: 'committed'; readonly receipt: CredentialMutationReceipt }
  | { readonly status: 'not_found' };

const HEX64 = /^[0-9a-f]{64}$/;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SALT_LEN = 22;
const DIGEST_LEN = 43;
const BASE64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every((key) => key in value);
}

/** Canonical plain lowercase UUIDv4 (exact 36 chars, no newline). */
export function parseCredentialId(value: unknown): string {
  if (typeof value !== 'string' || value.length !== 36 || !UUID_V4.test(value)) {
    throw new DurabilityInputError();
  }
  return value;
}

export function parseSessionId(value: unknown): string {
  return parseCredentialId(value);
}

export function parseLookupId(value: unknown): string {
  return parseCredentialId(value);
}

/** Canonical unpadded base64url for exactly n bytes with decode/re-encode equality. */
export function parseCanonicalBase64Url(value: unknown, byteLength: number): string {
  const expectedLength = byteLength === 16 ? SALT_LEN : byteLength === 32 ? DIGEST_LEN : -1;
  if (expectedLength < 0 || typeof value !== 'string' || value.length !== expectedLength) {
    throw new DurabilityInputError();
  }
  let decoded: Buffer;
  try {
    decoded = Buffer.from(value, 'base64url');
  } catch {
    throw new DurabilityInputError();
  }
  if (decoded.length !== byteLength || decoded.toString('base64url') !== value) {
    throw new DurabilityInputError();
  }
  for (const character of value) {
    if (!BASE64URL.includes(character)) throw new DurabilityInputError();
  }
  return value;
}

/**
 * The EXACT closed hash input. Own keys only, fixed literal algorithms and
 * parameters, canonical salt (16 bytes) and digest (32 bytes) encodings.
 */
export interface CredentialHashInput {
  readonly algorithm: 'scrypt';
  readonly hashVersion: 1;
  readonly pepperVersion: number;
  readonly N: 32768;
  readonly r: 8;
  readonly p: 1;
  readonly salt: string;
  readonly digest: string;
}

const HASH_KEYS = [
  'algorithm',
  'hashVersion',
  'pepperVersion',
  'N',
  'r',
  'p',
  'salt',
  'digest',
] as const;

export function parseCredentialHashInput(value: unknown): CredentialHashInput {
  if (!isRecord(value) || !hasOnlyKeys(value, HASH_KEYS)) throw new DurabilityInputError();
  if (value['algorithm'] !== 'scrypt' || value['hashVersion'] !== 1) throw new DurabilityInputError();
  const pepper = value['pepperVersion'];
  if (
    typeof pepper !== 'number' ||
    !Number.isInteger(pepper) ||
    pepper < 1 ||
    pepper > 16
  ) {
    throw new DurabilityInputError();
  }
  if (value['N'] !== 32768 || value['r'] !== 8 || value['p'] !== 1) {
    throw new DurabilityInputError();
  }
  return {
    algorithm: 'scrypt',
    hashVersion: 1,
    pepperVersion: pepper,
    N: 32768,
    r: 8,
    p: 1,
    salt: parseCanonicalBase64Url(value['salt'], 16),
    digest: parseCanonicalBase64Url(value['digest'], 32),
  };
}

/** Namespace/kind-bound prefix derived from the caller-supplied lookup id. */
export function credentialKeyPrefix(kind: CredentialKind, lookupId: unknown): string {
  const lookup = parseLookupId(lookupId);
  return kind === 'agent' ? `oac_ag_${lookup}` : `oac_pr_${lookup}`;
}

export function credentialDigestVersion(operation: CredentialOperation): string {
  return `${operation}.v1`;
}

export function credentialSessionDomain(operation: CredentialOperation): string {
  return `openarc.${operation}.session.v1`;
}

export function credentialIdempotencyDomain(operation: CredentialOperation): string {
  return `openarc.${operation}.idempotency.v1`;
}

/** Domain-separated digest of an internal 64-hex session context. */
export function digestCredentialSessionContext(operation: CredentialOperation, sessionHash: string): string {
  if (typeof sessionHash !== 'string' || !HEX64.test(sessionHash)) throw new DurabilityInputError();
  return sha256Hex(`${credentialSessionDomain(operation)}:${sessionHash}`);
}

/** Domain-separated digest of the raw idempotency key (32-byte base64url). */
export function digestCredentialIdempotencyKey(operation: CredentialOperation, rawKey: string): string {
  const key = parseCanonicalBase64Url(rawKey, 32);
  return sha256Hex(`${credentialIdempotencyDomain(operation)}:${key}`);
}

export interface CredentialMutationDigestContext {
  readonly organizationId: string;
  readonly actorAccountId: string;
  readonly actorRole: string;
  readonly sessionContextDigest: string;
  readonly mutationId: string;
}

function requireContext(context: CredentialMutationDigestContext): void {
  if (typeof context.organizationId !== 'string') throw new DurabilityInputError();
  if (typeof context.actorAccountId !== 'string') throw new DurabilityInputError();
  if (typeof context.actorRole !== 'string') throw new DurabilityInputError();
  if (!HEX64.test(context.sessionContextDigest)) throw new DurabilityInputError();
  parseMutationId(context.mutationId);
}

function digestCredentialRequest(
  operation: CredentialOperation,
  fields: readonly unknown[],
): string {
  return sha256Hex(
    JSON.stringify([credentialDigestVersion(operation), CREDENTIAL_NETWORK, ...fields]),
  );
}

/**
 * Issue replay digest. It binds org, actor+role, session context, kind/profile,
 * mutationId, scope/env and the requested expiresAt. It deliberately does NOT
 * bind the ephemeral lookup/salt/digest/pepper, so a replay with fresh
 * randomness still returns the original safe receipt without replacing material.
 */
export function digestCredentialIssueRequest(
  operation: Extract<CredentialOperation, 'tenant.agent.credential.issue' | 'tenant.provider.credential.issue'>,
  context: CredentialMutationDigestContext,
  profileId: string,
  expectedExpiresAt: string,
): string {
  requireContext(context);
  if (typeof profileId !== 'string' || !profileId.startsWith('openarc:')) {
    throw new DurabilityInputError();
  }
  if (typeof expectedExpiresAt !== 'string' || expectedExpiresAt.length === 0) {
    throw new DurabilityInputError();
  }
  const kind = CREDENTIAL_KIND_BY_OPERATION[operation];
  return digestCredentialRequest(operation, [
    context.organizationId,
    context.actorAccountId,
    context.actorRole,
    context.sessionContextDigest,
    parseMutationId(context.mutationId),
    kind,
    profileId,
    CREDENTIAL_SCOPE_BY_KIND[kind],
    expectedExpiresAt,
  ]);
}

/** Revoke replay digest binds the target credential id plus the context. */
export function digestCredentialRevokeRequest(
  operation: Extract<CredentialOperation, 'tenant.agent.credential.revoke' | 'tenant.provider.credential.revoke'>,
  context: CredentialMutationDigestContext,
  credentialId: string,
): string {
  requireContext(context);
  const kind = CREDENTIAL_KIND_BY_OPERATION[operation];
  return digestCredentialRequest(operation, [
    context.organizationId,
    context.actorAccountId,
    context.actorRole,
    context.sessionContextDigest,
    parseMutationId(context.mutationId),
    kind,
    parseCredentialId(credentialId),
  ]);
}
