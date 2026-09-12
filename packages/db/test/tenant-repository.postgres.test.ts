import { createHash } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { createDatabasePool, migrate, TenantStore } from '../src/index.js';
import {
  adminPool,
  ensureRoles,
  migratorUrl,
  resetSchema,
  tenantUrl,
} from './postgres-fixture.js';

/**
 * Real PostgreSQL acceptance for the TenantStore repository over the frozen
 * schema2 SQL surface. Runs only against the restricted `openarc_tenant_app`
 * role and the exact disposable fixture; seeds are written with the admin
 * superuser so the runtime role never gains auth-table privileges.
 */

function sha256(seed: string): string {
  return createHash('sha256').update(`openarc-tenant-repository:${seed}`, 'utf8').digest('hex');
}

function uuid(seed: number): string {
  return `00000000-0000-4000-8000-${String(seed).padStart(12, '0')}`;
}

function accountId(seed: number): string {
  return `openarc:account:${uuid(seed)}`;
}

function orgId(seed: number): string {
  return `openarc:org:${uuid(seed)}`;
}

function userHandle(seed: number): string {
  return `${sha256(`handle:${seed}`).slice(0, 42)}A`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

async function expectCode(promise: Promise<unknown>, code: string): Promise<void> {
  try {
    await promise;
  } catch (error) {
    expect(isRecord(error) && error['code']).toBe(code);
    return;
  }
  throw new Error(`expected TenantStoreError ${code}`);
}

let admin: Pool;
let migrator: Pool;
let storePool: Pool;
let store: TenantStore;

beforeAll(async () => {
  admin = adminPool();
  await ensureRoles(admin);
  migrator = createDatabasePool(migratorUrl());
  storePool = createDatabasePool(tenantUrl());
});

afterAll(async () => {
  try {
    await resetSchema(admin);
  } finally {
    await storePool.end();
    await migrator.end();
    await admin.end();
  }
});

beforeEach(async () => {
  await resetSchema(admin);
  await migrate(migrator);
  store = new TenantStore(storePool);
});

async function seedAccount(seed: number, status = 'active'): Promise<string> {
  const id = accountId(seed);
  await admin.query(
    'INSERT INTO openarc_auth.accounts (account_id, user_handle, status) VALUES ($1, $2, $3)',
    [id, userHandle(seed), status],
  );
  return id;
}

interface SessionOptions {
  readonly method?: string;
  readonly createdAtOffsetMinutes?: number;
  readonly expiresOffsetMinutes?: number;
}

async function seedSession(
  seed: number,
  account: string,
  options: SessionOptions = {},
): Promise<string> {
  const hash = sha256(`session:${seed}`);
  await admin.query(
    `INSERT INTO openarc_auth.sessions (token_hash, account_id, method, created_at, expires_at)
     VALUES ($1, $2, $3, now() + ($4 || ' minutes')::interval, now() + ($5 || ' minutes')::interval)`,
    [
      hash,
      account,
      options.method ?? 'passkey',
      String(options.createdAtOffsetMinutes ?? 0),
      String(options.expiresOffsetMinutes ?? 1440),
    ],
  );
  return hash;
}

async function seedOrganization(seed: number, creator: string): Promise<string> {
  const org = orgId(seed);
  await admin.query(
    "INSERT INTO openarc_tenant.organizations (organization_id, display_name, created_by) VALUES ($1, 'Org', $2)",
    [org, creator],
  );
  return org;
}

async function seedMembership(
  org: string,
  account: string,
  role: string,
  status = 'active',
): Promise<void> {
  await admin.query(
    'INSERT INTO openarc_tenant.memberships (organization_id, account_id, role, status) VALUES ($1, $2, $3, $4)',
    [org, account, role, status],
  );
}

async function seedOwner(seed: number): Promise<{ account: string; org: string; hash: string }> {
  const account = await seedAccount(seed);
  const hash = await seedSession(seed, account);
  const org = await seedOrganization(seed, account);
  await seedMembership(org, account, 'owner');
  return { account, org, hash };
}

async function waitForLockWait(): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    const probe = await admin.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM pg_stat_activity
        WHERE datname = current_database() AND wait_event_type = 'Lock' AND pid <> pg_backend_pid()`,
    );
    if ((probe.rows[0]?.n ?? 0) > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('no lock wait observed');
}

function assertPoolContextReleased(): void {
  expect(storePool.totalCount - storePool.idleCount).toBe(0);
}

describe('TenantStore readiness', () => {
  it('initializes against the restricted tenant role and frozen schema', async () => {
    await store.initialize();
    const other = new TenantStore(storePool);
    await other.readiness();
    assertPoolContextReleased();
  });
});

describe('TenantStore organization bootstrap', () => {
  it('atomically creates the organization and initial owner', async () => {
    const account = await seedAccount(1);
    const hash = await seedSession(1, account);

    const created = await store.createOrganization(hash, 'Acme Evidence');
    expect(created.organization.displayName).toBe('Acme Evidence');
    expect(created.organization.schemaVersion).toBe('openarc.organization.v1');
    expect(created.organization.createdAt.endsWith('Z')).toBe(true);
    expect(Object.keys(created.organization).sort()).toEqual([
      'createdAt',
      'displayName',
      'organizationId',
      'schemaVersion',
      'updatedAt',
    ]);
    expect(created.access.role).toBe('owner');
    expect(created.access.accountId).toBe(account);
    expect(created.access.membershipStatus).toBe('active');
    expect(Object.keys(created.access).sort()).toEqual([
      'accountId',
      'membershipStatus',
      'organizationId',
      'role',
      'schemaVersion',
      'sessionExpiresAt',
    ]);

    const rows = await admin.query<{ owner: string; account: string }>(
      `SELECT o.created_by AS owner, m.account_id AS account
         FROM openarc_tenant.organizations o
         JOIN openarc_tenant.memberships m ON m.organization_id = o.organization_id
        WHERE o.organization_id = $1`,
      [created.organization.organizationId],
    );
    expect(rows.rows[0]).toEqual({ owner: account, account });
    assertPoolContextReleased();
  });

  it('leaves no orphan organization on a denied bootstrap', async () => {
    const account = await seedAccount(2);
    const stale = await seedSession(2, account, {
      createdAtOffsetMinutes: -6,
      expiresOffsetMinutes: 60,
    });
    await expectCode(store.createOrganization(stale, 'Blocked'), 'TENANT_STORE_SESSION_INVALID');
    const count = await admin.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM openarc_tenant.organizations',
    );
    expect(count.rows[0]?.n).toBe(0);
    assertPoolContextReleased();
  });

  it('denies recovery sessions and expired sessions', async () => {
    const account = await seedAccount(3);
    const recovery = await seedSession(3, account, { method: 'recovery' });
    await expectCode(store.createOrganization(recovery, 'Recovery'), 'TENANT_STORE_SESSION_INVALID');
    const expired = await seedSession(4, account, {
      createdAtOffsetMinutes: -120,
      expiresOffsetMinutes: -60,
    });
    await expectCode(store.createOrganization(expired, 'Expired'), 'TENANT_STORE_SESSION_INVALID');
    const missing = sha256('no-such-session');
    await expectCode(store.createOrganization(missing, 'Missing'), 'TENANT_STORE_SESSION_INVALID');
    assertPoolContextReleased();
  });
});

describe('TenantStore cross-organization isolation', () => {
  it('denies cross reads and writes for two accounts and two organizations', async () => {
    const a = await seedOwner(10);
    const b = await seedOwner(11);

    const access = await store.getOrganizationAccess(a.hash, a.org);
    expect(access.access.accountId).toBe(a.account);

    await expectCode(store.getOrganizationAccess(a.hash, b.org), 'TENANT_STORE_FORBIDDEN');
    await expectCode(store.listMembers(a.hash, b.org), 'TENANT_STORE_FORBIDDEN');
    await expectCode(store.createAgent(a.hash, b.org, 'Intruder'), 'TENANT_STORE_FORBIDDEN');

    const own = await store.createAgent(b.hash, b.org, 'Owned');
    const foreign = await store.listAgents(a.hash, b.org).catch((error: unknown) => error);
    expect(foreign).toMatchObject({ code: 'TENANT_STORE_FORBIDDEN' });
    expect(own.organizationId).toBe(b.org);
    assertPoolContextReleased();
  });

  it('denies a suspended membership and a revoked session', async () => {
    const owner = await seedOwner(12);
    const suspended = await seedAccount(13);
    const suspendedHash = await seedSession(13, suspended);
    await seedMembership(owner.org, suspended, 'viewer', 'suspended');
    await expectCode(store.getOrganizationAccess(suspendedHash, owner.org), 'TENANT_STORE_FORBIDDEN');

    await admin.query('DELETE FROM openarc_auth.sessions WHERE token_hash = $1', [owner.hash]);
    await expectCode(store.getOrganizationAccess(owner.hash, owner.org), 'TENANT_STORE_SESSION_INVALID');
    assertPoolContextReleased();
  });
});

describe('TenantStore role authority', () => {
  it('allows owner/operator/viewer agent reads and denies provider roles', async () => {
    const owner = await seedOwner(20);
    const operator = await seedAccount(21);
    const viewer = await seedAccount(22);
    const providerAdmin = await seedAccount(23);
    const operatorHash = await seedSession(21, operator);
    const viewerHash = await seedSession(22, viewer);
    await seedSession(23, providerAdmin);
    await seedMembership(owner.org, operator, 'operator');
    await seedMembership(owner.org, viewer, 'viewer');
    await seedMembership(owner.org, providerAdmin, 'provider_admin');

    const created = await store.createAgent(owner.hash, owner.org, 'Agent One');
    for (const [seed, allowed] of [
      [21, true],
      [22, true],
      [23, false],
    ] as const) {
      const hash = sha256(`session:${seed}`);
      if (allowed) {
        const listed = await store.listAgents(hash, owner.org);
        expect(listed.items.map((item) => item.agentId)).toContain(created.agentId);
      } else {
        await expectCode(store.listAgents(hash, owner.org), 'TENANT_STORE_FORBIDDEN');
      }
    }

    const operatorAgent = await store.createAgent(operatorHash, owner.org, 'Operator Agent');
    expect(operatorAgent.status).toBe('active');
    await expectCode(store.createAgent(viewerHash, owner.org, 'Viewer Agent'), 'TENANT_STORE_FORBIDDEN');
    assertPoolContextReleased();
  });

  it('keeps providers owner-only', async () => {
    const owner = await seedOwner(24);
    const operator = await seedAccount(25);
    const operatorHash = await seedSession(25, operator);
    await seedMembership(owner.org, operator, 'operator');

    const provider = await store.createProvider(owner.hash, owner.org, 'Provider One');
    expect(provider.status).toBe('active');
    await expectCode(store.listProviders(operatorHash, owner.org), 'TENANT_STORE_FORBIDDEN');
    await expectCode(
      store.createProvider(operatorHash, owner.org, 'Nope'),
      'TENANT_STORE_FORBIDDEN',
    );
    assertPoolContextReleased();
  });

  it('lets only the owner list all members including suspended', async () => {
    const owner = await seedOwner(26);
    const operator = await seedAccount(27);
    const suspended = await seedAccount(28);
    const operatorHash = await seedSession(27, operator);
    await seedMembership(owner.org, operator, 'operator', 'active');
    await seedMembership(owner.org, suspended, 'viewer', 'suspended');

    const members = await store.listMembers(owner.hash, owner.org);
    expect(members.items).toHaveLength(3);
    expect(members.items.map((item) => item.accountId).sort()).toEqual(
      [owner.account, accountId(27), accountId(28)].sort(),
    );
    const suspendedRow = members.items.find((item) => item.accountId === accountId(28));
    expect(suspendedRow?.status).toBe('suspended');
    expect(members.items.every((item) => !('displayName' in item))).toBe(true);

    await expectCode(store.listMembers(operatorHash, owner.org), 'TENANT_STORE_FORBIDDEN');
    assertPoolContextReleased();
  });
});

describe('TenantStore list bounds and cursors', () => {
  it('returns bounded pages with a stable cursor', async () => {
    const owner = await seedOwner(30);
    for (let index = 0; index < 3; index += 1) {
      await store.createAgent(owner.hash, owner.org, `Agent ${index}`);
    }
    const first = await store.listAgents(owner.hash, owner.org, { limit: 2 });
    expect(first.items).toHaveLength(2);
    expect(first.nextCursor).not.toBeNull();
    const second =
      first.nextCursor === null
        ? await store.listAgents(owner.hash, owner.org, { limit: 2 })
        : await store.listAgents(owner.hash, owner.org, {
            limit: 2,
            afterAgentId: first.nextCursor,
          });
    expect(second.items).toHaveLength(1);
    expect(second.nextCursor).toBeNull();
    assertPoolContextReleased();
  });

  it('lists only own organizations with a bounded stable page', async () => {
    const owner = await seedOwner(31);
    await seedMembership(await seedOrganization(32, owner.account), owner.account, 'viewer');
    await seedMembership(await seedOrganization(33, owner.account), owner.account, 'viewer');
    const first = await store.listOrganizations(owner.hash, { limit: 2 });
    expect(first.items).toHaveLength(2);
    expect(first.nextCursor).not.toBeNull();
    const second =
      first.nextCursor === null
        ? await store.listOrganizations(owner.hash, { limit: 2 })
        : await store.listOrganizations(owner.hash, {
            limit: 2,
            afterOrganizationId: first.nextCursor,
          });
    expect(second.items).toHaveLength(1);
    expect(second.nextCursor).toBeNull();
    const ids = [...first.items, ...second.items].map((item) => item.organizationId).sort();
    expect(ids).toEqual([owner.org, orgId(32), orgId(33)].sort());
    assertPoolContextReleased();
  });
});

describe('TenantStore membership invariants', () => {
  it('creates and changes membership, revoking target sessions only on change', async () => {
    const owner = await seedOwner(40);
    const target = await seedAccount(41);

    const created = await store.setMembership(owner.hash, owner.org, target, 'viewer', 'active');
    expect(created.role).toBe('viewer');
    expect(created.status).toBe('active');

    const targetHash = await seedSession(41, target);
    const unchanged = await store.setMembership(owner.hash, owner.org, target, 'viewer', 'active');
    expect(unchanged.role).toBe('viewer');
    const live = await admin.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM openarc_auth.sessions WHERE token_hash = $1',
      [targetHash],
    );
    expect(live.rows[0]?.n).toBe(1);

    await store.setMembership(owner.hash, owner.org, target, 'operator', 'active');
    const revoked = await admin.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM openarc_auth.sessions WHERE token_hash = $1',
      [targetHash],
    );
    expect(revoked.rows[0]?.n).toBe(0);
    assertPoolContextReleased();
  });

  it('retains one active owner under parallel demotions and does not invert lock order', async () => {
    const first = await seedOwner(42);
    const secondAccount = await seedAccount(43);
    const secondHash = await seedSession(43, secondAccount);
    await seedMembership(first.org, secondAccount, 'owner');
    await store.setMembership(first.hash, first.org, secondAccount, 'owner', 'active');

    const outcomes = await Promise.allSettled([
      store.setMembership(first.hash, first.org, secondAccount, 'operator', 'active'),
      store.setMembership(secondHash, first.org, first.account, 'operator', 'active'),
    ]);
    const fulfilled = outcomes.filter((outcome) => outcome.status === 'fulfilled');
    expect(fulfilled).toHaveLength(1);
    const owners = await admin.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM openarc_tenant.memberships
        WHERE organization_id = $1 AND role = 'owner' AND status = 'active'`,
      [first.org],
    );
    expect(owners.rows[0]?.n).toBe(1);
    assertPoolContextReleased();
  });

  it('rejects non-owner and stale-proof membership changes', async () => {
    const owner = await seedOwner(44);
    const viewerAccount = await seedAccount(45);
    const viewerHash = await seedSession(45, viewerAccount);
    await seedMembership(owner.org, viewerAccount, 'viewer');

    await expectCode(
      store.setMembership(viewerHash, owner.org, accountId(46), 'viewer', 'active'),
      'TENANT_STORE_FORBIDDEN',
    );

    const staleOwner = await seedAccount(47);
    const staleHash = await seedSession(47, staleOwner, {
      createdAtOffsetMinutes: -6,
      expiresOffsetMinutes: 30,
    });
    const staleOrg = await seedOrganization(47, staleOwner);
    await seedMembership(staleOrg, staleOwner, 'owner');
    await expectCode(
      store.setMembership(staleHash, staleOrg, accountId(46), 'viewer', 'active'),
      'TENANT_STORE_SESSION_INVALID',
    );
    assertPoolContextReleased();
  });
});

