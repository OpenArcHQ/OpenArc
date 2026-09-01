import { z } from "zod";

export const EvmAddressSchema = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/u, "Expected a 20-byte EVM address")
  .transform((value) => value.toLowerCase());

export const TransactionHashSchema = z
  .string()
  .regex(/^0x[0-9a-fA-F]{64}$/u, "Expected a 32-byte transaction hash")
  .transform((value) => value.toLowerCase());

export const CanonicalIntegerSchema = z
  .string()
  .regex(
    /^(0|[1-9][0-9]{0,77})$/u,
    "Expected an unsigned base-10 integer string of at most 78 digits",
  );

export const CanonicalDecimalSchema = z
  .string()
  .regex(
    /^(0|[1-9][0-9]{0,77})(\.[0-9]{1,78})?$/u,
    "Expected an unsigned decimal with at most 78 integer and 78 fractional digits",
  )
  .refine((value) => !value.includes(".") || !value.endsWith("0"), {
    message: "Fractional trailing zeros are not canonical",
  });

export const IsoTimestampSchema = z
  .iso.datetime({ offset: false, local: false })
  .refine((value) => value.endsWith("Z"), {
    message: "Expected an ISO 8601 UTC timestamp ending in Z",
  });

export const Sha256DigestSchema = z
  .string()
  .regex(/^sha256:[0-9a-f]{64}$/u, "Expected a lowercase SHA-256 digest");

export const BuildMarkerSchema = z
  .string()
  .regex(/^[A-Za-z0-9._-]{1,64}$/u, "Expected a bounded deployment build marker");

export const BuildInfoSchema = z.strictObject({
  service: z.enum(["openarc-api", "openarc-web"]),
  version: z.string().min(1).max(64),
  commitSha: BuildMarkerSchema,
});

export type BuildInfo = z.infer<typeof BuildInfoSchema>;
