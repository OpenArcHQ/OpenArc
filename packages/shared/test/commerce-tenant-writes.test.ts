import { describe, expect, expectTypeOf, it } from "vitest";

import {
  COMMERCE_API_ERRORS,
  CommerceApiErrorEnvelopeSchema,
  CommerceTenantIdempotencyKeySchema,
  CommerceTenantMutationIdSchema,
  CommerceTenantMutationReceiptSchema,
  CommerceTenantMutationResponseSchema,
  CommerceTenantMutationResultSchema,
  CommerceTenantMutationStatusRequestSchema,
  CommerceTenantMutationStatusResponseSchema,
  CommerceTenantMutationStatusSchema,
  CommerceOrganizationCreateBodySchema,
  CommerceOrganizationMutationStatusRequestSchema,
  CommerceAgentCreateBodySchema,
  CommerceAgentUpdateBodySchema,
  CommerceProviderCreateBodySchema,
  CommerceProviderUpdateBodySchema,
  CommerceMembershipSetBodySchema,
  type CommerceAgentCreateBody,
  type CommerceAgentUpdateBody,
  type CommerceMembershipSetBody,
  type CommerceOrganizationCreateBody,
  type CommerceProviderCreateBody,
  type CommerceProviderUpdateBody,
  type CommerceTenantIdempotencyKey,
  type CommerceTenantMutationReceipt,
  type CommerceTenantMutationResult,
  type CommerceTenantMutationStatus,
} from "../src/index.js";

const V4 = "12345678-1234-4234-8123-123456789abc";
const V4_B = "87654321-4321-4321-b123-abcdefabcdef";

const MUTATION = V4;
const MUTATION_B = V4_B;

const ORG = `openarc:org:${V4}`;
const ORG_B = `openarc:org:${V4_B}`;
const AGENT = `openarc:agent:${V4}`;
const PROVIDER = `openarc:provider:${V4}`;
const ACCOUNT = `openarc:account:${V4}`;

const ISO = "2024-01-01T00:00:00.000Z";

const CANARY = "PRIVATE_CANARY_DO_NOT_ECHO";
const SAMPLE_UUID = "9f1c2d34-5e6a-4b7c-8d9e-0f1a2b3c4d5e";
const SAMPLE_SHA = "0123456789abcdef0123456789abcdef01234567";

const META = {
  schemaVersion: "openarc.api.v2" as const,
  requestId: SAMPLE_UUID,
  buildSha: SAMPLE_SHA,
};

/** 32 zero bytes -> 43 canonical base64url characters ending in `A`. */
const IDEMPOTENCY = `${"A".repeat(42)}A`;

type ParseableSchema = {
  safeParse(value: unknown): { success: boolean };
};

function createBody(mutationId: unknown, displayName: unknown = "Acme") {
  return { mutationId, displayName };
}

function organizationReceipt(mutationId = MUTATION, resourceId = ORG) {
  return {
    mutationId,
    operation: "tenant.organization.create" as const,
    resourceType: "organization" as const,
    resourceId,
    committedAt: ISO,
  };
}

function agentReceipt(operation: "tenant.agent.create" | "tenant.agent.update") {
  return {
    mutationId: MUTATION,
    operation,
    resourceType: "agent" as const,
    resourceId: AGENT,
    committedAt: ISO,
  };
}

function providerReceipt(
  operation: "tenant.provider.create" | "tenant.provider.update",
) {
  return {
    mutationId: MUTATION,
    operation,
    resourceType: "provider" as const,
    resourceId: PROVIDER,
    committedAt: ISO,
  };
}

function membershipReceipt() {
  return {
    mutationId: MUTATION,
    operation: "tenant.membership.set" as const,
    resourceType: "membership" as const,
    resourceId: ACCOUNT,
    committedAt: ISO,
  };
}

