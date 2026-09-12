import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import {
  CommerceListingOwnerSchema,
  CommerceListingOwnerVersionSchema,
  type CommerceListingOwner,
  type CommerceListingOwnerVersion,
} from '@openarc/shared';
import { loadMigrations } from './migrate.js';
import {
  TenantStore,
  type DurableMutationMetadata,
  type TenantClient,
  type TenantPool,
  type TenantStoreErrorCode,
} from './tenant-store.js';
import {
  MARKET_RESOURCE_BY_OPERATION,
  MARKET_OPERATIONS,
  digestMarketIdempotencyKey,
  digestMarketListingCreateRequest,
  digestMarketListingVersionCreateRequest,
  digestMarketSessionContext,
  parseMarketListingId,
  parseMarketListingVersion,
  parseMarketListingContent,
  requireIdempotencyKey,
  requireMutationId,
  type MarketListingContent,
  type MarketMutationMetadata,
  type MarketMutationReceipt,
  type MarketMutationResult,
  type MarketMutationStatus,
  type MarketOperation,
  type MarketResourceType,
} from './market-mutations.js';

/**
 * MarketStore over the restricted tenant pool. Every operation runs in one
 * connection/transaction through the reviewed SECURITY DEFINER helpers and
 * never migrates. Outputs pass the exact shared listing validators; malformed
 * driver rows become a fixed UNAVAILABLE error and never leak driver values.
 */

export const MARKET_STORE_ERROR_MESSAGES = {
  MARKET_STORE_INPUT_INVALID: 'MarketStore input is invalid.',
  MARKET_STORE_SESSION_INVALID: 'MarketStore session is not valid.',
  MARKET_STORE_FORBIDDEN: 'MarketStore caller is not permitted.',
  MARKET_STORE_NOT_FOUND: 'MarketStore target was not found.',
  MARKET_STORE_CONFLICT: 'MarketStore operation conflicts with existing state.',
  MARKET_STORE_IDEMPOTENCY_CONFLICT:
    'MarketStore mutation conflicts with an existing idempotency record.',
  MARKET_STORE_UNAVAILABLE: 'MarketStore is not available.',
  MARKET_STORE_OUTCOME_UNKNOWN:
    'MarketStore mutation outcome could not be confirmed; it may have committed.',
} as const;

export type MarketStoreErrorCode = keyof typeof MARKET_STORE_ERROR_MESSAGES;

/** Fixed, non-echoing repository error. Never carries driver detail. */
export class MarketStoreError extends Error {
  readonly code: MarketStoreErrorCode;

  constructor(code: MarketStoreErrorCode) {
    super(MARKET_STORE_ERROR_MESSAGES[code]);
    this.name = 'MarketStoreError';
    this.code = code;
  }
}

export interface CreateListingVersionInput {
  readonly expectedLatestVersion: string;
  readonly content: MarketListingContent;
}

export interface ListOwnerListingsInput {
  readonly afterListingId?: string;
  readonly limit?: number;
}

export interface ListOwnerListingsResult {
  readonly items: CommerceListingOwner[];
  readonly nextCursor: string | null;
}

export interface ListOwnerListingVersionsInput {
  readonly afterVersion?: string;
  readonly limit?: number;
}

export interface ListOwnerListingVersionsResult {
  readonly items: CommerceListingOwnerVersion[];
  readonly nextCursor: string | null;
}

const HEX64 = /^[0-9a-f]{64}$/;
const DEFAULT_PAGE = 25;
const MAX_PAGE = 50;

/** Transaction-local bounds; never global connection or OS configuration. */
export const MARKET_STATEMENT_TIMEOUT_MS = 15000;
export const MARKET_LOCK_TIMEOUT_MS = 10000;

function fail(code: MarketStoreErrorCode): never {
  throw new MarketStoreError(code);
}

/** A malformed driver/daemon row is never caller input: it is UNAVAILABLE. */
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

function requireOrganization(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !/^openarc:org:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)
  ) {
    fail('MARKET_STORE_INPUT_INVALID');
  }
  return value;
}

function requireProvider(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !/^openarc:provider:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)
  ) {
    fail('MARKET_STORE_INPUT_INVALID');
  }
  return value;
}

