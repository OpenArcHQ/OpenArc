import {
  AccountPasskeyRegisterVerifyRequestSchema,
  AccountSessionResponseSchema,
  COMMERCE_API_ERRORS,
  COMMERCE_API_SCHEMA_VERSION,
  AccountBootstrapResponseSchema,
  AccountEmptyRequestSchema,
} from "@openarc/shared";
import { describe, expect, it, vi } from "vitest";

import { ACCOUNT_API_PATHS } from "../src/account/auth-client.js";
import { requestAccount } from "../src/account/auth-client.js";
import {
  AccountFlowController,
  type AccountOperationScope,
} from "../src/account/flow-controller.js";
import { hasUsableCsrf, initialAccountState } from "../src/account/session-store.js";

const ACCOUNT_A = "openarc:account:aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa";
const ACCOUNT_B = "openarc:account:bbbbbbbb-bbbb-7bbb-8bbb-bbbbbbbbbbbb";

function signedIn(accountId: string) {
  return {
    signedIn: true as const,
    accountId,
    method: "passkey" as const,
    expiresAt: "2026-01-02T00:00:00.000Z",
  };
}

function bootstrapWith(csrf: string, session: unknown): Response {
  return json({
    ok: true,
    data: { csrfToken: csrf, session },
    meta: META,
  });
}

const META = {
  schemaVersion: COMMERCE_API_SCHEMA_VERSION,
  requestId: "018f47a2-3b4c-7def-8123-456789abcdef",
  buildSha: "0123456789abcdef0123456789abcdef01234567",
};

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function bootstrapResponse(csrf: string, signedIn = false): Response {
  return json({
    ok: true,
    data: { csrfToken: csrf, session: signedIn ? { signedIn: false } : { signedIn: false } },
    meta: META,
  });
}

describe("account flow controller", () => {
  it("bootstraps exactly once per mutation and adopts the fresh token", async () => {
    const calls: string[] = [];
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input);
      calls.push(path);
      if (path === ACCOUNT_API_PATHS.bootstrap) return bootstrapResponse("csrf-1");
      return json({
        ok: true,
        data: {
          csrfToken: "csrf-2",
          session: {
            signedIn: true,
            accountId: "openarc:account:018f47a2-3b4c-7def-8123-456789abcdef",
            method: "passkey",
            expiresAt: "2026-01-02T00:00:00.000Z",
          },
        },
        meta: META,
      });
    });
    const controller = new AccountFlowController({ fetcher: fetcher as unknown as typeof fetch });
    const data = await controller.mutate(async ({ csrfToken, signal, fetcher: injected }) => {
      expect(csrfToken).toBe("csrf-1");
      return requestAccount({
        path: ACCOUNT_API_PATHS.registerVerify,
        method: "POST",
        requestSchema: AccountPasskeyRegisterVerifyRequestSchema,
        responseSchema: AccountSessionResponseSchema,
        body: {
          flowId: "abcdefghijklmnop",
          response: {
            id: "abc",
            rawId: "abc",
            type: "public-key",
            response: {
              clientDataJSON: "YQ",
              attestationObject: "YQ",
            },
          },
        },
        csrfToken,
        signal,
        ...(injected === undefined ? {} : { fetcher: injected }),
      });
    });
    expect(calls).toEqual([ACCOUNT_API_PATHS.bootstrap, ACCOUNT_API_PATHS.registerVerify]);
    controller.adoptSessionResponse(data);
    expect(controller.state.status).toBe("signed-in");
    expect(controller.state.csrfToken).toBe("csrf-2");
    expect(controller.busy).toBe(false);
  });

  it("does not send a mutation when bootstrap fails", async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) === ACCOUNT_API_PATHS.bootstrap) {
        return json(
          {
            ok: false,
            error: {
              code: "FEATURE_DISABLED",
              message: COMMERCE_API_ERRORS.FEATURE_DISABLED.message,
              retryable: false,
            },
            meta: META,
          },
          503,
        );
      }
      return bootstrapResponse("csrf-should-not-be-used");
    });
    const controller = new AccountFlowController({ fetcher: fetcher as unknown as typeof fetch });
    const work = vi.fn(async () => undefined);
    await expect(controller.mutate(work)).rejects.toBeDefined();
    expect(work).not.toHaveBeenCalled();
  });

  it("disables concurrent mutations and suppresses a stale response after cancel", async () => {
    const fetcher = vi.fn(async () => bootstrapResponse("csrf-1"));
    const controller = new AccountFlowController({ fetcher: fetcher as unknown as typeof fetch });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = controller.mutate(async () => {
      await gate;
      return "late";
    });
    await expect(controller.mutate(async () => "second")).rejects.toBeDefined();
    controller.cancel();
    release();
    await expect(first).rejects.toBeDefined();
    expect(controller.busy).toBe(false);
  });

  it("has no usable CSRF before a bootstrap and no persistence side effects", () => {
    const controller = new AccountFlowController();
    expect(hasUsableCsrf(controller.state)).toBe(false);
    expect(controller.state).toEqual(initialAccountState());
    expect(controller.reset()).toBeUndefined();
  });

  it("keeps the request schema allowlist strict for bootstrap", () => {
    expect(AccountBootstrapResponseSchema.safeParse({ csrfToken: "x", session: { signedIn: false }, extra: 1 }).success).toBe(false);
    expect(AccountEmptyRequestSchema.safeParse({ extra: 1 }).success).toBe(false);
  });
});

