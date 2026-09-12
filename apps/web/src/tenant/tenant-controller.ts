import { CommerceAgentIdSchema, CommerceProviderIdSchema } from "@openarc/shared";
import type {
  AccountSessionView,
  CommerceAgentPage,
  CommerceOrganizationContext,
  CommerceOrganizationId,
  CommerceOrganizationPage,
  CommerceProviderPage,
} from "@openarc/shared";

import type { AccountFlowController } from "../account/flow-controller.js";
import { contextAccountId, TenantApiError, TenantClient } from "./tenant-client.js";

/**
 * Coordinates organization-scoped reads around the accepted account session.
 *
 * This controller never mutates the account flow controller and never touches
 * the Vault or a wallet. It owns a separate principal, organization and
 * per-read generation so a delayed response from a previous account,
 * organization or route can never overwrite newer state. All protected data
 * is in memory only: nothing is written to localStorage, sessionStorage,
 * IndexedDB, the URL or a cookie.
 */

export const PAGE_LIMIT = 50 as const;
export const MAX_PAGE_LIMIT = 100 as const;

export type TenantPrincipalStatus =
  | "idle"
  | "loading"
  | "signed-out"
  | "expired"
  | "signed-in";

export interface TenantPrincipalState {
  readonly status: TenantPrincipalStatus;
  readonly accountId: string | null;
  readonly expiresAt: string | null;
}

export type TenantDataStatus = "none" | "loading" | "ready" | "error";

export type TenantFailureKind =
  | "unauthenticated"
  | "forbidden"
  | "feature-disabled"
  | "unavailable"
  | "invalid-response";

export interface TenantViewControllerState {
  readonly principal: TenantPrincipalState;
  readonly organizations: {
    readonly status: TenantDataStatus;
    readonly items: CommerceOrganizationPage["items"];
    readonly nextCursor: CommerceOrganizationId | null;
    /** True once a next-page read replaced the first bounded page. */
    readonly hasPrevious: boolean;
    readonly failure: TenantFailureKind | null;
  };
  readonly selectedOrganizationId: CommerceOrganizationId | null;
  readonly context: CommerceOrganizationContext | null;
  readonly agents: {
    readonly status: TenantDataStatus;
    readonly items: CommerceAgentPage["items"];
    readonly nextCursor: CommerceAgentPage["nextCursor"];
    /** True once a next-page read replaced the first bounded page. */
    readonly hasPrevious: boolean;
    readonly failure: TenantFailureKind | null;
  };
  readonly providers: {
    readonly status: TenantDataStatus;
    readonly items: CommerceProviderPage["items"];
    readonly nextCursor: CommerceProviderPage["nextCursor"];
    /** True once a next-page read replaced the first bounded page. */
    readonly hasPrevious: boolean;
    readonly failure: TenantFailureKind | null;
  };
  /**
   * True after the page was hidden and protected data was cleared. The UI
   * must offer an explicit refresh and must not claim empty success.
   */
  readonly refreshRequired: boolean;
  readonly busy: boolean;
}

export function initialTenantState(): TenantViewControllerState {
  return {
    principal: { status: "idle", accountId: null, expiresAt: null },
    organizations: { status: "none", items: [], nextCursor: null, hasPrevious: false, failure: null },
    selectedOrganizationId: null,
    context: null,
    agents: { status: "none", items: [], nextCursor: null, hasPrevious: false, failure: null },
    providers: { status: "none", items: [], nextCursor: null, hasPrevious: false, failure: null },
    refreshRequired: false,
    busy: false,
  };
}

export interface TenantControllerDeps {
  /** Injected fetch transport. Defaults to the global fetch. */
  readonly client?: TenantClient;
  /** The accepted account flow controller; never modified here. */
  readonly account: AccountFlowController;
  readonly onState?: (state: TenantViewControllerState) => void;
  /** Injectable clock for bounded expiry scheduling tests. */
  readonly now?: () => number;
}

type Timer = ReturnType<typeof setTimeout>;

export class TenantController {
  #state: TenantViewControllerState = initialTenantState();
  #principalGeneration = 0;
  #organizationGeneration = 0;
  #readGeneration = 0;
  #listAbort: AbortController | null = null;
  #contextAbort: AbortController | null = null;
  #agentsAbort: AbortController | null = null;
  #providersAbort: AbortController | null = null;
  #expiryTimer: Timer | null = null;
  #disposed = false;
  readonly #client: TenantClient;
  readonly #account: AccountFlowController;
  readonly #onState: ((state: TenantViewControllerState) => void) | undefined;
  readonly #now: () => number;

