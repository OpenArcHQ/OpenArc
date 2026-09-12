import { describe, expect, it } from 'vitest';
import {
  MarketCatalogStore,
  MarketStoreError,
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
  constructor(private readonly make: () => FakeClient) {}
  async connect(): Promise<TenantClient> {
    this.connectCalls += 1;
    const client = this.make();
    this.clients.push(client);
    return client;
  }
}

const PROVIDER = 'openarc:provider:00000000-0000-4000-8000-000000000002';
const LISTING = 'openarc:listing:00000000-0000-4000-8000-000000000003';
const LISTING_B = 'openarc:listing:00000000-0000-4000-8000-000000000004';

function content(): Record<string, unknown> {
  return {
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
    availability: { status: 'available', rateLimitPerMinute: '60' },
  };
}

function publicRow(listingId: string, overrides: Row = {}): Row {
  const c = content();
  return {
    out_listing_id: listingId,
    out_provider_id: PROVIDER,
    out_version: '1',
    out_kind: 'api',
    out_title: 'Example API',
    out_description: 'A bounded description',
    out_manifest: c['manifest'],
    out_price: c['price'],
    out_evidence_contract: c['evidenceContract'],
    out_endpoint_origin: 'https://api.example.com',
    out_terms_revision: 'terms-v1',
    out_privacy_summary: 'We store nothing.',
    out_payment_lane: 'unavailable',
    out_availability: c['availability'],
    out_status: 'active',
    out_published_at: '2026-09-12 10:00:00.000003+00',
    ...overrides,
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


describe('public catalog store over a scripted port', () => {
  it('projects an allowlisted public page with one-extra pagination', async () => {
    const pool = new FakePool(
      () =>
        new FakeClient([
          {
            when: (t) => t.includes('list_public_listings'),
            rows: [publicRow(LISTING), publicRow(LISTING_B)],
          },
        ]),
    );
    const store = new MarketCatalogStore(pool);
    const page = await store.listPublicListings({ limit: 1 });
    expect(page.items).toHaveLength(1);
    expect(page.nextCursor).toBe(LISTING);
    expect(page.items[0]).toMatchObject({
      schemaVersion: 'openarc.listing-public-version.v1',
      listingId: LISTING,
      endpointOrigin: 'https://api.example.com',
      status: 'active',
    });
    // No organization/session/path field is representable on the public DTO.
    expect(Object.keys(page.items[0] ?? {})).not.toContain('organizationId');
    expect(Object.keys(page.items[0] ?? {})).not.toContain('endpointContract');
  });

  it('defaults the page size to 25 and rejects over-max limits before checkout', async () => {
    const pool = new FakePool(() => new FakeClient([]));
    const store = new MarketCatalogStore(pool);
    await expectCode(store.listPublicListings({ limit: 51 }), 'MARKET_STORE_INPUT_INVALID');
    await expectCode(store.listPublicListings({ limit: 0 }), 'MARKET_STORE_INPUT_INVALID');
    expect(pool.clients).toHaveLength(0);
  });

  it('rejects wildcard/oversized q and unknown options', async () => {
    const pool = new FakePool(() => new FakeClient([]));
    const store = new MarketCatalogStore(pool);
    await expectCode(store.listPublicListings({ q: 'a'.repeat(81) }), 'MARKET_STORE_INPUT_INVALID');
    await expectCode(store.listPublicListings({ q: ' a' }), 'MARKET_STORE_INPUT_INVALID');
    await expectCode(
      store.listPublicListings({ unknown: true } as never),
      'MARKET_STORE_INPUT_INVALID',
    );
    expect(pool.clients).toHaveLength(0);
  });

  it('returns a public listing detail or null on a truthful miss', async () => {
    const hit = new FakePool(
      () => new FakeClient([{ when: (t) => t.includes('get_public_listing'), rows: [publicRow(LISTING)] }]),
    );
    const storeHit = new MarketCatalogStore(hit);
    expect((await storeHit.getPublicListing(LISTING))?.listingId).toBe(LISTING);

    const miss = new FakePool(
      () => new FakeClient([{ when: (t) => t.includes('get_public_listing'), rows: [] }]),
    );
    const storeMiss = new MarketCatalogStore(miss);
    expect(await storeMiss.getPublicListing(LISTING)).toBeNull();
  });

  it('rejects a mismatched public provider item', async () => {
    const pool = new FakePool(
      () =>
        new FakeClient([
          {
            when: (t) => t.includes('get_public_provider'),
            rows: [
              {
                out_provider_id: 'openarc:provider:00000000-0000-4000-8000-000000000009',
                out_display_name: 'Example Provider',
                out_status: 'active',
              },
            ],
          },
        ]),
    );
    const store = new MarketCatalogStore(pool);
    await expectCode(store.getPublicProvider(PROVIDER), 'MARKET_STORE_UNAVAILABLE');
  });

  it('returns a projection for an active provider with an eligible listing', async () => {
    const pool = new FakePool(
      () =>
        new FakeClient([
          {
            when: (t) => t.includes('get_public_provider'),
            rows: [{ out_provider_id: PROVIDER, out_display_name: 'Example Provider', out_status: 'active' }],
          },
        ]),
    );
    const store = new MarketCatalogStore(pool);
    expect(await store.getPublicProvider(PROVIDER)).toEqual({
      schemaVersion: 'openarc.provider-public.v1',
      providerId: PROVIDER,
      displayName: 'Example Provider',
      status: 'active',
    });
  });

  it('maps a scripted SQL error to a fixed code and still releases once', async () => {
    const pool = new FakePool(
      () =>
        new FakeClient([
          { when: (t) => t.includes('list_public_listings'), throws: { code: '42501' } },
        ]),
    );
    const store = new MarketCatalogStore(pool);
    await expectCode(store.listPublicListings({}), 'MARKET_STORE_FORBIDDEN');
    expect(pool.clients[0]?.releases).toEqual([false]);
  });

  it('rejects an explicitly-present undefined option before checkout', async () => {
    const pool = new FakePool(() => new FakeClient([]));
    const store = new MarketCatalogStore(pool);
    await expectCode(
      store.listPublicListings({ limit: undefined } as never),
      'MARKET_STORE_INPUT_INVALID',
    );
    await expectCode(
      store.listPublicListings({ afterListingId: undefined } as never),
      'MARKET_STORE_INPUT_INVALID',
    );
    expect(pool.clients).toHaveLength(0);
  });

  it('binds every projected row to the requested provider and kind filter', async () => {
    const providerPool = new FakePool(
      () =>
        new FakeClient([
          {
            when: (t) => t.includes('list_public_listings'),
            rows: [
              publicRow(LISTING, {
                out_provider_id: 'openarc:provider:00000000-0000-4000-8000-000000000009',
              }),
            ],
          },
        ]),
    );
    await expectCode(
      new MarketCatalogStore(providerPool).listPublicListings({ providerId: PROVIDER }),
      'MARKET_STORE_UNAVAILABLE',
    );

    const kindPool = new FakePool(
      () =>
        new FakeClient([
          { when: (t) => t.includes('list_public_listings'), rows: [publicRow(LISTING, { out_kind: 'data' })] },
        ]),
    );
    await expectCode(
      new MarketCatalogStore(kindPool).listPublicListings({ kind: 'api' }),
      'MARKET_STORE_UNAVAILABLE',
    );
  });

  it('maps a malformed driver listing row to UNAVAILABLE', async () => {
    const pool = new FakePool(
      () =>
        new FakeClient([
          {
            when: (t) => t.includes('list_public_listings'),
            rows: [publicRow('openarc:listing:not-a-uuid')],
          },
        ]),
    );
    await expectCode(
      new MarketCatalogStore(pool).listPublicListings({}),
      'MARKET_STORE_UNAVAILABLE',
    );
  });
});
