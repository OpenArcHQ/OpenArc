import { describe, expect, expectTypeOf, it } from "vitest";

import {
  COMMERCE_TENANT_NETWORK,
  COMMERCE_TENANT_READ_FIELD_CLASSES,
  CommerceAgentListRequestSchema,
  CommerceAgentPageResponseSchema,
  CommerceAgentPageSchema,
  CommerceOrganizationContextRequestSchema,
  CommerceOrganizationContextResponseSchema,
  CommerceOrganizationContextSchema,
  CommerceOrganizationListRequestSchema,
  CommerceOrganizationPageResponseSchema,
  CommerceOrganizationPageSchema,
  CommerceProviderListRequestSchema,
  CommerceProviderPageResponseSchema,
  CommerceProviderPageSchema,
  type CommerceAgentListRequest,
  type CommerceAgentPage,
  type CommerceAgentPageResponse,
  type CommerceOrganizationContext,
  type CommerceOrganizationContextRequest,
  type CommerceOrganizationContextResponse,
  type CommerceOrganizationListRequest,
  type CommerceOrganizationPage,
  type CommerceOrganizationPageResponse,
  type CommerceProviderListRequest,
  type CommerceProviderPage,
  type CommerceProviderPageResponse,
} from "../src/index.js";

const V1 = "12345678-1234-1234-8123-123456789abc";
const V4 = "12345678-1234-4234-8123-123456789abc";
const V7 = "12345678-1234-7234-8123-123456789abc";
const V8 = "12345678-1234-8234-8123-123456789abc";

const ORG = `openarc:org:${V1}`;
const ORG_2 = `openarc:org:${V4}`;
const ORG_3 = `openarc:org:${V7}`;
const ACCOUNT = `openarc:account:${V4}`;
const AGENT = `openarc:agent:${V7}`;
const AGENT_3 = `openarc:agent:${V1}`;
const PROVIDER = `openarc:provider:${V8}`;
const PROVIDER_2 = `openarc:provider:${V1}`;

const ISO = "2024-01-01T00:00:00.000Z";
const ISO_LATER = "2024-01-01T00:00:00.001Z";
const PAST = "2000-01-01T00:00:00.000Z";

const CANARY = "PRIVATE_CANARY_DO_NOT_ECHO";
const SAMPLE_UUID = "9f1c2d34-5e6a-4b7c-8d9e-0f1a2b3c4d5e";
const SAMPLE_SHA = "0123456789abcdef0123456789abcdef01234567";

const META = {
  schemaVersion: "openarc.api.v2" as const,
  requestId: SAMPLE_UUID,
  buildSha: SAMPLE_SHA,
};

type ParseableSchema = {
  safeParse(value: unknown): { success: boolean };
};

function organization(organizationId: string, displayName = "Acme") {
  return {
    schemaVersion: "openarc.organization.v1" as const,
    organizationId,
    displayName,
    createdAt: ISO,
    updatedAt: ISO_LATER,
  };
}

function access(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: "openarc.organization-access.v1" as const,
    organizationId: ORG,
    accountId: ACCOUNT,
    role: "owner" as const,
    membershipStatus: "active" as const,
    sessionExpiresAt: PAST,
    ...overrides,
  };
}

function agent(agentId: string, organizationId = ORG, displayName = "Agent") {
  return {
    schemaVersion: "openarc.agent-profile.v1" as const,
    agentId,
    organizationId,
    displayName,
    status: "active" as const,
    createdAt: ISO,
    updatedAt: ISO,
  };
}

function provider(
  providerId: string,
  organizationId = ORG,
  displayName = "Provider",
) {
  return {
    schemaVersion: "openarc.provider-profile.v1" as const,
    providerId,
    organizationId,
    displayName,
    status: "active" as const,
    createdAt: ISO,
    updatedAt: ISO,
  };
}

