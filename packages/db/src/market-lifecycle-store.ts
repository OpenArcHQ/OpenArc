import type { Pool } from 'pg';
import {
  CommerceListingOwnerSchema,
  CommerceListingOwnerVersionSchema,
  CommerceMarketLifecycleMutationReceiptSchema,
  CommerceMarketProviderOptionSchema,
  IsoTimestampSchema,
  type CommerceListingOwner,
  type CommerceListingOwnerVersion,
  type CommerceMarketOriginReviewDecision,
  type CommerceMarketOriginReviewReasonCode,
  type CommerceMarketProviderOption,
} from '@openarc/shared';
import {
  MarketStore,
  MarketStoreError,
  MARKET_LOCK_TIMEOUT_MS,
  MARKET_STATEMENT_TIMEOUT_MS,
  type MarketStoreErrorCode,
} from './market-store.js';
import {
  digestLifecycleIdempotencyKey,
  digestLifecycleSessionContext,
  digestLifecycleTransitionRequest,
  digestOriginReviewRequest,
  lifecycleResourceId,
  parseLifecycleDecision,
  parseLifecycleListingId,
  parseLifecycleReasonCode,
  parseLifecycleVersion,
  requireIdempotencyKey,
  requireLifecycleDigest,
  requireMutationId,
  requireNullableLifecycleDigest,
  type LifecycleOperation,
} from './market-lifecycle-mutations.js';
import {
  type DurableMutationMetadata,
  type TenantClient,
  type TenantPool,
} from './tenant-store.js';

/**
 * Reviewed lifecycle repository over the restricted tenant pool. Composes the
 * accepted TenantStore for the baseline schema checks and never migrates. Every
 * mutation runs in one connection/transaction through the reviewed SECURITY
 * DEFINER helpers; malformed driver rows collapse to a fixed UNAVAILABLE error.
 */

export interface LifecycleMutationReceipt {
  readonly mutationId: string;
  readonly operation: LifecycleOperation;
  readonly resourceType: 'listing_version';
  readonly resourceId: string;
  readonly committedAt: string;
}

export interface LifecycleMutationResult {
  readonly replayed: boolean;
  readonly receipt: LifecycleMutationReceipt;
}

export interface OriginReviewInput {
  readonly expectedUpdatedAt: string;
  readonly decision: unknown;
  readonly reviewedEndpointDigest: unknown;
  readonly reasonCode: unknown;
  readonly reasonDigest: unknown;
}

export interface LifecycleTransitionInput {
  readonly expectedUpdatedAt: string;
  readonly expectedActiveVersion: string | null;
}

export interface ListMarketProvidersInput {
  readonly afterProviderId?: string;
  readonly limit?: number;
}

export interface ListMarketProvidersResult {
  readonly items: CommerceMarketProviderOption[];
  readonly nextCursor: string | null;
}

const HEX64 = /^[0-9a-f]{64}$/;
const DEFAULT_PAGE = 25;
const MAX_PAGE = 50;
const PG_TIMESTAMP =
  /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?([+-])(\d{2})(?::?(\d{2}))?$/;

function fail(code: MarketStoreErrorCode): never {
  throw new MarketStoreError(code);
}

function failOutput(): never {
  fail('MARKET_STORE_UNAVAILABLE');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireSessionHash(value: unknown): string {
  if (typeof value !== 'string' || !HEX64.test(value)) fail('MARKET_STORE_INPUT_INVALID');
  return value;
}

const ORG_ID = /^openarc:org:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const PROVIDER_ID = /^openarc:provider:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function requireOrganization(value: unknown): string {
  if (typeof value !== 'string' || !ORG_ID.test(value)) fail('MARKET_STORE_INPUT_INVALID');
  return value;
}

function parseListingId(value: unknown): string {
  try {
    return parseLifecycleListingId(value);
  } catch {
    fail('MARKET_STORE_INPUT_INVALID');
  }
}

function parseVersion(value: unknown): string {
  try {
    return parseLifecycleVersion(value);
  } catch {
    fail('MARKET_STORE_INPUT_INVALID');
  }
}

function requirePage(value: unknown): number {
  if (value === undefined) return DEFAULT_PAGE;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > MAX_PAGE) {
    fail('MARKET_STORE_INPUT_INVALID');
  }
  return value;
}

function requireOptions(value: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (value === undefined) return {};
  if (!isRecord(value)) fail('MARKET_STORE_INPUT_INVALID');
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) fail('MARKET_STORE_INPUT_INVALID');
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) fail('MARKET_STORE_INPUT_INVALID');
  }
  return value;
}

function parseStrictMetadata(value: unknown): DurableMutationMetadata {
  if (!isRecord(value)) fail('MARKET_STORE_INPUT_INVALID');
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) fail('MARKET_STORE_INPUT_INVALID');
  const keys = Object.keys(value);
  if (keys.length !== 2 || !keys.includes('idempotencyKey') || !keys.includes('mutationId')) {
    fail('MARKET_STORE_INPUT_INVALID');
  }
  try {
    return {
      idempotencyKey: requireIdempotencyKey(value['idempotencyKey']),
      mutationId: requireMutationId(value['mutationId']),
    };
  } catch {
    fail('MARKET_STORE_INPUT_INVALID');
  }
}

