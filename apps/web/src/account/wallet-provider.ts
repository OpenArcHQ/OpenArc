import { validateWalletMessage, WalletMessageError } from "./siwe.js";

/**
 * Minimal injected EIP-1193 wallet boundary.
 *
 * Only the four read/sign methods this login needs are ever requested:
 * `eth_requestAccounts`, `eth_accounts`, `eth_chainId` and `personal_sign`.
 * There is no wallet dependency, auto-discovery, network switch/add,
 * transaction, typed-data, `eth_sendTransaction` or `wallet_sendCalls`.
 */

export const WALLET_CHAIN_ID_HEX = "0x4cef52";
const HEX_ADDRESS = /^0x[0-9a-fA-F]{40}$/u;

export interface Eip1193Provider {
  request(input: { method: string; params?: unknown[] }): Promise<unknown>;
  on?(event: string, listener: (...args: unknown[]) => void): void;
  removeListener?(event: string, listener: (...args: unknown[]) => void): void;
}

export type WalletFailure =
  | "no-provider"
  | "rejected"
  | "no-account"
  | "wrong-chain"
  | "changed"
  | "invalid-message";

export class WalletError extends Error {
  readonly failure: WalletFailure;

  constructor(failure: WalletFailure) {
    super(failure);
    this.name = "WalletError";
    this.failure = failure;
  }
}

/** Reads the injected provider; never triggers discovery or a network call. */
export function injectedProvider(): Eip1193Provider | null {
  const candidate = (globalThis as { ethereum?: unknown }).ethereum;
  if (
    typeof candidate !== "object" ||
    candidate === null ||
    typeof (candidate as { request?: unknown }).request !== "function"
  ) {
    return null;
  }
  return candidate as Eip1193Provider;
}

/** Browser-safe UTF-8 to `0x`-prefixed hex, with no Node Buffer dependency. */
export function utf8ToHex(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let hex = "";
  for (const byte of bytes) hex += byte.toString(16).padStart(2, "0");
  return `0x${hex}`;
}

function firstAccount(value: unknown): string {
  if (!Array.isArray(value)) throw new WalletError("no-account");
  const account = value[0];
  if (typeof account !== "string" || !HEX_ADDRESS.test(account)) {
    throw new WalletError("no-account");
  }
  return account;
}

async function safeRequest(
  provider: Eip1193Provider,
  method: string,
  params?: unknown[],
): Promise<unknown> {
  try {
    return await provider.request(params === undefined ? { method } : { method, params });
  } catch {
    throw new WalletError("rejected");
  }
}

/**
 * Explicit account access only. Must be called from a user gesture; it never
 * signs anything by itself.
 */
export async function requestWalletAccount(
  provider: Eip1193Provider,
): Promise<string> {
  const accounts = await safeRequest(provider, "eth_requestAccounts");
  return firstAccount(accounts);
}

export async function readWalletAccounts(
  provider: Eip1193Provider,
): Promise<string> {
  return firstAccount(await safeRequest(provider, "eth_accounts"));
}

async function assertChain(provider: Eip1193Provider): Promise<void> {
  const chain = await safeRequest(provider, "eth_chainId");
  if (typeof chain !== "string" || chain.toLowerCase() !== WALLET_CHAIN_ID_HEX) {
    throw new WalletError("wrong-chain");
  }
}

export interface WalletSession {
  address: string;
  /** Aborted by the user or by any account/chain/disconnect event. */
  readonly signal: AbortSignal;
  abort(): void;
}

/**
 * Opens a wallet session: explicit account access, then a chain assertion.
 *
 * A normal first grant emits `accountsChanged` from `[]` to the selected
 * address while `eth_requestAccounts` is pending; aborting on that would
 * self-cancel the first login. Events observed during the account request are
 * recorded while the final cancellation boundary is still disarmed. As soon as
 * the selected account is known, the final boundary is armed (while the
 * request-phase recorders remain registered) BEFORE the awaited address/chain
 * rechecks, so a change or disconnect during the `eth_accounts`/`chainId`
 * handoff aborts too. Each await is followed by an explicit abort check, and
 * all listeners are removed on every failure path.
 */
