import { describe, expect, expectTypeOf, it } from "vitest";
import {
  ACCOUNT_ACCEPT_MINIMAL_RECORDS,
  ACCOUNT_FIELD_CLASSES,
  AccountBootstrapResponseSchema,
  AccountPasskeyAuthenticationOptionsResponseSchema,
  AccountPasskeyAuthenticationResponseSchema,
  AccountPasskeyRegistrationOptionsResponseSchema,
  AccountPasskeyRegistrationResponseSchema,
  AccountRecoveryCodesResponseSchema,
  AccountRecoveryRedeemRequestSchema,
  AccountRegisterOptionsRequestSchema,
  AccountSessionMethodSchema,
  AccountSessionViewSchema,
  AccountWalletAddressRequestSchema,
  AccountWalletOptionsResponseSchema,
  AccountWalletVerifyRequestSchema,
  type AccountSessionView,
} from "../src/commerce/account.js";

const ACCOUNT_ID = "openarc:account:12345678-1234-4234-8123-123456789abc";
const EXPIRES = "2026-09-12T12:00:00Z";

describe("account session view", () => {
  it("accepts exactly the guest or signed-in shapes", () => {
    expect(AccountSessionViewSchema.safeParse({ signedIn: false }).success).toBe(
      true,
    );
    const signedIn = {
      signedIn: true,
      accountId: ACCOUNT_ID,
      method: "passkey",
      expiresAt: EXPIRES,
    };
    expect(AccountSessionViewSchema.safeParse(signedIn).success).toBe(true);
    expect(AccountSessionMethodSchema.options).toEqual([
      "passkey",
      "wallet",
      "recovery",
    ]);
  });

  it("rejects account ids, methods, timestamps and unknown fields", () => {
    const base = {
      signedIn: true,
      accountId: ACCOUNT_ID,
      method: "passkey",
      expiresAt: EXPIRES,
    };
    const bad: unknown[] = [
      { ...base, accountId: "openarc:org:12345678-1234-4234-8123-123456789abc" },
      { ...base, accountId: "act_1234" },
      { ...base, method: "password" },
      { ...base, expiresAt: "2026-09-12T12:00:00+00:00" },
      { ...base, sessionHash: "a".repeat(64) },
      { signedIn: false, accountId: ACCOUNT_ID },
    ];
    for (const value of bad) {
      expect(AccountSessionViewSchema.safeParse(value).success).toBe(false);
    }
  });

  it("exposes a narrowed signed-in type without generic payload", () => {
    expectTypeOf<AccountSessionView>().toMatchTypeOf<
      | { signedIn: false }
      | {
          signedIn: true;
          accountId: string;
          method: "passkey" | "wallet" | "recovery";
          expiresAt: string;
        }
    >();
  });
});

describe("account request contracts", () => {
  it("registration requires acceptMinimalRecords:true and nothing else", () => {
    expect(ACCOUNT_ACCEPT_MINIMAL_RECORDS).toBe(true);
    expect(
      AccountRegisterOptionsRequestSchema.safeParse({
        acceptMinimalRecords: true,
      }).success,
    ).toBe(true);
    expect(
      AccountRegisterOptionsRequestSchema.safeParse({
        acceptMinimalRecords: false,
      }).success,
    ).toBe(false);
    expect(
      AccountRegisterOptionsRequestSchema.safeParse({
        acceptMinimalRecords: true,
        email: "x@example.test",
      }).success,
    ).toBe(false);
  });

  it("wallet address is a bounded checksum-shaped hex string", () => {
    expect(
      AccountWalletAddressRequestSchema.safeParse({
        address: "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed",
      }).success,
    ).toBe(true);
    for (const address of [
      "0x" + "1".repeat(39),
      "0x" + "1".repeat(41),
      "5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed",
      "0xGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGG",
    ]) {
      expect(AccountWalletAddressRequestSchema.safeParse({ address }).success).toBe(
        false,
      );
    }
  });

  it("wallet verify bounds the message and signature", () => {
    const base = {
      flowId: Buffer.alloc(32, 1).toString("base64url"),
      message: "Sign in to OpenArc.",
      signature: `0x${"ab".repeat(65)}`,
    };
    expect(AccountWalletVerifyRequestSchema.safeParse(base).success).toBe(true);
    expect(
      AccountWalletVerifyRequestSchema.safeParse({
        ...base,
        message: "",
      }).success,
    ).toBe(false);
    expect(
      AccountWalletVerifyRequestSchema.safeParse({
        ...base,
        signature: `0x${"ab".repeat(64)}`,
      }).success,
    ).toBe(false);
    expect(
      AccountWalletVerifyRequestSchema.safeParse({
        ...base,
        extra: true,
      }).success,
    ).toBe(false);
  });

  it("wallet options expose only flowId and a bounded message", () => {
    const base = {
      flowId: Buffer.alloc(32, 6).toString("base64url"),
      message: "Sign in to OpenArc. This does not authorize payments.",
    };
    expect(AccountWalletOptionsResponseSchema.safeParse(base).success).toBe(true);
    for (const bad of [
      { ...base, extra: true },
      { ...base, message: "" },
      { ...base, message: "m".repeat(4097) },
      { ...base, flowId: "short" },
      { flowId: base.flowId },
      { message: base.message },
      { ...base, address: "0x" + "1".repeat(40) },
    ]) {
      expect(AccountWalletOptionsResponseSchema.safeParse(bad).success).toBe(
        false,
      );
    }
  });

  it("recovery redeem accepts one bounded code and no extra fields", () => {
    expect(
      AccountRecoveryRedeemRequestSchema.safeParse({ code: "abc" }).success,
    ).toBe(true);
    expect(AccountRecoveryRedeemRequestSchema.safeParse({ code: "" }).success).toBe(
      false,
    );
    expect(
      AccountRecoveryRedeemRequestSchema.safeParse({ code: "a", codes: [] })
        .success,
    ).toBe(false);
  });
});

