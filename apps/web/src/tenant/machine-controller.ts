import {
  CommerceMachineCredentialIdSchema,
  CommerceMachineKindSchema,
  type CommerceMachineCredentialMetadata,
  type CommerceMachineCredentialPage,
  type CommerceMachineCredentialStatus,
  type CommerceMachineKind,
  type CommerceMachineMutationReceipt,
} from "@openarc/shared";

import type { AccountBoundToken, AccountFlowController } from "../account/flow-controller.js";
import {
  MachineApiError,
  MachineClient,
  createMachineCorrelation,
  type MachineApiFailure,
  type MachineCredentialCorrelation,
} from "./machine-client.js";

/**
 * Coordinates the credential-management console around the accepted account
 * flow and read controllers.
 *
 * The controller owns one logical credential action at a time. A logical
 * mutation id, key, operation and target are frozen while a request is pending
 * so no automatic retry can mint a new id or key. Unknown outcomes are never
 * rolled back or resubmitted: the only recovery is an explicit status GET with
 * the original mutation id. All drafts, receipts and the raw credential are
 * memory only: nothing is written to storage, the URL, history, a download or a
 * log, and the wallet is untouched. The raw credential is held in exactly one
 * place (`revealedCredential`) and is cleared by `dismissCredential` or any
 * invalidation. Once cleared it cannot be re-revealed.
 */

/** The narrow coordination surface the credential flow needs from reads. */
export interface MachineReadCoordinator {
  currentOrganizationId(): string | null;
  currentRole(): string | null;
  currentAccountId(): string | null;
  /** Aborts pending reads and bumps their generations without clearing data. */
  abortPendingReads(): void;
  /** Reloads only the bounded page relevant to the committed resource. */
  reloadAfterCommit(kind: CommerceMachineKind): Promise<void>;
}

export type MachineCredentialTarget = {
  readonly kind: CommerceMachineKind;
  readonly profileId: string;
};

export type MachineIssueDraft = {
  readonly op: "issue";
  readonly kind: CommerceMachineKind;
  readonly profileId: string;
  readonly expiresAt: string;
};

export type MachineRevokeDraft = {
  readonly op: "revoke";
  readonly kind: CommerceMachineKind;
  readonly credentialId: string;
};

export type MachineCredentialDraft = MachineIssueDraft | MachineRevokeDraft;

export type MachineFailureNotice =
  | { readonly kind: "validation" }
  | { readonly kind: "policy" }
  | { readonly kind: "conflict" }
  | { readonly kind: "unauthenticated" }
  | { readonly kind: "csrf" }
  | { readonly kind: "account-changed" }
  | { readonly kind: "recovery-blocked" }
  | { readonly kind: "inactive-profile" };

/**
 * The credential receipt plus the one-time raw delivery. The raw credential is
 * present ONLY on a fresh, committed first response; it is never reconstructed
 * from a replay, a status, a list or a refresh.
 */
export interface MachineCommittedReceipt {
  readonly receipt: CommerceMachineMutationReceipt;
  readonly replayed: boolean;
  /**
   * The one-time raw credential for a fresh issue. `null` means the secret is
   * not (or is no longer) available; it can never be re-populated.
   */
  readonly availableOnce: string | null;
  /** The public prefix that correlates the raw credential to the receipt. */
  readonly publicPrefix: string | null;
}

export type MachineConsoleState =
  | { readonly kind: "idle" }
  | {
      readonly kind: "confirming";
      readonly draft: MachineCredentialDraft;
      readonly warning: string | null;
    }
  | {
      readonly kind: "pending";
      readonly draft: MachineCredentialDraft;
      readonly mutationId: string;
    }
  | {
      readonly kind: "committed";
      readonly committed: MachineCommittedReceipt;
    }
  | {
      readonly kind: "rejected";
      readonly notice: MachineFailureNotice;
    }
  | {
      readonly kind: "outcome-unknown";
      readonly mutationId: string;
      readonly organizationId: string;
      readonly kindOfMutation: CommerceMachineKind;
      readonly checking: boolean;
      readonly statusMessage: string | null;
    };

