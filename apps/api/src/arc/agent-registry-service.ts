import {
  ARC_ERC8004,
  ARC_TESTNET,
  AgentRegistryEvidenceSchema,
  classifyAgentMetadataUri,
  type AgentRegistryEvidence,
  type AgentRegistryEvidenceRequest,
} from "@openarc/shared";
import { decodeFunctionResult, encodeFunctionData, type Abi } from "viem";

import { ApiBoundaryError } from "../http/errors.js";
import type { SourceLease } from "../limits/budget.js";
import type { ArcRpcReader } from "./rpc-client.js";
import { block, requireChainId, requireSameBlock } from "./validation.js";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

const identityAbi = [
  { type: "function", name: "ownerOf", stateMutability: "view",
    inputs: [{ name: "tokenId", type: "uint256" }], outputs: [{ name: "", type: "address" }] },
  { type: "function", name: "tokenURI", stateMutability: "view",
    inputs: [{ name: "tokenId", type: "uint256" }], outputs: [{ name: "", type: "string" }] },
  { type: "function", name: "getAgentWallet", stateMutability: "view",
    inputs: [{ name: "agentId", type: "uint256" }], outputs: [{ name: "", type: "address" }] },
] as const satisfies Abi;

const reputationAbi = [
  { type: "function", name: "getIdentityRegistry", stateMutability: "view", inputs: [],
    outputs: [{ name: "", type: "address" }] },
  { type: "function", name: "readFeedback", stateMutability: "view",
    inputs: [{ name: "agentId", type: "uint256" }, { name: "clientAddress", type: "address" },
      { name: "feedbackIndex", type: "uint64" }],
    outputs: [{ name: "value", type: "int128" }, { name: "valueDecimals", type: "uint8" },
      { name: "tag1", type: "string" }, { name: "tag2", type: "string" },
      { name: "isRevoked", type: "bool" }] },
] as const satisfies Abi;

const validationAbi = [
  { type: "function", name: "getIdentityRegistry", stateMutability: "view", inputs: [],
    outputs: [{ name: "", type: "address" }] },
  { type: "function", name: "getValidationStatus", stateMutability: "view",
    inputs: [{ name: "requestHash", type: "bytes32" }],
    outputs: [{ name: "validatorAddress", type: "address" }, { name: "agentId", type: "uint256" },
      { name: "response", type: "uint8" }, { name: "responseHash", type: "bytes32" },
      { name: "tag", type: "string" }, { name: "lastUpdate", type: "uint256" }] },
] as const satisfies Abi;

function decode(abi: Abi, functionName: string, data: unknown): unknown {
  if (typeof data !== "string" || !/^0x(?:[0-9a-f]{2})*$/u.test(data)) {
    throw new ApiBoundaryError("SOURCE_MALFORMED");
  }
  try {
    const decodeResult = decodeFunctionResult as unknown as (options: {
      abi: Abi; functionName: string; data: `0x${string}`;
    }) => unknown;
    return decodeResult({ abi, functionName, data: data as `0x${string}` });
  }
  catch { throw new ApiBoundaryError("SOURCE_MALFORMED"); }
}

function fixedPoint(value: bigint, decimals: number): string {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 18) throw new ApiBoundaryError("SOURCE_MALFORMED");
  if (decimals === 0) return value.toString(10);
  const negative = value < 0n;
  const digits = (negative ? -value : value).toString(10).padStart(decimals + 1, "0");
  const whole = digits.slice(0, -decimals).replace(/^0+(?=\d)/u, "");
  const fraction = digits.slice(-decimals).replace(/0+$/u, "");
  const unsigned = fraction ? `${whole}.${fraction}` : whole;
  return negative && unsigned !== "0" ? `-${unsigned}` : unsigned;
}

export class AgentRegistryService {
  constructor(private readonly rpc: ArcRpcReader, private readonly now: () => string = () => new Date().toISOString()) {}

  private async contractCall(abi: Abi, functionName: string, args: readonly unknown[], to: string,
    blockNumber: string, lease: SourceLease, signal: AbortSignal, revertAsNotFound = false): Promise<unknown> {
    let data: `0x${string}`;
    try { data = encodeFunctionData({ abi, functionName, args }); }
    catch { throw new ApiBoundaryError("INTERNAL_ERROR"); }
    const result = await this.rpc.call("eth_call", [{ to, data }, blockNumber], lease, signal,
      revertAsNotFound ? { revertAsNotFound: true } : undefined);
    return decode(abi, functionName, result);
  }

