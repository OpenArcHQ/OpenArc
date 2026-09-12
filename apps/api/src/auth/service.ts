import { createHash } from "node:crypto";

import type {
  AccountPasskeyAuthenticationOptionsResponse,
  AccountPasskeyRegistrationOptionsResponse,
  AccountRecoveryCodesResponse,
  AccountSessionView,
} from "@openarc/shared";
import { AuthStoreError, type AuthStoredCredential } from "@openarc/db";
import { getAddress } from "viem";

import { AuthProofError, type AuthOriginConfig } from "./proofs.js";
import {
  clearCookie,
  deriveCsrfToken,
  hmacHex,
  issueBindingCookie,
  serializeBindingCookie,
  serializeSessionCookie,
  verifyBindingCookie,
  verifyCsrfToken,
  type AuthCookieNames,
  type ParsedAuthCookies,
} from "./cookies.js";
import { AUTH_ERRORS, AuthApiError } from "./errors.js";
import type { AuthProofPort, AuthRuntime, AuthStorePort } from "./ports.js";

/**
 * Account-only orchestration across the reviewed proof adapters and the
 * durable account repository. It holds no in-memory session or rate-limit
 * state: every decision is delegated to the DB or rejected when the DB fails.
 */

const SESSION_TOKEN_BYTES = 32;
const FLOW_BYTES = 32;
const RECOVERY_CODE_BYTES = 32;
const RECOVERY_CODE_COUNT = 8;
const WALLET_NONCE_BYTES = 16;
const FRESH_SESSION_MS = 5 * 60 * 1000;

export interface AuthRateLimits {
  globalLimit: number;
  globalWindowSeconds: number;
  peerLimit: number;
  peerWindowSeconds: number;
  bindingLimit: number;
  bindingWindowSeconds: number;
  recoveryLimit: number;
  recoveryWindowSeconds: number;
}

export const AUTH_RATE_LIMITS: AuthRateLimits = Object.freeze({
  globalLimit: 600,
  globalWindowSeconds: 60,
  peerLimit: 120,
  peerWindowSeconds: 3600,
  bindingLimit: 120,
  bindingWindowSeconds: 3600,
  recoveryLimit: 5,
  recoveryWindowSeconds: 900,
});

export interface AuthServiceConfig {
  authSecret: string;
  appOrigin: string;
  rpId: string;
  environment: "development" | "production";
  secureCookies: boolean;
  cookieNames: AuthCookieNames;
  rateLimits?: AuthRateLimits;
}

export interface AuthRequestContext {
  peerIp: string;
  cookies: ParsedAuthCookies;
}

export interface AuthSessionResult {
  session: AccountSessionView;
  csrfToken: string;
  setCookies: string[];
  clearCookies: string[];
}

function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

function b64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

function isoTimestamp(date: Date): string {
  return date.toISOString();
}

function sessionView(view: {
  accountId: string;
  method: "passkey" | "wallet" | "recovery";
  expiresAt: Date;
}): AccountSessionView {
  return {
    signedIn: true,
    accountId: view.accountId as Extract<
      AccountSessionView,
      { signedIn: true }
    >["accountId"],
    method: view.method,
    expiresAt: isoTimestamp(view.expiresAt),
  };
}

const GUEST_SESSION: AccountSessionView = { signedIn: false };

export class AuthService {
  readonly #config: AuthServiceConfig;
  readonly #store: AuthStorePort;
  readonly #proofs: AuthProofPort;
  readonly #runtime: AuthRuntime;
  readonly #origin: AuthOriginConfig;
  #housekeeping: ReturnType<typeof setInterval> | undefined;

