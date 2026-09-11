import { z } from "zod";

/**
 * Commerce data classification for contract metadata.
 *
 * IMPORTANT: These schemas are CONTRACT METADATA ONLY. They describe the
 * declared shape of a boundary record. They are NOT authorization, NOT runtime
 * redaction, NOT validation of content, and NOT public-release approval.
 * A caller-provided `dataClass` never grants any capability. Do not add a
 * function that authorizes based on caller-provided dataClass.
 */
export const CommerceDataClassSchema = z.enum([
  "public",
  "organization_protected",
  "local_private",
  "secret_ephemeral",
]);

export type CommerceDataClass = z.infer<typeof CommerceDataClassSchema>;

/**
 * Strict discriminated union of the only legal boundary combinations.
 * The discriminator is `dataClass`; audience and serverPersistence are fixed
 * per class. This remains descriptive metadata, not an enforcement mechanism.
 */
export const CommerceBoundarySchema = z.discriminatedUnion("dataClass", [
  z.strictObject({
    dataClass: z.literal("public"),
    audience: z.literal("public"),
    serverPersistence: z.literal("allowed"),
  }),
  z.strictObject({
    dataClass: z.literal("organization_protected"),
    audience: z.enum(["organization", "provider_minimal"]),
    serverPersistence: z.literal("allowed"),
  }),
  z.strictObject({
    dataClass: z.literal("local_private"),
    audience: z.literal("local"),
    serverPersistence: z.literal("forbidden"),
  }),
  z.strictObject({
    dataClass: z.literal("secret_ephemeral"),
    audience: z.literal("ephemeral"),
    serverPersistence: z.literal("forbidden"),
  }),
]);

export type CommerceBoundary = z.infer<typeof CommerceBoundarySchema>;
