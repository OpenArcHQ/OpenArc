import {
  COMMERCE_API_ERRORS,
  COMMERCE_API_SCHEMA_VERSION,
  type CommerceHumanRole,
} from "@openarc/shared";
import { describe, expect, it } from "vitest";

import type { AccountFlowController } from "../src/account/flow-controller.js";
import { MachineClient } from "../src/tenant/machine-client.js";
import {
  MachineCredentialController,
  MACHINE_MAX_EXPIRY_DAYS,
  initialMachineConsoleState,
  suppressStaleMachineContext,
  validExpiry,
  type MachineCredentialTarget,
  type MachineReadCoordinator,
  type MachineRenderContext,
} from "../src/tenant/machine-controller.js";

const META = {
  schemaVersion: COMMERCE_API_SCHEMA_VERSION,
  requestId: "018f47a2-3b4c-7def-8123-456789abcdef",
  buildSha: "0123456789abcdef0123456789abcdef01234567",
};

const V4 = "12345678-1234-4234-8123-123456789abc";
const V4_B = "87654321-4321-4321-b123-abcdefabcdef";
const ORG = `openarc:org:${V4}`;
const ORG_B = `openarc:org:${V4_B}`;
const AGENT = `openarc:agent:${V4}`;
const PROVIDER = `openarc:provider:${V4}`;
const ACCOUNT_A = `openarc:account:${V4}`;
const ACCOUNT_B = `openarc:account:${V4_B}`;
const TOKEN_SECRET = `${"A".repeat(42)}A`;
const AGENT_PREFIX = `oac_ag_${V4}`;
const AGENT_CREDENTIAL = `oac_ag_${V4}_${TOKEN_SECRET}`;
const ISO = "2024-01-01T00:00:00.000Z";
const EXPIRES = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

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

function agentIssueReceipt(mutationId: string) {
  return {
    mutationId,
    operation: "tenant.agent.credential.issue" as const,
    resourceType: "agent_credential" as const,
    credentialId: mutationId,
    committedAt: ISO,
  };
}

function freshIssue(mutationId: string) {
  return {
    organizationId: ORG,
    replayed: false as const,
    receipt: agentIssueReceipt(mutationId),
    delivery: { status: "available_once" as const, credential: AGENT_CREDENTIAL, publicPrefix: AGENT_PREFIX },
  };
}

function fakeReads(
  role: CommerceHumanRole | null = "owner",
  organizationId: string | null = ORG,
  accountId: string | null = ACCOUNT_A,
): MachineReadCoordinator & { abortCalls: number; reloads: string[] } {
  const reads = {
    abortCalls: 0,
    reloads: [] as string[],
    currentOrganizationId: () => organizationId,
    currentRole: () => role,
    currentAccountId: () => accountId,
    abortPendingReads() {
      reads.abortCalls += 1;
    },
    async reloadAfterCommit(kind: string) {
      reads.reloads.push(kind);
    },
  };
  return reads;
}

/** Faithful account stub mirroring the accepted mutate/account-changed seam. */
function fakeAccount(initialAccountId: string | null = ACCOUNT_A, method = "passkey") {
  let currentAccountId = initialAccountId;
  let generation = 0;
  const account = {
    get generation() {
      return generation;
    },
    state: {
      status: initialAccountId === null ? "signed-out" : "signed-in",
      csrfToken: "csrf" as string | null,
      session: initialAccountId === null
        ? { signedIn: false as const }
        : { signedIn: true as const, accountId: initialAccountId, method, expiresAt: "2030-01-01T00:00:00.000Z" },
    },
    captureAccountBound() {
      return { generation, accountId: currentAccountId };
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
        scope: { generation, isCurrent: () => true },
        adopt: () => true,
      });
    },
    async refreshSession() {
      return undefined;
    },
    setAccount(id: string | null) {
      currentAccountId = id;
      generation += 1;
    },
  };
  return account as unknown as AccountFlowController & { setAccount(id: string | null): void };
}

function controllerWith(
  fetcher: typeof fetch,
  account: AccountFlowController,
  reads: MachineReadCoordinator,
  isProfileActive?: (kind: "agent" | "provider", profileId: string) => boolean,
) {
  return new MachineCredentialController({
    account,
    reads,
    client: new MachineClient({ fetcher }),
    ...(isProfileActive === undefined ? {} : { isProfileActive }),
  });
}

