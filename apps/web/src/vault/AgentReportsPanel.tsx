import { useEffect, useRef, useState, type FormEvent } from "react";
import {
  AGENT_IMPORT_MAX_BYTES, ARC_TESTNET, AgentImportError, AgentMonitoringPolicySchema,
  evaluateAgentPolicy, parseAgentImport,
  type AgentImport, type AgentMonitoringPolicy, type AgentMonitoringPolicyRecord,
  type AgentPolicyEventInput, type WorkspaceRecord,
} from "@openarc/shared";
import { prepareAgentMonitoringPolicyRecord, prepareLocalAgentImport } from "./service.js";
import { vaultErrorMessage } from "./errors.js";
import type { UnlockedWorkspace } from "./types.js";
import { Modal, SectionHeading } from "./VaultWorkspace.js";

type Props = {
  workspace: UnlockedWorkspace; busy: boolean;
  onOpenTour: (target: HTMLElement) => void;
  onSave: (records: readonly WorkspaceRecord[], message: string) => Promise<boolean>;
  onDelete: (ids: readonly string[], message: string) => Promise<boolean>;
  createSessionGuard: () => { assertActive: () => void; isActive: () => boolean };
};

export function AgentReportsPanel(props: Props) {
  const [draft, setDraft] = useState("");
  const [preview, setPreview] = useState<AgentImport | null>(null);
  const [agentId, setAgentId] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reading, setReading] = useState(false);
  const readGeneration = useRef(0);
  const [editing, setEditing] = useState<AgentMonitoringPolicyRecord | null | undefined>();
  const [selectedEvent, setSelectedEvent] = useState("");
  const [selectedPolicy, setSelectedPolicy] = useState("");
  const [comparison, setComparison] = useState<{ revision: string; value: ReturnType<typeof evaluateAgentPolicy> } | null>(null);
  const agents = props.workspace.records.filter(record => record.kind === "agent_profile");
  const imports = props.workspace.records.filter(record => record.kind === "agent_import");
  const policies = props.workspace.records.filter(record => record.kind === "agent_monitoring_policy");
  const events: AgentPolicyEventInput[] = imports.flatMap(record => record.report.events.map((event, eventIndex) => ({
    importRecordId: record.recordId, agentProfileRecordId: record.linkedAgentProfileRecordId,
    connectorId: record.report.connectorId, eventIndex, event,
  })));
  const busy = props.busy || reading;
  const result = comparison?.revision === props.workspace.meta.revision ? comparison.value : null;

  useEffect(() => () => { readGeneration.current += 1; }, []);

  function previewBytes(bytes: Uint8Array) {
    setError(null); setPreview(null); setConfirmed(false);
    try { setPreview(parseAgentImport(bytes, new Date().toISOString())); }
    catch (cause) { setError(importError(cause)); }
  }

  async function previewFile(file: File | undefined) {
    const generation = ++readGeneration.current;
    setPreview(null); setConfirmed(false); setError(null);
    if (!file) return;
    if (file.size > AGENT_IMPORT_MAX_BYTES) { setError(importError(new AgentImportError("IMPORT_TOO_LARGE"))); return; }
    const guard = props.createSessionGuard(); setReading(true);
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      guard.assertActive();
      if (generation !== readGeneration.current) return;
      previewBytes(bytes);
    } catch { if (guard.isActive() && generation === readGeneration.current) setError("The local file could not be read. Nothing was saved or sent."); }
    finally { if (guard.isActive() && generation === readGeneration.current) setReading(false); }
  }

  async function saveImport() {
    if (!preview) return;
    setError(null);
    try {
      const record = prepareLocalAgentImport(props.workspace, preview, agentId, confirmed);
      if (await props.onSave([record], "Agent report encrypted locally. Authorship, approval and execution remain unverified.")) {
        setPreview(null); setDraft(""); setConfirmed(false);
      }
    } catch (cause) { setError(vaultErrorMessage(cause)); }
  }

  function compare(event: FormEvent) {
    event.preventDefault(); setError(null); setComparison(null);
    const selected = events.find(entry => eventKey(entry) === selectedEvent);
    const policy = policies.find(record => record.recordId === selectedPolicy);
    if (!selected || !policy) { setError("Select a saved report event and monitoring policy first."); return; }
    try {
      setComparison({ revision: props.workspace.meta.revision,
        value: evaluateAgentPolicy({ selected, events, policy: policy.policy, evaluatedAt: new Date().toISOString() }) });
    } catch { setError("These bounded inputs cannot be compared. Check their timestamps and references; no conclusion was saved or sent."); }
  }

  return <section className="workspace-section payment-evidence agent-reports" aria-labelledby="agent-reports-title">
    <SectionHeading eyebrow="LOCAL MONITORING ONLY" title="Agent reports" id="agent-reports-title" onLearn={props.onOpenTour}>
      Import what an agent reports doing, then compare it with your local rules. No upload, wallet connection or transaction execution.
    </SectionHeading>
    <div className="workspace-card report-intro">
      <h3>New here? Start with one report.</h3>
      <ol><li>Create an owner-supplied profile in Agents.</li><li>Preview a supported report and confirm its local profile association.</li>
        <li>Save a monitoring policy, select an event and compare locally.</li></ol>
      <p>Reports are unverified claims. A matching rule is not wallet permission; an incomplete history cannot prove a daily spending limit was respected.</p>
    </div>
    {error ? <p role="alert" className="field-error">{error}</p> : null}
    <section className="workspace-card" aria-labelledby="report-import-title">
      <h3 id="report-import-title">1. Preview a local report</h3>
      <p>Only <code>openarc.agent-import.v1</code> JSON, up to 256 KiB and 64 events. No signatures, keys, prompts, URLs or response bodies.</p>
      <form className="form-stack" onSubmit={event => { event.preventDefault(); previewBytes(new TextEncoder().encode(draft)); }}>
        <label>Agent report JSON<textarea aria-label="Agent report JSON" rows={6} maxLength={AGENT_IMPORT_MAX_BYTES} value={draft} disabled={busy}
          onChange={event => { setDraft(event.target.value); setPreview(null); setConfirmed(false); }} /></label>
        <div className="button-row"><button type="submit" className="button button-primary" disabled={busy || !draft}>Preview report</button>
          <button type="button" disabled={busy} onClick={() => { setDraft(JSON.stringify(exampleReport(), null, 2)); setPreview(null); setConfirmed(false); setError(null); }}>Load example report</button></div>
        <p>The example contains synthetic activity, not observed payments. It stays in this browser.</p>
        <label>Agent report JSON file<input type="file" accept="application/json,.json" disabled={busy}
          onChange={event => void previewFile(event.target.files?.[0])} /></label>
      </form>
      {preview ? <div className="report-preview" aria-label="Report preview">
        <h4>Report preview</h4><p>{preview.events.length} reported events · connector {preview.connectorId} · authentication not verified.</p>
        <p>Import ID: <code>{preview.importId}</code>. Nothing has been saved or sent.</p>
        <details><summary>Preview exact report fields</summary><pre>{JSON.stringify(preview, null, 2)}</pre></details>
        <label>Local agent association<select aria-label="Local agent association" value={agentId} disabled={busy} onChange={event => { setAgentId(event.target.value); setConfirmed(false); }}>
          <option value="">Choose an owner-supplied profile</option>{agents.map(agent => <option key={agent.recordId} value={agent.recordId}>{agent.displayName}</option>)}</select></label>
        <label className="confirm-row"><input type="checkbox" checked={confirmed} disabled={busy} onChange={event => setConfirmed(event.target.checked)} />I associate this report with this local agent profile; this does not verify its identity.</label>
        {agents.length === 0 ? <p>Create a profile in Agents before saving this report.</p> : null}
        <button type="button" className="button button-primary" disabled={busy || !agentId || !confirmed} onClick={() => void saveImport()}>Encrypt report locally</button>
      </div> : null}
    </section>
    <section className="workspace-card" aria-labelledby="report-policies-title">
      <h3 id="report-policies-title">2. Set monitoring rules</h3>
      <p>These policies apply to imported reports, not the synthetic fixture policies in Policies. Daily totals count supplied attempts, not confirmed wallet spend.</p>
      <button type="button" className="button button-primary" disabled={busy || agents.length === 0} onClick={() => setEditing(null)}>Add report monitoring policy</button>
      {policies.map(record => <article className="report-policy" key={record.recordId}>
        <h4>{record.policy.name}</h4><p>Revision {record.policy.revision} · {record.policy.enabled ? "enabled" : "disabled"} · LOCAL MONITORING ONLY</p>
        <details><summary>Exact monitoring policy</summary><pre>{JSON.stringify(record.policy, null, 2)}</pre></details>
        <div className="button-row"><button type="button" disabled={busy} onClick={() => setEditing(record)}>Edit {record.policy.name}</button>
          <button type="button" className="danger-link" disabled={busy} onClick={() => void props.onDelete([record.recordId], "Report monitoring policy deleted locally.")}>Delete {record.policy.name}</button></div>
      </article>)}
    </section>
    <section className="workspace-card" aria-labelledby="report-compare-title">
      <h3 id="report-compare-title">3. Compare a reported attempt</h3>
      <form className="form-stack" onSubmit={compare}>
        <label>Report event<select aria-label="Report event" value={selectedEvent} disabled={busy} onChange={event => { setSelectedEvent(event.target.value); setComparison(null); }}>
          <option value="">Choose a saved event</option>{events.map((entry, index) => <option key={`${eventKey(entry)}:${index}`} value={eventKey(entry)}>{entry.event.eventId} · {entry.event.actionId}</option>)}</select></label>
        <label>Monitoring policy<select aria-label="Monitoring policy" value={selectedPolicy} disabled={busy} onChange={event => { setSelectedPolicy(event.target.value); setComparison(null); }}>
          <option value="">Choose a saved policy</option>{policies.map(record => <option key={record.recordId} value={record.recordId}>{record.policy.name}</option>)}</select></label>
        <button type="submit" className="button button-primary" disabled={busy || !selectedEvent || !selectedPolicy}>Compare locally</button>
      </form>
      {result ? <div className="report-comparison" aria-live="polite">
        <h4>Comparison: {result.status.replaceAll("_", " ")}</h4>
        <p>LOCAL MONITORING ONLY · enforcement not verified. Evaluated against the selected policy revision at the reported attempt time.</p>
        <ul className="report-findings">{result.findings.filter(finding => finding.status !== "not_applicable" || finding.rule === "scope").map((finding, index) => <li key={`${finding.rule}:${finding.code}:${index}`}>
          <strong>{finding.rule.replaceAll("_", " ")}: </strong>{findingMessage(finding.code)}
          <span> ({finding.status.replaceAll("_", " ")})</span>
        </li>)}</ul>
        {result.warnings.length ? <p>Duplicate source-event reports were detected and counted once. Inspect the citations below.</p> : null}
        <details><summary>Rules and evidence citations</summary><pre>{JSON.stringify(result, null, 2)}</pre></details>
      </div> : null}
    </section>
    <section aria-labelledby="saved-reports-title"><h3 id="saved-reports-title">Saved agent reports</h3>
      <p>{imports.length} / 32 reports · {events.length} / 512 supplied events. No background requests or automatic comparisons.</p>
      {imports.map(record => <article className="workspace-card" key={record.recordId}>
        <h4>Imported agent report {record.report.importId}</h4>
        <p>Agent-reported · authentication not verified · {record.report.connectorId} · captured {record.report.capturedAt}</p>
        <p>Local association: {agents.find(agent => agent.recordId === record.linkedAgentProfileRecordId)?.displayName}. Owner-confirmed, not authenticated identity.</p>
        <details><summary>Reported events</summary>{record.report.events.map((event, index) => <div key={`${event.eventId}:${index}`}>
          <h5>{event.actionId}</h5><p>{event.amountBaseUnits} USDC base units (6 decimals) · reported {event.reportedStatus} · {event.occurredAt}</p>
          <pre>{JSON.stringify(event, null, 2)}</pre></div>)}</details>
        <button type="button" className="danger-link" disabled={busy} onClick={() => void props.onDelete([record.recordId], "Agent report deleted locally; comparisons will be recomputed from remaining evidence.")}>Delete report</button>
      </article>)}
    </section>
    {editing !== undefined ? <ReportPolicyDialog key={editing?.recordId ?? "new"} existing={editing} agents={agents}
      busy={busy} onClose={() => setEditing(undefined)} onSave={async policy => {
        const record = prepareAgentMonitoringPolicyRecord(props.workspace, policy, editing ?? undefined);
        if (await props.onSave([record], "Monitoring policy encrypted locally. No wallet permission was granted.")) setEditing(undefined);
      }} /> : null}
  </section>;
}