describe("tenant mutation id", () => {
  it("accepts exact lower-case canonical UUIDv4 values", () => {
    for (const value of [V4, V4_B]) {
      expect(CommerceTenantMutationIdSchema.safeParse(value).success).toBe(true);
    }
    for (const variant of ["8", "9", "a", "b"]) {
      const value = `12345678-1234-4234-${variant}123-123456789abc`;
      expect(CommerceTenantMutationIdSchema.safeParse(value).success).toBe(true);
    }
  });

  it("rejects wrong version, wrong variant, uppercase and noncanonical forms", () => {
    const bad = [
      "12345678-1234-3234-8123-123456789abc", // version 3
      "12345678-1234-5234-8123-123456789abc", // version 5
      "12345678-1234-4234-c123-123456789abc", // variant c
      "12345678-1234-4234-7123-123456789abc", // variant 7
      V4.toUpperCase(),
      `${V4}\n`,
      `${V4} `,
      ` ${V4}`,
      "12345678123442348123123456789abc",
      "12345678-1234-4234-8123-123456789ab",
      42,
      null,
      undefined,
      {},
    ];
    for (const value of bad) {
      expect(CommerceTenantMutationIdSchema.safeParse(value).success).toBe(false);
    }
  });
});

describe("tenant idempotency key", () => {
  it("accepts canonical unpadded base64url of exactly 32 bytes", () => {
    expect(CommerceTenantIdempotencyKeySchema.safeParse(IDEMPOTENCY).success).toBe(
      true,
    );
    for (const last of ["A", "E", "I", "M", "Q", "U", "Y", "c", "g", "k", "o", "s", "w", "0", "4", "8"]) {
      const value = `${"A".repeat(42)}${last}`;
      expect(CommerceTenantIdempotencyKeySchema.safeParse(value).success).toBe(
        true,
      );
    }
  });

  it("rejects noncanonical trailing bits, padding, whitespace and bad lengths", () => {
    const bad = [
      `${"A".repeat(42)}B`, // nonzero padding bit
      `${"A".repeat(42)}C`,
      `${"A".repeat(42)}D`,
      `${"A".repeat(42)}=`,
      `${"A".repeat(42)}=`,
      `${"A".repeat(43)}=`,
      "A".repeat(42),
      "A".repeat(44),
      `${"A".repeat(42)}A\n`,
      ` ${"A".repeat(43)}`,
      `${"A".repeat(42)}A `,
      "A".repeat(3),
      "",
      42,
      null,
      undefined,
      {},
    ];
    for (const value of bad) {
      expect(
        CommerceTenantIdempotencyKeySchema.safeParse(value).success,
      ).toBe(false);
    }
  });
});

describe("tenant create bodies", () => {
  const cases: readonly (readonly [ParseableSchema, string])[] = [
    [CommerceOrganizationCreateBodySchema, "organization"],
    [CommerceAgentCreateBodySchema, "agent"],
    [CommerceProviderCreateBodySchema, "provider"],
  ];

  it("accepts the exact create body for every resource", () => {
    for (const [schema] of cases) {
      expect(schema.safeParse(createBody(MUTATION)).success).toBe(true);
      expect(
        schema.safeParse(createBody(MUTATION_B, "Ünïcode")).success,
      ).toBe(true);
    }
  });

  it("rejects a missing mutationId, missing displayName and noncanonical ids", () => {
    for (const [schema] of cases) {
      expect(schema.safeParse({ displayName: "Acme" }).success).toBe(false);
      expect(schema.safeParse({ mutationId: MUTATION }).success).toBe(false);
      expect(
        schema.safeParse(createBody(MUTATION.toUpperCase())).success,
      ).toBe(false);
      expect(schema.safeParse(createBody(MUTATION, "")).success).toBe(false);
      expect(schema.safeParse(createBody(MUTATION, " Acme")).success).toBe(false);
      expect(schema.safeParse(createBody(MUTATION, "Ac\nme")).success).toBe(false);
      expect(schema.safeParse(createBody(MUTATION, 42)).success).toBe(false);
      expect(schema.safeParse(createBody(MUTATION, null)).success).toBe(false);
    }
  });

  it("rejects private extra fields at the body and nested level", () => {
    const forbidden = [
      "organizationId",
      "accountId",
      "role",
      "idempotencyKey",
      "principal",
      "session",
      "actor",
      "hash",
      "payload",
      "rawBody",
      "credential",
      "csrfToken",
      "status",
    ];
    for (const [schema] of cases) {
      for (const key of forbidden) {
        expect(
          schema.safeParse({ ...createBody(MUTATION), [key]: CANARY }).success,
        ).toBe(false);
      }
      expect(
        schema.safeParse({
          ...createBody(MUTATION),
          displayName: CANARY,
        }).success,
      ).toBe(true);
    }
  });
});

