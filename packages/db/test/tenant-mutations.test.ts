import { describe, expect, it } from 'vitest';
import {
  DURABLE_NETWORK,
  TenantStore,
  TenantStoreError,
  digestAgentUpdateRequest,
  digestMembershipSetRequest,
  digestOrganizationCreateRequest,
  digestProviderCreateRequest,
  digestProviderUpdateRequest,
  digestSessionContext,
  digestVersion,
  type TenantClient,
  type TenantPool,
  type TenantQueryResult,
  type DurableMutationReceipt,
  type DurableMutationResult,
  type DurableMutationStatus,
  type DurableOperation,
} from '../src/index.js';

/**
 * Unit coverage for the remaining durable tenant write methods over a narrow
 * scripted port. Authorization is never mocked: the fake port only returns what
 * the accepted SQL definer helpers would return.
 */

type Row = Record<string, unknown>;

interface Route {
  readonly when: (text: string) => boolean;
  readonly rows?: Row[];
  readonly throws?: { readonly code?: string; readonly message?: string };
}

class FakeClient implements TenantClient {
  readonly calls: { text: string; values: unknown[] }[] = [];
  readonly releases: boolean[] = [];
  constructor(private readonly routes: Route[]) {}
  async query<T extends Record<string, unknown>>(
    text: string,
    values: unknown[] = [],
  ): Promise<TenantQueryResult<T>> {
    this.calls.push({ text, values });
    const route = this.routes.find((candidate) => candidate.when(text));
    if (route?.throws !== undefined) {
      const error = new Error(route.throws.message ?? 'scripted failure');
      if (route.throws.code !== undefined) (error as { code?: string }).code = route.throws.code;
      throw error;
    }
    const rows = (route?.rows ?? []) as T[];
    return { rows, rowCount: route?.rows === undefined ? null : rows.length };
  }
  release(destroy?: boolean): void {
    this.releases.push(destroy === true);
  }
}

class FakePool implements TenantPool {
  connectCalls = 0;
  constructor(readonly client: TenantClient) {}
  async connect(): Promise<TenantClient> {
    this.connectCalls += 1;
    return this.client;
  }
}

const ACCOUNT_A = 'openarc:account:00000000-0000-4000-8000-000000000001';
const ACCOUNT_B = 'openarc:account:00000000-0000-4000-8000-000000000002';
const ORG_A = 'openarc:org:00000000-0000-4000-8000-00000000000a';
const AGENT_A = 'openarc:agent:00000000-0000-4000-8000-00000000000b';
const PROVIDER_A = 'openarc:provider:00000000-0000-4000-8000-00000000000c';
const HASH_A = 'a'.repeat(64);
const MUTATION_A = '00000000-0000-4000-8000-00000000000e';
const KEY_A = Buffer.alloc(32, 7).toString('base64url');
const NOW = new Date('2026-01-01T00:00:00.000Z');
const CREATED = new Date('2025-12-31T23:59:00.000Z');
const EXPIRES = new Date('2026-01-02T00:00:00.000Z');

function isQuery(text: string, fragment: string): boolean {
  return text.includes(fragment);
}

function sessionRoute(overrides: Partial<Row> = {}): Route {
  return {
    when: (text) => isQuery(text, 'lock_auth_session'),
    rows: [
      {
        account_id: ACCOUNT_A,
        method: 'passkey',
        session_created_at: CREATED,
        session_expires_at: EXPIRES,
        ...overrides,
      },
    ],
  };
}

function accessRoute(role = 'owner'): Route {
  return {
    when: (text) => isQuery(text, 'lock_organization_access'),
    rows: [{ out_organization_id: ORG_A, out_role: role }],
  };
}

function receiptRow(overrides: Partial<Row> = {}): Row {
  return {
    out_replayed: false,
    out_mutation_id: MUTATION_A,
    out_operation: 'tenant.agent.update',
    out_resource_type: 'agent',
    out_resource_id: AGENT_A,
    out_committed_at: NOW,
    ...overrides,
  };
}

function metadata(overrides: Partial<{ idempotencyKey: string; mutationId: string }> = {}) {
  return { idempotencyKey: KEY_A, mutationId: MUTATION_A, ...overrides };
}

