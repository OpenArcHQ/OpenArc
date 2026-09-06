import { ARC_TESTNET, GatewayTransferRequestSchema, GatewayTransferObservationSchema,
  type GatewayTransferRequest, type GatewayTransferObservation } from "@openarc/shared";

import { ApiBoundaryError } from "../http/errors.js";
import type { SourceLease } from "../limits/budget.js";
import { GATEWAY_ORIGIN, type GatewayReader } from "./client.js";

const KEYS = ["id", "status", "token", "sendingNetwork", "recipientNetwork", "fromAddress", "toAddress",
  "amount", "nonce", "txHash", "createdAt", "updatedAt"].sort();
const lower = (value: unknown): unknown => typeof value === "string" ? value.toLowerCase() : value;

export class GatewayTransferService {
  constructor(private readonly gateway: GatewayReader, private readonly now: () => Date = () => new Date()) {}

  async observe(input: GatewayTransferRequest, lease: SourceLease, signal: AbortSignal): Promise<GatewayTransferObservation> {
    const request = GatewayTransferRequestSchema.safeParse(input);
    if (!request.success) throw new ApiBoundaryError("INVALID_REQUEST");
    const raw = await this.gateway.read(request.data.transferId, lease, signal);
    if (!raw || typeof raw !== "object" || Array.isArray(raw) || Object.getPrototypeOf(raw) !== Object.prototype ||
      Object.keys(raw).sort().join("|") !== KEYS.join("|")) throw new ApiBoundaryError("SOURCE_MALFORMED");
    const value = raw as Record<string, unknown>;
    if (value.sendingNetwork !== ARC_TESTNET.caip2 || value.recipientNetwork !== ARC_TESTNET.caip2) {
      throw new ApiBoundaryError("SOURCE_WRONG_NETWORK");
    }
    if (value.id !== request.data.transferId) throw new ApiBoundaryError("SOURCE_CONFLICT");
    const observation = GatewayTransferObservationSchema.safeParse({
      schemaVersion: "openarc.gateway-transfer-observation.v1", network: ARC_TESTNET.caip2,
      transfer: { id: value.id, status: value.status, token: value.token, sendingNetwork: value.sendingNetwork,
        recipientNetwork: value.recipientNetwork, fromAddress: lower(value.fromAddress), toAddress: lower(value.toAddress),
        amount: value.amount, nonce: lower(value.nonce), txHash: lower(value.txHash),
        createdAt: value.createdAt, updatedAt: value.updatedAt },
      source: { sourceId: "circle_gateway_testnet", origin: GATEWAY_ORIGIN,
        observedAt: this.now().toISOString(), adapterVersion: "openarc.gateway-transfer.m07.v1" },
    });
    if (!observation.success) throw new ApiBoundaryError("SOURCE_MALFORMED");
    return observation.data;
  }
}