function parseListingId(value: unknown): string {
  try {
    return parseMarketListingId(value);
  } catch {
    fail('MARKET_STORE_INPUT_INVALID');
  }
}

function parseListingVersion(value: unknown): string {
  try {
    return parseMarketListingVersion(value);
  } catch {
    fail('MARKET_STORE_INPUT_INVALID');
  }
}

/** Output-side parsers: malformed driver rows map to UNAVAILABLE, not input. */
function parseOutputListingId(value: unknown): string {
  try {
    return parseMarketListingId(value);
  } catch {
    failOutput();
  }
}

function parseOutputListingVersion(value: unknown): string {
  try {
    return parseMarketListingVersion(value);
  } catch {
    failOutput();
  }
}

function requireOutputOrganization(value: unknown): string {
  try {
    return requireOrganization(value);
  } catch {
    failOutput();
  }
}

function requireOutputProvider(value: unknown): string {
  try {
    return requireProvider(value);
  } catch {
    failOutput();
  }
}

function parseOutputMutationId(value: unknown): string {
  try {
    return requireMutationId(value);
  } catch {
    failOutput();
  }
}

function parseOutputOperation(value: unknown): MarketOperation {
  if (typeof value !== 'string' || !(MARKET_OPERATIONS as readonly string[]).includes(value)) {
    failOutput();
  }
  return value as MarketOperation;
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

function requirePage(value: unknown): number {
  if (value === undefined) return DEFAULT_PAGE;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > MAX_PAGE) {
    fail('MARKET_STORE_INPUT_INVALID');
  }
  return value;
}

/** A definer must never return more rows than the requested page plus one. */
function assertBoundedRows(count: number, limit: number): void {
  if (!Number.isInteger(count) || count < 0 || count > limit) failOutput();
}

function assertAscendingListingIds(ids: readonly string[]): void {
  for (let index = 1; index < ids.length; index += 1) {
    const previous = ids[index - 1];
    const current = ids[index];
    if (previous === undefined || current === undefined || previous >= current) failOutput();
  }
}

function assertAscendingVersions(versions: readonly string[]): void {
  for (let index = 1; index < versions.length; index += 1) {
    const previous = versions[index - 1];
    const current = versions[index];
    if (previous === undefined || current === undefined || BigInt(previous) >= BigInt(current)) {
      failOutput();
    }
  }
}

/** Strict option object: only the two accepted keys, plain object. */
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

/**
 * Canonical UTC rendering that preserves PostgreSQL microseconds. The SQL
 * helpers return `timestamptz::text`, so a value can carry up to six fractional
 * digits; Date parsing would truncate to milliseconds. A Date fallback is
 * accepted but is only millisecond-precise by construction.
 */
const PG_TIMESTAMP =
  /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?([+-])(\d{2})(?::?(\d{2}))?$/;

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/**
 * Canonical UTC rendering that preserves PostgreSQL microseconds. Calendar
 * fields are validated before any Date construction so an out-of-range value
 * can never be silently normalized (Date.UTC rolls month 13 / day 32 forward
 * and maps years 0..99 into 1900..1999).
 */