export function initialMachineConsoleState(): MachineConsoleState {
  return { kind: "idle" };
}

export type MachineCredentialListStatus = "none" | "loading" | "ready" | "error";

export interface MachineCredentialListState {
  readonly target: MachineCredentialTarget | null;
  readonly status: MachineCredentialListStatus;
  readonly items: readonly CommerceMachineCredentialMetadata[];
  readonly nextCursor: string | null;
  readonly hasPrevious: boolean;
}

export function initialMachineCredentialListState(): MachineCredentialListState {
  return { target: null, status: "none", items: [], nextCursor: null, hasPrevious: false };
}

export interface MachineControllerDeps {
  readonly client?: MachineClient;
  readonly account: AccountFlowController;
  readonly reads: MachineReadCoordinator;
  /**
   * Reports whether the addressed selected profile is active. A credential
   * issue is refused for an inactive profile; revoke is always allowed.
   * Defaults to "active" so a caller without profile metadata is not blocked.
   */
  readonly isProfileActive?: (kind: CommerceMachineKind, profileId: string) => boolean;
  readonly onState?: (state: MachineConsoleState) => void;
  readonly onListState?: (state: MachineCredentialListState) => void;
}

interface FrozenSubmission {
  readonly draft: MachineCredentialDraft;
  readonly correlation: MachineCredentialCorrelation;
  readonly organizationId: string;
  readonly kind: CommerceMachineKind;
}

export class MachineCredentialController {
  #state: MachineConsoleState = initialMachineConsoleState();
  #listState: MachineCredentialListState = initialMachineCredentialListState();
  #generation = 0;
  #disposed = false;
  #frozen: FrozenSubmission | null = null;
  #statusAbort: AbortController | null = null;
  #listAbort: AbortController | null = null;
  #listGeneration = 0;
  /**
   * The one and only location that holds a raw credential. Cleared on every
   * identity/context invalidation and by `dismissCredential`, and never written
   * anywhere else.
   */
  #revealedCredential: string | null = null;
  /**
   * The permission role the displayed state was bound to. A role change must
   * invalidate the console even when the selected profile is unchanged, so an
   * owner->viewer->owner round trip can never re-show a previous secret,
   * receipt or list page.
   */
  #boundRole: string | null = null;
  readonly #client: MachineClient;
  readonly #account: AccountFlowController;
  readonly #reads: MachineReadCoordinator;
  readonly #isProfileActive: ((kind: CommerceMachineKind, profileId: string) => boolean) | undefined;
  readonly #onState: ((state: MachineConsoleState) => void) | undefined;
  readonly #onListState: ((state: MachineCredentialListState) => void) | undefined;

  constructor(deps: MachineControllerDeps) {
    this.#client = deps.client ?? new MachineClient();
    this.#account = deps.account;
    this.#reads = deps.reads;
    this.#isProfileActive = deps.isProfileActive;
    this.#onState = deps.onState;
    this.#onListState = deps.onListState;
  }

  get state(): MachineConsoleState {
    return this.#state;
  }

  get credentialList(): MachineCredentialListState {
    return this.#listState;
  }

  get disposed(): boolean {
    return this.#disposed;
  }

  /**
   * The single raw credential, or null when it is not available. Reading does
   * not reveal it a second time: a replay/status/list can never populate it.
   */
  get revealedCredential(): string | null {
    return this.#revealedCredential;
  }

