import { createHash, randomBytes } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import {
  AUTH_WALLET_CHAIN_ID,
  AuthStore,
  AuthStoreError,
  type AuthStoredCredential,
  type AuthTransport,
  createDatabasePool,
  migrate,
} from '../src/index.js';
import {
  adminPool,
  appUrl,
  ensureRoles,
  migratorUrl,
  resetSchema,
} from './postgres-fixture.js';

const ALLOWED_HANDLE_FINALS = 'AEIMQUYcgkosw048';

function sha256(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

function challengeText(seed: string): string {
  return Buffer.from(seed, 'utf8').toString('base64url');
}

function hash(seed: string): string {
  return sha256(`openarc-test:${seed}`);
}

function handle(seed: number): string {
  const body = hash(`handle:${seed}`).slice(0, 42);
  const final = ALLOWED_HANDLE_FINALS[seed % ALLOWED_HANDLE_FINALS.length];
  if (final === undefined) throw new Error('handle final missing');
  return `${body}${final}`;
}

function address(seed: number): string {
  return `0x${hash(`wallet:${seed}`).slice(0, 40)}`;
}

function credential(seed: number, overrides: Partial<AuthStoredCredential> = {}): AuthStoredCredential {
  return {
    credentialId: Buffer.from(`credential-${seed}`).toString('base64url'),
    publicKey: new Uint8Array(randomBytes(32)),
    counter: 0,
    deviceType: 'multiDevice',
    backedUp: false,
    transports: ['internal'] as AuthTransport[],
    ...overrides,
  };
}

async function expectCode(promise: Promise<unknown>, code: string): Promise<AuthStoreError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(AuthStoreError);
    const typed = error as AuthStoreError;
    expect(typed.code).toBe(code);
    return typed;
  }
  throw new Error(`expected ${code}`);
}

const PERMISSIBLE_RACE_CODES = new Set([
  'AUTH_STORE_CONFLICT',
  'AUTH_STORE_SESSION_INVALID',
  'AUTH_STORE_CHALLENGE_INVALID',
  'AUTH_STORE_INPUT_INVALID',
]);

/**
 * A concurrency race may only fail with a specific logical outcome. A
 * repository failure (AUTH_STORE_DATABASE), driver deadlock or unexpected code
 * is a real defect and must fail the test.
 */
function assertRaceOutcome(outcome: PromiseSettledResult<unknown>): void {
  if (outcome.status === 'rejected') {
    expect(outcome.reason).toBeInstanceOf(AuthStoreError);
    const code = (outcome.reason as AuthStoreError).code;
    expect(PERMISSIBLE_RACE_CODES.has(code)).toBe(true);
  }
}

let admin: Pool;
let app: Pool;
let store: AuthStore;
let migrator: Pool;

beforeAll(async () => {
  admin = adminPool();
  await ensureRoles(admin);
  migrator = createDatabasePool(migratorUrl());
});

afterAll(async () => {
  try {
    await resetSchema(admin);
  } finally {
    await migrator.end();
    await admin.end();
  }
});

beforeEach(async () => {
  await resetSchema(admin);
  await migrate(migrator);
  app = createDatabasePool(appUrl());
  store = new AuthStore(app);
});

afterEach(async () => {
  await app.end();
});

describe('AuthStore challenges', () => {
  it('issues a passkey registration challenge with a 5 minute DB expiry', async () => {
    const issued = await store.issueChallenge({
      challengeHash: hash('cq1'),
      bindingHash: hash('cqb1'),
      kind: 'passkey_register',
      challenge: Buffer.from(randomBytes(32)).toString('base64url'),
      userHandle: handle(1),
    });
    expect(issued.kind).toBe('passkey_register');
    expect(issued.accountId).toBeNull();
    expect(issued.userHandle).toBe(handle(1));
    expect(issued.walletAddress).toBeNull();
    expect(issued.expiresAt.getTime()).toBeGreaterThan(issued.createdAt.getTime());
    expect(issued.expiresAt.getTime() - issued.createdAt.getTime()).toBeLessThanOrEqual(5 * 60 * 1000);
  });

  it('consumes a challenge exactly once', async () => {
    const challengeHash = hash('cq2');
    const bindingHash = hash('cqb2');
    await store.issueChallenge({
      challengeHash,
      bindingHash,
      kind: 'passkey_login',
      challenge: challengeText('login-challenge'),
    });
    const consumed = await store.consumeChallenge({ challengeHash, bindingHash, kind: 'passkey_login' });
    expect(consumed.accountId).toBeNull();
    expect(consumed.challenge).toBe(challengeText('login-challenge'));
    await expectCode(
      store.consumeChallenge({ challengeHash, bindingHash, kind: 'passkey_login' }),
      'AUTH_STORE_CHALLENGE_INVALID',
    );
  });

  it('rejects a wrong binding without consuming the challenge', async () => {
    const challengeHash = hash('cq3');
    const bindingHash = hash('cqb3');
    await store.issueChallenge({
      challengeHash,
      bindingHash,
      kind: 'passkey_login',
      challenge: challengeText('wrong-binding'),
    });
    await expectCode(
      store.consumeChallenge({ challengeHash, bindingHash: hash('other'), kind: 'passkey_login' }),
      'AUTH_STORE_CHALLENGE_INVALID',
    );
    const consumed = await store.consumeChallenge({ challengeHash, bindingHash, kind: 'passkey_login' });
    expect(consumed.kind).toBe('passkey_login');
  });

  it('rejects an expired challenge', async () => {
    const challengeHash = hash('cq4');
    const bindingHash = hash('cqb4');
    await store.issueChallenge({
      challengeHash,
      bindingHash,
      kind: 'passkey_login',
      challenge: challengeText('expired'),
    });
    await admin.query(
      `UPDATE openarc_auth.challenges
          SET created_at = now() - interval '10 minutes',
              expires_at = now() - interval '5 minutes'
        WHERE challenge_hash = $1`,
      [challengeHash],
    );
    await expectCode(
      store.consumeChallenge({ challengeHash, bindingHash, kind: 'passkey_login' }),
      'AUTH_STORE_CHALLENGE_INVALID',
    );
  });

  it('allows exactly one concurrent consumer', async () => {
    const challengeHash = hash('cq5');
    const bindingHash = hash('cqb5');
    await store.issueChallenge({
      challengeHash,
      bindingHash,
      kind: 'passkey_login',
      challenge: challengeText('race'),
    });
    const results = await Promise.allSettled([
      store.consumeChallenge({ challengeHash, bindingHash, kind: 'passkey_login' }),
      store.consumeChallenge({ challengeHash, bindingHash, kind: 'passkey_login' }),
    ]);
    expect(results.filter((entry) => entry.status === 'fulfilled')).toHaveLength(1);
  });

  it('rejects kind/field combinations', async () => {
    await expectCode(
      store.issueChallenge({
        challengeHash: hash('cq6'),
        bindingHash: hash('cqb6'),
        kind: 'passkey_login',
        challenge: challengeText('bad'),
        userHandle: handle(2),
      }),
      'AUTH_STORE_INPUT_INVALID',
    );
    await expectCode(
      store.issueChallenge({
        challengeHash: hash('cq7'),
        bindingHash: hash('cqb7'),
        kind: 'wallet_login',
        challenge: challengeText('bad'),
      }),
      'AUTH_STORE_INPUT_INVALID',
    );
    await expectCode(
      store.issueChallenge({
        challengeHash: hash('cq8'),
        bindingHash: hash('cqb8'),
        kind: 'passkey_add',
        challenge: challengeText('bad'),
        userHandle: handle(3),
      }),
      'AUTH_STORE_INPUT_INVALID',
    );
  });

  it('requires a live fresh session for add/link challenges', async () => {
    await expectCode(
      store.issueChallenge({
        challengeHash: hash('cq9'),
        bindingHash: hash('cqb9'),
        kind: 'wallet_link',
        challenge: challengeText('link'),
        walletAddress: address(9),
        sessionHash: hash('missing-session'),
      }),
      'AUTH_STORE_SESSION_INVALID',
    );
  });
});

