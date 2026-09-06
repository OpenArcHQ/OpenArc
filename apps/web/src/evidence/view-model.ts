import type { EvidenceFixture, EvidenceRecord, PaymentCorrelation } from "@openarc/shared";

export interface EvidenceFactView {
  label: string;
  value: string;
}

export interface EvidenceNodeView {
  id: string;
  schemaVersion: EvidenceRecord["schemaVersion"];
  actionId: EvidenceRecord["actionId"];
  type: EvidenceRecord["evidenceType"];
  typeLabel: string;
  authority: EvidenceRecord["class"];
  authorityLabel: string;
  sourceLabel: string;
  sourceId: string;
  sourceReference: string;
  sourceKind: EvidenceRecord["source"]["kind"];
  sourceEnvironment: EvidenceRecord["source"]["environment"];
  sourceAdapterVersion: EvidenceRecord["source"]["adapterVersion"];
  sourceNetwork: EvidenceRecord["source"]["network"];
  observedAt: string;
  occurredAt: string | null;
  time: string;
  timeLabel: string;
  facts: readonly EvidenceFactView[];
  limitations: readonly string[];
}

export interface EvidenceEdgeView {
  fromId: string;
  toId: string;
  relationship: "chronological evidence sequence" | "signed-field comparison" | "OpenArc-derived field comparison";
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

const paymentFacts = (payload: PaymentCorrelation): EvidenceFactView[] => [
  { label: "Network", value: payload.network },
  { label: "Asset", value: payload.asset },
  { label: "Payer", value: payload.payer },
  { label: "Recipient", value: payload.payTo },
  { label: "Amount · base units", value: payload.amountBaseUnits },
  { label: "Authorization nonce", value: payload.authorizationNonce },
  { label: "Resource digest", value: payload.resourceDigest },
];

function factsFor(record: EvidenceRecord): EvidenceFactView[] {
  switch (record.evidenceType) {
    case "intent":
      return [...paymentFacts(record.payload), { label: "Mandate digest", value: record.payload.mandateDigest }];
    case "attempt":
      return [...paymentFacts(record.payload), { label: "Connector event", value: record.payload.connectorEventId }];
    case "payment_requirement":
      return [
        ...paymentFacts(record.payload),
        { label: "Valid after", value: record.payload.validAfter },
        { label: "Valid before", value: record.payload.validBefore },
        { label: "Requirement digest", value: record.payload.requirementDigest },
      ];
    case "authorization":
      return [
        ...paymentFacts(record.payload),
        { label: "Valid after", value: record.payload.validAfter },
        { label: "Valid before", value: record.payload.validBefore },
        { label: "Authorization digest", value: record.payload.authorizationDigest },
      ];
    case "fulfillment":
      return [
        { label: "Resource digest", value: record.payload.resourceDigest },
        { label: "Provider status", value: record.payload.providerStatus },
        { label: "Response digest", value: record.payload.responseDigest ?? "NOT SUPPLIED" },
      ];
    case "settlement":
      return [
        ...paymentFacts(record.payload),
        { label: "Transaction hash", value: record.payload.transactionHash },
        { label: "Block hash", value: record.payload.blockHash },
        { label: "Block number", value: record.payload.blockNumber },
        { label: "Settlement status", value: record.payload.settlementStatus },
      ];
    case "refund":
      return [
        { label: "Original transaction", value: record.payload.originalTransactionHash },
        { label: "Refund transaction", value: record.payload.refundTransactionHash },
        { label: "Amount · base units", value: record.payload.amountBaseUnits },
        { label: "Block hash", value: record.payload.blockHash },
        { label: "Block number", value: record.payload.blockNumber },
      ];
  }
}

const relationshipFor = (
  from: EvidenceRecord["evidenceType"],
  to: EvidenceRecord["evidenceType"],
): EvidenceEdgeView["relationship"] => {
  if (from === "payment_requirement" && to === "authorization") return "signed-field comparison";
  if (to === "settlement" || to === "refund") return "OpenArc-derived field comparison";
  return "chronological evidence sequence";
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
      schemaVersion: record.schemaVersion,
      actionId: record.actionId,
      type: record.evidenceType,
      typeLabel: titleCase(record.evidenceType),
      authority: record.class,
      authorityLabel: authorityLabels[record.class],
      sourceLabel: record.source.label,
      sourceId: record.source.sourceId,
      sourceReference: record.source.reference,
      sourceKind: record.source.kind,
      sourceEnvironment: record.source.environment,
      sourceAdapterVersion: record.source.adapterVersion,
      sourceNetwork: record.source.network,
      observedAt: record.observedAt,
      occurredAt: record.occurredAt,
      time,
      timeLabel: `${time.slice(11, 16)} UTC`,
      facts: factsFor(record),
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
