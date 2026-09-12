import { createHash, timingSafeEqual } from "node:crypto";
import { ApiErrorCodeSchema, BuildMarkerSchema, type ApiErrorCode } from "@openarc/shared";

import { SOURCE_CLASSES, type BudgetEvent, type SourceClass } from "../limits/budget.js";

export const ROUTE_CLASSES = ["health", "readiness", "capabilities", "metrics", "auth", "arc_account", "arc_transaction", "agent_registry", "agent_job", "gateway_transfer", "disabled_source", "not_found", "test_source"] as const;
export type RouteClass = typeof ROUTE_CLASSES[number];
export type SafeMethod = "GET" | "POST" | "OPTIONS" | "HEAD" | "OTHER";

export function safeMethod(method: string): SafeMethod {
  return ["GET", "POST", "OPTIONS", "HEAD"].includes(method) ? method as SafeMethod : "OTHER";
}

export function metricsAuthorized(header: unknown, expected: string | undefined): boolean {
  if (!expected || typeof header !== "string" || header.length > 135) return false;
  const match = /^Bearer ([A-Za-z0-9_-]{32,128})$/u.exec(header);
  if (!match) return false;
  return timingSafeEqual(createHash("sha256").update(match[1]!).digest(), createHash("sha256").update(expected).digest());
}

export type DurationBucket = "under_10ms" | "under_100ms" | "under_1s" | "at_least_1s";
export function durationBucket(milliseconds: number): DurationBucket {
  return milliseconds < 10 ? "under_10ms" : milliseconds < 100 ? "under_100ms" : milliseconds < 1000 ? "under_1s" : "at_least_1s";
}

export class AggregateMetrics {
  private readonly counts = new Map<string, number>();
  private readonly failures = new Map<string, number>();
  private readonly sourceCounts = new Map<string, number>();
  record(route: RouteClass, status: number, duration: DurationBucket): void {
    if (!ROUTE_CLASSES.includes(route) || !Number.isInteger(status) || status < 100 || status > 599 ||
      !["under_10ms", "under_100ms", "under_1s", "at_least_1s"].includes(duration)) return;
    const statusClass = Math.min(5, Math.max(1, Math.floor(status / 100)));
    const key = `route="${route}",status_class="${statusClass}xx",duration="${duration}"`;
    this.counts.set(key, Math.min(Number.MAX_SAFE_INTEGER, (this.counts.get(key) ?? 0) + 1));
  }
  recordFailure(route: RouteClass, code: ApiErrorCode): void {
    if (!ROUTE_CLASSES.includes(route) || !ApiErrorCodeSchema.safeParse(code).success) return;
    const key = `route="${route}",code="${code}"`;
    this.failures.set(key, Math.min(Number.MAX_SAFE_INTEGER, (this.failures.get(key) ?? 0) + 1));
  }
  recordBudget(source: SourceClass, event: BudgetEvent): void {
    if (!SOURCE_CLASSES.includes(source) || !["attempt_reserved", "subcall_reserved", "dispatched", "hour_exhausted",
      "day_exhausted", "store_unavailable", "subcall_cap"].includes(event)) return;
    const key = `source="${source}",event="${event}"`;
    this.sourceCounts.set(key, Math.min(Number.MAX_SAFE_INTEGER, (this.sourceCounts.get(key) ?? 0) + 1));
  }
  render(commitSha: string, sourceRoutesEnabled = false): string {
    const marker = BuildMarkerSchema.safeParse(commitSha);
    if (!marker.success) throw new Error("Invalid metrics build marker");
    const lines = ["# TYPE openarc_http_requests_total counter",
      ...[...this.counts].sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => `openarc_http_requests_total{${key}} ${value}`),
      "# TYPE openarc_api_failures_total counter",
      ...[...this.failures].sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => `openarc_api_failures_total{${key}} ${value}`),
      "# TYPE openarc_source_events_total counter",
      ...[...this.sourceCounts].sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => `openarc_source_events_total{${key}} ${value}`),
      "# TYPE openarc_build_info gauge", `openarc_build_info{sha="${commitSha}"} 1`,
      "# TYPE openarc_source_routes_enabled gauge", `openarc_source_routes_enabled ${sourceRoutesEnabled ? 1 : 0}`,
      "# TYPE openarc_redis_required gauge", `openarc_redis_required ${sourceRoutesEnabled ? 1 : 0}`];
    return `${lines.join("\n")}\n`;
  }
}
