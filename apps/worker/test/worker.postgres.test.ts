import { createHash } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  CommerceSessionStore,
  ControlPolicyStore,
  CredentialStore,
  MarketStore,
  OutboxStore,
  TenantStore,
  createDatabasePool,
  migrate,
  type ClaimedOutboxEvent,
} from '@openarc/db';
import {
  adminPool,
  ensureRoles,
  migratorUrl,
  resetSchema,
  tenantUrl,
  workerUrl,
} from '../../../packages/db/test/postgres-fixture.js';
import { WorkerLoop, type WorkerLogRecord } from '../src/worker.js';
import { createHandlerRegistry, eventKeyOf, validateNotification } from '../src/handlers.js';

/**
 * Real PostgreSQL acceptance for the bounded tenant notification worker.
 *
 * The exhaustive helper/ACL/schema matrices are already proven by the frozen
 * packages/db postgres suites (postgres, postgres-boundaries, durability,
 * tenant-mutations); this suite reuses that evidence and does NOT clone those
 * assertions. It proves the worker-role path: legitimate durable tenant events
 * are consumed, concurrent workers split claims, a killed worker's lease is
 * reclaimed through the real DB clock, a stale generation cannot acknowledge,
 * exhausted attempts dead-letter, and a wrong role or stale schema fails
 * closed. Only the guarded disposable fixture database is reset.
 */

