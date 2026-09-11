import { z } from "zod";

import { createCommerceSuccessEnvelopeSchema } from "./api.js";
import {
  COMMERCE_IDENTITY_FIELD_CLASSES,
  CommerceAgentProfileSchema,
  CommerceOrganizationAccessViewSchema,
  CommerceOrganizationSchema,
  CommerceProviderProfileSchema,
} from "./identity.js";
import {
  COMMERCE_REGISTRY_VERSION,
  type CommerceSchemaDescriptor,
} from "./schema.js";

/**
 * Boundary label for the four existing protected identity DTOs. This is
 * conservative registry metadata only: it is not an access-control decision
 * and does not authorize any audience or persistence path.
 */
function createIdentityBoundary() {
  return Object.freeze({
    dataClass: "organization_protected",
    audience: "organization",
    serverPersistence: "allowed",
  } as const);
}

function createIdentityDescriptor<ContractId extends string>(
  contractId: ContractId,
) {
  return Object.freeze({
    schemaVersion: COMMERCE_REGISTRY_VERSION,
    contractId,
    boundary: createIdentityBoundary(),
  } satisfies CommerceSchemaDescriptor);
}

/**
 * Static, explicitly scoped registry of the FOUR existing protected identity
 * DTOs only (organization, organization access view, agent profile, provider
 * profile). It makes no claim about future listing, payment or evidence
 * contracts, and it has no dynamic registration, reflection-based redaction,
 * caller-supplied audience, or arbitrary data slot. Field classifications are
 * labels, not authorization.
 */
export const COMMERCE_IDENTITY_REGISTRY = Object.freeze({
  organization: Object.freeze({
    descriptor: createIdentityDescriptor("openarc.commerce.organization.v1"),
    schema: CommerceOrganizationSchema,
    fields: COMMERCE_IDENTITY_FIELD_CLASSES.organization,
    successSchema:
      createCommerceSuccessEnvelopeSchema(CommerceOrganizationSchema),
  }),
  organizationAccessView: Object.freeze({
    descriptor: createIdentityDescriptor(
      "openarc.commerce.organization_access.v1",
    ),
    schema: CommerceOrganizationAccessViewSchema,
    fields: COMMERCE_IDENTITY_FIELD_CLASSES.organizationAccessView,
    successSchema: createCommerceSuccessEnvelopeSchema(
      CommerceOrganizationAccessViewSchema,
    ),
  }),
  agentProfile: Object.freeze({
    descriptor: createIdentityDescriptor("openarc.commerce.agent_profile.v1"),
    schema: CommerceAgentProfileSchema,
    fields: COMMERCE_IDENTITY_FIELD_CLASSES.agentProfile,
    successSchema: createCommerceSuccessEnvelopeSchema(
      CommerceAgentProfileSchema,
    ),
  }),
  providerProfile: Object.freeze({
    descriptor: createIdentityDescriptor(
      "openarc.commerce.provider_profile.v1",
    ),
    schema: CommerceProviderProfileSchema,
    fields: COMMERCE_IDENTITY_FIELD_CLASSES.providerProfile,
    successSchema: createCommerceSuccessEnvelopeSchema(
      CommerceProviderProfileSchema,
    ),
  }),
});

/**
 * Strict discriminated union of the four existing protected identity DTOs.
 * Membership is fixed at compile time; callers cannot extend it.
 */
export const CommerceProtectedIdentityDtoSchema = z.discriminatedUnion(
  "schemaVersion",
  [
    CommerceOrganizationSchema,
    CommerceOrganizationAccessViewSchema,
    CommerceAgentProfileSchema,
    CommerceProviderProfileSchema,
  ],
);

export type CommerceProtectedIdentityDto = z.infer<
  typeof CommerceProtectedIdentityDtoSchema
>;
