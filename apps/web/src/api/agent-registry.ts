import {
  AGENT_REGISTRY_EVIDENCE_PATH,
  AgentRegistryEvidenceEnvelopeSchema,
  AgentRegistryEvidenceRequestSchema,
  type AgentRegistryEvidenceEnvelope,
  type AgentRegistryEvidenceRequest,
} from "@openarc/shared";

import { OpenArcRequestError, requestOpenArc, type OpenArcFetch } from "./client.js";

export async function requestAgentRegistryEvidence(body: AgentRegistryEvidenceRequest, signal: AbortSignal,
  fetcher?: OpenArcFetch): Promise<AgentRegistryEvidenceEnvelope> {
  const envelope = await requestOpenArc({ path: AGENT_REGISTRY_EVIDENCE_PATH, method: "POST",
    requestSchema: AgentRegistryEvidenceRequestSchema, responseSchema: AgentRegistryEvidenceEnvelopeSchema,
    body, signal, ...(fetcher ? { fetcher } : {}) });
  const expected = AgentRegistryEvidenceRequestSchema.parse(body);
  const feedbackMatches = expected.feedbackQuery
    ? envelope.data.feedback?.observer === expected.feedbackQuery.clientAddress &&
      envelope.data.feedback.feedbackIndex === expected.feedbackQuery.feedbackIndex
    : envelope.data.feedback === null;
  const validationMatches = expected.validationRequestHash
    ? envelope.data.validation?.requestHash === expected.validationRequestHash
    : envelope.data.validation === null;
  if (envelope.data.agentId !== expected.agentId || !feedbackMatches || !validationMatches) {
    throw new OpenArcRequestError("INVALID_RESPONSE", "post-send");
  }
  return envelope;
}
