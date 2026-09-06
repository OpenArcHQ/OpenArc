import { ARC_TESTNET } from "@openarc/shared";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, it, vi } from "vitest";

const { requestMock } = vi.hoisted(() => ({ requestMock: vi.fn() }));
vi.mock("node:https", () => ({ request: requestMock }));

import { SourceLease, type BudgetEvent } from "../src/limits/budget.js";
import { arcHttpsTransport, BoundedProviderClient, type ProviderResponse, type ProviderTransport } from "../src/providers/http.js";
import { ArcRpcClient } from "../src/arc/rpc-client.js";

const signal = () => new AbortController().signal;
function lease(abortSignal = signal(), reserve = async () => undefined, events: BudgetEvent[] = []) {
  return new SourceLease("arc_rpc", 8, reserve, abortSignal, (_source, event) => events.push(event));
}
function response(body = '{"result":"synthetic"}', overrides: Partial<ProviderResponse> = {}): ProviderResponse {
  return { status: 200, headers: { "content-type": "application/json" },
    body: (async function* () { yield Buffer.from(body); })(), close: vi.fn(), ...overrides };
}
function setup(reply = response(), overrides: Partial<ConstructorParameters<typeof BoundedProviderClient>[0]> = {}) {
  const transport = vi.fn(async () => reply);
  return { transport, client: new BoundedProviderClient({ timeoutMs: 100, maxResponseBytes: 1_024, transport, ...overrides }) };
}

