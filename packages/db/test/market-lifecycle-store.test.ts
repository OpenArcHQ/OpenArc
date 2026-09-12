import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  MarketLifecycleStore,
  MarketStoreError,
  digestLifecycleIdempotencyKey,
  digestLifecycleSessionContext,
  digestOriginReviewRequest,
  lifecycleResourceId,
  parseLifecycleDecision,
  parseLifecycleReasonCode,
  requireLifecycleDigest,
  requireNullableLifecycleDigest,
  reviewedEndpointDigest,
  type LifecycleDigestContext,
  type TenantClient,
  type TenantPool,
  type TenantQueryResult,
} from '../src/index.js';

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
const KEY = 'A'.repeat(42) + 'A';
const ORIGIN = 'https://api.example.com';
const PATH = '/v1/run';

function content(): Record<string, unknown> {
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
    endpointContract: { origin: ORIGIN, path: PATH },
    termsRevision: 'terms-v1',
    privacySummary: 'We store nothing.',
    paymentLane: 'unavailable',
    availability: { status: 'available', rateLimitPerMinute: '60' },
  };
}

function receiptRow(operation: string, version: string): Row {
  return {
    out_replayed: false,
    out_mutation_id: MUTATION,
    out_operation: operation,
    out_resource_type: 'listing_version',
    out_resource_id: lifecycleResourceId(LISTING, version),
    out_committed_at: '2026-09-12 10:00:00.123456+00',
  };
}

function versionRow(overrides: Row = {}): Row {
  const c = content();
  return {
    out_listing_id: LISTING,
    out_organization_id: ORG,
    out_provider_id: PROVIDER,
    out_version: '1',
    out_kind: 'api',
    out_title: 'Example API',
    out_description: 'A bounded description',
    out_manifest: c['manifest'],
    out_price: c['price'],
    out_evidence_contract: c['evidenceContract'],
    out_endpoint_contract: c['endpointContract'],
    out_origin_review_state: 'unreviewed',
    out_terms_revision: 'terms-v1',
    out_privacy_summary: 'We store nothing.',
    out_payment_lane: 'unavailable',
    out_availability: c['availability'],
    out_status: 'draft',
    out_created_at: '2026-09-12 10:00:00.000001+00',
    out_updated_at: '2026-09-12 10:00:00.000002+00',
    out_published_at: null,
    ...overrides,
  };
}

