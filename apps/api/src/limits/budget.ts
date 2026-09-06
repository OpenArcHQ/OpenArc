import { createHmac } from "node:crypto";
import { isIP, SocketAddress } from "node:net";
import { createClient } from "@redis/client";

import { ApiBoundaryError } from "../http/errors.js";
import { RESERVE_LUA } from "./redis-script.js";

export const SOURCE_CLASSES = ["arc_rpc", "gateway"] as const;
export type SourceClass = typeof SOURCE_CLASSES[number];
export const SOURCE_ROUTES = ["arc_account", "arc_transaction", "agent_registry", "agent_job", "gateway_transfer"] as const;
export type SourceRoute = typeof SOURCE_ROUTES[number];
export type BudgetEvent = "attempt_reserved" | "subcall_reserved" | "dispatched" | "hour_exhausted" | "day_exhausted" | "store_unavailable" | "subcall_cap";
export type BudgetObserver = (source: SourceClass, event: BudgetEvent) => void;

interface RedisExecutor {
  readonly isReady: boolean;
  sendCommand(args: string[], options: { abortSignal: AbortSignal; timeout: number }): Promise<unknown>;
}

export interface BudgetOptions {
  secret: string;
  requestsPerPeerHour: number;
  globalUnitsPerDay: number;
  maxSubcalls: number;
  commandTimeoutMs?: number;
  observe?: BudgetObserver;
}

/** Reconnect the budget transport only; commands are never queued or retried. */
export function redisReconnectDelay(retries: number): number {
  const exponent = Number.isInteger(retries) ? Math.min(Math.max(retries, 0), 4) : 4;
  return Math.min(100 * (2 ** exponent), 1_000);
}

/** Normalize only an address authenticated at the web-to-API proxy boundary. */
export function canonicalPeer(value: string | undefined): string {
  if (!value || value.length > 64) return "unknown";
  const family = isIP(value);
  if (family === 4) return value;
  if (family !== 6) return "unknown";
  try {
    const address = new SocketAddress({ address: value, family: "ipv6" }).address.toLowerCase();
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/u.exec(address);
    return mapped?.[1] ?? address;
  } catch { return "unknown"; }
}

function integer(value: number, min: number, max: number): boolean {
  return Number.isInteger(value) && value >= min && value <= max;
}

export class SourceBudget {
  private readonly timeout: number;
  constructor(private readonly redis: RedisExecutor, private readonly options: BudgetOptions) {
    this.timeout = options.commandTimeoutMs ?? 750;
    if (!/^[A-Za-z0-9_-]{32,128}$/u.test(options.secret) ||
      !integer(options.requestsPerPeerHour, 1, 10_000) ||
      !integer(options.globalUnitsPerDay, 1, 1_000_000) ||
      !integer(options.maxSubcalls, 1, 16) || !integer(this.timeout, 25, 2_000)) {
      throw new Error("Invalid budget configuration");
    }
  }

  async begin(source: SourceClass, route: SourceRoute, peer: string | undefined, signal: AbortSignal): Promise<SourceLease> {
    if (!SOURCE_CLASSES.includes(source) || !SOURCE_ROUTES.includes(route)) throw new ApiBoundaryError("INTERNAL_ERROR");
    const digest = createHmac("sha256", this.options.secret).update(`${route}\0${canonicalPeer(peer)}`).digest("hex");
    const keys = [`oa:v1:abuse:${digest}`, `oa:v1:budget:${source}`];
    await this.reserve(source, keys, "attempt", signal);
    return new SourceLease(source, this.options.maxSubcalls,
      () => this.reserve(source, keys, "subcall", signal), signal, this.options.observe);
  }

  async ready(signal: AbortSignal): Promise<boolean> {
    try { return await this.command(["PING"], signal) === "PONG"; } catch { return false; }
  }