const AGENT_TARGET: MachineCredentialTarget = { kind: "agent", profileId: AGENT };
const PROVIDER_TARGET: MachineCredentialTarget = { kind: "provider", profileId: PROVIDER };

function issueDraft(profileId = AGENT) {
  return { op: "issue" as const, kind: "agent" as const, profileId, expiresAt: EXPIRES };
}

describe("machine credential controller issue/revoke", () => {
  it("blocks a recovery session from issuing but allows a revoke", () => {
    const reads = fakeReads();
    const account = fakeAccount(ACCOUNT_A, "recovery");
    const controller = controllerWith(
      (async () => success(freshIssue(V4))) as unknown as typeof fetch,
      account,
      reads,
    );
    expect(controller.begin(issueDraft())).toBe(false);
    expect(controller.state).toEqual({ kind: "rejected", notice: { kind: "recovery-blocked" } });
    expect(controller.begin({ op: "revoke", kind: "agent", credentialId: V4 })).toBe(true);
  });

  it("enforces the agent/provider role boundary", () => {
    const operator = controllerWith(
      (async () => success(freshIssue(V4))) as unknown as typeof fetch,
      fakeAccount(),
      fakeReads("operator"),
    );
    expect(operator.begin(issueDraft())).toBe(true);
    operator.cancel();
    expect(
      operator.begin({ op: "issue", kind: "provider", profileId: PROVIDER, expiresAt: EXPIRES }),
    ).toBe(false);

    const viewer = controllerWith(
      (async () => success(freshIssue(V4))) as unknown as typeof fetch,
      fakeAccount(),
      fakeReads("viewer"),
    );
    expect(viewer.begin(issueDraft())).toBe(false);

    const owner = controllerWith(
      (async () => success(freshIssue(V4))) as unknown as typeof fetch,
      fakeAccount(),
      fakeReads("owner"),
    );
    expect(
      owner.begin({ op: "issue", kind: "provider", profileId: PROVIDER, expiresAt: EXPIRES }),
    ).toBe(true);
  });

  it("refuses an inactive profile issue locally and never sends", async () => {
    let fetches = 0;
    const controller = controllerWith(
      (async () => {
        fetches += 1;
        return success(freshIssue(V4));
      }) as unknown as typeof fetch,
      fakeAccount(),
      fakeReads("owner"),
      () => false,
    );
    expect(controller.begin(issueDraft())).toBe(false);
    expect(controller.state).toEqual({ kind: "rejected", notice: { kind: "inactive-profile" } });
    expect(fetches).toBe(0);
    // Revoke is still permitted for an inactive profile.
    expect(controller.begin({ op: "revoke", kind: "agent", credentialId: V4 })).toBe(true);
  });

  it("rejects a malformed expiry at begin", () => {
    const controller = controllerWith(
      (async () => success(freshIssue(V4))) as unknown as typeof fetch,
      fakeAccount(),
      fakeReads("owner"),
    );
    expect(controller.begin({ op: "issue", kind: "agent", profileId: AGENT, expiresAt: "not-a-date" })).toBe(false);
    expect(validExpiry(new Date(Date.now() + 91 * 24 * 60 * 60 * 1000).toISOString())).toBe(false);
    expect(validExpiry(new Date(Date.now() - 1000).toISOString())).toBe(false);
    expect(MACHINE_MAX_EXPIRY_DAYS).toBe(90);
  });

  it("sends exactly one request, freezes the id/key and exposes the raw credential once", async () => {
    const bodies: string[] = [];
    const keys: string[] = [];
    const fetcher = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      bodies.push(String(init?.body ?? ""));
      keys.push(String((init?.headers as Record<string, string>)["Idempotency-Key"]));
      const mutationId = (JSON.parse(String(init?.body)) as { mutationId: string }).mutationId;
      return success(freshIssue(mutationId));
    }) as unknown as typeof fetch;
    const reads = fakeReads();
    const controller = controllerWith(fetcher, fakeAccount(), reads);
    expect(controller.begin(issueDraft())).toBe(true);
    const pending = controller.confirm();
    expect(controller.state.kind).toBe("pending");
    await pending;
    expect(controller.state.kind).toBe("committed");
    expect(reads.abortCalls).toBe(1);
    expect(bodies.length).toBe(1);
    expect(keys.length).toBe(1);
    expect(bodies[0]).not.toContain(keys[0]);
    // The one-time secret is exposed exactly from the validated response.
    expect(controller.revealedCredential).toBe(AGENT_CREDENTIAL);
    // Dismissal removes it and it cannot be re-revealed.
    controller.dismissCredential();
    expect(controller.revealedCredential).toBeNull();
    if (controller.state.kind === "committed") {
      expect(controller.state.committed.availableOnce).toBeNull();
    }
  });

  it("maps a definite rejection to a fixed notice without a secret", async () => {
    const controller = controllerWith(
      (async () => errorEnvelope("POLICY_DENIED", 409)) as unknown as typeof fetch,
      fakeAccount(),
      fakeReads(),
    );
    controller.begin(issueDraft());
    await controller.confirm();
    expect(controller.state).toEqual({ kind: "rejected", notice: { kind: "policy" } });
    expect(controller.revealedCredential).toBeNull();
  });

  it("exposes no raw credential on a replayed issue", async () => {
    let issuedMutation = "";
    const controller = controllerWith(
      (async (_input: RequestInfo | URL, init?: RequestInit) => {
        issuedMutation = (JSON.parse(String(init?.body)) as { mutationId: string }).mutationId;
        return success({
          organizationId: ORG,
          replayed: true,
          receipt: agentIssueReceipt(issuedMutation),
          delivery: { status: "token_not_replayable" },
        });
      }) as unknown as typeof fetch,
      fakeAccount(),
      fakeReads(),
    );
    controller.begin(issueDraft());
    await controller.confirm();
    expect(controller.state.kind).toBe("committed");
    expect(controller.revealedCredential).toBeNull();
    if (controller.state.kind === "committed") {
      expect(controller.state.committed.replayed).toBe(true);
      expect(controller.state.committed.availableOnce).toBeNull();
    }
  });
});

