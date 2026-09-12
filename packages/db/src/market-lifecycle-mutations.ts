import { createHash } from 'node:crypto';
import {
  CommerceListingIdSchema,
  CommerceListingVersionSchema,
  CommerceMarketOriginReviewDecisionSchema,
  CommerceMarketOriginReviewReasonCodeSchema,
  type CommerceMarketLifecycleMutationReceipt,
  type CommerceMarketOriginReviewDecision,
  type CommerceMarketOriginReviewReasonCode,
} from '@openarc/shared';
import { MarketInputError, requireIdempotencyKey, requireMutationId } from './market-mutations.js';

/**
 * Pure metadata authority for the four reviewed lifecycle operations. This
 * module exposes ONLY canonical parsers and digest helpers. It accepts no
 * callback, principal, role, clock, network or filesystem.
 */

export const LIFECYCLE_OPERATIONS = [
  'market.listing.origin_review.record',
  'market.listing.version.publish',
  'market.listing.version.pause',
  'market.listing.version.retire',
] as const;

export type LifecycleOperation = (typeof LIFECYCLE_OPERATIONS)[number];

export const LIFECYCLE_RESOURCE_BY_OPERATION = Object.freeze({
  'market.listing.origin_review.record': 'listing_version',
  'market.listing.version.publish': 'listing_version',
  'market.listing.version.pause': 'listing_version',
  'market.listing.version.retire': 'listing_version',
}) satisfies Readonly<Record<LifecycleOperation, 'listing_version'>>;

export const LIFECYCLE_EVENT_BY_OPERATION = Object.freeze({
  'market.listing.origin_review.record': 'market.listing.origin_review.recorded',
  'market.listing.version.publish': 'market.listing.version.published',
  'market.listing.version.pause': 'market.listing.version.paused',
  'market.listing.version.retire': 'market.listing.version.retired',
}) satisfies Readonly<Record<LifecycleOperation, string>>;

export const LIFECYCLE_SESSION_DOMAIN_BY_OPERATION = Object.freeze({
  'market.listing.origin_review.record': 'openarc.market.listing.origin_review.record.session.v1',
  'market.listing.version.publish': 'openarc.market.listing.version.publish.session.v1',
  'market.listing.version.pause': 'openarc.market.listing.version.pause.session.v1',
  'market.listing.version.retire': 'openarc.market.listing.version.retire.session.v1',
}) satisfies Readonly<Record<LifecycleOperation, string>>;

export const LIFECYCLE_KEY_DOMAIN_BY_OPERATION = Object.freeze({
  'market.listing.origin_review.record': 'openarc.market.listing.origin_review.record.idempotency.v1',
  'market.listing.version.publish': 'openarc.market.listing.version.publish.idempotency.v1',
  'market.listing.version.pause': 'openarc.market.listing.version.pause.idempotency.v1',
  'market.listing.version.retire': 'openarc.market.listing.version.retire.idempotency.v1',
}) satisfies Readonly<Record<LifecycleOperation, string>>;

export const LIFECYCLE_DIGEST_DOMAIN_BY_OPERATION = Object.freeze({
  'market.listing.origin_review.record': 'market.listing.origin_review.record.v1',
  'market.listing.version.publish': 'market.listing.version.publish.v1',
  'market.listing.version.pause': 'market.listing.version.pause.v1',
  'market.listing.version.retire': 'market.listing.version.retire.v1',
}) satisfies Readonly<Record<LifecycleOperation, string>>;

export const MARKET_LIFECYCLE_NETWORK = 'eip155:5042002' as const;

export const REVIEWED_ENDPOINT_DIGEST_PREFIX = 'openarc.market.endpoint-review.v1' as const;

export interface ReviewedEndpointFields {
  readonly listingId: string;
  readonly version: string;
  readonly origin: string;
  readonly path: string;
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function requireNoLineFeed(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.includes('\n') || value.includes('\r')) {
    throw new MarketInputError();
  }
  void field;
  return value;
}

export function parseLifecycleListingId(value: unknown): string {
  const parsed = CommerceListingIdSchema.safeParse(value);
  if (!parsed.success) throw new MarketInputError();
  return parsed.data;
}

export function parseLifecycleVersion(value: unknown): string {
  const parsed = CommerceListingVersionSchema.safeParse(value);
  if (!parsed.success) throw new MarketInputError();
  return parsed.data;
}

export function parseLifecycleDecision(value: unknown): CommerceMarketOriginReviewDecision {
  const parsed = CommerceMarketOriginReviewDecisionSchema.safeParse(value);
  if (!parsed.success) throw new MarketInputError();
  return parsed.data;
}

export function parseLifecycleReasonCode(value: unknown): CommerceMarketOriginReviewReasonCode {
  const parsed = CommerceMarketOriginReviewReasonCodeSchema.safeParse(value);
  if (!parsed.success) throw new MarketInputError();
  return parsed.data;
}

