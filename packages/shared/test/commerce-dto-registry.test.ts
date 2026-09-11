import { describe, expect, expectTypeOf, it } from "vitest";
import type { z } from "zod";

import { COMMERCE_API_SCHEMA_VERSION } from "../src/commerce/api.js";
import {
  COMMERCE_IDENTITY_FIELD_CLASSES,
  CommerceAgentProfileSchema,
  CommerceOrganizationAccessViewSchema,
  CommerceOrganizationSchema,
  CommerceProviderProfileSchema,
  type CommerceAgentProfile,
  type CommerceOrganization,
  type CommerceOrganizationAccessView,
  type CommerceProviderProfile,
} from "../src/commerce/identity.js";
import {
  COMMERCE_IDENTITY_REGISTRY,
  CommerceProtectedIdentityDtoSchema,
  type CommerceProtectedIdentityDto,
} from "../src/commerce/registry.js";
import {
  COMMERCE_REGISTRY_VERSION,
  CommerceSchemaDescriptorSchema,
} from "../src/commerce/schema.js";

const CREATED_AT = "2025-01-01T00:00:00.000Z";
const UPDATED_AT = "2025-01-02T00:00:00.000Z";

const ORGANIZATION_ID = "openarc:org:11111111-1111-4111-8111-111111111111";
const ACCOUNT_ID = "openarc:account:22222222-2222-4222-9222-222222222222";
const AGENT_ID = "openarc:agent:33333333-3333-4333-a333-333333333333";
const PROVIDER_ID = "openarc:provider:44444444-4444-4444-b444-444444444444";
const REQUEST_ID = "55555555-5555-4555-8555-555555555555";
const BUILD_SHA = "0123456789abcdef0123456789abcdef01234567";

const META = {
  schemaVersion: COMMERCE_API_SCHEMA_VERSION,
  requestId: REQUEST_ID,
  buildSha: BUILD_SHA,
} as const;

const REGISTRY_KEYS = [
  "organization",
  "organizationAccessView",
  "agentProfile",
  "providerProfile",
] as const;

const organizationFixture = {
  schemaVersion: "openarc.organization.v1",
  organizationId: ORGANIZATION_ID,
  displayName: "Acme Robotics",
  createdAt: CREATED_AT,
  updatedAt: UPDATED_AT,
} satisfies CommerceOrganization;

const organizationAccessViewFixture = {
  schemaVersion: "openarc.organization-access.v1",
  organizationId: ORGANIZATION_ID,
  accountId: ACCOUNT_ID,
  role: "owner",
  membershipStatus: "active",
  sessionExpiresAt: "2030-01-01T00:00:00.000Z",
} satisfies CommerceOrganizationAccessView;

const agentProfileFixture = {
  schemaVersion: "openarc.agent-profile.v1",
  agentId: AGENT_ID,
  organizationId: ORGANIZATION_ID,
  displayName: "Support Agent",
  status: "active",
  createdAt: CREATED_AT,
  updatedAt: UPDATED_AT,
} satisfies CommerceAgentProfile;

const providerProfileFixture = {
  schemaVersion: "openarc.provider-profile.v1",
  providerId: PROVIDER_ID,
  organizationId: ORGANIZATION_ID,
  displayName: "Acme Provider",
  status: "active",
  createdAt: CREATED_AT,
  updatedAt: UPDATED_AT,
} satisfies CommerceProviderProfile;

const CASES = [
  {
    key: "organization",
    schema: CommerceOrganizationSchema,
    fixture: organizationFixture,
  },
  {
    key: "organizationAccessView",
    schema: CommerceOrganizationAccessViewSchema,
    fixture: organizationAccessViewFixture,
  },
  {
    key: "agentProfile",
    schema: CommerceAgentProfileSchema,
    fixture: agentProfileFixture,
  },
  {
    key: "providerProfile",
    schema: CommerceProviderProfileSchema,
    fixture: providerProfileFixture,
  },
] as const;

