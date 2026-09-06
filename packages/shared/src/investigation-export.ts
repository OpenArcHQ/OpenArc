import { z } from "zod";
import { IsoTimestampSchema } from "./primitives.js";
import { INVESTIGATION_LIMITS, INVESTIGATION_SOURCE_CLASSES, INVESTIGATION_SOURCE_LIMITATIONS,
  INVESTIGATION_STATUSES, type InvestigationDetail } from "./investigation-types.js";

// Standard Web/Node 22 global; shared remains independent of DOM/Node type libraries.
declare const TextEncoder: new () => { encode(value: string): Uint8Array };

export const INVESTIGATION_REPORT_FILENAME = "openarc-investigation-report.json";
const source = z.enum(INVESTIGATION_SOURCE_CLASSES);
const status = z.enum(INVESTIGATION_STATUSES);
const alias = z.string().regex(/^item-[0-9]{3}$/u);
const count = z.number().int().min(0).max(1_000_000);
const category = z.enum(["identifier", "amount", "timestamp", "local_private", "public_status", "context"]);
const edgeKind = z.enum(["cited_evidence", "explicit_local_association", "local_policy_comparison", "chronological_sequence"]);
const ruleVersion = z.enum(["openarc.reconcile.v1", "openarc.x402-reconciliation.m07.v1", "openarc.agent-policy-rules.v1"]);
const identifier = z.string().regex(/^[A-Za-z0-9_:.-]{1,160}$/u);
const amount = z.string().max(160).regex(/^(0|[1-9][0-9]*)(\.[0-9]*[1-9])?$/u);
const selectedFields = z.strictObject({ includeIdentifiers: z.boolean(), includeAmounts: z.boolean(), includeTimestamps: z.boolean() });
export type InvestigationReportOptions = Partial<z.infer<typeof selectedFields>>;
export const InvestigationReportSchema = z.strictObject({
  schemaVersion: z.literal("openarc.investigation-report.v1"), network: z.literal("arc_testnet"),
  warning: z.literal("PLAINTEXT_REPORT_NOT_ENCRYPTED_BACKUP"),
  selectedFields,
  scope: z.strictObject({ page: count, pageCount: count, totalNodes: count, totalEdges: count,
    omittedCrossPageEdges: count, selectedRootOnPage: z.boolean() }),
  root: z.strictObject({ alias: alias.nullable(), sourceClass: source, status }),
  nodes: z.array(z.strictObject({ alias, sourceClass: source, status, limitation: z.string().max(256),
    reference: z.strictObject({ recordId: identifier, recordRevision: identifier,
      eventIndex: z.number().int().min(0).max(63).optional(), eventId: identifier.optional() }).optional(),
    fields: z.array(z.strictObject({ ordinal: count, category: z.enum(["identifier", "amount", "timestamp"]),
      value: z.string().max(160) })).max(INVESTIGATION_LIMITS.factsPerNode),
  })).max(INVESTIGATION_LIMITS.detailNodes),
  edges: z.array(z.strictObject({ from: alias, to: alias, kind: edgeKind })).max(INVESTIGATION_LIMITS.detailEdges),
  comparisons: z.array(z.strictObject({ status, ruleVersion: ruleVersion.nullable(), citations: z.array(alias).max(INVESTIGATION_LIMITS.detailNodes),
    citationsOutsidePage: count, limitation: z.literal("Local comparison over cited supplied evidence; no verified enforcement or individual settlement claim.") })).max(64),
  replayScope: z.strictObject({ supplied: count, compared: count, completeLocalCollection: z.boolean() }).nullable(),
  omittedFields: z.array(z.strictObject({ category, reason: z.enum(["not_selected", "always_private", "unsafe_value", "not_on_page"]), count })).max(24),
}).superRefine((report, ctx) => {
  const aliases = new Set(report.nodes.map(node => node.alias));
  if (aliases.size !== report.nodes.length || report.edges.some(edge => !aliases.has(edge.from) || !aliases.has(edge.to)) ||
    (report.root.alias !== null && !aliases.has(report.root.alias)) ||
    report.comparisons.some(comparison => comparison.citations.some(citation => !aliases.has(citation)))) {
    ctx.addIssue({ code: "custom", message: "Report references must resolve within the exported page" });
  }
  for (const node of report.nodes) for (const field of node.fields) {
    const schema = field.category === "identifier" ? identifier : field.category === "amount" ? amount : IsoTimestampSchema;
    const permitted = field.category === "identifier" ? report.selectedFields.includeIdentifiers :
      field.category === "amount" ? report.selectedFields.includeAmounts : report.selectedFields.includeTimestamps;
    if (!permitted || !schema.safeParse(field.value).success) ctx.addIssue({ code: "custom", message: "Invalid selected report field" });
  }
  if (!report.selectedFields.includeIdentifiers && report.nodes.some(node => node.reference !== undefined)) {
    ctx.addIssue({ code: "custom", message: "Identifiers were not selected" });
  }
  const replay = report.replayScope;
  if (replay && (replay.supplied < 1 || replay.supplied > 1_000 || replay.compared < 1 || replay.compared > 64 ||
    replay.compared > replay.supplied || (replay.completeLocalCollection && replay.compared !== replay.supplied))) {
    ctx.addIssue({ code: "custom", message: "Replay coverage counts are contradictory" });
  }
});
export type InvestigationReport = z.infer<typeof InvestigationReportSchema>;