function listingRow(overrides: Row = {}): Row {
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

function metadata(mutationId = MUTATION, idempotencyKey = KEY): Record<string, unknown> {
  return { mutationId, idempotencyKey };
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

describe('reviewed endpoint digest vectors', () => {
  it('matches the frozen domain/string with no trailing newline', () => {
    const expected =
      'sha256:' +
      createHash('sha256')
        .update(`openarc.market.endpoint-review.v1\n${LISTING}\n1\n${ORIGIN}\n${PATH}`, 'utf8')
        .digest('hex');
    expect(reviewedEndpointDigest({ listingId: LISTING, version: '1', origin: ORIGIN, path: PATH })).toBe(expected);
  });

  it('rejects a line feed in any field', () => {
    expect(() =>
      reviewedEndpointDigest({ listingId: LISTING, version: '1', origin: `${ORIGIN}\n`, path: PATH }),
    ).toThrow();
    expect(() =>
      reviewedEndpointDigest({ listingId: LISTING, version: '1', origin: ORIGIN, path: `${PATH}\n` }),
    ).toThrow();
  });

  it('changes when any bound field changes', () => {
    const base = reviewedEndpointDigest({ listingId: LISTING, version: '1', origin: ORIGIN, path: PATH });
    expect(base).not.toBe(
      reviewedEndpointDigest({ listingId: LISTING, version: '2', origin: ORIGIN, path: PATH }),
    );
    expect(base).not.toBe(
      reviewedEndpointDigest({ listingId: LISTING, version: '1', origin: 'https://api.example.org', path: PATH }),
    );
  });
});

describe('lifecycle scalar parsing', () => {
  it('accepts only approved/rejected decisions', () => {
    expect(parseLifecycleDecision('approved')).toBe('approved');
    expect(() => parseLifecycleDecision('maybe')).toThrow();
  });

  it('accepts only the closed reason enum', () => {
    expect(parseLifecycleReasonCode('other')).toBe('other');
    expect(() => parseLifecycleReasonCode('raw_note')).toThrow();
  });

  it('requires a canonical sha256 digest and a nullable digest', () => {
    expect(requireLifecycleDigest(`sha256:${'a'.repeat(64)}`)).toBe(`sha256:${'a'.repeat(64)}`);
    expect(() => requireLifecycleDigest('sha256:xyz')).toThrow();
    expect(requireNullableLifecycleDigest(null)).toBeNull();
    expect(requireNullableLifecycleDigest(`sha256:${'a'.repeat(64)}`)).toBe(`sha256:${'a'.repeat(64)}`);
  });
});

describe('lifecycle session/key/digest binding', () => {
  const operation = 'market.listing.version.publish' as const;
  const context: LifecycleDigestContext = {
    organizationId: ORG,
    actorAccountId: 'openarc:account:x',
    actorRole: 'owner',
    sessionContextDigest: digestLifecycleSessionContext(operation, HASH),
    mutationId: MUTATION,
  };

  it('binds a stable per-operation session context', () => {
    expect(digestLifecycleSessionContext(operation, HASH)).toMatch(/^[0-9a-f]{64}$/);
    expect(digestLifecycleSessionContext(operation, HASH)).not.toBe(
      digestLifecycleSessionContext('market.listing.version.pause', HASH),
    );
  });

  it('binds a stable per-operation idempotency key', () => {
    expect(digestLifecycleIdempotencyKey(operation, KEY)).toMatch(/^[0-9a-f]{64}$/);
    expect(digestLifecycleIdempotencyKey(operation, KEY)).not.toBe(
      digestLifecycleIdempotencyKey('market.listing.version.pause', KEY),
    );
  });

  it('changes the request digest when the CAS/body fields change', () => {
    const base = digestOriginReviewRequest(context, LISTING, '1', {
      expectedUpdatedAt: '2026-09-12T10:00:00.000002Z',
      decision: 'approved',
      reviewedEndpointDigest: `sha256:${'a'.repeat(64)}`,
      reasonCode: 'manual_review',
      reasonDigest: null,
    });
    const changed = digestOriginReviewRequest(context, LISTING, '1', {
      expectedUpdatedAt: '2026-09-12T10:00:00.000003Z',
      decision: 'approved',
      reviewedEndpointDigest: `sha256:${'a'.repeat(64)}`,
      reasonCode: 'manual_review',
      reasonDigest: null,
    });
    expect(base).not.toBe(changed);
  });
});

describe('lifecycle store over a scripted port', () => {
  const reviewerRoute = (): Route => ({
    when: (t) => t.includes('lock_moderator_actor'),
    rows: [{ out_actor: 'openarc:account:moderator' }],
  });
  it('records an origin review and projects the lifecycle receipt', async () => {
    const pool = new FakePool(
      () =>
        new FakeClient([
          reviewerRoute(),
          { when: (t) => t.includes('commit_origin_review'), rows: [receiptRow('market.listing.origin_review.record', '1')] },
        ]),
    );
    const store = new MarketLifecycleStore(pool);
    const result = await store.recordOriginReview(
      HASH,
      ORG,
      LISTING,
      '1',
      {
        expectedUpdatedAt: '2026-09-12T10:00:00.000002Z',
        decision: 'approved',
        reviewedEndpointDigest: `sha256:${'a'.repeat(64)}`,
        reasonCode: 'manual_review',
        reasonDigest: null,
      },
      metadata(),
    );
    expect(result.replayed).toBe(false);
    expect(result.receipt).toEqual({
      mutationId: MUTATION,
      operation: 'market.listing.origin_review.record',
      resourceType: 'listing_version',
      resourceId: lifecycleResourceId(LISTING, '1'),
      committedAt: '2026-09-12T10:00:00.123456Z',
    });
    expect(pool.clients[0]?.releases).toEqual([false]);
  });

  it('publishes/pauses/retires with the exact resource binding', async () => {
    for (const operation of [
      'market.listing.version.publish',
      'market.listing.version.pause',
      'market.listing.version.retire',
    ] as const) {
      const pool = new FakePool(
        () =>
          new FakeClient([
            { when: (t) => t.includes('lock_lifecycle_writer'), rows: [{ out_actor: 'openarc:account:writer', out_provider_id: PROVIDER, out_listing_id: LISTING }] },
            { when: (t) => t.includes('commit_lifecycle_transition'), rows: [receiptRow(operation, '1')] },
          ]),
      );
      const store = new MarketLifecycleStore(pool);
      const result = await (
        operation === 'market.listing.version.publish'
          ? store.publishListingVersion
          : operation === 'market.listing.version.pause'
            ? store.pauseListingVersion
            : store.retireListingVersion
      ).call(
        store,
        HASH,
        ORG,
        LISTING,
        '1',
        { expectedUpdatedAt: '2026-09-12T10:00:00.000002Z', expectedActiveVersion: null },
        metadata(),
      );
      expect(result.receipt.operation).toBe(operation);
      expect(result.receipt.resourceId).toBe(lifecycleResourceId(LISTING, '1'));
    }
  });

  it('rejects unknown metadata keys and a non-null version mismatch', async () => {
    const pool = new FakePool(() => new FakeClient([]));
    const store = new MarketLifecycleStore(pool);
    await expectCode(
      store.recordOriginReview(
        HASH,
        ORG,
        LISTING,
        '1',
        {
          expectedUpdatedAt: '2026-09-12T10:00:00.000002Z',
          decision: 'approved',
          reviewedEndpointDigest: `sha256:${'a'.repeat(64)}`,
          reasonCode: 'manual_review',
          reasonDigest: null,
        },
        { ...metadata(), extra: true },
      ),
      'MARKET_STORE_INPUT_INVALID',
    );
    expect(pool.clients).toHaveLength(0);
  });

  it('rejects a malformed session hash before any checkout', async () => {
    const pool = new FakePool(() => new FakeClient([]));
    const store = new MarketLifecycleStore(pool);
    await expectCode(store.getOwnerListing('nope', ORG, LISTING), 'MARKET_STORE_INPUT_INVALID');
    expect(pool.clients).toHaveLength(0);
  });

  it('maps a scripted idempotency conflict to the fixed conflict error', async () => {
    const pool = new FakePool(
      () =>
        new FakeClient([
          reviewerRoute(),
          { when: (t) => t.includes('commit_origin_review'), throws: { code: 'P0D01' } },
        ]),
    );
    const store = new MarketLifecycleStore(pool);
    await expectCode(
      store.recordOriginReview(
        HASH,
        ORG,
        LISTING,
        '1',
        {
          expectedUpdatedAt: '2026-09-12T10:00:00.000002Z',
          decision: 'approved',
          reviewedEndpointDigest: `sha256:${'a'.repeat(64)}`,
          reasonCode: 'manual_review',
          reasonDigest: null,
        },
        metadata(),
      ),
      'MARKET_STORE_IDEMPOTENCY_CONFLICT',
    );
    expect(pool.clients[0]?.releases).toEqual([false]);
  });

  it('returns not_found for an unknown lifecycle mutation', async () => {
    const pool = new FakePool(() => new FakeClient([{ when: (t) => t.includes('read_lifecycle_mutation_status'), rows: [] }]));
    const store = new MarketLifecycleStore(pool);
    expect(await store.getLifecycleMutationStatus(HASH, ORG, MUTATION)).toEqual({ status: 'not_found' });
  });

  it('projects owner listing/version and provider option outputs', async () => {
    const pool = new FakePool(
      () =>
        new FakeClient([
          { when: (t) => t.includes('read_owner_listing'), rows: [listingRow()] },
          { when: (t) => t.includes('read_lifecycle_mutation_status'), rows: [receiptRow('market.listing.version.publish', '1')] },
        ]),
    );
    const store = new MarketLifecycleStore(pool);
    const listing = await store.getOwnerListing(HASH, ORG, LISTING);
    expect(listing?.listingId).toBe(LISTING);
    const status = await store.getLifecycleMutationStatus(HASH, ORG, MUTATION);
    expect(status.status).toBe('committed');
  });

  it('rejects a version mismatch in a returned receipt', async () => {
    const pool = new FakePool(
      () =>
        new FakeClient([
          reviewerRoute(),
          {
            when: (t) => t.includes('commit_origin_review'),
            rows: [receiptRow('market.listing.origin_review.record', '1')],
          },
        ]),
    );
    const store = new MarketLifecycleStore(pool);
    await expectCode(
      store.recordOriginReview(
        HASH,
        ORG,
        LISTING,
        '2',
        {
          expectedUpdatedAt: '2026-09-12T10:00:00.000002Z',
          decision: 'approved',
          reviewedEndpointDigest: `sha256:${'a'.repeat(64)}`,
          reasonCode: 'manual_review',
          reasonDigest: null,
        },
        metadata(),
      ),
      'MARKET_STORE_UNAVAILABLE',
    );
  });

  it('binds the provider picker to the requested cursor and rejects lookahead rows at or below it', async () => {
    const pool = new FakePool(
      () =>
        new FakeClient([
          {
            when: (t) => t.includes('list_market_providers'),
            rows: [
              { out_provider_id: PROVIDER, out_display_name: 'P', out_status: 'active' },
              {
                out_provider_id: 'openarc:provider:00000000-0000-4000-8000-000000000009',
                out_display_name: 'Q',
                out_status: 'active',
              },
            ],
          },
        ]),
    );
    const store = new MarketLifecycleStore(pool);
    // First row equals the requested cursor, so it is not a valid ascending page.
    await expectCode(
      store.listMarketProviders(HASH, ORG, { afterProviderId: PROVIDER, limit: 1 }),
      'MARKET_STORE_UNAVAILABLE',
    );
  });

  it('maps a malformed driver provider/version row to UNAVAILABLE, never INPUT_INVALID', async () => {
    const providerPool = new FakePool(
      () =>
        new FakeClient([
          {
            when: (t) => t.includes('list_market_providers'),
            rows: [{ out_provider_id: 'not-a-provider', out_display_name: 'P', out_status: 'active' }],
          },
        ]),
    );
    await expectCode(
      new MarketLifecycleStore(providerPool).listMarketProviders(HASH, ORG, {}),
      'MARKET_STORE_UNAVAILABLE',
    );

    const versionPool = new FakePool(
      () =>
        new FakeClient([
          {
            when: (t) => t.includes('get_moderator_listing_version'),
            rows: [versionRow({ out_version: 'not-a-version' })],
          },
          reviewerRoute(),
        ]),
    );
    await expectCode(
      new MarketLifecycleStore(versionPool).getModeratorListingVersion(HASH, ORG, LISTING, '1'),
      'MARKET_STORE_UNAVAILABLE',
    );

    const listingPool = new FakePool(
      () =>
        new FakeClient([
          {
            when: (t) => t.includes('read_owner_listing'),
            rows: [listingRow({ out_listing_id: 'openarc:listing:nope' })],
          },
        ]),
    );
    await expectCode(
      new MarketLifecycleStore(listingPool).getOwnerListing(HASH, ORG, LISTING),
      'MARKET_STORE_UNAVAILABLE',
    );
  });
});
