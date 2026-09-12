import { randomUUID } from "node:crypto";

import {
  CommerceAgentIdSchema,
  CommerceMachineCredentialIssueBodySchema,
  CommerceMachineCredentialIssueResultSchema,
  CommerceMachineCredentialMetadataSchema,
  CommerceMachineCredentialPageSchema,
  CommerceMachineCredentialRevokeBodySchema,
  CommerceMachineCredentialRevokeResultSchema,
  CommerceMachineCredentialStatusSchema,
  CommerceMachineMutationReceiptSchema,
  CommerceMachineRevokeReceiptSchema,
  CommerceOrganizationIdSchema,
  CommerceProviderIdSchema,
  CommerceTenantIdempotencyKeySchema,
  CommerceTenantMutationIdSchema,
  type CommerceMachineCredentialIssueResult,
  type CommerceMachineCredentialPage,
  type CommerceMachineCredentialRevokeResult,
  type CommerceMachineCredentialStatus,
  type CommerceMachineMutationReceipt,
} from "@openarc/shared";
import { CredentialStoreError } from "@openarc/db";
import type { ZodType } from "zod";

import { AUTH_ERRORS, AuthApiError } from "../auth/errors.js";
import type { AuthRequestContext } from "../auth/service.js";
import {
  generateMachineCredential,
  MachineCredentialError,
  type MachineCredentialKind,
} from "./credential-crypto.js";
import { MACHINE_RATE_LIMITS, type MachineRateLimiter } from "./rate-limiter.js";
import type {
  MachineCredentialStorePort,
  MachineCryptoPort,
  MachineManagementAuthPort,
  MachineRequestContext,
} from "./ports.js";

/**
 * Human management orchestration for the machine credential family.
 *
 * Ordering contract: strict input validation, the exact accepted CSRF check,
 * `beginTenantRead` (rate limit and live internal account/session hash), a
 * bounded preflight namespace resolution through `CredentialStore.list(1)`
 * that does NOT authorize the write, the additional per-account issuance rate
 * limit, THEN the expensive KDF and exactly ONE typed durable issue/revoke
 * call. The accepted SQL rechecks the actual fresh human proof, current role
 * and profile atomically at commit; no client proof or role is ever trusted.
 *
 * A candidate secret is generated only after every human precheck and is
 * returned ONLY when the durable call confirms a non-replayed commit whose
 * receipt validates. On replay/conflict/unknown/projection failure the
 * candidate is discarded; no write is repeated, no replacement is attempted.
 */

const MAX_LIST_LIMIT = 50;
const DEFAULT_LIST_LIMIT = 50;

interface ManagementRequestEnvelope {
  readonly ctx: AuthRequestContext;
  readonly csrf: unknown;
  readonly idempotencyKey: unknown;
  readonly body: unknown;
}

export interface MachineManagementServiceOptions {
  readonly auth: MachineManagementAuthPort;
  readonly store: MachineCredentialStorePort;
  readonly crypto: MachineCryptoPort;
  readonly limits: MachineRateLimiter;
}

function invalidInput(): AuthApiError {
  return AUTH_ERRORS.invalidRequest();
}

function forbidden(): AuthApiError {
  return AUTH_ERRORS.forbidden();
}

function unauthenticated(): AuthApiError {
  return AUTH_ERRORS.unauthenticated();
}

function unavailable(): AuthApiError {
  return AUTH_ERRORS.unavailable();
}

function idempotencyConflict(): AuthApiError {
  return new AuthApiError("IDEMPOTENCY_CONFLICT", 409, "INVALID_REQUEST");
}

function policyDenied(): AuthApiError {
  return new AuthApiError("POLICY_DENIED", 409, "INVALID_REQUEST");
}

function projectionFailure(): AuthApiError {
  return AUTH_ERRORS.internal();
}

function mapStoreError(error: unknown): never {
  if (error instanceof AuthApiError) throw error;
  if (error instanceof CredentialStoreError) {
    switch (error.code) {
      case "CREDENTIAL_STORE_INPUT_INVALID":
        throw invalidInput();
      case "CREDENTIAL_STORE_SESSION_INVALID":
        throw unauthenticated();
      case "CREDENTIAL_STORE_FORBIDDEN":
      case "CREDENTIAL_STORE_NOT_FOUND":
        throw forbidden();
      case "CREDENTIAL_STORE_CONFLICT":
        throw policyDenied();
      case "CREDENTIAL_STORE_IDEMPOTENCY_CONFLICT":
        throw idempotencyConflict();
      case "CREDENTIAL_STORE_UNAVAILABLE":
      case "CREDENTIAL_STORE_OUTCOME_UNKNOWN":
      default:
        throw unavailable();
    }
  }
  throw unavailable();
}

