import { ARC_TESTNET } from "@openarc/shared";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, it, vi } from "vitest";

const { requestMock } = vi.hoisted(() => ({ requestMock: vi.fn() }));
vi.mock("node:https", () => ({ request: requestMock }));

import { BoundedGatewayClient, gatewayHttpsTransport, GATEWAY_ORIGIN } from "../src/gateway/client.js";
import { GatewayTransferService } from "../src/gateway/transfer-service.js";
import { SourceLease } from "../src/limits/budget.js";
import type { ProviderResponse } from "../src/providers/http.js";

const id = "11111111-1111-4111-8111-111111111111";
const signal = () => new AbortController().signal;
const lease = (reserve = async () => undefined) => new SourceLease("gateway", 1, reserve, signal());
const fixture = () => ({ id, status: "received", token: "USDC", sendingNetwork: ARC_TESTNET.caip2,
  recipientNetwork: ARC_TESTNET.caip2, fromAddress: `0x${"ab".repeat(20)}`, toAddress: `0x${"cd".repeat(20)}`,
  amount: "900719925474099312345", nonce: `0x${"ef".repeat(32)}`, txHash: null,
  createdAt: "2026-09-05T00:00:00Z", updatedAt: "2026-09-05T00:01:00Z" });
const input = { network: ARC_TESTNET.caip2, transferId: id };
const now = () => new Date("2026-09-05T00:02:00Z");
function response(body = JSON.stringify(fixture()), overrides: Partial<ProviderResponse> = {}): ProviderResponse {
  return { status: 200, headers: { "content-type": "application/json" },
    body: (async function* () { yield Buffer.from(body); })(), close: vi.fn(), ...overrides };
}
function setup(reply = response(), transport = vi.fn(async () => reply)) {
  const client = new BoundedGatewayClient({ timeoutMs: 100, maxResponseBytes: 1024, transport });
  return { client, transport, service: new GatewayTransferService(client, now) };
}

