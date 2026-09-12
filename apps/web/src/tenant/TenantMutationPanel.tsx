import {
  CommerceHumanRoleSchema,
  type CommerceHumanRole,
  type CommerceTenantMutationReceipt,
} from "@openarc/shared";
import { useCallback, useEffect, useId, useRef, useState } from "react";

import type {
  TenantWriteController,
  TenantMutationDraft,
  TenantMutationState,
} from "./tenant-write-controller.js";

/**
 * Bounded tenant mutation panel.
 *
 * Renders the six accepted operations with strict native controls, accessible
 * labels and errors, an explicit confirmation step and a busy/disabled state.
 * It invokes no wallet, writes no storage and never renders a raw server body:
 * only a safe mutation/resource id receipt or a fixed local message.
 */

export interface TenantMutationPanelProps {
  readonly controller: TenantWriteController | null;
  readonly role: CommerceHumanRole;
  readonly organizationId: string;
  /**
   * `bootstrap` renders only the first-organization create for a signed-in
   * user with zero organizations. `full` renders the accepted six-operation
   * panel for a selected organization.
   */
  readonly mode?: "full" | "bootstrap" | "receipt";
}

type OperationKey = TenantMutationDraft["op"];

interface FieldErrors {
  readonly displayName?: string;
  readonly accountId?: string;
  readonly patch?: string;
}

const HUMAN_ROLES = CommerceHumanRoleSchema.options;

const ROLE_LABELS: Record<CommerceHumanRole, string> = {
  owner: "Owner",
  operator: "Operator",
  provider_admin: "Provider admin",
  provider_developer: "Provider developer",
  viewer: "Viewer",
};

const AGENT_STATUSES = ["active", "suspended", "revoked"] as const;
const PROVIDER_STATUSES = ["active", "suspended", "retired"] as const;