describe("machine credential controller uncertain outcomes", () => {
  it("treats a lost response as unknown and keeps the original id", async () => {
    const controller = controllerWith(
      (async () => {
        throw new Error("network");
      }) as unknown as typeof fetch,
      fakeAccount(),
      fakeReads(),
    );
    controller.begin(issueDraft());
    await controller.confirm();
    expect(controller.state.kind).toBe("outcome-unknown");
    if (controller.state.kind === "outcome-unknown") {
      expect(controller.state.organizationId).toBe(ORG);
      expect(controller.state.mutationId).toMatch(/^[0-9a-f-]{36}$/u);
    }
  });

  it("checks status with the original id and keeps unknown on not_found", async () => {
    let statusCalls = 0;
    const paths: string[] = [];
    const fetcher = (async (input: RequestInfo | URL) => {
      if (String(input).includes("-credential-mutations/")) {
        statusCalls += 1;
        paths.push(String(input));
        return success({ organizationId: ORG, status: "not_found" });
      }
      throw new Error("network");
    }) as unknown as typeof fetch;
    const controller = controllerWith(fetcher, fakeAccount(), fakeReads());
    controller.begin(issueDraft());
    await controller.confirm();
    const mutationId =
      controller.state.kind === "outcome-unknown" ? controller.state.mutationId : "none";
    await controller.checkStatus();
    if (controller.state.kind === "outcome-unknown") {
      expect(controller.state.mutationId).toBe(mutationId);
      expect(controller.state.statusMessage).toBe(
        "No committed result found yet; it may still complete. Check again.",
      );
    } else {
      throw new Error("not_found must keep the outcome unknown");
    }
    expect(statusCalls).toBe(1);
    expect(paths[0]).toContain(mutationId);
    // not_found never mints a new logical id or a new write.
    expect(controller.begin(issueDraft())).toBe(true);
  });

  it("clears the draft on a committed status but never recovers the secret", async () => {
    const fetcher = (async (input: RequestInfo | URL) => {
      const match = /-credential-mutations\/([0-9a-f-]{36})$/u.exec(String(input));
      if (match !== null) {
        return success({
          organizationId: ORG,
          status: "committed",
          receipt: agentIssueReceipt(match[1] as string),
        });
      }
      throw new Error("network");
    }) as unknown as typeof fetch;
    const controller = controllerWith(fetcher, fakeAccount(), fakeReads());
    controller.begin(issueDraft());
    await controller.confirm();
    await controller.checkStatus();
    expect(controller.state.kind).toBe("committed");
    expect(controller.revealedCredential).toBeNull();
  });

  it("locks the unknown outcome to Check status with no resubmit affordance", async () => {
    const controller = controllerWith(
      (async () => {
        throw new Error("network");
      }) as unknown as typeof fetch,
      fakeAccount(),
      fakeReads(),
    );
    controller.begin(issueDraft());
    await controller.confirm();
    expect(controller.state.kind).toBe("outcome-unknown");
    expect(
      (controller as unknown as { dismissUnknown?: unknown }).dismissUnknown,
    ).toBeUndefined();
  });

  it("clears local state on account change and never sends under the new account", async () => {
    const reads = fakeReads();
    let fetches = 0;
    const account = fakeAccount();
    const controller = controllerWith(
      (async () => {
        fetches += 1;
        return success(freshIssue(V4));
      }) as unknown as typeof fetch,
      account,
      reads,
    );
    controller.begin(issueDraft());
    account.setAccount(ACCOUNT_B);
    await controller.confirm();
    expect(controller.state).toEqual({ kind: "rejected", notice: { kind: "account-changed" } });
    expect(fetches).toBe(0);
  });

  it("clears all local state on clear, hidden and dispose", () => {
    const controller = controllerWith(
      (async () => success(freshIssue(V4))) as unknown as typeof fetch,
      fakeAccount(),
      fakeReads(),
    );
    controller.begin(issueDraft());
    controller.clear();
    expect(controller.state).toEqual({ kind: "idle" });
    controller.begin(issueDraft());
    controller.dispose();
    expect(controller.disposed).toBe(true);
    expect(controller.state).toEqual({ kind: "idle" });
    expect(controller.revealedCredential).toBeNull();
  });
});

