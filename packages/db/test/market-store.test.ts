import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  MARKET_LISTING_CONTENT_KEYS,
  MarketInputError,
  MarketStore,
  MarketStoreError,
  digestMarketIdempotencyKey,
  digestMarketListingCreateRequest,
  digestMarketListingVersionCreateRequest,
  digestMarketSessionContext,
  parseMarketListingContent,
  requireIdempotencyKey,
  requireMutationId,
  type MarketListingContent,
  type MarketMutationResult,
  type TenantClient,
  type TenantPool,
  type TenantQueryResult,
} from '../src/index.js';

/**
 * Unit coverage for the market draft/version store over a narrow scripted port.
 * Authorization is never mocked: the fake port only returns what the accepted
 * SQL definer helpers would return.
 */

type Row = Record<string, unknown>;

interface Route {
  readonly when: (text: string) => boolean;
  readonly rows?: Row[];
  readonly throws?: { readonly code?: string };
}

class FakeClient implements TenantClient {
  readonly calls: { text: string; values: unknown[] }[] = [];
  readonly releases: boolean[] = [];
  releaseThrows = false;
  constructor(private readonly routes: Route[]) {}
  async query<T extends Record<string, unknown>>(
    text: string,
    values: unknown[] = [],
  ): Promise<TenantQueryResult<T>> {
    this.calls.push({ text, values });
    const route = this.routes.find((candidate) => candidate.when(text));
    if (route?.throws !== undefined) {
      const error = new Error('scripted failure');
      if (route.throws.code !== undefined) (error as { code?: string }).code = route.throws.code;
      throw error;
    }
    const rows = (route?.rows ?? []) as T[];
    return { rows, rowCount: route?.rows === undefined ? null : rows.length };
  }
  release(destroy?: boolean): void {
    this.releases.push(destroy === true);
    if (this.releaseThrows) throw new Error('release failed');
  }
}

class FakePool implements TenantPool {
  connectCalls = 0;
  readonly clients: FakeClient[] = [];
  constructor(
    private readonly make: () => FakeClient,
    private readonly configure?: (client: FakeClient) => void,
  ) {}
  async connect(): Promise<TenantClient> {
    this.connectCalls += 1;
    const client = this.make();
    this.configure?.(client);
    this.clients.push(client);
    return client;
  }
}

const HASH = 'a'.repeat(64);
const ORG = 'openarc:org:00000000-0000-4000-8000-000000000001';
const PROVIDER = 'openarc:provider:00000000-0000-4000-8000-000000000002';
const LISTING = 'openarc:listing:00000000-0000-4000-8000-000000000003';
const MUTATION = '00000000-0000-4000-8000-000000000004';
const DRAFT_LISTING = `openarc:listing:${MUTATION}`;
const KEY = 'A'.repeat(42) + 'A';

function baseContent(): MarketListingContent {
  return {
    kind: 'api',
    title: 'Example API',
    description: 'A bounded description',
    manifest: {
      schemaVersion: 'openarc.listing-manifest.v1',
      inputSchemaDigest: `sha256:${'1'.repeat(64)}`,
      outputSchemaDigest: `sha256:${'2'.repeat(64)}`,
    },
    price: {
      amount: {
        schemaVersion: 'openarc.usdc-amount.v1',
        networkId: 'eip155:5042002',
        asset: 'USDC',
        atomicAmount: '1000000',
        representation: 'erc20',
        decimals: 6,
      },
      pricingModel: 'fixed',
    },
    evidenceContract: {
      schemaVersion: 'openarc.receipt-contract.v1',
      receiptType: 'receipt.v1',
      receiptSchemaDigest: `sha256:${'3'.repeat(64)}`,
      deliveryFields: ['payload', 'status'],
    },
    endpointContract: { origin: 'https://api.example.com', path: '/v1/run' },
    termsRevision: 'terms-v1',
    privacySummary: 'We store nothing.',
    paymentLane: 'unavailable',
    availability: { status: 'available', rateLimitPerMinute: '60' },
  } as unknown as MarketListingContent;
}

function receiptRow(operation: string, resourceType: string, resourceId: string): Row {
  return {
    out_replayed: false,
    out_mutation_id: MUTATION,
    out_operation: operation,
    out_resource_type: resourceType,
    out_resource_id: resourceId,
    out_committed_at: '2026-09-12 10:00:00.123456+00',
  };
}

function validListingRow(overrides: Row = {}): Row {
  return {
    out_listing_id: LISTING,
    out_organization_id: ORG,
    out_provider_id: PROVIDER,
    out_active_version: null,
    out_created_at: '2026-09-12 10:00:00.000001+00',
    out_updated_at: '2026-09-12 10:00:00.000002+00',
    ...overrides,
  };
}