export function TenantMutationPanel(props: TenantMutationPanelProps) {
  const { controller, role, organizationId } = props;
  const bootstrap = props.mode === "bootstrap";
  const receiptOnly = props.mode === "receipt";
  const [operation, setOperation] = useState<OperationKey>(
    bootstrap ? "tenant.organization.create" : "tenant.agent.create",
  );
  const [displayName, setDisplayName] = useState("");
  const [targetId, setTargetId] = useState("");
  const [patchName, setPatchName] = useState("");
  const [patchStatus, setPatchStatus] = useState("");
  const [membershipAccountId, setMembershipAccountId] = useState("");
  const [membershipRole, setMembershipRole] = useState<CommerceHumanRole>("viewer");
  const [membershipStatus, setMembershipStatus] = useState<"active" | "suspended">("active");
  const [errors, setErrors] = useState<FieldErrors>({});
  const state = controller?.state ?? { kind: "idle" as const };

  const canWriteAgents = role === "owner" || role === "operator";

  // Account/route/org change clears the draft. Returning to a clean slate.
  useEffect(() => {
    setDisplayName("");
    setTargetId("");
    setPatchName("");
    setPatchStatus("");
    setMembershipAccountId("");
    setMembershipRole("viewer");
    setMembershipStatus("active");
    setErrors({});
  }, [organizationId]);

  const resetDraft = useCallback(() => {
    setDisplayName("");
    setTargetId("");
    setPatchName("");
    setPatchStatus("");
    setMembershipAccountId("");
    setMembershipRole("viewer");
    setMembershipStatus("active");
    setErrors({});
  }, []);

  // A confirmed commit clears the local input draft too, so no stale field
  // values can be re-reviewed or resubmitted as a new logical submit.
  useEffect(() => {
    if (state.kind === "committed") {
      setDisplayName("");
      setTargetId("");
      setPatchName("");
      setPatchStatus("");
      setMembershipAccountId("");
      setMembershipRole("viewer");
      setMembershipStatus("active");
      setErrors({});
    }
  }, [state.kind]);

  if (controller === null) return null;

  const pending = state.kind === "pending";
  const confirming = state.kind === "confirming";
  const unknown = state.kind === "outcome-unknown";

  // Receipt-only mode keeps a committed or unconfirmed outcome visible even
  // though the organization list refreshed and no organization is selected.
  // It never renders the create form, so no new mutation is offered outside a
  // real first-organization context.
  if (receiptOnly && state.kind !== "committed" && state.kind !== "outcome-unknown") {
    return null;
  }

  function submitDraft(): void {
    const result = buildDraft({
      operation,
      organizationId,
      displayName,
      targetId,
      patchName,
      patchStatus,
      membershipAccountId,
      membershipRole,
      membershipStatus,
      canWriteAgents,
    });
    if (!result.ok) {
      setErrors(result.errors);
      return;
    }
    setErrors({});
    const accepted = controller?.begin(result.draft) ?? false;
    if (accepted) {
      // The controller owns confirmation; drafts stay visible for review.
    }
  }

  return (
    <section className="tenant-card" aria-labelledby="tenant-mutation-title">
      <h2 className="tenant-card__title" id="tenant-mutation-title">
        Membership and tenant changes
      </h2>
      <p className="tenant-lede">
        Every change is a single explicit request. Nothing is retried automatically; an
        unconfirmed outcome can only be checked, never resubmitted.
      </p>

      {renderState(state, controller, resetDraft)}

      {!receiptOnly && !pending && !confirming && !unknown ? (
        <form
          className="tenant-form"
          aria-label="Tenant change"
          onSubmit={(event) => {
            event.preventDefault();
            submitDraft();
          }}
        >
          <div className="tenant-field">
            <label htmlFor="tenant-mutation-operation">Operation</label>
            <select
              id="tenant-mutation-operation"
              className="tenant-input"
              value={operation}
              disabled={pending}
              onChange={(event) => {
                setOperation(event.target.value as OperationKey);
                setErrors({});
              }}
            >
              {bootstrap ? (
                <option value="tenant.organization.create">Create organization</option>
              ) : (
                <>
                  <option value="tenant.agent.create" disabled={!canWriteAgents}>
                    Create agent
                  </option>
                  <option value="tenant.agent.update" disabled={!canWriteAgents}>
                    Edit agent
                  </option>
                  <option value="tenant.provider.create" disabled={role !== "owner"}>
                    Create provider
                  </option>
                  <option value="tenant.provider.update" disabled={role !== "owner"}>
                    Edit provider
                  </option>
                  <option value="tenant.membership.set" disabled={role !== "owner"}>
                    Set membership
                  </option>
                  <option value="tenant.organization.create" disabled={false}>
                    Create organization
                  </option>
                </>
              )}
            </select>
          </div>

          <OperationFields
            operation={operation}
            canWriteAgents={canWriteAgents}
            isOwner={role === "owner"}
            displayName={displayName}
            targetId={targetId}
            patchName={patchName}
            patchStatus={patchStatus}
            membershipAccountId={membershipAccountId}
            membershipRole={membershipRole}
            membershipStatus={membershipStatus}
            errors={errors}
            onDisplayName={setDisplayName}
            onTargetId={setTargetId}
            onPatchName={setPatchName}
            onPatchStatus={setPatchStatus}
            onMembershipAccountId={setMembershipAccountId}
            onMembershipRole={setMembershipRole}
            onMembershipStatus={setMembershipStatus}
          />

          <div className="tenant-actions">
            <button type="submit" className="tenant-button tenant-button--primary" disabled={pending}>
              Review change
            </button>
          </div>
        </form>
      ) : null}
    </section>
  );
}

interface OperationFieldsProps {
  operation: OperationKey;
  canWriteAgents: boolean;
  isOwner: boolean;
  displayName: string;
  targetId: string;
  patchName: string;
  patchStatus: string;
  membershipAccountId: string;
  membershipRole: CommerceHumanRole;
  membershipStatus: "active" | "suspended";
  errors: FieldErrors;
  onDisplayName: (value: string) => void;
  onTargetId: (value: string) => void;
  onPatchName: (value: string) => void;
  onPatchStatus: (value: string) => void;
  onMembershipAccountId: (value: string) => void;
  onMembershipRole: (value: CommerceHumanRole) => void;
  onMembershipStatus: (value: "active" | "suspended") => void;
}

