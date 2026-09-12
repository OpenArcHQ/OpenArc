import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DURABILITY_DIGEST_VERSION,
  DURABILITY_NETWORK,
  DURABILITY_OPERATION,
  DURABILITY_RESOURCE_TYPE,
  DURABILITY_SESSION_DOMAIN,
  DURABILITY_KEY_DOMAIN,
  DurabilityInputError,
  OutboxStore,
  OutboxStoreError,
  TenantStore,
  TenantStoreError,
  digestAgentCreateRequest,
  digestIdempotencyKey,
  digestSessionContext,
  loadMigrations,
  parseIdempotencyKey,
  parseMutationId,
  type OutboxClient,
  type OutboxPool,
  type OutboxQueryResult,
  type TenantClient,
  type TenantPool,
  type TenantQueryResult,
} from '../src/index.js';

/**
 * Unit coverage for the durability metadata authority and the repository
 * boundaries over a narrow scripted port. Authorization is never mocked: the
 * fake port only returns what the accepted SQL definer helpers would return.
 */

type Row = Record<string, unknown>;

interface Route {
  readonly when: (text: string) => boolean;
  readonly rows?: Row[];
  readonly throws?: { readonly code?: string; readonly message?: string };
}

class FakeClient implements TenantClient, OutboxClient {
  readonly calls: { text: string; values: unknown[] }[] = [];
  readonly releases: boolean[] = [];
  releaseThrows = false;

  constructor(private readonly routes: Route[]) {}

  async query<T extends Record<string, unknown>>(
    text: string,
    values: unknown[] = [],
  ): Promise<TenantQueryResult<T> & OutboxQueryResult<T>> {
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
    return { rows, rowCount: route?.rows === undefined ? null : rows.length };
  }

  release(destroy?: boolean): void {
    if (this.releaseThrows && destroy !== true) {
      throw new Error('release failed');
    }
    this.releases.push(destroy === true);
  }
}

class FakePool implements TenantPool, OutboxPool {
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
const ORG_A = 'openarc:org:00000000-0000-4000-8000-00000000000a';
const AGENT_A = 'openarc:agent:00000000-0000-4000-8000-00000000000b';
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
    out_operation: DURABILITY_OPERATION,
    out_resource_type: DURABILITY_RESOURCE_TYPE,
    out_resource_id: AGENT_A,
    out_committed_at: NOW,
    ...overrides,
  };
}

const appliedManifest: Row[] = loadMigrations().map((migration) => ({
  id: migration.id,
  checksum: createHash('sha256').update(migration.sql, 'utf8').digest('hex'),
}));

function readinessRoutes(applied: Row[] = appliedManifest): Route[] {
  return [
    {
      when: (text) => isQuery(text, 'elevated_memberships'),
      rows: [
        {
          role: 'openarc_worker_app',
          rolsuper: false,
          rolbypassrls: false,
          rolcreatedb: false,
          rolcreaterole: false,
          elevated_memberships: 0,
          migrator_member: false,
          tenant_member: false,
          auth_member: false,
        },
      ],
    },
    {
      when: (text) => isQuery(text, 'AS table_access'),
      rows: [{ table_access: 0, sequence_access: 0, schema_create: 0 }],
    },
    { when: (text) => isQuery(text, 'nspowner'), rows: [{ owner: 'openarc_migrator' }] },
    {
      when: (text) => isQuery(text, 'all_forced'),
      rows: [{ n: 3, all_enabled: true, all_forced: true }],
    },
    { when: (text) => isQuery(text, 'pg_get_userbyid(c.relowner)'), rows: [{ n: 0 }] },
    {
      when: (text) => isQuery(text, 'pg_get_function_identity_arguments'),
      rows: [
        {
          proname: 'claim_outbox_jobs',
          args: 'claim_limit integer',
          owner: 'openarc_migrator',
          prosecdef: true,
          config: ['search_path=pg_catalog'],
          app_exec: true,
          public_grants: 0,
        },
        {
          proname: 'complete_outbox_job',
          args: 'target_event_id uuid, expected_generation bigint',
          owner: 'openarc_migrator',
          prosecdef: true,
          config: ['search_path=pg_catalog'],
          app_exec: true,
          public_grants: 0,
        },
        {
          proname: 'fail_outbox_job',
          args: 'target_event_id uuid, expected_generation bigint, failure_code text',
          owner: 'openarc_migrator',
          prosecdef: true,
          config: ['search_path=pg_catalog'],
          app_exec: true,
          public_grants: 0,
        },
      ],
    },
    { when: (text) => isQuery(text, 'openarc_meta.schema_migrations'), rows: applied },
  ];
}

