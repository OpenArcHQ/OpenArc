import { describe, expect, it } from "vitest";

import {
  ARC_ACCOUNT_SNAPSHOT_PATH,
  ARC_OBSERVATION_DISCLOSURE,
  ARC_TESTNET,
  ArcObservationPermissionReceiptRecordSchema,
  PermissionReceiptRecordSchema,
} from "../src/index.js";

const address = "0x1111111111111111111111111111111111111111";
const at = "2026-09-03T12:00:00Z";
const base = {
  recordSchema: "openarc.permission-receipt.v2",
  kind: "permission_receipt",
  recordId: "11111111-1111-4111-8111-111111111111",
  recordRevision: "A".repeat(32),
  createdAt: at,
  updatedAt: at,
  connectorId: "arc_account_snapshot",
  destination: { origin: "https://app.example.test", path: ARC_ACCOUNT_SNAPSHOT_PATH,
    method: "POST", upstreams: [ARC_TESTNET.rpcHttp] },
  releasedFields: ["network", "address"],
  released: { network: ARC_TESTNET.caip2, address },
  purpose: "Observe one public Arc Testnet address at one exact final block.",
  credentials: ARC_OBSERVATION_DISCLOSURE.credentials,
  openArcRetention: ARC_OBSERVATION_DISCLOSURE.openArcRetention,
  providerRetention: ARC_OBSERVATION_DISCLOSURE.providerRetention,
  hostingMetadata: ARC_OBSERVATION_DISCLOSURE.hostingMetadata,
  approvedAt: at,
  outcome: "completed",
  resolvedAt: at,
  failureCode: null,
} as const;

describe("M04 permission receipt contract", () => {
  it("pins the exact public disclosure, route, upstream, and resolved lifecycle", () => {
    const parsed = ArcObservationPermissionReceiptRecordSchema.parse(base);
    expect(parsed.released).toEqual({ network: ARC_TESTNET.caip2, address });
    expect(parsed.destination).toEqual({ origin: "https://app.example.test",
      path: ARC_ACCOUNT_SNAPSHOT_PATH, method: "POST", upstreams: [ARC_TESTNET.rpcHttp] });
    expect(PermissionReceiptRecordSchema.safeParse(parsed).success).toBe(true);
  });

  it.each([
    { ...base, destination: { ...base.destination, path: "/v1/private/arc/arbitrary" } },
    { ...base, destination: { ...base.destination, upstreams: ["https://evil.test"] } },
    { ...base, released: { ...base.released, privateKey: "canary" } },
    { ...base, releasedFields: ["network"] },
    { ...base, outcome: "completed", resolvedAt: null },
    { ...base, outcome: "failed", failureCode: null },
    { ...base, extra: "canary" },
  ])("rejects a widened or inconsistent receipt", (candidate) => {
    expect(ArcObservationPermissionReceiptRecordSchema.safeParse(candidate).success).toBe(false);
  });
});