function requireTimestamp(value: unknown): string {
  if (typeof value !== 'string' || !IsoTimestampSchema.safeParse(value).success) {
    fail('MARKET_STORE_INPUT_INVALID');
  }
  return value;
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function canonicalTimestamp(value: unknown): string {
  if (value instanceof Date) {
    if (!Number.isFinite(value.getTime())) failOutput();
    return value.toISOString();
  }
  if (typeof value !== 'string') failOutput();
  const match = PG_TIMESTAMP.exec(value);
  if (match === null) failOutput();
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, fraction, sign, offHourText, offMinuteText] = match;
  const year = Number.parseInt(yearText ?? '', 10);
  const month = Number.parseInt(monthText ?? '', 10);
  const day = Number.parseInt(dayText ?? '', 10);
  const hour = Number.parseInt(hourText ?? '', 10);
  const minute = Number.parseInt(minuteText ?? '', 10);
  const second = Number.parseInt(secondText ?? '', 10);
  const offHour = Number.parseInt(offHourText ?? '0', 10);
  const offMinute = Number.parseInt(offMinuteText ?? '0', 10);
  if (
    !Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day) ||
    !Number.isInteger(hour) || !Number.isInteger(minute) || !Number.isInteger(second) ||
    !Number.isInteger(offHour) || !Number.isInteger(offMinute) ||
    year < 1 || year > 9999 || month < 1 || month > 12 || day < 1 ||
    day > daysInMonth(year, month) || hour > 23 || minute > 59 || second > 59 ||
    offHour > 23 || offMinute > 59
  ) {
    failOutput();
  }
  const micros = (fraction ?? '').padEnd(6, '0').slice(0, 6);
  const offsetMinutes = (sign === '-' ? -1 : 1) * (offHour * 60 + offMinute);
  const local = new Date(0);
  local.setUTCFullYear(year, month - 1, day);
  local.setUTCHours(hour, minute, second, 0);
  const utcMillis = local.getTime() - offsetMinutes * 60_000;
  const normalized = new Date(utcMillis);
  if (!Number.isFinite(normalized.getTime())) failOutput();
  const iso = normalized.toISOString();
  return `${iso.slice(0, 19)}.${micros}Z`;
}

function canonicalTimestampOrNull(value: unknown): string | null {
  if (value === null) return null;
  if (value === undefined) failOutput();
  return canonicalTimestamp(value);
}

function requireOutputBoolean(value: unknown): boolean {
  if (value !== true && value !== false) failOutput();
  return value;
}

function requireAtMostOne<T>(rows: readonly T[]): T | undefined {
  if (rows.length > 1) failOutput();
  return rows[0];
}

function requireExactlyOne<T>(rows: readonly T[]): T {
  if (rows.length !== 1) failOutput();
  return rows[0] as T;
}

/** Output-side parsers: a malformed driver row is UNAVAILABLE, not input. */
function parseOutputListingId(value: unknown): string {
  try {
    return parseLifecycleListingId(value);
  } catch {
    failOutput();
  }
}

function parseOutputVersion(value: unknown): string {
  try {
    return parseLifecycleVersion(value);
  } catch {
    failOutput();
  }
}

function requireOutputOrganization(value: unknown): string {
  if (typeof value !== 'string' || !ORG_ID.test(value)) failOutput();
  return value;
}

function requireOutputProvider(value: unknown): string {
  if (typeof value !== 'string' || !PROVIDER_ID.test(value)) failOutput();
  return value;
}

function normalizeError(error: unknown): MarketStoreError {
  if (error instanceof MarketStoreError) return error;
  if (isRecord(error) && typeof error.code === 'string') {
    switch (error.code) {
      case '28000':
        return new MarketStoreError('MARKET_STORE_SESSION_INVALID');
      case '42501':
        return new MarketStoreError('MARKET_STORE_FORBIDDEN');
      case '23503':
        return new MarketStoreError('MARKET_STORE_NOT_FOUND');
      case '23505':
        return new MarketStoreError('MARKET_STORE_CONFLICT');
      case 'P0D01':
        return new MarketStoreError('MARKET_STORE_IDEMPOTENCY_CONFLICT');
      case '22023':
      case '22P02':
      case '22001':
      case '22003':
      case '23514':
        return new MarketStoreError('MARKET_STORE_INPUT_INVALID');
      default:
        return new MarketStoreError('MARKET_STORE_UNAVAILABLE');
    }
  }
  return new MarketStoreError('MARKET_STORE_UNAVAILABLE');
}

interface ReceiptRow extends Record<string, unknown> {
  readonly out_replayed: boolean;
  readonly out_mutation_id: string;
  readonly out_operation: string;
  readonly out_resource_type: string;
  readonly out_resource_id: string;
  readonly out_committed_at: string;
}