  /**
   * Binds the console to ONE explicitly selected profile. Selecting a different
   * profile clears any in-flight list, displayed list, receipt and secret for
   * the previous profile; it never auto-selects a first profile.
   */
  select(target: MachineCredentialTarget | null): void {
    if (this.#disposed) return;
    // A same-profile reselect still has to observe an authoritative role change.
    this.#reconcileRole(this.#reads.currentRole());
    if (target === null) {
      this.resetListState();
      return;
    }
    const current = this.#listState.target;
    if (current !== null && current.kind === target.kind && current.profileId === target.profileId) {
      return;
    }
    this.resetListState();
    this.#listGeneration += 1;
    this.#listAbort?.abort();
    this.#listAbort = null;
    this.#clearSecret();
    this.#generation += 1;
    this.#frozen = null;
    this.#statusAbort?.abort();
    this.#statusAbort = null;
    this.#set({ kind: "idle" });
    this.#setList({ target, status: "none", items: [], nextCursor: null, hasPrevious: false });
  }

  /**
   * Reconciles the authoritative role for the current context. A change in the
   * role (for example owner -> viewer -> owner) invalidates every local
   * credential artifact even when the selected profile is byte-identical, so a
   * transition can never resurrect a secret or receipt. The synchronous render
   * guard in the parent suppresses the transition frame; this clears the
   * controller so the stale state cannot return once the guard releases.
   */
  reconcileRole(role: string | null): void {
    if (this.#disposed) return;
    this.#reconcileRole(role);
  }

  #reconcileRole(role: string | null): void {
    if (this.#boundRole === role) return;
    this.#boundRole = role;
    this.clear();
  }

  /** Loads (or reloads) the first bounded page for the current selection. */
  async loadCredentials(): Promise<void> {
    await this.#loadCredentialPage(false);
  }

  /** Explicit next page; replaces the page, never accumulates. */
  async loadNextCredentials(): Promise<void> {
    await this.#loadCredentialPage(true);
  }

  async #loadCredentialPage(next: boolean): Promise<void> {
    if (this.#disposed) return;
    const target = this.#listState.target;
    const organizationId = this.#reads.currentOrganizationId();
    if (target === null || organizationId === null) return;
    const cursor = next ? this.#listState.nextCursor : null;
    if (next && cursor === null) return;
    const generation = this.#listGeneration;
    const accountGeneration = this.#account.generation;
    this.#listAbort?.abort();
    const controller = new AbortController();
    this.#listAbort = controller;
    this.#setList({ ...this.#listState, status: "loading" });
    let page: CommerceMachineCredentialPage;
    try {
      page =
        target.kind === "agent"
          ? await this.#client.listAgentCredentials(
              {
                organizationId,
                agentId: target.profileId,
                ...(cursor === null ? {} : { afterCredentialId: cursor }),
              },
              controller.signal,
            )
          : await this.#client.listProviderCredentials(
              {
                organizationId,
                providerId: target.profileId,
                ...(cursor === null ? {} : { afterCredentialId: cursor }),
              },
              controller.signal,
            );
    } catch {
      if (!this.#listStillCurrent(generation, accountGeneration, target, organizationId)) return;
      this.#setList({ ...this.#listState, status: "error", items: [], nextCursor: null });
      return;
    }
    if (!this.#listStillCurrent(generation, accountGeneration, target, organizationId)) return;
    this.#setList({
      target,
      status: "ready",
      items: page.items,
      nextCursor: page.nextCursor,
      hasPrevious: next,
    });
  }