describe("tenant update patch bodies", () => {
  it("accepts single and combined defined patch fields", () => {
    const agentPatches = [
      { displayName: "New" },
      { status: "active" },
      { displayName: "New", status: "suspended" },
      { status: "revoked" },
    ] as const;
    for (const patch of agentPatches) {
      expect(
        CommerceAgentUpdateBodySchema.safeParse({
          mutationId: MUTATION,
          patch,
        }).success,
      ).toBe(true);
    }

    const providerPatches = [
      { displayName: "New" },
      { status: "active" },
      { displayName: "New", status: "retired" },
      { status: "suspended" },
    ] as const;
    for (const patch of providerPatches) {
      expect(
        CommerceProviderUpdateBodySchema.safeParse({
          mutationId: MUTATION,
          patch,
        }).success,
      ).toBe(true);
    }
  });

  it("rejects empty, null, undefined and unknown patches", () => {
    const badPatches: readonly unknown[] = [
      {},
      null,
      undefined,
      "patch",
      42,
      [],
      { unknown: CANARY },
      { displayName: "New", unknown: CANARY },
    ];
    for (const patch of badPatches) {
      expect(
        CommerceAgentUpdateBodySchema.safeParse({ mutationId: MUTATION, patch })
          .success,
      ).toBe(false);
      expect(
        CommerceProviderUpdateBodySchema.safeParse({
          mutationId: MUTATION,
          patch,
        }).success,
      ).toBe(false);
    }
  });

  it("rejects explicit undefined patch fields and noncanonical values", () => {
    expect(
      CommerceAgentUpdateBodySchema.safeParse({
        mutationId: MUTATION,
        patch: { displayName: undefined },
      }).success,
    ).toBe(false);
    expect(
      CommerceAgentUpdateBodySchema.safeParse({
        mutationId: MUTATION,
        patch: { status: undefined },
      }).success,
    ).toBe(false);
    expect(
      CommerceProviderUpdateBodySchema.safeParse({
        mutationId: MUTATION,
        patch: { displayName: undefined, status: undefined },
      }).success,
    ).toBe(false);
    expect(
      CommerceAgentUpdateBodySchema.safeParse({
        mutationId: MUTATION,
        patch: { status: "retired" },
      }).success,
    ).toBe(false);
    expect(
      CommerceProviderUpdateBodySchema.safeParse({
        mutationId: MUTATION,
        patch: { status: "revoked" },
      }).success,
    ).toBe(false);
  });

  it("rejects private extra fields at body and patch level", () => {
    for (const key of [
      "accountId",
      "organizationId",
      "role",
      "idempotencyKey",
      "session",
      "actor",
      "hash",
      "payload",
    ]) {
      expect(
        CommerceAgentUpdateBodySchema.safeParse({
          mutationId: MUTATION,
          patch: { displayName: "New" },
          [key]: CANARY,
        }).success,
      ).toBe(false);
      expect(
        CommerceProviderUpdateBodySchema.safeParse({
          mutationId: MUTATION,
          patch: { displayName: "New", [key]: CANARY },
        }).success,
      ).toBe(false);
    }
  });
});

describe("tenant membership body", () => {
  it("accepts every accepted human role and both membership statuses", () => {
    for (const role of [
      "owner",
      "operator",
      "provider_admin",
      "provider_developer",
      "viewer",
    ] as const) {
      for (const membershipStatus of ["active", "suspended"] as const) {
        expect(
          CommerceMembershipSetBodySchema.safeParse({
            mutationId: MUTATION,
            role,
            membershipStatus,
          }).success,
        ).toBe(true);
      }
    }
  });

  it("rejects targetAccountId in the body, bad roles and bad statuses", () => {
    const base = {
      mutationId: MUTATION,
      role: "owner" as const,
      membershipStatus: "active" as const,
    };
    expect(
      CommerceMembershipSetBodySchema.safeParse({
        ...base,
        targetAccountId: ACCOUNT,
      }).success,
    ).toBe(false);
    expect(
      CommerceMembershipSetBodySchema.safeParse({
        ...base,
        accountId: ACCOUNT,
      }).success,
    ).toBe(false);
    expect(
      CommerceMembershipSetBodySchema.safeParse({
        ...base,
        role: "admin",
      }).success,
    ).toBe(false);
    expect(
      CommerceMembershipSetBodySchema.safeParse({
        ...base,
        membershipStatus: "pending",
      }).success,
    ).toBe(false);
    expect(
      CommerceMembershipSetBodySchema.safeParse({
        ...base,
        role: undefined,
      }).success,
    ).toBe(false);
  });
});