describe("account-bound invariant", () => {
  it("aborts a stale A action when bootstrap resolves a different account B", async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL) =>
      String(input) === ACCOUNT_API_PATHS.bootstrap
        ? bootstrapWith("csrf-b", signedIn(ACCOUNT_B))
        : bootstrapWith("csrf-b", signedIn(ACCOUNT_B)),
    );
    const controller = new AccountFlowController({ fetcher: fetcher as unknown as typeof fetch });
    controller.adoptSessionResponse({ csrfToken: "csrf-a", session: signedIn(ACCOUNT_A) });
    const bound = controller.captureAccountBound();
    expect(bound.accountId).toBe(ACCOUNT_A);
    const work = vi.fn(async () => "should-not-run");
    await expect(controller.mutate(work, { accountBound: bound })).rejects.toMatchObject({
      failure: { kind: "account-changed" },
    });
    expect(work).not.toHaveBeenCalled();
    // Displayed state synchronizes to the actual session B.
    expect(controller.state.session).toMatchObject({ signedIn: true, accountId: ACCOUNT_B });
  });

  it("aborts a stale A action when bootstrap resolves a guest", async () => {
    const fetcher = vi.fn(async () =>
      bootstrapWith("csrf-guest", { signedIn: false }),
    );
    const controller = new AccountFlowController({ fetcher: fetcher as unknown as typeof fetch });
    controller.adoptSessionResponse({ csrfToken: "csrf-a", session: signedIn(ACCOUNT_A) });
    const bound = controller.captureAccountBound();
    const work = vi.fn(async () => "should-not-run");
    await expect(controller.mutate(work, { accountBound: bound })).rejects.toMatchObject({
      failure: { kind: "account-changed" },
    });
    expect(work).not.toHaveBeenCalled();
    expect(controller.state.session).toEqual({ signedIn: false });
  });

  it("runs the action when bootstrap matches the intended account", async () => {
    const fetcher = vi.fn(async () =>
      bootstrapWith("csrf-a2", signedIn(ACCOUNT_A)),
    );
    const controller = new AccountFlowController({ fetcher: fetcher as unknown as typeof fetch });
    controller.adoptSessionResponse({ csrfToken: "csrf-a", session: signedIn(ACCOUNT_A) });
    const bound = controller.captureAccountBound();
    const work = vi.fn(async ({ csrfToken }: { csrfToken: string }) => {
      expect(csrfToken).toBe("csrf-a2");
      return "done";
    });
    await expect(controller.mutate(work, { accountBound: bound })).resolves.toBe("done");
    expect(work).toHaveBeenCalledTimes(1);
  });

  it("rejects a bound action captured before a session generation change", async () => {
    const fetcher = vi.fn(async () =>
      bootstrapWith("csrf-a2", signedIn(ACCOUNT_A)),
    );
    const controller = new AccountFlowController({ fetcher: fetcher as unknown as typeof fetch });
    controller.adoptSessionResponse({ csrfToken: "csrf-a", session: signedIn(ACCOUNT_A) });
    const bound = controller.captureAccountBound();
    controller.cancel();
    const work = vi.fn(async () => "should-not-run");
    await expect(controller.mutate(work, { accountBound: bound })).rejects.toBeDefined();
    expect(work).not.toHaveBeenCalled();
  });
});