afterEach(() => {
  // no shared state
});

describe('durability metadata parsing', () => {
  it('accepts canonical UUIDv4 and rejects non-canonical forms', () => {
    expect(parseMutationId(MUTATION_A)).toBe(MUTATION_A);
    for (const bad of [
      '',
      'not-a-uuid',
      MUTATION_A.toUpperCase(),
      '00000000-0000-4000-8000-00000000000',
      '00000000-0000-1000-8000-000000000001',
      '00000000-0000-4000-c000-000000000001',
    ]) {
      expect(() => parseMutationId(bad)).toThrow(DurabilityInputError);
    }
  });

  it('accepts exactly 32-byte unpadded base64url with decode/re-encode equality', () => {
    expect(parseIdempotencyKey(KEY_A)).toBe(KEY_A);
    expect(KEY_A).toHaveLength(43);
    for (const bad of [
      '',
      `${KEY_A}=`,
      Buffer.alloc(31).toString('base64url'),
      Buffer.alloc(33).toString('base64url'),
      '!'.repeat(43),
    ]) {
      expect(() => parseIdempotencyKey(bad)).toThrow(DurabilityInputError);
    }
  });

  it('domain-separates session and key digests and never returns raw values', () => {
    const session = digestSessionContext(HASH_A);
    const key = digestIdempotencyKey(KEY_A);
    expect(session).toMatch(/^[0-9a-f]{64}$/);
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    expect(session).not.toContain(HASH_A);
    expect(key).not.toContain(KEY_A);
    expect(session).toBe(
      createHash('sha256').update(`${DURABILITY_SESSION_DOMAIN}:${HASH_A}`, 'utf8').digest('hex'),
    );
    expect(key).toBe(
      createHash('sha256').update(`${DURABILITY_KEY_DOMAIN}:${KEY_A}`, 'utf8').digest('hex'),
    );
  });

  it('builds the fixed-order canonical request digest', () => {
    const digest = digestAgentCreateRequest({
      organizationId: ORG_A,
      actorAccountId: ACCOUNT_A,
      actorRole: 'owner',
      sessionContextDigest: digestSessionContext(HASH_A),
      mutationId: MUTATION_A,
      displayName: 'Agent A',
    });
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    expect(DURABILITY_DIGEST_VERSION).toBe('tenant.agent.create.v1');
    expect(DURABILITY_NETWORK).toBe('eip155:5042002');
  });
});

describe('TenantStore.createAgentDurably strict inputs', () => {
  it('rejects bad metadata before any checkout', async () => {
    const pool = new FakePool(new FakeClient([]));
    const store = new TenantStore(pool);
    await expect(
      store.createAgentDurably(HASH_A, ORG_A, 'Agent', {
        idempotencyKey: 'short',
        mutationId: MUTATION_A,
      }),
    ).rejects.toMatchObject({ code: 'TENANT_STORE_INPUT_INVALID' });
    await expect(
      store.createAgentDurably(HASH_A, ORG_A, 'Agent', {
        idempotencyKey: KEY_A,
        mutationId: 'bad',
      }),
    ).rejects.toMatchObject({ code: 'TENANT_STORE_INPUT_INVALID' });
    await expect(
      store.createAgentDurably(HASH_A, ORG_A, 'Agent', {
        idempotencyKey: KEY_A,
        mutationId: MUTATION_A,
        requestDigest: 'x',
      } as never),
    ).rejects.toMatchObject({ code: 'TENANT_STORE_INPUT_INVALID' });
    expect(pool.connectCalls).toBe(0);
  });
});

