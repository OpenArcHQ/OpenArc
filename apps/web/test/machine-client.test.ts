import {
  API_CLIENT_HEADER,
  COMMERCE_API_ERRORS,
  COMMERCE_API_SCHEMA_VERSION,
  CommerceMachineCredentialIdSchema,
  CommerceTenantIdempotencyKeySchema,
} from "@openarc/shared";
import { describe, expect, it, vi } from "vitest";

import {
  MachineApiError,
  MachineClient,
  createMachineCorrelation,
  createMachineIdempotencyKey,
  createMachineMutationId,
} from "../src/tenant/machine-client.js";

const META = {
  schemaVersion: COMMERCE_API_SCHEMA_VERSION,
  requestId: "018f47a2-3b4c-7def-8123-456789abcdef",
  buildSha: "0123456789abcdef0123456789abcdef01234567",
};

const V4 = "12345678-1234-4234-8123-123456789abc";
const V4_B = "87654321-4321-4321-b123-abcdefabcdef";
const ORG = `openarc:org:${V4}`;
const AGENT = `openarc:agent:${V4}`;
const PROVIDER = `openarc:provider:${V4}`;
const TOKEN_SECRET = `${"A".repeat(42)}A`;
const AGENT_PREFIX = `oac_ag_${V4}`;
const PROVIDER_PREFIX = `oac_pr_${V4}`;
const AGENT_CREDENTIAL = `oac_ag_${V4}_${TOKEN_SECRET}`;
const PROVIDER_CREDENTIAL = `oac_pr_${V4}_${TOKEN_SECRET}`;
const ISO = "2024-01-01T00:00:00.000Z";
const ISO_EXPIRES = "2024-01-02T00:00:00.000Z";
const KEY = createMachineIdempotencyKey();
const MUTATION = V4;

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

function agentMetadata() {
  return {
    credentialId: V4,
    kind: "agent" as const,
    profileId: AGENT,
    publicPrefix: AGENT_PREFIX,
    environment: "eip155:5042002" as const,
    scopes: ["agent:self.read"] as const,
    scopeVersion: 1 as const,
    createdAt: ISO,
    expiresAt: ISO_EXPIRES,
    revokedAt: null,
    status: "active" as const,
  };
}

function agentIssueReceipt() {
  return {
    mutationId: MUTATION,
    operation: "tenant.agent.credential.issue" as const,
    resourceType: "agent_credential" as const,
    credentialId: MUTATION,
    committedAt: ISO,
  };
}

function providerIssueReceipt() {
  return {
    mutationId: MUTATION,
    operation: "tenant.provider.credential.issue" as const,
    resourceType: "provider_credential" as const,
    credentialId: MUTATION,
    committedAt: ISO,
  };
}

function agentRevokeReceipt() {
  return {
    mutationId: MUTATION,
    operation: "tenant.agent.credential.revoke" as const,
    resourceType: "agent_credential" as const,
    credentialId: V4_B,
    committedAt: ISO,
  };
}

const signal = () => new AbortController().signal;