function mapCryptoError(error: unknown): never {
  if (error instanceof AuthApiError) throw error;
  if (error instanceof MachineCredentialError) {
    if (error.code === "BUSY") throw AUTH_ERRORS.rateLimited();
    if (
      error.code === "INVALID_RECORD" ||
      error.code === "UNSUPPORTED_VERSION" ||
      error.code === "DISPOSED" ||
      error.code === "CRYPTO_FAILURE" ||
      error.code === "INVALID_CONFIG"
    ) {
      throw unavailable();
    }
    throw invalidInput();
  }
  throw unavailable();
}

function parseRequest<T>(schema: ZodType<T>, input: unknown): T {
  const parsed = schema.safeParse(input);
  if (!parsed.success) throw invalidInput();
  return parsed.data;
}

function profileSchema(kind: MachineCredentialKind) {
  return kind === "agent" ? CommerceAgentIdSchema : CommerceProviderIdSchema;
}

function issueOperation(kind: MachineCredentialKind): string {
  return kind === "agent"
    ? "tenant.agent.credential.issue"
    : "tenant.provider.credential.issue";
}

function revokeOperation(kind: MachineCredentialKind): string {
  return kind === "agent"
    ? "tenant.agent.credential.revoke"
    : "tenant.provider.credential.revoke";
}

export class MachineManagementService {
  readonly #auth: MachineManagementAuthPort;
  readonly #store: MachineCredentialStorePort;
  readonly #crypto: MachineCryptoPort;
  readonly #limits: MachineRateLimiter;

  constructor(options: MachineManagementServiceOptions) {
    this.#auth = options.auth;
    this.#store = options.store;
    this.#crypto = options.crypto;
    this.#limits = options.limits;
  }

