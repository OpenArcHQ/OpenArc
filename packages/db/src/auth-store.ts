import { randomBytes, randomUUID } from 'node:crypto';
import type { Pool, PoolClient, QueryResult } from 'pg';

/**
 * Durable account repository (OpenArc auth).
 *
 * DB-owned storage for passkey/wallet credentials, single-use challenges and
 * opaque session-token hashes. It accepts only hashes, public credential
 * fields and strict bounded scalars; raw tokens, signatures, attestation,
 * prompts and user e-mail never cross this boundary. All SQL is
 * parameterized. The database clock owns every created/expiry decision.
 *
 * This store is NOT a tenant principal and makes no RLS or commercial
 * authorization claim. The account view it returns is a safe account view
 * only. Callers must supply a pool bound to the runtime app role.
 */

export const AUTH_STORE_ERROR_MESSAGES = {
  AUTH_STORE_INPUT_INVALID: 'AuthStore input is invalid.',
  AUTH_STORE_HASH_INVALID: 'AuthStore hash is invalid.',
  AUTH_STORE_CHALLENGE_INVALID: 'AuthStore challenge is not valid.',
  AUTH_STORE_SESSION_INVALID: 'AuthStore session is not valid.',
  AUTH_STORE_ACCOUNT_DISABLED: 'AuthStore account is disabled.',
  AUTH_STORE_CONFLICT: 'AuthStore operation conflicts with existing state.',
  AUTH_STORE_LIMIT_REACHED: 'AuthStore limit has been reached.',
  AUTH_STORE_DATABASE: 'AuthStore operation could not be completed.',
} as const;

export type AuthStoreErrorCode = keyof typeof AUTH_STORE_ERROR_MESSAGES;

/** Fixed, non-echoing repository error. Never carries driver detail. */
export class AuthStoreError extends Error {
  readonly code: AuthStoreErrorCode;

  constructor(code: AuthStoreErrorCode) {
    super(AUTH_STORE_ERROR_MESSAGES[code]);
    this.name = 'AuthStoreError';
    this.code = code;
  }
}

export type AuthChallengeKind =
  | 'passkey_register'
  | 'passkey_login'
  | 'passkey_add'
  | 'wallet_login'
  | 'wallet_link';

export type AuthPasskeyDeviceType = 'singleDevice' | 'multiDevice';

export type AuthSessionMethod = 'passkey' | 'wallet' | 'recovery';

export type AuthTransport =
  | 'usb'
  | 'nfc'
  | 'ble'
  | 'internal'
  | 'hybrid'
  | 'cable'
  | 'smart-card';

/** Public credential fields; no raw signature or attestation is stored. */
export interface AuthStoredCredential {
  readonly credentialId: string;
  readonly publicKey: Uint8Array;
  readonly counter: number;
  readonly deviceType: AuthPasskeyDeviceType;
  readonly backedUp: boolean;
  readonly transports: readonly AuthTransport[];
}

/** Safe account view. Not a tenant principal. */
export interface AuthAccountView {
  readonly accountId: string;
  readonly userHandle: string;
}

export interface AuthSessionView {
  readonly accountId: string;
  readonly userHandle: string;
  readonly method: AuthSessionMethod;
  readonly createdAt: Date;
  readonly expiresAt: Date;
}

export interface IssuedChallenge {
  readonly challengeHash: string;
  readonly bindingHash: string;
  readonly kind: AuthChallengeKind;
  readonly userHandle: string | null;
  readonly walletAddress: string | null;
  readonly accountId: string | null;
  readonly createdAt: Date;
  readonly expiresAt: Date;
}

export interface ConsumedChallenge {
  readonly kind: AuthChallengeKind;
  readonly userHandle: string | null;
  readonly walletAddress: string | null;
  readonly accountId: string | null;
  readonly challenge: string;
  readonly createdAt: Date;
  readonly expiresAt: Date;
}

export interface IssuedSession {
  readonly account: AuthAccountView;
  readonly session: {
    readonly createdAt: Date;
    readonly expiresAt: Date;
  };
}

export interface CreatedPasskeyAccount extends IssuedSession {
  readonly credential: AuthStoredCredential;
}

export interface FoundPasskey {
  readonly accountId: string;
  readonly userHandle: string;
  readonly credential: AuthStoredCredential;
}

export interface IssuedChallengeInput {
  readonly challengeHash: string;
  readonly bindingHash: string;
  readonly kind: AuthChallengeKind;
  readonly challenge: string;
  readonly userHandle?: string;
  readonly walletAddress?: string;
  readonly sessionHash?: string;
}

export interface ConsumeChallengeInput {
  readonly challengeHash: string;
  readonly bindingHash: string;
  readonly kind: AuthChallengeKind;
  readonly sessionHash?: string;
}

export interface CreatePasskeyAccountInput {
  readonly userHandle: string;
  readonly credential: AuthStoredCredential;
  readonly sessionHash: string;
  readonly previousSessionHash?: string;
}

export interface LoginWalletInput {
  readonly address: string;
  readonly sessionHash: string;
  readonly previousSessionHash?: string;
}

/** Snapshot previously returned by findPasskey, used to reject stale proofs. */
export interface ExpectedPasskeyCredential {
  readonly accountId: string;
  readonly credentialId: string;
  readonly publicKey: Uint8Array;
  readonly counter: number;
  readonly deviceType: AuthPasskeyDeviceType;
  readonly backedUp: boolean;
  readonly transports: readonly AuthTransport[];
}

export interface LoginPasskeyInput {
  readonly expectedCredential: ExpectedPasskeyCredential;
  readonly newCounter: number;
  readonly backedUp: boolean;
  readonly sessionHash: string;
  readonly previousSessionHash?: string;
}

export interface AddPasskeyInput {
  readonly sessionHash: string;
  readonly credential: AuthStoredCredential;
  readonly userHandle: string;
}

export interface LinkWalletInput {
  readonly sessionHash: string;
  readonly address: string;
}

export interface ReplaceRecoveryCodesInput {
  readonly sessionHash: string;
  readonly codeHashes: readonly string[];
}

export interface RedeemRecoveryCodeInput {
  readonly codeHash: string;
  readonly newSessionHash: string;
}

export interface ConsumeRateLimitInput {
  readonly keyHash: string;
  readonly limit: number;
  readonly windowSeconds: number;
}

export interface ConsumedRateLimit {
  readonly allowed: boolean;
}

export interface PurgeExpiredInput {
  readonly limit: number;
}