  constructor(deps: TenantControllerDeps) {
    this.#client = deps.client ?? new TenantClient();
    this.#account = deps.account;
    this.#onState = deps.onState;
    this.#now = deps.now ?? (() => Date.now());
  }

  get state(): TenantViewControllerState {
    return this.#state;
  }

  get disposed(): boolean {
    return this.#disposed;
  }

  /**
   * The explicit initial load: read the accepted account session once, then
   * load the first bounded organization page. No child read happens without a
   * user selection.
   */
  async initialize(): Promise<void> {
    if (this.#disposed) return;
    const principalGeneration = this.#principalGeneration;
    this.#set({
      ...this.#state,
      principal: { status: "loading", accountId: null, expiresAt: null },
      refreshRequired: false,
      busy: true,
    });
    try {
      await this.#account.refreshSession();
    } catch {
      if (!this.#stillCurrent(principalGeneration)) return;
      this.#adoptPrincipal(null, null, principalGeneration);
      this.#clearProtected();
      this.#set({ ...this.#state, busy: false });
      return;
    }
    if (!this.#stillCurrent(principalGeneration)) return;
    const session = this.#account.state.session;
    if (!session.signedIn) {
      this.#adoptPrincipal(null, null, principalGeneration);
      this.#clearProtected();
      this.#set({
        ...this.#state,
        principal: { status: "signed-out", accountId: null, expiresAt: null },
        busy: false,
      });
      return;
    }
    this.#adoptPrincipal(session.accountId, session.expiresAt, principalGeneration);
    this.#scheduleExpiry(session.expiresAt);
    await this.loadOrganizations();
  }

  /** Explicit refresh of the account session, then the first organization page. */
  async refreshSession(): Promise<void> {
    if (this.#disposed) return;
    this.#invalidateReads();
    this.#set({ ...this.#state, refreshRequired: false });
    await this.initialize();
  }

  /** Loads (or reloads) the first bounded organization page. */
  async loadOrganizations(): Promise<void> {
    if (this.#disposed) return;
    const principalGeneration = this.#principalGeneration;
    const organizationGeneration = this.#organizationGeneration;
    const readGeneration = this.#readGeneration;
    this.#listAbort?.abort();
    const controller = new AbortController();
    this.#listAbort = controller;
    this.#set({
      ...this.#state,
      organizations: { ...this.#state.organizations, status: "loading", failure: null },
      busy: true,
    });
    try {
      const page = await this.#client.listOrganizations({ limit: PAGE_LIMIT }, controller.signal);
      if (!this.#readStillCurrent(principalGeneration, organizationGeneration, readGeneration)) {
        return;
      }
      this.#set({
        ...this.#state,
        organizations: {
          status: "ready",
          items: page.items,
          nextCursor: page.nextCursor,
          hasPrevious: false,
          failure: null,
        },
        busy: false,
      });
    } catch (error) {
      if (!this.#readStillCurrent(principalGeneration, organizationGeneration, readGeneration)) {
        return;
      }
      this.#handleReadFailure(error, "organizations");
    }
  }

  /**
   * Explicit "next page" read. It replaces the page data (never unbounded
   * accumulation) and only advances the cursor the response actually returned.
   */
  async loadNextOrganizations(): Promise<void> {
    const cursor = this.#state.organizations.nextCursor;
    if (this.#disposed || cursor === null) return;
    const principalGeneration = this.#principalGeneration;
    const organizationGeneration = this.#organizationGeneration;
    const readGeneration = this.#readGeneration;
    this.#listAbort?.abort();
    const controller = new AbortController();
    this.#listAbort = controller;
    this.#set({
      ...this.#state,
      organizations: { ...this.#state.organizations, status: "loading", failure: null },
      busy: true,
    });
    try {
      const page = await this.#client.listOrganizations(
        { afterOrganizationId: cursor, limit: PAGE_LIMIT },
        controller.signal,
      );
      if (!this.#readStillCurrent(principalGeneration, organizationGeneration, readGeneration)) {
        return;
      }
      this.#set({
        ...this.#state,
        organizations: {
          status: "ready",
          items: page.items,
          nextCursor: page.nextCursor,
          hasPrevious: true,
          failure: null,
        },
        busy: false,
      });
    } catch (error) {
      if (!this.#readStillCurrent(principalGeneration, organizationGeneration, readGeneration)) {
        return;
      }
      this.#handleReadFailure(error, "organizations");
    }
  }

  /**
   * Selects an organization. Old context/profiles are cleared BEFORE the
   * request, and the response is checked against the current principal,
   * organization and read generation before any state is published.
   */
  async selectOrganization(organizationId: CommerceOrganizationId): Promise<void> {
    if (this.#disposed) return;
    const principalGeneration = this.#principalGeneration;
    const organizationGeneration = this.#organizationGeneration + 1;
    this.#organizationGeneration = organizationGeneration;
    this.#abortChildren();
    this.#set({
      ...this.#state,
      selectedOrganizationId: organizationId,
      context: null,
      agents: { status: "none", items: [], nextCursor: null, hasPrevious: false, failure: null },
      providers: { status: "none", items: [], nextCursor: null, hasPrevious: false, failure: null },
      busy: true,
    });
    const readGeneration = this.#readGeneration;
    const controller = new AbortController();
    this.#contextAbort = controller;
    try {
      const context = await this.#client.readOrganizationContext(
        { organizationId },
        controller.signal,
      );
      if (
        !this.#stillCurrent(principalGeneration) ||
        organizationGeneration !== this.#organizationGeneration ||
        !this.#readStillCurrent(principalGeneration, organizationGeneration, readGeneration)
      ) {
        return;
      }
      if (context.access.membershipStatus !== "active") {
        // Suspended membership: clear and do not fetch children.
        this.#abortChildren();
        this.#set({
          ...this.#state,
          context: null,
          agents: { status: "none", items: [], nextCursor: null, hasPrevious: false, failure: null },
          providers: { status: "none", items: [], nextCursor: null, hasPrevious: false, failure: null },
          busy: false,
        });
        return;
      }
      this.#set({ ...this.#state, context, busy: false });
    } catch (error) {
      if (
        !this.#stillCurrent(principalGeneration) ||
        organizationGeneration !== this.#organizationGeneration ||
        !this.#readStillCurrent(principalGeneration, organizationGeneration, readGeneration)
      ) {
        return;
      }
      this.#handleReadFailure(error, "context");
    }
  }

  async loadAgents(): Promise<void> {
    await this.#loadProfilePage("agents");
  }

  async loadNextAgents(): Promise<void> {
    await this.#loadProfilePage("agents", true);
  }

  async loadProviders(): Promise<void> {
    await this.#loadProfilePage("providers");
  }

  async loadNextProviders(): Promise<void> {
    await this.#loadProfilePage("providers", true);
  }

  async #loadProfilePage(kind: "agents" | "providers", next = false): Promise<void> {
    if (this.#disposed) return;
    const context = this.#state.context;
    if (context === null || this.#state.selectedOrganizationId === null) return;
    // Controller-side role gate mirrors the accepted read matrix, so a
    // disallowed panel never issues a request regardless of the UI.
    const allowed =
      kind === "agents"
        ? canReadAgents(context.access.role)
        : canReadProviders(context.access.role);
    if (!allowed) return;
    const organizationId = this.#state.selectedOrganizationId;
    const principalGeneration = this.#principalGeneration;
    const organizationGeneration = this.#organizationGeneration;
    const readGeneration = this.#readGeneration;
    const existing = this.#state[kind];
    const cursor =
      next && kind === "agents"
        ? this.#state.agents.nextCursor
        : next && kind === "providers"
          ? this.#state.providers.nextCursor
          : null;
    if (next && cursor === null) return;
    const abort = kind === "agents" ? this.#agentsAbort : this.#providersAbort;
    abort?.abort();
    const controller = new AbortController();
    if (kind === "agents") this.#agentsAbort = controller;
    else this.#providersAbort = controller;
    this.#set({
      ...this.#state,
      [kind]: { ...existing, status: "loading", failure: null },
      busy: true,
    });
    try {
      const page =
        kind === "agents"
          ? await this.#client.listAgents(
              buildAgentRead(organizationId, cursor),
              controller.signal,
            )
          : await this.#client.listProviders(
              buildProviderRead(organizationId, cursor),
              controller.signal,
            );
      if (!this.#readStillCurrent(principalGeneration, organizationGeneration, readGeneration)) {
        return;
      }
      if (kind === "agents") {
        const agentPage = page as CommerceAgentPage;
        this.#set({
          ...this.#state,
          agents: {
            status: "ready",
            items: agentPage.items,
            nextCursor: agentPage.nextCursor,
            hasPrevious: next,
            failure: null,
          },
          busy: false,
        });
      } else {
        const providerPage = page as CommerceProviderPage;
        this.#set({
          ...this.#state,
          providers: {
            status: "ready",
            items: providerPage.items,
            nextCursor: providerPage.nextCursor,
            hasPrevious: next,
            failure: null,
          },
          busy: false,
        });
      }
    } catch (error) {
      if (!this.#readStillCurrent(principalGeneration, organizationGeneration, readGeneration)) {
        return;
      }
      this.#handleReadFailure(error, kind);
    }
  }

  /**
   * The page became hidden. Aborts pending reads, clears protected data and
   * never leaves stale data ready to render. It does not touch the account
   * session or the Vault.
   */
  onHidden(): void {
    this.#invalidateProtected();
    this.#set({ ...this.#state, refreshRequired: true });
  }

  /**
   * Visibility returned. No data is refetched automatically: the cleared
   * state stays cleared and the UI keeps offering the explicit refresh action.
   */
  onVisible(): void {
    // Intentionally no fetch. The user drives recovery via refreshSession().
  }

  /** Route change or unmount: abort reads and clear protected state locally. */
  dispose(): void {
    if (this.#disposed) return;
    this.#readGeneration += 1;
    this.#organizationGeneration += 1;
    this.#listAbort?.abort();
    this.#listAbort = null;
    this.#abortChildren();
    this.#disposed = true;
    this.#state = {
      ...this.#state,
      organizations: { status: "none", items: [], nextCursor: null, hasPrevious: false, failure: null },
      selectedOrganizationId: null,
      context: null,
      agents: { status: "none", items: [], nextCursor: null, hasPrevious: false, failure: null },
      providers: { status: "none", items: [], nextCursor: null, hasPrevious: false, failure: null },
      busy: false,
    };
    this.#onState?.(this.#state);
    if (this.#expiryTimer !== null) {
      clearTimeout(this.#expiryTimer);
      this.#expiryTimer = null;
    }
  }

  #adoptPrincipal(
    accountId: string | null,
    expiresAt: string | null,
    principalGeneration: number,
  ): void {
    if (!this.#stillCurrent(principalGeneration)) return;
    const identity = this.#state.principal.accountId;
    if (identity !== accountId) {
      // A principal change advances the principal generation and invalidates
      // every pending read so a stale result for the previous account can
      // never be applied.
      this.#principalGeneration += 1;
      this.#invalidateReads();
      this.#clearProtected();
    }
    this.#set({
      ...this.#state,
      principal: {
        status: accountId === null ? "signed-out" : "signed-in",
        accountId,
        expiresAt,
      },
    });
  }

  #scheduleExpiry(expiresAt: string | null): void {
    if (this.#expiryTimer !== null) {
      clearTimeout(this.#expiryTimer);
      this.#expiryTimer = null;
    }
    if (expiresAt === null) return;
    const deadline = Date.parse(expiresAt);
    if (!Number.isFinite(deadline)) return;
    const delay = deadline - this.#now();
    if (delay <= 0) {
      this.#expireLocally();
      return;
    }
    // A bounded delay so a suspicious server timestamp cannot schedule an
    // unbounded timer. Browsers cap the delay anyway; the local expiry only
    // clears UI and never authorizes server data.
    this.#expiryTimer = setTimeout(() => this.#expireLocally(), Math.min(delay, 2_147_483_647));
  }

  #expireLocally(): void {
    if (this.#disposed) return;
    this.#invalidateProtected();
    this.#set({
      ...this.#state,
      principal: { status: "expired", accountId: null, expiresAt: null },
      busy: false,
    });
  }

  #handleReadFailure(error: unknown, section: "organizations" | "context" | "agents" | "providers"): void {
    const failure = error instanceof TenantApiError ? error.failure.kind : "unavailable";
    if (failure === "aborted") return;
    if (failure === "unauthenticated") {
      this.#invalidateProtected();
      this.#set({
        ...this.#state,
        principal: { status: "signed-out", accountId: null, expiresAt: null },
        busy: false,
      });
      return;
    }
    if (failure === "forbidden") {
      // Clear the selected tenant/context/profiles and require an explicit
      // reselect, but keep the organization list so a choice is still
      // possible.
      this.#organizationGeneration += 1;
      this.#abortChildren();
      this.#set({
        ...this.#state,
        selectedOrganizationId: null,
        context: null,
        agents: { status: "none", items: [], nextCursor: null, hasPrevious: false, failure: null },
        providers: { status: "none", items: [], nextCursor: null, hasPrevious: false, failure: null },
        busy: false,
      });
      return;
    }
    if (section === "organizations") {
      this.#set({
        ...this.#state,
        organizations: {
          status: "error",
          items: [],
          nextCursor: null,
          hasPrevious: false,
          failure,
        },
        busy: false,
      });
      return;
    }
    if (section === "context") {
      this.#set({
        ...this.#state,
        context: null,
        selectedOrganizationId: null,
        agents: { status: "none", items: [], nextCursor: null, hasPrevious: false, failure: null },
        providers: { status: "none", items: [], nextCursor: null, hasPrevious: false, failure: null },
        busy: false,
      });
      return;
    }
    this.#set({
      ...this.#state,
      [section]: { status: "error", items: [], nextCursor: null, hasPrevious: false, failure },
      busy: false,
    });
  }

  #invalidateProtected(): void {
    this.#invalidateReads();
    this.#clearProtected();
    this.#set({ ...this.#state, busy: false });
  }

  /** Aborts every pending read and bumps every generation. */
  #invalidateReads(): void {
    this.#readGeneration += 1;
    this.#organizationGeneration += 1;
    this.#listAbort?.abort();
    this.#listAbort = null;
    this.#abortChildren();
  }

  #abortChildren(): void {
    this.#contextAbort?.abort();
    this.#contextAbort = null;
    this.#agentsAbort?.abort();
    this.#agentsAbort = null;
    this.#providersAbort?.abort();
    this.#providersAbort = null;
  }

  #clearProtected(): void {
    this.#set({
      ...this.#state,
      organizations: { status: "none", items: [], nextCursor: null, hasPrevious: false, failure: null },
      selectedOrganizationId: null,
      context: null,
      agents: { status: "none", items: [], nextCursor: null, hasPrevious: false, failure: null },
      providers: { status: "none", items: [], nextCursor: null, hasPrevious: false, failure: null },
    });
  }

  #stillCurrent(principalGeneration: number): boolean {
    return !this.#disposed && principalGeneration === this.#principalGeneration;
  }

  #readStillCurrent(
    principalGeneration: number,
    organizationGeneration: number,
    readGeneration: number,
  ): boolean {
    return (
      !this.#disposed &&
      principalGeneration === this.#principalGeneration &&
      organizationGeneration === this.#organizationGeneration &&
      readGeneration === this.#readGeneration
    );
  }

  #set(next: TenantViewControllerState): void {
    if (this.#disposed) return;
    this.#state = next;
    this.#onState?.(next);
  }
}