function OperationFields(props: OperationFieldsProps) {
  const idPrefix = useId();
  const nameId = `${idPrefix}-name`;
  const targetId = `${idPrefix}-target`;
  const patchNameId = `${idPrefix}-patch-name`;
  const patchStatusId = `${idPrefix}-patch-status`;
  const accountId = `${idPrefix}-account`;
  const roleId = `${idPrefix}-role`;
  const statusId = `${idPrefix}-status`;
  void props.canWriteAgents;
  void props.isOwner;

  if (props.operation === "tenant.organization.create") {
    return (
      <>
        <div className="tenant-field">
          <label htmlFor={nameId}>Display name</label>
          <input
            id={nameId}
            className="tenant-input"
            value={props.displayName}
            maxLength={100}
            required
            aria-invalid={props.errors.displayName !== undefined}
            aria-describedby={props.errors.displayName !== undefined ? `${nameId}-error` : undefined}
            onChange={(event) => props.onDisplayName(event.target.value)}
          />
          <FieldError id={`${nameId}-error`} message={props.errors.displayName} />
        </div>
        <p className="tenant-note">
          Creating an organization needs a fresh passkey or wallet sign-in. Sign in again from
          your Account page first if you have been asked to.
        </p>
      </>
    );
  }

  if (props.operation === "tenant.agent.create" || props.operation === "tenant.provider.create") {
    return (
      <div className="tenant-field">
        <label htmlFor={nameId}>Display name</label>
        <input
          id={nameId}
          className="tenant-input"
          value={props.displayName}
          maxLength={100}
          required
          aria-invalid={props.errors.displayName !== undefined}
          aria-describedby={props.errors.displayName !== undefined ? `${nameId}-error` : undefined}
          onChange={(event) => props.onDisplayName(event.target.value)}
        />
        <FieldError id={`${nameId}-error`} message={props.errors.displayName} />
      </div>
    );
  }

  if (props.operation === "tenant.agent.update" || props.operation === "tenant.provider.update") {
    const statuses = props.operation === "tenant.agent.update" ? AGENT_STATUSES : PROVIDER_STATUSES;
    return (
      <>
        <div className="tenant-field">
          <label htmlFor={targetId}>Resource ID</label>
          <input
            id={targetId}
            className="tenant-input tenant-input--mono"
            value={props.targetId}
            required
            aria-invalid={props.errors.patch !== undefined}
            aria-describedby={props.errors.patch !== undefined ? `${targetId}-error` : undefined}
            onChange={(event) => props.onTargetId(event.target.value)}
          />
          <FieldError id={`${targetId}-error`} message={props.errors.patch} />
        </div>
        <div className="tenant-field">
          <label htmlFor={patchNameId}>New display name (optional)</label>
          <input
            id={patchNameId}
            className="tenant-input"
            value={props.patchName}
            maxLength={100}
            onChange={(event) => props.onPatchName(event.target.value)}
          />
        </div>
        <div className="tenant-field">
          <label htmlFor={patchStatusId}>New status (optional)</label>
          <select
            id={patchStatusId}
            className="tenant-input"
            value={props.patchStatus}
            onChange={(event) => props.onPatchStatus(event.target.value)}
          >
            <option value="">Leave unchanged</option>
            {statuses.map((status) => (
              <option key={status} value={status}>
                {status}
              </option>
            ))}
          </select>
        </div>
      </>
    );
  }

  return (
    <>
      <div className="tenant-field">
        <label htmlFor={accountId}>Target account ID</label>
        <input
          id={accountId}
          className="tenant-input tenant-input--mono"
          value={props.membershipAccountId}
          required
          placeholder="openarc:account:…"
          aria-invalid={props.errors.accountId !== undefined}
          aria-describedby={props.errors.accountId !== undefined ? `${accountId}-error` : undefined}
          onChange={(event) => props.onMembershipAccountId(event.target.value)}
        />
        <FieldError id={`${accountId}-error`} message={props.errors.accountId} />
      </div>
      <div className="tenant-field">
        <label htmlFor={roleId}>Role</label>
        <select
          id={roleId}
          className="tenant-input"
          value={props.membershipRole}
          onChange={(event) => props.onMembershipRole(event.target.value as CommerceHumanRole)}
        >
          {HUMAN_ROLES.map((value) => (
            <option key={value} value={value}>
              {ROLE_LABELS[value]}
            </option>
          ))}
        </select>
      </div>
      <div className="tenant-field">
        <label htmlFor={statusId}>Membership status</label>
        <select
          id={statusId}
          className="tenant-input"
          value={props.membershipStatus}
          onChange={(event) =>
            props.onMembershipStatus(event.target.value === "suspended" ? "suspended" : "active")
          }
        >
          <option value="active">Active</option>
          <option value="suspended">Suspended</option>
        </select>
      </div>
      <p className="tenant-note">
        Membership changes need a fresh passkey or wallet sign-in. The last-owner rule is
        enforced by the server.
      </p>
    </>
  );
}

function FieldError(props: { id: string; message: string | undefined }) {
  if (props.message === undefined) return null;
  return (
    <p className="tenant-field__error" id={props.id} role="alert">
      {props.message}
    </p>
  );
}