describe('TenantStore.createAgentDurably receipt projection', () => {
  it('projects a bounded receipt and never echoes session/key/digest', async () => {
    const client = new FakeClient([
      sessionRoute(),
      accessRoute(),
      { when: (text) => isQuery(text, 'commit_agent_create'), rows: [receiptRow()] },
    ]);
    const store = new TenantStore(new FakePool(client));
    const result = await store.createAgentDurably(HASH_A, ORG_A, 'Agent A', {
      idempotencyKey: KEY_A,
      mutationId: MUTATION_A,
    });
    expect(result.replayed).toBe(false);
    expect(result.receipt).toEqual({
      mutationId: MUTATION_A,
      operation: DURABILITY_OPERATION,
      resourceType: DURABILITY_RESOURCE_TYPE,
      resourceId: AGENT_A,
      committedAt: NOW.toISOString(),
    });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(HASH_A);
    expect(serialized).not.toContain(KEY_A);
    expect(client.releases).toEqual([false]);
  });

  it('surfaces replayed=true for a safe same-key replay', async () => {
    const client = new FakeClient([
      sessionRoute(),
      accessRoute('operator'),
      {
        when: (text) => isQuery(text, 'commit_agent_create'),
        rows: [receiptRow({ out_replayed: true })],
      },
    ]);
    const store = new TenantStore(new FakePool(client));
    const result = await store.createAgentDurably(HASH_A, ORG_A, 'Agent A', {
      idempotencyKey: KEY_A,
      mutationId: MUTATION_A,
    });
    expect(result.replayed).toBe(true);
  });

  it('maps the idempotency SQLSTATE to a fixed conflict error', async () => {
    const client = new FakeClient([
      sessionRoute(),
      accessRoute(),
      {
        when: (text) => isQuery(text, 'commit_agent_create'),
        throws: { code: 'P0D01', message: `raw ${HASH_A}` },
      },
    ]);
    const store = new TenantStore(new FakePool(client));
    const error = await store
      .createAgentDurably(HASH_A, ORG_A, 'Agent A', {
        idempotencyKey: KEY_A,
        mutationId: MUTATION_A,
      })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(TenantStoreError);
    expect((error as TenantStoreError).code).toBe('TENANT_STORE_IDEMPOTENCY_CONFLICT');
    expect((error as TenantStoreError).message).not.toContain(HASH_A);
  });

  it('reports OUTCOME_UNKNOWN on a lost COMMIT reply', async () => {
    const client = new FakeClient([
      sessionRoute(),
      accessRoute(),
      { when: (text) => isQuery(text, 'commit_agent_create'), rows: [receiptRow()] },
      { when: (text) => text === 'COMMIT', throws: { message: 'lost' } },
    ]);
    const store = new TenantStore(new FakePool(client));
    await expect(
      store.createAgentDurably(HASH_A, ORG_A, 'Agent A', {
        idempotencyKey: KEY_A,
        mutationId: MUTATION_A,
      }),
    ).rejects.toMatchObject({ code: 'TENANT_STORE_OUTCOME_UNKNOWN' });
    expect(client.releases).toEqual([true]);
  });
});

describe('TenantStore.getAgentMutationStatus', () => {
  it('returns committed for an own receipt and not_found for another account', async () => {
    const found = new FakeClient([
      sessionRoute(),
      {
        when: (text) => isQuery(text, 'read_agent_mutation_status'),
        rows: [receiptRow()],
      },
    ]);
    const store = new TenantStore(new FakePool(found));
    const status = await store.getAgentMutationStatus(HASH_A, ORG_A, MUTATION_A);
    expect(status.status).toBe('committed');

    const missing = new FakeClient([
      sessionRoute(),
      { when: (text) => isQuery(text, 'read_agent_mutation_status'), rows: [] },
    ]);
    const other = new TenantStore(new FakePool(missing));
    await expect(other.getAgentMutationStatus(HASH_A, ORG_A, MUTATION_A)).resolves.toEqual({
      status: 'not_found',
    });
  });

  it('rejects a non-canonical mutation id before checkout', async () => {
    const pool = new FakePool(new FakeClient([]));
    const store = new TenantStore(pool);
    await expect(store.getAgentMutationStatus(HASH_A, ORG_A, 'nope')).rejects.toMatchObject({
      code: 'TENANT_STORE_INPUT_INVALID',
    });
    expect(pool.connectCalls).toBe(0);
  });
});

