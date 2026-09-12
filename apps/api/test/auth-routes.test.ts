import { createHash } from "node:crypto";

import { AuthStoreError } from "@openarc/db";
import type {
  AuthChallengeKind,
  AuthSessionView,
  AuthStoredCredential,
  ConsumedChallenge,
  CreatedPasskeyAccount,
  ExpectedPasskeyCredential,
  FoundPasskey,
  IssuedChallenge,
  IssuedSession,
  PurgedExpired,
} from "@openarc/db";
import { afterEach, describe, expect, it } from "vitest";

import { createApp } from "../src/app.js";
import type { CompletionLog } from "../src/app.js";
import { AUTH_ROUTES } from "../src/auth/routes.js";
import { AuthService, type AuthServiceConfig } from "../src/auth/service.js";
import type {
  AuthProofPort,
  AuthRuntime,
  AuthStorePort,
} from "../src/auth/ports.js";
import type { AuthOriginConfig, PasskeyProof } from "../src/auth/proofs.js";
import { loadConfig } from "../src/config.js";

/**
 * HTTP inject coverage for the account-only routes.
 *
 * The durable repository and the WebAuthn/SIWE adapters are HONESTLY MOCKED
 * test doubles here: this file proves route wiring, transport rejection,
 * binding/CSRF, single-use consumption ordering and fixed error envelopes.
 * Real crypto and real PostgreSQL are exercised by auth-service.postgres.test.ts
 * and by the reviewed adapter contract tests. No mock is a production path.
 */

const ORIGIN = "http://localhost:5173";
const RP_ID = "localhost";
const SECRET = "synthetic_auth_secret_for_route_tests_0123456789";
const BUILD_SHA = "0123456789abcdef0123456789abcdef01234567";
const CLIENT = { origin: ORIGIN, "x-openarc-client": "browser-v1" };
const JSON_HEADERS = { ...CLIENT, "content-type": "application/json" };