describe("commerce tenant read requests", () => {
  const requestCases: readonly (readonly [ParseableSchema, unknown])[] = [
    [CommerceOrganizationListRequestSchema, {}],
    [CommerceOrganizationListRequestSchema, { afterOrganizationId: ORG }],
    [CommerceOrganizationListRequestSchema, { limit: 1 }],
    [CommerceOrganizationListRequestSchema, { limit: 100 }],
    [CommerceOrganizationListRequestSchema, { afterOrganizationId: ORG, limit: 50 }],
    [CommerceOrganizationContextRequestSchema, { organizationId: ORG }],
    [CommerceAgentListRequestSchema, { organizationId: ORG }],
    [CommerceAgentListRequestSchema, { organizationId: ORG, afterAgentId: AGENT }],
    [CommerceAgentListRequestSchema, { organizationId: ORG, limit: 100 }],
    [CommerceProviderListRequestSchema, { organizationId: ORG }],
    [
      CommerceProviderListRequestSchema,
      { organizationId: ORG, afterProviderId: PROVIDER },
    ],
    [CommerceProviderListRequestSchema, { organizationId: ORG, limit: 100 }],
  ];

  it("accepts the minimal and fully populated request shapes", () => {
    for (const [schema, value] of requestCases) {
      expect(schema.safeParse(value).success).toBe(true);
    }
  });

  it("does not default limit and strips nothing", () => {
    const parsed = CommerceOrganizationListRequestSchema.parse({});
    expect(parsed).toEqual({});
    expect("limit" in parsed).toBe(false);
    const parsedWithLimit = CommerceOrganizationListRequestSchema.parse({
      limit: 25,
    });
    expect(parsedWithLimit.limit).toBe(25);
  });

  it("rejects limits outside 1..100 and every non-integer form", () => {
    const badLimits: readonly unknown[] = [
      0,
      101,
      1.5,
      -1,
      "50",
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      true,
      null,
    ];
    const listSchemas = [
      CommerceOrganizationListRequestSchema,
      CommerceAgentListRequestSchema,
      CommerceProviderListRequestSchema,
    ] as const;
    for (const schema of listSchemas) {
      for (const limit of badLimits) {
        const base =
          schema === CommerceOrganizationListRequestSchema
            ? {}
            : { organizationId: ORG };
        expect(schema.safeParse({ ...base, limit }).success).toBe(false);
      }
    }
  });

  it("rejects wrong-typed, noncanonical and wrong-prefix cursors", () => {
    expect(
      CommerceOrganizationListRequestSchema.safeParse({
        afterOrganizationId: "openarc:account:" + V4,
      }).success,
    ).toBe(false);
    expect(
      CommerceOrganizationListRequestSchema.safeParse({
        afterOrganizationId: ORG.toUpperCase(),
      }).success,
    ).toBe(false);
    expect(
      CommerceAgentListRequestSchema.safeParse({
        organizationId: ORG,
        afterAgentId: "openarc:provider:" + V8,
      }).success,
    ).toBe(false);
    expect(
      CommerceProviderListRequestSchema.safeParse({
        organizationId: ORG,
        afterProviderId: "openarc:agent:" + V7,
      }).success,
    ).toBe(false);
    for (const value of [42, null, true, {}, []]) {
      expect(
        CommerceAgentListRequestSchema.safeParse({
          organizationId: ORG,
          afterAgentId: value,
        }).success,
      ).toBe(false);
    }
  });

  it("rejects selected account, role, principal, session, network and digest fields", () => {
    const forbidden = [
      "accountId",
      "role",
      "principal",
      "session",
      "sessionId",
      "network",
      "digest",
      "organization",
      "access",
      "payload",
      "dataClass",
      "rawBody",
      "requestBody",
      "privatePrompt",
      "credential",
      "signature",
      "cookie",
    ];
    const roots: readonly (readonly [ParseableSchema, object])[] = [
      [CommerceOrganizationListRequestSchema, {}],
      [CommerceOrganizationContextRequestSchema, { organizationId: ORG }],
      [CommerceAgentListRequestSchema, { organizationId: ORG }],
      [CommerceProviderListRequestSchema, { organizationId: ORG }],
    ];
    for (const [schema, base] of roots) {
      for (const key of forbidden) {
        expect(schema.safeParse({ ...base, [key]: CANARY }).success).toBe(false);
      }
    }
  });

  it("rejects malformed organization ids on list requests", () => {
    for (const schema of [
      CommerceOrganizationContextRequestSchema,
      CommerceAgentListRequestSchema,
      CommerceProviderListRequestSchema,
    ] as const) {
      for (const bad of ["", "openarc:org:", `openarc:org:${V4.toUpperCase()}`, 42, null]) {
        expect(schema.safeParse({ organizationId: bad }).success).toBe(false);
      }
    }
  });

  it("retains the inferred request types without any", () => {
    expectTypeOf<CommerceOrganizationListRequest["limit"]>().toEqualTypeOf<
      number | undefined
    >();
    expectTypeOf<CommerceOrganizationContextRequest["organizationId"]>().toEqualTypeOf<string>();
    expectTypeOf<CommerceAgentListRequest["afterAgentId"]>().toEqualTypeOf<
      string | undefined
    >();
    expectTypeOf<CommerceProviderListRequest["afterProviderId"]>().toEqualTypeOf<
      string | undefined
    >();
  });
});

