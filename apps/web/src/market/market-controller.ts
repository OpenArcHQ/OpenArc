import {
  CommerceListingIdSchema,
  CommerceListingKindSchema,
  CommerceProviderIdSchema,
  type CommerceListingKind,
  type CommerceListingPublicVersion,
  type CommerceMarketPublicProvider,
  type MarketplaceCapabilityManifest,
} from "@openarc/shared";

import { MarketApiError, MarketClient, MARKET_PAGE_LIMIT } from "./market-client.js";

/**
 * Coordinates the public marketplace catalog in memory only.
 *
 * The controller owns one bounded page at a time (never an unbounded item
 * accumulation), one detail and one provider profile. A per-section generation
 * plus an AbortController cancels a stale route, filter or page read so a
 * delayed response can never overwrite newer state. Nothing is written to
 * URL/history, browser storage, a cookie, the Vault or a wallet, and no
 * catalog read is issued until the capability manifest reports the
 * `public_catalog` family `enabled`.
 */

export const MARKET_CURSOR_STACK_LIMIT = 20;

export type MarketGateStatus =
  | "disabled"
  | "loading-capabilities"
  | "unavailable"
  | "enabled";

export type MarketDataStatus = "none" | "loading" | "ready" | "error";

export type MarketFailureKind =
  | "unavailable"
  | "invalid-response"
  | "feature-disabled";

export interface MarketFilters {
  readonly q: string | null;
  readonly kind: CommerceListingKind | null;
  readonly providerId: string | null;
}

export interface MarketListSection {
  readonly status: MarketDataStatus;
  readonly items: readonly CommerceListingPublicVersion[];
  readonly nextCursor: string | null;
  /** True after a cursor-stack back step; false for the first page. */
  readonly hasPrevious: boolean;
  readonly failure: MarketFailureKind | null;
}

export type MarketDetailStatus = MarketDataStatus | "not-found";

export interface MarketDetailSection {
  readonly status: MarketDetailStatus;
  readonly requestedListingId: string | null;
  readonly item: CommerceListingPublicVersion | null;
  readonly failure: MarketFailureKind | null;
}

export interface MarketProviderSection {
  readonly status: MarketDetailStatus;
  readonly requestedProviderId: string | null;
  readonly provider: CommerceMarketPublicProvider | null;
  readonly listings: MarketListSection;
}

export interface MarketControllerState {
  readonly gate: MarketGateStatus;
  readonly capabilities: MarketplaceCapabilityManifest | null;
  readonly filters: MarketFilters;
  readonly list: MarketListSection;
  readonly detail: MarketDetailSection;
  readonly provider: MarketProviderSection;
}

export function emptyListSection(): MarketListSection {
  return { status: "none", items: [], nextCursor: null, hasPrevious: false, failure: null };
}

export function emptyDetailSection(): MarketDetailSection {
  return { status: "none", requestedListingId: null, item: null, failure: null };
}

export function emptyProviderSection(): MarketProviderSection {
  return {
    status: "none",
    requestedProviderId: null,
    provider: null,
    listings: emptyListSection(),
  };
}

export function emptyFilters(): MarketFilters {
  return { q: null, kind: null, providerId: null };
}

export function initialMarketState(gate: MarketGateStatus = "disabled"): MarketControllerState {
  return {
    gate,
    capabilities: null,
    filters: emptyFilters(),
    list: emptyListSection(),
    detail: emptyDetailSection(),
    provider: emptyProviderSection(),
  };
}

export interface MarketControllerDeps {
  readonly client?: MarketClient;
  /**
   * True only when BOTH the marketplace catalog flag and the accepted API
   * boundary are exactly enabled. When false the controller stays in the
   * `disabled` gate and issues no request at all.
   */
  readonly enabled?: boolean;
  readonly onState?: (state: MarketControllerState) => void;
}