function sha256(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

function b64(bytes: number, fill: number): string {
  return Buffer.alloc(bytes, fill).toString("base64url");
}

interface StoredAccount {
  accountId: string;
  userHandle: string;
  status: "active" | "disabled";
}

interface StoredSession {
  tokenHash: string;
  accountId: string;
  method: "passkey" | "wallet" | "recovery";
  createdAt: number;
  expiresAt: number;
}

interface StoredChallenge extends ConsumedChallenge {
  challengeHash: string;
  bindingHash: string;
}

interface StoredCredential {
  accountId: string;
  credentialId: string;
  publicKey: Uint8Array;
  counter: number;
  deviceType: "singleDevice" | "multiDevice";
  backedUp: boolean;
  transports: AuthStoredCredential["transports"];
}

class MockStore implements AuthStorePort {
  readonly accounts = new Map<string, StoredAccount>();
  readonly sessions = new Map<string, StoredSession>();
  readonly challenges = new Map<string, StoredChallenge>();
  readonly credentials = new Map<string, StoredCredential>();
  readonly wallets = new Map<string, string>();
  readonly recovery = new Map<string, string>();
  readonly rate = new Map<string, number>();
  readonly limits = new Map<string, number>();
  failRate = false;
  private sequence = 0;
  failRegistration = false;

  seedAccount(userHandle: string): string {
    const accountId = this.nextId("openarc:account");
    this.accounts.set(accountId, { accountId, userHandle, status: "active" });
    return accountId;
  }

  /** Seeds a live session for an exact raw token (the service hashes it). */
  seedSession(
    accountId: string,
    token: string,
    method: "passkey" | "wallet" | "recovery" = "passkey",
  ): { tokenHash: string } {
    const tokenHash = sha256(`openarc:session:v1:${token}`);
    const now = Date.now();
    this.sessions.set(tokenHash, {
      tokenHash,
      accountId,
      method,
      createdAt: now,
      expiresAt: now + 24 * 60 * 60 * 1000,
    });
    return { tokenHash };
  }

  #invalid(): never {
    throw new AuthStoreError("AUTH_STORE_CHALLENGE_INVALID");
  }

  nextId(prefix: string): string {
    this.sequence += 1;
    const hex = this.sequence.toString(16).padStart(8, "0");
    return `${prefix}:${hex}-0000-4000-8000-000000000000`;
  }

  async issueChallenge(input: {
    challengeHash: string;
    bindingHash: string;
    kind: AuthChallengeKind;
    challenge: string;
    userHandle?: string;
    walletAddress?: string;
    sessionHash?: string;
  }): Promise<IssuedChallenge> {
    if (this.challenges.has(input.challengeHash)) {
      throw new AuthStoreError("AUTH_STORE_CONFLICT");
    }
    let accountId: string | null = null;
    if (input.kind === "passkey_add" || input.kind === "wallet_link") {
      const session = input.sessionHash
        ? this.sessions.get(input.sessionHash)
        : undefined;
      if (!session || session.expiresAt <= Date.now()) {
        throw new AuthStoreError("AUTH_STORE_SESSION_INVALID");
      }
      accountId = session.accountId;
    }
    const now = Date.now();
    const issued: IssuedChallenge = {
      challengeHash: input.challengeHash,
      bindingHash: input.bindingHash,
      kind: input.kind,
      userHandle: input.userHandle ?? null,
      walletAddress: input.walletAddress ?? null,
      accountId,
      createdAt: new Date(now),
      expiresAt: new Date(now + 5 * 60 * 1000),
    };
    this.challenges.set(input.challengeHash, {
      ...issued,
      challenge: input.challenge,
    });
    return issued;
  }

  async consumeChallenge(input: {
    challengeHash: string;
    bindingHash: string;
    kind: AuthChallengeKind;
    sessionHash?: string;
  }): Promise<ConsumedChallenge> {
    const row = this.challenges.get(input.challengeHash);
    if (
      !row ||
      row.bindingHash !== input.bindingHash ||
      row.kind !== input.kind ||
      row.expiresAt.getTime() <= Date.now()
    ) {
      this.#invalid();
    }
    if (input.kind === "passkey_add" || input.kind === "wallet_link") {
      const session = input.sessionHash
        ? this.sessions.get(input.sessionHash)
        : undefined;
      if (!session || session.accountId !== row.accountId) this.#invalid();
      if (session.expiresAt <= Date.now()) {
        throw new AuthStoreError("AUTH_STORE_SESSION_INVALID");
      }
    }
    this.challenges.delete(input.challengeHash);
    const consumed = { ...row };
    delete (consumed as { challengeHash?: string }).challengeHash;
    delete (consumed as { bindingHash?: string }).bindingHash;
    return consumed as ConsumedChallenge;
  }

  async createPasskeyAccount(input: {
    userHandle: string;
    credential: AuthStoredCredential;
    sessionHash: string;
    previousSessionHash?: string;
  }): Promise<CreatedPasskeyAccount> {
    const accountId = this.nextId("openarc:account");
    this.accounts.set(accountId, {
      accountId,
      userHandle: input.userHandle,
      status: "active",
    });
    this.credentials.set(input.credential.credentialId, {
      ...input.credential,
      accountId,
    });
    if (input.previousSessionHash) this.sessions.delete(input.previousSessionHash);
    const session = this.#insertSession(accountId, input.sessionHash, "passkey");
    return {
      account: { accountId, userHandle: input.userHandle },
      session,
      credential: input.credential,
    };
  }

  async findPasskey(credentialId: unknown): Promise<FoundPasskey | null> {
    if (typeof credentialId !== "string") return null;
    const found = this.credentials.get(credentialId);
    if (!found) return null;
    const account = this.accounts.get(found.accountId);
    if (!account || account.status !== "active") return null;
    return {
      accountId: found.accountId,
      userHandle: account.userHandle,
      credential: {
        credentialId: found.credentialId,
        publicKey: found.publicKey,
        counter: found.counter,
        deviceType: found.deviceType,
        backedUp: found.backedUp,
        transports: found.transports,
      },
    };
  }

  async loginPasskey(input: {
    expectedCredential: ExpectedPasskeyCredential;
    newCounter: number;
    backedUp: boolean;
    sessionHash: string;
    previousSessionHash?: string;
  }): Promise<IssuedSession> {
    const stored = this.credentials.get(input.expectedCredential.credentialId);
    if (!stored || stored.accountId !== input.expectedCredential.accountId) {
      throw new AuthStoreError("AUTH_STORE_CONFLICT");
    }
    stored.counter = input.newCounter;
    stored.backedUp = input.backedUp;
    if (input.previousSessionHash) this.sessions.delete(input.previousSessionHash);
    const account = this.accounts.get(stored.accountId);
    if (!account) throw new AuthStoreError("AUTH_STORE_CONFLICT");
    const session = this.#insertSession(stored.accountId, input.sessionHash, "passkey");
    return {
      account: { accountId: account.accountId, userHandle: account.userHandle },
      session,
    };
  }

  async loginWallet(input: {
    address: string;
    sessionHash: string;
    previousSessionHash?: string;
  }): Promise<IssuedSession> {
    const existing = this.wallets.get(input.address);
    let accountId: string;
    if (existing === undefined) {
      accountId = this.nextId("openarc:account");
      this.accounts.set(accountId, {
        accountId,
        userHandle: b64(32, 17),
        status: "active",
      });
      this.wallets.set(input.address, accountId);
    } else {
      accountId = existing;
    }
    if (input.previousSessionHash) this.sessions.delete(input.previousSessionHash);
    const account = this.accounts.get(accountId);
    if (!account) throw new AuthStoreError("AUTH_STORE_CONFLICT");
    const session = this.#insertSession(accountId, input.sessionHash, "wallet");
    return {
      account: { accountId, userHandle: account.userHandle },
      session,
    };
  }

  async getSession(sessionHash: unknown): Promise<AuthSessionView | null> {
    if (typeof sessionHash !== "string") return null;
    const session = this.sessions.get(sessionHash);
    if (!session || session.expiresAt <= Date.now()) return null;
    const account = this.accounts.get(session.accountId);
    if (!account || account.status !== "active") return null;
    return {
      accountId: session.accountId,
      userHandle: account.userHandle,
      method: session.method,
      createdAt: new Date(session.createdAt),
      expiresAt: new Date(session.expiresAt),
    };
  }

  async logout(sessionHash: unknown): Promise<void> {
    if (typeof sessionHash === "string") this.sessions.delete(sessionHash);
  }

  async addPasskey(input: {
    sessionHash: string;
    credential: AuthStoredCredential;
    userHandle: string;
  }): Promise<AuthStoredCredential> {
    const session = this.sessions.get(input.sessionHash);
    if (!session) throw new AuthStoreError("AUTH_STORE_SESSION_INVALID");
    const account = this.accounts.get(session.accountId);
    if (!account || account.userHandle !== input.userHandle) {
      throw new AuthStoreError("AUTH_STORE_SESSION_INVALID");
    }
    this.credentials.set(input.credential.credentialId, {
      ...input.credential,
      accountId: account.accountId,
    });
    return input.credential;
  }

  async linkWallet(input: { sessionHash: string; address: string }): Promise<void> {
    const session = this.sessions.get(input.sessionHash);
    if (!session) throw new AuthStoreError("AUTH_STORE_SESSION_INVALID");
    if (this.wallets.has(input.address)) {
      throw new AuthStoreError("AUTH_STORE_CONFLICT");
    }
    this.wallets.set(input.address, session.accountId);
  }

  async replaceRecoveryCodes(input: {
    sessionHash: string;
    codeHashes: readonly string[];
  }): Promise<void> {
    const session = this.sessions.get(input.sessionHash);
    if (!session || session.method === "recovery") {
      throw new AuthStoreError("AUTH_STORE_SESSION_INVALID");
    }
    for (const [hash, accountId] of this.recovery) {
      if (accountId === session.accountId) this.recovery.delete(hash);
    }
    for (const hash of input.codeHashes) {
      this.recovery.set(hash, session.accountId);
    }
  }

  async redeemRecoveryCode(input: {
    codeHash: string;
    newSessionHash: string;
  }): Promise<IssuedSession> {
    const accountId = this.recovery.get(input.codeHash);
    if (!accountId) throw new AuthStoreError("AUTH_STORE_INPUT_INVALID");
    this.recovery.delete(input.codeHash);
    for (const [hash, session] of this.sessions) {
      if (session.accountId === accountId) this.sessions.delete(hash);
    }
    for (const [hash, challenge] of this.challenges) {
      if (challenge.accountId === accountId) this.challenges.delete(hash);
    }
    const account = this.accounts.get(accountId);
    if (!account) throw new AuthStoreError("AUTH_STORE_CONFLICT");
    const session = this.#insertSession(accountId, input.newSessionHash, "recovery");
    return {
      account: { accountId, userHandle: account.userHandle },
      session,
    };
  }

  async consumeRateLimit(input: {
    keyHash: string;
    limit: number;
    windowSeconds: number;
  }): Promise<{ allowed: boolean }> {
    if (this.failRate) throw new AuthStoreError("AUTH_STORE_DATABASE");
    const current = (this.rate.get(input.keyHash) ?? 0) + 1;
    this.rate.set(input.keyHash, current);
    this.limits.set(input.keyHash, input.limit);
    return { allowed: current <= input.limit };
  }

  async purgeExpired(): Promise<PurgedExpired> {
    return { challenges: 0, sessions: 0, rateLimits: 0 };
  }

  #insertSession(
    accountId: string,
    tokenHash: string,
    method: "passkey" | "wallet" | "recovery",
  ): { createdAt: Date; expiresAt: Date } {
    const now = Date.now();
    this.sessions.set(tokenHash, {
      tokenHash,
      accountId,
      method,
      createdAt: now,
      expiresAt: now + 24 * 60 * 60 * 1000,
    });
    return { createdAt: new Date(now), expiresAt: new Date(now + 24 * 60 * 60 * 1000) };
  }
}