describe('TenantStore terminal states and immutable ownership', () => {
  it('treats revoked agents and retired providers as terminal', async () => {
    const owner = await seedOwner(50);
    const agent = await store.createAgent(owner.hash, owner.org, 'Agent');
    const revoked = await store.updateAgent(owner.hash, owner.org, agent.agentId, {
      status: 'revoked',
    });
    expect(revoked.status).toBe('revoked');
    await expectCode(
      store.updateAgent(owner.hash, owner.org, agent.agentId, { displayName: 'Nope' }),
      'TENANT_STORE_CONFLICT',
    );

    const provider = await store.createProvider(owner.hash, owner.org, 'Provider');
    const retired = await store.updateProvider(owner.hash, owner.org, provider.providerId, {
      status: 'retired',
    });
    expect(retired.status).toBe('retired');
    await expectCode(
      store.updateProvider(owner.hash, owner.org, provider.providerId, { status: 'active' }),
      'TENANT_STORE_CONFLICT',
    );

    const storedAgent = await admin.query<{ organization_id: string }>(
      'SELECT organization_id FROM openarc_tenant.agents WHERE agent_id = $1',
      [agent.agentId],
    );
    expect(storedAgent.rows[0]?.organization_id).toBe(owner.org);
    assertPoolContextReleased();
  });
});

