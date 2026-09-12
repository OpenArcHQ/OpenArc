import { createHash } from 'node:crypto';
import {
  CommerceListingAvailabilitySchema,
  CommerceEndpointContractSchema,
  CommerceListingIdSchema,
  CommerceListingKindSchema,
  CommerceListingManifestSchema,
  CommerceListingOwnerVersionSchema,
  CommerceListingPriceSchema,
  CommerceListingVersionSchema,
  CommerceReceiptContractSchema,
  type CommerceListingAvailability,
  type CommerceEndpointContract,
  type CommerceListingKind,
  type CommerceListingManifest,
  type CommerceListingOwnerVersion,
  type CommerceListingPrice,
  type CommerceReceiptContract,
} from '@openarc/shared';

/**
 * Pure metadata authority for the two durable market operations
 * `market.listing.create` and `market.listing.version.create`.
 *
 * This module exposes ONLY canonical parsers and digest helpers. It accepts no
 * callback, no principal, no role, no clock and no network. All server-side
 * resolution happens inside the reviewed SQL definer helpers.
 */

export const MARKET_NETWORK = 'eip155:5042002' as const;
export const MARKET_PAYMENT_LANE = 'unavailable' as const;
export const MARKET_DIGEST_VERSION = 'market.listing.create.v1' as const;

export const MARKET_OPERATIONS = [
  'market.listing.create',
  'market.listing.version.create',
] as const;

export type MarketOperation = (typeof MARKET_OPERATIONS)[number];

export type MarketResourceType = 'listing' | 'listing_version';

export const MARKET_RESOURCE_BY_OPERATION = Object.freeze({
  'market.listing.create': 'listing',
  'market.listing.version.create': 'listing_version',
}) satisfies Readonly<Record<MarketOperation, MarketResourceType>>;

export const MARKET_EVENT_BY_OPERATION = Object.freeze({
  'market.listing.create': 'market.listing.created',
  'market.listing.version.create': 'market.listing.version.created',
}) satisfies Readonly<Record<MarketOperation, string>>;

export const MARKET_SESSION_DOMAIN_BY_OPERATION = Object.freeze({
  'market.listing.create': 'openarc.market.listing.create.session.v1',
  'market.listing.version.create': 'openarc.market.listing.version.create.session.v1',
}) satisfies Readonly<Record<MarketOperation, string>>;

export const MARKET_KEY_DOMAIN_BY_OPERATION = Object.freeze({
  'market.listing.create': 'openarc.market.listing.create.idempotency.v1',
  'market.listing.version.create': 'openarc.market.listing.version.create.idempotency.v1',
}) satisfies Readonly<Record<MarketOperation, string>>;

export const MARKET_DIGEST_DOMAIN_BY_OPERATION = Object.freeze({
  'market.listing.create': 'market.listing.create.v1',
  'market.listing.version.create': 'market.listing.version.create.v1',
}) satisfies Readonly<Record<MarketOperation, string>>;

/** The twelve caller-supplied immutable content fields. */
export interface MarketListingContent {
  readonly kind: CommerceListingKind;
  readonly title: string;
  readonly description: string;
  readonly manifest: CommerceListingManifest;
  readonly price: CommerceListingPrice;
  readonly evidenceContract: CommerceReceiptContract;
  readonly endpointContract: CommerceEndpointContract;
  readonly termsRevision: string;
  readonly privacySummary: string;
  readonly paymentLane: 'unavailable';
  readonly availability: CommerceListingAvailability;
}

export const MARKET_LISTING_CONTENT_KEYS = [
  'kind',
  'title',
  'description',
  'manifest',
  'price',
  'evidenceContract',
  'endpointContract',
  'termsRevision',
  'privacySummary',
  'paymentLane',
  'availability',
] as const;

export interface MarketMutationReceipt {
  readonly mutationId: string;
  readonly operation: MarketOperation;
  readonly resourceType: MarketResourceType;
  readonly resourceId: string;
  readonly committedAt: string;
}

export interface MarketMutationResult {
  readonly replayed: boolean;
  readonly receipt: MarketMutationReceipt;
}

export type MarketMutationStatus =
  | { readonly status: 'committed'; readonly receipt: MarketMutationReceipt }
  | { readonly status: 'not_found' };