describe("M03 pinned bounded provider transport", () => {
  it("pins HTTPS endpoint, POST, normal TLS verification, identity encoding, and header/body limits", async () => {
    const request = Object.assign(new EventEmitter(), { end: vi.fn(), destroy: vi.fn() });
    const body = Buffer.from('{"fixture":true}');
    const abortSignal = signal();
    const stream = Object.assign(new PassThrough(), { statusCode: 200, headers: { "content-type": "application/json" } });
    requestMock.mockImplementationOnce((_url, _options, callback) => { queueMicrotask(() => callback(stream)); return request; });
    const received = await arcHttpsTransport(body, abortSignal);
    expect(requestMock).toHaveBeenCalledWith(ARC_TESTNET.rpcHttp, {
      method: "POST", signal: abortSignal, agent: false, maxHeaderSize: 8_192, rejectUnauthorized: true, joinDuplicateHeaders: true,
      headers: { "Content-Type": "application/json", Accept: "application/json", "Accept-Encoding": "identity", "Content-Length": String(body.length) },
    }, expect.any(Function));
    expect(request.end).toHaveBeenCalledWith(body);
    received.close();
    expect(stream.destroyed).toBe(true);
    expect(request.destroy).toHaveBeenCalledOnce();
  });

  it("maps native request errors to fixed text without leaking TLS/host details", async () => {
    const request = Object.assign(new EventEmitter(), { end: vi.fn(), destroy: vi.fn() });
    requestMock.mockImplementationOnce(() => { queueMicrotask(() => request.emit("error", new Error("PRIVATE_TLS_CANARY"))); return request; });
    await expect(arcHttpsTransport(Buffer.from("{}"), signal())).rejects
      .toMatchObject({ code: "SOURCE_UNAVAILABLE", message: "The approved source is temporarily unavailable." });
  });

  it("requires a reservation before exactly one dispatch, then closes the response", async () => {
    const reply = response();
    const { client, transport } = setup(reply);
    const reserve = vi.fn(async () => undefined);
    await expect(client.postJson({ fixture: true }, lease(signal(), reserve), signal())).resolves.toEqual({ result: "synthetic" });
    expect(reserve).toHaveBeenCalledOnce();
    expect(transport).toHaveBeenCalledOnce();
    expect(reserve.mock.invocationCallOrder[0]).toBeLessThan(transport.mock.invocationCallOrder[0]!);
    expect(reply.close).toHaveBeenCalledOnce();
  });

  it("rejects redirect, unavailable, and rate-limited responses without following or retrying", async () => {
    for (const status of [301, 302, 303, 307, 308, 401, 404, 429, 500, 503]) {
      const reply = response("PRIVATE_BODY_CANARY", { status, headers: { location: "https://evil.example.test/PRIVATE_URL_CANARY" } });
      const { client, transport } = setup(reply);
      await expect(client.postJson({}, lease(), signal())).rejects.toMatchObject({ code: status === 429 ? "SOURCE_RATE_LIMITED" : "SOURCE_UNAVAILABLE" });
      expect(transport).toHaveBeenCalledOnce();
      expect(reply.close).toHaveBeenCalledOnce();
    }
  });

  it("rejects compressed, non-JSON, invalid, duplicate, and mismatched size headers", async () => {
    for (const headers of [
      { "content-type": "text/html" }, { "content-type": "application/json", "content-encoding": "gzip" },
      { "content-type": "application/json", "content-encoding": "br" },
      { "content-type": ["application/json", "text/html"] },
      { "content-type": "application/json", "content-length": "-1" },
      { "content-type": "application/json", "content-length": "4" },
      { "content-type": "application/json", "content-length": ["2", "5"] },
    ]) {
      const reply = response("{}", { headers });
      await expect(setup(reply).client.postJson({}, lease(), signal())).rejects.toMatchObject({ code: "SOURCE_MALFORMED" });
      expect(reply.close).toHaveBeenCalledOnce();
    }
  });

  it("stops at declared or streamed byte limits, including a lying Content-Length", async () => {
    for (const headers of [{ "content-type": "application/json" },
      { "content-type": "application/json", "content-length": "3000" },
      { "content-type": "application/json", "content-length": "2" }]) {
      let consumed = 0;
      const reply = response("", { headers, body: (async function* () {
        for (let index = 0; index < 20; index += 1) { consumed += 1; yield Buffer.alloc(600, "x"); }
      })() });
      await expect(setup(reply).client.postJson({}, lease(), signal())).rejects.toMatchObject({ code: "SOURCE_RESPONSE_TOO_LARGE" });
      expect(consumed).toBeLessThanOrEqual(2);
      expect(reply.close).toHaveBeenCalledOnce();
    }
  });

  it("rejects malformed/primitive/unsafe/oversized JSON structures and invalid UTF-8", async () => {
    const deep = `${'{"child":'.repeat(18)}{}${"}".repeat(18)}`;
    for (const body of ["{PRIVATE_PARSE_CANARY", "null", '"PRIVATE_PRIMITIVE_CANARY"', "[] trailing", deep,
      '{"__proto__":{"PRIVATE_CANARY":true}}', JSON.stringify({ a: Array.from({ length: 2_049 }, () => 0) }),
      JSON.stringify({ a: "x".repeat(65_537) }), JSON.stringify(Array.from({ length: 8 }, () => Array.from({ length: 1_200 }, () => 0)))]) {
      await expect(setup(response(body), { maxResponseBytes: 256 * 1024 }).client.postJson({}, lease(), signal()))
        .rejects.toMatchObject({ code: "SOURCE_MALFORMED" });
    }
    const reply = response("", { body: (async function* () { yield Buffer.from([123, 34, 120, 34, 58, 34, 0xff, 34, 125]); })() });
    await expect(setup(reply).client.postJson({}, lease(), signal())).rejects.toMatchObject({ code: "SOURCE_MALFORMED" });
  });

  it("never sends invalid/oversized requests, wrong-source leases, or canceled calls", async () => {
    const { client, transport } = setup();
    for (const input of [{ value: "x".repeat(17_000) }, undefined, { invalid: 1n }, { nested: { a: undefined } }]) {
      await expect(client.postJson(input, lease(), signal())).rejects.toBeDefined();
    }
    const controller = new AbortController();
    controller.abort();
    await expect(client.postJson({}, lease(), controller.signal)).rejects.toMatchObject({ code: "SOURCE_UNAVAILABLE" });
    await expect(client.postJson({}, new SourceLease("gateway", 1, async () => undefined, signal()), signal())).rejects.toMatchObject({ code: "SOURCE_UNAVAILABLE" });
    expect(transport).not.toHaveBeenCalled();
  });

  it("bounds headers and streaming stalls with one total deadline and closes late responses", async () => {
    const late = response();
    const transport = vi.fn(async () => { await delay(160); return late; });
    await expect(setup(late, { transport }).client.postJson({}, lease(), signal())).rejects.toMatchObject({ code: "SOURCE_UNAVAILABLE" });
    await delay(90);
    expect(transport).toHaveBeenCalledOnce();
    expect(late.close).toHaveBeenCalledOnce();
    const stream = response("", { body: (async function* () { yield Buffer.from("{"); await delay(160); yield Buffer.from("}"); })() });
    await expect(setup(stream).client.postJson({}, lease(), signal())).rejects.toMatchObject({ code: "SOURCE_UNAVAILABLE" });
    expect(stream.close).toHaveBeenCalledOnce();
  });

  it("aborts a pending call and maps raw transport failures without private messages", async () => {
    const controller = new AbortController();
    const transport: ProviderTransport = async (_body, abortSignal) => {
      controller.abort();
      expect(abortSignal.aborted).toBe(true);
      throw new Error("PRIVATE_TRANSPORT_CANARY");
    };
    await expect(setup(response(), { transport }).client.postJson({}, lease(), controller.signal))
      .rejects.toMatchObject({ code: "SOURCE_UNAVAILABLE", message: "The approved source is temporarily unavailable." });
  });
});

