import {
  AccountBootstrapResponseSchema,
  AccountEmptyRequestSchema,
  AccountPasskeyAddVerifyRequestSchema,
  AccountPasskeyLoginVerifyRequestSchema,
  AccountPasskeyRegisterVerifyRequestSchema,
  AccountRecoveryCodesResponseSchema,
  AccountRecoveryRedeemRequestSchema,
  AccountRegisterOptionsRequestSchema,
  AccountSessionResponseSchema,
  AccountWalletAddressRequestSchema,
  AccountWalletOptionsResponseSchema,
  AccountWalletVerifyRequestSchema,
  type AccountSessionView,
} from "@openarc/shared";

import {
  ACCOUNT_API_PATHS,
  AccountApiError,
  requestAccount,
  type AccountFetch,
} from "./auth-client.js";
import {
  AccountSessionEnvelopeDataSchema,
  accountIdOf,
  applyBootstrap,
  applySessionResponse,
  clearAccountState,
  hasUsableCsrf,
  initialAccountState,
  type AccountSessionState,
} from "./session-store.js";

/**
 * Explicit, single-flight account flow controller.
 *
 * One session generation is authoritative for both reads and mutations. A
 * mutation first bootstraps once to obtain a fresh CSRF token bound to the
 * current session hash, then completes that flow without a second bootstrap.
 * Concurrent actions are disabled, and the generation plus per-operation
 * AbortControllers guarantee a stale read or write can never be applied.
 * Reads are invalidated when a mutation starts, when a session is adopted or
 * cleared, and on unmount. There are no automatic write retries.
 */

export interface AccountFlowDeps {
  fetcher?: AccountFetch;
  onState?: (state: AccountSessionState) => void;
}

export interface AccountBoundToken {
  readonly generation: number;
  readonly accountId: string | null;
}

/**
 * A single mutation's authority token. Successor effects (session adoption,
 * success notices, busy clearing) must consult `isCurrent()` immediately
 * before they run so a superseded operation can never apply state.
 */
export interface AccountOperationScope {
  readonly generation: number;
  isCurrent(): boolean;
}

export class AccountFlowController {
  #state: AccountSessionState = initialAccountState();
  #generation = 0;
  #readGeneration = 0;
  #busy = false;
  #abort: AbortController | null = null;
  #readAbort: AbortController | null = null;
  readonly #deps: AccountFlowDeps;

  constructor(deps: AccountFlowDeps = {}) {
    this.#deps = deps;
  }

  get state(): AccountSessionState {
    return this.#state;
  }

  get busy(): boolean {
    return this.#busy;
  }

  get generation(): number {
    return this.#generation;
  }

