import { describe, expect, it, vi } from "vitest";

import { accountAccessEnabled } from "../src/account/availability.js";
import { createConfirmation } from "../src/account/confirmation.js";
import {
  EMPTY_RECOVERY_DISPLAY,
  hideRecoveryCodes,
  parseRecoveryCodes,
  RecoveryDisplayGuard,
  shouldClearRecovery,
} from "../src/account/recovery.js";
import {
  PasskeyCeremonyError,
  toAuthenticationWire,
  toRegistrationWire,
} from "../src/account/webauthn.js";
import {
  assertWalletMessage,
  injectedProvider,
  isWalletCancelled,
  openWalletSession,
  personalSign,
  utf8ToHex,
  WalletError,
  type Eip1193Provider,
} from "../src/account/wallet-provider.js";

const B64 = "YWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWE";

describe("account availability", () => {
  it("enables only for the exact true value", () => {
    for (const value of [undefined, false, "false", "TRUE", "1", "yes"]) {
      expect(accountAccessEnabled(value)).toBe(false);
    }
    expect(accountAccessEnabled(true)).toBe(true);
    expect(accountAccessEnabled("true")).toBe(true);
  });
});

describe("recovery code display", () => {
  const codes = ["a", "b", "c", "d", "e", "f", "g", "h"];

  it("parses exactly eight codes and returns empty otherwise", () => {
    expect(parseRecoveryCodes({ codes })).toEqual({ codes, visible: true });
    expect(parseRecoveryCodes({ codes: codes.slice(0, 7) })).toEqual(EMPTY_RECOVERY_DISPLAY);
    expect(parseRecoveryCodes({ codes, extra: true })).toEqual(EMPTY_RECOVERY_DISPLAY);
    expect(parseRecoveryCodes(null)).toEqual(EMPTY_RECOVERY_DISPLAY);
  });

  it("clears on every required lifecycle event", () => {
    for (const event of ["pagehide", "logout", "navigation", "unmount"] as const) {
      expect(shouldClearRecovery(event, "visible")).toBe(true);
    }
    expect(shouldClearRecovery("visibility-hidden", "hidden")).toBe(true);
    expect(shouldClearRecovery("visibility-hidden", "visible")).toBe(false);
    expect(hideRecoveryCodes()).toEqual(EMPTY_RECOVERY_DISPLAY);
  });
});

describe("webauthn wire adapters", () => {
  it("omits a null userHandle and nullable attachment", () => {
    const wire = toAuthenticationWire({
      id: "abc",
      rawId: "abc",
      type: "public-key",
      response: {
        clientDataJSON: B64,
        authenticatorData: B64,
        signature: B64,
        userHandle: null,
      },
      clientExtensionResults: {},
      authenticatorAttachment: null,
    });
    expect("userHandle" in wire.response).toBe(false);
    expect("authenticatorAttachment" in wire).toBe(false);
  });

  it("drops unknown extensions and rejects malformed input", () => {
    const wire = toRegistrationWire({
      id: "abc",
      rawId: "abc",
      type: "public-key",
      response: { clientDataJSON: B64, attestationObject: B64 },
      clientExtensionResults: { credProps: { rk: true }, unknown: { x: 1 } },
    });
    expect(wire.clientExtensionResults).toEqual({ credProps: { rk: true } });
    expect(() => toRegistrationWire({ id: "abc" })).toThrow(PasskeyCeremonyError);
    expect(() => toRegistrationWire({ id: "abc", rawId: "abc", type: "public-key", response: { clientDataJSON: "", attestationObject: B64 } })).toThrow(PasskeyCeremonyError);
  });
});