export class MarketController {
  #state: MarketControllerState;
  #disposed = false;
  #capabilitiesGeneration = 0;
  #listGeneration = 0;
  #detailGeneration = 0;
  #providerGeneration = 0;
  #capabilitiesAbort: AbortController | null = null;
  #listAbort: AbortController | null = null;
  #detailAbort: AbortController | null = null;
  #providerAbort: AbortController | null = null;
  #listCursors: (string | null)[] = [null];
  #providerCursors: (string | null)[] = [null];
  readonly #client: MarketClient;
  readonly #enabled: boolean;
  readonly #onState: ((state: MarketControllerState) => void) | undefined;

  constructor(deps: MarketControllerDeps = {}) {
    this.#client = deps.client ?? new MarketClient();
    this.#enabled = deps.enabled ?? false;
    this.#onState = deps.onState;
    this.#state = initialMarketState(this.#enabled ? "loading-capabilities" : "disabled");
  }

  get state(): MarketControllerState {
    return this.#state;
  }

  get disposed(): boolean {
    return this.#disposed;
  }

  /**
   * Explicit capability bootstrap. It is the ONLY way catalog reads become
   * possible: the manifest must report `public_catalog` with state `enabled`.
   * A missing, malformed or unavailable capability response yields the bounded
   * `unavailable` gate and issues no catalog read. Never infers an enabled
   * family from route presence or another family.
   */
  async loadCapabilities(): Promise<void> {
    if (this.#disposed || !this.#enabled) return;
    const generation = this.#capabilitiesGeneration;
    this.#capabilitiesAbort?.abort();
    const controller = new AbortController();
    this.#capabilitiesAbort = controller;
    this.#set({ ...this.#state, gate: "loading-capabilities", capabilities: null });
    let manifest: MarketplaceCapabilityManifest;
    try {
      manifest = await this.#client.readCapabilities(controller.signal);
    } catch {
      if (!this.#capabilitiesStillCurrent(generation)) return;
      this.#set({ ...this.#state, gate: "unavailable", capabilities: null });
      return;
    }
    if (!this.#capabilitiesStillCurrent(generation)) return;
    const publicCatalog = manifest.capabilities.find(
      (entry) => entry.family === "public_catalog",
    );
    if (publicCatalog === undefined || publicCatalog.state !== "enabled") {
      this.#set({ ...this.#state, gate: "unavailable", capabilities: manifest });
      return;
    }
    this.#set({ ...this.#state, gate: "enabled", capabilities: manifest });
  }

  /** Explicit first page. Resets the cursor stack to the first position. */
  async loadList(): Promise<void> {
    if (this.#disposed || this.#state.gate !== "enabled") return;
    this.#listCursors = [null];
    await this.#loadListPage(null, 0, false);
  }

  /** Explicit next page. Replaces the page; never accumulates. */
  async loadNextList(): Promise<void> {
    if (this.#disposed || this.#state.gate !== "enabled") return;
    const cursor = this.#state.list.nextCursor;
    if (cursor === null) return;
    const nextStack = [...this.#listCursors, cursor].slice(-MARKET_CURSOR_STACK_LIMIT);
    this.#listCursors = nextStack;
    await this.#loadListPage(cursor, nextStack.length - 1, nextStack.length > 1);
  }

  /** Explicit previous page: pops the bounded cursor stack. Never refetches. */
  async loadPreviousList(): Promise<void> {
    if (this.#disposed || this.#state.gate !== "enabled") return;
    if (this.#listCursors.length <= 1) return;
    const nextStack = this.#listCursors.slice(0, -1);
    const cursor = nextStack[nextStack.length - 1] ?? null;
    this.#listCursors = nextStack;
    await this.#loadListPage(cursor, nextStack.length - 1, nextStack.length > 1);
  }

  async #loadListPage(
    cursor: string | null,
    _stackIndex: number,
    hasPrevious: boolean,
  ): Promise<void> {
    const generation = this.#listGeneration;
    const filters = this.#state.filters;
    this.#listAbort?.abort();
    const controller = new AbortController();
    this.#listAbort = controller;
    this.#set({
      ...this.#state,
      list: { ...this.#state.list, status: "loading", failure: null },
    });
    let page;
    try {
      page = await this.#client.listListings(
        {
          ...(cursor === null ? {} : { afterListingId: cursor }),
          limit: MARKET_PAGE_LIMIT,
          ...(filters.kind === null ? {} : { kind: filters.kind }),
          ...(filters.providerId === null ? {} : { providerId: filters.providerId }),
          ...(filters.q === null ? {} : { q: filters.q }),
        },
        controller.signal,
      );
    } catch (error) {
      if (!this.#listStillCurrent(generation)) return;
      this.#set({
        ...this.#state,
        list: {
          status: "error",
          items: [],
          nextCursor: null,
          hasPrevious,
          failure: failureKind(error),
        },
      });
      return;
    }
    if (!this.#listStillCurrent(generation)) return;
    this.#set({
      ...this.#state,
      list: {
        status: "ready",
        items: page.items,
        nextCursor: page.nextCursor,
        hasPrevious,
        failure: null,
      },
    });
  }

  /**
   * Applies validated explicit filters (kind enum / canonical provider id /
   * trimmed query) and resets to the first page. Unknown enum/id values are
   * rejected, not coerced.
   */
  async applyFilters(filters: MarketFilters): Promise<void> {
    if (this.#disposed || this.#state.gate !== "enabled") return;
    const validated = validateFilters(filters);
    if (validated === null) return;
    this.#listGeneration += 1;
    this.#listAbort?.abort();
    this.#listAbort = null;
    this.#listCursors = [null];
    this.#set({
      ...this.#state,
      filters: validated,
      list: emptyListSection(),
    });
    await this.loadList();
  }

  /** Explicit retry of the current first page with the active filters. */
  async retryList(): Promise<void> {
    if (this.#disposed || this.#state.gate !== "enabled") return;
    await this.loadList();
  }

  /**
   * Reads one public listing. The previous detail is cleared synchronously
   * before the request, and a `null` item becomes `not-found` (never an
   * authorization failure).
   */
  async loadListing(listingId: string): Promise<void> {
    if (this.#disposed || this.#state.gate !== "enabled") return;
    const parsed = CommerceListingIdSchema.safeParse(listingId);
    if (!parsed.success) {
      this.#setDetail({ status: "not-found", requestedListingId: null, item: null, failure: null });
      return;
    }
    const generation = this.#detailGeneration;
    this.#detailAbort?.abort();
    const controller = new AbortController();
    this.#detailAbort = controller;
    this.#setDetail({
      status: "loading",
      requestedListingId: parsed.data,
      item: null,
      failure: null,
    });
    let detail;
    try {
      detail = await this.#client.readListing(parsed.data, controller.signal);
    } catch (error) {
      if (!this.#detailStillCurrent(generation, parsed.data)) return;
      if (isAborted(error)) return;
      if (error instanceof MarketApiError && error.failure.kind === "not-found") {
        this.#setDetail({
          status: "not-found",
          requestedListingId: parsed.data,
          item: null,
          failure: null,
        });
        return;
      }
      this.#setDetail({
        status: "error",
        requestedListingId: parsed.data,
        item: null,
        failure: failureKind(error),
      });
      return;
    }
    if (!this.#detailStillCurrent(generation, parsed.data)) return;
    if (detail.item === null) {
      this.#setDetail({
        status: "not-found",
        requestedListingId: parsed.data,
        item: null,
        failure: null,
      });
      return;
    }
    this.#setDetail({
      status: "ready",
      requestedListingId: parsed.data,
      item: detail.item,
      failure: null,
    });
  }

  /**
   * Reads one public provider profile and its filtered first listing page.
   * The profile and prior listings are cleared synchronously before the
   * request; a `null` provider becomes `not-found`.
   */
  async loadProvider(providerId: string): Promise<void> {
    if (this.#disposed || this.#state.gate !== "enabled") return;
    const parsed = CommerceProviderIdSchema.safeParse(providerId);
    if (!parsed.success) {
      this.#setProvider({
        status: "not-found",
        requestedProviderId: null,
        provider: null,
        listings: emptyListSection(),
      });
      return;
    }
    const generation = this.#providerGeneration;
    this.#providerAbort?.abort();
    const controller = new AbortController();
    this.#providerAbort = controller;
    this.#providerCursors = [null];
    this.#setProvider({
      status: "loading",
      requestedProviderId: parsed.data,
      provider: null,
      listings: emptyListSection(),
    });
    let detail;
    try {
      detail = await this.#client.readProvider(parsed.data, controller.signal);
    } catch (error) {
      if (!this.#providerStillCurrent(generation, parsed.data)) return;
      if (isAborted(error)) return;
      if (error instanceof MarketApiError && error.failure.kind === "not-found") {
        this.#setProvider({
          status: "not-found",
          requestedProviderId: parsed.data,
          provider: null,
          listings: emptyListSection(),
        });
        return;
      }
      this.#setProvider({
        status: "error",
        requestedProviderId: parsed.data,
        provider: null,
        listings: emptyListSection(),
      });
      return;
    }
    if (!this.#providerStillCurrent(generation, parsed.data)) return;
    if (detail.item === null) {
      this.#setProvider({
        status: "not-found",
        requestedProviderId: parsed.data,
        provider: null,
        listings: emptyListSection(),
      });
      return;
    }
    this.#setProvider({
      status: "ready",
      requestedProviderId: parsed.data,
      provider: detail.item,
      listings: emptyListSection(),
    });
    await this.#loadProviderListings();
  }

  /** Explicit next page of the current provider's filtered listings. */
  async loadNextProviderListings(): Promise<void> {
    if (this.#disposed || this.#state.gate !== "enabled") return;
    const provider = this.#state.provider.provider;
    if (provider === null || this.#state.provider.listings.nextCursor === null) return;
    const nextStack = [...this.#providerCursors, this.#state.provider.listings.nextCursor].slice(
      -MARKET_CURSOR_STACK_LIMIT,
    );
    this.#providerCursors = nextStack;
    await this.#loadProviderListings();
  }

  /** Explicit previous page of the current provider's filtered listings. */
  async loadPreviousProviderListings(): Promise<void> {
    if (this.#disposed || this.#state.gate !== "enabled") return;
    if (this.#providerCursors.length <= 1) return;
    this.#providerCursors = this.#providerCursors.slice(0, -1);
    await this.#loadProviderListings();
  }

  async #loadProviderListings(): Promise<void> {
    const provider = this.#state.provider.provider;
    const requestedProviderId = this.#state.provider.requestedProviderId;
    if (provider === null || requestedProviderId === null) return;
    const generation = this.#providerGeneration;
    const cursor = this.#providerCursors[this.#providerCursors.length - 1] ?? null;
    this.#providerAbort?.abort();
    const controller = new AbortController();
    this.#providerAbort = controller;
    this.#setProvider({
      ...this.#state.provider,
      listings: { ...this.#state.provider.listings, status: "loading", failure: null },
    });
    let page;
    try {
      page = await this.#client.listListings(
        {
          providerId: requestedProviderId,
          limit: MARKET_PAGE_LIMIT,
          ...(cursor === null ? {} : { afterListingId: cursor }),
        },
        controller.signal,
      );
    } catch (error) {
      if (!this.#providerListStillCurrent(generation, requestedProviderId)) return;
      this.#setProvider({
        ...this.#state.provider,
        listings: {
          status: "error",
          items: [],
          nextCursor: null,
          hasPrevious: this.#providerCursors.length > 1,
          failure: failureKind(error),
        },
      });
      return;
    }
    if (!this.#providerListStillCurrent(generation, requestedProviderId)) return;
    this.#setProvider({
      ...this.#state.provider,
      listings: {
        status: "ready",
        items: page.items,
        nextCursor: page.nextCursor,
        hasPrevious: this.#providerCursors.length > 1,
        failure: null,
      },
    });
  }

  /**
   * Route/context change: clears ALL visible catalog data synchronously and
   * aborts every in-flight read so no stale response can render.
   */
  reset(): void {
    if (this.#disposed) return;
    this.#listGeneration += 1;
    this.#detailGeneration += 1;
    this.#providerGeneration += 1;
    this.#listAbort?.abort();
    this.#listAbort = null;
    this.#detailAbort?.abort();
    this.#detailAbort = null;
    this.#providerAbort?.abort();
    this.#providerAbort = null;
    this.#listCursors = [null];
    this.#providerCursors = [null];
    this.#set({
      ...this.#state,
      filters: emptyFilters(),
      list: emptyListSection(),
      detail: emptyDetailSection(),
      provider: emptyProviderSection(),
    });
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#capabilitiesGeneration += 1;
    this.#listGeneration += 1;
    this.#detailGeneration += 1;
    this.#providerGeneration += 1;
    this.#capabilitiesAbort?.abort();
    this.#capabilitiesAbort = null;
    this.#listAbort?.abort();
    this.#listAbort = null;
    this.#detailAbort?.abort();
    this.#detailAbort = null;
    this.#providerAbort?.abort();
    this.#providerAbort = null;
    this.#disposed = true;
    this.#state = initialMarketState(this.#enabled ? "loading-capabilities" : "disabled");
    this.#onState?.(this.#state);
  }

  #capabilitiesStillCurrent(generation: number): boolean {
    return !this.#disposed && generation === this.#capabilitiesGeneration;
  }

  #listStillCurrent(generation: number): boolean {
    return !this.#disposed && generation === this.#listGeneration;
  }

  #detailStillCurrent(generation: number, listingId: string): boolean {
    return (
      !this.#disposed &&
      generation === this.#detailGeneration &&
      this.#state.detail.requestedListingId === listingId
    );
  }

  #providerStillCurrent(generation: number, providerId: string): boolean {
    return (
      !this.#disposed &&
      generation === this.#providerGeneration &&
      this.#state.provider.requestedProviderId === providerId
    );
  }

  #providerListStillCurrent(generation: number, providerId: string): boolean {
    return (
      this.#providerStillCurrent(generation, providerId) &&
      this.#state.provider.provider !== null
    );
  }

  #setDetail(detail: MarketDetailSection): void {
    if (this.#disposed) return;
    this.#set({ ...this.#state, detail });
  }

  #setProvider(provider: MarketProviderSection): void {
    if (this.#disposed) return;
    this.#set({ ...this.#state, provider });
  }

  #set(next: MarketControllerState): void {
    if (this.#disposed) return;
    this.#state = next;
    this.#onState?.(next);
  }
}

