import {
  API_CLIENT_HEADER,
  API_MAX_RESPONSE_BYTES,
  COMMERCE_API_ERRORS,
  COMMERCE_API_SCHEMA_VERSION,
} from "@openarc/shared";
import { describe, expect, it, vi } from "vitest";

import { TenantApiError, TenantClient } from "../src/tenant/tenant-client.js";

const META = {
  schemaVersion: COMMERCE_API_SCHEMA_VERSION,
  requestId: "018f47a2-3b4c-7def-8123-456789abcdef",
  buildSha: "0123456789abcdef0123456789abcdef01234567",
};

const ORG_A = "openarc:org:aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa";
const ORG_B = "openarc:org:bbbbbbbb-bbbb-7bbb-8bbb-bbbbbbbbbbbb";
const ACCOUNT_A = "openarc:account:aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa";

function success(data: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify({ ok: true, data, meta: META }), {
    status: 200,
    headers: { "content-type": "application/json", ...init.headers },
    ...init,
  });
}

function errorEnvelope(code: keyof typeof COMMERCE_API_ERRORS, status: number): Response {
  return new Response(
    JSON.stringify({
      ok: false,
      error: {
        code,
        message: COMMERCE_API_ERRORS[code].message,
        retryable: false,
      },
      meta: META,
    }),
    { status, headers: { "content-type": "application/json" } },
  );
}

function organizationPage(items: Array<{ organizationId: string }>, nextCursor: string | null = null) {
  return {
    items: items.map((item, index) => ({
      schemaVersion: "openarc.organization.v1",
      organizationId: item.organizationId,
      displayName: `Org ${index}`,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    })),
    nextCursor,
  };
}

