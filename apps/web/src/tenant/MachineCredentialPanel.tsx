import type {
  CommerceHumanRole,
  CommerceMachineCredentialMetadata,
  CommerceMachineKind,
} from "@openarc/shared";
import { useEffect, useId, useRef, useState } from "react";

import {
  MACHINE_MAX_EXPIRY_DAYS,
  MACHINE_MIN_EXPIRY_DAYS,
  scopeLabel,
  type MachineCredentialController,
  type MachineConsoleState,
  type MachineCredentialDraft,
  type MachineCredentialTarget,
} from "./machine-controller.js";

/**
 * Credential-management console for ONE explicitly selected profile.
 *
 * The panel is only rendered by the parent when the machine flag and all four
 * prerequisite flags are enabled. It never infers the first profile: the parent
 * passes the exact selected target. It writes no browser storage, issues no
 * payment action, and never renders a raw server body or token except the one
 * validated `available_once` credential for the matching committed response.
 */

export interface MachineCredentialPanelProps {
  readonly controller: MachineCredentialController | null;
  readonly role: CommerceHumanRole;
  readonly target: MachineCredentialTarget;
  /**
   * The current list state for the bound profile. The parent passes the
   * controller's `credentialList`; list loads go through the controller.
   */
  readonly credentials: {
    readonly status: "none" | "loading" | "ready" | "error";
    readonly items: readonly CommerceMachineCredentialMetadata[];
    readonly nextCursor: string | null;
    readonly hasPrevious: boolean;
  };
}

type ExpiryChoice = number;

const EXPIRY_CHOICES: readonly ExpiryChoice[] = [1, 7, 30, 90];

function defaultExpiryIso(days: number): string {
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
}

export function MachineCredentialPanel(props: MachineCredentialPanelProps) {
  const { controller, role, target } = props;
  const [expiryDays, setExpiryDays] = useState<ExpiryChoice>(7);
  const [confirmingRevoke, setConfirmingRevoke] = useState<string | null>(null);
  const state = controller?.state ?? ({ kind: "idle" } as const);

  // A different explicit profile selection clears the local expiry/revoke
  // confirmation draft; the controller is cleared by the parent context guard.
  useEffect(() => {
    setExpiryDays(7);
    setConfirmingRevoke(null);
  }, [target.kind, target.profileId]);

  useEffect(() => {
    if (state.kind === "committed" || state.kind === "idle") setConfirmingRevoke(null);
  }, [state.kind]);

  if (controller === null) return null;

  const canIssue =
    target.kind === "agent" ? role === "owner" || role === "operator" : role === "owner";
  const canRevoke = canIssue;
  const pending = state.kind === "pending";
  // A fresh, unrecoverable secret is visible. Another issue would overwrite it,
  // so issue initiation stays disabled until the user explicitly dismisses it.
  const freshSecretVisible = state.kind === "committed" && state.committed.availableOnce !== null;

  function confirmIssue(): void {
    const days =
      expiryDays >= MACHINE_MIN_EXPIRY_DAYS && expiryDays <= MACHINE_MAX_EXPIRY_DAYS
        ? expiryDays
        : 7;
    controller?.begin({
      op: "issue",
      kind: target.kind,
      profileId: target.profileId,
      expiresAt: defaultExpiryIso(days),
    });
  }

  return (
    <section
      className="tenant-card machine-panel"
      aria-labelledby={`machine-title-${target.kind}-${target.profileId}`}
    >
      <h3 className="tenant-card__title" id={`machine-title-${target.kind}-${target.profileId}`}>
        {target.kind === "agent" ? "Agent credential" : "Provider credential"}
      </h3>
      <p className="tenant-note">
        Profile <span className="tenant-mono">{target.profileId}</span>. Scope{" "}
        <span className="tenant-mono">{scopeLabel(target.kind)}</span>. This is a read-only
        machine credential; it grants no payment or signing authority.
      </p>

      {renderState(state, controller)}

      {canIssue &&
      !pending &&
      !freshSecretVisible &&
      state.kind !== "confirming" &&
      state.kind !== "outcome-unknown" ? (
        <form
          className="tenant-form"
          aria-label="Issue credential"
          onSubmit={(event) => {
            event.preventDefault();
            confirmIssue();
          }}
        >
          <div className="tenant-field">
            <label htmlFor={`machine-expiry-${target.profileId}`}>Expires in</label>
            <select
              id={`machine-expiry-${target.profileId}`}
              className="tenant-input"
              value={expiryDays}
              disabled={pending}
              onChange={(event) => setExpiryDays(Number(event.target.value) as ExpiryChoice)}
            >
              {EXPIRY_CHOICES.map((days) => (
                <option key={days} value={days}>
                  {days} day{days === 1 ? "" : "s"}
                </option>
              ))}
            </select>
          </div>
          <div className="tenant-actions">
            <button type="submit" className="tenant-button tenant-button--primary" disabled={pending}>
              Review issue
            </button>
          </div>
        </form>
      ) : null}

      <CredentialList
        target={target}
        credentials={props.credentials}
        canRevoke={canRevoke}
        pending={pending}
        confirmingRevoke={confirmingRevoke}
        onLoad={() => void controller.loadCredentials()}
        onNext={() => void controller.loadNextCredentials()}
        onFirst={() => void controller.loadCredentials()}
        onRequestRevoke={setConfirmingRevoke}
        onConfirmRevoke={(credentialId) => {
          setConfirmingRevoke(null);
          controller.begin({ op: "revoke", kind: target.kind, credentialId });
        }}
        onCancelRevoke={() => setConfirmingRevoke(null)}
      />
    </section>
  );
}