function renderState(
  state: TenantMutationState,
  controller: TenantWriteController,
  resetDraft: () => void,
) {
  if (state.kind === "idle") return null;
  if (state.kind === "confirming") {
    return (
      <div className="tenant-confirm" role="group" aria-label="Confirm change">
        <h3 className="tenant-confirm__title">Confirm this change</h3>
        <p className="tenant-confirm__op">{operationLabel(state.draft)}</p>
        {state.warning !== null ? (
          <p className="tenant-status tenant-status--warning" role="status">
            {state.warning}
          </p>
        ) : null}
        <div className="tenant-actions">
          <button
            type="button"
            className="tenant-button tenant-button--primary"
            onClick={() => void controller.confirm()}
          >
            Confirm and send
          </button>
          <button
            type="button"
            className="tenant-button"
            onClick={() => {
              controller.cancel();
              resetDraft();
            }}
          >
            Cancel
          </button>
        </div>
      </div>
    );
  }
  if (state.kind === "pending") {
    return (
      <p className="tenant-status" role="status" aria-live="polite">
        Sending the change… Do not resubmit. A single request is in flight.
      </p>
    );
  }
  if (state.kind === "committed") {
    return <CommittedReceipt receipt={state.receipt} replayed={state.replayed} />;
  }
  if (state.kind === "rejected") {
    return <RejectedNotice notice={state.notice} />;
  }
  return (
    <UnknownOutcome
      controller={controller}
      mutationId={state.mutationId}
      checking={state.checking}
      statusMessage={state.statusMessage}
    />
  );
}

function CommittedReceipt(props: {
  receipt: CommerceTenantMutationReceipt;
  replayed: boolean;
}) {
  return (
    <div className="tenant-receipt" role="status" aria-live="polite">
      <h3 className="tenant-receipt__title">
        {props.replayed ? "Change already committed" : "Change committed"}
      </h3>
      <dl className="tenant-meta">
        <dt>Operation</dt>
        <dd>{props.receipt.operation}</dd>
        <dt>Resource</dt>
        <dd className="tenant-mono">{props.receipt.resourceId}</dd>
        <dt>Mutation</dt>
        <dd className="tenant-mono">{props.receipt.mutationId}</dd>
      </dl>
    </div>
  );
}

function RejectedNotice(props: { notice: { kind: string } }) {
  const messages: Record<string, string> = {
    validation: "The server rejected the request as invalid. Review the fields and try again.",
    policy: "The server policy denied this change. No write was applied.",
    conflict: "The server reported a conflict. No write was applied.",
    unauthenticated: "Your sign-in is no longer valid. Sign in again before changing anything.",
    csrf: "The page security check expired. Sign in again before changing anything.",
    "account-changed":
      "The signed-in account changed while this action was starting, so nothing was sent. Review the account shown, then start again.",
    "recovery-blocked":
      "This change needs a fresh passkey or wallet sign-in. Recovery sign-in cannot authorize it. Sign in again from your Account page, then retry.",
  };
  const message = messages[props.notice.kind] ?? "The change could not be started.";
  return (
    <p className="tenant-status tenant-status--error" role="alert">
      {message}{" "}
      <a href="/account">Go to account</a>
    </p>
  );
}

function UnknownOutcome(props: {
  controller: TenantWriteController;
  mutationId: string;
  checking: boolean;
  statusMessage: string | null;
}) {
  const messageRef = useRef<HTMLParagraphElement | null>(null);
  useEffect(() => {
    messageRef.current?.focus();
  }, []);
  return (
    <div className="tenant-confirm" role="group" aria-label="Unconfirmed change">
      <h3 className="tenant-confirm__title">Outcome unknown</h3>
      <p className="tenant-status tenant-status--warning" role="status">
        The request was sent but no confirmed response arrived. It may still complete. There is
        no retry and no dismiss that would let this same change be submitted again. Check the
        status with the original mutation id; it stays locked until a committed result or a
        navigation away from this page.
      </p>
      <p className="tenant-mono" ref={messageRef} tabIndex={-1}>
        Mutation {props.mutationId}
      </p>
      {props.statusMessage !== null ? (
        <p className="tenant-status" role="status" aria-live="polite">
          {props.statusMessage}
        </p>
      ) : null}
      <div className="tenant-actions">
        <button
          type="button"
          className="tenant-button tenant-button--primary"
          disabled={props.checking}
          onClick={() => void props.controller.checkStatus()}
        >
          {props.checking ? "Checking…" : "Check status"}
        </button>
        <a className="tenant-button" href="/app/overview">
          Leave this page
        </a>
      </div>
    </div>
  );
}