export interface MarketMutationMetadata {
  readonly idempotencyKey: string;
  readonly mutationId: string;
}

/** Fixed, non-echoing market input error. Never carries caller detail. */
export class MarketInputError extends Error {
  constructor() {
    super('Market input is invalid.');
    this.name = 'MarketInputError';
  }
}

const HEX64 = /^[0-9a-f]{64}$/;
const MUTATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const BASE64URL_32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Strict parse of the twelve-field content input. Reuse the accepted owner
 * version schema (not an independently drifting validator) with a fixed draft
 * identity so every bounded field, nested key and the paymentLane literal are
 * validated exactly once by the shared contract.
 */
export function parseMarketListingContent(value: unknown): MarketListingContent {
  if (!isRecord(value)) throw new MarketInputError();
  const keys = Object.keys(value);
  if (keys.length !== MARKET_LISTING_CONTENT_KEYS.length) throw new MarketInputError();
  for (const key of keys) {
    if (!(MARKET_LISTING_CONTENT_KEYS as readonly string[]).includes(key)) {
      throw new MarketInputError();
    }
  }
  const parsed = CommerceListingOwnerVersionSchema.safeParse({
    schemaVersion: 'openarc.listing-owner-version.v1',
    listingId: 'openarc:listing:00000000-0000-4000-8000-000000000000',
    organizationId: 'openarc:org:00000000-0000-4000-8000-000000000000',
    providerId: 'openarc:provider:00000000-0000-4000-8000-000000000000',
    version: '1',
    kind: value['kind'],
    title: value['title'],
    description: value['description'],
    manifest: value['manifest'],
    price: value['price'],
    evidenceContract: value['evidenceContract'],
    endpointContract: value['endpointContract'],
    originReviewState: 'unreviewed',
    termsRevision: value['termsRevision'],
    privacySummary: value['privacySummary'],
    paymentLane: value['paymentLane'],
    availability: value['availability'],
    status: 'draft',
    createdAt: '2000-01-01T00:00:00.000Z',
    updatedAt: '2000-01-01T00:00:00.000Z',
    publishedAt: null,
  });
  if (!parsed.success) throw new MarketInputError();
  return {
    kind: parsed.data.kind,
    title: parsed.data.title,
    description: parsed.data.description,
    manifest: parsed.data.manifest,
    price: parsed.data.price,
    evidenceContract: parsed.data.evidenceContract,
    endpointContract: parsed.data.endpointContract,
    termsRevision: parsed.data.termsRevision,
    privacySummary: parsed.data.privacySummary,
    paymentLane: parsed.data.paymentLane,
    availability: parsed.data.availability,
  };
}

/**
 * Canonical fixed-order representation of one content value. Every field is
 * extracted explicitly; object key order is irrelevant and semantic changes
 * (including nested deliveryFields array order) change the digest.
 */
function canonicalContent(content: MarketListingContent): unknown[] {
  return [
    content.kind,
    content.title,
    content.description,
    content.manifest.schemaVersion,
    content.manifest.inputSchemaDigest,
    content.manifest.outputSchemaDigest,
    content.price.pricingModel,
    content.price.amount.representation,
    content.price.amount.decimals,
    content.price.amount.atomicAmount,
    content.evidenceContract.schemaVersion,
    content.evidenceContract.receiptType,
    content.evidenceContract.receiptSchemaDigest,
    [...content.evidenceContract.deliveryFields],
    content.endpointContract.origin,
    content.endpointContract.path,
    content.termsRevision,
    content.privacySummary,
    content.paymentLane,
    content.availability.status,
    content.availability.rateLimitPerMinute,
  ];
}

export interface MarketDigestContext {
  readonly organizationId: string;
  readonly actorAccountId: string;
  readonly actorRole: string;
  readonly sessionContextDigest: string;
  readonly mutationId: string;
}

export function digestMarketListingCreateRequest(
  context: MarketDigestContext,
  providerId: string,
  content: MarketListingContent,
): string {
  return digestMarketRequest('market.listing.create', context, [
    providerId,
    ...canonicalContent(content),
  ]);
}

