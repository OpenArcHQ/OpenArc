import { z } from "zod";

import { IsoTimestampSchema } from "../primitives.js";
import { CommerceAccountIdSchema } from "./identity.js";

/**
 * Strict account-only v2 wire contracts.
 *
 * This module is deliberately account-scoped: it contains no organization,
 * tenant, role, principal or payment authority. Every object is strict, so an
 * unknown field is rejected rather than stripped. There are no `any`, record
 * or raw payload slots.
 */

export const AccountSessionMethodSchema = z.enum([
  "passkey",
  "wallet",
  "recovery",
]);

export type AccountSessionMethod = z.infer<typeof AccountSessionMethodSchema>;

/**
 * Safe account session view. A guest has exactly `{ signedIn: false }`.
 * A signed-in caller learns only the account id, the authentication method
 * and the DB-owned expiry: never a session hash, public key, user handle or
 * wallet list.
 */
export const AccountSessionViewSchema = z.discriminatedUnion("signedIn", [
  z.strictObject({ signedIn: z.literal(false) }),
  z.strictObject({
    signedIn: z.literal(true),
    accountId: CommerceAccountIdSchema,
    method: AccountSessionMethodSchema,
    expiresAt: IsoTimestampSchema,
  }),
]);

export type AccountSessionView = z.infer<typeof AccountSessionViewSchema>;

export const AccountBootstrapResponseSchema = z.strictObject({
  csrfToken: z.string().min(1).max(256),
  session: AccountSessionViewSchema,
});

export type AccountBootstrapResponse = z.infer<
  typeof AccountBootstrapResponseSchema
>;

/**
 * Response for a POST that may rotate the session. A fresh CSRF token is
 * returned alongside the safe session view so the browser can continue with a
 * token that is bound to the new session hash.
 */
export const AccountSessionResponseSchema = z.strictObject({
  csrfToken: z.string().min(1).max(256),
  session: AccountSessionViewSchema,
});

export type AccountSessionResponse = z.infer<
  typeof AccountSessionResponseSchema
>;

export const ACCOUNT_ACCEPT_MINIMAL_RECORDS = true as const;

/**
 * Browser-safe canonical base64url validation with no Buffer/Node dependency.
 * A value is canonical when it uses the unpadded URL alphabet, decodes to at
 * least one byte, and carries no non-zero trailing bits. For unpadded input of
 * length L: L % 4 === 1 is impossible; L % 4 === 2 allows only the low 4 bits
 * of the final character to be zero; L % 4 === 3 allows only the low 2 bits.
 */
const B64URL_ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

function canonicalB64urlLength(value: string): boolean {
  if (value.length < 2 || !/^[A-Za-z0-9_-]+$/u.test(value)) return false;
  const remainder = value.length % 4;
  if (remainder === 1) return false;
  const finalIndex = B64URL_ALPHABET.indexOf(value[value.length - 1] as string);
  if (finalIndex < 0) return false;
  if (remainder === 2) return (finalIndex & 0b1111) === 0;
  if (remainder === 3) return (finalIndex & 0b11) === 0;
  return true;
}

const canonicalB64url = (min: number, max: number) =>
  z
    .string()
    .min(min)
    .max(max)
    .refine(canonicalB64urlLength, {
      message: "Expected a canonical base64url string",
    });

const flowIdSchema = canonicalB64url(16, 256);
const credentialIdSchema = canonicalB64url(1, 1024);

const transportsSchema = z
  .array(
    z.enum([
      "usb",
      "nfc",
      "ble",
      "internal",
      "hybrid",
      "cable",
      "smart-card",
    ]),
  )
  .max(8);

const publicKeyCredentialDescriptorSchema = z.strictObject({
  id: z.string().min(1).max(1024),
  type: z.literal("public-key"),
  transports: z
    .array(
      z.enum([
        "usb",
        "nfc",
        "ble",
        "internal",
        "hybrid",
        "cable",
        "smart-card",
      ]),
    )
    .max(8)
    .optional(),
});

const publicKeyCredentialParametersSchema = z.strictObject({
  type: z.literal("public-key"),
  alg: z.union([z.literal(-7), z.literal(-257)]),
});

