import {
  CommerceListingIdSchema,
  CommerceListingOwnerVersionSchema,
  CommerceMarketDraftCreateBodySchema,
  CommerceMarketMutationResultSchema,
  CommerceMarketMutationStatusRequestSchema,
  CommerceMarketMutationStatusSchema,
  CommerceMarketOwnerListRequestSchema,
  CommerceMarketOwnerPageSchema,
  CommerceMarketOwnerVersionDetailSchema,
  CommerceMarketOwnerVersionRequestSchema,
  CommerceMarketOwnerVersionsRequestSchema,
  CommerceMarketOwnerVersionPageSchema,
  CommerceMarketVersionCreateBodySchema,
  CommerceOrganizationIdSchema,
  CommerceTenantIdempotencyKeySchema,
  type CommerceMarketMutationResult,
  type CommerceMarketMutationStatus,
  type CommerceMarketOwnerPage,
  type CommerceMarketOwnerVersionDetail,
  type CommerceMarketOwnerVersionPage,
} from "@openarc/shared";
import { MarketStoreError, type MarketOperation } from "@openarc/db";
import type { ZodType } from "zod";

import { AUTH_ERRORS, AuthApiError } from "../auth/errors.js";
import type { AuthRequestContext } from "../auth/service.js";
import type { MarketAuthPort, MarketStorePort } from "./ports.js";

/**
 * Orchestration for the protected market owner listing family.
 *
 * Read/status ordering is strict: parse the request BEFORE any auth work, then
 * `beginTenantRead`, exactly one accepted repository read, then
 * `finishTenantRead`, and only then validate/bind the returned DTO. Writes
 * parse, verify CSRF, begin, invoke exactly one accepted repository mutation,
 * and deliberately perform NO post-commit live-session check: the authoritative
 * SQL may revoke this very request's session at commit, so re-reading would
 * misreport a committed write.
 *
 * No method retries, polls, substitutes an idempotency key, preflights latest
 * state or acts on an unknown outcome. `OUTCOME_UNKNOWN` maps to a fixed
 * non-retryable 503; recovery is an explicit status GET with the same logical
 * mutation id. Every store error is mapped from the closed MarketStoreError
 * code list with no driver, parser, body or raw cause echoed.
 */

const LISTING_CREATE_OPERATION = "market.listing.create" as const;
const VERSION_CREATE_OPERATION = "market.listing.version.create" as const;
/**
 * This draft packet's status method is explicitly closed to the TWO draft
 * creation operations. The shared receipt union now also carries four
 * lifecycle operations for a separate future status helper; a lifecycle
 * receipt observed through THIS method is a malformed result.
 */
const DRAFT_OPERATIONS: ReadonlySet<string> = new Set([
  LISTING_CREATE_OPERATION,
  VERSION_CREATE_OPERATION,
]);
const CANONICAL_VERSION_PATTERN = /^[1-9][0-9]{0,8}$/u;
const PAGE_MAX = 50;

interface MarketWriteEnvelope {
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

/**
 * A malformed/shape-invalid repository result (or a binding violation) is a
 * server bug, not a caller or dependency outage: a fixed 500, never a
 * retryable-looking 503.
 */
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

/**
 * Reject a store envelope that carries keys other than the two accepted ones.
 * A page result is `{items, nextCursor}`; an extra key is a malformed result
 * and must not be silently stripped away before validation.
 */
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

/** Numeric version comparison with a length guard before BigInt. */
function versionIsStrictlyAfter(version: string, after: string): boolean {
  if (
    !CANONICAL_VERSION_PATTERN.test(version) ||
    !CANONICAL_VERSION_PATTERN.test(after)
  ) {
    return false;
  }
  return BigInt(version) > BigInt(after);
}

/** The bounded requested page size; absent means the repository default. */
function requestedLimit(limit: number | undefined): number {
  return limit ?? PAGE_MAX;
}

export class MarketService {
  readonly #auth: MarketAuthPort;
  readonly #store: MarketStorePort;

  constructor(options: { auth: MarketAuthPort; store: MarketStorePort }) {
    this.#auth = options.auth;
    this.#store = options.store;
  }

  /* ---------------------------------------------------------------- */
  /* Reads                                                             */
  /* ---------------------------------------------------------------- */