  async listCredentials(
    kind: MachineCredentialKind,
    organizationId: unknown,
    profileId: unknown,
    request: {
      readonly after?: unknown;
      readonly limit?: unknown;
      readonly ctx: MachineRequestContext;
    },
  ): Promise<CommerceMachineCredentialPage> {
    const organization = parseRequest(CommerceOrganizationIdSchema, organizationId);
    const profile = parseRequest(profileSchema(kind), profileId);
    const limit = this.#parseLimit(request.limit);
    const after =
      request.after === undefined
        ? undefined
        : parseRequest(CommerceTenantMutationIdSchema, request.after);
    const begun = await this.#auth.beginTenantRead(request.ctx);
    let raw: unknown;
    try {
      raw = await this.#list(kind, {
        sessionHash: begun.sessionHash,
        organizationId: organization,
        profileId: profile,
        ...(after !== undefined ? { after } : {}),
        limit,
      });
    } catch (error) {
      mapStoreError(error);
    }
    await this.#auth.finishTenantRead(request.ctx, begun);
    return this.#projectPage(kind, organization, profile, raw);
  }

  async getMutationStatus(
    kind: MachineCredentialKind,
    organizationId: unknown,
    mutationId: unknown,
    ctx: MachineRequestContext,
  ): Promise<CommerceMachineCredentialStatus> {
    const organization = parseRequest(CommerceOrganizationIdSchema, organizationId);
    const mutation = parseRequest(CommerceTenantMutationIdSchema, mutationId);
    const begun = await this.#auth.beginTenantRead(ctx);
    let raw: unknown;
    try {
      raw =
        kind === "agent"
          ? await this.#store.getAgentCredentialMutationStatus(
              begun.sessionHash,
              organization,
              mutation,
            )
          : await this.#store.getProviderCredentialMutationStatus(
              begun.sessionHash,
              organization,
              mutation,
            );
    } catch (error) {
      mapStoreError(error);
    }
    await this.#auth.finishTenantRead(ctx, begun);
    return this.#projectStatus(kind, organization, mutation, raw);
  }

  async issueCredential(
    kind: MachineCredentialKind,
    organizationId: unknown,
    profileId: unknown,
    request: ManagementRequestEnvelope,
  ): Promise<CommerceMachineCredentialIssueResult> {
    const organization = parseRequest(CommerceOrganizationIdSchema, organizationId);
    const profile = parseRequest(profileSchema(kind), profileId);
    const body = parseRequest(CommerceMachineCredentialIssueBodySchema, request.body);
    const idempotencyKey = parseRequest(
      CommerceTenantIdempotencyKeySchema,
      request.idempotencyKey,
    );

    this.#auth.verifyCsrf(request.ctx.cookies, request.csrf);
    const begun = await this.#auth.beginTenantRead(request.ctx);
    await this.#preflight(kind, begun.sessionHash, organization, profile);
    await this.#limits.consume({
      family: "management",
      bucket: "account",
      kind,
      value: begun.accountId,
      limit: MACHINE_RATE_LIMITS.issuance.account,
    });

    const lookupId = randomUUID();
    const candidate = generateMachineCredential({ kind, lookupId });
    let record;
    try {
      record = await this.#crypto.hash({ kind, lookupId, raw: candidate.raw });
    } catch (error) {
      mapCryptoError(error);
    }
    const hash = {
      algorithm: "scrypt" as const,
      hashVersion: 1 as const,
      pepperVersion: record.pepperVersion,
      N: 32768 as const,
      r: 8 as const,
      p: 1 as const,
      salt: record.salt,
      digest: record.digest,
    };

    let raw: unknown;
    try {
      raw =
        kind === "agent"
          ? await this.#store.issueAgentCredentialDurably({
              sessionHash: begun.sessionHash,
              organizationId: organization,
              profileId: profile,
              lookupId,
              hash,
              expiresAt: body.expiresAt,
              metadata: { idempotencyKey, mutationId: body.mutationId },
            })
          : await this.#store.issueProviderCredentialDurably({
              sessionHash: begun.sessionHash,
              organizationId: organization,
              profileId: profile,
              lookupId,
              hash,
              expiresAt: body.expiresAt,
              metadata: { idempotencyKey, mutationId: body.mutationId },
            });
    } catch (error) {
      mapStoreError(error);
    }

    return this.#projectIssue(kind, organization, body.mutationId, candidate, raw);
  }

  async revokeCredential(
    kind: MachineCredentialKind,
    organizationId: unknown,
    credentialId: unknown,
    request: ManagementRequestEnvelope,
  ): Promise<CommerceMachineCredentialRevokeResult> {
    const organization = parseRequest(CommerceOrganizationIdSchema, organizationId);
    const credential = parseRequest(CommerceTenantMutationIdSchema, credentialId);
    const body = parseRequest(CommerceMachineCredentialRevokeBodySchema, request.body);
    const idempotencyKey = parseRequest(
      CommerceTenantIdempotencyKeySchema,
      request.idempotencyKey,
    );
    this.#auth.verifyCsrf(request.ctx.cookies, request.csrf);
    const begun = await this.#auth.beginTenantRead(request.ctx);

    let raw: unknown;
    try {
      raw =
        kind === "agent"
          ? await this.#store.revokeAgentCredentialDurably({
              sessionHash: begun.sessionHash,
              organizationId: organization,
              credentialId: credential,
              metadata: { idempotencyKey, mutationId: body.mutationId },
            })
          : await this.#store.revokeProviderCredentialDurably({
              sessionHash: begun.sessionHash,
              organizationId: organization,
              credentialId: credential,
              metadata: { idempotencyKey, mutationId: body.mutationId },
            });
    } catch (error) {
      mapStoreError(error);
    }
    return this.#projectRevoke(kind, organization, credential, body.mutationId, raw);
  }

  #parseLimit(value: unknown): number {
    if (value === undefined) return DEFAULT_LIST_LIMIT;
    if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > MAX_LIST_LIMIT) {
      throw invalidInput();
    }
    return value;
  }

  #list(
    kind: MachineCredentialKind,
    input: {
      sessionHash: string;
      organizationId: string;
      profileId: string;
      after?: string;
      limit?: number;
    },
  ): Promise<unknown> {
    return kind === "agent"
      ? this.#store.listAgentCredentials(input)
      : this.#store.listProviderCredentials(input);
  }

  async #preflight(
    kind: MachineCredentialKind,
    sessionHash: string,
    organizationId: string,
    profileId: string,
  ): Promise<void> {
    try {
      await this.#list(kind, {
        sessionHash,
        organizationId,
        profileId,
        limit: 1,
      });
    } catch (error) {
      mapStoreError(error);
    }
  }

  #projectPage(
    kind: MachineCredentialKind,
    organizationId: string,
    profileId: string,
    raw: unknown,
  ): CommerceMachineCredentialPage {
    if (typeof raw !== "object" || raw === null) throw projectionFailure();
    const source = raw as { items?: unknown; nextCursor?: unknown };
    if (!Array.isArray(source.items)) throw projectionFailure();
    const items = source.items.map((item) => {
      if (typeof item !== "object" || item === null) throw projectionFailure();
      const record = item as Record<string, unknown>;
      const parsed = CommerceMachineCredentialMetadataSchema.safeParse({
        credentialId: record["credentialId"],
        kind,
        profileId: record["profileId"],
        publicPrefix: record["keyPrefix"],
        environment: record["environment"],
        scopes: [record["scope"]],
        scopeVersion: record["scopeVersion"],
        createdAt: record["createdAt"],
        expiresAt: record["expiresAt"],
        revokedAt: record["revokedAt"],
        status: record["status"],
      });
      if (!parsed.success) throw projectionFailure();
      return parsed.data;
    });
    const page = CommerceMachineCredentialPageSchema.safeParse({
      organizationId,
      kind,
      profileId,
      items,
      nextCursor: source.nextCursor,
    });
    if (!page.success) throw projectionFailure();
    return page.data;
  }

  #projectStatus(
    kind: MachineCredentialKind,
    organizationId: string,
    mutationId: string,
    raw: unknown,
  ): CommerceMachineCredentialStatus {
    if (typeof raw !== "object" || raw === null) throw projectionFailure();
    const record = raw as Record<string, unknown>;
    if (record["status"] === "not_found") {
      const parsed = CommerceMachineCredentialStatusSchema.safeParse({
        organizationId,
        status: "not_found",
      });
      if (!parsed.success) throw projectionFailure();
      return parsed.data;
    }
    if (record["status"] !== "committed") throw projectionFailure();
    const receipt = this.#receiptKindBound(kind, record["receipt"], mutationId);
    const parsed = CommerceMachineCredentialStatusSchema.safeParse({
      organizationId,
      status: "committed",
      receipt,
    });
    if (!parsed.success) throw projectionFailure();
    return parsed.data;
  }

  #receiptKindBound(
    kind: MachineCredentialKind,
    raw: unknown,
    expectedMutationId: string | null,
  ): CommerceMachineMutationReceipt {
    if (typeof raw !== "object" || raw === null) throw projectionFailure();
    const record = raw as Record<string, unknown>;
    const parsed = CommerceMachineMutationReceiptSchema.safeParse({
      mutationId: record["mutationId"],
      operation: record["operation"],
      resourceType: record["resourceType"],
      credentialId: record["credentialId"],
      committedAt: record["committedAt"],
    });
    if (!parsed.success) throw projectionFailure();
    const expectedOperationPrefix =
      kind === "agent" ? "tenant.agent.credential." : "tenant.provider.credential.";
    if (!parsed.data.operation.startsWith(expectedOperationPrefix)) {
      throw projectionFailure();
    }
    if (expectedMutationId !== null && parsed.data.mutationId !== expectedMutationId) {
      throw projectionFailure();
    }
    return parsed.data;
  }

  #projectIssue(
    kind: MachineCredentialKind,
    organizationId: string,
    mutationId: string,
    candidate: { readonly raw: string; readonly publicPrefix: string },
    raw: unknown,
  ): CommerceMachineCredentialIssueResult {
    if (typeof raw !== "object" || raw === null) throw projectionFailure();
    const record = raw as Record<string, unknown>;
    const replayed = record["replayed"];
    if (replayed !== true && replayed !== false) throw projectionFailure();
    const receipt = this.#receiptKindBound(kind, record["receipt"], mutationId);
    if (receipt.operation !== issueOperation(kind)) throw projectionFailure();
    if (receipt.credentialId !== mutationId) throw projectionFailure();

    const delivery =
      replayed === true
        ? { status: "token_not_replayable" as const }
        : {
            status: "available_once" as const,
            credential: candidate.raw,
            publicPrefix: candidate.publicPrefix,
          };
    const parsed = CommerceMachineCredentialIssueResultSchema.safeParse({
      organizationId,
      replayed,
      receipt,
      delivery,
    });
    if (!parsed.success) throw projectionFailure();
    return parsed.data;
  }

  #projectRevoke(
    kind: MachineCredentialKind,
    organizationId: string,
    credentialId: string,
    mutationId: string,
    raw: unknown,
  ): CommerceMachineCredentialRevokeResult {
    if (typeof raw !== "object" || raw === null) throw projectionFailure();
    const record = raw as Record<string, unknown>;
    const replayed = record["replayed"];
    if (replayed !== true && replayed !== false) throw projectionFailure();
    const receipt = this.#receiptKindBound(kind, record["receipt"], mutationId);
    const parsedReceipt = CommerceMachineRevokeReceiptSchema.safeParse(receipt);
    if (!parsedReceipt.success) throw projectionFailure();
    if (parsedReceipt.data.operation !== revokeOperation(kind)) throw projectionFailure();
    if (parsedReceipt.data.credentialId !== credentialId) throw projectionFailure();
    const parsed = CommerceMachineCredentialRevokeResultSchema.safeParse({
      organizationId,
      replayed,
      receipt: parsedReceipt.data,
    });
    if (!parsed.success) throw projectionFailure();
    return parsed.data;
  }
}
