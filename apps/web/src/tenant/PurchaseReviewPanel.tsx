import {
  PURCHASE_DECISION_SUMMARIES,
  type PurchaseDecision,
  type PurchaseReviewField,
} from "@openarc/shared";

import { formatAtomicAmount } from "./action-controller.js";
import {
  purchaseDecisionOutcomeLabel,
  purchaseRejectionMessage,
  type PurchaseController,
  type PurchaseControllerState,
  type PurchaseOutcomeView,
} from "./purchase-controller.js";

/**
 * P04-06 — the browser purchase handoff.
 *
 * A human reviews exactly one pending agent purchase and approves or rejects
 * it. Every figure is printed as the server sent it: the canonical integer
 * string is always shown, and its decimal placement is produced by string
 * position only. No amount is parsed into a JavaScript number, rounded or
 * approximated.
 *
 * A field no browser route can supply is shown as an explicit unknown, never
 * filled in with a guess. The outcome line uses only the accepted certainty
 * vocabulary: it never says paid, settled, refunded, failed or released.
 */

export interface PurchaseReviewPanelProps {
  readonly state: PurchaseControllerState;
  readonly controller: PurchaseController | null;
  readonly actionId: string;
}

/** Amount-valued rows get a decimal placement alongside the exact integer. */
const AMOUNT_KEYS = new Set(["amountAtomic", "feeAtomic", "debitAtomic"]);

export function PurchaseReviewPanel(props: PurchaseReviewPanelProps) {
  const { state, controller } = props;
  const review = state.review;

  if (state.capability === "unknown" || state.capability === "checking") {
    return (
      <p className="tenant-status" role="status">
        Checking purchase availability…
      </p>
    );
  }
  if (state.capability === "unavailable") {
    return (
      <p className="tenant-status tenant-status--warning" role="status">
        The purchase handoff is not enabled in this deployment. No request was made.
      </p>
    );
  }
  if (review.status === "none" || review.status === "loading") {
    return (
      <p className="tenant-status" role="status">
        Loading the purchase for review…
      </p>
    );
  }
  if (review.status === "not-found") {
    return (
      <p className="tenant-status tenant-status--warning" role="status">
        This purchase was not found. No empty or fabricated purchase is shown.
      </p>
    );
  }
  if (review.status === "error" || review.action === null) {
    return (
      <p className="tenant-status tenant-status--error" role="alert">
        The purchase could not be loaded. Nothing is shown rather than a guess.
      </p>
    );
  }

  const action = review.action;
  const fields = controller?.reviewFields() ?? [];
  const outcome = controller?.outcome() ?? null;
  const decidable = action.status === "pending_approval" || action.status === "reserved_not_granted";
  const busy = state.decision.kind === "pending" || state.decision.kind === "confirming";
  const showDecisions = state.canDecide && decidable && !state.receiptUnavailable;

  return (
    <section className="tenant-actions-console__section purchase-review" aria-labelledby="purchase-review-title">
      <p className="tenant-eyebrow">PURCHASE REVIEW</p>
      <h2 className="tenant-title tenant-title--small" id="purchase-review-title">
        Review purchase <span className="tenant-mono">{action.actionId}</span>
      </h2>
      <p className="tenant-status tenant-status--warning" role="status">
        You are reviewing what an agent proposes to buy. Approving records your approval and commits
        the budget shown below. It connects no wallet, signs nothing and moves no money by itself.
      </p>

      <dl className="tenant-actions-console__exposure purchase-review__fields">
        {fields.map((field) => (
          <PurchaseField key={field.key} field={field} decimals={action.exposureKey.decimals} asset={action.exposureKey.asset} />
        ))}
      </dl>

      {outcome !== null ? <PurchaseOutcomeSection outcome={outcome} /> : null}

      {review.exposureUnavailable ? (
        <p className="tenant-status tenant-status--warning" role="status">
          The policy exposure could not be read, so no budget figure from the server is shown here.
          This is not a zero budget.
        </p>
      ) : null}

      <PurchaseDecisionView state={state} controller={controller} />

      {showDecisions ? (
        <div className="tenant-actions-console__decisions" role="group" aria-label="Purchase decision">
          <p className="tenant-status tenant-status--warning">
            What you reviewed above is written to your encrypted workspace before anything is sent.
            Only the organization, this purchase, your decision and one mutation ID then leave this
            browser. If that workspace changed or was locked, nothing is sent at all.
          </p>
          {(["approve", "reject"] as const).map((decision) => (
            <button
              key={decision}
              type="button"
              className={decision === "approve" ? "tenant-button tenant-button--primary" : "tenant-button"}
              disabled={busy}
              onClick={() => controller?.beginDecision(decision)}
            >
              {decision === "approve" ? "Approve purchase" : "Reject purchase"}
            </button>
          ))}
        </div>
      ) : state.receiptUnavailable && decidable && state.canDecide ? (
        <p className="tenant-status tenant-status--error" role="alert">
          No encrypted workspace is unlocked in this browser, so a receipt of what you reviewed
          cannot be committed. The decision controls are disabled and nothing can be sent.
        </p>
      ) : !decidable ? (
        <p className="tenant-status" role="status">
          This purchase is no longer open to a decision.
        </p>
      ) : (
        <p className="tenant-status tenant-status--warning" role="status">
          {state.serverDeniedDecision
            ? "The server refused your last decision on this purchase, so the controls are disabled here."
            : "Your role can read this purchase but cannot decide it. Only an owner or operator may approve or reject."}
        </p>
      )}

      <div className="tenant-actions">
        <button
          type="button"
          className="tenant-button"
          onClick={() => void controller?.loadPurchase(props.actionId)}
        >
          Refresh purchase
        </button>
      </div>
    </section>
  );
}