interface ListingsRow extends Record<string, unknown> {
  readonly out_listing_id: string;
  readonly out_organization_id: string;
  readonly out_provider_id: string;
  readonly out_active_version: string | null;
  readonly out_created_at: string;
  readonly out_updated_at: string;
}

interface ProviderRow extends Record<string, unknown> {
  readonly out_provider_id: string;
  readonly out_display_name: string;
  readonly out_status: string;
}

interface VersionRow extends Record<string, unknown> {
  readonly out_listing_id: string;
  readonly out_organization_id: string;
  readonly out_provider_id: string;
  readonly out_version: string;
  readonly out_kind: string;
  readonly out_title: string;
  readonly out_description: string;
  readonly out_manifest: unknown;
  readonly out_price: unknown;
  readonly out_evidence_contract: unknown;
  readonly out_endpoint_contract: unknown;
  readonly out_origin_review_state: string;
  readonly out_terms_revision: string;
  readonly out_privacy_summary: string;
  readonly out_payment_lane: string;
  readonly out_availability: unknown;
  readonly out_status: string;
  readonly out_created_at: string;
  readonly out_updated_at: string;
  readonly out_published_at: string | null;
}

export class MarketLifecycleStore {
  readonly #pool: TenantPool;
  readonly #base: MarketStore;
  #initialized = false;

  constructor(pool: TenantPool) {
    if (pool === null || typeof pool !== 'object' || typeof pool.connect !== 'function') {
      fail('MARKET_STORE_INPUT_INVALID');
    }
    this.#pool = pool;
    this.#base = new MarketStore(pool);
  }

