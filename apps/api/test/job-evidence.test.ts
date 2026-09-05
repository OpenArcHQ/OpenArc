import { ARC_ERC8183, ARC_TESTNET, JOB_STATUSES, JobEvidenceRequestSchema, JobEvidenceSchema } from "@openarc/shared";
import { encodeFunctionResult, keccak256, toBytes } from "viem";
import { describe, expect, it } from "vitest";

import { JOB_ABI, JobService } from "../src/arc/job-service.js";
import type { ArcRpcMethod, ArcRpcReader } from "../src/arc/rpc-client.js";
import type { SourceLease } from "../src/limits/budget.js";

const signal = new AbortController().signal;
const lease = {} as SourceLease;
const client = `0x${"1".repeat(40)}` as const;
const provider = `0x${"2".repeat(40)}` as const;
const evaluator = `0x${"3".repeat(40)}` as const;
const zero = `0x${"0".repeat(40)}` as const;
const tx = `0x${"a".repeat(64)}` as const;
const digest = `0x${"b".repeat(64)}` as const;
const anchor = { number: "0x64", hash: `0x${"c".repeat(64)}`, timestamp: "0x6553f100" };
const implementation = `0x${"0".repeat(24)}${ARC_ERC8183.implementation.slice(2)}`;
const contract = ARC_TESTNET.contracts.erc8183AgenticCommerce;
const job = { id: 1n, client, provider, evaluator, description: "<script>untrusted text</script>",
  budget: 1234567890123456789012345n, expiredAt: 1_700_000_001n, status: 0, hook: zero };
const request = { network: ARC_TESTNET.caip2, jobId: "1" } as const;
const submission = { address: contract, topics: [keccak256(toBytes("JobSubmitted(uint256,address,bytes32)")),
  `0x${"0".repeat(63)}1`, `0x${"0".repeat(24)}${provider.slice(2)}`], data: digest,
  blockNumber: anchor.number, blockHash: anchor.hash, transactionHash: tx, transactionIndex: "0x0", logIndex: "0x2", removed: false };
const receipt = { transactionHash: tx, blockNumber: anchor.number, blockHash: anchor.hash,
  transactionIndex: "0x0", status: "0x1", logs: [submission] };

class SequenceRpc implements ArcRpcReader {
  readonly calls: { method: ArcRpcMethod; params: readonly unknown[] }[] = [];
  constructor(private readonly sequence: readonly unknown[]) {}
  async call(method: ArcRpcMethod, params: readonly unknown[]): Promise<unknown> {
    this.calls.push({ method, params });
    const value = this.sequence[this.calls.length - 1];
    if (value === undefined) throw new Error(`Unexpected call ${method}`);
    return value;
  }
}

function sequence(options: { job?: Partial<typeof job>; implementation?: string; token?: string;
  receipt?: unknown; explicitlySet?: boolean; repeated?: unknown; jobResult?: string } = {}) {
  return new SequenceRpc([ARC_TESTNET.chainIdHex, anchor, options.implementation ?? implementation,
    encodeFunctionResult({ abi: JOB_ABI, functionName: "paymentToken", result: (options.token ?? ARC_TESTNET.contracts.usdc) as `0x${string}` }),
    options.jobResult ?? encodeFunctionResult({ abi: JOB_ABI, functionName: "getJob", result: { ...job, ...options.job } }),
    encodeFunctionResult({ abi: JOB_ABI, functionName: "jobHasBudget", result: options.explicitlySet ?? true }),
    ...(options.receipt !== undefined ? [options.receipt, anchor, anchor] : []), options.repeated ?? anchor]);
}

