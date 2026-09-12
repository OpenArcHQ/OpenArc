import type {
  CommerceTenantMutationResult,
  CommerceTenantMutationStatus,
} from "@openarc/shared";
import type {
  DurableMutationResult,
  DurableMutationStatus,
  UpdateAgentPatch,
  UpdateProviderPatch,
} from "@openarc/db";

import type { AuthRequestContext } from "../auth/service.js";
import type { ParsedAuthCookies } from "../auth/cookies.js";

/**
 * Structural write seam for the protected tenant family.
 *
 * The store port exposes ONLY the accepted concrete durable operations on
 * TenantStore: six business mutations plus the two scoped status reads. There
 * is deliberately no generic callback, no raw pool/client, no non-durable
 * compatibility method and no caller-supplied authority. The concrete runtime
 * implementation is the reviewed `@openarc/db` TenantStore; unit tests inject
 * an honest fake.
 */

/** Canonical durable mutation metadata. The raw key is never logged or stored. */
export interface TenantWriteMutationMetadata {
  readonly idempotencyKey: string;
  readonly mutationId: string;
}

export interface TenantWriteStorePort {
  createOrganizationDurably(
    sessionHash: string,
    displayName: string,
    metadata: TenantWriteMutationMetadata,
  ): Promise<DurableMutationResult>;
  createAgentDurably(
    sessionHash: string,
    organizationId: string,
    displayName: string,
    metadata: TenantWriteMutationMetadata,
  ): Promise<DurableMutationResult>;
  updateAgentDurably(
    sessionHash: string,
    organizationId: string,
    agentId: string,
    patch: UpdateAgentPatch,
    metadata: TenantWriteMutationMetadata,
  ): Promise<DurableMutationResult>;
  createProviderDurably(
    sessionHash: string,
    organizationId: string,
    displayName: string,
    metadata: TenantWriteMutationMetadata,
  ): Promise<DurableMutationResult>;
  updateProviderDurably(
    sessionHash: string,
    organizationId: string,
    providerId: string,
    patch: UpdateProviderPatch,
    metadata: TenantWriteMutationMetadata,
  ): Promise<DurableMutationResult>;
  setMembershipDurably(
    sessionHash: string,
    organizationId: string,
    targetAccountId: string,
    role: string,
    status: "active" | "suspended",
    metadata: TenantWriteMutationMetadata,
  ): Promise<DurableMutationResult>;
  getTenantMutationStatus(
    sessionHash: string,
    organizationId: string,
    mutationId: string,
  ): Promise<DurableMutationStatus>;
  getOrganizationMutationStatus(
    sessionHash: string,
    mutationId: string,
  ): Promise<DurableMutationStatus>;
}

/**
 * Structural seam over the accepted AuthService methods used by writes.
 *
 * `verifyCsrf` validates the binding/session-bound anti-forgery token and
 * `beginTenantRead` rate-limits and resolves the live internal account/session
 * hash. `finishTenantRead` is used by the status GET only. An isolated
 * self-demotion/suspension may revoke THIS request's session at commit, so no
 * post-commit live-session check is attempted for a business mutation.
 */
export interface TenantWriteAuthPort {
  verifyCsrf(cookies: ParsedAuthCookies, csrfHeader: unknown): string;
  beginTenantRead(
    ctx: AuthRequestContext,
  ): Promise<{ sessionHash: string; accountId: string }>;
  finishTenantRead(
    ctx: AuthRequestContext,
    expected: { sessionHash: string; accountId: string },
  ): Promise<void>;
}

/** Validated wire results returned by the write service. */
export type {
  CommerceTenantMutationResult,
  CommerceTenantMutationStatus,
};

/** Re-exported request context so routes and tests share one alias. */
export type TenantWriteRequestContext = AuthRequestContext;
