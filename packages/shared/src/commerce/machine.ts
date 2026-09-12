import { z } from "zod";

import {
  IsoTimestampSchema,
  compareIsoTimestamps,
} from "../primitives.js";
import { createCommerceSuccessEnvelopeSchema } from "./api.js";
import {
  CommerceAgentIdSchema,
  CommerceOrganizationIdSchema,
  CommerceProviderIdSchema,
} from "./identity.js";
import { CommerceTenantMutationIdSchema } from "./tenant-writes.js";

/**
 * Frozen machine (agent/provider credential and session) wire contracts.
 *
 * Browser-safe, strict, pure Zod DTOs for request bodies and response data
 * objects only. There are no routes, transport verbs, server clocks, storage,
 * crypto primitives or authorization decisions here. Machine authentication is
 * the job of the future transport/server controller: nothing in this module
 * parses an HTTP Authorization header, authorizes a caller or checks a
 * database clock.
 *
 * Raw long-lived credentials and short-lived session tokens appear only in the
 * one-time `available_once` delivery schema. They are never representable on a
 * replay, status or revoke result. Parsing a DTO never proves that a secret was
 * stored durably or that a caller is a principal, and no DTO grants source
 * signing or payment authority.
 */

export const COMMERCE_MACHINE_ENVIRONMENT = "eip155:5042002" as const;

export const CommerceMachineKindSchema = z.enum(["agent", "provider"]);

export type CommerceMachineKind = z.infer<typeof CommerceMachineKindSchema>;

/**
 * Canonical lower-case UUIDv4 identity leaves. `credentialId`, `lookupId` and
 * `sessionId` reuse the exact logical mutation-id grammar already frozen for
 * tenant writes: version nibble `4`, variant nibble `8`/`9`/`a`/`b`, and an
 * absolute end-of-input anchor so a trailing newline cannot satisfy `$`. They
 * are correlation identifiers, not authentication secrets.
 */
export const CommerceMachineCredentialIdSchema = CommerceTenantMutationIdSchema;
export const CommerceMachineLookupIdSchema = CommerceTenantMutationIdSchema;
export const CommerceMachineSessionIdSchema = CommerceTenantMutationIdSchema;

export type CommerceMachineCredentialId = z.infer<
  typeof CommerceMachineCredentialIdSchema
>;
export type CommerceMachineLookupId = z.infer<
  typeof CommerceMachineLookupIdSchema
>;
export type CommerceMachineSessionId = z.infer<
  typeof CommerceMachineSessionIdSchema
>;

const MACHINE_ID_UUID =
  "[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";

/**
 * Public, non-secret prefix of a long-lived machine credential. It names the
 * kind and the credential UUID exactly (`oac_ag_<uuid>` / `oac_pr_<uuid>`) and
 * carries no secret characters. The `(?![\s\S])` anchor rejects trailing text
 * and newlines.
 */
export const CommerceMachineCredentialPublicPrefixSchema = z
  .string()
  .regex(
    new RegExp(`^oac_(?:ag|pr)_${MACHINE_ID_UUID}(?![\\s\\S])`),
    "Expected oac_ag_<uuidv4> or oac_pr_<uuidv4>",
  );

export type CommerceMachineCredentialPublicPrefix = z.infer<
  typeof CommerceMachineCredentialPublicPrefixSchema
>;

const BASE64URL_FINAL_ALPHABET = "AEIMQUYcgkosw048";

/**
 * Canonical unpadded base64url encoding of exactly 32 bytes: exactly 43
 * characters whose final character carries zero padding bits. No decode
 * dependency is required or used. This is the secret random material of both
 * long-lived credentials and short session tokens.
 */
export const CommerceMachineSecretMaterialSchema = z
  .string()
  .regex(
    new RegExp(`^[A-Za-z0-9_-]{42}[${BASE64URL_FINAL_ALPHABET}](?![\\s\\S])`),
    "Expected 43 canonical unpadded base64url characters",
  );

export type CommerceMachineSecretMaterial = z.infer<
  typeof CommerceMachineSecretMaterialSchema
>;

/**
 * Raw long-lived credential token `oac_ag_<uuidv4>_<43base64url>` or the
 * `oac_pr_` equivalent. It is public on the wire exactly once, in an
 * `available_once` delivery, and never in a replay/status/revoke DTO.
 */