function PurchaseField(props: {
  readonly field: PurchaseReviewField;
  readonly decimals: number;
  readonly asset: string;
}) {
  const { field } = props;
  if (!field.known || field.value === null) {
    return (
      <div>
        <dt>{field.label}</dt>
        <dd>
          <span className="tenant-actions-console__amount purchase-review__unknown">Unknown</span>
          <p className="tenant-actions-console__explain">{field.explanation}</p>
        </dd>
      </div>
    );
  }
  const isAmount = AMOUNT_KEYS.has(field.key);
  const display = isAmount ? formatAtomicAmount(field.value, props.decimals) : null;
  return (
    <div>
      <dt>{field.label}</dt>
      <dd>
        <span className="tenant-actions-console__amount">
          {isAmount ? `${display ?? field.value} ${props.asset}` : field.value}
        </span>
        {isAmount ? (
          <span className="tenant-actions-console__atomic">
            {field.value} atomic ({props.decimals} decimals)
          </span>
        ) : null}
        <p className="tenant-actions-console__explain">{field.explanation}</p>
      </dd>
    </div>
  );
}

/**
 * The honest outcome. Unresolved money is ALWAYS its own line, and when this
 * console cannot know the figure it says so instead of printing a zero.
 */
function PurchaseOutcomeSection(props: { readonly outcome: PurchaseOutcomeView }) {
  const { outcome } = props;
  const unknown = outcome.unknownExposure;
  return (
    <section className="purchase-review__outcome" aria-labelledby="purchase-outcome-title">
      <h3 className="tenant-title tenant-title--small" id="purchase-outcome-title">
        Payment outcome
      </h3>
      <p className="tenant-status" role="status">
        <strong>{outcome.label}</strong>
      </p>
      <p className="tenant-actions-console__explain">{outcome.explanation}</p>
      <dl className="tenant-meta purchase-review__unresolved">
        <dt>{unknown.label}</dt>
        <dd>
          <span className="tenant-actions-console__amount">
            {unknown.known && unknown.atomic !== null ? unknown.atomic : "Unknown"}
          </span>
          <p className="tenant-actions-console__explain">{unknown.explanation}</p>
        </dd>
      </dl>
    </section>
  );
}