describe('TenantStore lock-order freshness', () => {
  it('rechecks session expiry after waiting on the organization row lock', async () => {
    const account = await seedAccount(60);
    const hash = await seedSession(60, account, {
      createdAtOffsetMinutes: -2,
      expiresOffsetMinutes: 60,
    });
    await admin.query(
      `UPDATE openarc_auth.sessions SET expires_at = now() + interval '1 second'
        WHERE token_hash = $1`,
      [hash],
    );
    const org = await seedOrganization(60, account);
    await seedMembership(org, account, 'owner');
    const blocker: PoolClient = await admin.connect();
    try {
      await blocker.query('BEGIN');
      await blocker.query(
        'SELECT 1 FROM openarc_tenant.organizations WHERE organization_id = $1 FOR UPDATE',
        [org],
      );
      const pending = store.getOrganizationAccess(hash, org);
      await waitForLockWait();
      await admin.query('SELECT pg_sleep(2)');
      await blocker.query('COMMIT');
      await expectCode(pending, 'TENANT_STORE_SESSION_INVALID');
    } finally {
      blocker.release();
    }
    assertPoolContextReleased();
  });
});

describe('TenantStore readiness role hierarchy', () => {
  it('rejects transitive membership in an elevated role and cleans up', async () => {
    const probe = new TenantStore(storePool);
    await probe.readiness();
    try {
      await admin.query('DROP ROLE IF EXISTS openarc_test_elevated').catch(() => {});
      await admin.query('DROP ROLE IF EXISTS openarc_test_intermediate').catch(() => {});
      await admin.query('CREATE ROLE openarc_test_elevated NOLOGIN CREATEDB');
      await admin.query('CREATE ROLE openarc_test_intermediate NOLOGIN');
      await admin.query('GRANT openarc_test_elevated TO openarc_test_intermediate');
      await admin.query('GRANT openarc_test_intermediate TO openarc_tenant_app');
      await expectCode(probe.readiness(), 'TENANT_STORE_UNAVAILABLE');
    } finally {
      await admin
        .query('REVOKE openarc_test_intermediate FROM openarc_tenant_app')
        .catch(() => {});
      await admin
        .query('REVOKE openarc_test_elevated FROM openarc_test_intermediate')
        .catch(() => {});
      await admin.query('DROP ROLE IF EXISTS openarc_test_intermediate').catch(() => {});
      await admin.query('DROP ROLE IF EXISTS openarc_test_elevated').catch(() => {});
    }
    await probe.readiness();
    assertPoolContextReleased();
  });
});

