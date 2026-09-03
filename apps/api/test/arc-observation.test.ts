import { ARC_TESTNET } from "@openarc/shared";
import { describe, expect, it } from "vitest";

import { ArcAccountService } from "../src/arc/account-service.js";
import type { ArcRpcMethod, ArcRpcReader } from "../src/arc/rpc-client.js";
import { ArcTransactionService } from "../src/arc/transaction-service.js";
import { ApiBoundaryError } from "../src/http/errors.js";
import type { SourceLease } from "../src/limits/budget.js";

const signal = new AbortController().signal;
const lease = {} as SourceLease;
const addressA = "0x1111111111111111111111111111111111111111";
const addressB = "0x2222222222222222222222222222222222222222";
const blockHash = `0x${"a".repeat(64)}`;
const otherBlockHash = `0x${"b".repeat(64)}`;
const transactionHash = `0x${"c".repeat(64)}`;
const otherTransactionHash = `0x${"d".repeat(64)}`;
const anchor = { number: "0x64", hash: blockHash, timestamp: "0x6553f100" };

function word(value: bigint): string { return `0x${value.toString(16).padStart(64, "0")}`; }
function topic(value: string): string { return `0x${value.slice(2).padStart(64, "0")}`; }

class SequenceRpc implements ArcRpcReader {
  readonly calls: { method: ArcRpcMethod; params: readonly unknown[] }[] = [];
  constructor(private readonly sequence: readonly unknown[]) {}
  async call(method: ArcRpcMethod, params: readonly unknown[]): Promise<unknown> {
    this.calls.push({ method, params });
    if (this.calls.length > this.sequence.length) throw new Error("Unexpected RPC call");
    return this.sequence[this.calls.length - 1];
  }
}

function accountRpc(mutations: { chain?: unknown; repeated?: unknown; native?: bigint; erc20?: bigint } = {}) {
  const native = mutations.native ?? 100_000_000_100_000_000_000n;
  const erc20 = mutations.erc20 ?? native / 1_000_000_000_000n;
  return new SequenceRpc([
    mutations.chain ?? ARC_TESTNET.chainIdHex,
    anchor,
    `0x${native.toString(16)}`,
    word(erc20),
    mutations.repeated ?? anchor,
  ]);
}

describe("M04 account observation", () => {
  it("keeps exact 18-decimal precision and proves the truncating 6-decimal view at one anchor", async () => {
    const rpc = accountRpc();
    const observed = await new ArcAccountService(rpc, () => "2026-09-03T12:00:00.000Z")
      .observe({ network: ARC_TESTNET.caip2, address: addressA }, lease, signal);

    expect(observed.nativeUsdc.amount).toEqual({
      baseUnits: "100000000100000000000", decimals: 18, decimal: "100.0000001",
    });
    expect(observed.erc20UsdcView.amount).toEqual({
      baseUnits: "100000000", decimals: 6, decimal: "100",
    });
    expect(observed.anchor).toEqual({ blockNumber: "100", blockHash,
      blockTimestamp: "2023-11-14T22:13:20.000Z", finality: "deterministic", confirmations: "1" });
    expect(rpc.calls.map((entry) => entry.method)).toEqual([
      "eth_chainId", "eth_getBlockByNumber", "eth_getBalance", "eth_call", "eth_getBlockByNumber",
    ]);
    expect(rpc.calls[2]?.params).toEqual([addressA, "0x64"]);
  });

  it("retains a sub-micro native balance when the ERC-20 view is zero", async () => {
    const observed = await new ArcAccountService(accountRpc({ native: 100_000_000_000n, erc20: 0n }))
      .observe({ network: ARC_TESTNET.caip2, address: addressA }, lease, signal);
    expect(observed.nativeUsdc.amount.decimal).toBe("0.0000001");
    expect(observed.erc20UsdcView.amount.decimal).toBe("0");
  });

  it.each([
    ["wrong chain", accountRpc({ chain: "0x1" }), "SOURCE_WRONG_NETWORK"],
    ["anchor changed", accountRpc({ repeated: { ...anchor, hash: otherBlockHash } }), "SOURCE_CONFLICT"],
    ["six-decimal view conflicts", accountRpc({ erc20: 99n }), "SOURCE_CONFLICT"],
  ])("rejects %s", async (_name, rpc, code) => {
    await expect(new ArcAccountService(rpc).observe(
      { network: ARC_TESTNET.caip2, address: addressA }, lease, signal,
    )).rejects.toMatchObject({ code });
  });
});

function transferLog(emitter: string, index: string, from: string, to: string, value: bigint) {
  return { address: emitter, topics: [ARC_TESTNET.transferTopic, topic(from), topic(to)], data: word(value),
    transactionHash, blockHash, blockNumber: "0x64", transactionIndex: "0x2", logIndex: index,
    removed: false };
}

