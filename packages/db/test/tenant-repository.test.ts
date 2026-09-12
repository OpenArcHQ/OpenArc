import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  TenantStore,
  TenantStoreError,
  loadMigrations,
  type TenantClient,
  type TenantPool,
  type TenantQueryResult,
} from '../src/index.js';

/**
 * Unit coverage for the TenantStore repository boundary.
 *
 * These tests exercise strict input validation, canonical DTO projection,
 * error normalization, lost-COMMIT and cleanup/release semantics over a
 * narrow scripted pool port. Authorization is never mocked here: the fake
 * port only returns what the already-accepted SQL bridge would return.
 */

type Row = Record<string, unknown>;

interface Route {
  readonly when: (text: string) => boolean;
  readonly rows?: Row[];
  readonly rowCount?: number | null;
  readonly throws?: { readonly code?: string; readonly message?: string };
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
      const error = new Error(route.throws.message ?? 'scripted failure');
      if (route.throws.code !== undefined) {
        (error as { code?: string }).code = route.throws.code;
      }
      throw error;
    }
    const rows = (route?.rows ?? []) as T[];
    const rowCount = route?.rowCount ?? (route?.rows === undefined ? null : route.rows.length);
    return { rows, rowCount };
  }

  release(destroy?: boolean): void {
    if (this.releaseThrows && destroy !== true) {
      throw new Error('release failed');
    }
    this.releases.push(destroy === true);
  }
}

class FakePool implements TenantPool {
  connectCalls = 0;
  connectError: Error | null = null;

  constructor(readonly client: TenantClient) {}

  async connect(): Promise<TenantClient> {
    this.connectCalls += 1;
    if (this.connectError !== null) throw this.connectError;
    return this.client;
  }
}

const ACCOUNT_A = 'openarc:account:00000000-0000-4000-8000-000000000001';
const ACCOUNT_B = 'openarc:account:00000000-0000-4000-8000-000000000002';
const ORG_A = 'openarc:org:00000000-0000-4000-8000-00000000000a';
const AGENT_A = 'openarc:agent:00000000-0000-4000-8000-00000000000b';
const PROVIDER_A = 'openarc:provider:00000000-0000-4000-8000-00000000000c';
const HASH_A = 'a'.repeat(64);

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