  /**
   * Captures the intended account for an account-bound action. A later
   * mutation validates the fresh bootstrap against this token so a stale `A`
   * view can never act on a session that has since become `B` or a guest.
   */
  captureAccountBound(): AccountBoundToken {
    return { generation: this.#generation, accountId: accountIdOf(this.#state.session) };
  }

  /** Cancels any in-flight flow/read and invalidates its generation. */
  cancel(): void {
    this.#generation += 1;
    this.#readGeneration += 1;
    this.#abort?.abort();
    this.#abort = null;
    this.#readAbort?.abort();
    this.#readAbort = null;
    this.#busy = false;
  }

  /** Cancels and clears all local sensitive state (used on unmount/logout). */
  reset(): void {
    this.cancel();
    this.#setState(clearAccountState());
  }

  /**
   * Explicit read, coordinated through the controller generation. A late
   * guest GET can no longer overwrite a completed login, and an old
   * authenticated GET can no longer overwrite a logout: the read's generation
   * is invalidated as soon as a mutation starts or a session is adopted.
   */
  async loadSession(): Promise<AccountSessionView> {
    this.#readAbort?.abort();
    const controller = new AbortController();
    this.#readAbort = controller;
    const generation = this.#generation;
    const readGeneration = this.#readGeneration;
    const data = await requestAccount({
      path: ACCOUNT_API_PATHS.session,
      method: "GET",
      responseSchema: AccountSessionEnvelopeDataSchema,
      signal: controller.signal,
      ...(this.#deps.fetcher === undefined ? {} : { fetcher: this.#deps.fetcher }),
    });
    if (generation !== this.#generation || readGeneration !== this.#readGeneration) {
      throw new AccountApiError({ kind: "aborted" });
    }
    this.#readAbort = null;
    return data.session;
  }

  /**
   * Explicit read that also adopts the resolved session into controller state
   * (never into a stale generation). Used by the enabled screen's initial load
   * and explicit refresh.
   */
  async refreshSession(): Promise<AccountSessionState> {
    const session = await this.loadSession();
    const next: AccountSessionState = session.signedIn
      ? { status: "signed-in", csrfToken: this.#state.csrfToken, session }
      : { status: "signed-out", csrfToken: this.#state.csrfToken, session };
    this.#setState(next);
    return next;
  }

  /**
   * Runs one explicit mutation flow:
   *  1. bootstrap exactly once for a fresh CSRF/binding,
   *  2. validate the intended account (if bound) BEFORE any options/mutation,
   *  3. send the mutation with that token,
   *  4. adopt any rotated CSRF token/session from the mutation response.
   *
   * On a lost response the caller receives `outcome-unknown`; it must not be
   * reported as a failure that rolled back.
   */
  async mutate<T>(
    run: (context: {
      csrfToken: string;
      signal: AbortSignal;
      scope: AccountOperationScope;
      adopt: (data: { csrfToken: string; session: AccountSessionView }) => boolean;
      fetcher?: AccountFetch;
    }) => Promise<T>,
    options: { accountBound?: AccountBoundToken } = {},
  ): Promise<T> {
    if (this.#busy) throw new AccountApiError({ kind: "pre-send" });
    const controller = new AbortController();
    this.#abort = controller;
    this.#busy = true;
    const generation = this.#generation;
    const scope: AccountOperationScope = {
      generation,
      isCurrent: () => generation === this.#generation && !controller.signal.aborted,
    };
    // Adoption is operation-scoped: it checks generation and abort at the
    // exact moment it is asked to apply, not only when `run` later returns.
    const adopt = (data: { csrfToken: string; session: AccountSessionView }): boolean => {
      if (!scope.isCurrent()) return false;
      this.adoptSessionResponse(data);
      return true;
    };
    // A mutation invalidates any read racing it.
    this.#readAbort?.abort();
    this.#readAbort = null;
    this.#readGeneration += 1;
    try {
      const bootstrap = await this.#bootstrap(controller.signal, generation);
      if (generation !== this.#generation) {
        throw new AccountApiError({ kind: "aborted" });
      }
      const bound = options.accountBound;
      if (bound !== undefined) {
        if (bound.generation !== generation) {
          throw new AccountApiError({ kind: "aborted" });
        }
        const actual = accountIdOf(this.#state.session);
        if (bound.accountId === null || actual !== bound.accountId) {
          // Synchronize displayed state to the actual session, then require a
          // new explicit action: never let stale `A` act on `B`/guest.
          throw new AccountApiError({ kind: "account-changed" });
        }
      }
      const result = await run({
        csrfToken: bootstrap.csrfToken,
        signal: controller.signal,
        scope,
        adopt,
        ...(this.#deps.fetcher === undefined ? {} : { fetcher: this.#deps.fetcher }),
      });
      if (generation !== this.#generation) {
        throw new AccountApiError({ kind: "aborted" });
      }
      return result;
    } finally {
      if (generation === this.#generation) {
        this.#busy = false;
        this.#abort = null;
      }
    }
  }

  async #bootstrap(
    signal: AbortSignal,
    generation: number,
  ): Promise<{ csrfToken: string }> {
    const data = await requestAccount({
      path: ACCOUNT_API_PATHS.bootstrap,
      method: "POST",
      requestSchema: AccountEmptyRequestSchema,
      responseSchema: AccountBootstrapResponseSchema,
      body: {},
      signal,
      ...(this.#deps.fetcher === undefined ? {} : { fetcher: this.#deps.fetcher }),
    });
    // Never apply a bootstrap resolved for a superseded generation.
    if (generation !== this.#generation) {
      throw new AccountApiError({ kind: "aborted" });
    }
    const next = applyBootstrap(this.#state, data);
    this.#setState(next);
    if (!hasUsableCsrf(next)) {
      throw new AccountApiError({ kind: "invalid-response" });
    }
    return { csrfToken: data.csrfToken };
  }

  /**
   * Adopts a rotation response from register/login/recovery verify. When an
   * operation scope is supplied, the adoption is a no-op unless that operation
   * is still current and unaborted.
   */
  adoptSessionResponse(
    data: {
      csrfToken: string;
      session: AccountSessionView;
    },
    scope?: AccountOperationScope,
  ): boolean {
    if (scope !== undefined && !scope.isCurrent()) return false;
    this.#invalidateReads();
    this.#setState(applySessionResponse(this.#state, data));
    return true;
  }

  /** Synchronizes controller state to an authoritative external session. */
  setSession(session: AccountSessionView): void {
    this.#invalidateReads();
    const next: AccountSessionState = session.signedIn
      ? { status: "signed-in", csrfToken: this.#state.csrfToken, session }
      : { status: "signed-out", csrfToken: this.#state.csrfToken, session };
    this.#setState(next);
  }

  #invalidateReads(): void {
    this.#readAbort?.abort();
    this.#readAbort = null;
    this.#readGeneration += 1;
  }

  #setState(next: AccountSessionState): void {
    this.#state = next;
    this.#deps.onState?.(next);
  }
}

/** Request schemas/bodies for each explicit flow, kept in one audited place. */
export const ACCOUNT_REQUESTS = Object.freeze({
  registerOptions: {
    path: ACCOUNT_API_PATHS.registerOptions,
    requestSchema: AccountRegisterOptionsRequestSchema,
    body: { acceptMinimalRecords: true as const },
    responseSchema: null,
  },
  registerVerify: {
    path: ACCOUNT_API_PATHS.registerVerify,
    requestSchema: AccountPasskeyRegisterVerifyRequestSchema,
  },
  loginOptions: {
    path: ACCOUNT_API_PATHS.loginOptions,
    requestSchema: AccountEmptyRequestSchema,
    body: {},
  },
  loginVerify: {
    path: ACCOUNT_API_PATHS.loginVerify,
    requestSchema: AccountPasskeyLoginVerifyRequestSchema,
  },
  addOptions: {
    path: ACCOUNT_API_PATHS.addOptions,
    requestSchema: AccountEmptyRequestSchema,
    body: {},
  },
  addVerify: {
    path: ACCOUNT_API_PATHS.addVerify,
    requestSchema: AccountPasskeyAddVerifyRequestSchema,
  },
  walletLoginOptions: {
    path: ACCOUNT_API_PATHS.walletLoginOptions,
    requestSchema: AccountWalletAddressRequestSchema,
  },
  walletLoginVerify: {
    path: ACCOUNT_API_PATHS.walletLoginVerify,
    requestSchema: AccountWalletVerifyRequestSchema,
  },
  walletLinkOptions: {
    path: ACCOUNT_API_PATHS.walletLinkOptions,
    requestSchema: AccountWalletAddressRequestSchema,
  },
  walletLinkVerify: {
    path: ACCOUNT_API_PATHS.walletLinkVerify,
    requestSchema: AccountWalletVerifyRequestSchema,
  },
  recoveryCodes: {
    path: ACCOUNT_API_PATHS.recoveryCodes,
    requestSchema: AccountEmptyRequestSchema,
    body: {},
  },
  recoveryRedeem: {
    path: ACCOUNT_API_PATHS.recoveryRedeem,
    requestSchema: AccountRecoveryRedeemRequestSchema,
  },
  logout: {
    path: ACCOUNT_API_PATHS.logout,
    requestSchema: AccountEmptyRequestSchema,
    body: {},
  },
} as const);

export {
  AccountRecoveryCodesResponseSchema,
  AccountSessionResponseSchema,
  AccountWalletOptionsResponseSchema,
};
