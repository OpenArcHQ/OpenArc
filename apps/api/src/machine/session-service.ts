import {
  CommerceMachineCredentialTokenSchema,
  CommerceMachineSessionExchangeResultSchema,
  CommerceMachineSessionMetadataSchema,
  CommerceMachineSessionRevokeResultSchema,
  CommerceMachineSessionSelfResultSchema,
  compareIsoTimestamps,
  type CommerceMachineSessionExchangeResult,
  type CommerceMachineSessionRevokeResult,
  type CommerceMachineSessionSelfResult,
} from "@openarc/shared";
import { CredentialStoreError } from "@openarc/db";

import { AUTH_ERRORS, AuthApiError } from "../auth/errors.js";
import {
  MachineCredentialError,
  parseMachineCredential,
  type MachineCredentialKind,
} from "./credential-crypto.js";
import { MACHINE_RATE_LIMITS, type MachineRateLimiter } from "./rate-limiter.js";
import type {
  MachineCryptoPort,
  MachineSessionFactoryPort,
  MachineSessionStorePort,
} from "./ports.js";
import {
  generateSessionId,
  generateSessionToken,
  hashSessionToken,
  isSessionTokenForKind,
} from "./session-token.js";

/**
 * Machine session exchange and current-session orchestration.
 *
 * Exchange order: bounded token shape, typed canonical long-lived credential,
 * the ordered global/peer/lookup durable limiter, a typed verifier snapshot,
 * the accepted real async scrypt verify, then independent session material and
 * exactly ONE `create*Session` call whose SQL rechecks issuer, membership,
 * profile, credential and the snapshot's expected revocation version after the
 * KDF. Each self/revoke reads the CURRENT database state by token hash with no
 * auth cache.
 *
 * The raw long-lived credential and the raw session token never enter a store,
 * log or error. A wrong-namespace token fails the fixed 401 before touching the
 * other kind's store, and a long-lived credential can never satisfy the short
 * session-token shape.
 */

const SESSION_TTL_MS = 5 * 60 * 1000;
const MAX_SESSION_TTL_MS = 15 * 60 * 1000;

export interface MachineSessionServiceOptions {
  readonly store: MachineSessionStorePort;
  readonly crypto: MachineCryptoPort;
  readonly limits: MachineRateLimiter;
  readonly now?: () => Date;
  readonly factory?: MachineSessionFactoryPort;
}

function unauthorized(): AuthApiError {
  return AUTH_ERRORS.unauthenticated();
}

function unavailable(): AuthApiError {
  return AUTH_ERRORS.unavailable();
}

function projectionFailure(): AuthApiError {
  return AUTH_ERRORS.internal();
}

function mapCryptoError(error: unknown): never {
  if (error instanceof AuthApiError) throw error;
  if (error instanceof MachineCredentialError) {
    if (error.code === "BUSY") throw AUTH_ERRORS.rateLimited();
    if (
      error.code === "INVALID_RECORD" ||
      error.code === "UNSUPPORTED_VERSION" ||
      error.code === "DISPOSED" ||
      error.code === "CRYPTO_FAILURE" ||
      error.code === "INVALID_CONFIG"
    ) {
      throw unavailable();
    }
    throw unauthorized();
  }
  throw unavailable();
}

/**
 * Credential/session repository failures during machine auth collapse to the
 * same fixed 401 without an existence oracle. Genuine store outages remain a
 * non-retryable 503.
 */
function mapSessionStoreError(error: unknown): never {
  if (error instanceof AuthApiError) throw error;
  if (error instanceof CredentialStoreError) {
    switch (error.code) {
      case "CREDENTIAL_STORE_SESSION_INVALID":
      case "CREDENTIAL_STORE_FORBIDDEN":
      case "CREDENTIAL_STORE_NOT_FOUND":
      case "CREDENTIAL_STORE_CONFLICT":
        throw unauthorized();
      case "CREDENTIAL_STORE_INPUT_INVALID":
        throw unauthorized();
      case "CREDENTIAL_STORE_UNAVAILABLE":
      case "CREDENTIAL_STORE_OUTCOME_UNKNOWN":
      case "CREDENTIAL_STORE_IDEMPOTENCY_CONFLICT":
      default:
        throw unavailable();
    }
  }
  throw unavailable();
}

export class MachineSessionService {
  readonly #store: MachineSessionStorePort;
  readonly #crypto: MachineCryptoPort;
  readonly #limits: MachineRateLimiter;
  readonly #now: () => Date;
  readonly #factory: MachineSessionFactoryPort;