describe("M07 credential-free fixed Gateway transport", () => {
  it("pins exact GET path, TLS and safe headers, sending no credentials or request body", async () => {
    const request = Object.assign(new EventEmitter(), { end: vi.fn(), destroy: vi.fn() });
    const stream = Object.assign(new PassThrough(), { statusCode: 200, headers: { "content-type": "application/json" } });
    requestMock.mockImplementationOnce((_url, _options, callback) => { queueMicrotask(() => callback(stream)); return request; });
    const abortSignal = signal();
    const received = await gatewayHttpsTransport(id, abortSignal);
    expect(requestMock).toHaveBeenCalledWith(`${GATEWAY_ORIGIN}/v1/x402/transfers/${id}`, {
      method: "GET", signal: abortSignal, agent: false, maxHeaderSize: 8192, rejectUnauthorized: true,
      joinDuplicateHeaders: true, headers: { Accept: "application/json", "Accept-Encoding": "identity" },
    }, expect.any(Function));
    expect(request.end).toHaveBeenCalledWith();
    received.close(); expect(stream.destroyed).toBe(true); expect(request.destroy).toHaveBeenCalledOnce();
  });
  it("sanitizes native HTTPS failures", async () => {
    const request = Object.assign(new EventEmitter(), { end: vi.fn(), destroy: vi.fn() });
    requestMock.mockImplementationOnce(() => { queueMicrotask(() => request.emit("error", new Error("PRIVATE_TLS_CANARY"))); return request; });
    await expect(gatewayHttpsTransport(id, signal())).rejects.toMatchObject({ code: "SOURCE_UNAVAILABLE",
      message: "The approved source is temporarily unavailable." });
  });
  it("reserves exactly one subcall before transport, closes the response, and caps reuse", async () => {
    const reply = response(); const { client, transport } = setup(reply);
    const reserve = vi.fn(async () => undefined); const budget = lease(reserve);
    await expect(client.read(id, budget, signal())).resolves.toEqual(fixture());
    expect(reserve).toHaveBeenCalledOnce(); expect(transport).toHaveBeenCalledOnce();
    expect(reserve.mock.invocationCallOrder[0]).toBeLessThan(transport.mock.invocationCallOrder[0]!);
    expect(reply.close).toHaveBeenCalledOnce();
    await expect(client.read(id, budget, signal())).rejects.toMatchObject({ code: "SOURCE_UNAVAILABLE" });
    expect(transport).toHaveBeenCalledOnce();
  });
  it.each([301, 302, 303, 307, 308, 401, 403, 404, 429, 500, 503])("rejects HTTP %s without following or retrying", async (status) => {
    const reply = response("PRIVATE_BODY_CANARY", { status, headers: { location: "https://evil.test/PRIVATE_CANARY" } });
    const { client, transport } = setup(reply);
    await expect(client.read(id, lease(), signal())).rejects.toMatchObject({
      code: status === 404 ? "SOURCE_NOT_FOUND" : status === 429 ? "SOURCE_RATE_LIMITED" : "SOURCE_UNAVAILABLE",
    });
    expect(transport).toHaveBeenCalledOnce(); expect(reply.close).toHaveBeenCalledOnce();
  });
  it("rejects non-JSON, compressed, duplicate and contradictory size headers", async () => {
    for (const headers of [{ "content-type": "text/html" }, { "content-type": "application/json", "content-encoding": "gzip" },
      { "content-type": ["application/json", "application/json"] }, { "content-type": "application/json", "content-length": "-1" },
      { "content-type": "application/json", "content-length": "4" }, { "content-type": "application/json", "content-length": ["2", "3"] }]) {
      const reply = response("{}", { headers });
      await expect(setup(reply).client.read(id, lease(), signal())).rejects.toMatchObject({ code: "SOURCE_MALFORMED" });
      expect(reply.close).toHaveBeenCalledOnce();
    }
  });
  it("caps declared and streamed bytes without reading an oversized declared body", async () => {
    for (const headers of [{ "content-type": "application/json", "content-length": "3000" }, { "content-type": "application/json" }]) {
      let consumed = 0;
      const reply = response("", { headers, body: (async function* () {
        for (let count = 0; count < 10; count += 1) { consumed += 1; yield Buffer.alloc(600); }
      })() });
      await expect(setup(reply).client.read(id, lease(), signal())).rejects.toMatchObject({ code: "SOURCE_RESPONSE_TOO_LARGE" });
      expect(consumed).toBe(headers["content-length"] ? 0 : 2); expect(reply.close).toHaveBeenCalledOnce();
    }
  });
  it("rejects unsafe, deep, malformed, primitive JSON and invalid UTF-8", async () => {
    for (const body of ["{bad", "null", '"private"', '{"__proto__":{}}', `${'{"a":'.repeat(18)}{}${"}".repeat(18)}`]) {
      await expect(setup(response(body)).client.read(id, lease(), signal())).rejects.toMatchObject({ code: "SOURCE_MALFORMED" });
    }
    const reply = response("", { body: (async function* () { yield Buffer.from([123, 34, 120, 34, 58, 34, 0xff, 34, 125]); })() });
    await expect(setup(reply).client.read(id, lease(), signal())).rejects.toMatchObject({ code: "SOURCE_MALFORMED" });
  });
  it("never dispatches invalid paths, wrong leases, canceled requests or failed reservations", async () => {
    const { client, transport } = setup();
    for (const value of ["../search", `${id}?token=PRIVATE_CANARY`, "https://evil.test", "not-uuid"]) {
      await expect(client.read(value, lease(), signal())).rejects.toMatchObject({ code: "INVALID_REQUEST" });
      await expect(gatewayHttpsTransport(value, signal())).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    }
    await expect(client.read(id, new SourceLease("arc_rpc", 1, async () => undefined, signal()), signal())).rejects.toMatchObject({ code: "SOURCE_UNAVAILABLE" });
    const abort = new AbortController(); abort.abort();
    await expect(client.read(id, lease(), abort.signal)).rejects.toMatchObject({ code: "SOURCE_UNAVAILABLE" });
    await expect(client.read(id, lease(async () => { throw new Error("PRIVATE_BUDGET_CANARY"); }), signal())).rejects.toMatchObject({ code: "SOURCE_UNAVAILABLE" });
    expect(transport).not.toHaveBeenCalled();
  });
  it("bounds late headers and stalled streams; closes late responses", async () => {
    const late = response(); const transport = vi.fn(async () => { await delay(160); return late; });
    await expect(setup(late, transport).client.read(id, lease(), signal())).rejects.toMatchObject({ code: "SOURCE_UNAVAILABLE" });
    await delay(90); expect(late.close).toHaveBeenCalledOnce(); expect(transport).toHaveBeenCalledOnce();
    const stalled = response("", { body: (async function* () { yield Buffer.from("{"); await delay(160); yield Buffer.from("}"); })() });
    await expect(setup(stalled).client.read(id, lease(), signal())).rejects.toMatchObject({ code: "SOURCE_UNAVAILABLE" });
    expect(stalled.close).toHaveBeenCalledOnce();
  });
});