describe('OutboxStore claim and acknowledge', () => {
  const EVENT_ID = '00000000-0000-4000-8000-0000000000ff';

  it('rejects out-of-range limits and bad acknowledgements before checkout', async () => {
    const pool = new FakePool(new FakeClient([]));
    const store = new OutboxStore(pool);
    await expect(store.claim({ limit: 0 })).rejects.toMatchObject({
      code: 'OUTBOX_STORE_INPUT_INVALID',
    });
    await expect(store.claim({ limit: 51 })).rejects.toMatchObject({
      code: 'OUTBOX_STORE_INPUT_INVALID',
    });
    await expect(store.complete('nope', '1')).rejects.toMatchObject({
      code: 'OUTBOX_STORE_INPUT_INVALID',
    });
    await expect(store.fail(EVENT_ID, '1', 'boom')).rejects.toMatchObject({
      code: 'OUTBOX_STORE_INPUT_INVALID',
    });
    expect(pool.connectCalls).toBe(0);
  });

  it('projects a bounded opaque claim with canonical generation string', async () => {
    const client = new FakeClient([
      {
        when: (text) => isQuery(text, 'claim_outbox_jobs'),
        rows: [
          {
            event_id: EVENT_ID,
            organization_id: ORG_A,
            mutation_id: MUTATION_A,
            resource_type: 'agent',
            resource_id: AGENT_A,
            event_type: 'tenant.agent.created',
            payload_version: 1,
            lease_generation: '3',
            lease_until: NOW,
            attempt_count: 2,
          },
        ],
      },
    ]);
    const store = new OutboxStore(new FakePool(client));
    const [claimed] = await store.claim();
    expect(claimed).toEqual({
      eventId: EVENT_ID,
      organizationId: ORG_A,
      mutationId: MUTATION_A,
      resourceType: 'agent',
      resourceId: AGENT_A,
      eventType: 'tenant.agent.created',
      payloadVersion: 1,
      leaseGeneration: '3',
      leaseUntil: NOW.toISOString(),
      attemptCount: 2,
    });
    expect(JSON.stringify(claimed)).not.toContain('openarc:account');
  });

  it('returns applied=false for a stale or expired acknowledgement', async () => {
    const stale = new FakeClient([
      { when: (text) => isQuery(text, 'complete_outbox_job'), rows: [{ applied: false }] },
    ]);
    const store = new OutboxStore(new FakePool(stale));
    await expect(store.complete(EVENT_ID, '1')).resolves.toEqual({ applied: false });

    const expired = new FakeClient([
      { when: (text) => isQuery(text, 'fail_outbox_job'), rows: [{ applied: false }] },
    ]);
    const failing = new OutboxStore(new FakePool(expired));
    await expect(failing.fail(EVENT_ID, '9', 'handler_failed')).resolves.toEqual({
      applied: false,
    });
  });

  it('normalizes restricted-role denials without echoing detail', async () => {
    const client = new FakeClient([
      {
        when: (text) => isQuery(text, 'claim_outbox_jobs'),
        throws: { code: '42501', message: `denied ${EVENT_ID}` },
      },
    ]);
    const store = new OutboxStore(new FakePool(client));
    const error = await store.claim().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(OutboxStoreError);
    expect((error as OutboxStoreError).code).toBe('OUTBOX_STORE_FORBIDDEN');
    expect((error as OutboxStoreError).message).not.toContain(EVENT_ID);
  });

  it('readiness rejects the wrong role and a drifted manifest', async () => {
    const wrong = new OutboxStore(
      new FakePool(
        new FakeClient([
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
                tenant_member: true,
                auth_member: true,
              },
            ],
          },
        ]),
      ),
    );
    await expect(wrong.readiness()).rejects.toMatchObject({
      code: 'OUTBOX_STORE_UNAVAILABLE',
    });

    const drifted = readinessRoutes(
      appliedManifest.map((row, index) =>
        index === appliedManifest.length - 1 ? { ...row, checksum: '0'.repeat(64) } : row,
      ),
    );
    const store = new OutboxStore(new FakePool(new FakeClient(drifted)));
    await expect(store.readiness()).rejects.toMatchObject({
      code: 'OUTBOX_STORE_UNAVAILABLE',
    });
  });

  it('accepts the exact applied manifest without mutating anything', async () => {
    const client = new FakeClient(readinessRoutes());
    const store = new OutboxStore(new FakePool(client));
    await expect(store.readiness()).resolves.toBeUndefined();
    const mutations = client.calls.filter((call) =>
      /^(INSERT|UPDATE|DELETE|CREATE|ALTER|DROP)\b/i.test(call.text.trim()),
    );
    expect(mutations).toEqual([]);
    expect(client.releases).toEqual([false]);
  });

  it('rejects effective protected access, a bad helper shape and an ignored PUBLIC grant', async () => {
    const accessDenied = readinessRoutes();
    const accessIndex = accessDenied.findIndex((route) => route.when('SELECT 1 AS table_access'));
    accessDenied[accessIndex] = {
      when: (text) => isQuery(text, 'AS table_access'),
      rows: [{ table_access: 1, sequence_access: 0, schema_create: 0 }],
    };
    await expect(
      new OutboxStore(new FakePool(new FakeClient(accessDenied))).readiness(),
    ).rejects.toMatchObject({ code: 'OUTBOX_STORE_UNAVAILABLE' });

    const schemaCreate = readinessRoutes();
    const createIndex = schemaCreate.findIndex((route) =>
      route.when('SELECT 1 AS table_access'),
    );
    schemaCreate[createIndex] = {
      when: (text) => isQuery(text, 'AS table_access'),
      rows: [{ table_access: 0, sequence_access: 0, schema_create: 1 }],
    };
    await expect(
      new OutboxStore(new FakePool(new FakeClient(schemaCreate))).readiness(),
    ).rejects.toMatchObject({ code: 'OUTBOX_STORE_UNAVAILABLE' });

    const publicGrant = readinessRoutes();
    const helperIndex = publicGrant.findIndex((route) =>
      route.when('pg_get_function_identity_arguments'),
    );
    const helpers = publicGrant[helperIndex]?.rows ?? [];
    publicGrant[helperIndex] = {
      when: (text) => isQuery(text, 'pg_get_function_identity_arguments'),
      rows: helpers.map((row, index) => (index === 0 ? { ...row, public_grants: 1 } : row)),
    };
    await expect(
      new OutboxStore(new FakePool(new FakeClient(publicGrant))).readiness(),
    ).rejects.toMatchObject({ code: 'OUTBOX_STORE_UNAVAILABLE' });

    const wrongSignature = readinessRoutes();
    const sigIndex = wrongSignature.findIndex((route) =>
      route.when('pg_get_function_identity_arguments'),
    );
    const sigHelpers = wrongSignature[sigIndex]?.rows ?? [];
    wrongSignature[sigIndex] = {
      when: (text) => isQuery(text, 'pg_get_function_identity_arguments'),
      rows: sigHelpers.map((row, index) => (index === 0 ? { ...row, args: 'bigint' } : row)),
    };
    await expect(
      new OutboxStore(new FakePool(new FakeClient(wrongSignature))).readiness(),
    ).rejects.toMatchObject({ code: 'OUTBOX_STORE_UNAVAILABLE' });

    const notDefiner = readinessRoutes();
    const defIndex = notDefiner.findIndex((route) =>
      route.when('pg_get_function_identity_arguments'),
    );
    const defHelpers = notDefiner[defIndex]?.rows ?? [];
    notDefiner[defIndex] = {
      when: (text) => isQuery(text, 'pg_get_function_identity_arguments'),
      rows: defHelpers.map((row, index) => (index === 0 ? { ...row, prosecdef: false } : row)),
    };
    await expect(
      new OutboxStore(new FakePool(new FakeClient(notDefiner))).readiness(),
    ).rejects.toMatchObject({ code: 'OUTBOX_STORE_UNAVAILABLE' });

    const missingHelper = readinessRoutes();
    const missingIndex = missingHelper.findIndex((route) =>
      route.when('pg_get_function_identity_arguments'),
    );
    missingHelper[missingIndex] = {
      when: (text) => isQuery(text, 'pg_get_function_identity_arguments'),
      rows: (missingHelper[missingIndex]?.rows ?? []).slice(0, 2),
    };
    await expect(
      new OutboxStore(new FakePool(new FakeClient(missingHelper))).readiness(),
    ).rejects.toMatchObject({ code: 'OUTBOX_STORE_UNAVAILABLE' });
  });
});
