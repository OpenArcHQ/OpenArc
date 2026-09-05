import { ARC_TESTNET, GatewayTransferEnvelopeSchema, X402BundleRecordSchema } from "../../../packages/shared/src/index.js";

export const GATEWAY_TEST_ID = "33333333-3333-4333-8333-333333333333";
export const GATEWAY_TEST_REQUEST = { network: ARC_TESTNET.caip2, transferId: GATEWAY_TEST_ID } as const;
export const gatewayEnvelope = () => GatewayTransferEnvelopeSchema.parse({ ok: true,
  meta: { schemaVersion: "openarc.api.v1", requestId: "11111111-1111-4111-8111-111111111111", buildSha: "gateway-web-test" },
  data: { schemaVersion: "openarc.gateway-transfer-observation.v1", network: ARC_TESTNET.caip2,
    transfer: { id: GATEWAY_TEST_ID, status: "completed", token: "USDC", sendingNetwork: ARC_TESTNET.caip2,
      recipientNetwork: ARC_TESTNET.caip2, fromAddress: `0x${"1".repeat(40)}`, toAddress: `0x${"2".repeat(40)}`,
      amount: "1000", nonce: `0x${"a".repeat(64)}`, txHash: null,
      createdAt: "2026-09-05T12:00:00Z", updatedAt: "2026-09-05T12:01:00Z" },
    source: { sourceId: "circle_gateway_testnet", origin: "https://gateway-api-testnet.circle.com",
      observedAt: "2026-09-05T12:02:00Z", adapterVersion: "openarc.gateway-transfer.m07.v1" } },
});

export const gatewayBundleRecord = (recordRevision: string) => X402BundleRecordSchema.parse({
  recordSchema: "openarc.x402-bundle-record.v1", kind: "x402_bundle", recordId: crypto.randomUUID(),
  recordRevision, createdAt: "2026-09-05T12:03:00Z", updatedAt: "2026-09-05T12:03:00Z",
  bundle: { schemaVersion: "openarc.x402-receipt-bundle.v1", bundleId: crypto.randomUUID(),
    capturedAt: "2026-09-05T12:03:00Z", provenance: "imported_metadata", authentication: "not_verified",
    resource: { originDigest: `sha256:${"b".repeat(64)}`, resourceDigest: `sha256:${"c".repeat(64)}` },
    responseMetadata: { respondedAt: "2026-09-05T12:01:00Z", httpStatus: 200, reportedSuccess: true,
      responseDigest: `sha256:${"d".repeat(64)}`, transferId: GATEWAY_TEST_ID } },
});