function ReportPolicyDialog({ existing, agents, busy, onClose, onSave }: {
  existing: AgentMonitoringPolicyRecord | null; agents: { recordId: string; displayName: string }[];
  busy: boolean; onClose: () => void; onSave: (policy: AgentMonitoringPolicy) => Promise<void>;
}) {
  const [error, setError] = useState<string | null>(null);
  const policy = existing?.policy;
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setError(null);
    const form = new FormData(event.currentTarget);
    const text = (key: string) => String(form.get(key) ?? "").trim();
    const list = (key: string) => text(key) ? text(key).split(/\r?\n/u).map(value => value.trim()).filter(Boolean) : [];
    const parsed = AgentMonitoringPolicySchema.safeParse({ schemaVersion: "openarc.agent-policy.v2",
      policyId: policy?.policyId ?? crypto.randomUUID(), revision: policy?.revision ?? 1,
      name: text("name"), agentProfileRecordId: text("agent"), enabled: form.has("enabled"),
      validAfter: text("validAfter"), validBefore: text("validBefore"),
      perActionLimit: text("perActionLimit") || null, dailyLimit: text("dailyLimit") || null,
      allowRecipients: list("allowRecipients"), blockRecipients: list("blockRecipients"),
      allowContracts: list("allowContracts"), blockContracts: list("blockContracts"),
      allowServices: list("allowServices"), blockServices: list("blockServices"),
      requireApproval: form.has("requireApproval"), mode: "local_monitoring_only" });
    if (!parsed.success) { setError("Use a name, local agent, ordered UTC validity window, whole nonnegative base-unit limits and at most 16 unique values per list."); return; }
    try { await onSave(parsed.data); } catch (cause) { setError(vaultErrorMessage(cause)); }
  }
  return <Modal title="Report monitoring policy" onClose={onClose} closeDisabled={busy}>
    <form className="workspace-form" onSubmit={event => void submit(event)}>
      <p>LOCAL MONITORING ONLY. Lists use one exact address or SHA-256 service digest per line. A blocked value wins over an allowed one.</p>
      {error ? <p role="alert" className="field-error">{error}</p> : null}
      <label className="field">Policy name<input name="name" defaultValue={policy?.name ?? ""} required maxLength={80} disabled={busy} /></label>
      <label className="field">Policy agent<select aria-label="Policy agent" name="agent" defaultValue={policy?.agentProfileRecordId ?? agents[0]?.recordId} required disabled={busy}>
        {agents.map(agent => <option key={agent.recordId} value={agent.recordId}>{agent.displayName}</option>)}</select></label>
      <label className="field">Valid after (UTC)<input name="validAfter" defaultValue={policy?.validAfter ?? "1970-01-01T00:00:00.000Z"} required maxLength={30} disabled={busy} /></label>
      <label className="field">Valid before (UTC)<input name="validBefore" defaultValue={policy?.validBefore ?? "2100-01-01T00:00:00.000Z"} required maxLength={30} disabled={busy} /></label>
      <label className="field">Per-action limit (USDC base units)<input name="perActionLimit" inputMode="numeric" maxLength={78} defaultValue={policy?.perActionLimit ?? ""} disabled={busy} /></label>
      <label className="field">Daily limit (USDC base units)<input name="dailyLimit" inputMode="numeric" maxLength={78} defaultValue={policy?.dailyLimit ?? ""} disabled={busy} /></label>
      <p>1 USDC = 1,000,000 base units. Blank means no amount rule. Daily means the reported event's UTC day, not 24 hours from now; supplied history is incomplete.</p>
      {([
        ["allowRecipients", "Allowed recipients"], ["blockRecipients", "Blocked recipients"],
        ["allowContracts", "Allowed contracts"], ["blockContracts", "Blocked contracts"],
        ["allowServices", "Allowed service digests"], ["blockServices", "Blocked service digests"],
      ] as const).map(([key, label]) => <label className="field" key={key}>{label}<textarea name={key} rows={2} maxLength={1200} defaultValue={policy?.[key].join("\n") ?? ""} disabled={busy} /></label>)}
      <label className="confirm-row"><input type="checkbox" name="requireApproval" defaultChecked={policy?.requireApproval ?? false} disabled={busy} />Require reported human approval</label>
      <label className="confirm-row"><input type="checkbox" name="enabled" defaultChecked={policy?.enabled ?? true} disabled={busy} />Policy enabled</label>
      <button type="submit" className="button button-primary" disabled={busy}>Save monitoring policy</button>
      <button type="button" disabled={busy} onClick={onClose}>Cancel</button>
    </form>
  </Modal>;
}

