import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  CredentialStore,
  CredentialStoreError,
  digestCredentialIdempotencyKey,
  digestCredentialIssueRequest,
  digestCredentialSessionContext,
  loadMigrations,
  parseCanonicalBase64Url,
  parseCredentialHashInput,
  parseCredentialId,
  type TenantClient,
  type TenantPool,
  type TenantQueryResult,
} from '../src/index.js';
import { digestSessionContext, parseMutationId } from '../src/index.js';

/**
 * Unit coverage for the credential metadata authority and the repository
 * boundaries over a narrow scripted port. Authorization is never mocked: the
 * fake port only returns what the accepted SQL definer helpers would return.
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
      if (route.throws.code !== undefined) (error as { code?: string }).code = route.throws.code;
      throw error;
    }
    const rows = (route?.rows ?? []) as T[];
    return { rows, rowCount: route?.rows === undefined ? null : rows.length };
  }

  release(destroy?: boolean): void {
    if (this.releaseThrows && destroy !== true) throw new Error('release failed');
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

const ORG = 'openarc:org:00000000-0000-4000-8000-00000000000a';
const AGENT = 'openarc:agent:00000000-0000-4000-8000-00000000000b';
const ACCOUNT = 'openarc:account:00000000-0000-4000-8000-000000000001';
const HASH = 'a'.repeat(64);
const CREDENTIAL = '00000000-0000-4000-8000-00000000000e';
const LOOKUP = '00000000-0000-4000-8000-00000000000f';
const MUTATION = '00000000-0000-4000-8000-000000000010';
const SESSION = '00000000-0000-4000-8000-000000000011';
const KEY = Buffer.alloc(32, 7).toString('base64url');
const SALT = Buffer.alloc(16, 3).toString('base64url');
const DIGEST = Buffer.alloc(32, 9).toString('base64url');
const EXPIRES = '2026-01-02T00:00:00.000Z';
const COMMITTED = new Date('2026-01-01T00:00:00.000Z');

function hashInput(overrides: Row = {}): Row {
  return {
    algorithm: 'scrypt',
    hashVersion: 1,
    pepperVersion: 1,
    N: 32768,
    r: 8,
    p: 1,
    salt: SALT,
    digest: DIGEST,
    ...overrides,
  };
}

describe('credential hash input and id parsing', () => {
  it('accepts the exact closed hash shape', () => {
    expect(parseCredentialHashInput(hashInput())).toEqual({
      algorithm: 'scrypt',
      hashVersion: 1,
      pepperVersion: 1,
      N: 32768,
      r: 8,
      p: 1,
      salt: SALT,
      digest: DIGEST,
    });
  });

  it('rejects unknown keys, malformed base64 and out-of-range pepper', () => {
    expect(() => parseCredentialHashInput(hashInput({ extra: 1 }))).toThrow();
    expect(() => parseCredentialHashInput(hashInput({ pepperVersion: 0 }))).toThrow();
    expect(() => parseCredentialHashInput(hashInput({ pepperVersion: 17 }))).toThrow();
    expect(() => parseCredentialHashInput(hashInput({ N: 16384 }))).toThrow();
    expect(() => parseCredentialHashInput(hashInput({ salt: `${SALT}=` }))).toThrow();
    expect(() => parseCredentialHashInput(hashInput({ digest: '!'.repeat(43) }))).toThrow();
    expect(() => parseCredentialHashInput(hashInput({ salt: Buffer.alloc(15).toString('base64url') }))).toThrow();
  });

  it('rejects non-canonical UUIDv4 credential ids and mutation ids', () => {
    for (const bad of [
      '',
      CREDENTIAL.toUpperCase(),
      '00000000-0000-1000-8000-000000000001',
      '00000000-0000-4000-c000-000000000001',
      `${CREDENTIAL}\n`,
    ]) {
      expect(() => parseCredentialId(bad)).toThrow();
    }
    expect(parseCredentialId(CREDENTIAL)).toBe(CREDENTIAL);
    expect(parseMutationId(MUTATION)).toBe(MUTATION);
  });

  it('domain-separates the credential digests and never returns raw values', () => {
    const session = digestCredentialSessionContext('tenant.agent.credential.issue', HASH);
    const key = digestCredentialIdempotencyKey('tenant.agent.credential.issue', KEY);
    expect(session).toMatch(/^[0-9a-f]{64}$/);
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    expect(session).not.toContain(HASH);
    expect(key).not.toContain(KEY);
    expect(session).not.toBe(digestSessionContext(HASH));
    expect(key).not.toBe(session);
  });

  it('binds the issue digest without the ephemeral lookup/hash fields', () => {
    const context = {
      organizationId: ORG,
      actorAccountId: ACCOUNT,
      actorRole: 'owner',
      sessionContextDigest: digestCredentialSessionContext('tenant.agent.credential.issue', HASH),
      mutationId: MUTATION,
    };
    const first = digestCredentialIssueRequest('tenant.agent.credential.issue', context, AGENT, EXPIRES);
    const second = digestCredentialIssueRequest('tenant.agent.credential.issue', context, AGENT, EXPIRES);
    expect(first).toBe(second);
    expect(first).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('CredentialStore strict inputs', () => {
  it('rejects malformed ids, keys, TTL and unknown metadata keys before any checkout', async () => {
    const pool = new FakePool(new FakeClient([]));
    const store = new CredentialStore(pool);
    const base = {
      sessionHash: HASH,
      organizationId: ORG,
      profileId: AGENT,
      lookupId: LOOKUP,
      hash: hashInput(),
      expiresAt: EXPIRES,
      metadata: { idempotencyKey: KEY, mutationId: MUTATION },
    };
    await expect(store.issueAgentCredentialDurably({ ...base, lookupId: 'nope' } as never)).rejects.toMatchObject({
      code: 'CREDENTIAL_STORE_INPUT_INVALID',
    });
    await expect(store.issueAgentCredentialDurably({ ...base, expiresAt: '2026-01-02' } as never)).rejects.toMatchObject({
      code: 'CREDENTIAL_STORE_INPUT_INVALID',
    });
    await expect(store.issueAgentCredentialDurably({ ...base, hash: hashInput({ p: 2 }) } as never)).rejects.toMatchObject({
      code: 'CREDENTIAL_STORE_INPUT_INVALID',
    });
    await expect(
      store.issueAgentCredentialDurably({
        ...base,
        metadata: { idempotencyKey: KEY, mutationId: MUTATION, extra: 1 },
      } as never),
    ).rejects.toMatchObject({ code: 'CREDENTIAL_STORE_INPUT_INVALID' });
    await expect(store.issueProviderCredentialDurably({ ...base, profileId: AGENT } as never)).rejects.toMatchObject({
      code: 'CREDENTIAL_STORE_INPUT_INVALID',
    });
    expect(pool.connectCalls).toBe(0);
  });

  it('rejects malformed list, session and token inputs before checkout', async () => {
    const pool = new FakePool(new FakeClient([]));
    const store = new CredentialStore(pool);
    await expect(
      store.listAgentCredentials({ sessionHash: HASH, organizationId: ORG, profileId: AGENT, limit: 51 }),
    ).rejects.toMatchObject({ code: 'CREDENTIAL_STORE_INPUT_INVALID' });
    await expect(store.getAgentSession('nope')).rejects.toMatchObject({
      code: 'CREDENTIAL_STORE_INPUT_INVALID',
    });
    await expect(
      store.createAgentSession({
        organizationId: ORG,
        profileId: AGENT,
        credentialId: CREDENTIAL,
        expectedVersion: 0,
        sessionId: SESSION,
        tokenHash: HASH,
        expiresAt: EXPIRES,
      }),
    ).rejects.toMatchObject({ code: 'CREDENTIAL_STORE_INPUT_INVALID' });
    expect(pool.connectCalls).toBe(0);
  });
});

describe('CredentialStore mutation projection and failure seams', () => {
  function issueRoutes(replayed = false): Route[] {
    return [
      {
        when: (text) => text.includes('lock_auth_session'),
        rows: [{ account_id: ACCOUNT, method: 'passkey', session_created_at: COMMITTED, session_expires_at: COMMITTED }],
      },
      {
        when: (text) => text.includes('lock_organization_access'),
        rows: [{ out_organization_id: ORG, out_role: 'owner' }],
      },
      {
        when: (text) => text.includes('commit_agent_credential_issue'),
        rows: [
          {
            out_replayed: replayed,
            out_mutation_id: MUTATION,
            out_operation: 'tenant.agent.credential.issue',
            out_resource_type: 'agent_credential',
            out_resource_id: CREDENTIAL,
            out_committed_at: COMMITTED,
          },
        ],
      },
    ];
  }

  const input = {
    sessionHash: HASH,
    organizationId: ORG,
    profileId: AGENT,
    lookupId: LOOKUP,
    hash: hashInput(),
    expiresAt: EXPIRES,
    metadata: { idempotencyKey: KEY, mutationId: MUTATION },
  } as const;

  it('projects a bounded receipt and never echoes session/key/hash material', async () => {
    const client = new FakeClient(issueRoutes());
    const store = new CredentialStore(new FakePool(client));
    const result = await store.issueAgentCredentialDurably(input as never);
    expect(result.replayed).toBe(false);
    expect(result.receipt).toEqual({
      mutationId: MUTATION,
      operation: 'tenant.agent.credential.issue',
      resourceType: 'agent_credential',
      credentialId: CREDENTIAL,
      committedAt: COMMITTED.toISOString(),
    });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(HASH);
    expect(serialized).not.toContain(KEY);
    expect(serialized).not.toContain(SALT);
    expect(serialized).not.toContain(DIGEST);
    expect(client.releases).toEqual([false]);
  });

  it('maps the idempotency SQLSTATE to a fixed conflict error', async () => {
    const routes = issueRoutes();
    routes[2] = {
      when: (text) => text.includes('commit_agent_credential_issue'),
      throws: { code: 'P0D01', message: `raw ${HASH}` },
    };
    const store = new CredentialStore(new FakePool(new FakeClient(routes)));
    const error = await store.issueAgentCredentialDurably(input as never).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(CredentialStoreError);
    expect((error as CredentialStoreError).code).toBe('CREDENTIAL_STORE_IDEMPOTENCY_CONFLICT');
    expect((error as CredentialStoreError).message).not.toContain(HASH);
  });

  it('reports OUTCOME_UNKNOWN on a lost COMMIT reply and destroys the client', async () => {
    const routes = issueRoutes();
    routes.push({ when: (text) => text === 'COMMIT', throws: { message: 'lost' } });
    const client = new FakeClient(routes);
    const store = new CredentialStore(new FakePool(client));
    await expect(store.issueAgentCredentialDurably(input as never)).rejects.toMatchObject({
      code: 'CREDENTIAL_STORE_OUTCOME_UNKNOWN',
    });
    expect(client.releases).toEqual([true]);
  });

  it('reports UNAVAILABLE when the pool cannot connect', async () => {
    const pool = new FakePool(new FakeClient([]));
    pool.connectError = new Error('down');
    const store = new CredentialStore(pool);
    await expect(store.issueAgentCredentialDurably(input as never)).rejects.toMatchObject({
      code: 'CREDENTIAL_STORE_UNAVAILABLE',
    });
  });
});

describe('CredentialStore verifier snapshot', () => {
  it('projects the immutable version snapshot and never authorizes', async () => {
    const client = new FakeClient([
      {
        when: (text) => text.includes('find_agent_credential_verifier'),
        rows: [
          {
            out_organization_id: ORG,
            out_credential_id: CREDENTIAL,
            out_agent_id: AGENT,
            out_issuer_account_id: ACCOUNT,
            out_scope: 'agent:self.read',
            out_scope_version: 1,
            out_environment: 'eip155:5042002',
            out_algorithm: 'scrypt',
            out_hash_version: 1,
            out_pepper_version: 2,
            out_kdf_n: 32768,
            out_kdf_r: 8,
            out_kdf_p: 1,
            out_salt: SALT,
            out_digest: DIGEST,
            out_key_prefix: `oac_ag_${LOOKUP}`,
            out_revocation_version: 1,
            out_expires_at: new Date(EXPIRES),
          },
        ],
      },
    ]);
    const store = new CredentialStore(new FakePool(client));
    const snapshot = await store.findAgentCredentialVerifier(LOOKUP);
    expect(snapshot).toMatchObject({
      organizationId: ORG,
      credentialId: CREDENTIAL,
      kind: 'agent',
      profileId: AGENT,
      pepperVersion: 2,
      N: 32768,
      r: 8,
      p: 1,
      salt: SALT,
      digest: DIGEST,
    });
    expect(JSON.stringify(snapshot)).not.toContain(HASH);
  });

  it('maps a missing verifier to a fixed not_found', async () => {
    const client = new FakeClient([
      { when: (text) => text.includes('find_provider_credential_verifier'), rows: [] },
    ]);
    const store = new CredentialStore(new FakePool(client));
    await expect(store.findProviderCredentialVerifier(LOOKUP)).rejects.toMatchObject({
      code: 'CREDENTIAL_STORE_NOT_FOUND',
    });
  });
});

/**
 * Readiness over a narrow scripted port. Authorization is NOT mocked: the port
 * returns the same catalog rows a real restricted role would observe, and the
 * store must fail closed on any deviation.
 */