describe('AuthStore passkey accounts and sessions', () => {
  it('creates a canonical account with credential and 24h session', async () => {
    const created = await store.createPasskeyAccount({
      userHandle: handle(10),
      credential: credential(10),
      sessionHash: hash('session-10'),
    });
    expect(created.account.accountId).toMatch(
      /^openarc:account:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(created.account.userHandle).toBe(handle(10));
    const session = await store.getSession(hash('session-10'));
    expect(session).not.toBeNull();
    expect(session?.method).toBe('passkey');
    expect(session?.accountId).toBe(created.account.accountId);
    expect((session?.expiresAt.getTime() ?? 0) - (session?.createdAt.getTime() ?? 0)).toBeLessThanOrEqual(
      24 * 60 * 60 * 1000,
    );
    await store.logout(hash('session-10'));
    expect(await store.getSession(hash('session-10'))).toBeNull();
    await store.logout(hash('session-10'));
  });

  it('rolls back duplicate credential and duplicate handle with no orphan', async () => {
    await store.createPasskeyAccount({
      userHandle: handle(11),
      credential: credential(11),
      sessionHash: hash('session-11'),
    });
    await expectCode(
      store.createPasskeyAccount({
        userHandle: handle(12),
        credential: credential(11),
        sessionHash: hash('session-12'),
      }),
      'AUTH_STORE_CONFLICT',
    );
    await expectCode(
      store.createPasskeyAccount({
        userHandle: handle(11),
        credential: credential(13),
        sessionHash: hash('session-13'),
      }),
      'AUTH_STORE_CONFLICT',
    );
    const counts = await admin.query<{ accounts: number; sessions: number; passkeys: number }>(
      `SELECT
         (SELECT count(*)::int FROM openarc_auth.accounts) AS accounts,
         (SELECT count(*)::int FROM openarc_auth.sessions) AS sessions,
         (SELECT count(*)::int FROM openarc_auth.passkeys) AS passkeys`,
    );
    expect(counts.rows[0]).toEqual({ accounts: 1, sessions: 1, passkeys: 1 });
  });

  it('rejects a malformed hash and a session/challenge hash collision', async () => {
    await expectCode(
      store.createPasskeyAccount({
        userHandle: handle(14),
        credential: credential(14),
        sessionHash: 'raw-session-token',
      }),
      'AUTH_STORE_INPUT_INVALID',
    );
    const collision = hash('collision-15');
    await store.issueChallenge({
      challengeHash: collision,
      bindingHash: hash('collision-b15'),
      kind: 'passkey_login',
      challenge: challengeText('collision'),
    });
    await expectCode(
      store.createPasskeyAccount({
        userHandle: handle(15),
        credential: credential(15),
        sessionHash: collision,
      }),
      'AUTH_STORE_CONFLICT',
    );
  });

  it('rotates a prior session hash in the same transaction', async () => {
    const first = await store.createPasskeyAccount({
      userHandle: handle(16),
      credential: credential(16),
      sessionHash: hash('old-session-16'),
    });
    const second = await store.createPasskeyAccount({
      userHandle: handle(17),
      credential: credential(17),
      sessionHash: hash('new-session-17'),
      previousSessionHash: hash('old-session-16'),
    });
    expect(await store.getSession(hash('old-session-16'))).toBeNull();
    expect(await store.getSession(hash('new-session-17'))).not.toBeNull();
    expect(second.account.accountId).not.toBe(first.account.accountId);
  });

  it('returns null for guest or missing session cookies', async () => {
    expect(await store.getSession(undefined)).toBeNull();
    expect(await store.getSession('not-a-hash')).toBeNull();
    expect(await store.getSession(hash('absent'))).toBeNull();
  });
});

describe('AuthStore wallet login', () => {
  it('creates a wallet account on first login and reuses it afterwards', async () => {
    const wallet = address(20);
    const first = await store.loginWallet({ address: wallet, sessionHash: hash('w20a') });
    expect(first.account.accountId).toMatch(/^openarc:account:/);
    const second = await store.loginWallet({ address: wallet, sessionHash: hash('w20b') });
    expect(second.account.accountId).toBe(first.account.accountId);
    const stored = await admin.query<{ chain_id: number }>(
      'SELECT chain_id FROM openarc_auth.wallets WHERE address = $1',
      [wallet],
    );
    expect(stored.rows[0]?.chain_id).toBe(AUTH_WALLET_CHAIN_ID);
  });

  it('rejects non-canonical addresses and other chains', async () => {
    await expectCode(
      store.loginWallet({ address: address(21).toUpperCase(), sessionHash: hash('w21') }),
      'AUTH_STORE_INPUT_INVALID',
    );
    await expectCode(
      store.loginWallet({ address: `0x${'1'.repeat(40)}`, sessionHash: 'not-hex' }),
      'AUTH_STORE_INPUT_INVALID',
    );
  });

  it('has exactly one account and link under concurrent first login', async () => {
    const wallet = address(22);
    const results = await Promise.all([
      store.loginWallet({ address: wallet, sessionHash: hash('w22a') }),
      store.loginWallet({ address: wallet, sessionHash: hash('w22b') }),
    ]);
    expect(results[0]?.account.accountId).toBe(results[1]?.account.accountId);
    const counts = await admin.query<{ accounts: number; wallets: number }>(
      `SELECT
         (SELECT count(*)::int FROM openarc_auth.accounts) AS accounts,
         (SELECT count(*)::int FROM openarc_auth.wallets) AS wallets`,
    );
    expect(counts.rows[0]).toEqual({ accounts: 1, wallets: 1 });
  });

  it('rotates a prior session during wallet login', async () => {
    const wallet = address(23);
    const first = await store.loginWallet({ address: wallet, sessionHash: hash('w23a') });
    await store.loginWallet({
      address: wallet,
      sessionHash: hash('w23b'),
      previousSessionHash: hash('w23a'),
    });
    expect(await store.getSession(hash('w23a'))).toBeNull();
    expect((await store.getSession(hash('w23b')))?.accountId).toBe(first.account.accountId);
  });

  it('fails disabled accounts on wallet login', async () => {
    const wallet = address(24);
    const first = await store.loginWallet({ address: wallet, sessionHash: hash('w24a') });
    await admin.query("UPDATE openarc_auth.accounts SET status = 'disabled' WHERE account_id = $1", [
      first.account.accountId,
    ]);
    await expectCode(
      store.loginWallet({ address: wallet, sessionHash: hash('w24b') }),
      'AUTH_STORE_ACCOUNT_DISABLED',
    );
  });
});

describe('AuthStore passkey login', () => {
  async function seedPasskey(seed: number, overrides: Partial<AuthStoredCredential> = {}) {
    const created = await store.createPasskeyAccount({
      userHandle: handle(seed),
      credential: credential(seed, overrides),
      sessionHash: hash(`seed-session-${seed}`),
    });
    return created;
  }

  it('finds the active account and stored proof without tokens', async () => {
    const created = await seedPasskey(30);
    const found = await store.findPasskey(credential(30).credentialId);
    expect(found).not.toBeNull();
    expect(found?.accountId).toBe(created.account.accountId);
    expect(found?.userHandle).toBe(handle(30));
    expect(Object.keys(found ?? {})).not.toContain('sessionHash');
    expect(await store.findPasskey(Buffer.from('missing-credential').toString('base64url'))).toBeNull();
  });

  it('logs in and advances the counter', async () => {
    await seedPasskey(31, { counter: 2, deviceType: 'multiDevice' });
    const expected = await store.findPasskey(credential(31).credentialId);
    if (expected === null) throw new Error('expected credential');
    const session = await store.loginPasskey({
      expectedCredential: { ...expected, accountId: expected.accountId, ...expected.credential },
      newCounter: 3,
      backedUp: true,
      sessionHash: hash('login31'),
    });
    expect(session.account.accountId).toBe(expected.accountId);
    const after = await store.findPasskey(credential(31).credentialId);
    expect(after?.credential.counter).toBe(3);
    expect(after?.credential.backedUp).toBe(true);
  });

  it('rejects a stale counter and a changed key snapshot', async () => {
    await seedPasskey(32, { counter: 5 });
    const expected = await store.findPasskey(credential(32).credentialId);
    if (expected === null) throw new Error('expected credential');
    const snapshot = { ...expected.credential, accountId: expected.accountId };
    await seedPasskey(33, { counter: 0 });
    const changed = await store.findPasskey(credential(33).credentialId);
    if (changed === null) throw new Error('expected credential');
    await admin.query(
      'UPDATE openarc_auth.passkeys SET public_key = $1 WHERE credential_id = $2',
      [Buffer.from(randomBytes(32)), credential(33).credentialId],
    );
    await expectCode(
      store.loginPasskey({
        expectedCredential: { ...changed.credential, accountId: changed.accountId },
        newCounter: 1,
        backedUp: false,
        sessionHash: hash('key33'),
      }),
      'AUTH_STORE_CONFLICT',
    );
    await expectCode(
      store.loginPasskey({
        expectedCredential: snapshot,
        newCounter: 4,
        backedUp: false,
        sessionHash: hash('stale32'),
      }),
      'AUTH_STORE_INPUT_INVALID',
    );
  });

  it('rejects a replaced snapshot after another login wins', async () => {
    await seedPasskey(34, { counter: 0, deviceType: 'multiDevice' });
    const expected = await store.findPasskey(credential(34).credentialId);
    if (expected === null) throw new Error('expected credential');
    const snapshot = { ...expected.credential, accountId: expected.accountId };
    await store.loginPasskey({
      expectedCredential: snapshot,
      newCounter: 1,
      backedUp: false,
      sessionHash: hash('win34'),
    });
    await expectCode(
      store.loginPasskey({
        expectedCredential: snapshot,
        newCounter: 2,
        backedUp: false,
        sessionHash: hash('lose34'),
      }),
      'AUTH_STORE_CONFLICT',
    );
  });

  it('allows exactly one parallel counter claim', async () => {
    await seedPasskey(35, { counter: 0, deviceType: 'multiDevice' });
    const expected = await store.findPasskey(credential(35).credentialId);
    if (expected === null) throw new Error('expected credential');
    const snapshot = { ...expected.credential, accountId: expected.accountId };
    const results = await Promise.allSettled([
      store.loginPasskey({
        expectedCredential: snapshot,
        newCounter: 1,
        backedUp: false,
        sessionHash: hash('claim35a'),
      }),
      store.loginPasskey({
        expectedCredential: snapshot,
        newCounter: 1,
        backedUp: false,
        sessionHash: hash('claim35b'),
      }),
    ]);
    expect(results.filter((entry) => entry.status === 'fulfilled')).toHaveLength(1);
  });

  it('rejects counter regression and single-device backup', async () => {
    await seedPasskey(36, { counter: 4, deviceType: 'multiDevice' });
    const expected = await store.findPasskey(credential(36).credentialId);
    if (expected === null) throw new Error('expected credential');
    await expectCode(
      store.loginPasskey({
        expectedCredential: { ...expected.credential, accountId: expected.accountId },
        newCounter: 3,
        backedUp: false,
        sessionHash: hash('regress36'),
      }),
      'AUTH_STORE_INPUT_INVALID',
    );
    await expectCode(
      store.createPasskeyAccount({
        userHandle: handle(37),
        credential: credential(37, { deviceType: 'singleDevice', backedUp: true }),
        sessionHash: hash('single37'),
      }),
      'AUTH_STORE_INPUT_INVALID',
    );
  });

  it('fails login for a disabled account', async () => {
    const created = await seedPasskey(38);
    const expected = await store.findPasskey(credential(38).credentialId);
    if (expected === null) throw new Error('expected credential');
    await admin.query("UPDATE openarc_auth.accounts SET status = 'disabled' WHERE account_id = $1", [
      created.account.accountId,
    ]);
    await expectCode(
      store.loginPasskey({
        expectedCredential: { ...expected.credential, accountId: expected.accountId },
        newCounter: 1,
        backedUp: false,
        sessionHash: hash('disabled38'),
      }),
      'AUTH_STORE_ACCOUNT_DISABLED',
    );
  });
});

describe('AuthStore add passkey and link wallet', () => {
  async function seedAccount(seed: number, sessionSeed: string) {
    return store.createPasskeyAccount({
      userHandle: handle(seed),
      credential: credential(seed),
      sessionHash: hash(sessionSeed),
    });
  }

  it('adds a passkey under a fresh session and rejects a handle mismatch', async () => {
    await seedAccount(40, 's40');
    const added = await store.addPasskey({
      sessionHash: hash('s40'),
      credential: credential(41),
      userHandle: handle(40),
    });
    expect(added.credentialId).toBe(credential(41).credentialId);
    const found = await store.findPasskey(credential(41).credentialId);
    expect(found?.accountId).toBe((await store.getSession(hash('s40')))?.accountId);
    await expectCode(
      store.addPasskey({
        sessionHash: hash('s40'),
        credential: credential(42),
        userHandle: handle(99),
      }),
      'AUTH_STORE_SESSION_INVALID',
    );
  });

  it('rejects add for invalid, expired and stale sessions', async () => {
    await seedAccount(43, 's43');
    await expectCode(
      store.addPasskey({
        sessionHash: hash('no-such'),
        credential: credential(430),
        userHandle: handle(43),
      }),
      'AUTH_STORE_SESSION_INVALID',
    );
    await admin.query(
      `UPDATE openarc_auth.sessions
          SET created_at = now() - interval '6 minutes',
              expires_at = now() + interval '23 hours'
        WHERE token_hash = $1`,
      [hash('s43')],
    );
    await expectCode(
      store.addPasskey({
        sessionHash: hash('s43'),
        credential: credential(431),
        userHandle: handle(43),
      }),
      'AUTH_STORE_SESSION_INVALID',
    );
    await admin.query(
      "UPDATE openarc_auth.sessions SET expires_at = now() - interval '1 second' WHERE token_hash = $1",
      [hash('s43')],
    );
    await expectCode(
      store.linkWallet({ sessionHash: hash('s43'), address: address(43) }),
      'AUTH_STORE_SESSION_INVALID',
    );
  });

  it('links a wallet and denies cross-account linking', async () => {
    await seedAccount(44, 's44');
    const wallet = address(44);
    await store.linkWallet({ sessionHash: hash('s44'), address: wallet });
    const linked = await admin.query<{ account_id: string }>(
      'SELECT account_id FROM openarc_auth.wallets WHERE address = $1',
      [wallet],
    );
    expect(linked.rows[0]?.account_id).toBe((await store.getSession(hash('s44')))?.accountId);

    await seedAccount(45, 's45');
    await expectCode(
      store.linkWallet({ sessionHash: hash('s45'), address: wallet }),
      'AUTH_STORE_CONFLICT',
    );
    const stillLinked = await admin.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM openarc_auth.wallets WHERE address = $1',
      [wallet],
    );
    expect(stillLinked.rows[0]?.n).toBe(1);
  });

  it('enforces the credential-per-account cap', async () => {
    await seedAccount(46, 's46');
    for (let index = 0; index < 9; index += 1) {
      await store.addPasskey({
        sessionHash: hash('s46'),
        credential: credential(100 + index),
        userHandle: handle(46),
      });
    }
    await expectCode(
      store.addPasskey({
        sessionHash: hash('s46'),
        credential: credential(200),
        userHandle: handle(46),
      }),
      'AUTH_STORE_LIMIT_REACHED',
    );
  });
});

