import type { Pool } from 'pg';
import {
  CommerceListingIdSchema,
  CommerceListingKindSchema,
  CommerceListingPublicVersionSchema,
  CommerceMarketPublicProviderSchema,
  type CommerceListingKind,
  type CommerceListingPublicVersion,
  type CommerceMarketPublicProvider,
} from '@openarc/shared';
import {
  MarketStoreError,
  MARKET_LOCK_TIMEOUT_MS,
  MARKET_STATEMENT_TIMEOUT_MS,
  type MarketStoreErrorCode,
} from './market-store.js';
import { MarketLifecycleStore } from './market-lifecycle-store.js';
import { type TenantClient, type TenantPool } from './tenant-store.js';

/**
 * Public catalog repository. It constructs no AuthService, no auth session, no
 * credential and no external network. Public reads emit an explicit allowlist
 * only and a snapshot of eligible metadata is NOT purchase authorization.
 */

export interface ListPublicListingsInput {
  readonly afterListingId?: string;
  readonly limit?: number;
  readonly kind?: CommerceListingKind;
  readonly providerId?: string;
  readonly q?: string;
}

export interface ListPublicListingsResult {
  readonly items: CommerceListingPublicVersion[];
  readonly nextCursor: string | null;
}

const DEFAULT_PAGE = 25;
const MAX_PAGE = 50;
const PROVIDER_ID = /^openarc:provider:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
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

/** C0/C1 control characters, mirroring the accepted shared trimmed-text rule. */
function hasControlCharacters(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) return true;
  }
  return false;
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

