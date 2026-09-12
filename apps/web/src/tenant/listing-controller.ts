import {
  CommerceListingIdSchema,
  CommerceListingOwnerVersionSchema,
  CommerceMarketListingContentSchema,
  CommerceTenantIdempotencyKeySchema,
  CommerceTenantMutationIdSchema,
  CommerceMarketMutationReceiptSchema,
  type CommerceListingOwner,
  type CommerceListingOwnerVersion,
  type CommerceMarketListingContent,
  type CommerceMarketMutationReceipt,
  type CommerceMarketMutationResult,
  type CommerceMarketProviderOption,
  type CommerceProviderId,
  type MarketplaceCapabilityState,
} from "@openarc/shared";

import type { AccountBoundToken, AccountFlowController } from "../account/flow-controller.js";
import {
  LISTING_PAGE_LIMIT,
  ListingApiError,
  ListingClient,
  createListingIdempotencyKey,
  createListingMutationId,
  readListingManagementCapability,
  type ListingApiFailure,
} from "./listing-client.js";
import type { ListingRoute } from "./listing-routes.js";

/**
 * Bounded listing-management controller.
 *
 * The controller owns at most one explicit logical write at a time. A logical
 * mutation id, idempotency key, target, body and CAS token are frozen for the
 * lifetime of a request: there is no automatic retry, polling, new key or
 * "latest state" preflight. A sent-but-unconfirmed outcome is reported as
 * `outcome-unknown` and can only be resolved by an explicit status GET with the
 * original mutation id. Every account/organization/role/generation change and
 * every hidden/pagehide/navigation event clears drafts, selections, keys,
 * receipts, errors and in-flight state. Nothing sensitive is written to
 * storage, the URL, history, a log or analytics.
 */

export const LISTING_HISTORY_PAGE_LIMIT = LISTING_PAGE_LIMIT;
export const LISTING_CURSOR_STACK_LIMIT = 20;

/**
 * Exact write-role matrix. Owner, provider_admin and provider_developer may
 * attempt a server-authorized listing write; operator and viewer are read-only;
 * an unknown role gets no controls. Local permission is a UI gate only: the
 * server remains the sole authority, and availability is never a grant.
 */
export function canWriteListings(role: string | null | undefined): boolean {
  return role === "owner" || role === "provider_admin" || role === "provider_developer";
}

export function canReadListings(role: string | null | undefined): boolean {
  return (
    role === "owner" ||
    role === "operator" ||
    role === "provider_admin" ||
    role === "provider_developer" ||
    role === "viewer"
  );
}

/** Draft id is deterministic from the mutation id: `openarc:listing:<uuid>`. */
export function deriveDraftListingId(mutationId: string): string {
  return `openarc:listing:${mutationId}`;
}

/** Reads a canonical listing id from a committed draft-create resource id. */
export function derivedListingIdOf(resourceId: string): string | null {
  const parsed = CommerceListingIdSchema.safeParse(resourceId);
  return parsed.success ? parsed.data : null;
}

/**
 * The latest version is only derivable when the history page is final
 * (`nextCursor === null`). An empty final history is a missing/error state, not
 * version 0.
 */
export function expectedLatestVersion(
  items: readonly CommerceListingOwnerVersion[],
  historyComplete: boolean,
): string | null {
  if (!historyComplete) return null;
  const last = items[items.length - 1];
  return last === undefined ? null : last.version;
}

/** Appends a cursor to the bounded previous-page stack (max 20). */
export function appendCursor(
  stack: readonly string[],
  cursor: string,
): readonly string[] {
  const next = [...stack, cursor];
  return next.length > LISTING_CURSOR_STACK_LIMIT
    ? next.slice(next.length - LISTING_CURSOR_STACK_LIMIT)
    : next;
}

/**
 * Converts a human TestnetUSDC fixed price to the canonical 6-decimals atomic
 * amount using strings/BigInt only. Rejects signs, whitespace, exponents,
 * fractional over-precision, leading zeros on the integer part, and zero.
 * Never uses `Number`.
 */
export function parseFixedPriceToAtomic(input: string): string | null {
  if (!/^(?:0|[1-9][0-9]*)(?:\.[0-9]{1,6})?$/u.test(input)) return null;
  const [whole, fraction = ""] = input.split(".");
  if (whole === undefined) return null;
  const padded = fraction.padEnd(6, "0");
  let atomic: bigint;
  try {
    atomic = BigInt(whole) * 1_000_000n + BigInt(padded);
  } catch {
    return null;
  }
  if (atomic <= 0n) return null;
  return atomic.toString();
}

/** Formats a canonical 6-decimals atomic amount as a human decimal string. */
export function formatFixedPriceFromAtomic(atomic: string): string {
  if (!/^(?:0|[1-9][0-9]*)$/u.test(atomic)) return "";
  const value = BigInt(atomic);
  const whole = (value / 1_000_000n).toString();
  const fraction = (value % 1_000_000n).toString().padStart(6, "0").replace(/0+$/u, "");
  return fraction.length === 0 ? whole : `${whole}.${fraction}`;
}