describe("M07 strict Gateway normalization", () => {
  it.each(["received", "batched", "confirmed", "completed", "failed"])("preserves %s without inferring fulfillment or per-payment settlement", async (status) => {
    const transfer = { ...fixture(), status, txHash: status === "received" ? null : `0x${"aa".repeat(32)}` };
    const result = await setup(response(JSON.stringify(transfer))).service.observe(input, lease(), signal());
    expect(result.transfer).toEqual(transfer);
    expect(result.source).toEqual({ sourceId: "circle_gateway_testnet", origin: GATEWAY_ORIGIN,
      observedAt: now().toISOString(), adapterVersion: "openarc.gateway-transfer.m07.v1" });
    expect(Object.keys(result).sort()).toEqual(["network", "schemaVersion", "source", "transfer"]);
  });
  it("normalizes source hex casing but preserves exact atomic amount", async () => {
    const transfer = { ...fixture(), fromAddress: `0x${"AB".repeat(20)}`, nonce: `0x${"EF".repeat(32)}` };
    expect((await setup(response(JSON.stringify(transfer))).service.observe(input, lease(), signal())).transfer).toEqual(fixture());
  });
  it.each([
    { id: "22222222-2222-4222-8222-222222222222" }, { sendingNetwork: "eip155:1" }, { recipientNetwork: "eip155:1" },
    { status: "settled" }, { token: "USDT" }, { amount: "1e6" }, { amount: "01" }, { amount: (1n << 256n).toString() },
    { nonce: "0x1" }, { txHash: "0x1" }, { fromAddress: "address" }, { toAddress: null },
    { createdAt: "2026-09-05T00:01:01Z" }, { updatedAt: "2026-09-05T00:03:00Z" }, { updatedAt: "bad" },
    { rawSignature: "PRIVATE_SIGNATURE_CANARY" },
  ])("fails closed on mismatched or unsupported field %#", async (patch) => {
    const code = "id" in patch ? "SOURCE_CONFLICT" : "sendingNetwork" in patch || "recipientNetwork" in patch ? "SOURCE_WRONG_NETWORK" : "SOURCE_MALFORMED";
    await expect(setup(response(JSON.stringify({ ...fixture(), ...patch }))).service.observe(input, lease(), signal()))
      .rejects.toMatchObject({ code });
  });
  it("rejects missing required nullable hash, wrappers and arrays", async () => {
    const missing: Record<string, unknown> = fixture(); delete missing.txHash;
    for (const body of [missing, { data: fixture() }, [fixture()]]) {
      await expect(setup(response(JSON.stringify(body))).service.observe(input, lease(), signal())).rejects.toMatchObject({ code: "SOURCE_MALFORMED" });
    }
  });
});
