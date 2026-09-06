import { GatewayTransferRequestSchema, ARC_TESTNET } from "@openarc/shared";
import { request as httpsRequest } from "node:https";

import { ApiBoundaryError } from "../http/errors.js";
import { untilAborted } from "../http/source-route.js";
import type { SourceLease } from "../limits/budget.js";
import { readProviderJson, type ProviderResponse } from "../providers/http.js";

export const GATEWAY_ORIGIN = "https://gateway-api-testnet.circle.com";
export type GatewayTransport = (transferId: string, signal: AbortSignal) => Promise<ProviderResponse>;

/** Fixed credential-free read route. Input cannot provide URLs, queries, headers, or methods. */
export const gatewayHttpsTransport: GatewayTransport = async (transferId, signal) => {
  if (!GatewayTransferRequestSchema.safeParse({ network: ARC_TESTNET.caip2, transferId }).success) {
    throw new ApiBoundaryError("INVALID_REQUEST");
  }
  return new Promise((resolve, reject) => {
    const request = httpsRequest(`${GATEWAY_ORIGIN}/v1/x402/transfers/${transferId}`, {
      method: "GET", signal, agent: false, maxHeaderSize: 8_192,
      rejectUnauthorized: true, joinDuplicateHeaders: true,
      headers: { Accept: "application/json", "Accept-Encoding": "identity" },
    }, (response) => resolve({ status: response.statusCode ?? 0, headers: response.headers,
      body: response, close: () => { response.destroy(); request.destroy(); } }));
    request.once("error", () => reject(new ApiBoundaryError("SOURCE_UNAVAILABLE")));
    request.end();
  });
};

export interface GatewayReader {
  read(transferId: string, lease: SourceLease, signal: AbortSignal): Promise<unknown>;
}

export class BoundedGatewayClient implements GatewayReader {
  private readonly transport: GatewayTransport;
  constructor(private readonly options: { timeoutMs: number; maxResponseBytes: number; transport?: GatewayTransport }) {
    if (!Number.isInteger(options.timeoutMs) || options.timeoutMs < 100 || options.timeoutMs > 10_000 ||
      !Number.isInteger(options.maxResponseBytes) || options.maxResponseBytes < 1_024 || options.maxResponseBytes > 256 * 1024) {
      throw new Error("Invalid provider bounds");
    }
    this.transport = options.transport ?? gatewayHttpsTransport;
  }

  async read(transferId: string, lease: SourceLease, signal: AbortSignal): Promise<unknown> {
    if (!GatewayTransferRequestSchema.safeParse({ network: ARC_TESTNET.caip2, transferId }).success) {
      throw new ApiBoundaryError("INVALID_REQUEST");
    }
    if (lease.source !== "gateway") throw new ApiBoundaryError("SOURCE_UNAVAILABLE");
    const controller = new AbortController();
    const deadline = AbortSignal.any([signal, controller.signal]);
    const timer = setTimeout(() => controller.abort(), this.options.timeoutMs);
    let response: ProviderResponse | undefined;
    try {
      if (deadline.aborted) throw new ApiBoundaryError("SOURCE_UNAVAILABLE");
      return await untilAborted(lease.dispatch(async () => {
        if (deadline.aborted) throw new ApiBoundaryError("SOURCE_UNAVAILABLE");
        response = await this.transport(transferId, deadline);
        if (deadline.aborted) { response.close(); throw new ApiBoundaryError("SOURCE_UNAVAILABLE"); }
        if (response.status === 404) throw new ApiBoundaryError("SOURCE_NOT_FOUND");
        if (response.status === 429) throw new ApiBoundaryError("SOURCE_RATE_LIMITED");
        if (response.status !== 200) throw new ApiBoundaryError("SOURCE_UNAVAILABLE");
        return readProviderJson(response, this.options.maxResponseBytes, deadline);
      }, deadline), deadline);
    } catch (error) {
      if (error instanceof ApiBoundaryError) throw error;
      throw new ApiBoundaryError("SOURCE_UNAVAILABLE");
    } finally {
      clearTimeout(timer);
      controller.abort();
      response?.close();
    }
  }
}
