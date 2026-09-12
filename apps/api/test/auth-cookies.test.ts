import { describe, expect, it } from "vitest";

import {
  authCookieNames,
  clearCookie,
  deriveCsrfToken,
  hmacHex,
  issueBindingCookie,
  parseAuthCookies,
  serializeBindingCookie,
  serializeSessionCookie,
  verifyBindingCookie,
  verifyCsrfToken,
  AuthCookieError,
} from "../src/auth/cookies.js";

const SECRET = "synthetic_auth_secret_for_cookie_tests_0123456789";
const NOW = 1_760_000_000_000;
const NONCE = Buffer.alloc(16, 5).toString("base64url");

describe("auth cookie names", () => {
  it("uses __Host prefixes only when secure and plain names on localhost", () => {
    expect(authCookieNames(true)).toEqual({
      session: "__Host-openarc_session",
      binding: "__Host-openarc_binding",
    });
    expect(authCookieNames(false)).toEqual({
      session: "openarc_session",
      binding: "openarc_binding",
    });
  });
});

describe("parseAuthCookies", () => {
  const names = authCookieNames(true);

  it("returns nulls for an absent header", () => {
    expect(parseAuthCookies(undefined, names)).toEqual({
      session: null,
      binding: null,
    });
  });

  it("parses only the auth cookies and ignores unrelated names", () => {
    const parsed = parseAuthCookies(
      "theme=dark; __Host-openarc_session=abc; other=1; __Host-openarc_binding=def",
      names,
    );
    expect(parsed).toEqual({ session: "abc", binding: "def" });
  });

  it("rejects duplicate auth cookie names", () => {
    expect(() =>
      parseAuthCookies(
        "__Host-openarc_session=a; __Host-openarc_session=b",
        names,
      ),
    ).toThrow(AuthCookieError);
    expect(() =>
      parseAuthCookies(
        "__Host-openarc_binding=a; __Host-openarc_binding=b",
        names,
      ),
    ).toThrow(AuthCookieError);
  });

  it("rejects malformed segments, control characters and oversized headers", () => {
    for (const header of [
      "novalue",
      "=v",
      "__Host-openarc_session=va lue",
      `${"a".repeat(4097)}`,
      "__Host-openarc_session=" + String.fromCharCode(10),
    ]) {
      expect(() => parseAuthCookies(header, names)).toThrow(AuthCookieError);
    }
    expect(() => parseAuthCookies(12345, names)).toThrow(AuthCookieError);
  });
});

describe("binding cookie", () => {
  it("round-trips a server-authenticated, server-expiring value", () => {
    const value = issueBindingCookie(SECRET, NONCE, NOW);
    expect(verifyBindingCookie(SECRET, value, NOW + 1_000)).toBe(value);
  });

  it("rejects a wrong secret, tampering, future and expired values", () => {
    const value = issueBindingCookie(SECRET, NONCE, NOW);
    const tampered = `${value.slice(0, -1)}${value.endsWith("A") ? "B" : "A"}`;
    for (const candidate of [
      tampered,
      value.replace(NONCE, Buffer.alloc(16, 9).toString("base64url")),
      issueBindingCookie(SECRET, NONCE, NOW + 120_000),
      issueBindingCookie(SECRET, NONCE, NOW - 400_000),
      "not-a-binding",
      "",
      undefined,
    ]) {
      expect(() =>
        verifyBindingCookie(SECRET, candidate, NOW + 1_000),
      ).toThrow(AuthCookieError);
    }
    expect(() =>
      verifyBindingCookie("other_secret_that_is_long_enough_0123456789", value, NOW + 1_000),
    ).toThrow(AuthCookieError);
  });

  it("rejects a non-canonical nonce on issue", () => {
    expect(() => issueBindingCookie(SECRET, "short", NOW)).toThrow(
      AuthCookieError,
    );
    expect(() => issueBindingCookie(SECRET, NONCE, 0)).toThrow(AuthCookieError);
  });
});

describe("csrf token", () => {
  it("is stable for the same binding and session and binds both", () => {
    const binding = issueBindingCookie(SECRET, NONCE, NOW);
    const hash = "a".repeat(64);
    const token = deriveCsrfToken(SECRET, binding, hash);
    expect(verifyCsrfToken(SECRET, binding, hash, token)).toBe(true);
    expect(verifyCsrfToken(SECRET, binding, null, token)).toBe(false);
    expect(verifyCsrfToken(SECRET, binding, "b".repeat(64), token)).toBe(false);
    expect(
      verifyCsrfToken(
        SECRET,
        issueBindingCookie(SECRET, NONCE, NOW + 1_000),
        hash,
        token,
      ),
    ).toBe(false);
  });

  it("rejects absent, oversized and wrong-length tokens without throwing", () => {
    const binding = issueBindingCookie(SECRET, NONCE, NOW);
    for (const provided of [undefined, null, "", "x", "y".repeat(257), 42]) {
      expect(verifyCsrfToken(SECRET, binding, null, provided)).toBe(false);
    }
  });
});

describe("cookie serialization", () => {
  it("sets the required security attributes and no Domain", () => {
    const session = serializeSessionCookie(
      "__Host-openarc_session",
      "token",
      true,
    );
    expect(session).toContain("__Host-openarc_session=token");
    expect(session).toContain("Path=/");
    expect(session).toContain("HttpOnly");
    expect(session).toContain("Secure");
    expect(session).toContain("SameSite=Lax");
    expect(session).toContain("Max-Age=86400");
    expect(session).not.toContain("Domain");

    const binding = serializeBindingCookie(
      "openarc_binding",
      "value",
      false,
    );
    expect(binding).toContain("Max-Age=300");
    expect(binding).not.toContain("Secure");

    const cleared = clearCookie("openarc_session", false);
    expect(cleared).toContain("Max-Age=0");
  });
});

describe("hmacHex domain separation", () => {
  it("is deterministic and differs by purpose and value", () => {
    const a = hmacHex(SECRET, "openarc:rate:peer:v1", "192.0.2.1");
    expect(a).toMatch(/^[0-9a-f]{64}$/u);
    expect(a).toBe(hmacHex(SECRET, "openarc:rate:peer:v1", "192.0.2.1"));
    expect(a).not.toBe(hmacHex(SECRET, "openarc:rate:peer:v1", "192.0.2.2"));
    expect(a).not.toBe(
      hmacHex(SECRET, "openarc:rate:binding:v1", "192.0.2.1"),
    );
  });
});