describe("machine credential client transport", () => {
  it("issues an agent credential with exactly the fixed headers and no query", async () => {
    const fetcher = vi.fn(async () =>
      success({
        organizationId: ORG,
        replayed: false,
        receipt: agentIssueReceipt(),
        delivery: { status: "available_once", credential: AGENT_CREDENTIAL, publicPrefix: AGENT_PREFIX },
      }),
    );
    const client = new MachineClient({ fetcher: fetcher as unknown as typeof fetch });
    const result = await client.issueAgentCredential({
      organizationId: ORG,
      agentId: AGENT,
      body: { mutationId: MUTATION, expiresAt: ISO_EXPIRES },
      csrfToken: "csrf-token",
      idempotencyKey: KEY,
      signal: signal(),
    });
    expect(result.receipt.operation).toBe("tenant.agent.credential.issue");
    const path = `/v1/operator/organizations/${encodeURIComponent(ORG)}/agents/${encodeURIComponent(AGENT)}/credentials`;
    expect(fetcher).toHaveBeenCalledWith(path, {
      method: "POST",
      headers: {
        "X-OpenArc-Client": API_CLIENT_HEADER,
        "Content-Type": "application/json",
        Accept: "application/json",
        "X-OpenArc-CSRF": "csrf-token",
        "Idempotency-Key": KEY,
      },
      body: JSON.stringify({ mutationId: MUTATION, expiresAt: ISO_EXPIRES }),
      credentials: "same-origin",
      cache: "no-store",
      redirect: "error",
      referrerPolicy: "no-referrer",
      signal: expect.any(AbortSignal),
    });
    expect(path).not.toContain("?");
  });

  it("issues a provider credential and revokes both kinds on exact routes", async () => {
    const paths: string[] = [];
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      paths.push(`${init?.method} ${path}`);
      if (path.endsWith("/credentials") && path.includes("/providers/")) {
        return success({
          organizationId: ORG,
          replayed: false,
          receipt: providerIssueReceipt(),
          delivery: { status: "available_once", credential: PROVIDER_CREDENTIAL, publicPrefix: PROVIDER_PREFIX },
        });
      }
      if (path.includes("/agent-credentials/")) {
        return success({ organizationId: ORG, replayed: false, receipt: agentRevokeReceipt() });
      }
      return success({
        organizationId: ORG,
        replayed: false,
        receipt: {
          mutationId: MUTATION,
          operation: "tenant.provider.credential.revoke" as const,
          resourceType: "provider_credential" as const,
          credentialId: V4_B,
          committedAt: ISO,
        },
      });
    });
    const client = new MachineClient({ fetcher: fetcher as unknown as typeof fetch });
    const common = { csrfToken: "c", idempotencyKey: KEY, signal: signal() };
    await client.issueProviderCredential({
      organizationId: ORG,
      providerId: PROVIDER,
      body: { mutationId: MUTATION, expiresAt: ISO_EXPIRES },
      ...common,
    });
    await client.revokeAgentCredential({
      organizationId: ORG,
      credentialId: V4_B,
      body: { mutationId: MUTATION },
      ...common,
    });
    await client.revokeProviderCredential({
      organizationId: ORG,
      credentialId: V4_B,
      body: { mutationId: MUTATION },
      ...common,
    });
    const org = encodeURIComponent(ORG);
    expect(paths).toEqual([
      `POST /v1/operator/organizations/${org}/providers/${encodeURIComponent(PROVIDER)}/credentials`,
      `POST /v1/operator/organizations/${org}/agent-credentials/${V4_B}/revoke`,
      `POST /v1/operator/organizations/${org}/provider-credentials/${V4_B}/revoke`,
    ]);
    expect(paths.every((path) => !path.includes("%25"))).toBe(true);
  });

  it("lists a profile page with only the bounded query and no write headers", async () => {
    const fetcher = vi.fn(async () =>
      success({ organizationId: ORG, kind: "agent", profileId: AGENT, items: [agentMetadata()], nextCursor: null }),
    );
    const client = new MachineClient({ fetcher: fetcher as unknown as typeof fetch });
    const page = await client.listAgentCredentials({ organizationId: ORG, agentId: AGENT }, signal());
    expect(page.items).toHaveLength(1);
    const [path, init] = (fetcher.mock.calls as unknown as Array<[RequestInfo | URL, RequestInit?]>)[0]!;
    expect(String(path)).toBe(
      `/v1/operator/organizations/${encodeURIComponent(ORG)}/agents/${encodeURIComponent(AGENT)}/credentials?limit=50`,
    );
    expect(init?.method).toBe("GET");
    expect(init?.headers).toEqual({ "X-OpenArc-Client": API_CLIENT_HEADER, Accept: "application/json" });
    expect(init?.body).toBeUndefined();
    expect((init?.headers as Record<string, string>)["Idempotency-Key"]).toBeUndefined();
  });

  it("reads status without a body, key or CSRF", async () => {
    const fetcher = vi.fn(async () =>
      success({ organizationId: ORG, status: "committed", receipt: agentIssueReceipt() }),
    );
    const client = new MachineClient({ fetcher: fetcher as unknown as typeof fetch });
    const status = await client.readCredentialStatus({
      organizationId: ORG,
      kind: "agent",
      mutationId: MUTATION,
      signal: signal(),
    });
    expect(status.status).toBe("committed");
    expect(fetcher).toHaveBeenCalledWith(
      `/v1/operator/organizations/${encodeURIComponent(ORG)}/agent-credential-mutations/${MUTATION}`,
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("rejects a malformed id before sending and validates the body locally", async () => {
    const fetcher = vi.fn();
    const client = new MachineClient({ fetcher: fetcher as unknown as typeof fetch });
    await expect(
      client.issueAgentCredential({
        organizationId: "../evil",
        agentId: AGENT,
        body: { mutationId: MUTATION, expiresAt: ISO_EXPIRES },
        csrfToken: "c",
        idempotencyKey: KEY,
        signal: signal(),
      }),
    ).rejects.toMatchObject({ failure: { kind: "pre-send" } });
    await expect(
      client.issueAgentCredential({
        organizationId: ORG,
        agentId: AGENT,
        body: { mutationId: MUTATION, expiresAt: ISO_EXPIRES, extra: 1 },
        csrfToken: "c",
        idempotencyKey: KEY,
        signal: signal(),
      }),
    ).rejects.toMatchObject({ failure: { kind: "pre-send" } });
    await expect(
      client.issueAgentCredential({
        organizationId: ORG,
        agentId: AGENT,
        body: { mutationId: MUTATION, expiresAt: ISO_EXPIRES },
        csrfToken: "c",
        idempotencyKey: "not-canonical",
        signal: signal(),
      }),
    ).rejects.toMatchObject({ failure: { kind: "pre-send" } });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("rejects a response whose kind, organization or mutation does not match", async () => {
    const wrongKind = new MachineClient({
      fetcher: (async () =>
        success({
          organizationId: ORG,
          replayed: false,
          receipt: agentIssueReceipt(),
          delivery: { status: "available_once", credential: AGENT_CREDENTIAL, publicPrefix: AGENT_PREFIX },
        })) as unknown as typeof fetch,
    });
    await expect(
      wrongKind.issueProviderCredential({
        organizationId: ORG,
        providerId: PROVIDER,
        body: { mutationId: MUTATION, expiresAt: ISO_EXPIRES },
        csrfToken: "c",
        idempotencyKey: KEY,
        signal: signal(),
      }),
    ).rejects.toMatchObject({ failure: { kind: "invalid-response" } });

    const wrongOrg = new MachineClient({
      fetcher: (async () =>
        success({
          organizationId: `openarc:org:${V4_B}`,
          replayed: false,
          receipt: agentIssueReceipt(),
          delivery: { status: "available_once", credential: AGENT_CREDENTIAL, publicPrefix: AGENT_PREFIX },
        })) as unknown as typeof fetch,
    });
    await expect(
      wrongOrg.issueAgentCredential({
        organizationId: ORG,
        agentId: AGENT,
        body: { mutationId: MUTATION, expiresAt: ISO_EXPIRES },
        csrfToken: "c",
        idempotencyKey: KEY,
        signal: signal(),
      }),
    ).rejects.toMatchObject({ failure: { kind: "invalid-response" } });
  });

  it("rejects a revoke receipt that targets a different credential id", async () => {
    const wrongTarget = new MachineClient({
      fetcher: (async () =>
        success({
          organizationId: ORG,
          replayed: false,
          receipt: {
            mutationId: MUTATION,
            operation: "tenant.agent.credential.revoke",
            resourceType: "agent_credential",
            credentialId: V4,
            committedAt: ISO,
          },
        })) as unknown as typeof fetch,
    });
    await expect(
      wrongTarget.revokeAgentCredential({
        organizationId: ORG,
        credentialId: V4_B,
        body: { mutationId: MUTATION },
        csrfToken: "c",
        idempotencyKey: KEY,
        signal: signal(),
      }),
    ).rejects.toMatchObject({ failure: { kind: "invalid-response" } });
  });

  it("rejects a page whose kind or organization does not match the request", async () => {
    const wrongKind = new MachineClient({
      fetcher: (async () =>
        success({ organizationId: ORG, kind: "provider", profileId: PROVIDER, items: [], nextCursor: null })) as unknown as typeof fetch,
    });
    await expect(wrongKind.listAgentCredentials({ organizationId: ORG, agentId: AGENT }, signal())).rejects.toMatchObject({
      failure: { kind: "invalid-response" },
    });
    const wrongOrg = new MachineClient({
      fetcher: (async () =>
        success({ organizationId: `openarc:org:${V4_B}`, kind: "agent", profileId: AGENT, items: [], nextCursor: null })) as unknown as typeof fetch,
    });
    await expect(wrongOrg.listAgentCredentials({ organizationId: ORG, agentId: AGENT }, signal())).rejects.toMatchObject({
      failure: { kind: "invalid-response" },
    });
  });

  it("rejects a same-kind page for a different profile, including an empty list page", async () => {
    // Same kind, same organization, DIFFERENT profile, non-empty items.
    const wrongProfileItems = new MachineClient({
      fetcher: (async () =>
        success({
          organizationId: ORG,
          kind: "agent",
          profileId: `openarc:agent:${V4_B}`,
          items: [agentMetadata()],
          nextCursor: null,
        })) as unknown as typeof fetch,
    });
    await expect(
      wrongProfileItems.listAgentCredentials({ organizationId: ORG, agentId: AGENT }, signal()),
    ).rejects.toMatchObject({ failure: { kind: "invalid-response" } });

    // Same kind, same organization, DIFFERENT profile, EMPTY list page: the
    // profileId field is the only binding and cannot be inferred from items.
    const wrongProfileEmpty = new MachineClient({
      fetcher: (async () =>
        success({
          organizationId: ORG,
          kind: "agent",
          profileId: `openarc:agent:${V4_B}`,
          items: [],
          nextCursor: null,
        })) as unknown as typeof fetch,
    });
    await expect(
      wrongProfileEmpty.listAgentCredentials({ organizationId: ORG, agentId: AGENT }, signal()),
    ).rejects.toMatchObject({ failure: { kind: "invalid-response" } });

    // A provider page for a different provider is likewise refused.
    const wrongProviderEmpty = new MachineClient({
      fetcher: (async () =>
        success({
          organizationId: ORG,
          kind: "provider",
          profileId: `openarc:provider:${V4_B}`,
          items: [],
          nextCursor: null,
        })) as unknown as typeof fetch,
    });
    await expect(
      wrongProviderEmpty.listProviderCredentials({ organizationId: ORG, providerId: PROVIDER }, signal()),
    ).rejects.toMatchObject({ failure: { kind: "invalid-response" } });
  });

  it("accepts only the exact requested profile on a same-kind page", async () => {
    const fetcher = vi.fn(async () =>
      success({
        organizationId: ORG,
        kind: "agent",
        profileId: AGENT,
        items: [agentMetadata()],
        nextCursor: null,
      }),
    );
    const client = new MachineClient({ fetcher: fetcher as unknown as typeof fetch });
    const page = await client.listAgentCredentials({ organizationId: ORG, agentId: AGENT }, signal());
    expect(page.profileId).toBe(AGENT);
  });

  it("reports an abort after a write fetch invocation as outcome-unknown, never aborted", async () => {
    let calls = 0;
    const client = new MachineClient({
      fetcher: (async () => {
        calls += 1;
        throw new DOMException("Aborted", "AbortError");
      }) as unknown as typeof fetch,
    });
    await expect(
      client.issueAgentCredential({
        organizationId: ORG,
        agentId: AGENT,
        body: { mutationId: MUTATION, expiresAt: ISO_EXPIRES },
        csrfToken: "c",
        idempotencyKey: KEY,
        signal: signal(),
      }),
    ).rejects.toMatchObject({ failure: { kind: "outcome-unknown" } });
    // The write is never retried automatically.
    expect(calls).toBe(1);
  });

  it("reports a pre-send abort without invoking the write fetch", async () => {
    const fetcher = vi.fn();
    const client = new MachineClient({ fetcher: fetcher as unknown as typeof fetch });
    const controller = new AbortController();
    controller.abort();
    await expect(
      client.issueAgentCredential({
        organizationId: ORG,
        agentId: AGENT,
        body: { mutationId: MUTATION, expiresAt: ISO_EXPIRES },
        csrfToken: "c",
        idempotencyKey: KEY,
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ failure: { kind: "aborted" } });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("maps definite 4xx to validation/policy/conflict and 5xx/malformed to unknown", async () => {
    const cases: Array<[keyof typeof COMMERCE_API_ERRORS, number, string]> = [
      ["INVALID_REQUEST", 400, "validation"],
      ["POLICY_DENIED", 409, "policy"],
      ["GRANT_REVOKED", 409, "policy"],
      ["IDEMPOTENCY_CONFLICT", 409, "conflict"],
      ["UNAUTHENTICATED", 401, "unauthenticated"],
      ["CSRF_REJECTED", 403, "csrf"],
      ["FORBIDDEN", 403, "forbidden"],
      ["FEATURE_DISABLED", 404, "feature-disabled"],
      ["SOURCE_UNAVAILABLE", 503, "outcome-unknown"],
      ["INTERNAL_ERROR", 500, "outcome-unknown"],
    ];
    for (const [code, status, kind] of cases) {
      const client = new MachineClient({
        fetcher: (async () => errorEnvelope(code, status)) as unknown as typeof fetch,
      });
      await expect(
        client.issueAgentCredential({
          organizationId: ORG,
          agentId: AGENT,
          body: { mutationId: MUTATION, expiresAt: ISO_EXPIRES },
          csrfToken: "c",
          idempotencyKey: KEY,
          signal: signal(),
        }),
      ).rejects.toMatchObject({ failure: { kind } });
    }
    const thrown = new MachineClient({
      fetcher: (async () => {
        throw new Error("PRIVATE_CANARY");
      }) as unknown as typeof fetch,
    });
    await expect(
      thrown.issueAgentCredential({
        organizationId: ORG,
        agentId: AGENT,
        body: { mutationId: MUTATION, expiresAt: ISO_EXPIRES },
        csrfToken: "c",
        idempotencyKey: KEY,
        signal: signal(),
      }),
    ).rejects.toMatchObject({ failure: { kind: "outcome-unknown" } });
  });

  it("never places the key or CSRF in the body", async () => {
    let capturedBody = "";
    const fetcher = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      capturedBody = String(init?.body ?? "");
      return success({
        organizationId: ORG,
        replayed: false,
        receipt: agentIssueReceipt(),
        delivery: { status: "available_once", credential: AGENT_CREDENTIAL, publicPrefix: AGENT_PREFIX },
      });
    });
    const client = new MachineClient({ fetcher: fetcher as unknown as typeof fetch });
    await client.issueAgentCredential({
      organizationId: ORG,
      agentId: AGENT,
      body: { mutationId: MUTATION, expiresAt: ISO_EXPIRES },
      csrfToken: "SECRET_CSRF",
      idempotencyKey: KEY,
      signal: signal(),
    });
    expect(capturedBody).not.toContain(KEY);
    expect(capturedBody).not.toContain("SECRET_CSRF");
  });

  it("enforces the local 8KiB body cap and never retries", async () => {
    const fetcher = vi.fn();
    const client = new MachineClient({ fetcher: fetcher as unknown as typeof fetch });
    await expect(
      client.issueAgentCredential({
        organizationId: ORG,
        agentId: AGENT,
        body: { mutationId: MUTATION, expiresAt: `${"A".repeat(9 * 1024)}` },
        csrfToken: "c",
        idempotencyKey: KEY,
        signal: signal(),
      }),
    ).rejects.toMatchObject({ failure: { kind: "pre-send" } });
    expect(fetcher).not.toHaveBeenCalled();

    let calls = 0;
    const failing = new MachineClient({
      fetcher: (async () => {
        calls += 1;
        return errorEnvelope("INTERNAL_ERROR", 500);
      }) as unknown as typeof fetch,
    });
    await expect(
      failing.issueAgentCredential({
        organizationId: ORG,
        agentId: AGENT,
        body: { mutationId: MUTATION, expiresAt: ISO_EXPIRES },
        csrfToken: "c",
        idempotencyKey: KEY,
        signal: signal(),
      }),
    ).rejects.toBeDefined();
    expect(calls).toBe(1);
  });

  it("never references a machine session exchange/self/revoke route", async () => {
    const paths: string[] = [];
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      paths.push(String(input));
      if (init?.method === "GET") {
        return success({ organizationId: ORG, kind: "agent", profileId: AGENT, items: [], nextCursor: null });
      }
      return success({
        organizationId: ORG,
        replayed: false,
        receipt: agentIssueReceipt(),
        delivery: { status: "available_once", credential: AGENT_CREDENTIAL, publicPrefix: AGENT_PREFIX },
      });
    });
    const client = new MachineClient({ fetcher: fetcher as unknown as typeof fetch });
    await client.listAgentCredentials({ organizationId: ORG, agentId: AGENT }, signal());
    await client.issueAgentCredential({
      organizationId: ORG,
      agentId: AGENT,
      body: { mutationId: MUTATION, expiresAt: ISO_EXPIRES },
      csrfToken: "c",
      idempotencyKey: KEY,
      signal: signal(),
    });
    for (const path of paths) {
      expect(path.startsWith("/v1/operator/organizations/")).toBe(true);
      expect(path.includes("/v1/agent")).toBe(false);
      expect(path.includes("/v1/provider")).toBe(false);
      expect(path.includes("/session")).toBe(false);
    }
  });
});

describe("machine credential correlation", () => {
  it("creates canonical v4 ids and 32-byte keys once per call", () => {
    const first = createMachineCorrelation();
    const second = createMachineCorrelation();
    expect(CommerceMachineCredentialIdSchema.safeParse(first.mutationId).success).toBe(true);
    expect(CommerceTenantIdempotencyKeySchema.safeParse(first.idempotencyKey).success).toBe(true);
    expect(first.mutationId).not.toBe(second.mutationId);
    expect(first.idempotencyKey).not.toBe(second.idempotencyKey);
    expect(first.idempotencyKey.length).toBe(43);
  });

  it("creates a version-4 variant UUID", () => {
    for (let index = 0; index < 25; index += 1) {
      const id = createMachineMutationId();
      expect(id[14]).toBe("4");
      expect(["8", "9", "a", "b"]).toContain(id[19]);
    }
  });
});

describe("machine client error class", () => {
  it("exposes the bounded failure kind without echoing a raw body", () => {
    const error = new MachineApiError({ kind: "invalid-response" });
    expect(error.failure).toEqual({ kind: "invalid-response" });
    expect(error.message).toBe("invalid-response");
  });
});
