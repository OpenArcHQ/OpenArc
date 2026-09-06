import { describe, expect, it } from "vitest";
import { AgentImportError, AgentImportSchema, AGENT_IMPORT_MAX_BYTES, parseAgentImport } from "../src/agent-import.js";
import { ARC_TESTNET } from "../src/network.js";

const id = "11111111-1111-4111-8111-111111111111";
const now = "2026-09-05T12:00:00.000000002Z";
const event = { eventId: id, actionId: "attempt-1", occurredAt: "2026-09-05T12:00:00.000000001Z",
  network: ARC_TESTNET.caip2, asset: ARC_TESTNET.contracts.usdc, decimals: 6,
  payer: `0x${"1".repeat(40)}`, recipient: `0x${"2".repeat(40)}`, amountBaseUnits: "9007199254740993",
  reportedStatus: "attempted", contract: null, serviceDigest: null, authorizationNonce: null,
  authorizationDomainDigest: null, approval: "not_supplied" };
const report = () => ({ schemaVersion: "openarc.agent-import.v1", importId: id, capturedAt: now, connectorId: "local-agent:1", authentication: "not_verified", events: [{ ...event }] });
const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
function failure(bytes: Uint8Array, code: string): void {
  try { parseAgentImport(bytes, now); expect.fail("Expected safe parser error"); }
  catch (error) { expect(error).toBeInstanceOf(AgentImportError); expect((error as AgentImportError).code).toBe(code); expect((error as Error).message).not.toContain("PRIVATE_CANARY"); }
}

describe("M08 local agent import", () => {
  it("preserves exact atomic units and nanoseconds", () => {
    expect(parseAgentImport(encode(report()), now).events[0]!.amountBaseUnits).toBe("9007199254740993");
    expect(AgentImportSchema.safeParse({ ...report(), capturedAt: "2026-09-05T12:00:00Z" }).success).toBe(false);
    failure(encode({ ...report(), capturedAt: "2026-09-05T12:00:00.000000003Z" }), "FUTURE_CAPTURE");
  });
  it.each(["signature", "signatures", "signatureProof", "signedPayload", "publicKey", "verificationKey"])("rejects unsupported %s without echoing content", (key) => {
    failure(encode({ ...report(), [key]: "PRIVATE_CANARY" }), "UNSUPPORTED_SIGNATURE");
    failure(encode({ ...report(), events: [{ ...event, [key]: "PRIVATE_CANARY" }] }), "UNSUPPORTED_SIGNATURE");
  });
  it.each(["url", "privateKey", "prompt", "body", "headers", "conclusion"])("rejects extraneous %s", (key) => {
    failure(encode({ ...report(), [key]: "PRIVATE_CANARY" }), "INVALID_IMPORT");
    failure(encode({ ...report(), events: [{ ...event, [key]: "PRIVATE_CANARY" }] }), "INVALID_IMPORT");
  });
  it("rejects signed authentication and future versions explicitly", () => {
    failure(encode({ ...report(), authentication: "verified" }), "UNSUPPORTED_SIGNATURE");
    failure(encode({ ...report(), schemaVersion: "openarc.agent-import.v2" }), "UNSUPPORTED_VERSION");
    failure(encode({ ...report(), schemaVersion: "openarc.agent-import.signed.v1" }), "UNSUPPORTED_SIGNATURE");
  });
  it("enforces byte bounds, strict UTF8 and JSON before schema work", () => {
    failure(new Uint8Array(AGENT_IMPORT_MAX_BYTES + 1), "IMPORT_TOO_LARGE");
    failure(new Uint8Array([0xc3, 0x28]), "INVALID_UTF8");
    failure(new TextEncoder().encode("PRIVATE_CANARY"), "INVALID_JSON");
    const bytes = encode(report());
    const padded = new Uint8Array(AGENT_IMPORT_MAX_BYTES).fill(32); padded.set(bytes);
    expect(parseAgentImport(padded, now).events).toHaveLength(1);
    failure(encode({ ...report(), nested: JSON.parse('{"__proto__":"PRIVATE_CANARY"}') }), "INVALID_IMPORT");
    failure(new TextEncoder().encode('['.repeat(20) + '0' + ']'.repeat(20)), "INVALID_IMPORT");
  });
  it.each(["-1", "01", "1.1", "1e6", "", (1n << 256n).toString()])("rejects unsafe amount %s", (amountBaseUnits) => {
    failure(encode({ ...report(), events: [{ ...event, amountBaseUnits }] }), "INVALID_IMPORT");
  });
  it("enforces 1–64 events, canonical IDs, pinned network and bounded source identifiers", () => {
    expect(AgentImportSchema.safeParse({ ...report(), events: Array.from({ length: 64 }, () => event) }).success).toBe(true);
    for (const changes of [{ events: [] }, { events: Array.from({ length: 65 }, () => event) },
      { importId: "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA" }, { connectorId: "a".repeat(81) }, { connectorId: "https://example.com" }]) {
      failure(encode({ ...report(), ...changes }), "INVALID_IMPORT");
    }
    for (const changes of [{ network: "eip155:1" }, { asset: `0x${"3".repeat(40)}` }, { decimals: 18 }, { actionId: "a".repeat(129) },
      { authorizationNonce: "0x01" }, { serviceDigest: "https://example.com" }, { occurredAt: "not-a-date" }, { amountBaseUnits: 1 }]) {
      failure(encode({ ...report(), events: [{ ...event, ...changes }] }), "INVALID_IMPORT");
    }
  });
});