  #listStillCurrent(
    generation: number,
    accountGeneration: number,
    target: MachineCredentialTarget,
    organizationId: string,
  ): boolean {
    if (this.#disposed) return false;
    if (generation !== this.#listGeneration) return false;
    if (accountGeneration !== this.#account.generation) return false;
    const current = this.#listState.target;
    if (current === null) return false;
    if (current.kind !== target.kind || current.profileId !== target.profileId) return false;
    if (this.#reads.currentOrganizationId() !== organizationId) return false;
    return true;
  }

  /** Clears the credential list binding and any pending list read. */
  resetListState(): void {
    if (this.#disposed) return;
    this.#listGeneration += 1;
    this.#listAbort?.abort();
    this.#listAbort = null;
    this.#setList(initialMachineCredentialListState());
  }

  /**
   * Validates a draft and enters the explicit confirmation stage. No request is
   * sent and no key is generated here.
   */
  begin(draft: MachineCredentialDraft): boolean {
    if (this.#disposed) return false;
    // A fresh, unrecoverable secret is on screen. Starting another issue would
    // overwrite it, so the controller refuses until the user explicitly
    // dismisses the current one. The secret is preserved, not destroyed.
    if (
      draft.op === "issue" &&
      this.#state.kind === "committed" &&
      this.#state.committed.availableOnce !== null
    ) {
      return false;
    }
    const checked = validateDraft(
      draft,
      this.#reads.currentOrganizationId(),
      this.#reads.currentRole(),
      this.#account.state.session.signedIn === true,
    );
    if (!checked.ok) return false;
    if (
      checked.draft.op === "issue" &&
      this.#isProfileActive !== undefined &&
      !this.#isProfileActive(checked.draft.kind, checked.draft.profileId)
    ) {
      this.#frozen = null;
      this.#clearSecret();
      this.#set({ kind: "rejected", notice: { kind: "inactive-profile" } });
      return false;
    }
    if (
      draft.op === "issue" &&
      this.#account.state.session.signedIn &&
      this.#account.state.session.method === "recovery"
    ) {
      this.#frozen = null;
      this.#set({ kind: "rejected", notice: { kind: "recovery-blocked" } });
      return false;
    }
    this.#generation += 1;
    this.#frozen = null;
    this.#clearSecret();
    this.#set({
      kind: "confirming",
      draft: checked.draft,
      warning: confirmationWarning(checked.draft),
    });
    return true;
  }

  /** Cancels the confirmation or an idle flow without sending anything. */
  cancel(): void {
    if (this.#disposed) return;
    if (this.#state.kind === "pending") return;
    this.#generation += 1;
    this.#frozen = null;
    this.#clearSecret();
    this.#set({ kind: "idle" });
  }

  /**
   * Sends exactly one confirmed logical action. The mutation id, key, operation
   * and target are frozen for the lifetime of the request.
   */
  async confirm(): Promise<void> {
    if (this.#disposed) return;
    if (this.#state.kind !== "confirming") return;
    const draft = this.#state.draft;
    const organizationId = this.#reads.currentOrganizationId();
    if (organizationId === null) return;
    const correlation = createMachineCorrelation();
    const generation = this.#generation;
    this.#frozen = { draft, correlation, organizationId, kind: draft.kind };
    this.#set({ kind: "pending", draft, mutationId: correlation.mutationId });
    this.#reads.abortPendingReads();
    const accountBound: AccountBoundToken = this.#account.captureAccountBound();
    let result: MachineCommittedReceipt;
    try {
      result = await this.#account.mutate(
        async ({ csrfToken, signal }) =>
          runMachineAction(this.#client, {
            draft,
            correlation,
            organizationId,
            csrfToken,
            signal,
          }),
        { accountBound },
      );
    } catch (error) {
      if (!this.#stillCurrent(generation)) return;
      this.#handleConfirmFailure(error, draft, correlation);
      return;
    }
    if (!this.#stillCurrent(generation)) return;
    this.#frozen = null;
    if (result.availableOnce !== null) {
      this.#revealedCredential = result.availableOnce;
    }
    this.#set({ kind: "committed", committed: result });
    // A confirmed commit is final even when the FOLLOW-UP read/session refresh
    // fails. Refresh is handled separately and can never demote a commit to
    // unknown or imply an optimistic rollback.
    await this.#refreshAfterCommit(draft, generation);
  }

  #handleConfirmFailure(
    error: unknown,
    draft: MachineCredentialDraft,
    correlation: MachineCredentialCorrelation,
  ): void {
    const failure = failureOf(error);
    if (failure.kind === "unauthorized" || failure.kind === "csrf") {
      this.#frozen = null;
      this.#clearSecret();
      this.#set({
        kind: "rejected",
        notice: failure.kind === "csrf" ? { kind: "csrf" } : { kind: "unauthenticated" },
      });
      return;
    }
    if (failure.kind === "account-changed") {
      this.#frozen = null;
      this.#clearSecret();
      this.#set({ kind: "rejected", notice: { kind: "account-changed" } });
      return;
    }
    if (failure.kind === "known-rejected") {
      this.#frozen = null;
      this.#clearSecret();
      this.#set({ kind: "rejected", notice: { kind: failure.reason } });
      return;
    }
    if (failure.kind === "aborted") {
      this.#frozen = null;
      this.#set({ kind: "idle" });
      return;
    }
    // Any other sent-but-unconfirmed outcome may have committed. Keep the
    // frozen id and offer only an explicit status check.
    this.#set({
      kind: "outcome-unknown",
      mutationId: correlation.mutationId,
      organizationId: this.#frozen?.organizationId ?? "",
      kindOfMutation: draft.kind,
      checking: false,
      statusMessage: null,
    });
  }

  async #refreshAfterCommit(draft: MachineCredentialDraft, generation: number): Promise<void> {
    try {
      await this.#reads.reloadAfterCommit(draft.kind);
    } catch {
      // A read failure after a confirmed commit is not a write failure.
    }
    if (!this.#stillCurrent(generation)) return;
    // A committed credential action reloads the list for the selected profile
    // when one is bound. A refresh failure never demotes the commit.
    if (this.#listState.target !== null) {
      try {
        await this.#loadCredentialPage(false);
      } catch {
        // The confirmed receipt stands.
      }
    }
  }

  /**
   * Explicit safe GET. A committed status clears the draft and reloads the
   * relevant bounded page; `not_found` never proves the original is dead.
   */
  async checkStatus(): Promise<void> {
    if (this.#disposed || this.#state.kind !== "outcome-unknown") return;
    const { mutationId, organizationId, kindOfMutation } = this.#state;
    const generation = this.#generation;
    this.#statusAbort?.abort();
    const controller = new AbortController();
    this.#statusAbort = controller;
    this.#set({ ...this.#state, checking: true, statusMessage: null });
    let status: CommerceMachineCredentialStatus;
    try {
      status = await this.#client.readCredentialStatus({
        organizationId,
        kind: kindOfMutation,
        mutationId,
        signal: controller.signal,
      });
    } catch {
      if (!this.#stillCurrent(generation) || this.#state.kind !== "outcome-unknown") return;
      this.#set({
        ...this.#state,
        checking: false,
        statusMessage: "No committed result found yet; it may still complete. Check again.",
      });
      return;
    }
    if (!this.#stillCurrent(generation) || this.#state.kind !== "outcome-unknown") return;
    if (status.status === "committed") {
      this.#frozen = null;
      // A committed status NEVER recovers the raw credential.
      this.#set({
        kind: "committed",
        committed: {
          receipt: status.receipt,
          replayed: true,
          availableOnce: null,
          publicPrefix: null,
        },
      });
      try {
        await this.#reads.reloadAfterCommit(receiptOperationKind(status.receipt));
      } catch {
        // The confirmed receipt stands.
      }
      return;
    }
    // not_found does NOT prove an in-flight original will never commit.
    this.#set({
      ...this.#state,
      checking: false,
      statusMessage: "No committed result found yet; it may still complete. Check again.",
    });
  }

  /** Removes the one-time raw credential so it cannot be re-revealed. */
  dismissCredential(): void {
    if (this.#disposed) return;
    this.#clearSecret();
    if (this.#state.kind === "committed") {
      this.#set({
        kind: "committed",
        committed: { ...this.#state.committed, availableOnce: null, publicPrefix: null },
      });
    }
  }

  /** Account/session change, logout, hidden or navigation: clear everything local. */
  clear(): void {
    if (this.#disposed) return;
    this.#generation += 1;
    this.#frozen = null;
    this.#statusAbort?.abort();
    this.#statusAbort = null;
    this.#listGeneration += 1;
    this.#listAbort?.abort();
    this.#listAbort = null;
    this.#clearSecret();
    this.#set({ kind: "idle" });
    this.#setList(initialMachineCredentialListState());
  }

  /**
   * Organization/profile change: clear any in-flight or displayed credential
   * state for the previous context.
   */
  clearForContextChange(): void {
    this.clear();
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#generation += 1;
    this.#frozen = null;
    this.#statusAbort?.abort();
    this.#statusAbort = null;
    this.#listGeneration += 1;
    this.#listAbort?.abort();
    this.#listAbort = null;
    this.#clearSecret();
    this.#disposed = true;
    this.#state = { kind: "idle" };
    this.#listState = initialMachineCredentialListState();
    this.#onState?.(this.#state);
    this.#onListState?.(this.#listState);
  }

  #clearSecret(): void {
    this.#revealedCredential = null;
  }

  #stillCurrent(generation: number): boolean {
    return !this.#disposed && generation === this.#generation;
  }

  #set(next: MachineConsoleState): void {
    if (this.#disposed) return;
    this.#state = next;
    this.#onState?.(next);
  }

  #setList(next: MachineCredentialListState): void {
    if (this.#disposed) return;
    this.#listState = next;
    this.#onListState?.(next);
  }
}

