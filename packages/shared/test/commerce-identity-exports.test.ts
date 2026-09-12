import { describe, expect, expectTypeOf, it } from "vitest";

import {
  COMMERCE_IDENTITY_FIELD_CLASSES,
  CommerceAccountIdSchema,
  CommerceAgentIdSchema,
  CommerceAgentProfileSchema,
  CommerceHumanRoleSchema,
  CommerceOrganizationAccessViewSchema,
  CommerceOrganizationIdSchema,
  CommerceOrganizationSchema,
  CommerceProviderIdSchema,
  CommerceProviderProfileSchema,
  type CommerceAgentProfile,
  type CommerceHumanRole,
  type CommerceOrganization,
  type CommerceOrganizationAccessView,
  type CommerceProviderProfile,
} from "../src/index.js";
import {
  CommerceAgentProfileSchema as IdentityModuleAgentProfileSchema,
  CommerceHumanRoleSchema as IdentityModuleHumanRoleSchema,
  CommerceOrganizationAccessViewSchema as IdentityModuleAccessViewSchema,
  CommerceOrganizationIdSchema as IdentityModuleOrganizationIdSchema,
  CommerceOrganizationSchema as IdentityModuleOrganizationSchema,
  CommerceProviderProfileSchema as IdentityModuleProviderProfileSchema,
} from "../src/commerce/identity.js";

/**
 * Closure test for the additive shared root export.
 *
 * The canonical commerce identity schemas, types and the field-class registry
 * must be reachable through the public `@openarc/shared` source index, and the
 * values re-exported there must be the exact same validator instances as the
 * identity module so the package cannot drift into a second source of truth.
 */

const V4 = "12345678-1234-4234-8123-123456789abc";
const ORG = `openarc:org:${V4}`;
const ACCOUNT = `openarc:account:${V4}`;
const ISO = "2024-01-01T00:00:00.000Z";

describe("shared root commerce identity export closure", () => {
  it("re-exports the exact canonical identity validators from the source index", () => {
    expect(CommerceOrganizationSchema).toBe(IdentityModuleOrganizationSchema);
    expect(CommerceOrganizationAccessViewSchema).toBe(IdentityModuleAccessViewSchema);
    expect(CommerceAgentProfileSchema).toBe(IdentityModuleAgentProfileSchema);
    expect(CommerceProviderProfileSchema).toBe(IdentityModuleProviderProfileSchema);
    expect(CommerceHumanRoleSchema).toBe(IdentityModuleHumanRoleSchema);
    expect(CommerceOrganizationIdSchema).toBe(IdentityModuleOrganizationIdSchema);
  });

  it("keeps the id schemas usable through the public index", () => {
    expect(CommerceOrganizationIdSchema.safeParse(ORG).success).toBe(true);
    expect(CommerceAccountIdSchema.safeParse(ACCOUNT).success).toBe(true);
    expect(CommerceAgentIdSchema.safeParse(`openarc:agent:${V4}`).success).toBe(true);
    expect(CommerceProviderIdSchema.safeParse(`openarc:provider:${V4}`).success).toBe(true);
    expect(CommerceOrganizationIdSchema.safeParse(ACCOUNT).success).toBe(false);
  });

  it("validates canonical DTOs through the public index schemas", () => {
    const organization = {
      schemaVersion: "openarc.organization.v1",
      organizationId: ORG,
      displayName: "Acme",
      createdAt: ISO,
      updatedAt: ISO,
    };
    const access = {
      schemaVersion: "openarc.organization-access.v1",
      organizationId: ORG,
      accountId: ACCOUNT,
      role: "owner",
      membershipStatus: "active",
      sessionExpiresAt: ISO,
    };
    const agent = {
      schemaVersion: "openarc.agent-profile.v1",
      agentId: `openarc:agent:${V4}`,
      organizationId: ORG,
      displayName: "Agent",
      status: "active",
      createdAt: ISO,
      updatedAt: ISO,
    };
    const provider = {
      schemaVersion: "openarc.provider-profile.v1",
      providerId: `openarc:provider:${V4}`,
      organizationId: ORG,
      displayName: "Provider",
      status: "active",
      createdAt: ISO,
      updatedAt: ISO,
    };
    expect(CommerceOrganizationSchema.safeParse(organization).success).toBe(true);
    expect(CommerceOrganizationAccessViewSchema.safeParse(access).success).toBe(true);
    expect(CommerceAgentProfileSchema.safeParse(agent).success).toBe(true);
    expect(CommerceProviderProfileSchema.safeParse(provider).success).toBe(true);
    expect(
      CommerceOrganizationSchema.safeParse({ ...organization, extra: true }).success,
    ).toBe(false);
  });

  it("preserves the canonical DTO and role types through the public index", () => {
    expectTypeOf<CommerceOrganization["schemaVersion"]>().toEqualTypeOf<"openarc.organization.v1">();
    expectTypeOf<CommerceHumanRole>().toEqualTypeOf<
      "owner" | "operator" | "provider_admin" | "provider_developer" | "viewer"
    >();
    expectTypeOf<CommerceAgentProfile["status"]>().toEqualTypeOf<
      "active" | "suspended" | "revoked"
    >();
    expectTypeOf<CommerceProviderProfile["status"]>().toEqualTypeOf<
      "active" | "suspended" | "retired"
    >();
    expectTypeOf<CommerceOrganizationAccessView["membershipStatus"]>().toEqualTypeOf<
      "active" | "suspended"
    >();
  });

  it("exposes the frozen field-class registry through the public index", () => {
    expect(Object.isFrozen(COMMERCE_IDENTITY_FIELD_CLASSES)).toBe(true);
    expect(COMMERCE_IDENTITY_FIELD_CLASSES.organization.organizationId).toBe(
      "organization_protected",
    );
  });
});
