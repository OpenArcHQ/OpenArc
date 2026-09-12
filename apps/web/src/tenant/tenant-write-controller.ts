import {
  CommerceAccountIdSchema,
  CommerceHumanRoleSchema,
  type CommerceHumanRole,
  type CommerceTenantMutationReceipt,
  type CommerceTenantMutationResult,
} from "@openarc/shared";

import type { AccountFlowController, AccountBoundToken } from "../account/flow-controller.js";
import {
  TenantWriteApiError,
  TenantWriteClient,
  createMutationCorrelation,
  type TenantMutationCorrelation,
  type TenantWriteFailure,
} from "./tenant-write-client.js";

/**
 * Coordinates the bounded tenant mutation panel around the accepted account
 * and read controllers.
 *
 * The controller owns one logical submit at a time. A logical id, key, body
 * and operation are frozen while a request is pending so no automatic retry
 * can mint a new id or key. Unknown outcomes are never rolled back or
 * resubmitted: the only recovery is an explicit status GET with the original
 * mutation id. All draft/protected mutation state is memory only: nothing is
 * written to storage, the URL, history or a log, and the wallet is untouched.
 */

/** The narrow coordination surface the mutation flow needs from reads. */
export interface TenantReadCoordinator {
  currentOrganizationId(): string | null;
  currentRole(): CommerceHumanRole | null;
  /** Aborts pending reads and bumps their generations without clearing data. */
  abortPendingReads(): void;
  /** Aborts reads and clears all protected read data (account change). */
  clearForAccountChange(): void;
  /** Reloads only the bounded page relevant to the committed resource. */
  reloadAfterCommit(section: TenantMutationSection): Promise<void>;
}

export type TenantMutationSection =
  | "organizations"
  | "context"
  | "agents"
  | "providers"
  | "membership";

export type TenantMutationDraft =
  | { readonly op: "tenant.organization.create"; readonly displayName: string }
  | {
      readonly op: "tenant.agent.create";
      readonly organizationId: string;
      readonly displayName: string;
    }
  | {
      readonly op: "tenant.agent.update";
      readonly organizationId: string;
      readonly agentId: string;
      readonly displayName?: string;
      readonly status?: "active" | "suspended" | "revoked";
    }
  | {
      readonly op: "tenant.provider.create";
      readonly organizationId: string;
      readonly displayName: string;
    }
  | {
      readonly op: "tenant.provider.update";
      readonly organizationId: string;
      readonly providerId: string;
      readonly displayName?: string;
      readonly status?: "active" | "suspended" | "retired";
    }
  | {
      readonly op: "tenant.membership.set";
      readonly organizationId: string;
      readonly accountId: string;
      readonly role: CommerceHumanRole;
      readonly membershipStatus: "active" | "suspended";
    };

export type TenantMutationFailureNotice =
  | { readonly kind: "validation" }
  | { readonly kind: "policy" }
  | { readonly kind: "conflict" }
  | { readonly kind: "unauthenticated" }
  | { readonly kind: "csrf" }
  | { readonly kind: "account-changed" }
  | { readonly kind: "recovery-blocked" };

export type TenantMutationState =
  | { readonly kind: "idle" }
  | {
      readonly kind: "confirming";
      readonly draft: TenantMutationDraft;
      readonly warning: string | null;
    }
  | {
      readonly kind: "pending";
      readonly draft: TenantMutationDraft;
      readonly mutationId: string;
    }
  | {
      readonly kind: "committed";
      readonly receipt: CommerceTenantMutationReceipt;
      readonly replayed: boolean;
    }
  | {
      readonly kind: "rejected";
      readonly notice: TenantMutationFailureNotice;
    }
  | {
      readonly kind: "outcome-unknown";
      readonly mutationId: string;
      readonly organizationId: string | null;
      readonly checking: boolean;
      readonly statusMessage: string | null;
    };

export function initialTenantMutationState(): TenantMutationState {
  return { kind: "idle" };
}

