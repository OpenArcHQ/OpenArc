import { useState, type FormEvent } from "react";
import {
  ARC_TESTNET, GATEWAY_DISCLOSURE, GATEWAY_TRANSFER_PATH, GatewayTransferRequestSchema,
  X402BundleRecordSchema, X402ReceiptBundleSchema, reconcileX402, compareIsoTimestamps,
  type GatewayTransferRequest, type GatewayObservationRecord, type WorkspaceRecord,
  type X402ReconciliationInput,
} from "@openarc/shared";
import type { UnlockedWorkspace } from "./types.js";
import { Modal, SectionHeading } from "./VaultWorkspace.js";

export function PaymentsPanel(props: {
  workspace: UnlockedWorkspace; busy: boolean;
  onOpenTour: (target: HTMLElement) => void;
  onSave: (records: readonly WorkspaceRecord[], message: string) => Promise<boolean>;
  onDelete: (ids: readonly string[], message: string) => Promise<boolean>;
  onObserveGateway: (request: GatewayTransferRequest, linkedBundleRecordId: string | null) => Promise<GatewayObservationRecord | null>;
}) {
  const [draft, setDraft] = useState("");
  const [transferId, setTransferId] = useState("");
  const [linked, setLinked] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [batchLinks, setBatchLinks] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<{ request: GatewayTransferRequest; linked: string | null } | null>(null);
  const bundles = props.workspace.records.filter((record) => record.kind === "x402_bundle");
  const observations = props.workspace.records.filter((record) => record.kind === "gateway_observation");
  const transactions = props.workspace.records.filter((record) => record.kind === "arc_observation")
    .filter((record) => record.observation.schemaVersion === "openarc.arc-transaction-evidence.v1");

  async function importBundle(event: FormEvent) {
    event.preventDefault(); setError(null);
    let value: unknown;
    try {
      if (new TextEncoder().encode(draft).byteLength > 16_384) throw new Error("Too large");
      value = JSON.parse(draft);
    } catch { setError("Use a normalized JSON metadata bundle of at most 16 KiB. Do not paste keys, signatures, headers or response bodies."); return; }
    const parsed = X402ReceiptBundleSchema.safeParse(value);
    if (!parsed.success) { setError("This is not a supported metadata bundle. Unknown fields are rejected; no data was saved or sent."); return; }
    if (bundles.some((record) => record.bundle.bundleId === parsed.data.bundleId)) {
      setError("That bundle ID is already stored. Existing evidence was not overwritten."); return;
    }
    const at = new Date().toISOString();
    if (compareIsoTimestamps(parsed.data.capturedAt, at) > 0) {
      setError("The reported capture is in the future. Check the bundle timestamp; nothing was saved or sent."); return;
    }
    const record = X402BundleRecordSchema.parse({ recordSchema: "openarc.x402-bundle-record.v1",
      kind: "x402_bundle", recordId: crypto.randomUUID(), recordRevision: props.workspace.meta.revision,
      createdAt: at, updatedAt: at, bundle: parsed.data });
    if (await props.onSave([record], "Metadata encrypted locally. Signatures and fulfillment are not verified.")) setDraft("");
  }

  function review(event: FormEvent) {
    event.preventDefault(); setError(null);
    const request = GatewayTransferRequestSchema.safeParse({ network: ARC_TESTNET.caip2, transferId });
    if (!request.success || (linked && !confirmed)) {
      setError("Use a lowercase transfer UUID and explicitly confirm any local bundle association."); return;
    }
    setPending({ request: request.data, linked: linked || null });
  }

  return <section className="workspace-section payment-evidence" aria-labelledby="payments-title">
    <SectionHeading eyebrow="ARC TESTNET · EVIDENCE, NOT EXECUTION" title="Payments" id="payments-title" onLearn={props.onOpenTour}>
      Compare what a service requested with imported payment metadata and what Gateway reports. OpenArc never pays, signs, or verifies service quality.
    </SectionHeading>
    <details className="workspace-card"><summary>New here? Follow the payment evidence workflow</summary>
      <ol><li>Import a normalized metadata bundle from an external test workflow. This is local and makes no network request.</li>
        <li>Enter its exact Gateway transfer UUID. Review the disclosure before allowing a read.</li>
        <li>Inspect agreements, gaps and conflicts. A completed Gateway transfer is not proof that a service delivered.</li></ol>
      <p>No wallet connection is needed. Raw payment signatures and private service responses are not supported imports.</p>
    </details>
    <form className="workspace-card form-stack" onSubmit={(event) => void importBundle(event)}>
      <h3>1. Import metadata locally</h3>
      <label>Normalized x402 metadata JSON<textarea value={draft} onChange={(event) => setDraft(event.target.value)}
        rows={5} maxLength={16_384} required spellCheck={false} autoComplete="off" /></label>
      <p>Use the openarc.x402-receipt-bundle.v1 contract. At most 16 KiB; no signatures, keys, URLs, raw headers or paid bodies.</p>
      <button className="button" type="submit" disabled={props.busy}>Encrypt metadata locally</button>
    </form>
    <form className="workspace-card form-stack" onSubmit={review}>
      <h3>2. Read a Gateway report</h3>
      <label>Gateway transfer UUID<input value={transferId} onChange={(event) => setTransferId(event.target.value)}
        maxLength={36} required autoComplete="off" spellCheck={false} /></label>
      <label>Local metadata association<select value={linked} onChange={(event) => { setLinked(event.target.value); setConfirmed(false); }}>
        <option value="">No association</option>{bundles.map((record) => <option key={record.recordId} value={record.recordId}>{record.bundle.bundleId}</option>)}
      </select></label>
      {linked ? <label className="confirm-row"><input type="checkbox" checked={confirmed}
        onChange={(event) => setConfirmed(event.target.checked)} /> I associate this report with this local bundle. Association alone does not prove a match.</label> : null}
      <button className="button" type="submit" disabled={props.busy}>Review Gateway permission</button>
    </form>
    {error ? <p role="alert">{error}</p> : null}
    <h3>3. Inspect the evidence</h3>
    {bundles.length === 0 && observations.length === 0 ? <p>No payment evidence yet. Nothing is fetched automatically.</p> : null}
    {bundles.map((record) => {
      const linkedObservations = observations.filter((observation) => observation.linkedBundleRecordId === record.recordId);
      const inputs = linkedObservations.length ? linkedObservations : [undefined];
      return <article className="workspace-card" key={record.recordId}>
        <h4>Imported bundle <code>{record.bundle.bundleId}</code></h4>
        <p>Owner-imported metadata · authentication not verified · captured {record.bundle.capturedAt}</p>
        {inputs.map((gateway) => {
          const batch = gateway ? transactions.find((candidate) => candidate.recordId === batchLinks[gateway.recordId]) : undefined;
          const result = safeReconcile({ bundleRecordId: record.recordId, bundle: record.bundle,
            ...(gateway ? { gateway: { recordId: gateway.recordId, observation: gateway.observation } } : {}),
            ...(batch?.observation.schemaVersion === "openarc.arc-transaction-evidence.v1"
              ? { onchain: { recordId: batch.recordId, observation: batch.observation } } : {}),
            otherBundles: bundles.filter((other) => other.recordId !== record.recordId).slice(0, 63)
              .map((other) => ({ recordId: other.recordId, bundle: other.bundle })),
            evaluatedAt: [new Date().toISOString(), ...bundles.map((other) => other.bundle.capturedAt),
              ...(gateway ? [gateway.observation.source.observedAt] : []),
              ...(batch ? [batch.observation.source.observedAt, batch.observation.anchor.blockTimestamp] : [])]
              .reduce((latest, time) => compareIsoTimestamps(time, latest) > 0 ? time : latest) });
          return <div key={gateway?.recordId ?? "no-gateway"}>
            {gateway ? <label>Compare a saved batch transaction (local only)
              <select value={batchLinks[gateway.recordId] ?? ""} onChange={(event) => {
                const selected = event.target.value;
                setBatchLinks((previous) => ({ ...previous, [gateway.recordId]: selected }));
              }}><option value="">No onchain comparison</option>{transactions.map((transaction) =>
                transaction.observation.schemaVersion === "openarc.arc-transaction-evidence.v1" ?
                  <option key={transaction.recordId} value={transaction.recordId}>{transaction.observation.transaction.hash}</option> : null)}
              </select></label> : null}
            <p>Metadata agreement: <strong>{result?.metadataAgreement ?? "Cannot compare these inputs safely"}</strong></p>
            <p>Authorization signature: not verified. Fulfillment: not verified.</p>
            <p>Gateway: {gateway ? `reports ${gateway.observation.transfer.status}` : "not observed"}.</p>
            <p>Batch inclusion: {result?.batchInclusion ?? "not verified"}. Even a matching successful batch does not prove individual payment inclusion or fulfillment.</p>
            <details><summary>Reasons and exact evidence citations</summary>
              <pre>{JSON.stringify(result, null, 2)}</pre>
              <p>Replay comparison is limited to the cited local bundles (up to 64); it is not a global replay search.</p>
            </details>
          </div>;
        })}
        <details><summary>Imported metadata · unverified</summary><pre>{JSON.stringify(record.bundle, null, 2)}</pre></details>
        <div className="row-actions"><button type="button" className="danger-link" disabled={props.busy || linkedObservations.length > 0}
          onClick={() => void props.onDelete([record.recordId], "Imported metadata deleted locally.")}>Delete metadata</button></div>
        {linkedObservations.length ? <p>Delete associated reports first to preserve evidence relationships.</p> : null}
      </article>;
    })}
    {observations.map((record) => <article className="workspace-card" key={record.recordId}>
      <h4>Gateway reports {record.observation.transfer.status}</h4>
      <p>Transfer <code>{record.observation.transfer.id}</code> · {formatUsdc(record.observation.transfer.amount)} USDC ({record.observation.transfer.amount} base units, 6 decimals).</p>
      <p>Observed {record.observation.source.observedAt}. This is a saved snapshot, not a continuously updated balance or status.</p>
      <p>Batch transaction: <code>{record.observation.transfer.txHash ?? "Not reported"}</code>. A batch hash can cover multiple payments; onchain inclusion was not verified here.</p>
      <details><summary>Exact Gateway fields and source</summary><pre>{JSON.stringify(record.observation, null, 2)}</pre></details>
      <div className="row-actions"><button type="button" disabled={props.busy} onClick={() => {
        setTransferId(record.observation.transfer.id); setLinked(record.linkedBundleRecordId ?? ""); setConfirmed(false);
      }}>Prepare another explicit read</button>
      <button type="button" className="danger-link" disabled={props.busy} onClick={() => void props.onDelete(
        [record.recordId, record.permissionReceiptId], "Gateway report and its permission receipt deleted locally.")}>Delete Gateway report</button></div>
    </article>)}
    {pending ? <Modal title="Allow this Gateway read?" onClose={() => setPending(null)}>
      <p>Only the following network and exact transfer UUID leave your encrypted workspace. No payment is made.</p>
      <dl><dt>OpenArc destination</dt><dd>{window.location.origin}{GATEWAY_TRANSFER_PATH}</dd>
        <dt>Upstream</dt><dd>https://gateway-api-testnet.circle.com</dd>
        <dt>Released network</dt><dd>{pending.request.network}</dd><dt>Released transfer UUID</dt><dd>{pending.request.transferId}</dd></dl>
      <p>Bundle contents, labels, local associations, payer, nonce and resource digests are not sent.</p>
      <p>{GATEWAY_DISCLOSURE.openArcRetention}</p><p>{GATEWAY_DISCLOSURE.providerRetention}</p><p>{GATEWAY_DISCLOSURE.hostingMetadata}</p>
      <p>Credentials omitted. Approval is encrypted before the request; the report and completed receipt are saved together.</p>
      <button type="button" disabled={props.busy} onClick={() => setPending(null)}>Cancel</button>
      <button className="button" type="button" disabled={props.busy} onClick={() => {
        const approved = pending; setPending(null);
        void props.onObserveGateway(approved.request, approved.linked);
      }}>Approve and read Gateway</button>
    </Modal> : null}
  </section>;
}

function safeReconcile(input: X402ReconciliationInput) {
  try { return reconcileX402(input); }
  catch { return null; }
}

function formatUsdc(units: string) {
  const digits = units.padStart(7, "0");
  const fraction = digits.slice(-6).replace(/0+$/u, "");
  return `${digits.slice(0, -6)}${fraction ? `.${fraction}` : ""}`;
}
