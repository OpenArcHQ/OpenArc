import { createHash, randomBytes } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import {
  CommerceSessionStore,
  ControlGrantStore,
  ControlGrantStoreError,
  CredentialStore,
  MarketLifecycleStore,
  MarketStore,
  createDatabasePool,
  digestCommerceGrantToken,
  migrate,
  reviewedEndpointDigest,
} from '../src/index.js';
import {
  adminPool,
  ensureRoles,
  migratorUrl,
  resetSchema,
  tenantUrl,
} from './postgres-fixture.js';

/**
 * Privileged core-engine PG proofs for schema12 one-use authorization grants.
 *
 * Positive mechanics execute the migrator-only cores directly with the closed
 * mode 'internal_fixture'; the restricted tenant runtime only ever reaches the
 * literal 'production' wrappers, which reject that provenance. Nothing here is
 * production purchase, grant, payment, settlement or delivery evidence.
 */

const ORIGIN = 'https://api.example.com';
const PATH = '/v1/run';

function sha256(seed: string): string {
  return createHash('sha256').update(`openarc-grant-test:${seed}`, 'utf8').digest('hex');
}

function uuid(seed: number): string {
  return `40000000-0000-4000-8000-${String(seed).padStart(12, '0')}`;
}

function accountId(seed: number): string { return `openarc:account:${uuid(seed)}`; }
function orgId(seed: number): string { return `openarc:org:${uuid(seed)}`; }
function agentId(seed: number): string { return `openarc:agent:${uuid(seed)}`; }
function providerId(seed: number): string { return `openarc:provider:${uuid(seed)}`; }
function policyId(seed: number): string { return `openarc:policy:${uuid(seed)}`; }
function actionId(seed: number): string { return `openarc:action:${uuid(seed)}`; }
function requirementId(seed: number): string { return `openarc:requirement:${uuid(seed)}`; }
function grantId(mutation: string): string { return `openarc:grant:${mutation}`; }
function mutationId(seed: number): string { return uuid(700000 + seed); }
function actionMutation(seed: number): string { return uuid(850000 + seed); }
function grantMutation(seed: number): string { return uuid(880000 + seed); }
function lookupId(seed: number): string { return uuid(900000 + seed); }
function machineSessionId(seed: number): string { return uuid(600000 + seed); }
function providerSessionId(seed: number): string { return uuid(660000 + seed); }
function attemptId(seed: number): string { return uuid(770000 + seed); }

function key(seed: number): string {
  return createHash('sha256').update(`grant-key:${seed}`).digest().toString('base64url');
}

function userHandle(seed: number): string {
  return `${sha256(`handle:${seed}`).slice(0, 42)}A`;
}

/** A canonical raw oag_v1_ secret. It is generated here exactly as the trusted
 *  API would and is NEVER handed to the store or the database. */
function rawGrantToken(seed: number): string {
  const material = createHash('sha256').update(`grant-secret:${seed}`).digest();
  return `oag_v1_${material.toString('base64url')}`;
}

const SALT = Buffer.alloc(16, 7).toString('base64url');
const DIGEST = Buffer.alloc(32, 8).toString('base64url');

function hashInput() {
  return {
    algorithm: 'scrypt' as const,
    hashVersion: 1 as const,
    pepperVersion: 1,
    N: 32768 as const,
    r: 8 as const,
    p: 1 as const,
    salt: SALT,
    digest: DIGEST,
  };
}

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

let admin: Pool;
let migrator: ReturnType<typeof createDatabasePool>;
let tenant: ReturnType<typeof createDatabasePool>;
let store: ControlGrantStore;
let credentials: CredentialStore;
let commerce: CommerceSessionStore;
let market: MarketStore;
let lifecycle: MarketLifecycleStore;

beforeAll(async () => {
  admin = adminPool();
  await ensureRoles(admin);
  migrator = createDatabasePool(migratorUrl());
  tenant = createDatabasePool(tenantUrl());
});

afterAll(async () => {
  try {
    await resetSchema(admin);
  } finally {
    await tenant.end();
    await migrator.end();
    await admin.end();
  }
});

beforeEach(async () => {
  await resetSchema(admin);
  await migrate(migrator);
  store = new ControlGrantStore(tenant);
  credentials = new CredentialStore(tenant);
  commerce = new CommerceSessionStore(tenant);
  market = new MarketStore(tenant);
  lifecycle = new MarketLifecycleStore(tenant);
});

interface Owner {
  readonly account: string;
  readonly hash: string;
  readonly org: string;
}

async function seedAccount(seed: number, status = 'active'): Promise<string> {
  const id = accountId(seed);
  await admin.query(
    'INSERT INTO openarc_auth.accounts (account_id, user_handle, status) VALUES ($1, $2, $3)',
    [id, userHandle(seed), status],
  );
  return id;
}

async function seedSession(seed: number, account: string, method = 'passkey'): Promise<string> {
  const hash = sha256(`session:${seed}`);
  await admin.query(
    `INSERT INTO openarc_auth.sessions (token_hash, account_id, method, created_at, expires_at)
     VALUES ($1, $2, $3, now(), now() + interval '24 hours')`,
    [hash, account, method],
  );
  return hash;
}

async function seedOwner(seed: number, role = 'owner'): Promise<Owner> {
  const account = await seedAccount(seed);
  const hash = await seedSession(seed, account);
  const org = orgId(seed);
  await admin.query(
    "INSERT INTO openarc_tenant.organizations (organization_id, display_name, created_by) VALUES ($1, 'Org', $2)",
    [org, account],
  );
  await admin.query(
    'INSERT INTO openarc_tenant.memberships (organization_id, account_id, role, status) VALUES ($1, $2, $3, $4)',
    [org, account, role, 'active'],
  );
  return { account, hash, org };
}

async function seedAgent(seed: number, org: string): Promise<string> {
  const id = agentId(seed);
  await admin.query(
    'INSERT INTO openarc_tenant.agents (organization_id, agent_id, display_name, status) VALUES ($1, $2, $3, $4)',
    [org, id, `Agent ${seed}`, 'active'],
  );
  return id;
}

async function seedProvider(seed: number, org: string): Promise<string> {
  const id = providerId(seed);
  await admin.query(
    'INSERT INTO openarc_tenant.providers (organization_id, provider_id, display_name, status) VALUES ($1, $2, $3, $4)',
    [org, id, `Provider ${seed}`, 'active'],
  );
  return id;
}