export const CommerceMachineCredentialTokenSchema = z
  .string()
  .regex(
    new RegExp(
      `^oac_(?:ag|pr)_${MACHINE_ID_UUID}_[A-Za-z0-9_-]{42}[${BASE64URL_FINAL_ALPHABET}](?![\\s\\S])`,
    ),
    "Expected a canonical raw machine credential token",
  );

export type CommerceMachineCredentialToken = z.infer<
  typeof CommerceMachineCredentialTokenSchema
>;

/**
 * Raw short-lived session token `oas_ag_<43base64url>` or the `oas_pr`
 * equivalent. A session token carries no lookup UUID.
 */
export const CommerceMachineSessionTokenSchema = z
  .string()
  .regex(
    new RegExp(
      `^oas_(?:ag|pr)_[A-Za-z0-9_-]{42}[${BASE64URL_FINAL_ALPHABET}](?![\\s\\S])`,
    ),
    "Expected a canonical raw machine session token",
  );

export type CommerceMachineSessionToken = z.infer<
  typeof CommerceMachineSessionTokenSchema
>;

const AGENT_SCOPE = "agent:self.read" as const;
const PROVIDER_SCOPE = "provider:self.read" as const;

/**
 * Exactly one self-read scope, matching the credential/session kind. A tuple
 * rejects empty, duplicate, widened and wrong-kind scopes.
 */
export const CommerceMachineScopesSchema = z.union([
  z.tuple([z.literal(AGENT_SCOPE)]),
  z.tuple([z.literal(PROVIDER_SCOPE)]),
]);

export type CommerceMachineScopes = z.infer<typeof CommerceMachineScopesSchema>;

/**
 * Existing agent/provider profile ids are reused verbatim, not re-specified.
 * They accept identities with UUID versions 1-8 exactly as the identity
 * module's canonical leaf already permits. Only NEW credential, lookup and
 * session ids are v4-only.
 */
const AgentProfileIdSchema = CommerceAgentIdSchema;
const ProviderProfileIdSchema = CommerceProviderIdSchema;

export type CommerceMachineAgentProfileId = z.infer<
  typeof AgentProfileIdSchema
>;
export type CommerceMachineProviderProfileId = z.infer<
  typeof ProviderProfileIdSchema
>;

/**
 * Kind-discriminated public prefix tuple. Each variant fixes the literal
 * prefix shape to its kind so a provider prefix can never satisfy an agent
 * credential (and vice versa).
 */
export const CommerceMachineAgentPublicPrefixSchema = z
  .string()
  .regex(new RegExp(`^oac_ag_${MACHINE_ID_UUID}(?![\\s\\S])`));

export const CommerceMachineProviderPublicPrefixSchema = z
  .string()
  .regex(new RegExp(`^oac_pr_${MACHINE_ID_UUID}(?![\\s\\S])`));

export type CommerceMachineAgentPublicPrefix = z.infer<
  typeof CommerceMachineAgentPublicPrefixSchema
>;
export type CommerceMachineProviderPublicPrefix = z.infer<
  typeof CommerceMachineProviderPublicPrefixSchema
>;

function withinMilliseconds(left: string, right: string, maxMs: number): boolean {
  const leftMs = Date.parse(left);
  const rightMs = Date.parse(right);
  if (!Number.isFinite(leftMs) || !Number.isFinite(rightMs)) return false;
  return rightMs - leftMs <= maxMs;
}

const MAX_CREDENTIAL_LIFETIME_MS = 90 * 24 * 60 * 60 * 1000;

function credentialCommonValid(value: {
  createdAt: string;
  expiresAt: string;
  revokedAt: string | null;
  status: "active" | "revoked" | "expired";
}): boolean {
  if (!IsoTimestampSchema.safeParse(value.createdAt).success) return true;
  if (!IsoTimestampSchema.safeParse(value.expiresAt).success) return true;
  if (compareIsoTimestamps(value.expiresAt, value.createdAt) <= 0) return false;
  if (!withinMilliseconds(value.createdAt, value.expiresAt, MAX_CREDENTIAL_LIFETIME_MS)) {
    return false;
  }
  const hasRevoked = value.revokedAt !== null;
  const statusRevoked = value.status === "revoked";
  if (hasRevoked !== statusRevoked) return false;
  if (value.revokedAt !== null) {
    if (!IsoTimestampSchema.safeParse(value.revokedAt).success) return true;
    if (compareIsoTimestamps(value.revokedAt, value.createdAt) < 0) return false;
  }
  if (value.status === "active" && value.revokedAt !== null) return false;
  if (value.status === "expired" && value.revokedAt !== null) return false;
  return true;
}