describe("wallet provider boundary", () => {
  function provider(overrides: Partial<Eip1193Provider> = {}): Eip1193Provider {
    return {
      request: vi.fn(async ({ method }: { method: string }) => {
        if (method === "eth_requestAccounts" || method === "eth_accounts") {
          return ["0xA0Cf798816D4b9b9866b5330EEa46a18382f251e"];
        }
        if (method === "eth_chainId") return "0x4cef52";
        if (method === "personal_sign") return `0x${"ab".repeat(65)}`;
        throw new Error("unexpected method");
      }),
      ...overrides,
    };
  }

  it("exposes no provider when none is injected", () => {
    const globalWith = globalThis as { ethereum?: unknown };
    const previous = globalWith.ethereum;
    delete globalWith.ethereum;
    expect(injectedProvider()).toBeNull();
    if (previous !== undefined) globalWith.ethereum = previous;
  });

  it("requests only account access and chain before signing", async () => {
    const p = provider();
    const session = await openWalletSession(p);
    expect(session.address).toBe("0xA0Cf798816D4b9b9866b5330EEa46a18382f251e");
    const methods = (p.request as ReturnType<typeof vi.fn>).mock.calls.map(
      (call) => (call[0] as { method: string }).method,
    );
    expect(methods).toEqual(["eth_requestAccounts", "eth_chainId"]);
    session.abort();
  });

  it("rejects a wrong chain and never signs", async () => {
    const p = provider({
      request: vi.fn(async ({ method }: { method: string }) => {
        if (method === "eth_requestAccounts" || method === "eth_accounts") {
          return ["0xA0Cf798816D4b9b9866b5330EEa46a18382f251e"];
        }
        if (method === "eth_chainId") return "0x1";
        return `0x${"ab".repeat(65)}`;
      }),
    });
    await expect(openWalletSession(p)).rejects.toMatchObject({ failure: "wrong-chain" });
  });

  it("hex-encodes UTF-8 message bytes and passes the selected address", async () => {
    const request = vi.fn(async ({ method }: { method: string }) => {
      if (method === "eth_chainId") return "0x4cef52";
      if (method === "eth_accounts") return ["0xA0Cf798816D4b9b9866b5330EEa46a18382f251e"];
      return `0x${"ab".repeat(65)}`;
    });
    const signature = await personalSign({ request }, {
      message: "é",
      address: "0xA0Cf798816D4b9b9866b5330EEa46a18382f251e",
    });
    expect(signature).toBe(`0x${"ab".repeat(65)}`);
    expect(request).toHaveBeenLastCalledWith({
      method: "personal_sign",
      params: ["0xc3a9", "0xA0Cf798816D4b9b9866b5330EEa46a18382f251e"],
    });
  });

  it("rejects an account change between connect and sign", async () => {
    const request = vi.fn(async ({ method }: { method: string }) => {
      if (method === "eth_chainId") return "0x4cef52";
      if (method === "eth_accounts") return ["0x1111111111111111111111111111111111111111"];
      return `0x${"ab".repeat(65)}`;
    });
    await expect(
      personalSign({ request }, {
        message: "x",
        address: "0xA0Cf798816D4b9b9866b5330EEa46a18382f251e",
      }),
    ).rejects.toMatchObject({ failure: "changed" });
  });

  it("maps a rejected personal_sign to a safe rejection", async () => {
    const request = vi.fn(async ({ method }: { method: string }) => {
      if (method === "eth_chainId") return "0x4cef52";
      if (method === "eth_accounts") return ["0xA0Cf798816D4b9b9866b5330EEa46a18382f251e"];
      throw new Error("PRIVATE_CANARY");
    });
    await expect(
      personalSign({ request }, {
        message: "x",
        address: "0xA0Cf798816D4b9b9866b5330EEa46a18382f251e",
      }),
    ).rejects.toMatchObject({ failure: "rejected" });
  });

  it("rejects a wrong-origin message before signing", () => {
    const message = [
      "http://evil.example wants you to sign in with your Ethereum account:",
      "0xA0Cf798816D4b9b9866b5330EEa46a18382f251e",
      "",
      "Sign in to OpenArc. This does not authorize payments.",
      "",
      "URI: http://evil.example/account",
      "Version: 1",
      "Chain ID: 5042002",
      "Nonce: 0123456789abcdef0123456789abcdef",
      "Issued At: 2026-01-01T00:00:00.000Z",
      "Expiration Time: 2026-01-01T00:05:00.000Z",
    ].join("\n");
    expect(() => assertWalletMessage(message, "http://localhost:5201", "0xA0Cf798816D4b9b9866b5330EEa46a18382f251e")).toThrow(WalletError);
  });
});