  async observe(input: AgentRegistryEvidenceRequest, lease: SourceLease,
    signal: AbortSignal): Promise<AgentRegistryEvidence> {
    requireChainId(await this.rpc.call("eth_chainId", [], lease, signal));
    const anchor = block(await this.rpc.call("eth_getBlockByNumber", ["latest", false], lease, signal));
    const agentId = BigInt(input.agentId);
    const identity = ARC_TESTNET.contracts.erc8004IdentityRegistry.toLowerCase();
    const reputation = ARC_TESTNET.contracts.erc8004ReputationRegistry.toLowerCase();
    const validation = ARC_TESTNET.contracts.erc8004ValidationRegistry.toLowerCase();

    const owner = this.requireAddress(await this.contractCall(identityAbi, "ownerOf", [agentId], identity,
      anchor.numberHex, lease, signal, true));
    const metadataUri = this.requireString(await this.contractCall(identityAbi, "tokenURI", [agentId], identity,
      anchor.numberHex, lease, signal), 4096);
    const agentWallet = this.requireAddress(await this.contractCall(identityAbi, "getAgentWallet", [agentId], identity,
      anchor.numberHex, lease, signal));
    const reputationBinding = this.requireAddress(await this.contractCall(reputationAbi, "getIdentityRegistry", [], reputation,
      anchor.numberHex, lease, signal));
    const validationBinding = this.requireAddress(await this.contractCall(validationAbi, "getIdentityRegistry", [], validation,
      anchor.numberHex, lease, signal));
    if (reputationBinding !== identity || validationBinding !== identity) throw new ApiBoundaryError("SOURCE_CONFLICT");

    let feedback: AgentRegistryEvidence["feedback"] = null;
    if (input.feedbackQuery) {
      const observer = input.feedbackQuery.clientAddress;
      if (observer === owner || observer === agentWallet) throw new ApiBoundaryError("SOURCE_CONFLICT");
      const decoded = await this.contractCall(reputationAbi, "readFeedback",
        [agentId, observer, BigInt(input.feedbackQuery.feedbackIndex)], reputation,
        anchor.numberHex, lease, signal, true);
      if (!Array.isArray(decoded) || decoded.length !== 5 || typeof decoded[0] !== "bigint" ||
        typeof decoded[1] !== "number" || typeof decoded[2] !== "string" || typeof decoded[3] !== "string" ||
        typeof decoded[4] !== "boolean") throw new ApiBoundaryError("SOURCE_MALFORMED");
      feedback = { observer, feedbackIndex: input.feedbackQuery.feedbackIndex, value: decoded[0].toString(10),
        valueDecimals: decoded[1], decimal: fixedPoint(decoded[0], decoded[1]), tag1: this.requireString(decoded[2], 160),
        tag2: this.requireString(decoded[3], 160), revoked: decoded[4], relationship: "observer_specific_claim" };
    }

    let validationClaim: AgentRegistryEvidence["validation"] = null;
    if (input.validationRequestHash) {
      const decoded = await this.contractCall(validationAbi, "getValidationStatus", [input.validationRequestHash], validation,
        anchor.numberHex, lease, signal);
      if (!Array.isArray(decoded) || decoded.length !== 6 || typeof decoded[0] !== "string" ||
        typeof decoded[1] !== "bigint" || typeof decoded[2] !== "number" || typeof decoded[3] !== "string" ||
        typeof decoded[4] !== "string" || typeof decoded[5] !== "bigint") throw new ApiBoundaryError("SOURCE_MALFORMED");
      const validator = this.requireAddress(decoded[0]);
      if (validator === ZERO_ADDRESS) throw new ApiBoundaryError("SOURCE_NOT_FOUND");
      if (decoded[1] !== agentId) throw new ApiBoundaryError("SOURCE_CONFLICT");
      if (!/^0x[0-9a-f]{64}$/u.test(decoded[3])) throw new ApiBoundaryError("SOURCE_MALFORMED");
      validationClaim = { requestHash: input.validationRequestHash, validator, agentId: decoded[1].toString(10),
        response: decoded[2], responseHash: decoded[3], tag: this.requireString(decoded[4], 160),
        lastUpdate: decoded[5].toString(10), relationship: "validator_specific_response" };
    }

    const repeated = block(await this.rpc.call("eth_getBlockByNumber", [anchor.numberHex, false], lease, signal));
    requireSameBlock(anchor, repeated);
    return AgentRegistryEvidenceSchema.parse({
      schemaVersion: "openarc.agent-registry-evidence.v1", network: ARC_TESTNET.caip2, agentId: input.agentId,
      anchor: { blockNumber: anchor.numberDecimal, blockHash: anchor.hash, blockTimestamp: anchor.timestamp,
        finality: "deterministic", confirmations: "1" },
      identity: { owner, agentWallet,
        metadata: { uri: metadataUri, kind: classifyAgentMetadataUri(metadataUri),
          trust: "untrusted_external_metadata", fetched: false } },
      feedback, validation: validationClaim,
      source: { sourceId: "arc_primary_rpc", registrySourceId: "erc8004_registries",
        origin: ARC_TESTNET.rpcHttp, explorerOrigin: ARC_TESTNET.explorerOrigin, network: ARC_TESTNET.caip2,
        sourceRevision: ARC_ERC8004.sourceRevision, reviewedAt: ARC_ERC8004.reviewedAt,
        specificationStatus: ARC_ERC8004.specificationStatus, contractsRevision: ARC_ERC8004.contractsRevision,
        registries: { identity, reputation, validation }, observedAt: this.now(),
        adapterVersion: "openarc.agent-registry-evidence.m05.v1" },
      limitations: [
        "ERC-8004 is a draft standard; registry facts may change before finalization.",
        "Identity ownership and metadata are registry claims, not proof of safety, quality, or control.",
        "Feedback is one observer's claim and validation is one validator's response; neither is a universal score.",
        "Metadata is untrusted external text and was not fetched or rendered by OpenArc.",
      ],
    });
  }

  private requireAddress(value: unknown): `0x${string}` {
    if (typeof value !== "string" || !/^0x[0-9a-fA-F]{40}$/u.test(value)) throw new ApiBoundaryError("SOURCE_MALFORMED");
    return value.toLowerCase() as `0x${string}`;
  }

  private requireString(value: unknown, maximum: number): string {
    if (typeof value !== "string" || value.length > maximum) throw new ApiBoundaryError("SOURCE_MALFORMED");
    return value;
  }
}