// The status receipt union has no operation-kind helper; add a local one.
function receiptOperationKind(receipt: CommerceMachineMutationReceipt): CommerceMachineKind {
  return receipt.operation.includes(".provider.") ? "provider" : "agent";
}

interface RunActionInput {
  readonly draft: MachineCredentialDraft;
  readonly correlation: MachineCredentialCorrelation;
  readonly organizationId: string;
  readonly csrfToken: string;
  readonly signal: AbortSignal;
}

async function runMachineAction(
  client: MachineClient,
  input: RunActionInput,
): Promise<MachineCommittedReceipt> {
  const { draft, correlation, organizationId, csrfToken, signal } = input;
  const common = { csrfToken, idempotencyKey: correlation.idempotencyKey, signal };
  if (draft.op === "issue") {
    const body = { mutationId: correlation.mutationId, expiresAt: draft.expiresAt };
    const result =
      draft.kind === "agent"
        ? await client.issueAgentCredential({
            organizationId,
            agentId: draft.profileId,
            body,
            ...common,
          })
        : await client.issueProviderCredential({
            organizationId,
            providerId: draft.profileId,
            body,
            ...common,
          });
    const token = result.delivery.status === "available_once" ? result.delivery.credential : null;
    const prefix = result.delivery.status === "available_once" ? result.delivery.publicPrefix : null;
    return {
      receipt: result.receipt,
      replayed: result.replayed,
      availableOnce: token,
      publicPrefix: prefix,
    };
  }
  const body = { mutationId: correlation.mutationId };
  const result =
    draft.kind === "agent"
      ? await client.revokeAgentCredential({
          organizationId,
          credentialId: draft.credentialId,
          body,
          ...common,
        })
      : await client.revokeProviderCredential({
          organizationId,
          credentialId: draft.credentialId,
          body,
          ...common,
        });
  return {
    receipt: result.receipt,
    replayed: result.replayed,
    availableOnce: null,
    publicPrefix: null,
  };
}