function requireAtMostOne<T>(rows: readonly T[]): T | undefined {
  if (rows.length > 1) failOutput();
  return rows[0];
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

interface PublicListingRow extends Record<string, unknown> {
  readonly out_listing_id: string;
  readonly out_provider_id: string;
  readonly out_version: string;
  readonly out_kind: string;
  readonly out_title: string;
  readonly out_description: string;
  readonly out_manifest: unknown;
  readonly out_price: unknown;
  readonly out_evidence_contract: unknown;
  readonly out_endpoint_origin: string;
  readonly out_terms_revision: string;
  readonly out_privacy_summary: string;
  readonly out_payment_lane: string;
  readonly out_availability: unknown;
  readonly out_status: string;
  readonly out_published_at: string;
}

interface PublicProviderRow extends Record<string, unknown> {
  readonly out_provider_id: string;
  readonly out_display_name: string;
  readonly out_status: string;
}

export class MarketCatalogStore {
  readonly #pool: TenantPool;
  readonly #base: MarketLifecycleStore;
  #initialized = false;

  constructor(pool: TenantPool) {
    if (pool === null || typeof pool !== 'object' || typeof pool.connect !== 'function') {
      fail('MARKET_STORE_INPUT_INVALID');
    }
    this.#pool = pool;
    // The lifecycle store composes the accepted MarketStore baseline and adds
    // the schema7 table RLS/owner/ACL and lifecycle helper posture checks. It
    // constructs no AuthService, auth session, credential or network, so a
    // catalog-only deployment validates the full baseline without auth.
    this.#base = new MarketLifecycleStore(pool);
  }

  async initialize(): Promise<void> {
    if (this.#initialized) return;
    await this.#baseChecks(() => this.#base.initialize());
    await this.#withTransaction(async (client) => {
      await this.#assertCatalogReady(client);
    });
    this.#initialized = true;
  }

  async readiness(): Promise<void> {
    await this.#baseChecks(() => this.#base.readiness());
    await this.#withTransaction(async (client) => {
      await this.#assertCatalogReady(client);
    });
  }

  async #baseChecks(run: () => Promise<void>): Promise<void> {
    try {
      await run();
    } catch {
      fail('MARKET_STORE_UNAVAILABLE');
    }
  }

  async listPublicListings(input?: ListPublicListingsInput): Promise<ListPublicListingsResult> {
    if (input === undefined) input = {};
    if (!isRecord(input)) fail('MARKET_STORE_INPUT_INVALID');
    const allowed = ['afterListingId', 'limit', 'kind', 'providerId', 'q'];
    // A closed input object: unknown keys and explicitly-present `undefined`
    // values are rejected before any pool checkout.
    for (const key of Object.keys(input)) {
      if (!allowed.includes(key) || input[key] === undefined) fail('MARKET_STORE_INPUT_INVALID');
    }
    const limit = this.#requireLimit(input.limit);
    const after = input.afterListingId === undefined ? null : this.#requireListingId(input.afterListingId);
    const kind = input.kind === undefined ? null : this.#requireKind(input.kind);
    const provider = input.providerId === undefined ? null : this.#requireProviderId(input.providerId);
    const q = input.q === undefined ? null : this.#requireQuery(input.q);
    return this.#withTransaction(async (client) => {
      const result = await client.query<PublicListingRow>(
        `SELECT out_listing_id, out_provider_id, out_version, out_kind, out_title,
                out_description, out_manifest, out_price, out_evidence_contract,
                out_endpoint_origin, out_terms_revision, out_privacy_summary,
                out_payment_lane, out_availability, out_status,
                out_published_at::text AS out_published_at
           FROM openarc_durable.list_public_listings($1, $2, $3, $4, $5)`,
        [after, limit + 1, kind, provider, q],
      );
      if (result.rows.length > limit + 1) failOutput();
      const projected = result.rows.map((row) => this.#projectListing(row));
      let previous: string | undefined;
      for (const item of projected) {
        if (previous !== undefined && item.listingId <= previous) failOutput();
        previous = item.listingId;
        if (provider !== null && item.providerId !== provider) failOutput();
        if (kind !== null && item.kind !== kind) failOutput();
      }
      if (after !== null) {
        const first = projected[0]?.listingId;
        if (first !== undefined && first <= after) failOutput();
      }
      const visible = projected.slice(0, limit);
      const nextCursor = result.rows.length > limit ? visible[visible.length - 1]?.listingId ?? null : null;
      return { items: visible, nextCursor };
    });
  }

  async getPublicListing(listingId: unknown): Promise<CommerceListingPublicVersion | null> {
    const listing = this.#requireListingId(listingId);
    return this.#withTransaction(async (client) => {
      const result = await client.query<PublicListingRow>(
        `SELECT out_listing_id, out_provider_id, out_version, out_kind, out_title,
                out_description, out_manifest, out_price, out_evidence_contract,
                out_endpoint_origin, out_terms_revision, out_privacy_summary,
                out_payment_lane, out_availability, out_status,
                out_published_at::text AS out_published_at
           FROM openarc_durable.get_public_listing($1)`,
        [listing],
      );
      const row = requireAtMostOne(result.rows);
      if (row === undefined) return null;
      const item = this.#projectListing(row);
      if (item.listingId !== listing) failOutput();
      return item;
    });
  }

  async getPublicProvider(providerId: unknown): Promise<CommerceMarketPublicProvider | null> {
    const provider = this.#requireProviderId(providerId);
    return this.#withTransaction(async (client) => {
      const result = await client.query<PublicProviderRow>(
        `SELECT out_provider_id, out_display_name, out_status
           FROM openarc_durable.get_public_provider($1)`,
        [provider],
      );
      const row = requireAtMostOne(result.rows);
      if (row === undefined) return null;
      const parsed = CommerceMarketPublicProviderSchema.safeParse({
        schemaVersion: 'openarc.provider-public.v1',
        providerId: row.out_provider_id,
        displayName: row.out_display_name,
        status: row.out_status,
      });
      if (!parsed.success) failOutput();
      if (parsed.data.providerId !== provider) failOutput();
      return parsed.data;
    });
  }

  #requireListingId(value: unknown): string {
    if (typeof value !== 'string') fail('MARKET_STORE_INPUT_INVALID');
    const parsed = CommerceListingIdSchema.safeParse(value);
    if (!parsed.success) fail('MARKET_STORE_INPUT_INVALID');
    return parsed.data;
  }

  #requireProviderId(value: unknown): string {
    if (typeof value !== 'string' || !PROVIDER_ID.test(value)) fail('MARKET_STORE_INPUT_INVALID');
    return value;
  }

  #requireKind(value: unknown): CommerceListingKind {
    const parsed = CommerceListingKindSchema.safeParse(value);
    if (!parsed.success) fail('MARKET_STORE_INPUT_INVALID');
    return parsed.data;
  }

  #requireQuery(value: unknown): string {
    if (
      typeof value !== 'string' ||
      value.length < 1 ||
      value.length > 80 ||
      value !== value.trim() ||
      hasControlCharacters(value)
    ) {
      fail('MARKET_STORE_INPUT_INVALID');
    }
    return value;
  }

  #requireLimit(value: unknown): number {
    if (value === undefined) return DEFAULT_PAGE;
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > MAX_PAGE) {
      fail('MARKET_STORE_INPUT_INVALID');
    }
    return value;
  }

  #projectListing(row: PublicListingRow): CommerceListingPublicVersion {
    const parsed = CommerceListingPublicVersionSchema.safeParse({
      schemaVersion: 'openarc.listing-public-version.v1',
      listingId: row.out_listing_id,
      providerId: row.out_provider_id,
      version: row.out_version,
      kind: row.out_kind,
      title: row.out_title,
      description: row.out_description,
      manifest: row.out_manifest,
      price: row.out_price,
      evidenceContract: row.out_evidence_contract,
      endpointOrigin: row.out_endpoint_origin,
      termsRevision: row.out_terms_revision,
      privacySummary: row.out_privacy_summary,
      paymentLane: row.out_payment_lane,
      availability: row.out_availability,
      status: row.out_status,
      publishedAt: canonicalTimestamp(row.out_published_at),
    });
    if (!parsed.success) failOutput();
    return parsed.data;
  }

  async #assertCatalogReady(client: TenantClient): Promise<void> {
    // Exact signature/owner/SECDEF/search_path/EXECUTE ACL for the three public
    // catalog helpers. The composed MarketLifecycleStore base already verified
    // the full schema7 manifest checksums, the accepted schema6 RLS/helper/role
    // posture, the new schema7 tables' FORCE RLS/owner/runtime ACL and the
    // lifecycle helper posture, plus the runtime's lack of direct table access.
    const expected: readonly { name: string; args: string }[] = [
      { name: 'list_public_listings', args: 'after_listing_id text, page_limit integer, filter_kind text, filter_provider_id text, search_q text' },
      { name: 'get_public_listing', args: 'listing_id text' },
      { name: 'get_public_provider', args: 'provider_id text' },
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
          AND p.proname IN ('list_public_listings', 'get_public_listing', 'get_public_provider')
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

export function asCatalogPool(pool: Pool): TenantPool {
  return pool as unknown as TenantPool;
}
