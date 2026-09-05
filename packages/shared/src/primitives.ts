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

export const Uint256DecimalSchema = CanonicalIntegerSchema.refine(
  (value) => /^(0|[1-9][0-9]{0,77})$/u.test(value) && BigInt(value) <= (1n << 256n) - 1n,
  { message: "Expected an unsigned 256-bit integer" },
);

export const Uint64DecimalSchema = CanonicalIntegerSchema.refine(
  (value) => /^(0|[1-9][0-9]{0,77})$/u.test(value) && BigInt(value) <= (1n << 64n) - 1n,
  { message: "Expected an unsigned 64-bit integer" },
);

export const SignedCanonicalIntegerSchema = z.string().regex(
  /^(0|-?[1-9][0-9]{0,38})$/u,
  "Expected a canonical signed integer string",
);

export const SignedCanonicalDecimalSchema = z
  .string()
  .regex(
    /^(0|-?[1-9][0-9]{0,38})(\.[0-9]{1,38})?$/u,
    "Expected a canonical signed decimal",
  )
  .refine((value) => !value.includes(".") || !value.endsWith("0"), {
    message: "Fractional trailing zeros are not canonical",
  });

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
  .refine((value) => value.length <= 30, {
    message: "Expected a UTC timestamp of at most 30 characters",
  })
  .refine((value) => !/\.(\d+)Z$/u.test(value) || /\.\d{1,9}Z$/u.test(value), {
    message: "Expected at most 9 fractional-second digits",
  })
  .refine((value) => value.endsWith("Z"), {
    message: "Expected an ISO 8601 UTC timestamp ending in Z",
  });

export function compareIsoTimestamps(left: string, right: string): number {
  const pattern = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d+))?Z$/u;
  const leftMatch = pattern.exec(left);
  const rightMatch = pattern.exec(right);
  if (!leftMatch || !rightMatch) throw new Error("Expected valid ISO 8601 UTC timestamps");

  const leftSecond = Date.parse(`${leftMatch[1]}Z`);
  const rightSecond = Date.parse(`${rightMatch[1]}Z`);
  if (!Number.isFinite(leftSecond) || !Number.isFinite(rightSecond)) {
    throw new Error("Expected valid ISO 8601 UTC timestamps");
  }
  if (leftSecond !== rightSecond) return leftSecond < rightSecond ? -1 : 1;

  const leftFraction = leftMatch[2] ?? "";
  const rightFraction = rightMatch[2] ?? "";
  const precision = Math.max(leftFraction.length, rightFraction.length);
  const normalizedLeft = leftFraction.padEnd(precision, "0");
  const normalizedRight = rightFraction.padEnd(precision, "0");
  if (normalizedLeft === normalizedRight) return 0;
  return normalizedLeft < normalizedRight ? -1 : 1;
}

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