export interface TenantWriteControllerDeps {
  readonly client?: TenantWriteClient;
  readonly account: AccountFlowController;
  readonly reads: TenantReadCoordinator;
  readonly onState?: (state: TenantMutationState) => void;
}

interface FrozenSubmission {
  readonly draft: TenantMutationDraft;
  readonly correlation: TenantMutationCorrelation;
  readonly organizationId: string | null;
}

export class TenantWriteController {
  #state: TenantMutationState = initialTenantMutationState();
  #generation = 0;
  #disposed = false;
  #frozen: FrozenSubmission | null = null;
  #statusAbort: AbortController | null = null;
  readonly #client: TenantWriteClient;
  readonly #account: AccountFlowController;
  readonly #reads: TenantReadCoordinator;
  readonly #onState: ((state: TenantMutationState) => void) | undefined;

  constructor(deps: TenantWriteControllerDeps) {
    this.#client = deps.client ?? new TenantWriteClient();
    this.#account = deps.account;
    this.#reads = deps.reads;
    this.#onState = deps.onState;
  }

  get state(): TenantMutationState {
    return this.#state;
  }

  get disposed(): boolean {
    return this.#disposed;
  }

  /**
   * Validates a draft and enters the explicit confirmation stage. No request
   * is sent and no key is generated here. A known-recovery session is blocked
   * locally for the operations that require a fresh non-recovery proof.
   */
  begin(draft: TenantMutationDraft): boolean {
    if (this.#disposed) return false;
    const checked = validateDraft(
      draft,
      this.#reads.currentOrganizationId(),
      this.#reads.currentRole(),
      this.#account.state.session.signedIn === true,
    );
    if (!checked.ok) return false;
    if (
      requiresFreshProof(checked.draft) &&
      this.#account.state.session.signedIn &&
      this.#account.state.session.method === "recovery"
    ) {
      this.#frozen = null;
      this.#set({ kind: "rejected", notice: { kind: "recovery-blocked" } });
      return false;
    }
    this.#generation += 1;
    this.#frozen = null;
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
    this.#set({ kind: "idle" });
  }

  /**
   * Sends exactly one confirmed logical submit. The mutation id, key, body and
   * operation are frozen for the lifetime of the request.
   */
  async confirm(): Promise<void> {
    if (this.#disposed) return;
    if (this.#state.kind !== "confirming") return;
    const draft = this.#state.draft;
    const correlation = createMutationCorrelation();
    const generation = this.#generation;
    this.#frozen = {
      draft,
      correlation,
      organizationId: organizationIdOf(draft),
    };
    this.#set({
      kind: "pending",
      draft,
      mutationId: correlation.mutationId,
    });
    // Starting a write invalidates racing reads, but it does not start a read
    // refresh that could invalidate this flow.
    this.#reads.abortPendingReads();
    const accountBound: AccountBoundToken = this.#account.captureAccountBound();
    let result: CommerceTenantMutationResult;
    try {
      result = await this.#account.mutate(
        async ({ csrfToken, signal }) =>
          runMutation(this.#client, {
            draft,
            correlation,
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
    this.#set({
      kind: "committed",
      receipt: result.receipt,
      replayed: result.replayed,
    });
    // A confirmed commit is final even when the FOLLOW-UP read/session refresh
    // fails. Refresh is handled separately and can never demote a commit to
    // unknown or imply an optimistic rollback.
    await this.#refreshAfterCommit(draft, generation);
  }