describe("machine credential controller list", () => {
  it("loads a bounded page only for the explicitly bound profile", async () => {
    const paths: string[] = [];
    const fetcher = (async (input: RequestInfo | URL) => {
      paths.push(String(input));
      return success({
        organizationId: ORG,
        kind: "agent",
        profileId: AGENT,
        items: [],
        nextCursor: null,
      });
    }) as unknown as typeof fetch;
    const controller = controllerWith(fetcher, fakeAccount(), fakeReads());
    // No selection yet: no request.
    await controller.loadCredentials();
    expect(paths).toEqual([]);
    controller.select(AGENT_TARGET);
    await controller.loadCredentials();
    expect(controller.credentialList.status).toBe("ready");
    expect(paths[0]).toContain(`/agents/${encodeURIComponent(AGENT)}/credentials?limit=50`);
  });

  it("selecting a different profile clears the previous list, receipt and secret", async () => {
    const fetcher = (async () =>
      success({
        organizationId: ORG,
        kind: "agent",
        profileId: AGENT,
        items: [],
        nextCursor: null,
      })) as unknown as typeof fetch;
    const controller = controllerWith(fetcher, fakeAccount(), fakeReads());
    controller.select(AGENT_TARGET);
    await controller.loadCredentials();
    expect(controller.credentialList.status).toBe("ready");
    controller.select(PROVIDER_TARGET);
    expect(controller.credentialList.target).toEqual(PROVIDER_TARGET);
    expect(controller.credentialList.status).toBe("none");
    expect(controller.state).toEqual({ kind: "idle" });
    expect(controller.revealedCredential).toBeNull();
  });

  it("keeps a prior page when a reload fails after commit", async () => {
    const controller = controllerWith(
      (async (_input: RequestInfo | URL, init?: RequestInit) => {
        if (init?.method === "GET") throw new Error("list down");
        const mutationId = (JSON.parse(String(init?.body)) as { mutationId: string }).mutationId;
        return success(freshIssue(mutationId));
      }) as unknown as typeof fetch,
      fakeAccount(),
      fakeReads(),
    );
    controller.select(AGENT_TARGET);
    controller.begin(issueDraft());
    await controller.confirm();
    // The commit is authoritative even though the follow-up list reload failed.
    expect(controller.state.kind).toBe("committed");
    expect(controller.revealedCredential).toBe(AGENT_CREDENTIAL);
  });

  it("drops a list response after the bound profile or organization changes", async () => {
    let resolvePage: (value: Response) => void = () => undefined;
    const fetcher = (async () =>
      new Promise<Response>((resolve) => {
        resolvePage = resolve;
      })) as unknown as typeof fetch;
    const controller = controllerWith(fetcher, fakeAccount(), fakeReads());
    controller.select(AGENT_TARGET);
    const pending = controller.loadCredentials();
    controller.select(PROVIDER_TARGET);
    resolvePage(
      success({ organizationId: ORG, kind: "agent", profileId: AGENT, items: [], nextCursor: null }),
    );
    await pending;
    // The stale agent page must not be published under the provider selection.
    expect(controller.credentialList.target).toEqual(PROVIDER_TARGET);
    expect(controller.credentialList.items).toEqual([]);
    expect(controller.credentialList.status).not.toBe("ready");
  });
});

