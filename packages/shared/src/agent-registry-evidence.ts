import { z } from "zod";

import { API_SCHEMA_VERSION, ApiMetaSchema } from "./api.js";
import { ArcAnchorSchema } from "./arc-observation.js";
import { ARC_ERC8004, ARC_TESTNET } from "./network.js";
import {
  EvmAddressSchema,
  IsoTimestampSchema,
  SignedCanonicalDecimalSchema,
  SignedCanonicalIntegerSchema,
  TransactionHashSchema,
  Uint256DecimalSchema,
  Uint64DecimalSchema,
} from "./primitives.js";

export const AGENT_REGISTRY_EVIDENCE_PATH = "/v1/private/arc/agent-registry-evidence" as const;

export const AgentRegistryEvidenceRequestSchema = z.strictObject({
  network: z.literal(ARC_TESTNET.caip2),
  agentId: Uint256DecimalSchema,
  feedbackQuery: z.strictObject({
    clientAddress: EvmAddressSchema,
    feedbackIndex: Uint64DecimalSchema,
  }).optional(),
  validationRequestHash: TransactionHashSchema.optional(),
});

export const AgentRegistrySourceSchema = z.strictObject({
  sourceId: z.literal("arc_primary_rpc"),
  registrySourceId: z.literal("erc8004_registries"),
  origin: z.literal(ARC_TESTNET.rpcHttp),
  explorerOrigin: z.literal(ARC_TESTNET.explorerOrigin),
  network: z.literal(ARC_TESTNET.caip2),
  sourceRevision: z.literal(ARC_ERC8004.sourceRevision),
  reviewedAt: z.literal(ARC_ERC8004.reviewedAt),
  specificationStatus: z.literal(ARC_ERC8004.specificationStatus),
  contractsRevision: z.literal(ARC_ERC8004.contractsRevision),
  registries: z.strictObject({
    identity: z.literal(ARC_TESTNET.contracts.erc8004IdentityRegistry.toLowerCase()),
    reputation: z.literal(ARC_TESTNET.contracts.erc8004ReputationRegistry.toLowerCase()),
    validation: z.literal(ARC_TESTNET.contracts.erc8004ValidationRegistry.toLowerCase()),
  }),
  observedAt: IsoTimestampSchema,
  adapterVersion: z.literal("openarc.agent-registry-evidence.m05.v1"),
});

const metadataUri = z.string().max(4096);
export type AgentMetadataUriKind = "none" | "https" | "ipfs" | "data" | "other";

function hasUnsafeUriCharacters(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint !== undefined && (codePoint <= 0x20 || codePoint === 0x7f)) return true;
  }
  return false;
}

function hasSafeHttpsAuthority(uri: string): boolean {
  const remainder = uri.slice("https://".length);
  const boundary = remainder.search(/[/?#]/u);
  const authority = boundary === -1 ? remainder : remainder.slice(0, boundary);
  if (!authority || authority.includes("@")) return false;

  const ipv6Authority = /^\[[0-9a-f:.]+\](?::([0-9]{1,5}))?$/iu.exec(authority);
  const hostAuthority = /^([a-z0-9](?:[a-z0-9.-]*[a-z0-9])?)(?::([0-9]{1,5}))?$/iu.exec(authority);
  const port = ipv6Authority?.[1] ?? hostAuthority?.[2];
  return (ipv6Authority !== null || hostAuthority !== null) && (port === undefined || Number(port) <= 65_535);
}

export function classifyAgentMetadataUri(uri: string): AgentMetadataUriKind {
  if (uri === "") return "none";
  if (hasUnsafeUriCharacters(uri)) return "other";
  if (uri.startsWith("https://") && hasSafeHttpsAuthority(uri)) return "https";
  if (uri.startsWith("ipfs://") && uri.length > "ipfs://".length) return "ipfs";
  if (uri.startsWith("data:") && uri.length > "data:".length) return "data";
  return "other";
}

const AgentMetadataSchema = z.strictObject({
  uri: metadataUri,
  kind: z.enum(["none", "https", "ipfs", "data", "other"]),
  trust: z.literal("untrusted_external_metadata"),
  fetched: z.literal(false),
}).superRefine((metadata, context) => {
  if (metadata.kind !== classifyAgentMetadataUri(metadata.uri)) {
    context.addIssue({ code: "custom", message: "Metadata URI kind must match its untrusted text", path: ["kind"] });
  }
});

export const AgentRegistryEvidenceSchema = z.strictObject({
  schemaVersion: z.literal("openarc.agent-registry-evidence.v1"),
  network: z.literal(ARC_TESTNET.caip2),
  agentId: Uint256DecimalSchema,
  anchor: ArcAnchorSchema,
  identity: z.strictObject({
    owner: EvmAddressSchema,
    agentWallet: EvmAddressSchema,
    metadata: AgentMetadataSchema,
  }),
  feedback: z.strictObject({
    observer: EvmAddressSchema,
    feedbackIndex: Uint64DecimalSchema,
    value: SignedCanonicalIntegerSchema,
    valueDecimals: z.number().int().min(0).max(18),
    decimal: SignedCanonicalDecimalSchema,
    tag1: z.string().max(160),
    tag2: z.string().max(160),
    revoked: z.boolean(),
    relationship: z.literal("observer_specific_claim"),
  }).nullable(),
  validation: z.strictObject({
    requestHash: TransactionHashSchema,
    validator: EvmAddressSchema,
    agentId: Uint256DecimalSchema,
    response: z.number().int().min(0).max(100),
    responseHash: TransactionHashSchema,
    tag: z.string().max(160),
    lastUpdate: Uint256DecimalSchema,
    relationship: z.literal("validator_specific_response"),
  }).nullable(),
  source: AgentRegistrySourceSchema,
  limitations: z.tuple([
    z.literal("ERC-8004 is a draft standard; registry facts may change before finalization."),
    z.literal("Identity ownership and metadata are registry claims, not proof of safety, quality, or control."),
    z.literal("Feedback is one observer's claim and validation is one validator's response; neither is a universal score."),
    z.literal("Metadata is untrusted external text and was not fetched or rendered by OpenArc."),
  ]),
});

export const AgentRegistryEvidenceEnvelopeSchema = z.strictObject({
  ok: z.literal(true),
  data: AgentRegistryEvidenceSchema,
  meta: ApiMetaSchema.extend({ schemaVersion: z.literal(API_SCHEMA_VERSION) }),
});

export type AgentRegistryEvidenceRequest = z.infer<typeof AgentRegistryEvidenceRequestSchema>;
export type AgentRegistryEvidence = z.infer<typeof AgentRegistryEvidenceSchema>;
export type AgentRegistryEvidenceEnvelope = z.infer<typeof AgentRegistryEvidenceEnvelopeSchema>;