function transactionRpc(mutations: {
  chain?: unknown;
  transaction?: Record<string, unknown> | null;
  receipt?: Record<string, unknown> | null;
  block?: unknown;
  repeated?: unknown;
} = {}) {
  const transaction = mutations.transaction === undefined ? {
    hash: transactionHash, blockHash, blockNumber: "0x64", transactionIndex: "0x2",
    from: addressA, to: addressB, value: "0x0",
  } : mutations.transaction;
  const suppliedReceipt = mutations.receipt === undefined ? {
    transactionHash, blockHash, blockNumber: "0x64", transactionIndex: "0x2", status: "0x1",
    gasUsed: "0x5208", effectiveGasPrice: "0x4a817c800",
    logs: [
      transferLog(ARC_TESTNET.usdcSystemEmitter, "0x0", addressA, addressB, 1_000_000_000_000_000_000n),
      transferLog(ARC_TESTNET.contracts.usdc.toLowerCase(), "0x1", addressA, addressB, 1_000_000n),
      { address: ARC_TESTNET.contracts.usdc, topics: [`0x${"e".repeat(64)}`], data: "0x",
        transactionHash, blockHash, blockNumber: "0x64", transactionIndex: "0x2", logIndex: "0x2",
        removed: false },
    ],
  } : mutations.receipt;
  const receipt = suppliedReceipt === null ? null : { from: addressA, to: addressB, ...suppliedReceipt };
  return new SequenceRpc([
    mutations.chain ?? ARC_TESTNET.chainIdHex,
    transaction,
    receipt,
    mutations.block ?? anchor,
    mutations.repeated ?? anchor,
  ]);
}

