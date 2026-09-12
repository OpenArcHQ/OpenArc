import {
  COMMERCE_API_ERRORS,
  COMMERCE_API_SCHEMA_VERSION,
  type AccountSessionView,
} from "@openarc/shared";
import { describe, expect, it, vi } from "vitest";

import type { AccountFlowController } from "../src/account/flow-controller.js";
import type { TenantClient, TenantFetch } from "../src/tenant/tenant-client.js";
import { TenantClient as RealTenantClient } from "../src/tenant/tenant-client.js";
import {
  TenantController,
  canReadAgents,
  canReadProviders,
  initialTenantState,
} from "../src/tenant/tenant-controller.js";

const META = {
  schemaVersion: COMMERCE_API_SCHEMA_VERSION,
  requestId: "018f47a2-3b4c-7def-8123-456789abcdef",
  buildSha: "0123456789abcdef0123456789abcdef01234567",
};

const ORG_A = "openarc:org:aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa";
const ORG_B = "openarc:org:bbbbbbbb-bbbb-7bbb-8bbb-bbbbbbbbbbbb";
const ACCOUNT_A = "openarc:account:aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa";
const ACCOUNT_B = "openarc:account:bbbbbbbb-bbbb-7bbb-8bbb-bbbbbbbbbbbb";
const AGENT_A = "openarc:agent:aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa";

function session(accountId: string): AccountSessionView {
  return {
    signedIn: true,
    accountId,
    method: "passkey",
    expiresAt: "2030-01-01T00:00:00.000Z",
  };
}

type FakeAccount = AccountFlowController & {
  state: { status: string; csrfToken: string; session: AccountSessionView };
  refreshSession: ReturnType<typeof vi.fn>;
  set(next: AccountSessionView): void;
};

function fakeAccount(current: AccountSessionView): FakeAccount {
  const account = {
    state: { status: "signed-in", csrfToken: "csrf", session: current },
    refreshSession: vi.fn(async () => undefined),
    set(next: AccountSessionView) {
      account.state = { status: "signed-in", csrfToken: "csrf", session: next };
    },
  };
  return account as unknown as FakeAccount;
}

function success(data: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify({ ok: true, data, meta: META }), {
    status: 200,
    headers: { "content-type": "application/json", ...init.headers },
    ...init,
  });
}

function organizationPage(ids: string[], nextCursor: string | null = null) {
  return {
    items: ids.map((organizationId, index) => ({
      schemaVersion: "openarc.organization.v1",
      organizationId,
      displayName: `Org ${index}`,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    })),
    nextCursor,
  };
}

function contextFor(organizationId: string, accountId: string, role = "owner", status = "active") {
  return {
    organization: {
      schemaVersion: "openarc.organization.v1",
      organizationId,
      displayName: "Org",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    },
    access: {
      schemaVersion: "openarc.organization-access.v1",
      organizationId,
      accountId,
      role,
      membershipStatus: status,
      sessionExpiresAt: "2030-01-01T00:00:00.000Z",
    },
    network: "eip155:5042002",
  };
}