function confirmationWarning(draft: MachineCredentialDraft): string | null {
  if (draft.op === "issue") {
    return "The new credential will be shown once. OpenArc cannot retrieve it later; save it securely before dismissing.";
  }
  return "Revoking a credential is immediate and cannot be undone. Any machine using it will lose access.";
}

type DraftCheck =
  | { readonly ok: true; readonly draft: MachineCredentialDraft }
  | { readonly ok: false };

/**
 * Strict local draft validation. A credential action always requires a selected
 * organization and the accepted role. Agent credentials require owner/operator;
 * provider credentials require owner. An inactive (suspended) profile cannot
 * issue, but may revoke.
 */
function validateDraft(
  draft: MachineCredentialDraft,
  currentOrganizationId: string | null,
  currentRole: string | null,
  signedIn: boolean,
): DraftCheck {
  if (!signedIn) return { ok: false };
  if (currentOrganizationId === null || currentRole === null) return { ok: false };
  if (!CommerceMachineKindSchema.safeParse(draft.kind).success) return { ok: false };
  if (draft.kind === "agent") {
    if (currentRole !== "owner" && currentRole !== "operator") return { ok: false };
  } else if (currentRole !== "owner") {
    return { ok: false };
  }
  if (draft.op === "issue") {
    if (!validExpiry(draft.expiresAt)) return { ok: false };
  } else if (!CommerceMachineCredentialIdSchema.safeParse(draft.credentialId).success) {
    return { ok: false };
  }
  return { ok: true, draft };
}