/** Builds the 11-field content object from the read form values. */
export function buildListingContent(input: {
  kind: CommerceMarketListingContent["kind"];
  title: string;
  description: string;
  inputSchemaDigest: string;
  outputSchemaDigest: string;
  priceAtomic: string;
  receiptType: string;
  receiptSchemaDigest: string;
  deliveryFields: readonly string[];
  endpointOrigin: string;
  endpointPath: string;
  termsRevision: string;
  privacySummary: string;
  availabilityStatus: "available" | "unavailable";
  rateLimitPerMinute: string | null;
}): CommerceMarketListingContent | null {
  const candidate = {
    kind: input.kind,
    title: input.title,
    description: input.description,
    manifest: {
      schemaVersion: "openarc.listing-manifest.v1" as const,
      inputSchemaDigest: input.inputSchemaDigest,
      outputSchemaDigest: input.outputSchemaDigest,
    },
    price: {
      amount: {
        schemaVersion: "openarc.usdc-amount.v1" as const,
        networkId: "eip155:5042002" as const,
        asset: "USDC" as const,
        representation: "erc20" as const,
        decimals: 6 as const,
        atomicAmount: input.priceAtomic,
      },
      pricingModel: "fixed" as const,
    },
    evidenceContract: {
      schemaVersion: "openarc.receipt-contract.v1" as const,
      receiptType: input.receiptType,
      receiptSchemaDigest: input.receiptSchemaDigest,
      deliveryFields: [...input.deliveryFields],
    },
    endpointContract: {
      origin: input.endpointOrigin,
      path: input.endpointPath,
    },
    termsRevision: input.termsRevision,
    privacySummary: input.privacySummary,
    paymentLane: "unavailable" as const,
    availability: {
      status: input.availabilityStatus,
      rateLimitPerMinute: input.rateLimitPerMinute,
    },
  };
  const parsed = CommerceMarketListingContentSchema.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}

/** Prefills a NEW-version form from an existing (never edited-in-place) version. */
export function prefillContentFromVersion(
  version: CommerceListingOwnerVersion,
): CommerceMarketListingContent | null {
  const parsed = CommerceListingOwnerVersionSchema.safeParse(version);
  if (!parsed.success) return null;
  const candidate = {
    kind: parsed.data.kind,
    title: parsed.data.title,
    description: parsed.data.description,
    manifest: parsed.data.manifest,
    price: parsed.data.price,
    evidenceContract: parsed.data.evidenceContract,
    endpointContract: parsed.data.endpointContract,
    termsRevision: parsed.data.termsRevision,
    privacySummary: parsed.data.privacySummary,
    paymentLane: parsed.data.paymentLane,
    availability: parsed.data.availability,
  };
  const content = CommerceMarketListingContentSchema.safeParse(candidate);
  return content.success ? content.data : null;
}

export interface ListingReadCoordinator {
  currentOrganizationId(): string | null;
  currentRole(): string | null;
  currentAccountId(): string | null;
  abortPendingReads(): void;
  reloadAfterCommit(): Promise<void>;
}

export type ListingRootsStatus = "none" | "loading" | "ready" | "error";

export interface ListingRootsState {
  readonly status: ListingRootsStatus;
  readonly items: readonly CommerceListingOwner[];
  readonly nextCursor: string | null;
  readonly hasPrevious: boolean;
}

export interface ListingVersionHistoryState {
  readonly status: ListingRootsStatus;
  readonly items: readonly CommerceListingOwnerVersion[];
  readonly nextCursor: string | null;
  readonly historyComplete: boolean;
  readonly cursorStack: readonly string[];
}

export interface ListingDetailState {
  readonly status: "none" | "loading" | "ready" | "not-found" | "error";
  readonly root: CommerceListingOwner | null;
  readonly history: ListingVersionHistoryState;
}

export interface ListingProviderOptionsState {
  readonly status: ListingRootsStatus;
  readonly items: readonly CommerceMarketProviderOption[];
  readonly nextCursor: string | null;
  readonly hasPrevious: boolean;
}

export type ListingMutationDraft =
  | { readonly op: "create-draft"; readonly providerId: CommerceProviderId; readonly content: CommerceMarketListingContent }
  | { readonly op: "create-version"; readonly listingId: string; readonly expectedLatestVersion: string; readonly content: CommerceMarketListingContent }
  | { readonly op: "publish"; readonly listingId: string; readonly version: string; readonly expectedUpdatedAt: string; readonly expectedActiveVersion: string | null }
  | { readonly op: "pause"; readonly listingId: string; readonly version: string; readonly expectedUpdatedAt: string; readonly expectedActiveVersion: string | null }
  | { readonly op: "retire"; readonly listingId: string; readonly version: string; readonly expectedUpdatedAt: string; readonly expectedActiveVersion: string | null };

export type ListingMutationNotice =
  | { readonly kind: "validation" }
  | { readonly kind: "policy" }
  | { readonly kind: "conflict"; readonly reloadRequired: boolean }
  | { readonly kind: "unauthenticated" }
  | { readonly kind: "csrf" }
  | { readonly kind: "forbidden" }
  | { readonly kind: "not-found" }
  | { readonly kind: "account-changed" }
  | { readonly kind: "capability-disabled" };

