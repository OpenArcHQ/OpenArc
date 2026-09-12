import {
  CommerceAgentListRequestSchema,
  CommerceAgentPageSchema,
  CommerceOrganizationContextRequestSchema,
  CommerceOrganizationContextSchema,
  CommerceOrganizationListRequestSchema,
  CommerceOrganizationPageSchema,
  CommerceProviderListRequestSchema,
  CommerceProviderPageSchema,
  COMMERCE_TENANT_NETWORK,
  type CommerceAgentPage,
  type CommerceOrganizationContext,
  type CommerceOrganizationPage,
  type CommerceProviderPage,
} from "@openarc/shared";
import { TenantStoreError } from "@openarc/db";
import type { ZodType } from "zod";

import { AUTH_ERRORS, AuthApiError } from "../auth/errors.js";
import type { AuthRequestContext } from "../auth/service.js";
import type {
  TenantListAgentsInput,
  TenantListOrganizationsInput,
  TenantListProvidersInput,
  TenantReadAuthPort,
  TenantReadStorePort,
} from "./ports.js";

/**
 * Read-only orchestration for the protected tenant family.
 *
 * Every method strictly parses the request BEFORE any repository checkout,
 * begins the internal read-only session, invokes exactly one accepted
 * TenantStore read with the internal hash and requested organization, then
 * calls finishTenantRead BEFORE returning the validated, account/org-bound
 * DTO. The repository (never the frontend and never this service) is the
 * authority on active membership and role.
 *
 * The class holds no session state and performs no writes, retries or
 * fabricated empty successes. Failures map to the fixed commerce error
 * catalog with no raw cause.
 */

function invalidInput(): AuthApiError {
  return AUTH_ERRORS.invalidRequest();
}

function forbidden(): AuthApiError {
  return AUTH_ERRORS.forbidden();
}

function unauthenticated(): AuthApiError {
  return AUTH_ERRORS.unauthenticated();
}

function unavailable(): AuthApiError {
  return AUTH_ERRORS.unavailable();
}

/**
 * Response projection failures are a server bug, not a caller or dependency
 * outage, so they are a fixed 500 rather than a retryable-looking 503.
 */
function projectionFailure(): AuthApiError {
  return AUTH_ERRORS.internal();
}

function mapStoreError(error: unknown): never {
  if (error instanceof AuthApiError) throw error;
  if (error instanceof TenantStoreError) {
    switch (error.code) {
      case "TENANT_STORE_INPUT_INVALID":
        throw invalidInput();
      case "TENANT_STORE_SESSION_INVALID":
        throw unauthenticated();
      case "TENANT_STORE_FORBIDDEN":
      case "TENANT_STORE_NOT_FOUND":
        throw forbidden();
      case "TENANT_STORE_UNAVAILABLE":
      case "TENANT_STORE_OUTCOME_UNKNOWN":
        throw unavailable();
      default:
        throw unavailable();
    }
  }
  throw unavailable();
}

function parseRequest<T>(schema: ZodType<T>, input: unknown): T {
  const parsed = schema.safeParse(input);
  if (!parsed.success) throw invalidInput();
  return parsed.data;
}

export class TenantReadService {
  readonly #auth: TenantReadAuthPort;
  readonly #store: TenantReadStorePort;

  constructor(options: {
    auth: TenantReadAuthPort;
    store: TenantReadStorePort;
  }) {
    this.#auth = options.auth;
    this.#store = options.store;
  }

  async listOrganizations(
    ctx: AuthRequestContext,
    request: unknown,
  ): Promise<CommerceOrganizationPage> {
    const parsed = parseRequest(CommerceOrganizationListRequestSchema, request);
    const input: TenantListOrganizationsInput = {
      ...(parsed.afterOrganizationId !== undefined
        ? { afterOrganizationId: parsed.afterOrganizationId }
        : {}),
      ...(parsed.limit !== undefined ? { limit: parsed.limit } : {}),
    };
    const begun = await this.#auth.beginTenantRead(ctx);
    let raw: unknown;
    try {
      raw = await this.#store.listOrganizations(begun.sessionHash, input);
    } catch (error) {
      mapStoreError(error);
    }
    await this.#auth.finishTenantRead(ctx, begun);
    const page = CommerceOrganizationPageSchema.safeParse(raw);
    if (!page.success) throw projectionFailure();
    return page.data;
  }

