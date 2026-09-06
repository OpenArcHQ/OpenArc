import { describe, expect, it } from "vitest";

import { reconcileX402, type X402ReconciliationInput } from "../src/x402-reconciliation.js";
import { batchObservation, gatewayObservation, x402Bundle } from "./x402-fixtures.js";

const mainId = "33333333-3333-4333-8333-333333333333";
const gatewayId = "44444444-4444-4444-8444-444444444444";
const otherId = "55555555-5555-4555-8555-555555555555";
const input = (): X402ReconciliationInput => ({ bundleRecordId: mainId, bundle: x402Bundle(),
  gateway: { recordId: gatewayId, observation: gatewayObservation() }, evaluatedAt: "2026-09-06T12:00:00Z" });

describe("M07 independent evidence dimensions", () => {
  it("compares exact agreement without claiming authorization, fulfillment or onchain settlement", () => {
    const value = input();
    const before = JSON.stringify(value);
    const result = reconcileX402(value);
    expect(result).toMatchObject({ metadataAgreement: "consistent", authorizationVerification: "not_verified",
      authorizationValidity: "within_reported_window", providerResponse: "reported_success",
      fulfillment: "not_verified", gatewayStatus: "completed", onchainSettlement: "not_verified", conflicts: [], gaps: [] });
    expect(result.inputRecordIds).toEqual([mainId, gatewayId]);
    expect(result.replayScope).toEqual({ kind: "supplied_local_bundles_only", recordIds: [mainId] });
    expect(JSON.stringify(value)).toBe(before);
    expect(reconcileX402(value)).toEqual(result);
  });
  it.each(["received", "batched", "confirmed", "completed", "failed"] as const)("keeps Gateway %s separate from provider success", (status) => {
    const value = input(); value.gateway!.observation.transfer.status = status;
    const result = reconcileX402(value);
    expect(result.gatewayStatus).toBe(status);
    expect(result.providerResponse).toBe("reported_success");
    expect(result.fulfillment).toBe("not_verified");
    expect(result.onchainSettlement).toBe("not_verified");
  });
  it("preserves incomplete stages and does not infer a transfer link from matching amounts", () => {
    const value = input(); delete value.bundle.authorizationMetadata; delete value.bundle.responseMetadata;
    const result = reconcileX402(value);
    expect(result.metadataAgreement).toBe("incomplete");
    expect(result.authorizationValidity).toBe("not_supplied");
    expect(result.gaps.map((entry) => entry.code)).toContain("TRANSFER_ID_LINK_NOT_SUPPLIED");
    expect(result.conflicts).toEqual([]);
    delete value.gateway;
    expect(reconcileX402(value).gatewayStatus).toBe("not_observed");
  });
  it.each([
    ["id", "66666666-6666-4666-8666-666666666666", "GATEWAY_TRANSFER_ID_MISMATCH"],
    ["fromAddress", `0x${"9".repeat(40)}`, "GATEWAY_PAYER_MISMATCH"],
    ["toAddress", `0x${"9".repeat(40)}`, "GATEWAY_RECIPIENT_MISMATCH"],
    ["amount", "9007199254740993123456790", "GATEWAY_AMOUNT_MISMATCH"],
    ["nonce", `0x${"9".repeat(64)}`, "GATEWAY_NONCE_MISMATCH"],
  ] as const)("cites exact contradictory Gateway %s", (field, changed, code) => {
    const value = input(); Object.assign(value.gateway!.observation.transfer, { [field]: changed });
    const result = reconcileX402(value);
    expect(result.metadataAgreement).toBe("conflicting");
    expect(result.conflicts).toContainEqual({ code, recordIds: [mainId, gatewayId] });
  });
  it("compares requirement recipient and amount without fabricating requirement payer or nonce", () => {
    const value = input(); value.bundle.requirement!.payTo = `0x${"9".repeat(40)}`; value.bundle.requirement!.amount = "1";
    expect(reconcileX402(value).conflicts.map((entry) => entry.code)).toEqual([
      "REQUIREMENT_AUTHORIZATION_AMOUNT_MISMATCH", "REQUIREMENT_AUTHORIZATION_RECIPIENT_MISMATCH",
      "REQUIREMENT_GATEWAY_AMOUNT_MISMATCH", "REQUIREMENT_GATEWAY_RECIPIENT_MISMATCH",
    ]);
  });
  it("does not confuse today's clock with historical imported authorization validity", () => {
    const value = input(); value.evaluatedAt = "2099-01-01T00:00:00Z";
    expect(reconcileX402(value).authorizationValidity).toBe("within_reported_window");
    delete value.bundle.responseMetadata;
    expect(reconcileX402(value).authorizationValidity).toBe("response_time_missing");
  });
  it.each(["2026-09-05T11:59:59Z", "2026-09-05T12:00:01Z"])("rejects exact validity boundary %s", (respondedAt) => {
    const value = input(); value.bundle.responseMetadata!.respondedAt = respondedAt;
    expect(reconcileX402(value).authorizationValidity).toBe("outside_reported_window");
    expect(reconcileX402(value).conflicts.map((entry) => entry.code)).toContain("REPORTED_RESPONSE_OUTSIDE_AUTHORIZATION_WINDOW");
  });
  it("preserves subsecond response ordering and flags success with non-success HTTP", () => {
    const value = input(); value.bundle.responseMetadata!.respondedAt = "2026-09-05T11:59:59.000000001Z";
    expect(reconcileX402(value).authorizationValidity).toBe("within_reported_window");
    value.bundle.responseMetadata!.httpStatus = 402;
    expect(reconcileX402(value).conflicts.map((entry) => entry.code)).toContain("REPORTED_SUCCESS_HTTP_STATUS_MISMATCH");
    value.bundle.responseMetadata!.reportedSuccess = false;
    expect(reconcileX402(value).providerResponse).toBe("reported_failure");
  });
  it("treats identical capture as duplicate metadata, never proof of an executed replay", () => {
    const value = input(); value.otherBundles = [{ recordId: otherId, bundle: x402Bundle() }];
    const result = reconcileX402(value);
    expect(result.conflicts).toEqual([]);
    expect(result.duplicates).toEqual([{ code: "DUPLICATE_METADATA", recordIds: [mainId, otherId] }]);
    value.otherBundles[0]!.bundle.bundleId = "77777777-7777-4777-8777-777777777777";
    value.otherBundles[0]!.bundle.capturedAt = "2026-09-05T12:00:03Z";
    expect(reconcileX402(value).duplicates).toEqual(result.duplicates);
    expect(reconcileX402(value).conflicts).toEqual([]);
    value.otherBundles[0]!.bundle.authorizationMetadata!.from = `0x${"9".repeat(40)}`;
    value.otherBundles[0]!.bundle.responseMetadata!.transferId = null;
    expect(reconcileX402(value).conflicts).toEqual([]);
  });
  it("allows incomplete repeated metadata while detecting changed authorization under a reused nonce", () => {
    const value = input(); const other = x402Bundle();
    other.bundleId = "77777777-7777-4777-8777-777777777777";
    delete other.requirement; delete other.responseMetadata;
    value.otherBundles = [{ recordId: otherId, bundle: other }];
    expect(reconcileX402(value).conflicts).toEqual([]);
    expect(reconcileX402(value).duplicates).toEqual([{ code: "DUPLICATE_AUTHORIZATION_METADATA", recordIds: [mainId, otherId] }]);
    for (const changed of [{ value: "1" }, { to: `0x${"9".repeat(40)}` }, { validBefore: "1788609602" }]) {
      value.otherBundles[0]!.bundle = { ...other, authorizationMetadata: { ...other.authorizationMetadata!, ...changed } };
      expect(reconcileX402(value).conflicts).toContainEqual({ code: "AUTHORIZATION_NONCE_CONTENT_MISMATCH", recordIds: [mainId, otherId] });
    }
  });
  it("flags changed bundle IDs, resource claims and transfer claims without conflating missing stages", () => {
    const value = input(); const other = x402Bundle();
    other.resource.resourceDigest = `sha256:${"9".repeat(64)}`;
    value.otherBundles = [{ recordId: otherId, bundle: other }];
    expect(reconcileX402(value).conflicts.map((entry) => entry.code)).toEqual([
      "AUTHORIZATION_RESOURCE_MISMATCH", "BUNDLE_ID_CONTENT_MISMATCH", "TRANSFER_ID_CONTENT_MISMATCH",
    ]);
    const incomplete = x402Bundle(); incomplete.bundleId = "77777777-7777-4777-8777-777777777777";
    delete incomplete.authorizationMetadata;
    value.otherBundles = [{ recordId: otherId, bundle: incomplete }];
    expect(reconcileX402(value).conflicts).toEqual([]);
    expect(reconcileX402(value).duplicates).toContainEqual({ code: "DUPLICATE_TRANSFER_METADATA", recordIds: [mainId, otherId] });
  });
  it("never treats a shared batch hash as replay of an individual payment", () => {
    const value = input(); value.gateway!.observation.transfer.txHash = null;
    expect(reconcileX402(value).gaps.map((entry) => entry.code)).toContain("BATCH_TRANSACTION_NOT_OBSERVED");
    expect(reconcileX402(value).onchainSettlement).toBe("not_verified");
  });
  it("cites matched successful batch inclusion but never individual payment settlement", () => {
    const value = input(); value.onchain = { recordId: otherId, observation: batchObservation() };
    const result = reconcileX402(value);
    expect(result.batchInclusion).toBe("included_successfully");
    expect(result.onchainSettlement).toBe("not_verified");
    expect(result.fulfillment).toBe("not_verified");
    expect(result.inputRecordIds).toContain(otherId);
    value.gateway!.observation.transfer.txHash = null;
    expect(reconcileX402(value).batchInclusion).toBe("unlinked");
  });
  it.each(["hash", "anchor", "failed"])("rejects contradictory onchain %s", (kind) => {
    const value = input(); value.onchain = { recordId: otherId, observation: batchObservation() };
    if (kind === "hash") value.onchain.observation.transaction.hash = `0x${"9".repeat(64)}`;
    if (kind === "anchor") value.onchain.observation.transaction.blockNumber = "99";
    if (kind === "failed") value.onchain.observation.receipt.status = "failed";
    const result = reconcileX402(value);
    expect(result.batchInclusion).toBe("conflicting");
    expect(result.metadataAgreement).toBe("conflicting");
    expect(result.conflicts[0]!.recordIds).toEqual([mainId, gatewayId, otherId]);
    expect(result.onchainSettlement).toBe("not_verified");
  });
  it("fails closed on unsupported onchain network and duplicate evidence citations", () => {
    const value = input();
    expect(() => reconcileX402({ ...value, onchain: { recordId: mainId, observation: batchObservation() } })).toThrow();
    expect(() => reconcileX402({ ...value, onchain: { recordId: otherId,
      observation: { ...batchObservation(), network: "eip155:1" } } } as never)).toThrow();
  });
  it("rejects duplicate record IDs, future evidence, overlarge replay scopes, and injected conclusions", () => {
    const value = input();
    for (const changed of [{ evaluatedAt: "2026-09-05T11:00:00Z" },
      { otherBundles: [{ recordId: mainId, bundle: x402Bundle() }] },
      { otherBundles: Array.from({ length: 64 }, () => ({ recordId: otherId, bundle: x402Bundle() })) },
      { conclusion: "settled" }]) {
      expect(() => reconcileX402({ ...value, ...changed })).toThrow();
    }
  });
});
