import {
  CommerceAccountIdSchema,
  CommerceAgentCreateBodySchema,
  CommerceAgentIdSchema,
  CommerceAgentUpdateBodySchema,
  CommerceMembershipSetBodySchema,
  CommerceOrganizationCreateBodySchema,
  CommerceOrganizationIdSchema,
  CommerceProviderCreateBodySchema,
  CommerceProviderIdSchema,
  CommerceProviderUpdateBodySchema,
  CommerceTenantIdempotencyKeySchema,
  CommerceTenantMutationIdSchema,
  CommerceTenantMutationReceiptSchema,
  CommerceTenantMutationResultSchema,
  CommerceTenantMutationStatusSchema,
  type CommerceTenantMutationResult,
  type CommerceTenantMutationStatus,
} from "@openarc/shared";
import { TenantStoreError, type UpdateAgentPatch, type UpdateProviderPatch } from "@openarc/db";
import type { ZodType } from "zod";

import { AUTH_ERRORS, AuthApiError } from "../auth/errors.js";
import type { AuthRequestContext } from "../auth/service.js";
import type {
  TenantWriteAuthPort,
  TenantWriteMutationMetadata,
  TenantWriteStorePort,
} from "./write-ports.js";

/**
 * Write orchestration for the protected tenant family.
 *
 * Ordering contract for every business mutation: strict input validation, then
 * the exact accepted CSRF check, then `beginTenantRead` (rate limit + live
 * internal account/session hash). No mutation method is invoked unless both the
 * CSRF and the begin authorization succeed. Exactly one accepted concrete
 * `*Durably` repository method is called per business mutation.
 *
 * A business mutation deliberately performs NO post-commit live-session check.
 * The authoritative SQL may commit a self-demotion/suspension that revokes
 * THIS request's session within the same transaction; re-reading the session
 * after commit would misreport a committed, authorized action as failed. The
 * committed receipt is therefore returned as-is with no cookie or session
 * rotation. The status GET keeps the read family's begin + repository + finish
 * ordering.
 *
 * Unknown COMMIT outcome: `TENANT_STORE_OUTCOME_UNKNOWN` means the transaction
 * may have committed but the reply was lost. It maps to a non-echoing 503 with
 * `retryable:false`; there is no automatic repository retry, status poll or
 * rollback. A missing/failed definitive response is a client-unknown outcome;
 * callers recover by re-reading status with the same logical mutation id. No
 * new error taxonomy is introduced by this module.
 */

const OPERATION_BY_KIND = {
  organizationCreate: "tenant.organization.create",
  agentCreate: "tenant.agent.create",
  agentUpdate: "tenant.agent.update",
  providerCreate: "tenant.provider.create",
  providerUpdate: "tenant.provider.update",
  membershipSet: "tenant.membership.set",
} as const;