describe('TenantStore applied migration exactness', () => {
  it('rejects newer, mismatched, drifted and older metadata then restores it', async () => {
    const original = await admin.query<{ checksum: string }>(
      "SELECT checksum FROM openarc_meta.schema_migrations WHERE id = '0002_tenants'",
    );
    const checksum = original.rows[0]?.checksum;
    if (typeof checksum !== 'string') throw new Error('0002 checksum missing');
    const probe = new TenantStore(storePool);
    await probe.readiness();
    try {
      await admin.query(
        "INSERT INTO openarc_meta.schema_migrations (id, checksum) VALUES ('0003_future', 'deadbeef')",
      );
      await expectCode(probe.readiness(), 'TENANT_STORE_UNAVAILABLE');
      await admin.query(
        "DELETE FROM openarc_meta.schema_migrations WHERE id = '0003_future'",
      );

      await admin.query(
        "UPDATE openarc_meta.schema_migrations SET id = '0002_wrong' WHERE id = '0002_tenants'",
      );
      await expectCode(probe.readiness(), 'TENANT_STORE_UNAVAILABLE');
      await admin.query(
        "UPDATE openarc_meta.schema_migrations SET id = '0002_tenants' WHERE id = '0002_wrong'",
      );

      await admin.query(
        "UPDATE openarc_meta.schema_migrations SET checksum = 'drift' WHERE id = '0002_tenants'",
      );
      await expectCode(probe.readiness(), 'TENANT_STORE_UNAVAILABLE');

      await admin.query(
        "DELETE FROM openarc_meta.schema_migrations WHERE id = '0002_tenants'",
      );
      await expectCode(probe.readiness(), 'TENANT_STORE_UNAVAILABLE');
    } finally {
      await admin
        .query("DELETE FROM openarc_meta.schema_migrations WHERE id = '0003_future'")
        .catch(() => {});
      await admin
        .query("DELETE FROM openarc_meta.schema_migrations WHERE id = '0002_wrong'")
        .catch(() => {});
      await admin
        .query("DELETE FROM openarc_meta.schema_migrations WHERE id = '0002_tenants'")
        .catch(() => {});
      await admin
        .query(
          "INSERT INTO openarc_meta.schema_migrations (id, checksum) VALUES ('0002_tenants', $1)",
          [checksum],
        )
        .catch(() => {});
    }
    await probe.readiness();
    assertPoolContextReleased();
  });
});

