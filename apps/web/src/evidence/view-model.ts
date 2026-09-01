import type { EvidenceFixture, EvidenceRecord } from "@openarc/shared";

export interface EvidenceNodeView {
  id: string;
  type: EvidenceRecord["evidenceType"];
  typeLabel: string;
  authority: EvidenceRecord["class"];
  authorityLabel: string;
  sourceLabel: string;
  sourceReference: string;
  time: string;
  timeLabel: string;
  limitations: readonly string[];
}

export interface EvidenceEdgeView {
  fromId: string;
  toId: string;
  relationship: "reported relationship" | "cryptographic link" | "provider association" | "OpenArc-derived match";
}

export interface EvidenceFixtureView {
  fixture: EvidenceFixture;
  nodes: readonly EvidenceNodeView[];
  edges: readonly EvidenceEdgeView[];
  evidenceCitation: string;
}

const titleCase = (value: string) =>
  value
    .split("_")
    .map((word) => `${word.slice(0, 1).toUpperCase()}${word.slice(1)}`)
    .join(" ");

const authorityLabels: Record<EvidenceRecord["class"], string> = {
  local: "Local evidence",
  signed: "Signed evidence",
  agent_reported: "Agent-reported evidence",
  provider: "Provider evidence",
  gateway: "Gateway evidence",
  onchain: "Onchain evidence",
};

const relationshipFor = (
  from: EvidenceRecord["evidenceType"],
  to: EvidenceRecord["evidenceType"],
): EvidenceEdgeView["relationship"] => {
  if (from === "payment_requirement" && to === "authorization") return "cryptographic link";
  if (to === "settlement" || to === "refund") return "OpenArc-derived match";
  if (from === "attempt" || from === "fulfillment" || to === "fulfillment") {
    return "provider association";
  }
  return "reported relationship";
};

export function buildEvidenceFixtureView(fixture: EvidenceFixture): EvidenceFixtureView {
  const records = new Map(fixture.evidence.map((record) => [record.evidenceId, record]));
  const ordered = fixture.result.evidenceIds.map((evidenceId) => {
    const record = records.get(evidenceId);
    if (!record) throw new Error(`Fixture result cites missing evidence ${evidenceId}`);
    return record;
  });

  if (new Set(ordered.map((record) => record.evidenceId)).size !== fixture.evidence.length) {
    throw new Error("Fixture graph and semantic evidence list must contain the same records");
  }

  const nodes = ordered.map<EvidenceNodeView>((record) => {
    const time = record.occurredAt ?? record.observedAt;
    return {
      id: record.evidenceId,
      type: record.evidenceType,
      typeLabel: titleCase(record.evidenceType),
      authority: record.class,
      authorityLabel: authorityLabels[record.class],
      sourceLabel: record.source.label,
      sourceReference: record.source.reference,
      time,
      timeLabel: `${time.slice(11, 16)} UTC`,
      limitations: record.limitations,
    };
  });
  const edges = nodes.slice(1).map<EvidenceEdgeView>((node, index) => ({
    fromId: nodes[index]!.id,
    toId: node.id,
    relationship: relationshipFor(nodes[index]!.type, node.type),
  }));

  return {
    fixture,
    nodes,
    edges,
    evidenceCitation: fixture.result.evidenceIds.join(", "),
  };
}
