import {
  AccountSessionViewSchema,
  type AccountSessionView,
} from "@openarc/shared";

/**
 * In-memory-only account state.
 *
 * Nothing here is persisted: there is no localStorage, sessionStorage, cookie
 * read, IndexedDB or history entry. The CSRF token and the safe session view
 * live for the lifetime of the enabled account screen only.
 */

export type AccountStatus =
  | "signed-out"
  | "signed-in";

export interface AccountSessionState {
  readonly status: AccountStatus;
  readonly csrfToken: string | null;
  readonly session: AccountSessionView;
}

export const GUEST_SESSION: AccountSessionView = { signedIn: false };

/** The bound account id for a session, or null for a guest. */
export function accountIdOf(session: AccountSessionView): string | null {
  return session.signedIn ? session.accountId : null;
}

/**
 * Structural runtime schema for the `{ session }` data returned by
 * `GET /v2/auth/session` and `POST /v2/auth/logout`.
 */
export const AccountSessionEnvelopeDataSchema: {
  safeParse(value: unknown):
    | { success: true; data: { session: AccountSessionView } }
    | { success: false };
} = {
  safeParse(value: unknown) {
    if (typeof value !== "object" || value === null) return { success: false };
    const parsed = AccountSessionViewSchema.safeParse(
      (value as { session?: unknown }).session,
    );
    return parsed.success
      ? { success: true, data: { session: parsed.data } }
      : { success: false };
  },
};

export function initialAccountState(): AccountSessionState {
  return { status: "signed-out", csrfToken: null, session: GUEST_SESSION };
}

/** Applies a verified session response, adopting its rotated CSRF token. */
export function applySessionResponse(
  current: AccountSessionState,
  response: { csrfToken: string; session: unknown },
): AccountSessionState {
  const session = AccountSessionViewSchema.parse(response.session);
  return {
    status: session.signedIn ? "signed-in" : "signed-out",
    csrfToken: response.csrfToken,
    session,
  };
}

/** Applies a bootstrap response (fresh CSRF/binding, never a write). */
export function applyBootstrap(
  current: AccountSessionState,
  response: { csrfToken: string; session: unknown },
): AccountSessionState {
  return applySessionResponse(current, response);
}

/** Clears local sensitive state after logout or an expired session. */
export function clearAccountState(): AccountSessionState {
  return initialAccountState();
}

/**
 * A fresh CSRF token is required before a mutation. Bootstrap binds the token
 * to the current session hash; a mutation may rotate the session and return a
 * new token, which replaces the old one on success.
 */
export function hasUsableCsrf(state: AccountSessionState): boolean {
  return typeof state.csrfToken === "string" && state.csrfToken.length > 0;
}

export function safeSessionSummary(
  state: AccountSessionState,
): { signedIn: false } | { signedIn: true; accountId: string; method: string; expiresAt: string } {
  const session = state.session;
  if (!session.signedIn) return { signedIn: false };
  return {
    signedIn: true,
    accountId: session.accountId,
    method: session.method,
    expiresAt: session.expiresAt,
  };
}