function sha256(seed: string): string {
  return createHash('sha256').update(`openarc-worker-test:${seed}`).digest('hex');
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function uuid(seed: number): string {
  return `00000000-0000-4000-8000-${String(seed).padStart(12, '0')}`;
}

function accountId(seed: number): string {
  return `openarc:account:${uuid(seed)}`;
}

function orgId(seed: number): string {
  return `openarc:org:${uuid(seed)}`;
}

function mutationId(seed: number): string {
  return uuid(100000 + seed);
}

function userHandle(seed: number): string {
  return `${sha256(`handle:${seed}`).slice(0, 42)}A`;
}

function base64Key(seed: number): string {
  return createHash('sha256').update(`key:${seed}`).digest().toString('base64url');
}

let admin: ReturnType<typeof adminPool>;
let migrator: ReturnType<typeof createDatabasePool>;
let tenant: ReturnType<typeof createDatabasePool>;
let worker: ReturnType<typeof createDatabasePool>;
let workerPeer: ReturnType<typeof createDatabasePool>;
let store: TenantStore;
let credentials: CredentialStore;
let outbox: OutboxStore;

beforeAll(async () => {
  admin = adminPool();
  await ensureRoles(admin);
  migrator = createDatabasePool(migratorUrl());
  tenant = createDatabasePool(tenantUrl());
  worker = createDatabasePool(workerUrl());
  workerPeer = createDatabasePool(workerUrl());
});

afterAll(async () => {
  try {
    await resetSchema(admin);
  } finally {
    await workerPeer.end();
    await worker.end();
    await tenant.end();
    await migrator.end();
    await admin.end();
  }
});

beforeEach(async () => {
  await resetSchema(admin);
  await migrate(migrator);
  store = new TenantStore(tenant);
  credentials = new CredentialStore(tenant);
  outbox = new OutboxStore(worker);
});

async function seedAccount(seed: number): Promise<string> {
  const id = accountId(seed);
  await admin.query(
    'INSERT INTO openarc_auth.accounts (account_id, user_handle, status) VALUES ($1, $2, $3)',
    [id, userHandle(seed), 'active'],
  );
  return id;
}

async function seedSession(seed: number, account: string): Promise<string> {
  const hash = sha256(`session:${seed}`);
  await admin.query(
    `INSERT INTO openarc_auth.sessions (token_hash, account_id, method, created_at, expires_at)
     VALUES ($1, $2, 'passkey', now(), now() + interval '24 hours')`,
    [hash, account],
  );
  return hash;
}

async function seedOrg(seed: number, creator: string): Promise<string> {
  const org = orgId(seed);
  await admin.query(
    "INSERT INTO openarc_tenant.organizations (organization_id, display_name, created_by) VALUES ($1, 'Worker Org', $2)",
    [org, creator],
  );
  return org;
}

async function seedMembership(org: string, account: string, role: string): Promise<void> {
  await admin.query(
    'INSERT INTO openarc_tenant.memberships (organization_id, account_id, role, status) VALUES ($1, $2, $3, $4)',
    [org, account, role, 'active'],
  );
}

interface SeededOwner {
  readonly account: string;
  readonly org: string;
  readonly hash: string;
}

async function seedOwner(seed: number): Promise<SeededOwner> {
  const account = await seedAccount(seed);
  const hash = await seedSession(seed, account);
  const org = await seedOrg(seed, account);
  await seedMembership(org, account, 'owner');
  return { account, org, hash };
}

describe('worker role consumes durable tenant notifications', () => {
  it('initializes the exact worker role and consumes a legitimate agent event', async () => {
    const owner = await seedOwner(1);
    await store.createAgentDurably(owner.hash, owner.org, 'Worker Agent', {
      idempotencyKey: base64Key(1),
      mutationId: mutationId(1),
    });

    await outbox.initialize();
    const claimed = await outbox.claim({ limit: 10 });
    expect(claimed).toHaveLength(1);
    const event = claimed[0] as ClaimedOutboxEvent;
    expect(event.resourceType).toBe('agent');
    expect(event.eventType).toBe('tenant.agent.created');
    expect(event.mutationId).toBe(mutationId(1));
    expect(event.attemptCount).toBe(1);

    const completed = await outbox.complete(event.eventId, event.leaseGeneration);
    expect(completed).toEqual({ applied: true });
    expect(await outbox.claim({ limit: 10 })).toHaveLength(0);
  });

  it('consumes a legitimate provider event', async () => {
    const owner = await seedOwner(2);
    await store.createProviderDurably(owner.hash, owner.org, 'Worker Provider', {
      idempotencyKey: base64Key(2),
      mutationId: mutationId(2),
    });
    await outbox.initialize();
    const [event] = await outbox.claim({ limit: 10 });
    expect(event?.resourceType).toBe('provider');
    expect(event?.eventType).toBe('tenant.provider.created');
    expect(await outbox.complete(event?.eventId, event?.leaseGeneration)).toEqual({ applied: true });
  });

  it('gives concurrent workers distinct claims', async () => {
    const owner = await seedOwner(3);
    await store.createAgentDurably(owner.hash, owner.org, 'Agent A', {
      idempotencyKey: base64Key(3),
      mutationId: mutationId(3),
    });
    await store.createAgentDurably(owner.hash, owner.org, 'Agent B', {
      idempotencyKey: base64Key(4),
      mutationId: mutationId(4),
    });

    const outboxA = new OutboxStore(worker);
    const outboxB = new OutboxStore(workerPeer);
    await outboxA.initialize();
    await outboxB.initialize();
    const [a, b] = await Promise.all([outboxA.claim({ limit: 10 }), outboxB.claim({ limit: 10 })]);
    const ids = [...a, ...b].map((event) => event.eventId);
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
    for (const event of [...a, ...b]) {
      expect(await outboxA.complete(event.eventId, event.leaseGeneration)).toEqual({ applied: true });
    }
  });

  it(
    'consumes a bounded 50-notification batch through the worker loop without artificial dead-letter',
    async () => {
      const owner = await seedOwner(4);
      for (let index = 0; index < 50; index += 1) {
        await store.createAgentDurably(owner.hash, owner.org, `Batch Agent ${index}`, {
          idempotencyKey: base64Key(4000 + index),
          mutationId: mutationId(4000 + index),
        });
      }

      await outbox.initialize();
      let claimed = 0;
      let completed = 0;
      let failed = 0;
      let stop: () => void = () => undefined;
      const loop = new WorkerLoop({
        store: outbox,
        claimLimit: 50,
        pollMs: 250,
        idleMaxMs: 1000,
        logger: {
          log: (record: WorkerLogRecord) => {
            if (record.status === 'claimed') claimed += record.count ?? 0;
            if (record.status === 'completed') completed += 1;
            if (
              record.status === 'failed' ||
              record.status === 'stale' ||
              record.status === 'outcome_unknown'
            ) {
              failed += 1;
            }
            if (record.status === 'claim_empty') stop();
          },
        },
      });
      stop = () => loop.requestStop();
      await loop.run();

      expect(claimed).toBe(50);
      expect(completed).toBe(50);
      expect(failed).toBe(0);
      const states = await admin.query<{ state: string }>(
        'SELECT state FROM openarc_durable.outbox_events WHERE organization_id = $1',
        [owner.org],
      );
      expect(states.rows).toHaveLength(50);
      expect(states.rows.every((row) => row.state === 'completed')).toBe(true);
    },
    30000,
  );

  it('reclaims a killed worker lease through the real clock and rejects a stale generation', async () => {
    const owner = await seedOwner(5);
    await store.createAgentDurably(owner.hash, owner.org, 'Reclaim Agent', {
      idempotencyKey: base64Key(5),
      mutationId: mutationId(5),
    });

    const killed = new OutboxStore(worker);
    await killed.initialize();
    const [first] = await killed.claim({ limit: 1 });
    expect(first).toBeDefined();
    const staleGeneration = first?.leaseGeneration ?? '';

    // Controlled fixture: age the still-leased row with admin SQL instead of a
    // 30s real sleep. This labels the observed durable lease, not a mock.
    await admin.query(
      `UPDATE openarc_durable.outbox_events
          SET lease_until = clock_timestamp() - interval '1 second'
        WHERE event_id = $1`,
      [first?.eventId],
    );

    const restarted = new OutboxStore(workerPeer);
    await restarted.initialize();
    const [second] = await restarted.claim({ limit: 1 });
    expect(second?.eventId).toBe(first?.eventId);
    expect(Number(second?.leaseGeneration)).toBe(Number(staleGeneration) + 1);
    expect(second?.attemptCount).toBe(2);

    // The killed worker's stale generation must never acknowledge the job.
    expect(await killed.complete(first?.eventId, staleGeneration)).toEqual({ applied: false });
    expect(await restarted.complete(second?.eventId, second?.leaseGeneration)).toEqual({
      applied: true,
    });
  });

  it('dead-letters an exhausted-lease final attempt', async () => {
    const owner = await seedOwner(6);
    await store.createAgentDurably(owner.hash, owner.org, 'Exhausted Agent', {
      idempotencyKey: base64Key(6),
      mutationId: mutationId(6),
    });
    await admin.query(
      `UPDATE openarc_durable.outbox_events
          SET state = 'leased',
              attempt_count = 5,
              lease_generation = lease_generation + 1,
              lease_until = clock_timestamp() - interval '1 second'
        WHERE mutation_id = $1::uuid`,
      [mutationId(6)],
    );

    await outbox.initialize();
    expect(await outbox.claim({ limit: 10 })).toHaveLength(0);
    const state = await admin.query<{ state: string; last_failure_code: string | null }>(
      'SELECT state, last_failure_code FROM openarc_durable.outbox_events WHERE mutation_id = $1::uuid',
      [mutationId(6)],
    );
    expect(state.rows[0]).toEqual({
      state: 'dead_letter',
      last_failure_code: 'attempts_exhausted',
    });
  });

  it('fails closed for a wrong role and a stale schema', async () => {
    const wrongRole = new OutboxStore(tenant);
    await expect(wrongRole.initialize()).rejects.toMatchObject({
      code: 'OUTBOX_STORE_UNAVAILABLE',
    });

    await admin.query("DELETE FROM openarc_meta.schema_migrations WHERE id = '0004_durable_tenant_mutations'");
    const stale = new OutboxStore(worker);
    await expect(stale.initialize()).rejects.toMatchObject({
      code: 'OUTBOX_STORE_UNAVAILABLE',
    });
  });

  it('denies direct durable DML to the worker role', async () => {
    await expect(worker.query('SELECT * FROM openarc_durable.outbox_events')).rejects.toBeTruthy();
    await expect(worker.query('SELECT * FROM openarc_durable.idempotency_records')).rejects.toBeTruthy();
    await expect(worker.query('SELECT * FROM openarc_durable.audit_events')).rejects.toBeTruthy();
    await expect(
      worker.query("UPDATE openarc_durable.outbox_events SET state = 'completed'"),
    ).rejects.toBeTruthy();
  });

  it('consumes all four notification-only credential events with only metadata', async () => {
    const owner = await seedOwner(20);
    const agent = 'openarc:agent:' + uuid(20);
    const provider = 'openarc:provider:' + uuid(20);
    await admin.query(
      "INSERT INTO openarc_tenant.agents (organization_id, agent_id, display_name) VALUES ($1, $2, 'Worker Agent')",
      [owner.org, agent],
    );
    await admin.query(
      "INSERT INTO openarc_tenant.providers (organization_id, provider_id, display_name) VALUES ($1, $2, 'Worker Provider')",
      [owner.org, provider],
    );
    const salt = Buffer.alloc(16, 5).toString('base64url');
    const digest = Buffer.alloc(32, 6).toString('base64url');
    const hash = {
      algorithm: 'scrypt' as const,
      hashVersion: 1 as const,
      pepperVersion: 1,
      N: 32768 as const,
      r: 8 as const,
      p: 1 as const,
      salt,
      digest,
    };
    await credentials.issueAgentCredentialDurably({
      sessionHash: owner.hash,
      organizationId: owner.org,
      profileId: agent,
      lookupId: uuid(500020),
      hash,
      expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
      metadata: { idempotencyKey: base64Key(20), mutationId: mutationId(20) },
    });
    await credentials.revokeAgentCredentialDurably({
      sessionHash: owner.hash,
      organizationId: owner.org,
      credentialId: mutationId(20),
      metadata: { idempotencyKey: base64Key(21), mutationId: mutationId(21) },
    });
    await credentials.issueProviderCredentialDurably({
      sessionHash: owner.hash,
      organizationId: owner.org,
      profileId: provider,
      lookupId: uuid(500022),
      hash,
      expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
      metadata: { idempotencyKey: base64Key(22), mutationId: mutationId(22) },
    });
    await credentials.revokeProviderCredentialDurably({
      sessionHash: owner.hash,
      organizationId: owner.org,
      credentialId: mutationId(22),
      metadata: { idempotencyKey: base64Key(23), mutationId: mutationId(23) },
    });

    await outbox.initialize();
    let claimed = 0;
    let completed = 0;
    let failed = 0;
    let stop: () => void = () => undefined;
    const loop = new WorkerLoop({
      store: outbox,
      claimLimit: 50,
      pollMs: 250,
      idleMaxMs: 1000,
      logger: {
        log: (record: WorkerLogRecord) => {
          if (record.status === 'claimed') claimed += record.count ?? 0;
          if (record.status === 'completed') completed += 1;
          if (record.status === 'failed' || record.status === 'stale' || record.status === 'outcome_unknown') {
            failed += 1;
          }
          if (record.status === 'claim_empty') stop();
        },
      },
    });
    stop = () => loop.requestStop();
    await loop.run();
    expect(claimed).toBe(4);
    expect(completed).toBe(4);
    expect(failed).toBe(0);
    const states = await admin.query<{ state: string; event_type: string }>(
      'SELECT state, event_type FROM openarc_durable.outbox_events WHERE organization_id = $1 ORDER BY event_type',
      [owner.org],
    );
    expect(states.rows.map((row) => row.event_type)).toEqual([
      'tenant.agent.credential.created',
      'tenant.agent.credential.revoked',
      'tenant.provider.credential.created',
      'tenant.provider.credential.revoked',
    ]);
    expect(states.rows.every((row) => row.state === 'completed')).toBe(true);
  });

  it('consumes the two new market listing notification events', async () => {
    const seed = 30;
    const account = accountId(seed);
    await admin.query(
      'INSERT INTO openarc_auth.accounts (account_id, user_handle) VALUES ($1, $2)',
      [account, userHandle(seed)],
    );
    const hash = sha256(`session:${seed}`);
    await admin.query(
      "INSERT INTO openarc_auth.sessions (token_hash, account_id, method, expires_at) VALUES ($1, $2, 'passkey', now() + interval '1 hour')",
      [hash, account],
    );
    const org = orgId(seed);
    await admin.query(
      "INSERT INTO openarc_tenant.organizations (organization_id, display_name, created_by) VALUES ($1, 'Worker Org', $2)",
      [org, account],
    );
    await admin.query(
      "INSERT INTO openarc_tenant.memberships (organization_id, account_id, role, status) VALUES ($1, $2, 'owner', 'active')",
      [org, account],
    );
    const provider = `openarc:provider:${uuid(seed + 1)}`;
    await admin.query(
      "INSERT INTO openarc_tenant.providers (organization_id, provider_id, display_name) VALUES ($1, $2, 'Worker Provider')",
      [org, provider],
    );
    const marketContent = {
      kind: 'api',
      title: 'Worker Listing',
      description: 'A bounded worker listing description',
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
        deliveryFields: ['payload'],
      },
      endpointContract: { origin: 'https://api.example.com', path: '/v1/run' },
      termsRevision: 'terms-v1',
      privacySummary: 'We store nothing.',
      paymentLane: 'unavailable',
      availability: { status: 'available', rateLimitPerMinute: '60' },
    };
    const market = new MarketStore(tenant);
    const draft = await market.createListingDraft(hash, org, provider, marketContent, {
      idempotencyKey: base64Key(30),
      mutationId: mutationId(30),
    });
    await market.createListingVersion(
      hash,
      org,
      draft.receipt.resourceId,
      { expectedLatestVersion: '1', content: marketContent },
      { idempotencyKey: base64Key(31), mutationId: mutationId(31) },
    );

    await outbox.initialize();
    const claimed = await outbox.claim({ limit: 50 });
    const marketEvents = claimed.filter(
      (event) => event.resourceType === 'listing' || event.resourceType === 'listing_version',
    );
    expect(marketEvents.map((event) => event.eventType).sort()).toEqual([
      'market.listing.created',
      'market.listing.version.created',
    ]);
    const registry = createHandlerRegistry();
    for (const event of marketEvents) {
      const key = eventKeyOf(event);
      expect(validateNotification(event)).toEqual(event);
      await registry[key](event, { signal: new AbortController().signal });
      expect((await outbox.complete(event.eventId, event.leaseGeneration)).applied).toBe(true);
    }
  });

  it('consumes the five control policy events from a real policy lifecycle without replay duplication', async () => {
    const seed = 40;
    const owner = await seedOwner(seed);
    const subjectAgent = 'openarc:agent:' + uuid(seed + 1);
    await admin.query(
      "INSERT INTO openarc_tenant.agents (organization_id, agent_id, display_name) VALUES ($1, $2, 'Policy Agent')",
      [owner.org, subjectAgent],
    );

    const content = {
      organizationId: owner.org,
      subjectAgentId: subjectAgent,
      networkId: 'eip155:5042002',
      asset: 'USDC',
      representation: 'erc20',
      decimals: 6,
      perActionLimit: '1000',
      rollingLimit: null,
      rollingWindowSeconds: null,
      feeLimit: '10',
      allowedProviderIds: [],
      allowedListingIds: [],
      approval: { mode: 'none', threshold: null, separateApprover: false },
      expiresAt: null,
    } as const;
    const metadata = (offset: number) => ({
      idempotencyKey: base64Key(seed * 100 + offset),
      mutationId: mutationId(seed * 100 + offset),
    });

    const policies = new ControlPolicyStore(tenant);
    await policies.initialize();

    // createPolicy(hash, org, content, metadata): the receipt carries the
    // canonical openarc:policy: UUID generated by the real store.
    const created = await policies.createPolicy(owner.hash, owner.org, content, metadata(1));
    const policyId = created.receipt.resourceId;
    expect(policyId).toMatch(
      /^openarc:policy:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );

    const root = await policies.getPolicyRoot(owner.hash, owner.org, policyId);
    expect(root.currentRevision).toBe('1');

    // appendPolicyRevision(hash, org, id, {expectedRevision, expectedUpdatedAt,
    // content}, metadata): revision 2 becomes POLICY_ID@2.
    const appended = await policies.appendPolicyRevision(
      owner.hash,
      owner.org,
      policyId,
      { expectedRevision: root.currentRevision, expectedUpdatedAt: root.updatedAt, content },
      metadata(2),
    );
    expect(appended.receipt.resourceId).toBe(`${policyId}@2`);

    let cursor = await policies.getPolicyRoot(owner.hash, owner.org, policyId);
    for (const operation of ['control.policy.pause', 'control.policy.resume', 'control.policy.revoke'] as const) {
      const transitioned = await policies.transitionPolicy(
        owner.hash,
        owner.org,
        policyId,
        {
          operation,
          expectedRevision: cursor.currentRevision,
          expectedUpdatedAt: cursor.updatedAt,
        },
        metadata(operation === 'control.policy.pause' ? 3 : operation === 'control.policy.resume' ? 4 : 5),
      );
      expect(transitioned.receipt.resourceId).toBe(policyId);
      cursor = await policies.getPolicyRoot(owner.hash, owner.org, policyId);
    }
    expect(cursor.status).toBe('revoked');

    await outbox.initialize();
    const claimed = await outbox.claim({ limit: 50 });
    expect(claimed).toHaveLength(5);
    const safeTuples = claimed
      .map((event) => `${event.resourceType}|${event.eventType}|${event.resourceId}`)
      .sort();
    expect(safeTuples).toEqual(
      [
        `budget_policy|control.policy.created|${policyId}`,
        `budget_policy_revision|control.policy.revision.created|${policyId}@2`,
        `budget_policy|control.policy.paused|${policyId}`,
        `budget_policy|control.policy.resumed|${policyId}`,
        `budget_policy|control.policy.revoked|${policyId}`,
      ].sort(),
    );

    const registry = createHandlerRegistry();
    const acknowledged = new Set<string>();
    for (const event of claimed) {
      expect(validateNotification(event)).toEqual(event);
      const key = eventKeyOf(event);
      await registry[key](event, { signal: new AbortController().signal });
      const result = await outbox.complete(event.eventId, event.leaseGeneration);
      expect(result).toEqual({ applied: true });
      acknowledged.add(event.eventId);
    }
    expect(acknowledged.size).toBe(5);

    // The durable rows are completed and a second claim replays nothing.
    expect(await outbox.claim({ limit: 50 })).toHaveLength(0);
    const states = await admin.query<{ state: string }>(
      'SELECT state FROM openarc_durable.outbox_events WHERE organization_id = $1',
      [owner.org],
    );
    expect(states.rows).toHaveLength(5);
    expect(states.rows.every((row) => row.state === 'completed')).toBe(true);
  });

  it('consumes the three commerce-session events derived from a real issue/exchange/revoke lifecycle', async () => {
    const seed = 60;
    const owner = await seedOwner(seed);
    const subjectAgent = 'openarc:agent:' + uuid(seed + 1);
    await admin.query(
      "INSERT INTO openarc_tenant.agents (organization_id, agent_id, display_name) VALUES ($1, $2, 'Session Agent')",
      [owner.org, subjectAgent],
    );

    const policyContent = {
      organizationId: owner.org,
      subjectAgentId: subjectAgent,
      networkId: 'eip155:5042002',
      asset: 'USDC',
      representation: 'erc20',
      decimals: 6,
      perActionLimit: '1000',
      rollingLimit: null,
      rollingWindowSeconds: null,
      feeLimit: '10',
      allowedProviderIds: [],
      allowedListingIds: [],
      approval: { mode: 'none', threshold: null, separateApprover: false },
      expiresAt: null,
    } as const;
    const metadata = (offset: number) => ({
      idempotencyKey: base64Key(seed * 100 + offset),
      mutationId: mutationId(seed * 100 + offset),
    });

    const policies = new ControlPolicyStore(tenant);
    await policies.initialize();
    const created = await policies.createPolicy(owner.hash, owner.org, policyContent, metadata(1));
    const policyId = created.receipt.resourceId;

    const salt = Buffer.alloc(16, 9).toString('base64url');
    const digest = Buffer.alloc(32, 10).toString('base64url');
    const hash = {
      algorithm: 'scrypt' as const,
      hashVersion: 1 as const,
      pepperVersion: 1,
      N: 32768 as const,
      r: 8 as const,
      p: 1 as const,
      salt,
      digest,
    };
    const issuedCredential = await credentials.issueAgentCredentialDurably({
      sessionHash: owner.hash,
      organizationId: owner.org,
      profileId: subjectAgent,
      lookupId: uuid(800060),
      hash,
      expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
      metadata: { idempotencyKey: base64Key(seed * 100 + 2), mutationId: mutationId(seed * 100 + 2) },
    });
    const machineTokenHash = sha256(`machine-session:${seed}`);
    await credentials.createAgentSession({
      organizationId: owner.org,
      profileId: subjectAgent,
      credentialId: issuedCredential.receipt.credentialId,
      expectedVersion: 1,
      sessionId: uuid(610060),
      tokenHash: machineTokenHash,
      expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
    });

    const sessions = new CommerceSessionStore(tenant);
    const handoffHash = sha256(`handoff:${seed}`);
    const issued = await sessions.issueCommerceSession(
      owner.hash,
      owner.org,
      { subjectAgentId: subjectAgent, policyId, handoffHash, hashVersion: 1 },
      metadata(10),
    );
    const sessionId = issued.receipt.resourceId;
    expect(sessionId).toBe(mutationId(seed * 100 + 10));
    const exchanged = await sessions.exchangeCommerceSession(
      machineTokenHash,
      handoffHash,
      { tokenHash: sha256(`session-token:${seed}`), hashVersion: 1 },
      metadata(11),
    );
    expect(exchanged.receipt.resourceId).toBe(sessionId);
    const revoked = await sessions.revokeCommerceSession(owner.hash, owner.org, sessionId, metadata(12));
    expect(revoked.receipt.resourceId).toBe(sessionId);

    await outbox.initialize();
    // The real worker loop claims, validates and consumes each fenced event once.
    // A thin recorder captures the raw claimed rows without altering the real
    // claim/fence path, so the loop still owns every claim and acknowledgement.
    const claimedRows: ClaimedOutboxEvent[] = [];
    const recordingStore = {
      claim: async (input?: { limit?: number }) => {
        const batch = await outbox.claim(input);
        claimedRows.push(...batch);
        return batch;
      },
      complete: (eventId: unknown, leaseGeneration: unknown) =>
        outbox.complete(eventId, leaseGeneration),
      fail: (eventId: unknown, leaseGeneration: unknown, code: unknown) =>
        outbox.fail(eventId, leaseGeneration, code),
    };
    const records: WorkerLogRecord[] = [];
    let stop: () => void = () => undefined;
    const loop = new WorkerLoop({
      store: recordingStore,
      claimLimit: 50,
      pollMs: 250,
      idleMaxMs: 1000,
      logger: {
        log: (record) => {
          records.push(record);
          if (record.status === 'claim_empty') stop();
        },
      },
    });
    stop = () => loop.requestStop();
    await loop.run();

    const sessionEvents = claimedRows.filter((event) => event.resourceType === 'commerce_session');
    expect(sessionEvents).toHaveLength(3);
    expect(
      sessionEvents.map((event) => `${event.eventType}|${event.resourceId}`).sort(),
    ).toEqual(
      [
        `control.commerce_session.issued|${sessionId}`,
        `control.commerce_session.exchanged|${sessionId}`,
        `control.commerce_session.revoked|${sessionId}`,
      ].sort(),
    );
    // Every commerce-session resource id is the canonical UUIDv4 session id and
    // every claim mutation id is a canonical UUID that matches the durable row.
    for (const event of sessionEvents) {
      expect(event.resourceId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );
      expect(event.mutationId).toMatch(UUID);
      expect(validateNotification(event)).toEqual(event);
    }
    const mutationByType = new Map(
      sessionEvents.map((event) => [event.eventType, event.mutationId]),
    );
    expect(mutationByType.get('control.commerce_session.issued')).toBe(mutationId(seed * 100 + 10));
    expect(mutationByType.get('control.commerce_session.exchanged')).toBe(mutationId(seed * 100 + 11));
    expect(mutationByType.get('control.commerce_session.revoked')).toBe(mutationId(seed * 100 + 12));

    const completedSession = records.filter(
      (record) => record.status === 'completed' && record.eventType?.startsWith('control.commerce_session.'),
    );
    expect(completedSession).toHaveLength(3);
    expect(records.some((record) => record.status === 'failed')).toBe(false);
    expect(completedSession.every((record) => record.count === 1)).toBe(true);
    // A second claim replays nothing: each job was acknowledged exactly once.
    expect(await outbox.claim({ limit: 50 })).toHaveLength(0);
    // The raw handoff and the machine/token hashes never leak into the emitted
    // event rows nor the bounded worker log records.
    const serializedLog = JSON.stringify(records);
    expect(serializedLog).not.toContain(handoffHash);
    expect(serializedLog).not.toContain(machineTokenHash);
    expect(serializedLog).not.toContain(sha256(`session-token:${seed}`));
    expect(serializedLog).not.toContain(sessionId);
    const durableRows = await admin.query<{ event_type: string; resource_id: string }>(
      `SELECT event_type, resource_id FROM openarc_durable.outbox_events
        WHERE organization_id = $1 AND resource_type = 'commerce_session'`,
      [owner.org],
    );
    expect(durableRows.rows).toHaveLength(3);
    const serializedRows = JSON.stringify(durableRows.rows);
    expect(serializedRows).not.toContain(handoffHash);
    expect(serializedRows).not.toContain(machineTokenHash);
    expect(durableRows.rows.every((row) => row.resource_id === sessionId)).toBe(true);
    const states = await admin.query<{ state: string }>(
      `SELECT state FROM openarc_durable.outbox_events
        WHERE organization_id = $1 AND resource_type = 'commerce_session'`,
      [owner.org],
    );
    expect(states.rows.every((row) => row.state === 'completed')).toBe(true);
  });
});