describe("tenant status request schemas", () => {
  it("accepts canonical tenant and organization status requests", () => {
    expect(
      CommerceTenantMutationStatusRequestSchema.safeParse({
        organizationId: ORG,
        mutationId: MUTATION,
      }).success,
    ).toBe(true);
    expect(
      CommerceOrganizationMutationStatusRequestSchema.safeParse({
        mutationId: MUTATION,
      }).success,
    ).toBe(true);
  });

  it("rejects wrong prefixes, noncanonical ids and extra private fields", () => {
    for (const organizationId of [
      ACCOUNT,
      AGENT,
      ORG.toUpperCase(),
      `${ORG}\n`,
      "openarc:org:",
      42,
      null,
    ]) {
      expect(
        CommerceTenantMutationStatusRequestSchema.safeParse({
          organizationId,
          mutationId: MUTATION,
        }).success,
      ).toBe(false);
    }
    for (const key of ["accountId", "role", "session", "idempotencyKey"]) {
      expect(
        CommerceTenantMutationStatusRequestSchema.safeParse({
          organizationId: ORG,
          mutationId: MUTATION,
          [key]: CANARY,
        }).success,
      ).toBe(false);
      expect(
        CommerceOrganizationMutationStatusRequestSchema.safeParse({
          mutationId: MUTATION,
          [key]: CANARY,
        }).success,
      ).toBe(false);
    }
    expect(
      CommerceOrganizationMutationStatusRequestSchema.safeParse({
        mutationId: MUTATION.toUpperCase(),
      }).success,
    ).toBe(false);
  });
});

describe("tenant mutation receipt", () => {
  it("accepts the closed discriminated operation/resource union", () => {
    const receipts = [
      organizationReceipt(),
      agentReceipt("tenant.agent.create"),
      agentReceipt("tenant.agent.update"),
      providerReceipt("tenant.provider.create"),
      providerReceipt("tenant.provider.update"),
      membershipReceipt(),
    ];
    for (const receipt of receipts) {
      expect(
        CommerceTenantMutationReceiptSchema.safeParse(receipt).success,
      ).toBe(true);
    }
  });

  it("enforces the organization bootstrap resourceId convention", () => {
    expect(
      CommerceTenantMutationReceiptSchema.safeParse(organizationReceipt()).success,
    ).toBe(true);
    expect(
      CommerceTenantMutationReceiptSchema.safeParse(
        organizationReceipt(MUTATION, ORG_B),
      ).success,
    ).toBe(false);
  });

  it("rejects wrong operation/resourceType pairings", () => {
    const mismatched = [
      { ...agentReceipt("tenant.agent.create"), resourceType: "provider" },
      { ...agentReceipt("tenant.agent.create"), resourceId: PROVIDER },
      { ...providerReceipt("tenant.provider.create"), resourceType: "agent" },
      { ...membershipReceipt(), resourceType: "agent" },
      { ...organizationReceipt(), resourceType: "account" },
      { ...agentReceipt("tenant.agent.update"), operation: "tenant.agent.updated" },
    ];
    for (const receipt of mismatched) {
      expect(
        CommerceTenantMutationReceiptSchema.safeParse(receipt).success,
      ).toBe(false);
    }
  });

  it("rejects request names, keys, hashes, principals and raw blobs", () => {
    const base = organizationReceipt();
    for (const key of [
      "displayName",
      "idempotencyKey",
      "requestId",
      "hash",
      "session",
      "actor",
      "role",
      "payload",
      "rawResponse",
      "responseBody",
    ]) {
      expect(
        CommerceTenantMutationReceiptSchema.safeParse({
          ...base,
          [key]: CANARY,
        }).success,
      ).toBe(false);
    }
    expect(
      CommerceTenantMutationReceiptSchema.safeParse({
        ...base,
        committedAt: "2024-13-01T00:00:00.000Z",
      }).success,
    ).toBe(false);
  });
});

