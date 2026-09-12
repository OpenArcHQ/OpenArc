import { AccountRecoveryCodesResponseSchema } from "@openarc/shared";

/**
 * In-memory-only recovery-code handling.
 *
 * A generated set exists solely as component state: it is never copied
 * automatically, downloaded, placed in the URL, sent to storage, logged or
 * turned into an analytics event. It is cleared on any of the events below.
 */

export interface RecoveryDisplay {
  codes: readonly string[];
  visible: boolean;
}

export const EMPTY_RECOVERY_DISPLAY: RecoveryDisplay = Object.freeze({
  codes: [],
  visible: false,
});

/** Parses exactly eight codes from the one-time response, or returns empty. */
export function parseRecoveryCodes(payload: unknown): RecoveryDisplay {
  const parsed = AccountRecoveryCodesResponseSchema.safeParse(payload);
  if (!parsed.success) return EMPTY_RECOVERY_DISPLAY;
  return { codes: [...parsed.data.codes], visible: true };
}

export function hideRecoveryCodes(): RecoveryDisplay {
  return EMPTY_RECOVERY_DISPLAY;
}

/**
 * The events that must clear displayed codes. Kept explicit so the UI wiring
 * and tests agree on the exact lifecycle.
 */
export const RECOVERY_CLEAR_EVENTS = Object.freeze([
  "pagehide",
  "visibility-hidden",
  "logout",
  "navigation",
  "unmount",
] as const);

export type RecoveryClearEvent = (typeof RECOVERY_CLEAR_EVENTS)[number];

export function shouldClearRecovery(
  event: RecoveryClearEvent,
  visibilityState: string,
): boolean {
  if (event !== "visibility-hidden") return true;
  return visibilityState === "hidden";
}

/**
 * Tracks a monotonically increasing generation for in-flight recovery-code
 * display requests. Hiding, navigating, unmounting or changing the session
 * invalidates the generation so a late server response is discarded even if
 * the tab later becomes visible again. There is no automatic regeneration.
 */
export class RecoveryDisplayGuard {
  #generation = 0;

  /** Issues a token for a new display request, invalidating any prior one. */
  start(): number {
    this.#generation += 1;
    return this.#generation;
  }

  /**
   * Applies a response only if its token is still current and the guard has
   * not been invalidated; otherwise returns the empty display unchanged.
   */
  apply(token: number, payload: unknown, current: RecoveryDisplay): RecoveryDisplay {
    if (token !== this.#generation) return current;
    return parseRecoveryCodes(payload);
  }

  /** Invalidates in-flight display requests (hide/nav/logout/unmount). */
  invalidate(): void {
    this.#generation += 1;
  }

  /** Clears the visible display and invalidates any in-flight request. */
  clear(): RecoveryDisplay {
    this.invalidate();
    return hideRecoveryCodes();
  }
}
