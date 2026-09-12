import {
  API_CLIENT_HEADER,
  API_MAX_RESPONSE_BYTES,
  COMMERCE_API_ERRORS,
  COMMERCE_API_SCHEMA_VERSION,
  AccountBootstrapResponseSchema,
  AccountEmptyRequestSchema,
  AccountSessionViewSchema,
} from "@openarc/shared";
import { describe, expect, it, vi } from "vitest";

import { ACCOUNT_API_PATHS, AccountApiError, requestAccount } from "../src/account/auth-client.js";

const META = {
  schemaVersion: COMMERCE_API_SCHEMA_VERSION,
  requestId: "018f47a2-3b4c-7def-8123-456789abcdef",
  buildSha: "0123456789abcdef0123456789abcdef01234567",
};

function json(value: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json", ...init.headers },
    ...init,
  });
}

const GUEST = { ok: true as const, data: { signedIn: false as const }, meta: META };

describe("account v2 auth client", () => {
  it("sends only a relative same-origin JSON request with client and CSRF headers", async () => {
    const fetcher = vi.fn(async () => json(GUEST));
    const data = await requestAccount({
      path: ACCOUNT_API_PATHS.session,
      method: "GET",
      responseSchema: AccountSessionViewSchema,
      signal: new AbortController().signal,
      fetcher,
    });
    expect(data).toEqual({ signedIn: false });
    expect(fetcher).toHaveBeenCalledWith(ACCOUNT_API_PATHS.session, {
      method: "GET",
      headers: { "X-OpenArc-Client": API_CLIENT_HEADER },
      credentials: "same-origin",
      cache: "no-store",
      redirect: "error",
      referrerPolicy: "no-referrer",
      signal: expect.any(AbortSignal),
    });
  });

  it("adds CSRF and strict JSON body only for an explicit POST", async () => {
    const fetcher = vi.fn(async () =>
      json({
        ok: true,
        data: { csrfToken: "csrf-token-value", session: { signedIn: false } },
        meta: META,
      }),
    );
    await requestAccount({
      path: ACCOUNT_API_PATHS.bootstrap,
      method: "POST",
      requestSchema: AccountEmptyRequestSchema,
      responseSchema: AccountBootstrapResponseSchema,
      body: {},
      csrfToken: "csrf-token-value",
      signal: new AbortController().signal,
      fetcher,
    });
    expect(fetcher).toHaveBeenCalledWith(ACCOUNT_API_PATHS.bootstrap, {
      method: "POST",
      headers: {
        "X-OpenArc-Client": API_CLIENT_HEADER,
        "Content-Type": "application/json",
        "X-OpenArc-CSRF": "csrf-token-value",
      },
      body: "{}",
      credentials: "same-origin",
      cache: "no-store",
      redirect: "error",
      referrerPolicy: "no-referrer",
      signal: expect.any(AbortSignal),
    });
  });

  it("rejects a mismatched method/body shape before sending", async () => {
    const fetcher = vi.fn(async () => json(GUEST));
    await expect(
      requestAccount({
        path: ACCOUNT_API_PATHS.session,
        method: "GET",
        requestSchema: AccountEmptyRequestSchema,
        responseSchema: AccountSessionViewSchema,
        body: {},
        signal: new AbortController().signal,
        fetcher,
      }),
    ).rejects.toMatchObject({ failure: { kind: "pre-send" } });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("maps a canonical error envelope to a bounded code without echoing text", async () => {
    const fetcher = async () =>
      json(
        {
          ok: false,
          error: {
            code: "CSRF_REJECTED",
            message: COMMERCE_API_ERRORS.CSRF_REJECTED.message,
            retryable: false,
          },
          meta: META,
        },
        { status: 403 },
      );
    await expect(
      requestAccount({
        path: ACCOUNT_API_PATHS.session,
        method: "GET",
        responseSchema: AccountSessionViewSchema,
        signal: new AbortController().signal,
        fetcher,
      }),
    ).rejects.toMatchObject({ failure: { kind: "server", code: "CSRF_REJECTED" } });
  });

  it("rejects non-canonical error messages and unknown codes", async () => {
    for (const error of [
      { code: "CSRF_REJECTED", message: "PRIVATE_CANARY", retryable: false },
      { code: "NOT_A_CODE", message: "x", retryable: false },
    ]) {
      await expect(
        requestAccount({
          path: ACCOUNT_API_PATHS.session,
          method: "GET",
          responseSchema: AccountSessionViewSchema,
          signal: new AbortController().signal,
          fetcher: async () => json({ ok: false, error, meta: META }, { status: 403 }),
        }),
      ).rejects.toMatchObject({ failure: { kind: "invalid-response" } });
    }
  });

  it("rejects wrong schema versions, extra success keys and malformed DTOs", async () => {
    for (const body of [
      { ...GUEST, meta: { ...META, schemaVersion: "openarc.api.v1" } },
      { ...GUEST, extra: true },
      { ok: true, data: { session: { signedIn: true } }, meta: META },
    ]) {
      await expect(
        requestAccount({
          path: ACCOUNT_API_PATHS.session,
          method: "GET",
          responseSchema: AccountSessionViewSchema,
          signal: new AbortController().signal,
          fetcher: async () => json(body),
        }),
      ).rejects.toBeInstanceOf(AccountApiError);
    }
  });

  it("treats a transport failure after send as an unknown outcome, not a false failure", async () => {
    await expect(
      requestAccount({
        path: ACCOUNT_API_PATHS.session,
        method: "GET",
        responseSchema: AccountSessionViewSchema,
        signal: new AbortController().signal,
        fetcher: async () => {
          throw new Error("PRIVATE_CANARY");
        },
      }),
    ).rejects.toMatchObject({ failure: { kind: "outcome-unknown" } });
  });

  it("reports outcome-unknown for an unverifiable POST response after send", async () => {
    const postEnvelope = (data: unknown, status = 200) =>
      new Response(JSON.stringify({ ok: status === 200, data, meta: META }), {
        status,
        headers: { "content-type": "application/json" },
      });
    const cases: Array<() => Promise<Response>> = [
      // Truncated body: declared length does not match the actual bytes.
      async () =>
        new Response('{"ok":true,"data":{"ses', {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      // Valid envelope but a data DTO that fails its schema.
      async () => postEnvelope({ session: { signedIn: "yes" } }),
      // Successful-looking envelope with extra keys.
      async () =>
        new Response(JSON.stringify({ ok: true, data: { session: { signedIn: false } }, meta: META, extra: 1 }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      // Wrong content type.
      async () => new Response("{}", { status: 200, headers: { "content-type": "text/html" } }),
    ];
    for (const response of cases) {
      await expect(
        requestAccount({
          path: ACCOUNT_API_PATHS.logout,
          method: "POST",
          requestSchema: AccountEmptyRequestSchema,
          responseSchema: AccountSessionViewSchema,
          body: {},
          csrfToken: "csrf-token-value",
          signal: new AbortController().signal,
          fetcher: response,
        }),
      ).rejects.toMatchObject({ failure: { kind: "outcome-unknown" } });
    }
  });

  it("keeps a concrete server denial and a GET schema failure distinct", async () => {
    // A canonical 500 is a concrete server error, not an unknown outcome.
    await expect(
      requestAccount({
        path: ACCOUNT_API_PATHS.logout,
        method: "POST",
        requestSchema: AccountEmptyRequestSchema,
        responseSchema: AccountSessionViewSchema,
        body: {},
        csrfToken: "csrf-token-value",
        signal: new AbortController().signal,
        fetcher: async () =>
          json(
            {
              ok: false,
              error: { code: "INTERNAL_ERROR", message: COMMERCE_API_ERRORS.INTERNAL_ERROR.message, retryable: false },
              meta: META,
            },
            { status: 500 },
          ),
      }),
    ).rejects.toMatchObject({ failure: { kind: "server", code: "INTERNAL_ERROR" } });
    // A GET with a bad DTO stays an invalid read, never a phantom write.
    await expect(
      requestAccount({
        path: ACCOUNT_API_PATHS.session,
        method: "GET",
        responseSchema: AccountSessionViewSchema,
        signal: new AbortController().signal,
        fetcher: async () => json({ ok: true, data: { signedIn: "yes" }, meta: META }),
      }),
    ).rejects.toMatchObject({ failure: { kind: "invalid-response" } });
  });

  it("bounds declared and actual response bytes and rejects non-JSON media", async () => {
    await expect(
      requestAccount({
        path: ACCOUNT_API_PATHS.session,
        method: "GET",
        responseSchema: AccountSessionViewSchema,
        signal: new AbortController().signal,
        fetcher: async () => new Response("{}", { headers: { "content-type": "text/html" } }),
      }),
    ).rejects.toMatchObject({ failure: { kind: "invalid-response" } });
    await expect(
      requestAccount({
        path: ACCOUNT_API_PATHS.session,
        method: "GET",
        responseSchema: AccountSessionViewSchema,
        signal: new AbortController().signal,
        fetcher: async () =>
          json(GUEST, { headers: { "content-length": String(API_MAX_RESPONSE_BYTES + 1) } }),
      }),
    ).rejects.toMatchObject({ failure: { kind: "invalid-response" } });
  });

  it("honours an already-aborted signal without calling fetch", async () => {
    const controller = new AbortController();
    controller.abort();
    const fetcher = vi.fn(async () => json(GUEST));
    await expect(
      requestAccount({
        path: ACCOUNT_API_PATHS.session,
        method: "GET",
        responseSchema: AccountSessionViewSchema,
        signal: controller.signal,
        fetcher,
      }),
    ).rejects.toMatchObject({ failure: { kind: "aborted" } });
    expect(fetcher).not.toHaveBeenCalled();
  });
});
