import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  buildInvestigationIndex, filterInvestigations, buildInvestigationDetail,
  INVESTIGATION_LIMITS, INVESTIGATION_SOURCE_CLASSES, INVESTIGATION_STATUSES,
  type InvestigationDetail, type InvestigationFilter, type InvestigationEntry,
  serializeInvestigationReport, INVESTIGATION_REPORT_FILENAME, buildInvestigationSourceHistory,
} from "@openarc/shared";
import { apiBoundaryEnabled, arcObservationEnabled, agentRegistryEnabled, agentJobsEnabled, gatewayEvidenceEnabled } from "../app/availability.js";
import type { UnlockedWorkspace } from "./types.js";
import { SectionHeading } from "./VaultWorkspace.js";

type Props = { workspace: UnlockedWorkspace; busy: boolean;
  onOpenTour: (target: HTMLElement) => void;
  createSessionGuard: () => { assertActive: () => void; isActive: () => boolean } };
const readable = (value: string) => value.replaceAll("_", " ");

/** Mounted only while unlocked, keyed by the parent to the exact workspace revision. */
export function InvestigationsPanel(props: Props) {
  const [filter, setFilter] = useState<InvestigationFilter>({ page: 1 });
  const [selected, setSelected] = useState<InvestigationEntry | null>(null);
  const [detailPage, setDetailPage] = useState(1);
  const [graph, setGraph] = useState(false);
  const [policyDraft, setPolicyDraft] = useState("");
  const [policyRecordId, setPolicyRecordId] = useState<string | undefined>();
  const [evaluatedAt] = useState(() => new Date().toISOString());
  const [exportOptions, setExportOptions] = useState({ includeIdentifiers: false, includeAmounts: false, includeTimestamps: false });
  const [exportPreview, setExportPreview] = useState<string | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);
  const mounted = useRef(true);
  const detailHeading = useRef<HTMLHeadingElement>(null);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useLayoutEffect(() => {
    const heading = detailHeading.current;
    if (!selected || !heading) return;
    // Finish this accessibility jump before paint: delayed focus scrolling can
    // move the next control between pointer-down and pointer-up in WebKit.
    heading.focus({ preventScroll: true });
    heading.scrollIntoView({ behavior: "instant", block: "start" });
  }, [selected]);
  useEffect(() => { setExportPreview(null); setExportError(null); }, [selected, detailPage, policyRecordId, exportOptions]);
  const sourceHistory = useMemo(() => {
    const enabledConnectors: string[] = [];
    if (apiBoundaryEnabled()) {
      enabledConnectors.push("openarc_capabilities");
      if (arcObservationEnabled()) {
        enabledConnectors.push("arc_account_snapshot", "arc_transaction_evidence");
        if (agentRegistryEnabled()) {
          enabledConnectors.push("arc_agent_registry_evidence");
          if (agentJobsEnabled()) { enabledConnectors.push("arc_job_evidence"); if (gatewayEvidenceEnabled()) enabledConnectors.push("circle_gateway_transfer"); }
        }
      }
    }
    try { return buildInvestigationSourceHistory(props.workspace.records, { evaluatedAt, enabledConnectors }); }
    catch { return null; }
  }, [props.workspace.records, evaluatedAt]);
  const index = useMemo(() => {
    try { return { entries: buildInvestigationIndex(props.workspace.records), error: null }; }
    catch { return { entries: null, error: "This workspace exceeds the investigation bounds or contains unsupported references. No partial index is shown." }; }
  }, [props.workspace.records]);
  const page = useMemo(() => index.entries ? filterInvestigations(index.entries, filter) : null, [index.entries, filter]);
  const detail = useMemo(() => {
    if (!selected) return { value: null, error: null };
    try { return { value: buildInvestigationDetail(props.workspace.records, selected.reference,
      { evaluatedAt, page: detailPage, ...(policyRecordId ? { policyRecordId } : {}) }), error: null }; }
    catch { return { value: null, error: "This selection cannot be resolved safely from the saved records. No conclusion is available." }; }
  }, [props.workspace.records, selected, evaluatedAt, detailPage, policyRecordId]);
  const selectedImport = props.workspace.records.find(record => record.kind === "agent_import" && record.recordId === selected?.reference.recordId);
  const policies = props.workspace.records.filter(record => record.kind === "agent_monitoring_policy").filter(record =>
    selectedImport?.kind === "agent_import" && record.policy.agentProfileRecordId === selectedImport.linkedAgentProfileRecordId);
  function updateFilter(next: Partial<InvestigationFilter>) { setFilter(current => ({ ...current, ...next, page: 1 })); }
  function select(entry: InvestigationEntry) {
    setSelected(entry); setDetailPage(1); setGraph(false); setPolicyDraft(""); setPolicyRecordId(undefined);
    setExportPreview(null); setExportOptions({ includeIdentifiers: false, includeAmounts: false, includeTimestamps: false });
  }
  function previewReport() {
    setExportPreview(null); setExportError(null);
    if (!detail.value) return;
    const guard = props.createSessionGuard();
    try { const json = serializeInvestigationReport(detail.value, exportOptions); guard.assertActive(); if (mounted.current) setExportPreview(json); }
    catch { if (guard.isActive() && mounted.current) setExportError("This report could not be safely generated within the export bounds. Nothing was downloaded."); }
  }
  function downloadReport() {
    if (!exportPreview) return;
    const guard = props.createSessionGuard();
    let url: string | null = null;
    try {
      guard.assertActive(); if (!mounted.current) return;
      url = URL.createObjectURL(new Blob([exportPreview], { type: "application/json" }));
      const link = document.createElement("a"); link.href = url; link.download = INVESTIGATION_REPORT_FILENAME;
      guard.assertActive(); document.body.append(link); link.click(); link.remove();
    } catch { if (guard.isActive() && mounted.current) setExportError("Download canceled. Generate a new preview from this unlocked workspace."); }
    finally { if (url) URL.revokeObjectURL(url); }
  }
  return <section className="workspace-section investigations" aria-labelledby="investigations-title">
    <SectionHeading eyebrow="SAVED EVIDENCE · LOCAL ONLY" title="Investigations" id="investigations-title" onLearn={props.onOpenTour}>
      Find a saved action, inspect what agrees and what is missing, then share only the facts you choose. No source is contacted here.
    </SectionHeading>
    <div className="workspace-card"><h3>Start with a question</h3><p>Search the records already in this encrypted workspace. Exceptions are clues in supplied evidence, not a complete wallet audit or a fraud verdict. Synthetic examples remain clearly separate.</p></div>
    {index.error ? <p role="alert">{index.error}</p> : null}
    <section className="workspace-card" aria-labelledby="investigation-search-title">
      <h3 id="investigation-search-title">Search and exception inbox</h3>
      <div className="investigation-filters">
        <label>Search saved actions<input aria-label="Search saved actions" maxLength={INVESTIGATION_LIMITS.queryCharacters} value={filter.query ?? ""} onChange={event => updateFilter({ query: event.target.value })} /></label>
        <label>Status filter<select aria-label="Status filter" value={filter.status ?? "all"} onChange={event => updateFilter({ status: event.target.value as NonNullable<InvestigationFilter["status"]> })}>
          <option value="all">All statuses</option>{INVESTIGATION_STATUSES.map(status => <option key={status} value={status}>{readable(status)}</option>)}</select></label>
        <label>Source class filter<select aria-label="Source class filter" value={filter.sourceClass ?? "all"} onChange={event => updateFilter({ sourceClass: event.target.value as NonNullable<InvestigationFilter["sourceClass"]> })}>
          <option value="all">All source classes</option>{INVESTIGATION_SOURCE_CLASSES.map(source => <option key={source} value={source}>{readable(source)}</option>)}</select></label>
        <label className="confirm-row"><input type="checkbox" checked={filter.exceptionsOnly ?? false} onChange={event => updateFilter({ exceptionsOnly: event.target.checked })} />Exceptions only</label>
      </div>
      <p role="status">{page ? `${page.total} matching saved entries · page ${page.page} of ${Math.max(1, page.pageCount)}` : "Index unavailable"}</p>
      {page?.total === 0 ? <p>No matching saved actions. Import evidence in its own workspace section or change these local filters.</p> : null}
      <ul className="investigation-results">{page?.entries.map(entry => <li key={entry.key}>
        <button type="button" className="investigation-result" aria-pressed={selected?.key === entry.key} onClick={() => select(entry)}>
          <strong>Inspect {entry.title}</strong><span>{readable(entry.sourceClass)} · {readable(entry.status)}</span><time dateTime={entry.time}>{entry.time}</time>
        </button></li>)}</ul>
      {page && page.pageCount > 1 ? <div className="button-row"><button type="button" disabled={page.page <= 1} onClick={() => setFilter(current => ({ ...current, page: page.page - 1 }))}>Previous results</button><button type="button" disabled={page.page >= page.pageCount} onClick={() => setFilter(current => ({ ...current, page: page.page + 1 }))}>Next results</button></div> : null}
    </section>
    {detail.error ? <p role="alert">{detail.error}</p> : null}
    {selected?.kind === "agent_import" ? <form className="workspace-card" onSubmit={event => { event.preventDefault(); setPolicyRecordId(policyDraft || undefined); }}>
      <h3>Optional local policy comparison</h3><p>Select a saved applicable monitoring policy explicitly. This does not authorize execution or establish complete spending history.</p>
      <label>Investigation monitoring policy<select aria-label="Investigation monitoring policy" value={policyDraft} onChange={event => setPolicyDraft(event.target.value)}><option value="">No policy comparison</option>{policies.map(policy => <option key={policy.recordId} value={policy.recordId}>{policy.policy.name}</option>)}</select></label>
      <button className="button" type="submit" disabled={props.busy}>Compare selected policy</button>
    </form> : null}
    <section className="workspace-card" aria-labelledby="investigation-sources-title"><h3 id="investigation-sources-title">Saved source history</h3>
      <details><summary>Review saved source checks</summary>
      <p>Not a live provider monitor. Age is measured at {evaluatedAt}; older than 24 hours is an aged snapshot, not proof of an outage. Disabled source controls never erase saved evidence.</p>
      {sourceHistory === null ? <p role="alert">Saved source history cannot be projected safely from these bounded records.</p> : null}
      <ul className="investigation-source-history">{sourceHistory?.map(source => <li key={source.connectorId}><h4>{source.label}</h4><p>{readable(source.status)} · {source.savedObservations} saved observations · {source.unresolvedApprovals} unresolved approvals</p><details><summary>Saved timestamps</summary><dl><div><dt>Last saved attempt</dt><dd>{source.lastAttemptAt ?? "Never checked"}</dd></div><div><dt>Last saved observation</dt><dd>{source.lastObservationAt ?? "None"}</dd></div></dl></details></li>)}</ul>
      <details><summary>Source-history limitations</summary><ul>{[...new Set(sourceHistory?.flatMap(source => source.limitations))].map(text => <li key={text}>{text}</li>)}</ul></details>
      </details>
    </section>
    {detail.value ? <section className="workspace-card" aria-labelledby="investigation-detail-title">
      <h3 id="investigation-detail-title" tabIndex={-1} ref={detailHeading}>Selected investigation</h3><h4>{detail.value.root.title}</h4>
      <p>{readable(detail.value.root.sourceClass)} · {readable(detail.value.root.status)}</p>
      <p>{detail.value.totalNodes} total evidence nodes · {detail.value.totalEdges} total edges · page {detail.value.page} of {Math.max(1, detail.value.pageCount)}. {detail.value.omittedCrossPageEdges} cross-page edges omitted from this page.</p>
      <ul>{detail.value.limitations.map((text, index) => <li key={index}>{text}</li>)}</ul>
      {detail.value.replayScope ? <p>Local replay coverage: {detail.value.replayScope.compared} of {detail.value.replayScope.supplied} supplied bundles compared. {detail.value.replayScope.completeLocalCollection ? "Covers this bounded local collection only." : "Whole-collection coverage unavailable."}</p> : null}
      {detail.value.comparisons.map((comparison, index) => <article className="investigation-comparison" key={index}><h4>{comparison.title}: {readable(comparison.status)}</h4><p>Rule version: {comparison.ruleVersion}</p><ul>{comparison.findings.map((finding, i) => <li key={i}>{finding}</li>)}</ul><ul>{comparison.limitations.map((limitation, i) => <li key={i}>{limitation}</li>)}</ul><details><summary>Exact comparison citations</summary><pre>{JSON.stringify(comparison.citations, null, 2)}</pre></details></article>)}
      <label className="confirm-row"><input type="checkbox" checked={graph} onChange={event => setGraph(event.target.checked)} />Show evidence graph</label>
      {graph ? <EvidenceGraph detail={detail.value} /> : null}
      <h4>Chronological evidence list</h4>
      <ol className="investigation-evidence" aria-label="Chronological evidence list">{detail.value.nodes.map((node, index) => <li key={node.key} id={`investigation-node-${index}`} tabIndex={-1} data-node-key={node.key}>
        <h5>{node.title}</h5><p>{readable(node.sourceClass)} · {readable(node.status)} · <time dateTime={node.time}>{node.time}</time></p>
        <dl className="investigation-key-facts">{node.facts.filter(fact => fact.category === "amount" || fact.category === "public_status").slice(0, 4).map((fact, i) => <div key={i}><dt>{readable(fact.side)} · {fact.label}</dt><dd>{fact.value}</dd></div>)}</dl>
        {node.limitations[0] ? <p>{node.limitations[0]}</p> : null}
        <details><summary>Inspect all {node.facts.length} facts and limitations</summary>
          {(["expected", "observed", "context"] as const).map(side => <div key={side}><h6>{readable(side)}</h6><dl>{node.facts.filter(fact => fact.side === side).map((fact, i) => <div key={i}><dt>{fact.label}</dt><dd>{fact.value}</dd></div>)}</dl>{node.facts.every(fact => fact.side !== side) ? <p>No {side} fact supplied.</p> : null}</div>)}
          <ul>{node.limitations.map((text, i) => <li key={i}>{text}</li>)}</ul>
        </details>
        <details><summary>Exact evidence citation</summary><pre>{JSON.stringify(node.reference, null, 2)}</pre></details>
      </li>)}</ol>
      <h4>Relationships on this page</h4><ul aria-label="Evidence relationships">{detail.value.edges.map((edge, index) => <li key={index}>{detail.value!.nodes.find(node => node.key === edge.from)?.title} → {detail.value!.nodes.find(node => node.key === edge.to)?.title}: {edge.label} ({readable(edge.kind)})</li>)}</ul>
      {detail.value.pageCount > 1 ? <div className="button-row"><button type="button" disabled={detailPage <= 1} onClick={() => setDetailPage(value => value - 1)}>Previous evidence page</button><button type="button" disabled={detailPage >= detail.value.pageCount} onClick={() => setDetailPage(value => value + 1)}>Next evidence page</button></div> : null}
      <section className="investigation-export" aria-labelledby="investigation-export-title"><h4 id="investigation-export-title">Redacted JSON report</h4>
        <p>This is plaintext for sharing, not an encrypted workspace backup. Only this evidence page is included. Local labels, descriptions, notes, arbitrary metadata and vault internals are never exported.</p>
        <fieldset><legend>Optional exact values (excluded by default)</legend>
          <label className="confirm-row"><input type="checkbox" checked={exportOptions.includeIdentifiers} onChange={event => setExportOptions(current => ({ ...current, includeIdentifiers: event.target.checked }))} />Include identifiers</label>
          <label className="confirm-row"><input type="checkbox" checked={exportOptions.includeAmounts} onChange={event => setExportOptions(current => ({ ...current, includeAmounts: event.target.checked }))} />Include exact amounts</label>
          <label className="confirm-row"><input type="checkbox" checked={exportOptions.includeTimestamps} onChange={event => setExportOptions(current => ({ ...current, includeTimestamps: event.target.checked }))} />Include timestamps</label>
        </fieldset><button type="button" className="button" onClick={previewReport}>Preview redacted report</button>
        {exportError ? <p role="alert">{exportError}</p> : null}
        {exportPreview ? <div aria-label="Redacted report preview"><p>Review every field and the omitted-fields manifest before sharing.</p><pre>{exportPreview}</pre><div className="button-row"><button className="button" type="button" onClick={downloadReport}>Download plaintext report</button><button type="button" onClick={() => setExportPreview(null)}>Cancel report export</button></div></div> : null}
      </section>
    </section> : null}
  </section>;
}

