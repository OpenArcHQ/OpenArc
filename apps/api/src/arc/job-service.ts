import { ARC_ERC8183, ARC_TESTNET, JOB_LIMITATIONS, JOB_STATUSES, JobEvidenceRequestSchema,
  JobEvidenceSchema, type JobEvidence, type JobEvidenceRequest } from "@openarc/shared";
import { decodeFunctionResult, encodeFunctionData, keccak256, toBytes, type Abi } from "viem";

import { ApiBoundaryError } from "../http/errors.js";
import type { SourceLease } from "../limits/budget.js";
import { amount, parseHexQuantity, record, timestamp } from "./quantities.js";
import type { ArcRpcReader } from "./rpc-client.js";
import { address, block, hash, requireChainId, requireSameBlock, type ParsedBlock } from "./validation.js";

export const JOB_ABI = [
  { type: "function", name: "getJob", stateMutability: "view", inputs: [{ name: "jobId", type: "uint256" }],
    outputs: [{ name: "", type: "tuple", components: [
      { name: "id", type: "uint256" }, { name: "client", type: "address" },
      { name: "provider", type: "address" }, { name: "evaluator", type: "address" },
      { name: "description", type: "string" }, { name: "budget", type: "uint256" },
      { name: "expiredAt", type: "uint256" }, { name: "status", type: "uint8" }, { name: "hook", type: "address" },
    ] }] },
  { type: "function", name: "paymentToken", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "jobHasBudget", stateMutability: "view", inputs: [{ name: "jobId", type: "uint256" }],
    outputs: [{ type: "bool" }] },
] as const satisfies Abi;

const contract = ARC_TESTNET.contracts.erc8183AgenticCommerce.toLowerCase();
const submissionTopic = keccak256(toBytes("JobSubmitted(uint256,address,bytes32)"));

/** Read-only, fixed deployment. No discovery scans, custom contracts, or content fetches. */
export class JobService {
  constructor(private readonly rpc: ArcRpcReader, private readonly now: () => string = () => new Date().toISOString()) {}

  private async contractCall(name: "getJob" | "paymentToken" | "jobHasBudget", jobId: bigint,
    anchor: ParsedBlock, lease: SourceLease, signal: AbortSignal): Promise<unknown> {
    const data = name === "paymentToken" ? encodeFunctionData({ abi: JOB_ABI, functionName: name }) :
      encodeFunctionData({ abi: JOB_ABI, functionName: name, args: [jobId] });
    const result = await this.rpc.call("eth_call", [{ to: contract, data }, anchor.numberHex], lease, signal);
    if (typeof result !== "string" || !/^0x(?:[0-9a-f]{2})+$/u.test(result)) throw new ApiBoundaryError("SOURCE_MALFORMED");
    try { return decodeFunctionResult({ abi: JOB_ABI, functionName: name, data: result as `0x${string}` }); }
    catch { throw new ApiBoundaryError("SOURCE_MALFORMED"); }
  }

  private async requireImplementation(anchor: ParsedBlock, lease: SourceLease, signal: AbortSignal): Promise<void> {
    const implementation = await this.rpc.call("eth_getStorageAt",
      [contract, ARC_ERC8183.implementationSlot, anchor.numberHex], lease, signal);
    if (typeof implementation !== "string" || !/^0x[0-9a-f]{64}$/u.test(implementation)) {
      throw new ApiBoundaryError("SOURCE_MALFORMED");
    }
    if (implementation !== `0x${"0".repeat(24)}${ARC_ERC8183.implementation.slice(2)}`) {
      throw new ApiBoundaryError("UNSUPPORTED_EVIDENCE");
    }
  }

  private async submission(transactionHash: string, jobId: bigint, provider: string,
    anchor: ParsedBlock, lease: SourceLease, signal: AbortSignal): Promise<JobEvidence["deliverable"]> {
    const value = await this.rpc.call("eth_getTransactionReceipt", [transactionHash], lease, signal);
    if (value === null) throw new ApiBoundaryError("SOURCE_NOT_FOUND");
    const receipt = record(value);
    if (hash(receipt.transactionHash) !== transactionHash || receipt.status !== "0x1") {
      throw new ApiBoundaryError("SOURCE_CONFLICT");
    }
    const receiptNumber = parseHexQuantity(receipt.blockNumber);
    const receiptHash = hash(receipt.blockHash);
    if (receiptNumber > anchor.number) throw new ApiBoundaryError("SOURCE_CONFLICT");
    const receiptBlock = block(await this.rpc.call("eth_getBlockByNumber", [receipt.blockNumber, false], lease, signal));
    if (receiptBlock.number !== receiptNumber || receiptBlock.hash !== receiptHash ||
      Date.parse(receiptBlock.timestamp) > Date.parse(anchor.timestamp)) throw new ApiBoundaryError("SOURCE_CONFLICT");
    // Historical submission semantics must also come from the reviewed implementation.
    if (receiptNumber === anchor.number) requireSameBlock(anchor, receiptBlock);
    else await this.requireImplementation(receiptBlock, lease, signal);
    if (!Array.isArray(receipt.logs) || receipt.logs.length > 256) throw new ApiBoundaryError("SOURCE_MALFORMED");
    const matches: JobEvidence["deliverable"][] = [];
    const indices = new Set<string>();
    for (const raw of receipt.logs) {
      const log = record(raw);
      const index = parseHexQuantity(log.logIndex).toString();
      if (indices.has(index)) throw new ApiBoundaryError("SOURCE_CONFLICT");
      indices.add(index);
      if (log.removed !== false || hash(log.transactionHash) !== transactionHash || hash(log.blockHash) !== receiptHash ||
        parseHexQuantity(log.blockNumber) !== receiptNumber ||
        parseHexQuantity(log.transactionIndex) !== parseHexQuantity(receipt.transactionIndex)) {
        throw new ApiBoundaryError("SOURCE_CONFLICT");
      }
      const emitter = address(log.address);
      if (!Array.isArray(log.topics) || log.topics.length > 4) throw new ApiBoundaryError("SOURCE_MALFORMED");
      const topics = log.topics.map(hash);
      if (emitter !== contract || topics[0] !== submissionTopic) continue;
      if (topics.length !== 3 || !/^0x0{24}[0-9a-f]{40}$/u.test(topics[2] ?? "")) {
        throw new ApiBoundaryError("SOURCE_MALFORMED");
      }
      if (BigInt(topics[1] ?? "") !== jobId) continue;
      if (`0x${topics[2]?.slice(-40)}` !== provider) throw new ApiBoundaryError("SOURCE_CONFLICT");
      matches.push({ availability: "submission_event", digest: hash(log.data), transactionHash,
        blockNumber: receiptNumber.toString(), blockHash: receiptHash, logIndex: index });
    }
    if (matches.length === 0) throw new ApiBoundaryError("SOURCE_NOT_FOUND");
    if (matches.length !== 1) throw new ApiBoundaryError("SOURCE_CONFLICT");
    // A second read protects a historical receipt block as well as the current job anchor.
    requireSameBlock(receiptBlock, block(await this.rpc.call("eth_getBlockByNumber", [receipt.blockNumber, false], lease, signal)));
    return matches[0]!;
  }

