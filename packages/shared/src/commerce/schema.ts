import { z } from "zod";
import { CommerceBoundarySchema } from "./privacy.js";

/**
 * Registry metadata version for the commerce schema descriptor contract.
 */
export const COMMERCE_REGISTRY_VERSION =
  "openarc.commerce.registry.v1" as const;

/**
 * Registry descriptor metadata only.
 *
 * This is NOT a field-level DTO registry. Full field-level DTO registries are
 * follow-up P01-01 work and are not claimed completed here. There are no
 * z.record / z.any / unknown payload slots, no implicit stripping, no nullable
 * defaults and no fetch. All names are prefixed `Commerce` to avoid colliding
 * with legacy schemas such as EvidenceClassSchema.
 */
export const CommerceSchemaDescriptorSchema = z.strictObject({
  schemaVersion: z.literal(COMMERCE_REGISTRY_VERSION),
  contractId: z
    .string()
    .max(96)
    .regex(/^openarc\.commerce\.[a-z][a-z0-9_]*\.v[1-9][0-9]*$/u),
  boundary: CommerceBoundarySchema,
});

export type CommerceSchemaDescriptor = z.infer<
  typeof CommerceSchemaDescriptorSchema
>;