function failureKind(error: unknown): MarketFailureKind {
  if (error instanceof MarketApiError) {
    if (error.failure.kind === "feature-disabled") return "feature-disabled";
    if (error.failure.kind === "invalid-response") return "invalid-response";
    return "unavailable";
  }
  return "unavailable";
}

function isAborted(error: unknown): boolean {
  return error instanceof MarketApiError && error.failure.kind === "aborted";
}

/**
 * Strict local filter validation. A kind must be one of the closed enum values,
 * a provider id must be a canonical `openarc:provider:` id, and a query must be
 * trimmed 1..80 characters. Any invalid field fails the whole apply (no partial
 * coercion).
 */
function validateFilters(filters: MarketFilters): MarketFilters | null {
  const q = filters.q === null ? null : (filters.q === "" ? null : normalizeQuery(filters.q));
  if (filters.q !== null && filters.q !== "" && q === null) return null;
  const kind = filters.kind ?? null;
  if (kind !== null && !CommerceListingKindSchema.safeParse(kind).success) return null;
  const providerId = filters.providerId === null || filters.providerId === ""
    ? null
    : filters.providerId;
  if (providerId !== null && !CommerceProviderIdSchema.safeParse(providerId).success) {
    return null;
  }
  return { q, kind, providerId };
}