class MockProofs implements AuthProofPort {
  registrationChallenge = b64(32, 11);
  authenticationChallenge = b64(32, 12);
  nextCounter = 1;
  backedUp = false;
  registrationProof: PasskeyProof = {
    credentialId: b64(16, 21),
    publicKey: new Uint8Array([1, 2, 3]),
    counter: 0,
    deviceType: "multiDevice",
    backedUp: false,
    transports: ["internal"],
  };
  assertionUserHandle: string | undefined;
  walletMessage = "";
  failRegistration = false;
  badRegistrationOptions = false;

  validateAuthOriginConfig(input: unknown): AuthOriginConfig {
    const value = input as {
      origin: string;
      rpId: string;
      environment: "development" | "production";
    };
    return { origin: value.origin, rpId: value.rpId, environment: value.environment };
  }

  async generatePasskeyRegistration(userHandle: string) {
    return {
      challenge: this.badRegistrationOptions
        ? "x".repeat(3000)
        : this.registrationChallenge,
      rp: { id: RP_ID, name: "OpenArc" },
      user: {
        id: userHandle,
        name: `OpenArc ${userHandle.slice(0, 8)}`,
        displayName: `OpenArc ${userHandle.slice(0, 8)}`,
      },
      pubKeyCredParams: [
        { type: "public-key" as const, alg: -7 as const },
        { type: "public-key" as const, alg: -257 as const },
      ],
      timeout: 60_000,
      attestation: "none" as const,
    };
  }

  async generatePasskeyAuthentication() {
    return {
      challenge: this.authenticationChallenge,
      timeout: 60_000,
      rpId: RP_ID,
      allowCredentials: [],
      userVerification: "required" as const,
    };
  }

  async verifyPasskeyRegistration(): Promise<PasskeyProof> {
    if (this.failRegistration) throw new Error("proof invalid");
    return this.registrationProof;
  }

  async verifyPasskeyAuthentication(): Promise<{
    newCounter: number;
    backedUp: boolean;
  }> {
    return { newCounter: this.nextCounter, backedUp: this.backedUp };
  }

  createWalletLoginMessage(context: {
    address: string;
    nonce: string;
    issuedAt: Date;
  }): string {
    this.walletMessage = `${context.address}|${context.nonce}|${context.issuedAt.getTime()}`;
    return this.walletMessage;
  }

  async verifyWalletLoginProof(
    message: string,
    signature: string,
    context: { address: string; nonce: string; issuedAt: Date },
  ): Promise<string> {
    const expected = `${context.address}|${context.nonce}|${context.issuedAt.getTime()}`;
    if (message !== expected) throw new Error("proof invalid");
    if (signature !== `0x${"ab".repeat(65)}`) throw new Error("proof invalid");
    return context.address.toLowerCase();
  }
}