describe("commerce protected identity registry", () => {
  it("exposes exactly the four entries with unique literal contract ids", () => {
    expect(Object.keys(COMMERCE_IDENTITY_REGISTRY).sort()).toEqual(
      [...REGISTRY_KEYS].sort(),
    );

    const contractIds = REGISTRY_KEYS.map(
      (key) => COMMERCE_IDENTITY_REGISTRY[key].descriptor.contractId,
    );
    expect(contractIds).toEqual([
      "openarc.commerce.organization.v1",
      "openarc.commerce.organization_access.v1",
      "openarc.commerce.agent_profile.v1",
      "openarc.commerce.provider_profile.v1",
    ]);
    expect(new Set(contractIds).size).toBe(contractIds.length);
  });

  it("validates every descriptor and keeps every boundary organization-only", () => {
    for (const key of REGISTRY_KEYS) {
      const { descriptor } = COMMERCE_IDENTITY_REGISTRY[key];
      const parsed = CommerceSchemaDescriptorSchema.safeParse(descriptor);
      expect(parsed.success).toBe(true);
      if (!parsed.success) continue;

      expect(parsed.data.schemaVersion).toBe(COMMERCE_REGISTRY_VERSION);
      expect(parsed.data.contractId).toBe(descriptor.contractId);
      expect(parsed.data.boundary.dataClass).toBe("organization_protected");
      expect(parsed.data.boundary.audience).toBe("organization");
      expect(parsed.data.boundary.serverPersistence).toBe("allowed");
    }
  });

  it("freezes the registry, entries, descriptors, boundaries and field maps", () => {
    expect(Object.isFrozen(COMMERCE_IDENTITY_REGISTRY)).toBe(true);
    for (const key of REGISTRY_KEYS) {
      const entry = COMMERCE_IDENTITY_REGISTRY[key];
      expect(Object.isFrozen(entry)).toBe(true);
      expect(Object.isFrozen(entry.descriptor)).toBe(true);
      expect(Object.isFrozen(entry.descriptor.boundary)).toBe(true);
      expect(Object.isFrozen(entry.fields)).toBe(true);
      expect(entry.fields).toBe(COMMERCE_IDENTITY_FIELD_CLASSES[key]);
    }
  });

  it("binds each entry to the expected schema and exact field keys", () => {
    for (const { key, schema, fixture } of CASES) {
      const entry = COMMERCE_IDENTITY_REGISTRY[key];

      expect(entry.schema).toBe(schema);
      expect(entry.fields).toBe(COMMERCE_IDENTITY_FIELD_CLASSES[key]);

      const shapeKeys = Object.keys(schema.shape).sort();
      const fieldKeys = Object.keys(entry.fields).sort();
      expect(fieldKeys).toEqual(shapeKeys);
      expect(fieldKeys).toContain("schemaVersion");

      const result = schema.safeParse(fixture);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(Object.keys(result.data).sort()).toEqual(fieldKeys);
      }

      for (const classification of Object.values(entry.fields)) {
        expect(classification).toBe("organization_protected");
      }
    }
  });

  it("parses each fixture via its schema, the union and its v2 success envelope", () => {
    for (const { key, schema, fixture } of CASES) {
      const individual = schema.safeParse(fixture);
      expect(individual.success).toBe(true);

      const union = CommerceProtectedIdentityDtoSchema.safeParse(fixture);
      expect(union.success).toBe(true);
      if (union.success) {
        expect(union.data).toEqual(fixture);
      }

      const envelope = COMMERCE_IDENTITY_REGISTRY[key].successSchema.safeParse({
        ok: true,
        data: fixture,
        meta: META,
      });
      expect(envelope.success).toBe(true);
      if (envelope.success) {
        expect(envelope.data.meta).toEqual(META);
      }
    }
  });

  it("rejects unknown, missing, wrong, legacy, non-object and injected payloads", () => {
    const organizationWithoutVersion = {
      organizationId: ORGANIZATION_ID,
      displayName: "Acme Robotics",
      createdAt: CREATED_AT,
      updatedAt: UPDATED_AT,
    };

    const invalidPayloads: readonly unknown[] = [
      { ...organizationFixture, schemaVersion: "openarc.organization.v2" },
      {
        ...organizationFixture,
        schemaVersion: "openarc.commerce.organization.v1",
      },
      organizationWithoutVersion,
      { ...organizationFixture, schemaVersion: "openarc.evidence.v1" },
      "openarc.organization.v1",
      42,
      null,
      [],
      [organizationFixture],
      { ...organizationFixture, privatePrompt: "secret" },
      { ...organizationFixture, rawOutput: "raw" },
      { ...organizationFixture, credential: "secret" },
      { ...organizationFixture, privateKey: "0xdeadbeef" },
      { ...organizationFixture, audience: "organization" },
      { ...organizationFixture, dataClass: "organization_protected" },
    ];

    for (const payload of invalidPayloads) {
      expect(() =>
        CommerceProtectedIdentityDtoSchema.safeParse(payload),
      ).not.toThrow();
      expect(
        CommerceProtectedIdentityDtoSchema.safeParse(payload).success,
      ).toBe(false);
    }
  });

  it("rejects cross-DTO data and extra or legacy envelope metadata per entry", () => {
    for (const { key, fixture } of CASES) {
      const envelopeSchema = COMMERCE_IDENTITY_REGISTRY[key].successSchema;

      for (const other of CASES) {
        if (other.key === key) continue;
        expect(
          envelopeSchema.safeParse({
            ok: true,
            data: other.fixture,
            meta: META,
          }).success,
        ).toBe(false);
      }

      expect(
        envelopeSchema.safeParse({
          ok: true,
          data: fixture,
          meta: META,
          extra: "x",
        }).success,
      ).toBe(false);

      expect(
        envelopeSchema.safeParse({
          ok: true,
          data: { ...fixture, injected: "x" },
          meta: META,
        }).success,
      ).toBe(false);

      expect(
        envelopeSchema.safeParse({
          ok: true,
          data: fixture,
          meta: { ...META, extra: "x" },
        }).success,
      ).toBe(false);

      expect(
        envelopeSchema.safeParse({
          ok: true,
          data: fixture,
          meta: { ...META, schemaVersion: "openarc.api.v1" },
        }).success,
      ).toBe(false);

      expect(
        envelopeSchema.safeParse({
          ok: true,
          data: fixture,
          meta: { ...META, buildSha: "ZZZ" },
        }).success,
      ).toBe(false);

      expect(
        envelopeSchema.safeParse({
          ok: true,
          data: fixture,
          meta: { ...META, buildSha: BUILD_SHA.toUpperCase() },
        }).success,
      ).toBe(false);

      expect(
        envelopeSchema.safeParse({
          ok: false,
          data: fixture,
          meta: META,
        }).success,
      ).toBe(false);
    }
  });

  it("keeps strict object refinements through the union and success envelope", () => {
    const decreasingDay = {
      ...organizationFixture,
      createdAt: UPDATED_AT,
      updatedAt: CREATED_AT,
    };
    const decreasingSubMillisecond = {
      ...organizationFixture,
      createdAt: "2025-01-01T00:00:00.000000002Z",
      updatedAt: "2025-01-01T00:00:00.000000001Z",
    };
    const invalidTimestamp = {
      ...organizationFixture,
      createdAt: "not-a-timestamp",
    };

    for (const payload of [
      decreasingDay,
      decreasingSubMillisecond,
      invalidTimestamp,
    ]) {
      expect(CommerceOrganizationSchema.safeParse(payload).success).toBe(false);
      expect(
        CommerceProtectedIdentityDtoSchema.safeParse(payload).success,
      ).toBe(false);
      expect(
        COMMERCE_IDENTITY_REGISTRY.organization.successSchema.safeParse({
          ok: true,
          data: payload,
          meta: META,
        }).success,
      ).toBe(false);
    }
  });

  it("accepts increasing sub-millisecond and sparse-precision timestamps", () => {
    const subMillisecondIncreasing = {
      ...organizationFixture,
      createdAt: "2025-01-01T00:00:00.000000001Z",
      updatedAt: "2025-01-01T00:00:00.000000002Z",
    };
    const sparseFractionIncreasing = {
      ...organizationFixture,
      createdAt: "2025-01-01T00:00:00.0001Z",
      updatedAt: UPDATED_AT,
    };

    for (const payload of [
      subMillisecondIncreasing,
      sparseFractionIncreasing,
    ]) {
      expect(CommerceOrganizationSchema.safeParse(payload).success).toBe(true);
      expect(
        CommerceProtectedIdentityDtoSchema.safeParse(payload).success,
      ).toBe(true);
      expect(
        COMMERCE_IDENTITY_REGISTRY.organization.successSchema.safeParse({
          ok: true,
          data: payload,
          meta: META,
        }).success,
      ).toBe(true);
    }
  });

  it("treats access-view session expiry as a display record, not live auth", () => {
    const expired = {
      ...organizationAccessViewFixture,
      sessionExpiresAt: "2000-01-01T00:00:00.000Z",
    };

    expect(
      CommerceOrganizationAccessViewSchema.safeParse(expired).success,
    ).toBe(true);
    expect(
      CommerceProtectedIdentityDtoSchema.safeParse(expired).success,
    ).toBe(true);
    expect(
      COMMERCE_IDENTITY_REGISTRY.organizationAccessView.successSchema.safeParse(
        { ok: true, data: expired, meta: META },
      ).success,
    ).toBe(true);
  });

  it("keeps the union and per-entry envelope data types precise", () => {
    expectTypeOf<CommerceOrganization>().toMatchTypeOf<CommerceProtectedIdentityDto>();
    expectTypeOf<CommerceOrganizationAccessView>().toMatchTypeOf<CommerceProtectedIdentityDto>();
    expectTypeOf<CommerceAgentProfile>().toMatchTypeOf<CommerceProtectedIdentityDto>();
    expectTypeOf<CommerceProviderProfile>().toMatchTypeOf<CommerceProtectedIdentityDto>();

    expectTypeOf<CommerceProtectedIdentityDto>().toMatchTypeOf<
      | CommerceOrganization
      | CommerceOrganizationAccessView
      | CommerceAgentProfile
      | CommerceProviderProfile
    >();

    type OrganizationEnvelopeData = z.infer<
      typeof COMMERCE_IDENTITY_REGISTRY.organization.successSchema
    >["data"];
    expectTypeOf<OrganizationEnvelopeData>().toEqualTypeOf<CommerceOrganization>();
    expectTypeOf<OrganizationEnvelopeData>().not.toBeUnknown();
    expectTypeOf<OrganizationEnvelopeData>().not.toEqualTypeOf<CommerceProtectedIdentityDto>();

    expectTypeOf<
      z.infer<
        typeof COMMERCE_IDENTITY_REGISTRY.organizationAccessView.successSchema
      >["data"]
    >().toEqualTypeOf<CommerceOrganizationAccessView>();

    expectTypeOf<
      z.infer<
        typeof COMMERCE_IDENTITY_REGISTRY.agentProfile.successSchema
      >["data"]
    >().toEqualTypeOf<CommerceAgentProfile>();

    expectTypeOf<
      z.infer<
        typeof COMMERCE_IDENTITY_REGISTRY.providerProfile.successSchema
      >["data"]
    >().toEqualTypeOf<CommerceProviderProfile>();
  });
});