export { requireIdempotencyKey, requireMutationId };
export type { CommerceMarketLifecycleMutationReceipt };

const SHA256_DIGEST = /^sha256:[0-9a-f]{64}$/;
const HEX64 = /^[0-9a-f]{64}$/;

export function requireLifecycleDigest(value: unknown): string {
  if (typeof value !== 'string' || !SHA256_DIGEST.test(value)) throw new MarketInputError();
  return value;
}

export function requireNullableLifecycleDigest(value: unknown): string | null {
  if (value === null) return null;
  return requireLifecycleDigest(value);
}

/**
 * Frozen reviewed-endpoint digest computation. This is NOT generic JSON
 * serialization and MUST byte-match the SQL helper
 * openarc_durable.reviewed_endpoint_digest. All fields are validated and cannot
 * contain a line feed before hashing.
 */
export function reviewedEndpointDigest(fields: ReviewedEndpointFields): string {
  const listingId = parseLifecycleListingId(fields.listingId);
  const version = parseLifecycleVersion(fields.version);
  if (typeof fields.origin !== 'string' || fields.origin.length === 0) throw new MarketInputError();
  if (typeof fields.path !== 'string' || fields.path.length === 0) throw new MarketInputError();
  const origin = requireNoLineFeed(fields.origin, 'origin');
  const path = requireNoLineFeed(fields.path, 'path');
  const canonical =
    `${REVIEWED_ENDPOINT_DIGEST_PREFIX}\n${listingId}\n${version}\n${origin}\n${path}`;
  return `sha256:${sha256Hex(canonical)}`;
}

export interface LifecycleDigestContext {
  readonly organizationId: string;
  readonly actorAccountId: string;
  readonly actorRole: string;
  readonly sessionContextDigest: string;
  readonly mutationId: string;
}

function digestLifecycleRequest(
  operation: LifecycleOperation,
  context: LifecycleDigestContext,
  target: unknown[],
): string {
  if (!HEX64.test(context.sessionContextDigest)) throw new MarketInputError();
  const mutationId = requireMutationId(context.mutationId);
  return sha256Hex(
    JSON.stringify([
      LIFECYCLE_DIGEST_DOMAIN_BY_OPERATION[operation],
      MARKET_LIFECYCLE_NETWORK,
      context.organizationId,
      context.actorAccountId,
      context.actorRole,
      context.sessionContextDigest,
      mutationId,
      ...target,
    ]),
  );
}

export interface OriginReviewRequestFields {
  readonly expectedUpdatedAt: string;
  readonly decision: CommerceMarketOriginReviewDecision;
  readonly reviewedEndpointDigest: string;
  readonly reasonCode: CommerceMarketOriginReviewReasonCode;
  readonly reasonDigest: string | null;
}

export function digestOriginReviewRequest(
  context: LifecycleDigestContext,
  listingId: string,
  version: string,
  fields: OriginReviewRequestFields,
): string {
  return digestLifecycleRequest('market.listing.origin_review.record', context, [
    listingId,
    version,
    fields.expectedUpdatedAt,
    fields.decision,
    fields.reviewedEndpointDigest,
    fields.reasonCode,
    fields.reasonDigest,
  ]);
}

export interface LifecycleTransitionRequestFields {
  readonly expectedUpdatedAt: string;
  readonly expectedActiveVersion: string | null;
}

export function digestLifecycleTransitionRequest(
  operation: LifecycleOperation,
  context: LifecycleDigestContext,
  listingId: string,
  version: string,
  fields: LifecycleTransitionRequestFields,
): string {
  return digestLifecycleRequest(operation, context, [
    listingId,
    version,
    fields.expectedUpdatedAt,
    fields.expectedActiveVersion,
  ]);
}

export function digestLifecycleSessionContext(
  operation: LifecycleOperation,
  sessionHash: string,
): string {
  if (typeof sessionHash !== 'string' || !HEX64.test(sessionHash)) throw new MarketInputError();
  return sha256Hex(`${LIFECYCLE_SESSION_DOMAIN_BY_OPERATION[operation]}:${sessionHash}`);
}

export function digestLifecycleIdempotencyKey(
  operation: LifecycleOperation,
  rawKey: string,
): string {
  const key = requireIdempotencyKey(rawKey);
  return sha256Hex(`${LIFECYCLE_KEY_DOMAIN_BY_OPERATION[operation]}:${key}`);
}

/** Canonical `listingId@version` lifecycle resourceId with version >= 1. */
export function lifecycleResourceId(listingId: string, version: string): string {
  const listing = parseLifecycleListingId(listingId);
  const parsedVersion = parseLifecycleVersion(version);
  return `${listing}@${parsedVersion}`;
}