function validVersionRow(overrides: Row = {}): Row {
  const content = baseContent();
  return {
    out_listing_id: LISTING,
    out_organization_id: ORG,
    out_provider_id: PROVIDER,
    out_version: '2',
    out_kind: 'api',
    out_title: 'Example API',
    out_description: 'A bounded description',
    out_manifest: content.manifest,
    out_price: content.price,
    out_evidence_contract: content.evidenceContract,
    out_endpoint_contract: content.endpointContract,
    out_origin_review_state: 'unreviewed',
    out_terms_revision: 'terms-v1',
    out_privacy_summary: 'We store nothing.',
    out_payment_lane: 'unavailable',
    out_availability: content.availability,
    out_status: 'draft',
    out_created_at: '2026-09-12 10:00:00.000001+00',
    out_updated_at: '2026-09-12 10:00:00.000002+00',
    out_published_at: null,
    ...overrides,
  };
}

function actorRow(): Row {
  return {
    out_actor: 'openarc:account:x',
    out_role: 'owner',
    out_proof_created_at: 'x',
    out_session_expires_at: 'x',
  };
}

async function expectCode(promise: Promise<unknown>, code: string): Promise<void> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(MarketStoreError);
    expect((error as MarketStoreError).code).toBe(code);
    return;
  }
  throw new Error(`expected MarketStoreError ${code}`);
}

describe('market content parsing', () => {
  it('accepts the exact twelve fields and rejects extra/missing keys', () => {
    const content = baseContent();
    expect(parseMarketListingContent(content)).toEqual(content);
    expect(() => parseMarketListingContent({ ...content, extra: 1 })).toThrow(MarketInputError);
    const missing: Record<string, unknown> = { ...content };
    delete missing['title'];
    expect(() => parseMarketListingContent(missing)).toThrow(MarketInputError);
    expect(MARKET_LISTING_CONTENT_KEYS).toHaveLength(11);
  });

  it('rejects a zero price, bad manifest digest and unknown payment lane', () => {
    const zero = baseContent();
    const zeroPrice = {
      ...zero,
      price: { amount: { ...zero.price.amount, atomicAmount: '0' }, pricingModel: 'fixed' },
    };
    expect(() => parseMarketListingContent(zeroPrice)).toThrow(MarketInputError);
    const badDigest = {
      ...zero,
      manifest: { ...zero.manifest, inputSchemaDigest: 'sha256:xyz' },
    };
    expect(() => parseMarketListingContent(badDigest)).toThrow(MarketInputError);
    const lane = { ...zero, paymentLane: 'charge' };
    expect(() => parseMarketListingContent(lane)).toThrow(MarketInputError);
  });

  it('rejects caller-supplied identity/status fields', () => {
    const content = baseContent() as unknown as Record<string, unknown>;
    for (const key of ['listingId', 'organizationId', 'status', 'originReviewState', 'publishedAt']) {
      expect(() => parseMarketListingContent({ ...content, [key]: 'x' })).toThrow(MarketInputError);
    }
  });
});

