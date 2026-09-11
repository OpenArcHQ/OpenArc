import { z } from "zod";

import { Uint256DecimalSchema } from "../primitives.js";

const SCALE = 1000000000000n;
const MAX_UINT256 =
  115792089237316195423570985008687907853269984665640564039457584007913129639935n;

const SCHEMA_VERSION = "openarc.usdc-amount.v1";
const NETWORK_ID = "eip155:5042002";
const ASSET = "USDC";

const OVERFLOW_MESSAGE = "USDC amount exceeds uint256 range";
const PRECISION_MESSAGE = "USDC amount conversion would lose precision";
const UNDERFLOW_MESSAGE = "USDC amount subtraction underflow";
const UNIT_MISMATCH_MESSAGE =
  "USDC amounts must share representation, network, asset, and decimals";

export const CommerceUsdcRepresentationSchema = z.enum(["native", "erc20"]);
export type CommerceUsdcRepresentation = z.infer<
  typeof CommerceUsdcRepresentationSchema
>;

const commerceUsdcAmountCommonShape = {
  schemaVersion: z.literal(SCHEMA_VERSION),
  networkId: z.literal(NETWORK_ID),
  asset: z.literal(ASSET),
  atomicAmount: Uint256DecimalSchema,
} as const;

export const CommerceUsdcAmountSchema = z.discriminatedUnion(
  "representation",
  [
    z.strictObject({
      ...commerceUsdcAmountCommonShape,
      representation: z.literal("native"),
      decimals: z.literal(18),
    }),
    z.strictObject({
      ...commerceUsdcAmountCommonShape,
      representation: z.literal("erc20"),
      decimals: z.literal(6),
    }),
  ],
);
export type CommerceUsdcAmount = z.infer<typeof CommerceUsdcAmountSchema>;

export function createCommerceUsdcAmount(
  representation: CommerceUsdcRepresentation,
  atomicAmount: string,
): CommerceUsdcAmount {
  const rep = CommerceUsdcRepresentationSchema.parse(representation);
  const atomic = Uint256DecimalSchema.parse(atomicAmount);

  if (rep === "native") {
    return CommerceUsdcAmountSchema.parse({
      schemaVersion: SCHEMA_VERSION,
      networkId: NETWORK_ID,
      asset: ASSET,
      atomicAmount: atomic,
      representation: "native",
      decimals: 18,
    });
  }

  return CommerceUsdcAmountSchema.parse({
    schemaVersion: SCHEMA_VERSION,
    networkId: NETWORK_ID,
    asset: ASSET,
    atomicAmount: atomic,
    representation: "erc20",
    decimals: 6,
  });
}

function parseCommerceUsdcAmount(
  amount: CommerceUsdcAmount,
): CommerceUsdcAmount {
  return CommerceUsdcAmountSchema.parse(amount);
}

function assertSameUnit(
  left: CommerceUsdcAmount,
  right: CommerceUsdcAmount,
): void {
  if (
    left.representation !== right.representation ||
    left.networkId !== right.networkId ||
    left.asset !== right.asset ||
    left.decimals !== right.decimals
  ) {
    throw new RangeError(UNIT_MISMATCH_MESSAGE);
  }
}

export function convertCommerceUsdcAmount(
  amount: CommerceUsdcAmount,
  target: CommerceUsdcRepresentation,
): CommerceUsdcAmount {
  const parsed = parseCommerceUsdcAmount(amount);
  const targetRepresentation = CommerceUsdcRepresentationSchema.parse(target);

  if (parsed.representation === targetRepresentation) {
    return parsed;
  }

  const value = BigInt(parsed.atomicAmount);

  if (parsed.representation === "erc20") {
    const scaled = value * SCALE;
    if (scaled > MAX_UINT256) {
      throw new RangeError(OVERFLOW_MESSAGE);
    }
    return createCommerceUsdcAmount("native", scaled.toString());
  }

  if (value % SCALE !== 0n) {
    throw new RangeError(PRECISION_MESSAGE);
  }
  return createCommerceUsdcAmount("erc20", (value / SCALE).toString());
}

export function addCommerceUsdcAmounts(
  left: CommerceUsdcAmount,
  right: CommerceUsdcAmount,
): CommerceUsdcAmount {
  const a = parseCommerceUsdcAmount(left);
  const b = parseCommerceUsdcAmount(right);
  assertSameUnit(a, b);

  const sum = BigInt(a.atomicAmount) + BigInt(b.atomicAmount);
  if (sum > MAX_UINT256) {
    throw new RangeError(OVERFLOW_MESSAGE);
  }
  return createCommerceUsdcAmount(a.representation, sum.toString());
}

export function subtractCommerceUsdcAmounts(
  left: CommerceUsdcAmount,
  right: CommerceUsdcAmount,
): CommerceUsdcAmount {
  const a = parseCommerceUsdcAmount(left);
  const b = parseCommerceUsdcAmount(right);
  assertSameUnit(a, b);

  const leftValue = BigInt(a.atomicAmount);
  const rightValue = BigInt(b.atomicAmount);
  if (leftValue < rightValue) {
    throw new RangeError(UNDERFLOW_MESSAGE);
  }
  return createCommerceUsdcAmount(
    a.representation,
    (leftValue - rightValue).toString(),
  );
}

export function compareCommerceUsdcAmounts(
  left: CommerceUsdcAmount,
  right: CommerceUsdcAmount,
): -1 | 0 | 1 {
  const a = parseCommerceUsdcAmount(left);
  const b = parseCommerceUsdcAmount(right);
  assertSameUnit(a, b);

  const leftValue = BigInt(a.atomicAmount);
  const rightValue = BigInt(b.atomicAmount);
  if (leftValue < rightValue) {
    return -1;
  }
  if (leftValue > rightValue) {
    return 1;
  }
  return 0;
}

export function formatCommerceUsdcAmount(amount: CommerceUsdcAmount): string {
  const parsed = parseCommerceUsdcAmount(amount);
  const padded = parsed.atomicAmount.padStart(parsed.decimals + 1, "0");
  const splitIndex = padded.length - parsed.decimals;
  const whole = padded.slice(0, splitIndex).replace(/^0+(?=\d)/, "");
  const fraction = padded.slice(splitIndex).replace(/0+$/, "");
  return fraction.length > 0 ? `${whole}.${fraction}` : whole;
}

export const COMMERCE_USDC_FIELD_CLASSES = Object.freeze({
  schemaVersion: "organization_protected",
  networkId: "organization_protected",
  asset: "organization_protected",
  representation: "organization_protected",
  decimals: "organization_protected",
  atomicAmount: "organization_protected",
} as const);