  /** Maps a failed confirmed send; the commit is not yet known to have applied. */
  #handleConfirmFailure(
    error: unknown,
    draft: TenantMutationDraft,
    correlation: TenantMutationCorrelation,
  ): void {
    const failure = failureOf(error);
    if (
      failure.kind === "unauthorized" ||
      failure.kind === "csrf"
    ) {
      this.#frozen = null;
      this.#reads.clearForAccountChange();
      this.#set({
        kind: "rejected",
        notice:
          failure.kind === "csrf"
            ? { kind: "csrf" }
            : { kind: "unauthenticated" },
      });
      return;
    }
    if (failure.kind === "account-changed") {
      this.#frozen = null;
      this.#reads.clearForAccountChange();
      this.#set({ kind: "rejected", notice: { kind: "account-changed" } });
      return;
    }
    if (failure.kind === "known-rejected") {
      this.#frozen = null;
      this.#set({
        kind: "rejected",
        notice: { kind: failure.reason },
      });
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
      organizationId: this.#frozen?.organizationId ?? organizationIdOf(draft),
      checking: false,
      statusMessage: null,
    });
  }

  /**
   * Post-commit refresh. It reloads the relevant bounded page and, for a
   * membership change, re-reads the session. Any failure here is swallowed:
   * the committed receipt stays displayed and the UI offers explicit sign-in
   * or refresh guidance instead of pretending the write is unknown.
   */
  async #refreshAfterCommit(draft: TenantMutationDraft, generation: number): Promise<void> {
    try {
      await this.#reads.reloadAfterCommit(sectionOf(draft));
    } catch {
      // A read failure after a confirmed commit is not a write failure.
    }
    if (!this.#stillCurrent(generation)) return;
    if (draft.op === "tenant.membership.set") {
      // A self membership change may have revoked THIS session at commit.
      try {
        await this.#account.refreshSession();
      } catch {
        // The committed receipt stands; the UI directs the user to sign in.
      }
    }
  }

  /**
   * Explicit safe GET. A committed status clears the draft and reloads the
   * relevant bounded page; `not_found` never proves the original is dead.
   */
  async checkStatus(): Promise<void> {
    if (this.#disposed || this.#state.kind !== "outcome-unknown") return;
    const { mutationId, organizationId } = this.#state;
    const generation = this.#generation;
    this.#statusAbort?.abort();
    const controller = new AbortController();
    this.#statusAbort = controller;
    this.#set({ ...this.#state, checking: true, statusMessage: null });
    let status;
    try {
      status = await this.#client.readMutationStatus({
        ...(organizationId === null ? {} : { organizationId }),
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
      this.#set({
        kind: "committed",
        receipt: status.receipt,
        replayed: true,
      });
      // The committed status clears the frozen/local draft and reloads the
      // relevant bounded page; a refresh failure must not hide the commit.
      try {
        await this.#reads.reloadAfterCommit(sectionOfOperation(status.receipt.operation));
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

  /** Account/session change, logout or route change: clear everything local. */
  clear(): void {
    if (this.#disposed) return;
    this.#generation += 1;
    this.#frozen = null;
    this.#statusAbort?.abort();
    this.#statusAbort = null;
    this.#set({ kind: "idle" });
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#generation += 1;
    this.#frozen = null;
    this.#statusAbort?.abort();
    this.#statusAbort = null;
    this.#disposed = true;
    this.#state = { kind: "idle" };
    this.#onState?.(this.#state);
  }

  #stillCurrent(generation: number): boolean {
    return !this.#disposed && generation === this.#generation;
  }

  #set(next: TenantMutationState): void {
    if (this.#disposed) return;
    this.#state = next;
    this.#onState?.(next);
  }
}

interface RunInput {
  readonly draft: TenantMutationDraft;
  readonly correlation: TenantMutationCorrelation;
  readonly csrfToken: string;
  readonly signal: AbortSignal;
}

/** Runs the exact client call for one draft; one operation per submit. */
async function runMutation(
  client: TenantWriteClient,
  input: RunInput,
): Promise<CommerceTenantMutationResult> {
  const { draft, correlation, csrfToken, signal } = input;
  const common = { csrfToken, idempotencyKey: correlation.idempotencyKey, signal };
  switch (draft.op) {
    case "tenant.organization.create":
      return client.createOrganization({
        operation: draft.op,
        body: { mutationId: correlation.mutationId, displayName: draft.displayName },
        ...common,
      });
    case "tenant.agent.create":
      return client.createAgent({
        operation: draft.op,
        organizationId: draft.organizationId,
        body: { mutationId: correlation.mutationId, displayName: draft.displayName },
        ...common,
      });
    case "tenant.agent.update":
      return client.updateAgent({
        operation: draft.op,
        organizationId: draft.organizationId,
        agentId: draft.agentId,
        body: {
          mutationId: correlation.mutationId,
          patch: patchObject(draft.displayName, draft.status),
        },
        ...common,
      });
    case "tenant.provider.create":
      return client.createProvider({
        operation: draft.op,
        organizationId: draft.organizationId,
        body: { mutationId: correlation.mutationId, displayName: draft.displayName },
        ...common,
      });
    case "tenant.provider.update":
      return client.updateProvider({
        operation: draft.op,
        organizationId: draft.organizationId,
        providerId: draft.providerId,
        body: {
          mutationId: correlation.mutationId,
          patch: patchObject(draft.displayName, draft.status),
        },
        ...common,
      });
    case "tenant.membership.set":
      return client.setMembership({
        operation: draft.op,
        organizationId: draft.organizationId,
        accountId: draft.accountId,
        body: {
          mutationId: correlation.mutationId,
          role: draft.role,
          membershipStatus: draft.membershipStatus,
        },
        ...common,
      });
  }
}

function patchObject(
  displayName: string | undefined,
  status: string | undefined,
): Record<string, string> {
  return {
    ...(displayName === undefined ? {} : { displayName }),
    ...(status === undefined ? {} : { status }),
  };
}

function organizationIdOf(draft: TenantMutationDraft): string | null {
  return draft.op === "tenant.organization.create" ? null : draft.organizationId;
}

function sectionOf(draft: TenantMutationDraft): TenantMutationSection {
  switch (draft.op) {
    case "tenant.organization.create":
      return "organizations";
    case "tenant.agent.create":
    case "tenant.agent.update":
      return "agents";
    case "tenant.provider.create":
    case "tenant.provider.update":
      return "providers";
    case "tenant.membership.set":
      return "membership";
  }
}

/**
 * The bounded read section a committed receipt's operation belongs to. Used by
 * the explicit status commit path so it reloads exactly one relevant page.
 */
function sectionOfOperation(operation: string): TenantMutationSection {
  switch (operation) {
    case "tenant.organization.create":
      return "organizations";
    case "tenant.agent.create":
    case "tenant.agent.update":
      return "agents";
    case "tenant.provider.create":
    case "tenant.provider.update":
      return "providers";
    case "tenant.membership.set":
      return "membership";
    default:
      return "context";
  }
}

function requiresFreshProof(draft: TenantMutationDraft): boolean {
  return draft.op === "tenant.organization.create" || draft.op === "tenant.membership.set";
}

function confirmationWarning(draft: TenantMutationDraft): string | null {
  if (draft.op !== "tenant.membership.set") return null;
  if (draft.role === "owner" && draft.membershipStatus === "active") {
    return "Changing this membership can affect ownership. If you demote or suspend the last owner, the server protects the organization and refuses the change.";
  }
  return "If this membership change affects your own access, you may be signed out after it commits.";
}

type DraftCheck =
  | { readonly ok: true; readonly draft: TenantMutationDraft }
  | { readonly ok: false };

/**
 * Strict local draft validation. It mirrors the shared request schemas
 * (display name length/trim, exact role/status enums, canonical account id)
 * and never generates a request that the server would reject for shape.
 */
function validateDraft(
  draft: TenantMutationDraft,
  currentOrganizationId: string | null,
  currentRole: CommerceHumanRole | null,
  signedIn: boolean,
): DraftCheck {
  // Bootstrap is special-cased BEFORE the selected-org/role requirement: a
  // signed-in user with zero organizations may create their first organization.
  // The server alone decides proof freshness; recovery sessions are blocked in
  // `begin`. All other operations still require a selected organization + role.
  if (draft.op === "tenant.organization.create") {
    if (!signedIn) return { ok: false };
    if (!validDisplayName(draft.displayName)) return { ok: false };
    return { ok: true, draft };
  }
  if (currentOrganizationId === null || currentRole === null) return { ok: false };
  switch (draft.op) {
    case "tenant.agent.create":
      if (draft.organizationId !== currentOrganizationId) return { ok: false };
      if (!canWriteAgents(currentRole)) return { ok: false };
      if (!validDisplayName(draft.displayName)) return { ok: false };
      return { ok: true, draft };
    case "tenant.agent.update":
      if (draft.organizationId !== currentOrganizationId) return { ok: false };
      if (!canWriteAgents(currentRole)) return { ok: false };
      if (!hasDefinedPatch(draft.displayName, draft.status)) return { ok: false };
      if (draft.displayName !== undefined && !validDisplayName(draft.displayName)) {
        return { ok: false };
      }
      return { ok: true, draft };
    case "tenant.provider.create":
      if (draft.organizationId !== currentOrganizationId) return { ok: false };
      if (currentRole !== "owner") return { ok: false };
      if (!validDisplayName(draft.displayName)) return { ok: false };
      return { ok: true, draft };
    case "tenant.provider.update":
      if (draft.organizationId !== currentOrganizationId) return { ok: false };
      if (currentRole !== "owner") return { ok: false };
      if (!hasDefinedPatch(draft.displayName, draft.status)) return { ok: false };
      if (draft.displayName !== undefined && !validDisplayName(draft.displayName)) {
        return { ok: false };
      }
      return { ok: true, draft };
    case "tenant.membership.set":
      if (draft.organizationId !== currentOrganizationId) return { ok: false };
      if (currentRole !== "owner") return { ok: false };
      if (!CommerceAccountIdSchema.safeParse(draft.accountId).success) return { ok: false };
      if (!CommerceHumanRoleSchema.safeParse(draft.role).success) return { ok: false };
      if (draft.membershipStatus !== "active" && draft.membershipStatus !== "suspended") {
        return { ok: false };
      }
      return { ok: true, draft };
  }
}

function hasDefinedPatch(
  displayName: string | undefined,
  status: string | undefined,
): boolean {
  return displayName !== undefined || status !== undefined;
}

function validDisplayName(value: string): boolean {
  if (value.length < 1 || value.length > 100) return false;
  if (value !== value.trim()) return false;
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint === undefined) continue;
    if (codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f)) return false;
  }
  return true;
}