/** Bound 1..90 days from now; server remains authoritative on the clock. */
export const MACHINE_MIN_EXPIRY_DAYS = 1;
export const MACHINE_MAX_EXPIRY_DAYS = 90;

export function validExpiry(expiresAt: string): boolean {
  const parsed = Date.parse(expiresAt);
  if (!Number.isFinite(parsed)) return false;
  const now = Date.now();
  const delta = parsed - now;
  const day = 24 * 60 * 60 * 1000;
  return delta > 0 && delta <= MACHINE_MAX_EXPIRY_DAYS * day;
}

/**
 * Builds the exact valid credential scope description for a kind. The server
 * remains authoritative; this is display-only review text.
 */
export function scopeLabel(kind: CommerceMachineKind): string {
  return kind === "agent" ? "agent:self.read" : "provider:self.read";
}

type FailureResult =
  | { readonly kind: "known-rejected"; readonly reason: "validation" | "policy" | "conflict" }
  | { readonly kind: "unauthorized" }
  | { readonly kind: "csrf" }
  | { readonly kind: "account-changed" }
  | { readonly kind: "aborted" }
  | { readonly kind: "unknown" };

function failureOf(error: unknown): FailureResult {
  if (error instanceof MachineApiError) return mapMachineFailure(error.failure);
  const kind = readFailureKind(error);
  if (kind === "account-changed") return { kind: "account-changed" };
  if (kind === "aborted") return { kind: "aborted" };
  return { kind: "unknown" };
}

function readFailureKind(error: unknown): string | null {
  if (typeof error !== "object" || error === null) return null;
  const failure = (error as { failure?: unknown }).failure;
  if (typeof failure !== "object" || failure === null) return null;
  const kind = (failure as { kind?: unknown }).kind;
  return typeof kind === "string" ? kind : null;
}

function mapMachineFailure(failure: MachineApiFailure): FailureResult {
  switch (failure.kind) {
    case "validation":
      return { kind: "known-rejected", reason: "validation" };
    case "policy":
      return { kind: "known-rejected", reason: "policy" };
    case "conflict":
      return { kind: "known-rejected", reason: "conflict" };
    case "unauthenticated":
      return { kind: "unauthorized" };
    case "csrf":
      return { kind: "csrf" };
    case "aborted":
      return { kind: "aborted" };
    case "pre-send":
      return { kind: "unknown" };
    default:
      return { kind: "unknown" };
  }
}

export type { AccountFlowController, CommerceMachineCredentialMetadata, CommerceMachineCredentialPage };

/**
 * Synchronous render-boundary guard.
 *
 * React effects run AFTER render, so an account/organization/role transition
 * would otherwise paint one frame of the previous context's credential state
 * (receipt, one-time secret, list) to the new context. A parent computes this
 * during render and passes `null` for the controller/subtree when the current
 * render context does not match the context the state was bound to.
 *
 * `bound` is the context the current render-held credential state belongs to
 * (`null` before any context has been bound). `current` is the context for the
 * render being computed. A mismatch suppresses synchronously.
 */
export interface MachineRenderContext {
  readonly accountId: string | null;
  readonly organizationId: string | null;
  readonly role: string | null;
  readonly kind: CommerceMachineKind | null;
  readonly profileId: string | null;
}

export function suppressStaleMachineContext(
  bound: MachineRenderContext | null,
  current: MachineRenderContext,
): boolean {
  if (bound === null) return false;
  if (current.accountId === null || current.organizationId === null) return true;
  return (
    bound.accountId !== current.accountId ||
    bound.organizationId !== current.organizationId ||
    bound.role !== current.role ||
    bound.kind !== current.kind ||
    bound.profileId !== current.profileId
  );
}