describe("commerce tenant page and context shapes", () => {
  it("accepts empty pages with a null cursor", () => {
    expect(
      CommerceOrganizationPageSchema.safeParse({ items: [], nextCursor: null })
        .success,
    ).toBe(true);
    expect(
      CommerceAgentPageSchema.safeParse({
        organizationId: ORG,
        items: [],
        nextCursor: null,
      }).success,
    ).toBe(true);
    expect(
      CommerceProviderPageSchema.safeParse({
        organizationId: ORG,
        items: [],
        nextCursor: null,
      }).success,
    ).toBe(true);
  });

  it("accepts nonempty pages with a null or last-item cursor", () => {
    const orgPage = {
      items: [
        organization(ORG),
        organization(ORG_2),
        organization(ORG_3),
      ],
      nextCursor: ORG_3,
    };
    expect(CommerceOrganizationPageSchema.safeParse(orgPage).success).toBe(true);
    expect(
      CommerceOrganizationPageSchema.safeParse({ ...orgPage, nextCursor: null })
        .success,
    ).toBe(true);

    const agentPage = {
      organizationId: ORG,
      items: [agent(AGENT_3), agent(AGENT, ORG)],
      nextCursor: AGENT,
    };
    expect(CommerceAgentPageSchema.safeParse(agentPage).success).toBe(true);

    const providerPage = {
      organizationId: ORG,
      items: [provider(PROVIDER_2), provider(PROVIDER)],
      nextCursor: PROVIDER,
    };
    expect(CommerceProviderPageSchema.safeParse(providerPage).success).toBe(true);
  });

  it("rejects duplicate and out-of-order ids", () => {
    const duplicate = {
      items: [organization(ORG_2), organization(ORG_2)],
      nextCursor: null,
    };
    expect(CommerceOrganizationPageSchema.safeParse(duplicate).success).toBe(false);

    const unsorted = {
      items: [organization(ORG_3), organization(ORG_2)],
      nextCursor: null,
    };
    expect(CommerceOrganizationPageSchema.safeParse(unsorted).success).toBe(false);

    const agentUnsorted = {
      organizationId: ORG,
      items: [agent(AGENT), agent(AGENT_3)],
      nextCursor: null,
    };
    expect(CommerceAgentPageSchema.safeParse(agentUnsorted).success).toBe(false);

    const providerUnsorted = {
      organizationId: ORG,
      items: [provider(PROVIDER), provider(PROVIDER_2)],
      nextCursor: null,
    };
    expect(CommerceProviderPageSchema.safeParse(providerUnsorted).success).toBe(
      false,
    );
  });

  it("rejects a cursor that is not the last item or that is non-null on an empty page", () => {
    expect(
      CommerceOrganizationPageSchema.safeParse({
        items: [organization(ORG), organization(ORG_2)],
        nextCursor: ORG,
      }).success,
    ).toBe(false);
    expect(
      CommerceOrganizationPageSchema.safeParse({
        items: [],
        nextCursor: ORG,
      }).success,
    ).toBe(false);
    expect(
      CommerceAgentPageSchema.safeParse({
        organizationId: ORG,
        items: [],
        nextCursor: AGENT,
      }).success,
    ).toBe(false);
    expect(
      CommerceProviderPageSchema.safeParse({
        organizationId: ORG,
        items: [],
        nextCursor: PROVIDER,
      }).success,
    ).toBe(false);
  });

  it("rejects noncanonical, wrong-prefix and non-null-string cursors", () => {
    for (const bad of [
      "not-an-id",
      `openarc:account:${V4}`,
      ORG.toUpperCase(),
      42,
      true,
      {},
      [],
    ]) {
      expect(
        CommerceOrganizationPageSchema.safeParse({
          items: [organization(ORG)],
          nextCursor: bad,
        }).success,
      ).toBe(false);
    }
    expect(
      CommerceOrganizationPageSchema.safeParse({
        items: [organization(ORG)],
      }).success,
    ).toBe(false);
  });

  it("rejects more than 100 items", () => {
    const items = Array.from({ length: 101 }, (_, index) =>
      organization(`openarc:org:${String(index).padStart(8, "0")}-1234-4234-8123-123456789abc`),
    );
    expect(
      CommerceOrganizationPageSchema.safeParse({ items, nextCursor: null })
        .success,
    ).toBe(false);

    const agents = Array.from({ length: 101 }, (_, index) =>
      agent(`openarc:agent:${String(index).padStart(8, "0")}-1234-7234-8123-123456789abc`),
    );
    expect(
      CommerceAgentPageSchema.safeParse({
        organizationId: ORG,
        items: agents,
        nextCursor: null,
      }).success,
    ).toBe(false);
  });

  it("rejects mixed-organization items and wrong top-level organization ids", () => {
    expect(
      CommerceAgentPageSchema.safeParse({
        organizationId: ORG,
        items: [agent(AGENT, ORG_2)],
        nextCursor: null,
      }).success,
    ).toBe(false);
    expect(
      CommerceProviderPageSchema.safeParse({
        organizationId: ORG,
        items: [provider(PROVIDER, ORG_2)],
        nextCursor: null,
      }).success,
    ).toBe(false);
    expect(
      CommerceAgentPageSchema.safeParse({
        organizationId: `openarc:account:${V4}`,
        items: [],
        nextCursor: null,
      }).success,
    ).toBe(false);
  });

  it("validates the exact testnet context and cross-checks organization ids", () => {
    const context = {
      organization: organization(ORG, "Ünïcode Org"),
      access: access({ membershipStatus: "suspended" }),
      network: COMMERCE_TENANT_NETWORK,
    };
    expect(CommerceOrganizationContextSchema.safeParse(context).success).toBe(true);
    expect(COMMERCE_TENANT_NETWORK).toBe("eip155:5042002");
    expect(
      CommerceOrganizationContextSchema.safeParse({
        ...context,
        network: "eip155:1",
      }).success,
    ).toBe(false);
    expect(
      CommerceOrganizationContextSchema.safeParse({
        ...context,
        organization: organization(ORG_2),
      }).success,
    ).toBe(false);
    expect(
      CommerceOrganizationContextSchema.safeParse({
        ...context,
        access: access({ organizationId: ORG_2 }),
      }).success,
    ).toBe(false);
  });

  it("accepts every role view including suspended and Unicode display names", () => {
    for (const role of [
      "owner",
      "operator",
      "provider_admin",
      "provider_developer",
      "viewer",
    ] as const) {
      for (const membershipStatus of ["active", "suspended"] as const) {
        expect(
          CommerceOrganizationContextSchema.safeParse({
            organization: organization(ORG, "é".repeat(100)),
            access: access({ role, membershipStatus }),
            network: COMMERCE_TENANT_NETWORK,
          }).success,
        ).toBe(true);
      }
    }
  });

  it("rejects inherited strict timestamp refinements and wrong versions", () => {
    expect(
      CommerceOrganizationContextSchema.safeParse({
        organization: organization(ORG),
        access: access({
          sessionExpiresAt: "2024-13-01T00:00:00.000Z",
        }),
        network: COMMERCE_TENANT_NETWORK,
      }).success,
    ).toBe(false);
    expect(
      CommerceOrganizationPageSchema.safeParse({
        items: [{ ...organization(ORG), updatedAt: ISO, createdAt: ISO_LATER }],
        nextCursor: null,
      }).success,
    ).toBe(false);
    expect(
      CommerceOrganizationPageSchema.safeParse({
        items: [{ ...organization(ORG), schemaVersion: "openarc.organization.v2" }],
        nextCursor: null,
      }).success,
    ).toBe(false);
  });

  it("rejects unknown and private canary fields at every nested boundary", () => {
    const forbidden = [
      "privatePrompt",
      "rawOutput",
      "signature",
      "credential",
      "cookie",
      "dataClass",
      "payload",
      "rawBody",
      "nested",
    ];

    for (const key of forbidden) {
      expect(
        CommerceOrganizationPageSchema.safeParse({
          items: [organization(ORG)],
          nextCursor: null,
          [key]: CANARY,
        }).success,
      ).toBe(false);
      expect(
        CommerceOrganizationPageSchema.safeParse({
          items: [{ ...organization(ORG), [key]: CANARY }],
          nextCursor: null,
        }).success,
      ).toBe(false);
      expect(
        CommerceAgentPageSchema.safeParse({
          organizationId: ORG,
          items: [agent(AGENT)],
          nextCursor: null,
          [key]: CANARY,
        }).success,
      ).toBe(false);
      expect(
        CommerceAgentPageSchema.safeParse({
          organizationId: ORG,
          items: [{ ...agent(AGENT), [key]: CANARY }],
          nextCursor: null,
        }).success,
      ).toBe(false);
      expect(
        CommerceOrganizationContextSchema.safeParse({
          organization: organization(ORG),
          access: access(),
          network: COMMERCE_TENANT_NETWORK,
          [key]: CANARY,
        }).success,
      ).toBe(false);
      expect(
        CommerceOrganizationContextSchema.safeParse({
          organization: organization(ORG),
          access: { ...access(), [key]: CANARY },
          network: COMMERCE_TENANT_NETWORK,
        }).success,
      ).toBe(false);
      expect(
        CommerceOrganizationContextSchema.safeParse({
          organization: organization(ORG),
          access: access(),
          network: COMMERCE_TENANT_NETWORK,
          organizationExtra: { [key]: CANARY },
        }).success,
      ).toBe(false);
    }
  });

  it("retains the inferred response data types without any", () => {
    expectTypeOf<CommerceOrganizationPage["nextCursor"]>().toEqualTypeOf<
      string | null
    >();
    expectTypeOf<CommerceOrganizationContext["network"]>().toEqualTypeOf<
      "eip155:5042002"
    >();
    expectTypeOf<CommerceAgentPage["organizationId"]>().toEqualTypeOf<string>();
    expectTypeOf<CommerceProviderPage["nextCursor"]>().toEqualTypeOf<
      string | null
    >();
  });
});