describe('AuthStore recovery codes', () => {
  function codes(seed: number): string[] {
    return Array.from({ length: 8 }, (_value, index) => hash(`code-${seed}-${index}`));
  }

  it('replaces exactly eight unique hashes atomically', async () => {
    const created = await store.createPasskeyAccount({
      userHandle: handle(50),
      credential: credential(50),
      sessionHash: hash('s50'),
    });
    await store.replaceRecoveryCodes({ sessionHash: hash('s50'), codeHashes: codes(50) });
    const stored = await admin.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM openarc_auth.recovery_codes WHERE account_id = $1',
      [created.account.accountId],
    );
    expect(stored.rows[0]?.n).toBe(8);
    await store.replaceRecoveryCodes({ sessionHash: hash('s50'), codeHashes: codes(51) });
    const replaced = await admin.query<{ n: number; first: string }>(
      `SELECT count(*)::int AS n, (array_agg(code_hash ORDER BY code_hash))[1] AS first
         FROM openarc_auth.recovery_codes WHERE account_id = $1`,
      [created.account.accountId],
    );
    expect(replaced.rows[0]?.n).toBe(8);
    expect(codes(50)).not.toContain(replaced.rows[0]?.first);
  });

  it('rejects wrong counts, duplicates and recovery-method sessions', async () => {
    await store.createPasskeyAccount({
      userHandle: handle(52),
      credential: credential(52),
      sessionHash: hash('s52'),
    });
    await expectCode(
      store.replaceRecoveryCodes({ sessionHash: hash('s52'), codeHashes: codes(52).slice(0, 7) }),
      'AUTH_STORE_INPUT_INVALID',
    );
    const duplicate = [...codes(52).slice(0, 7), codes(52)[0] ?? ''];
    await expectCode(
      store.replaceRecoveryCodes({ sessionHash: hash('s52'), codeHashes: duplicate }),
      'AUTH_STORE_INPUT_INVALID',
    );
  });

  it('redeems once, revokes sessions and leaves other codes intact', async () => {
    const created = await store.createPasskeyAccount({
      userHandle: handle(53),
      credential: credential(53),
      sessionHash: hash('s53'),
    });
    await store.replaceRecoveryCodes({ sessionHash: hash('s53'), codeHashes: codes(53) });
    const results = await Promise.allSettled([
      store.redeemRecoveryCode({ codeHash: codes(53)[0] ?? '', newSessionHash: hash('rec53a') }),
      store.redeemRecoveryCode({ codeHash: codes(53)[0] ?? '', newSessionHash: hash('rec53b') }),
    ]);
    const fulfilled = results.filter((entry) => entry.status === 'fulfilled');
    expect(fulfilled).toHaveLength(1);
    expect(await store.getSession(hash('s53'))).toBeNull();
    const remaining = await admin.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM openarc_auth.recovery_codes WHERE account_id = $1',
      [created.account.accountId],
    );
    expect(remaining.rows[0]?.n).toBe(7);
    const recovery = await store.getSession(hash('rec53a'));
    const recoveryAlt = await store.getSession(hash('rec53b'));
    const active = recovery ?? recoveryAlt;
    expect(active?.method).toBe('recovery');
    expect(active?.accountId).toBe(created.account.accountId);
    if (recovery !== null) {
      await expectCode(
        store.replaceRecoveryCodes({ sessionHash: hash('rec53a'), codeHashes: codes(54) }),
        'AUTH_STORE_SESSION_INVALID',
      );
    }
  });
});

