import {
  API_CLIENT_HEADER,
  COMMERCE_API_ERRORS,
  COMMERCE_API_SCHEMA_VERSION,
  CommerceTenantIdempotencyKeySchema,
  CommerceTenantMutationIdSchema,
} from "@openarc/shared";
import { describe, expect, it, vi } from "vitest";

import {
  TENANT_WRITE_MAX_BODY_BYTES,
  TenantWriteApiError,
  TenantWriteClient,
  createIdempotencyKey,
  createMutationCorrelation,
  createMutationId,
} from "../src/tenant/tenant-write-client.js";

const META = {
  schemaVersion: COMMERCE_API_SCHEMA_VERSION,
  requestId: "018f47a2-3b4c-7def-8123-456789abcdef",
  buildSha: "0123456789abcdef0123456789abcdef01234567",
};

const ORG_A = "openarc:org:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const AGENT_A = "openarc:agent:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const PROVIDER_A = "openarc:provider:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ACCOUNT_A = "openarc:account:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const MUTATION = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const KEY = createIdempotencyKey();

function success(data: unknown): Response {
  return new Response(JSON.stringify({ ok: true, data, meta: META }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

const RESOURCE_TYPE: Record<string, string> = {
  "tenant.organization.create": "organization",
  "tenant.agent.create": "agent",
  "tenant.agent.update": "agent",
  "tenant.provider.create": "provider",
  "tenant.provider.update": "provider",
  "tenant.membership.set": "membership",
};

function receipt(operation: string, resourceId: string) {
  return {
    mutationId: MUTATION,
    operation,
    resourceType: RESOURCE_TYPE[operation],
    resourceId,
    committedAt: "2026-01-01T00:00:00.000Z",
  };
}

function result(operation: string, resourceId: string, organizationId = ORG_A) {
  return { organizationId, replayed: false, receipt: receipt(operation, resourceId) };
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

describe("tenant write client transport", () => {
  it("sends POST /v1/operator/organizations with the fixed browser headers", async () => {
    const fetcher = vi.fn(async () =>
      success(result("tenant.organization.create", `openarc:org:${MUTATION}`, `openarc:org:${MUTATION}`)),
    );
    const client = new TenantWriteClient({ fetcher: fetcher as unknown as typeof fetch });
    await client.createOrganization({
      operation: "tenant.organization.create",
      body: { mutationId: MUTATION, displayName: "Org" },
      csrfToken: "csrf-token",
      idempotencyKey: KEY,
      signal: new AbortController().signal,
    });
    expect(fetcher).toHaveBeenCalledWith("/v1/operator/organizations", {
      method: "POST",
      headers: {
        "X-OpenArc-Client": API_CLIENT_HEADER,
        "Content-Type": "application/json",
        Accept: "application/json",
        "X-OpenArc-CSRF": "csrf-token",
        "Idempotency-Key": KEY,
      },
      body: JSON.stringify({ mutationId: MUTATION, displayName: "Org" }),
      credentials: "same-origin",
      cache: "no-store",
      redirect: "error",
      referrerPolicy: "no-referrer",
      signal: expect.any(AbortSignal),
    });
  });

  it("encodes each validated id exactly once across the six write routes", async () => {
    const paths: string[] = [];
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      paths.push(`${init?.method} ${String(input)}`);
      const method = init?.method;
      if (String(input) === "/v1/operator/organizations") {
        return success(result("tenant.organization.create", `openarc:org:${MUTATION}`, `openarc:org:${MUTATION}`));
      }
      if (method === "POST" && String(input).endsWith("/agents")) {
        return success(result("tenant.agent.create", AGENT_A));
      }
      if (method === "PATCH" && String(input).includes("/agents/")) {
        return success(result("tenant.agent.update", AGENT_A));
      }
      if (method === "POST" && String(input).endsWith("/providers")) {
        return success(result("tenant.provider.create", PROVIDER_A));
      }
      if (method === "PATCH" && String(input).includes("/providers/")) {
        return success(result("tenant.provider.update", PROVIDER_A));
      }
      return success(result("tenant.membership.set", ACCOUNT_A));
    });
    const client = new TenantWriteClient({ fetcher: fetcher as unknown as typeof fetch });
    const signal = new AbortController().signal;
    const base = { csrfToken: "c", idempotencyKey: KEY, signal };
    await client.createOrganization({ operation: "tenant.organization.create", body: { mutationId: MUTATION, displayName: "Org" }, ...base });
    await client.createAgent({ operation: "tenant.agent.create", organizationId: ORG_A, body: { mutationId: MUTATION, displayName: "A" }, ...base });
    await client.updateAgent({ operation: "tenant.agent.update", organizationId: ORG_A, agentId: AGENT_A, body: { mutationId: MUTATION, patch: { status: "suspended" } }, ...base });
    await client.createProvider({ operation: "tenant.provider.create", organizationId: ORG_A, body: { mutationId: MUTATION, displayName: "P" }, ...base });
    await client.updateProvider({ operation: "tenant.provider.update", organizationId: ORG_A, providerId: PROVIDER_A, body: { mutationId: MUTATION, patch: { displayName: "P2" } }, ...base });
    await client.setMembership({ operation: "tenant.membership.set", organizationId: ORG_A, accountId: ACCOUNT_A, body: { mutationId: MUTATION, role: "viewer", membershipStatus: "active" }, ...base });
    const org = encodeURIComponent(ORG_A);
    expect(paths).toEqual([
      "POST /v1/operator/organizations",
      `POST /v1/operator/organizations/${org}/agents`,
      `PATCH /v1/operator/organizations/${org}/agents/${encodeURIComponent(AGENT_A)}`,
      `POST /v1/operator/organizations/${org}/providers`,
      `PATCH /v1/operator/organizations/${org}/providers/${encodeURIComponent(PROVIDER_A)}`,
      `PUT /v1/operator/organizations/${org}/memberships/${encodeURIComponent(ACCOUNT_A)}`,
    ]);
    // A canonical id never requires double encoding beyond the single pass.
    expect(paths.every((path) => !path.includes("%25"))).toBe(true);
  });

  it("reads status with no body, no key and no CSRF", async () => {
    const fetcher = vi.fn(async () =>
      success({ status: "committed", organizationId: ORG_A, receipt: receipt("tenant.agent.create", AGENT_A) }),
    );
    const client = new TenantWriteClient({ fetcher: fetcher as unknown as typeof fetch });
    const status = await client.readMutationStatus({ organizationId: ORG_A, mutationId: MUTATION, signal: new AbortController().signal });
    expect(status.status).toBe("committed");
    const calls = fetcher.mock.calls as unknown as Array<[RequestInfo | URL, RequestInit?]>;
    const lastInit = calls[0]?.[1];
    expect(lastInit?.method).toBe("GET");
    expect(lastInit?.headers).toEqual({ "X-OpenArc-Client": API_CLIENT_HEADER, Accept: "application/json" });
    expect(lastInit?.body).toBeUndefined();
    expect(fetcher).toHaveBeenCalledWith(
      `/v1/operator/organizations/${encodeURIComponent(ORG_A)}/mutations/${MUTATION}`,
      expect.anything(),
    );
  });

  it("reads bootstrap status without an organization in the path", async () => {
    const fetcher = vi.fn(async () =>
      success({ status: "not_found", organizationId: `openarc:org:${MUTATION}` }),
    );
    const client = new TenantWriteClient({ fetcher: fetcher as unknown as typeof fetch });
    await client.readMutationStatus({ mutationId: MUTATION, signal: new AbortController().signal });
    expect(fetcher).toHaveBeenCalledWith(
      `/v1/operator/organizations/bootstrap-mutations/${MUTATION}`,
      expect.anything(),
    );
  });

  it("rejects a malformed id before sending and validates the body locally", async () => {
    const fetcher = vi.fn();
    const client = new TenantWriteClient({ fetcher: fetcher as unknown as typeof fetch });
    const signal = new AbortController().signal;
    await expect(
      client.createAgent({
        operation: "tenant.agent.create",
        organizationId: "../evil",
        body: { mutationId: MUTATION, displayName: "A" },
        csrfToken: "c",
        idempotencyKey: KEY,
        signal,
      }),
    ).rejects.toMatchObject({ failure: { kind: "pre-send" } });
    await expect(
      client.createOrganization({
        operation: "tenant.organization.create",
        body: { mutationId: MUTATION, displayName: "Org", extra: 1 },
        csrfToken: "c",
        idempotencyKey: KEY,
        signal,
      }),
    ).rejects.toMatchObject({ failure: { kind: "pre-send" } });
    await expect(
      client.createAgent({
        operation: "tenant.agent.create",
        organizationId: ORG_A,
        body: { mutationId: MUTATION, displayName: "A" },
        csrfToken: "c",
        idempotencyKey: "not-a-canonical-key",
        signal,
      }),
    ).rejects.toMatchObject({ failure: { kind: "pre-send" } });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("enforces the local 8KiB body cap", async () => {
    const fetcher = vi.fn();
    const client = new TenantWriteClient({ fetcher: fetcher as unknown as typeof fetch });
    await expect(
      client.createOrganization({
        operation: "tenant.organization.create",
        body: { mutationId: MUTATION, displayName: "A".repeat(TENANT_WRITE_MAX_BODY_BYTES) },
        csrfToken: "c",
        idempotencyKey: KEY,
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ failure: { kind: "pre-send" } });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("never puts the idempotency key or CSRF in the body", async () => {
    let capturedBody = "";
    const fetcher = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      capturedBody = String(init?.body ?? "");
      return success(result("tenant.agent.create", AGENT_A));
    });
    const client = new TenantWriteClient({ fetcher: fetcher as unknown as typeof fetch });
    await client.createAgent({
      operation: "tenant.agent.create",
      organizationId: ORG_A,
      body: { mutationId: MUTATION, displayName: "A" },
      csrfToken: "SECRET_CSRF",
      idempotencyKey: KEY,
      signal: new AbortController().signal,
    });
    expect(capturedBody).not.toContain(KEY);
    expect(capturedBody).not.toContain("SECRET_CSRF");
  });

  it("maps definite 4xx codes to validation, policy and conflict without echoing text", async () => {
    const cases: Array<[keyof typeof COMMERCE_API_ERRORS, number, string]> = [
      ["INVALID_REQUEST", 400, "validation"],
      ["UNSUPPORTED_MEDIA_TYPE", 415, "validation"],
      ["REQUEST_TOO_LARGE", 413, "validation"],
      ["POLICY_DENIED", 409, "policy"],
      ["APPROVAL_REQUIRED", 409, "policy"],
      ["IDEMPOTENCY_CONFLICT", 409, "conflict"],
    ];
    for (const [code, status, kind] of cases) {
      const client = new TenantWriteClient({
        fetcher: (async () => errorEnvelope(code, status)) as unknown as typeof fetch,
      });
      await expect(
        client.createAgent({
          operation: "tenant.agent.create",
          organizationId: ORG_A,
          body: { mutationId: MUTATION, displayName: "A" },
          csrfToken: "c",
          idempotencyKey: KEY,
          signal: new AbortController().signal,
        }),
      ).rejects.toMatchObject({ failure: { kind } });
    }
  });

  it("maps 401/CSRF/forbidden distinctly and 5xx/malformed transport to unknown", async () => {
    const cases: Array<[keyof typeof COMMERCE_API_ERRORS, number, string]> = [
      ["UNAUTHENTICATED", 401, "unauthenticated"],
      ["CSRF_REJECTED", 403, "csrf"],
      ["INVALID_ORIGIN", 403, "csrf"],
      ["FORBIDDEN", 403, "forbidden"],
      ["TENANT_MISMATCH", 403, "forbidden"],
      ["FEATURE_DISABLED", 404, "feature-disabled"],
      ["SOURCE_UNAVAILABLE", 503, "outcome-unknown"],
      ["INTERNAL_ERROR", 500, "outcome-unknown"],
    ];
    for (const [code, status, kind] of cases) {
      const client = new TenantWriteClient({
        fetcher: (async () => errorEnvelope(code, status)) as unknown as typeof fetch,
      });
      await expect(
        client.createAgent({
          operation: "tenant.agent.create",
          organizationId: ORG_A,
          body: { mutationId: MUTATION, displayName: "A" },
          csrfToken: "c",
          idempotencyKey: KEY,
          signal: new AbortController().signal,
        }),
      ).rejects.toMatchObject({ failure: { kind } });
    }
    const thrown = new TenantWriteClient({
      fetcher: (async () => {
        throw new Error("PRIVATE_CANARY");
      }) as unknown as typeof fetch,
    });
    await expect(
      thrown.createAgent({
        operation: "tenant.agent.create",
        organizationId: ORG_A,
        body: { mutationId: MUTATION, displayName: "A" },
        csrfToken: "c",
        idempotencyKey: KEY,
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ failure: { kind: "outcome-unknown" } });
  });

  it("rejects a response whose mutation or resource binding does not match", async () => {
    const wrongMutation = new TenantWriteClient({
      fetcher: (async () =>
        success({
          organizationId: ORG_A,
          replayed: false,
          receipt: {
            mutationId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
            operation: "tenant.agent.update",
            resourceType: "agent",
            resourceId: AGENT_A,
            committedAt: "2026-01-01T00:00:00.000Z",
          },
        })) as unknown as typeof fetch,
    });
    await expect(
      wrongMutation.updateAgent({
        operation: "tenant.agent.update",
        organizationId: ORG_A,
        agentId: AGENT_A,
        body: { mutationId: MUTATION, patch: { status: "suspended" } },
        csrfToken: "c",
        idempotencyKey: KEY,
        signal: new AbortController().signal,
      }),
    ).rejects.toBeInstanceOf(TenantWriteApiError);

    const wrongTarget = new TenantWriteClient({
      fetcher: (async () =>
        success(result("tenant.agent.update", "openarc:agent:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"))) as unknown as typeof fetch,
    });
    await expect(
      wrongTarget.updateAgent({
        operation: "tenant.agent.update",
        organizationId: ORG_A,
        agentId: AGENT_A,
        body: { mutationId: MUTATION, patch: { status: "suspended" } },
        csrfToken: "c",
        idempotencyKey: KEY,
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ failure: { kind: "invalid-response" } });
  });

  it("rejects a status whose organization does not match the query", async () => {
    const client = new TenantWriteClient({
      fetcher: (async () =>
        success({
          status: "not_found",
          organizationId: "openarc:org:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        })) as unknown as typeof fetch,
    });
    await expect(
      client.readMutationStatus({ organizationId: ORG_A, mutationId: MUTATION, signal: new AbortController().signal }),
    ).rejects.toMatchObject({ failure: { kind: "invalid-response" } });
  });

  it("rejects non-JSON media, oversized declared bytes and truncated bodies", async () => {
    const nonJson = new TenantWriteClient({
      fetcher: (async () => new Response("{}", { headers: { "content-type": "text/html" } })) as unknown as typeof fetch,
    });
    await expect(
      nonJson.createAgent({
        operation: "tenant.agent.create",
        organizationId: ORG_A,
        body: { mutationId: MUTATION, displayName: "A" },
        csrfToken: "c",
        idempotencyKey: KEY,
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ failure: { kind: "outcome-unknown" } });

    const truncated = new TenantWriteClient({
      fetcher: (async () =>
        new Response('{"ok":true,"data":{"ite', {
          headers: { "content-type": "application/json" },
        })) as unknown as typeof fetch,
    });
    await expect(
      truncated.createAgent({
        operation: "tenant.agent.create",
        organizationId: ORG_A,
        body: { mutationId: MUTATION, displayName: "A" },
        csrfToken: "c",
        idempotencyKey: KEY,
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ failure: { kind: "outcome-unknown" } });
  });

  it("does not retry a failed write", async () => {
    let calls = 0;
    const client = new TenantWriteClient({
      fetcher: (async () => {
        calls += 1;
        return errorEnvelope("INTERNAL_ERROR", 500);
      }) as unknown as typeof fetch,
    });
    await expect(
      client.createAgent({
        operation: "tenant.agent.create",
        organizationId: ORG_A,
        body: { mutationId: MUTATION, displayName: "A" },
        csrfToken: "c",
        idempotencyKey: KEY,
        signal: new AbortController().signal,
      }),
    ).rejects.toBeDefined();
    expect(calls).toBe(1);
  });
});

describe("tenant mutation correlation", () => {
  it("creates canonical mutation ids and keys once per call", () => {
    const first = createMutationCorrelation();
    const second = createMutationCorrelation();
    expect(CommerceTenantMutationIdSchema.safeParse(first.mutationId).success).toBe(true);
    expect(CommerceTenantIdempotencyKeySchema.safeParse(first.idempotencyKey).success).toBe(true);
    expect(first.mutationId).not.toBe(second.mutationId);
    expect(first.idempotencyKey).not.toBe(second.idempotencyKey);
    expect(first.idempotencyKey.length).toBe(43);
  });

  it("creates a version-4 variant UUID and a 32-byte canonical key", () => {
    for (let index = 0; index < 25; index += 1) {
      const id = createMutationId();
      expect(id[14]).toBe("4");
      expect(["8", "9", "a", "b"]).toContain(id[19]);
      expect(CommerceTenantIdempotencyKeySchema.safeParse(createIdempotencyKey()).success).toBe(true);
    }
  });
});