describe('TenantStore post-wait authorization', () => {
  async function blockTable(table: string): Promise<PoolClient> {
    const blocker = await admin.connect();
    await blocker.query('BEGIN');
    await blocker.query(`LOCK TABLE openarc_tenant.${table} IN ACCESS EXCLUSIVE MODE`);
    return blocker;
  }

  async function finishBlocker(blocker: PoolClient): Promise<void> {
    // The owning test's finally performs the single release.
    await blocker.query('COMMIT');
  }

  it('rejects a bootstrap whose proof goes stale while the INSERT waits', async () => {
    const account = await seedAccount(70);
    const hash = sha256('session:70');
    await admin.query(
      `INSERT INTO openarc_auth.sessions (token_hash, account_id, method, created_at, expires_at)
       VALUES ($1, $2, 'passkey', now() - interval '4 minutes 58 seconds', now() + interval '1 hour')`,
      [hash, account],
    );
    const blocker = await blockTable('organizations');
    try {
      const pending = store.createOrganization(hash, 'Too Late');
      await waitForLockWait();
      await admin.query('SELECT pg_sleep(3)');
      await finishBlocker(blocker);
      await expectCode(pending, 'TENANT_STORE_SESSION_INVALID');
    } finally {
      await blocker.query('ROLLBACK').catch(() => {});
      blocker.release();
    }
    const organizations = await admin.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM openarc_tenant.organizations',
    );
    expect(organizations.rows[0]?.n).toBe(0);
    assertPoolContextReleased();
  });

  it('rejects a bootstrap whose session expires while the INSERT waits', async () => {
    const account = await seedAccount(71);
    const hash = sha256('session:71');
    await admin.query(
      `INSERT INTO openarc_auth.sessions (token_hash, account_id, method, created_at, expires_at)
       VALUES ($1, $2, 'passkey', now() - interval '1 minute', now() + interval '3 seconds')`,
      [hash, account],
    );
    const blocker = await blockTable('organizations');
    try {
      const pending = store.createOrganization(hash, 'Too Late');
      await waitForLockWait();
      await admin.query('SELECT pg_sleep(4)');
      await finishBlocker(blocker);
      await expectCode(pending, 'TENANT_STORE_SESSION_INVALID');
    } finally {
      await blocker.query('ROLLBACK').catch(() => {});
      blocker.release();
    }
    const organizations = await admin.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM openarc_tenant.organizations',
    );
    expect(organizations.rows[0]?.n).toBe(0);
    assertPoolContextReleased();
  });

  it('rejects an agent whose session expires while the INSERT waits', async () => {
    const owner = await seedOwner(72);
    await admin.query(
      "UPDATE openarc_auth.sessions SET expires_at = now() + interval '3 seconds' WHERE token_hash = $1",
      [owner.hash],
    );
    const blocker = await blockTable('agents');
    try {
      const pending = store.createAgent(owner.hash, owner.org, 'Late Agent');
      await waitForLockWait();
      await admin.query('SELECT pg_sleep(4)');
      await finishBlocker(blocker);
      await expectCode(pending, 'TENANT_STORE_SESSION_INVALID');
    } finally {
      await blocker.query('ROLLBACK').catch(() => {});
      blocker.release();
    }
    const agents = await admin.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM openarc_tenant.agents',
    );
    expect(agents.rows[0]?.n).toBe(0);
    assertPoolContextReleased();
  });

  it('rejects a provider whose session expires while the INSERT waits', async () => {
    const owner = await seedOwner(73);
    await admin.query(
      "UPDATE openarc_auth.sessions SET expires_at = now() + interval '3 seconds' WHERE token_hash = $1",
      [owner.hash],
    );
    const blocker = await blockTable('providers');
    try {
      const pending = store.createProvider(owner.hash, owner.org, 'Late Provider');
      await waitForLockWait();
      await admin.query('SELECT pg_sleep(4)');
      await finishBlocker(blocker);
      await expectCode(pending, 'TENANT_STORE_SESSION_INVALID');
    } finally {
      await blocker.query('ROLLBACK').catch(() => {});
      blocker.release();
    }
    const providers = await admin.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM openarc_tenant.providers',
    );
    expect(providers.rows[0]?.n).toBe(0);
    assertPoolContextReleased();
  });
});
