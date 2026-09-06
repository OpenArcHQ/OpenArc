import { randomUUID } from "node:crypto";

import { ApiBoundaryError } from "../http/errors.js";
import type { SourceLease } from "../limits/budget.js";
import type { BoundedProviderClient } from "../providers/http.js";
import { record } from "./quantities.js";

export const ARC_RPC_METHODS = [
  "eth_chainId",
  "eth_getBalance",
  "eth_call",
  "eth_getStorageAt",
  "eth_getBlockByNumber",
  "eth_getBlockByHash",
  "eth_getTransactionByHash",
  "eth_getTransactionReceipt",
] as const;
export type ArcRpcMethod = typeof ARC_RPC_METHODS[number];

export interface ArcRpcReader {
  call(method: ArcRpcMethod, params: readonly unknown[], lease: SourceLease, signal: AbortSignal,
    options?: { revertAsNotFound?: boolean }): Promise<unknown>;
}

export class ArcRpcClient implements ArcRpcReader {
  constructor(private readonly provider: BoundedProviderClient) {}

  async call(method: ArcRpcMethod, params: readonly unknown[], lease: SourceLease, signal: AbortSignal,
    options: { revertAsNotFound?: boolean } = {}): Promise<unknown> {
    if (!ARC_RPC_METHODS.includes(method)) throw new ApiBoundaryError("INTERNAL_ERROR");
    const id = `oa_${randomUUID()}`;
    const response = record(await this.provider.postJson({ jsonrpc: "2.0", id, method, params }, lease, signal));
    const keys = Object.keys(response).sort();
    if (response.jsonrpc !== "2.0" || response.id !== id) throw new ApiBoundaryError("SOURCE_MALFORMED");
    if (keys.length === 3 && keys[0] === "error" && keys[1] === "id" && keys[2] === "jsonrpc") {
      if (method === "eth_call" && options.revertAsNotFound === true) throw new ApiBoundaryError("SOURCE_NOT_FOUND");
      throw new ApiBoundaryError("SOURCE_MALFORMED");
    }
    if (keys.length !== 3 || keys[0] !== "id" || keys[1] !== "jsonrpc" || keys[2] !== "result") {
      throw new ApiBoundaryError("SOURCE_MALFORMED");
    }
    return response.result;
  }
}