describe("tenant read client", () => {
  it("sends a relative same-origin GET with only the client header", async () => {
    const fetcher = vi.fn(async () => success(organizationPage([])));
    const client = new TenantClient({ fetcher: fetcher as unknown as typeof fetch });
    const page = await client.listOrganizations({}, new AbortController().signal);
    expect(page).toEqual({ items: [], nextCursor: null });
    expect(fetcher).toHaveBeenCalledWith("/v1/operator/organizations", {
      method: "GET",
      headers: { "X-OpenArc-Client": API_CLIENT_HEADER },
      credentials: "same-origin",
      cache: "no-store",
      redirect: "error",
      referrerPolicy: "no-referrer",
      signal: expect.any(AbortSignal),
    });
  });

  it("builds canonical query strings from known keys only", async () => {
    const fetcher = vi.fn(async () => success(organizationPage([])));
    const client = new TenantClient({ fetcher: fetcher as unknown as typeof fetch });
    await client.listOrganizations(
      { afterOrganizationId: ORG_A, limit: 25 },
      new AbortController().signal,
    );
    expect(fetcher).toHaveBeenCalledWith(
      `/v1/operator/organizations?afterOrganizationId=${encodeURIComponent(ORG_A)}&limit=25`,
      expect.anything(),
    );
  });

  it("encodes a validated organization id exactly once and never a freeform path", async () => {
    const fetcher = vi.fn(async () =>
      success({
        organization: {
          schemaVersion: "openarc.organization.v1",
          organizationId: ORG_A,
          displayName: "Org A",
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
        access: {
          schemaVersion: "openarc.organization-access.v1",
          organizationId: ORG_A,
          accountId: ACCOUNT_A,
          role: "owner",
          membershipStatus: "active",
          sessionExpiresAt: "2030-01-01T00:00:00.000Z",
        },
        network: "eip155:5042002",
      }),
    );
    const client = new TenantClient({ fetcher: fetcher as unknown as typeof fetch });
    await client.readOrganizationContext({ organizationId: ORG_A }, new AbortController().signal);
    expect(fetcher).toHaveBeenCalledWith(
      `/v1/operator/organizations/${encodeURIComponent(ORG_A)}`,
      expect.anything(),
    );
    await expect(
      client.readOrganizationContext(
        { organizationId: "../evil" as never },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ failure: { kind: "invalid-response" } });
  });

  it("rejects a page whose organizationId does not match the requested org", async () => {
    const fetcher = vi.fn(async () =>
      success({
        organizationId: ORG_B,
        items: [
          {
            schemaVersion: "openarc.agent-profile.v1",
            agentId: "openarc:agent:aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa",
            organizationId: ORG_B,
            displayName: "Agent",
            status: "active",
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
          },
        ],
        nextCursor: null,
      }),
    );
    const client = new TenantClient({ fetcher: fetcher as unknown as typeof fetch });
    await expect(
      client.listAgents({ organizationId: ORG_A }, new AbortController().signal),
    ).rejects.toMatchObject({ failure: { kind: "invalid-response" } });
  });

  it("enforces the requested page length and a strictly-advancing cursor", async () => {
    const agent = (id: string, organizationId = ORG_A) => ({
      schemaVersion: "openarc.agent-profile.v1",
      agentId: id,
      organizationId,
      displayName: "Agent",
      status: "active",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    const A1 = "openarc:agent:aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa";
    const A2 = "openarc:agent:bbbbbbbb-bbbb-7bbb-8bbb-bbbbbbbbbbbb";
    const clientOf = (data: unknown) =>
      new TenantClient({
        fetcher: (async () => success(data)) as unknown as typeof fetch,
      });
    // More items than requested.
    await expect(
      clientOf({ organizationId: ORG_A, items: [agent(A1), agent(A2)], nextCursor: null }).listAgents(
        { organizationId: ORG_A, limit: 1 },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ failure: { kind: "invalid-response" } });
    // A cursor at or before the requested after id is a replay.
    await expect(
      clientOf({ organizationId: ORG_A, items: [agent(A1)], nextCursor: null }).listAgents(
        { organizationId: ORG_A, afterAgentId: A2, limit: 50 },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ failure: { kind: "invalid-response" } });
  });

  it("maps canonical error codes to fixed local failures without echoing text", async () => {
    const cases: Array<[keyof typeof COMMERCE_API_ERRORS, number, string]> = [
      ["UNAUTHENTICATED", 401, "unauthenticated"],
      ["FORBIDDEN", 403, "forbidden"],
      ["TENANT_MISMATCH", 403, "forbidden"],
      ["FEATURE_DISABLED", 404, "feature-disabled"],
      ["SOURCE_UNAVAILABLE", 503, "unavailable"],
      ["INTERNAL_ERROR", 500, "unavailable"],
    ];
    for (const [code, status, kind] of cases) {
      const client = new TenantClient({
        fetcher: (async () => errorEnvelope(code, status)) as unknown as typeof fetch,
      });
      await expect(
        client.listOrganizations({}, new AbortController().signal),
      ).rejects.toMatchObject({ failure: { kind } });
    }
  });

  it("rejects a wrong schema version, extra success keys and a private extra field", async () => {
    const bodies = [
      { ok: true, data: organizationPage([]), meta: { ...META, schemaVersion: "openarc.api.v1" } },
      { ok: true, data: organizationPage([]), meta: META, extra: 1 },
      {
        ok: true,
        data: {
          items: [
            {
              schemaVersion: "openarc.organization.v1",
              organizationId: ORG_A,
              displayName: "Org",
              createdAt: "2026-01-01T00:00:00.000Z",
              updatedAt: "2026-01-01T00:00:00.000Z",
              privateKey: "PRIVATE_CANARY",
            },
          ],
          nextCursor: null,
        },
        meta: META,
      },
    ];
    for (const body of bodies) {
      const client = new TenantClient({
        fetcher: (async () =>
          new Response(JSON.stringify(body), {
            headers: { "content-type": "application/json" },
          })) as unknown as typeof fetch,
      });
      await expect(
        client.listOrganizations({}, new AbortController().signal),
      ).rejects.toBeInstanceOf(TenantApiError);
    }
  });

  it("rejects non-JSON media, oversized declared bytes and truncated bodies", async () => {
    const nonJson = new TenantClient({
      fetcher: (async () =>
        new Response("{}", { headers: { "content-type": "text/html" } })) as unknown as typeof fetch,
    });
    await expect(
      nonJson.listOrganizations({}, new AbortController().signal),
    ).rejects.toMatchObject({ failure: { kind: "invalid-response" } });

    const oversized = new TenantClient({
      fetcher: (async () =>
        success(organizationPage([]), {
          headers: { "content-length": String(API_MAX_RESPONSE_BYTES + 1) },
        })) as unknown as typeof fetch,
    });
    await expect(
      oversized.listOrganizations({}, new AbortController().signal),
    ).rejects.toMatchObject({ failure: { kind: "invalid-response" } });

    const truncated = new TenantClient({
      fetcher: (async () =>
        new Response('{"ok":true,"data":{"ite', {
          headers: { "content-type": "application/json" },
        })) as unknown as typeof fetch,
    });
    await expect(
      truncated.listOrganizations({}, new AbortController().signal),
    ).rejects.toMatchObject({ failure: { kind: "invalid-response" } });
  });

  it("treats a transport failure after send as unavailable and aborted as aborted", async () => {
    const failing = new TenantClient({
      fetcher: (async () => {
        throw new Error("PRIVATE_CANARY");
      }) as unknown as typeof fetch,
    });
    await expect(
      failing.listOrganizations({}, new AbortController().signal),
    ).rejects.toMatchObject({ failure: { kind: "unavailable" } });

    const abort = new AbortController();
    abort.abort();
    const fetcher = vi.fn(async () => success(organizationPage([])));
    const client = new TenantClient({ fetcher: fetcher as unknown as typeof fetch });
    await expect(client.listOrganizations({}, abort.signal)).rejects.toMatchObject({
      failure: { kind: "aborted" },
    });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("does not retry a failed read", async () => {
    let calls = 0;
    const client = new TenantClient({
      fetcher: (async () => {
        calls += 1;
        return errorEnvelope("INTERNAL_ERROR", 500);
      }) as unknown as typeof fetch,
    });
    await expect(
      client.listOrganizations({}, new AbortController().signal),
    ).rejects.toBeDefined();
    expect(calls).toBe(1);
  });
});