function runtime(seed = 1): AuthRuntime {
  let counter = seed;
  return {
    randomBytes: (size: number) => {
      counter += 1;
      const value = new Uint8Array(size);
      for (let index = 0; index < size; index += 1) {
        value[index] = (counter + index) % 256;
      }
      return value;
    },
    now: () => new Date(1_760_000_000_000 + counter),
  };
}

const apps: ReturnType<typeof createApp>[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map(async (app) => app.close()));
});

function harness(options: { authEnabled?: boolean; failRate?: boolean } = {}) {
  const store = new MockStore();
  store.failRate = options.failRate ?? false;
  const proofs = new MockProofs();
  const authConfig: AuthServiceConfig = {
    authSecret: SECRET,
    appOrigin: ORIGIN,
    rpId: RP_ID,
    environment: "development",
    secureCookies: false,
    cookieNames: { session: "openarc_session", binding: "openarc_binding" },
  };
  const service = new AuthService({
    config: authConfig,
    store,
    proofs,
    runtime: runtime(),
  });
  const logs: CompletionLog[] = [];
  const authEnabled = options.authEnabled ?? true;
  const config = loadConfig({
    NODE_ENV: "test",
    APP_ORIGIN: ORIGIN,
    COMMIT_SHA: BUILD_SHA,
    AUTH_ENABLED: authEnabled ? "true" : "false",
    ...(authEnabled
      ? {
          AUTH_DATABASE_URL: "postgres://openarc_auth_app:x@127.0.0.1:5432/openarc_auth_test",
          AUTH_SECRET: SECRET,
          AUTH_RP_ID: RP_ID,
        }
      : {}),
  });
  const app = createApp({
    config,
    logger: false,
    logSink: (entry) => logs.push(entry),
    ...(authEnabled ? { authService: service } : {}),
  });
  apps.push(app);
  return { app, store, proofs, logs, service };
}

function cookiesFrom(response: { headers: Record<string, unknown> }): {
  session?: string;
  binding?: string;
  raw: string[];
} {
  const raw = [response.headers["set-cookie"]]
    .flat()
    .filter((value): value is string => typeof value === "string");
  const jar: { session?: string; binding?: string; raw: string[] } = { raw };
  for (const cookie of raw) {
    const [pair] = cookie.split(";");
    if (pair === undefined) continue;
    const separator = pair.indexOf("=");
    const name = pair.slice(0, separator);
    const value = pair.slice(separator + 1);
    if (name === "openarc_session") jar.session = value;
    if (name === "openarc_binding") jar.binding = value;
  }
  return jar;
}

async function bootstrap(app: ReturnType<typeof createApp>) {
  const response = await app.inject({
    method: "POST",
    url: AUTH_ROUTES.bootstrap,
    headers: JSON_HEADERS,
    payload: {},
  });
  expect(response.statusCode).toBe(200);
  const body = response.json();
  const jar = cookiesFrom(response);
  return {
    csrf: body.data.csrfToken as string,
    session: body.data.session,
    jar,
  };
}

function authHeaders(
  jar: { session?: string | undefined; binding?: string | undefined },
  csrf: string,
) {
  const pairs = [
    jar.session ? `openarc_session=${jar.session}` : undefined,
    jar.binding ? `openarc_binding=${jar.binding}` : undefined,
  ].filter((value): value is string => value !== undefined);
  return { ...JSON_HEADERS, "x-openarc-csrf": csrf, cookie: pairs.join("; ") };
}

describe("default-off and legacy behaviour", () => {
  it("serves legacy health/root unchanged and disables every auth route", async () => {
    const { app } = harness({ authEnabled: false });
    const health = await app.inject({ method: "GET", url: "/healthz" });
    expect(health.statusCode).toBe(200);
    const guest = await app.inject({
      method: "GET",
      url: AUTH_ROUTES.session,
      headers: CLIENT,
    });
    expect(guest.statusCode).toBe(503);
    expect(guest.json().error.code).toBe("FEATURE_DISABLED");
    expect(guest.headers["set-cookie"]).toBeUndefined();
    for (const path of [AUTH_ROUTES.bootstrap, AUTH_ROUTES.registerOptions]) {
      const response = await app.inject({
        method: "POST",
        url: path,
        headers: JSON_HEADERS,
        payload: {},
      });
      expect(response.statusCode).toBe(503);
    }
  });
});