function EvidenceGraph({ detail }: { detail: InvestigationDetail }) {
  return <div className="investigation-graph"><p>Same page as the chronological list. Select a node to focus its complete facts below.</p>
    <svg viewBox={`0 0 640 ${Math.max(80, detail.nodes.length * 80)}`} role="img" aria-label="Evidence graph; equivalent facts and relationships are listed below">
      {detail.edges.map((edge, index) => {
        const from = detail.nodes.findIndex(node => node.key === edge.from); const to = detail.nodes.findIndex(node => node.key === edge.to);
        return <path key={index} d={`M 30 ${from * 80 + 32} Q 0 ${(from + to) * 40 + 32} 30 ${to * 80 + 32}`} fill="none" stroke="currentColor"><title>{edge.label}</title></path>;
      })}
      {detail.nodes.map((node, index) => <g key={node.key} data-node-key={node.key}><title>{node.title} · {node.time} · {node.limitations.join(" ")}</title><circle cx="30" cy={index * 80 + 32} r="6" fill="currentColor" /><text x="50" y={index * 80 + 26}>
        <tspan>{index + 1}. {node.title.length > 65 ? `${node.title.slice(0, 62)}…` : node.title}</tspan>
        <tspan x="50" dy="18" className="investigation-graph-meta">{readable(node.sourceClass)} · {readable(node.status)}</tspan>
      </text></g>)}
    </svg>
    <div className="button-row">{detail.nodes.map((node, index) => <button key={node.key} type="button" onClick={() => document.getElementById(`investigation-node-${index}`)?.focus()}>Evidence {index + 1}: {node.title}</button>)}</div>
  </div>;
}