  constructor(options: MachineSessionServiceOptions) {
    this.#store = options.store;
    this.#crypto = options.crypto;
    this.#limits = options.limits;
    this.#now = options.now ?? (() => new Date());
    this.#factory =
      options.factory ??
      ({
        sessionToken: (kind) => generateSessionToken(kind),
        sessionId: () => generateSessionId(),
      } satisfies MachineSessionFactoryPort);
  }

  async exchange(
    kind: MachineCredentialKind,
    input: { readonly token: unknown; readonly peerIp: string },
  ): Promise<CommerceMachineSessionExchangeResult> {
    const raw = requireLongLivedToken(kind, input.token);
    const parsed = parseMachineCredential(raw);
    if (parsed.kind !== kind) throw unauthorized();

    await this.#limits.consumeAll([
      {
        family: "exchange",
        bucket: "global",
        kind,
        value: "*",
        limit: MACHINE_RATE_LIMITS.exchange.global,
      },
      {
        family: "exchange",
        bucket: "peer",
        kind,
        value: input.peerIp,
        limit: MACHINE_RATE_LIMITS.exchange.peer,
      },
      {
        family: "exchange",
        bucket: "lookup",
        kind,
        value: parsed.lookupId,
        limit: MACHINE_RATE_LIMITS.exchange.lookup,
      },
    ]);

    let snapshot;
    try {
      snapshot =
        kind === "agent"
          ? await this.#store.findAgentCredentialVerifier(parsed.lookupId)
          : await this.#store.findProviderCredentialVerifier(parsed.lookupId);
    } catch (error) {
      mapSessionStoreError(error);
    }
    if (snapshot.kind !== kind || snapshot.environment !== "eip155:5042002") {
      throw unauthorized();
    }

    let verified: boolean;
    try {
      verified = await this.#crypto.verify({
        raw,
        record: {
          algorithm: snapshot.algorithm,
          hashVersion: snapshot.hashVersion,
          pepperVersion: snapshot.pepperVersion,
          N: snapshot.N,
          r: snapshot.r,
          p: snapshot.p,
          salt: snapshot.salt,
          digest: snapshot.digest,
        },
        expectedKind: kind,
        expectedLookupId: parsed.lookupId,
      });
    } catch (error) {
      mapCryptoError(error);
    }
    if (!verified) throw unauthorized();

    const sessionId = this.#factory.sessionId();
    const sessionToken = this.#factory.sessionToken(kind);
    const tokenHash = hashSessionToken(kind, sessionToken);
    const expiresAt = this.#sessionExpiry(snapshot.expiresAt);

    let metadata;
    try {
      const createInput = {
        organizationId: snapshot.organizationId,
        profileId: snapshot.profileId,
        credentialId: snapshot.credentialId,
        expectedVersion: snapshot.revocationVersion,
        sessionId,
        tokenHash,
        expiresAt,
      };
      metadata =
        kind === "agent"
          ? await this.#store.createAgentSession(createInput)
          : await this.#store.createProviderSession(createInput);
    } catch (error) {
      mapSessionStoreError(error);
    }

    const session = projectSession(kind, metadata, snapshot);
    // The schema-validated metadata must correlate with the generated session
    // id and the exact requested expiry (including any credential cap).
    // `compareIsoTimestamps` compares the full sub-millisecond precision, so a
    // valid returned expiry extended by even 0.0001s is rejected here, before
    // the one-time token can be returned. An equivalent textual form of the
    // same instant compares as equal.
    let expiryMatches: boolean;
    try {
      expiryMatches = compareIsoTimestamps(session.expiresAt, expiresAt) === 0;
    } catch {
      throw projectionFailure();
    }
    if (session.sessionId !== sessionId || !expiryMatches) {
      throw projectionFailure();
    }
    const parsedResult = CommerceMachineSessionExchangeResultSchema.safeParse({
      session,
      delivery: { status: "available_once", token: sessionToken },
    });
    if (!parsedResult.success) throw projectionFailure();
    return parsedResult.data;
  }

  async self(
    kind: MachineCredentialKind,
    input: { readonly token: unknown; readonly peerIp: string },
  ): Promise<CommerceMachineSessionSelfResult> {
    const token = requireSessionToken(kind, input.token);
    await this.#consumeSessionLimits(kind, token, input.peerIp);
    const tokenHash = hashSessionToken(kind, token);
    let metadata;
    try {
      metadata =
        kind === "agent"
          ? await this.#store.getAgentSession(tokenHash)
          : await this.#store.getProviderSession(tokenHash);
    } catch (error) {
      mapSessionStoreError(error);
    }
    const session = projectSession(kind, metadata, null);
    const parsedResult = CommerceMachineSessionSelfResultSchema.safeParse({
      session,
    });
    if (!parsedResult.success) throw projectionFailure();
    return parsedResult.data;
  }

  async revoke(
    kind: MachineCredentialKind,
    input: { readonly token: unknown; readonly peerIp: string },
  ): Promise<CommerceMachineSessionRevokeResult> {
    const token = requireSessionToken(kind, input.token);
    await this.#consumeSessionLimits(kind, token, input.peerIp);
    const tokenHash = hashSessionToken(kind, token);
    let revoked;
    try {
      revoked =
        kind === "agent"
          ? await this.#store.revokeAgentSession(tokenHash)
          : await this.#store.revokeProviderSession(tokenHash);
    } catch (error) {
      mapSessionStoreError(error);
    }
    const parsedResult = CommerceMachineSessionRevokeResultSchema.safeParse({
      kind,
      sessionId: revoked.sessionId,
      organizationId: revoked.organizationId,
      revokedAt: revoked.revokedAt,
    });
    if (!parsedResult.success) throw projectionFailure();
    return parsedResult.data;
  }

  async #consumeSessionLimits(
    kind: MachineCredentialKind,
    token: string,
    peerIp: string,
  ): Promise<void> {
    await this.#limits.consumeAll([
      {
        family: "session",
        bucket: "global",
        kind,
        value: "*",
        limit: MACHINE_RATE_LIMITS.session.global,
      },
      {
        family: "session",
        bucket: "peer",
        kind,
        value: peerIp,
        limit: MACHINE_RATE_LIMITS.session.peer,
      },
      {
        family: "session",
        bucket: "session",
        kind,
        value: token,
        limit: MACHINE_RATE_LIMITS.session.session,
      },
    ]);
  }

  /** Target 5 minutes from now, capped by the credential expiry and 15 min. */
  #sessionExpiry(credentialExpiresAt: string): string {
    const now = this.#now().getTime();
    const target = now + SESSION_TTL_MS;
    const cap = now + MAX_SESSION_TTL_MS;
    const credential = Date.parse(credentialExpiresAt);
    if (!Number.isFinite(credential)) throw unavailable();
    const expiry = Math.min(target, cap, credential);
    return new Date(expiry).toISOString();
  }
}

