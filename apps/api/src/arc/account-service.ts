import {
  ARC_TESTNET,
  ArcAccountSnapshotSchema,
  type ArcAccountSnapshot,
  type ArcAccountSnapshotRequest,
} from "@openarc/shared";

import { ApiBoundaryError } from "../http/errors.js";
import type { SourceLease } from "../limits/budget.js";
import { amount, parseHexQuantity, parseWord } from "./quantities.js";
import type { ArcRpcReader } from "./rpc-client.js";
import { block, requireChainId, requireSameBlock } from "./validation.js";

const SCALE = 1_000_000_000_000n;

export class ArcAccountService {
  constructor(private readonly rpc: ArcRpcReader, private readonly now: () => string = () => new Date().toISOString()) {}

  async observe(input: ArcAccountSnapshotRequest, lease: SourceLease, signal: AbortSignal): Promise<ArcAccountSnapshot> {
    requireChainId(await this.rpc.call("eth_chainId", [], lease, signal));
    const anchor = block(await this.rpc.call("eth_getBlockByNumber", ["latest", false], lease, signal));
    const native = parseHexQuantity(await this.rpc.call("eth_getBalance", [input.address, anchor.numberHex], lease, signal));
    const balanceOfData = `0x70a08231${input.address.slice(2).padStart(64, "0")}`;
    const erc20 = parseWord(await this.rpc.call("eth_call", [{
      to: ARC_TESTNET.contracts.usdc.toLowerCase(), data: balanceOfData,
    }, anchor.numberHex], lease, signal));
    const repeated = block(await this.rpc.call("eth_getBlockByNumber", [anchor.numberHex, false], lease, signal));
    requireSameBlock(anchor, repeated);
    if (native / SCALE !== erc20) throw new ApiBoundaryError("SOURCE_CONFLICT");

    return ArcAccountSnapshotSchema.parse({
      schemaVersion: "openarc.arc-account-snapshot.v1",
      network: ARC_TESTNET.caip2,
      address: input.address,
      anchor: { blockNumber: anchor.numberDecimal, blockHash: anchor.hash,
        blockTimestamp: anchor.timestamp, finality: "deterministic", confirmations: "1" },
      nativeUsdc: { asset: "USDC", interface: "native", amount: amount(native, 18) },
      erc20UsdcView: { asset: "USDC", interface: "erc20",
        contract: ARC_TESTNET.contracts.usdc.toLowerCase(), amount: amount(erc20, 6),
        relationship: "same_underlying_balance", truncatesSubMicroUsdc: true },
      source: { sourceId: "arc_primary_rpc", origin: ARC_TESTNET.rpcHttp,
        explorerOrigin: ARC_TESTNET.explorerOrigin, network: ARC_TESTNET.caip2,
        sourceRevision: ARC_TESTNET.sourceRevision, observedAt: this.now(),
        adapterVersion: "openarc.arc-observation.m04.v1" },
      limitations: [
        "This is a read-only observation at one exact Arc Testnet block.",
        "The 6-decimal ERC-20 view truncates native precision below one micro-USDC.",
        "A public address is not proof that its owner or controller is an agent.",
      ],
    });
  }
}
