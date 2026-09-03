import { API_CLIENT_HEADER, API_SCHEMA_VERSION, ARC_TESTNET, CAPABILITIES_PATH } from "@openarc/shared";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CapabilityRequestError, requestCapabilities } from "../src/api/capabilities.js";

function envelope() {
  return { ok: true, data: { capabilityVersion: "openarc.capabilities.m04.v1", environment: "testnet",
    network: ARC_TESTNET.caip2, sourceRevision: ARC_TESTNET.sourceRevision, reviewedAt: ARC_TESTNET.reviewedAt,
    writes: false, enabledConnectors: [], features: { arcObservation: false, agentRegistry: false, agentJobs: false, gatewayEvidence: false },
    limits: { requestBytes: 16_384, responseBytes: 65_536, sourceResponseBytes: 262_144,
      sourceTimeoutMs: 5_000, sourceMaxSubcalls: 8, requestsPerPeerHour: 60, globalSourceUnitsPerDay: 10_000 } },
    meta: { schemaVersion: API_SCHEMA_VERSION, requestId: "018f47a2-3b4c-7def-8123-456789abcdef", buildSha: "test-sha" } };
}
function json(value: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json", ...init.headers }, ...init });
}

describe("M03 capability API client", () => {
  afterEach(() => vi.useRealTimers());
  it("uses only the fixed relative GET with no credentials, referrer, redirects, or caching", async () => {
    const fetcher = vi.fn(async () => json(envelope()));
    await expect(requestCapabilities(new AbortController().signal, fetcher)).resolves.toEqual(envelope());
    expect(fetcher).toHaveBeenCalledWith(CAPABILITIES_PATH, { method: "GET", headers: { "X-OpenArc-Client": API_CLIENT_HEADER },
      credentials: "omit", redirect: "error", cache: "no-store", referrerPolicy: "no-referrer", signal: expect.any(AbortSignal) });
  });

  it("distinguishes a synchronous pre-send failure from ambiguous post-send failures", async () => {
    const before = () => { throw new Error("PRIVATE_PRE_CANARY"); };
    await expect(requestCapabilities(new AbortController().signal, before)).rejects.toMatchObject({ code: "REQUEST_UNAVAILABLE", phase: "pre-send" });
    const after = async () => { throw new Error("PRIVATE_POST_CANARY"); };
    await expect(requestCapabilities(new AbortController().signal, after)).rejects.toMatchObject({ code: "REQUEST_UNAVAILABLE", phase: "post-send" });
  });

  it("requires exact success and fixed error envelopes", async () => {
    for (const value of [{ ...envelope(), extra: true }, { ...envelope(), data: { ...envelope().data, writes: true } },
      { ...envelope(), data: { ...envelope().data, enabledConnectors: ["arc_primary_rpc"] } }, { private: "PRIVATE_CANARY" }, null]) {
      await expect(requestCapabilities(new AbortController().signal, async () => json(value))).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
    }
    const error = { ok: false, error: { code: "FEATURE_DISABLED", message: "This capability is disabled.", retryable: false },
      meta: envelope().meta };
    await expect(requestCapabilities(new AbortController().signal, async () => json(error, { status: 503 })))
      .rejects.toMatchObject({ code: "FEATURE_DISABLED", phase: "post-send" });
    await expect(requestCapabilities(new AbortController().signal, async () => json({ ...error, error: { ...error.error, message: "PRIVATE_CANARY" } }, { status: 503 })))
      .rejects.toMatchObject({ code: "INVALID_RESPONSE" });
  });

  it("bounds media type, declared/actual bytes, UTF-8, and aborts without returning partial data", async () => {
    for (const response of [
      new Response("{}", { headers: { "content-type": "text/html" } }),
      new Response("{}", { headers: { "content-type": "application/json", "content-length": "65537" } }),
      new Response("{}", { headers: { "content-type": "application/json", "content-length": "4" } }),
      new Response(new Uint8Array([123, 34, 120, 34, 58, 34, 0xff, 34, 125]), { headers: { "content-type": "application/json" } }),
      new Response("x".repeat(65_537), { headers: { "content-type": "application/json" } }),
    ]) await expect(requestCapabilities(new AbortController().signal, async () => response)).rejects.toBeInstanceOf(CapabilityRequestError);
    const controller = new AbortController();
    controller.abort();
    await expect(requestCapabilities(controller.signal, async () => json(envelope()))).rejects.toMatchObject({ code: "REQUEST_UNAVAILABLE" });
  });

  it("enforces one total 10-second deadline even when fetch or a body reader ignores abort", async () => {
    vi.useFakeTimers();
    const never = new Promise<Response>(() => undefined);
    const stalledFetch = requestCapabilities(new AbortController().signal, () => never);
    const assertion = expect(stalledFetch).rejects.toMatchObject({ code: "REQUEST_UNAVAILABLE", phase: "post-send" });
    await vi.advanceTimersByTimeAsync(10_001);
    await assertion;
    const stalled = new ReadableStream<Uint8Array>({ start() { /* Deliberately never closes. */ } });
    const stalledBody = requestCapabilities(new AbortController().signal,
      async () => new Response(stalled, { headers: { "content-type": "application/json" } }));
    const bodyAssertion = expect(stalledBody).rejects.toMatchObject({ code: "REQUEST_UNAVAILABLE", phase: "post-send" });
    await vi.advanceTimersByTimeAsync(10_001);
    await bodyAssertion;
    const uncancellable = new ReadableStream<Uint8Array>({
      start() { /* Deliberately never closes. */ },
      cancel() { return new Promise<void>(() => undefined); },
    });
    const uncancellableBody = requestCapabilities(new AbortController().signal,
      async () => new Response(uncancellable, { headers: { "content-type": "application/json" } }));
    const uncancellableAssertion = expect(uncancellableBody).rejects.toMatchObject({ code: "REQUEST_UNAVAILABLE", phase: "post-send" });
    await vi.advanceTimersByTimeAsync(10_001);
    await uncancellableAssertion;
  });
});
