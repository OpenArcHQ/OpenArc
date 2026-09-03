import {
  ARC_TESTNET,
  ArcTransactionEvidenceSchema,
  type ArcCanonicalMovement,
  type ArcTransactionEvidence,
  type ArcTransactionEvidenceRequest,
} from "@openarc/shared";

import { ApiBoundaryError } from "../http/errors.js";
import type { SourceLease } from "../limits/budget.js";
import { amount, integer, parseHexQuantity, parseWord, record } from "./quantities.js";
import type { ArcRpcReader } from "./rpc-client.js";
import { address, block, hash, requireChainId, requireSameBlock } from "./validation.js";

const SCALE = 1_000_000_000_000n;
const TOPIC_ADDRESS = /^0x0{24}([0-9a-f]{40})$/u;

interface ParsedTransfer {
  emitter: string;
  logIndex: bigint;
  from: string;
  to: string;
  value: bigint;
}

function transfer(source: Record<string, unknown>, emitter: string): ParsedTransfer {
  const topics = source.topics;
  if (!Array.isArray(topics) || topics.length !== 3 || topics[0] !== ARC_TESTNET.transferTopic) {
    throw new ApiBoundaryError("SOURCE_MALFORMED");
  }
  const fromMatch = typeof topics[1] === "string" ? TOPIC_ADDRESS.exec(topics[1]) : null;
  const toMatch = typeof topics[2] === "string" ? TOPIC_ADDRESS.exec(topics[2]) : null;
  if (!fromMatch || !toMatch) throw new ApiBoundaryError("SOURCE_MALFORMED");
  const from = address(`0x${fromMatch[1]}`);
  const to = address(`0x${toMatch[1]}`);
  return { emitter, logIndex: parseHexQuantity(source.logIndex), from, to, value: parseWord(source.data) };
}

function movements(logs: unknown[], transactionHash: string, blockHash: string, blockNumber: bigint,
  transactionIndex: bigint,
  successful: boolean): { movements: ArcCanonicalMovement[]; unsupported: number; corroborated: number } {
  if (logs.length > 256) throw new ApiBoundaryError("SOURCE_MALFORMED");
  const system: ParsedTransfer[] = [];
  const erc20: ParsedTransfer[] = [];
  let unsupported = 0;
  const seenIndexes = new Set<string>();
  for (const raw of logs) {
    const source = record(raw);
    const emitter = address(source.address);
    if (hash(source.transactionHash) !== transactionHash || hash(source.blockHash) !== blockHash ||
      parseHexQuantity(source.blockNumber) !== blockNumber ||
      parseHexQuantity(source.transactionIndex) !== transactionIndex || source.removed === true) {
      throw new ApiBoundaryError("SOURCE_CONFLICT");
    }
    const index = parseHexQuantity(source.logIndex);
    const indexKey = integer(index);
    if (seenIndexes.has(indexKey)) throw new ApiBoundaryError("SOURCE_CONFLICT");
    seenIndexes.add(indexKey);
    if (!Array.isArray(source.topics) || source.topics.length > 4 ||
      !source.topics.every((topic) => typeof topic === "string" && /^0x[0-9a-f]{64}$/u.test(topic)) ||
      typeof source.data !== "string" || !/^0x(?:[0-9a-f]{2})*$/u.test(source.data)) {
      throw new ApiBoundaryError("SOURCE_MALFORMED");
    }
    if (emitter === ARC_TESTNET.usdcSystemEmitter) {
      system.push(transfer(source, emitter));
    } else if (emitter === ARC_TESTNET.contracts.usdc.toLowerCase() && source.topics[0] === ARC_TESTNET.transferTopic) {
      erc20.push(transfer(source, emitter));
    } else unsupported += 1;
  }
  system.sort((left, right) => left.logIndex < right.logIndex ? -1 : left.logIndex > right.logIndex ? 1 : 0);
  erc20.sort((left, right) => left.logIndex < right.logIndex ? -1 : left.logIndex > right.logIndex ? 1 : 0);
  if (!successful && (system.length > 0 || erc20.length > 0)) throw new ApiBoundaryError("SOURCE_CONFLICT");
  for (const event of system) {
    if (event.value === 0n || event.from === event.to) throw new ApiBoundaryError("SOURCE_CONFLICT");
  }

  const consumed = new Set<number>();
  const corroborationBySystem = new Map<number, ParsedTransfer>();
  for (const event of erc20) {
    if (event.value === 0n) continue;
    const match = system.findIndex((candidate, index) => !consumed.has(index) &&
      candidate.logIndex < event.logIndex && candidate.from === event.from && candidate.to === event.to &&
      candidate.value === event.value * SCALE);
    if (match < 0) throw new ApiBoundaryError("SOURCE_CONFLICT");
    consumed.add(match);
    corroborationBySystem.set(match, event);
  }
  const normalized = system.map((event, index): ArcCanonicalMovement => {
    const corroboration = corroborationBySystem.get(index);
    return {
      classification: "canonical_eip7708_usdc",
      emitter: ARC_TESTNET.usdcSystemEmitter,
      logIndex: integer(event.logIndex),
      from: event.from,
      to: event.to,
      amount: amount(event.value, 18),
      erc20Corroboration: corroboration ? {
        emitter: ARC_TESTNET.contracts.usdc.toLowerCase(), logIndex: integer(corroboration.logIndex),
        amount: amount(corroboration.value, 6),
      } : null,
    };
  });
  return { movements: normalized, unsupported, corroborated: corroborationBySystem.size };
}