/** Never serialize a source record. Only explicitly constructed allowlisted fields leave this function. */
export function buildInvestigationReport(detail: InvestigationDetail, options: InvestigationReportOptions = {}): InvestigationReport {
  try {
    const choices = selectedFields.parse({ includeIdentifiers: false, includeAmounts: false, includeTimestamps: false, ...options });
    if (!detail || !Array.isArray(detail.nodes) || detail.nodes.length > INVESTIGATION_LIMITS.detailNodes ||
      !Array.isArray(detail.edges) || detail.edges.length > INVESTIGATION_LIMITS.detailEdges ||
      !Array.isArray(detail.comparisons) || detail.comparisons.length > 64 ||
      !Number.isInteger(detail.page) || detail.page < 1 || detail.page > detail.pageCount ||
      !Number.isInteger(detail.pageCount) || detail.pageCount < 1 || detail.totalNodes < detail.nodes.length ||
      detail.totalEdges < detail.edges.length || !Number.isInteger(detail.totalNodes) || detail.totalNodes < 1 ||
      detail.totalNodes > INVESTIGATION_LIMITS.entries || detail.pageCount !== Math.ceil(detail.totalNodes / INVESTIGATION_LIMITS.detailNodes) ||
      detail.nodes.length !== Math.min(INVESTIGATION_LIMITS.detailNodes, detail.totalNodes - (detail.page - 1) * INVESTIGATION_LIMITS.detailNodes) ||
      detail.omittedCrossPageEdges !== detail.totalEdges - detail.edges.length) throw new Error();
    const aliases = new Map<string, string>();
    detail.nodes.forEach((node, index) => {
      if (typeof node.key !== "string" || node.key.length > 1024 || aliases.has(node.key)) throw new Error();
      aliases.set(node.key, `item-${String(index + 1).padStart(3, "0")}`);
    });
    const omissions = new Map<string, { category: z.infer<typeof category>; reason: "not_selected" | "always_private" | "unsafe_value" | "not_on_page"; count: number }>();
    const omit = (fieldCategory: z.infer<typeof category>, reason: "not_selected" | "always_private" | "unsafe_value" | "not_on_page", amount = 1) => {
      if (!amount) return;
      const key = `${fieldCategory}:${reason}`, previous = omissions.get(key);
      omissions.set(key, { category: fieldCategory, reason, count: (previous?.count ?? 0) + amount });
    };
    const nodes = detail.nodes.map(node => {
      const sourceClass = source.parse(node.sourceClass);
      if (!Array.isArray(node.facts) || node.facts.length > INVESTIGATION_LIMITS.factsPerNode) throw new Error();
      omit("local_private", "always_private", 1 + node.facts.length); // Title and arbitrary fact labels.
      const fields: InvestigationReport["nodes"][number]["fields"] = [];
      node.facts.forEach((fact, ordinal) => {
        const fieldCategory = category.parse(fact.category);
        if (fieldCategory === "local_private" || fieldCategory === "public_status" || fieldCategory === "context") {
          omit(fieldCategory, "always_private"); return;
        }
        const selected = fieldCategory === "identifier" ? choices.includeIdentifiers : fieldCategory === "amount" ? choices.includeAmounts : choices.includeTimestamps;
        if (!selected) { omit(fieldCategory, "not_selected"); return; }
        const grammar = fieldCategory === "identifier" ? identifier : fieldCategory === "amount" ? amount : IsoTimestampSchema;
        if (!grammar.safeParse(fact.value).success) { omit(fieldCategory, "unsafe_value"); return; }
        fields.push({ ordinal, category: fieldCategory, value: fact.value });
      });
      let reference: InvestigationReport["nodes"][number]["reference"];
      if (choices.includeIdentifiers) {
        reference = { recordId: identifier.parse(node.reference.recordId), recordRevision: identifier.parse(node.reference.recordRevision),
          ...(node.reference.eventIndex !== undefined ? { eventIndex: node.reference.eventIndex } : {}),
          ...(node.reference.eventId !== undefined ? { eventId: identifier.parse(node.reference.eventId) } : {}) };
      } else omit("identifier", "not_selected", 2 + (node.reference.eventId === undefined ? 0 : 1));
      // Connector labels/IDs are intentionally not copied as reference metadata.
      if (node.reference.connectorId !== undefined) omit("local_private", "always_private");
      return { alias: aliases.get(node.key)!, sourceClass, status: status.parse(node.status),
        limitation: INVESTIGATION_SOURCE_LIMITATIONS[sourceClass], fields, ...(reference ? { reference } : {}) };
    });
    const edges = detail.edges.map(edge => {
      if (!aliases.has(edge.from) || !aliases.has(edge.to)) throw new Error();
      return { from: aliases.get(edge.from)!, to: aliases.get(edge.to)!, kind: edgeKind.parse(edge.kind) };
    });
    const comparisons = detail.comparisons.map(comparison => {
      if (!Array.isArray(comparison.citations) || comparison.citations.length > INVESTIGATION_LIMITS.entries) throw new Error();
      const citations = new Set<string>(); let citationsOutsidePage = 0;
      for (const reference of comparison.citations) {
        const node = detail.nodes.find(candidate => candidate.reference.kind === reference.kind &&
          candidate.reference.recordId === reference.recordId && candidate.reference.recordRevision === reference.recordRevision &&
          candidate.reference.eventIndex === reference.eventIndex);
        if (node) citations.add(aliases.get(node.key)!); else citationsOutsidePage += 1;
      }
      omit("context", "not_on_page", citationsOutsidePage);
      const parsedRule = ruleVersion.safeParse(comparison.ruleVersion);
      if (!parsedRule.success) omit("context", "unsafe_value");
      return { status: status.parse(comparison.status), ruleVersion: parsedRule.success ? parsedRule.data : null,
        citations: [...citations], citationsOutsidePage,
        limitation: "Local comparison over cited supplied evidence; no verified enforcement or individual settlement claim." as const };
    });
    const report = InvestigationReportSchema.parse({ schemaVersion: "openarc.investigation-report.v1", network: "arc_testnet",
      warning: "PLAINTEXT_REPORT_NOT_ENCRYPTED_BACKUP", selectedFields: choices,
      scope: { page: detail.page, pageCount: detail.pageCount, totalNodes: detail.totalNodes, totalEdges: detail.totalEdges,
        omittedCrossPageEdges: detail.omittedCrossPageEdges, selectedRootOnPage: aliases.has(detail.root.key) },
      root: { alias: aliases.get(detail.root.key) ?? null, sourceClass: source.parse(detail.root.sourceClass), status: status.parse(detail.root.status) },
      nodes, edges, comparisons,
      replayScope: detail.replayScope === null ? null : { supplied: detail.replayScope.supplied, compared: detail.replayScope.compared,
        completeLocalCollection: detail.replayScope.completeLocalCollection },
      omittedFields: [...omissions.values()].sort((a, b) => a.category.localeCompare(b.category) || a.reason.localeCompare(b.reason)),
    });
    if (new TextEncoder().encode(JSON.stringify(report, null, 2)).byteLength > INVESTIGATION_LIMITS.exportBytes) throw new Error();
    return report;
  } catch { throw new Error("Invalid investigation report inputs."); }
}

export function serializeInvestigationReport(detail: InvestigationDetail, options: InvestigationReportOptions = {}): string {
  return JSON.stringify(buildInvestigationReport(detail, options), null, 2);
}