export type ListingMutationState =
  | { readonly kind: "idle" }
  | { readonly kind: "confirming"; readonly draft: ListingMutationDraft }
  | { readonly kind: "pending"; readonly draft: ListingMutationDraft; readonly mutationId: string }
  | {
      readonly kind: "committed";
      readonly receipt: CommerceMarketMutationReceipt;
      readonly replayed: boolean;
      readonly resourceVersion: string | null;
      readonly refreshError: boolean;
    }
  | { readonly kind: "rejected"; readonly notice: ListingMutationNotice }
  | {
      readonly kind: "outcome-unknown";
      readonly mutationId: string;
      readonly organizationId: string;
      readonly family: "draft" | "lifecycle";
      readonly operation: string;
      readonly resourceId: string;
      readonly listingId: string | null;
      readonly version: string | null;
      readonly checking: boolean;
      readonly statusMessage: string | null;
    };

export interface ListingSelection {
  readonly route: ListingRoute;
  readonly selectedVersion: CommerceListingOwnerVersion | null;
  readonly prefill: CommerceMarketListingContent | null;
  readonly knownLatestVersion: string | null;
}

export interface ListingControllerState {
  readonly capability: "unknown" | "checking" | "enabled" | "unavailable";
  readonly role: string | null;
  readonly canWrite: boolean;
  readonly roots: ListingRootsState;
  readonly detail: ListingDetailState;
  readonly providerOptions: ListingProviderOptionsState;
  readonly selection: ListingSelection;
  readonly mutation: ListingMutationState;
}

export function initialListingRootsState(): ListingRootsState {
  return { status: "none", items: [], nextCursor: null, hasPrevious: false };
}

export function initialListingVersionHistoryState(): ListingVersionHistoryState {
  return { status: "none", items: [], nextCursor: null, historyComplete: false, cursorStack: [] };
}

export function initialListingDetailState(): ListingDetailState {
  return { status: "none", root: null, history: initialListingVersionHistoryState() };
}

export function initialListingProviderOptionsState(): ListingProviderOptionsState {
  return { status: "none", items: [], nextCursor: null, hasPrevious: false };
}

export function initialListingControllerState(): ListingControllerState {
  return {
    capability: "unknown",
    role: null,
    canWrite: false,
    roots: initialListingRootsState(),
    detail: initialListingDetailState(),
    providerOptions: initialListingProviderOptionsState(),
    selection: { route: { kind: "roots" }, selectedVersion: null, prefill: null, knownLatestVersion: null },
    mutation: { kind: "idle" },
  };
}

export interface ListingControllerDeps {
  readonly client?: ListingClient;
  readonly account: AccountFlowController;
  readonly reads: ListingReadCoordinator;
  readonly capabilityReader?: (signal: AbortSignal) => Promise<MarketplaceCapabilityState>;
  /**
   * Invoked after a committed first-draft create so the shell can open the new
   * detail page. The listing id is derived from the committed receipt resource
   * id; it is never optimistically assumed before the commit.
   */
  readonly onCommittedListing?: (listingId: string) => void;
  readonly onState?: (state: ListingControllerState) => void;
}

interface FrozenSubmission {
  readonly draft: ListingMutationDraft;
  readonly mutationId: string;
  readonly idempotencyKey: string;
  readonly organizationId: string;
}

export class ListingController {
  #state: ListingControllerState = initialListingControllerState();
  #disposed = false;
  #generation = 0;
  #rootsAbort: AbortController | null = null;
  #detailAbort: AbortController | null = null;
  #providersAbort: AbortController | null = null;
  #statusAbort: AbortController | null = null;
  #capabilityAbort: AbortController | null = null;
  #frozen: FrozenSubmission | null = null;
  #capabilityChecked = false;
  readonly #client: ListingClient;
  readonly #account: AccountFlowController;
  readonly #reads: ListingReadCoordinator;
  readonly #capabilityReader: (signal: AbortSignal) => Promise<MarketplaceCapabilityState>;
  readonly #onCommittedListing: ((listingId: string) => void) | undefined;
  readonly #onState: ((state: ListingControllerState) => void) | undefined;

  constructor(deps: ListingControllerDeps) {
    this.#client = deps.client ?? new ListingClient();
    this.#account = deps.account;
    this.#reads = deps.reads;
    this.#capabilityReader = deps.capabilityReader ?? ((signal) => readListingManagementCapability(signal));
    this.#onCommittedListing = deps.onCommittedListing;
    this.#onState = deps.onState;
  }

  get state(): ListingControllerState {
    return this.#state;
  }

  get disposed(): boolean {
    return this.#disposed;
  }