export interface PurgedExpired {
  readonly challenges: number;
  readonly sessions: number;
  readonly rateLimits: number;
}

const HEX64 = /^[0-9a-f]{64}$/;
const USER_HANDLE = /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/;
const CREDENTIAL_ID = /^[A-Za-z0-9_-]{1,1024}$/;
const CHALLENGE = /^[A-Za-z0-9_-]{1,256}$/;
const WALLET_ADDRESS = /^0x[0-9a-f]{40}$/;
const ACCOUNT_ID = /^openarc:account:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const MAX_COUNTER = 4_294_967_295;
const MAX_PUBLIC_KEY_BYTES = 2048;
const MAX_TRANSPORTS = 8;
const MAX_CREDENTIALS_PER_ACCOUNT = 10;
const MAX_WALLETS_PER_ACCOUNT = 10;
const REQUIRED_RECOVERY_CODES = 8;
const MIN_RATE_LIMIT = 1;
const MAX_RATE_LIMIT = 1_000_000;
const MIN_WINDOW_SECONDS = 1;
const MAX_WINDOW_SECONDS = 86_400;
const MIN_PURGE_LIMIT = 1;
const MAX_PURGE_LIMIT = 10_000;
const RATE_RETENTION_SECONDS = 86_400;

/** Arc Testnet. Wallet login/link is valid on this chain only. */
export const AUTH_WALLET_CHAIN_ID = 5_042_002;

const TRANSPORTS: readonly AuthTransport[] = [
  'usb',
  'nfc',
  'ble',
  'internal',
  'hybrid',
  'cable',
  'smart-card',
];

const CHALLENGE_KINDS: readonly AuthChallengeKind[] = [
  'passkey_register',
  'passkey_login',
  'passkey_add',
  'wallet_login',
  'wallet_link',
];

const SESSION_METHODS: readonly AuthSessionMethod[] = ['passkey', 'wallet', 'recovery'];

function fail(code: AuthStoreErrorCode): never {
  throw new AuthStoreError(code);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isHex64(value: unknown): value is string {
  return typeof value === 'string' && value.length === 64 && HEX64.test(value);
}

function requireHex64(value: unknown, code: AuthStoreErrorCode): string {
  if (!isHex64(value)) fail(code);
  return value;
}

function requireUserHandle(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length !== 43 ||
    !USER_HANDLE.test(value) ||
    value.includes('\n') ||
    value.includes('\r')
  ) {
    fail('AUTH_STORE_INPUT_INVALID');
  }
  return value;
}

function requireCredentialId(value: unknown): string {
  if (typeof value === 'string' && CREDENTIAL_ID.test(value)) {
    return requireCanonicalB64url(value, 1, 1024);
  }
  fail('AUTH_STORE_INPUT_INVALID');
}

/**
 * Canonical, unpadded base64url that round-trips exactly. Rejects padding,
 * whitespace/newlines and noncanonical trailing bits while keeping the DB
 * char-class bound. Used for credential IDs and challenge nonces.
 */
function requireCanonicalB64url(value: unknown, min: number, max: number): string {
  if (typeof value !== 'string' || value.length < min || value.length > max) {
    fail('AUTH_STORE_INPUT_INVALID');
  }
  if (!/^[A-Za-z0-9_-]+$/.test(value) || value.includes('\n') || value.includes('\r')) {
    fail('AUTH_STORE_INPUT_INVALID');
  }
  const decoded = Buffer.from(value, 'base64url');
  if (decoded.length === 0 || decoded.toString('base64url') !== value) {
    fail('AUTH_STORE_INPUT_INVALID');
  }
  return value;
}

function requireChallengeText(value: unknown): string {
  if (typeof value === 'string' && CHALLENGE.test(value)) {
    return requireCanonicalB64url(value, 1, 256);
  }
  fail('AUTH_STORE_INPUT_INVALID');
}

function requireWalletAddress(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length !== 42 ||
    !WALLET_ADDRESS.test(value) ||
    value.includes('\n') ||
    value.includes('\r')
  ) {
    fail('AUTH_STORE_INPUT_INVALID');
  }
  return value;
}

function requireCounter(value: unknown): number {
  if (
    typeof value !== 'number' ||
    !Number.isInteger(value) ||
    value < 0 ||
    value > MAX_COUNTER
  ) {
    fail('AUTH_STORE_INPUT_INVALID');
  }
  return value;
}

function requireBoundedInteger(value: unknown, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    fail('AUTH_STORE_INPUT_INVALID');
  }
  return value;
}

function requireDeviceType(value: unknown): AuthPasskeyDeviceType {
  if (value !== 'singleDevice' && value !== 'multiDevice') {
    fail('AUTH_STORE_INPUT_INVALID');
  }
  return value;
}

function requireBoolean(value: unknown): boolean {
  if (typeof value !== 'boolean') fail('AUTH_STORE_INPUT_INVALID');
  return value;
}

function requireChallengeKind(value: unknown): AuthChallengeKind {
  if (typeof value !== 'string' || !CHALLENGE_KINDS.includes(value as AuthChallengeKind)) {
    fail('AUTH_STORE_INPUT_INVALID');
  }
  return value as AuthChallengeKind;
}

function requireTransports(value: unknown): AuthTransport[] {
  if (!Array.isArray(value) || value.length > MAX_TRANSPORTS) {
    fail('AUTH_STORE_INPUT_INVALID');
  }
  const transports: AuthTransport[] = [];
  for (const entry of value) {
    if (typeof entry !== 'string' || !TRANSPORTS.includes(entry as AuthTransport)) {
      fail('AUTH_STORE_INPUT_INVALID');
    }
    transports.push(entry as AuthTransport);
  }
  return transports;
}

function requirePublicKey(value: unknown): Uint8Array {
  if (!(value instanceof Uint8Array) || value.length < 1 || value.length > MAX_PUBLIC_KEY_BYTES) {
    fail('AUTH_STORE_INPUT_INVALID');
  }
  return new Uint8Array(value);
}

function requireCredential(value: unknown): AuthStoredCredential {
  if (!isRecord(value)) fail('AUTH_STORE_INPUT_INVALID');
  const credentialId = requireCredentialId(value['credentialId']);
  const publicKey = requirePublicKey(value['publicKey']);
  const counter = requireCounter(value['counter']);
  const deviceType = requireDeviceType(value['deviceType']);
  const backedUp = requireBoolean(value['backedUp']);
  const transports = requireTransports(value['transports']);
  if (deviceType === 'singleDevice' && backedUp) fail('AUTH_STORE_INPUT_INVALID');
  return { credentialId, publicKey, counter, deviceType, backedUp, transports };
}