function buildAgentRead(
  organizationId: CommerceOrganizationId,
  cursor: CommerceAgentPage["nextCursor"],
) {
  if (cursor !== null && !CommerceAgentIdSchema.safeParse(cursor).success) {
    throw new TenantApiError({ kind: "invalid-response" });
  }
  return {
    organizationId,
    ...(cursor === null ? {} : { afterAgentId: cursor }),
    limit: PAGE_LIMIT,
  };
}

function buildProviderRead(
  organizationId: CommerceOrganizationId,
  cursor: CommerceProviderPage["nextCursor"],
) {
  if (cursor !== null && !CommerceProviderIdSchema.safeParse(cursor).success) {
    throw new TenantApiError({ kind: "invalid-response" });
  }
  return {
    organizationId,
    ...(cursor === null ? {} : { afterProviderId: cursor }),
    limit: PAGE_LIMIT,
  };
}

/**
 * Confirms the context belongs to the expected account before any profile
 * read. Returns false for a guest/expired session or a mismatched account.
 */
export function contextMatchesAccount(
  context: CommerceOrganizationContext,
  accountId: string | null,
): boolean {
  if (accountId === null) return false;
  return contextAccountId(context) === accountId;
}

/**
 * Accepted agent-read matrix: owner, operator and viewer may read the agent
 * list. provider_admin and provider_developer may not read agents or providers.
 */
export function canReadAgents(role: string): boolean {
  return role === "owner" || role === "operator" || role === "viewer";
}

/** Accepted provider-read matrix: owner only. */
export function canReadProviders(role: string): boolean {
  return role === "owner";
}

export type { AccountSessionView };