export function digestMarketListingVersionCreateRequest(
  context: MarketDigestContext,
  listingId: string,
  expectedLatestVersion: string,
  content: MarketListingContent,
): string {
  return digestMarketRequest('market.listing.version.create', context, [
    listingId,
    expectedLatestVersion,
    ...canonicalContent(content),
  ]);
}

function digestMarketRequest(
  operation: MarketOperation,
  context: MarketDigestContext,
  target: unknown[],
): string {
  if (!HEX64.test(context.sessionContextDigest)) throw new MarketInputError();
  const mutationId = requireMutationId(context.mutationId);
  const canonical = JSON.stringify([
    MARKET_DIGEST_DOMAIN_BY_OPERATION[operation],
    MARKET_NETWORK,
    context.organizationId,
    context.actorAccountId,
    context.actorRole,
    context.sessionContextDigest,
    mutationId,
    ...target,
  ]);
  return sha256Hex(canonical);
}

export function requireMutationId(value: unknown): string {
  if (typeof value !== 'string' || value.length !== 36 || !MUTATION_ID.test(value)) {
    throw new MarketInputError();
  }
  return value;
}

export function requireIdempotencyKey(value: unknown): string {
  if (typeof value !== 'string' || value.length !== 43) throw new MarketInputError();
  let decoded: Buffer;
  try {
    decoded = Buffer.from(value, 'base64url');
  } catch {
    throw new MarketInputError();
  }
  if (decoded.length !== 32) throw new MarketInputError();
  if (decoded.toString('base64url') !== value) throw new MarketInputError();
  for (const character of value) {
    if (!BASE64URL_32.includes(character)) throw new MarketInputError();
  }
  return value;
}

export function digestMarketSessionContext(operation: MarketOperation, sessionHash: string): string {
  if (typeof sessionHash !== 'string' || !HEX64.test(sessionHash)) throw new MarketInputError();
  return sha256Hex(`${MARKET_SESSION_DOMAIN_BY_OPERATION[operation]}:${sessionHash}`);
}

export function digestMarketIdempotencyKey(operation: MarketOperation, rawKey: string): string {
  const key = requireIdempotencyKey(rawKey);
  return sha256Hex(`${MARKET_KEY_DOMAIN_BY_OPERATION[operation]}:${key}`);
}

export function parseMarketOperation(value: unknown): MarketOperation {
  if (typeof value !== 'string' || !(MARKET_OPERATIONS as readonly string[]).includes(value)) {
    throw new MarketInputError();
  }
  return value as MarketOperation;
}

export function parseMarketListingId(value: unknown): string {
  const parsed = CommerceListingIdSchema.safeParse(value);
  if (!parsed.success) throw new MarketInputError();
  return parsed.data;
}

export function parseMarketListingVersion(value: unknown): string {
  const parsed = CommerceListingVersionSchema.safeParse(value);
  if (!parsed.success) throw new MarketInputError();
  return parsed.data;
}

export function parseMarketListingKind(value: unknown): CommerceListingKind {
  const parsed = CommerceListingKindSchema.safeParse(value);
  if (!parsed.success) throw new MarketInputError();
  return parsed.data;
}

export function parseMarketManifest(value: unknown): CommerceListingManifest {
  const parsed = CommerceListingManifestSchema.safeParse(value);
  if (!parsed.success) throw new MarketInputError();
  return parsed.data;
}

export function parseMarketPrice(value: unknown): CommerceListingPrice {
  const parsed = CommerceListingPriceSchema.safeParse(value);
  if (!parsed.success) throw new MarketInputError();
  return parsed.data;
}

export function parseMarketEvidenceContract(value: unknown): CommerceReceiptContract {
  const parsed = CommerceReceiptContractSchema.safeParse(value);
  if (!parsed.success) throw new MarketInputError();
  return parsed.data;
}

export function parseMarketEndpointContract(value: unknown): CommerceEndpointContract {
  const parsed = CommerceEndpointContractSchema.safeParse(value);
  if (!parsed.success) throw new MarketInputError();
  return parsed.data;
}

export function parseMarketAvailability(value: unknown): CommerceListingAvailability {
  const parsed = CommerceListingAvailabilitySchema.safeParse(value);
  if (!parsed.success) throw new MarketInputError();
  return parsed.data;
}

export type { CommerceListingOwnerVersion };
