import {
  CommerceListingIdSchema,
  CommerceListingOwnerSchema,
  CommerceListingOwnerVersionSchema,
  CommerceListingVersionSchema,
  CommerceMarketLifecycleMutationReceiptSchema,
  CommerceMarketMutationResultSchema,
  CommerceMarketMutationStatusRequestSchema,
  CommerceMarketMutationStatusSchema,
  CommerceMarketOriginReviewBodySchema,
  CommerceMarketOwnerRootDetailSchema,
  CommerceMarketOwnerRootRequestSchema,
  CommerceMarketOwnerVersionDetailSchema,
  CommerceMarketOwnerVersionRequestSchema,
  CommerceMarketPauseBodySchema,
  CommerceMarketProviderOptionsPageSchema,
  CommerceMarketProviderOptionsRequestSchema,
  CommerceMarketPublishBodySchema,
  CommerceMarketRetireBodySchema,
  CommerceOrganizationIdSchema,
  CommerceTenantIdempotencyKeySchema,
  type CommerceMarketMutationResult,
  type CommerceMarketMutationStatus,
  type CommerceMarketOwnerRootDetail,
  type CommerceMarketOwnerVersionDetail,
  type CommerceMarketProviderOptionsPage,
} from "@openarc/shared";
import {
  MarketStoreError,
  lifecycleResourceId,
  type LifecycleOperation,
} from "@openarc/db";
import type { ZodType } from "zod";

import { AUTH_ERRORS, AuthApiError } from "../auth/errors.js";
import type { AuthRequestContext } from "../auth/service.js";
import type {
  MarketLifecycleAuthPort,
  MarketLifecycleStorePort,
} from "./lifecycle-ports.js";

/**
 * Orchestration for the protected marketplace lifecycle family.
 *
 * Read ordering is strict: parse the request BEFORE any auth work, then
 * `beginTenantRead`, exactly one accepted repository read, then
 * `finishTenantRead`, and only then validate/bind the returned DTO. Writes
 * parse every input, run the exact accepted CSRF check, begin the live session,
 * invoke exactly ONE accepted repository mutation, and deliberately perform NO
 * post-commit read, auth check, preflight or retry.
 *
 * Both lifecycle status routes share this ONE helper. It returns exactly the
 * FOUR lifecycle operations and rejects the two draft operations, tenant and
 * machine receipts as malformed results. The shared
 * `CommerceMarketMutationResult/StatusSchema` wrappers alone are not enough
 * because they also admit the two draft operations, so an explicit four-way
 * lifecycle receipt restriction is applied in addition.
 *
 * Every store error is mapped from the closed `MarketStoreError` code list with
 * no driver, parser, body or raw cause echoed.
 */

const ORIGIN_REVIEW_OPERATION = "market.listing.origin_review.record" as const;
const PUBLISH_OPERATION = "market.listing.version.publish" as const;
const PAUSE_OPERATION = "market.listing.version.pause" as const;
const RETIRE_OPERATION = "market.listing.version.retire" as const;

/** Default provider-options page size when the wire value is absent. */
const PROVIDER_OPTIONS_DEFAULT_LIMIT = 25;

interface MarketLifecycleWriteEnvelope {
  readonly ctx: AuthRequestContext;
  readonly csrf: unknown;
  readonly idempotencyKey: unknown;
  readonly body: unknown;
}

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

function idempotencyConflict(): AuthApiError {
  return new AuthApiError("IDEMPOTENCY_CONFLICT", 409, "INVALID_REQUEST");
}

function policyDenied(): AuthApiError {
  return new AuthApiError("POLICY_DENIED", 409, "INVALID_REQUEST");
}

/** A malformed repository result or binding violation is a fixed server bug. */
function projectionFailure(): AuthApiError {
  return AUTH_ERRORS.internal();
}