async function seedPolicy(
  org: string,
  subject: string,
  seed: number,
  provider: string,
): Promise<string> {
  const id = policyId(seed);
  const client = await admin.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO openarc_tenant.budget_policy_roots
         (organization_id, policy_id, subject_agent_id, current_revision, status)
       VALUES ($1, $2, $3, '1', 'active')`,
      [org, id, subject],
    );
    await client.query(
      `INSERT INTO openarc_tenant.budget_policy_versions
         (organization_id, policy_id, revision, subject_agent_id, network_id, asset,
          representation, decimals, per_action_limit, rolling_limit, rolling_window_seconds,
          fee_limit, allowed_provider_ids, allowed_listing_ids, approval_mode,
          approval_threshold, approval_separate_approver, expires_at, digest)
       VALUES ($1, $2, '1', $3, 'eip155:5042002', 'USDC', 'erc20', 6, '5000000', '5000000',
               '3600', '0', ARRAY[$4]::text[], ARRAY[]::text[], 'none', NULL, false,
               clock_timestamp() + interval '1 hour', 'sha256:' || repeat('a', 64))`,
      [org, id, subject, provider],
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
  return id;
}

async function seedMachine(owner: Owner, seed: number, agent: string): Promise<string> {
  const issued = await credentials.issueAgentCredentialDurably({
    sessionHash: owner.hash,
    organizationId: owner.org,
    profileId: agent,
    lookupId: lookupId(seed),
    hash: hashInput(),
    expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(),
    metadata: { idempotencyKey: key(500000 + seed), mutationId: mutationId(500000 + seed) },
  });
  const agentSessionHash = sha256(`machine:${seed}`);
  await credentials.createAgentSession({
    organizationId: owner.org,
    profileId: agent,
    credentialId: issued.receipt.credentialId,
    expectedVersion: 1,
    sessionId: machineSessionId(seed),
    tokenHash: agentSessionHash,
    expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
  });
  return agentSessionHash;
}

/** A live oas_pr_ provider session under the EXISTING provider:self.read scope.
 *  No scope, credential or endpoint is widened for the grant surface. */
async function seedProviderSession(
  seller: Owner,
  provider: string,
  seed: number,
): Promise<string> {
  const issued = await credentials.issueProviderCredentialDurably({
    sessionHash: seller.hash,
    organizationId: seller.org,
    profileId: provider,
    lookupId: lookupId(4000 + seed),
    hash: hashInput(),
    expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(),
    metadata: { idempotencyKey: key(600000 + seed), mutationId: mutationId(600000 + seed) },
  });
  const tokenHash = sha256(`provider-session:${seed}`);
  await credentials.createProviderSession({
    organizationId: seller.org,
    profileId: provider,
    credentialId: issued.receipt.credentialId,
    expectedVersion: 1,
    sessionId: providerSessionId(seed),
    tokenHash,
    expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
  });
  return tokenHash;
}

/** A SECOND live session for the SAME provider credential, used to prove that
 *  historical recovery works for a new session of the same provider. */
async function seedExtraProviderSession(
  seller: Owner,
  provider: string,
  seed: number,
): Promise<string> {
  const credential = await admin.query<{ credential_id: string }>(
    `SELECT credential_id FROM openarc_durable.provider_credentials
      WHERE organization_id = $1 AND provider_id = $2 AND revoked_at IS NULL`,
    [seller.org, provider],
  );
  const tokenHash = sha256(`provider-session-extra:${seed}`);
  await credentials.createProviderSession({
    organizationId: seller.org,
    profileId: provider,
    credentialId: credential.rows[0]!.credential_id,
    expectedVersion: 1,
    sessionId: providerSessionId(50000 + seed),
    tokenHash,
    expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
  });
  return tokenHash;
}

async function seedPublishedListing(owner: Owner, provider: string, seed: number): Promise<string> {
  const draft = await market.createListingDraft(owner.hash, owner.org, provider, content(), {
    idempotencyKey: key(seed),
    mutationId: mutationId(seed),
  });
  const listing = draft.receipt.resourceId;
  const digest = reviewedEndpointDigest({ listingId: listing, version: '1', origin: ORIGIN, path: PATH });
  const s0 = await admin.query<{ updated_at: string }>(
    "SELECT to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') AS updated_at FROM openarc_tenant.listing_version_states WHERE organization_id = $1 AND listing_id = $2 AND version = '1'",
    [owner.org, listing],
  );
  const moderatorAccount = await seedAccount(seed + 8000);
  const moderatorHash = await seedSession(seed + 8000, moderatorAccount);
  await admin.query(
    "INSERT INTO openarc_tenant.market_moderator_grants (account_id, status) VALUES ($1, 'active')",
    [moderatorAccount],
  );
  await lifecycle.recordOriginReview(
    moderatorHash, owner.org, listing, '1',
    {
      expectedUpdatedAt: s0.rows[0]!.updated_at,
      decision: 'approved',
      reviewedEndpointDigest: digest,
      reasonCode: 'manual_review',
      reasonDigest: null,
    },
    { idempotencyKey: key(seed + 9000), mutationId: mutationId(seed + 9000) },
  );
  const s1 = await admin.query<{ updated_at: string }>(
    "SELECT to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') AS updated_at FROM openarc_tenant.listing_version_states WHERE organization_id = $1 AND listing_id = $2 AND version = '1'",
    [owner.org, listing],
  );
  await lifecycle.publishListingVersion(
    owner.hash, owner.org, listing, '1',
    { expectedUpdatedAt: s1.rows[0]!.updated_at, expectedActiveVersion: null },
    { idempotencyKey: key(seed + 1), mutationId: mutationId(seed + 1) },
  );
  return listing;
}

interface Chain {
  readonly buyer: Owner;
  readonly seller: Owner;
  readonly agent: string;
  readonly provider: string;
  readonly listing: string;
  readonly policy: string;
  readonly commerceTokenHash: string;
  readonly agentSessionHash: string;
  readonly seed: number;
}

/** Buyer A buys seller B's real published, origin-approved listing. The buyer
 *  holds NO membership in the seller organization. */
async function seedCrossChain(buyerSeed: number, sellerSeed: number): Promise<Chain> {
  const buyer = await seedOwner(buyerSeed);
  const seller = await seedOwner(sellerSeed);
  const agent = await seedAgent(buyerSeed, buyer.org);
  const provider = await seedProvider(sellerSeed, seller.org);
  const listing = await seedPublishedListing(seller, provider, sellerSeed);
  const policy = await seedPolicy(buyer.org, agent, buyerSeed, provider);
  const agentSessionHash = await seedMachine(buyer, buyerSeed, agent);
  const handoffHash = sha256(`handoff:${buyerSeed}`);
  const commerceTokenHash = sha256(`commerce:${buyerSeed}`);
  await commerce.issueCommerceSession(
    buyer.hash, buyer.org,
    { subjectAgentId: agent, policyId: policy, handoffHash, hashVersion: 1 },
    { idempotencyKey: key(100000 + buyerSeed), mutationId: mutationId(100000 + buyerSeed) },
  );
  await commerce.exchangeCommerceSession(
    agentSessionHash, handoffHash,
    { tokenHash: commerceTokenHash, hashVersion: 1 },
    { idempotencyKey: key(200000 + buyerSeed), mutationId: mutationId(200000 + buyerSeed) },
  );
  return { buyer, seller, agent, provider, listing, policy, commerceTokenHash, agentSessionHash, seed: buyerSeed };
}

async function seedRequirement(chain: Chain, seed: number): Promise<string> {
  const id = requirementId(seed);
  await admin.query(
    `INSERT INTO openarc_durable.commerce_requirement_references (
       organization_id, requirement_id, seller_organization_id, provider_id, listing_id,
       listing_version, network_id, asset, representation, decimals, amount_atomic,
       fee_atomic, requirement_digest, source_kind, created_at, valid_until)
     VALUES ($1, $2, $3, $4, $5, '1', 'eip155:5042002', 'USDC', 'erc20', 6, '1000000', '0',
             'sha256:' || repeat('c', 64), 'internal_fixture', clock_timestamp(),
             clock_timestamp() + interval '30 minutes')`,
    [chain.buyer.org, id, chain.seller.org, chain.provider, chain.listing],
  );
  return id;
}

const HEX_A = 'a'.repeat(64);
const HEX_B = 'b'.repeat(64);
const HEX_C = 'c'.repeat(64);
const HEX_D = 'd'.repeat(64);

function contextDigest(domain: string, hash: string): string {
  return createHash('sha256').update(`${domain}:${hash}`, 'utf8').digest('hex');
}

async function coreAuthorize(chain: Chain, requirement: string, action: string) {
  const keyHash = createHash('sha256').update(key(chain.seed + 300000), 'utf8').digest('hex');
  return migrator.query(
    `SELECT * FROM openarc_durable.authorize_commerce_action_core(
       'internal_fixture', $1, $2, $3, $4::uuid, $5, $6, $7)`,
    [
      chain.commerceTokenHash, requirement, action, actionMutation(chain.seed), keyHash, HEX_A,
      contextDigest('openarc.control.commerce_action.authorize.session.v1', chain.commerceTokenHash),
    ],
  );
}

interface CoreMeta {
  readonly mutation?: string;
  readonly keyHash?: string;
  readonly digest?: string;
  readonly context?: string;
}

function coreIssue(chain: Chain, action: string, tokenHash: string, meta: CoreMeta = {}) {
  return migrator.query(
    `SELECT *, out_issued_at::text AS issued_text, out_expires_at::text AS expires_text,
            extract(epoch FROM (out_expires_at - out_issued_at))::float8 AS lifetime_seconds
       FROM openarc_durable.issue_authorization_grant_core(
         'internal_fixture', $1, $2, $3, 1, $4::uuid, $5, $6, $7)`,
    [
      chain.commerceTokenHash, action, tokenHash,
      meta.mutation ?? grantMutation(chain.seed), meta.keyHash ?? HEX_B,
      meta.digest ?? HEX_C, meta.context ?? HEX_D,
    ],
  );
}

function coreReplace(chain: Chain, grant: string, tokenHash: string, meta: CoreMeta = {}) {
  return migrator.query(
    `SELECT *, extract(epoch FROM (out_expires_at - out_issued_at))::float8 AS lifetime_seconds
       FROM openarc_durable.replace_authorization_grant_core(
         'internal_fixture', $1, $2, $3, 1, $4::uuid, $5, $6, $7)`,
    [
      chain.commerceTokenHash, grant, tokenHash,
      meta.mutation ?? grantMutation(90000 + chain.seed), meta.keyHash ?? HEX_A,
      meta.digest ?? HEX_C, meta.context ?? HEX_D,
    ],
  );
}

function coreIntrospect(providerSessionHash: string, grantTokenHash: string) {
  return migrator.query(
    `SELECT * FROM openarc_durable.introspect_authorization_grant_core(
       'internal_fixture', $1, $2)`,
    [providerSessionHash, grantTokenHash],
  );
}

function coreClaim(
  providerSessionHash: string,
  grantTokenHash: string,
  action: string,
  attempt: string,
  meta: CoreMeta = {},
  pool: ReturnType<typeof createDatabasePool> = migrator,
) {
  return pool.query(
    `SELECT * FROM openarc_durable.claim_authorization_grant_core(
       'internal_fixture', $1, $2, $3, $4::uuid, $5::uuid, $6, $7, $8)`,
    [
      providerSessionHash, grantTokenHash, action, attempt,
      meta.mutation ?? grantMutation(91000), meta.keyHash ?? HEX_B,
      meta.digest ?? HEX_C, meta.context ?? HEX_D,
    ],
  );
}

async function rawError(promise: Promise<unknown>): Promise<{ code?: string }> {
  try {
    await promise;
  } catch (error) {
    return error as { code?: string };
  }
  throw new Error('expected a rejection');
}

async function expectStoreCode(promise: Promise<unknown>, code: string): Promise<void> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(ControlGrantStoreError);
    expect((error as ControlGrantStoreError).code).toBe(code);
    return;
  }
  throw new Error(`expected ControlGrantStoreError ${code}`);
}

async function counts(): Promise<Record<string, number>> {
  const result = await admin.query<Record<string, number>>(
    `SELECT (SELECT count(*)::int FROM openarc_durable.authorization_grants) AS grants,
            (SELECT count(*)::int FROM openarc_durable.authorization_grant_tokens) AS tokens,
            (SELECT count(*)::int FROM openarc_durable.authorization_grant_claims) AS claims,
            (SELECT count(*)::int FROM openarc_durable.budget_reservations) AS reservations,
            (SELECT count(*)::int FROM openarc_durable.budget_events WHERE event_kind = 'released') AS released,
            (SELECT count(*)::int FROM openarc_durable.idempotency_records
              WHERE operation LIKE 'control.grant.%') AS idem,
            (SELECT count(*)::int FROM openarc_durable.outbox_events
              WHERE resource_type = 'authorization_grant') AS outbox,
            (SELECT count(*)::int FROM openarc_durable.audit_events
              WHERE resource_type = 'authorization_grant') AS audit`,
  );
  return result.rows[0]!;
}

async function grantRow(grant: string) {
  const result = await admin.query<Record<string, unknown>>(
    'SELECT * FROM openarc_durable.authorization_grants WHERE grant_id = $1',
    [grant],
  );
  return result.rows[0];
}

async function actionStatus(action: string): Promise<string | undefined> {
  const result = await admin.query<{ status: string }>(
    'SELECT status FROM openarc_durable.commerce_actions WHERE action_id = $1',
    [action],
  );
  return result.rows[0]?.status;
}

async function reservationRow(action: string) {
  const result = await admin.query<Record<string, unknown>>(
    'SELECT * FROM openarc_durable.budget_reservations WHERE action_id = $1',
    [action],
  );
  return result.rows[0];
}

/** An issued, unclaimed grant over a real reserved cross-organization action. */
interface Issued {
  readonly chain: Chain;
  readonly action: string;
  readonly grant: string;
  readonly raw: string;
  readonly tokenHash: string;
  readonly providerSessionHash: string;
}

async function seedIssuedGrant(buyerSeed: number, sellerSeed: number): Promise<Issued> {
  const chain = await seedCrossChain(buyerSeed, sellerSeed);
  const requirement = await seedRequirement(chain, buyerSeed);
  const action = actionId(buyerSeed);
  await coreAuthorize(chain, requirement, action);
  const raw = rawGrantToken(buyerSeed);
  const tokenHash = digestCommerceGrantToken(raw);
  const issued = await coreIssue(chain, action, tokenHash);
  const providerSessionHash = await seedProviderSession(chain.seller, chain.provider, sellerSeed);
  return {
    chain,
    action,
    grant: issued.rows[0]!.out_grant_id as string,
    raw,
    tokenHash,
    providerSessionHash,
  };
}

describe('schema12 manifest, ownership and ACLs', () => {
  it('records schema12 and keeps the runtime denied on the grant tables and cores', async () => {
    const applied = await admin.query<{ id: string }>(
      'SELECT id FROM openarc_meta.schema_migrations ORDER BY id',
    );
    expect(applied.rows.map((row) => row.id)).toEqual([
      '0001_auth',
      '0002_tenants',
      '0003_durability',
      '0004_durable_tenant_mutations',
      '0005_machine_credentials',
      '0006_market',
      '0007_market_lifecycle',
      '0008_control_policies',
      '0009_control_sessions',
      '0010_control_actions',
      '0011_control_action_reads',
      '0012_authorization_grants',
    ]);
    const tables = await admin.query<{ n: number; enabled: boolean; forced: boolean }>(
      `SELECT count(*)::int AS n, bool_and(c.relrowsecurity) AS enabled,
              bool_and(c.relforcerowsecurity) AS forced
         FROM pg_class c JOIN pg_namespace ns ON ns.oid = c.relnamespace
        WHERE ns.nspname = 'openarc_durable' AND c.relkind = 'r'
          AND c.relname IN ('authorization_grants', 'authorization_grant_tokens',
                            'authorization_grant_claims')`,
    );
    expect(tables.rows[0]).toMatchObject({ n: 3, enabled: true, forced: true });
    for (const table of ['authorization_grants', 'authorization_grant_tokens', 'authorization_grant_claims']) {
      expect((await rawError(tenant.query(`SELECT count(*) FROM openarc_durable.${table}`))).code)
        .toBe('42501');
    }
    // No closed core, lock chain or digest helper is reachable from runtime.
    for (const call of [
      `SELECT * FROM openarc_durable.issue_authorization_grant_core('internal_fixture', $1, $2, $3, 1, $4::uuid, $5, $6, $7)`,
      `SELECT * FROM openarc_durable.claim_authorization_grant_core('internal_fixture', $1, $2, $3, $4::uuid, $4::uuid, $5, $6, $7)`,
    ]) {
      const error = await rawError(
        tenant.query(call, [HEX_A, actionId(1), HEX_B, uuid(1), HEX_C, HEX_D, HEX_A]),
      );
      expect(error.code).toBeTruthy();
    }
    const chains = await rawError(
      tenant.query('SELECT * FROM openarc_durable.lock_grant_provider_chain($1, $2)', [HEX_A, grantId(uuid(1))]),
    );
    expect(chains.code).toBeTruthy();
    expect((await counts()).grants).toBe(0);
  });

  it('starts with zero grant, token and claim rows', async () => {
    expect(await counts()).toMatchObject({ grants: 0, tokens: 0, claims: 0 });
  });

  it('initializes and re-checks readiness for the restricted tenant runtime', async () => {
    await store.initialize();
    await store.readiness();
    // A PUBLIC EXECUTE grant on a closed core is a readiness failure, not a
    // silently widened surface.
    await migrator.query(
      `GRANT EXECUTE ON FUNCTION openarc_durable.claim_authorization_grant_core(
         text, text, text, text, uuid, uuid, text, text, text) TO PUBLIC`,
    );
    await expectStoreCode(new ControlGrantStore(tenant).readiness(), 'CONTROL_GRANT_STORE_UNAVAILABLE');
    await migrator.query(
      `REVOKE EXECUTE ON FUNCTION openarc_durable.claim_authorization_grant_core(
         text, text, text, text, uuid, uuid, text, text, text) FROM PUBLIC`,
    );
    await new ControlGrantStore(tenant).readiness();
  }, 60000);
});

describe('issue on a reserved action', () => {
  it('moves the action reserved_not_granted -> grant_issued and stores one hash generation', async () => {
    const chain = await seedCrossChain(10, 1010);
    const requirement = await seedRequirement(chain, 10);
    const action = actionId(10);
    const authorized = await coreAuthorize(chain, requirement, action);
    expect(authorized.rows[0]).toMatchObject({ out_status: 'reserved_not_granted' });
    expect(await actionStatus(action)).toBe('reserved_not_granted');

    const raw = rawGrantToken(10);
    const tokenHash = digestCommerceGrantToken(raw);
    const result = await coreIssue(chain, action, tokenHash);
    const row = result.rows[0]!;
    expect(row).toMatchObject({
      out_replayed: false,
      out_status: 'issued',
      out_generation: 1,
      out_action_id: action,
      out_organization_id: chain.buyer.org,
      out_provider_id: chain.provider,
      out_claimed_at: null,
      out_revoked_at: null,
    });
    // Grant ids derive from the first-issue mutation id.
    expect(row['out_grant_id']).toBe(grantId(grantMutation(chain.seed)));
    expect(await actionStatus(action)).toBe('grant_issued');
    const reservation = await reservationRow(action);
    expect(reservation).toMatchObject({ status: 'held', claimed_at: null });
    expect(await counts()).toMatchObject({
      grants: 1, tokens: 1, claims: 0, reservations: 1, idem: 1, outbox: 1, audit: 1,
    });
    const token = await admin.query<{ generation: number; hash_version: number; retired_at: unknown; token_hash: string }>(
      'SELECT generation, hash_version, retired_at, token_hash FROM openarc_durable.authorization_grant_tokens',
    );
    expect(token.rows[0]).toMatchObject({ generation: 1, hash_version: 1, retired_at: null, token_hash: tokenHash });
  });

  it('refuses a second issue for the same action and creates no second reservation', async () => {
    const chain = await seedCrossChain(11, 1011);
    const requirement = await seedRequirement(chain, 11);
    const action = actionId(11);
    await coreAuthorize(chain, requirement, action);
    await coreIssue(chain, action, digestCommerceGrantToken(rawGrantToken(11)));

    // A genuinely different idempotency key and mutation id must still fail.
    const error = await rawError(
      coreIssue(chain, action, digestCommerceGrantToken(rawGrantToken(9911)), {
        mutation: grantMutation(9911), keyHash: HEX_A,
      }),
    );
    expect(error.code).toBe('P0D14');
    expect(await counts()).toMatchObject({ grants: 1, tokens: 1, reservations: 1, idem: 1 });
    expect(await actionStatus(action)).toBe('grant_issued');
  });

  it('bounds validity at 300 seconds and lets a shorter chain of authority win', async () => {
    const chain = await seedCrossChain(12, 1012);
    const requirement = await seedRequirement(chain, 12);
    const action = actionId(12);
    await coreAuthorize(chain, requirement, action);

    // The hard ceiling is a SQL CHECK, not merely an application computation:
    // a privileged migrator insert of a 301-second window is rejected.
    const overCeiling = await rawError(migrator.query(
      `INSERT INTO openarc_durable.authorization_grants (
         organization_id, grant_id, action_id, reservation_id, subject_agent_id,
         commerce_session_id, seller_organization_id, provider_id, listing_id,
         listing_version, requirement_id, source_kind, current_generation, status,
         issued_at, updated_at, expires_at)
       SELECT a.organization_id, $2, a.action_id, a.reservation_id, a.subject_agent_id,
              a.commerce_session_id, a.seller_organization_id, a.provider_id, a.listing_id,
              a.listing_version, a.requirement_id, a.source_kind, 1, 'issued',
              clock_timestamp(), clock_timestamp(), clock_timestamp() + interval '301 seconds'
         FROM openarc_durable.commerce_actions a WHERE a.action_id = $1`,
      [action, grantId(uuid(999012))],
    ));
    expect(overCeiling.code).toBe('23514');
    expect(await counts()).toMatchObject({ grants: 0 });

    const ceiling = await coreIssue(chain, action, digestCommerceGrantToken(rawGrantToken(12)));
    const ceilingLifetime = ceiling.rows[0]!['lifetime_seconds'] as number;
    expect(ceilingLifetime).toBeLessThanOrEqual(300);
    expect(ceilingLifetime).toBeGreaterThan(290);

    // A second buyer whose machine session expires inside the ceiling.
    const short = await seedCrossChain(13, 1013);
    const shortRequirement = await seedRequirement(short, 13);
    const shortAction = actionId(13);
    await coreAuthorize(short, shortRequirement, shortAction);
    await admin.query(
      `UPDATE openarc_durable.agent_sessions
          SET expires_at = clock_timestamp() + interval '30 seconds'
        WHERE session_id = $1`,
      [machineSessionId(13)],
    );
    const bounded = await coreIssue(short, shortAction, digestCommerceGrantToken(rawGrantToken(13)));
    const lifetime = bounded.rows[0]!['lifetime_seconds'] as number;
    expect(lifetime).toBeLessThanOrEqual(30);
    expect(lifetime).toBeGreaterThan(0);
  });
});

describe('explicit SQL transition control', () => {
  it('permits exactly the two grant edges and never mislabels a live grant', async () => {
    const chain = await seedCrossChain(15, 1015);
    const requirement = await seedRequirement(chain, 15);
    const action = actionId(15);
    await coreAuthorize(chain, requirement, action);

    // The grant_issued label can never be minted without a real grant row.
    const orphan = await rawError(migrator.query(
      `UPDATE openarc_durable.commerce_actions
          SET status = 'grant_issued', updated_at = clock_timestamp()
        WHERE action_id = $1`,
      [action],
    ));
    expect(orphan.code).toBe('23514');
    expect(await actionStatus(action)).toBe('reserved_not_granted');

    const issued = await coreIssue(chain, action, digestCommerceGrantToken(rawGrantToken(15)));
    const grant = issued.rows[0]!.out_grant_id as string;
    expect(await actionStatus(action)).toBe('grant_issued');

    // The accepted schema10 cancel core fails closed for a granted action:
    // grant revoke owns the safe cleanup path.
    const cancelled = await rawError(migrator.query(
      `SELECT * FROM openarc_durable.cancel_commerce_action_core($1, $2, $3, $4::uuid, $5, $6, $7)`,
      [chain.buyer.hash, chain.buyer.org, action, grantMutation(7015), HEX_A, HEX_B, HEX_C],
    ));
    expect(cancelled.code).toBe('23514');
    expect(await actionStatus(action)).toBe('grant_issued');

    // A privileged cancel while the grant is still live is refused too.
    const live = await rawError(migrator.query(
      `UPDATE openarc_durable.commerce_actions
          SET status = 'cancelled', updated_at = clock_timestamp()
        WHERE action_id = $1`,
      [action],
    ));
    expect(live.code).toBe('23514');

    // Every other edge out of grant_issued stays closed.
    for (const target of ['reserved_not_granted', 'pending_approval', 'rejected', 'expired']) {
      const blocked = await rawError(migrator.query(
        `UPDATE openarc_durable.commerce_actions
            SET status = $2, updated_at = clock_timestamp()
          WHERE action_id = $1`,
        [action, target],
      ));
      expect(blocked.code).toBe('23514');
    }
    // The grant's own identity, reservation association and expiry are immutable.
    for (const mutation of [
      `UPDATE openarc_durable.authorization_grants SET expires_at = expires_at + interval '60 seconds', updated_at = clock_timestamp() WHERE grant_id = $1`,
      `UPDATE openarc_durable.authorization_grants SET reservation_id = 'openarc:reservation:00000000-0000-4000-8000-0000000000ff', updated_at = clock_timestamp() WHERE grant_id = $1`,
      `DELETE FROM openarc_durable.authorization_grants WHERE grant_id = $1`,
      `UPDATE openarc_durable.authorization_grant_tokens SET token_hash = repeat('f', 64) WHERE grant_id = $1`,
    ]) {
      const error = await rawError(migrator.query(mutation, [grant]));
      expect(error.code).toBe('42501');
    }
    expect(await actionStatus(action)).toBe('grant_issued');
    expect((await grantRow(grant))!['status']).toBe('issued');
  }, 60000);
});

describe('replacement before any claim or exposure', () => {
  it('retires the old generation, mints the next and never extends the expiry', async () => {
    const issued = await seedIssuedGrant(20, 1020);
    const before = await grantRow(issued.grant);
    const nextRaw = rawGrantToken(9020);
    const nextHash = digestCommerceGrantToken(nextRaw);
    const replaced = await coreReplace(issued.chain, issued.grant, nextHash);
    expect(replaced.rows[0]).toMatchObject({
      out_replayed: false, out_generation: 2, out_status: 'issued', out_grant_id: issued.grant,
    });
    // Same grant, same reservation, IDENTICAL expiry: never extended.
    const after = await grantRow(issued.grant);
    expect(after!['expires_at']).toEqual(before!['expires_at']);
    expect(after!['issued_at']).toEqual(before!['issued_at']);
    expect(after!['reservation_id']).toEqual(before!['reservation_id']);

    const tokens = await admin.query<{ generation: number; retired_at: unknown; token_hash: string }>(
      'SELECT generation, retired_at, token_hash FROM openarc_durable.authorization_grant_tokens ORDER BY generation',
    );
    expect(tokens.rows).toHaveLength(2);
    expect(tokens.rows[0]).toMatchObject({ generation: 1, token_hash: issued.tokenHash });
    expect(tokens.rows[0]!.retired_at).not.toBeNull();
    expect(tokens.rows[1]).toMatchObject({ generation: 2, token_hash: nextHash, retired_at: null });
    expect(await counts()).toMatchObject({ grants: 1, tokens: 2, reservations: 1 });

    // The retired hash is never authority again, and a regenerated hash equal
    // to any current or retired hash fails closed.
    expect((await rawError(coreIntrospect(issued.providerSessionHash, issued.tokenHash))).code).toBe('42501');
    expect((await rawError(
      coreReplace(issued.chain, issued.grant, issued.tokenHash, { mutation: grantMutation(9021), keyHash: HEX_B }),
    )).code).toBe('23505');
  });

  it('refuses to replace after a claim or any exposure', async () => {
    const issued = await seedIssuedGrant(21, 1021);
    const claimed = await coreClaim(
      issued.providerSessionHash, issued.tokenHash, issued.action, attemptId(21),
    );
    expect(claimed.rows[0]).toMatchObject({ out_status: 'claimed' });
    const error = await rawError(
      coreReplace(issued.chain, issued.grant, digestCommerceGrantToken(rawGrantToken(9021)), {
        mutation: grantMutation(9022), keyHash: HEX_B,
      }),
    );
    expect(error.code).toBe('P0D14');
    const tokens = await admin.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM openarc_durable.authorization_grant_tokens',
    );
    expect(tokens.rows[0]!.n).toBe(1);

    // Exposure without a grant claim: an independently claimed reservation.
    const other = await seedIssuedGrant(22, 1022);
    await admin.query(
      `UPDATE openarc_durable.budget_reservations
          SET status = 'claimed', claimed_at = clock_timestamp()
        WHERE action_id = $1`,
      [other.action],
    );
    const exposure = await rawError(
      coreReplace(other.chain, other.grant, digestCommerceGrantToken(rawGrantToken(9023)), {
        mutation: grantMutation(9024), keyHash: HEX_A,
      }),
    );
    expect(exposure.code).toBe('P0D13');
  });
});

describe('two-token provider claim', () => {
  it('denies the provider session alone and the grant token alone', async () => {
    const issued = await seedIssuedGrant(30, 1030);

    // Provider session alone: a live matching provider session with no valid
    // grant token proves nothing.
    const sessionOnly = await rawError(
      coreClaim(issued.providerSessionHash, HEX_A, issued.action, attemptId(30)),
    );
    expect(sessionOnly.code).toBe('42501');

    // Grant token alone: the exact buyer secret with no live provider session.
    const tokenOnly = await rawError(
      coreClaim(sha256('not-a-session'), issued.tokenHash, issued.action, attemptId(31), {
        mutation: grantMutation(9031), keyHash: HEX_A,
      }),
    );
    expect(tokenOnly.code).toBe('28000');

    // A live session of a DIFFERENT provider plus the exact token is denied.
    const foreign = await seedCrossChain(31, 1031);
    const foreignSession = await seedProviderSession(foreign.seller, foreign.provider, 1031);
    const wrongProvider = await rawError(
      coreClaim(foreignSession, issued.tokenHash, issued.action, attemptId(32), {
        mutation: grantMutation(9032), keyHash: HEX_B,
      }),
    );
    expect(wrongProvider.code).toBe('42501');

    expect(await counts()).toMatchObject({ claims: 0, idem: 1 });
    expect((await grantRow(issued.grant))!['status']).toBe('issued');
    expect((await reservationRow(issued.action))!['status']).toBe('held');
  });

  it('binds grant, action, listing, version, requirement, provider and attempt atomically', async () => {
    const issued = await seedIssuedGrant(33, 1033);
    const attempt = attemptId(33);
    const result = await coreClaim(issued.providerSessionHash, issued.tokenHash, issued.action, attempt);
    const row = result.rows[0]!;
    expect(row).toMatchObject({
      out_replayed: false,
      out_status: 'claimed',
      out_grant_id: issued.grant,
      out_action_id: issued.action,
      out_provider_id: issued.chain.provider,
      out_listing_id: issued.chain.listing,
      out_listing_version: '1',
      out_attempt_id: attempt,
      out_amount_atomic: '1000000',
      out_fee_atomic: '0',
      out_debit_atomic: '1000000',
    });
    expect(row['out_claim_digest']).toMatch(/^sha256:[0-9a-f]{64}$/);

    const claim = await admin.query<Record<string, unknown>>(
      'SELECT * FROM openarc_durable.authorization_grant_claims',
    );
    expect(claim.rows).toHaveLength(1);
    expect(claim.rows[0]).toMatchObject({
      organization_id: issued.chain.buyer.org,
      grant_id: issued.grant,
      action_id: issued.action,
      seller_organization_id: issued.chain.seller.org,
      provider_id: issued.chain.provider,
      listing_id: issued.chain.listing,
      listing_version: '1',
      attempt_id: attempt,
    });
    expect(claim.rows[0]!['provider_session_id']).toBe(providerSessionId(1033));
    expect((await grantRow(issued.grant))!['status']).toBe('claimed');
    expect((await reservationRow(issued.action))!['status']).toBe('claimed');
    expect(await actionStatus(issued.action)).toBe('grant_issued');
    expect(await counts()).toMatchObject({ claims: 1, outbox: 2, audit: 2 });

    // One attempt id can never claim a second grant for the same provider.
    const duplicate = await rawError(migrator.query(
      `INSERT INTO openarc_durable.authorization_grant_claims
         (organization_id, grant_id, action_id, reservation_id, seller_organization_id,
          provider_id, listing_id, listing_version, requirement_id, provider_credential_id,
          provider_session_id, attempt_id, claim_digest, claimed_at)
       SELECT c.organization_id, c.grant_id || 'x', c.action_id, c.reservation_id,
              c.seller_organization_id, c.provider_id, c.listing_id, c.listing_version,
              c.requirement_id, c.provider_credential_id, c.provider_session_id,
              c.attempt_id, c.claim_digest, c.claimed_at
         FROM openarc_durable.authorization_grant_claims c`,
    ));
    expect(duplicate.code).toBeTruthy();
    expect((await counts()).claims).toBe(1);
  }, 60000);

  it('elects exactly one winner for real concurrent claims on separate connections', async () => {
    const issued = await seedIssuedGrant(35, 1035);
    const first = createDatabasePool(migratorUrl());
    const second = createDatabasePool(migratorUrl());
    const holder = await first.connect();
    let loser: Promise<unknown> | undefined;
    let loserSettled = false;
    try {
      // Connection A claims inside an OPEN transaction, so it still holds the
      // grant row lock when connection B starts its own claim.
      await holder.query('BEGIN');
      const winner = await holder.query(
        `SELECT * FROM openarc_durable.claim_authorization_grant_core(
           'internal_fixture', $1, $2, $3, $4::uuid, $5::uuid, $6, $7, $8)`,
        [issued.providerSessionHash, issued.tokenHash, issued.action, attemptId(35),
         grantMutation(9035), HEX_A, HEX_C, HEX_D],
      );
      expect(winner.rows[0]).toMatchObject({ out_status: 'claimed', out_attempt_id: attemptId(35) });

      loser = second.query(
        `SELECT * FROM openarc_durable.claim_authorization_grant_core(
           'internal_fixture', $1, $2, $3, $4::uuid, $5::uuid, $6, $7, $8)`,
        [issued.providerSessionHash, issued.tokenHash, issued.action, attemptId(36),
         grantMutation(9036), HEX_B, HEX_C, HEX_D],
      );
      loser.then(() => { loserSettled = true; }, () => { loserSettled = true; });
      // B is genuinely blocked on the row lock A holds: it cannot decide yet.
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(loserSettled).toBe(false);
      await holder.query('COMMIT');
    } finally {
      holder.release();
    }
    try {
      const error = await rawError(loser!);
      expect(error.code).toBe('P0D14');
    } finally {
      await first.end();
      await second.end();
    }
    const claims = await admin.query<{ n: number; attempt: string }>(
      'SELECT count(*) OVER ()::int AS n, attempt_id::text AS attempt FROM openarc_durable.authorization_grant_claims',
    );
    expect(claims.rows).toHaveLength(1);
    expect(claims.rows[0]).toMatchObject({ n: 1, attempt: attemptId(35) });
    expect((await grantRow(issued.grant))!['status']).toBe('claimed');
    expect((await reservationRow(issued.action))!['status']).toBe('claimed');
  }, 60000);

  it('replays the exact original provider-session claim and conflicts on a new attempt', async () => {
    const issued = await seedIssuedGrant(37, 1037);
    const attempt = attemptId(37);
    const args = { mutation: grantMutation(9037), keyHash: HEX_A, digest: HEX_C, context: HEX_D };
    const first = await coreClaim(issued.providerSessionHash, issued.tokenHash, issued.action, attempt, args);
    const replay = await coreClaim(issued.providerSessionHash, issued.tokenHash, issued.action, attempt, args);
    expect(first.rows[0]!['out_replayed']).toBe(false);
    expect(replay.rows[0]).toMatchObject({
      out_replayed: true,
      out_attempt_id: attempt,
      out_claim_digest: first.rows[0]!['out_claim_digest'],
      out_committed_at: first.rows[0]!['out_committed_at'],
    });
    // A different attempt under the same key is a conflict, never a second
    // claim, so a lost reply can never trigger a second external payment.
    const conflict = await rawError(
      coreClaim(issued.providerSessionHash, issued.tokenHash, issued.action, attemptId(38), args),
    );
    expect(conflict.code).toBe('P0D01');
    // A different key on an already claimed grant is a grant conflict.
    const second = await rawError(
      coreClaim(issued.providerSessionHash, issued.tokenHash, issued.action, attemptId(39),
        { mutation: grantMutation(9039), keyHash: HEX_B }),
    );
    expect(second.code).toBe('P0D14');
    expect((await counts()).claims).toBe(1);
  }, 60000);
});

describe('introspection is read-only', () => {
  it('never consumes, reserves or mutates anything on repeated calls', async () => {
    const issued = await seedIssuedGrant(40, 1040);
    const before = await grantRow(issued.grant);
    const beforeCounts = await counts();
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const view = await coreIntrospect(issued.providerSessionHash, issued.tokenHash);
      expect(view.rows[0]).toMatchObject({
        out_grant_id: issued.grant,
        out_action_id: issued.action,
        out_provider_id: issued.chain.provider,
        out_status: 'issued',
        out_claimed_attempt_id: null,
        out_amount_atomic: '1000000',
        out_debit_atomic: '1000000',
      });
    }
    expect(await grantRow(issued.grant)).toEqual(before);
    expect(await counts()).toEqual(beforeCounts);
    expect((await reservationRow(issued.action))!['status']).toBe('held');
    const tokens = await admin.query<{ n: number; live: number }>(
      `SELECT count(*)::int AS n,
              count(*) FILTER (WHERE retired_at IS NULL)::int AS live
         FROM openarc_durable.authorization_grant_tokens`,
    );
    expect(tokens.rows[0]).toMatchObject({ n: 1, live: 1 });
  });
});

describe('provider historical recovery', () => {
  it('recovers a claim for a NEW session of the same provider and hides missing from foreign', async () => {
    const issued = await seedIssuedGrant(50, 1050);
    const attempt = attemptId(50);
    await coreClaim(issued.providerSessionHash, issued.tokenHash, issued.action, attempt);

    const fresh = await seedExtraProviderSession(issued.chain.seller, issued.chain.provider, 1050);
    const recovered = await store.readProviderAttemptStatus(fresh, attempt);
    expect(recovered).toEqual({
      status: 'claimed',
      attemptId: attempt,
      grantId: issued.grant,
      actionId: issued.action,
      providerId: issued.chain.provider,
      listingId: issued.chain.listing,
      listingVersion: '1',
      claimedAt: expect.any(String),
      grantRevoked: false,
    });

    // Missing and foreign are INDISTINGUISHABLE: both are exactly not_found.
    const missing = await store.readProviderAttemptStatus(fresh, attemptId(59));
    expect(missing).toEqual({ status: 'not_found' });
    const foreign = await seedCrossChain(51, 1051);
    const foreignSession = await seedProviderSession(foreign.seller, foreign.provider, 1051);
    const hidden = await store.readProviderAttemptStatus(foreignSession, attempt);
    expect(hidden).toEqual({ status: 'not_found' });
    expect(hidden).toEqual(missing);
  }, 60000);
});

describe('revocation after a claim retains the claim and the exposure', () => {
  it('keeps the claim fact and the held exposure and releases nothing on a repeated revoke', async () => {
    const issued = await seedIssuedGrant(60, 1060);
    const attempt = attemptId(60);
    await coreClaim(issued.providerSessionHash, issued.tokenHash, issued.action, attempt);

    const revoked = await store.revokeGrant(
      issued.chain.buyer.hash, issued.chain.buyer.org, issued.grant,
      { idempotencyKey: key(60), mutationId: grantMutation(5060) },
    );
    expect(revoked.released).toBe(false);
    expect(revoked.reservationStatus).toBe('claimed');
    expect(revoked.actionStatus).toBe('grant_issued');
    expect(revoked.metadata.status).toBe('revoked');
    expect(revoked.metadata.claimedAt).not.toBeNull();
    expect(revoked.metadata.revokedAt).not.toBeNull();
    expect(revoked.receipt.resourceId).toBe(issued.grant);
    // No released budget event: a possible payment is never erased.
    expect(await counts()).toMatchObject({ claims: 1, released: 0 });

    // The provider still recovers the claim fact plus an explicit flag; a
    // retired token alone is not evidence of nonpayment.
    const fresh = await seedExtraProviderSession(issued.chain.seller, issued.chain.provider, 1060);
    const status = await store.readProviderAttemptStatus(fresh, attempt);
    expect(status).toMatchObject({ status: 'claimed', attemptId: attempt, grantRevoked: true });

    // The retired token is never authority again.
    expect((await rawError(coreIntrospect(issued.providerSessionHash, issued.tokenHash))).code).toBe('42501');

    // A repeated revoke with a fresh key releases nothing.
    await expectStoreCode(
      store.revokeGrant(issued.chain.buyer.hash, issued.chain.buyer.org, issued.grant,
        { idempotencyKey: key(61), mutationId: grantMutation(5061) }),
      'CONTROL_GRANT_STORE_GRANT_CONFLICT',
    );
    expect((await reservationRow(issued.action))!['status']).toBe('claimed');
    expect(await actionStatus(issued.action)).toBe('grant_issued');
    expect(await counts()).toMatchObject({ released: 0, claims: 1 });
  }, 60000);

  it('cancels the action through safe never-claimed cleanup', async () => {
    const issued = await seedIssuedGrant(62, 1062);
    const revoked = await store.revokeGrant(
      issued.chain.buyer.hash, issued.chain.buyer.org, issued.grant,
      { idempotencyKey: key(62), mutationId: grantMutation(5062) },
    );
    expect(revoked.released).toBe(true);
    expect(revoked.reservationStatus).toBe('released');
    expect(revoked.actionStatus).toBe('cancelled');
    expect(revoked.metadata.status).toBe('revoked');
    expect(revoked.metadata.claimedAt).toBeNull();
    expect(await actionStatus(issued.action)).toBe('cancelled');
    expect(await counts()).toMatchObject({ released: 1, claims: 0 });
    const token = await admin.query<{ retired: number }>(
      `SELECT count(*) FILTER (WHERE retired_at IS NOT NULL)::int AS retired
         FROM openarc_durable.authorization_grant_tokens`,
    );
    expect(token.rows[0]!.retired).toBe(1);
    // The buyer projection reports the revoked status without any secret.
    const projected = await store.readGrant(
      issued.chain.buyer.hash, issued.chain.buyer.org, issued.grant,
    );
    expect(projected).toMatchObject({ status: 'revoked', grantId: issued.grant, generation: '1' });
    expect(JSON.stringify(projected)).not.toContain(issued.tokenHash);
  }, 60000);
});

describe('production provenance seam', () => {
  it('rejects internal_fixture provenance in every production wrapper with zero mutations', async () => {
    const chain = await seedCrossChain(70, 1070);
    const requirement = await seedRequirement(chain, 70);
    const action = actionId(70);
    await coreAuthorize(chain, requirement, action);
    const before = await counts();

    await expectStoreCode(
      store.issueForReservedAction(
        chain.commerceTokenHash,
        { actionId: action, grantTokenHash: digestCommerceGrantToken(rawGrantToken(70)) },
        { idempotencyKey: key(70), mutationId: grantMutation(5070) },
      ),
      'CONTROL_GRANT_STORE_REQUIREMENT_UNAVAILABLE',
    );
    expect(await counts()).toEqual(before);
    expect(await actionStatus(action)).toBe('reserved_not_granted');

    // A migrator-only fixture grant proves mechanics but stays production-inert.
    const raw = rawGrantToken(71);
    const tokenHash = digestCommerceGrantToken(raw);
    const issued = await coreIssue(chain, action, tokenHash);
    const grant = issued.rows[0]!.out_grant_id as string;
    const providerSessionHash = await seedProviderSession(chain.seller, chain.provider, 1070);
    const afterIssue = await counts();

    await expectStoreCode(
      store.introspectGrant(providerSessionHash, tokenHash),
      'CONTROL_GRANT_STORE_REQUIREMENT_UNAVAILABLE',
    );
    await expectStoreCode(
      store.claimGrant(
        providerSessionHash,
        { grantTokenHash: tokenHash, expectedActionId: action, attemptId: attemptId(70) },
        { idempotencyKey: key(71), mutationId: grantMutation(5071) },
      ),
      'CONTROL_GRANT_STORE_REQUIREMENT_UNAVAILABLE',
    );
    await expectStoreCode(
      store.replaceUnclaimedGrant(
        chain.commerceTokenHash,
        { grantId: grant, grantTokenHash: digestCommerceGrantToken(rawGrantToken(72)) },
        { idempotencyKey: key(72), mutationId: grantMutation(5072) },
      ),
      'CONTROL_GRANT_STORE_REQUIREMENT_UNAVAILABLE',
    );
    expect(await counts()).toEqual(afterIssue);
    expect((await grantRow(grant))!['status']).toBe('issued');
  }, 60000);
});

describe('no raw grant secret anywhere', () => {
  it('stores and returns no raw oag_v1_ token and no reconstructable material', async () => {
    const issued = await seedIssuedGrant(80, 1080);
    await coreClaim(issued.providerSessionHash, issued.tokenHash, issued.action, attemptId(80));

    const tables = [
      'openarc_durable.authorization_grants',
      'openarc_durable.authorization_grant_tokens',
      'openarc_durable.authorization_grant_claims',
      'openarc_durable.idempotency_records',
      'openarc_durable.audit_events',
      'openarc_durable.outbox_events',
      'openarc_durable.commerce_actions',
      'openarc_durable.budget_reservations',
    ];
    for (const table of tables) {
      const scan = await admin.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM ${table} t WHERE t::text LIKE '%' || $1 || '%'`,
        [issued.raw],
      );
      expect(scan.rows[0]!.n).toBe(0);
      const secret = await admin.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM ${table} t WHERE t::text LIKE '%' || $1 || '%'`,
        [issued.raw.slice('oag_v1_'.length)],
      );
      expect(secret.rows[0]!.n).toBe(0);
    }
    // The stored hash exists exactly once and only in the token table.
    const stored = await admin.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM openarc_durable.authorization_grant_tokens WHERE token_hash = $1',
      [issued.tokenHash],
    );
    expect(stored.rows[0]!.n).toBe(1);
    for (const table of tables.filter((name) => !name.endsWith('grant_tokens'))) {
      const leak = await admin.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM ${table} t WHERE t::text LIKE '%' || $1 || '%'`,
        [issued.tokenHash],
      );
      expect(leak.rows[0]!.n).toBe(0);
    }
    // No projection, status or receipt carries the raw secret or its hash.
    const projected = await store.readGrant(
      issued.chain.buyer.hash, issued.chain.buyer.org, issued.grant,
    );
    const status = await store.readProviderAttemptStatus(issued.providerSessionHash, attemptId(80));
    for (const payload of [JSON.stringify(projected), JSON.stringify(status)]) {
      expect(payload).not.toContain(issued.raw);
      expect(payload).not.toContain(issued.tokenHash);
      expect(payload).not.toContain(issued.raw.slice('oag_v1_'.length));
    }
    // A second independent secret never digests to the stored hash.
    expect(digestCommerceGrantToken(`oag_v1_${randomBytes(32).toString('base64url')}`))
      .not.toBe(issued.tokenHash);
  }, 60000);
});