const CredentialCommonShape = {
  credentialId: CommerceMachineCredentialIdSchema,
  environment: z.literal(COMMERCE_MACHINE_ENVIRONMENT),
  scopeVersion: z.literal(1),
  createdAt: IsoTimestampSchema,
  expiresAt: IsoTimestampSchema,
  revokedAt: IsoTimestampSchema.nullable(),
  status: z.enum(["active", "revoked", "expired"]),
} as const;

/**
 * Strict kind-discriminated credential metadata. The kind fixes both the
 * profile-id namespace and the exact one-element scope tuple. Timestamps are
 * canonical ISO leaves; `expiresAt` must strictly follow `createdAt` and stay
 * within the 90-day hard maximum. `revokedAt` is present if and only if the
 * status is `revoked`, and never precedes `createdAt`. No current-clock
 * inference, issuer, hash, pepper, lookup-internals, display name, session or
 * original request is representable.
 */
export const CommerceMachineCredentialMetadataSchema = z
  .discriminatedUnion("kind", [
    z.strictObject({
      ...CredentialCommonShape,
      kind: z.literal("agent"),
      profileId: AgentProfileIdSchema,
      publicPrefix: CommerceMachineAgentPublicPrefixSchema,
      scopes: z.tuple([z.literal(AGENT_SCOPE)]),
    }),
    z.strictObject({
      ...CredentialCommonShape,
      kind: z.literal("provider"),
      profileId: ProviderProfileIdSchema,
      publicPrefix: CommerceMachineProviderPublicPrefixSchema,
      scopes: z.tuple([z.literal(PROVIDER_SCOPE)]),
    }),
  ])
  .superRefine((value, ctx) => {
    if (!credentialCommonValid(value)) {
      ctx.addIssue({
        code: "custom",
        path: ["createdAt"],
        message:
          "credential timestamps/status violate the canonical lifetime rules",
      });
    }
  });

export type CommerceMachineCredentialMetadata = z.infer<
  typeof CommerceMachineCredentialMetadataSchema
>;

const MACHINE_CREDENTIAL_PAGE_MAX = 50;

function duplicateCredentialIds(items: readonly { credentialId: string }[]): boolean {
  const seen = new Set<string>();
  for (const item of items) {
    if (seen.has(item.credentialId)) return true;
    seen.add(item.credentialId);
  }
  return false;
}

/**
 * Strict credential list data. The page repeats the outer kind and profile so
 * every item can be correlated with the requested namespace. Pagination
 * defaulting is a SERVER responsibility; this schema only caps `items` at the
 * frozen maximum of 50 and rejects duplicate credential ids. `nextCursor` is a
 * canonical UUIDv4 or null.
 */
export const CommerceMachineCredentialPageSchema = z
  .strictObject({
    organizationId: CommerceOrganizationIdSchema,
    kind: CommerceMachineKindSchema,
    profileId: z.union([AgentProfileIdSchema, ProviderProfileIdSchema]),
    items: z
      .array(CommerceMachineCredentialMetadataSchema)
      .max(MACHINE_CREDENTIAL_PAGE_MAX),
    nextCursor: CommerceMachineCredentialIdSchema.nullable(),
  })
  .superRefine((value, ctx) => {
    if (duplicateCredentialIds(value.items)) {
      ctx.addIssue({
        code: "custom",
        path: ["items"],
        message: "credentialId values must be unique within a page",
      });
    }
    // The page namespace is discriminated independently of `items`, so an
    // empty agent page carrying a provider profile id (or vice versa) is
    // rejected even when there are no items to inspect.
    const profileMatchesKind =
      value.kind === "agent"
        ? CommerceAgentIdSchema.safeParse(value.profileId).success
        : CommerceProviderIdSchema.safeParse(value.profileId).success;
    if (!profileMatchesKind) {
      ctx.addIssue({
        code: "custom",
        path: ["profileId"],
        message: "page profileId namespace must match the page kind",
      });
    }
    value.items.forEach((item, index) => {
      if (item.kind !== value.kind) {
        ctx.addIssue({
          code: "custom",
          path: ["items", index, "kind"],
          message: "item kind must match the page kind",
        });
      }
      if (item.profileId !== value.profileId) {
        ctx.addIssue({
          code: "custom",
          path: ["items", index, "profileId"],
          message: "item profileId must match the page profileId",
        });
      }
    });
  });