export class ArcTransactionService {
  constructor(private readonly rpc: ArcRpcReader, private readonly now: () => string = () => new Date().toISOString()) {}

  async observe(input: ArcTransactionEvidenceRequest, lease: SourceLease, signal: AbortSignal): Promise<ArcTransactionEvidence> {
    requireChainId(await this.rpc.call("eth_chainId", [], lease, signal));
    const rawTransaction = await this.rpc.call("eth_getTransactionByHash", [input.transactionHash], lease, signal);
    const rawReceipt = await this.rpc.call("eth_getTransactionReceipt", [input.transactionHash], lease, signal);
    if (rawTransaction === null || rawReceipt === null) throw new ApiBoundaryError("SOURCE_NOT_FOUND");
    const transaction = record(rawTransaction);
    const receipt = record(rawReceipt);
    const txHash = hash(transaction.hash);
    if (txHash !== input.transactionHash || hash(receipt.transactionHash) !== input.transactionHash) {
      throw new ApiBoundaryError("SOURCE_CONFLICT");
    }
    const txBlockHash = hash(transaction.blockHash);
    const receiptBlockHash = hash(receipt.blockHash);
    const txBlockNumber = parseHexQuantity(transaction.blockNumber);
    const receiptBlockNumber = parseHexQuantity(receipt.blockNumber);
    const txIndex = parseHexQuantity(transaction.transactionIndex);
    const receiptIndex = parseHexQuantity(receipt.transactionIndex);
    if (txBlockHash !== receiptBlockHash || txBlockNumber !== receiptBlockNumber || txIndex !== receiptIndex) {
      throw new ApiBoundaryError("SOURCE_CONFLICT");
    }
    const txFrom = address(transaction.from);
    const txTo = transaction.to === null ? null : address(transaction.to);
    if (address(receipt.from) !== txFrom ||
      (receipt.to === null ? null : address(receipt.to)) !== txTo) throw new ApiBoundaryError("SOURCE_CONFLICT");
    const anchored = block(await this.rpc.call("eth_getBlockByHash", [txBlockHash, false], lease, signal));
    const repeated = block(await this.rpc.call("eth_getBlockByNumber", [anchored.numberHex, false], lease, signal));
    requireSameBlock(anchored, repeated);
    if (anchored.hash !== txBlockHash || anchored.number !== txBlockNumber) throw new ApiBoundaryError("SOURCE_CONFLICT");

    const statusValue = parseHexQuantity(receipt.status);
    if (statusValue !== 0n && statusValue !== 1n) throw new ApiBoundaryError("SOURCE_MALFORMED");
    const successful = statusValue === 1n;
    const gasUsed = parseHexQuantity(receipt.gasUsed);
    const effectiveGasPrice = parseHexQuantity(receipt.effectiveGasPrice);
    const fee = gasUsed * effectiveGasPrice;
    if (fee > (1n << 256n) - 1n) throw new ApiBoundaryError("SOURCE_MALFORMED");
    const value = parseHexQuantity(transaction.value);
    if (!Array.isArray(receipt.logs)) throw new ApiBoundaryError("SOURCE_MALFORMED");
    const decoded = movements(receipt.logs, txHash, txBlockHash, txBlockNumber, txIndex, successful);

    return ArcTransactionEvidenceSchema.parse({
      schemaVersion: "openarc.arc-transaction-evidence.v1",
      network: ARC_TESTNET.caip2,
      transaction: { hash: txHash, blockNumber: integer(txBlockNumber), blockHash: txBlockHash,
        transactionIndex: integer(txIndex), from: txFrom,
        to: txTo, nativeValue: amount(value, 18) },
      receipt: { status: successful ? "success" : "failed", gasUsed: integer(gasUsed),
        effectiveGasPrice: amount(effectiveGasPrice, 18), fee: amount(fee, 18) },
      anchor: { blockNumber: anchored.numberDecimal, blockHash: anchored.hash,
        blockTimestamp: anchored.timestamp, finality: "deterministic", confirmations: "1" },
      movements: decoded.movements,
      coverage: { totalLogs: receipt.logs.length, canonicalMovements: decoded.movements.length,
        corroboratedMovements: decoded.corroborated, unsupportedLogs: decoded.unsupported,
        completeForUsdcTransfers: true },
      source: { sourceId: "arc_primary_rpc", origin: ARC_TESTNET.rpcHttp,
        explorerOrigin: ARC_TESTNET.explorerOrigin, network: ARC_TESTNET.caip2,
        sourceRevision: ARC_TESTNET.sourceRevision, observedAt: this.now(),
        adapterVersion: "openarc.arc-observation.m04.v1" },
      limitations: [
        "This is a read-only observation of one Arc Testnet transaction and receipt.",
        "EIP-7708 system events are canonical; matching ERC-20 events are corroboration, not additional movements.",
        "Transaction inclusion does not prove intent, authorization, fulfillment, or service quality.",
      ],
    });
  }
}
