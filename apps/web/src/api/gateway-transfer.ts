import { GATEWAY_TRANSFER_PATH, GatewayTransferEnvelopeSchema, GatewayTransferRequestSchema,
  type GatewayTransferEnvelope, type GatewayTransferRequest } from "@openarc/shared";
import { OpenArcRequestError, requestOpenArc, type OpenArcFetch } from "./client.js";

export async function requestGatewayTransfer(body: GatewayTransferRequest, signal: AbortSignal,
  fetcher?: OpenArcFetch): Promise<GatewayTransferEnvelope> {
  const envelope = await requestOpenArc({ path: GATEWAY_TRANSFER_PATH, method: "POST",
    requestSchema: GatewayTransferRequestSchema, responseSchema: GatewayTransferEnvelopeSchema,
    body, signal, ...(fetcher ? { fetcher } : {}) });
  const expected = GatewayTransferRequestSchema.parse(body);
  if (envelope.data.transfer.id !== expected.transferId || envelope.data.network !== expected.network) {
    throw new OpenArcRequestError("INVALID_RESPONSE", "post-send");
  }
  return envelope;
}