describe("tenant mutation result and status", () => {
  it("accepts committed and not_found results", () => {
    expect(
      CommerceTenantMutationResultSchema.safeParse({
        organizationId: ORG,
        replayed: false,
        receipt: organizationReceipt(),
      }).success,
    ).toBe(true);
    expect(
      CommerceTenantMutationResultSchema.safeParse({
        organizationId: ORG,
        replayed: true,
        receipt: agentReceipt("tenant.agent.create"),
      }).success,
    ).toBe(true);
    expect(
      CommerceTenantMutationResultSchema.safeParse({
        organizationId: ORG,
        replayed: true,
        receipt: membershipReceipt(),
      }).success,
    ).toBe(true);
  });

  it("enforces the organization receipt linkage on results", () => {
    expect(
      CommerceTenantMutationResultSchema.safeParse({
        organizationId: ORG_B,
        replayed: false,
        receipt: organizationReceipt(),
      }).success,
    ).toBe(false);
  });

  it("rejects replay flags that are not booleans", () => {
    for (const replayed of ["true", 0, 1, null, undefined]) {
      expect(
        CommerceTenantMutationResultSchema.safeParse({
          organizationId: ORG,
          replayed,
          receipt: organizationReceipt(),
        }).success,
      ).toBe(false);
    }
  });

  it("accepts committed status with matching organization and not_found", () => {
    expect(
      CommerceTenantMutationStatusSchema.safeParse({
        status: "committed",
        organizationId: ORG,
        receipt: organizationReceipt(),
      }).success,
    ).toBe(true);
    expect(
      CommerceTenantMutationStatusSchema.safeParse({
        status: "committed",
        organizationId: ORG,
        receipt: agentReceipt("tenant.agent.update"),
      }).success,
    ).toBe(true);
    expect(
      CommerceTenantMutationStatusSchema.safeParse({
        status: "not_found",
        organizationId: ORG,
      }).success,
    ).toBe(true);
  });

  it("enforces top-level organization and org receipt resource linkage", () => {
    expect(
      CommerceTenantMutationStatusSchema.safeParse({
        status: "committed",
        organizationId: ORG_B,
        receipt: organizationReceipt(),
      }).success,
    ).toBe(false);
    expect(
      CommerceTenantMutationStatusSchema.safeParse({
        status: "committed",
        organizationId: ORG,
        receipt: organizationReceipt(MUTATION, ORG_B),
      }).success,
    ).toBe(false);
  });

  it("rejects pending, failed and unknown status discriminators", () => {
    for (const status of ["pending", "failed", "succeeded", "unknown", ""]) {
      expect(
        CommerceTenantMutationStatusSchema.safeParse({
          status,
          organizationId: ORG,
          receipt: organizationReceipt(),
        }).success,
      ).toBe(false);
    }
    expect(
      CommerceTenantMutationStatusSchema.safeParse({
        status: "not_found",
        organizationId: ORG,
        receipt: organizationReceipt(),
      }).success,
    ).toBe(false);
  });

  it("rejects private extra fields at every status/result level", () => {
    for (const key of [
      "accountId",
      "role",
      "session",
      "idempotencyKey",
      "payload",
      "rawBody",
    ]) {
      expect(
        CommerceTenantMutationStatusSchema.safeParse({
          status: "committed",
          organizationId: ORG,
          receipt: organizationReceipt(),
          [key]: CANARY,
        }).success,
      ).toBe(false);
      expect(
        CommerceTenantMutationStatusSchema.safeParse({
          status: "committed",
          organizationId: ORG,
          receipt: { ...organizationReceipt(), [key]: CANARY },
        }).success,
      ).toBe(false);
      expect(
        CommerceTenantMutationResultSchema.safeParse({
          organizationId: ORG,
          replayed: false,
          receipt: { ...organizationReceipt(), [key]: CANARY },
        }).success,
      ).toBe(false);
    }
  });
});