describe('market digest vectors', () => {
  const context = {
    organizationId: ORG,
    actorAccountId: 'openarc:account:00000000-0000-4000-8000-000000000005',
    actorRole: 'owner',
    sessionContextDigest: 'b'.repeat(64),
    mutationId: MUTATION,
  };

  it('is stable, order-invariant across key insertion and semantic-sensitive', () => {
    const content = baseContent();
    const reordered = {
      availability: content.availability,
      paymentLane: content.paymentLane,
      privacySummary: content.privacySummary,
      termsRevision: content.termsRevision,
      endpointContract: content.endpointContract,
      evidenceContract: content.evidenceContract,
      price: content.price,
      manifest: content.manifest,
      description: content.description,
      title: content.title,
      kind: content.kind,
    } as unknown as MarketListingContent;
    const first = digestMarketListingCreateRequest(context, PROVIDER, content);
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(digestMarketListingCreateRequest(context, PROVIDER, reordered)).toBe(first);

    const changedTitle = { ...content, title: 'Example API v2' } as MarketListingContent;
    expect(digestMarketListingCreateRequest(context, PROVIDER, changedTitle)).not.toBe(first);
    const reorderedDelivery = {
      ...content,
      evidenceContract: { ...content.evidenceContract, deliveryFields: ['status', 'payload'] },
    } as MarketListingContent;
    expect(digestMarketListingCreateRequest(context, PROVIDER, reorderedDelivery)).not.toBe(first);
    expect(digestMarketListingCreateRequest(context, `${PROVIDER}x`, content)).not.toBe(first);
  });

  it('uses a distinct domain for the version operation', () => {
    const content = baseContent();
    const create = digestMarketListingCreateRequest(context, PROVIDER, content);
    const version = digestMarketListingVersionCreateRequest(context, LISTING, '1', content);
    expect(version).not.toBe(create);
    expect(digestMarketListingVersionCreateRequest(context, LISTING, '2', content)).not.toBe(version);
    expect(create).toBe(
      createHash('sha256')
        .update(
          JSON.stringify([
            'market.listing.create.v1',
            'eip155:5042002',
            context.organizationId,
            context.actorAccountId,
            context.actorRole,
            context.sessionContextDigest,
            context.mutationId,
            PROVIDER,
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
          ]),
          'utf8',
        )
        .digest('hex'),
    );
  });

  it('binds the session context and idempotency key by domain', () => {
    expect(digestMarketSessionContext('market.listing.create', HASH)).toMatch(/^[0-9a-f]{64}$/);
    expect(digestMarketSessionContext('market.listing.create', HASH)).not.toBe(
      digestMarketSessionContext('market.listing.version.create', HASH),
    );
    expect(() => requireMutationId('not-a-uuid')).toThrow(MarketInputError);
    expect(requireMutationId(MUTATION)).toBe(MUTATION);
    expect(requireIdempotencyKey(KEY)).toBe(KEY);
    expect(() => requireIdempotencyKey('short')).toThrow(MarketInputError);
    expect(digestMarketIdempotencyKey('market.listing.create', KEY)).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('market store mutations over a scripted port', () => {
  it('commits a draft and projects a canonical receipt and microsecond timestamp', async () => {
    const content = baseContent();
    const operation = 'market.listing.create';
    const pool = new FakePool(
      () =>
        new FakeClient([
          { when: (t) => t.includes('lock_market_actor'), rows: [{ out_actor: 'openarc:account:x', out_role: 'owner', out_proof_created_at: 'x', out_session_expires_at: 'x' }] },
          { when: (t) => t.includes('commit_listing_create'), rows: [receiptRow(operation, 'listing', DRAFT_LISTING)] },
        ]),
    );
    const store = new MarketStore(pool);
    const result = await store.createListingDraft(HASH, ORG, PROVIDER, content, {
      idempotencyKey: KEY,
      mutationId: MUTATION,
    });
    expect(result.receipt).toEqual({
      mutationId: MUTATION,
      operation,
      resourceType: 'listing',
      resourceId: DRAFT_LISTING,
      committedAt: '2026-09-12T10:00:00.123456Z',
    });
    const call = pool.clients[0]?.calls.find((entry) => entry.text.includes('commit_listing_create'));
    expect(call?.values[6]).toBe(JSON.stringify(content.manifest));
  });

  it('projects a version receipt with listingId@version and rejects a mismatch', async () => {
    const operation = 'market.listing.version.create';
    const resourceId = `${LISTING}@2`;
    const pool = new FakePool(
      () =>
        new FakeClient([
          { when: (t) => t.includes('lock_market_actor'), rows: [{ out_actor: 'a', out_role: 'provider_admin', out_proof_created_at: 'x', out_session_expires_at: 'x' }] },
          { when: (t) => t.includes('commit_listing_version_create'), rows: [receiptRow(operation, 'listing_version', resourceId)] },
        ]),
    );
    const store = new MarketStore(pool);
    const result = await store.createListingVersion(
      HASH,
      ORG,
      LISTING,
      { expectedLatestVersion: '1', content: baseContent() },
      { idempotencyKey: KEY, mutationId: MUTATION },
    );
    expect(result.receipt.resourceId).toBe(resourceId);
    expect(result.receipt.operation).toBe(operation);
  });

  it('rejects unknown metadata keys and malformed listing ids before any checkout', async () => {
    const pool = new FakePool(() => new FakeClient([]));
    const store = new MarketStore(pool);
    await expectCode(
      store.createListingDraft(HASH, ORG, PROVIDER, baseContent(), {
        idempotencyKey: KEY,
        mutationId: MUTATION,
        extra: true,
      } as unknown as { idempotencyKey: string; mutationId: string }),
      'MARKET_STORE_INPUT_INVALID',
    );
    await expectCode(
      store.getOwnerListingVersion(HASH, ORG, 'openarc:listing:not-uuid', '1'),
      'MARKET_STORE_INPUT_INVALID',
    );
    expect(pool.connectCalls).toBe(0);
  });

  it('maps a conflict code and rolls back, then releases without destroying', async () => {
    const pool = new FakePool(
      () =>
        new FakeClient([
          { when: (t) => t.includes('lock_market_actor'), rows: [{ out_actor: 'a', out_role: 'owner', out_proof_created_at: 'x', out_session_expires_at: 'x' }] },
          { when: (t) => t.includes('commit_listing_create'), throws: { code: 'P0D01' } },
        ]),
    );
    const store = new MarketStore(pool);
    await expectCode(
      store.createListingDraft(HASH, ORG, PROVIDER, baseContent(), {
        idempotencyKey: KEY,
        mutationId: MUTATION,
      }),
      'MARKET_STORE_IDEMPOTENCY_CONFLICT',
    );
    const calls = pool.clients[0]?.calls.map((entry) => entry.text) ?? [];
    expect(calls).toContain('ROLLBACK');
    expect(pool.clients[0]?.releases).toEqual([false]);
  });

  it('reports OUTCOME_UNKNOWN when the COMMIT reply is lost and never rolls back', async () => {
    const pool = new FakePool(
      () =>
        new FakeClient([
          { when: (t) => t.includes('lock_market_actor'), rows: [{ out_actor: 'a', out_role: 'owner', out_proof_created_at: 'x', out_session_expires_at: 'x' }] },
          { when: (t) => t.includes('commit_listing_create'), rows: [receiptRow('market.listing.create', 'listing', DRAFT_LISTING)] },
          { when: (t) => t === 'COMMIT', throws: { code: '08006' } },
        ]),
    );
    const store = new MarketStore(pool);
    await expectCode(
      store.createListingDraft(HASH, ORG, PROVIDER, baseContent(), {
        idempotencyKey: KEY,
        mutationId: MUTATION,
      }),
      'MARKET_STORE_OUTCOME_UNKNOWN',
    );
    const calls = pool.clients[0]?.calls.map((entry) => entry.text) ?? [];
    expect(calls).not.toContain('ROLLBACK');
  });

  it('projects owner listings/versions and paginates with one extra row', async () => {
    const listingRow = (id: string): Row => ({
      out_listing_id: id,
      out_organization_id: ORG,
      out_provider_id: PROVIDER,
      out_active_version: '1',
      out_created_at: '2026-09-12 10:00:00.000001+00',
      out_updated_at: '2026-09-12 10:00:00.000002+00',
    });
    const versionRow = (version: string): Row => ({
      out_listing_id: LISTING,
      out_organization_id: ORG,
      out_provider_id: PROVIDER,
      out_version: version,
      out_kind: 'api',
      out_title: 'Example API',
      out_description: 'A bounded description',
      out_manifest: baseContent().manifest,
      out_price: baseContent().price,
      out_evidence_contract: baseContent().evidenceContract,
      out_endpoint_contract: baseContent().endpointContract,
      out_origin_review_state: 'unreviewed',
      out_terms_revision: 'terms-v1',
      out_privacy_summary: 'We store nothing.',
      out_payment_lane: 'unavailable',
      out_availability: baseContent().availability,
      out_status: 'draft',
      out_created_at: '2026-09-12 10:00:00.000001+00',
      out_updated_at: '2026-09-12 10:00:00.000002+00',
      out_published_at: null,
    });
    const secondListing = 'openarc:listing:00000000-0000-4000-8000-000000000099';
    const pool = new FakePool(
      () =>
        new FakeClient([
          { when: (t) => t.includes('read_owner_listings'), rows: [listingRow(LISTING), listingRow(secondListing)] },
          { when: (t) => t.includes('read_owner_listing_versions'), rows: [versionRow('1'), versionRow('2')] },
        ]),
    );
    const store = new MarketStore(pool);
    const listings = await store.listOwnerListings(HASH, ORG, { limit: 1 });
    expect(listings.items).toHaveLength(1);
    expect(listings.nextCursor).toBe(LISTING);
    expect(listings.items[0]).toMatchObject({
      schemaVersion: 'openarc.listing.v1',
      activeVersion: '1',
      createdAt: '2026-09-12T10:00:00.000001Z',
    });
    const versions = await store.listOwnerListingVersions(HASH, ORG, LISTING, { limit: 1 });
    expect(versions.items).toHaveLength(1);
    expect(versions.nextCursor).toBe('1');
    expect(versions.items[0]?.version).toBe('1');
  });

  it('returns null absence and maps invalid driver rows to UNAVAILABLE', async () => {
    const empty = new FakePool(
      () =>
        new FakeClient([
          { when: (t) => t.includes('read_owner_listing_version'), rows: [] },
        ]),
    );
    const store = new MarketStore(empty);
    expect(await store.getOwnerListingVersion(HASH, ORG, LISTING, '1')).toBeNull();

    const invalid = new FakePool(
      () =>
        new FakeClient([
          { when: (t) => t.includes('read_market_mutation_status'), rows: [{ out_mutation_id: MUTATION, out_operation: 'market.listing.create', out_resource_type: 'agent', out_resource_id: LISTING, out_committed_at: 'x' }] },
        ]),
    );
    await expectCode(
      new MarketStore(invalid).getMarketMutationStatus(HASH, ORG, MUTATION),
      'MARKET_STORE_UNAVAILABLE',
    );
  });

  it('serializes options strictly and defaults to 25/max 50', async () => {
    const pool = new FakePool(
      () => new FakeClient([{ when: (t) => t.includes('read_owner_listings'), rows: [] }]),
    );
    const store = new MarketStore(pool);
    const result: Awaited<ReturnType<MarketStore['listOwnerListings']>> = await store.listOwnerListings(HASH, ORG);
    expect(result).toEqual({ items: [], nextCursor: null });
    await expectCode(store.listOwnerListings(HASH, ORG, { limit: 51 }), 'MARKET_STORE_INPUT_INVALID');
    await expectCode(
      store.listOwnerListings(HASH, ORG, { afterListingId: LISTING, nope: 1 } as unknown as { afterListingId: string }),
      'MARKET_STORE_INPUT_INVALID',
    );
  });
});

describe('market store readiness and transaction cleanup', () => {
  it('fails initialize closed on a missing market schema', async () => {
    const pool = new FakePool(
      () =>
        new FakeClient([
          { when: (t) => t.includes('pg_roles') || t.includes('pg_namespace'), rows: [{ role: 'openarc_tenant_app', rolsuper: false, rolbypassrls: false, rolcreatedb: false, rolcreaterole: false, elevated_memberships: 0, migrator_member: false, auth_member: false }] },
          { when: (t) => t.includes("c.relname IN ('listings'"), rows: [{ n: 0, all_enabled: null, all_forced: null }] },
        ]),
    );
    await expectCode(new MarketStore(pool).initialize(), 'MARKET_STORE_UNAVAILABLE');
  });

  it('destroys the connection when BEGIN fails', async () => {
    const pool = new FakePool(
      () => new FakeClient([{ when: (t) => t === 'BEGIN', throws: { code: '08000' } }]),
    );
    await expectCode(
      new MarketStore(pool).getMarketMutationStatus(HASH, ORG, MUTATION),
      'MARKET_STORE_UNAVAILABLE',
    );
    expect(pool.clients[0]?.releases).toEqual([true]);
  });
});

describe('market result typing', () => {
  it('exposes the closed MarketMutationResult shape', () => {
    const value: MarketMutationResult = {
      replayed: false,
      receipt: {
        mutationId: MUTATION,
        operation: 'market.listing.create',
        resourceType: 'listing',
        resourceId: LISTING,
        committedAt: '2026-09-12T10:00:00.000000Z',
      },
    };
    expect(value.receipt.resourceType).toBe('listing');
  });
});

describe('strict returned-row binding and transaction boundaries', () => {
  it('rejects an unknown receipt operation and a mismatched mutation binding', async () => {
    const unknown = new FakePool(
      () =>
        new FakeClient([
          {
            when: (t) => t.includes('read_market_mutation_status'),
            rows: [
              {
                out_mutation_id: MUTATION,
                out_operation: 'market.listing.unknown',
                out_resource_type: 'listing',
                out_resource_id: DRAFT_LISTING,
                out_committed_at: '2026-09-12 10:00:00.000001+00',
              },
            ],
          },
        ]),
    );
    await expectCode(
      new MarketStore(unknown).getMarketMutationStatus(HASH, ORG, MUTATION),
      'MARKET_STORE_UNAVAILABLE',
    );

    const wrongMutation = new FakePool(
      () =>
        new FakeClient([
          {
            when: (t) => t.includes('read_market_mutation_status'),
            rows: [
              {
                out_mutation_id: '00000000-0000-4000-8000-0000000000ff',
                out_operation: 'market.listing.create',
                out_resource_type: 'listing',
                out_resource_id: `openarc:listing:00000000-0000-4000-8000-0000000000ff`,
                out_committed_at: '2026-09-12 10:00:00.000001+00',
              },
            ],
          },
        ]),
    );
    await expectCode(
      new MarketStore(wrongMutation).getMarketMutationStatus(HASH, ORG, MUTATION),
      'MARKET_STORE_UNAVAILABLE',
    );
  });

  it('rejects a creation receipt whose draft id or target does not bind the request', async () => {
    const wrongDraft = new FakePool(
      () =>
        new FakeClient([
          { when: (t) => t.includes('lock_market_actor'), rows: [actorRow()] },
          {
            when: (t) => t.includes('commit_listing_create'),
            rows: [receiptRow('market.listing.create', 'listing', LISTING)],
          },
        ]),
    );
    await expectCode(
      new MarketStore(wrongDraft).createListingDraft(HASH, ORG, PROVIDER, baseContent(), {
        idempotencyKey: KEY,
        mutationId: MUTATION,
      }),
      'MARKET_STORE_UNAVAILABLE',
    );

    const wrongNext = new FakePool(
      () =>
        new FakeClient([
          { when: (t) => t.includes('lock_market_actor'), rows: [actorRow()] },
          {
            when: (t) => t.includes('commit_listing_version_create'),
            rows: [receiptRow('market.listing.version.create', 'listing_version', `${LISTING}@3`)],
          },
        ]),
    );
    await expectCode(
      new MarketStore(wrongNext).createListingVersion(
        HASH,
        ORG,
        LISTING,
        { expectedLatestVersion: '1', content: baseContent() },
        { idempotencyKey: KEY, mutationId: MUTATION },
      ),
      'MARKET_STORE_UNAVAILABLE',
    );
  });

  it('maps malformed output ids/versions/orgs/providers to UNAVAILABLE, never INPUT_INVALID', async () => {
    const cases: readonly { rows: Row[]; call: (store: MarketStore) => Promise<unknown> }[] = [
      {
        rows: [validListingRow({ out_listing_id: 'not-a-listing' })],
        call: (store) => store.listOwnerListings(HASH, ORG),
      },
      {
        rows: [validListingRow({ out_active_version: '0' })],
        call: (store) => store.listOwnerListings(HASH, ORG),
      },
      {
        rows: [validListingRow({ out_organization_id: 'openarc:org:nope' })],
        call: (store) => store.listOwnerListings(HASH, ORG),
      },
      {
        rows: [validVersionRow({ out_version: '01' })],
        call: (store) => store.getOwnerListingVersion(HASH, ORG, LISTING, '2'),
      },
      {
        rows: [validVersionRow({ out_provider_id: 'openarc:provider:nope' })],
        call: (store) => store.listOwnerListingVersions(HASH, ORG, LISTING),
      },
    ];
    for (const entry of cases) {
      const pool = new FakePool(
        () =>
          new FakeClient([
            {
              when: (t) =>
                t.includes('read_owner_listing') || t.includes('read_owner_listings'),
              rows: entry.rows,
            },
          ]),
      );
      await expectCode(entry.call(new MarketStore(pool)), 'MARKET_STORE_UNAVAILABLE');
    }
  });

  it('rejects an absent nullable publication field and invalid calendar timestamps', async () => {
    const missingPublished = new FakePool(
      () =>
        new FakeClient([
          {
            when: (t) => t.includes('read_owner_listing_version'),
            rows: [validVersionRow({ out_published_at: undefined })],
          },
        ]),
    );
    await expectCode(
      new MarketStore(missingPublished).getOwnerListingVersion(HASH, ORG, LISTING, '2'),
      'MARKET_STORE_UNAVAILABLE',
    );

    const invalidCalendar = new FakePool(
      () =>
        new FakeClient([
          {
            when: (t) => t.includes('read_owner_listings'),
            rows: [validListingRow({ out_created_at: '2026-13-45 10:00:00.000001+00' })],
          },
        ]),
    );
    await expectCode(new MarketStore(invalidCalendar).listOwnerListings(HASH, ORG), 'MARKET_STORE_UNAVAILABLE');

    const normalizedCalendar = new FakePool(
      () =>
        new FakeClient([
          {
            when: (t) => t.includes('read_owner_listings'),
            rows: [validListingRow({ out_created_at: '2026-02-30 10:00:00.000001+00' })],
          },
        ]),
    );
    await expectCode(
      new MarketStore(normalizedCalendar).listOwnerListings(HASH, ORG),
      'MARKET_STORE_UNAVAILABLE',
    );
  });

  it('rejects non-ascending, duplicate-provider and over-long history pages', async () => {
    const nonAscending = new FakePool(
      () =>
        new FakeClient([
          { when: (t) => t.includes('read_owner_listing_versions'), rows: [validVersionRow({ out_version: '2' }), validVersionRow({ out_version: '1' })] },
        ]),
    );
    await expectCode(
      new MarketStore(nonAscending).listOwnerListingVersions(HASH, ORG, LISTING),
      'MARKET_STORE_UNAVAILABLE',
    );

    const crossProvider = new FakePool(
      () =>
        new FakeClient([
          {
            when: (t) => t.includes('read_owner_listing_versions'),
            rows: [validVersionRow({ out_version: '2' }), validVersionRow({ out_version: '3', out_provider_id: 'openarc:provider:00000000-0000-4000-8000-0000000000aa' })],
          },
        ]),
    );
    await expectCode(
      new MarketStore(crossProvider).listOwnerListingVersions(HASH, ORG, LISTING),
      'MARKET_STORE_UNAVAILABLE',
    );

    const overLong = new FakePool(
      () =>
        new FakeClient([
          {
            when: (t) => t.includes('read_owner_listings'),
            rows: [
              validListingRow({ out_listing_id: 'openarc:listing:00000000-0000-4000-8000-000000000001' }),
              validListingRow({ out_listing_id: 'openarc:listing:00000000-0000-4000-8000-000000000002' }),
              validListingRow({ out_listing_id: 'openarc:listing:00000000-0000-4000-8000-000000000003' }),
            ],
          },
        ]),
    );
    await expectCode(
      new MarketStore(overLong).listOwnerListings(HASH, ORG, { limit: 1 }),
      'MARKET_STORE_UNAVAILABLE',
    );
  });

  it('establishes transaction-local statement and lock timeouts before work', async () => {
    const pool = new FakePool(
      () => new FakeClient([{ when: (t) => t.includes('read_owner_listings'), rows: [] }]),
    );
    await new MarketStore(pool).listOwnerListings(HASH, ORG);
    const calls = pool.clients[0]?.calls.map((entry) => entry.text) ?? [];
    expect(calls.some((text) => text.startsWith('SET LOCAL statement_timeout'))).toBe(true);
    expect(calls.some((text) => text.startsWith('SET LOCAL lock_timeout'))).toBe(true);
    expect(calls.indexOf('BEGIN')).toBeLessThan(
      calls.findIndex((text) => text.startsWith('SET LOCAL statement_timeout')),
    );
  });

  it('destroys the connection when rollback fails and swallows release failures', async () => {
    const pool = new FakePool(
      () =>
        new FakeClient([
          { when: (t) => t.includes('lock_market_actor'), rows: [actorRow()] },
          { when: (t) => t.includes('commit_listing_create'), throws: { code: 'P0D01' } },
          { when: (t) => t === 'ROLLBACK', throws: { code: '08006' } },
        ]),
    );
    await expectCode(
      new MarketStore(pool).createListingDraft(HASH, ORG, PROVIDER, baseContent(), {
        idempotencyKey: KEY,
        mutationId: MUTATION,
      }),
      'MARKET_STORE_IDEMPOTENCY_CONFLICT',
    );
    expect(pool.clients[0]?.releases).toEqual([true]);

    const releasePool = new FakePool(
      () => new FakeClient([{ when: (t) => t.includes('read_owner_listings'), rows: [] }]),
      (client) => {
        client.releaseThrows = true;
      },
    );
    await expect(new MarketStore(releasePool).listOwnerListings(HASH, ORG)).resolves.toEqual({
      items: [],
      nextCursor: null,
    });
  });
});

describe('strict boolean, scalar-cardinality and lookahead binding', () => {
  it('requires an actual boolean out_replayed, never a truthy coercion', async () => {
    for (const replayed of ['true', 1, null, undefined]) {
      const pool = new FakePool(
        () =>
          new FakeClient([
            { when: (t) => t.includes('lock_market_actor'), rows: [actorRow()] },
            {
              when: (t) => t.includes('commit_listing_create'),
              rows: [{ ...receiptRow('market.listing.create', 'listing', DRAFT_LISTING), out_replayed: replayed }],
            },
          ]),
      );
      await expectCode(
        new MarketStore(pool).createListingDraft(HASH, ORG, PROVIDER, baseContent(), {
          idempotencyKey: KEY,
          mutationId: MUTATION,
        }),
        'MARKET_STORE_UNAVAILABLE',
      );
    }

    const replay = new FakePool(
      () =>
        new FakeClient([
          { when: (t) => t.includes('lock_market_actor'), rows: [actorRow()] },
          {
            when: (t) => t.includes('commit_listing_create'),
            rows: [{ ...receiptRow('market.listing.create', 'listing', DRAFT_LISTING), out_replayed: true }],
          },
        ]),
    );
    const result = await new MarketStore(replay).createListingDraft(HASH, ORG, PROVIDER, baseContent(), {
      idempotencyKey: KEY,
      mutationId: MUTATION,
    });
    expect(result.replayed).toBe(true);
  });

  it('rejects a scalar query that returns more than one row', async () => {
    const detail = new FakePool(
      () =>
        new FakeClient([
          { when: (t) => t.includes('read_owner_listing_version'), rows: [validVersionRow(), validVersionRow()] },
        ]),
    );
    await expectCode(
      new MarketStore(detail).getOwnerListingVersion(HASH, ORG, LISTING, '2'),
      'MARKET_STORE_UNAVAILABLE',
    );

    const status = new FakePool(
      () =>
        new FakeClient([
          {
            when: (t) => t.includes('read_market_mutation_status'),
            rows: [
              {
                out_mutation_id: MUTATION,
                out_operation: 'market.listing.create',
                out_resource_type: 'listing',
                out_resource_id: DRAFT_LISTING,
                out_committed_at: '2026-09-12 10:00:00.000001+00',
              },
              {
                out_mutation_id: MUTATION,
                out_operation: 'market.listing.create',
                out_resource_type: 'listing',
                out_resource_id: DRAFT_LISTING,
                out_committed_at: '2026-09-12 10:00:00.000001+00',
              },
            ],
          },
        ]),
    );
    await expectCode(
      new MarketStore(status).getMarketMutationStatus(HASH, ORG, MUTATION),
      'MARKET_STORE_UNAVAILABLE',
    );

    const commit = new FakePool(
      () =>
        new FakeClient([
          { when: (t) => t.includes('lock_market_actor'), rows: [actorRow()] },
          {
            when: (t) => t.includes('commit_listing_create'),
            rows: [
              receiptRow('market.listing.create', 'listing', DRAFT_LISTING),
              receiptRow('market.listing.create', 'listing', DRAFT_LISTING),
            ],
          },
        ]),
    );
    await expectCode(
      new MarketStore(commit).createListingDraft(HASH, ORG, PROVIDER, baseContent(), {
        idempotencyKey: KEY,
        mutationId: MUTATION,
      }),
      'MARKET_STORE_UNAVAILABLE',
    );
  });

  it('validates the lookahead row and enforces first-row-after-cursor ordering', async () => {
    const malformedLookahead = new FakePool(
      () =>
        new FakeClient([
          {
            when: (t) => t.includes('read_owner_listings'),
            rows: [
              validListingRow({ out_listing_id: 'openarc:listing:00000000-0000-4000-8000-000000000001' }),
              validListingRow({ out_listing_id: 'not-a-listing' }),
            ],
          },
        ]),
    );
    await expectCode(
      new MarketStore(malformedLookahead).listOwnerListings(HASH, ORG, { limit: 1 }),
      'MARKET_STORE_UNAVAILABLE',
    );

    const crossOrgLookahead = new FakePool(
      () =>
        new FakeClient([
          {
            when: (t) => t.includes('read_owner_listings'),
            rows: [
              validListingRow({ out_listing_id: 'openarc:listing:00000000-0000-4000-8000-000000000001' }),
              validListingRow({
                out_listing_id: 'openarc:listing:00000000-0000-4000-8000-000000000002',
                out_organization_id: 'openarc:org:00000000-0000-4000-8000-0000000000ff',
              }),
            ],
          },
        ]),
    );
    await expectCode(
      new MarketStore(crossOrgLookahead).listOwnerListings(HASH, ORG, { limit: 1 }),
      'MARKET_STORE_UNAVAILABLE',
    );

    const notAfterCursor = new FakePool(
      () =>
        new FakeClient([
          { when: (t) => t.includes('read_owner_listings'), rows: [validListingRow()] },
        ]),
    );
    await expectCode(
      new MarketStore(notAfterCursor).listOwnerListings(HASH, ORG, { afterListingId: LISTING }),
      'MARKET_STORE_UNAVAILABLE',
    );

    const versionLookahead = new FakePool(
      () =>
        new FakeClient([
          {
            when: (t) => t.includes('read_owner_listing_versions'),
            rows: [validVersionRow({ out_version: '2' }), validVersionRow({ out_version: '01' })],
          },
        ]),
    );
    await expectCode(
      new MarketStore(versionLookahead).listOwnerListingVersions(HASH, ORG, LISTING, { limit: 1 }),
      'MARKET_STORE_UNAVAILABLE',
    );

    const versionNotAfter = new FakePool(
      () =>
        new FakeClient([
          { when: (t) => t.includes('read_owner_listing_versions'), rows: [validVersionRow({ out_version: '2' })] },
        ]),
    );
    await expectCode(
      new MarketStore(versionNotAfter).listOwnerListingVersions(HASH, ORG, LISTING, { afterVersion: '2' }),
      'MARKET_STORE_UNAVAILABLE',
    );
  });
});