function requireLongLivedToken(
  kind: MachineCredentialKind,
  token: unknown,
): string {
  if (typeof token !== "string") throw unauthorized();
  if (!CommerceMachineCredentialTokenSchema.safeParse(token).success) {
    throw unauthorized();
  }
  const expectedPrefix = kind === "agent" ? "oac_ag_" : "oac_pr_";
  if (!token.startsWith(expectedPrefix)) throw unauthorized();
  if (token.startsWith("oas_")) throw unauthorized();
  return token;
}

function requireSessionToken(
  kind: MachineCredentialKind,
  token: unknown,
): string {
  if (!isSessionTokenForKind(kind, token)) throw unauthorized();
  return token;
}

function projectSession(
  kind: MachineCredentialKind,
  metadata: {
    readonly sessionId: string;
    readonly credentialId: string;
    readonly organizationId: string;
    readonly profileId: string;
    readonly environment: "eip155:5042002";
    readonly scope: string;
    readonly scopeVersion: 1;
    readonly createdAt: string;
    readonly expiresAt: string;
  },
  snapshot: { readonly organizationId: string; readonly profileId: string; readonly credentialId: string } | null,
) {
  const parsed = CommerceMachineSessionMetadataSchema.safeParse({
    sessionId: metadata.sessionId,
    credentialId: metadata.credentialId,
    organizationId: metadata.organizationId,
    kind,
    profileId: metadata.profileId,
    environment: metadata.environment,
    scopes: [metadata.scope],
    scopeVersion: metadata.scopeVersion,
    createdAt: metadata.createdAt,
    expiresAt: metadata.expiresAt,
  });
  if (!parsed.success) throw projectionFailure();
  if (snapshot !== null) {
    if (
      parsed.data.organizationId !== snapshot.organizationId ||
      parsed.data.profileId !== snapshot.profileId ||
      parsed.data.credentialId !== snapshot.credentialId
    ) {
      throw projectionFailure();
    }
  }
  return parsed.data;
}
