/**
 * Exact-bytes EIP-4361 (SIWE) validation for wallet sign-in.
 *
 * The server message is never reconstructed on the client: the caller signs
 * the exact bytes returned by the server. This module asserts that the bytes
 * match the frozen producer in `apps/api/src/auth/proofs.ts`
 * (`createSiweMessage` from viem) line-for-line: a fixed header, the selected
 * address, the login-only statement, and exactly the six ordered fields
 * `URI`, `Version`, `Chain ID`, `Nonce`, `Issued At`, `Expiration Time`.
 * Unknown, trailing, duplicated or out-of-order fields, CRLF, extra blank
 * lines, resource lists and trailing content are rejected before signing.
 */

export const WALLET_LOGIN_CHAIN_ID = 5_042_002;
export const WALLET_LOGIN_STATEMENT =
  "Sign in to OpenArc. This does not authorize payments.";
/** The server mints `Expiration Time` exactly five minutes after `Issued At`. */
export const WALLET_LOGIN_EXPIRY_MS = 5 * 60 * 1000;

export interface WalletMessageExpectation {
  origin: string;
  address: string;
}

export type WalletMessageFailure =
  | "invalid"
  | "wrong-origin"
  | "wrong-chain"
  | "wrong-statement"
  | "wrong-address"
  | "stale";

export class WalletMessageError extends Error {
  readonly failure: WalletMessageFailure;

  constructor(failure: WalletMessageFailure) {
    super(failure);
    this.name = "WalletMessageError";
    this.failure = failure;
  }
}

const HEX_ADDRESS = /^0x[0-9a-fA-F]{40}$/u;
const NONCE = /^[0-9a-f]{32}$/u;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;

interface ParsedSiwe {
  authority: string;
  scheme: string;
  address: string;
  statement: string;
  uri: string;
  version: string;
  chainId: string;
  nonce: string;
  issuedAt: string;
  expirationTime: string;
}

/**
 * Splits and validates the frozen 11-line shape. Any deviation from the exact
 * producer output is `invalid`; field errors are surfaced separately.
 */
function parseExactSiwe(message: string): ParsedSiwe {
  // The producer never emits CR; a CR would change the signed bytes.
  if (message.includes("\r")) throw new WalletMessageError("invalid");
  // The producer emits no trailing newline or trailing content.
  if (message.endsWith("\n") || message.endsWith("\n\n")) {
    throw new WalletMessageError("invalid");
  }
  const lines = message.split("\n");
  if (lines.length !== 11) throw new WalletMessageError("invalid");

  const header = lines[0] ?? "";
  const headerMatch =
    /^([a-z][a-z0-9+.-]*):\/\/(.+?) wants you to sign in with your Ethereum account:$/u.exec(
      header,
    );
  if (headerMatch === null) throw new WalletMessageError("invalid");
  const scheme = headerMatch[1] ?? "";
  const authority = headerMatch[2] ?? "";

  const address = lines[1] ?? "";
  if (!HEX_ADDRESS.test(address)) throw new WalletMessageError("invalid");
  if (lines[2] !== "") throw new WalletMessageError("invalid");
  const statement = lines[3] ?? "";
  if (lines[4] !== "") throw new WalletMessageError("invalid");

  const uri = parseField(lines[5], "URI");
  const version = parseField(lines[6], "Version");
  const chainId = parseField(lines[7], "Chain ID");
  const nonce = parseField(lines[8], "Nonce");
  const issuedAt = parseField(lines[9], "Issued At");
  const expirationTime = parseField(lines[10], "Expiration Time");

  return {
    authority,
    scheme,
    address,
    statement,
    uri,
    version,
    chainId,
    nonce,
    issuedAt,
    expirationTime,
  };
}

/** Requires the exact `Prefix: value` line at a fixed position. */
function parseField(line: string | undefined, prefix: string): string {
  if (line === undefined) throw new WalletMessageError("invalid");
  const marker = `${prefix}: `;
  if (!line.startsWith(marker)) throw new WalletMessageError("invalid");
  const value = line.slice(marker.length);
  if (value.length === 0 || value.includes("\n")) {
    throw new WalletMessageError("invalid");
  }
  return value;
}

function sameAddress(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

/**
 * Validates the server message against the frozen contract. `now` is injected
 * so freshness is testable. Returns the exact original message on success.
 */
export function validateWalletMessage(
  message: string,
  expectation: WalletMessageExpectation,
  now: Date = new Date(),
): string {
  if (message.length === 0 || message.length > 4096) {
    throw new WalletMessageError("invalid");
  }
  let origin: URL;
  try {
    origin = new URL(expectation.origin);
  } catch {
    throw new WalletMessageError("invalid");
  }
  if (origin.origin !== expectation.origin) {
    throw new WalletMessageError("invalid");
  }
  const parsed = parseExactSiwe(message);
  const expectedScheme = origin.protocol.replace(":", "");
  if (parsed.scheme !== expectedScheme || parsed.authority !== origin.host) {
    throw new WalletMessageError("wrong-origin");
  }
  if (parsed.uri !== `${origin.origin}/account`) {
    throw new WalletMessageError("wrong-origin");
  }
  if (parsed.version !== "1") throw new WalletMessageError("invalid");
  if (parsed.chainId !== String(WALLET_LOGIN_CHAIN_ID)) {
    throw new WalletMessageError("wrong-chain");
  }
  if (!NONCE.test(parsed.nonce)) throw new WalletMessageError("invalid");
  if (parsed.statement !== WALLET_LOGIN_STATEMENT) {
    throw new WalletMessageError("wrong-statement");
  }
  if (!sameAddress(parsed.address, expectation.address)) {
    throw new WalletMessageError("wrong-address");
  }
  if (!ISO.test(parsed.issuedAt) || !ISO.test(parsed.expirationTime)) {
    throw new WalletMessageError("invalid");
  }
  const issued = Date.parse(parsed.issuedAt);
  const expires = Date.parse(parsed.expirationTime);
  const current = now.getTime();
  if (!Number.isFinite(issued) || !Number.isFinite(expires)) {
    throw new WalletMessageError("invalid");
  }
  // Enforce the server's fixed five-minute interval, not an arbitrary future
  // date, and reject a window that has not yet opened.
  if (expires - issued !== WALLET_LOGIN_EXPIRY_MS) {
    throw new WalletMessageError("invalid");
  }
  if (current < issued || current >= expires) {
    throw new WalletMessageError("stale");
  }
  return message;
}
