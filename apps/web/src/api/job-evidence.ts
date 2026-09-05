import { JOB_EVIDENCE_PATH, JobEvidenceEnvelopeSchema, JobEvidenceRequestSchema,
  type JobEvidenceEnvelope, type JobEvidenceRequest } from "@openarc/shared";
import { OpenArcRequestError, requestOpenArc, type OpenArcFetch } from "./client.js";

export async function requestJobEvidence(body: JobEvidenceRequest, signal: AbortSignal,
  fetcher?: OpenArcFetch): Promise<JobEvidenceEnvelope> {
  const envelope = await requestOpenArc({ path: JOB_EVIDENCE_PATH, method: "POST",
    requestSchema: JobEvidenceRequestSchema, responseSchema: JobEvidenceEnvelopeSchema,
    body, signal, ...(fetcher ? { fetcher } : {}) });
  const expected = JobEvidenceRequestSchema.parse(body);
  const deliverable = envelope.data.deliverable;
  if (envelope.data.jobId !== expected.jobId || (expected.submissionTransactionHash ?? null) !==
    (deliverable.availability === "submission_event" ? deliverable.transactionHash : null)) {
    throw new OpenArcRequestError("INVALID_RESPONSE", "post-send");
  }
  return envelope;
}