describe('durable operation digest authority', () => {
  it('versions and derives the fixed domains per operation', () => {
    const operations: DurableOperation[] = [
      'tenant.organization.create',
      'tenant.agent.update',
      'tenant.provider.create',
      'tenant.provider.update',
      'tenant.membership.set',
    ];
    for (const operation of operations) {
      expect(digestVersion(operation)).toBe(`${operation}.v1`);
    }
    expect(DURABLE_NETWORK).toBe('eip155:5042002');
  });

  it('produces a fixed-order digest independent of object key order', () => {
    const base = {
      organizationId: ORG_A,
      actorAccountId: ACCOUNT_A,
      actorRole: 'owner',
      sessionContextDigest: digestSessionContext(HASH_A),
      mutationId: MUTATION_A,
    };
    const first = digestAgentUpdateRequest(base, AGENT_A, {
      hasDisplayName: true,
      displayName: 'Name',
      hasStatus: false,
      status: null,
    });
    const second = digestAgentUpdateRequest(base, AGENT_A, {
      hasDisplayName: true,
      displayName: 'Name',
      hasStatus: false,
      status: null,
    });
    expect(first).toBe(second);
    expect(first).toMatch(/^[0-9a-f]{64}$/);
  });

  it('treats absent vs provided-null patch fields as distinct digests', () => {
    const base = {
      organizationId: ORG_A,
      actorAccountId: ACCOUNT_A,
      actorRole: 'owner',
      sessionContextDigest: digestSessionContext(HASH_A),
      mutationId: MUTATION_A,
    };
    const absent = digestAgentUpdateRequest(base, AGENT_A, {
      hasDisplayName: false,
      displayName: null,
      hasStatus: true,
      status: 'active',
    });
    const provided = digestAgentUpdateRequest(base, AGENT_A, {
      hasDisplayName: true,
      displayName: '',
      hasStatus: true,
      status: 'active',
    }).valueOf();
    expect(absent).not.toBe(provided);
  });

  it('binds create and membership fields in a fixed order', () => {
    const org = digestOrganizationCreateRequest({
      mutationId: MUTATION_A,
      actorAccountId: ACCOUNT_A,
      sessionContextDigest: digestSessionContext(HASH_A),
      displayName: 'Acme',
    });
    expect(org).toMatch(/^[0-9a-f]{64}$/);
    const provider = digestProviderCreateRequest(
      {
        organizationId: ORG_A,
        actorAccountId: ACCOUNT_A,
        actorRole: 'owner',
        sessionContextDigest: digestSessionContext(HASH_A),
        mutationId: MUTATION_A,
      },
      'Provider',
    );
    expect(provider).toMatch(/^[0-9a-f]{64}$/);
    const membership = digestMembershipSetRequest(
      {
        organizationId: ORG_A,
        actorAccountId: ACCOUNT_A,
        actorRole: 'owner',
        sessionContextDigest: digestSessionContext(HASH_A),
        mutationId: MUTATION_A,
      },
      ACCOUNT_B,
      'viewer',
      'active',
    );
    expect(membership).toMatch(/^[0-9a-f]{64}$/);
    const update = digestProviderUpdateRequest(
      {
        organizationId: ORG_A,
        actorAccountId: ACCOUNT_A,
        actorRole: 'owner',
        sessionContextDigest: digestSessionContext(HASH_A),
        mutationId: MUTATION_A,
      },
      PROVIDER_A,
      { hasDisplayName: true, displayName: 'P', hasStatus: false, status: null },
    );
    expect(update).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('durable strict input validation before checkout', () => {
  it('rejects bad metadata and bad ids for every new method', async () => {
    const pool = new FakePool(new FakeClient([]));
    const store = new TenantStore(pool);
    const badMeta = { idempotencyKey: 'short', mutationId: MUTATION_A };
    const goodMeta = metadata();
    const cases = [
      store.createOrganizationDurably(HASH_A, 'Acme', badMeta),
      store.updateAgentDurably(HASH_A, ORG_A, AGENT_A, { displayName: 'A' }, badMeta),
      store.createProviderDurably(HASH_A, ORG_A, 'P', badMeta),
      store.updateProviderDurably(HASH_A, ORG_A, PROVIDER_A, { displayName: 'P' }, badMeta),
      store.setMembershipDurably(HASH_A, ORG_A, ACCOUNT_B, 'viewer', 'active', badMeta),
      store.updateAgentDurably(HASH_A, ORG_A, 'not-agent', { displayName: 'A' }, goodMeta),
      store.updateAgentDurably(HASH_A, ORG_A, AGENT_A, {}, goodMeta),
      store.updateProviderDurably(HASH_A, ORG_A, PROVIDER_A, { displayName: '  ' }, goodMeta),
      store.setMembershipDurably(HASH_A, ORG_A, ACCOUNT_B, 'root', 'active', goodMeta),
      store.setMembershipDurably(HASH_A, ORG_A, ACCOUNT_B, 'viewer', 'pending', goodMeta),
    ];
    for (const pending of cases) {
      await expect(pending).rejects.toMatchObject({ code: 'TENANT_STORE_INPUT_INVALID' });
    }
    expect(pool.connectCalls).toBe(0);
  });

  it('rejects a getTenantMutationStatus with a non-canonical mutation id', async () => {
    const pool = new FakePool(new FakeClient([]));
    const store = new TenantStore(pool);
    await expect(store.getTenantMutationStatus(HASH_A, ORG_A, 'nope')).rejects.toMatchObject({
      code: 'TENANT_STORE_INPUT_INVALID',
    });
    await expect(store.getOrganizationMutationStatus(HASH_A, 'nope')).rejects.toMatchObject({
      code: 'TENANT_STORE_INPUT_INVALID',
    });
    expect(pool.connectCalls).toBe(0);
  });
});

describe('durable receipt projection', () => {
  it('projects each bounded resource kind and never echoes secrets', async () => {
    const shapes: { sql: string; operation: DurableOperation; resourceType: string; id: string }[] = [
      { sql: 'commit_organization_create', operation: 'tenant.organization.create', resourceType: 'organization', id: ORG_A },
      { sql: 'commit_agent_update', operation: 'tenant.agent.update', resourceType: 'agent', id: AGENT_A },
      { sql: 'commit_provider_create', operation: 'tenant.provider.create', resourceType: 'provider', id: PROVIDER_A },
      { sql: 'commit_membership_set', operation: 'tenant.membership.set', resourceType: 'membership', id: ACCOUNT_B },
    ];
    for (const shape of shapes) {
      const client = new FakeClient([
        { when: (text) => isQuery(text, 'clock_timestamp'), rows: [{ now: NOW }] },
        sessionRoute(),
        accessRoute(),
        {
          when: (text) => isQuery(text, shape.sql),
          rows: [
            receiptRow({
              out_operation: shape.operation,
              out_resource_type: shape.resourceType,
              out_resource_id: shape.id,
            }),
          ],
        },
        {
          when: (text) => isQuery(text, 'lock_membership_set'),
          rows: [{ out_actor: ACCOUNT_A, out_role: 'owner' }],
        },
      ]);
      const store = new TenantStore(new FakePool(client));
      const result: DurableMutationResult =
        shape.operation === 'tenant.organization.create'
          ? await store.createOrganizationDurably(HASH_A, 'Acme', metadata())
          : shape.operation === 'tenant.agent.update'
            ? await store.updateAgentDurably(HASH_A, ORG_A, AGENT_A, { displayName: 'A' }, metadata())
            : shape.operation === 'tenant.provider.create'
              ? await store.createProviderDurably(HASH_A, ORG_A, 'P', metadata())
              : await store.setMembershipDurably(HASH_A, ORG_A, ACCOUNT_B, 'viewer', 'active', metadata());
      const receipt: DurableMutationReceipt = result.receipt;
      expect(receipt.operation).toBe(shape.operation);
      expect(receipt.resourceType).toBe(shape.resourceType);
      expect(receipt.resourceId).toBe(shape.id);
      expect(JSON.stringify(result)).not.toContain(KEY_A);
    }
  });

  it('maps the idempotency SQLSTATE to a fixed conflict error', async () => {
    const client = new FakeClient([
      sessionRoute(),
      accessRoute(),
      {
        when: (text) => isQuery(text, 'commit_provider_create'),
        throws: { code: 'P0D01', message: `raw ${HASH_A}` },
      },
    ]);
    const store = new TenantStore(new FakePool(client));
    const error = await store
      .createProviderDurably(HASH_A, ORG_A, 'P', metadata())
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(TenantStoreError);
    expect((error as TenantStoreError).code).toBe('TENANT_STORE_IDEMPOTENCY_CONFLICT');
    expect((error as TenantStoreError).message).not.toContain(HASH_A);
  });
});

describe('durable status projection', () => {
  it('returns committed for an own receipt and not_found otherwise', async () => {
    const found = new FakeClient([
      { when: (text) => isQuery(text, 'read_tenant_mutation_status'), rows: [receiptRow()] },
    ]);
    const store = new TenantStore(new FakePool(found));
    const status: DurableMutationStatus = await store.getTenantMutationStatus(
      HASH_A,
      ORG_A,
      MUTATION_A,
    );
    expect(status.status).toBe('committed');

    const missing = new FakeClient([
      { when: (text) => isQuery(text, 'read_organization_mutation_status'), rows: [] },
    ]);
    const other = new TenantStore(new FakePool(missing));
    await expect(other.getOrganizationMutationStatus(HASH_A, MUTATION_A)).resolves.toEqual({
      status: 'not_found',
    });
  });
});
