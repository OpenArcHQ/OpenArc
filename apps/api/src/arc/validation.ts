import { ARC_TESTNET, EvmAddressSchema, TransactionHashSchema } from "@openarc/shared";

import { ApiBoundaryError } from "../http/errors.js";
import { integer, parseHexQuantity, record, timestamp } from "./quantities.js";

export interface ParsedBlock {
  numberHex: string;
  number: bigint;
  numberDecimal: string;
  hash: string;
  timestamp: string;
}

export function requireChainId(value: unknown): void {
  if (value !== ARC_TESTNET.chainIdHex) throw new ApiBoundaryError("SOURCE_WRONG_NETWORK");
}

export function block(value: unknown): ParsedBlock {
  if (value === null) throw new ApiBoundaryError("SOURCE_NOT_FOUND");
  const source = record(value);
  const numberValue = parseHexQuantity(source.number);
  const hash = TransactionHashSchema.safeParse(source.hash);
  if (!hash.success || typeof source.number !== "string") throw new ApiBoundaryError("SOURCE_MALFORMED");
  return { numberHex: source.number, number: numberValue, numberDecimal: integer(numberValue),
    hash: hash.data, timestamp: timestamp(source.timestamp) };
}

export function requireSameBlock(left: ParsedBlock, right: ParsedBlock): void {
  if (left.number !== right.number || left.hash !== right.hash || left.timestamp !== right.timestamp) {
    throw new ApiBoundaryError("SOURCE_CONFLICT");
  }
}

export function address(value: unknown): string {
  const parsed = EvmAddressSchema.safeParse(value);
  if (!parsed.success) throw new ApiBoundaryError("SOURCE_MALFORMED");
  return parsed.data;
}

export function hash(value: unknown): string {
  const parsed = TransactionHashSchema.safeParse(value);
  if (!parsed.success) throw new ApiBoundaryError("SOURCE_MALFORMED");
  return parsed.data;
}