  async listOwnerListings(
    ctx: AuthRequestContext,
    request: unknown,
  ): Promise<CommerceMarketOwnerPage> {
    const parsed = parseRequest(CommerceMarketOwnerListRequestSchema, request);
    const input = {
      ...(parsed.afterListingId !== undefined
        ? { afterListingId: parsed.afterListingId }
        : {}),
      ...(parsed.limit !== undefined ? { limit: parsed.limit } : {}),
    };
    const begun = await this.#auth.beginTenantRead(ctx);
    let raw: unknown;
    try {
      raw = await this.#store.listOwnerListings(
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
    const page = CommerceMarketOwnerPageSchema.safeParse({
      organizationId: parsed.organizationId,
      items: raw["items"],
      nextCursor: raw["nextCursor"],
    });
    if (!page.success) throw projectionFailure();
    if (page.data.items.length > requestedLimit(parsed.limit)) {
      throw projectionFailure();
    }
    if (parsed.afterListingId !== undefined) {
      for (const item of page.data.items) {
        if (!(item.listingId > parsed.afterListingId)) {
          throw projectionFailure();
        }
      }
    }
    return page.data;
  }

  /**
   * Owner version history. The provider id is read from the immutable version 1
   * inside the SAME authorized read as the page, so an empty page still carries
   * a truthful provider id and never fabricates one from client input.
   */
  async listOwnerListingVersions(
    ctx: AuthRequestContext,
    request: unknown,
  ): Promise<CommerceMarketOwnerVersionPage> {
    const parsed = parseRequest(CommerceMarketOwnerVersionsRequestSchema, request);
    const input = {
      ...(parsed.afterVersion !== undefined
        ? { afterVersion: parsed.afterVersion }
        : {}),
      ...(parsed.limit !== undefined ? { limit: parsed.limit } : {}),
    };
    const begun = await this.#auth.beginTenantRead(ctx);
    let providerId: string;
    let raw: unknown;
    try {
      const versionOne = await this.#store.getOwnerListingVersion(
        begun.sessionHash,
        parsed.organizationId,
        parsed.listingId,
        "1",
      );
      if (versionOne === null) throw forbidden();
      const first = CommerceListingOwnerVersionSchema.safeParse(versionOne);
      if (!first.success) throw projectionFailure();
      if (
        first.data.organizationId !== parsed.organizationId ||
        first.data.listingId !== parsed.listingId ||
        first.data.version !== "1"
      ) {
        throw projectionFailure();
      }
      providerId = first.data.providerId;
      raw = await this.#store.listOwnerListingVersions(
        begun.sessionHash,
        parsed.organizationId,
        parsed.listingId,
        input,
      );
    } catch (error) {
      mapStoreError(error);
    }
    await this.#auth.finishTenantRead(ctx, begun);
    if (!isRecord(raw)) throw projectionFailure();
    requireExactKeys(raw, ["items", "nextCursor"]);
    const page = CommerceMarketOwnerVersionPageSchema.safeParse({
      organizationId: parsed.organizationId,
      listingId: parsed.listingId,
      providerId,
      items: raw["items"],
      nextCursor: raw["nextCursor"],
    });
    if (!page.success) throw projectionFailure();
    if (page.data.items.length > requestedLimit(parsed.limit)) {
      throw projectionFailure();
    }
    if (parsed.afterVersion !== undefined) {
      for (const item of page.data.items) {
        if (!versionIsStrictlyAfter(item.version, parsed.afterVersion)) {
          throw projectionFailure();
        }
      }
    }
    return page.data;
  }