function orgRow(overrides: Partial<Row> = {}): Row {
  return {
    organization_id: ORG_A,
    display_name: 'Org A',
    created_at: CREATED,
    updated_at: NOW,
    ...overrides,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('TenantStore strict inputs', () => {
  const invalidHash = 'not-a-hash';

  it('rejects invalid session hashes before checkout', async () => {
    const pool = new FakePool(new FakeClient([]));
    const store = new TenantStore(pool);
    await expect(store.listOrganizations(invalidHash)).rejects.toMatchObject({
      code: 'TENANT_STORE_INPUT_INVALID',
    });
    await expect(store.createOrganization(invalidHash, 'Org')).rejects.toMatchObject({
      code: 'TENANT_STORE_INPUT_INVALID',
    });
    await expect(store.setMembership(invalidHash, ORG_A, ACCOUNT_B, 'viewer', 'active')).rejects.toMatchObject(
      { code: 'TENANT_STORE_INPUT_INVALID' },
    );
    expect(pool.connectCalls).toBe(0);
  });

  it('rejects invalid limits, cursors, names and patches before checkout', async () => {
    const pool = new FakePool(new FakeClient([]));
    const store = new TenantStore(pool);
    await expect(store.listOrganizations(HASH_A, { limit: 0 })).rejects.toMatchObject({
      code: 'TENANT_STORE_INPUT_INVALID',
    });
    await expect(store.listOrganizations(HASH_A, { limit: 101 })).rejects.toMatchObject({
      code: 'TENANT_STORE_INPUT_INVALID',
    });
    await expect(
      store.listOrganizations(HASH_A, { afterOrganizationId: 'openarc:org:nope' }),
    ).rejects.toMatchObject({ code: 'TENANT_STORE_INPUT_INVALID' });
    await expect(store.createOrganization(HASH_A, '  padded  ')).rejects.toMatchObject({
      code: 'TENANT_STORE_INPUT_INVALID',
    });
    await expect(store.createOrganization(HASH_A, 'bad\u0007name')).rejects.toMatchObject({
      code: 'TENANT_STORE_INPUT_INVALID',
    });
    await expect(store.updateAgent(HASH_A, ORG_A, AGENT_A, {})).rejects.toMatchObject({
      code: 'TENANT_STORE_INPUT_INVALID',
    });
    await expect(
      store.updateAgent(HASH_A, ORG_A, AGENT_A, { status: 'retired' as never }),
    ).rejects.toMatchObject({ code: 'TENANT_STORE_INPUT_INVALID' });
    await expect(
      store.updateProvider(HASH_A, ORG_A, PROVIDER_A, { status: 'revoked' as never }),
    ).rejects.toMatchObject({ code: 'TENANT_STORE_INPUT_INVALID' });
    await expect(store.setMembership(HASH_A, ORG_A, ACCOUNT_B, 'root', 'active')).rejects.toMatchObject(
      { code: 'TENANT_STORE_INPUT_INVALID' },
    );
    await expect(store.setMembership(HASH_A, ORG_A, ACCOUNT_B, 'viewer', 'pending')).rejects.toMatchObject(
      { code: 'TENANT_STORE_INPUT_INVALID' },
    );
    expect(pool.connectCalls).toBe(0);
  });
});

describe('TenantStore canonical DTO projection', () => {
  it('projects a strict organization and access view with UTC timestamps', async () => {
    const client = new FakeClient([
      sessionRoute(),
      {
        when: (text) => isQuery(text, 'lock_organization_access'),
        rows: [{ out_organization_id: ORG_A, out_role: 'owner' }],
      },
      { when: (text) => isQuery(text, 'FROM openarc_tenant.organizations'), rows: [orgRow()] },
    ]);
    const store = new TenantStore(new FakePool(client));

    const result = await store.getOrganizationAccess(HASH_A, ORG_A);
    expect(Object.keys(result.organization).sort()).toEqual([
      'createdAt',
      'displayName',
      'organizationId',
      'schemaVersion',
      'updatedAt',
    ]);
    expect(Object.keys(result.access).sort()).toEqual([
      'accountId',
      'membershipStatus',
      'organizationId',
      'role',
      'schemaVersion',
      'sessionExpiresAt',
    ]);
    expect(result.organization.createdAt).toBe(CREATED.toISOString());
    expect(result.access.sessionExpiresAt).toBe(EXPIRES.toISOString());
    expect(result.access.accountId).toBe(ACCOUNT_A);
    expect(result.access.role).toBe('owner');
    expect(client.releases).toEqual([false]);
  });

  it('returns a bounded next cursor only when another page exists', async () => {
    const otherOrg = 'openarc:org:00000000-0000-4000-8000-00000000000d';
    const client = new FakeClient([
      {
        when: (text) => isQuery(text, 'list_account_organization_ids'),
        rows: [{ organization_id: ORG_A }],
      },
      {
        when: (text) => isQuery(text, 'lock_organization_access'),
        rows: [{ out_organization_id: ORG_A, out_role: 'viewer' }],
      },
      { when: (text) => isQuery(text, 'FROM openarc_tenant.organizations'), rows: [orgRow()] },
    ]);
    const store = new TenantStore(new FakePool(client));
    const page = await store.listOrganizations(HASH_A, { limit: 1 });
    expect(page.items).toHaveLength(1);
    expect(page.nextCursor).toBe(ORG_A);

    const single = new FakeClient([
      {
        when: (text) => isQuery(text, 'list_account_organization_ids'),
        rows: [{ organization_id: ORG_A }],
      },
      {
        when: (text) => isQuery(text, 'lock_organization_access'),
        rows: [{ out_organization_id: ORG_A, out_role: 'viewer' }],
      },
      { when: (text) => isQuery(text, 'FROM openarc_tenant.organizations'), rows: [orgRow({ organization_id: otherOrg })] },
    ]);
    const stored = new TenantStore(new FakePool(single));
    const last = await stored.listOrganizations(HASH_A, { limit: 5 });
    expect(last.nextCursor).toBeNull();
  });

  it('validates server-generated ids through the canonical schemas', async () => {
    const client = new FakeClient([
      sessionRoute(),
      {
        when: (text) => isQuery(text, 'lock_organization_access'),
        rows: [{ out_organization_id: ORG_A, out_role: 'owner' }],
      },
      {
        when: (text) => isQuery(text, 'INSERT INTO openarc_tenant.agents'),
        rows: [
          {
            agent_id: AGENT_A,
            organization_id: ORG_A,
            display_name: 'Agent A',
            status: 'active',
            created_at: CREATED,
            updated_at: NOW,
          },
        ],
      },
      { when: (text) => isQuery(text, 'INSERT INTO openarc_tenant.providers'), rows: [] },
    ]);
    const store = new TenantStore(new FakePool(client));
    const agent = await store.createAgent(HASH_A, ORG_A, 'Agent A');
    expect(agent.agentId).toMatch(
      /^openarc:agent:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(agent.organizationId).toMatch(
      /^openarc:org:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(agent.schemaVersion).toBe('openarc.agent-profile.v1');
    expect(Object.keys(agent).sort()).toEqual([
      'agentId',
      'createdAt',
      'displayName',
      'organizationId',
      'schemaVersion',
      'status',
      'updatedAt',
    ]);
    expect(PROVIDER_A).toMatch(
      /^openarc:provider:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });
});

describe('TenantStore error normalization', () => {
  const cases: readonly [string, string][] = [
    ['28000', 'TENANT_STORE_SESSION_INVALID'],
    ['42501', 'TENANT_STORE_FORBIDDEN'],
    ['22023', 'TENANT_STORE_INPUT_INVALID'],
    ['23505', 'TENANT_STORE_CONFLICT'],
    ['23503', 'TENANT_STORE_NOT_FOUND'],
    ['08006', 'TENANT_STORE_UNAVAILABLE'],
  ];

  it.each(cases)('maps SQLSTATE %s to %s without echoing detail', async (code, expected) => {
    const client = new FakeClient([
      {
        when: (text) => isQuery(text, 'set_membership'),
        throws: { code, message: `raw ${HASH_A} detail` },
      },
    ]);
    const store = new TenantStore(new FakePool(client));
    const error = await store
      .setMembership(HASH_A, ORG_A, ACCOUNT_B, 'viewer', 'active')
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(TenantStoreError);
    expect((error as TenantStoreError).code).toBe(expected);
    expect((error as TenantStoreError).message).not.toContain(HASH_A);
    expect(client.releases).toEqual([false]);
  });

  it('reports OUTCOME_UNKNOWN on a lost COMMIT reply and never claims rollback', async () => {
    const client = new FakeClient([
      {
        when: (text) => isQuery(text, 'set_membership'),
        rows: [
          {
            organization_id: ORG_A,
            account_id: ACCOUNT_B,
            role: 'viewer',
            status: 'active',
            created_at: CREATED,
            updated_at: NOW,
          },
        ],
      },
      { when: (text) => text === 'COMMIT', throws: { message: 'connection lost' } },
    ]);
    const store = new TenantStore(new FakePool(client));
    await expect(store.setMembership(HASH_A, ORG_A, ACCOUNT_B, 'viewer', 'active')).rejects.toMatchObject(
      { code: 'TENANT_STORE_OUTCOME_UNKNOWN' },
    );
    expect(client.releases).toEqual([true]);
  });

  it('discards the connection when cleanup rollback itself fails', async () => {
    const client = new FakeClient([
      { when: (text) => isQuery(text, 'set_membership'), throws: { code: '42501' } },
      { when: (text) => text === 'ROLLBACK', throws: { message: 'rollback failed' } },
    ]);
    const store = new TenantStore(new FakePool(client));
    await expect(store.setMembership(HASH_A, ORG_A, ACCOUNT_B, 'viewer', 'active')).rejects.toMatchObject(
      { code: 'TENANT_STORE_FORBIDDEN' },
    );
    expect(client.releases).toEqual([true]);
  });

  it('keeps a committed result when normal release fails', async () => {
    const client = new FakeClient([
      {
        when: (text) => isQuery(text, 'set_membership'),
        rows: [
          {
            organization_id: ORG_A,
            account_id: ACCOUNT_B,
            role: 'viewer',
            status: 'active',
            created_at: CREATED,
            updated_at: NOW,
          },
        ],
      },
    ]);
    client.releaseThrows = true;
    const store = new TenantStore(new FakePool(client));
    const result = await store.setMembership(HASH_A, ORG_A, ACCOUNT_B, 'viewer', 'active');
    expect(result.accountId).toBe(ACCOUNT_B);
    expect(client.releases).toEqual([]);
  });

  it('reports UNAVAILABLE when the pool cannot connect', async () => {
    const pool = new FakePool(new FakeClient([]));
    pool.connectError = new Error('no connection');
    const store = new TenantStore(pool);
    await expect(store.listMembers(HASH_A, ORG_A)).rejects.toMatchObject({
      code: 'TENANT_STORE_UNAVAILABLE',
    });
  });
});

describe('TenantStore bootstrap and readiness guards', () => {
  it('rejects recovery and stale sessions for organization bootstrap', async () => {
    const recovery = new TenantStore(
      new FakePool(new FakeClient([sessionRoute({ method: 'recovery' })])),
    );
    await expect(recovery.createOrganization(HASH_A, 'Org')).rejects.toMatchObject({
      code: 'TENANT_STORE_SESSION_INVALID',
    });

    const stale = new TenantStore(
      new FakePool(
        new FakeClient([
          sessionRoute({ session_created_at: new Date(NOW.getTime() - 6 * 60 * 1000) }),
          { when: (text) => isQuery(text, 'clock_timestamp'), rows: [{ now: NOW }] },
        ]),
      ),
    );
    await expect(stale.createOrganization(HASH_A, 'Org')).rejects.toMatchObject({
      code: 'TENANT_STORE_SESSION_INVALID',
    });
  });

  it('bootstrap is atomic and projects its initial owner access', async () => {
    const client = new FakeClient([
      sessionRoute(),
      { when: (text) => isQuery(text, 'clock_timestamp'), rows: [{ now: NOW }] },
      {
        when: (text) => isQuery(text, 'INSERT INTO openarc_tenant.organizations'),
        rows: [orgRow()],
      },
      { when: (text) => isQuery(text, 'INSERT INTO openarc_tenant.memberships'), rows: [] },
      { when: (text) => isQuery(text, 'FROM openarc_tenant.organizations'), rows: [orgRow()] },
    ]);
    const store = new TenantStore(new FakePool(client));
    const created = await store.createOrganization(HASH_A, 'Org A');
    expect(created.organization.displayName).toBe('Org A');
    expect(created.access.role).toBe('owner');
    expect(created.access.membershipStatus).toBe('active');
    expect(client.calls.filter((call) => call.text === 'COMMIT')).toHaveLength(1);
  });

  it('readiness rejects a wrong or elevated runtime role without migrating', async () => {
    const client = new FakeClient([
      {
        when: (text) => isQuery(text, 'FROM pg_roles r'),
        rows: [
          {
            role: 'postgres',
            rolsuper: true,
            rolbypassrls: true,
            rolcreatedb: true,
            rolcreaterole: true,
            elevated_memberships: 1,
            migrator_member: true,
            auth_member: true,
          },
        ],
      },
    ]);
    const store = new TenantStore(new FakePool(client));
    await expect(store.initialize()).rejects.toMatchObject({
      code: 'TENANT_STORE_UNAVAILABLE',
    });
    const mutations = client.calls.filter((call) =>
      /^(INSERT|UPDATE|DELETE|CREATE|ALTER|DROP)\b/i.test(call.text.trim()),
    );
    expect(mutations).toEqual([]);
  });
});

/* ------------------------------------------------------------------ */
/* Strict update patches (review finding 4)                            */
/* ------------------------------------------------------------------ */

describe('TenantStore strict update patches', () => {
  const invalidPatches: readonly [string, unknown][] = [
    ['null', null],
    ['undefined', undefined],
    ['array', []],
    ['string', 'displayName'],
    ['number', 7],
    ['empty object', {}],
    ['undefined-only', { displayName: undefined }],
    ['unknown key', { displayName: 'Valid', extra: true }],
    ['unknown-only key', { nope: 'x' }],
    ['inherited-only', Object.create({ displayName: 'Inherited' })],
    ['class instance', new (class { displayName = 'Classy'; })()],
  ];

  it.each(invalidPatches)(
    'rejects %s before checkout for both update methods',
    async (_name, patch) => {
      const pool = new FakePool(new FakeClient([]));
      const store = new TenantStore(pool);
      await expect(
        store.updateAgent(HASH_A, ORG_A, AGENT_A, patch as never),
      ).rejects.toMatchObject({ code: 'TENANT_STORE_INPUT_INVALID' });
      await expect(
        store.updateProvider(HASH_A, ORG_A, PROVIDER_A, patch as never),
      ).rejects.toMatchObject({ code: 'TENANT_STORE_INPUT_INVALID' });
      expect(pool.connectCalls).toBe(0);
    },
  );

  it('rejects inherited allowed fields mixed with an own unknown key', async () => {
    const pool = new FakePool(new FakeClient([]));
    const store = new TenantStore(pool);
    const patch = Object.create({ displayName: 'Inherited' });
    patch.extra = true;
    await expect(store.updateAgent(HASH_A, ORG_A, AGENT_A, patch as never)).rejects.toMatchObject({
      code: 'TENANT_STORE_INPUT_INVALID',
    });
    expect(pool.connectCalls).toBe(0);
  });

  it('accepts a valid defined name/status patch and commits once', async () => {
    const client = new FakeClient([
      sessionRoute(),
      {
        when: (text) => isQuery(text, 'lock_organization_access'),
        rows: [{ out_organization_id: ORG_A, out_role: 'owner' }],
      },
      {
        when: (text) => isQuery(text, 'FOR UPDATE') && isQuery(text, 'FROM openarc_tenant.agents'),
        rows: [
          {
            agent_id: AGENT_A,
            organization_id: ORG_A,
            display_name: 'Before',
            status: 'active',
            created_at: CREATED,
            updated_at: NOW,
          },
        ],
      },
      {
        when: (text) => isQuery(text, 'UPDATE openarc_tenant.agents'),
        rows: [
          {
            agent_id: AGENT_A,
            organization_id: ORG_A,
            display_name: 'After',
            status: 'suspended',
            created_at: CREATED,
            updated_at: NOW,
          },
        ],
      },
    ]);
    const store = new TenantStore(new FakePool(client));
    const updated = await store.updateAgent(HASH_A, ORG_A, AGENT_A, {
      displayName: 'After',
      status: 'suspended',
    });
    expect(updated.displayName).toBe('After');
    expect(updated.status).toBe('suspended');
    expect(client.calls.filter((call) => call.text === 'COMMIT')).toHaveLength(1);
  });
});

/* ------------------------------------------------------------------ */
/* Exact migration readiness (review finding 2)                        */
/* ------------------------------------------------------------------ */

function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function readinessRoutes(applied: Row[]): Route[] {
  return [
    {
      when: (text) => isQuery(text, 'FROM pg_roles r'),
      rows: [
        {
          role: 'openarc_tenant_app',
          rolsuper: false,
          rolbypassrls: false,
          rolcreatedb: false,
          rolcreaterole: false,
          elevated_memberships: 0,
          migrator_member: false,
          auth_member: false,
        },
      ],
    },
    { when: (text) => isQuery(text, 'nspowner'), rows: [{ owner: 'openarc_migrator' }] },
    {
      when: (text) => isQuery(text, 'all_forced'),
      rows: [{ n: 4, all_enabled: true, all_forced: true }],
    },
    { when: (text) => isQuery(text, 'pg_get_userbyid(c.relowner)'), rows: [{ n: 0 }] },
    {
      when: (text) => isQuery(text, 'p.proname AS name'),
      rows: [
        { name: 'current_context_access_kind' },
        { name: 'list_account_organization_ids' },
        { name: 'lock_auth_session' },
        { name: 'lock_organization_access' },
        { name: 'set_membership' },
      ],
    },
    { when: (text) => isQuery(text, 'openarc_meta.schema_migrations'), rows: applied },
  ];
}

const appliedManifest: Row[] = loadMigrations().map((migration) => ({
  id: migration.id,
  checksum: sha256Hex(migration.sql),
}));

describe('TenantStore exact migration readiness', () => {
  it('accepts the exact applied manifest without running a migration', async () => {
    const client = new FakeClient(readinessRoutes(appliedManifest));
    const store = new TenantStore(new FakePool(client));
    await expect(store.readiness()).resolves.toBeUndefined();
    const statements = client.calls.filter((call) =>
      /\b(INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|TRUNCATE)\b/i.test(call.text),
    );
    expect(statements).toEqual([]);
    expect(client.releases).toEqual([false]);
  });

  const failureVectors: readonly [string, Row[]][] = [
    ['an older applied set', appliedManifest.slice(0, 1)],
    [
      'a newer applied set',
      [...appliedManifest, { id: '0003_future', checksum: 'deadbeef' }],
    ],
    ['mismatched migration ids', [...appliedManifest].reverse()],
    [
      'a drifted checksum',
      appliedManifest.map((row) => ({ ...row, checksum: '0'.repeat(64) })),
    ],
  ];

  it.each(failureVectors)('rejects %s without migrating', async (_name, applied) => {
    const client = new FakeClient(readinessRoutes(applied));
    const store = new TenantStore(new FakePool(client));
    await expect(store.readiness()).rejects.toMatchObject({
      code: 'TENANT_STORE_UNAVAILABLE',
    });
    const statements = client.calls.filter((call) =>
      /\b(INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|TRUNCATE)\b/i.test(call.text),
    );
    expect(statements).toEqual([]);
  });
});