  private async command(args: string[], signal: AbortSignal): Promise<unknown> {
    const deadline = AbortSignal.any([signal, AbortSignal.timeout(this.timeout)]);
    if (!this.redis.isReady || deadline.aborted) throw new ApiBoundaryError("BUDGET_STORE_UNAVAILABLE");
    // Redis cancels queued commands, but an already-written command can keep
    // waiting for its reply. Own the deadline without retrying or refunding a
    // reservation that the server may still execute. Handle late rejections too.
    let onAbort: () => void = () => undefined;
    const aborted = new Promise<never>((_resolve, reject) => {
      onAbort = () => reject(new ApiBoundaryError("BUDGET_STORE_UNAVAILABLE"));
      deadline.addEventListener("abort", onAbort, { once: true });
    });
    try {
      const result = await Promise.race([
        aborted,
        this.redis.sendCommand(args, { abortSignal: deadline, timeout: this.timeout }),
      ]);
      if (deadline.aborted) throw new ApiBoundaryError("BUDGET_STORE_UNAVAILABLE");
      return result;
    } finally {
      deadline.removeEventListener("abort", onAbort);
    }
  }

  private async reserve(source: SourceClass, keys: string[], mode: "attempt" | "subcall", signal: AbortSignal): Promise<void> {
    let result: unknown;
    try {
      result = await this.command(["EVAL", RESERVE_LUA, "2", ...keys, mode,
        String(this.options.requestsPerPeerHour), String(this.options.globalUnitsPerDay)], signal);
      if (!Array.isArray(result) || result.length !== 2 ||
        !integer(result[0] as number, 0, 2) || !integer(result[1] as number, 0, 86_400) ||
        (result[0] === 0 ? result[1] !== 0 : result[1] === 0)) throw new Error("Invalid reservation reply");
    } catch {
      this.options.observe?.(source, "store_unavailable");
      throw new ApiBoundaryError("BUDGET_STORE_UNAVAILABLE");
    }
    const [status, retry] = result as [number, number];
    if (status === 1 || status === 2) {
      this.options.observe?.(source, status === 1 ? "hour_exhausted" : "day_exhausted");
      throw new ApiBoundaryError(status === 1 ? "RATE_LIMITED" : "GLOBAL_BUDGET_EXHAUSTED", retry);
    }
    this.options.observe?.(source, mode === "attempt" ? "attempt_reserved" : "subcall_reserved");
  }
}

/** A single route's conservative budget. No refunds, offline queue, or retries. */
export class SourceLease {
  private reserved = 0;
  private closed = false;
  constructor(readonly source: SourceClass, private readonly maximum: number,
    private readonly reserve: () => Promise<void>, private readonly signal: AbortSignal,
    private readonly observe?: BudgetObserver) {}

  close(): void { this.closed = true; }

  async dispatch<T>(operation: () => Promise<T>, additionalSignal?: AbortSignal): Promise<T> {
    if (this.closed || this.signal.aborted || additionalSignal?.aborted) throw new ApiBoundaryError("SOURCE_UNAVAILABLE");
    if (this.reserved >= this.maximum) {
      this.observe?.(this.source, "subcall_cap");
      throw new ApiBoundaryError("SOURCE_UNAVAILABLE");
    }
    // Increment before awaiting: concurrent subcalls cannot overrun the lease.
    this.reserved += 1;
    await this.reserve();
    if (this.closed || this.signal.aborted || additionalSignal?.aborted) throw new ApiBoundaryError("SOURCE_UNAVAILABLE");
    this.observe?.(this.source, "dispatched");
    return operation();
  }
}

export async function connectBudgetRedis(url: string) {
  const client = createClient({ url, disableOfflineQueue: true, commandsQueueMaxLength: 256,
    socket: { reconnectStrategy: (retries) => redisReconnectDelay(retries), connectTimeout: 750 },
    commandOptions: { timeout: 750 }, disableClientInfo: true });
  // No raw connection URL, library error, command, or argument is ever logged.
  client.on("error", () => undefined);
  try { await client.connect(); return client; }
  catch { if (client.isOpen) client.destroy(); throw new ApiBoundaryError("BUDGET_STORE_UNAVAILABLE"); }
}