  /** Point the controller at a parsed route without issuing any request. */
  setRoute(route: ListingRoute): void {
    if (this.#disposed) return;
    this.#update({
      selection: {
        route,
        selectedVersion: null,
        prefill: null,
        knownLatestVersion: null,
      },
      detail: initialListingDetailState(),
    });
  }

  /**
   * Independent capability gate. It runs BEFORE any listing client/controller
   * request and never depends on tenant-writes or the machine flag. On a known
   * listing route with the flag on but the capability not `enabled`, state is
   * `unavailable` and no listing request is ever made.
   */
  async initialize(route: ListingRoute): Promise<void> {
    if (this.#disposed) return;
    const generation = this.#generation;
    this.#update({ selection: { route, selectedVersion: null, prefill: null, knownLatestVersion: null } });
    if (!this.#capabilityChecked) {
      this.#update({ capability: "checking" });
      // The capability probe is tracked like every other request so an
      // account/org/role change, hidden/pagehide or dispose aborts it instead
      // of leaving the gate stuck on "checking" or letting a late response
      // resurrect an obsolete context. Generation checks still apply.
      this.#capabilityAbort?.abort();
      const capabilityController = new AbortController();
      this.#capabilityAbort = capabilityController;
      let state: MarketplaceCapabilityState;
      try {
        state = await this.#capabilityReader(capabilityController.signal);
      } catch {
        if (generation !== this.#generation) return;
        if (capabilityController.signal.aborted) return;
        this.#update({ capability: "unavailable" });
        return;
      }
      if (!this.#stillCurrent(generation)) return;
      if (capabilityController.signal.aborted) return;
      this.#capabilityAbort = null;
      this.#capabilityChecked = true;
      if (state !== "enabled") {
        this.#update({ capability: "unavailable" });
        return;
      }
      this.#update({ capability: "enabled" });
    }
    if (this.#state.capability !== "enabled") return;
    if (route.kind === "roots" || route.kind === "new") {
      await this.loadRoots();
      if (route.kind === "new") await this.loadProviderOptions();
    } else if (route.kind === "detail") {
      await this.loadDetail(route.listingId);
    }
  }

  async loadRoots(): Promise<void> {
    await this.#loadRootsPage(false);
  }

  async loadNextRoots(): Promise<void> {
    await this.#loadRootsPage(true);
  }

  async #loadRootsPage(next: boolean): Promise<void> {
    if (this.#disposed || !this.#authorized()) return;
    const organizationId = this.#currentOrganizationId();
    if (organizationId === null) return;
    const cursor = next ? this.#state.roots.nextCursor : null;
    if (next && cursor === null) return;
    const generation = this.#generation;
    this.#rootsAbort?.abort();
    const controller = new AbortController();
    this.#rootsAbort = controller;
    this.#patchRoots({ status: "loading" });
    let page;
    try {
      page = await this.#client.listRoots(
        { organizationId, ...(cursor === null ? {} : { afterListingId: cursor }) },
        controller.signal,
      );
    } catch {
      if (!this.#stillCurrent(generation)) return;
      this.#patchRoots({ status: "error", items: [], nextCursor: null, hasPrevious: next });
      return;
    }
    if (!this.#stillCurrent(generation) || this.#currentOrganizationId() !== organizationId) return;
    this.#patchRoots({ status: "ready", items: page.items, nextCursor: page.nextCursor, hasPrevious: next });
  }

  async loadProviderOptions(): Promise<void> {
    await this.#loadProvidersPage(false);
  }

  async loadNextProviderOptions(): Promise<void> {
    await this.#loadProvidersPage(true);
  }

  async #loadProvidersPage(next: boolean): Promise<void> {
    if (this.#disposed || !this.#authorized()) return;
    const organizationId = this.#currentOrganizationId();
    if (organizationId === null) return;
    const cursor = next ? this.#state.providerOptions.nextCursor : null;
    if (next && cursor === null) return;
    const generation = this.#generation;
    this.#providersAbort?.abort();
    const controller = new AbortController();
    this.#providersAbort = controller;
    this.#patchProviders({ status: "loading" });
    let page;
    try {
      page = await this.#client.listProviderOptions(
        { organizationId, ...(cursor === null ? {} : { afterProviderId: cursor }) },
        controller.signal,
      );
    } catch {
      if (!this.#stillCurrent(generation)) return;
      this.#patchProviders({ status: "error", items: [], nextCursor: null, hasPrevious: next });
      return;
    }
    if (!this.#stillCurrent(generation) || this.#currentOrganizationId() !== organizationId) return;
    this.#patchProviders({ status: "ready", items: page.items, nextCursor: page.nextCursor, hasPrevious: next });
  }

  /**
   * Detail fetch: root and the first history page resolve INDEPENDENTLY. A
   * truthful `item: null` root becomes an honest `not-found`; a history failure
   * does not fabricate an empty (version 0) history.
   */
  async loadDetail(listingId: string): Promise<void> {
    if (this.#disposed || !this.#authorized()) return;
    const organizationId = this.#currentOrganizationId();
    if (organizationId === null) return;
    const generation = this.#generation;
    this.#detailAbort?.abort();
    const controller = new AbortController();
    this.#detailAbort = controller;
    this.#patchDetail({
      status: "loading",
      root: null,
      history: initialListingVersionHistoryState(),
    });
    const [rootResult, historyResult] = await Promise.allSettled([
      this.#client.readRoot({ organizationId, listingId }, controller.signal),
      this.#client.listVersions({ organizationId, listingId }, controller.signal),
    ]);
    if (!this.#stillCurrent(generation) || this.#currentOrganizationId() !== organizationId) return;
    const root = rootResult.status === "fulfilled" ? rootResult.value.item : null;
    const rootFailed = rootResult.status === "rejected";
    const history =
      historyResult.status === "fulfilled"
        ? {
            status: "ready" as const,
            items: historyResult.value.items,
            nextCursor: historyResult.value.nextCursor,
            historyComplete: historyResult.value.nextCursor === null,
            cursorStack: [] as readonly string[],
          }
        : {
            status: "error" as const,
            items: [] as readonly CommerceListingOwnerVersion[],
            nextCursor: null,
            historyComplete: false,
            cursorStack: [] as readonly string[],
          };
    if (root === null) {
      // A null item is a truthful miss. A transport failure is an error, never a
      // fabricated not-found, but the history page may still be shown.
      this.#patchDetail({
        status: rootFailed ? "error" : "not-found",
        root: null,
        history,
      });
      return;
    }
    this.#patchDetail({ status: "ready", root, history });
  }

  /** Explicit bounded "load more versions": ascending afterVersion, max 50. */
  async loadMoreVersions(): Promise<void> {
    if (this.#disposed || !this.#authorized()) return;
    const detail = this.#state.detail;
    const root = detail.root;
    const organizationId = this.#currentOrganizationId();
    if (root === null || organizationId === null) return;
    const history = detail.history;
    if (history.status === "loading" || history.historyComplete || history.nextCursor === null) return;
    const cursor = history.nextCursor;
    const generation = this.#generation;
    this.#detailAbort?.abort();
    const controller = new AbortController();
    this.#detailAbort = controller;
    this.#patchDetail({ ...detail, history: { ...history, status: "loading" } });
    let page;
    try {
      page = await this.#client.listVersions(
        { organizationId, listingId: root.listingId, afterVersion: cursor },
        controller.signal,
      );
    } catch {
      if (!this.#stillCurrent(generation)) return;
      // Preserve the one prior bounded page and its cursor, but make the
      // continuation failure EXPLICIT. History stays incomplete (so no latest
      // version is claimed and create-version stays disabled), and the visible
      // error plus the still-present cursor lets an explicit retry recover.
      this.#patchDetail({ ...this.#state.detail, history: { ...history, status: "error" } });
      return;
    }
    if (!this.#stillCurrent(generation) || this.#currentOrganizationId() !== organizationId) return;
    const completed = page.nextCursor === null;
    const nextHistory: ListingVersionHistoryState = {
      status: "ready",
      items: page.items,
      nextCursor: page.nextCursor,
      historyComplete: completed,
      cursorStack: appendCursor(history.cursorStack, cursor),
    };
    const nextDetail = { ...this.#state.detail, history: nextHistory };
    // Selecting a historical version pre-fills a NEW version form; the known
    // latest is invalidated on fresh load/context change, never carried across.
    this.#patchDetail(nextDetail);
  }

  /**
   * Explicit version selection for a NEW-version form. An existing version is
   * NEVER editable in place: this only records the source for prefill.
   */
  selectVersion(version: CommerceListingOwnerVersion): boolean {
    if (this.#disposed || !this.#authorized()) return false;
    const parsed = CommerceListingOwnerVersionSchema.safeParse(version);
    if (!parsed.success) return false;
    const prefill = prefillContentFromVersion(parsed.data);
    if (prefill === null) return false;
    this.#update({
      selection: {
        route: this.#state.selection.route,
        selectedVersion: parsed.data,
        prefill,
        knownLatestVersion: this.#knownLatestVersion(),
      },
    });
    return true;
  }

  #knownLatestVersion(): string | null {
    const history = this.#state.detail.history;
    return expectedLatestVersion(history.items, history.historyComplete);
  }

  /** Begins the explicit confirmation stage; sends nothing and mints no key. */
  beginCreateDraft(providerId: string, content: CommerceMarketListingContent): boolean {
    return this.#begin({ op: "create-draft", providerId: providerId as CommerceProviderId, content });
  }

  beginCreateVersion(content: CommerceMarketListingContent): boolean {
    const root = this.#state.detail.root;
    if (root === null) return false;
    const expected = this.#knownLatestVersion();
    if (expected === null) return false;
    return this.#begin({ op: "create-version", listingId: root.listingId, expectedLatestVersion: expected, content });
  }

  beginLifecycle(
    op: "publish" | "pause" | "retire",
    version: CommerceListingOwnerVersion,
  ): boolean {
    const root = this.#state.detail.root;
    if (root === null) return false;
    const expectedUpdatedAt = version.updatedAt;
    const expectedActiveVersion = root.activeVersion;
    if (op === "publish") {
      if (version.status !== "draft" && version.status !== "paused") return false;
      if (version.originReviewState !== "approved") return false;
    } else if (op === "pause") {
      if (version.status !== "active") return false;
    } else if (version.status !== "active" && version.status !== "paused") {
      return false;
    }
    return this.#begin({
      op,
      listingId: root.listingId,
      version: version.version,
      expectedUpdatedAt,
      expectedActiveVersion,
    });
  }

  #begin(draft: ListingMutationDraft): boolean {
    if (this.#disposed) return false;
    if (this.#state.capability !== "enabled") {
      this.#update({ mutation: { kind: "rejected", notice: { kind: "capability-disabled" } } });
      return false;
    }
    if (!canWriteListings(this.#currentRole())) {
      this.#update({ mutation: { kind: "rejected", notice: { kind: "forbidden" } } });
      return false;
    }
    this.#generation += 1;
    this.#frozen = null;
    this.#update({ mutation: { kind: "confirming", draft } });
    return true;
  }

  cancel(): void {
    if (this.#disposed) return;
    if (this.#state.mutation.kind === "pending") return;
    this.#generation += 1;
    this.#frozen = null;
    this.#update({ mutation: { kind: "idle" } });
  }

  /** Sends exactly one confirmed logical write with a frozen id/key/CAS. */
  async confirm(): Promise<void> {
    if (this.#disposed) return;
    if (this.#state.mutation.kind !== "confirming") return;
    const draft = this.#state.mutation.draft;
    const organizationId = this.#currentOrganizationId();
    if (organizationId === null) return;
    const mutationId = createListingMutationId();
    const idempotencyKey = createListingIdempotencyKey();
    if (
      !CommerceTenantMutationIdSchema.safeParse(mutationId).success ||
      !CommerceTenantIdempotencyKeySchema.safeParse(idempotencyKey).success
    ) {
      this.#update({ mutation: { kind: "rejected", notice: { kind: "validation" } } });
      return;
    }
    const generation = this.#generation;
    this.#frozen = { draft, mutationId, idempotencyKey, organizationId };
    this.#update({ mutation: { kind: "pending", draft, mutationId } });
    this.#reads.abortPendingReads();
    const accountBound: AccountBoundToken = this.#account.captureAccountBound();
    try {
      const result = await this.#account.mutate(
        async ({ csrfToken, signal }) =>
          this.#runAction(draft, organizationId, mutationId, idempotencyKey, csrfToken, signal),
        { accountBound },
      );
      if (!this.#stillCurrent(generation)) return;
      this.#frozen = null;
      await this.#afterCommit(result, generation);
    } catch (error) {
      if (!this.#stillCurrent(generation)) return;
      this.#handleFailure(error, draft, mutationId, organizationId);
    }
  }

  /**
   * Runs exactly one frozen logical action. The mutation id and idempotency key
   * are supplied by the controller and never re-minted here.
   */
  async #runAction(
    draft: ListingMutationDraft,
    organizationId: string,
    mutationId: string,
    idempotencyKey: string,
    csrfToken: string,
    signal: AbortSignal,
  ): Promise<{ receipt: CommerceMarketMutationReceipt; replayed: boolean; resourceVersion: string | null }> {
    const common = { organizationId, csrfToken, idempotencyKey, signal };
    let result: CommerceMarketMutationResult;
    switch (draft.op) {
      case "create-draft":
        result = await this.#client.createDraft({
          ...common,
          body: { mutationId, providerId: draft.providerId, content: draft.content },
        });
        break;
      case "create-version":
        result = await this.#client.createVersion({
          ...common,
          listingId: draft.listingId,
          body: {
            mutationId,
            expectedLatestVersion: draft.expectedLatestVersion,
            content: draft.content,
          },
        });
        break;
      case "publish":
      case "pause":
      case "retire":
        result = await this.#client[draft.op]({
          ...common,
          listingId: draft.listingId,
          version: draft.version,
          body: {
            mutationId,
            expectedUpdatedAt: draft.expectedUpdatedAt,
            expectedActiveVersion: draft.expectedActiveVersion,
          },
        });
        break;
    }
    assertReceiptBinding(result, mutationId);
    return {
      receipt: result.receipt,
      replayed: result.replayed,
      resourceVersion: resourceVersionOf(result.receipt),
    };
  }

  async #afterCommit(
    result: { receipt: CommerceMarketMutationReceipt; replayed: boolean; resourceVersion: string | null },
    generation: number,
  ): Promise<void> {
    let refreshError = false;
    try {
      await this.#reads.reloadAfterCommit();
    } catch {
      refreshError = true;
    }
    if (!this.#stillCurrent(generation)) return;
    this.#update({
      mutation: {
        kind: "committed",
        receipt: result.receipt,
        replayed: result.replayed,
        resourceVersion: result.resourceVersion,
        refreshError,
      },
    });
    if (result.receipt.operation === "market.listing.create") {
      const listingId = derivedListingIdOf(result.receipt.resourceId);
      if (listingId !== null) this.#onCommittedListing?.(listingId);
    }
    if (refreshError) return;
    const route = this.#state.selection.route;
    if (route.kind === "detail") {
      await this.loadDetail(route.listingId);
    } else {
      await this.loadRoots();
    }
  }

  #handleFailure(
    error: unknown,
    draft: ListingMutationDraft,
    mutationId: string,
    organizationId: string,
  ): void {
    const failure = failureOf(error);
    switch (failure.kind) {
      case "unauthenticated":
        this.#frozen = null;
        this.#update({ mutation: { kind: "rejected", notice: { kind: "unauthenticated" } } });
        return;
      case "csrf":
        this.#frozen = null;
        this.#update({ mutation: { kind: "rejected", notice: { kind: "csrf" } } });
        return;
      case "forbidden":
        this.#frozen = null;
        this.#update({ mutation: { kind: "rejected", notice: { kind: "forbidden" } } });
        return;
      case "validation":
        this.#frozen = null;
        this.#update({ mutation: { kind: "rejected", notice: { kind: "validation" } } });
        return;
      case "policy":
        this.#frozen = null;
        this.#update({ mutation: { kind: "rejected", notice: { kind: "policy" } } });
        return;
      case "conflict":
        // A definite conflict keeps the prior id/key for review, marks that a
        // reload is required, and requires a fresh explicit action.
        this.#frozen = null;
        this.#update({ mutation: { kind: "rejected", notice: { kind: "conflict", reloadRequired: true } } });
        return;
      case "not-found":
        this.#frozen = null;
        this.#update({ mutation: { kind: "rejected", notice: { kind: "not-found" } } });
        return;
      case "account-changed":
        this.#frozen = null;
        this.#update({ mutation: { kind: "rejected", notice: { kind: "account-changed" } } });
        return;
      case "aborted":
        this.#frozen = null;
        this.#update({ mutation: { kind: "idle" } });
        return;
      case "pre-send":
        this.#frozen = null;
        this.#update({ mutation: { kind: "rejected", notice: { kind: "validation" } } });
        return;
      default: {
        // Sent-but-unconfirmed: keep the frozen id and offer only an explicit
        // status GET with the original id.
        const frozen = this.#frozen;
        const binding = mutationBindingOf(draft, frozen?.mutationId ?? mutationId);
        this.#update({
          mutation: {
            kind: "outcome-unknown",
            mutationId: frozen?.mutationId ?? mutationId,
            organizationId: frozen?.organizationId ?? organizationId,
            family: draft.op === "create-draft" || draft.op === "create-version" ? "draft" : "lifecycle",
            operation: binding.operation,
            resourceId: binding.resourceId,
            listingId: draft.op === "create-draft" ? null : draft.listingId,
            version: draft.op === "publish" || draft.op === "pause" || draft.op === "retire" ? draft.version : null,
            checking: false,
            statusMessage: null,
          },
        });
        return;
      }
    }
  }

  /** Explicit safe status GET using the ORIGINAL mutation id; no resubmission. */
  async checkStatus(): Promise<void> {
    if (this.#disposed || this.#state.mutation.kind !== "outcome-unknown") return;
    const current = this.#state.mutation;
    const generation = this.#generation;
    this.#statusAbort?.abort();
    const controller = new AbortController();
    this.#statusAbort = controller;
    this.#update({ mutation: { ...current, checking: true, statusMessage: null } });
    let status;
    try {
      status =
        current.family === "draft"
          ? await this.#client.readDraftMutationStatus({
              organizationId: current.organizationId,
              mutationId: current.mutationId,
              operation: current.operation as "market.listing.create" | "market.listing.version.create",
              resourceId: current.resourceId,
              signal: controller.signal,
            })
          : await this.#client.readLifecycleMutationStatus({
              organizationId: current.organizationId,
              listingId: current.listingId ?? "",
              version: current.version ?? "",
              mutationId: current.mutationId,
              operation: current.operation,
              signal: controller.signal,
            });
    } catch {
      if (!this.#stillCurrent(generation) || this.#state.mutation.kind !== "outcome-unknown") return;
      this.#update({
        mutation: {
          ...current,
          checking: false,
          statusMessage: "No committed result found yet; it may still complete. Check again.",
        },
      });
      return;
    }
    if (!this.#stillCurrent(generation) || this.#state.mutation.kind !== "outcome-unknown") return;
    if (status.status === "committed") {
      this.#frozen = null;
      await this.#afterCommit(
        { receipt: status.receipt, replayed: true, resourceVersion: null },
        generation,
      );
      return;
    }
    // not_found never enables a resend and never mints a new id/key.
    this.#update({
      mutation: {
        ...current,
        checking: false,
        statusMessage: "No committed result found yet; it may still complete. Check again.",
      },
    });
  }

  /**
   * Account/org/role/session/hidden/pagehide/navigation/dispose: clear form,
   * selected version, mutation key/id/receipt/errors/request state.
   */
  clear(): void {
    if (this.#disposed) return;
    this.#generation += 1;
    this.#frozen = null;
    this.#rootsAbort?.abort();
    this.#rootsAbort = null;
    this.#detailAbort?.abort();
    this.#detailAbort = null;
    this.#providersAbort?.abort();
    this.#providersAbort = null;
    this.#statusAbort?.abort();
    this.#statusAbort = null;
    this.#capabilityAbort?.abort();
    this.#capabilityAbort = null;
    this.#update({
      role: this.#currentRole(),
      canWrite: this.#canWrite(),
      roots: initialListingRootsState(),
      detail: initialListingDetailState(),
      providerOptions: initialListingProviderOptionsState(),
      selection: {
        route: this.#state.selection.route,
        selectedVersion: null,
        prefill: null,
        knownLatestVersion: null,
      },
      mutation: { kind: "idle" },
    });
  }

  /** Role reconciliation: a role change clears every local artifact. */
  reconcileRole(role: string | null): void {
    if (this.#disposed) return;
    if (this.#state.role === role && this.#state.canWrite === canWriteListings(role)) return;
    this.clear();
  }

  /** Clears only the credential/form artifacts, not the bounded read pages. */
  clearSensitive(): void {
    if (this.#disposed) return;
    this.#generation += 1;
    this.#frozen = null;
    this.#statusAbort?.abort();
    this.#statusAbort = null;
    this.#capabilityAbort?.abort();
    this.#capabilityAbort = null;
    this.#update({
      selection: {
        route: this.#state.selection.route,
        selectedVersion: null,
        prefill: null,
        knownLatestVersion: null,
      },
      mutation: { kind: "idle" },
    });
  }

  dispose(): void {
    if (this.#disposed) return;
    this.clear();
    this.#disposed = true;
    this.#onState?.(this.#state);
  }

  /**
   * Reads require only the independent capability gate. The server remains the
   * authority for role and tenant scope, so a role that arrives after the first
   * initialize never strands the surface. Write controls are gated separately
   * by the exact local role matrix in `#canWrite`.
   */
  #authorized(): boolean {
    return this.#state.capability === "enabled";
  }

  /** Writes additionally require the exact write-role matrix. */
  #canWrite(): boolean {
    return this.#state.capability === "enabled" && canWriteListings(this.#currentRole());
  }

  #currentRole(): string | null {
    return this.#reads.currentRole();
  }

  #currentOrganizationId(): string | null {
    return this.#reads.currentOrganizationId();
  }

  #stillCurrent(generation: number): boolean {
    return !this.#disposed && generation === this.#generation;
  }

  #patchRoots(patch: Partial<ListingRootsState>): void {
    this.#update({ roots: { ...this.#state.roots, ...patch } });
  }

  #patchProviders(patch: Partial<ListingProviderOptionsState>): void {
    this.#update({ providerOptions: { ...this.#state.providerOptions, ...patch } });
  }

  #patchDetail(detail: ListingDetailState): void {
    this.#update({ detail });
  }

  #update(patch: Partial<ListingControllerState>): void {
    if (this.#disposed) return;
    this.#state = { ...this.#state, ...patch };
    // Role and the derived write gate are always recomputed from the current
    // server context and capability: a role/capability change can never leave a
    // stale owner control on screen.
    this.#state = {
      ...this.#state,
      role: this.#currentRole(),
      canWrite: this.#canWrite(),
    };
    this.#onState?.(this.#state);
  }
}

