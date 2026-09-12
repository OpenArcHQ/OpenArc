import { createHash } from 'node:crypto';
import type { TenantQueryResult } from './tenant-store.js';

/**
 * Pure metadata authority for the single durable tenant operation
 * `tenant.agent.create`.
 *
 * This module deliberately exposes ONLY canonical parsers and digest helpers.
 * It is not a mutation facility: it accepts no callback, no arbitrary SQL, no
 * principal, no role and no network. All server-side resolution happens inside
 * the reviewed SQL definer helpers.
 */

export const DURABILITY_DIGEST_VERSION = 'tenant.agent.create.v1' as const;
export const DURABILITY_OPERATION = 'tenant.agent.create' as const;
export const DURABILITY_RESOURCE_TYPE = 'agent' as const;
export const DURABILITY_NETWORK = 'eip155:5042002' as const;
export const DURABILITY_SESSION_DOMAIN = 'openarc.tenant.agent.create.session.v1' as const;
export const DURABILITY_KEY_DOMAIN = 'openarc.tenant.agent.create.idempotency.v1' as const;

const HEX64 = /^[0-9a-f]{64}$/;
const MUTATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const BASE64URL_32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

export interface DurableReceipt {
  readonly mutationId: string;
  readonly operation: typeof DURABILITY_OPERATION;
  readonly resourceType: typeof DURABILITY_RESOURCE_TYPE;
  readonly resourceId: string;
  readonly committedAt: string;
}

export interface AgentMutationResult {
  readonly replayed: boolean;
  readonly receipt: DurableReceipt;
}

export type AgentMutationStatus =
  | { readonly status: 'committed'; readonly receipt: DurableReceipt }
  | { readonly status: 'not_found' };

/**
 * Canonical lower-case UUIDv4 mutation id. The version nibble MUST be 4 and the
 * variant nibble MUST be 8/9/a/b so a caller cannot smuggle an arbitrary UUID.
 */
export function parseMutationId(value: unknown): string {
  if (typeof value !== 'string' || value.length !== 36 || !MUTATION_ID.test(value)) {
    throw new DurabilityInputError();
  }
  return value;
}

/**
 * Canonical unpadded base64url for exactly 32 bytes: 43 characters, decode and
 * re-encode must round-trip exactly. It is NOT an auth credential.
 */
export function parseIdempotencyKey(value: unknown): string {
  if (typeof value !== 'string' || value.length !== 43) throw new DurabilityInputError();
  let decoded: Buffer;
  try {
    decoded = Buffer.from(value, 'base64url');
  } catch {
    throw new DurabilityInputError();
  }
  if (decoded.length !== 32) throw new DurabilityInputError();
  if (decoded.toString('base64url') !== value) throw new DurabilityInputError();
  for (const character of value) {
    if (!BASE64URL_32.includes(character)) throw new DurabilityInputError();
  }
  return value;
}

/** SHA-256 (lower-case hex) of a domain-separated UTF-8 value. */
function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/**
 * Domain-separated digest of the internal session context. The raw session hash
 * is never persisted; only this bounded hex digest reaches the idempotency row.
 */
export function digestSessionContext(sessionHash: string): string {
  if (typeof sessionHash !== 'string' || !HEX64.test(sessionHash)) throw new DurabilityInputError();
  return sha256Hex(`${DURABILITY_SESSION_DOMAIN}:${sessionHash}`);
}

/** Domain-separated digest of the raw idempotency key. The raw key is never stored. */
export function digestIdempotencyKey(rawKey: string): string {
  const key = parseIdempotencyKey(rawKey);
  return sha256Hex(`${DURABILITY_KEY_DOMAIN}:${key}`);
}

/**
 * Canonical request digest version tenant.agent.create.v1.
 *
 * SHA-256 of UTF8 JSON.stringify of a fixed-order primitive array. The caller
 * supplies only the already-authorized display name; account, role and session
 * are server-resolved. The raw display name is authorized profile data, and the
 * audit/outbox/idempotency rows store no body or name.
 */
export function digestAgentCreateRequest(input: {
  readonly organizationId: string;
  readonly actorAccountId: string;
  readonly actorRole: string;
  readonly sessionContextDigest: string;
  readonly mutationId: string;
  readonly displayName: string;
}): string {
  if (!HEX64.test(input.sessionContextDigest)) throw new DurabilityInputError();
  const mutationId = parseMutationId(input.mutationId);
  const canonical = JSON.stringify([
    DURABILITY_DIGEST_VERSION,
    DURABILITY_NETWORK,
    input.organizationId,
    input.actorAccountId,
    input.actorRole,
    input.sessionContextDigest,
    mutationId,
    input.displayName,
  ]);
  return sha256Hex(canonical);
}

/** Fixed, non-echoing durability input error. Never carries caller detail. */
export class DurabilityInputError extends Error {
  constructor() {
    super('Durability metadata is invalid.');
    this.name = 'DurabilityInputError';
  }
}

/** Narrow structural view of a row returned by the commit/status definer. */
export interface DurableReceiptRow extends Record<string, unknown> {
  readonly out_mutation_id: string;
  readonly out_operation: string;
  readonly out_resource_type: string;
  readonly out_resource_id: string;
  readonly out_committed_at: Date;
}

export type DurableReceiptQuery = TenantQueryResult<DurableReceiptRow>;