export type CommerceMachineCredentialPage = z.infer<
  typeof CommerceMachineCredentialPageSchema
>;

/**
 * Human issue body is exactly `{ mutationId, expiresAt }`. Scope, organization,
 * profile, credential route ids, actor and idempotency keys are transport
 * concerns and are deliberately not accepted in the body.
 */
export const CommerceMachineCredentialIssueBodySchema = z.strictObject({
  mutationId: CommerceTenantMutationIdSchema,
  expiresAt: IsoTimestampSchema,
});

export const CommerceMachineCredentialRevokeBodySchema = z.strictObject({
  mutationId: CommerceTenantMutationIdSchema,
});

/** Strict empty bodies for machine exchange / current-credential revoke. */
export const CommerceMachineEmptyBodySchema = z.strictObject({});

export type CommerceMachineCredentialIssueBody = z.infer<
  typeof CommerceMachineCredentialIssueBodySchema
>;
export type CommerceMachineCredentialRevokeBody = z.infer<
  typeof CommerceMachineCredentialRevokeBodySchema
>;
export type CommerceMachineEmptyBody = z.infer<
  typeof CommerceMachineEmptyBodySchema
>;

const CREDENTIAL_RESOURCE_TYPE = {
  agent: "agent_credential",
  provider: "provider_credential",
} as const;

/**
 * Machine mutation receipt union, SEPARATE from the tenant-write receipt
 * union. Operations are exactly the four machine credential issue/revoke
 * operations, each paired with its exact credential resource type. Issue
 * receipts carry `credentialId === mutationId`; revoke receipts target an
 * independent credential id. There is no raw token, prefix, actor or
 * `resourceId` alias.
 */
export const CommerceMachineMutationReceiptSchema = z
  .discriminatedUnion("operation", [
    z.strictObject({
      mutationId: CommerceTenantMutationIdSchema,
      operation: z.literal("tenant.agent.credential.issue"),
      resourceType: z.literal(CREDENTIAL_RESOURCE_TYPE.agent),
      credentialId: CommerceMachineCredentialIdSchema,
      committedAt: IsoTimestampSchema,
    }),
    z.strictObject({
      mutationId: CommerceTenantMutationIdSchema,
      operation: z.literal("tenant.provider.credential.issue"),
      resourceType: z.literal(CREDENTIAL_RESOURCE_TYPE.provider),
      credentialId: CommerceMachineCredentialIdSchema,
      committedAt: IsoTimestampSchema,
    }),
    z.strictObject({
      mutationId: CommerceTenantMutationIdSchema,
      operation: z.literal("tenant.agent.credential.revoke"),
      resourceType: z.literal(CREDENTIAL_RESOURCE_TYPE.agent),
      credentialId: CommerceMachineCredentialIdSchema,
      committedAt: IsoTimestampSchema,
    }),
    z.strictObject({
      mutationId: CommerceTenantMutationIdSchema,
      operation: z.literal("tenant.provider.credential.revoke"),
      resourceType: z.literal(CREDENTIAL_RESOURCE_TYPE.provider),
      credentialId: CommerceMachineCredentialIdSchema,
      committedAt: IsoTimestampSchema,
    }),
  ])
  .superRefine((receipt, ctx) => {
    if (receipt.operation.endsWith(".issue") && receipt.credentialId !== receipt.mutationId) {
      ctx.addIssue({
        code: "custom",
        path: ["credentialId"],
        message: "issue credentialId must equal mutationId",
      });
    }
  });

export type CommerceMachineMutationReceipt = z.infer<
  typeof CommerceMachineMutationReceiptSchema
>;

export const CommerceMachineIssueReceiptSchema =
  CommerceMachineMutationReceiptSchema.refine(
    (receipt) => receipt.operation.endsWith(".issue"),
    { message: "Expected an issue receipt" },
  );

