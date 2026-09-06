import {
  ARC_ACCOUNT_SNAPSHOT_PATH,
  ARC_TRANSACTION_EVIDENCE_PATH,
  ArcAccountSnapshotEnvelopeSchema,
  ArcAccountSnapshotRequestSchema,
  ArcTransactionEvidenceEnvelopeSchema,
  ArcTransactionEvidenceRequestSchema,
  type ArcAccountSnapshotEnvelope,
  type ArcAccountSnapshotRequest,
  type ArcTransactionEvidenceEnvelope,
  type ArcTransactionEvidenceRequest,
} from "@openarc/shared";

import { OpenArcRequestError, requestOpenArc, type OpenArcFetch } from "./client.js";

export async function requestArcAccountSnapshot(body: ArcAccountSnapshotRequest, signal: AbortSignal,
  fetcher?: OpenArcFetch): Promise<ArcAccountSnapshotEnvelope> {
  const envelope = await requestOpenArc({ path: ARC_ACCOUNT_SNAPSHOT_PATH, method: "POST",
    requestSchema: ArcAccountSnapshotRequestSchema, responseSchema: ArcAccountSnapshotEnvelopeSchema,
    body, signal, ...(fetcher ? { fetcher } : {}) });
  const expected = ArcAccountSnapshotRequestSchema.parse(body);
  if (envelope.data.address !== expected.address) throw new OpenArcRequestError("INVALID_RESPONSE", "post-send");
  return envelope;
}

export async function requestArcTransactionEvidence(body: ArcTransactionEvidenceRequest, signal: AbortSignal,
  fetcher?: OpenArcFetch): Promise<ArcTransactionEvidenceEnvelope> {
  const envelope = await requestOpenArc({ path: ARC_TRANSACTION_EVIDENCE_PATH, method: "POST",
    requestSchema: ArcTransactionEvidenceRequestSchema, responseSchema: ArcTransactionEvidenceEnvelopeSchema,
    body, signal, ...(fetcher ? { fetcher } : {}) });
  const expected = ArcTransactionEvidenceRequestSchema.parse(body);
  if (envelope.data.transaction.hash !== expected.transactionHash) {
    throw new OpenArcRequestError("INVALID_RESPONSE", "post-send");
  }
  return envelope;
}