describe("machine credential controller role and secret guards", () => {
  it("clears secret, receipt and list on a same-profile role change and does not re-show them", async () => {
    let role = "owner";
    const reads = fakeReads("owner");
    const controller = controllerWith(
      (async (_input: RequestInfo | URL, init?: RequestInit) => {
        if (init?.method === "GET") {
          return success({
            organizationId: ORG,
            kind: "agent",
            profileId: AGENT,
            items: [],
            nextCursor: null,
          });
        }
        const mutationId = (JSON.parse(String(init?.body)) as { mutationId: string }).mutationId;
        return success(freshIssue(mutationId));
      }) as unknown as typeof fetch,
      fakeAccount(),
      { ...reads, currentRole: () => role },
    );
    controller.select(AGENT_TARGET);
    await controller.loadCredentials();
    controller.begin(issueDraft());
    await controller.confirm();
    expect(controller.state.kind).toBe("committed");
    expect(controller.revealedCredential).toBe(AGENT_CREDENTIAL);
    expect(controller.credentialList.target).toEqual(AGENT_TARGET);

    // owner -> viewer: same profile selection, authority changed.
    role = "viewer";
    controller.select(AGENT_TARGET);
    expect(controller.state).toEqual({ kind: "idle" });
    expect(controller.revealedCredential).toBeNull();
    // The explicit selection is retained, but all bound data is cleared.
    expect(controller.credentialList.target).toEqual(AGENT_TARGET);
    expect(controller.credentialList.status).toBe("none");
    expect(controller.credentialList.items).toEqual([]);

    // viewer -> owner must not resurrect the previous secret or receipt.
    role = "owner";
    controller.select(AGENT_TARGET);
    expect(controller.state).toEqual({ kind: "idle" });
    expect(controller.revealedCredential).toBeNull();
    if (controller.state.kind === "committed") {
      throw new Error("a role round trip must not restore a committed receipt");
    }
  });

  it("reconcileRole invalidates state even before a reselection", async () => {
    const reads = fakeReads("owner");
    const controller = controllerWith(
      (async (_input: RequestInfo | URL, init?: RequestInit) => {
        const mutationId = (JSON.parse(String(init?.body)) as { mutationId: string }).mutationId;
        return success(freshIssue(mutationId));
      }) as unknown as typeof fetch,
      fakeAccount(),
      reads,
    );
    controller.select(AGENT_TARGET);
    controller.begin(issueDraft());
    await controller.confirm();
    expect(controller.revealedCredential).toBe(AGENT_CREDENTIAL);
    controller.reconcileRole("viewer");
    expect(controller.state).toEqual({ kind: "idle" });
    expect(controller.revealedCredential).toBeNull();
  });

  it("keeps the unknown outcome locked to the original id after an abort after send", async () => {
    let posts = 0;
    let statusCalls = 0;
    const paths: string[] = [];
    const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      paths.push(`${init?.method ?? "GET"} ${path}`);
      if (init?.method === "POST") {
        posts += 1;
        throw new DOMException("Aborted", "AbortError");
      }
      if (path.includes("-credential-mutations/")) {
        statusCalls += 1;
        return success({ organizationId: ORG, status: "not_found" });
      }
      throw new Error("network");
    }) as unknown as typeof fetch;
    const controller = controllerWith(fetcher, fakeAccount(), fakeReads());
    controller.begin(issueDraft());
    await controller.confirm();
    expect(controller.state.kind).toBe("outcome-unknown");
    const mutationId =
      controller.state.kind === "outcome-unknown" ? controller.state.mutationId : "none";
    const keyAtFreeze = mutationId;
    // There is no resubmit affordance and no extra POST.
    expect(posts).toBe(1);
    await controller.checkStatus();
    // not_found does not unlock a resend.
    expect(controller.state.kind).toBe("outcome-unknown");
    if (controller.state.kind === "outcome-unknown") {
      expect(controller.state.mutationId).toBe(mutationId);
      expect(controller.state.statusMessage).toBe(
        "No committed result found yet; it may still complete. Check again.",
      );
    }
    expect(statusCalls).toBe(1);
    expect(paths.find((entry) => entry.startsWith("GET "))).toContain(keyAtFreeze);
    expect(posts).toBe(1);
  });

  it("refuses another issue while a fresh secret is displayed, then allows it after Dismiss", async () => {
    let fetches = 0;
    const controller = controllerWith(
      (async (_input: RequestInfo | URL, init?: RequestInit) => {
        fetches += 1;
        const mutationId = (JSON.parse(String(init?.body)) as { mutationId: string }).mutationId;
        return success(freshIssue(mutationId));
      }) as unknown as typeof fetch,
      fakeAccount(),
      fakeReads(),
    );
    controller.begin(issueDraft());
    await controller.confirm();
    expect(controller.revealedCredential).toBe(AGENT_CREDENTIAL);
    // A second issue is refused and the first secret is preserved, not destroyed.
    expect(controller.begin(issueDraft())).toBe(false);
    expect(controller.revealedCredential).toBe(AGENT_CREDENTIAL);
    expect(fetches).toBe(1);
    expect(controller.state.kind).toBe("committed");
    // Explicit Dismiss clears the secret and only then can a new issue start.
    controller.dismissCredential();
    expect(controller.revealedCredential).toBeNull();
    expect(controller.begin(issueDraft())).toBe(true);
  });
});

