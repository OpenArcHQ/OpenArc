// Synthetic only: shared by browser and API contract tests; never imported by runtime code.
import { ARC_ERC8183, ARC_TESTNET, JOB_LIMITATIONS, JobEvidenceEnvelopeSchema } from "../packages/shared/src/index.js";

export const JOB_TEST_REQUEST = { network: ARC_TESTNET.caip2, jobId: "1" } as const;
export function jobTestEnvelope() {
  return JobEvidenceEnvelopeSchema.parse({ ok: true,
    meta: { schemaVersion: "openarc.api.v1", requestId: "11111111-1111-4111-8111-111111111111", buildSha: "job-evidence-e2e" },
    data: { schemaVersion: "openarc.job-evidence.v1", network: ARC_TESTNET.caip2, jobId: "1",
      anchor: { blockNumber: "100", blockHash: `0x${"c".repeat(64)}`, blockTimestamp: "2026-09-04T12:00:00Z",
        finality: "deterministic", confirmations: "1" },
      client: `0x${"1".repeat(40)}`, provider: `0x${"2".repeat(40)}`, evaluator: `0x${"3".repeat(40)}`,
      hook: `0x${"0".repeat(40)}`, description: "<script>PUBLIC_UNTRUSTED_JOB_DESCRIPTION</script>",
      budget: { asset: "USDC", contract: ARC_TESTNET.contracts.usdc, decimals: 6,
        baseUnits: "1234567890123456789012345", decimal: "1234567890123456789.012345", explicitlySet: true },
      expiry: { unixSeconds: "1788523200", timestamp: "2026-09-04T12:00:00Z", deadlineReachedAtAnchor: true },
      status: "Submitted", deliverable: { availability: "not_observed", reason: "not_returned_by_getJob" },
      source: { sourceId: "arc_primary_rpc", jobSourceId: "erc8183_reference", origin: ARC_TESTNET.rpcHttp,
        explorerOrigin: ARC_TESTNET.explorerOrigin, network: ARC_TESTNET.caip2,
        contract: ARC_TESTNET.contracts.erc8183AgenticCommerce, implementation: ARC_ERC8183.implementation,
        sourceRevision: ARC_ERC8183.sourceRevision, reviewedAt: ARC_ERC8183.reviewedAt, sourceSha256: ARC_ERC8183.sourceSha256,
        observedAt: "2026-09-04T12:00:01Z", adapterVersion: "openarc.job-evidence.m06.v1" },
      limitations: JOB_LIMITATIONS },
  });
}