  async initialize(): Promise<void> {
    if (this.#initialized) return;
    await this.#baseChecks(() => this.#base.initialize());
    await this.#withTransaction(async (client) => {
      await this.#assertLifecycleReady(client);
    });
    this.#initialized = true;
  }

  async readiness(): Promise<void> {
    await this.#baseChecks(() => this.#base.readiness());
    await this.#withTransaction(async (client) => {
      await this.#assertLifecycleReady(client);
    });
  }

  async #baseChecks(run: () => Promise<void>): Promise<void> {
    try {
      await run();
    } catch {
      fail('MARKET_STORE_UNAVAILABLE');
    }
  }

  async getOwnerListing(
    sessionHash: unknown,
    organizationId: unknown,
    listingId: unknown,
  ): Promise<CommerceListingOwner | null> {
    const hash = requireSessionHash(sessionHash);
    const organization = requireOrganization(organizationId);
    const listing = parseListingId(listingId);
    return this.#withTransaction(async (client) => {
      const result = await client.query<ListingsRow>(
        `SELECT out_listing_id, out_organization_id, out_provider_id,
                out_active_version, out_created_at::text AS out_created_at,
                out_updated_at::text AS out_updated_at
           FROM openarc_durable.read_owner_listing($1, $2, $3)`,
        [hash, organization, listing],
      );
      const row = requireAtMostOne(result.rows);
      if (row === undefined) return null;
      const item = this.#projectListing(row);
      if (item.organizationId !== organization || item.listingId !== listing) failOutput();
      return item;
    });
  }

  async listMarketProviders(
    sessionHash: unknown,
    organizationId: unknown,
    options?: ListMarketProvidersInput,
  ): Promise<ListMarketProvidersResult> {
    const hash = requireSessionHash(sessionHash);
    const organization = requireOrganization(organizationId);
    const parsedOptions = requireOptions(options, ['afterProviderId', 'limit']);
    const limit = requirePage(parsedOptions['limit']);
    const after =
      parsedOptions['afterProviderId'] === undefined
        ? null
        : this.#parseProviderId(parsedOptions['afterProviderId']);
    return this.#withTransaction(async (client) => {
      const result = await client.query<ProviderRow>(
        `SELECT out_provider_id, out_display_name, out_status
           FROM openarc_durable.list_market_providers($1, $2, $3, $4)`,
        [hash, organization, after, limit + 1],
      );
      if (result.rows.length > limit + 1) failOutput();
      const projected = result.rows.map((row) => this.#projectProvider(row));
      let previous: string | undefined;
      for (const item of projected) {
        if (previous !== undefined && item.providerId <= previous) failOutput();
        previous = item.providerId;
      }
      if (after !== null) {
        const first = projected[0]?.providerId;
        if (first !== undefined && first <= after) failOutput();
      }
      const visible = projected.slice(0, limit);
      const nextCursor =
        result.rows.length > limit ? visible[visible.length - 1]?.providerId ?? null : null;
      return { items: visible, nextCursor };
    });
  }

  #parseProviderId(value: unknown): string {
    if (typeof value !== 'string' || !PROVIDER_ID.test(value)) fail('MARKET_STORE_INPUT_INVALID');
    return value;
  }

  async getModeratorListingVersion(
    sessionHash: unknown,
    organizationId: unknown,
    listingId: unknown,
    version: unknown,
  ): Promise<CommerceListingOwnerVersion | null> {
    const hash = requireSessionHash(sessionHash);
    const organization = requireOrganization(organizationId);
    const listing = parseListingId(listingId);
    const parsedVersion = parseVersion(version);
    return this.#withTransaction(async (client) => {
      const result = await client.query<VersionRow>(
        `SELECT out_listing_id, out_organization_id, out_provider_id, out_version,
                out_kind, out_title, out_description, out_manifest, out_price,
                out_evidence_contract, out_endpoint_contract, out_origin_review_state,
                out_terms_revision, out_privacy_summary, out_payment_lane,
                out_availability, out_status, out_created_at::text AS out_created_at,
                out_updated_at::text AS out_updated_at,
                out_published_at::text AS out_published_at
           FROM openarc_durable.get_moderator_listing_version($1, $2, $3, $4)`,
        [hash, organization, listing, parsedVersion],
      );
      const row = requireAtMostOne(result.rows);
      if (row === undefined) return null;
      const item = this.#projectVersion(row);
      if (
        item.organizationId !== organization ||
        item.listingId !== listing ||
        item.version !== parsedVersion
      ) {
        failOutput();
      }
      return item;
    });
  }

  async recordOriginReview(
    sessionHash: unknown,
    organizationId: unknown,
    listingId: unknown,
    version: unknown,
    input: OriginReviewInput,
    metadata: unknown,
  ): Promise<LifecycleMutationResult> {
    const hash = requireSessionHash(sessionHash);
    const organization = requireOrganization(organizationId);
    const listing = parseListingId(listingId);
    const parsedVersion = parseVersion(version);
    if (!isRecord(input)) fail('MARKET_STORE_INPUT_INVALID');
    const keys = Object.keys(input);
    const allowed = ['expectedUpdatedAt', 'decision', 'reviewedEndpointDigest', 'reasonCode', 'reasonDigest'];
    if (keys.length !== allowed.length) fail('MARKET_STORE_INPUT_INVALID');
    for (const key of keys) if (!allowed.includes(key)) fail('MARKET_STORE_INPUT_INVALID');
    const expectedUpdatedAt = requireTimestamp(input['expectedUpdatedAt']);
    let decision: CommerceMarketOriginReviewDecision;
    let reasonCode: CommerceMarketOriginReviewReasonCode;
    let reviewedDigest: string;
    let reasonDigest: string | null;
    try {
      decision = parseLifecycleDecision(input['decision']);
      reasonCode = parseLifecycleReasonCode(input['reasonCode']);
      reviewedDigest = requireLifecycleDigest(input['reviewedEndpointDigest']);
      reasonDigest = requireNullableLifecycleDigest(input['reasonDigest']);
    } catch {
      fail('MARKET_STORE_INPUT_INVALID');
    }
    const meta = parseStrictMetadata(metadata);
    const operation: LifecycleOperation = 'market.listing.origin_review.record';
    const sessionContextDigest = digestLifecycleSessionContext(operation, hash);
    const keyHash = digestLifecycleIdempotencyKey(operation, meta.idempotencyKey);
    return this.#withTransaction(async (client) => {
      const actor = await this.#lockModerator(client, hash, organization);
      const requestDigest = digestOriginReviewRequest(
        {
          organizationId: organization,
          actorAccountId: actor,
          actorRole: 'moderator',
          sessionContextDigest,
          mutationId: meta.mutationId,
        },
        listing,
        parsedVersion,
        {
          expectedUpdatedAt,
          decision,
          reviewedEndpointDigest: reviewedDigest,
          reasonCode,
          reasonDigest,
        },
      );
      const result = await client.query<ReceiptRow>(
        `SELECT out_replayed, out_mutation_id, out_operation, out_resource_type,
                out_resource_id, out_committed_at::text AS out_committed_at
           FROM openarc_durable.commit_origin_review(
             $1, $2, $3, $4, $5::timestamptz, $6, $7, $8, $9,
             $10::uuid, $11, $12, $13)`,
        [
          hash, organization, listing, parsedVersion, expectedUpdatedAt,
          decision, reviewedDigest, reasonCode, reasonDigest,
          meta.mutationId, keyHash, requestDigest, sessionContextDigest,
        ],
      );
      return {
        replayed: requireOutputBoolean(requireExactlyOne(result.rows).out_replayed),
        receipt: this.#projectReceipt(
          requireExactlyOne(result.rows),
          operation,
          meta.mutationId,
          listing,
          parsedVersion,
        ),
      };
    });
  }

  async publishListingVersion(
    sessionHash: unknown,
    organizationId: unknown,
    listingId: unknown,
    version: unknown,
    input: LifecycleTransitionInput,
    metadata: unknown,
  ): Promise<LifecycleMutationResult> {
    return this.#transition('market.listing.version.publish', sessionHash, organizationId, listingId, version, input, metadata);
  }

  async pauseListingVersion(
    sessionHash: unknown,
    organizationId: unknown,
    listingId: unknown,
    version: unknown,
    input: LifecycleTransitionInput,
    metadata: unknown,
  ): Promise<LifecycleMutationResult> {
    return this.#transition('market.listing.version.pause', sessionHash, organizationId, listingId, version, input, metadata);
  }

  async retireListingVersion(
    sessionHash: unknown,
    organizationId: unknown,
    listingId: unknown,
    version: unknown,
    input: LifecycleTransitionInput,
    metadata: unknown,
  ): Promise<LifecycleMutationResult> {
    return this.#transition('market.listing.version.retire', sessionHash, organizationId, listingId, version, input, metadata);
  }

  async #transition(
    operation: LifecycleOperation,
    sessionHash: unknown,
    organizationId: unknown,
    listingId: unknown,
    version: unknown,
    input: LifecycleTransitionInput,
    metadata: unknown,
  ): Promise<LifecycleMutationResult> {
    const hash = requireSessionHash(sessionHash);
    const organization = requireOrganization(organizationId);
    const listing = parseListingId(listingId);
    const parsedVersion = parseVersion(version);
    if (!isRecord(input)) fail('MARKET_STORE_INPUT_INVALID');
    const keys = Object.keys(input);
    if (keys.length !== 2 || !keys.includes('expectedUpdatedAt') || !keys.includes('expectedActiveVersion')) {
      fail('MARKET_STORE_INPUT_INVALID');
    }
    const expectedUpdatedAt = requireTimestamp(input['expectedUpdatedAt']);
    const rawActive = input['expectedActiveVersion'];
    let expectedActiveVersion: string | null;
    if (rawActive === null) expectedActiveVersion = null;
    else expectedActiveVersion = parseVersion(rawActive);
    const meta = parseStrictMetadata(metadata);
    const sessionContextDigest = digestLifecycleSessionContext(operation, hash);
    const keyHash = digestLifecycleIdempotencyKey(operation, meta.idempotencyKey);
    return this.#withTransaction(async (client) => {
      const actor = await this.#lockWriter(client, hash, organization, listing);
      const requestDigest = digestLifecycleTransitionRequest(
        operation,
        {
          organizationId: organization,
          actorAccountId: actor,
          actorRole: 'writer',
          sessionContextDigest,
          mutationId: meta.mutationId,
        },
        listing,
        parsedVersion,
        { expectedUpdatedAt, expectedActiveVersion },
      );
      const result = await client.query<ReceiptRow>(
        `SELECT out_replayed, out_mutation_id, out_operation, out_resource_type,
                out_resource_id, out_committed_at::text AS out_committed_at
           FROM openarc_durable.commit_lifecycle_transition(
             $1, $2, $3, $4, $5, $6::timestamptz, $7,
             $8::uuid, $9, $10, $11)`,
        [
          hash, organization, listing, parsedVersion, operation,
          expectedUpdatedAt, expectedActiveVersion,
          meta.mutationId, keyHash, requestDigest, sessionContextDigest,
        ],
      );
      const row = requireExactlyOne(result.rows);
      return {
        replayed: requireOutputBoolean(row.out_replayed),
        receipt: this.#projectReceipt(row, operation, meta.mutationId, listing, parsedVersion),
      };
    });
  }

  async getLifecycleMutationStatus(
    sessionHash: unknown,
    organizationId: unknown,
    mutationId: unknown,
  ): Promise<{ readonly status: 'committed'; readonly receipt: LifecycleMutationReceipt } | { readonly status: 'not_found' }> {
    const hash = requireSessionHash(sessionHash);
    const organization = requireOrganization(organizationId);
    let mutation: string;
    try {
      mutation = requireMutationId(mutationId);
    } catch {
      fail('MARKET_STORE_INPUT_INVALID');
    }
    return this.#withTransaction(async (client) => {
      const result = await client.query<ReceiptRow>(
        `SELECT out_mutation_id, out_operation, out_resource_type,
                out_resource_id, out_committed_at::text AS out_committed_at
           FROM openarc_durable.read_lifecycle_mutation_status($1, $2, $3::uuid)`,
        [hash, organization, mutation],
      );
      const row = requireAtMostOne(result.rows);
      if (row === undefined) return { status: 'not_found' } as const;
      const operation = this.#parseOperation(row.out_operation);
      const resourceId = row.out_resource_id;
      const parts = resourceId.split('@');
      if (parts.length !== 2) failOutput();
      const listing = parseOutputListingId(parts[0]);
      const version = parseOutputVersion(parts[1]);
      return {
        status: 'committed' as const,
        receipt: this.#projectReceipt(row, operation, mutation, listing, version),
      };
    });
  }

  #parseOperation(value: unknown): LifecycleOperation {
    if (
      value !== 'market.listing.origin_review.record' &&
      value !== 'market.listing.version.publish' &&
      value !== 'market.listing.version.pause' &&
      value !== 'market.listing.version.retire'
    ) {
      failOutput();
    }
    return value;
  }

  async #lockModerator(client: TenantClient, hash: string, organization: string): Promise<string> {
    const result = await client.query<{ out_actor: string }>(
      `SELECT out_actor FROM openarc_durable.lock_moderator_actor($1, $2)`,
      [hash, organization],
    );
    const row = result.rows[0];
    if (row === undefined || typeof row.out_actor !== 'string') fail('MARKET_STORE_FORBIDDEN');
    return row.out_actor;
  }

  async #lockWriter(
    client: TenantClient,
    hash: string,
    organization: string,
    listing: string,
  ): Promise<string> {
    const result = await client.query<{ out_actor: string; out_provider_id: string }>(
      `SELECT out_actor, out_provider_id
         FROM openarc_durable.lock_lifecycle_writer($1, $2, $3)`,
      [hash, organization, listing],
    );
    const row = result.rows[0];
    if (row === undefined || typeof row.out_actor !== 'string') fail('MARKET_STORE_FORBIDDEN');
    return row.out_actor;
  }

  #projectReceipt(
    row: ReceiptRow,
    operation: LifecycleOperation,
    expectedMutationId: string,
    listing: string,
    version: string,
  ): LifecycleMutationReceipt {
    if (row.out_operation !== operation) failOutput();
    if (row.out_resource_type !== 'listing_version') failOutput();
    let mutationId: string;
    try {
      mutationId = requireMutationId(row.out_mutation_id);
    } catch {
      failOutput();
    }
    if (mutationId !== expectedMutationId) failOutput();
    const expectedResourceId = lifecycleResourceId(listing, version);
    if (row.out_resource_id !== expectedResourceId) failOutput();
    const parsed = CommerceMarketLifecycleMutationReceiptSchema.safeParse({
      mutationId,
      operation,
      resourceType: 'listing_version',
      resourceId: expectedResourceId,
      committedAt: canonicalTimestamp(row.out_committed_at),
    });
    if (!parsed.success) failOutput();
    return parsed.data;
  }

  #projectListing(row: ListingsRow): CommerceListingOwner {
    const parsed = CommerceListingOwnerSchema.safeParse({
      schemaVersion: 'openarc.listing.v1',
      listingId: parseOutputListingId(row.out_listing_id),
      organizationId: requireOutputOrganization(row.out_organization_id),
      providerId: requireOutputProvider(row.out_provider_id),
      activeVersion:
        row.out_active_version === null ? null : parseOutputVersion(row.out_active_version),
      createdAt: canonicalTimestamp(row.out_created_at),
      updatedAt: canonicalTimestamp(row.out_updated_at),
    });
    if (!parsed.success) failOutput();
    return parsed.data;
  }

  #projectProvider(row: ProviderRow): CommerceMarketProviderOption {
    const parsed = CommerceMarketProviderOptionSchema.safeParse({
      providerId: requireOutputProvider(row.out_provider_id),
      displayName: row.out_display_name,
      status: row.out_status,
    });
    if (!parsed.success) failOutput();
    return parsed.data;
  }

  #projectVersion(row: VersionRow): CommerceListingOwnerVersion {
    const parsed = CommerceListingOwnerVersionSchema.safeParse({
      schemaVersion: 'openarc.listing-owner-version.v1',
      listingId: parseOutputListingId(row.out_listing_id),
      organizationId: requireOutputOrganization(row.out_organization_id),
      providerId: requireOutputProvider(row.out_provider_id),
      version: parseOutputVersion(row.out_version),
      kind: row.out_kind,
      title: row.out_title,
      description: row.out_description,
      manifest: row.out_manifest,
      price: row.out_price,
      evidenceContract: row.out_evidence_contract,
      endpointContract: row.out_endpoint_contract,
      originReviewState: row.out_origin_review_state,
      termsRevision: row.out_terms_revision,
      privacySummary: row.out_privacy_summary,
      paymentLane: row.out_payment_lane,
      availability: row.out_availability,
      status: row.out_status,
      createdAt: canonicalTimestamp(row.out_created_at),
      updatedAt: canonicalTimestamp(row.out_updated_at),
      publishedAt: canonicalTimestampOrNull(row.out_published_at),
    });
    if (!parsed.success) failOutput();
    return parsed.data;
  }

  async #assertLifecycleReady(client: TenantClient): Promise<void> {
    // The first five tables are exactly migrator-owned with forced RLS.
    const tables = await client.query<{ n: number; all_enabled: boolean; all_forced: boolean }>(
      `SELECT count(*)::int AS n,
              bool_and(c.relrowsecurity) AS all_enabled,
              bool_and(c.relforcerowsecurity) AS all_forced
         FROM pg_class c
         JOIN pg_namespace ns ON ns.oid = c.relnamespace
        WHERE ns.nspname = 'openarc_tenant'
          AND c.relkind = 'r'
          AND c.relname IN ('listings', 'listing_versions', 'listing_version_states',
                            'listing_origin_reviews', 'market_moderator_grants')`,
    );
    const state = tables.rows[0];
    if (state === undefined || state.n !== 5 || state.all_enabled !== true || state.all_forced !== true) {
      fail('MARKET_STORE_UNAVAILABLE');
    }
    const owners = await client.query<{ n: number }>(
      `SELECT count(*)::int AS n
         FROM pg_class c
         JOIN pg_namespace ns ON ns.oid = c.relnamespace
         JOIN pg_roles r ON r.oid = c.relowner
        WHERE ns.nspname = 'openarc_tenant'
          AND c.relkind = 'r'
          AND c.relname IN ('listings', 'listing_versions', 'listing_version_states',
                            'listing_origin_reviews', 'market_moderator_grants')
          AND r.rolname = 'openarc_migrator'`,
    );
    if ((owners.rows[0]?.n ?? -1) !== 5) fail('MARKET_STORE_UNAVAILABLE');

    // No runtime-reachable role holds a direct privilege on the new tables.
    const access = await client.query<{ n: number }>(
      `WITH reachable AS (
         SELECT r.oid FROM pg_roles r
          WHERE r.oid = (SELECT oid FROM pg_roles WHERE rolname = current_user)
             OR pg_has_role(current_user, r.oid, 'MEMBER')
       )
       SELECT count(*)::int AS n
         FROM pg_class c
         JOIN pg_namespace ns ON ns.oid = c.relnamespace
        WHERE ns.nspname = 'openarc_tenant'
          AND c.relkind = 'r'
          AND c.relname IN ('listing_origin_reviews', 'market_moderator_grants')
          AND EXISTS (
            SELECT 1 FROM reachable x
             WHERE has_table_privilege(x.oid, c.oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
          )`,
    );
    if ((access.rows[0]?.n ?? -1) !== 0) fail('MARKET_STORE_UNAVAILABLE');

    await this.#assertLifecyclePolicies(client);
    await this.#assertLifecycleHelpers(client);
  }

  /**
   * The only new provider policy is the approver's UPDATE policy TO
   * openarc_migrator. No new policy is granted to a runtime role, and the
   * runtime remains a non-member of the migrator.
   */
  async #assertLifecyclePolicies(client: TenantClient): Promise<void> {
    const policy = await client.query<{ polname: string; roles: string[]; cmd: string; using_expr: string | null; check_expr: string | null }>(
      `SELECT p.polname,
              array(SELECT r.rolname::text FROM unnest(p.polroles) AS o JOIN pg_roles r ON r.oid = o ORDER BY r.rolname) AS roles,
              p.polcmd AS cmd,
              pg_get_expr(p.polqual, p.polrelid) AS using_expr,
              pg_get_expr(p.polwithcheck, p.polrelid) AS check_expr
         FROM pg_policy p
         JOIN pg_class c ON c.oid = p.polrelid
         JOIN pg_namespace ns ON ns.oid = c.relnamespace
        WHERE ns.nspname = 'openarc_tenant' AND c.relname = 'providers'
          AND p.polname = 'providers_update_migrator'`,
    );
    const row = policy.rows[0];
    // The accepted schema7 providers UPDATE policy is the exact
    // current_user = 'openarc_migrator' equality (deparsed with the name cast)
    // for BOTH the USING and WITH CHECK expressions. polcmd 'w' is UPDATE. Any
    // drift in either expression is a posture failure; the runtime never holds
    // this policy. The role list is cast to text[] so the driver parses it as
    // an array rather than a raw name[] literal.
    const acceptedExpr = "(CURRENT_USER = 'openarc_migrator'::name)";
    if (
      row === undefined ||
      row.cmd !== 'w' ||
      row.roles.length !== 1 ||
      row.roles[0] !== 'openarc_migrator' ||
      row.using_expr !== acceptedExpr ||
      row.check_expr !== acceptedExpr
    ) {
      fail('MARKET_STORE_UNAVAILABLE');
    }
    const runtimePolicies = await client.query<{ n: number }>(
      `SELECT count(*)::int AS n
         FROM pg_policy p
         JOIN pg_class c ON c.oid = p.polrelid
         JOIN pg_namespace ns ON ns.oid = c.relnamespace
         JOIN unnest(p.polroles) AS o ON true
         JOIN pg_roles r ON r.oid = o
        WHERE ns.nspname = 'openarc_tenant'
          AND c.relname IN ('providers', 'listing_origin_reviews', 'market_moderator_grants')
          AND r.rolname IN ('openarc_tenant_app', 'openarc_worker_app', 'openarc_auth_app')`,
    );
    if ((runtimePolicies.rows[0]?.n ?? -1) !== 0) fail('MARKET_STORE_UNAVAILABLE');
    const membership = await client.query<{ n: number }>(
      `SELECT count(*)::int AS n
         FROM pg_roles a
         JOIN pg_auth_members m ON m.member = a.oid
         JOIN pg_roles b ON b.oid = m.roleid
        WHERE a.rolname = 'openarc_tenant_app' AND b.rolname = 'openarc_migrator'`,
    );
    if ((membership.rows[0]?.n ?? -1) !== 0) fail('MARKET_STORE_UNAVAILABLE');
  }

  /**
   * Exact signatures/owner/SECDEF/search_path/EXECUTE ACL for the runtime
   * lifecycle helpers, and NO runtime/public EXECUTE for internal validators.
   */
  async #assertLifecycleHelpers(client: TenantClient): Promise<void> {
    const expected: readonly { name: string; args: string }[] = [
      { name: 'commit_origin_review', args: 'session_hash text, organization_id text, listing_id text, version text, expected_updated_at timestamp with time zone, decision text, reviewed_digest text, reason_code text, reason_digest text, mutation_id uuid, key_hash text, request_digest text, session_context_digest text' },
      { name: 'commit_lifecycle_transition', args: 'session_hash text, organization_id text, listing_id text, version text, operation text, expected_updated_at timestamp with time zone, expected_active_version text, mutation_id uuid, key_hash text, request_digest text, session_context_digest text' },
      { name: 'lock_moderator_actor', args: 'session_hash text, organization_id text' },
      { name: 'lock_lifecycle_writer', args: 'session_hash text, organization_id text, listing_id text' },
      { name: 'read_owner_listing', args: 'session_hash text, organization_id text, listing_id text' },
      { name: 'list_market_providers', args: 'session_hash text, organization_id text, after_provider_id text, page_limit integer' },
      { name: 'get_moderator_listing_version', args: 'session_hash text, organization_id text, listing_id text, version text' },
      { name: 'read_lifecycle_mutation_status', args: 'session_hash text, organization_id text, mutation_id uuid' },
    ];
    const helpers = await client.query<{
      proname: string;
      args: string;
      owner: string;
      prosecdef: boolean;
      config: string[];
      app_exec: boolean;
      public_grants: number;
      forbidden_grants: number;
    }>(
      `SELECT p.proname,
              pg_get_function_identity_arguments(p.oid) AS args,
              r.rolname AS owner,
              p.prosecdef,
              coalesce(p.proconfig, ARRAY[]::text[]) AS config,
              has_function_privilege('openarc_tenant_app', p.oid, 'EXECUTE') AS app_exec,
              (SELECT count(*)::int
                 FROM aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE') AS public_grants,
              (SELECT count(*)::int
                 FROM aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                 JOIN pg_roles gr ON gr.oid = a.grantee
                WHERE gr.rolname IN ('openarc_worker_app', 'openarc_auth_app')
                  AND a.privilege_type = 'EXECUTE') AS forbidden_grants
         FROM pg_proc p
         JOIN pg_namespace n ON n.oid = p.pronamespace
         JOIN pg_roles r ON r.oid = p.proowner
        WHERE n.nspname = 'openarc_durable'
          AND p.prokind = 'f'
          AND p.proname IN (
            'commit_origin_review', 'commit_lifecycle_transition',
            'lock_moderator_actor', 'lock_lifecycle_writer', 'read_owner_listing',
            'list_market_providers', 'get_moderator_listing_version',
            'read_lifecycle_mutation_status'
          )
        ORDER BY p.proname, p.oid`,
    );
    const byName = new Map(helpers.rows.map((row) => [row.proname, row]));
    for (const spec of expected) {
      const row = byName.get(spec.name);
      if (row === undefined) fail('MARKET_STORE_UNAVAILABLE');
      if (
        row.args !== spec.args ||
        row.owner !== 'openarc_migrator' ||
        row.prosecdef !== true ||
        !Array.isArray(row.config) ||
        !row.config.includes('search_path=pg_catalog') ||
        row.app_exec !== true ||
        row.public_grants !== 0 ||
        row.forbidden_grants !== 0
      ) {
        fail('MARKET_STORE_UNAVAILABLE');
      }
    }
    if (helpers.rows.length !== expected.length) fail('MARKET_STORE_UNAVAILABLE');

    // Internal trigger/validator helpers are migrator-only: no runtime EXECUTE.
    const internal = await client.query<{ n: number }>(
      `SELECT count(*)::int AS n
         FROM pg_proc p
         JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname IN ('openarc_durable', 'openarc_tenant')
          AND p.proname IN (
            'reviewed_endpoint_digest', 'assert_listing_active_pointer',
            'check_listings_active_pointer', 'check_states_active_pointer',
            'reject_listing_origin_review_mutation'
          )
          AND (
            has_function_privilege('openarc_tenant_app', p.oid, 'EXECUTE')
            OR has_function_privilege('openarc_worker_app', p.oid, 'EXECUTE')
            OR has_function_privilege('openarc_auth_app', p.oid, 'EXECUTE')
            OR EXISTS (
              SELECT 1 FROM aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
               WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE'
            )
          )`,
    );
    if ((internal.rows[0]?.n ?? -1) !== 0) fail('MARKET_STORE_UNAVAILABLE');
  }

  async #withTransaction<T>(work: (client: TenantClient) => Promise<T>): Promise<T> {
    let client: TenantClient;
    try {
      client = await this.#pool.connect();
    } catch {
      fail('MARKET_STORE_UNAVAILABLE');
    }
    try {
      await client.query('BEGIN');
      await client.query(`SET LOCAL statement_timeout = '${MARKET_STATEMENT_TIMEOUT_MS}ms'`);
      await client.query(`SET LOCAL lock_timeout = '${MARKET_LOCK_TIMEOUT_MS}ms'`);
    } catch {
      this.#release(client, true);
      fail('MARKET_STORE_UNAVAILABLE');
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
      fail('MARKET_STORE_OUTCOME_UNKNOWN');
    }
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
}

export function asLifecyclePool(pool: Pool): TenantPool {
  return pool as unknown as TenantPool;
}