  async getOwnerListingVersion(
    ctx: AuthRequestContext,
    request: unknown,
  ): Promise<CommerceMarketOwnerVersionDetail> {
    const parsed = parseRequest(CommerceMarketOwnerVersionRequestSchema, request);
    const begun = await this.#auth.beginTenantRead(ctx);
    let raw: unknown;
    try {
      raw = await this.#store.getOwnerListingVersion(
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
    // Parse the raw store object DIRECTLY against the strict accepted schema so
    // an extra key can never be stripped into a passing projection.
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

  async getMarketMutationStatus(
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
      raw = await this.#store.getMarketMutationStatus(
        begun.sessionHash,
        parsed.organizationId,
        parsed.mutationId,
      );
    } catch (error) {
      mapStoreError(error);
    }
    await this.#auth.finishTenantRead(ctx, begun);
    // Validate the COMPLETE raw status object against the strict accepted
    // schema FIRST, so an extra key can never be stripped into a passing
    // projection before binding.
    const status = CommerceMarketMutationStatusSchema.safeParse(raw);
    if (!status.success) throw projectionFailure();
    if (status.data.status === "not_found") return status.data;
    if (status.data.receipt.mutationId !== parsed.mutationId) {
      throw projectionFailure();
    }
    // Lifecycle receipts belong to a separate future status helper and must
    // not be served through this draft-packet status method.
    if (!DRAFT_OPERATIONS.has(status.data.receipt.operation)) {
      throw projectionFailure();
    }
    return status.data;
  }

  /* ---------------------------------------------------------------- */
  /* Writes                                                            */
  /* ---------------------------------------------------------------- */

  async createListingDraft(
    ctx: AuthRequestContext,
    organizationId: unknown,
    request: MarketWriteEnvelope,
  ): Promise<CommerceMarketMutationResult> {
    const organization = parseRequest(
      CommerceOrganizationIdSchema,
      organizationId,
    );
    const body = parseRequest(CommerceMarketDraftCreateBodySchema, request.body);
    const authorized = await this.#authorize(request, body.mutationId);
    const raw = await this.#invoke(() =>
      this.#store.createListingDraft(
        authorized.sessionHash,
        organization,
        body.providerId,
        body.content,
        authorized.metadata,
      ),
    );
    return this.#projectMutationResult({
      raw,
      invokedOperation: LISTING_CREATE_OPERATION,
      requestMutationId: body.mutationId,
      expectedResourceId: `openarc:listing:${body.mutationId}`,
    });
  }

  async createListingVersion(
    ctx: AuthRequestContext,
    organizationId: unknown,
    listingId: unknown,
    request: MarketWriteEnvelope,
  ): Promise<CommerceMarketMutationResult> {
    const organization = parseRequest(
      CommerceOrganizationIdSchema,
      organizationId,
    );
    const listing = parseRequest(CommerceListingIdSchema, listingId);
    const body = parseRequest(
      CommerceMarketVersionCreateBodySchema,
      request.body,
    );
    // `expectedLatestVersion` is the accepted canonical 1..999999999 decimal,
    // so BigInt is only reached by already-valid canonical input. A max-version
    // input is accepted here but the authoritative SQL will conflict.
    const nextVersion = (BigInt(body.expectedLatestVersion) + 1n).toString();
    const authorized = await this.#authorize(request, body.mutationId);
    const raw = await this.#invoke(() =>
      this.#store.createListingVersion(
        authorized.sessionHash,
        organization,
        listing,
        {
          expectedLatestVersion: body.expectedLatestVersion,
          content: body.content,
        },
        authorized.metadata,
      ),
    );
    return this.#projectMutationResult({
      raw,
      invokedOperation: VERSION_CREATE_OPERATION,
      requestMutationId: body.mutationId,
      expectedResourceId: `${listing}@${nextVersion}`,
    });
  }

  /* ---------------------------------------------------------------- */
  /* Internal helpers                                                  */
  /* ---------------------------------------------------------------- */

  async #authorize(
    request: MarketWriteEnvelope,
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

  #projectMutationResult(input: {
    raw: unknown;
    invokedOperation: MarketOperation;
    requestMutationId: string;
    expectedResourceId: string;
  }): CommerceMarketMutationResult {
    // Validate the COMPLETE raw result against the strict accepted schema
    // FIRST, so an extra key can never be stripped into a passing projection.
    const result = CommerceMarketMutationResultSchema.safeParse(input.raw);
    if (!result.success) throw projectionFailure();
    const receipt = result.data.receipt;
    if (receipt.operation !== input.invokedOperation) {
      throw projectionFailure();
    }
    if (receipt.mutationId !== input.requestMutationId) {
      throw projectionFailure();
    }
    if (receipt.resourceId !== input.expectedResourceId) {
      throw projectionFailure();
    }
    // The service target envelope is added only after the store shape passed
    // strict validation and every mutation/operation/target binding held.
    return result.data;
  }
}