export async function openWalletSession(
  provider: Eip1193Provider,
): Promise<WalletSession> {
  const controller = new AbortController();
  let accountsChangedDuringRequest = false;
  let chainChangedDuringRequest = false;
  let disconnectedDuringRequest = false;
  const onAccountsDuringRequest = () => {
    accountsChangedDuringRequest = true;
  };
  const onChainDuringRequest = () => {
    chainChangedDuringRequest = true;
  };
  const onDisconnectDuringRequest = () => {
    disconnectedDuringRequest = true;
  };
  const requestEvents: Array<[string, (...args: unknown[]) => void]> = [
    ["accountsChanged", onAccountsDuringRequest],
    ["chainChanged", onChainDuringRequest],
    ["disconnect", onDisconnectDuringRequest],
  ];
  for (const [event, listener] of requestEvents) provider.on?.(event, listener);
  const removeRequestListeners = () => {
    for (const [event, listener] of requestEvents) {
      provider.removeListener?.(event, listener);
    }
  };
  const onEvent = () => controller.abort();
  const finalEvents = ["accountsChanged", "chainChanged", "disconnect"];
  const cleanupFinal = () => {
    for (const event of finalEvents) provider.removeListener?.(event, onEvent);
  };
  let address: string;
  try {
    address = await requestWalletAccount(provider);
  } catch (error) {
    // A rejected account request or chain failure must not leak listeners.
    removeRequestListeners();
    controller.abort();
    throw error;
  }
  // Arm the final boundary before the awaited rechecks and before removing
  // the request-phase recorders: an event during the handoff must abort.
  try {
    for (const event of finalEvents) provider.on?.(event, onEvent);
  } catch (error) {
    // A provider that fails to register a listener must not leak the others,
    // nor leave an unguarded session usable.
    cleanupFinal();
    removeRequestListeners();
    controller.abort();
    throw error;
  }
  try {
    await assertChain(provider);
    if (controller.signal.aborted) throw new WalletError("changed");
    // Recheck what the provider actually selected/now reports. A first
    // []->[selected] grant is expected; a genuinely different account, a
    // disconnect or a changed chain is not, and must stop before signing.
    if (disconnectedDuringRequest) {
      throw new WalletError("changed");
    }
    if (accountsChangedDuringRequest) {
      const current = await readWalletAccounts(provider);
      if (controller.signal.aborted) throw new WalletError("changed");
      if (current.toLowerCase() !== address.toLowerCase()) {
        throw new WalletError("changed");
      }
    }
    if (chainChangedDuringRequest) {
      await assertChain(provider);
      if (controller.signal.aborted) throw new WalletError("changed");
    }
  } catch (error) {
    removeRequestListeners();
    cleanupFinal();
    controller.abort();
    throw error;
  }
  removeRequestListeners();
  return {
    address,
    signal: controller.signal,
    abort: () => {
      cleanupFinal();
      controller.abort();
    },
  };
}

/**
 * Signs after explicit confirmation. The exact server message bytes are
 * hex-encoded UTF-8; the selected account is passed as the second parameter.
 * The selected account and chain are rechecked first.
 */
export async function personalSign(
  provider: Eip1193Provider,
  input: {
    message: string;
    address: string;
    signal?: AbortSignal;
    walletSignal?: AbortSignal;
  },
): Promise<string> {
  if (isAborted(input.signal) || isAborted(input.walletSignal)) {
    throw new WalletError("changed");
  }
  await assertChain(provider);
  if (isAborted(input.signal) || isAborted(input.walletSignal)) {
    throw new WalletError("changed");
  }
  const current = await readWalletAccounts(provider);
  if (isAborted(input.signal) || isAborted(input.walletSignal)) {
    throw new WalletError("changed");
  }
  if (current.toLowerCase() !== input.address.toLowerCase()) {
    throw new WalletError("changed");
  }
  const hexMessage = utf8ToHex(input.message);
  let signature: unknown;
  try {
    signature = await provider.request({
      method: "personal_sign",
      params: [hexMessage, input.address],
    });
  } catch {
    throw new WalletError("rejected");
  }
  // A cancellation during the awaited signature must prevent success.
  if (isAborted(input.signal) || isAborted(input.walletSignal)) {
    throw new WalletError("changed");
  }
  if (
    typeof signature !== "string" ||
    !/^0x[0-9a-fA-F]{130}$/u.test(signature)
  ) {
    throw new WalletError("rejected");
  }
  return signature;
}

function isAborted(signal: AbortSignal | undefined): boolean {
  return signal !== undefined && signal.aborted;
}

/** True when either the flow or the wallet session has been cancelled. */
export function isWalletCancelled(
  signals: readonly (AbortSignal | undefined)[],
): boolean {
  return signals.some(isAborted);
}

/**
 * Validates the server message before signing. Re-exposed here so the UI can
 * fail cleanly without importing the SIWE internals directly.
 */
export function assertWalletMessage(
  message: string,
  origin: string,
  address: string,
): void {
  try {
    validateWalletMessage(message, { origin, address });
  } catch (error) {
    if (error instanceof WalletMessageError) {
      throw new WalletError("invalid-message");
    }
    throw new WalletError("invalid-message");
  }
}
