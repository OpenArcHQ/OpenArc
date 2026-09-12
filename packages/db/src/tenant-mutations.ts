import { createHash } from 'node:crypto';
import {
  digestSessionContext,
  digestIdempotencyKey,
  parseIdempotencyKey,
  parseMutationId,
  DurabilityInputError,
  type DurableReceiptQuery,
  type DurableReceiptRow,
} from './tenant-durability.js';

/**
 * Pure metadata authority for the remaining durable tenant writes. This module
 * exposes ONLY canonical parsers and digest helpers for a CLOSED operation
 * union; it accepts no callback, no arbitrary SQL, no principal, no role and no
 * network. Every server-side resolution happens inside the reviewed SQL definer
 * helpers. The original `tenant.agent.create` digest authority stays in
 * `tenant-durability.ts` byte-for-byte and is re-exported here.
 */

export {
  digestIdempotencyKey,
  digestSessionContext,
  parseIdempotencyKey,
  parseMutationId,
  DurabilityInputError,
};
export type { DurableReceiptQuery, DurableReceiptRow };

export const DURABLE_NETWORK = 'eip155:5042002' as const;

export type DurableOperation =
  | 'tenant.organization.create'
  | 'tenant.agent.create'
  | 'tenant.agent.update'
  | 'tenant.provider.create'
  | 'tenant.provider.update'
  | 'tenant.membership.set';

export type DurableResourceType = 'organization' | 'agent' | 'provider' | 'membership';

/** Canonical object mapping a fixed operation to its single resource kind. */
export const DURABLE_RESOURCE_BY_OPERATION = {
  'tenant.organization.create': 'organization',
  'tenant.agent.create': 'agent',
  'tenant.agent.update': 'agent',
  'tenant.provider.create': 'provider',
  'tenant.provider.update': 'provider',
  'tenant.membership.set': 'membership',
} as const satisfies Record<DurableOperation, DurableResourceType>;

/** Canonical fixed event name per operation (event union, not receipt). */
export const DURABLE_EVENT_BY_OPERATION = {
  'tenant.organization.create': 'tenant.organization.created',
  'tenant.agent.create': 'tenant.agent.created',
  'tenant.agent.update': 'tenant.agent.updated',
  'tenant.provider.create': 'tenant.provider.created',
  'tenant.provider.update': 'tenant.provider.updated',
  'tenant.membership.set': 'tenant.membership.set',
} as const;

export interface DurableMutationReceipt {
  readonly mutationId: string;
  readonly operation: DurableOperation;
  readonly resourceType: DurableResourceType;
  readonly resourceId: string;
  readonly committedAt: string;
}

export interface DurableMutationResult {
  readonly replayed: boolean;
  readonly receipt: DurableMutationReceipt;
}

export type DurableMutationStatus =
  | { readonly status: 'committed'; readonly receipt: DurableMutationReceipt }
  | { readonly status: 'not_found' };

export function digestVersion(operation: DurableOperation): string {
  return `${operation}.v1`;
}

export function sessionDomain(operation: DurableOperation): string {
  return `openarc.${operation}.session.v1`;
}

export function idempotencyDomain(operation: DurableOperation): string {
  return `openarc.${operation}.idempotency.v1`;
}

const HEX64 = /^[0-9a-f]{64}$/;

function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function requireHex64(value: unknown): string {
  if (typeof value !== 'string' || !HEX64.test(value)) throw new DurabilityInputError();
  return value;
}

function digestRequest(operation: DurableOperation, canonical: readonly unknown[]): string {
  return sha256Hex(JSON.stringify([digestVersion(operation), DURABLE_NETWORK, ...canonical]));
}

export interface MutationDigestContext {
  readonly organizationId: string;
  readonly actorAccountId: string;
  readonly actorRole: string;
  readonly sessionContextDigest: string;
  readonly mutationId: string;
}

function baseFields(operation: DurableOperation, context: MutationDigestContext): unknown[] {
  requireHex64(context.sessionContextDigest);
  const mutationId = parseMutationId(context.mutationId);
  return [
    context.organizationId,
    context.actorAccountId,
    context.actorRole,
    context.sessionContextDigest,
    mutationId,
  ];
}

/**
 * Bootstrap digest. The organization id is the deterministic derived value and
 * the resolved role is the constant 'bootstrap'. Only the validated name is the
 * caller-supplied operation field.
 */
export function digestOrganizationCreateRequest(input: {
  readonly mutationId: string;
  readonly actorAccountId: string;
  readonly sessionContextDigest: string;
  readonly displayName: string;
}): string {
  const mutationId = parseMutationId(input.mutationId);
  requireHex64(input.sessionContextDigest);
  return digestRequest('tenant.organization.create', [
    `openarc:org:${mutationId}`,
    input.actorAccountId,
    'bootstrap',
    input.sessionContextDigest,
    mutationId,
    input.displayName,
  ]);
}

export interface CanonicalPatchFields {
  readonly hasDisplayName: boolean;
  readonly displayName: string | null;
  readonly hasStatus: boolean;
  readonly status: string | null;
}

/**
 * Explicit absence encoding: the key order never changes the digest and a
 * provided-null vs absent field is a distinct canonical value.
 */
function patchFields(input: CanonicalPatchFields): unknown[] {
  if (
    input.hasDisplayName !== (input.displayName !== null) ||
    input.hasStatus !== (input.status !== null)
  ) {
    throw new DurabilityInputError();
  }
  return [input.hasDisplayName, input.displayName, input.hasStatus, input.status];
}

export function digestAgentUpdateRequest(
  context: MutationDigestContext,
  agentId: string,
  patch: CanonicalPatchFields,
): string {
  return digestRequest('tenant.agent.update', [
    ...baseFields('tenant.agent.update', context),
    agentId,
    ...patchFields(patch),
  ]);
}

export function digestProviderCreateRequest(
  context: MutationDigestContext,
  displayName: string,
): string {
  return digestRequest('tenant.provider.create', [
    ...baseFields('tenant.provider.create', context),
    displayName,
  ]);
}

export function digestProviderUpdateRequest(
  context: MutationDigestContext,
  providerId: string,
  patch: CanonicalPatchFields,
): string {
  return digestRequest('tenant.provider.update', [
    ...baseFields('tenant.provider.update', context),
    providerId,
    ...patchFields(patch),
  ]);
}

export function digestMembershipSetRequest(
  context: MutationDigestContext,
  targetAccountId: string,
  requestedRole: string,
  requestedStatus: string,
): string {
  return digestRequest('tenant.membership.set', [
    ...baseFields('tenant.membership.set', context),
    targetAccountId,
    requestedRole,
    requestedStatus,
  ]);
}