type FailureKind = ListingApiFailure["kind"] | "account-changed";

/** A response receipt must bind the exact frozen mutation id requested. */
export function assertReceiptBinding(
  result: CommerceMarketMutationResult,
  mutationId: string,
): void {
  if (!CommerceMarketMutationReceiptSchema.safeParse(result.receipt).success) {
    throw new ListingApiError({ kind: "invalid-response" });
  }
  if (result.receipt.mutationId !== mutationId) {
    throw new ListingApiError({ kind: "invalid-response" });
  }
}

/**
 * Extracts the immutable version resource version from a receipt. A draft
 * create has no version; a version create/lifecycle receipt resourceId is
 * `canonicalListingId@version` and must carry version >= 1 (>= 2 for creation).
 */
export function resourceVersionOf(receipt: CommerceMarketMutationReceipt): string | null {
  if (receipt.operation === "market.listing.create") return null;
  const parts = receipt.resourceId.split("@");
  const version = parts[1];
  return version === undefined ? null : version;
}

/**
 * The exact operation and resource a frozen logical action must receive back.
 * A first draft resource is deterministically `openarc:listing:<mutationId>`;
 * a new version is `listingId@(expectedLatestVersion + 1)`; a lifecycle
 * mutation is `listingId@version`. This is the SAME correlation the transport
 * binds, derived only from frozen inputs and never re-minted.
 */