export const CommerceMachineRevokeReceiptSchema =
  CommerceMachineMutationReceiptSchema.refine(
    (receipt) => receipt.operation.endsWith(".revoke"),
    { message: "Expected a revoke receipt" },
  );

function receiptKind(operation: string): "agent" | "provider" {
  return operation.includes(".provider.") ? "provider" : "agent";
}

const CredentialTokenDeliverySchema = z.strictObject({
  status: z.literal("available_once"),
  credential: CommerceMachineCredentialTokenSchema,
  publicPrefix: CommerceMachineCredentialPublicPrefixSchema,
});

const TokenNotReplayableDeliverySchema = z.strictObject({
  status: z.literal("token_not_replayable"),
});

/**
 * Strict issue result discriminated by `replayed`. The fresh variant carries
 * the raw credential exactly once plus its kind-correct public prefix; the
 * replay variant carries no reusable secret. Every variant correlates the
 * receipt operation kind with the delivery prefix and raw token prefix.
 */
export const CommerceMachineCredentialIssueResultSchema = z
  .discriminatedUnion("replayed", [
    z.strictObject({
      organizationId: CommerceOrganizationIdSchema,
      replayed: z.literal(false),
      receipt: CommerceMachineIssueReceiptSchema,
      delivery: CredentialTokenDeliverySchema,
    }),
    z.strictObject({
      organizationId: CommerceOrganizationIdSchema,
      replayed: z.literal(true),
      receipt: CommerceMachineIssueReceiptSchema,
      delivery: TokenNotReplayableDeliverySchema,
    }),
  ])
  .superRefine((value, ctx) => {
    if (value.replayed !== false) return;
    const kind = receiptKind(value.receipt.operation);
    const expectedPrefix = kind === "agent" ? "oac_ag_" : "oac_pr_";
    const token = value.delivery.credential;
    const tokenPrefixMatchesKind =
      kind === "agent"
        ? token.startsWith("oac_ag_")
        : token.startsWith("oac_pr_");
    // The raw credential embeds an independently generated lookup UUID, NOT
    // the receipt credentialId (which for an issue equals the mutation id).
    // Correlate only the kind prefix; the lookup identifier must be free to
    // differ from the credential id.
    if (!tokenPrefixMatchesKind) {
      ctx.addIssue({
        code: "custom",
        path: ["delivery", "credential"],
        message: "raw credential kind prefix must match the receipt operation",
      });
    }
    // Correlate the full public prefix shown to the caller with the public
    // prefix embedded in the raw token: both derive from the same kind and
    // independently generated lookup UUID. No receipt credentialId is
    // involved.
    if (
      !token.startsWith(`${expectedPrefix}`) ||
      value.delivery.publicPrefix !== token.slice(0, expectedPrefix.length + 36)
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["delivery", "publicPrefix"],
        message: "publicPrefix must match the raw credential lookup prefix",
      });
    }
    if (receiptKind(value.receipt.operation) !== value.receipt.resourceType.split("_")[0]) {
      ctx.addIssue({
        code: "custom",
        path: ["receipt", "resourceType"],
        message: "resourceType kind must match the operation kind",
      });
    }
  });

export type CommerceMachineCredentialIssueResult = z.infer<
  typeof CommerceMachineCredentialIssueResultSchema
>;

export const CommerceMachineCredentialRevokeResultSchema = z.strictObject({
  organizationId: CommerceOrganizationIdSchema,
  replayed: z.boolean(),
  receipt: CommerceMachineRevokeReceiptSchema,
});

export type CommerceMachineCredentialRevokeResult = z.infer<
  typeof CommerceMachineCredentialRevokeResultSchema
>;

export const CommerceMachineCredentialStatusSchema = z.discriminatedUnion(
  "status",
  [
    z.strictObject({
      organizationId: CommerceOrganizationIdSchema,
      status: z.literal("committed"),
      receipt: CommerceMachineMutationReceiptSchema,
    }),
    z.strictObject({
      organizationId: CommerceOrganizationIdSchema,
      status: z.literal("not_found"),
    }),
  ],
);

export type CommerceMachineCredentialStatus = z.infer<
  typeof CommerceMachineCredentialStatusSchema