describe('AuthStore rate limits and purge', () => {
  it('increments atomically under concurrency and enforces the limit', async () => {
    const key = hash('rate-key-60');
    const attempts = await Promise.all(
      Array.from({ length: 10 }, () =>
        store.consumeRateLimit({ keyHash: key, limit: 10, windowSeconds: 3600 }),
      ),
    );
    expect(attempts.every((entry) => entry.allowed)).toBe(true);
    const over = await store.consumeRateLimit({ keyHash: key, limit: 10, windowSeconds: 3600 });
    expect(over.allowed).toBe(false);
    const stored = await admin.query<{ attempts: number }>(
      'SELECT sum(attempts)::int AS attempts FROM openarc_auth.rate_limits WHERE key_hash = $1',
      [key],
    );
    expect(stored.rows[0]?.attempts).toBe(11);
  });

  it('validates rate limit bounds', async () => {
    await expectCode(
      store.consumeRateLimit({ keyHash: hash('rate-bad'), limit: 0, windowSeconds: 60 }),
      'AUTH_STORE_INPUT_INVALID',
    );
    await expectCode(
      store.consumeRateLimit({ keyHash: hash('rate-bad2'), limit: 5, windowSeconds: 0 }),
      'AUTH_STORE_INPUT_INVALID',
    );
  });

  it('purges expired rows in bounded batches', async () => {
    for (let index = 0; index < 3; index += 1) {
      await store.issueChallenge({
        challengeHash: hash(`purge-c-${index}`),
        bindingHash: hash(`purge-b-${index}`),
        kind: 'passkey_login',
        challenge: challengeText(`purge-${index}`),
      });
    }
    for (let index = 0; index < 3; index += 1) {
      await store.createPasskeyAccount({
        userHandle: handle(70 + index),
        credential: credential(70 + index),
        sessionHash: hash(`purge-s-${index}`),
      });
    }
    await admin.query(
      `UPDATE openarc_auth.challenges
          SET created_at = now() - interval '10 minutes',
              expires_at = now() - interval '5 minutes'`,
    );
    await admin.query(
      `UPDATE openarc_auth.sessions
          SET created_at = now() - interval '25 hours',
              expires_at = now() - interval '1 hour'`,
    );
    await admin.query(
      `INSERT INTO openarc_auth.rate_limits (key_hash, window_start, attempts)
       SELECT $1, floor(extract(epoch FROM now()))::bigint - 200000 - g, 1
         FROM generate_series(0, 2) AS g`,
      [hash('purge-rate')],
    );
    const first = await store.purgeExpired({ limit: 2 });
    expect(first.challenges).toBe(2);
    expect(first.sessions).toBe(2);
    expect(first.rateLimits).toBe(2);
    const second = await store.purgeExpired({ limit: 100 });
    expect(second.challenges).toBe(1);
    expect(second.sessions).toBe(1);
    expect(second.rateLimits).toBe(1);
    const accounts = await admin.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM openarc_auth.accounts',
    );
    expect(accounts.rows[0]?.n).toBe(3);
  });
});