const authenticatorSelectionSchema = z.strictObject({
  authenticatorAttachment: z
    .enum(["platform", "cross-platform"])
    .optional(),
  residentKey: z
    .enum(["discouraged", "preferred", "required"])
    .optional(),
  requireResidentKey: z.boolean().optional(),
  userVerification: z.enum(["discouraged", "preferred", "required"]).optional(),
});

const authenticationExtensionsSchema = z.strictObject({
  credProps: z.boolean().optional(),
});

/**
 * Allowlisted registration options wire DTO built from the maintained SDK
 * output. The pseudonymous WebAuthn user handle is necessarily present; no
 * arbitrary payload slot is accepted.
 */
export const AccountPasskeyRegistrationOptionsResponseSchema = z.strictObject({
  flowId: flowIdSchema,
  options: z.strictObject({
    challenge: z.string().min(1).max(2048),
    rp: z.strictObject({
      id: z.string().min(1).max(253).optional(),
      name: z.string().min(1).max(128),
    }),
    user: z.strictObject({
      id: z.string().min(1).max(256),
      name: z.string().min(1).max(256),
      displayName: z.string().min(1).max(256),
    }),
    pubKeyCredParams: z.array(publicKeyCredentialParametersSchema).min(1).max(16),
    timeout: z.number().int().min(1).max(600_000).optional(),
    excludeCredentials: z
      .array(publicKeyCredentialDescriptorSchema)
      .max(64)
      .optional(),
    authenticatorSelection: authenticatorSelectionSchema.optional(),
    attestation: z
      .enum(["none", "indirect", "direct", "enterprise"])
      .optional(),
    extensions: authenticationExtensionsSchema.optional(),
  }),
});

export type AccountPasskeyRegistrationOptionsResponse = z.infer<
  typeof AccountPasskeyRegistrationOptionsResponseSchema
>;

export const AccountPasskeyAuthenticationOptionsResponseSchema =
  z.strictObject({
    flowId: flowIdSchema,
    options: z.strictObject({
      challenge: z.string().min(1).max(2048),
      timeout: z.number().int().min(1).max(600_000).optional(),
      rpId: z.string().min(1).max(253).optional(),
      allowCredentials: z
        .array(publicKeyCredentialDescriptorSchema)
        .max(64)
        .optional(),
      userVerification: z
        .enum(["discouraged", "preferred", "required"])
        .optional(),
      extensions: authenticationExtensionsSchema.optional(),
    }),
  });

export type AccountPasskeyAuthenticationOptionsResponse = z.infer<
  typeof AccountPasskeyAuthenticationOptionsResponseSchema
>;

/** Exactly eight one-time recovery codes, returned only once. */
export const AccountRecoveryCodesResponseSchema = z.strictObject({
  codes: z.tuple([
    z.string().min(1).max(256),
    z.string().min(1).max(256),
    z.string().min(1).max(256),
    z.string().min(1).max(256),
    z.string().min(1).max(256),
    z.string().min(1).max(256),
    z.string().min(1).max(256),
    z.string().min(1).max(256),
  ]),
});

export type AccountRecoveryCodesResponse = z.infer<
  typeof AccountRecoveryCodesResponseSchema
>;

const clientExtensionResultsSchema = z.strictObject({
  credProps: z.strictObject({ rk: z.boolean() }).strict().optional(),
});

/**
 * Allowlisted WebAuthn registration response wire DTO. Mirrors the reviewed
 * adapter schema so the route never accepts or forwards arbitrary fields.
 */
export const AccountPasskeyRegistrationResponseSchema = z.strictObject({
  id: credentialIdSchema,
  rawId: credentialIdSchema,
  type: z.literal("public-key"),
  response: z.strictObject({
    clientDataJSON: canonicalB64url(1, 8192),
    attestationObject: canonicalB64url(1, 16384),
    authenticatorData: canonicalB64url(1, 16384).optional(),
    publicKey: canonicalB64url(1, 2048).optional(),
    publicKeyAlgorithm: z.union([z.literal(-7), z.literal(-257)]).optional(),
    transports: transportsSchema.optional(),
  }),
  clientExtensionResults: clientExtensionResultsSchema.optional(),
  authenticatorAttachment: z
    .enum(["platform", "cross-platform"])
    .optional(),
});

export type AccountPasskeyRegistrationResponse = z.infer<
  typeof AccountPasskeyRegistrationResponseSchema
>;