>;

const MAX_SESSION_LIFETIME_MS = 15 * 60 * 1000;

function sessionTimestampsValid(value: {
  createdAt: string;
  expiresAt: string;
}): boolean {
  if (!IsoTimestampSchema.safeParse(value.createdAt).success) return true;
  if (!IsoTimestampSchema.safeParse(value.expiresAt).success) return true;
  if (compareIsoTimestamps(value.expiresAt, value.createdAt) <= 0) return false;
  return withinMilliseconds(value.createdAt, value.expiresAt, MAX_SESSION_LIFETIME_MS);
}

/**
 * Strict kind-discriminated session metadata. `expiresAt` must strictly follow
 * `createdAt` and stay within the 15-minute hard database maximum (the API
 * layer will target 5 minutes). No issuer, revocation version, hash, raw
 * credential or session token is representable.
 */
export const CommerceMachineSessionMetadataSchema = z
  .discriminatedUnion("kind", [
    z.strictObject({
      sessionId: CommerceMachineSessionIdSchema,
      credentialId: CommerceMachineCredentialIdSchema,
      organizationId: CommerceOrganizationIdSchema,
      kind: z.literal("agent"),
      profileId: AgentProfileIdSchema,
      environment: z.literal(COMMERCE_MACHINE_ENVIRONMENT),
      scopes: z.tuple([z.literal(AGENT_SCOPE)]),
      scopeVersion: z.literal(1),
      createdAt: IsoTimestampSchema,
      expiresAt: IsoTimestampSchema,
    }),
    z.strictObject({
      sessionId: CommerceMachineSessionIdSchema,
      credentialId: CommerceMachineCredentialIdSchema,
      organizationId: CommerceOrganizationIdSchema,
      kind: z.literal("provider"),
      profileId: ProviderProfileIdSchema,
      environment: z.literal(COMMERCE_MACHINE_ENVIRONMENT),
      scopes: z.tuple([z.literal(PROVIDER_SCOPE)]),
      scopeVersion: z.literal(1),
      createdAt: IsoTimestampSchema,
      expiresAt: IsoTimestampSchema,
    }),
  ])
  .superRefine((value, ctx) => {
    if (!sessionTimestampsValid(value)) {
      ctx.addIssue({
        code: "custom",
        path: ["createdAt"],
        message:
          "session expiresAt must strictly follow createdAt and stay within 15 minutes",
      });
    }
  });

export type CommerceMachineSessionMetadata = z.infer<
  typeof CommerceMachineSessionMetadataSchema
>;

const SessionTokenDeliverySchema = z
  .strictObject({
    status: z.literal("available_once"),
    token: CommerceMachineSessionTokenSchema,
  });

/**
 * Exchange result: metadata plus a one-time raw session token. The raw token
 * kind must match the metadata kind. This is the only DTO in the module that
 * carries a session token.
 */
export const CommerceMachineSessionExchangeResultSchema = z
  .strictObject({
    session: CommerceMachineSessionMetadataSchema,
    delivery: SessionTokenDeliverySchema,
  })
  .superRefine((value, ctx) => {
    const expectedPrefix = value.session.kind === "agent" ? "oas_ag_" : "oas_pr_";
    if (!value.delivery.token.startsWith(expectedPrefix)) {
      ctx.addIssue({
        code: "custom",
        path: ["delivery", "token"],
        message: "session token prefix must match the session kind",
      });
    }
  });

export type CommerceMachineSessionExchangeResult = z.infer<
  typeof CommerceMachineSessionExchangeResultSchema
>;

/** Self result: safe session metadata only, with no raw token. */
export const CommerceMachineSessionSelfResultSchema = z.strictObject({
  session: CommerceMachineSessionMetadataSchema,
});

export type CommerceMachineSessionSelfResult = z.infer<
  typeof CommerceMachineSessionSelfResultSchema
>;

export const CommerceMachineSessionRevokeResultSchema = z.strictObject({
  kind: CommerceMachineKindSchema,
  sessionId: CommerceMachineSessionIdSchema,
  organizationId: CommerceOrganizationIdSchema,
  revokedAt: IsoTimestampSchema,
});

export type CommerceMachineSessionRevokeResult = z.infer<
  typeof CommerceMachineSessionRevokeResultSchema
