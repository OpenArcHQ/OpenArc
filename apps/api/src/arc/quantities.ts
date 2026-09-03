import { ApiBoundaryError } from "../http/errors.js";

const HEX_QUANTITY = /^0x(?:0|[1-9a-f][0-9a-f]{0,63})$/u;
const WORD = /^0x[0-9a-f]{64}$/u;

export function parseHexQuantity(value: unknown): bigint {
  if (typeof value !== "string" || !HEX_QUANTITY.test(value)) {
    throw new ApiBoundaryError("SOURCE_MALFORMED");
  }
  try { return BigInt(value); }
  catch { throw new ApiBoundaryError("SOURCE_MALFORMED"); }
}

export function parseWord(value: unknown): bigint {
  if (typeof value !== "string" || !WORD.test(value)) {
    throw new ApiBoundaryError("SOURCE_MALFORMED");
  }
  try { return BigInt(value); }
  catch { throw new ApiBoundaryError("SOURCE_MALFORMED"); }
}

export function integer(value: bigint): string {
  if (value < 0n) throw new ApiBoundaryError("SOURCE_MALFORMED");
  return value.toString(10);
}

export function decimal(value: bigint, decimals: 6 | 18): string {
  if (value < 0n) throw new ApiBoundaryError("SOURCE_MALFORMED");
  const digits = value.toString(10).padStart(decimals + 1, "0");
  const whole = digits.slice(0, -decimals).replace(/^0+(?=\d)/u, "");
  const fraction = digits.slice(-decimals).replace(/0+$/u, "");
  return fraction ? `${whole}.${fraction}` : whole;
}

export function amount<D extends 6 | 18>(value: bigint, decimals: D) {
  return { baseUnits: integer(value), decimals, decimal: decimal(value, decimals) } as const;
}

export function timestamp(value: unknown): string {
  const seconds = parseHexQuantity(value);
  if (seconds > 253_402_300_799n) throw new ApiBoundaryError("SOURCE_MALFORMED");
  const date = new Date(Number(seconds) * 1_000);
  if (!Number.isFinite(date.getTime())) throw new ApiBoundaryError("SOURCE_MALFORMED");
  return date.toISOString();
}

export function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new ApiBoundaryError("SOURCE_MALFORMED");
  }
  return value as Record<string, unknown>;
}
