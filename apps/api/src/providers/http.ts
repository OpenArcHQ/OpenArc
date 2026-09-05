import { ARC_TESTNET } from "@openarc/shared";
import { request as httpsRequest } from "node:https";

import { ApiBoundaryError } from "../http/errors.js";
import { untilAborted } from "../http/source-route.js";
import type { SourceLease } from "../limits/budget.js";

export const PROVIDER_MAX_REQUEST_BYTES = 16 * 1024;
const MAX_DEPTH = 16;
const MAX_NODES = 8_192;
const MAX_COLLECTION = 2_048;
const MAX_STRING = 64 * 1024;

export interface ProviderResponse {
  status: number;
  headers: Readonly<Record<string, string | string[] | undefined>>;
  body: AsyncIterable<Uint8Array>;
  close: () => void;
}
export type ProviderTransport = (body: Buffer, signal: AbortSignal) => Promise<ProviderResponse>;

/** Exact endpoint + POST are closed over here, never supplied by a browser. */
export const arcHttpsTransport: ProviderTransport = (body, signal) => new Promise((resolve, reject) => {
  const request = httpsRequest(ARC_TESTNET.rpcHttp, { method: "POST", signal, agent: false,
    maxHeaderSize: 8_192, rejectUnauthorized: true, joinDuplicateHeaders: true,
    headers: { "Content-Type": "application/json", Accept: "application/json",
      "Accept-Encoding": "identity", "Content-Length": String(body.byteLength) } }, (response) => {
    resolve({ status: response.statusCode ?? 0, headers: response.headers,
      body: response, close: () => { response.destroy(); request.destroy(); } });
  });
  request.once("error", () => reject(new ApiBoundaryError("SOURCE_UNAVAILABLE")));
  request.end(body);
});

export interface ProviderOptions {
  timeoutMs: number;
  maxResponseBytes: number;
  transport?: ProviderTransport;
}

/** M03 transport primitive only; RPC method/chain/anchor adapters belong to M04. */
export class BoundedProviderClient {
  private readonly transport: ProviderTransport;
  constructor(private readonly options: ProviderOptions) {
    if (!Number.isInteger(options.timeoutMs) || options.timeoutMs < 100 || options.timeoutMs > 10_000 ||
      !Number.isInteger(options.maxResponseBytes) || options.maxResponseBytes < 1_024 || options.maxResponseBytes > 256 * 1024) {
      throw new Error("Invalid provider bounds");
    }
    this.transport = options.transport ?? arcHttpsTransport;
  }

  async postJson(input: unknown, lease: SourceLease, signal: AbortSignal): Promise<unknown> {
    if (lease.source !== "arc_rpc") throw new ApiBoundaryError("SOURCE_UNAVAILABLE");
    let serialized: string | undefined;
    try {
      assertJsonBounds(input);
      serialized = JSON.stringify(input);
    } catch { throw new ApiBoundaryError("INVALID_REQUEST"); }
    if (serialized === undefined) throw new ApiBoundaryError("INVALID_REQUEST");
    if (Buffer.byteLength(serialized) > PROVIDER_MAX_REQUEST_BYTES) throw new ApiBoundaryError("REQUEST_TOO_LARGE");
    const controller = new AbortController();
    const deadline = AbortSignal.any([signal, controller.signal]);
    const timer = setTimeout(() => controller.abort(), this.options.timeoutMs);
    let response: ProviderResponse | undefined;
    try {
      if (deadline.aborted) throw new ApiBoundaryError("SOURCE_UNAVAILABLE");
      return await untilAborted(lease.dispatch(async () => {
        if (deadline.aborted) throw new ApiBoundaryError("SOURCE_UNAVAILABLE");
        response = await this.transport(Buffer.from(serialized), deadline);
        if (deadline.aborted) { response.close(); throw new ApiBoundaryError("SOURCE_UNAVAILABLE"); }
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

/** Shared strict decoder for fixed-origin Arc POST and Gateway GET transports. */
export async function readProviderJson(response: ProviderResponse, maxResponseBytes: number, deadline: AbortSignal): Promise<unknown> {
  const type = response.headers["content-type"];
  if (typeof type !== "string" || !/^application\/json(?:\s*;\s*charset=utf-8)?$/iu.test(type)) {
    throw new ApiBoundaryError("SOURCE_MALFORMED");
  }
  if (response.headers["content-encoding"] !== undefined && response.headers["content-encoding"] !== "identity") {
    throw new ApiBoundaryError("SOURCE_MALFORMED");
  }
  const length = response.headers["content-length"];
  if (length !== undefined && (typeof length !== "string" || !/^(?:0|[1-9]\d{0,9})$/u.test(length))) {
    throw new ApiBoundaryError("SOURCE_MALFORMED");
  }
  if (length !== undefined && Number(length) > maxResponseBytes) throw new ApiBoundaryError("SOURCE_RESPONSE_TOO_LARGE");
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of response.body) {
    if (deadline.aborted) throw new ApiBoundaryError("SOURCE_UNAVAILABLE");
    if (!(chunk instanceof Uint8Array)) throw new ApiBoundaryError("SOURCE_MALFORMED");
    bytes += chunk.byteLength;
    if (bytes > maxResponseBytes) throw new ApiBoundaryError("SOURCE_RESPONSE_TOO_LARGE");
    chunks.push(Buffer.from(chunk));
  }
  if (length !== undefined && bytes !== Number(length)) throw new ApiBoundaryError("SOURCE_MALFORMED");
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
    const value: unknown = JSON.parse(text);
    if (!value || typeof value !== "object") throw new Error("Invalid JSON root");
    assertJsonBounds(value);
    return value;
  } catch { throw new ApiBoundaryError("SOURCE_MALFORMED"); }
}

function assertJsonBounds(root: unknown): void {
  const stack: { value: unknown; depth: number }[] = [{ value: root, depth: 0 }];
  let nodes = 0;
  while (stack.length) {
    const { value, depth } = stack.pop()!;
    nodes += 1;
    if (nodes > MAX_NODES || depth > MAX_DEPTH) throw new Error("JSON structure limit");
    if (value === null || typeof value === "boolean") continue;
    if (typeof value === "string") { if (value.length > MAX_STRING) throw new Error("JSON string limit"); continue; }
    if (typeof value === "number" && Number.isFinite(value)) continue;
    if (typeof value !== "object") throw new Error("Not JSON");
    const entries = Object.entries(value);
    if (entries.length > MAX_COLLECTION || (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype)) {
      throw new Error("JSON collection limit");
    }
    for (const [key, child] of entries) {
      if (key.length > MAX_STRING || ["__proto__", "constructor", "prototype"].includes(key)) throw new Error("Unsafe JSON key");
      stack.push({ value: child, depth: depth + 1 });
    }
  }
}