describe("machine render context guard", () => {
  const bound: MachineRenderContext = {
    accountId: ACCOUNT_A,
    organizationId: ORG,
    role: "owner",
    kind: "agent",
    profileId: AGENT,
  };

  it("keeps the context when nothing changed and before any binding", () => {
    expect(suppressStaleMachineContext(null, bound)).toBe(false);
    expect(suppressStaleMachineContext(bound, { ...bound })).toBe(false);
  });

  it("suppresses synchronously on account, organization, role or profile change", () => {
    expect(suppressStaleMachineContext(bound, { ...bound, accountId: ACCOUNT_B })).toBe(true);
    expect(suppressStaleMachineContext(bound, { ...bound, organizationId: ORG_B })).toBe(true);
    expect(suppressStaleMachineContext(bound, { ...bound, role: "operator" })).toBe(true);
    expect(suppressStaleMachineContext(bound, { ...bound, profileId: `openarc:agent:${V4_B}` })).toBe(true);
    expect(suppressStaleMachineContext(bound, { ...bound, kind: "provider" })).toBe(true);
    expect(suppressStaleMachineContext(bound, { ...bound, accountId: null })).toBe(true);
    expect(suppressStaleMachineContext(bound, { ...bound, organizationId: null })).toBe(true);
  });
});

describe("machine credential controller initial state", () => {
  it("starts idle with no secret or list", () => {
    const controller = controllerWith(
      (async () => success(freshIssue(V4))) as unknown as typeof fetch,
      fakeAccount(),
      fakeReads(),
    );
    expect(controller.state).toEqual(initialMachineConsoleState());
    expect(controller.revealedCredential).toBeNull();
    expect(controller.credentialList.items).toEqual([]);
  });
});
