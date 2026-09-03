import { describe, expect, it } from "vitest";

import {
  API_ERRORS, API_SCHEMA_VERSION, ApiErrorEnvelopeSchema, CapabilitiesEnvelopeSchema,
  CAPABILITIES_PATH, WorkspaceOriginSchema,
} from "../src/api.js";
import { ARC_TESTNET } from "../src/network.js";
import { CAPABILITY_DISCLOSURE, PermissionReceiptRecordSchema } from "../src/permission.js";
import { WorkspaceRecordSchema } from "../src/vault.js";

const meta = { schemaVersion: API_SCHEMA_VERSION, requestId: "11111111-1111-4111-8111-111111111111", buildSha: "test-sha" };
const limits = { requestBytes: 16384, responseBytes: 65536, sourceResponseBytes: 262144,
  sourceTimeoutMs: 5000, sourceMaxSubcalls: 8, requestsPerPeerHour: 60, globalSourceUnitsPerDay: 10000 };
const capabilities = { ok: true, meta, data: { capabilityVersion: "openarc.capabilities.m04.v1",
  environment: "testnet", network: ARC_TESTNET.caip2, sourceRevision: ARC_TESTNET.sourceRevision,
  reviewedAt: ARC_TESTNET.reviewedAt, writes: false, enabledConnectors: [],
  features: { arcObservation: false, agentRegistry: false, agentJobs: false, gatewayEvidence: false }, limits } };
const approved = { ...CAPABILITY_DISCLOSURE,
  recordSchema: "openarc.permission-receipt.v1", kind: "permission_receipt",
  recordId: meta.requestId, recordRevision: "A".repeat(32),
  createdAt: "2026-09-03T16:00:00Z", updatedAt: "2026-09-03T16:00:00Z",
  approvedAt: "2026-09-03T16:00:00Z", outcome: "approved", resolvedAt: null, failureCode: null,
  destination: { origin: "https://app.example.test", path: CAPABILITIES_PATH, method: "GET", upstreams: [] },
  releasedFields: [] };

describe("M04 shared API boundary", () => {
  it("accepts only a strict capability contract with consistent connector truth", () => {
    expect(CapabilitiesEnvelopeSchema.safeParse(capabilities).success).toBe(true);
    expect(CapabilitiesEnvelopeSchema.safeParse({ ...capabilities, data: { ...capabilities.data,
      enabledConnectors: ["arc_primary_rpc"],
      features: { ...capabilities.data.features, arcObservation: true } } }).success).toBe(true);
    for (const data of [
      { ...capabilities.data, rawProviderBody: {} },
      { ...capabilities.data, writes: true },
      { ...capabilities.data, network: "eip155:1" },
      { ...capabilities.data, enabledConnectors: ["arc_primary_rpc"] },
      { ...capabilities.data, features: { ...capabilities.data.features, arcObservation: true } },
      { ...capabilities.data, limits: { ...limits, sourceMaxSubcalls: 17 } },
    ]) expect(CapabilitiesEnvelopeSchema.safeParse({ ...capabilities, data }).success).toBe(false);
    expect(CapabilitiesEnvelopeSchema.safeParse({ ...capabilities, meta: { ...meta, schemaVersion: "future" } }).success).toBe(false);
  });

  it("binds public error messages and retry metadata to fixed codes", () => {
    for (const [code, definition] of Object.entries(API_ERRORS)) {
      const valid = { ok: false, meta, error: { code, message: definition.message, retryable: definition.retryable } };
      expect(ApiErrorEnvelopeSchema.safeParse(valid).success).toBe(true);
      expect(ApiErrorEnvelopeSchema.safeParse({ ...valid, error: { ...valid.error, message: "PRIVATE_CANARY" } }).success).toBe(false);
      expect(ApiErrorEnvelopeSchema.safeParse({ ...valid, error: { ...valid.error, stack: "PRIVATE_CANARY" } }).success).toBe(false);
    }
    expect(Object.isFrozen(API_ERRORS.SOURCE_UNAVAILABLE)).toBe(true);
  });

  it("allows only canonical HTTPS or exact loopback development origins", () => {
    for (const origin of ["https://app.example.test", "http://localhost:5183", "http://127.0.0.1:5183"]) {
      expect(WorkspaceOriginSchema.safeParse(origin).success).toBe(true);
    }
    for (const origin of ["https://user:secret@app.example.test", "https://app.example.test/path", "https://app.example.test/", "https://app.example.test?private", "http://remote.test", "javascript:alert(1)", "null"]) {
      expect(WorkspaceOriginSchema.safeParse(origin).success).toBe(false);
    }
  });
});

describe("M03 permission receipts", () => {
  it("accepts each precise outcome in the mixed encrypted record union", () => {
    expect(WorkspaceRecordSchema.safeParse(approved).success).toBe(true);
    for (const outcome of ["completed", "failed"]) {
      expect(PermissionReceiptRecordSchema.safeParse({ ...approved, outcome,
        resolvedAt: "2026-09-03T16:00:01Z", updatedAt: "2026-09-03T16:00:01Z",
        failureCode: outcome === "failed" ? "REQUEST_UNAVAILABLE" : null }).success).toBe(true);
    }
  });

  it("rejects premature resolution, inconsistent outcome times, and unsupported disclosure", () => {
    const mutations = [
      { recordSchema: "openarc.workspace-record.v1" }, { recordSchema: "future" },
      { approvedAt: "not-a-time" }, { createdAt: "not-a-time" },
      { walletAddress: `0x${"1".repeat(40)}` }, { releasedFields: ["address"] },
      { credentials: "include" }, { providerRetention: "No logs, guaranteed" },
      { failureCode: "REQUEST_UNAVAILABLE" }, { resolvedAt: approved.approvedAt },
      { outcome: "completed" }, { outcome: "failed" },
      { updatedAt: "2026-09-03T16:00:02Z" },
      { outcome: "failed", resolvedAt: "2026-09-03T15:00:00Z", updatedAt: "2026-09-03T15:00:00Z", failureCode: "REQUEST_UNAVAILABLE" },
      { destination: { ...approved.destination, path: "/v1/private/arc/account-snapshot" } },
      { destination: { ...approved.destination, upstreams: ["https://rpc.testnet.arc.io"] } },
    ];
    for (const mutation of mutations) expect(PermissionReceiptRecordSchema.safeParse({ ...approved, ...mutation }).success).toBe(false);
  });
});
