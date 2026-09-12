import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Cookie and CSRF primitives for the account-only auth slice.
 *
 * Session and binding values are never parsed from Authorization or the query
 * string. Duplicate auth cookie names are rejected so a smuggled second copy
 * cannot shadow the first.
 */

export const SESSION_COOKIE_PROD = "__Host-openarc_session";
export const SESSION_COOKIE_DEV = "openarc_session";
export const BINDING_COOKIE_PROD = "__Host-openarc_binding";
export const BINDING_COOKIE_DEV = "openarc_binding";

export const SESSION_MAX_AGE_SECONDS = 24 * 60 * 60;
export const BINDING_MAX_AGE_SECONDS = 300;

export interface AuthCookieNames {
  session: string;
  binding: string;
}

export function authCookieNames(secure: boolean): AuthCookieNames {
  return secure
    ? { session: SESSION_COOKIE_PROD, binding: BINDING_COOKIE_PROD }
    : { session: SESSION_COOKIE_DEV, binding: BINDING_COOKIE_DEV };
}

export class AuthCookieError extends Error {
  constructor() {
    super("AUTH_COOKIE_INVALID");
    this.name = "AuthCookieError";
  }
}

function fail(): never {
  throw new AuthCookieError();
}

/** Raw auth cookie values, or null when absent. Throws on malformed/dup. */
export interface ParsedAuthCookies {
  session: string | null;
  binding: string | null;
}

/**
 * Parses the Cookie header and returns only the two auth values. Any duplicate
 * auth cookie name, malformed pair, control character or unexpected name
 * encoding fails closed.
 */
export function parseAuthCookies(
  header: unknown,
  names: AuthCookieNames,
): ParsedAuthCookies {
  if (header === undefined) return { session: null, binding: null };
  if (typeof header !== "string" || header.length === 0 || header.length > 4096) {
    fail();
  }
  const found: { session?: string; binding?: string } = {};
  for (const segment of header.split(";")) {
    const trimmed = segment.trim();
    if (trimmed.length === 0) continue;
    const separator = trimmed.indexOf("=");
    if (separator <= 0) fail();
    const name = trimmed.slice(0, separator);
    const value = trimmed.slice(separator + 1);
    if (!/^[\x21-\x7e]+$/u.test(name) || !/^[\x21-\x7e]+$/u.test(value)) {
      fail();
    }
    if (name !== names.session && name !== names.binding) continue;
    if (name === names.session) {
      if (found.session !== undefined) fail();
      found.session = value;
    } else {
      if (found.binding !== undefined) fail();
      found.binding = value;
    }
  }
  return {
    session: found.session ?? null,
    binding: found.binding ?? null,
  };
}

function hmac(secret: string, input: string): Buffer {
  return createHmac("sha256", secret).update(input, "utf8").digest();
}

function constantTimeEqual(left: Buffer, right: Buffer): boolean {
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

const BINDING_PATTERN = /^[A-Za-z0-9_-]{22}\.[0-9]{1,16}\.[A-Za-z0-9_-]{43}$/u;

/**
 * A binding cookie is a server-authenticated, server-expiring value:
 * `<nonce>.<issuedAtMillis>.<hmac>`. The HMAC is bound to the secret and the
 * full prefix, and the issued-at is checked against the wall clock.
 */
export function issueBindingCookie(
  secret: string,
  nonce: string,
  issuedAtMillis: number,
): string {
  if (!/^[A-Za-z0-9_-]{22}$/u.test(nonce)) fail();
  if (!Number.isInteger(issuedAtMillis) || issuedAtMillis <= 0) fail();
  const prefix = `${nonce}.${issuedAtMillis}`;
  const mac = hmac(secret, `openarc:binding:v1:${prefix}`).toString("base64url");
  return `${prefix}.${mac}`;
}

/** Validates signature and server expiry. Returns the exact cookie value. */
export function verifyBindingCookie(
  secret: string,
  value: unknown,
  nowMillis: number,
  maxAgeSeconds = BINDING_MAX_AGE_SECONDS,
): string {
  if (typeof value !== "string" || value.length > 256 || !BINDING_PATTERN.test(value)) {
    fail();
  }
  const parts = value.split(".");
  const nonce = parts[0];
  const issuedAtText = parts[1];
  const macText = parts[2];
  if (nonce === undefined || issuedAtText === undefined || macText === undefined) {
    fail();
  }
  const issuedAtMillis = Number.parseInt(issuedAtText, 10);
  if (!Number.isInteger(issuedAtMillis) || issuedAtMillis <= 0) fail();
  if (issuedAtMillis > nowMillis + 60_000) fail();
  if (nowMillis - issuedAtMillis > maxAgeSeconds * 1000) fail();
  const expected = hmac(
    secret,
    `openarc:binding:v1:${nonce}.${issuedAtMillis}`,
  );
  const provided = Buffer.from(macText, "base64url");
  if (!constantTimeEqual(expected, provided)) fail();
  return value;
}

/**
 * CSRF token bound to the binding cookie value AND the current session hash
 * (empty string when the caller has no live account session).
 */
export function deriveCsrfToken(
  secret: string,
  bindingValue: string,
  sessionHash: string | null,
): string {
  return hmac(
    secret,
    `openarc:csrf:v1:${bindingValue}:${sessionHash ?? ""}`,
  ).toString("base64url");
}

export function verifyCsrfToken(
  secret: string,
  bindingValue: string,
  sessionHash: string | null,
  provided: unknown,
): boolean {
  if (typeof provided !== "string" || provided.length === 0 || provided.length > 256) {
    return false;
  }
  const expected = deriveCsrfToken(secret, bindingValue, sessionHash);
  const expectedBuffer = Buffer.from(expected, "utf8");
  const providedBuffer = Buffer.from(provided, "utf8");
  return constantTimeEqual(expectedBuffer, providedBuffer);
}

/** HMAC a raw value under a domain-separated purpose (never store raw). */
export function hmacHex(secret: string, purpose: string, value: string): string {
  return hmac(secret, `${purpose}:${value}`).toString("hex");
}

function serializeCookie(
  name: string,
  value: string,
  options: {
    secure: boolean;
    httpOnly: boolean;
    path: string;
    maxAge: number | null;
    sameSite: "Lax";
  },
): string {
  const parts = [
    `${name}=${value}`,
    `Path=${options.path}`,
    `SameSite=${options.sameSite}`,
  ];
  if (options.httpOnly) parts.push("HttpOnly");
  if (options.secure) parts.push("Secure");
  if (options.maxAge !== null) parts.push(`Max-Age=${options.maxAge}`);
  return parts.join("; ");
}

export function serializeSessionCookie(
  name: string,
  value: string,
  secure: boolean,
): string {
  return serializeCookie(name, value, {
    secure,
    httpOnly: true,
    path: "/",
    maxAge: SESSION_MAX_AGE_SECONDS,
    sameSite: "Lax",
  });
}

export function serializeBindingCookie(
  name: string,
  value: string,
  secure: boolean,
): string {
  return serializeCookie(name, value, {
    secure,
    httpOnly: true,
    path: "/",
    maxAge: BINDING_MAX_AGE_SECONDS,
    sameSite: "Lax",
  });
}

export function clearCookie(name: string, secure: boolean): string {
  return serializeCookie(name, "", {
    secure,
    httpOnly: true,
    path: "/",
    maxAge: 0,
    sameSite: "Lax",
  });
}

export function setCookieHeaders(values: readonly string[]): string[] {
  return [...values];
}