describe("confirmation gate", () => {
  it("resolves true only on confirm and false on cancel", async () => {
    const confirmed = createConfirmation("payload");
    confirmed.confirm();
    await expect(confirmed.promise).resolves.toBe(true);
    expect(confirmed.value).toBe("payload");
    const cancelled = createConfirmation("payload");
    cancelled.cancel();
    await expect(cancelled.promise).resolves.toBe(false);
  });

  it("ignores a duplicate settle", async () => {
    const gate = createConfirmation(1);
    gate.confirm();
    gate.cancel();
    await expect(gate.promise).resolves.toBe(true);
  });
});

describe("utf8ToHex", () => {
  it("encodes ASCII and multibyte code points without Node Buffer", () => {
    expect(utf8ToHex("A")).toBe("0x41");
    expect(utf8ToHex("é")).toBe("0xc3a9");
  });
});

describe("wallet session cancellation", () => {
  const ADDRESS = "0xA0Cf798816D4b9b9866b5330EEa46a18382f251e";
  const SIGNATURE = `0x${"ab".repeat(65)}`;

  function listeningProvider(overrides: Partial<Eip1193Provider> = {}) {
    const listeners = new Map<string, Set<(...args: unknown[]) => void>>();
    const provider: Eip1193Provider = {
      request: vi.fn(async ({ method }: { method: string }) => {
        if (method === "eth_requestAccounts" || method === "eth_accounts") return [ADDRESS];
        if (method === "eth_chainId") return "0x4cef52";
        if (method === "personal_sign") return SIGNATURE;
        throw new Error("unexpected method");
      }),
      on: vi.fn((event: string, listener: (...args: unknown[]) => void) => {
        const set = listeners.get(event) ?? new Set();
        set.add(listener);
        listeners.set(event, set);
      }),
      removeListener: vi.fn((event: string, listener: (...args: unknown[]) => void) => {
        listeners.get(event)?.delete(listener);
      }),
      ...overrides,
    };
    const emit = (event: string) => {
      for (const listener of listeners.get(event) ?? []) listener();
    };
    const count = () => [...listeners.values()].reduce((total, set) => total + set.size, 0);
    return { provider, emit, count };
  }

  it("exposes a wallet-session signal aborted by account/chain/disconnect events", async () => {
    const { provider, emit } = listeningProvider();
    const session = await openWalletSession(provider);
    expect(session.signal.aborted).toBe(false);
    expect(isWalletCancelled([session.signal])).toBe(false);
    emit("accountsChanged");
    expect(session.signal.aborted).toBe(true);
    expect(isWalletCancelled([session.signal])).toBe(true);
    session.abort();
  });

  it("disposes listeners on abort and on a rejected account request", async () => {
    const ok = listeningProvider();
    const session = await openWalletSession(ok.provider);
    expect(ok.count()).toBe(3);
    session.abort();
    expect(ok.count()).toBe(0);

    const rejected = listeningProvider({
      request: vi.fn(async () => {
        throw new Error("PRIVATE_CANARY");
      }),
    });
    await expect(openWalletSession(rejected.provider)).rejects.toMatchObject({ failure: "rejected" });
    expect(rejected.count()).toBe(0);
  });

  it("disposes listeners on a wrong-chain failure", async () => {
    const wrongChain = listeningProvider({
      request: vi.fn(async ({ method }: { method: string }) => {
        if (method === "eth_requestAccounts") return [ADDRESS];
        if (method === "eth_chainId") return "0x1";
        return SIGNATURE;
      }),
    });
    await expect(openWalletSession(wrongChain.provider)).rejects.toMatchObject({ failure: "wrong-chain" });
    expect(wrongChain.count()).toBe(0);
  });

  it("prevents signing when the wallet session is cancelled while confirmation waits", async () => {
    const { provider, emit } = listeningProvider();
    const session = await openWalletSession(provider);
    // The confirmation gate is held open, then a wallet event cancels it.
    emit("disconnect");
    await expect(
      personalSign(provider, {
        message: "sign me",
        address: ADDRESS,
        walletSignal: session.signal,
      }),
    ).rejects.toMatchObject({ failure: "changed" });
    const calls = (provider.request as ReturnType<typeof vi.fn>).mock.calls.map(
      (call) => (call[0] as { method: string }).method,
    );
    expect(calls).not.toContain("personal_sign");
    session.abort();
  });

  it("prevents success when a wallet event arrives during personal_sign", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { provider, emit } = listeningProvider({
      request: vi.fn(async ({ method }: { method: string }) => {
        if (method === "eth_requestAccounts" || method === "eth_accounts") return [ADDRESS];
        if (method === "eth_chainId") return "0x4cef52";
        if (method === "personal_sign") {
          await gate;
          return SIGNATURE;
        }
        throw new Error("unexpected method");
      }),
    });
    const session = await openWalletSession(provider);
    const signing = personalSign(provider, {
      message: "sign me",
      address: ADDRESS,
      walletSignal: session.signal,
    });
    emit("accountsChanged");
    release();
    await expect(signing).rejects.toMatchObject({ failure: "changed" });
    session.abort();
  });

  it("does not self-cancel on the initial []->[selected] accountsChanged", async () => {
    const listeners = new Map<string, Set<(...args: unknown[]) => void>>();
    const emit = (event: string) => {
      for (const listener of listeners.get(event) ?? []) listener();
    };
    let address = "0x1111111111111111111111111111111111111111";
    const provider: Eip1193Provider = {
      request: vi.fn(async ({ method }: { method: string }) => {
        if (method === "eth_requestAccounts") {
          // A normal first grant notifies []->[selected] while pending.
          emit("accountsChanged");
          return [address];
        }
        if (method === "eth_accounts") return [address];
        if (method === "eth_chainId") return "0x4cef52";
        if (method === "personal_sign") return SIGNATURE;
        throw new Error("unexpected method");
      }),
      on: vi.fn((event: string, listener: (...args: unknown[]) => void) => {
        const set = listeners.get(event) ?? new Set();
        set.add(listener);
        listeners.set(event, set);
      }),
      removeListener: vi.fn((event: string, listener: (...args: unknown[]) => void) => {
        listeners.get(event)?.delete(listener);
      }),
    };
    const session = await openWalletSession(provider);
    expect(session.address).toBe(address);
    expect(session.signal.aborted).toBe(false);
    // The recheck read the settled account and the boundary is now armed.
    const methods = (provider.request as ReturnType<typeof vi.fn>).mock.calls.map(
      (call) => (call[0] as { method: string }).method,
    );
    expect(methods).toEqual(["eth_requestAccounts", "eth_chainId", "eth_accounts"]);
    // A genuine later change is still fatal.
    address = "0x2222222222222222222222222222222222222222";
    emit("accountsChanged");
    expect(session.signal.aborted).toBe(true);
    session.abort();
  });

  it("rejects a genuinely different account selected during the request", async () => {
    const listeners = new Map<string, Set<(...args: unknown[]) => void>>();
    const provider: Eip1193Provider = {
      request: vi.fn(async ({ method }: { method: string }) => {
        if (method === "eth_requestAccounts") {
          for (const listener of listeners.get("accountsChanged") ?? []) listener();
          return ["0x1111111111111111111111111111111111111111"];
        }
        if (method === "eth_accounts") return ["0x2222222222222222222222222222222222222222"];
        if (method === "eth_chainId") return "0x4cef52";
        return SIGNATURE;
      }),
      on: vi.fn((event: string, listener: (...args: unknown[]) => void) => {
        const set = listeners.get(event) ?? new Set();
        set.add(listener);
        listeners.set(event, set);
      }),
      removeListener: vi.fn((event: string, listener: (...args: unknown[]) => void) => {
        listeners.get(event)?.delete(listener);
      }),
    };
    await expect(openWalletSession(provider)).rejects.toMatchObject({ failure: "changed" });
    const total = [...listeners.values()].reduce((sum, set) => sum + set.size, 0);
    expect(total).toBe(0);
  });

  it("rejects a disconnect observed during the account request", async () => {
    const listeners = new Map<string, Set<(...args: unknown[]) => void>>();
    const provider: Eip1193Provider = {
      request: vi.fn(async ({ method }: { method: string }) => {
        if (method === "eth_requestAccounts") {
          for (const listener of listeners.get("disconnect") ?? []) listener();
          return ["0x1111111111111111111111111111111111111111"];
        }
        if (method === "eth_chainId") return "0x4cef52";
        return SIGNATURE;
      }),
      on: vi.fn((event: string, listener: (...args: unknown[]) => void) => {
        const set = listeners.get(event) ?? new Set();
        set.add(listener);
        listeners.set(event, set);
      }),
      removeListener: vi.fn((event: string, listener: (...args: unknown[]) => void) => {
        listeners.get(event)?.delete(listener);
      }),
    };
    await expect(openWalletSession(provider)).rejects.toMatchObject({ failure: "changed" });
    const total = [...listeners.values()].reduce((sum, set) => sum + set.size, 0);
    expect(total).toBe(0);
  });

  it("aborts when a disconnect arrives during a deferred eth_accounts handoff", async () => {
    const listeners = new Map<string, Set<(...args: unknown[]) => void>>();
    const emit = (event: string) => {
      for (const listener of listeners.get(event) ?? []) listener();
    };
    let releaseAccounts!: (accounts: string[]) => void;
    const deferredAccounts = new Promise<string[]>((resolve) => {
      releaseAccounts = resolve;
    });
    const provider: Eip1193Provider = {
      request: vi.fn(async ({ method }: { method: string }) => {
        if (method === "eth_requestAccounts") {
          // The normal first grant records a change but must not abort yet.
          emit("accountsChanged");
          return ["0x1111111111111111111111111111111111111111"];
        }
        if (method === "eth_accounts") return deferredAccounts;
        if (method === "eth_chainId") return "0x4cef52";
        return SIGNATURE;
      }),
      on: vi.fn((event: string, listener: (...args: unknown[]) => void) => {
        const set = listeners.get(event) ?? new Set();
        set.add(listener);
        listeners.set(event, set);
      }),
      removeListener: vi.fn((event: string, listener: (...args: unknown[]) => void) => {
        listeners.get(event)?.delete(listener);
      }),
    };
    const session = openWalletSession(provider);
    // The handoff recheck is pending; a real disconnect must abort it.
    await vi.waitFor(() => {
      expect((provider.request as ReturnType<typeof vi.fn>).mock.calls.some(
        (call) => (call[0] as { method: string }).method === "eth_accounts",
      )).toBe(true);
    });
    emit("disconnect");
    releaseAccounts(["0x1111111111111111111111111111111111111111"]);
    await expect(session).rejects.toMatchObject({ failure: "changed" });
    const total = [...listeners.values()].reduce((sum, set) => sum + set.size, 0);
    expect(total).toBe(0);
  });

  it("rejects a deferred eth_accounts handoff that settles on another account", async () => {
    const listeners = new Map<string, Set<(...args: unknown[]) => void>>();
    const provider: Eip1193Provider = {
      request: vi.fn(async ({ method }: { method: string }) => {
        if (method === "eth_requestAccounts") {
          for (const listener of listeners.get("accountsChanged") ?? []) listener();
          return ["0x1111111111111111111111111111111111111111"];
        }
        if (method === "eth_accounts") {
          await new Promise((resolve) => setTimeout(resolve, 10));
          return ["0x2222222222222222222222222222222222222222"];
        }
        if (method === "eth_chainId") return "0x4cef52";
        return SIGNATURE;
      }),
      on: vi.fn((event: string, listener: (...args: unknown[]) => void) => {
        const set = listeners.get(event) ?? new Set();
        set.add(listener);
        listeners.set(event, set);
      }),
      removeListener: vi.fn((event: string, listener: (...args: unknown[]) => void) => {
        listeners.get(event)?.delete(listener);
      }),
    };
    await expect(openWalletSession(provider)).rejects.toMatchObject({ failure: "changed" });
    const total = [...listeners.values()].reduce((sum, set) => sum + set.size, 0);
    expect(total).toBe(0);
  });

  it("keeps the boundary armed after a matching deferred eth_accounts handoff", async () => {
    const listeners = new Map<string, Set<(...args: unknown[]) => void>>();
    const emit = (event: string) => {
      for (const listener of listeners.get(event) ?? []) listener();
    };
    const address = "0x1111111111111111111111111111111111111111";
    const provider: Eip1193Provider = {
      request: vi.fn(async ({ method }: { method: string }) => {
        if (method === "eth_requestAccounts") {
          emit("accountsChanged");
          return [address];
        }
        if (method === "eth_accounts") {
          await new Promise((resolve) => setTimeout(resolve, 10));
          return [address];
        }
        if (method === "eth_chainId") return "0x4cef52";
        return SIGNATURE;
      }),
      on: vi.fn((event: string, listener: (...args: unknown[]) => void) => {
        const set = listeners.get(event) ?? new Set();
        set.add(listener);
        listeners.set(event, set);
      }),
      removeListener: vi.fn((event: string, listener: (...args: unknown[]) => void) => {
        listeners.get(event)?.delete(listener);
      }),
    };
    const session = await openWalletSession(provider);
    expect(session.address).toBe(address);
    expect(session.signal.aborted).toBe(false);
    // The final boundary is still armed after the handoff.
    emit("accountsChanged");
    expect(session.signal.aborted).toBe(true);
    session.abort();
  });
});

