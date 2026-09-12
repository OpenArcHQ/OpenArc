import { describe, expect, it, vi } from "vitest";

import {
  renderMutationState,
  suppressPriorAccountMutation,
} from "../src/tenant/tenant-mutation-render.js";

const A = "openarc:account:aaa";
const B = "openarc:account:bbb";

describe("tenant mutation render guard", () => {
  it("keeps the state for the same account", () => {
    expect(suppressPriorAccountMutation(A, A)).toBe(false);
    expect(suppressPriorAccountMutation(B, B)).toBe(false);
  });

  it("keeps the state for the initial null adoption", () => {
    expect(suppressPriorAccountMutation(null, A)).toBe(false);
    expect(suppressPriorAccountMutation(null, B)).toBe(false);
    expect(suppressPriorAccountMutation(null, null)).toBe(false);
  });

  it("suppresses a stale account A->B transition synchronously", () => {
    expect(suppressPriorAccountMutation(A, B)).toBe(true);
    expect(suppressPriorAccountMutation(B, A)).toBe(true);
  });

  it("allows A->signed-out so a self-demotion receipt survives", () => {
    expect(suppressPriorAccountMutation(A, null)).toBe(false);
  });

  it("suppresses A->B even after an intervening signed-out frame", () => {
    // The receipt from A must never be exposed once B is adopted.
    expect(suppressPriorAccountMutation(A, null)).toBe(false);
    expect(suppressPriorAccountMutation(A, B)).toBe(true);
  });

  it("returns idle without touching the controller when suppressing", () => {
    const staleState = { kind: "committed" as const };
    const idle = vi.fn(() => ({ kind: "idle" as const }));

    const suppressed = renderMutationState(A, B, staleState, idle);
    expect(idle).toHaveBeenCalledTimes(1);
    expect(suppressed).toEqual({ kind: "idle" });

    const kept = renderMutationState(A, A, staleState, idle);
    expect(kept).toBe(staleState);
    expect(idle).toHaveBeenCalledTimes(1);
  });

  it("never exposes a stale state when false", () => {
    for (const [last, current] of [
      [A, B],
      [B, A],
    ] as const) {
      expect(suppressPriorAccountMutation(last, current)).toBe(true);
      const exposed = renderMutationState(last, current, { kind: "committed" }, () => ({
        kind: "idle" as const,
      }));
      expect(exposed.kind).toBe("idle");
    }
  });
});