function normalizeQuery(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed.length < 1 || trimmed.length > 80) return null;
  // Reject control characters without echoing the raw value anywhere.
  for (const character of trimmed) {
    const codePoint = character.codePointAt(0);
    if (codePoint !== undefined && (codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f))) {
      return null;
    }
  }
  return trimmed;
}

export { MarketApiError, MarketClient };

export type MarketInfoKind = "docs" | "status" | "legal";

export type MarketRoute =
  | { readonly kind: "list" }
  | { readonly kind: "detail"; readonly listingId: string }
  | { readonly kind: "provider"; readonly providerId: string }
  | { readonly kind: "info"; readonly info: MarketInfoKind }
  | { readonly kind: "not-found" }
  | { readonly kind: "invalid" };

/** Decodes exactly one path segment once; `null` when decoding is unsafe. */
function decodePathSegment(segment: string): string | null {
  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
}

/**
 * Exact route grammar. A known route with an unknown extra/trailing path is a
 * bounded not-found; malformed percent-encoding is an invalid route. Interior
 * empty segments (e.g. `/market//id`) are rejected BEFORE decoding, while a
 * single trailing slash is normalized away. Query strings are never consulted,
 * so no private context can be derived from them.
 */
export function resolveMarketRoute(pathname: string): MarketRoute {
  const raw = pathname.replace(/\/+$/u, "") || "/";
  if (raw === "/market") return { kind: "list" };
  const leading = raw.split("/");
  if (leading[0] !== "") return { kind: "not-found" };
  const segments = leading.slice(1);
  // Reject any interior empty segment before decoding; only the leading slash
  // was removed and any trailing slash was already normalized away above.
  if (segments.some((segment) => segment.length === 0)) return { kind: "not-found" };
  if (raw.startsWith("/market/")) {
    if (segments.length !== 2) return { kind: "not-found" };
    const decoded = decodePathSegment(segments[1] as string);
    if (decoded === null) return { kind: "invalid" };
    if (!CommerceListingIdSchema.safeParse(decoded).success) return { kind: "not-found" };
    return { kind: "detail", listingId: decoded };
  }
  if (raw.startsWith("/providers/")) {
    if (segments.length !== 2) return { kind: "not-found" };
    const decoded = decodePathSegment(segments[1] as string);
    if (decoded === null) return { kind: "invalid" };
    if (!CommerceProviderIdSchema.safeParse(decoded).success) return { kind: "not-found" };
    return { kind: "provider", providerId: decoded };
  }
  if (raw === "/docs") return { kind: "info", info: "docs" };
  if (raw === "/status") return { kind: "info", info: "status" };
  if (raw === "/legal") return { kind: "info", info: "legal" };
  return { kind: "not-found" };
}

/**
 * Formats a canonical erc20/decimals-6 USDC atomic amount as an exact decimal
 * string using BigInt/strings only — no `Number`, no floating point and no
 * rounding. Trailing fractional zeros are trimmed and a whole amount keeps no
 * decimal point.
 */
export function formatUsdcAtomic(atomicAmount: string, decimals: number): string {
  const canonical = /^(0|[1-9][0-9]{0,77})$/u.test(atomicAmount);
  if (!canonical || !Number.isInteger(decimals) || decimals < 0 || decimals > 78) {
    return atomicAmount;
  }
  if (decimals === 0) return atomicAmount;
  const padded = BigInt(atomicAmount).toString().padStart(decimals + 1, "0");
  const splitIndex = padded.length - decimals;
  const whole = padded.slice(0, splitIndex).replace(/^0+(?=\d)/u, "");
  const fraction = padded.slice(splitIndex).replace(/0+$/u, "");
  return fraction.length > 0 ? `${whole}.${fraction}` : whole;
}

export function formatListingPrice(amount: { atomicAmount: string; decimals: number }): string {
  return formatUsdcAtomic(amount.atomicAmount, amount.decimals);
}