interface WriteRequestEnvelope {
  readonly ctx: AuthRequestContext;
  readonly csrf: unknown;
  readonly idempotencyKey: unknown;
  readonly body: unknown;
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

/** Response projection/validation failures are a server bug, not an outage. */
function projectionFailure(): AuthApiError {
  return AUTH_ERRORS.internal();
}

function mapStoreError(error: unknown): never {
  if (error instanceof AuthApiError) throw error;
  if (error instanceof TenantStoreError) {
    switch (error.code) {
      case "TENANT_STORE_INPUT_INVALID":
        throw invalidInput();
      case "TENANT_STORE_SESSION_INVALID":
        throw unauthenticated();
      case "TENANT_STORE_FORBIDDEN":
      case "TENANT_STORE_NOT_FOUND":
        // A cross-actor or unknown target is the same fixed denial: no
        // organization-existence oracle is exposed by the transport.
        throw forbidden();
      case "TENANT_STORE_CONFLICT":
        throw policyDenied();
      case "TENANT_STORE_IDEMPOTENCY_CONFLICT":
        throw idempotencyConflict();
      case "TENANT_STORE_UNAVAILABLE":
      case "TENANT_STORE_OUTCOME_UNKNOWN":
      default:
        throw unavailable();
    }
  }
  throw unavailable();
}

function parseRequest<T>(schema: ZodType<T>, input: unknown): T {
  const parsed = schema.safeParse(input);
  if (!parsed.success) throw invalidInput();
  return parsed.data;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function organizationIdForBootstrap(mutationId: string): string {
  return `openarc:org:${mutationId}`;
}

export class TenantWriteService {
  readonly #auth: TenantWriteAuthPort;
  readonly #store: TenantWriteStorePort;

  constructor(options: { auth: TenantWriteAuthPort; store: TenantWriteStorePort }) {
    this.#auth = options.auth;
    this.#store = options.store;
  }

  async createOrganization(
    request: WriteRequestEnvelope,
  ): Promise<CommerceTenantMutationResult> {
    const body = parseRequest(CommerceOrganizationCreateBodySchema, request.body);
    const authorized = await this.#authorize(
      request,
      body.mutationId,
    );
    const raw = await this.#invoke(() =>
      this.#store.createOrganizationDurably(
        authorized.sessionHash,
        body.displayName,
        authorized.metadata,
      ),
    );
    return this.#projectResult({
      raw,
      invokedOperation: OPERATION_BY_KIND.organizationCreate,
      requestMutationId: body.mutationId,
      organizationId: organizationIdForBootstrap(body.mutationId),
      targetResourceId: null,
    });
  }

  async createAgent(
    organizationId: unknown,
    request: WriteRequestEnvelope,
  ): Promise<CommerceTenantMutationResult> {
    const organization = parseRequest(CommerceOrganizationIdSchema, organizationId);
    const body = parseRequest(CommerceAgentCreateBodySchema, request.body);
    const authorized = await this.#authorize(request, body.mutationId);
    const raw = await this.#invoke(() =>
      this.#store.createAgentDurably(
        authorized.sessionHash,
        organization,
        body.displayName,
        authorized.metadata,
      ),
    );
    return this.#projectResult({
      raw,
      invokedOperation: OPERATION_BY_KIND.agentCreate,
      requestMutationId: body.mutationId,
      organizationId: organization,
      targetResourceId: null,
    });
  }

  async updateAgent(
    organizationId: unknown,
    agentId: unknown,
    request: WriteRequestEnvelope,
  ): Promise<CommerceTenantMutationResult> {
    const organization = parseRequest(CommerceOrganizationIdSchema, organizationId);
    const agent = parseRequest(CommerceAgentIdSchema, agentId);
    const body = parseRequest(CommerceAgentUpdateBodySchema, request.body);
    const patch: UpdateAgentPatch = {
      ...(body.patch.displayName !== undefined
        ? { displayName: body.patch.displayName }
        : {}),
      ...(body.patch.status !== undefined ? { status: body.patch.status } : {}),
    };
    const authorized = await this.#authorize(request, body.mutationId);
    const raw = await this.#invoke(() =>
      this.#store.updateAgentDurably(
        authorized.sessionHash,
        organization,
        agent,
        patch,
        authorized.metadata,
      ),
    );
    return this.#projectResult({
      raw,
      invokedOperation: OPERATION_BY_KIND.agentUpdate,
      requestMutationId: body.mutationId,
      organizationId: organization,
      targetResourceId: agent,
    });
  }

  async createProvider(
    organizationId: unknown,
    request: WriteRequestEnvelope,
  ): Promise<CommerceTenantMutationResult> {
    const organization = parseRequest(CommerceOrganizationIdSchema, organizationId);
    const body = parseRequest(CommerceProviderCreateBodySchema, request.body);
    const authorized = await this.#authorize(request, body.mutationId);
    const raw = await this.#invoke(() =>
      this.#store.createProviderDurably(
        authorized.sessionHash,
        organization,
        body.displayName,
        authorized.metadata,
      ),
    );
    return this.#projectResult({
      raw,
      invokedOperation: OPERATION_BY_KIND.providerCreate,
      requestMutationId: body.mutationId,
      organizationId: organization,
      targetResourceId: null,
    });
  }

  async updateProvider(
    organizationId: unknown,
    providerId: unknown,
    request: WriteRequestEnvelope,
  ): Promise<CommerceTenantMutationResult> {
    const organization = parseRequest(CommerceOrganizationIdSchema, organizationId);
    const provider = parseRequest(CommerceProviderIdSchema, providerId);
    const body = parseRequest(CommerceProviderUpdateBodySchema, request.body);
    const patch: UpdateProviderPatch = {
      ...(body.patch.displayName !== undefined
        ? { displayName: body.patch.displayName }
        : {}),
      ...(body.patch.status !== undefined ? { status: body.patch.status } : {}),
    };
    const authorized = await this.#authorize(request, body.mutationId);
    const raw = await this.#invoke(() =>
      this.#store.updateProviderDurably(
        authorized.sessionHash,
        organization,
        provider,
        patch,
        authorized.metadata,
      ),
    );
    return this.#projectResult({
      raw,
      invokedOperation: OPERATION_BY_KIND.providerUpdate,
      requestMutationId: body.mutationId,
      organizationId: organization,
      targetResourceId: provider,
    });
  }

  async setMembership(
    organizationId: unknown,
    targetAccountId: unknown,
    request: WriteRequestEnvelope,
  ): Promise<CommerceTenantMutationResult> {
    const organization = parseRequest(CommerceOrganizationIdSchema, organizationId);
    const account = parseRequest(CommerceAccountIdSchema, targetAccountId);
    const body = parseRequest(CommerceMembershipSetBodySchema, request.body);
    const authorized = await this.#authorize(request, body.mutationId);
    const raw = await this.#invoke(() =>
      this.#store.setMembershipDurably(
        authorized.sessionHash,
        organization,
        account,
        body.role,
        body.membershipStatus,
        authorized.metadata,
      ),
    );
    return this.#projectResult({
      raw,
      invokedOperation: OPERATION_BY_KIND.membershipSet,
      requestMutationId: body.mutationId,
      organizationId: organization,
      targetResourceId: account,
    });
  }

  /** Scoped mutation status. Reads keep begin + repository + finish ordering. */
  async getTenantMutationStatus(
    organizationId: unknown,
    mutationId: unknown,
    ctx: AuthRequestContext,
  ): Promise<CommerceTenantMutationStatus> {
    const organization = parseRequest(CommerceOrganizationIdSchema, organizationId);
    const mutation = parseRequest(CommerceTenantMutationIdSchema, mutationId);
    const begun = await this.#auth.beginTenantRead(ctx);
    let raw: unknown;
    try {
      raw = await this.#store.getTenantMutationStatus(
        begun.sessionHash,
        organization,
        mutation,
      );
    } catch (error) {
      mapStoreError(error);
    }
    await this.#auth.finishTenantRead(ctx, begun);
    return this.#projectStatus(raw, organization, mutation);
  }

  /**
   * Bootstrap status. The organization id is derived ONLY from the logical
   * mutation id and must match a committed organization receipt.
   */
  async getOrganizationMutationStatus(
    mutationId: unknown,
    ctx: AuthRequestContext,
  ): Promise<CommerceTenantMutationStatus> {
    const mutation = parseRequest(CommerceTenantMutationIdSchema, mutationId);
    const derived = organizationIdForBootstrap(mutation);
    const begun = await this.#auth.beginTenantRead(ctx);
    let raw: unknown;
    try {
      raw = await this.#store.getOrganizationMutationStatus(begun.sessionHash, mutation);
    } catch (error) {
      mapStoreError(error);
    }
    await this.#auth.finishTenantRead(ctx, begun);
    return this.#projectStatus(raw, derived, mutation, true);
  }

  async #authorize(
    request: WriteRequestEnvelope,
    mutationId: string,
  ): Promise<{ sessionHash: string; metadata: TenantWriteMutationMetadata }> {
    const idempotencyKey = parseRequest(
      CommerceTenantIdempotencyKeySchema,
      request.idempotencyKey,
    );
    // Input validation finished; now the exact accepted CSRF check, then the
    // live-session begin. No mutation happens without both.
    this.#auth.verifyCsrf(request.ctx.cookies, request.csrf);
    const begun = await this.#auth.beginTenantRead(request.ctx);
    return {
      sessionHash: begun.sessionHash,
      metadata: { idempotencyKey, mutationId },
    };
  }

  async #invoke(work: () => Promise<unknown>): Promise<unknown> {
    try {
      return await work();
    } catch (error) {
      mapStoreError(error);
    }
  }

  /**
   * Validate the RAW repository result against the accepted strict receipt /
   * result contracts: the operation must equal the invoked method, the
   * mutation id must equal the request, and for PATCH/PUT the resource id must
   * equal the path target. Bootstrap organization ids derive only from the
   * logical mutation id.
   */
  #projectResult(input: {
    raw: unknown;
    invokedOperation: (typeof OPERATION_BY_KIND)[keyof typeof OPERATION_BY_KIND];
    requestMutationId: string;
    organizationId: string;
    targetResourceId: string | null;
  }): CommerceTenantMutationResult {
    if (!isRecord(input.raw)) throw projectionFailure();
    const receiptRaw = input.raw["receipt"];
    const receipt = CommerceTenantMutationReceiptSchema.safeParse(receiptRaw);
    if (!receipt.success) throw projectionFailure();
    if (receipt.data.operation !== input.invokedOperation) throw projectionFailure();
    if (receipt.data.mutationId !== input.requestMutationId) {
      throw projectionFailure();
    }
    if (
      input.targetResourceId !== null &&
      receipt.data.resourceId !== input.targetResourceId
    ) {
      throw projectionFailure();
    }
    if (input.raw["replayed"] !== true && input.raw["replayed"] !== false) {
      throw projectionFailure();
    }
    const result = CommerceTenantMutationResultSchema.safeParse({
      organizationId: input.organizationId,
      replayed: input.raw["replayed"],
      receipt: receipt.data,
    });
    if (!result.success) throw projectionFailure();
    return result.data;
  }

  #projectStatus(
    raw: unknown,
    organizationId: string,
    mutationId: string,
    requireOrganizationReceipt = false,
  ): CommerceTenantMutationStatus {
    if (!isRecord(raw)) throw projectionFailure();
    if (raw["status"] === "not_found") {
      const status = CommerceTenantMutationStatusSchema.safeParse({
        status: "not_found",
        organizationId,
      });
      if (!status.success) throw projectionFailure();
      return status.data;
    }
    if (raw["status"] !== "committed") throw projectionFailure();
    const receipt = CommerceTenantMutationReceiptSchema.safeParse(raw["receipt"]);
    if (!receipt.success) throw projectionFailure();
    if (receipt.data.mutationId !== mutationId) throw projectionFailure();
    if (
      requireOrganizationReceipt &&
      (receipt.data.operation !== OPERATION_BY_KIND.organizationCreate ||
        receipt.data.resourceId !== organizationId)
    ) {
      throw projectionFailure();
    }
    const status = CommerceTenantMutationStatusSchema.safeParse({
      status: "committed",
      organizationId,
      receipt: receipt.data,
    });
    if (!status.success) throw projectionFailure();
    return status.data;
  }
}
