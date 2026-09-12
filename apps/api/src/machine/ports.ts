import type {
  CreateSessionInput,
  CredentialHashInput,
  CredentialMetadata,
  CredentialMutationResult,
  CredentialMutationStatus,
  CredentialVerifierSnapshot,
  ListCredentialsResult,
  MachineSessionMetadata,
  RevokeSessionResult,
} from "@openarc/db";

import type { ParsedAuthCookies } from "../auth/cookies.js";
import type { AuthRequestContext } from "../auth/service.js";
import type {
  MachineCredentialKind,
  MachineCredentialRecord,
} from "./credential-crypto.js";

/**
 * Structural dependency seams for the machine credential/session slice.
 *
 * The concrete runtime implementations are the reviewed `@openarc/db`
 * `CredentialStore` and the accepted `AuthService`/`AuthStore`. Unit tests
 * inject HONESTLY-LABELLED fakes that satisfy these interfaces; there is no
 * production test adapter, environment bypass or raw pool exposure.
 */

/** Canonical durable mutation metadata. The raw key is never logged or stored. */
export interface MachineCredentialMutationMetadata {
  readonly idempotencyKey: string;
  readonly mutationId: string;
}

export interface MachineIssueInput {
  readonly sessionHash: string;
  readonly organizationId: string;
  readonly profileId: string;
  readonly lookupId: string;
  readonly hash: CredentialHashInput;
  readonly expiresAt: string;
  readonly metadata: MachineCredentialMutationMetadata;
}

export interface MachineRevokeInput {
  readonly sessionHash: string;
  readonly organizationId: string;
  readonly credentialId: string;
  readonly metadata: MachineCredentialMutationMetadata;
}

export interface MachineListInput {
  readonly sessionHash: string;
  readonly organizationId: string;
  readonly profileId: string;
  readonly after?: string;
  readonly limit?: number;
}

/**
 * The exact accepted concrete `CredentialStore` operations. No generic
 * callback, raw pool or client is exposed.
 */
export interface MachineCredentialStorePort {
  issueAgentCredentialDurably(
    input: MachineIssueInput,
  ): Promise<CredentialMutationResult>;
  issueProviderCredentialDurably(
    input: MachineIssueInput,
  ): Promise<CredentialMutationResult>;
  revokeAgentCredentialDurably(
    input: MachineRevokeInput,
  ): Promise<CredentialMutationResult>;
  revokeProviderCredentialDurably(
    input: MachineRevokeInput,
  ): Promise<CredentialMutationResult>;
  listAgentCredentials(
    input: MachineListInput,
  ): Promise<ListCredentialsResult>;
  listProviderCredentials(
    input: MachineListInput,
  ): Promise<ListCredentialsResult>;
  getAgentCredentialMutationStatus(
    sessionHash: unknown,
    organizationId: unknown,
    mutationId: unknown,
  ): Promise<CredentialMutationStatus>;
  getProviderCredentialMutationStatus(
    sessionHash: unknown,
    organizationId: unknown,
    mutationId: unknown,
  ): Promise<CredentialMutationStatus>;
}

/** The accepted machine session/verifier repository operations. */
export interface MachineSessionStorePort {
  findAgentCredentialVerifier(
    lookupId: unknown,
  ): Promise<CredentialVerifierSnapshot>;
  findProviderCredentialVerifier(
    lookupId: unknown,
  ): Promise<CredentialVerifierSnapshot>;
  createAgentSession(input: CreateSessionInput): Promise<MachineSessionMetadata>;
  createProviderSession(input: CreateSessionInput): Promise<MachineSessionMetadata>;
  getAgentSession(tokenHash: unknown): Promise<MachineSessionMetadata>;
  getProviderSession(tokenHash: unknown): Promise<MachineSessionMetadata>;
  revokeAgentSession(tokenHash: unknown): Promise<RevokeSessionResult>;
  revokeProviderSession(tokenHash: unknown): Promise<RevokeSessionResult>;
}

/**
 * Structural seam over the accepted human-auth methods used by management.
 * `verifyCsrf` validates the binding/session anti-forgery token;
 * `beginTenantRead` rate-limits and resolves the live internal account/session
 * hash. The repository, never the caller, is the authority on role/profile.
 */
export interface MachineManagementAuthPort {
  verifyCsrf(cookies: ParsedAuthCookies, csrfHeader: unknown): string;
  beginTenantRead(
    ctx: AuthRequestContext,
  ): Promise<{ sessionHash: string; accountId: string }>;
  finishTenantRead(
    ctx: AuthRequestContext,
    expected: { sessionHash: string; accountId: string },
  ): Promise<void>;
}

/**
 * Narrow bound interface over the accepted durable `AuthStore.consumeRateLimit`
 * fixed-window increment. Only `consume` is reachable; no pool, full store or
 * counter-read is exposed.
 */
export interface MachineRateLimitStorePort {
  consume(input: {
    keyHash: string;
    limit: number;
    windowSeconds: number;
  }): Promise<{ allowed: boolean }>;
}

/** Narrow crypto seam over the accepted `MachineCredentialCrypto`. */
export interface MachineCryptoPort {
  hash(options: {
    kind: MachineCredentialKind;
    lookupId: string;
    raw: string;
  }): Promise<MachineCredentialRecord>;
  verify(options: {
    raw: string;
    record: MachineCredentialRecord;
    expectedKind?: MachineCredentialKind;
    expectedLookupId?: string;
  }): Promise<boolean>;
  dispose(): void;
}

/** Injectable clock so service TTL computation is deterministic under test. */
export interface MachineClockPort {
  now(): Date;
}

/** Injectable independent session token/id source (real RNG in production). */
export interface MachineSessionFactoryPort {
  sessionToken(kind: MachineCredentialKind): string;
  sessionId(): string;
}

/** Validated wire results returned by the machine services. */
export type { CredentialMetadata, MachineSessionMetadata };
export type {
  CredentialMutationResult,
  CredentialMutationStatus,
  ListCredentialsResult,
} from "@openarc/db";

/** Re-exported request context so routes and tests share one alias. */
export type MachineRequestContext = AuthRequestContext;