describe("commerce tenant success envelopes", () => {
  const orgPage = {
    ok: true as const,
    data: { items: [organization(ORG)], nextCursor: ORG },
    meta: { ...META },
  };
  const context = {
    ok: true as const,
    data: {
      organization: organization(ORG),
      access: access(),
      network: COMMERCE_TENANT_NETWORK,
    },
    meta: { ...META },
  };
  const agentPage = {
    ok: true as const,
    data: { organizationId: ORG, items: [agent(AGENT)], nextCursor: null },
    meta: { ...META },
  };
  const providerPage = {
    ok: true as const,
    data: {
      organizationId: ORG,
      items: [provider(PROVIDER)],
      nextCursor: null,
    },
    meta: { ...META },
  };

  it("parses valid v2 envelopes for all four responses", () => {
    expect(CommerceOrganizationPageResponseSchema.safeParse(orgPage).success).toBe(
      true,
    );
    expect(
      CommerceOrganizationContextResponseSchema.safeParse(context).success,
    ).toBe(true);
    expect(CommerceAgentPageResponseSchema.safeParse(agentPage).success).toBe(true);
    expect(CommerceProviderPageResponseSchema.safeParse(providerPage).success).toBe(
      true,
    );
    expect(
      CommerceOrganizationPageResponseSchema.parse(orgPage).data,
    ).toEqual(orgPage.data);
  });

  it("rejects secret extra fields, meta overrides and wrong build versions", () => {
    const extra = { ...orgPage, privatePrompt: CANARY };
    expect(CommerceOrganizationPageResponseSchema.safeParse(extra).success).toBe(
      false,
    );
    const metaExtra = {
      ...orgPage,
      meta: { ...META, buildLabel: "x" },
    };
    expect(
      CommerceOrganizationPageResponseSchema.safeParse(metaExtra).success,
    ).toBe(false);
    const wrongVersion = {
      ...orgPage,
      meta: { ...META, schemaVersion: "openarc.api.v1" },
    };
    expect(
      CommerceOrganizationPageResponseSchema.safeParse(wrongVersion).success,
    ).toBe(false);
    const wrongSha = {
      ...orgPage,
      meta: { ...META, buildSha: "deadbeef" },
    };
    expect(
      CommerceOrganizationPageResponseSchema.safeParse(wrongSha).success,
    ).toBe(false);
  });

  it("rejects data mutations that violate the underlying data schema", () => {
    expect(
      CommerceOrganizationPageResponseSchema.safeParse({
        ...orgPage,
        ok: false,
      }).success,
    ).toBe(false);
    expect(
      CommerceOrganizationPageResponseSchema.safeParse({
        ...orgPage,
        data: { items: [], nextCursor: ORG },
      }).success,
    ).toBe(false);
    expect(
      CommerceOrganizationContextResponseSchema.safeParse({
        ...context,
        data: { ...context.data, network: "eip155:1" },
      }).success,
    ).toBe(false);
  });

  it("retains typed data through the envelopes", () => {
    const typed = CommerceOrganizationPageResponseSchema.parse(orgPage);
    expectTypeOf(typed.data).toEqualTypeOf<CommerceOrganizationPage>();
    expect(typed.ok).toBe(true);
    const typedContext = CommerceOrganizationContextResponseSchema.parse(context);
    expectTypeOf(typedContext.data).toEqualTypeOf<CommerceOrganizationContext>();
    const typedAgent = CommerceAgentPageResponseSchema.parse(agentPage);
    expectTypeOf(typedAgent.data).toEqualTypeOf<CommerceAgentPage>();
    const typedProvider = CommerceProviderPageResponseSchema.parse(providerPage);
    expectTypeOf(typedProvider.data).toEqualTypeOf<CommerceProviderPage>();

    expectTypeOf<CommerceOrganizationPageResponse["ok"]>().toEqualTypeOf<true>();
    expectTypeOf<CommerceOrganizationContextResponse["data"]>().toEqualTypeOf<CommerceOrganizationContext>();
    expectTypeOf<CommerceAgentPageResponse["data"]>().toEqualTypeOf<CommerceAgentPage>();
    expectTypeOf<CommerceProviderPageResponse["data"]>().toEqualTypeOf<CommerceProviderPage>();
  });
});