describe("M04 strict JSON-RPC envelope", () => {
  it("uses an opaque request ID and returns only the exact matching result", async () => {
    const transport = vi.fn(async (body: Buffer) => {
      const request = JSON.parse(body.toString("utf8"));
      expect(request).toMatchObject({ jsonrpc: "2.0", method: "eth_chainId", params: [] });
      expect(request.id).toMatch(/^oa_[0-9a-f-]{36}$/u);
      expect(JSON.stringify(request)).not.toContain("PRIVATE_CANARY");
      return response(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: ARC_TESTNET.chainIdHex }));
    });
    const rpc = new ArcRpcClient(new BoundedProviderClient({ timeoutMs: 100, maxResponseBytes: 1_024, transport }));
    await expect(rpc.call("eth_chainId", [], lease(), signal())).resolves.toBe(ARC_TESTNET.chainIdHex);
    expect(transport).toHaveBeenCalledOnce();
  });

  it("rejects wrong IDs, errors, and extra envelope fields", async () => {
    for (const build of [
      (id: string) => ({ jsonrpc: "2.0", id: `${id}-wrong`, result: "0x1" }),
      (id: string) => ({ jsonrpc: "2.0", id, error: { code: -1, message: "PRIVATE_CANARY" } }),
      (id: string) => ({ jsonrpc: "2.0", id, result: "0x1", extra: "PRIVATE_CANARY" }),
      (id: string) => ({ jsonrpc: "1.0", id, result: "0x1" }),
    ]) {
      const transport: ProviderTransport = async (body) => {
        const id = JSON.parse(body.toString("utf8")).id as string;
        return response(JSON.stringify(build(id)));
      };
      const rpc = new ArcRpcClient(new BoundedProviderClient({ timeoutMs: 100, maxResponseBytes: 1_024, transport }));
      await expect(rpc.call("eth_chainId", [], lease(), signal())).rejects.toMatchObject({
        code: "SOURCE_MALFORMED", message: "The source response did not match its supported contract.",
      });
    }
  });

  it("maps only an explicitly expected eth_call revert to sanitized not-found", async () => {
    const transport: ProviderTransport = async (body) => {
      const request = JSON.parse(body.toString("utf8"));
      return response(JSON.stringify({ jsonrpc: "2.0", id: request.id,
        error: { code: -32_000, message: "PRIVATE_REVERT_CANARY", data: "PRIVATE_DATA_CANARY" } }));
    };
    const rpc = new ArcRpcClient(new BoundedProviderClient({ timeoutMs: 100, maxResponseBytes: 1_024, transport }));
    await expect(rpc.call("eth_call", [{ to: "0x1111111111111111111111111111111111111111", data: "0x" }, "0x1"],
      lease(), signal(), { revertAsNotFound: true })).rejects.toMatchObject({
      code: "SOURCE_NOT_FOUND", message: "The requested source evidence was not found.",
    });
    await expect(rpc.call("eth_chainId", [], lease(), signal(), { revertAsNotFound: true }))
      .rejects.toMatchObject({ code: "SOURCE_MALFORMED" });
  });
});