function requireExpectedCredential(value: unknown): ExpectedPasskeyCredential {
  if (!isRecord(value)) fail('AUTH_STORE_INPUT_INVALID');
  const accountId = value['accountId'];
  if (
    typeof accountId !== 'string' ||
    accountId.length !== 52 ||
    !ACCOUNT_ID.test(accountId) ||
    accountId.includes('\n') ||
    accountId.includes('\r')
  ) {
    fail('AUTH_STORE_INPUT_INVALID');
  }
  const credential = requireCredential({
    credentialId: value['credentialId'],
    publicKey: value['publicKey'],
    counter: value['counter'],
    deviceType: value['deviceType'],
    backedUp: value['backedUp'],
    transports: value['transports'],
  });
  return { accountId, ...credential };
}

function requireDate(value: unknown): Date {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    fail('AUTH_STORE_DATABASE');
  }
  return value;
}

function requireString(value: unknown): string {
  if (typeof value !== 'string') fail('AUTH_STORE_DATABASE');
  return value;
}

function requireMethod(value: unknown): AuthSessionMethod {
  if (typeof value !== 'string' || !SESSION_METHODS.includes(value as AuthSessionMethod)) {
    fail('AUTH_STORE_DATABASE');
  }
  return value as AuthSessionMethod;
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let index = 0; index < a.length; index += 1) {
    if (a[index] !== b[index]) return false;
  }
  return true;
}

function normalizeError(error: unknown): AuthStoreError {
  if (error instanceof AuthStoreError) return error;
  if (isRecord(error) && typeof error['code'] === 'string') {
    const code = error['code'];
    if (code === '23505' || code === '23503') {
      return new AuthStoreError('AUTH_STORE_CONFLICT');
    }
    if (code === '23514' || code === '22P02' || code === '22001' || code === '22003') {
      return new AuthStoreError('AUTH_STORE_INPUT_INVALID');
    }
  }
  return new AuthStoreError('AUTH_STORE_DATABASE');
}

function generateUserHandle(): string {
  return randomBytes(32).toString('base64url');
}

function generateAccountId(): string {
  return `openarc:account:${randomUUID()}`;
}

interface SessionRow {
  readonly account_id: string;
  readonly user_handle: string;
  readonly method: string;
  readonly created_at: Date;
  readonly expires_at: Date;
}

interface SessionTimes {
  readonly createdAt: Date;
  readonly expiresAt: Date;
}

/**
 * Durable account repository over a caller-supplied pg Pool.
 */
export class AuthStore {
  readonly #pool: Pool;

  constructor(pool: Pool) {
    if (pool === null || typeof pool !== 'object' || typeof pool.connect !== 'function') {
      fail('AUTH_STORE_INPUT_INVALID');
    }
    this.#pool = pool;
  }