describe("account response contracts", () => {
  it("bootstrap carries a csrf token and safe session view", () => {
    const parsed = AccountBootstrapResponseSchema.safeParse({
      csrfToken: "token",
      session: { signedIn: false },
    });
    expect(parsed.success).toBe(true);
    expect(
      AccountBootstrapResponseSchema.safeParse({
        csrfToken: "token",
        session: { signedIn: false },
        cookies: [],
      }).success,
    ).toBe(false);
  });

  it("recovery codes are exactly eight without extra fields", () => {
    const codes = Array.from({ length: 8 }, (_value, index) => `code-${index}`);
    expect(AccountRecoveryCodesResponseSchema.safeParse({ codes }).success).toBe(
      true,
    );
    expect(
      AccountRecoveryCodesResponseSchema.safeParse({ codes: codes.slice(0, 7) })
        .success,
    ).toBe(false);
    expect(
      AccountRecoveryCodesResponseSchema.safeParse({
        codes: [...codes.slice(0, 7), "code-7", "extra"],
      }).success,
    ).toBe(false);
  });

  it("passkey registration options expose only allowlisted fields", () => {
    const options = {
      flowId: Buffer.alloc(32, 2).toString("base64url"),
      options: {
        challenge: Buffer.alloc(32, 3).toString("base64url"),
        rp: { id: "localhost", name: "OpenArc" },
        user: { id: "handle", name: "OpenArc handle", displayName: "OpenArc" },
        pubKeyCredParams: [
          { type: "public-key", alg: -7 },
          { type: "public-key", alg: -257 },
        ],
        timeout: 60_000,
        authenticatorSelection: {
          residentKey: "required",
          userVerification: "required",
        },
        attestation: "none",
      },
    };
    expect(
      AccountPasskeyRegistrationOptionsResponseSchema.safeParse(options).success,
    ).toBe(true);
    expect(
      AccountPasskeyRegistrationOptionsResponseSchema.safeParse({
        ...options,
        options: { ...options.options, rp: { name: "OpenArc", extra: 1 } },
      }).success,
    ).toBe(false);
    expect(
      AccountPasskeyRegistrationOptionsResponseSchema.safeParse({
        ...options,
        options: { ...options.options, pubKeyCredParams: [
          { type: "public-key", alg: -7 },
          { type: "public-key", alg: -8 },
        ] },
      }).success,
    ).toBe(false);
  });

  it("passkey authentication options are discoverable and bounded", () => {
    const options = {
      flowId: Buffer.alloc(32, 4).toString("base64url"),
      options: {
        challenge: Buffer.alloc(32, 5).toString("base64url"),
        allowCredentials: [],
        userVerification: "required",
      },
    };
    expect(
      AccountPasskeyAuthenticationOptionsResponseSchema.safeParse(options)
        .success,
    ).toBe(true);
    expect(
      AccountPasskeyAuthenticationOptionsResponseSchema.safeParse({
        ...options,
        options: { ...options.options, rp: { name: "OpenArc" } },
      }).success,
    ).toBe(false);
  });

  it("passkey response wire schemas reject unknown and oversized fields", () => {
    const b64 = (bytes: number, fill: number) =>
      Buffer.alloc(bytes, fill).toString("base64url");
    const registration = {
      id: b64(16, 6),
      rawId: b64(16, 6),
      type: "public-key",
      response: {
        clientDataJSON: b64(16, 7),
        attestationObject: b64(16, 8),
      },
    };
    expect(
      AccountPasskeyRegistrationResponseSchema.safeParse(registration).success,
    ).toBe(true);
    expect(
      AccountPasskeyRegistrationResponseSchema.safeParse({
        ...registration,
        signature: "x",
      }).success,
    ).toBe(false);
    expect(
      AccountPasskeyRegistrationResponseSchema.safeParse({
        ...registration,
        response: {
          ...registration.response,
          attestationObject: "a".repeat(16385),
        },
      }).success,
    ).toBe(false);

    const authentication = {
      id: b64(16, 9),
      rawId: b64(16, 9),
      type: "public-key",
      response: {
        clientDataJSON: b64(16, 10),
        authenticatorData: b64(16, 11),
        signature: b64(16, 12),
      },
    };
    expect(
      AccountPasskeyAuthenticationResponseSchema.safeParse(authentication)
        .success,
    ).toBe(true);
    expect(
      AccountPasskeyAuthenticationResponseSchema.safeParse({
        ...authentication,
        response: { ...authentication.response, attestationObject: "x" },
      }).success,
    ).toBe(false);
  });
});

describe("account field classification metadata", () => {
  it("classifies every account leaf and is frozen", () => {
    expect(Object.isFrozen(ACCOUNT_FIELD_CLASSES)).toBe(true);
    expect(ACCOUNT_FIELD_CLASSES.sessionSignedIn.accountId).toBe(
      "organization_protected",
    );
    expect(Object.keys(ACCOUNT_FIELD_CLASSES.sessionGuest)).toEqual(["signedIn"]);
    expect(Object.keys(ACCOUNT_FIELD_CLASSES.bootstrapResponse)).toEqual([
      "csrfToken",
      "session",
    ]);
    expect(Object.keys(ACCOUNT_FIELD_CLASSES.recoveryCodesResponse)).toEqual([
      "codes",
    ]);
  });
});
