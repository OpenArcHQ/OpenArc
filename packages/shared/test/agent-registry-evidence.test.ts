import {
  AGENT_REGISTRY_EVIDENCE_PATH,
  ARC_ERC8004,
  ARC_TESTNET,
  AgentRegistryEvidenceRequestSchema,
  AgentRegistryEvidenceSchema,
  AgentRegistryPermissionReceiptRecordSchema,
} from "../src/index.js";
import { describe, expect, it } from "vitest";

const observer = "0x3333333333333333333333333333333333333333";
const requestHash = `0x${"a".repeat(64)}`;

describe("M05 ERC-8004 shared contracts", () => {
  it("accepts only one bounded exact agent, feedback, and validation request", () => {
    const parsed = AgentRegistryEvidenceRequestSchema.parse({ network: ARC_TESTNET.caip2, agentId: "1",
      feedbackQuery: { clientAddress: observer, feedbackIndex: "0" }, validationRequestHash: requestHash });
    expect(parsed.feedbackQuery?.clientAddress).toBe(observer);
    for (const invalid of [
      { ...parsed, agentId: (1n << 256n).toString() },
      { ...parsed, feedbackQuery: { ...parsed.feedbackQuery, feedbackIndex: (1n << 64n).toString() } },
      { ...parsed, registryAddress: observer },
    ]) expect(AgentRegistryEvidenceRequestSchema.safeParse(invalid).success).toBe(false);
  });

  it("requires exact disclosure fields and never includes a local profile link", () => {
    const at = "2026-09-04T12:00:00.000Z";
    const receipt = { recordSchema: "openarc.permission-receipt.v3", kind: "permission_receipt",
      recordId: crypto.randomUUID(), recordRevision: "A".repeat(32), createdAt: at, updatedAt: at,
      connectorId: "arc_agent_registry_evidence", destination: { origin: "https://app.example.test",
        path: AGENT_REGISTRY_EVIDENCE_PATH, method: "POST", upstreams: [ARC_TESTNET.rpcHttp] },
      releasedFields: ["network", "agentId", "feedbackQuery.clientAddress", "feedbackQuery.feedbackIndex"],
      released: { network: ARC_TESTNET.caip2, agentId: "1",
        feedbackQuery: { clientAddress: observer, feedbackIndex: "0" } },
      purpose: "Observe one ERC-8004 agent identity and optional exact observer or validator claims at one final Arc Testnet block.",
      credentials: "omit",
      openArcRetention: "No request or response body is retained by the OpenArc API. The approved result is stored only in the encrypted local workspace.",
      providerRetention: "Arc's public RPC receives the released public registry identifiers under Arc's current terms and privacy policy.",
      hostingMetadata: "OpenArc, its hosting provider, and the Arc RPC receive ordinary network metadata, including IP and user-agent where applicable.",
      approvedAt: at, outcome: "approved", resolvedAt: null, failureCode: null };
    expect(AgentRegistryPermissionReceiptRecordSchema.parse(receipt).released.agentId).toBe("1");
    expect(AgentRegistryPermissionReceiptRecordSchema.safeParse({ ...receipt,
      releasedFields: ["network", "agentId"], linkedAgentProfileRecordId: crypto.randomUUID() }).success).toBe(false);
  });

  it("keeps metadata explicitly unfetched and claims observer-specific", () => {
    const parsed = AgentRegistryEvidenceSchema.parse({
      schemaVersion: "openarc.agent-registry-evidence.v1", network: ARC_TESTNET.caip2, agentId: "1",
      anchor: { blockNumber: "2", blockHash: requestHash, blockTimestamp: "2026-09-04T12:00:00.000Z",
        finality: "deterministic", confirmations: "1" },
      identity: { owner: observer, agentWallet: observer,
        metadata: { uri: "https://example.test/agent.json", kind: "https", trust: "untrusted_external_metadata", fetched: false } },
      feedback: null, validation: null,
      source: { sourceId: "arc_primary_rpc", registrySourceId: "erc8004_registries", origin: ARC_TESTNET.rpcHttp,
        explorerOrigin: ARC_TESTNET.explorerOrigin, network: ARC_TESTNET.caip2,
        sourceRevision: ARC_ERC8004.sourceRevision, reviewedAt: ARC_ERC8004.reviewedAt,
        specificationStatus: "draft", contractsRevision: ARC_ERC8004.contractsRevision,
        registries: { identity: ARC_TESTNET.contracts.erc8004IdentityRegistry,
          reputation: ARC_TESTNET.contracts.erc8004ReputationRegistry,
          validation: ARC_TESTNET.contracts.erc8004ValidationRegistry },
        observedAt: "2026-09-04T12:00:00.000Z", adapterVersion: "openarc.agent-registry-evidence.m05.v1" },
      limitations: ["ERC-8004 is a draft standard; registry facts may change before finalization.",
        "Identity ownership and metadata are registry claims, not proof of safety, quality, or control.",
        "Feedback is one observer's claim and validation is one validator's response; neither is a universal score.",
        "Metadata is untrusted external text and was not fetched or rendered by OpenArc."],
    });
    expect(parsed.identity.metadata.fetched).toBe(false);
    expect(AgentRegistryEvidenceSchema.safeParse({ ...parsed, identity: { ...parsed.identity,
      metadata: { ...parsed.identity.metadata, uri: "javascript:alert(1)", kind: "https" } } }).success).toBe(false);
    expect(AgentRegistryEvidenceSchema.safeParse({ ...parsed, identity: { ...parsed.identity,
      metadata: { ...parsed.identity.metadata, uri: "https://user:password@example.test/a", kind: "https" } } }).success).toBe(false);
  });
});