interface BuildInput {
  operation: OperationKey;
  organizationId: string;
  displayName: string;
  targetId: string;
  patchName: string;
  patchStatus: string;
  membershipAccountId: string;
  membershipRole: CommerceHumanRole;
  membershipStatus: "active" | "suspended";
  canWriteAgents: boolean;
}

type BuildResult =
  | { ok: true; draft: TenantMutationDraft }
  | { ok: false; errors: FieldErrors };

function buildDraft(input: BuildInput): BuildResult {
  const displayName = input.displayName.trim();
  switch (input.operation) {
    case "tenant.organization.create":
      if (displayName.length === 0 || displayName.length > 100) {
        return { ok: false, errors: { displayName: "Enter a display name of 1–100 characters." } };
      }
      return { ok: true, draft: { op: input.operation, displayName } };
    case "tenant.agent.create":
      if (displayName.length === 0 || displayName.length > 100) {
        return { ok: false, errors: { displayName: "Enter a display name of 1–100 characters." } };
      }
      if (!input.canWriteAgents) {
        return { ok: false, errors: { displayName: "Your role cannot create agents." } };
      }
      return {
        ok: true,
        draft: { op: input.operation, organizationId: input.organizationId, displayName },
      };
    case "tenant.provider.create":
      if (displayName.length === 0 || displayName.length > 100) {
        return { ok: false, errors: { displayName: "Enter a display name of 1–100 characters." } };
      }
      return {
        ok: true,
        draft: { op: input.operation, organizationId: input.organizationId, displayName },
      };
    case "tenant.agent.update": {
      const name = input.patchName.trim();
      if (input.targetId.length === 0) {
        return { ok: false, errors: { patch: "Enter the agent ID to edit." } };
      }
      const status = input.patchStatus === "" ? undefined : (input.patchStatus as "active" | "suspended" | "revoked");
      if (name === "" && status === undefined) {
        return { ok: false, errors: { patch: "Change at least one field." } };
      }
      return {
        ok: true,
        draft: {
          op: input.operation,
          organizationId: input.organizationId,
          agentId: input.targetId,
          ...(name === "" ? {} : { displayName: name }),
          ...(status === undefined ? {} : { status }),
        },
      };
    }
    case "tenant.provider.update": {
      const name = input.patchName.trim();
      if (input.targetId.length === 0) {
        return { ok: false, errors: { patch: "Enter the provider ID to edit." } };
      }
      const status = input.patchStatus === "" ? undefined : (input.patchStatus as "active" | "suspended" | "retired");
      if (name === "" && status === undefined) {
        return { ok: false, errors: { patch: "Change at least one field." } };
      }
      return {
        ok: true,
        draft: {
          op: input.operation,
          organizationId: input.organizationId,
          providerId: input.targetId,
          ...(name === "" ? {} : { displayName: name }),
          ...(status === undefined ? {} : { status }),
        },
      };
    }
    case "tenant.membership.set":
      if (!CommerceHumanRoleSchema.safeParse(input.membershipRole).success) {
        return { ok: false, errors: { accountId: "Choose a valid role." } };
      }
      if (input.membershipAccountId.length === 0) {
        return { ok: false, errors: { accountId: "Enter the canonical account ID." } };
      }
      return {
        ok: true,
        draft: {
          op: input.operation,
          organizationId: input.organizationId,
          accountId: input.membershipAccountId.trim(),
          role: input.membershipRole,
          membershipStatus: input.membershipStatus,
        },
      };
  }
}

function operationLabel(draft: TenantMutationDraft): string {
  switch (draft.op) {
    case "tenant.organization.create":
      return `Create organization “${draft.displayName}”`;
    case "tenant.agent.create":
      return `Create agent “${draft.displayName}”`;
    case "tenant.agent.update":
      return `Edit agent ${draft.agentId}`;
    case "tenant.provider.create":
      return `Create provider “${draft.displayName}”`;
    case "tenant.provider.update":
      return `Edit provider ${draft.providerId}`;
    case "tenant.membership.set":
      return `Set ${draft.accountId} to ${ROLE_LABELS[draft.role]} (${draft.membershipStatus})`;
  }
}

export type { TenantWriteController };