describe("M06 reviewed reference job evidence", () => {
  it.each(JOB_STATUSES.map((status, index) => [status, index] as const))("observes %s without inventing lifecycle transitions", async (status, index) => {
    const rpc = sequence({ job: { status: index, expiredAt: index === 5 ? 1_700_000_000n : job.expiredAt } });
    const result = await new JobService(rpc).observe(request, lease, signal);
    expect(result.status).toBe(status);
    expect(result.budget.decimal).toBe("1234567890123456789.012345");
    expect(result.description).toBe(job.description);
    expect(result.deliverable).toEqual({ availability: "not_observed", reason: "not_returned_by_getJob" });
    expect(rpc.calls).toHaveLength(7);
    for (const call of rpc.calls.filter((entry) => entry.method === "eth_call")) {
      expect(call.params[1]).toBe(anchor.number);
      expect((call.params[0] as { to: string }).to).toBe(contract);
    }
    expect(rpc.calls[2]?.params).toEqual([contract, ARC_ERC8183.implementationSlot, anchor.number]);
  });

  it("keeps deadline timing separate from contract status and permits zero budgets", async () => {
    const result = await new JobService(sequence({ job: { status: 2, budget: 0n, expiredAt: 1_700_000_000n }, explicitlySet: false }))
      .observe(request, lease, signal);
    expect(result.status).toBe("Submitted");
    expect(result.expiry.deadlineReachedAtAnchor).toBe(true);
    expect(result.budget).toMatchObject({ baseUnits: "0", decimal: "0", explicitlySet: false });
  });

  it("accepts an unassigned provider on an open job", async () => {
    expect((await new JobService(sequence({ job: { provider: zero, budget: 0n }, explicitlySet: false }))
      .observe(request, lease, signal)).provider).toBe(zero);
  });

  it("reads a deliverable only from the exact matching submission event", async () => {
    const rpc = sequence({ job: { status: 3 }, receipt });
    const result = await new JobService(rpc).observe({ ...request, submissionTransactionHash: tx }, lease, signal);
    expect(result.deliverable).toEqual({ availability: "submission_event", digest, transactionHash: tx,
      blockNumber: "100", blockHash: anchor.hash, logIndex: "2" });
    expect(rpc.calls).toHaveLength(10);
    expect(rpc.calls.some((call) => String(call.method).includes("Logs"))).toBe(false);
  });

  it("binds historical submission semantics and both repeated anchors within eleven calls", async () => {
    const historical = { number: "0x63", hash: digest, timestamp: "0x6553f0ff" };
    const historicalReceipt = { ...receipt, blockNumber: historical.number, blockHash: historical.hash,
      logs: [{ ...submission, blockNumber: historical.number, blockHash: historical.hash }] };
    const prefix = [ARC_TESTNET.chainIdHex, anchor, implementation,
      encodeFunctionResult({ abi: JOB_ABI, functionName: "paymentToken", result: ARC_TESTNET.contracts.usdc as `0x${string}` }),
      encodeFunctionResult({ abi: JOB_ABI, functionName: "getJob", result: { ...job, status: 3 } }),
      encodeFunctionResult({ abi: JOB_ABI, functionName: "jobHasBudget", result: true }), historicalReceipt, historical];
    const rpc = new SequenceRpc([...prefix, implementation, historical, anchor]);
    expect((await new JobService(rpc).observe({ ...request, submissionTransactionHash: tx }, lease, signal))
      .deliverable).toMatchObject({ availability: "submission_event", blockNumber: "99" });
    expect(rpc.calls).toHaveLength(11);
    expect(rpc.calls[8]?.params[2]).toBe("0x63");
    await expect(new JobService(new SequenceRpc([...prefix, `0x${"0".repeat(64)}`]))
      .observe({ ...request, submissionTransactionHash: tx }, lease, signal)).rejects.toMatchObject({ code: "UNSUPPORTED_EVIDENCE" });
    await expect(new JobService(new SequenceRpc([...prefix, implementation, { ...historical, hash: anchor.hash }]))
      .observe({ ...request, submissionTransactionHash: tx }, lease, signal)).rejects.toMatchObject({ code: "SOURCE_CONFLICT" });
  });

  it.each([
    ["unknown implementation", { implementation: `0x${"0".repeat(64)}` }, "UNSUPPORTED_EVIDENCE"],
    ["wrong payment asset", { token: provider }, "SOURCE_CONFLICT"],
    ["missing job", { job: { id: 0n } }, "SOURCE_NOT_FOUND"],
    ["wrong job", { job: { id: 2n } }, "SOURCE_CONFLICT"],
    ["unknown status", { job: { status: 6 } }, "SOURCE_MALFORMED"],
    ["unbounded expiry", { job: { expiredAt: 253_402_300_800n } }, "SOURCE_MALFORMED"],
    ["zero expiry", { job: { expiredAt: 0n } }, "SOURCE_MALFORMED"],
    ["unset nonzero budget", { explicitlySet: false }, "SOURCE_MALFORMED"],
    ["missing assigned provider", { job: { provider: zero, status: 1 } }, "SOURCE_MALFORMED"],
    ["budget assigned without a provider", { job: { provider: zero, budget: 0n } }, "SOURCE_MALFORMED"],
    ["missing client", { job: { client: zero } }, "SOURCE_MALFORMED"],
    ["missing evaluator", { job: { evaluator: zero } }, "SOURCE_MALFORMED"],
    ["premature expired state", { job: { status: 5 } }, "SOURCE_MALFORMED"],
    ["oversized description", { job: { description: "x".repeat(4097) } }, "SOURCE_MALFORMED"],
    ["malformed ABI", { jobResult: "0x1234" }, "SOURCE_MALFORMED"],
    ["changed anchor", { repeated: { ...anchor, hash: digest } }, "SOURCE_CONFLICT"],
  ] as const)("fails closed: %s", async (_name, options, code) => {
    await expect(new JobService(sequence(options)).observe(request, lease, signal)).rejects.toMatchObject({ code });
  });

  it.each([
    ["missing receipt", null, "SOURCE_NOT_FOUND"],
    ["failed transaction", { ...receipt, status: "0x0" }, "SOURCE_CONFLICT"],
    ["wrong transaction", { ...receipt, transactionHash: digest }, "SOURCE_CONFLICT"],
    ["wrong emitting contract", { ...receipt, logs: [{ ...submission, address: provider }] }, "SOURCE_NOT_FOUND"],
    ["wrong provider", { ...receipt, logs: [{ ...submission, topics: [...submission.topics.slice(0, 2), `0x${"0".repeat(24)}${client.slice(2)}`] }] }, "SOURCE_CONFLICT"],
    ["wrong job", { ...receipt, logs: [{ ...submission, topics: [submission.topics[0], `0x${"0".repeat(63)}2`, submission.topics[2]] }] }, "SOURCE_NOT_FOUND"],
    ["duplicate submission", { ...receipt, logs: [submission, { ...submission, logIndex: "0x3" }] }, "SOURCE_CONFLICT"],
    ["removed log", { ...receipt, logs: [{ ...submission, removed: true }] }, "SOURCE_CONFLICT"],
    ["wrong receipt block", { ...receipt, blockHash: digest }, "SOURCE_CONFLICT"],
    ["receipt after anchor", { ...receipt, blockNumber: "0x65" }, "SOURCE_CONFLICT"],
    ["malformed digest", { ...receipt, logs: [{ ...submission, data: "0x12" }] }, "SOURCE_MALFORMED"],
    ["overlarge log set", { ...receipt, logs: Array.from({ length: 257 }, () => submission) }, "SOURCE_MALFORMED"],
  ] as const)("rejects submission evidence: %s", async (_name, mutatedReceipt, code) => {
    await expect(new JobService(sequence({ job: { status: 2 }, receipt: mutatedReceipt }))
      .observe({ ...request, submissionTransactionHash: tx }, lease, signal)).rejects.toMatchObject({ code });
  });

  it("rejects a submission receipt conflicting with the observed job status", async () => {
    await expect(new JobService(sequence({ receipt })).observe({ ...request, submissionTransactionHash: tx }, lease, signal))
      .rejects.toMatchObject({ code: "SOURCE_MALFORMED" });
  });

  it("rejects an impossible submission by an unassigned provider on a rejected job", async () => {
    const rejected = { provider: zero, budget: 0n, status: 4 };
    const withoutSubmission = await new JobService(sequence({ job: rejected, explicitlySet: false }))
      .observe(request, lease, signal);
    expect(withoutSubmission.status).toBe("Rejected");
    expect(JobEvidenceSchema.safeParse({ ...withoutSubmission, deliverable: {
      availability: "submission_event", digest, transactionHash: tx,
      blockNumber: "100", blockHash: anchor.hash, logIndex: "2",
    } }).success).toBe(false);
    const impossibleReceipt = { ...receipt, logs: [{ ...submission,
      topics: [...submission.topics.slice(0, 2), `0x${"0".repeat(64)}`] }] };
    await expect(new JobService(sequence({ job: rejected, explicitlySet: false, receipt: impossibleReceipt }))
      .observe({ ...request, submissionTransactionHash: tx }, lease, signal))
      .rejects.toMatchObject({ code: "SOURCE_MALFORMED" });
  });

  it("rejects response amounts, dates, and source identities that do not match their fields", async () => {
    const result = await new JobService(sequence()).observe(request, lease, signal);
    expect(JobEvidenceSchema.safeParse({ ...result, budget: { ...result.budget, decimal: "1" } }).success).toBe(false);
    expect(JobEvidenceSchema.safeParse({ ...result, expiry: { ...result.expiry, deadlineReachedAtAnchor: true } }).success).toBe(false);
    expect(JobEvidenceSchema.safeParse({ ...result, source: { ...result.source, contract: provider } }).success).toBe(false);
    expect(JobEvidenceSchema.safeParse({ ...result, anchor: { ...result.anchor, blockNumber: (1n << 256n).toString() } }).success).toBe(false);
    for (const value of ["garbage", "1.0", "", "-1"]) {
      expect(JobEvidenceSchema.safeParse({ ...result, budget: { ...result.budget, baseUnits: value } }).success).toBe(false);
      expect(JobEvidenceSchema.safeParse({ ...result, expiry: { ...result.expiry, unixSeconds: value } }).success).toBe(false);
    }
  });

  it.each(["0", "01", "-1", "1.0", "garbage", "", ((1n << 256n)).toString()])("rejects invalid job ID %s", (jobId) => {
    expect(JobEvidenceRequestSchema.safeParse({ ...request, jobId }).success).toBe(false);
  });

  it("does not accept caller-selected RPCs, contracts, or private labels", () => {
    for (const extra of [{ contract: provider }, { rpc: "https://example.test" }, { localDescription: "private" }]) {
      expect(JobEvidenceRequestSchema.safeParse({ ...request, ...extra }).success).toBe(false);
    }
  });
});