>;

/**
 * Typed strict v2 success envelopes. These reuse the existing factory and add
 * no envelope or error-catalog behavior; callers must reuse the existing error
 * schema for failures. Plain schemas are neither authentication nor payment
 * authorization.
 */
export const CommerceMachineCredentialPageResponseSchema =
  createCommerceSuccessEnvelopeSchema(CommerceMachineCredentialPageSchema);
export const CommerceMachineCredentialIssueResponseSchema =
  createCommerceSuccessEnvelopeSchema(
    CommerceMachineCredentialIssueResultSchema,
  );
export const CommerceMachineCredentialRevokeResponseSchema =
  createCommerceSuccessEnvelopeSchema(
    CommerceMachineCredentialRevokeResultSchema,
  );
export const CommerceMachineCredentialStatusResponseSchema =
  createCommerceSuccessEnvelopeSchema(CommerceMachineCredentialStatusSchema);
export const CommerceMachineSessionExchangeResponseSchema =
  createCommerceSuccessEnvelopeSchema(
    CommerceMachineSessionExchangeResultSchema,
  );
export const CommerceMachineSessionSelfResponseSchema =
  createCommerceSuccessEnvelopeSchema(CommerceMachineSessionSelfResultSchema);
export const CommerceMachineSessionRevokeResponseSchema =
  createCommerceSuccessEnvelopeSchema(
    CommerceMachineSessionRevokeResultSchema,
  );

export type CommerceMachineCredentialPageResponse = z.infer<
  typeof CommerceMachineCredentialPageResponseSchema
>;
export type CommerceMachineCredentialIssueResponse = z.infer<
  typeof CommerceMachineCredentialIssueResponseSchema
>;
export type CommerceMachineCredentialRevokeResponse = z.infer<
  typeof CommerceMachineCredentialRevokeResponseSchema
>;
export type CommerceMachineCredentialStatusResponse = z.infer<
  typeof CommerceMachineCredentialStatusResponseSchema
>;
export type CommerceMachineSessionExchangeResponse = z.infer<
  typeof CommerceMachineSessionExchangeResponseSchema
>;
export type CommerceMachineSessionSelfResponse = z.infer<
  typeof CommerceMachineSessionSelfResponseSchema
>;
export type CommerceMachineSessionRevokeResponse = z.infer<
  typeof CommerceMachineSessionRevokeResponseSchema
>;

const PROTECTED_CLASS = "organization_protected" as const;

function protectedFields<K extends string>(
  keys: readonly K[],
): Readonly<Record<K, typeof PROTECTED_CLASS>> {
  const map = {} as Record<K, typeof PROTECTED_CLASS>;
  for (const key of keys) {
    map[key] = PROTECTED_CLASS;
  }
  return Object.freeze(map);
}

/**
 * Conservative top-level classification for the machine response data shapes.
 * Descriptive metadata only: it is not authorization, redaction or an
 * assertion that a secret may be persisted.
 */
export const COMMERCE_MACHINE_FIELD_CLASSES = Object.freeze({
  credentialMetadata: protectedFields([
    "credentialId",
    "kind",
    "profileId",
    "publicPrefix",
    "environment",
    "scopes",
    "scopeVersion",
    "createdAt",
    "expiresAt",
    "revokedAt",
    "status",
  ] as const),
  credentialPage: protectedFields([
    "organizationId",
    "kind",
    "profileId",
    "items",
    "nextCursor",
  ] as const),
  credentialIssueResult: protectedFields([
    "organizationId",
    "replayed",
    "receipt",
    "delivery",
  ] as const),
  credentialRevokeResult: protectedFields([
    "organizationId",
    "replayed",
    "receipt",
  ] as const),
  sessionMetadata: protectedFields([
    "sessionId",
    "credentialId",
    "organizationId",
    "kind",
    "profileId",
    "environment",
    "scopes",
    "scopeVersion",
    "createdAt",
    "expiresAt",
  ] as const),
  sessionExchangeResult: protectedFields([
    "session",
    "delivery",
  ] as const),
  sessionSelfResult: protectedFields(["session"] as const),
  sessionRevokeResult: protectedFields([
    "kind",
    "sessionId",
    "organizationId",
    "revokedAt",
  ] as const),
});
