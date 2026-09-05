import { describe, expect, it } from "vitest";

import { ARC_TESTNET } from "../src/network.js";
import { GatewayTransferObservationSchema, GatewayTransferRequestSchema, X402ReceiptBundleSchema,
} from "../src/x402-evidence.js";
import { gatewayObservation, x402Bundle } from "./x402-fixtures.js";

describe("M07 normalized metadata contract", () => {
  it("accepts bounded exact claims without rounding amounts", () => {
    expect(X402ReceiptBundleSchema.parse(x402Bundle()).authorizationMetadata?.value).toBe("9007199254740993123456789");
  });
  it.each(["requirement", "authorizationMetadata", "responseMetadata"] as const)("accepts an incomplete %s-only bundle", (stage) => {
    const full = x402Bundle();
    const base = { ...full }; delete base.requirement; delete base.authorizationMetadata; delete base.responseMetadata;
    expect(X402ReceiptBundleSchema.safeParse({ ...base, [stage]: full[stage] }).success).toBe(true);
    expect(X402ReceiptBundleSchema.safeParse(base).success).toBe(false);
  });
  it.each(["signature", "privateKey", "headers", "body", "resourceUrl", "reconciliation", "authorization"])("rejects forbidden %s at every stage", (key) => {
    const full = x402Bundle();
    expect(X402ReceiptBundleSchema.safeParse({ ...full, [key]: "PRIVATE_CANARY" }).success).toBe(false);
    for (const stage of ["requirement", "authorizationMetadata", "responseMetadata", "resource"] as const) {
      expect(X402ReceiptBundleSchema.safeParse({ ...full, [stage]: { ...full[stage], [key]: "PRIVATE_CANARY" } }).success).toBe(false);
    }
  });
  it.each(["-1", "01", "1.0", "garbage", "", (1n << 256n).toString()])("rejects unsafe atomic amount %s without throwing", (amount) => {
    const full = x402Bundle();
    expect(X402ReceiptBundleSchema.safeParse({ ...full, requirement: { ...full.requirement, amount } }).success).toBe(false);
    expect(X402ReceiptBundleSchema.safeParse({ ...full, authorizationMetadata: { ...full.authorizationMetadata, value: amount } }).success).toBe(false);
  });
  it.each(["network", "asset", "verifyingContract", "domainName", "domainVersion"] as const)("rejects unsupported domain %s", (field) => {
    const full = x402Bundle();
    for (const stage of ["requirement", "authorizationMetadata"] as const) {
      expect(X402ReceiptBundleSchema.safeParse({ ...full, [stage]: { ...full[stage], [field]: "unsupported" } }).success).toBe(false);
    }
  });
  it("enforces bounded ordered validity, capture time, UUID, HTTP status and version", () => {
    const full = x402Bundle();
    for (const validBefore of [full.authorizationMetadata!.validAfter, "0", "253402300800", "garbage"]) {
      expect(X402ReceiptBundleSchema.safeParse({ ...full, authorizationMetadata: { ...full.authorizationMetadata, validBefore } }).success).toBe(false);
    }
    for (const invalid of [{ schemaVersion: "openarc.x402-receipt-bundle.v2" }, { authentication: "verified" },
      { capturedAt: "2026-09-05T11:59:59Z" }, { bundleId: "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA" },
      { responseMetadata: { ...full.responseMetadata, httpStatus: 600 } }]) {
      expect(X402ReceiptBundleSchema.safeParse({ ...full, ...invalid }).success).toBe(false);
    }
  });
});

describe("M07 Gateway transfer contract", () => {
  it.each(["received", "batched", "confirmed", "completed", "failed"] as const)("preserves reported %s without assuming a transaction hash", (status) => {
    const full = gatewayObservation();
    expect(GatewayTransferObservationSchema.parse({ ...full, transfer: { ...full.transfer, status, txHash: null } }).transfer.status).toBe(status);
  });
  it("normalizes addresses and hashes but requires a canonical lowercase UUID", () => {
    const full = gatewayObservation();
    const parsed = GatewayTransferObservationSchema.parse({ ...full, transfer: { ...full.transfer,
      fromAddress: `0x${"A".repeat(40)}`, nonce: `0x${"B".repeat(64)}` } });
    expect(parsed.transfer.fromAddress).toBe(`0x${"a".repeat(40)}`);
    expect(parsed.transfer.nonce).toBe(`0x${"b".repeat(64)}`);
    expect(GatewayTransferRequestSchema.safeParse({ network: ARC_TESTNET.caip2, transferId: "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA" }).success).toBe(false);
  });
  it("rejects unsupported networks, missing nonce, raw extensions and impossible time order", () => {
    const full = gatewayObservation();
    for (const changed of [{ sendingNetwork: "eip155:1" }, { recipientNetwork: "ARC-TESTNET" }, { nonce: undefined },
      { token: "EURC" }, { status: "settled" }, { amount: "01" }, { txHash: "" },
      { createdAt: "2026-09-05T12:00:02Z" }, { updatedAt: "2026-09-05T12:00:03Z" },
      { headers: { signature: "PRIVATE_CANARY" } }]) {
      expect(GatewayTransferObservationSchema.safeParse({ ...full, transfer: { ...full.transfer, ...changed } }).success).toBe(false);
    }
    expect(GatewayTransferRequestSchema.safeParse({ network: ARC_TESTNET.caip2, transferId: full.transfer.id, url: "https://evil.test" }).success).toBe(false);
    expect(GatewayTransferObservationSchema.safeParse({ ...full, source: { ...full.source, origin: "https://evil.test" } }).success).toBe(false);
  });
});