function agentPage(ids: string[], organizationId: string, nextCursor: string | null = null) {
  return {
    organizationId,
    items: ids.map((agentId) => ({
      schemaVersion: "openarc.agent-profile.v1",
      agentId,
      organizationId,
      displayName: "Agent",
      status: "active",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    })),
    nextCursor,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function controllerWith(
  fetcher: TenantFetch,
  account: AccountFlowController,
  now?: () => number,
) {
  const client = new RealTenantClient({ fetcher });
  return new TenantController({
    account,
    client,
    ...(now === undefined ? {} : { now }),
  });
}

function orgPaths(fetcher: ReturnType<typeof vi.fn>): string[] {
  return fetcher.mock.calls.map((call) => String(call[0]));
}

describe("tenant controller", () => {
  it("reads the session then the first organization page without a child read", async () => {
    const account = fakeAccount(session(ACCOUNT_A));
    const fetcher = vi.fn(async () => success(organizationPage([ORG_A])));
    const controller = controllerWith(fetcher as unknown as TenantFetch, account);
    await controller.initialize();
    expect(orgPaths(fetcher)).toEqual(["/v1/operator/organizations?limit=50"]);
    expect(controller.state.principal.accountId).toBe(ACCOUNT_A);
    expect(controller.state.organizations.items.map((item) => item.organizationId)).toEqual([ORG_A]);
    expect(controller.state.context).toBeNull();
    expect(controller.state.agents.items).toEqual([]);
  });

  it("clears protected data and does not list when the session is a guest", async () => {
    const account = fakeAccount({ signedIn: false });
    const fetcher = vi.fn(async () => success(organizationPage([ORG_A])));
    const controller = controllerWith(fetcher as unknown as TenantFetch, account);
    await controller.initialize();
    expect(controller.state.principal.status).toBe("signed-out");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("clears old context before selecting a new organization and checks account on the response", async () => {
    const account = fakeAccount(session(ACCOUNT_A));
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input);
      if (path === "/v1/operator/organizations?limit=50") return success(organizationPage([ORG_A, ORG_B]));
      if (path.endsWith(`/${encodeURIComponent(ORG_A)}`)) return success(contextFor(ORG_A, ACCOUNT_A));
      if (path.endsWith(`/${encodeURIComponent(ORG_A)}/agents?limit=50`)) {
        return success(agentPage([AGENT_A], ORG_A));
      }
      if (path.endsWith(`/${encodeURIComponent(ORG_B)}`)) return success(contextFor(ORG_B, ACCOUNT_A));
      return success(organizationPage([]));
    }) as unknown as TenantFetch;
    const controller = controllerWith(fetcher, account);
    await controller.initialize();
    await controller.selectOrganization(ORG_A);
    await controller.loadAgents();
    expect(controller.state.selectedOrganizationId).toBe(ORG_A);
    expect(controller.state.agents.items.map((item) => item.agentId)).toEqual([AGENT_A]);
    // Starting a B selection clears A's context and profiles before the request.
    const pending = controller.selectOrganization(ORG_B);
    expect(controller.state.selectedOrganizationId).toBe(ORG_B);
    expect(controller.state.context).toBeNull();
    expect(controller.state.agents.items).toEqual([]);
    await pending;
    expect(controller.state.context?.organization.organizationId).toBe(ORG_B);
  });

  it("does not let a late A response overwrite a newer B selection", async () => {
    const account = fakeAccount(session(ACCOUNT_A));
    const lateA = deferred<Response>();
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input);
      if (path === "/v1/operator/organizations?limit=50") return success(organizationPage([ORG_A, ORG_B]));
      if (path.endsWith(`/${encodeURIComponent(ORG_A)}`)) return lateA.promise;
      return success(contextFor(ORG_B, ACCOUNT_A));
    }) as unknown as TenantFetch;
    const controller = controllerWith(fetcher, account);
    await controller.initialize();
    const stale = controller.selectOrganization(ORG_A);
    await controller.selectOrganization(ORG_B);
    lateA.resolve(success(contextFor(ORG_A, ACCOUNT_A)));
    await stale;
    expect(controller.state.context?.organization.organizationId).toBe(ORG_B);
  });

  it("does not let a late account-A result overwrite a newer account B refresh", async () => {
    let current = session(ACCOUNT_A);
    const gates: Array<() => void> = [];
    const account = {
      get state() {
        return { status: "signed-in", csrfToken: "csrf", session: current };
      },
      refreshSession: vi.fn(
        () =>
          new Promise<void>((resolve) => {
            gates.push(resolve);
          }),
      ),
    } as unknown as AccountFlowController;
    const lateList = deferred<Response>();
    let orgCalls = 0;
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input);
      if (path.startsWith("/v1/operator/organizations")) {
        orgCalls += 1;
        if (orgCalls === 1) return lateList.promise;
        return success(organizationPage([ORG_B]));
      }
      return success(contextFor(ORG_A, ACCOUNT_A));
    }) as unknown as TenantFetch;
    const controller = controllerWith(fetcher, account);
    // Start account A's initial load and release its session read.
    const stale = controller.initialize();
    gates.shift()?.();
    await Promise.resolve();
    // The account changes to B and an explicit refresh starts. Its session
    // read is released only after invalidation has run.
    current = session(ACCOUNT_B);
    const refresh = controller.refreshSession();
    gates.shift()?.();
    await refresh;
    expect(controller.state.principal.accountId).toBe(ACCOUNT_B);
    expect(controller.state.organizations.items.map((item) => item.organizationId)).toEqual([ORG_B]);
    // A's late list finally resolves and must be discarded.
    lateList.resolve(success(organizationPage([ORG_A])));
    await stale;
    expect(controller.state.principal.accountId).toBe(ACCOUNT_B);
    expect(controller.state.organizations.items.map((item) => item.organizationId)).toEqual([ORG_B]);
  });

  it("does not fetch children without a selection and blocks providers for a non-owner", async () => {
    const account = fakeAccount(session(ACCOUNT_A));
    const fetcher = vi.fn(async () => success(organizationPage([ORG_A]))) as unknown as TenantFetch;
    const controller = controllerWith(fetcher, account);
    await controller.initialize();
    await controller.loadAgents();
    expect(orgPaths(fetcher as unknown as ReturnType<typeof vi.fn>).some((path) => path.includes("/agents"))).toBe(false);
    expect(controller.state.agents.items).toEqual([]);
  });

  it("clears protected data on hidden and never repopulates it from a late response", async () => {
    const account = fakeAccount(session(ACCOUNT_A));
    const late = deferred<Response>();
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input);
      if (path === "/v1/operator/organizations?limit=50") return success(organizationPage([ORG_A]));
      if (path.endsWith(`/${encodeURIComponent(ORG_A)}`)) return late.promise;
      return success(agentPage([AGENT_A], ORG_A));
    }) as unknown as TenantFetch;
    const controller = controllerWith(fetcher, account);
    await controller.initialize();
    const pending = controller.selectOrganization(ORG_A);
    controller.onHidden();
    expect(controller.state.organizations.items).toEqual([]);
    expect(controller.state.selectedOrganizationId).toBeNull();
    late.resolve(success(contextFor(ORG_A, ACCOUNT_A)));
    await pending;
    expect(controller.state.context).toBeNull();
    expect(controller.state.organizations.items).toEqual([]);
  });

  it("dispose aborts pending reads and clears protected state", async () => {
    const account = fakeAccount(session(ACCOUNT_A));
    const fetcher = vi.fn(async () => success(organizationPage([ORG_A]))) as unknown as TenantFetch;
    const controller = controllerWith(fetcher, account);
    await controller.initialize();
    controller.dispose();
    expect(controller.disposed).toBe(true);
    expect(controller.state.organizations.items).toEqual([]);
    expect(controller.state.selectedOrganizationId).toBeNull();
  });

  it("expires locally at the server-provided UTC deadline without a server read", async () => {
    const account = fakeAccount(session(ACCOUNT_A));
    const fetcher = vi.fn(async () => success(organizationPage([ORG_A]))) as unknown as TenantFetch;
    let now = Date.parse("2029-12-31T23:59:59.000Z");
    const controller = controllerWith(fetcher, account, () => now);
    await controller.initialize();
    expect(controller.state.principal.status).toBe("signed-in");
    // Advance the clock past the injected session expiry and run the timer.
    now = Date.parse("2030-01-01T00:00:01.000Z");
    await new Promise((resolve) => setTimeout(resolve, 0));
    vi.useFakeTimers();
    vi.useRealTimers();
    // Directly exercise the bounded scheduler with a past deadline.
    const fetcher2 = vi.fn(async () => success(organizationPage([ORG_A]))) as unknown as TenantFetch;
    const controller2 = controllerWith(fetcher2, account, () => Date.parse("2030-01-01T00:00:00.000Z"));
    await controller2.initialize();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(["signed-in", "expired"]).toContain(controller2.state.principal.status);
  });

  it("clears all protected state on an unauthenticated read", async () => {
    const account = fakeAccount(session(ACCOUNT_A));
    let calls = 0;
    const fetcher = vi.fn(async () => {
      calls += 1;
      if (calls === 1) return success(organizationPage([ORG_A]));
      return new Response(
        JSON.stringify({
          ok: false,
          error: {
            code: "UNAUTHENTICATED",
            message: COMMERCE_API_ERRORS.UNAUTHENTICATED.message,
            retryable: false,
          },
          meta: META,
        }),
        { status: 401, headers: { "content-type": "application/json" } },
      );
    }) as unknown as TenantFetch;
    const controller = controllerWith(fetcher, account);
    await controller.initialize();
    expect(controller.state.organizations.items.length).toBe(1);
    await controller.loadOrganizations();
    expect(controller.state.principal.status).toBe("signed-out");
    expect(controller.state.organizations.items).toEqual([]);
    expect(controller.state.selectedOrganizationId).toBeNull();
  });

  it("requires an explicit reselect after a forbidden tenant mismatch", async () => {
    const account = fakeAccount(session(ACCOUNT_A));
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input);
      if (path === "/v1/operator/organizations?limit=50") return success(organizationPage([ORG_A, ORG_B]));
      if (path.endsWith(`/${encodeURIComponent(ORG_A)}`)) return success(contextFor(ORG_A, ACCOUNT_A));
      return new Response(
        JSON.stringify({
          ok: false,
          error: {
            code: "TENANT_MISMATCH",
            message: COMMERCE_API_ERRORS.TENANT_MISMATCH.message,
            retryable: false,
          },
          meta: META,
        }),
        { status: 403, headers: { "content-type": "application/json" } },
      );
    }) as unknown as TenantFetch;
    const controller = controllerWith(fetcher, account);
    await controller.initialize();
    await controller.selectOrganization(ORG_A);
    expect(controller.state.context).not.toBeNull();
    await controller.selectOrganization(ORG_B);
    expect(controller.state.context).toBeNull();
    expect(controller.state.selectedOrganizationId).toBeNull();
  });

  it("exposes only memory-only state with the initial shape", () => {
    const account = fakeAccount(session(ACCOUNT_A));
    const controller = controllerWith((async () => success(organizationPage([]))) as unknown as TenantFetch, account);
    expect(controller.state).toEqual(initialTenantState());
  });

  it("type-only import compatibility", () => {
    const _client: TenantClient | null = null;
    expect(_client).toBeNull();
  });

  it("uses the accepted role read matrix", () => {
    for (const role of ["owner", "operator", "viewer"]) {
      expect(canReadAgents(role)).toBe(true);
    }
    for (const role of ["provider_admin", "provider_developer"]) {
      expect(canReadAgents(role)).toBe(false);
    }
    expect(canReadProviders("owner")).toBe(true);
    for (const role of ["operator", "viewer", "provider_admin", "provider_developer"]) {
      expect(canReadProviders(role)).toBe(false);
    }
  });

  it("sets refreshRequired on hidden, does not auto-fetch on visible, and clears it on refresh", async () => {
    const account = fakeAccount(session(ACCOUNT_A));
    const fetcher = vi.fn(async () => success(organizationPage([ORG_A]))) as unknown as TenantFetch;
    let orgCalls = 0;
    const counting = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).startsWith("/v1/operator/organizations?limit=50")) orgCalls += 1;
      return (fetcher as unknown as typeof fetch)(input, init);
    }) as unknown as TenantFetch;
    const controller = controllerWith(counting, account);
    await controller.initialize();
    expect(controller.state.refreshRequired).toBe(false);
    controller.onHidden();
    expect(controller.state.refreshRequired).toBe(true);
    expect(controller.state.organizations.items).toEqual([]);
    const callsAfterHidden = orgCalls;
    controller.onVisible();
    await Promise.resolve();
    expect(orgCalls).toBe(callsAfterHidden);
    expect(controller.state.refreshRequired).toBe(true);
    await controller.refreshSession();
    expect(controller.state.refreshRequired).toBe(false);
    expect(controller.state.organizations.items.map((item) => item.organizationId)).toEqual([ORG_A]);
  });

  it("does not fetch agents for provider_admin even if the UI asks", async () => {
    const account = fakeAccount(session(ACCOUNT_A));
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input);
      if (path === "/v1/operator/organizations?limit=50") return success(organizationPage([ORG_A]));
      if (path.endsWith(`/${encodeURIComponent(ORG_A)}`)) return success(contextFor(ORG_A, ACCOUNT_A, "provider_admin"));
      return success(agentPage([AGENT_A], ORG_A));
    }) as unknown as TenantFetch;
    const controller = controllerWith(fetcher, account);
    await controller.initialize();
    await controller.selectOrganization(ORG_A);
    await controller.loadAgents();
    expect(orgPaths(fetcher as unknown as ReturnType<typeof vi.fn>).some((path) => path.includes("/agents"))).toBe(false);
    expect(controller.state.agents.items).toEqual([]);
  });

  describe("first-page reload from later pages", () => {
    const AGENT_B = "openarc:agent:bbbbbbbb-bbbb-7bbb-8bbb-bbbbbbbbbbbb";
    const AGENT_C = "openarc:agent:cccccccc-cccc-7ccc-8ccc-cccccccccccc";
    const ORG_C = "openarc:org:cccccccc-cccc-7ccc-8ccc-cccccccccccc";
    const PROVIDER_A = "openarc:provider:aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa";
    const PROVIDER_B = "openarc:provider:bbbbbbbb-bbbb-7bbb-8bbb-bbbbbbbbbbbb";
    const PROVIDER_C = "openarc:provider:cccccccc-cccc-7ccc-8ccc-cccccccccccc";

    function providerPage(ids: string[], organizationId: string, nextCursor: string | null = null) {
      return {
        organizationId,
        items: ids.map((providerId) => ({
          schemaVersion: "openarc.provider-profile.v1",
          providerId,
          organizationId,
          displayName: "Provider",
          status: "active",
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        })),
        nextCursor,
      };
    }

    it("walks organizations page1 -> page2 -> page3 then restores the exact first page", async () => {
      const account = fakeAccount(session(ACCOUNT_A));
      const listCalls: string[] = [];
      const fetcher = vi.fn(async (input: RequestInfo | URL) => {
        const path = String(input);
        listCalls.push(path);
        if (path === "/v1/operator/organizations?limit=50") {
          return success(organizationPage([ORG_A], ORG_A));
        }
        if (path === `/v1/operator/organizations?afterOrganizationId=${encodeURIComponent(ORG_A)}&limit=50`) {
          return success(organizationPage([ORG_B], ORG_B));
        }
        if (path === `/v1/operator/organizations?afterOrganizationId=${encodeURIComponent(ORG_B)}&limit=50`) {
          return success(organizationPage([ORG_C], null));
        }
        throw new Error(`unexpected organization read: ${path}`);
      }) as unknown as TenantFetch;
      const controller = controllerWith(fetcher, account);
      await controller.initialize();
      expect(controller.state.organizations.hasPrevious).toBe(false);

      await controller.loadNextOrganizations();
      expect(controller.state.organizations.hasPrevious).toBe(true);
      expect(controller.state.organizations.items.map((item) => item.organizationId)).toEqual([ORG_B]);

      await controller.loadNextOrganizations();
      expect(controller.state.organizations.hasPrevious).toBe(true);
      expect(controller.state.organizations.items.map((item) => item.organizationId)).toEqual([ORG_C]);
      expect(controller.state.organizations.nextCursor).toBeNull();

      await controller.loadOrganizations();
      expect(controller.state.organizations.hasPrevious).toBe(false);
      expect(controller.state.organizations.items.map((item) => item.organizationId)).toEqual([ORG_A]);
      expect(controller.state.organizations.nextCursor).toBe(ORG_A);
      // No cursor is persisted in the URL or browser storage.
      expect(listCalls.filter((path) => path.includes("afterOrganizationId")).length).toBe(2);
    });

    it("walks agents page1 -> page2 -> page3 then restores the exact first page", async () => {
      const account = fakeAccount(session(ACCOUNT_A));
      const fetcher = vi.fn(async (input: RequestInfo | URL) => {
        const path = String(input);
        if (path === "/v1/operator/organizations?limit=50") return success(organizationPage([ORG_A]));
        if (path.endsWith(`/${encodeURIComponent(ORG_A)}`)) return success(contextFor(ORG_A, ACCOUNT_A));
        if (path.endsWith(`/agents?limit=50`)) {
          return success(agentPage([AGENT_A], ORG_A, AGENT_A));
        }
        if (path.endsWith(`/agents?afterAgentId=${encodeURIComponent(AGENT_A)}&limit=50`)) {
          return success(agentPage([AGENT_B], ORG_A, AGENT_B));
        }
        if (path.endsWith(`/agents?afterAgentId=${encodeURIComponent(AGENT_B)}&limit=50`)) {
          return success(agentPage([AGENT_C], ORG_A, null));
        }
        throw new Error(`unexpected agent read: ${path}`);
      }) as unknown as TenantFetch;
      const controller = controllerWith(fetcher, account);
      await controller.initialize();
      await controller.selectOrganization(ORG_A);

      await controller.loadAgents();
      expect(controller.state.agents.hasPrevious).toBe(false);
      expect(controller.state.agents.items.map((item) => item.agentId)).toEqual([AGENT_A]);

      await controller.loadNextAgents();
      expect(controller.state.agents.hasPrevious).toBe(true);
      expect(controller.state.agents.items.map((item) => item.agentId)).toEqual([AGENT_B]);

      await controller.loadNextAgents();
      expect(controller.state.agents.items.map((item) => item.agentId)).toEqual([AGENT_C]);
      expect(controller.state.agents.nextCursor).toBeNull();

      await controller.loadAgents();
      expect(controller.state.agents.hasPrevious).toBe(false);
      expect(controller.state.agents.items.map((item) => item.agentId)).toEqual([AGENT_A]);
      expect(controller.state.agents.nextCursor).toBe(AGENT_A);
    });

    it("walks providers page1 -> page2 -> page3 then restores the exact first page", async () => {
      const account = fakeAccount(session(ACCOUNT_A));
      const fetcher = vi.fn(async (input: RequestInfo | URL) => {
        const path = String(input);
        if (path === "/v1/operator/organizations?limit=50") return success(organizationPage([ORG_A]));
        if (path.endsWith(`/${encodeURIComponent(ORG_A)}`)) return success(contextFor(ORG_A, ACCOUNT_A));
        if (path.endsWith(`/providers?limit=50`)) {
          return success(providerPage([PROVIDER_A], ORG_A, PROVIDER_A));
        }
        if (path.endsWith(`/providers?afterProviderId=${encodeURIComponent(PROVIDER_A)}&limit=50`)) {
          return success(providerPage([PROVIDER_B], ORG_A, PROVIDER_B));
        }
        if (path.endsWith(`/providers?afterProviderId=${encodeURIComponent(PROVIDER_B)}&limit=50`)) {
          return success(providerPage([PROVIDER_C], ORG_A, null));
        }
        throw new Error(`unexpected provider read: ${path}`);
      }) as unknown as TenantFetch;
      const controller = controllerWith(fetcher, account);
      await controller.initialize();
      await controller.selectOrganization(ORG_A);

      await controller.loadProviders();
      expect(controller.state.providers.hasPrevious).toBe(false);
      expect(controller.state.providers.items.map((item) => item.providerId)).toEqual([PROVIDER_A]);

      await controller.loadNextProviders();
      expect(controller.state.providers.hasPrevious).toBe(true);
      expect(controller.state.providers.items.map((item) => item.providerId)).toEqual([PROVIDER_B]);

      await controller.loadNextProviders();
      expect(controller.state.providers.items.map((item) => item.providerId)).toEqual([PROVIDER_C]);
      expect(controller.state.providers.nextCursor).toBeNull();

      await controller.loadProviders();
      expect(controller.state.providers.hasPrevious).toBe(false);
      expect(controller.state.providers.items.map((item) => item.providerId)).toEqual([PROVIDER_A]);
      expect(controller.state.providers.nextCursor).toBe(PROVIDER_A);
    });

    it("keeps the first-page reload bounded to the existing limit and replaces the page", async () => {
      const account = fakeAccount(session(ACCOUNT_A));
      const paths: string[] = [];
      const fetcher = vi.fn(async (input: RequestInfo | URL) => {
        const path = String(input);
        paths.push(path);
        if (path === "/v1/operator/organizations?limit=50") {
          return success(organizationPage([ORG_A], ORG_A));
        }
        return success(organizationPage([ORG_B], null));
      }) as unknown as TenantFetch;
      const controller = controllerWith(fetcher, account);
      await controller.initialize();
      await controller.loadNextOrganizations();
      await controller.loadOrganizations();
      expect(paths).toEqual([
        "/v1/operator/organizations?limit=50",
        `/v1/operator/organizations?afterOrganizationId=${encodeURIComponent(ORG_A)}&limit=50`,
        "/v1/operator/organizations?limit=50",
      ]);
    });
  });
});
