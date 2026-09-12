import {
  CommerceListingPublicVersionSchema,
  CommerceMarketPublicDetailSchema,
  CommerceMarketPublicDetailRequestSchema,
  CommerceMarketPublicListRequestSchema,
  CommerceMarketPublicPageSchema,
  CommerceMarketPublicProviderDetailSchema,
  CommerceMarketPublicProviderRequestSchema,
  CommerceMarketPublicProviderSchema,
  type CommerceMarketPublicDetail,
  type CommerceMarketPublicPage,
  type CommerceMarketPublicProviderDetail,
} from "@openarc/shared";
import { MarketStoreError } from "@openarc/db";
import type { ZodType } from "zod";

import { AUTH_ERRORS, AuthApiError } from "../auth/errors.js";
import type { MarketCatalogStorePort } from "./catalog-ports.js";

/**
 * Read-only orchestration for the public marketplace catalog.
 *
 * Authentication is FREE on this surface: the service holds no auth port and
 * performs no session, credential or token work. It validates every request and
 * every returned public DTO strictly, binds every target/filter/cursor/page
 * field, and defends against oversized lookahead pages. A malformed projection
 * is a fixed 500; a repository outage is a fixed 503; caller input is a fixed
 * 400. No internal row, driver error or raw value is ever reflected.
 *
 * There is no automatic external fetch: query text is validated, never
 * transmitted to a provider, RPC endpoint or private Vault.
 */

const DEFAULT_PAGE = 25;

function invalidInput(): AuthApiError {
  return AUTH_ERRORS.invalidRequest();
}

function unavailable(): AuthApiError {
  return AUTH_ERRORS.unavailable();
}

function projectionFailure(): AuthApiError {
  return AUTH_ERRORS.internal();
}

function mapStoreError(error: unknown): never {
  if (error instanceof AuthApiError) throw error;
  if (error instanceof MarketStoreError) {
    if (error.code === "MARKET_STORE_INPUT_INVALID") throw invalidInput();
    // Every other closed repository code is a service outage on this
    // credentialless read surface; none is echoed to the caller.
    throw unavailable();
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

export class MarketCatalogService {
  readonly #store: MarketCatalogStorePort;

  constructor(options: { store: MarketCatalogStorePort }) {
    this.#store = options.store;
  }

  /** Public catalog page. The repository owns the 25-item default page size. */
  async listPublicListings(request: unknown): Promise<CommerceMarketPublicPage> {
    const parsed = parseRequest(CommerceMarketPublicListRequestSchema, request);
    const input = {
      ...(parsed.afterListingId !== undefined
        ? { afterListingId: parsed.afterListingId }
        : {}),
      ...(parsed.limit !== undefined ? { limit: parsed.limit } : {}),
      ...(parsed.kind !== undefined ? { kind: parsed.kind } : {}),
      ...(parsed.providerId !== undefined ? { providerId: parsed.providerId } : {}),
      ...(parsed.q !== undefined ? { q: parsed.q } : {}),
    };
    let raw: unknown;
    try {
      raw = await this.#store.listPublicListings(input);
    } catch (error) {
      mapStoreError(error);
    }
    if (!isRecord(raw)) throw projectionFailure();
    requireExactKeys(raw, ["items", "nextCursor"]);
    const page = CommerceMarketPublicPageSchema.safeParse({
      items: raw["items"],
      nextCursor: raw["nextCursor"],
    });
    if (!page.success) throw projectionFailure();
    const limit = parsed.limit ?? DEFAULT_PAGE;
    if (page.data.items.length > limit) throw projectionFailure();
    if (parsed.afterListingId !== undefined) {
      for (const item of page.data.items) {
        if (!(item.listingId > parsed.afterListingId)) {
          throw projectionFailure();
        }
      }
    }
    if (parsed.providerId !== undefined) {
      for (const item of page.data.items) {
        if (item.providerId !== parsed.providerId) throw projectionFailure();
      }
    }
    if (parsed.kind !== undefined) {
      for (const item of page.data.items) {
        if (item.kind !== parsed.kind) throw projectionFailure();
      }
    }
    return page.data;
  }

  /** Public listing detail. A null store miss is a truthful nullable 200. */
  async getPublicListing(listingId: unknown): Promise<CommerceMarketPublicDetail> {
    const parsed = parseRequest(CommerceMarketPublicDetailRequestSchema, {
      listingId,
    });
    let raw: unknown;
    try {
      raw = await this.#store.getPublicListing(parsed.listingId);
    } catch (error) {
      mapStoreError(error);
    }
    if (raw === null) {
      const detail = CommerceMarketPublicDetailSchema.safeParse({
        listingId: parsed.listingId,
        item: null,
      });
      if (!detail.success) throw projectionFailure();
      return detail.data;
    }
    const item = CommerceListingPublicVersionSchema.safeParse(raw);
    if (!item.success) throw projectionFailure();
    if (item.data.listingId !== parsed.listingId) throw projectionFailure();
    const detail = CommerceMarketPublicDetailSchema.safeParse({
      listingId: parsed.listingId,
      item: item.data,
    });
    if (!detail.success) throw projectionFailure();
    return detail.data;
  }

  /** Public provider detail. A null store miss is a truthful nullable 200. */
  async getPublicProvider(
    providerId: unknown,
  ): Promise<CommerceMarketPublicProviderDetail> {
    const parsed = parseRequest(
      CommerceMarketPublicProviderRequestSchema,
      { providerId },
    );
    let raw: unknown;
    try {
      raw = await this.#store.getPublicProvider(parsed.providerId);
    } catch (error) {
      mapStoreError(error);
    }
    if (raw === null) {
      const detail = CommerceMarketPublicProviderDetailSchema.safeParse({
        providerId: parsed.providerId,
        item: null,
      });
      if (!detail.success) throw projectionFailure();
      return detail.data;
    }
    const item = CommerceMarketPublicProviderSchema.safeParse(raw);
    if (!item.success) throw projectionFailure();
    if (item.data.providerId !== parsed.providerId) throw projectionFailure();
    const detail = CommerceMarketPublicProviderDetailSchema.safeParse({
      providerId: parsed.providerId,
      item: item.data,
    });
    if (!detail.success) throw projectionFailure();
    return detail.data;
  }
}