  constructor(options: {
    config: AuthServiceConfig;
    store: AuthStorePort;
    proofs: AuthProofPort;
    runtime?: AuthRuntime;
  }) {
    this.#config = options.config;
    this.#store = options.store;
    this.#proofs = options.proofs;
    this.#runtime =
      options.runtime ??
      ({
        randomBytes: (size: number) => crypto.getRandomValues(new Uint8Array(size)),
        now: () => new Date(),
      } satisfies AuthRuntime);
    this.#origin = this.#proofs.validateAuthOriginConfig({
      origin: options.config.appOrigin,
      rpId: options.config.rpId,
      environment: options.config.environment,
    });
  }

  /* ---------------------------------------------------------------- */
  /* Public route operations                                           */
  /* ---------------------------------------------------------------- */

  async bootstrap(ctx: AuthRequestContext): Promise<{
    csrfToken: string;
    session: AccountSessionView;
    setCookies: string[];
    clearCookies: string[];
  }> {
    await this.#enforceLimits(ctx, ctx.cookies.binding, false);
    const now = this.#runtime.now().getTime();

    let bindingValue: string;
    if (ctx.cookies.binding !== null) {
      try {
        bindingValue = verifyBindingCookie(
          this.#config.authSecret,
          ctx.cookies.binding,
          now,
        );
      } catch {
        bindingValue = this.#newBinding(now);
      }
    } else {
      bindingValue = this.#newBinding(now);
    }

    const presented = this.#presentedSessionHash(ctx.cookies);
    const live = presented === null ? null : await this.#safeGetSession(presented);
    const session = live === null ? GUEST_SESSION : sessionView(live);
    const csrfToken = deriveCsrfToken(
      this.#config.authSecret,
      bindingValue,
      live === null ? null : presented,
    );
    // A presented-but-not-live session cookie must be cleared in the same
    // response as the guest-bound CSRF, otherwise every subsequent POST would
    // compare against the stale hash and fail permanently.
    const clearCookies =
      presented !== null && live === null
        ? [clearCookie(this.#config.cookieNames.session, this.#config.secureCookies)]
        : [];
    return {
      csrfToken,
      session,
      clearCookies,
      setCookies: [
        serializeBindingCookie(
          this.#config.cookieNames.binding,
          bindingValue,
          this.#config.secureCookies,
        ),
      ],
    };
  }

  async session(ctx: AuthRequestContext): Promise<{
    session: AccountSessionView;
    clearCookies: string[];
  }> {
    const presented = this.#presentedSessionHash(ctx.cookies);
    if (presented === null) return { session: GUEST_SESSION, clearCookies: [] };
    const live = await this.#safeGetSession(presented);
    if (live === null) {
      return {
        session: GUEST_SESSION,
        clearCookies: [
          clearCookie(this.#config.cookieNames.session, this.#config.secureCookies),
        ],
      };
    }
    return { session: sessionView(live), clearCookies: [] };
  }

  async registerOptions(
    ctx: AuthRequestContext,
  ): Promise<AccountPasskeyRegistrationOptionsResponse> {
    await this.#enforceLimits(ctx, ctx.cookies.binding, false);
    const bindingValue = this.#requireBinding(ctx);
    const userHandle = b64url(this.#runtime.randomBytes(32));
    const flowId = b64url(this.#runtime.randomBytes(FLOW_BYTES));
    let generated: Awaited<ReturnType<AuthProofPort["generatePasskeyRegistration"]>>;
    try {
      generated = await this.#proofs.generatePasskeyRegistration(
        userHandle,
        this.#origin,
      );
    } catch {
      throw AUTH_ERRORS.invalidRequest();
    }
    await this.#issueChallenge({
      flowId,
      bindingValue,
      bindingSessionHash: this.#presentedSessionHash(ctx.cookies),
      kind: "passkey_register",
      challenge: generated.challenge,
      userHandle,
    });
    return {
      flowId,
      options: {
        challenge: generated.challenge,
        rp: {
          ...(generated.rp.id !== undefined ? { id: generated.rp.id } : {}),
          name: generated.rp.name,
        },
        user: {
          id: generated.user.id,
          name: generated.user.name,
          displayName: generated.user.displayName,
        },
        pubKeyCredParams: generated.pubKeyCredParams.map((entry) => ({
          type: "public-key" as const,
          alg: entry.alg,
        })),
        ...(generated.timeout !== undefined
          ? { timeout: generated.timeout }
          : {}),
        ...(generated.excludeCredentials !== undefined
          ? {
              excludeCredentials: generated.excludeCredentials.map((entry) => ({
                id: entry.id,
                type: "public-key" as const,
                ...(entry.transports !== undefined
                  ? { transports: [...entry.transports] }
                  : {}),
              })),
            }
          : {}),
        ...(generated.authenticatorSelection !== undefined
          ? {
              authenticatorSelection: {
                ...(generated.authenticatorSelection
                  .authenticatorAttachment !== undefined
                  ? {
                      authenticatorAttachment:
                        generated.authenticatorSelection.authenticatorAttachment,
                    }
                  : {}),
                ...(generated.authenticatorSelection.residentKey !== undefined
                  ? {
                      residentKey:
                        generated.authenticatorSelection.residentKey,
                    }
                  : {}),
                ...(generated.authenticatorSelection
                  .requireResidentKey !== undefined
                  ? {
                      requireResidentKey:
                        generated.authenticatorSelection.requireResidentKey,
                    }
                  : {}),
                ...(generated.authenticatorSelection.userVerification !==
                undefined
                  ? {
                      userVerification:
                        generated.authenticatorSelection.userVerification,
                    }
                  : {}),
              },
            }
          : {}),
        ...(generated.attestation !== undefined
          ? { attestation: generated.attestation }
          : {}),
        ...(generated.extensions !== undefined
          ? { extensions: { ...generated.extensions } }
          : {}),
      },
    };
  }

  async registerVerify(
    ctx: AuthRequestContext,
    body: { flowId: string; response: unknown },
  ): Promise<AuthSessionResult> {
    await this.#enforceLimits(ctx, ctx.cookies.binding, false);
    const bindingValue = this.#requireBinding(ctx);
    const consumed = await this.#consumeChallenge({
      flowId: body.flowId,
      bindingValue,
      bindingSessionHash: this.#presentedSessionHash(ctx.cookies),
      kind: "passkey_register",
    });
    if (consumed.userHandle === null) throw AUTH_ERRORS.unauthenticated();
    const proof = await this.#verifyRegistration(
      body.response,
      consumed.challenge,
    );
    const newSession = this.#newSessionMaterial();
    const previous = await this.#livePresentedSession(ctx.cookies);
    const created = await this.#guardStore(async () =>
      this.#store.createPasskeyAccount({
        userHandle: consumed.userHandle as string,
        credential: proof,
        sessionHash: newSession.hash,
        ...(previous !== null ? { previousSessionHash: previous.hash } : {}),
      }),
    );
    return this.#sessionResult(
      created.account.accountId,
      "passkey",
      created.session.expiresAt,
      bindingValue,
      newSession,
    );
  }

  async loginOptions(
    ctx: AuthRequestContext,
  ): Promise<AccountPasskeyAuthenticationOptionsResponse> {
    await this.#enforceLimits(ctx, ctx.cookies.binding, false);
    const bindingValue = this.#requireBinding(ctx);
    const flowId = b64url(this.#runtime.randomBytes(FLOW_BYTES));
    let generated: Awaited<
      ReturnType<AuthProofPort["generatePasskeyAuthentication"]>
    >;
    try {
      generated = await this.#proofs.generatePasskeyAuthentication(this.#origin);
    } catch {
      throw AUTH_ERRORS.invalidRequest();
    }
    await this.#issueChallenge({
      flowId,
      bindingValue,
      bindingSessionHash: this.#presentedSessionHash(ctx.cookies),
      kind: "passkey_login",
      challenge: generated.challenge,
    });
    return {
      flowId,
      options: {
        challenge: generated.challenge,
        ...(generated.timeout !== undefined ? { timeout: generated.timeout } : {}),
        ...(generated.rpId !== undefined ? { rpId: generated.rpId } : {}),
        ...(generated.allowCredentials !== undefined
          ? {
              allowCredentials: generated.allowCredentials.map((entry) => ({
                id: entry.id,
                type: "public-key" as const,
              })),
            }
          : {}),
        ...(generated.userVerification !== undefined
          ? { userVerification: generated.userVerification }
          : {}),
        ...(generated.extensions !== undefined
          ? { extensions: { ...generated.extensions } }
          : {}),
      },
    };
  }

  async loginVerify(
    ctx: AuthRequestContext,
    body: { flowId: string; response: unknown },
  ): Promise<AuthSessionResult> {
    await this.#enforceLimits(ctx, ctx.cookies.binding, false);
    const bindingValue = this.#requireBinding(ctx);
    const consumed = await this.#consumeChallenge({
      flowId: body.flowId,
      bindingValue,
      bindingSessionHash: this.#presentedSessionHash(ctx.cookies),
      kind: "passkey_login",
    });
    const credentialId = this.#credentialIdFromResponse(body.response);
    const found = await this.#guardStore(() =>
      this.#store.findPasskey(credentialId),
    );
    if (found === null) throw AUTH_ERRORS.unauthenticated();
    const assertionHandle = this.#assertionUserHandle(body.response);
    if (assertionHandle !== null && assertionHandle !== found.userHandle) {
      throw AUTH_ERRORS.unauthenticated();
    }
    const verified = await this.#verifyAuthentication(
      body.response,
      consumed.challenge,
      found.credential,
    );
    const newSession = this.#newSessionMaterial();
    const previous = await this.#livePresentedSession(ctx.cookies);
    const session = await this.#guardStore(() =>
      this.#store.loginPasskey({
        expectedCredential: {
          accountId: found.accountId,
          credentialId: found.credential.credentialId,
          publicKey: found.credential.publicKey,
          counter: found.credential.counter,
          deviceType: found.credential.deviceType,
          backedUp: found.credential.backedUp,
          transports: found.credential.transports,
        },
        newCounter: verified.newCounter,
        backedUp: verified.backedUp,
        sessionHash: newSession.hash,
        ...(previous !== null ? { previousSessionHash: previous.hash } : {}),
      }),
    );
    return this.#sessionResult(
      session.account.accountId,
      "passkey",
      session.session.expiresAt,
      bindingValue,
      newSession,
    );
  }

  async addOptions(
    ctx: AuthRequestContext,
  ): Promise<AccountPasskeyRegistrationOptionsResponse> {
    await this.#enforceLimits(ctx, ctx.cookies.binding, false);
    const bindingValue = this.#requireBinding(ctx);
    const current = await this.#requireFreshSession(ctx.cookies);
    const flowId = b64url(this.#runtime.randomBytes(FLOW_BYTES));
    let generated: Awaited<ReturnType<AuthProofPort["generatePasskeyRegistration"]>>;
    try {
      generated = await this.#proofs.generatePasskeyRegistration(
        current.userHandle,
        this.#origin,
      );
    } catch {
      throw AUTH_ERRORS.invalidRequest();
    }
    await this.#issueChallenge({
      flowId,
      bindingValue,
      bindingSessionHash: current.hash,
      kind: "passkey_add",
      challenge: generated.challenge,
      userHandle: current.userHandle,
      sessionHash: current.hash,
    });
    return {
      flowId,
      options: {
        challenge: generated.challenge,
        rp: {
          ...(generated.rp.id !== undefined ? { id: generated.rp.id } : {}),
          name: generated.rp.name,
        },
        user: {
          id: generated.user.id,
          name: generated.user.name,
          displayName: generated.user.displayName,
        },
        pubKeyCredParams: generated.pubKeyCredParams.map((entry) => ({
          type: "public-key" as const,
          alg: entry.alg,
        })),
        ...(generated.timeout !== undefined
          ? { timeout: generated.timeout }
          : {}),
        ...(generated.authenticatorSelection !== undefined
          ? { authenticatorSelection: { ...generated.authenticatorSelection } }
          : {}),
        ...(generated.attestation !== undefined
          ? { attestation: generated.attestation }
          : {}),
      },
    };
  }

  async addVerify(
    ctx: AuthRequestContext,
    body: { flowId: string; response: unknown },
  ): Promise<AuthSessionResult> {
    await this.#enforceLimits(ctx, ctx.cookies.binding, false);
    const bindingValue = this.#requireBinding(ctx);
    const start = await this.#requireFreshSession(ctx.cookies);
    const consumed = await this.#consumeChallenge({
      flowId: body.flowId,
      bindingValue,
      bindingSessionHash: start.hash,
      kind: "passkey_add",
      sessionHash: start.hash,
    });
    if (consumed.userHandle === null || consumed.userHandle !== start.userHandle) {
      throw AUTH_ERRORS.unauthenticated();
    }
    const proof = await this.#verifyRegistration(
      body.response,
      consumed.challenge,
    );
    // Confirm the presented session still resolves to the SAME account after
    // async verification, and is still fresh, before any repository mutation.
    const after = await this.#requireFreshSession(ctx.cookies);
    if (after.hash !== start.hash || after.accountId !== start.accountId) {
      throw AUTH_ERRORS.unauthenticated();
    }
    await this.#guardStore(() =>
      this.#store.addPasskey({
        sessionHash: start.hash,
        credential: proof,
        userHandle: start.userHandle,
      }),
    );
    return {
      session: sessionView({
        accountId: start.accountId,
        method: start.method,
        expiresAt: start.expiresAt,
      }),
      csrfToken: deriveCsrfToken(this.#config.authSecret, bindingValue, start.hash),
      setCookies: [],
      clearCookies: [],
    };
  }

  async walletLoginOptions(
    ctx: AuthRequestContext,
    body: { address: string },
  ): Promise<{ flowId: string; message: string }> {
    await this.#enforceLimits(ctx, ctx.cookies.binding, false);
    const bindingValue = this.#requireBinding(ctx);
    const address = this.#canonicalAddress(body.address);
    const flowId = b64url(this.#runtime.randomBytes(FLOW_BYTES));
    const nonce = Buffer.from(
      this.#runtime.randomBytes(WALLET_NONCE_BYTES),
    ).toString("hex");
    const issued = await this.#issueChallenge({
      flowId,
      bindingValue,
      bindingSessionHash: this.#presentedSessionHash(ctx.cookies),
      kind: "wallet_login",
      challenge: nonce,
      walletAddress: address,
    });
    const message = this.#walletMessage(address, nonce, issued.createdAt);
    return { flowId, message };
  }

  async walletLoginVerify(
    ctx: AuthRequestContext,
    body: { flowId: string; message: string; signature: string },
  ): Promise<AuthSessionResult> {
    await this.#enforceLimits(ctx, ctx.cookies.binding, false);
    const bindingValue = this.#requireBinding(ctx);
    const consumed = await this.#consumeChallenge({
      flowId: body.flowId,
      bindingValue,
      bindingSessionHash: this.#presentedSessionHash(ctx.cookies),
      kind: "wallet_login",
    });
    if (consumed.walletAddress === null) throw AUTH_ERRORS.unauthenticated();
    const verified = await this.#verifyWallet(
      body.message,
      body.signature,
      consumed.walletAddress,
      consumed.challenge,
      consumed.createdAt,
    );
    if (verified !== consumed.walletAddress) throw AUTH_ERRORS.unauthenticated();
    const newSession = this.#newSessionMaterial();
    const previous = await this.#livePresentedSession(ctx.cookies);
    const session = await this.#guardStore(() =>
      this.#store.loginWallet({
        address: verified,
        sessionHash: newSession.hash,
        ...(previous !== null ? { previousSessionHash: previous.hash } : {}),
      }),
    );
    return this.#sessionResult(
      session.account.accountId,
      "wallet",
      session.session.expiresAt,
      bindingValue,
      newSession,
    );
  }

  async walletLinkOptions(
    ctx: AuthRequestContext,
    body: { address: string },
  ): Promise<{ flowId: string; message: string }> {
    await this.#enforceLimits(ctx, ctx.cookies.binding, false);
    const bindingValue = this.#requireBinding(ctx);
    const current = await this.#requireFreshSession(ctx.cookies);
    const address = this.#canonicalAddress(body.address);
    const flowId = b64url(this.#runtime.randomBytes(FLOW_BYTES));
    const nonce = Buffer.from(
      this.#runtime.randomBytes(WALLET_NONCE_BYTES),
    ).toString("hex");
    const issued = await this.#issueChallenge({
      flowId,
      bindingValue,
      bindingSessionHash: current.hash,
      kind: "wallet_link",
      challenge: nonce,
      walletAddress: address,
      sessionHash: current.hash,
    });
    const message = this.#walletMessage(address, nonce, issued.createdAt);
    return { flowId, message };
  }

  async walletLinkVerify(
    ctx: AuthRequestContext,
    body: { flowId: string; message: string; signature: string },
  ): Promise<AuthSessionResult> {
    await this.#enforceLimits(ctx, ctx.cookies.binding, false);
    const bindingValue = this.#requireBinding(ctx);
    const start = await this.#requireFreshSession(ctx.cookies);
    const consumed = await this.#consumeChallenge({
      flowId: body.flowId,
      bindingValue,
      bindingSessionHash: start.hash,
      kind: "wallet_link",
      sessionHash: start.hash,
    });
    if (consumed.walletAddress === null) throw AUTH_ERRORS.unauthenticated();
    const verified = await this.#verifyWallet(
      body.message,
      body.signature,
      consumed.walletAddress,
      consumed.challenge,
      consumed.createdAt,
    );
    if (verified !== consumed.walletAddress) throw AUTH_ERRORS.unauthenticated();
    const after = await this.#requireFreshSession(ctx.cookies);
    if (after.hash !== start.hash || after.accountId !== start.accountId) {
      throw AUTH_ERRORS.unauthenticated();
    }
    await this.#guardStore(() =>
      this.#store.linkWallet({ sessionHash: start.hash, address: verified }),
    );
    return {
      session: sessionView({
        accountId: start.accountId,
        method: start.method,
        expiresAt: start.expiresAt,
      }),
      csrfToken: deriveCsrfToken(this.#config.authSecret, bindingValue, start.hash),
      setCookies: [],
      clearCookies: [],
    };
  }

  async recoveryCodes(
    ctx: AuthRequestContext,
  ): Promise<AccountRecoveryCodesResponse> {
    await this.#enforceLimits(ctx, ctx.cookies.binding, false);
    const current = await this.#requireFreshSession(ctx.cookies);
    if (current.method === "recovery") throw AUTH_ERRORS.forbidden();
    const codes: string[] = [];
    const codeHashes: string[] = [];
    for (let index = 0; index < RECOVERY_CODE_COUNT; index += 1) {
      const code = b64url(this.#runtime.randomBytes(RECOVERY_CODE_BYTES));
      codes.push(code);
      codeHashes.push(sha256Hex(`openarc:recovery:v1:${code}`));
    }
    await this.#guardStore(() =>
      this.#store.replaceRecoveryCodes({
        sessionHash: current.hash,
        codeHashes,
      }),
    );
    return {
      codes: [
        codes[0] as string,
        codes[1] as string,
        codes[2] as string,
        codes[3] as string,
        codes[4] as string,
        codes[5] as string,
        codes[6] as string,
        codes[7] as string,
      ],
    };
  }

  async recoveryRedeem(
    ctx: AuthRequestContext,
    body: { code: string },
  ): Promise<AuthSessionResult> {
    await this.#enforceLimits(ctx, ctx.cookies.binding, true);
    const bindingValue = this.#requireBinding(ctx);
    if (body.code.length === 0 || body.code.length > 256) {
      throw AUTH_ERRORS.invalidRequest();
    }
    const codeHash = sha256Hex(`openarc:recovery:v1:${body.code}`);
    const newSession = this.#newSessionMaterial();
    const session = await this.#guardStore(() =>
      this.#store.redeemRecoveryCode({
        codeHash,
        newSessionHash: newSession.hash,
      }),
    );
    return this.#sessionResult(
      session.account.accountId,
      "recovery",
      session.session.expiresAt,
      bindingValue,
      newSession,
    );
  }

  async logout(ctx: AuthRequestContext): Promise<{ clearCookies: string[] }> {
    await this.#enforceLimits(ctx, ctx.cookies.binding, false);
    const presented = this.#presentedSessionHash(ctx.cookies);
    if (presented !== null) {
      await this.#guardStore(() => this.#store.logout(presented));
    }
    return {
      clearCookies: [
        clearCookie(this.#config.cookieNames.session, this.#config.secureCookies),
        clearCookie(this.#config.cookieNames.binding, this.#config.secureCookies),
      ],
    };
  }

  /* ---------------------------------------------------------------- */
  /* Housekeeping                                                      */
  /* ---------------------------------------------------------------- */

  startHousekeeping(intervalMs = 60_000): void {
    if (this.#housekeeping !== undefined) return;
    this.#housekeeping = setInterval(() => {
      void this.#store.purgeExpired({ limit: 200 }).catch(() => undefined);
    }, intervalMs);
    this.#housekeeping.unref?.();
  }

  stopHousekeeping(): void {
    if (this.#housekeeping !== undefined) {
      clearInterval(this.#housekeeping);
      this.#housekeeping = undefined;
    }
  }

  /* ---------------------------------------------------------------- */
  /* Internal helpers                                                  */
  /* ---------------------------------------------------------------- */

  #newBinding(nowMillis: number): string {
    const nonce = b64url(this.#runtime.randomBytes(16));
    return issueBindingCookie(this.#config.authSecret, nonce, nowMillis);
  }

  #presentedSessionHash(cookies: ParsedAuthCookies): string | null {
    if (cookies.session === null) return null;
    if (!/^[A-Za-z0-9_-]{43}$/u.test(cookies.session)) {
      throw AUTH_ERRORS.invalidRequest();
    }
    const decoded = Buffer.from(cookies.session, "base64url");
    if (
      decoded.length !== 32 ||
      decoded.toString("base64url") !== cookies.session
    ) {
      throw AUTH_ERRORS.invalidRequest();
    }
    return sha256Hex(`openarc:session:v1:${cookies.session}`);
  }

  #requireBinding(ctx: AuthRequestContext): string {
    if (ctx.cookies.binding === null) throw AUTH_ERRORS.csrfRejected();
    try {
      return verifyBindingCookie(
        this.#config.authSecret,
        ctx.cookies.binding,
        this.#runtime.now().getTime(),
      );
    } catch {
      throw AUTH_ERRORS.csrfRejected();
    }
  }

  #newSessionMaterial(): { token: string; hash: string } {
    const token = b64url(this.#runtime.randomBytes(SESSION_TOKEN_BYTES));
    return { token, hash: sha256Hex(`openarc:session:v1:${token}`) };
  }

  async #safeGetSession(hash: string): Promise<{
    accountId: string;
    userHandle: string;
    method: "passkey" | "wallet" | "recovery";
    createdAt: Date;
    expiresAt: Date;
  } | null> {
    try {
      return await this.#store.getSession(hash);
    } catch {
      throw AUTH_ERRORS.unavailable();
    }
  }

  async #livePresentedSession(
    cookies: ParsedAuthCookies,
  ): Promise<{ hash: string } | null> {
    const presented = this.#presentedSessionHash(cookies);
    if (presented === null) return null;
    const live = await this.#safeGetSession(presented);
    return live === null ? null : { hash: presented };
  }

  async #requireFreshSession(cookies: ParsedAuthCookies): Promise<{
    hash: string;
    accountId: string;
    userHandle: string;
    method: "passkey" | "wallet" | "recovery";
    expiresAt: Date;
  }> {
    const presented = this.#presentedSessionHash(cookies);
    if (presented === null) throw AUTH_ERRORS.unauthenticated();
    const live = await this.#safeGetSession(presented);
    if (live === null) throw AUTH_ERRORS.unauthenticated();
    const now = this.#runtime.now().getTime();
    if (!(live.expiresAt.getTime() > now)) throw AUTH_ERRORS.unauthenticated();
    if (!(live.createdAt.getTime() > now - FRESH_SESSION_MS)) {
      throw AUTH_ERRORS.unauthenticated();
    }
    return {
      hash: presented,
      accountId: live.accountId,
      userHandle: live.userHandle,
      method: live.method,
      expiresAt: live.expiresAt,
    };
  }

  #bindingHash(bindingValue: string, sessionHash: string | null): string {
    return sha256Hex(
      `openarc:binding:v1:${bindingValue}:${sessionHash ?? ""}`,
    );
  }

  async #issueChallenge(input: {
    flowId: string;
    bindingValue: string;
    /**
     * The PRESENTED session hash (guest is null), bound into the challenge so
     * a guest/authenticated transition or a same-account S1->S2 rotation
     * cannot consume the challenge. This is distinct from `sessionHash`, the
     * optional account-authorizing session the DB contract accepts for
     * add/link.
     */
    bindingSessionHash: string | null;
    kind:
      | "passkey_register"
      | "passkey_login"
      | "passkey_add"
      | "wallet_login"
      | "wallet_link";
    challenge: string;
    userHandle?: string;
    walletAddress?: string;
    sessionHash?: string;
  }) {
    const challengeHash = sha256Hex(`openarc:flow:v1:${input.flowId}`);
    const bindingHash = this.#bindingHash(
      input.bindingValue,
      input.bindingSessionHash,
    );
    return this.#guardStore(() =>
      this.#store.issueChallenge({
        challengeHash,
        bindingHash,
        kind: input.kind,
        challenge: input.challenge,
        ...(input.userHandle !== undefined
          ? { userHandle: input.userHandle }
          : {}),
        ...(input.walletAddress !== undefined
          ? { walletAddress: input.walletAddress }
          : {}),
        ...(input.sessionHash !== undefined
          ? { sessionHash: input.sessionHash }
          : {}),
      }),
    );
  }

  async #consumeChallenge(input: {
    flowId: string;
    bindingValue: string;
    bindingSessionHash: string | null;
    kind:
      | "passkey_register"
      | "passkey_login"
      | "passkey_add"
      | "wallet_login"
      | "wallet_link";
    sessionHash?: string;
  }) {
    const challengeHash = sha256Hex(`openarc:flow:v1:${input.flowId}`);
    const bindingHash = this.#bindingHash(
      input.bindingValue,
      input.bindingSessionHash,
    );
    return this.#guardStore(() =>
      this.#store.consumeChallenge({
        challengeHash,
        bindingHash,
        kind: input.kind,
        ...(input.sessionHash !== undefined
          ? { sessionHash: input.sessionHash }
          : {}),
      }),
    );
  }

  async #verifyRegistration(
    response: unknown,
    challenge: string,
  ): Promise<AuthStoredCredential> {
    try {
      const proof = await this.#proofs.verifyPasskeyRegistration(
        response,
        challenge,
        this.#origin,
      );
      return {
        credentialId: proof.credentialId,
        publicKey: new Uint8Array(proof.publicKey),
        counter: proof.counter,
        deviceType: proof.deviceType,
        backedUp: proof.backedUp,
        transports: [...proof.transports],
      };
    } catch {
      throw AUTH_ERRORS.invalidRequest();
    }
  }

  async #verifyAuthentication(
    response: unknown,
    challenge: string,
    credential: AuthStoredCredential,
  ): Promise<{ newCounter: number; backedUp: boolean }> {
    try {
      return await this.#proofs.verifyPasskeyAuthentication(
        response,
        challenge,
        this.#origin,
        {
          credentialId: credential.credentialId,
          publicKey: new Uint8Array(credential.publicKey),
          counter: credential.counter,
          deviceType: credential.deviceType,
          backedUp: credential.backedUp,
          transports: [...credential.transports],
        },
      );
    } catch {
      throw AUTH_ERRORS.unauthenticated();
    }
  }

  #credentialIdFromResponse(response: unknown): string {
    if (
      typeof response !== "object" ||
      response === null ||
      typeof (response as { id?: unknown }).id !== "string"
    ) {
      throw AUTH_ERRORS.invalidRequest();
    }
    return (response as { id: string }).id;
  }

  #assertionUserHandle(response: unknown): string | null {
    if (typeof response !== "object" || response === null) return null;
    const inner = (response as { response?: unknown }).response;
    if (typeof inner !== "object" || inner === null) return null;
    const handle = (inner as { userHandle?: unknown }).userHandle;
    return typeof handle === "string" ? handle : null;
  }

  #canonicalAddress(input: string): string {
    try {
      return getAddress(input).toLowerCase();
    } catch {
      throw AUTH_ERRORS.invalidRequest();
    }
  }

  #walletMessage(address: string, nonce: string, issuedAt: Date): string {
    try {
      return this.#proofs.createWalletLoginMessage({
        address,
        nonce,
        issuedAt,
        config: this.#origin,
      });
    } catch {
      throw AUTH_ERRORS.invalidRequest();
    }
  }

  async #verifyWallet(
    message: string,
    signature: string,
    address: string,
    nonce: string,
    issuedAt: Date,
  ): Promise<string> {
    try {
      return await this.#proofs.verifyWalletLoginProof(
        message,
        signature,
        { address, nonce, issuedAt, config: this.#origin },
        this.#runtime.now(),
      );
    } catch {
      throw AUTH_ERRORS.unauthenticated();
    }
  }

  #sessionResult(
    accountId: string,
    method: "passkey" | "wallet" | "recovery",
    expiresAt: Date,
    bindingValue: string,
    session: { token: string; hash: string },
  ): AuthSessionResult {
    return {
      session: sessionView({ accountId, method, expiresAt }),
      csrfToken: deriveCsrfToken(
        this.#config.authSecret,
        bindingValue,
        session.hash,
      ),
      setCookies: [
        serializeSessionCookie(
          this.#config.cookieNames.session,
          session.token,
          this.#config.secureCookies,
        ),
      ],
      clearCookies: [],
    };
  }

  async #enforceLimits(
    ctx: AuthRequestContext,
    bindingValue: string | null,
    recovery: boolean,
  ): Promise<void> {
    const limits = this.#config.rateLimits ?? AUTH_RATE_LIMITS;
    const now = this.#runtime.now().getTime();
    const globalWindow = Math.floor(now / (limits.globalWindowSeconds * 1000));
    const checks: Array<{ keyHash: string; limit: number; windowSeconds: number }> = [
      {
        keyHash: hmacHex(
          this.#config.authSecret,
          "openarc:rate:global:v1",
          String(globalWindow),
        ),
        limit: limits.globalLimit,
        windowSeconds: limits.globalWindowSeconds,
      },
      {
        keyHash: hmacHex(
          this.#config.authSecret,
          "openarc:rate:peer:v1",
          ctx.peerIp,
        ),
        limit: limits.peerLimit,
        windowSeconds: limits.peerWindowSeconds,
      },
    ];
    if (bindingValue !== null) {
      checks.push({
        keyHash: hmacHex(
          this.#config.authSecret,
          "openarc:rate:binding:v1",
          bindingValue,
        ),
        limit: limits.bindingLimit,
        windowSeconds: limits.bindingWindowSeconds,
      });
    }
    if (recovery) {
      checks.push({
        keyHash: hmacHex(
          this.#config.authSecret,
          "openarc:rate:recovery:v1",
          ctx.peerIp,
        ),
        limit: limits.recoveryLimit,
        windowSeconds: limits.recoveryWindowSeconds,
      });
    }
    for (const check of checks) {
      let allowed: boolean;
      try {
        allowed = (await this.#store.consumeRateLimit(check)).allowed;
      } catch {
        throw AUTH_ERRORS.unavailable();
      }
      if (!allowed) throw AUTH_ERRORS.rateLimited();
    }
  }

  #requireCsrf(
    bindingValue: string,
    sessionHash: string | null,
    provided: unknown,
  ): void {
    if (
      !verifyCsrfToken(
        this.#config.authSecret,
        bindingValue,
        sessionHash,
        provided,
      )
    ) {
      throw AUTH_ERRORS.csrfRejected();
    }
  }

  /** Verifies CSRF for a state-changing request from the raw header value. */
  verifyCsrf(
    cookies: ParsedAuthCookies,
    csrfHeader: unknown,
  ): string {
    const bindingValue = this.#requireBinding({ peerIp: "", cookies });
    const presented = this.#presentedSessionHash(cookies);
    this.#requireCsrf(bindingValue, presented, csrfHeader);
    return bindingValue;
  }

  async #guardStore<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (error) {
      if (error instanceof AuthApiError) throw error;
      if (error instanceof AuthStoreError) {
        throw this.#mapStoreError(error);
      }
      if (error instanceof AuthProofError) {
        throw AUTH_ERRORS.invalidRequest();
      }
      throw AUTH_ERRORS.internal();
    }
  }

  #mapStoreError(error: AuthStoreError): AuthApiError {
    switch (error.code) {
      case "AUTH_STORE_SESSION_INVALID":
      case "AUTH_STORE_CHALLENGE_INVALID":
        return AUTH_ERRORS.unauthenticated();
      case "AUTH_STORE_ACCOUNT_DISABLED":
        return AUTH_ERRORS.forbidden();
      case "AUTH_STORE_CONFLICT":
      case "AUTH_STORE_INPUT_INVALID":
        return AUTH_ERRORS.invalidRequest();
      case "AUTH_STORE_LIMIT_REACHED":
        return AUTH_ERRORS.forbidden();
      case "AUTH_STORE_DATABASE":
        return AUTH_ERRORS.unavailable();
    }
    return AUTH_ERRORS.internal();
  }
}