function eventKey(entry: AgentPolicyEventInput) { return `${entry.importRecordId}:${entry.eventIndex}`; }
function findingMessage(code: string): string {
  const messages: Record<string, string> = {
    POLICY_DISABLED: "This policy is disabled.", POLICY_AGENT_MISMATCH: "The policy belongs to a different local agent profile.",
    LOCAL_AGENT_ASSOCIATION_ONLY: "The agent association is an owner-supplied claim, not verified identity.",
    POLICY_NOT_YET_ACTIVE: "The reported attempt predates this policy's validity window.",
    POLICY_EXPIRED: "The reported attempt is at or after this policy's expiry.",
    WITHIN_REPORTED_ATTEMPT_WINDOW: "The reported attempt falls inside the policy window.",
    SOURCE_EVENT_CONTENT_CONFLICT: "Reports reuse a source event ID with contradictory contents.",
    NO_CONFLICT_IN_SUPPLIED_SOURCE_IDENTITIES: "No relevant source-ID contradiction was found in the supplied reports.",
    POSSIBLE_AUTHORIZATION_REPLAY_NOT_EXECUTION_PROOF: "Distinct reported actions reuse an authorization context. This is a possible replay, not proof of execution.",
    AUTHORIZATION_UNIQUENESS_UNEVALUABLE: "A nonce or authorization-domain digest is missing; uniqueness cannot be compared.",
    NO_REUSE_IN_SUPPLIED_ACTIONS_ONLY: "No reuse was found in these supplied actions; unseen history remains unknown.",
    PER_ACTION_LIMIT_NOT_CONFIGURED: "No per-action amount limit is configured.",
    PER_ACTION_LIMIT_EXCEEDED: "The reported amount exceeds the per-action limit.",
    REPORTED_AMOUNT_WITHIN_PER_ACTION_LIMIT: "The supplied amount is within the per-action limit.",
    DAILY_LIMIT_NOT_CONFIGURED: "No daily limit is configured.",
    DAILY_HISTORY_INCOMPLETE: "Imported history is incomplete, so it cannot establish daily compliance.",
    CONFLICTING_ATTEMPTS_EXCLUDED_FROM_TOTAL: "Contradictory source events were excluded from the attempt subtotal; inspect the conflicts.",
    SUPPLIED_DAILY_ATTEMPTS_EXCEED_LIMIT: "Even the supplied attempt subtotal exceeds this UTC-day limit.",
    LISTS_NOT_CONFIGURED: "No allow or block list is configured for this field.",
    REQUIRED_FACT_NOT_SUPPLIED: "The report is missing a fact required by this rule.",
    BLOCK_LIST_MATCH: "The reported value matches a blocked value.",
    OUTSIDE_ALLOW_LIST: "The reported value is absent from the configured allow list.",
    WITHIN_SUPPLIED_LIST_RULES: "The supplied value matches the configured list rules.",
    APPROVAL_NOT_REQUIRED: "This policy does not require a reported approval.",
    APPROVAL_NOT_SUPPLIED: "The report supplies no human-approval claim.",
    REPORTED_APPROVAL_DENIED: "The report says human approval was denied.",
    REPORTED_APPROVAL_NOT_VERIFIED: "The report claims approval; OpenArc has not verified it.",
  };
  return messages[code] ?? "Inspect the exact rule and cited inputs below.";
}
function importError(cause: unknown): string {
  if (!(cause instanceof AgentImportError)) return "This report could not be parsed. Nothing was saved or sent.";
  const messages = {
    IMPORT_TOO_LARGE: "Report exceeds the 256 KiB local import limit.", INVALID_UTF8: "Use valid UTF-8 JSON.",
    INVALID_JSON: "Use valid JSON for the supported report format.", INVALID_IMPORT: "This report has unsupported fields, invalid values or excessive events.",
    UNSUPPORTED_VERSION: "This report version is not supported. Use openarc.agent-import.v1.",
    UNSUPPORTED_SIGNATURE: "Signed reports are not supported. OpenArc does not accept or verify report or payment signatures here.",
    FUTURE_CAPTURE: "The report capture is in the future. Check its timestamp before importing.",
  };
  return `${messages[cause.code]} Nothing was saved or sent.`;
}
function exampleReport(): AgentImport {
  const at = new Date().toISOString();
  return { schemaVersion: "openarc.agent-import.v1", importId: crypto.randomUUID(), capturedAt: at,
    connectorId: "synthetic-example", authentication: "not_verified", events: [{ eventId: crypto.randomUUID(),
      actionId: "synthetic-example-attempt", occurredAt: at, network: ARC_TESTNET.caip2, asset: ARC_TESTNET.contracts.usdc,
      decimals: 6, payer: `0x${"1".repeat(40)}`, recipient: `0x${"2".repeat(40)}`, amountBaseUnits: "1000",
      reportedStatus: "attempted", contract: null, serviceDigest: null, authorizationNonce: null,
      authorizationDomainDigest: null, approval: "not_supplied" }] };
}
