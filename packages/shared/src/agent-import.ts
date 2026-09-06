import { z } from "zod";

import { ARC_TESTNET } from "./network.js";
import { EvmAddressSchema, IsoTimestampSchema, Sha256DigestSchema, TransactionHashSchema,
  Uint256DecimalSchema, compareIsoTimestamps } from "./primitives.js";

// Standard Web/Node 22 global; keep this package independent of DOM and Node type libraries.
declare const TextDecoder: new (label: string, options: { fatal: boolean; ignoreBOM: boolean }) => {
  decode(input: Uint8Array): string;
};

export const AGENT_IMPORT_MAX_BYTES = 256 * 1024;
export const AGENT_IMPORT_MAX_EVENTS = 64;
export const AGENT_POLICY_MAX_IMPORTS = 32;
export const AGENT_POLICY_MAX_EVENTS = 512;
export const AgentImportIdSchema = z.string().uuid().regex(/^[0-9a-f-]{36}$/u);
export const AgentConnectorIdSchema = z.string().min(1).max(80).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u);

export const AgentAttemptEventSchema = z.strictObject({
  eventId: AgentImportIdSchema,
  actionId: z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u),
  occurredAt: IsoTimestampSchema,
  network: z.literal(ARC_TESTNET.caip2), asset: z.literal(ARC_TESTNET.contracts.usdc), decimals: z.literal(6),
  payer: EvmAddressSchema, recipient: EvmAddressSchema, amountBaseUnits: Uint256DecimalSchema,
  reportedStatus: z.enum(["attempted", "succeeded", "failed"]), contract: EvmAddressSchema.nullable(),
  serviceDigest: Sha256DigestSchema.nullable(), authorizationNonce: TransactionHashSchema.nullable(),
  authorizationDomainDigest: Sha256DigestSchema.nullable(),
  approval: z.enum(["reported_approved", "reported_denied", "not_supplied"]),
});

export const AgentImportSchema = z.strictObject({
  schemaVersion: z.literal("openarc.agent-import.v1"), importId: AgentImportIdSchema,
  capturedAt: IsoTimestampSchema, connectorId: AgentConnectorIdSchema,
  authentication: z.literal("not_verified"), events: z.array(AgentAttemptEventSchema).min(1).max(AGENT_IMPORT_MAX_EVENTS),
}).superRefine((bundle, context) => {
  if (!IsoTimestampSchema.safeParse(bundle.capturedAt).success) return;
  for (const [index, event] of bundle.events.entries()) {
    if (IsoTimestampSchema.safeParse(event.occurredAt).success && compareIsoTimestamps(event.occurredAt, bundle.capturedAt) > 0) {
      context.addIssue({ code: "custom", path: ["events", index, "occurredAt"], message: "An event cannot follow capture" });
    }
  }
});

export type AgentAttemptEvent = z.infer<typeof AgentAttemptEventSchema>;
export type AgentImport = z.infer<typeof AgentImportSchema>;
export type AgentImportFailureCode = "IMPORT_TOO_LARGE" | "INVALID_UTF8" | "INVALID_JSON" | "INVALID_IMPORT" |
  "UNSUPPORTED_VERSION" | "UNSUPPORTED_SIGNATURE" | "FUTURE_CAPTURE";
export class AgentImportError extends Error {
  constructor(readonly code: AgentImportFailureCode) { super(code); this.name = "AgentImportError"; }
}

/** Strict, local-only parsing. Error messages never include untrusted file contents. */
export function parseAgentImport(bytes: Uint8Array, evaluatedAt: string): AgentImport {
  if (!(bytes instanceof Uint8Array) || !IsoTimestampSchema.safeParse(evaluatedAt).success) throw new AgentImportError("INVALID_IMPORT");
  if (bytes.byteLength > AGENT_IMPORT_MAX_BYTES) throw new AgentImportError("IMPORT_TOO_LARGE");
  let text: string;
  try { text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes); }
  catch { throw new AgentImportError("INVALID_UTF8"); }
  let value: unknown;
  try { value = JSON.parse(text); }
  catch { throw new AgentImportError("INVALID_JSON"); }
  inspectJson(value);
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const source = value as Record<string, unknown>;
    if (source.schemaVersion !== "openarc.agent-import.v1") throw new AgentImportError("UNSUPPORTED_VERSION");
  }
  const parsed = AgentImportSchema.safeParse(value);
  if (!parsed.success) throw new AgentImportError("INVALID_IMPORT");
  if (compareIsoTimestamps(parsed.data.capturedAt, evaluatedAt) > 0) throw new AgentImportError("FUTURE_CAPTURE");
  return parsed.data;
}

function inspectJson(root: unknown): void {
  const stack = [{ value: root, depth: 0 }]; let nodes = 0;
  while (stack.length) {
    const current = stack.pop()!;
    if (++nodes > 8192 || current.depth > 16) throw new AgentImportError("INVALID_IMPORT");
    if (!current.value || typeof current.value !== "object") continue;
    for (const [key, value] of Object.entries(current.value)) {
      if (["signature", "signatures", "signatureProof", "signedPayload", "publicKey", "verificationKey"].includes(key) ||
        (key === "authentication" && (value === "signed" || value === "verified")) ||
        (key === "schemaVersion" && typeof value === "string" && value.includes("signed"))) {
        throw new AgentImportError("UNSUPPORTED_SIGNATURE");
      }
      if (["__proto__", "constructor", "prototype"].includes(key)) throw new AgentImportError("INVALID_IMPORT");
      stack.push({ value, depth: current.depth + 1 });
    }
  }
}