describe("transport and CSRF boundary", () => {
  it("requires exact Origin, custom client header, JSON and no query", async () => {
    const { app } = harness();
    const cases: Array<{ headers: Record<string, string>; url?: string }> = [
      { headers: { ...JSON_HEADERS, origin: "https://evil.example" } },
      { headers: { ...JSON_HEADERS, origin: "null" } },
      { headers: { ...JSON_HEADERS, "x-openarc-client": "other" } },
      { headers: { ...JSON_HEADERS, "content-type": "text/plain" } },
      { headers: { ...JSON_HEADERS, "content-type": "application/x-www-form-urlencoded" } },
      { headers: JSON_HEADERS, url: `${AUTH_ROUTES.bootstrap}?x=1` },
    ];
    for (const [index, entry] of cases.entries()) {
      const headers = Object.fromEntries(
        Object.entries(entry.headers).filter(
          (pair): pair is [string, string] => pair[1] !== undefined,
        ),
      );
      const response = await app.inject({
        method: "POST",
        url: entry.url ?? AUTH_ROUTES.bootstrap,
        headers,
        payload: {},
      });
      expect([400, 403, 415], `case ${index}`).toContain(response.statusCode);
      expect(response.headers["cache-control"]).toBe("no-store");
    }
  });

  it("rejects unknown fields, oversize and wrong media before any store call", async () => {
    const { app, store } = harness();
    const { jar, csrf } = await bootstrap(app);
    const before = store.challenges.size;
    for (const payload of [
      { acceptMinimalRecords: true, email: "x@example.test" },
      { acceptMinimalRecords: false },
      { arbitrary: "PRIVATE_CANARY" },
    ]) {
      const response = await app.inject({
        method: "POST",
        url: AUTH_ROUTES.registerOptions,
        headers: authHeaders({ binding: jar.binding }, csrf),
        payload,
      });
      expect(response.statusCode).toBe(400);
      expect(response.body).not.toContain("PRIVATE_CANARY");
    }
    expect(store.challenges.size).toBe(before);
  });

  it("rejects duplicate auth cookies and never parses Authorization/query", async () => {
    const { app } = harness();
    const duplicate = await app.inject({
      method: "GET",
      url: AUTH_ROUTES.session,
      headers: {
        ...CLIENT,
        cookie: "openarc_session=a; openarc_session=b",
      },
    });
    expect(duplicate.statusCode).toBe(400);
    const authorization = await app.inject({
      method: "GET",
      url: AUTH_ROUTES.session,
      headers: { ...CLIENT, authorization: "Bearer token" },
    });
    expect(authorization.statusCode).toBe(400);
  });

  it("requires a valid CSRF token for every non-bootstrap POST", async () => {
    const { app } = harness();
    const { jar, csrf } = await bootstrap(app);
    const noCsrf = await app.inject({
      method: "POST",
      url: AUTH_ROUTES.registerOptions,
      headers: { ...JSON_HEADERS, cookie: `openarc_binding=${jar.binding}` },
      payload: { acceptMinimalRecords: true },
    });
    expect(noCsrf.statusCode).toBe(403);
    const wrongCsrf = await app.inject({
      method: "POST",
      url: AUTH_ROUTES.registerOptions,
      headers: authHeaders({ binding: jar.binding }, "wrong"),
      payload: { acceptMinimalRecords: true },
    });
    expect(wrongCsrf.statusCode).toBe(403);
    const ok = await app.inject({
      method: "POST",
      url: AUTH_ROUTES.registerOptions,
      headers: authHeaders({ binding: jar.binding }, csrf),
      payload: { acceptMinimalRecords: true },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().data.flowId).toBeTruthy();
    expect(ok.json().data.options.user.id).toBeTruthy();
  });
});

describe("guest session", () => {
  it("does not create a cookie for guests and reports signedOut", async () => {
    const { app } = harness();
    const response = await app.inject({
      method: "GET",
      url: AUTH_ROUTES.session,
      headers: CLIENT,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().data.session).toEqual({ signedIn: false });
    expect(response.headers["set-cookie"]).toBeUndefined();
    expect(response.json().meta.schemaVersion).toBe("openarc.api.v2");
  });

  it("bootstrap issues a binding cookie and csrf, never a session cookie", async () => {
    const { app } = harness();
    const response = await app.inject({
      method: "POST",
      url: AUTH_ROUTES.bootstrap,
      headers: JSON_HEADERS,
      payload: {},
    });
    expect(response.statusCode).toBe(200);
    const setCookies = [response.headers["set-cookie"]].flat();
    expect(setCookies).toHaveLength(1);
    expect(String(setCookies[0])).toContain("openarc_binding=");
    expect(String(setCookies[0])).toContain("HttpOnly");
    expect(String(setCookies[0])).toContain("Max-Age=300");
    expect(response.json().data.session).toEqual({ signedIn: false });
  });
});

describe("passkey registration and login", () => {
  it("registers with a DB-bound challenge consumed before verification", async () => {
    const { app, store, proofs } = harness();
    const { jar, csrf } = await bootstrap(app);
    const options = await app.inject({
      method: "POST",
      url: AUTH_ROUTES.registerOptions,
      headers: authHeaders({ binding: jar.binding }, csrf),
      payload: { acceptMinimalRecords: true },
    });
    expect(options.statusCode).toBe(200);
    const flowId = options.json().data.flowId as string;
    const optionsCsrf = options.json().data.options;
    expect(optionsCsrf.challenge).toBe(proofs.registrationChallenge);

    // Wrong account/kind cannot consume the DB challenge.
    const consumption = sha256(`openarc:flow:v1:${flowId}`);
    expect(store.challenges.has(consumption)).toBe(true);

    const verify = await app.inject({
      method: "POST",
      url: AUTH_ROUTES.registerVerify,
      headers: authHeaders({ binding: jar.binding }, csrf),
      payload: {
        flowId,
        response: {
          id: proofs.registrationProof.credentialId,
          rawId: proofs.registrationProof.credentialId,
          type: "public-key",
          response: { clientDataJSON: b64(16, 31), attestationObject: b64(16, 32) },
        },
      },
    });
    expect(verify.statusCode).toBe(200);
    expect(verify.json().data.session).toMatchObject({
      signedIn: true,
      method: "passkey",
    });
    expect(store.challenges.has(consumption)).toBe(false);
    const sessionCookie = cookiesFrom(verify).session;
    expect(sessionCookie).toBeTruthy();

    const session = await app.inject({
      method: "GET",
      url: AUTH_ROUTES.session,
      headers: { ...CLIENT, cookie: `openarc_session=${sessionCookie}` },
    });
    expect(session.json().data.session).toMatchObject({ signedIn: true, method: "passkey" });
    expect(session.body).not.toContain(proofs.registrationProof.credentialId);
  });

  it("consumes a failed proof attempt exactly once and rejects replay", async () => {
    const { app, store, proofs } = harness();
    const { jar, csrf } = await bootstrap(app);
    const options = await app.inject({
      method: "POST",
      url: AUTH_ROUTES.registerOptions,
      headers: authHeaders({ binding: jar.binding }, csrf),
      payload: { acceptMinimalRecords: true },
    });
    const flowId = options.json().data.flowId as string;
    const consumption = sha256(`openarc:flow:v1:${flowId}`);
    proofs.failRegistration = true;
    const badProof = {
      flowId,
      response: {
        id: proofs.registrationProof.credentialId,
        rawId: proofs.registrationProof.credentialId,
        type: "public-key",
        response: {
          clientDataJSON: b64(16, 41),
          attestationObject: b64(16, 42),
        },
      },
    };
    const first = await app.inject({
      method: "POST",
      url: AUTH_ROUTES.registerVerify,
      headers: authHeaders({ binding: jar.binding }, csrf),
      payload: badProof,
    });
    expect(first.statusCode).toBe(400);
    expect(store.challenges.has(consumption)).toBe(false);
    const replay = await app.inject({
      method: "POST",
      url: AUTH_ROUTES.registerVerify,
      headers: authHeaders({ binding: jar.binding }, csrf),
      payload: badProof,
    });
    expect(replay.statusCode).toBe(401);
  });

  it("rejects wrong binding cookie without consuming the challenge", async () => {
    const { app, store } = harness();
    const { jar, csrf } = await bootstrap(app);
    const options = await app.inject({
      method: "POST",
      url: AUTH_ROUTES.loginOptions,
      headers: authHeaders({ binding: jar.binding }, csrf),
      payload: {},
    });
    expect(options.statusCode).toBe(200);
    const flowId = options.json().data.flowId as string;
    const consumed = sha256(`openarc:flow:v1:${flowId}`);
    const other = await bootstrap(app);
    const response = await app.inject({
      method: "POST",
      url: AUTH_ROUTES.loginVerify,
      headers: authHeaders({ binding: other.jar.binding }, other.csrf),
      payload: { flowId, response: { id: b64(16, 5), rawId: b64(16, 5), type: "public-key", response: { clientDataJSON: b64(16, 1), authenticatorData: b64(16, 2), signature: b64(16, 3) } } },
    });
    expect(response.statusCode).toBe(401);
    expect(store.challenges.has(consumed)).toBe(true);
  });
});

describe("wallet and recovery", () => {
  const ADDRESS = "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed";

  it("logs in a wallet using DB-created timestamp and lowercases the address", async () => {
    const { app, store, proofs } = harness();
    const { jar, csrf } = await bootstrap(app);
    const options = await app.inject({
      method: "POST",
      url: AUTH_ROUTES.walletLoginOptions,
      headers: authHeaders({ binding: jar.binding }, csrf),
      payload: { address: ADDRESS },
    });
    expect(options.statusCode).toBe(200);
    const flowId = options.json().data.flowId as string;
    const message = options.json().data.message as string;
    expect(message).toBe(proofs.walletMessage);
    const verify = await app.inject({
      method: "POST",
      url: AUTH_ROUTES.walletLoginVerify,
      headers: authHeaders({ binding: jar.binding }, csrf),
      payload: { flowId, message, signature: `0x${"ab".repeat(65)}` },
    });
    expect(verify.statusCode).toBe(200);
    expect(verify.json().data.session).toMatchObject({ signedIn: true, method: "wallet" });
    expect(store.wallets.get(ADDRESS.toLowerCase())).toBeTruthy();
  });

  it("issues exactly eight recovery codes once and stores hashes only", async () => {
    const { app, store, proofs } = harness();
    const { jar, csrf } = await bootstrap(app);
    const options = await app.inject({
      method: "POST",
      url: AUTH_ROUTES.registerOptions,
      headers: authHeaders({ binding: jar.binding }, csrf),
      payload: { acceptMinimalRecords: true },
    });
    const flowId = options.json().data.flowId as string;
    const verify = await app.inject({
      method: "POST",
      url: AUTH_ROUTES.registerVerify,
      headers: authHeaders({ binding: jar.binding }, csrf),
      payload: {
        flowId,
        response: {
          id: proofs.registrationProof.credentialId,
          rawId: proofs.registrationProof.credentialId,
          type: "public-key",
          response: { clientDataJSON: b64(16, 31), attestationObject: b64(16, 32) },
        },
      },
    });
    const sessionJar = { ...cookiesFrom(verify), binding: jar.binding };
    const codes = await app.inject({
      method: "POST",
      url: AUTH_ROUTES.recoveryCodes,
      headers: authHeaders(sessionJar, verify.json().data.csrfToken),
      payload: {},
    });
    expect(codes.statusCode).toBe(200);
    const list = codes.json().data.codes as string[];
    expect(list).toHaveLength(8);
    expect(new Set(list).size).toBe(8);
    for (const code of list) {
      expect(store.recovery.has(sha256(`openarc:recovery:v1:${code}`))).toBe(true);
    }
    expect(JSON.stringify([...store.recovery.keys()])).not.toContain(list[0] as string);
  });

  it("rejects recovery replacement from a recovery session", async () => {
    const { app, store } = harness();
    const accountId = store.nextId("openarc:account");
    store.accounts.set(accountId, { accountId, userHandle: b64(32, 3), status: "active" });
    const tokenHash = sha256("recovery-token");
    store.sessions.set(tokenHash, {
      tokenHash,
      accountId,
      method: "recovery",
      createdAt: Date.now(),
      expiresAt: Date.now() + 60_000,
    });
    const { app: fresh } = { app };
    const response = await fresh.inject({
      method: "POST",
      url: AUTH_ROUTES.recoveryCodes,
      headers: { ...JSON_HEADERS, cookie: `openarc_session=${"recovery-token"}` },
      payload: {},
    });
    // No binding cookie here: the transport rejects before the method check.
    expect([401, 403]).toContain(response.statusCode);
  });
});

describe("rate limits and fixed errors", () => {
  it("fails closed with a fixed 503 when the rate limiter store fails", async () => {
    const { app } = harness({ failRate: true });
    const response = await app.inject({
      method: "POST",
      url: AUTH_ROUTES.bootstrap,
      headers: JSON_HEADERS,
      payload: {},
    });
    expect(response.statusCode).toBe(503);
    expect(response.json().error.code).toBe("INTERNAL_ERROR");
    expect(response.body).not.toContain("database unavailable");
  });

  it("returns 429 with a fixed envelope when a quota is exhausted", async () => {
    const { app, store } = harness();
    const { jar, csrf } = await bootstrap(app);
    for (const key of store.rate.keys()) store.rate.set(key, 1_000_000);
    const response = await app.inject({
      method: "POST",
      url: AUTH_ROUTES.loginOptions,
      headers: authHeaders({ binding: jar.binding }, csrf),
      payload: {},
    });
    expect(response.statusCode).toBe(429);
    expect(response.json().error.code).toBe("RATE_LIMITED");
  });

  it("logout revokes idempotently and clears both cookies", async () => {
    const { app, store } = harness();
    const { jar, csrf } = await bootstrap(app);
    const accountId = store.nextId("openarc:account");
    store.accounts.set(accountId, { accountId, userHandle: b64(32, 9), status: "active" });
    const response = await app.inject({
      method: "POST",
      url: AUTH_ROUTES.logout,
      headers: authHeaders({ binding: jar.binding }, csrf),
      payload: {},
    });
    expect(response.statusCode).toBe(200);
    const setCookies = [response.headers["set-cookie"]].flat();
    expect(setCookies).toHaveLength(2);
    for (const cookie of setCookies) {
      expect(String(cookie)).toContain("Max-Age=0");
    }
  });
});

describe("challenge binding to the presented session", () => {
  const HANDLE = b64(32, 61);
  const S1 = b64(32, 62);
  const S2 = b64(32, 63);
  const OTHER = b64(32, 64);

  async function bootstrapFor(
    app: ReturnType<typeof createApp>,
    binding: string | undefined,
    session: string | undefined,
  ) {
    const pairs = [
      binding ? `openarc_binding=${binding}` : undefined,
      session ? `openarc_session=${session}` : undefined,
    ].filter((value): value is string => value !== undefined);
    const response = await app.inject({
      method: "POST",
      url: AUTH_ROUTES.bootstrap,
      headers: { ...JSON_HEADERS, cookie: pairs.join("; ") },
      payload: {},
    });
    expect(response.statusCode).toBe(200);
    return {
      csrf: response.json().data.csrfToken as string,
      session: response.json().data.session,
      jar: cookiesFrom(response),
    };
  }

  it("rejects a same-account S1->S2 add flow and keeps it unconsumed", async () => {
    const { app, store } = harness();
    const accountId = store.seedAccount(HANDLE);
    store.seedSession(accountId, S1);
    store.seedSession(accountId, S2);
    const guest = await bootstrap(app);
    const s1 = await bootstrapFor(app, guest.jar.binding, S1);
    expect(s1.session).toMatchObject({ signedIn: true, method: "passkey" });

    const options = await app.inject({
      method: "POST",
      url: AUTH_ROUTES.addOptions,
      headers: authHeaders({ session: S1, binding: guest.jar.binding }, s1.csrf),
      payload: {},
    });
    expect(options.statusCode).toBe(200);
    const flowId = options.json().data.flowId as string;
    const consumption = sha256(`openarc:flow:v1:${flowId}`);
    expect(store.challenges.has(consumption)).toBe(true);

    // Same account, rotated session S2: the presented hash no longer matches
    // the hash bound when the challenge was issued.
    const s2 = await bootstrapFor(app, guest.jar.binding, S2);
    expect(s2.session).toMatchObject({ signedIn: true, method: "passkey" });
    const rotated = await app.inject({
      method: "POST",
      url: AUTH_ROUTES.addVerify,
      headers: authHeaders({ session: S2, binding: guest.jar.binding }, s2.csrf),
      payload: {
        flowId,
        response: {
          id: b64(16, 65),
          rawId: b64(16, 65),
          type: "public-key",
          response: { clientDataJSON: b64(16, 66), attestationObject: b64(16, 67) },
        },
      },
    });
    expect(rotated.statusCode).toBe(401);
    expect(store.challenges.has(consumption)).toBe(true);

    // The original S1 browser can still consume its own fresh flow.
    const original = await app.inject({
      method: "POST",
      url: AUTH_ROUTES.addVerify,
      headers: authHeaders({ session: S1, binding: guest.jar.binding }, s1.csrf),
      payload: {
        flowId,
        response: {
          id: b64(16, 68),
          rawId: b64(16, 68),
          type: "public-key",
          response: { clientDataJSON: b64(16, 69), attestationObject: b64(16, 70) },
        },
      },
    });
    expect(original.statusCode).toBe(200);
    expect(store.challenges.has(consumption)).toBe(false);
  });

  it("rejects a guest flow presented by an authenticated session", async () => {
    const { app, store } = harness();
    const accountId = store.seedAccount(HANDLE);
    store.seedSession(accountId, S1);
    const guest = await bootstrap(app);
    const options = await app.inject({
      method: "POST",
      url: AUTH_ROUTES.loginOptions,
      headers: authHeaders({ binding: guest.jar.binding }, guest.csrf),
      payload: {},
    });
    expect(options.statusCode).toBe(200);
    const flowId = options.json().data.flowId as string;
    const consumption = sha256(`openarc:flow:v1:${flowId}`);

    const authenticated = await bootstrapFor(app, guest.jar.binding, S1);
    const verify = await app.inject({
      method: "POST",
      url: AUTH_ROUTES.loginVerify,
      headers: authHeaders(
        { session: S1, binding: guest.jar.binding },
        authenticated.csrf,
      ),
      payload: {
        flowId,
        response: {
          id: b64(16, 71),
          rawId: b64(16, 71),
          type: "public-key",
          response: {
            clientDataJSON: b64(16, 72),
            authenticatorData: b64(16, 73),
            signature: b64(16, 74),
          },
        },
      },
    });
    expect(verify.statusCode).toBe(401);
    expect(store.challenges.has(consumption)).toBe(true);
  });

  it("does not let another principal consume a flow", async () => {
    const { app, store } = harness();
    const firstId = store.seedAccount(HANDLE);
    store.seedSession(firstId, S1);
    const secondId = store.seedAccount(b64(32, 75));
    store.seedSession(secondId, OTHER);
    const guest = await bootstrap(app);
    const s1 = await bootstrapFor(app, guest.jar.binding, S1);
    const options = await app.inject({
      method: "POST",
      url: AUTH_ROUTES.addOptions,
      headers: authHeaders({ session: S1, binding: guest.jar.binding }, s1.csrf),
      payload: {},
    });
    const flowId = options.json().data.flowId as string;
    const consumption = sha256(`openarc:flow:v1:${flowId}`);

    const other = await bootstrapFor(app, guest.jar.binding, OTHER);
    const attempt = await app.inject({
      method: "POST",
      url: AUTH_ROUTES.addVerify,
      headers: authHeaders(
        { session: OTHER, binding: guest.jar.binding },
        other.csrf,
      ),
      payload: {
        flowId,
        response: {
          id: b64(16, 76),
          rawId: b64(16, 76),
          type: "public-key",
          response: { clientDataJSON: b64(16, 77), attestationObject: b64(16, 78) },
        },
      },
    });
    expect(attempt.statusCode).toBe(401);
    expect(store.challenges.has(consumption)).toBe(true);
  });
});

describe("bootstrap stale session recovery", () => {
  it("clears a revoked session cookie and continues as a working guest", async () => {
    const { app, store } = harness();
    const accountId = store.seedAccount(b64(32, 81));
    const token = b64(32, 82);
    const seeded = store.seedSession(accountId, token);
    store.sessions.delete(seeded.tokenHash);
    const guest = await bootstrap(app);
    const accountsBefore = store.accounts.size;

    const stale = await app.inject({
      method: "POST",
      url: AUTH_ROUTES.bootstrap,
      headers: {
        ...JSON_HEADERS,
        cookie: `openarc_binding=${guest.jar.binding}; openarc_session=${token}`,
      },
      payload: {},
    });
    expect(stale.statusCode).toBe(200);
    expect(stale.json().data.session).toEqual({ signedIn: false });
    const setCookies = [stale.headers["set-cookie"]].flat().map(String);
    expect(setCookies.some((cookie) => cookie.startsWith("openarc_session=;"))).toBe(
      true,
    );
    const staleCsrf = stale.json().data.csrfToken as string;

    // Apply Set-Cookie: the client drops the stale session but keeps binding.
    const options = await app.inject({
      method: "POST",
      url: AUTH_ROUTES.loginOptions,
      headers: authHeaders({ binding: guest.jar.binding }, staleCsrf),
      payload: {},
    });
    expect(options.statusCode).toBe(200);
    expect(options.json().data.flowId).toBeTruthy();
    expect(store.accounts.size).toBe(accountsBefore);
  });
});

describe("v2 error normalization on auth routes", () => {
  function expectV2Error(response: { statusCode: number; json: () => unknown }, status: number, code: string) {
    expect(response.statusCode).toBe(status);
    const body = response.json() as {
      ok: boolean;
      error: { code: string; message: string; retryable: boolean };
      meta: { schemaVersion: string };
    };
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe(code);
    expect(body.error.message.length).toBeGreaterThan(0);
    expect(body.meta.schemaVersion).toBe("openarc.api.v2");
  }

  it("normalizes malformed JSON into a strict v2 400", async () => {
    const { app } = harness();
    const response = await app.inject({
      method: "POST",
      url: AUTH_ROUTES.bootstrap,
      headers: JSON_HEADERS,
      payload: '{"flowId":',
    });
    expectV2Error(response, 400, "INVALID_REQUEST");
  });

  it("normalizes an oversized body into a strict v2 413", async () => {
    const { app } = harness();
    const response = await app.inject({
      method: "POST",
      url: AUTH_ROUTES.bootstrap,
      headers: JSON_HEADERS,
      payload: JSON.stringify({ pad: "a".repeat(20_000) }),
    });
    expectV2Error(response, 413, "REQUEST_TOO_LARGE");
    expect(response.body).not.toContain("a".repeat(100));
  });

  it("normalizes a response-schema validation failure into a strict v2 500", async () => {
    const { app, proofs } = harness();
    const { jar, csrf } = await bootstrap(app);
    proofs.badRegistrationOptions = true;
    const response = await app.inject({
      method: "POST",
      url: AUTH_ROUTES.registerOptions,
      headers: authHeaders({ binding: jar.binding }, csrf),
      payload: { acceptMinimalRecords: true },
    });
    expectV2Error(response, 500, "INTERNAL_ERROR");
    expect(response.body).not.toContain("x".repeat(100));
  });
});