export const AccountPasskeyAuthenticationResponseSchema = z.strictObject({
  id: credentialIdSchema,
  rawId: credentialIdSchema,
  type: z.literal("public-key"),
  response: z.strictObject({
    clientDataJSON: canonicalB64url(1, 8192),
    authenticatorData: canonicalB64url(1, 4096),
    signature: canonicalB64url(1, 4096),
    userHandle: canonicalB64url(1, 128).optional(),
  }),
  clientExtensionResults: clientExtensionResultsSchema.optional(),
  authenticatorAttachment: z
    .enum(["platform", "cross-platform"])
    .optional(),
});

export type AccountPasskeyAuthenticationResponse = z.infer<
  typeof AccountPasskeyAuthenticationResponseSchema
>;

export const AccountEmptyRequestSchema = z.strictObject({});

export const AccountRegisterOptionsRequestSchema = z.strictObject({
  acceptMinimalRecords: z.literal(ACCOUNT_ACCEPT_MINIMAL_RECORDS),
});

export const AccountPasskeyRegisterVerifyRequestSchema = z.strictObject({
  flowId: flowIdSchema,
  response: AccountPasskeyRegistrationResponseSchema,
});

export const AccountPasskeyLoginVerifyRequestSchema = z.strictObject({
  flowId: flowIdSchema,
  response: AccountPasskeyAuthenticationResponseSchema,
});

export const AccountPasskeyAddVerifyRequestSchema = z.strictObject({
  flowId: flowIdSchema,
  response: AccountPasskeyRegistrationResponseSchema,
});

const evmAddressSchema = z
  .string()
  .length(42)
  .regex(/^0x[0-9a-fA-F]{40}$/u);

export const AccountWalletAddressRequestSchema = z.strictObject({
  address: evmAddressSchema,
});

export const AccountWalletVerifyRequestSchema = z.strictObject({
  flowId: flowIdSchema,
  message: z.string().min(1).max(4096),
  signature: z.string().length(132).regex(/^0x[0-9a-fA-F]{130}$/u),
});

export const AccountRecoveryRedeemRequestSchema = z.strictObject({
  code: z.string().min(1).max(256),
});

/**
 * Allowlisted wallet login/link options wire DTO. The message is the exact
 * fixed-statement SIWE text the browser must sign; no raw output slot.
 */
export const AccountWalletOptionsResponseSchema = z.strictObject({
  flowId: flowIdSchema,
  message: z.string().min(1).max(4096),
});

export type AccountEmptyRequest = z.infer<typeof AccountEmptyRequestSchema>;
export type AccountRegisterOptionsRequest = z.infer<
  typeof AccountRegisterOptionsRequestSchema
>;
export type AccountPasskeyRegisterVerifyRequest = z.infer<
  typeof AccountPasskeyRegisterVerifyRequestSchema
>;
export type AccountPasskeyLoginVerifyRequest = z.infer<
  typeof AccountPasskeyLoginVerifyRequestSchema
>;
export type AccountPasskeyAddVerifyRequest = z.infer<
  typeof AccountPasskeyAddVerifyRequestSchema
>;
export type AccountWalletAddressRequest = z.infer<
  typeof AccountWalletAddressRequestSchema
>;
export type AccountWalletVerifyRequest = z.infer<
  typeof AccountWalletVerifyRequestSchema
>;
export type AccountWalletOptionsResponse = z.infer<
  typeof AccountWalletOptionsResponseSchema
>;
export type AccountRecoveryRedeemRequest = z.infer<
  typeof AccountRecoveryRedeemRequestSchema
>;

/**
 * Account-scoped field classification metadata. Descriptive only: it is not
 * authorization, enforcement, redaction or public-release approval.
 */
function protectedFields<K extends string>(
  keys: readonly K[],
): Readonly<Record<K, "organization_protected">> {
  const map = {} as Record<K, "organization_protected">;
  for (const key of keys) {
    map[key] = "organization_protected";
  }
  return Object.freeze(map);
}

export const ACCOUNT_FIELD_CLASSES = Object.freeze({
  sessionGuest: protectedFields(["signedIn"] as const),
  sessionSignedIn: protectedFields([
    "signedIn",
    "accountId",
    "method",
    "expiresAt",
  ] as const),
  bootstrapResponse: protectedFields(["csrfToken", "session"] as const),
  recoveryCodesResponse: protectedFields(["codes"] as const),
});