  /**
   * 1. Issue a single-use challenge with a <=5 minute DB expiry. Add/link
   * challenges must resolve a live fresh session and store its account.
   */
  async issueChallenge(input: IssuedChallengeInput): Promise<IssuedChallenge> {
    const challengeHash = requireHex64(input?.challengeHash, 'AUTH_STORE_INPUT_INVALID');
    const bindingHash = requireHex64(input?.bindingHash, 'AUTH_STORE_INPUT_INVALID');
    const kind = requireChallengeKind(input?.kind);
    const challenge = requireChallengeText(input?.challenge);

    const needsSession = kind === 'passkey_add' || kind === 'wallet_link';
    const needsHandle = kind === 'passkey_register' || kind === 'passkey_add';
    const needsWallet = kind === 'wallet_login' || kind === 'wallet_link';

    let userHandle: string | null = null;
    if (needsHandle) {
      if (input.userHandle === undefined) fail('AUTH_STORE_INPUT_INVALID');
      userHandle = requireUserHandle(input.userHandle);
    } else if (input.userHandle !== undefined) {
      fail('AUTH_STORE_INPUT_INVALID');
    }

    let walletAddress: string | null = null;
    if (needsWallet) {
      if (input.walletAddress === undefined) fail('AUTH_STORE_INPUT_INVALID');
      walletAddress = requireWalletAddress(input.walletAddress);
    } else if (input.walletAddress !== undefined) {
      fail('AUTH_STORE_INPUT_INVALID');
    }

    let sessionHash: string | null = null;
    if (needsSession) {
      if (input.sessionHash === undefined) fail('AUTH_STORE_INPUT_INVALID');
      sessionHash = requireHex64(input.sessionHash, 'AUTH_STORE_INPUT_INVALID');
    } else if (input.sessionHash !== undefined) {
      fail('AUTH_STORE_INPUT_INVALID');
    }

    if (sessionHash !== null && sessionHash === challengeHash) {
      fail('AUTH_STORE_CONFLICT');
    }

    return this.#withTransaction(async (client) => {
      await this.#assertHashUnused(client, challengeHash);

      let accountId: string | null = null;
      if (sessionHash !== null) {
        const session = await this.#lockFreshSession(client, sessionHash, true);
        accountId = session.account_id;
        if (needsHandle && session.user_handle !== userHandle) {
          fail('AUTH_STORE_SESSION_INVALID');
        }
        if (needsHandle) userHandle = session.user_handle;
      }

      const inserted = await client.query<{
        created_at: Date;
        expires_at: Date;
      }>(
        `INSERT INTO openarc_auth.challenges
           (challenge_hash, binding_hash, kind, challenge, user_handle, account_id, wallet_address, created_at, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, now(), now() + interval '5 minutes')
         RETURNING created_at, expires_at`,
        [challengeHash, bindingHash, kind, challenge, userHandle, accountId, walletAddress],
      );
      const row = inserted.rows[0];
      if (inserted.rowCount !== 1 || row === undefined) fail('AUTH_STORE_DATABASE');

      return {
        challengeHash,
        bindingHash,
        kind,
        userHandle,
        walletAddress,
        accountId,
        createdAt: requireDate(row.created_at),
        expiresAt: requireDate(row.expires_at),
      };
    });
  }

  /**
   * 6. Passkey login. Caller has already verified the assertion; this method
   * performs the counter/backup compare-and-commit against the snapshot.
   */
  async loginPasskey(input: LoginPasskeyInput): Promise<IssuedSession> {
    const expected = requireExpectedCredential(input?.expectedCredential);
    const newCounter = requireCounter(input?.newCounter);
    const backedUp = requireBoolean(input?.backedUp);
    const sessionHash = requireHex64(input?.sessionHash, 'AUTH_STORE_INPUT_INVALID');
    const previousSessionHash =
      input.previousSessionHash === undefined
        ? null
        : requireHex64(input.previousSessionHash, 'AUTH_STORE_INPUT_INVALID');
    if (previousSessionHash !== null && previousSessionHash === sessionHash) {
      fail('AUTH_STORE_CONFLICT');
    }
    if (expected.deviceType === 'singleDevice' && backedUp) {
      fail('AUTH_STORE_INPUT_INVALID');
    }
    if ((expected.counter !== 0 || newCounter !== 0) && newCounter <= expected.counter) {
      fail('AUTH_STORE_INPUT_INVALID');
    }

    return this.#withTransaction(async (client) => {
      await this.#assertHashUnused(client, sessionHash);

      const initial = await client.query<{ account_id: string }>(
        'SELECT account_id FROM openarc_auth.passkeys WHERE credential_id = $1',
        [expected.credentialId],
      );
      const initialRow = initial.rows[0];
      if (initialRow === undefined || initialRow.account_id !== expected.accountId) {
        fail('AUTH_STORE_CONFLICT');
      }

      // Account-first rotation: discover the previous session's account
      // without locking, then lock the unique existing target account IDs in
      // sorted order before any child row. Then revalidate target state and
      // revoke only a session that still belongs to the locked target account.
      const targetAccountId = requireString(initialRow.account_id);
      const previousAccountId =
        previousSessionHash === null
          ? null
          : await this.#resolveSessionAccountId(client, previousSessionHash);
      const lockSet = [targetAccountId];
      if (previousAccountId !== null) lockSet.push(previousAccountId);
      await this.#lockAccountsSorted(client, lockSet);
      const account = await client.query<{ status: string; user_handle: string }>(
        'SELECT status, user_handle FROM openarc_auth.accounts WHERE account_id = $1',
        [targetAccountId],
      );
      const accountRow = account.rows[0];
      if (accountRow === undefined) fail('AUTH_STORE_CONFLICT');
      if (accountRow.status !== 'active') fail('AUTH_STORE_ACCOUNT_DISABLED');

      if (previousSessionHash !== null) {
        await client.query(
          'DELETE FROM openarc_auth.sessions WHERE token_hash = $1 AND account_id = $2',
          [previousSessionHash, previousAccountId],
        );
      }

      const locked = await client.query<{
        account_id: string;
        public_key: Buffer;
        counter: string;
        device_type: string;
        backed_up: boolean;
      }>(
        `SELECT account_id, public_key, counter, device_type, backed_up
           FROM openarc_auth.passkeys
          WHERE credential_id = $1
            FOR UPDATE`,
        [expected.credentialId],
      );
      const row = locked.rows[0];
      if (row === undefined) fail('AUTH_STORE_CONFLICT');
      const storedCounter = requireCounter(Number.parseInt(requireString(row.counter), 10));
      const storedDevice = requireDeviceType(row.device_type);
      if (row.account_id !== expected.accountId) fail('AUTH_STORE_CONFLICT');
      if (storedDevice !== expected.deviceType) fail('AUTH_STORE_CONFLICT');
      if (storedCounter !== expected.counter) fail('AUTH_STORE_CONFLICT');
      if (row.backed_up !== expected.backedUp) fail('AUTH_STORE_CONFLICT');
      if (!bytesEqual(new Uint8Array(row.public_key), expected.publicKey)) {
        fail('AUTH_STORE_CONFLICT');
      }

      const updated = await client.query(
        `UPDATE openarc_auth.passkeys
            SET counter = $1, backed_up = $2
          WHERE credential_id = $3 AND account_id = $4`,
        [newCounter, backedUp, expected.credentialId, expected.accountId],
      );
      if (updated.rowCount !== 1) fail('AUTH_STORE_CONFLICT');

      const times = await this.#insertSession(client, expected.accountId, sessionHash, 'passkey');
      return {
        account: {
          accountId: expected.accountId,
          userHandle: requireUserHandle(accountRow.user_handle),
        },
        session: times,
      };
    });
  }

  /**
   * 7. Active, unexpired safe session view. Missing/invalid returns null.
   */
  async getSession(sessionHash: unknown): Promise<AuthSessionView | null> {
    if (!isHex64(sessionHash)) return null;
    return this.#withTransaction(async (client) => {
      const result = await client.query<{
        account_id: string;
        user_handle: string;
        method: string;
        created_at: Date;
        expires_at: Date;
      }>(
        `SELECT s.account_id, a.user_handle, s.method, s.created_at, s.expires_at
           FROM openarc_auth.sessions s
           JOIN openarc_auth.accounts a ON a.account_id = s.account_id
          WHERE s.token_hash = $1
            AND s.expires_at > clock_timestamp()
            AND a.status = 'active'`,
        [sessionHash],
      );
      const row = result.rows[0];
      if (row === undefined) return null;
      return {
        accountId: requireString(row.account_id),
        userHandle: requireUserHandle(row.user_handle),
        method: requireMethod(row.method),
        createdAt: requireDate(row.created_at),
        expiresAt: requireDate(row.expires_at),
      };
    });
  }

  /** 8. Delete exactly one session. Idempotent for a well-formed hash. */
  async logout(sessionHash: unknown): Promise<void> {
    const tokenHash = requireHex64(sessionHash, 'AUTH_STORE_INPUT_INVALID');
    await this.#withTransaction(async (client) => {
      await client.query('DELETE FROM openarc_auth.sessions WHERE token_hash = $1', [tokenHash]);
    });
  }

  /**
   * 9a. Add a passkey to the session's active account (after add-challenge).
   */
  async addPasskey(input: AddPasskeyInput): Promise<AuthStoredCredential> {
    const sessionHash = requireHex64(input?.sessionHash, 'AUTH_STORE_INPUT_INVALID');
    const credential = requireCredential(input?.credential);
    const userHandle = requireUserHandle(input?.userHandle);

    return this.#withTransaction(async (client) => {
      await this.#assertCredentialAvailable(client, credential.credentialId);
      const session = await this.#lockFreshSession(client, sessionHash, true);
      const accountId = requireString(session.account_id);
      const account = await this.#lockAccount(client, accountId);
      if (requireUserHandle(account.user_handle) !== userHandle) {
        fail('AUTH_STORE_SESSION_INVALID');
      }
      const count = await client.query<{ n: number }>(
        'SELECT count(*)::int AS n FROM openarc_auth.passkeys WHERE account_id = $1',
        [accountId],
      );
      const n = count.rows[0]?.n;
      if (typeof n !== 'number') fail('AUTH_STORE_DATABASE');
      if (n >= MAX_CREDENTIALS_PER_ACCOUNT) fail('AUTH_STORE_LIMIT_REACHED');
      await this.#insertCredential(client, accountId, credential);
      return credential;
    });
  }

  /**
   * 9b. Link a wallet to the session's active account (after link-challenge).
   */
  async linkWallet(input: LinkWalletInput): Promise<void> {
    const sessionHash = requireHex64(input?.sessionHash, 'AUTH_STORE_INPUT_INVALID');
    const address = requireWalletAddress(input?.address);

    await this.#withTransaction(async (client) => {
      await client.query(
        'SELECT pg_advisory_xact_lock(hashtextextended($1, $2::bigint))',
        [`openarc:wallet:${address}`, AUTH_WALLET_CHAIN_ID],
      );
      const session = await this.#lockFreshSession(client, sessionHash, true);
      const accountId = requireString(session.account_id);
      await this.#lockAccount(client, accountId);
      const existing = await client.query<{ account_id: string }>(
        'SELECT account_id FROM openarc_auth.wallets WHERE chain_id = $1 AND address = $2 FOR UPDATE',
        [AUTH_WALLET_CHAIN_ID, address],
      );
      if (existing.rows[0] !== undefined) fail('AUTH_STORE_CONFLICT');
      const count = await client.query<{ n: number }>(
        'SELECT count(*)::int AS n FROM openarc_auth.wallets WHERE account_id = $1',
        [accountId],
      );
      const n = count.rows[0]?.n;
      if (typeof n !== 'number') fail('AUTH_STORE_DATABASE');
      if (n >= MAX_WALLETS_PER_ACCOUNT) fail('AUTH_STORE_LIMIT_REACHED');
      await client.query(
        'INSERT INTO openarc_auth.wallets (address, chain_id, account_id) VALUES ($1, $2, $3)',
        [address, AUTH_WALLET_CHAIN_ID, accountId],
      );
    });
  }

  /**
   * 10. Replace all recovery codes for a fresh passkey/wallet session.
   */
  async replaceRecoveryCodes(input: ReplaceRecoveryCodesInput): Promise<void> {
    const sessionHash = requireHex64(input?.sessionHash, 'AUTH_STORE_INPUT_INVALID');
    const codeHashes = input?.codeHashes;
    if (!Array.isArray(codeHashes) || codeHashes.length !== REQUIRED_RECOVERY_CODES) {
      fail('AUTH_STORE_INPUT_INVALID');
    }
    const validated: string[] = [];
    for (const hash of codeHashes) {
      validated.push(requireHex64(hash, 'AUTH_STORE_INPUT_INVALID'));
    }
    if (new Set(validated).size !== REQUIRED_RECOVERY_CODES) {
      fail('AUTH_STORE_INPUT_INVALID');
    }

    await this.#withTransaction(async (client) => {
      const session = await this.#lockFreshSession(client, sessionHash, true);
      const method = requireMethod(session.method);
      if (method === 'recovery') fail('AUTH_STORE_SESSION_INVALID');
      const accountId = requireString(session.account_id);
      await this.#lockAccount(client, accountId);
      await client.query('DELETE FROM openarc_auth.recovery_codes WHERE account_id = $1', [
        accountId,
      ]);
      for (const hash of validated) {
        await client.query(
          'INSERT INTO openarc_auth.recovery_codes (code_hash, account_id) VALUES ($1, $2)',
          [hash, accountId],
        );
      }
    });
  }

  /**
   * 11. Consume one recovery code, revoke all account sessions/challenges and
   * issue a recovery session. No payment authority is granted.
   */
  async redeemRecoveryCode(input: RedeemRecoveryCodeInput): Promise<IssuedSession> {
    const codeHash = requireHex64(input?.codeHash, 'AUTH_STORE_INPUT_INVALID');
    const newSessionHash = requireHex64(input?.newSessionHash, 'AUTH_STORE_INPUT_INVALID');
    if (codeHash === newSessionHash) fail('AUTH_STORE_CONFLICT');

    return this.#withTransaction(async (client) => {
      await this.#assertHashUnused(client, newSessionHash);
      // Resolve immutable account id without locking, lock the active account
      // first (same order as replacement), then consume the code guarded by
      // that account so a code cannot be moved between accounts mid-flight.
      const lookup = await client.query<{ account_id: string }>(
        'SELECT account_id FROM openarc_auth.recovery_codes WHERE code_hash = $1',
        [codeHash],
      );
      const lookupRow = lookup.rows[0];
      if (lookupRow === undefined) fail('AUTH_STORE_INPUT_INVALID');
      const accountId = requireString(lookupRow.account_id);
      const account = await this.#lockAccount(client, accountId);
      const userHandle = requireUserHandle(account.user_handle);
      const consumed = await client.query<{ account_id: string }>(
        'DELETE FROM openarc_auth.recovery_codes WHERE code_hash = $1 AND account_id = $2 RETURNING account_id',
        [codeHash, accountId],
      );
      const consumedRow = consumed.rows[0];
      if (consumed.rowCount !== 1 || consumedRow?.account_id !== accountId) {
        fail('AUTH_STORE_INPUT_INVALID');
      }

      await client.query('DELETE FROM openarc_auth.sessions WHERE account_id = $1', [accountId]);
      await client.query('DELETE FROM openarc_auth.challenges WHERE account_id = $1', [accountId]);
      const times = await this.#insertSession(client, accountId, newSessionHash, 'recovery');
      return { account: { accountId, userHandle }, session: times };
    });
  }

  /**
   * 12a. Fixed-window atomic rate-limit increment. No raw IP is stored.
   */
  async consumeRateLimit(input: ConsumeRateLimitInput): Promise<ConsumedRateLimit> {
    const keyHash = requireHex64(input?.keyHash, 'AUTH_STORE_INPUT_INVALID');
    const limit = requireBoundedInteger(input?.limit, MIN_RATE_LIMIT, MAX_RATE_LIMIT);
    const windowSeconds = requireBoundedInteger(
      input?.windowSeconds,
      MIN_WINDOW_SECONDS,
      MAX_WINDOW_SECONDS,
    );

    return this.#withTransaction(async (client) => {
      const result = await client.query<{ attempts: number }>(
        `INSERT INTO openarc_auth.rate_limits (key_hash, window_start, attempts)
         VALUES ($1, floor(extract(epoch FROM clock_timestamp()) / $2::numeric)::bigint * $2::bigint, 1)
         ON CONFLICT (key_hash, window_start)
         DO UPDATE SET attempts = openarc_auth.rate_limits.attempts + 1
         RETURNING attempts`,
        [keyHash, windowSeconds],
      );
      const attempts = result.rows[0]?.attempts;
      if (typeof attempts !== 'number') fail('AUTH_STORE_DATABASE');
      return { allowed: attempts <= limit };
    });
  }

  /**
   * 12b. Bounded purge of expired challenges and sessions and stale rate
   * entries. Never deletes accounts and never resets a table.
   */
  async purgeExpired(input: PurgeExpiredInput): Promise<PurgedExpired> {
    const limit = requireBoundedInteger(input?.limit, MIN_PURGE_LIMIT, MAX_PURGE_LIMIT);

    return this.#withTransaction(async (client) => {
      const challenges = await client.query(
        `DELETE FROM openarc_auth.challenges
          WHERE challenge_hash IN (
            SELECT challenge_hash FROM openarc_auth.challenges
             WHERE expires_at <= clock_timestamp()
             ORDER BY expires_at
             LIMIT $1
          )`,
        [limit],
      );
      const sessions = await client.query(
        `DELETE FROM openarc_auth.sessions
          WHERE token_hash IN (
            SELECT token_hash FROM openarc_auth.sessions
             WHERE expires_at <= clock_timestamp()
             ORDER BY expires_at
             LIMIT $1
          )`,
        [limit],
      );
      const rateLimits = await client.query(
        `DELETE FROM openarc_auth.rate_limits
          WHERE (key_hash, window_start) IN (
            SELECT key_hash, window_start FROM openarc_auth.rate_limits
             WHERE window_start < floor(extract(epoch FROM clock_timestamp()))::bigint - $2
             ORDER BY window_start
             LIMIT $1
          )`,
        [limit, RATE_RETENTION_SECONDS],
      );
      return {
        challenges: challenges.rowCount ?? 0,
        sessions: sessions.rowCount ?? 0,
        rateLimits: rateLimits.rowCount ?? 0,
      };
    });
  }

  /* ---------------------------------------------------------------- */
  /* Internal helpers                                                  */
  /* ---------------------------------------------------------------- */

  async #withTransaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    let client: PoolClient;
    try {
      client = await this.#pool.connect();
    } catch {
      fail('AUTH_STORE_DATABASE');
    }
    let result: T;
    try {
      await client.query('BEGIN');
      result = await work(client);
      await client.query('COMMIT');
    } catch (error) {
      let rolledBack = false;
      try {
        await client.query('ROLLBACK');
        rolledBack = true;
      } catch {
        rolledBack = false;
      }
      client.release(!rolledBack);
      throw normalizeError(error);
    }
    client.release();
    return result;
  }

  async #assertHashUnused(
    client: PoolClient,
    hash: string,
  ): Promise<void> {
    // Serialize cross-table namespace claims for the same hash so two
    // concurrent challenge/session inserts cannot both observe it as free.
    await this.#claimHashLock(client, hash);
    const queries = [
      'SELECT 1 FROM openarc_auth.sessions WHERE token_hash = $1',
      'SELECT 1 FROM openarc_auth.challenges WHERE challenge_hash = $1',
    ];
    for (const sql of queries) {
      const found = await client.query(sql, [hash]);
      if ((found.rowCount ?? 0) > 0) fail('AUTH_STORE_CONFLICT');
    }
  }

  async #claimHashLock(client: PoolClient, hash: string): Promise<void> {
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, $2::bigint))', [
      `openarc:hash:${hash}`,
      0,
    ]);
  }

  async #assertHandleAvailable(client: PoolClient, userHandle: string): Promise<void> {
    const found = await client.query('SELECT 1 FROM openarc_auth.accounts WHERE user_handle = $1', [
      userHandle,
    ]);
    if ((found.rowCount ?? 0) > 0) fail('AUTH_STORE_CONFLICT');
  }

  async #assertCredentialAvailable(client: PoolClient, credentialId: string): Promise<void> {
    const found = await client.query('SELECT 1 FROM openarc_auth.passkeys WHERE credential_id = $1', [
      credentialId,
    ]);
    if ((found.rowCount ?? 0) > 0) fail('AUTH_STORE_CONFLICT');
  }

  async #lockAccount(
    client: PoolClient,
    accountId: string,
  ): Promise<{ user_handle: string; status: string }> {
    const result = await client.query<{ user_handle: string; status: string }>(
      'SELECT user_handle, status FROM openarc_auth.accounts WHERE account_id = $1 FOR UPDATE',
      [accountId],
    );
    const row = result.rows[0];
    if (row === undefined) fail('AUTH_STORE_SESSION_INVALID');
    if (row.status !== 'active') fail('AUTH_STORE_ACCOUNT_DISABLED');
    return row;
  }

  /** Non-locking account-id lookup for a session hash; null when absent. */
  async #resolveSessionAccountId(
    client: PoolClient,
    tokenHash: string,
  ): Promise<string | null> {
    const result = await client.query<{ account_id: string }>(
      'SELECT account_id FROM openarc_auth.sessions WHERE token_hash = $1',
      [tokenHash],
    );
    const row = result.rows[0];
    return row === undefined ? null : requireString(row.account_id);
  }

  /**
   * Lock the unique existing account IDs in sorted order (deadlock-free)
   * without a status check; callers assert active status for the target
   * account explicitly. Account-bound child rows must be locked only after.
   */
  async #lockAccountsSorted(client: PoolClient, accountIds: readonly string[]): Promise<void> {
    const unique = [...new Set(accountIds)].sort();
    for (const accountId of unique) {
      await client.query('SELECT account_id FROM openarc_auth.accounts WHERE account_id = $1 FOR UPDATE', [
        accountId,
      ]);
    }
  }

  async #lockFreshSession(
    client: PoolClient,
    tokenHash: string,
    requireActiveAccount = true,
  ): Promise<SessionRow> {
    // Consistent lock order everywhere: resolve the immutable account id with
    // a nonlocking lookup, lock that account first, then lock/re-read the
    // session and re-check expiry/freshness with the DB clock AFTER waiting on
    // the account lock (so a session that expires while queued is rejected).
    const lookup = await client.query<{ account_id: string }>(
      'SELECT account_id FROM openarc_auth.sessions WHERE token_hash = $1',
      [tokenHash],
    );
    const lookupRow = lookup.rows[0];
    if (lookupRow === undefined) fail('AUTH_STORE_SESSION_INVALID');
    const accountId = requireString(lookupRow.account_id);
    const account = await this.#lockAccount(client, accountId);
    if (requireActiveAccount && account.status !== 'active') {
      fail('AUTH_STORE_ACCOUNT_DISABLED');
    }
    const result = await client.query<SessionRow>(
      `SELECT s.account_id, a.user_handle, s.method, s.created_at, s.expires_at
         FROM openarc_auth.sessions s
         JOIN openarc_auth.accounts a ON a.account_id = s.account_id
        WHERE s.token_hash = $1
          AND s.account_id = $2
          AND s.expires_at > clock_timestamp()
          AND s.created_at > clock_timestamp() - interval '5 minutes'
          FOR UPDATE OF s`,
      [tokenHash, accountId],
    );
    const row = result.rows[0];
    if (row === undefined) fail('AUTH_STORE_SESSION_INVALID');
    if (row.account_id !== accountId) fail('AUTH_STORE_SESSION_INVALID');
    // The WHERE clause was evaluated before any session-lock wait. After the
    // SELECT FOR UPDATE returns (and the account lock was already held),
    // re-read the DB clock and explicitly compare the row timestamps so a
    // session that expired while waiting on a child lock is rejected.
    const clock = await client.query<{ now: Date }>('SELECT clock_timestamp() AS now');
    const now = requireDate(clock.rows[0]?.now);
    const createdAt = requireDate(row.created_at);
    const expiresAt = requireDate(row.expires_at);
    if (!(expiresAt.getTime() > now.getTime())) fail('AUTH_STORE_SESSION_INVALID');
    if (!(createdAt.getTime() > now.getTime() - 5 * 60 * 1000)) {
      fail('AUTH_STORE_SESSION_INVALID');
    }
    return row;
  }

  async #insertCredential(
    client: PoolClient,
    accountId: string,
    credential: AuthStoredCredential,
  ): Promise<void> {
    const result: QueryResult = await client.query(
      `INSERT INTO openarc_auth.passkeys
         (credential_id, account_id, public_key, counter, device_type, backed_up, transports)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        credential.credentialId,
        accountId,
        Buffer.from(credential.publicKey),
        credential.counter,
        credential.deviceType,
        credential.backedUp,
        [...credential.transports],
      ],
    );
    if (result.rowCount !== 1) fail('AUTH_STORE_DATABASE');
  }

  async #insertSession(
    client: PoolClient,
    accountId: string,
    tokenHash: string,
    method: AuthSessionMethod,
  ): Promise<SessionTimes> {
    const result = await client.query<{ created_at: Date; expires_at: Date }>(
      `INSERT INTO openarc_auth.sessions (token_hash, account_id, method, created_at, expires_at)
       VALUES ($1, $2, $3, now(), now() + interval '24 hours')
       RETURNING created_at, expires_at`,
      [tokenHash, accountId, method],
    );
    const row = result.rows[0];
    if (result.rowCount !== 1 || row === undefined) fail('AUTH_STORE_DATABASE');
    return { createdAt: requireDate(row.created_at), expiresAt: requireDate(row.expires_at) };
  }
  /**
   * 2. Single-use atomic consumption. Add/link also validates the same live
   * fresh session/account in the same transaction; a mismatch rolls the
   * delete back so a wrong browser cannot consume the challenge.
   */
  async consumeChallenge(input: ConsumeChallengeInput): Promise<ConsumedChallenge> {
    const challengeHash = requireHex64(input?.challengeHash, 'AUTH_STORE_INPUT_INVALID');
    const bindingHash = requireHex64(input?.bindingHash, 'AUTH_STORE_INPUT_INVALID');
    const kind = requireChallengeKind(input?.kind);
    const needsSession = kind === 'passkey_add' || kind === 'wallet_link';
    let sessionHash: string | null = null;
    if (needsSession) {
      if (input.sessionHash === undefined) fail('AUTH_STORE_CHALLENGE_INVALID');
      sessionHash = requireHex64(input.sessionHash, 'AUTH_STORE_INPUT_INVALID');
    } else if (input.sessionHash !== undefined) {
      fail('AUTH_STORE_INPUT_INVALID');
    }

    return this.#withTransaction(async (client) => {
      // Account-bound add/link: resolve and lock the fresh active session's
      // account BEFORE touching the bound challenge row (consistent
      // account-first lock order; no challenge->account cycle). Anonymous
      // login/registration keeps no account lock.
      let boundAccountId: string | null = null;
      if (sessionHash !== null) {
        const session = await this.#lockFreshSession(client, sessionHash, true);
        boundAccountId = requireString(session.account_id);
      }

      const deleted = await client.query<{
        user_handle: string | null;
        account_id: string | null;
        wallet_address: string | null;
        challenge: string;
        created_at: Date;
        expires_at: Date;
      }>(
        `DELETE FROM openarc_auth.challenges
          WHERE challenge_hash = $1
            AND binding_hash = $2
            AND kind = $3
            AND expires_at > clock_timestamp()
            AND ($4::text IS NULL OR account_id = $4)
        RETURNING user_handle, account_id, wallet_address, challenge, created_at, expires_at`,
        [challengeHash, bindingHash, kind, boundAccountId],
      );
      const row = deleted.rows[0];
      if (deleted.rowCount !== 1 || row === undefined) fail('AUTH_STORE_CHALLENGE_INVALID');

      if (boundAccountId !== null && row.account_id !== boundAccountId) {
        fail('AUTH_STORE_SESSION_INVALID');
      }

      return {
        kind,
        userHandle: row.user_handle,
        walletAddress: row.wallet_address,
        accountId: row.account_id,
        challenge: requireChallengeText(row.challenge),
        createdAt: requireDate(row.created_at),
        expiresAt: requireDate(row.expires_at),
      };
    });
  }

  /**
   * 3. Create a passkey account with public credential and 24h session.
   */
  async createPasskeyAccount(input: CreatePasskeyAccountInput): Promise<CreatedPasskeyAccount> {
    const userHandle = requireUserHandle(input?.userHandle);
    const credential = requireCredential(input?.credential);
    const sessionHash = requireHex64(input?.sessionHash, 'AUTH_STORE_INPUT_INVALID');
    const previousSessionHash =
      input.previousSessionHash === undefined
        ? null
        : requireHex64(input.previousSessionHash, 'AUTH_STORE_INPUT_INVALID');
    if (previousSessionHash !== null && previousSessionHash === sessionHash) {
      fail('AUTH_STORE_CONFLICT');
    }

    return this.#withTransaction(async (client) => {
      await this.#assertHashUnused(client, sessionHash);
      await this.#assertHandleAvailable(client, userHandle);
      await this.#assertCredentialAvailable(client, credential.credentialId);

      // Account-first: if rotating a prior session, lock its existing account
      // (nonlocking discovery) before inserting the new random account id.
      const previousAccountId =
        previousSessionHash === null
          ? null
          : await this.#resolveSessionAccountId(client, previousSessionHash);
      if (previousAccountId !== null) {
        await this.#lockAccountsSorted(client, [previousAccountId]);
      }

      const accountId = generateAccountId();
      await client.query(
        'INSERT INTO openarc_auth.accounts (account_id, user_handle) VALUES ($1, $2)',
        [accountId, userHandle],
      );
      await this.#insertCredential(client, accountId, credential);
      if (previousSessionHash !== null) {
        await client.query(
          'DELETE FROM openarc_auth.sessions WHERE token_hash = $1 AND account_id = $2',
          [previousSessionHash, previousAccountId],
        );
      }
      const times = await this.#insertSession(client, accountId, sessionHash, 'passkey');

      return { account: { accountId, userHandle }, session: times, credential };
    });
  }

  /**
   * 4. Wallet login. The caller has already verified the wallet proof; this
   * method never verifies signatures. Chain is fixed to Arc Testnet.
   */
  async loginWallet(input: LoginWalletInput): Promise<IssuedSession> {
    const address = requireWalletAddress(input?.address);
    const sessionHash = requireHex64(input?.sessionHash, 'AUTH_STORE_INPUT_INVALID');
    const previousSessionHash =
      input.previousSessionHash === undefined
        ? null
        : requireHex64(input.previousSessionHash, 'AUTH_STORE_INPUT_INVALID');
    if (previousSessionHash !== null && previousSessionHash === sessionHash) {
      fail('AUTH_STORE_CONFLICT');
    }

    return this.#withTransaction(async (client) => {
      await this.#assertHashUnused(client, sessionHash);
      // Domain advisory wallet lock FIRST (before any account lock).
      await client.query(
        'SELECT pg_advisory_xact_lock(hashtextextended($1, $2::bigint))',
        [`openarc:wallet:${address}`, AUTH_WALLET_CHAIN_ID],
      );

      let accountId: string;
      let userHandle: string;
      // Resolve the existing wallet mapping and previous session accounts
      // without locking, then lock the unique EXISTING account IDs in sorted
      // order before revalidating and touching any child row.
      const lookup = await client.query<{ account_id: string }>(
        'SELECT account_id FROM openarc_auth.wallets WHERE chain_id = $1 AND address = $2',
        [AUTH_WALLET_CHAIN_ID, address],
      );
      const lookupRow = lookup.rows[0];
      const previousAccountId =
        previousSessionHash === null
          ? null
          : await this.#resolveSessionAccountId(client, previousSessionHash);
      const existingAccountId = lookupRow === undefined ? null : requireString(lookupRow.account_id);
      const lockSet: string[] = [];
      if (existingAccountId !== null) lockSet.push(existingAccountId);
      if (previousAccountId !== null) lockSet.push(previousAccountId);
      await this.#lockAccountsSorted(client, lockSet);

      if (lookupRow !== undefined) {
        accountId = requireString(lookupRow.account_id);
        const revalidated = await client.query<{ account_id: string }>(
          'SELECT account_id FROM openarc_auth.wallets WHERE chain_id = $1 AND address = $2 FOR UPDATE',
          [AUTH_WALLET_CHAIN_ID, address],
        );
        const revalidatedRow = revalidated.rows[0];
        if (revalidatedRow === undefined || revalidatedRow.account_id !== accountId) {
          fail('AUTH_STORE_CONFLICT');
        }
        const account = await client.query<{ user_handle: string; status: string }>(
          'SELECT user_handle, status FROM openarc_auth.accounts WHERE account_id = $1',
          [accountId],
        );
        const accountRow = account.rows[0];
        if (accountRow === undefined) fail('AUTH_STORE_CONFLICT');
        if (accountRow.status !== 'active') fail('AUTH_STORE_ACCOUNT_DISABLED');
        userHandle = requireUserHandle(accountRow.user_handle);
      } else {
        // New account creation locks the previous account (if any) before
        // inserting the new random account id.
        if (previousAccountId !== null) {
          await this.#lockAccount(client, previousAccountId);
        }
        userHandle = generateUserHandle();
        accountId = generateAccountId();
        await client.query(
          'INSERT INTO openarc_auth.accounts (account_id, user_handle) VALUES ($1, $2)',
          [accountId, userHandle],
        );
        await client.query(
          'INSERT INTO openarc_auth.wallets (address, chain_id, account_id) VALUES ($1, $2, $3)',
          [address, AUTH_WALLET_CHAIN_ID, accountId],
        );
      }

      if (previousSessionHash !== null) {
        await client.query(
          'DELETE FROM openarc_auth.sessions WHERE token_hash = $1 AND account_id = $2',
          [previousSessionHash, previousAccountId],
        );
      }
      const times = await this.#insertSession(client, accountId, sessionHash, 'wallet');
      return { account: { accountId, userHandle }, session: times };
    });
  }

  /**
   * 5. Look up an active account and stored proof for a service verifier.
   */
  async findPasskey(credentialId: unknown): Promise<FoundPasskey | null> {
    const id = requireCredentialId(credentialId);
    return this.#withTransaction(async (client) => {
      const result = await client.query<{
        account_id: string;
        user_handle: string;
        public_key: Buffer;
        counter: string;
        device_type: string;
        backed_up: boolean;
        transports: string[];
      }>(
        `SELECT p.account_id, a.user_handle, p.public_key, p.counter, p.device_type, p.backed_up, p.transports
           FROM openarc_auth.passkeys p
           JOIN openarc_auth.accounts a ON a.account_id = p.account_id
          WHERE p.credential_id = $1 AND a.status = 'active'`,
        [id],
      );
      const row = result.rows[0];
      if (row === undefined) return null;
      return {
        accountId: requireString(row.account_id),
        userHandle: requireUserHandle(row.user_handle),
        credential: {
          credentialId: id,
          publicKey: new Uint8Array(row.public_key),
          counter: requireCounter(Number.parseInt(requireString(row.counter), 10)),
          deviceType: requireDeviceType(row.device_type),
          backedUp: requireBoolean(row.backed_up),
          transports: requireTransports(row.transports),
        },
      };
    });
  }
}