  async observe(input: JobEvidenceRequest, lease: SourceLease, signal: AbortSignal): Promise<JobEvidence> {
    const parsed = JobEvidenceRequestSchema.safeParse(input);
    if (!parsed.success) throw new ApiBoundaryError("INVALID_REQUEST");
    const request = parsed.data;
    requireChainId(await this.rpc.call("eth_chainId", [], lease, signal));
    const anchor = block(await this.rpc.call("eth_getBlockByNumber", ["latest", false], lease, signal));
    await this.requireImplementation(anchor, lease, signal);
    const jobId = BigInt(request.jobId);
    if (address(await this.contractCall("paymentToken", jobId, anchor, lease, signal)) !== ARC_TESTNET.contracts.usdc) {
      throw new ApiBoundaryError("SOURCE_CONFLICT");
    }
    const job = record(await this.contractCall("getJob", jobId, anchor, lease, signal));
    if (job.id === 0n) throw new ApiBoundaryError("SOURCE_NOT_FOUND");
    if (typeof job.id !== "bigint" || typeof job.budget !== "bigint" || typeof job.expiredAt !== "bigint" ||
      typeof job.status !== "number" || !Number.isInteger(job.status) || !JOB_STATUSES[job.status] ||
      typeof job.description !== "string" || job.description.length > 4096) throw new ApiBoundaryError("SOURCE_MALFORMED");
    if (job.id !== jobId) throw new ApiBoundaryError("SOURCE_CONFLICT");
    const explicitlySet = await this.contractCall("jobHasBudget", jobId, anchor, lease, signal);
    if (typeof explicitlySet !== "boolean") throw new ApiBoundaryError("SOURCE_MALFORMED");
    const expiryTimestamp = timestamp(`0x${job.expiredAt.toString(16)}`);
    const provider = address(job.provider);
    const deliverable = request.submissionTransactionHash ?
      await this.submission(request.submissionTransactionHash, jobId, provider, anchor, lease, signal) :
      { availability: "not_observed", reason: "not_returned_by_getJob" } as const;
    requireSameBlock(anchor, block(await this.rpc.call("eth_getBlockByNumber", [anchor.numberHex, false], lease, signal)));
    const result = JobEvidenceSchema.safeParse({
      schemaVersion: "openarc.job-evidence.v1", network: ARC_TESTNET.caip2, jobId: request.jobId,
      anchor: { blockNumber: anchor.numberDecimal, blockHash: anchor.hash, blockTimestamp: anchor.timestamp,
        finality: "deterministic", confirmations: "1" },
      client: address(job.client), provider, evaluator: address(job.evaluator), hook: address(job.hook),
      description: job.description, budget: { asset: "USDC", contract: ARC_TESTNET.contracts.usdc,
        ...amount(job.budget, 6), explicitlySet },
      expiry: { unixSeconds: job.expiredAt.toString(), timestamp: expiryTimestamp,
        deadlineReachedAtAnchor: Date.parse(anchor.timestamp) >= Date.parse(expiryTimestamp) },
      status: JOB_STATUSES[job.status], deliverable,
      source: { sourceId: "arc_primary_rpc", jobSourceId: "erc8183_reference", origin: ARC_TESTNET.rpcHttp,
        explorerOrigin: ARC_TESTNET.explorerOrigin, network: ARC_TESTNET.caip2, contract,
        implementation: ARC_ERC8183.implementation, sourceRevision: ARC_ERC8183.sourceRevision,
        reviewedAt: ARC_ERC8183.reviewedAt, sourceSha256: ARC_ERC8183.sourceSha256,
        observedAt: this.now(), adapterVersion: "openarc.job-evidence.m06.v1" },
      limitations: JOB_LIMITATIONS,
    });
    if (!result.success) throw new ApiBoundaryError("SOURCE_MALFORMED");
    return result.data;
  }
}