function mapStoreError(error: unknown): never {
  if (error instanceof AuthApiError) throw error;
  if (error instanceof MarketStoreError) {
    switch (error.code) {
      case "MARKET_STORE_INPUT_INVALID":
        throw invalidInput();
      case "MARKET_STORE_SESSION_INVALID":
        throw unauthenticated();
      case "MARKET_STORE_FORBIDDEN":
      case "MARKET_STORE_NOT_FOUND":
        // A cross-actor or unknown target is the same fixed denial: no
        // organization-existence oracle is exposed by the transport.
        throw forbidden();
      case "MARKET_STORE_CONFLICT":
        throw policyDenied();
      case "MARKET_STORE_IDEMPOTENCY_CONFLICT":
        throw idempotencyConflict();
      case "MARKET_STORE_UNAVAILABLE":
      case "MARKET_STORE_OUTCOME_UNKNOWN":
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireExactKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
): void {
  const keys = Object.keys(value);
  if (keys.length !== allowed.length) throw projectionFailure();
  for (const key of keys) {
    if (!allowed.includes(key)) throw projectionFailure();
  }
}

export class MarketLifecycleService {
  readonly #auth: MarketLifecycleAuthPort;
  readonly #store: MarketLifecycleStorePort;

  constructor(options: {
    auth: MarketLifecycleAuthPort;
    store: MarketLifecycleStorePort;
  }) {
    this.#auth = options.auth;
    this.#store = options.store;
  }

  /* ---------------------------------------------------------------- */
  /* Reads                                                             */
  /* ---------------------------------------------------------------- */

  async getOwnerListing(
    ctx: AuthRequestContext,
    request: unknown,
  ): Promise<CommerceMarketOwnerRootDetail> {
    const parsed = parseRequest(CommerceMarketOwnerRootRequestSchema, request);
    const begun = await this.#auth.beginTenantRead(ctx);
    let raw: unknown;
    try {
      raw = await this.#store.getOwnerListing(
        begun.sessionHash,
        parsed.organizationId,
        parsed.listingId,
      );
    } catch (error) {
      mapStoreError(error);
    }
    await this.#auth.finishTenantRead(ctx, begun);
    if (raw === null) {
      const detail = CommerceMarketOwnerRootDetailSchema.safeParse({
        organizationId: parsed.organizationId,
        listingId: parsed.listingId,
        item: null,
      });
      if (!detail.success) throw projectionFailure();
      return detail.data;
    }
    // Parse the raw store object DIRECTLY against the strict accepted schema so
    // an extra key can never be stripped into a passing projection.
    const item = CommerceListingOwnerSchema.safeParse(raw);
    if (!item.success) throw projectionFailure();
    if (
      item.data.organizationId !== parsed.organizationId ||
      item.data.listingId !== parsed.listingId
    ) {
      throw projectionFailure();
    }
    const detail = CommerceMarketOwnerRootDetailSchema.safeParse({
      organizationId: parsed.organizationId,
      listingId: parsed.listingId,
      item: item.data,
    });
    if (!detail.success) throw projectionFailure();
    return detail.data;
  }

  async listMarketProviders(
    ctx: AuthRequestContext,
    request: unknown,
  ): Promise<CommerceMarketProviderOptionsPage> {
    const parsed = parseRequest(
      CommerceMarketProviderOptionsRequestSchema,
      request,
    );
    const input = {
      ...(parsed.afterProviderId !== undefined
        ? { afterProviderId: parsed.afterProviderId }
        : {}),
      ...(parsed.limit !== undefined ? { limit: parsed.limit } : {}),
    };
    const begun = await this.#auth.beginTenantRead(ctx);
    let raw: unknown;
    try {
      raw = await this.#store.listMarketProviders(
        begun.sessionHash,
        parsed.organizationId,
        input,
      );
    } catch (error) {
      mapStoreError(error);
    }
    await this.#auth.finishTenantRead(ctx, begun);
    if (!isRecord(raw)) throw projectionFailure();
    requireExactKeys(raw, ["items", "nextCursor"]);
    const page = CommerceMarketProviderOptionsPageSchema.safeParse({
      organizationId: parsed.organizationId,
      items: raw["items"],
      nextCursor: raw["nextCursor"],
    });
    if (!page.success) throw projectionFailure();
    const limit = parsed.limit ?? PROVIDER_OPTIONS_DEFAULT_LIMIT;
    if (page.data.items.length > limit) throw projectionFailure();
    if (parsed.afterProviderId !== undefined) {
      for (const item of page.data.items) {
        if (!(item.providerId > parsed.afterProviderId)) {
          throw projectionFailure();
        }
      }
    }
    return page.data;
  }

  async getModeratorListingVersion(
    ctx: AuthRequestContext,
    request: unknown,
  ): Promise<CommerceMarketOwnerVersionDetail> {
    const parsed = parseRequest(
      CommerceMarketOwnerVersionRequestSchema,
      request,
    );
    const begun = await this.#auth.beginTenantRead(ctx);
    let raw: unknown;
    try {
      raw = await this.#store.getModeratorListingVersion(
        begun.sessionHash,
        parsed.organizationId,
        parsed.listingId,
        parsed.version,
      );
    } catch (error) {
      mapStoreError(error);
    }
    await this.#auth.finishTenantRead(ctx, begun);
    if (raw === null) {
      const detail = CommerceMarketOwnerVersionDetailSchema.safeParse({
        organizationId: parsed.organizationId,
        listingId: parsed.listingId,
        version: parsed.version,
        item: null,
      });
      if (!detail.success) throw projectionFailure();
      return detail.data;
    }
    const item = CommerceListingOwnerVersionSchema.safeParse(raw);
    if (!item.success) throw projectionFailure();
    if (
      item.data.organizationId !== parsed.organizationId ||
      item.data.listingId !== parsed.listingId ||
      item.data.version !== parsed.version
    ) {
      throw projectionFailure();
    }
    const detail = CommerceMarketOwnerVersionDetailSchema.safeParse({
      organizationId: parsed.organizationId,
      listingId: parsed.listingId,
      version: parsed.version,
      item: item.data,
    });
    if (!detail.success) throw projectionFailure();
    return detail.data;
  }

  /**
   * Shared lifecycle status. Both the listing-management and moderation status
   * routes call this ONE helper: SQL is the current authority and the receipt
   * is scoped to the caller's own actor by the repository. Exactly the four
   * lifecycle operations are accepted; the two draft operations, tenant and
   * machine receipts are rejected as malformed.
   */
  async getLifecycleMutationStatus(
    ctx: AuthRequestContext,
    request: unknown,
  ): Promise<CommerceMarketMutationStatus> {
    const parsed = parseRequest(
      CommerceMarketMutationStatusRequestSchema,
      request,
    );
    const begun = await this.#auth.beginTenantRead(ctx);
    let raw: unknown;
    try {
      raw = await this.#store.getLifecycleMutationStatus(
        begun.sessionHash,
        parsed.organizationId,
        parsed.mutationId,
      );
    } catch (error) {
      mapStoreError(error);
    }
    await this.#auth.finishTenantRead(ctx, begun);
    // Validate the COMPLETE raw status against the strict accepted wrapper
    // FIRST, so an extra key cannot be stripped into a passing projection.
    const status = CommerceMarketMutationStatusSchema.safeParse(raw);
    if (!status.success) throw projectionFailure();
    if (status.data.status === "not_found") return status.data;
    // Explicit FOUR-operation lifecycle restriction in addition to the shared
    // wrapper: the wrapper also admits the two draft creation operations.
    const receipt = CommerceMarketLifecycleMutationReceiptSchema.safeParse(
      status.data.receipt,
    );
    if (!receipt.success) throw projectionFailure();
    if (receipt.data.mutationId !== parsed.mutationId) {
      throw projectionFailure();
    }
    return { status: "committed", receipt: receipt.data };
  }

  /* ---------------------------------------------------------------- */
  /* Writes                                                            */
  /* ---------------------------------------------------------------- */

  async recordOriginReview(
    ctx: AuthRequestContext,
    organizationId: unknown,
    listingId: unknown,
    version: unknown,
    request: MarketLifecycleWriteEnvelope,
  ): Promise<CommerceMarketMutationResult> {
    const organization = parseRequest(
      CommerceOrganizationIdSchema,
      organizationId,
    );
    const listing = parseRequest(CommerceListingIdSchema, listingId);
    const parsedVersion = parseRequest(CommerceListingVersionSchema, version);
    const body = parseRequest(
      CommerceMarketOriginReviewBodySchema,
      request.body,
    );
    const authorized = await this.#authorize(request, body.mutationId);
    const raw = await this.#invoke(() =>
      this.#store.recordOriginReview(
        authorized.sessionHash,
        organization,
        listing,
        parsedVersion,
        {
          expectedUpdatedAt: body.expectedUpdatedAt,
          decision: body.decision,
          reviewedEndpointDigest: body.reviewedEndpointDigest,
          reasonCode: body.reasonCode,
          reasonDigest: body.reasonDigest,
        },
        authorized.metadata,
      ),
    );
    return this.#projectLifecycleResult({
      raw,
      invokedOperation: ORIGIN_REVIEW_OPERATION,
      requestMutationId: body.mutationId,
      listingId: listing,
      version: parsedVersion,
    });
  }

  async publishListingVersion(
    ctx: AuthRequestContext,
    organizationId: unknown,
    listingId: unknown,
    version: unknown,
    request: MarketLifecycleWriteEnvelope,
  ): Promise<CommerceMarketMutationResult> {
    const scoped = this.#transitionScope(organizationId, listingId, version);
    const body = parseRequest(CommerceMarketPublishBodySchema, request.body);
    const authorized = await this.#authorize(request, body.mutationId);
    const raw = await this.#invoke(() =>
      this.#store.publishListingVersion(
        authorized.sessionHash,
        scoped.organization,
        scoped.listing,
        scoped.version,
        {
          expectedUpdatedAt: body.expectedUpdatedAt,
          expectedActiveVersion: body.expectedActiveVersion,
        },
        authorized.metadata,
      ),
    );
    return this.#projectLifecycleResult({
      raw,
      invokedOperation: PUBLISH_OPERATION,
      requestMutationId: body.mutationId,
      listingId: scoped.listing,
      version: scoped.version,
    });
  }

  async pauseListingVersion(
    ctx: AuthRequestContext,
    organizationId: unknown,
    listingId: unknown,
    version: unknown,
    request: MarketLifecycleWriteEnvelope,
  ): Promise<CommerceMarketMutationResult> {
    const scoped = this.#transitionScope(organizationId, listingId, version);
    const body = parseRequest(CommerceMarketPauseBodySchema, request.body);
    const authorized = await this.#authorize(request, body.mutationId);
    const raw = await this.#invoke(() =>
      this.#store.pauseListingVersion(
        authorized.sessionHash,
        scoped.organization,
        scoped.listing,
        scoped.version,
        {
          expectedUpdatedAt: body.expectedUpdatedAt,
          expectedActiveVersion: body.expectedActiveVersion,
        },
        authorized.metadata,
      ),
    );
    return this.#projectLifecycleResult({
      raw,
      invokedOperation: PAUSE_OPERATION,
      requestMutationId: body.mutationId,
      listingId: scoped.listing,
      version: scoped.version,
    });
  }

  async retireListingVersion(
    ctx: AuthRequestContext,
    organizationId: unknown,
    listingId: unknown,
    version: unknown,
    request: MarketLifecycleWriteEnvelope,
  ): Promise<CommerceMarketMutationResult> {
    const scoped = this.#transitionScope(organizationId, listingId, version);
    const body = parseRequest(CommerceMarketRetireBodySchema, request.body);
    const authorized = await this.#authorize(request, body.mutationId);
    const raw = await this.#invoke(() =>
      this.#store.retireListingVersion(
        authorized.sessionHash,
        scoped.organization,
        scoped.listing,
        scoped.version,
        {
          expectedUpdatedAt: body.expectedUpdatedAt,
          expectedActiveVersion: body.expectedActiveVersion,
        },
        authorized.metadata,
      ),
    );
    return this.#projectLifecycleResult({
      raw,
      invokedOperation: RETIRE_OPERATION,
      requestMutationId: body.mutationId,
      listingId: scoped.listing,
      version: scoped.version,
    });
  }

  /* ---------------------------------------------------------------- */
  /* Internal helpers                                                  */
  /* ---------------------------------------------------------------- */

  #transitionScope(
    organizationId: unknown,
    listingId: unknown,
    version: unknown,
  ): { organization: string; listing: string; version: string } {
    return {
      organization: parseRequest(CommerceOrganizationIdSchema, organizationId),
      listing: parseRequest(CommerceListingIdSchema, listingId),
      version: parseRequest(CommerceListingVersionSchema, version),
    };
  }

  async #authorize(
    request: MarketLifecycleWriteEnvelope,
    mutationId: string,
  ): Promise<{
    sessionHash: string;
    metadata: { idempotencyKey: string; mutationId: string };
  }> {
    const idempotencyKey = parseRequest(
      CommerceTenantIdempotencyKeySchema,
      request.idempotencyKey,
    );
    // Input validation is complete; now the exact accepted CSRF check, then the
    // live-session begin. No mutation happens unless both succeed.
    this.#auth.verifyCsrf(request.ctx.cookies, request.csrf);
    const begun = await this.#auth.beginTenantRead(request.ctx);
    return {
      sessionHash: begun.sessionHash,
      metadata: { idempotencyKey, mutationId },
    };
  }

  async #invoke(work: () => Promise<unknown>): Promise<unknown> {
    try {
      return await work();
    } catch (error) {
      mapStoreError(error);
    }
  }

  #projectLifecycleResult(input: {
    raw: unknown;
    invokedOperation: LifecycleOperation;
    requestMutationId: string;
    listingId: string;
    version: string;
  }): CommerceMarketMutationResult {
    // Validate the COMPLETE raw result against the strict accepted wrapper
    // FIRST, so an extra key can never be stripped into a passing projection.
    const result = CommerceMarketMutationResultSchema.safeParse(input.raw);
    if (!result.success) throw projectionFailure();
    // Explicit FOUR-operation lifecycle restriction; the wrapper alone also
    // admits the two draft creation operations.
    const receipt = CommerceMarketLifecycleMutationReceiptSchema.safeParse(
      result.data.receipt,
    );
    if (!receipt.success) throw projectionFailure();
    if (receipt.data.operation !== input.invokedOperation) {
      throw projectionFailure();
    }
    if (receipt.data.mutationId !== input.requestMutationId) {
      throw projectionFailure();
    }
    // listingId@version binding with version >= 1, exact to the request path.
    if (receipt.data.resourceId !== lifecycleResourceId(input.listingId, input.version)) {
      throw projectionFailure();
    }
    return { replayed: result.data.replayed, receipt: receipt.data };
  }
}