describe("tenant mutation success envelopes", () => {
  const result = {
    organizationId: ORG,
    replayed: false,
    receipt: organizationReceipt(),
  };
  const status = {
    status: "committed" as const,
    organizationId: ORG,
    receipt: organizationReceipt(),
  };

  it("parses strict v2 success envelopes", () => {
    const mutation = {
      ok: true as const,
      data: result,
      meta: { ...META },
    };
    const statusEnvelope = {
      ok: true as const,
      data: status,
      meta: { ...META },
    };
    expect(CommerceTenantMutationResponseSchema.safeParse(mutation).success).toBe(
      true,
    );
    expect(
      CommerceTenantMutationStatusResponseSchema.safeParse(statusEnvelope)
        .success,
    ).toBe(true);
    expect(CommerceTenantMutationResponseSchema.parse(mutation).data).toEqual(
      result,
    );
  });

  it("is error-independent and rejects meta or ok mutations", () => {
    const mutation = { ok: true as const, data: result, meta: { ...META } };
    expect(
      CommerceTenantMutationResponseSchema.safeParse({
        ...mutation,
        ok: false,
      }).success,
    ).toBe(false);
    expect(
      CommerceTenantMutationResponseSchema.safeParse({
        ...mutation,
        meta: { ...META, buildLabel: "x" },
      }).success,
    ).toBe(false);
    expect(
      CommerceTenantMutationResponseSchema.safeParse({
        ...mutation,
        meta: { ...META, schemaVersion: "openarc.api.v1" },
      }).success,
    ).toBe(false);
    expect(
      CommerceTenantMutationResponseSchema.safeParse({
        ...mutation,
        meta: { ...META, buildSha: "deadbeef" },
      }).success,
    ).toBe(false);
    expect(
      CommerceTenantMutationResponseSchema.safeParse({
        ...mutation,
        data: { ...result, replayed: "false" },
      }).success,
    ).toBe(false);

    // The success envelope shares only the v2 meta shape with the error path.
    expect(COMMERCE_API_ERRORS.INVALID_REQUEST.retryable).toBe(false);
    expect(
      CommerceApiErrorEnvelopeSchema.safeParse({
        ok: false,
        error: {
          code: "INVALID_REQUEST",
          message: COMMERCE_API_ERRORS.INVALID_REQUEST.message,
          retryable: false,
        },
        meta: { ...META },
      }).success,
    ).toBe(true);
  });
});

describe("tenant write type integration", () => {
  it("exposes inferred body and receipt types without any", () => {
    expectTypeOf<CommerceOrganizationCreateBody["mutationId"]>().toEqualTypeOf<
      string
    >();
    expectTypeOf<CommerceOrganizationCreateBody["displayName"]>().toEqualTypeOf<
      string
    >();
    expectTypeOf<CommerceAgentCreateBody["displayName"]>().toEqualTypeOf<string>();
    expectTypeOf<CommerceProviderCreateBody["displayName"]>().toEqualTypeOf<string>();
    expectTypeOf<CommerceAgentUpdateBody["patch"]>().toEqualTypeOf<{
      displayName?: string | undefined;
      status?: "active" | "suspended" | "revoked" | undefined;
    }>();
    expectTypeOf<CommerceProviderUpdateBody["patch"]>().toEqualTypeOf<{
      displayName?: string | undefined;
      status?: "active" | "suspended" | "retired" | undefined;
    }>();
    expectTypeOf<CommerceMembershipSetBody["role"]>().toEqualTypeOf<
      "owner" | "operator" | "provider_admin" | "provider_developer" | "viewer"
    >();
    expectTypeOf<CommerceMembershipSetBody["membershipStatus"]>().toEqualTypeOf<
      "active" | "suspended"
    >();
  });

  it("exposes discriminated receipt and status types", () => {
    expectTypeOf<CommerceTenantMutationReceipt["operation"]>().toEqualTypeOf<
      | "tenant.organization.create"
      | "tenant.agent.create"
      | "tenant.agent.update"
      | "tenant.provider.create"
      | "tenant.provider.update"
      | "tenant.membership.set"
    >();
    expectTypeOf<CommerceTenantMutationResult["receipt"]>().toEqualTypeOf<CommerceTenantMutationReceipt>();
    expectTypeOf<CommerceTenantMutationStatus["status"]>().toEqualTypeOf<
      "committed" | "not_found"
    >();
  });

  it("keeps the idempotency key a header-only string type", () => {
    expectTypeOf<CommerceTenantIdempotencyKey>().toBeString();
    const receipt: CommerceTenantMutationReceipt = organizationReceipt();
    expect(Object.hasOwn(receipt, "idempotencyKey")).toBe(false);
    expect("idempotencyKey" in receipt).toBe(false);
  });
});