describe("M04 transaction observation", () => {
  it("returns one canonical movement and marks the duplicate ERC-20 event as corroboration", async () => {
    const rpc = transactionRpc();
    const observed = await new ArcTransactionService(rpc, () => "2026-09-03T12:00:00.000Z")
      .observe({ network: ARC_TESTNET.caip2, transactionHash }, lease, signal);

    expect(observed.movements).toHaveLength(1);
    expect(observed.movements[0]).toMatchObject({
      classification: "canonical_eip7708_usdc", logIndex: "0", from: addressA, to: addressB,
      amount: { baseUnits: "1000000000000000000", decimals: 18, decimal: "1" },
      erc20Corroboration: { logIndex: "1", amount: { baseUnits: "1000000", decimals: 6, decimal: "1" } },
    });
    expect(observed.coverage).toEqual({ totalLogs: 3, canonicalMovements: 1,
      corroboratedMovements: 1, unsupportedLogs: 1, completeForUsdcTransfers: true });
    expect(observed.receipt.fee).toEqual({
      baseUnits: "420000000000000", decimals: 18, decimal: "0.00042",
    });
    expect(rpc.calls.map((entry) => entry.method)).toEqual([
      "eth_chainId", "eth_getTransactionByHash", "eth_getTransactionReceipt",
      "eth_getBlockByHash", "eth_getBlockByNumber",
    ]);
  });

  it("pairs repeated equal ERC-20 logs one-to-one without adding movements", async () => {
    const system0 = transferLog(ARC_TESTNET.usdcSystemEmitter, "0x0", addressA, addressB, 1_000_000_000_000_000_000n);
    const system1 = transferLog(ARC_TESTNET.usdcSystemEmitter, "0x1", addressA, addressB, 1_000_000_000_000_000_000n);
    const erc0 = transferLog(ARC_TESTNET.contracts.usdc.toLowerCase(), "0x2", addressA, addressB, 1_000_000n);
    const erc1 = transferLog(ARC_TESTNET.contracts.usdc.toLowerCase(), "0x3", addressA, addressB, 1_000_000n);
    const rpc = transactionRpc({ receipt: { transactionHash, blockHash, blockNumber: "0x64",
      transactionIndex: "0x2", status: "0x1", gasUsed: "0x1", effectiveGasPrice: "0x1",
      logs: [system0, system1, erc0, erc1] } });
    const observed = await new ArcTransactionService(rpc).observe(
      { network: ARC_TESTNET.caip2, transactionHash }, lease, signal,
    );
    expect(observed.movements).toHaveLength(2);
    expect(observed.movements.map((movement) => movement.erc20Corroboration?.logIndex)).toEqual(["2", "3"]);
  });

  it("orders movements by numeric log index even when input order differs", async () => {
    const later = transferLog(ARC_TESTNET.usdcSystemEmitter, "0xa", addressA, addressB, 2n);
    const earlier = transferLog(ARC_TESTNET.usdcSystemEmitter, "0x2", addressA, addressB, 1n);
    const rpc = transactionRpc({ receipt: { transactionHash, blockHash, blockNumber: "0x64",
      transactionIndex: "0x2", status: "0x1", gasUsed: "0x1", effectiveGasPrice: "0x1",
      logs: [later, earlier] } });
    const observed = await new ArcTransactionService(rpc).observe(
      { network: ARC_TESTNET.caip2, transactionHash }, lease, signal,
    );
    expect(observed.movements.map((movement) => movement.logIndex)).toEqual(["2", "10"]);
  });

  it.each([
    ["wrong chain", transactionRpc({ chain: "0x1" }), "SOURCE_WRONG_NETWORK"],
    ["missing transaction", transactionRpc({ transaction: null }), "SOURCE_NOT_FOUND"],
    ["mismatched receipt hash", transactionRpc({ receipt: { transactionHash: otherTransactionHash,
      blockHash, blockNumber: "0x64", transactionIndex: "0x2", status: "0x1",
      gasUsed: "0x1", effectiveGasPrice: "0x1", logs: [] } }), "SOURCE_CONFLICT"],
    ["mismatched receipt block", transactionRpc({ receipt: { transactionHash,
      blockHash: otherBlockHash, blockNumber: "0x64", transactionIndex: "0x2", status: "0x1",
      gasUsed: "0x1", effectiveGasPrice: "0x1", logs: [] } }), "SOURCE_CONFLICT"],
    ["mismatched receipt sender", transactionRpc({ receipt: { from: addressB, transactionHash,
      blockHash, blockNumber: "0x64", transactionIndex: "0x2", status: "0x1",
      gasUsed: "0x1", effectiveGasPrice: "0x1", logs: [] } }), "SOURCE_CONFLICT"],
    ["anchor mismatch", transactionRpc({ repeated: { ...anchor, hash: otherBlockHash } }), "SOURCE_CONFLICT"],
    ["malformed allowlisted log", transactionRpc({ receipt: { transactionHash, blockHash,
      blockNumber: "0x64", transactionIndex: "0x2", status: "0x1", gasUsed: "0x1",
      effectiveGasPrice: "0x1", logs: [{ ...transferLog(ARC_TESTNET.usdcSystemEmitter, "0x0",
        addressA, addressB, 1n), topics: [ARC_TESTNET.transferTopic] }] } }), "SOURCE_MALFORMED"],
    ["unmatched ERC-20 duplicate", transactionRpc({ receipt: { transactionHash, blockHash,
      blockNumber: "0x64", transactionIndex: "0x2", status: "0x1", gasUsed: "0x1",
      effectiveGasPrice: "0x1", logs: [transferLog(ARC_TESTNET.contracts.usdc.toLowerCase(), "0x1",
        addressA, addressB, 1n)] } }), "SOURCE_CONFLICT"],
    ["failed receipt with movement", transactionRpc({ receipt: { transactionHash, blockHash,
      blockNumber: "0x64", transactionIndex: "0x2", status: "0x0", gasUsed: "0x1",
      effectiveGasPrice: "0x1", logs: [transferLog(ARC_TESTNET.usdcSystemEmitter, "0x0",
        addressA, addressB, 1n)] } }), "SOURCE_CONFLICT"],
    ["log belongs to another transaction index", transactionRpc({ receipt: { transactionHash, blockHash,
      blockNumber: "0x64", transactionIndex: "0x2", status: "0x1", gasUsed: "0x1",
      effectiveGasPrice: "0x1", logs: [{ ...transferLog(ARC_TESTNET.usdcSystemEmitter, "0x0",
        addressA, addressB, 1n), transactionIndex: "0x3" }] } }), "SOURCE_CONFLICT"],
    ["removed log", transactionRpc({ receipt: { transactionHash, blockHash,
      blockNumber: "0x64", transactionIndex: "0x2", status: "0x1", gasUsed: "0x1",
      effectiveGasPrice: "0x1", logs: [{ ...transferLog(ARC_TESTNET.usdcSystemEmitter, "0x0",
        addressA, addressB, 1n), removed: true }] } }), "SOURCE_CONFLICT"],
    ["fee multiplication overflows uint256", transactionRpc({ receipt: { transactionHash, blockHash,
      blockNumber: "0x64", transactionIndex: "0x2", status: "0x1",
      gasUsed: `0x${"f".repeat(64)}`, effectiveGasPrice: `0x${"f".repeat(64)}`, logs: [] } }),
    "SOURCE_MALFORMED"],
  ])("rejects %s", async (_name, rpc, code) => {
    await expect(new ArcTransactionService(rpc).observe(
      { network: ARC_TESTNET.caip2, transactionHash }, lease, signal,
    )).rejects.toMatchObject({ code });
  });

  it("maps only bounded API errors", () => {
    expect(new ApiBoundaryError("SOURCE_CONFLICT").message).not.toContain(transactionHash);
  });
});
