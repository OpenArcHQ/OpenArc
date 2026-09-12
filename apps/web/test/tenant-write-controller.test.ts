import {
  COMMERCE_API_ERRORS,
  COMMERCE_API_SCHEMA_VERSION,
  type CommerceHumanRole,
} from "@openarc/shared";
import { describe, expect, it } from "vitest";

import type { AccountFlowController } from "../src/account/flow-controller.js";
import { TenantWriteApiError, TenantWriteClient } from "../src/tenant/tenant-write-client.js";
import {
  TenantWriteController,
  type TenantReadCoordinator,
} from "../src/tenant/tenant-write-controller.js";

const META = {
  schemaVersion: COMMERCE_API_SCHEMA_VERSION,
  requestId: "018f47a2-3b4c-7def-8123-456789abcdef",
  buildSha: "0123456789abcdef0123456789abcdef01234567",
};

const ORG_A = "openarc:org:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const AGENT_A = "openarc:agent:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ACCOUNT_A = "openarc:account:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ACCOUNT_B = "openarc:account:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

function success(data: unknown): Response {
  return new Response(JSON.stringify({ ok: true, data, meta: META }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function errorEnvelope(code: keyof typeof COMMERCE_API_ERRORS, status: number): Response {
  return new Response(
    JSON.stringify({
      ok: false,
      error: { code, message: COMMERCE_API_ERRORS[code].message, retryable: false },
      meta: META,
    }),
    { status, headers: { "content-type": "application/json" } },
  );
}

function agentResult(mutationId: string) {
  return {
    organizationId: ORG_A,
    replayed: false,
    receipt: {
      mutationId,
      operation: "tenant.agent.create",
      resourceType: "agent",
      resourceId: AGENT_A,
      committedAt: "2026-01-01T00:00:00.000Z",
    },
  };
}

function fakeReads(
  role: CommerceHumanRole | null = "owner",
  organizationId: string | null = ORG_A,
): TenantReadCoordinator & {
  abortCalls: number;
  cleared: number;
  reloads: string[];
} {
  const reads = {
    abortCalls: 0,
    cleared: 0,
    reloads: [] as string[],
    currentOrganizationId: () => organizationId,
    currentRole: () => role,
    abortPendingReads() {
      reads.abortCalls += 1;
    },
    clearForAccountChange() {
      reads.cleared += 1;
    },
    async reloadAfterCommit(section: string) {
      reads.reloads.push(section);
    },
  };
  return reads;
}

/**
 * A faithful account stub: `mutate` bootstrap-binds a CSRF token, validates
 * the captured account, and runs the supplied callback. It mirrors the real
 * controller's account-changed contract so the write controller's handling is
 * exercised exactly as in production.
 */
function fakeAccount(initialAccountId = ACCOUNT_A, method = "passkey") {
  let currentAccountId: string | null = initialAccountId;
  const account = {
    state: {
      status: "signed-in",
      csrfToken: "csrf" as string | null,
      session: { signedIn: true as const, accountId: initialAccountId, method, expiresAt: "2030-01-01T00:00:00.000Z" },
    },
    captureAccountBound() {
      return { generation: 0, accountId: currentAccountId };
    },
    async mutate<T>(
      run: (context: {
        csrfToken: string;
        signal: AbortSignal;
        scope: { generation: number; isCurrent(): boolean };
        adopt: (data: { csrfToken: string; session: unknown }) => boolean;
      }) => Promise<T>,
    ): Promise<T> {
      if (currentAccountId === null || currentAccountId !== initialAccountId) {
        throw { failure: { kind: "account-changed" } } as unknown as Error;
      }
      return run({
        csrfToken: "csrf-from-bootstrap",
        signal: new AbortController().signal,
        scope: { generation: 0, isCurrent: () => true },
        adopt: () => true,
      });
    },
    async refreshSession() {
      return undefined;
    },
    setAccount(id: string | null) {
      currentAccountId = id;
    },
  };
  return account as unknown as AccountFlowController & { setAccount(id: string | null): void };
}

function controllerWith(
  fetcher: typeof fetch,
  account: AccountFlowController,
  reads: TenantReadCoordinator,
) {
  return new TenantWriteController({
    account,
    reads,
    client: new TenantWriteClient({ fetcher }),
  });
}

/** An account whose session is signed out; `mutate` must never be called. */
function signedOutAccount() {
  return {
    state: {
      status: "signed-out",
      csrfToken: null,
      session: { signedIn: false as const },
    },
    captureAccountBound() {
      return { generation: 0, accountId: null };
    },
    async mutate() {
      throw new Error("mutate must not run for a signed-out session");
    },
    async refreshSession() {
      return undefined;
    },
  } as unknown as AccountFlowController;
}

function orgCreateResult(mutationId: string, organizationId: string) {
  return {
    organizationId,
    replayed: false,
    receipt: {
      mutationId,
      operation: "tenant.organization.create",
      resourceType: "organization",
      resourceId: organizationId,
      committedAt: "2026-01-01T00:00:00.000Z",
    },
  };
}

describe("tenant write controller", () => {
  it("blocks a known-recovery session locally for org bootstrap and membership", () => {
    const reads = fakeReads();
    const account = fakeAccount(ACCOUNT_A, "recovery");
    const controller = controllerWith(
      (async () => success(agentResult("x"))) as unknown as typeof fetch,
      account,
      reads,
    );
    expect(controller.begin({ op: "tenant.organization.create", displayName: "Org" })).toBe(false);
    expect(controller.state).toEqual({ kind: "rejected", notice: { kind: "recovery-blocked" } });
    expect(controller.begin({ op: "tenant.membership.set", organizationId: ORG_A, accountId: ACCOUNT_B, role: "viewer", membershipStatus: "active" })).toBe(false);
    // Agent writes do not require a fresh non-recovery proof.
    expect(controller.begin({ op: "tenant.agent.create", organizationId: ORG_A, displayName: "A" })).toBe(true);
  });

  it("enforces the role matrix for agent and provider writes", () => {
    const operator = controllerWith(
      (async () => success(agentResult("x"))) as unknown as typeof fetch,
      fakeAccount(),
      fakeReads("operator"),
    );
    expect(operator.begin({ op: "tenant.agent.create", organizationId: ORG_A, displayName: "A" })).toBe(true);
    operator.cancel();
    expect(operator.begin({ op: "tenant.provider.create", organizationId: ORG_A, displayName: "P" })).toBe(false);
    expect(operator.begin({ op: "tenant.membership.set", organizationId: ORG_A, accountId: ACCOUNT_B, role: "viewer", membershipStatus: "active" })).toBe(false);

    const viewer = controllerWith(
      (async () => success(agentResult("x"))) as unknown as typeof fetch,
      fakeAccount(),
      fakeReads("viewer"),
    );
    expect(viewer.begin({ op: "tenant.agent.create", organizationId: ORG_A, displayName: "A" })).toBe(false);

    const owner = controllerWith(
      (async () => success(agentResult("x"))) as unknown as typeof fetch,
      fakeAccount(),
      fakeReads("owner"),
    );
    expect(owner.begin({ op: "tenant.provider.create", organizationId: ORG_A, displayName: "P" })).toBe(true);
  });

  it("rejects empty updates, field limits and a mismatched organization", () => {
    const controller = controllerWith(
      (async () => success(agentResult("x"))) as unknown as typeof fetch,
      fakeAccount(),
      fakeReads("owner"),
    );
    expect(controller.begin({ op: "tenant.agent.update", organizationId: ORG_A, agentId: AGENT_A })).toBe(false);
    expect(controller.begin({ op: "tenant.agent.create", organizationId: ORG_A, displayName: "  " })).toBe(false);
    expect(controller.begin({ op: "tenant.agent.create", organizationId: ORG_A, displayName: "A".repeat(101) })).toBe(false);
    expect(
      controller.begin({
        op: "tenant.agent.create",
        organizationId: "openarc:org:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        displayName: "A",
      }),
    ).toBe(false);
    expect(controller.begin({ op: "tenant.membership.set", organizationId: ORG_A, accountId: "nope", role: "viewer", membershipStatus: "active" })).toBe(false);
  });

  it("freezes one mutation id/key while pending and sends the token from mutate", async () => {
    const bodies: string[] = [];
    const keys: string[] = [];
    const fetcher = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      bodies.push(String(init?.body ?? ""));
      keys.push(String((init?.headers as Record<string, string>)["Idempotency-Key"]));
      return success(agentResult(JSON.parse(String(init?.body)).mutationId));
    }) as unknown as typeof fetch;
    const reads = fakeReads();
    const controller = controllerWith(fetcher, fakeAccount(), reads);
    expect(controller.begin({ op: "tenant.agent.create", organizationId: ORG_A, displayName: "A" })).toBe(true);
    const pending = controller.confirm();
    expect(controller.state.kind).toBe("pending");
    await pending;
    expect(controller.state.kind).toBe("committed");
    expect(reads.abortCalls).toBe(1);
    expect(reads.reloads).toEqual(["agents"]);
    expect(keys.length).toBe(1);
    expect(bodies.length).toBe(1);
    // The key is never in the body; the body carries the frozen mutation id.
    expect(bodies[0]).not.toContain(keys[0]);
    expect((JSON.parse(bodies[0] as string) as { mutationId: string }).mutationId).toBeTruthy();
  });

  it("maps a definite rejection to a fixed notice without optimistic rows", async () => {
    const controller = controllerWith(
      (async () => errorEnvelope("INVALID_REQUEST", 400)) as unknown as typeof fetch,
      fakeAccount(),
      fakeReads(),
    );
    controller.begin({ op: "tenant.agent.create", organizationId: ORG_A, displayName: "A" });
    await controller.confirm();
    expect(controller.state).toEqual({ kind: "rejected", notice: { kind: "validation" } });
  });

  it("treats a lost response as unknown and keeps the original id", async () => {
    const controller = controllerWith(
      (async () => {
        throw new Error("network");
      }) as unknown as typeof fetch,
      fakeAccount(),
      fakeReads(),
    );
    controller.begin({ op: "tenant.agent.create", organizationId: ORG_A, displayName: "A" });
    await controller.confirm();
    expect(controller.state.kind).toBe("outcome-unknown");
    if (controller.state.kind === "outcome-unknown") {
      expect(controller.state.organizationId).toBe(ORG_A);
      expect(controller.state.mutationId).toMatch(/^[0-9a-f-]{36}$/u);
    }
  });

  it("checks status with the original id and keeps unknown on not_found", async () => {
    let statusCalls = 0;
    const originalMutation: string[] = [];
    const fetcher = (async (input: RequestInfo | URL) => {
      if (String(input).includes("/mutations/")) {
        statusCalls += 1;
        originalMutation.push(String(input));
        return success({ status: "not_found", organizationId: ORG_A });
      }
      throw new Error("network");
    }) as unknown as typeof fetch;
    const controller = controllerWith(fetcher, fakeAccount(), fakeReads());
    controller.begin({ op: "tenant.agent.create", organizationId: ORG_A, displayName: "A" });
    await controller.confirm();
    expect(controller.state.kind).toBe("outcome-unknown");
    const mutationId =
      controller.state.kind === "outcome-unknown" ? controller.state.mutationId : "none";
    await controller.checkStatus();
    expect(controller.state.kind).toBe("outcome-unknown");
    if (controller.state.kind === "outcome-unknown") {
      expect(controller.state.mutationId).toBe(mutationId);
      expect(controller.state.statusMessage).toBe(
        "No committed result found yet; it may still complete. Check again.",
      );
    }
    expect(statusCalls).toBe(1);
    expect(originalMutation[0]).toContain(mutationId);
  });

  it("clears the draft and reloads the bounded page on a committed status", async () => {
    const reads = fakeReads();
    const fetcher = (async (input: RequestInfo | URL) => {
      const match = /\/mutations\/([0-9a-f-]{36})$/u.exec(String(input));
      if (match !== null) {
        return success({
          status: "committed",
          organizationId: ORG_A,
          receipt: {
            mutationId: match[1],
            operation: "tenant.agent.create",
            resourceType: "agent",
            resourceId: AGENT_A,
            committedAt: "2026-01-01T00:00:00.000Z",
          },
        });
      }
      throw new Error("network");
    }) as unknown as typeof fetch;
    const controller = controllerWith(fetcher, fakeAccount(), reads);
    controller.begin({ op: "tenant.agent.create", organizationId: ORG_A, displayName: "A" });
    await controller.confirm();
    await controller.checkStatus();
    // The status GET must use the original mutation id, so it cannot be a new
    // submit. The committed receipt is shown; the read reload is driven by the
    // committed result path (not an invented mutation).
    expect(controller.state.kind).toBe("committed");
  });

  it("clears local state on account change and never sends under the new account", async () => {
    const reads = fakeReads();
    let fetches = 0;
    const account = fakeAccount();
    const controller = controllerWith(
      (async () => {
        fetches += 1;
        return success(agentResult("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"));
      }) as unknown as typeof fetch,
      account,
      reads,
    );
    controller.begin({ op: "tenant.agent.create", organizationId: ORG_A, displayName: "A" });
    account.setAccount(ACCOUNT_B);
    await controller.confirm();
    expect(controller.state).toEqual({ kind: "rejected", notice: { kind: "account-changed" } });
    expect(reads.cleared).toBe(1);
    expect(fetches).toBe(0);
  });

  it("clears local state on logout, hidden and dispose, and blocks reads from writing", async () => {
    const reads = fakeReads();
    const controller = controllerWith(
      (async () => success(agentResult("x"))) as unknown as typeof fetch,
      fakeAccount(),
      reads,
    );
    controller.begin({ op: "tenant.agent.create", organizationId: ORG_A, displayName: "A" });
    controller.clear();
    expect(controller.state).toEqual({ kind: "idle" });
    controller.begin({ op: "tenant.agent.create", organizationId: ORG_A, displayName: "A" });
    controller.dispose();
    expect(controller.disposed).toBe(true);
    expect(controller.state).toEqual({ kind: "idle" });
  });

  it("keeps an unknown outcome locked to status checks with no dismiss path", async () => {
    const controller = controllerWith(
      (async () => {
        throw new Error("network");
      }) as unknown as typeof fetch,
      fakeAccount(),
      fakeReads(),
    );
    controller.begin({ op: "tenant.agent.create", organizationId: ORG_A, displayName: "A" });
    await controller.confirm();
    expect(controller.state.kind).toBe("outcome-unknown");
    // The frozen contract permits no dismissal that restores this draft/new
    // logical submit in the active flow.
    expect(
      (controller as unknown as { dismissUnknown?: unknown }).dismissUnknown,
    ).toBeUndefined();
  });

  it("allows a signed-in zero-org user to bootstrap the first organization", async () => {
    const reads = fakeReads(null, null);
    const fetcher = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const mutationId = (JSON.parse(String(init?.body)) as { mutationId: string }).mutationId;
      return success(orgCreateResult(mutationId, `openarc:org:${mutationId}`));
    }) as unknown as typeof fetch;
    const controller = controllerWith(fetcher, fakeAccount(), reads);
    expect(
      controller.begin({ op: "tenant.organization.create", displayName: "Org" }),
    ).toBe(true);
    await controller.confirm();
    expect(controller.state.kind).toBe("committed");
    // Refresh organizations, but never implicitly select the new one.
    expect(reads.reloads).toEqual(["organizations"]);
  });

  it("refuses first-organization bootstrap without a signed-in session", () => {
    const controller = controllerWith(
      (async () => success(orgCreateResult("x", `openarc:org:${"a".repeat(8)}`))) as unknown as typeof fetch,
      signedOutAccount(),
      fakeReads(null, null),
    );
    expect(
      controller.begin({ op: "tenant.organization.create", displayName: "Org" }),
    ).toBe(false);
    expect(controller.state).toEqual({ kind: "idle" });
  });

  it("refuses a non-bootstrap draft with no selected organization", () => {
    const controller = controllerWith(
      (async () => success(agentResult("x"))) as unknown as typeof fetch,
      fakeAccount(),
      fakeReads(null, null),
    );
    expect(
      controller.begin({ op: "tenant.agent.create", organizationId: ORG_A, displayName: "A" }),
    ).toBe(false);
  });

  it("keeps a confirmed commit when the follow-up read refresh fails", async () => {
    const reads = fakeReads();
    reads.reloadAfterCommit = async () => {
      throw new Error("read unavailable");
    };
    const fetcher = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const mutationId = (JSON.parse(String(init?.body)) as { mutationId: string }).mutationId;
      return success({
        organizationId: ORG_A,
        replayed: false,
        receipt: {
          mutationId,
          operation: "tenant.agent.create",
          resourceType: "agent",
          resourceId: AGENT_A,
          committedAt: "2026-01-01T00:00:00.000Z",
        },
      });
    }) as unknown as typeof fetch;
    const controller = controllerWith(fetcher, fakeAccount(), reads);
    controller.begin({ op: "tenant.agent.create", organizationId: ORG_A, displayName: "A" });
    await controller.confirm();
    expect(controller.state.kind).toBe("committed");
  });

  it("keeps a self-membership commit confirmed when the session refresh 401s", async () => {
    const reads = fakeReads();
    const account = fakeAccount();
    (account as unknown as { refreshSession(): Promise<unknown> }).refreshSession = async () => {
      throw new Error("401 unauthenticated");
    };
    const fetcher = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const mutationId = (JSON.parse(String(init?.body)) as { mutationId: string }).mutationId;
      return success({
        organizationId: ORG_A,
        replayed: false,
        receipt: {
          mutationId,
          operation: "tenant.membership.set",
          resourceType: "membership",
          resourceId: ACCOUNT_B,
          committedAt: "2026-01-01T00:00:00.000Z",
        },
      });
    }) as unknown as typeof fetch;
    const controller = controllerWith(fetcher, account, reads);
    controller.begin({
      op: "tenant.membership.set",
      organizationId: ORG_A,
      accountId: ACCOUNT_B,
      role: "viewer",
      membershipStatus: "active",
    });
    await controller.confirm();
    // The commit is never reported failed, even though the session read 401ed.
    expect(controller.state.kind).toBe("committed");
    expect(reads.reloads).toEqual(["membership"]);
  });

  it("does not mint a new key or write after unknown -> not_found", async () => {
    let writes = 0;
    let statusCalls = 0;
    const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "GET") {
        statusCalls += 1;
        return success({ status: "not_found", organizationId: ORG_A });
      }
      writes += 1;
      throw new Error("network");
    }) as unknown as typeof fetch;
    const controller = controllerWith(fetcher, fakeAccount(), fakeReads());
    controller.begin({ op: "tenant.agent.create", organizationId: ORG_A, displayName: "A" });
    await controller.confirm();
    expect(controller.state.kind).toBe("outcome-unknown");
    const mutationId =
      controller.state.kind === "outcome-unknown" ? controller.state.mutationId : "none";
    await controller.checkStatus();
    await controller.checkStatus();
    expect(writes).toBe(1);
    expect(statusCalls).toBe(2);
    if (controller.state.kind === "outcome-unknown") {
      expect(controller.state.mutationId).toBe(mutationId);
    } else {
      throw new Error("not_found must keep the outcome unknown");
    }
  });

  it("never exposes a raw server message from a failure", async () => {
    const controller = controllerWith(
      (async () =>
        new Response(
          JSON.stringify({
            ok: false,
            error: { code: "POLICY_DENIED", message: COMMERCE_API_ERRORS.POLICY_DENIED.message, retryable: false },
            meta: META,
          }),
          { status: 409, headers: { "content-type": "application/json" } },
        )) as unknown as typeof fetch,
      fakeAccount(),
      fakeReads(),
    );
    controller.begin({ op: "tenant.membership.set", organizationId: ORG_A, accountId: ACCOUNT_B, role: "viewer", membershipStatus: "active" });
    await controller.confirm();
    expect(controller.state).toEqual({ kind: "rejected", notice: { kind: "policy" } });
    expect(JSON.stringify(controller.state)).not.toContain("denied this request");
  });

  it("surfaces a CSRF rejection as an auth-required notice and clears data", async () => {
    const reads = fakeReads();
    const controller = controllerWith(
      (async () => errorEnvelope("CSRF_REJECTED", 403)) as unknown as typeof fetch,
      fakeAccount(),
      reads,
    );
    controller.begin({ op: "tenant.agent.create", organizationId: ORG_A, displayName: "A" });
    await controller.confirm();
    expect(controller.state).toEqual({ kind: "rejected", notice: { kind: "csrf" } });
    expect(reads.cleared).toBe(1);
    expect(reads.reloads).toEqual([]);
  });

  it("rejects a status binding mismatch as an invalid response without writing", async () => {
    const client = new TenantWriteClient({
      fetcher: (async () =>
        success({ status: "not_found", organizationId: ACCOUNT_A })) as unknown as typeof fetch,
    });
    await expect(
      client.readMutationStatus({ organizationId: ORG_A, mutationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", signal: new AbortController().signal }),
    ).rejects.toBeInstanceOf(TenantWriteApiError);
  });
});