export function mutationBindingOf(
  draft: ListingMutationDraft,
  mutationId: string,
): { operation: string; resourceId: string } {
  switch (draft.op) {
    case "create-draft":
      return { operation: "market.listing.create", resourceId: `openarc:listing:${mutationId}` };
    case "create-version":
      return {
        operation: "market.listing.version.create",
        resourceId: `${draft.listingId}@${(BigInt(draft.expectedLatestVersion) + 1n).toString()}`,
      };
    case "publish":
      return { operation: "market.listing.version.publish", resourceId: `${draft.listingId}@${draft.version}` };
    case "pause":
      return { operation: "market.listing.version.pause", resourceId: `${draft.listingId}@${draft.version}` };
    case "retire":
      return { operation: "market.listing.version.retire", resourceId: `${draft.listingId}@${draft.version}` };
  }
}

function failureOf(error: unknown): { kind: FailureKind } {
  if (error instanceof ListingApiError) return { kind: error.failure.kind };
  if (typeof error === "object" && error !== null) {
    const failure = (error as { failure?: { kind?: unknown } }).failure;
    if (typeof failure === "object" && failure !== null) {
      const kind = (failure as { kind?: unknown }).kind;
      if (kind === "account-changed") return { kind: "account-changed" };
    }
  }
  return { kind: "outcome-unknown" };
}

export type { CommerceMarketProviderOption, ListingRoute };

/**
 * Synchronous render-boundary guard for the listing surface.
 *
 * React effects run AFTER render, so an account/organization/role transition
 * would otherwise paint one frame of the previous context's draft, receipt or
 * list. The parent computes the bound context during render and suppresses (by
 * substituting the initial state) when it does not match the current context.
 */
export interface ListingRenderContext {
  readonly accountId: string | null;
  readonly organizationId: string | null;
  readonly role: string | null;
}

export function suppressStaleListingContext(
  bound: ListingRenderContext | null,
  current: ListingRenderContext,
): boolean {
  if (bound === null) return false;
  if (current.accountId === null || current.organizationId === null) return true;
  return (
    bound.accountId !== current.accountId ||
    bound.organizationId !== current.organizationId ||
    bound.role !== current.role
  );
}

/**
 * Render-time projection used by the parent so a suppressed transition frame
 * never exposes a previous context's draft, receipt, selection or list. When
 * suppression applies the caller receives the initial state instead of the
 * controller's held value.
 */
export function renderListingState(
  suppress: boolean,
  state: ListingControllerState,
  initial: () => ListingControllerState = initialListingControllerState,
): ListingControllerState {
  return suppress ? initial() : state;
}