function renderState(state: MachineConsoleState, controller: MachineCredentialController) {
  if (state.kind === "idle") return null;
  if (state.kind === "confirming") {
    return (
      <div className="tenant-confirm" role="group" aria-label="Confirm credential action">
        <h4 className="tenant-confirm__title">Confirm this credential action</h4>
        <p className="tenant-confirm__op">{draftLabel(state.draft)}</p>
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
            Confirm
          </button>
          <button type="button" className="tenant-button" onClick={() => controller.cancel()}>
            Cancel
          </button>
        </div>
      </div>
    );
  }
  if (state.kind === "pending") {
    return (
      <p className="tenant-status" role="status" aria-live="polite">
        Sending one credential request… Do not resubmit.
      </p>
    );
  }
  if (state.kind === "committed") {
    return (
      <CommittedCredential
        committed={state.committed}
        onDismiss={() => controller.dismissCredential()}
      />
    );
  }
  if (state.kind === "rejected") {
    return <RejectedCredential notice={state.notice} />;
  }
  return (
    <UnknownCredential
      controller={controller}
      mutationId={state.mutationId}
      checking={state.checking}
      statusMessage={state.statusMessage}
    />
  );
}

function CommittedCredential(props: {
  committed: {
    readonly receipt: { readonly operation: string; readonly credentialId: string; readonly mutationId: string };
    readonly replayed: boolean;
    readonly availableOnce: string | null;
    readonly publicPrefix: string | null;
  };
  onDismiss: () => void;
}) {
  const secretRef = useRef<HTMLTextAreaElement | null>(null);
  const { committed } = props;
  const isIssue = committed.receipt.operation.endsWith(".issue");
  const freshSecret = committed.availableOnce;
  return (
    <div className="tenant-receipt">
      {/*
        Only the safe receipt metadata and guidance live in the polite live
        region. The raw credential group is deliberately OUTSIDE it so a new
        secret is never announced automatically; the user must select it.
      */}
      <div role="status" aria-live="polite">
        <h4 className="tenant-receipt__title">
          {committed.replayed ? "Credential action already committed" : "Credential action committed"}
        </h4>
        <dl className="tenant-meta">
          <dt>Operation</dt>
          <dd>{committed.receipt.operation}</dd>
          <dt>Credential</dt>
          <dd className="tenant-mono">{committed.receipt.credentialId}</dd>
          <dt>Mutation</dt>
          <dd className="tenant-mono">{committed.receipt.mutationId}</dd>
          {committed.publicPrefix !== null ? (
            <>
              <dt>Public prefix</dt>
              <dd className="tenant-mono">{committed.publicPrefix}</dd>
            </>
          ) : null}
        </dl>

        {isIssue && freshSecret !== null ? (
          <p className="tenant-status tenant-status--warning">
            This credential is shown only once. OpenArc cannot retrieve it later. Save it in a
            secure secret store now, then dismiss it.
          </p>
        ) : null}

        {isIssue && freshSecret === null ? (
          <p className="tenant-status tenant-status--warning">
            {committed.replayed
              ? "This credential was already issued, so its secret cannot be shown again. Revoke it explicitly and issue a new credential if you lost the secret."
              : "The credential secret is no longer available in this page."}
          </p>
        ) : null}

        {!isIssue ? (
          <p className="tenant-status">
            The credential was revoked. Any machine using it has lost access.
          </p>
        ) : null}
      </div>

      {isIssue && freshSecret !== null ? (
        <div className="machine-secret" role="group" aria-label="New credential">
          <label htmlFor="machine-secret-value">New machine credential</label>
          <textarea
            id="machine-secret-value"
            ref={secretRef}
            className="tenant-input tenant-input--mono machine-secret__value"
            readOnly
            rows={3}
            value={freshSecret}
            onFocus={(event) => event.currentTarget.select()}
          />
          <div className="tenant-actions">
            <button
              type="button"
              className="tenant-button"
              onClick={() => {
                secretRef.current?.focus();
                secretRef.current?.select();
              }}
            >
              Select credential
            </button>
            <button type="button" className="tenant-button tenant-button--primary" onClick={props.onDismiss}>
              Dismiss
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function RejectedCredential(props: { notice: { kind: string } }) {
  const messages: Record<string, string> = {
    validation: "The server rejected the credential request as invalid. Review and try again.",
    policy: "The server policy denied this credential action. Nothing was applied.",
    conflict: "The server reported a conflict. Nothing was applied.",
    unauthenticated: "Your sign-in is no longer valid. Sign in again before managing credentials.",
    csrf: "The page security check expired. Sign in again before managing credentials.",
    "account-changed":
      "The signed-in account changed while this action was starting, so nothing was sent. Review the account shown, then start again.",
    "recovery-blocked":
      "Issuing a credential needs a fresh passkey or wallet sign-in. Recovery sign-in cannot authorize it. Sign in again from your Account page, then retry.",
    "inactive-profile":
      "This profile is not active, so no credential can be issued. You may still revoke an existing credential.",
  };
  const message = messages[props.notice.kind] ?? "The credential action could not be started.";
  return (
    <p className="tenant-status tenant-status--error" role="alert">
      {message} <a href="/account">Go to account</a>
    </p>
  );
}

function UnknownCredential(props: {
  controller: MachineCredentialController;
  mutationId: string;
  checking: boolean;
  statusMessage: string | null;
}) {
  const messageRef = useRef<HTMLParagraphElement | null>(null);
  useEffect(() => {
    messageRef.current?.focus();
  }, []);
  return (
    <div className="tenant-confirm" role="group" aria-label="Unconfirmed credential action">
      <h4 className="tenant-confirm__title">Outcome unknown</h4>
      <p className="tenant-status tenant-status--warning" role="status">
        The request was sent but no confirmed response arrived. It may still complete. There is no
        retry and no dismiss that would let this same action be submitted again. Check the status
        with the original mutation id; it stays locked until a committed result or a navigation
        away from this page.
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

function CredentialList(props: {
  target: MachineCredentialTarget;
  credentials: MachineCredentialPanelProps["credentials"];
  canRevoke: boolean;
  pending: boolean;
  confirmingRevoke: string | null;
  onLoad: () => void;
  onNext: () => void;
  onFirst: () => void;
  onRequestRevoke: (credentialId: string) => void;
  onConfirmRevoke: (credentialId: string) => void;
  onCancelRevoke: () => void;
}) {
  const { credentials } = props;
  const labelId = useId();
  return (
    <div className="machine-credentials">
      <p className="tenant-rail__label" id={labelId}>
        Existing credentials
      </p>
      {credentials.status === "none" ? (
        <div className="tenant-actions">
          <button type="button" className="tenant-button" onClick={props.onLoad}>
            Load credentials
          </button>
        </div>
      ) : null}
      {credentials.status === "loading" ? (
        <p className="tenant-status" role="status">
          Loading credentials…
        </p>
      ) : null}
      {credentials.status === "error" ? (
        <p className="tenant-status tenant-status--error" role="alert">
          Credentials could not be loaded right now.
        </p>
      ) : null}
      {credentials.status === "ready" && credentials.items.length === 0 ? (
        <p className="tenant-empty">No credentials for this profile.</p>
      ) : null}
      {credentials.items.length > 0 ? (
        <ul className="machine-credential-list" aria-labelledby={labelId}>
          {credentials.items.map((item) => (
            <li key={item.credentialId} className="machine-credential">
              <span className="tenant-mono">{item.publicPrefix}</span>
              <span className={`tenant-pill ${item.status === "active" ? "tenant-pill--active" : ""}`}>
                {item.status}
              </span>
              <span className="tenant-mono machine-credential__expiry">
                expires {item.expiresAt}
              </span>
              {props.canRevoke && item.status === "active" ? (
                props.confirmingRevoke === item.credentialId ? (
                  <span className="machine-credential__confirm">
                    <span role="status">Revoke this credential?</span>
                    <button
                      type="button"
                      className="tenant-button"
                      disabled={props.pending}
                      onClick={() => props.onConfirmRevoke(item.credentialId)}
                    >
                      Confirm revoke
                    </button>
                    <button type="button" className="tenant-button" onClick={props.onCancelRevoke}>
                      Cancel
                    </button>
                  </span>
                ) : (
                  <button
                    type="button"
                    className="tenant-button"
                    disabled={props.pending}
                    onClick={() => props.onRequestRevoke(item.credentialId)}
                  >
                    Revoke
                  </button>
                )
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
      <div className="tenant-pagination">
        {credentials.hasPrevious ? (
          <button type="button" className="tenant-button" onClick={props.onFirst}>
            Back to page 1
          </button>
        ) : null}
        <button
          type="button"
          className="tenant-button"
          disabled={credentials.nextCursor === null}
          onClick={props.onNext}
        >
          Next page
        </button>
      </div>
    </div>
  );
}

function draftLabel(draft: MachineCredentialDraft): string {
  if (draft.op === "issue") {
    return `Issue a ${draft.kind} credential for ${draft.profileId} (scope ${scopeLabel(draft.kind)}, read-only)`;
  }
  return `Revoke ${draft.kind} credential ${draft.credentialId}`;
}

export type { CommerceMachineKind };