/** Owner and operator may write agents; viewer and provider roles may not. */
export function canWriteAgents(role: CommerceHumanRole): boolean {
  return role === "owner" || role === "operator";
}

type FailureResult =
  | { readonly kind: "known-rejected"; readonly reason: "validation" | "policy" | "conflict" }
  | { readonly kind: "unauthorized" }
  | { readonly kind: "csrf" }
  | { readonly kind: "account-changed" }
  | { readonly kind: "aborted" }
  | { readonly kind: "unknown" };

function failureOf(error: unknown): FailureResult {
  if (error instanceof TenantWriteApiError) {
    return mapWriteFailure(error.failure);
  }
  // `AccountFlowController.mutate` surfaces account-changed/aborted as an
  // AccountApiError; its `failure.kind` is inspected structurally.
  const kind = readFailureKind(error);
  if (kind === "account-changed") return { kind: "account-changed" };
  if (kind === "aborted") return { kind: "aborted" };
  if (kind === "server") return { kind: "unknown" };
  return { kind: "unknown" };
}

function readFailureKind(error: unknown): string | null {
  if (typeof error !== "object" || error === null) return null;
  const failure = (error as { failure?: unknown }).failure;
  if (typeof failure !== "object" || failure === null) return null;
  const kind = (failure as { kind?: unknown }).kind;
  return typeof kind === "string" ? kind : null;
}

function mapWriteFailure(failure: TenantWriteFailure): FailureResult {
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

export type { CommerceTenantMutationResult };