describe("one session generation", () => {
  function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  }

  it("discards a delayed guest GET that completes after a login mutation starts", async () => {
    const read = deferred<Response>();
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input);
      if (path === ACCOUNT_API_PATHS.session) return read.promise;
      if (path === ACCOUNT_API_PATHS.bootstrap) return bootstrapWith("csrf-a", signedIn(ACCOUNT_A));
      return json({
        ok: true,
        data: { csrfToken: "csrf-login", session: signedIn(ACCOUNT_A) },
        meta: META,
      });
    });
    const controller = new AccountFlowController({ fetcher: fetcher as unknown as typeof fetch });
    const stale = controller.refreshSession();
    // A mutation starts and invalidates the in-flight read generation.
    await controller.mutate(async () => "logged-in");
    controller.adoptSessionResponse({ csrfToken: "csrf-login", session: signedIn(ACCOUNT_A) });
    read.resolve(
      json({ ok: true, data: { session: { signedIn: false } }, meta: META }),
    );
    await expect(stale).rejects.toMatchObject({ failure: { kind: "aborted" } });
    // The late guest GET never overwrites the completed login.
    expect(controller.state.session).toMatchObject({ signedIn: true, accountId: ACCOUNT_A });
  });

  it("discards an old authenticated GET that completes after a logout", async () => {
    const read = deferred<Response>();
    let reads = 0;
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input);
      if (path === ACCOUNT_API_PATHS.session) {
        reads += 1;
        if (reads === 1) return read.promise;
        return json({ ok: true, data: { session: { signedIn: false } }, meta: META });
      }
      if (path === ACCOUNT_API_PATHS.bootstrap) return bootstrapWith("csrf-a", signedIn(ACCOUNT_A));
      return json({
        ok: true,
        data: { session: { signedIn: false } },
        meta: META,
      });
    });
    const controller = new AccountFlowController({ fetcher: fetcher as unknown as typeof fetch });
    controller.adoptSessionResponse({ csrfToken: "csrf-a", session: signedIn(ACCOUNT_A) });
    const stale = controller.refreshSession();
    await controller.mutate(async () => "logged-out");
    controller.reset();
    read.resolve(json({ ok: true, data: { session: signedIn(ACCOUNT_A) }, meta: META }));
    await expect(stale).rejects.toMatchObject({ failure: { kind: "aborted" } });
    expect(controller.state.session).toEqual({ signedIn: false });
  });

  it("cancels a stale bootstrap so its state is never applied", async () => {
    const bootstrapRead = deferred<Response>();
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input);
      if (path === ACCOUNT_API_PATHS.bootstrap) return bootstrapRead.promise;
      return json({ ok: true, data: { session: { signedIn: false } }, meta: META });
    });
    const controller = new AccountFlowController({ fetcher: fetcher as unknown as typeof fetch });
    const pending = controller.mutate(async () => "should-not-run");
    controller.cancel();
    bootstrapRead.resolve(bootstrapWith("csrf-late", signedIn(ACCOUNT_A)));
    await expect(pending).rejects.toBeDefined();
    expect(controller.state).toEqual(initialAccountState());
  });

  it("performs adoption inside delayed work without applying it after reset", async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL) =>
      String(input) === ACCOUNT_API_PATHS.bootstrap
        ? bootstrapWith("csrf-a", signedIn(ACCOUNT_A))
        : json({ ok: true, data: { session: { signedIn: false } }, meta: META }),
    );
    const controller = new AccountFlowController({ fetcher: fetcher as unknown as typeof fetch });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started = false;
    let adoptedResult: boolean | undefined;
    const pending = controller.mutate(async ({ adopt }) => {
      started = true;
      await gate;
      // The work really tries to adopt after the reset, not merely returns late.
      adoptedResult = adopt({ csrfToken: "csrf-late", session: signedIn(ACCOUNT_B) });
      return "late";
    });
    await vi.waitFor(() => expect(started).toBe(true));
    controller.reset();
    release();
    await expect(pending).rejects.toBeDefined();
    expect(adoptedResult).toBe(false);
    expect(controller.state).toEqual(initialAccountState());
    expect(controller.busy).toBe(false);
  });

  it("ignores direct adoption presented with a stale operation scope", async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL) =>
      String(input) === ACCOUNT_API_PATHS.bootstrap
        ? bootstrapWith("csrf-a", signedIn(ACCOUNT_A))
        : json({ ok: true, data: { session: { signedIn: false } }, meta: META }),
    );
    const controller = new AccountFlowController({ fetcher: fetcher as unknown as typeof fetch });
    let staleScope: AccountOperationScope | undefined;
    await controller.mutate(async ({ scope }) => {
      staleScope = scope;
      return "ok";
    });
    controller.reset();
    const applied = controller.adoptSessionResponse(
      { csrfToken: "csrf-late", session: signedIn(ACCOUNT_B) },
      staleScope,
    );
    expect(applied).toBe(false);
    expect(controller.state).toEqual(initialAccountState());
  });

  it("does not let a superseded operation clear a newer operation's busy state", async () => {
    let releaseFirst!: () => void;
    let releaseSecond!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const secondGate = new Promise<void>((resolve) => {
      releaseSecond = resolve;
    });
    const fetcher = vi.fn(async (input: RequestInfo | URL) =>
      String(input) === ACCOUNT_API_PATHS.bootstrap
        ? bootstrapWith("csrf-a", signedIn(ACCOUNT_A))
        : json({ ok: true, data: { session: { signedIn: false } }, meta: META }),
    );
    const controller = new AccountFlowController({ fetcher: fetcher as unknown as typeof fetch });
    let firstStarted = false;
    const first = controller.mutate(async () => {
      firstStarted = true;
      await firstGate;
      return "first";
    });
    await vi.waitFor(() => expect(firstStarted).toBe(true));
    controller.cancel();
    const second = controller.mutate(async () => {
      await secondGate;
      return "second";
    });
    expect(controller.busy).toBe(true);
    releaseFirst();
    await expect(first).rejects.toBeDefined();
    // The stale first operation must not clear the second's busy flag.
    expect(controller.busy).toBe(true);
    releaseSecond();
    await expect(second).resolves.toBe("second");
    expect(controller.busy).toBe(false);
  });
});