describe("recovery display generation", () => {
  const codes = ["a", "b", "c", "d", "e", "f", "g", "h"];

  it("discards a late response after a hide and a later show", () => {
    const guard = new RecoveryDisplayGuard();
    const token = guard.start();
    const cleared = guard.clear();
    expect(cleared).toEqual(EMPTY_RECOVERY_DISPLAY);
    // The tab becomes visible again, but the old in-flight result is stale.
    expect(guard.apply(token, { codes }, EMPTY_RECOVERY_DISPLAY)).toEqual(EMPTY_RECOVERY_DISPLAY);
    const fresh = guard.start();
    expect(guard.apply(fresh, { codes }, EMPTY_RECOVERY_DISPLAY)).toEqual({ codes, visible: true });
  });

  it("clears visible codes immediately when logout starts, even if the response is lost", () => {
    const guard = new RecoveryDisplayGuard();
    const token = guard.start();
    const visible = guard.apply(token, { codes }, EMPTY_RECOVERY_DISPLAY);
    expect(visible.visible).toBe(true);
    // Logout begins: clear before any server response, then a late success
    // from the lost request must not repopulate the display.
    expect(guard.clear()).toEqual(EMPTY_RECOVERY_DISPLAY);
    expect(guard.apply(token, { codes }, EMPTY_RECOVERY_DISPLAY)).toEqual(EMPTY_RECOVERY_DISPLAY);
  });

  it("invalidates on every lifecycle event and never shows malformed codes", () => {
    const guard = new RecoveryDisplayGuard();
    for (const event of ["pagehide", "navigation", "unmount", "logout"] as const) {
      expect(shouldClearRecovery(event, "visible")).toBe(true);
    }
    const token = guard.start();
    guard.invalidate();
    expect(guard.apply(token, { codes: codes.slice(0, 7) }, EMPTY_RECOVERY_DISPLAY)).toEqual(EMPTY_RECOVERY_DISPLAY);
    const fresh = guard.start();
    expect(guard.apply(fresh, { codes: codes.slice(0, 7) }, EMPTY_RECOVERY_DISPLAY)).toEqual(EMPTY_RECOVERY_DISPLAY);
  });
});