function canonicalTimestamp(value: unknown): string {
  if (value instanceof Date) {
    if (!Number.isFinite(value.getTime())) failOutput();
    return value.toISOString();
  }
  if (typeof value !== 'string') failOutput();
  const match = PG_TIMESTAMP.exec(value);
  if (match === null) failOutput();
  const [
    ,
    yearText,
    monthText,
    dayText,
    hourText,
    minuteText,
    secondText,
    fraction,
    sign,
    offHourText,
    offMinuteText,
  ] = match;
  const year = Number.parseInt(yearText ?? '', 10);
  const month = Number.parseInt(monthText ?? '', 10);
  const day = Number.parseInt(dayText ?? '', 10);
  const hour = Number.parseInt(hourText ?? '', 10);
  const minute = Number.parseInt(minuteText ?? '', 10);
  const second = Number.parseInt(secondText ?? '', 10);
  const offHour = Number.parseInt(offHourText ?? '0', 10);
  const offMinute = Number.parseInt(offMinuteText ?? '0', 10);
  if (
    !Number.isInteger(year) ||
    !Number.isInteger(month) ||
    !Number.isInteger(day) ||
    !Number.isInteger(hour) ||
    !Number.isInteger(minute) ||
    !Number.isInteger(second) ||
    !Number.isInteger(offHour) ||
    !Number.isInteger(offMinute) ||
    year < 1 ||
    year > 9999 ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > daysInMonth(year, month) ||
    hour > 23 ||
    minute > 59 ||
    second > 59 ||
    offHour > 23 ||
    offMinute > 59
  ) {
    failOutput();
  }
  const micros = (fraction ?? '').padEnd(6, '0').slice(0, 6);
  const offsetMinutes =
    (sign === '-' ? -1 : 1) * (offHour * 60 + offMinute);
  const local = new Date(0);
  local.setUTCFullYear(year, month - 1, day);
  local.setUTCHours(hour, minute, second, 0);
  if (
    local.getUTCFullYear() !== year ||
    local.getUTCMonth() !== month - 1 ||
    local.getUTCDate() !== day ||
    local.getUTCHours() !== hour ||
    local.getUTCMinutes() !== minute ||
    local.getUTCSeconds() !== second
  ) {
    failOutput();
  }
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

function requireString(value: unknown): string {
  if (typeof value !== 'string') fail('MARKET_STORE_UNAVAILABLE');
  return value;
}

/** A driver boolean must be an actual boolean, never a truthy coercion. */
function requireOutputBoolean(value: unknown): boolean {
  if (value !== true && value !== false) failOutput();
  return value;
}

/** A scalar definer query must yield exactly one row (or zero, when allowed). */
function requireAtMostOne<T>(rows: readonly T[]): T | undefined {
  if (rows.length > 1) failOutput();
  return rows[0];
}

function requireExactlyOne<T>(rows: readonly T[]): T {
  if (rows.length !== 1) failOutput();
  return rows[0] as T;
}

interface ListingsRow extends Record<string, unknown> {
  readonly out_listing_id: string;
  readonly out_organization_id: string;
  readonly out_provider_id: string;
  readonly out_active_version: string | null;
  readonly out_created_at: string;
  readonly out_updated_at: string;
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

/**
 * Market repository bound to a pool authenticated as openarc_tenant_app.
 */
export class MarketStore {
  readonly #pool: TenantPool;
  readonly #base: TenantStore;
  #initialized = false;

  constructor(pool: TenantPool) {
    if (pool === null || typeof pool !== 'object' || typeof pool.connect !== 'function') {
      fail('MARKET_STORE_INPUT_INVALID');
    }
    this.#pool = pool;
    this.#base = new TenantStore(pool);
  }

  /** Verify the frozen schema, restricted role and market ACLs exactly once. */
  async initialize(): Promise<void> {
    if (this.#initialized) return;
    await this.#baseChecks(() => this.#base.initialize());
    await this.#withTransaction(async (client) => {
      await this.#assertMarketReady(client);
    });
    this.#initialized = true;
  }

  /** Read-only readiness re-check; never migrates. */
  async readiness(): Promise<void> {
    await this.#baseChecks(() => this.#base.readiness());
    await this.#withTransaction(async (client) => {
      await this.#assertMarketReady(client);
    });
  }

  async #baseChecks(run: () => Promise<void>): Promise<void> {
    try {
      await run();
    } catch {
      fail('MARKET_STORE_UNAVAILABLE');
    }
  }

  async createListingDraft(
    sessionHash: unknown,
    organizationId: unknown,
    providerId: unknown,
    content: unknown,
    metadata: MarketMutationMetadata,
  ): Promise<MarketMutationResult> {
    const hash = requireSessionHash(sessionHash);
    const organization = requireOrganization(organizationId);
    const provider = requireProvider(providerId);
    const parsed = this.#parseContent(content);
    const meta = this.#parseMetadata(metadata);
    const operation: MarketOperation = 'market.listing.create';
    const sessionContextDigest = digestMarketSessionContext(operation, hash);
    const keyHash = digestMarketIdempotencyKey(operation, meta.idempotencyKey);

    return this.#withTransaction(async (client) => {
      const actor = await this.#lockActor(client, hash, organization, true);
      const requestDigest = digestMarketListingCreateRequest(
        {
          organizationId: organization,
          actorAccountId: actor.actor,
          actorRole: actor.role,
          sessionContextDigest,
          mutationId: meta.mutationId,
        },
        provider,
        parsed,
      );
      const row = await this.#commitListingCreate(client, {
        hash,
        organization,
        provider,
        content: parsed,
        mutationId: meta.mutationId,
        keyHash,
        requestDigest,
        sessionContextDigest,
      });
      return {
        replayed: requireOutputBoolean(row.out_replayed),
        receipt: this.#projectReceipt(row, operation, meta.mutationId),
      };
    });
  }

  async createListingVersion(
    sessionHash: unknown,
    organizationId: unknown,
    listingId: unknown,
    input: { expectedLatestVersion: unknown; content: unknown },
    metadata: MarketMutationMetadata,
  ): Promise<MarketMutationResult> {
    const hash = requireSessionHash(sessionHash);
    const organization = requireOrganization(organizationId);
    const listing = parseListingId(listingId);
    if (!isRecord(input)) fail('MARKET_STORE_INPUT_INVALID');
    const keys = Object.keys(input);
    if (keys.length !== 2 || !keys.includes('expectedLatestVersion') || !keys.includes('content')) {
      fail('MARKET_STORE_INPUT_INVALID');
    }
    const expected = parseListingVersion(input['expectedLatestVersion']);
    const parsed = this.#parseContent(input['content']);
    const meta = this.#parseMetadata(metadata);
    const operation: MarketOperation = 'market.listing.version.create';
    const sessionContextDigest = digestMarketSessionContext(operation, hash);
    const keyHash = digestMarketIdempotencyKey(operation, meta.idempotencyKey);

    return this.#withTransaction(async (client) => {
      const actor = await this.#lockActor(client, hash, organization, true);
      const requestDigest = digestMarketListingVersionCreateRequest(
        {
          organizationId: organization,
          actorAccountId: actor.actor,
          actorRole: actor.role,
          sessionContextDigest,
          mutationId: meta.mutationId,
        },
        listing,
        expected,
        parsed,
      );
      const row = await this.#commitVersionCreate(client, {
        hash,
        organization,
        listing,
        expected,
        content: parsed,
        mutationId: meta.mutationId,
        keyHash,
        requestDigest,
        sessionContextDigest,
      });
      return {
        replayed: requireOutputBoolean(row.out_replayed),
        receipt: this.#projectReceipt(row, operation, meta.mutationId, {
          listingId: listing,
          nextVersion: (BigInt(expected) + 1n).toString(),
        }),
      };
    });
  }

  async listOwnerListings(
    sessionHash: unknown,
    organizationId: unknown,
    options?: ListOwnerListingsInput,
  ): Promise<ListOwnerListingsResult> {
    const hash = requireSessionHash(sessionHash);
    const organization = requireOrganization(organizationId);
    const parsedOptions = requireOptions(options, ['afterListingId', 'limit']);
    const limit = requirePage(parsedOptions['limit']);
    const after =
      parsedOptions['afterListingId'] === undefined
        ? null
        : parseListingId(parsedOptions['afterListingId']);

    return this.#withTransaction(async (client) => {
      const result = await client.query<ListingsRow>(
        `SELECT out_listing_id, out_organization_id, out_provider_id,
                out_active_version, out_created_at::text AS out_created_at,
                out_updated_at::text AS out_updated_at
           FROM openarc_durable.read_owner_listings($1, $2, $3, $4)`,
        [hash, organization, after, limit + 1],
      );
      assertBoundedRows(result.rows.length, limit + 1);
      // Validate EVERY bounded row, including the one-extra lookahead, before
      // deriving the visible page: a malformed or out-of-scope row anywhere in
      // the batch is UNAVAILABLE, never silently dropped.
      const projected = result.rows.map((row) => this.#projectListing(row));
      for (const item of projected) {
        if (item.organizationId !== organization) failOutput();
      }
      assertAscendingListingIds(projected.map((item) => item.listingId));
      if (after !== null) {
        const first = projected[0]?.listingId;
        if (first !== undefined && first <= after) failOutput();
      }
      const visible = projected.slice(0, limit);
      const nextCursor =
        result.rows.length > limit ? requireString(visible[visible.length - 1]?.listingId) : null;
      return { items: visible, nextCursor };
    });
  }

  async listOwnerListingVersions(
    sessionHash: unknown,
    organizationId: unknown,
    listingId: unknown,
    options?: ListOwnerListingVersionsInput,
  ): Promise<ListOwnerListingVersionsResult> {
    const hash = requireSessionHash(sessionHash);
    const organization = requireOrganization(organizationId);
    const listing = parseListingId(listingId);
    const parsedOptions = requireOptions(options, ['afterVersion', 'limit']);
    const limit = requirePage(parsedOptions['limit']);
    const after =
      parsedOptions['afterVersion'] === undefined
        ? null
        : parseListingVersion(parsedOptions['afterVersion']);

    return this.#withTransaction(async (client) => {
      const result = await client.query<VersionRow>(
        `SELECT out_listing_id, out_organization_id, out_provider_id, out_version,
                out_kind, out_title, out_description, out_manifest, out_price,
                out_evidence_contract, out_endpoint_contract, out_origin_review_state,
                out_terms_revision, out_privacy_summary, out_payment_lane,
                out_availability, out_status, out_created_at::text AS out_created_at,
                out_updated_at::text AS out_updated_at,
                out_published_at::text AS out_published_at
           FROM openarc_durable.read_owner_listing_versions($1, $2, $3, $4, $5)`,
        [hash, organization, listing, after, limit + 1],
      );
      assertBoundedRows(result.rows.length, limit + 1);
      // Validate every bounded row including the lookahead, and bind the whole
      // batch to one org/listing/provider before deriving the visible page.
      const projected = result.rows.map((row) => this.#projectVersion(row));
      let providerId: string | undefined;
      for (const item of projected) {
        if (item.organizationId !== organization || item.listingId !== listing) failOutput();
        if (providerId === undefined) providerId = item.providerId;
        else if (item.providerId !== providerId) failOutput();
      }
      assertAscendingVersions(projected.map((item) => item.version));
      if (after !== null) {
        const first = projected[0]?.version;
        if (first !== undefined && BigInt(first) <= BigInt(after)) failOutput();
      }
      const visible = projected.slice(0, limit);
      const nextCursor =
        result.rows.length > limit ? requireString(visible[visible.length - 1]?.version) : null;
      return { items: visible, nextCursor };
    });
  }

  async getOwnerListingVersion(
    sessionHash: unknown,
    organizationId: unknown,
    listingId: unknown,
    version: unknown,
  ): Promise<CommerceListingOwnerVersion | null> {
    const hash = requireSessionHash(sessionHash);
    const organization = requireOrganization(organizationId);
    const listing = parseListingId(listingId);
    const parsedVersion = parseListingVersion(version);

    return this.#withTransaction(async (client) => {
      const result = await client.query<VersionRow>(
        `SELECT out_listing_id, out_organization_id, out_provider_id, out_version,
                out_kind, out_title, out_description, out_manifest, out_price,
                out_evidence_contract, out_endpoint_contract, out_origin_review_state,
                out_terms_revision, out_privacy_summary, out_payment_lane,
                out_availability, out_status, out_created_at::text AS out_created_at,
                out_updated_at::text AS out_updated_at,
                out_published_at::text AS out_published_at
           FROM openarc_durable.read_owner_listing_version($1, $2, $3, $4)`,
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

  async getMarketMutationStatus(
    sessionHash: unknown,
    organizationId: unknown,
    mutationId: unknown,
  ): Promise<MarketMutationStatus> {
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
           FROM openarc_durable.read_market_mutation_status($1, $2, $3::uuid)`,
        [hash, organization, mutation],
      );
      const row = requireAtMostOne(result.rows);
      if (row === undefined) return { status: 'not_found' } as const;
      const operation = parseOutputOperation(row.out_operation);
      return {
        status: 'committed' as const,
        receipt: this.#projectReceipt(row, operation, mutation),
      };
    });
  }

  #parseContent(content: unknown): MarketListingContent {
    try {
      return parseMarketListingContent(content);
    } catch {
      fail('MARKET_STORE_INPUT_INVALID');
    }
  }

  #parseMetadata(metadata: unknown): DurableMutationMetadata {
    return parseStrictMetadata(metadata);
  }

  async #lockActor(
    client: TenantClient,
    hash: string,
    organization: string,
    requireProof: boolean,
  ): Promise<{ actor: string; role: string }> {
    const result = await client.query<{
      out_actor: string;
      out_role: string;
      out_proof_created_at: string;
      out_session_expires_at: string;
    }>(
      `SELECT out_actor, out_role, out_proof_created_at, out_session_expires_at
         FROM openarc_durable.lock_market_actor($1, $2, $3, false)`,
      [hash, organization, requireProof],
    );
    const row = result.rows[0];
    if (row === undefined || typeof row.out_actor !== 'string' || typeof row.out_role !== 'string') {
      fail('MARKET_STORE_FORBIDDEN');
    }
    return { actor: row.out_actor, role: row.out_role };
  }

  async #commitListingCreate(
    client: TenantClient,
    input: {
      hash: string;
      organization: string;
      provider: string;
      content: MarketListingContent;
      mutationId: string;
      keyHash: string;
      requestDigest: string;
      sessionContextDigest: string;
    },
  ): Promise<ReceiptRow> {
    const c = input.content;
    const result = await client.query<ReceiptRow>(
      `SELECT out_replayed, out_mutation_id, out_operation, out_resource_type,
              out_resource_id, out_committed_at::text AS out_committed_at
         FROM openarc_durable.commit_listing_create(
           $1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9::jsonb, $10::jsonb,
           $11, $12, $13, $14::jsonb, $15::uuid, $16, $17, $18)`,
      [
        input.hash,
        input.organization,
        input.provider,
        c.kind,
        c.title,
        c.description,
        JSON.stringify(c.manifest),
        JSON.stringify(c.price),
        JSON.stringify(c.evidenceContract),
        JSON.stringify(c.endpointContract),
        c.termsRevision,
        c.privacySummary,
        c.paymentLane,
        JSON.stringify(c.availability),
        input.mutationId,
        input.keyHash,
        input.requestDigest,
        input.sessionContextDigest,
      ],
    );
    return this.#requireReceipt(requireExactlyOne(result.rows));
  }

  async #commitVersionCreate(
    client: TenantClient,
    input: {
      hash: string;
      organization: string;
      listing: string;
      expected: string;
      content: MarketListingContent;
      mutationId: string;
      keyHash: string;
      requestDigest: string;
      sessionContextDigest: string;
    },
  ): Promise<ReceiptRow> {
    const c = input.content;
    const result = await client.query<ReceiptRow>(
      `SELECT out_replayed, out_mutation_id, out_operation, out_resource_type,
              out_resource_id, out_committed_at::text AS out_committed_at
         FROM openarc_durable.commit_listing_version_create(
           $1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, $10::jsonb, $11::jsonb,
           $12, $13, $14, $15::jsonb, $16::uuid, $17, $18, $19)`,
      [
        input.hash,
        input.organization,
        input.listing,
        input.expected,
        c.kind,
        c.title,
        c.description,
        JSON.stringify(c.manifest),
        JSON.stringify(c.price),
        JSON.stringify(c.evidenceContract),
        JSON.stringify(c.endpointContract),
        c.termsRevision,
        c.privacySummary,
        c.paymentLane,
        JSON.stringify(c.availability),
        input.mutationId,
        input.keyHash,
        input.requestDigest,
        input.sessionContextDigest,
      ],
    );
    return this.#requireReceipt(requireExactlyOne(result.rows));
  }

  #requireReceipt(row: ReceiptRow | undefined): ReceiptRow {
    if (row === undefined) fail('MARKET_STORE_UNAVAILABLE');
    return row;
  }

  #projectReceipt(
    row: ReceiptRow,
    operation: MarketOperation,
    expectedMutationId: string,
    binding: { readonly listingId?: string; readonly nextVersion?: string } = {},
  ): MarketMutationReceipt {
    if (row.out_operation !== operation) failOutput();
    const resourceType: MarketResourceType = MARKET_RESOURCE_BY_OPERATION[operation];
    if (row.out_resource_type !== resourceType) failOutput();
    const mutationId = parseOutputMutationId(row.out_mutation_id);
    if (mutationId !== expectedMutationId) failOutput();
    const resourceId = this.#projectResourceId(
      resourceType,
      row.out_resource_id,
      mutationId,
      binding,
    );
    return {
      mutationId,
      operation,
      resourceType,
      resourceId,
      committedAt: canonicalTimestamp(row.out_committed_at),
    };
  }

  #projectResourceId(
    resourceType: MarketResourceType,
    value: unknown,
    mutationId: string,
    binding: { readonly listingId?: string; readonly nextVersion?: string },
  ): string {
    const resourceId = requireString(value);
    if (resourceType === 'listing') {
      const listing = parseOutputListingId(resourceId);
      if (listing !== `openarc:listing:${mutationId}`) failOutput();
      return listing;
    }
    // listing_version: listingId || '@' || canonicalVersion >= 2
    if (resourceId.length > 128) failOutput();
    const parts = resourceId.split('@');
    if (parts.length !== 2) failOutput();
    const listing = parseOutputListingId(parts[0]);
    const version = parseOutputListingVersion(parts[1]);
    if (BigInt(version) < 2n) failOutput();
    if (resourceId !== `${listing}@${version}`) failOutput();
    if (binding.listingId !== undefined && listing !== binding.listingId) failOutput();
    if (binding.nextVersion !== undefined && version !== binding.nextVersion) failOutput();
    return resourceId;
  }

  #projectListing(row: ListingsRow): CommerceListingOwner {
    const listingId = parseOutputListingId(row.out_listing_id);
    const activeVersion =
      row.out_active_version === null ? null : parseOutputListingVersion(row.out_active_version);
    const parsed = CommerceListingOwnerSchema.safeParse({
      schemaVersion: 'openarc.listing.v1',
      listingId,
      organizationId: requireOutputOrganization(row.out_organization_id),
      providerId: requireOutputProvider(row.out_provider_id),
      activeVersion,
      createdAt: canonicalTimestamp(row.out_created_at),
      updatedAt: canonicalTimestamp(row.out_updated_at),
    });
    if (!parsed.success) fail('MARKET_STORE_UNAVAILABLE');
    return parsed.data;
  }

  #projectVersion(row: VersionRow): CommerceListingOwnerVersion {
    const parsed = CommerceListingOwnerVersionSchema.safeParse({
      schemaVersion: 'openarc.listing-owner-version.v1',
      listingId: parseOutputListingId(row.out_listing_id),
      organizationId: requireOutputOrganization(row.out_organization_id),
      providerId: requireOutputProvider(row.out_provider_id),
      version: parseOutputListingVersion(row.out_version),
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
    if (!parsed.success) fail('MARKET_STORE_UNAVAILABLE');
    return parsed.data;
  }

  async #assertMarketReady(client: TenantClient): Promise<void> {
    const tables = await client.query<{ n: number; all_enabled: boolean; all_forced: boolean }>(
      `SELECT count(*)::int AS n,
              bool_and(c.relrowsecurity) AS all_enabled,
              bool_and(c.relforcerowsecurity) AS all_forced
         FROM pg_class c
         JOIN pg_namespace ns ON ns.oid = c.relnamespace
        WHERE ns.nspname = 'openarc_tenant'
          AND c.relkind = 'r'
          AND c.relname IN ('listings', 'listing_versions', 'listing_version_states')`,
    );
    const state = tables.rows[0];
    if (state === undefined || state.n !== 3 || state.all_enabled !== true || state.all_forced !== true) {
      fail('MARKET_STORE_UNAVAILABLE');
    }

    // The three new tables are owned by exactly the migrator and by no other
    // role, so the runtime can never drop RLS, triggers or constraints.
    const owners = await client.query<{ n: number }>(
      `SELECT count(*)::int AS n
         FROM pg_class c
         JOIN pg_namespace ns ON ns.oid = c.relnamespace
         JOIN pg_roles r ON r.oid = c.relowner
        WHERE ns.nspname = 'openarc_tenant'
          AND c.relkind = 'r'
          AND c.relname IN ('listings', 'listing_versions', 'listing_version_states')
          AND r.rolname = 'openarc_migrator'`,
    );
    if ((owners.rows[0]?.n ?? -1) !== 3) fail('MARKET_STORE_UNAVAILABLE');

    const expected: readonly { name: string; args: string }[] = [
      { name: 'commit_listing_create', args: 'session_hash text, organization_id text, provider_id text, kind text, title text, description text, manifest jsonb, price jsonb, evidence_contract jsonb, endpoint_contract jsonb, terms_revision text, privacy_summary text, payment_lane text, availability jsonb, mutation_id uuid, key_hash text, request_digest text, session_context_digest text' },
      { name: 'commit_listing_version_create', args: 'session_hash text, organization_id text, listing_id text, expected_latest_version text, kind text, title text, description text, manifest jsonb, price jsonb, evidence_contract jsonb, endpoint_contract jsonb, terms_revision text, privacy_summary text, payment_lane text, availability jsonb, mutation_id uuid, key_hash text, request_digest text, session_context_digest text' },
      { name: 'lock_market_actor', args: 'session_hash text, organization_id text, require_proof boolean, allow_recovery boolean' },
      { name: 'read_market_mutation_status', args: 'session_hash text, organization_id text, mutation_id uuid' },
      { name: 'read_owner_listing_version', args: 'session_hash text, organization_id text, listing_id text, version text' },
      { name: 'read_owner_listing_versions', args: 'session_hash text, organization_id text, listing_id text, after_version text, page_limit integer' },
      { name: 'read_owner_listings', args: 'session_hash text, organization_id text, after_listing_id text, page_limit integer' },
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
              has_function_privilege(current_user, p.oid, 'EXECUTE') AS app_exec,
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
            'commit_listing_create', 'commit_listing_version_create',
            'lock_market_actor', 'read_market_mutation_status',
            'read_owner_listing_version', 'read_owner_listing_versions',
            'read_owner_listings'
          )
        ORDER BY p.proname, p.oid`,
    );
    const byName = new Map(helpers.rows.map((row) => [row.proname, row]));
    for (const expectedHelper of expected) {
      const row = byName.get(expectedHelper.name);
      if (row === undefined) fail('MARKET_STORE_UNAVAILABLE');
      if (
        row.args !== expectedHelper.args ||
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

    // No effective direct table access for the runtime or any role reachable
    // through membership.
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
          AND c.relname IN ('listings', 'listing_versions', 'listing_version_states')
          AND c.relkind = 'r'
          AND EXISTS (
            SELECT 1 FROM reachable x
             WHERE has_table_privilege(x.oid, c.oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
          )`,
    );
    if ((access.rows[0]?.n ?? -1) !== 0) fail('MARKET_STORE_UNAVAILABLE');

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
      fail('MARKET_STORE_UNAVAILABLE');
    }
    if (applied.length !== migrations.length) fail('MARKET_STORE_UNAVAILABLE');
    for (let index = 0; index < applied.length; index += 1) {
      const record = applied[index];
      const manifest = migrations[index];
      if (record === undefined || manifest === undefined) fail('MARKET_STORE_UNAVAILABLE');
      if (record.id !== manifest.id) fail('MARKET_STORE_UNAVAILABLE');
      const checksum = createHash('sha256').update(manifest.sql, 'utf8').digest('hex');
      if (record.checksum !== checksum) fail('MARKET_STORE_UNAVAILABLE');
    }
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
    // A lost COMMIT reply means the mutation may actually have committed; the
    // transaction is never rolled back and the outcome is explicitly unknown.
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

export function asMarketPool(pool: Pool): TenantPool {
  return pool as unknown as TenantPool;
}

export type { TenantStoreErrorCode };
