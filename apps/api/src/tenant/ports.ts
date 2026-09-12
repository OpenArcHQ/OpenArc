import type {
  CommerceAgentPage,
  CommerceAgentProfile,
  CommerceOrganization,
  CommerceOrganizationAccessView,
  CommerceOrganizationPage,
  CommerceProviderPage,
  CommerceProviderProfile,
} from "@openarc/shared";

import type { AuthRequestContext } from "../auth/service.js";

/**
 * Structural read-only seam over the accepted TenantStore.
 *
 * The service depends ONLY on these four reads. It cannot construct a tenant,
 * mutate membership, list members, or reach a raw pool/client. The concrete
 * runtime implementation is the reviewed `@openarc/db` TenantStore; unit tests
 * inject an honest fake.
 */

export interface TenantListOrganizationsInput {
  readonly afterOrganizationId?: string;
  readonly limit?: number;
}

export interface TenantListAgentsInput {
  readonly afterAgentId?: string;
  readonly limit?: number;
}

export interface TenantListProvidersInput {
  readonly afterProviderId?: string;
  readonly limit?: number;
}

export interface TenantListOrganizationsResult {
  readonly items: CommerceOrganization[];
  readonly nextCursor: string | null;
}

export interface TenantGetOrganizationAccessResult {
  readonly organization: CommerceOrganization;
  readonly access: CommerceOrganizationAccessView;
}

export interface TenantListAgentsResult {
  readonly items: CommerceAgentProfile[];
  readonly nextCursor: string | null;
}

export interface TenantListProvidersResult {
  readonly items: CommerceProviderProfile[];
  readonly nextCursor: string | null;
}

export interface TenantReadStorePort {
  listOrganizations(
    sessionHash: string,
    input: TenantListOrganizationsInput,
  ): Promise<TenantListOrganizationsResult>;
  getOrganizationAccess(
    sessionHash: string,
    organizationId: string,
  ): Promise<TenantGetOrganizationAccessResult>;
  listAgents(
    sessionHash: string,
    organizationId: string,
    input: TenantListAgentsInput,
  ): Promise<TenantListAgentsResult>;
  listProviders(
    sessionHash: string,
    organizationId: string,
    input: TenantListProvidersInput,
  ): Promise<TenantListProvidersResult>;
}

/**
 * Structural seam over the two internal AuthService read methods. The concrete
 * implementation is the reviewed AuthService; tests inject a fake labelled as
 * a test double. The expected authority is captured by the service from the
 * begin result and is never supplied by an HTTP caller.
 */
export interface TenantReadAuthPort {
  beginTenantRead(
    ctx: AuthRequestContext,
  ): Promise<{ sessionHash: string; accountId: string }>;
  finishTenantRead(
    ctx: AuthRequestContext,
    expected: { sessionHash: string; accountId: string },
  ): Promise<void>;
}

/** Validated response data shapes returned by the four read methods. */
export type {
  CommerceAgentPage,
  CommerceOrganizationPage,
  CommerceProviderPage,
};

/** Re-exported request context so routes and tests share one alias. */
export type TenantReadRequestContext = AuthRequestContext;