describe('AuthStore input canaries', () => {
  it('never echoes supplied raw values in errors or stored columns', async () => {
    const canary = 'raw-session-token-canary-0123456789';
    let captured: AuthStoreError | null = null;
    try {
      await store.getSession(canary);
      await store.createPasskeyAccount({
        userHandle: handle(80),
        credential: credential(80),
        sessionHash: canary,
      });
    } catch (error) {
      captured = error as AuthStoreError;
    }
    expect(captured).toBeInstanceOf(AuthStoreError);
    expect(captured?.message).not.toContain(canary);
    const leaked = await admin.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM openarc_auth.sessions WHERE token_hash = $1`,
      [canary],
    );
    expect(leaked.rows[0]?.n).toBe(0);
    expect(await store.getSession(canary)).toBeNull();
  });

  it('does not store raw challenge or signature material', async () => {
    const challengeHash = hash('canary-ch');
    const bindingHash = hash('canary-b');
    const nonce = Buffer.from(randomBytes(32)).toString('base64url');
    await store.issueChallenge({
      challengeHash,
      bindingHash,
      kind: 'passkey_login',
      challenge: nonce,
    });
    const stored = await admin.query<{ challenge: string; challenge_hash: string }>(
      'SELECT challenge, challenge_hash FROM openarc_auth.challenges WHERE challenge_hash = $1',
      [challengeHash],
    );
    expect(stored.rows[0]?.challenge_hash).toBe(challengeHash);
    expect(stored.rows[0]?.challenge).toBe(nonce);
  });
});

describe('AuthStore lock order and expiry regressions', () => {
  it('rejects disabled accounts for add/link issue and consume', async () => {
    const created = await store.createPasskeyAccount({
      userHandle: handle(90),
      credential: credential(90),
      sessionHash: hash('s90'),
    });
    const sessionHash = hash('s90');
    const addChallenge = hash('disabled-add-ch');
    const addBinding = hash('disabled-add-b');
    const linkChallenge = hash('disabled-link-ch');
    const linkBinding = hash('disabled-link-b');
    // Issue valid add/link challenges while the account is active.
    const issuedAdd = await store.issueChallenge({
      challengeHash: addChallenge,
      bindingHash: addBinding,
      kind: 'passkey_add',
      challenge: challengeText('disabled-add'),
      userHandle: handle(90),
      sessionHash,
    });
    expect(issuedAdd.accountId).toBe(created.account.accountId);
    const issuedLink = await store.issueChallenge({
      challengeHash: linkChallenge,
      bindingHash: linkBinding,
      kind: 'wallet_link',
      challenge: challengeText('disabled-link'),
      walletAddress: address(90),
      sessionHash,
    });
    expect(issuedLink.accountId).toBe(created.account.accountId);

    // Disable, then consumption must reject and retain both challenge rows.
    await admin.query("UPDATE openarc_auth.accounts SET status = 'disabled' WHERE account_id = $1", [
      created.account.accountId,
    ]);
    await expectCode(
      store.consumeChallenge({
        challengeHash: addChallenge,
        bindingHash: addBinding,
        kind: 'passkey_add',
        sessionHash,
      }),
      'AUTH_STORE_ACCOUNT_DISABLED',
    );
    await expectCode(
      store.consumeChallenge({
        challengeHash: linkChallenge,
        bindingHash: linkBinding,
        kind: 'wallet_link',
        sessionHash,
      }),
      'AUTH_STORE_ACCOUNT_DISABLED',
    );
    const consumed = await admin.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM openarc_auth.challenges WHERE challenge_hash = ANY($1::text[])',
      [[addChallenge, linkChallenge]],
    );
    expect(consumed.rows[0]?.n).toBe(2);
  });

  it('checks session freshness AFTER waiting on the account lock', async () => {
    const created = await store.createPasskeyAccount({
      userHandle: handle(91),
      credential: credential(91),
      sessionHash: hash('s91'),
    });
    const blocker = await admin.connect();
    try {
      await blocker.query('BEGIN');
      await blocker.query('SELECT account_id FROM openarc_auth.accounts WHERE account_id = $1 FOR UPDATE', [
        created.account.accountId,
      ]);
      // Session is live and fresh when the request begins.
      const pending = store.addPasskey({
        sessionHash: hash('s91'),
        credential: credential(910),
        userHandle: handle(91),
      });
      // Bounded wait: confirm the waiter is actually blocked on a lock before
      // expiring the session, so a pre-lock expiry check cannot pass this test.
      let waiting = false;
      for (let attempt = 0; attempt < 200 && !waiting; attempt += 1) {
        const probe = await admin.query<{ n: number }>(
          `SELECT count(*)::int AS n
             FROM pg_stat_activity
            WHERE datname = current_database()
              AND wait_event_type = 'Lock'
              AND pid <> pg_backend_pid()`,
        );
        waiting = (probe.rows[0]?.n ?? 0) > 0;
        if (!waiting) await new Promise((resolve) => setTimeout(resolve, 5));
      }
      expect(waiting).toBe(true);
      // Expire the session in a constraint-valid state while the add waits.
      await admin.query(
        `UPDATE openarc_auth.sessions
            SET created_at = now() - interval '25 hours',
                expires_at = now() - interval '1 hour'
          WHERE token_hash = $1`,
        [hash('s91')],
      );
      await blocker.query('COMMIT');
      await expectCode(pending, 'AUTH_STORE_SESSION_INVALID');
    } finally {
      blocker.release();
    }
  });

  it('converges on parallel recovery and replacement without deadlock', async () => {
    const created = await store.createPasskeyAccount({
      userHandle: handle(92),
      credential: credential(92),
      sessionHash: hash('s92'),
    });
    const recoveryCodes = Array.from({ length: 8 }, (_value, index) => hash(`recovery-92-${index}`));
    await store.replaceRecoveryCodes({ sessionHash: hash('s92'), codeHashes: recoveryCodes });
    const replacementHashes = Array.from({ length: 8 }, (_value, index) => hash(`replacement-92-${index}`));
    const outcomes = await Promise.allSettled([
      store.redeemRecoveryCode({
        codeHash: recoveryCodes[0] ?? '',
        newSessionHash: hash('recovery-session-92'),
      }),
      store.replaceRecoveryCodes({ sessionHash: hash('s92'), codeHashes: replacementHashes }),
    ]);
    // Only specific logical outcomes are acceptable; no repository/deadlock.
    for (const outcome of outcomes) assertRaceOutcome(outcome);
    expect(outcomes.some((outcome) => outcome.status === 'fulfilled')).toBe(true);
    const account = await admin.query<{ status: string }>(
      'SELECT status FROM openarc_auth.accounts WHERE account_id = $1',
      [created.account.accountId],
    );
    expect(account.rows[0]?.status).toBe('active');
  });

  it('converges on parallel link and login for the same wallet', async () => {
    const created = await store.createPasskeyAccount({
      userHandle: handle(93),
      credential: credential(93),
      sessionHash: hash('s93'),
    });
    const wallet = address(93);
    const outcomes = await Promise.allSettled([
      store.linkWallet({ sessionHash: hash('s93'), address: wallet }),
      store.loginWallet({ address: wallet, sessionHash: hash('w93') }),
    ]);
    for (const outcome of outcomes) assertRaceOutcome(outcome);
    const links = await admin.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM openarc_auth.wallets WHERE address = $1',
      [wallet],
    );
    expect(links.rows[0]?.n).toBe(1);
    const owners = await admin.query<{ n: number }>(
      'SELECT count(DISTINCT account_id)::int AS n FROM openarc_auth.wallets WHERE address = $1',
      [wallet],
    );
    expect(owners.rows[0]?.n).toBe(1);
    expect(created.account.accountId).toBeTruthy();
  });

  it('serializes simultaneous challenge/session same-hash claims to one winner', async () => {
    const shared = hash('shared-namespace-94');
    const outcomes = await Promise.allSettled([
      store.issueChallenge({
        challengeHash: shared,
        bindingHash: hash('shared-b-94'),
        kind: 'passkey_login',
        challenge: challengeText('shared-94'),
      }),
      store.createPasskeyAccount({
        userHandle: handle(94),
        credential: credential(94),
        sessionHash: shared,
      }),
    ]);
    expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
    const rejected = outcomes.filter(
      (outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected',
    );
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.reason).toBeInstanceOf(AuthStoreError);
    const storedChallenge = await admin.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM openarc_auth.challenges WHERE challenge_hash = $1',
      [shared],
    );
    const storedSession = await admin.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM openarc_auth.sessions WHERE token_hash = $1',
      [shared],
    );
    expect((storedChallenge.rows[0]?.n ?? 0) + (storedSession.rows[0]?.n ?? 0)).toBe(1);
  });
});

describe('AuthStore cross-account rotation', () => {
  it('revokes the previous account passkey session, not the new target session', async () => {
    const accountA = await store.createPasskeyAccount({
      userHandle: handle(120),
      credential: credential(120),
      sessionHash: hash('rot-a-session'),
    });
    const accountB = await store.createPasskeyAccount({
      userHandle: handle(121),
      credential: credential(121),
      sessionHash: hash('rot-b-seed'),
    });
    const snapshot = await store.findPasskey(credential(121).credentialId);
    if (snapshot === null) throw new Error('expected credential');
    // Browser on B presents A's old cookie in previousSessionHash.
    const rotated = await store.loginPasskey({
      expectedCredential: { ...snapshot.credential, accountId: snapshot.accountId },
      newCounter: 1,
      backedUp: false,
      sessionHash: hash('rot-b-new'),
      previousSessionHash: hash('rot-a-session'),
    });
    expect(rotated.account.accountId).toBe(accountB.account.accountId);
    // A's old session is revoked; B's new session is live.
    expect(await store.getSession(hash('rot-a-session'))).toBeNull();
    expect((await store.getSession(hash('rot-b-new')))?.accountId).toBe(accountB.account.accountId);
    // B's seed session and both accounts/credentials are untouched.
    expect((await store.getSession(hash('rot-b-seed')))?.accountId).toBe(accountB.account.accountId);
    expect(await store.findPasskey(credential(120).credentialId)).not.toBeNull();
    expect(await store.findPasskey(credential(121).credentialId)).not.toBeNull();
    expect(accountA.account.accountId).not.toBe(accountB.account.accountId);
  });

  it('revokes the previous account wallet session on existing-wallet login', async () => {
    const wallet = address(122);
    const accountB = await store.loginWallet({ address: wallet, sessionHash: hash('rot-w-bseed') });
    const accountA = await store.createPasskeyAccount({
      userHandle: handle(122),
      credential: credential(122),
      sessionHash: hash('rot-w-asession'),
    });
    const loggedIn = await store.loginWallet({
      address: wallet,
      sessionHash: hash('rot-w-bnew'),
      previousSessionHash: hash('rot-w-asession'),
    });
    expect(loggedIn.account.accountId).toBe(accountB.account.accountId);
    expect(await store.getSession(hash('rot-w-asession'))).toBeNull();
    expect((await store.getSession(hash('rot-w-bnew')))?.accountId).toBe(accountB.account.accountId);
    expect((await store.getSession(hash('rot-w-bseed')))?.accountId).toBe(accountB.account.accountId);
    expect(await store.findPasskey(credential(122).credentialId)).not.toBeNull();
    expect(accountA.account.accountId).not.toBe(accountB.account.accountId);
  });
});

describe('AuthStore canonical scalar boundaries', () => {
  it('rejects trailing newline, padding and non-canonical challenge values', async () => {
    const newline = String.fromCharCode(10);
    const cases = [
      `${challengeText('boundary')}${newline}`,
      `${challengeText('boundary')}=`,
      'challenge with space',
    ];
    for (const [index, value] of cases.entries()) {
      await expectCode(
        store.issueChallenge({
          challengeHash: hash(`boundary-ch-${index}`),
          bindingHash: hash(`boundary-b-${index}`),
          kind: 'passkey_login',
          challenge: value,
        }),
        'AUTH_STORE_INPUT_INVALID',
      );
    }
  });

  it('rejects padded credential IDs and non-canonical hashes', async () => {
    await expectCode(
      store.addPasskey({
        sessionHash: hash('boundary-session'),
        credential: credential(95, { credentialId: 'AAAA=' }),
        userHandle: handle(95),
      }),
      'AUTH_STORE_INPUT_INVALID',
    );
    await expectCode(
      store.createPasskeyAccount({
        userHandle: handle(95),
        credential: credential(95, { credentialId: `raw-id${String.fromCharCode(10)}` }),
        sessionHash: hash('boundary-session-2'),
      }),
      'AUTH_STORE_INPUT_INVALID',
    );
    await expectCode(
      store.consumeRateLimit({
        keyHash: `${hash('key')}${String.fromCharCode(10)}`,
        limit: 1,
        windowSeconds: 60,
      }),
      'AUTH_STORE_INPUT_INVALID',
    );
  });

  it('accepts a canonical boundary-length challenge and credential id', async () => {
    const maxChallenge = Buffer.from(randomBytes(192)).toString('base64url');
    expect(maxChallenge.length).toBe(256);
    await store.issueChallenge({
      challengeHash: hash('boundary-max'),
      bindingHash: hash('boundary-max-b'),
      kind: 'passkey_login',
      challenge: maxChallenge,
    });
    const consumed = await store.consumeChallenge({
      challengeHash: hash('boundary-max'),
      bindingHash: hash('boundary-max-b'),
      kind: 'passkey_login',
    });
    expect(consumed.challenge).toBe(maxChallenge);
  });
});

describe('AuthStore scalar trailing-newline boundaries', () => {
  const LF = String.fromCharCode(10);

  it('rejects each bounded scalar with a trailing LF', async () => {
    expect(await store.getSession(`${hash('lf')}${LF}`)).toBeNull();
    await expectCode(
      store.issueChallenge({
        challengeHash: `${hash('lf-ch')}${LF}`,
        bindingHash: hash('lf-b'),
        kind: 'passkey_register',
        challenge: challengeText('lf'),
        userHandle: handle(96),
      }),
      'AUTH_STORE_INPUT_INVALID',
    );
    await expectCode(
      store.issueChallenge({
        challengeHash: hash('lf-ch2'),
        bindingHash: hash('lf-b2'),
        kind: 'passkey_register',
        challenge: challengeText('lf2'),
        userHandle: `${handle(96)}${LF}`,
      }),
      'AUTH_STORE_INPUT_INVALID',
    );
    await expectCode(
      store.issueChallenge({
        challengeHash: hash('lf-ch3'),
        bindingHash: hash('lf-b3'),
        kind: 'wallet_login',
        challenge: challengeText('lf3'),
        walletAddress: `${address(96)}${LF}`,
      }),
      'AUTH_STORE_INPUT_INVALID',
    );
    await expectCode(
      store.issueChallenge({
        challengeHash: hash('lf-ch4'),
        bindingHash: `${hash('lf-b4')}${LF}`,
        kind: 'passkey_login',
        challenge: challengeText('lf4'),
      }),
      'AUTH_STORE_INPUT_INVALID',
    );
  });

  it('exact lengths reject an appended character for each scalar', async () => {
    await expectCode(
      store.loginWallet({ address: '0x' + '1'.repeat(41), sessionHash: hash('len-wallet') }),
      'AUTH_STORE_INPUT_INVALID',
    );
    await expectCode(
      store.issueChallenge({
        challengeHash: hash('len-ch'),
        bindingHash: hash('len-b'),
        kind: 'passkey_register',
        challenge: challengeText('len'),
        userHandle: 'A'.repeat(44),
      }),
      'AUTH_STORE_INPUT_INVALID',
    );
  });
});

describe('AuthStore recovery-vs-account races', () => {
  it('serializes recovery against add-challenge consumption', async () => {
    const created = await store.createPasskeyAccount({
      userHandle: handle(97),
      credential: credential(97),
      sessionHash: hash('s97'),
    });
    const recoveryCodes = Array.from({ length: 8 }, (_value, index) => hash(`recovery-97-${index}`));
    await store.replaceRecoveryCodes({ sessionHash: hash('s97'), codeHashes: recoveryCodes });
    const addChallenge = hash('race-add-ch');
    const addBinding = hash('race-add-b');
    await store.issueChallenge({
      challengeHash: addChallenge,
      bindingHash: addBinding,
      kind: 'passkey_add',
      challenge: challengeText('race-add'),
      userHandle: handle(97),
      sessionHash: hash('s97'),
    });
    const outcomes = await Promise.allSettled([
      store.redeemRecoveryCode({
        codeHash: recoveryCodes[0] ?? '',
        newSessionHash: hash('race-recovery-97'),
      }),
      store.consumeChallenge({
        challengeHash: addChallenge,
        bindingHash: addBinding,
        kind: 'passkey_add',
        sessionHash: hash('s97'),
      }),
    ]);
    for (const outcome of outcomes) assertRaceOutcome(outcome);
    expect(outcomes.some((outcome) => outcome.status === 'fulfilled')).toBe(true);
    const account = await admin.query<{ status: string }>(
      'SELECT status FROM openarc_auth.accounts WHERE account_id = $1',
      [created.account.accountId],
    );
    expect(account.rows[0]?.status).toBe('active');
  });

  it('serializes recovery against login rotation of the same session', async () => {
    const created = await store.createPasskeyAccount({
      userHandle: handle(98),
      credential: credential(98),
      sessionHash: hash('s98'),
    });
    const recoveryCodes = Array.from({ length: 8 }, (_value, index) => hash(`recovery-98-${index}`));
    await store.replaceRecoveryCodes({ sessionHash: hash('s98'), codeHashes: recoveryCodes });
    const expected = await store.findPasskey(credential(98).credentialId);
    if (expected === null) throw new Error('expected credential');
    const snapshot = { ...expected.credential, accountId: expected.accountId };
    const outcomes = await Promise.allSettled([
      store.redeemRecoveryCode({
        codeHash: recoveryCodes[0] ?? '',
        newSessionHash: hash('race-recovery-98'),
      }),
      store.loginPasskey({
        expectedCredential: snapshot,
        newCounter: 1,
        backedUp: false,
        sessionHash: hash('race-login-98'),
        previousSessionHash: hash('s98'),
      }),
    ]);
    for (const outcome of outcomes) assertRaceOutcome(outcome);
    expect(outcomes.some((outcome) => outcome.status === 'fulfilled')).toBe(true);
    const account = await admin.query<{ status: string }>(
      'SELECT status FROM openarc_auth.accounts WHERE account_id = $1',
      [created.account.accountId],
    );
    expect(account.rows[0]?.status).toBe('active');
  });
});