  async getOrganizationContext(
    ctx: AuthRequestContext,
    request: unknown,
  ): Promise<CommerceOrganizationContext> {
    const parsed = parseRequest(
      CommerceOrganizationContextRequestSchema,
      request,
    );
    const begun = await this.#auth.beginTenantRead(ctx);
    let raw: unknown;
    try {
      raw = await this.#store.getOrganizationAccess(
        begun.sessionHash,
        parsed.organizationId,
      );
    } catch (error) {
      mapStoreError(error);
    }
    await this.#auth.finishTenantRead(ctx, begun);
    const store =
      typeof raw === "object" && raw !== null
        ? (raw as { organization?: unknown; access?: unknown })
        : {};
    const context = CommerceOrganizationContextSchema.safeParse({
      organization: store.organization,
      access: store.access,
      network: COMMERCE_TENANT_NETWORK,
    });
    if (!context.success) throw projectionFailure();
    // The requested organization must equal the returned organization and the
    // resolved account must equal the session account captured at begin.
    if (
      context.data.organization.organizationId !== parsed.organizationId ||
      context.data.access.organizationId !== parsed.organizationId ||
      context.data.access.accountId !== begun.accountId
    ) {
      throw projectionFailure();
    }
    return context.data;
  }

  async listAgents(
    ctx: AuthRequestContext,
    request: unknown,
  ): Promise<CommerceAgentPage> {
    const parsed = parseRequest(CommerceAgentListRequestSchema, request);
    const input: TenantListAgentsInput = {
      ...(parsed.afterAgentId !== undefined
        ? { afterAgentId: parsed.afterAgentId }
        : {}),
      ...(parsed.limit !== undefined ? { limit: parsed.limit } : {}),
    };
    const begun = await this.#auth.beginTenantRead(ctx);
    let raw: unknown;
    try {
      raw = await this.#store.listAgents(
        begun.sessionHash,
        parsed.organizationId,
        input,
      );
    } catch (error) {
      mapStoreError(error);
    }
    await this.#auth.finishTenantRead(ctx, begun);
    const store =
      typeof raw === "object" && raw !== null
        ? (raw as { items?: unknown; nextCursor?: unknown })
        : {};
    const page = CommerceAgentPageSchema.safeParse({
      organizationId: parsed.organizationId,
      items: store.items,
      nextCursor: store.nextCursor,
    });
    if (!page.success) throw projectionFailure();
    if (page.data.organizationId !== parsed.organizationId) {
      throw projectionFailure();
    }
    return page.data;
  }

  async listProviders(
    ctx: AuthRequestContext,
    request: unknown,
  ): Promise<CommerceProviderPage> {
    const parsed = parseRequest(CommerceProviderListRequestSchema, request);
    const input: TenantListProvidersInput = {
      ...(parsed.afterProviderId !== undefined
        ? { afterProviderId: parsed.afterProviderId }
        : {}),
      ...(parsed.limit !== undefined ? { limit: parsed.limit } : {}),
    };
    const begun = await this.#auth.beginTenantRead(ctx);
    let raw: unknown;
    try {
      raw = await this.#store.listProviders(
        begun.sessionHash,
        parsed.organizationId,
        input,
      );
    } catch (error) {
      mapStoreError(error);
    }
    await this.#auth.finishTenantRead(ctx, begun);
    const store =
      typeof raw === "object" && raw !== null
        ? (raw as { items?: unknown; nextCursor?: unknown })
        : {};
    const page = CommerceProviderPageSchema.safeParse({
      organizationId: parsed.organizationId,
      items: store.items,
      nextCursor: store.nextCursor,
    });
    if (!page.success) throw projectionFailure();
    if (page.data.organizationId !== parsed.organizationId) {
      throw projectionFailure();
    }
    return page.data;
  }
}