export interface PurchaseDecisionViewProps {
  readonly state: PurchaseControllerState;
  readonly controller: PurchaseController | null;
}

/**
 * The decision lifecycle: confirm, in flight, committed, refused or genuinely
 * unknown. An unknown outcome offers no resend and no new key.
 */
export function PurchaseDecisionView(props: PurchaseDecisionViewProps) {
  const decision = props.state.decision;
  const controller = props.controller;
  if (decision.kind === "idle") return null;

  if (decision.kind === "confirming") {
    return (
      <section className="tenant-actions-console__confirm" aria-labelledby="purchase-confirm-title">
        <h3 className="tenant-title tenant-title--small" id="purchase-confirm-title">
          Confirm: {decision.decision === "approve" ? "Approve purchase" : "Reject purchase"}
        </h3>
        <p className="tenant-status">{PURCHASE_DECISION_SUMMARIES[decision.decision satisfies PurchaseDecision]}</p>
        <p className="tenant-status">
          Confirming first records what you reviewed in your encrypted workspace, then re-checks that
          workspace, and only then sends exactly one request. If the response is lost, nothing is
          resent automatically.
        </p>
        <p className="tenant-mono">purchase {decision.actionId}</p>
        <div className="tenant-actions">
          <button
            type="button"
            className="tenant-button tenant-button--primary"
            onClick={() => void controller?.confirmDecision()}
          >
            {decision.decision === "approve" ? "Approve now" : "Reject now"}
          </button>
          <button type="button" className="tenant-button" onClick={() => controller?.cancelDecision()}>
            Go back without deciding
          </button>
        </div>
      </section>
    );
  }

  if (decision.kind === "pending") {
    return (
      <p className="tenant-status" role="status" aria-live="polite">
        Sending one decision request… Do not resubmit.
      </p>
    );
  }

  if (decision.kind === "committed") {
    const committed = decision.committed;
    return (
      <div className="tenant-actions-console__receipt" role="status" aria-live="polite">
        <h3 className="tenant-title tenant-title--small">
          {committed.replayed ? "Decision already committed" : "Decision committed"}
        </h3>
        <p className="tenant-status">{purchaseDecisionOutcomeLabel(decision)}</p>
        <dl className="tenant-meta">
          <dt>Operation</dt>
          <dd className="tenant-mono">{committed.receipt.operation}</dd>
          <dt>Purchase</dt>
          <dd className="tenant-mono">{committed.receipt.resourceId}</dd>
          <dt>Mutation</dt>
          <dd className="tenant-mono">{committed.receipt.mutationId}</dd>
          <dt>Committed at</dt>
          <dd className="tenant-mono">{committed.receipt.committedAt}</dd>
        </dl>
        <p className="tenant-status tenant-status--warning">
          A committed decision records a human choice. It does not mean the seller has been sent
          money, or that anything was delivered or purchased.
        </p>
      </div>
    );
  }

  if (decision.kind === "rejected") {
    return (
      <p className="tenant-status tenant-status--error" role="alert">
        {purchaseRejectionMessage(decision.notice)}
      </p>
    );
  }

  return (
    <section className="tenant-actions-console__unknown" aria-labelledby="purchase-unknown-title">
      <h3 className="tenant-title tenant-title--small" id="purchase-unknown-title">
        The outcome is unknown
      </h3>
      <p className="tenant-status tenant-status--warning" role="status">
        {purchaseDecisionOutcomeLabel(decision)} The request was sent but no confirmed response
        arrived. It may still complete. Nothing is retried and no new key is created.
      </p>
      <p className="tenant-mono">
        purchase {decision.actionId} · mutation {decision.mutationId}
      </p>
    </section>
  );
}