describe('CredentialStore readiness fail-closed', () => {
  const appliedManifest: Row[] = loadMigrations().map((migration) => ({
    id: migration.id,
    checksum: createHash('sha256').update(migration.sql, 'utf8').digest('hex'),
  }));

  const CREDENTIAL_HELPERS: readonly { name: string; args: string }[] = [
    { name: 'commit_agent_credential_issue', args: 'session_hash text, organization_id text, agent_id text, credential_id uuid, lookup_id uuid, key_prefix text, pepper_version integer, salt text, digest text, expires_at timestamp with time zone, mutation_id uuid, key_hash text, request_digest text, session_context_digest text' },
    { name: 'commit_agent_credential_revoke', args: 'session_hash text, organization_id text, credential_id uuid, mutation_id uuid, key_hash text, request_digest text, session_context_digest text' },
    { name: 'commit_provider_credential_issue', args: 'session_hash text, organization_id text, provider_id text, credential_id uuid, lookup_id uuid, key_prefix text, pepper_version integer, salt text, digest text, expires_at timestamp with time zone, mutation_id uuid, key_hash text, request_digest text, session_context_digest text' },
    { name: 'commit_provider_credential_revoke', args: 'session_hash text, organization_id text, credential_id uuid, mutation_id uuid, key_hash text, request_digest text, session_context_digest text' },
    { name: 'create_agent_session', args: 'organization_id text, agent_id text, credential_id uuid, expected_version integer, session_id uuid, token_hash text, expires_at timestamp with time zone' },
    { name: 'create_provider_session', args: 'organization_id text, provider_id text, credential_id uuid, expected_version integer, session_id uuid, token_hash text, expires_at timestamp with time zone' },
    { name: 'find_agent_credential_verifier', args: 'lookup_id uuid' },
    { name: 'find_provider_credential_verifier', args: 'lookup_id uuid' },
    { name: 'list_agent_credentials', args: 'session_hash text, organization_id text, agent_id text, after_credential_id uuid, page_limit integer' },
    { name: 'list_provider_credentials', args: 'session_hash text, organization_id text, provider_id text, after_credential_id uuid, page_limit integer' },
    { name: 'read_agent_credential_mutation_status', args: 'session_hash text, organization_id text, mutation_id uuid' },
    { name: 'read_agent_session', args: 'token_hash text' },
    { name: 'read_provider_credential_mutation_status', args: 'session_hash text, organization_id text, mutation_id uuid' },
    { name: 'read_provider_session', args: 'token_hash text' },
    { name: 'revoke_agent_session', args: 'token_hash text' },
    { name: 'revoke_provider_session', args: 'token_hash text' },
  ];

  function credentialHelperRows(
    mutate: (row: Record<string, unknown>) => Record<string, unknown> = (row) => row,
  ): Row[] {
    return CREDENTIAL_HELPERS.map((helper) =>
      mutate({
        proname: helper.name,
        args: helper.args,
        owner: 'openarc_migrator',
        prosecdef: true,
        config: ['search_path=pg_catalog'],
        app_exec: true,
        public_grants: 0,
      }),
    );
  }

  function readinessRoutes(overrides: { helpers?: Row[]; access?: number; tables?: number } = {}): Route[] {
    return [
      {
        when: (text) => text.includes('elevated_memberships'),
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
      { when: (text) => text.includes('nspowner'), rows: [{ owner: 'openarc_migrator' }] },
      {
        when: (text) => text.includes('all_forced') && text.includes('openarc_tenant'),
        rows: [{ n: 4, all_enabled: true, all_forced: true }],
      },
      {
        when: (text) => text.includes('pg_get_userbyid(c.relowner)'),
        rows: [{ n: 0 }],
      },
      {
        when: (text) => text.includes('proname') && text.includes("ns.nspname = 'openarc_tenant'"),
        rows: [
          { name: 'current_context_access_kind' },
          { name: 'list_account_organization_ids' },
          { name: 'lock_auth_session' },
          { name: 'lock_organization_access' },
          { name: 'set_membership' },
        ],
      },
      {
        when: (text) => text.includes('all_forced') && text.includes('openarc_durable'),
        rows: [{ n: overrides.tables ?? 4, all_enabled: true, all_forced: true }],
      },
      {
        when: (text) => text.includes('pg_get_function_identity_arguments'),
        rows: overrides.helpers ?? credentialHelperRows(),
      },
      {
        when: (text) => text.includes('has_table_privilege'),
        rows: [{ n: overrides.access ?? 0 }],
      },
      { when: (text) => text.includes('openarc_meta.schema_migrations'), rows: appliedManifest },
    ];
  }

  it('accepts the exact applied manifest without mutating anything', async () => {
    const client = new FakeClient(readinessRoutes());
    const store = new CredentialStore(new FakePool(client));
    await expect(store.readiness()).resolves.toBeUndefined();
    const mutations = client.calls.filter((call) =>
      /^(INSERT|UPDATE|DELETE|CREATE|ALTER|DROP)\b/i.test(call.text.trim()),
    );
    expect(mutations).toEqual([]);
  });

  it('fails closed on drifted manifest, missing helper, PUBLIC grant and direct access', async () => {
    const drifted = readinessRoutes();
    const last = drifted[drifted.length - 1];
    drifted[drifted.length - 1] = {
      when: last?.when ?? (() => false),
      rows: appliedManifest.map((row, index) =>
        index === appliedManifest.length - 1 ? { ...row, checksum: '0'.repeat(64) } : row,
      ),
    };
    await expect(new CredentialStore(new FakePool(new FakeClient(drifted))).readiness()).rejects.toMatchObject({
      code: 'CREDENTIAL_STORE_UNAVAILABLE',
    });

    await expect(
      new CredentialStore(
        new FakePool(new FakeClient(readinessRoutes({ helpers: credentialHelperRows().slice(0, 15) }))),
      ).readiness(),
    ).rejects.toMatchObject({ code: 'CREDENTIAL_STORE_UNAVAILABLE' });

    await expect(
      new CredentialStore(
        new FakePool(
          new FakeClient(
            readinessRoutes({ helpers: credentialHelperRows((row) => ({ ...row, public_grants: 1 })) }),
          ),
        ),
      ).readiness(),
    ).rejects.toMatchObject({ code: 'CREDENTIAL_STORE_UNAVAILABLE' });

    await expect(
      new CredentialStore(new FakePool(new FakeClient(readinessRoutes({ access: 1 })))).readiness(),
    ).rejects.toMatchObject({ code: 'CREDENTIAL_STORE_UNAVAILABLE' });

    await expect(
      new CredentialStore(new FakePool(new FakeClient(readinessRoutes({ tables: 3 })))).readiness(),
    ).rejects.toMatchObject({ code: 'CREDENTIAL_STORE_UNAVAILABLE' });
  });
});

describe('base64 canonical parsing', () => {
  it('rejects padding and wrong lengths', () => {
    expect(parseCanonicalBase64Url(SALT, 16)).toBe(SALT);
    expect(parseCanonicalBase64Url(DIGEST, 32)).toBe(DIGEST);
    expect(() => parseCanonicalBase64Url(`${SALT}=`, 16)).toThrow();
    expect(() => parseCanonicalBase64Url(DIGEST, 16)).toThrow();
  });
});

describe('list status is SQL-authoritative', () => {
  it('projects the SQL out_status even when the local wall clock disagrees', async () => {
    const client = new FakeClient([
      {
        when: (text) => text.includes('list_agent_credentials'),
        rows: [
          {
            out_credential_id: CREDENTIAL,
            out_lookup_id: LOOKUP,
            out_agent_id: AGENT,
            out_scope: 'agent:self.read',
            out_environment: 'eip155:5042002',
            out_key_prefix: `oac_ag_${LOOKUP}`,
            out_created_at: new Date('2020-01-01T00:00:00.000Z'),
            out_expires_at: new Date('2999-01-01T00:00:00.000Z'),
            out_revoked_at: null,
            out_status: 'expired',
          },
        ],
      },
    ]);
    const store = new CredentialStore(new FakePool(client));
    const list = await store.listAgentCredentials({
      sessionHash: HASH,
      organizationId: ORG,
      profileId: AGENT,
    });
    expect(list.items[0]?.status).toBe('expired');
    expect(list.nextCursor).toBeNull();
  });

  it('fails closed on an unknown SQL status', async () => {
    const client = new FakeClient([
      {
        when: (text) => text.includes('list_agent_credentials'),
        rows: [
          {
            out_credential_id: CREDENTIAL,
            out_lookup_id: LOOKUP,
            out_agent_id: AGENT,
            out_scope: 'agent:self.read',
            out_environment: 'eip155:5042002',
            out_key_prefix: `oac_ag_${LOOKUP}`,
            out_created_at: new Date('2020-01-01T00:00:00.000Z'),
            out_expires_at: new Date('2999-01-01T00:00:00.000Z'),
            out_revoked_at: null,
            out_status: 'weird',
          },
        ],
      },
    ]);
    const store = new CredentialStore(new FakePool(client));
    await expect(
      store.listAgentCredentials({ sessionHash: HASH, organizationId: ORG, profileId: AGENT }),
    ).rejects.toMatchObject({ code: 'CREDENTIAL_STORE_UNAVAILABLE' });
  });
});