describe("commerce tenant read field classes", () => {
  const expected = {
    organizationPage: ["items", "nextCursor"],
    organizationContext: ["organization", "access", "network"],
    agentPage: ["organizationId", "items", "nextCursor"],
    providerPage: ["organizationId", "items", "nextCursor"],
  } as const;

  it("has exact frozen top-level keys all classified organization_protected", () => {
    expect(Object.isFrozen(COMMERCE_TENANT_READ_FIELD_CLASSES)).toBe(true);
    expect(Object.keys(COMMERCE_TENANT_READ_FIELD_CLASSES).sort()).toEqual(
      Object.keys(expected).sort(),
    );
    for (const [name, keys] of Object.entries(expected)) {
      const map =
        COMMERCE_TENANT_READ_FIELD_CLASSES[
          name as keyof typeof expected
        ];
      expect(Object.isFrozen(map)).toBe(true);
      expect(Object.keys(map).sort()).toEqual([...keys].sort());
      for (const value of Object.values(map)) {
        expect(value).toBe("organization_protected");
      }
    }
  });

  it("does not bleed nested identity leaves into the top-level map", () => {
    expect(
      Object.keys(COMMERCE_TENANT_READ_FIELD_CLASSES.organizationContext),
    ).not.toContain("organizationId");
    expect(
      Object.keys(COMMERCE_TENANT_READ_FIELD_CLASSES.organizationPage),
    ).not.toContain("displayName");
  });
});
