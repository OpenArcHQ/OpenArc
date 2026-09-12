import { z } from "zod";

import { createCommerceSuccessEnvelopeSchema } from "./api.js";

/**
 * Strict, bounded, browser-safe commerce capability manifest and fixed
 * principal-route registry.
 *
 * This module publishes a pure data contract: a frozen five-family capability
 * manifest and a fixed 41-entry principal-route inventory. It contains no
 * route handlers, no transport, no authorization, no request dispatch, no
 * database/network access and no runtime registration or reflection.
 *
 * `capabilityVersion` is the new public v2 contract. The legacy
 * `openarc.capabilities.m04.v1`..`m07.v1` schemas in `../api.ts` are
 * deliberately untouched and remain the sole decoders for
 * `/v1/private/capabilities`.
 */

export const COMMERCE_CAPABILITIES_PATH = "/v2/public/capabilities" as const;

export const COMMERCE_CAPABILITY_VERSION =
  "openarc.capabilities.commerce.v1" as const;

export const COMMERCE_CAPABILITY_ENVIRONMENT = "testnet" as const;

export const COMMERCE_CAPABILITY_NETWORK = "eip155:5042002" as const;

/** Closed family inventory. No marketplace/payment/budget/settlement family. */
export const CommerceCapabilityFamilySchema = z.enum([
  "human_accounts",
  "tenant_reads",
  "tenant_writes",
  "machine_credentials",
  "machine_sessions",
]);

export type CommerceCapabilityFamily = z.infer<
  typeof CommerceCapabilityFamilySchema
>;

export const CommerceCapabilityAudienceSchema = z.enum(["browser", "machine"]);

export type CommerceCapabilityAudience = z.infer<
  typeof CommerceCapabilityAudienceSchema
>;

/**
 * State enum. `planned` is reserved for a future versioned contract: no
 * currently implemented family may ever report it (enforced by the manifest
 * builder and its schema refinement below).
 */
export const CommerceCapabilityStateSchema = z.enum([
  "enabled",
  "built_disabled",
  "unavailable",
  "planned",
]);

export type CommerceCapabilityState = z.infer<
  typeof CommerceCapabilityStateSchema
>;

export const CommerceCapabilityDependencySchema = z.enum([
  "auth",
  "tenantDatabase",
  "machineDatabase",
]);

export type CommerceCapabilityDependency = z.infer<
  typeof CommerceCapabilityDependencySchema
>;

/** Exact frozen audience per family; sessions is the only machine family. */
export const COMMERCE_CAPABILITY_AUDIENCE: Readonly<
  Record<CommerceCapabilityFamily, CommerceCapabilityAudience>
> = Object.freeze({
  human_accounts: "browser",
  tenant_reads: "browser",
  tenant_writes: "browser",
  machine_credentials: "browser",
  machine_sessions: "machine",
});

/** Exact closed dependency arrays, in the frozen order. */
export const COMMERCE_CAPABILITY_DEPENDENCIES: Readonly<
  Record<CommerceCapabilityFamily, readonly CommerceCapabilityDependency[]>
> = Object.freeze({
  human_accounts: Object.freeze(["auth"] as const),
  tenant_reads: Object.freeze(["auth", "tenantDatabase"] as const),
  tenant_writes: Object.freeze(["auth", "tenantDatabase"] as const),
  machine_credentials: Object.freeze([
    "auth",
    "tenantDatabase",
    "machineDatabase",
  ] as const),
  machine_sessions: Object.freeze([
    "auth",
    "tenantDatabase",
    "machineDatabase",
  ] as const),
});

/** Fixed deterministic family order for the manifest array. */
export const COMMERCE_CAPABILITY_FAMILY_ORDER: readonly CommerceCapabilityFamily[] =
  Object.freeze([
    "human_accounts",
    "tenant_reads",
    "tenant_writes",
    "machine_credentials",
    "machine_sessions",
  ] as const);

const DependenciesSchema = z
  .array(CommerceCapabilityDependencySchema)
  .min(1)
  .max(3);

export const CommerceCapabilityEntrySchema = z
  .strictObject({
    family: CommerceCapabilityFamilySchema,
    audience: CommerceCapabilityAudienceSchema,
    state: CommerceCapabilityStateSchema,
    dependencies: DependenciesSchema,
  })
  .superRefine((value, ctx) => {
    if (value.audience !== COMMERCE_CAPABILITY_AUDIENCE[value.family]) {
      ctx.addIssue({
        code: "custom",
        path: ["audience"],
        message: "Audience does not match the frozen family descriptor.",
      });
    }
    const expected = COMMERCE_CAPABILITY_DEPENDENCIES[value.family];
    if (
      value.dependencies.length !== expected.length ||
      value.dependencies.some((dependency, index) => dependency !== expected[index])
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["dependencies"],
        message: "Dependencies do not match the frozen family descriptor.",
      });
    }
  });

export type CommerceCapabilityEntry = z.infer<
  typeof CommerceCapabilityEntrySchema
>;

/**
 * One frozen route descriptor. `id` is a fixed lowercase snake_case token,
 * `path` is an exact static or `:parameter` template from the real API route
 * constants, and `method` is the one supported business verb.
 */
export const CommerceRouteDescriptorSchema = z
  .strictObject({
    id: z.string().regex(/^[a-z][a-z0-9_]*$/u),
    family: CommerceCapabilityFamilySchema,
    audience: CommerceCapabilityAudienceSchema,
    method: z.enum(["GET", "POST", "PATCH", "PUT"]),
    path: z.string().min(1).max(512),
  })
  .superRefine((value, ctx) => {
    if (value.audience !== COMMERCE_CAPABILITY_AUDIENCE[value.family]) {
      ctx.addIssue({
        code: "custom",
        path: ["audience"],
        message: "Route audience does not match the frozen family descriptor.",
      });
    }
    const expected = COMMERCE_ROUTE_INDEX[value.id];
    if (expected === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["id"],
        message: "Route id is not part of the frozen registry.",
      });
      return;
    }
    if (
      value.family !== expected.family ||
      value.audience !== expected.audience ||
      value.method !== expected.method ||
      value.path !== expected.path
    ) {
      ctx.addIssue({
        code: "custom",
        message:
          "Route descriptor does not match the frozen id/family/audience/method/path entry.",
      });
    }
  });

export type CommerceRouteDescriptor = z.infer<
  typeof CommerceRouteDescriptorSchema
>;

interface FrozenRoute {
  readonly id: string;
  readonly family: CommerceCapabilityFamily;
  readonly audience: CommerceCapabilityAudience;
  readonly method: "GET" | "POST" | "PATCH" | "PUT";
  readonly path: string;
}

const AUTH_BASE = "/v2/auth";
const TENANT_BASE = "/v1/operator/organizations";

/**
 * The frozen principal-route inventory.
 *
 * Paths mirror the real route constants exactly (including `:parameter`
 * templates); unsupported-method fallback registrations, the new public
 * manifest/health endpoints and the legacy `/v1/private/capabilities` route are
 * intentionally absent. There are 15 auth + 4 tenant reads + 8 tenant writes +
 * 8 machine-credential-management + 6 machine-session = 41 entries.
 */
export const COMMERCE_ROUTES: readonly CommerceRouteDescriptor[] = Object.freeze(
  (
    [
      // human_accounts (15)
      { id: "human_accounts_bootstrap", family: "human_accounts", audience: "browser", method: "POST", path: `${AUTH_BASE}/bootstrap` },
      { id: "human_accounts_session", family: "human_accounts", audience: "browser", method: "GET", path: `${AUTH_BASE}/session` },
      { id: "human_accounts_passkey_register_options", family: "human_accounts", audience: "browser", method: "POST", path: `${AUTH_BASE}/passkeys/register/options` },
      { id: "human_accounts_passkey_register_verify", family: "human_accounts", audience: "browser", method: "POST", path: `${AUTH_BASE}/passkeys/register/verify` },
      { id: "human_accounts_passkey_login_options", family: "human_accounts", audience: "browser", method: "POST", path: `${AUTH_BASE}/passkeys/login/options` },
      { id: "human_accounts_passkey_login_verify", family: "human_accounts", audience: "browser", method: "POST", path: `${AUTH_BASE}/passkeys/login/verify` },
      { id: "human_accounts_passkey_add_options", family: "human_accounts", audience: "browser", method: "POST", path: `${AUTH_BASE}/passkeys/add/options` },
      { id: "human_accounts_passkey_add_verify", family: "human_accounts", audience: "browser", method: "POST", path: `${AUTH_BASE}/passkeys/add/verify` },
      { id: "human_accounts_wallet_login_options", family: "human_accounts", audience: "browser", method: "POST", path: `${AUTH_BASE}/wallets/login/options` },
      { id: "human_accounts_wallet_login_verify", family: "human_accounts", audience: "browser", method: "POST", path: `${AUTH_BASE}/wallets/login/verify` },
      { id: "human_accounts_wallet_link_options", family: "human_accounts", audience: "browser", method: "POST", path: `${AUTH_BASE}/wallets/link/options` },
      { id: "human_accounts_wallet_link_verify", family: "human_accounts", audience: "browser", method: "POST", path: `${AUTH_BASE}/wallets/link/verify` },
      { id: "human_accounts_recovery_codes", family: "human_accounts", audience: "browser", method: "POST", path: `${AUTH_BASE}/recovery/codes` },
      { id: "human_accounts_recovery_redeem", family: "human_accounts", audience: "browser", method: "POST", path: `${AUTH_BASE}/recovery/redeem` },
      { id: "human_accounts_logout", family: "human_accounts", audience: "browser", method: "POST", path: `${AUTH_BASE}/logout` },
      // tenant_reads (4)
      { id: "tenant_reads_organizations", family: "tenant_reads", audience: "browser", method: "GET", path: TENANT_BASE },
      { id: "tenant_reads_organization", family: "tenant_reads", audience: "browser", method: "GET", path: `${TENANT_BASE}/:organizationId` },
      { id: "tenant_reads_agents", family: "tenant_reads", audience: "browser", method: "GET", path: `${TENANT_BASE}/:organizationId/agents` },
      { id: "tenant_reads_providers", family: "tenant_reads", audience: "browser", method: "GET", path: `${TENANT_BASE}/:organizationId/providers` },
      // tenant_writes (8)
      { id: "tenant_writes_organization_create", family: "tenant_writes", audience: "browser", method: "POST", path: TENANT_BASE },
      { id: "tenant_writes_agent_create", family: "tenant_writes", audience: "browser", method: "POST", path: `${TENANT_BASE}/:organizationId/agents` },
      { id: "tenant_writes_agent_update", family: "tenant_writes", audience: "browser", method: "PATCH", path: `${TENANT_BASE}/:organizationId/agents/:agentId` },
      { id: "tenant_writes_provider_create", family: "tenant_writes", audience: "browser", method: "POST", path: `${TENANT_BASE}/:organizationId/providers` },
      { id: "tenant_writes_provider_update", family: "tenant_writes", audience: "browser", method: "PATCH", path: `${TENANT_BASE}/:organizationId/providers/:providerId` },
      { id: "tenant_writes_membership_set", family: "tenant_writes", audience: "browser", method: "PUT", path: `${TENANT_BASE}/:organizationId/memberships/:accountId` },
      { id: "tenant_writes_mutation_status", family: "tenant_writes", audience: "browser", method: "GET", path: `${TENANT_BASE}/:organizationId/mutations/:mutationId` },
      { id: "tenant_writes_bootstrap_mutation_status", family: "tenant_writes", audience: "browser", method: "GET", path: `${TENANT_BASE}/bootstrap-mutations/:mutationId` },
      // machine_credentials (8)
      { id: "machine_credentials_agent_list", family: "machine_credentials", audience: "browser", method: "GET", path: `${TENANT_BASE}/:organizationId/agents/:agentId/credentials` },
      { id: "machine_credentials_agent_issue", family: "machine_credentials", audience: "browser", method: "POST", path: `${TENANT_BASE}/:organizationId/agents/:agentId/credentials` },
      { id: "machine_credentials_provider_list", family: "machine_credentials", audience: "browser", method: "GET", path: `${TENANT_BASE}/:organizationId/providers/:providerId/credentials` },
      { id: "machine_credentials_provider_issue", family: "machine_credentials", audience: "browser", method: "POST", path: `${TENANT_BASE}/:organizationId/providers/:providerId/credentials` },
      { id: "machine_credentials_agent_revoke", family: "machine_credentials", audience: "browser", method: "POST", path: `${TENANT_BASE}/:organizationId/agent-credentials/:credentialId/revoke` },
      { id: "machine_credentials_provider_revoke", family: "machine_credentials", audience: "browser", method: "POST", path: `${TENANT_BASE}/:organizationId/provider-credentials/:credentialId/revoke` },
      { id: "machine_credentials_agent_mutation_status", family: "machine_credentials", audience: "browser", method: "GET", path: `${TENANT_BASE}/:organizationId/agent-credential-mutations/:mutationId` },
      { id: "machine_credentials_provider_mutation_status", family: "machine_credentials", audience: "browser", method: "GET", path: `${TENANT_BASE}/:organizationId/provider-credential-mutations/:mutationId` },
      // machine_sessions (6)
      { id: "machine_sessions_agent_exchange", family: "machine_sessions", audience: "machine", method: "POST", path: "/v1/agent/sessions" },
      { id: "machine_sessions_provider_exchange", family: "machine_sessions", audience: "machine", method: "POST", path: "/v1/provider/sessions" },
      { id: "machine_sessions_agent_self", family: "machine_sessions", audience: "machine", method: "GET", path: "/v1/agent/self" },
      { id: "machine_sessions_provider_self", family: "machine_sessions", audience: "machine", method: "GET", path: "/v1/provider/self" },
      { id: "machine_sessions_agent_revoke", family: "machine_sessions", audience: "machine", method: "POST", path: "/v1/agent/sessions/current/revoke" },
      { id: "machine_sessions_provider_revoke", family: "machine_sessions", audience: "machine", method: "POST", path: "/v1/provider/sessions/current/revoke" },
    ] satisfies readonly FrozenRoute[]
  ).map((route) => Object.freeze(route)),
);

/** Exact-id index used by the strict lookup refinement (not a mutable map). */
export const COMMERCE_ROUTE_INDEX: Readonly<
  Record<string, FrozenRoute>
> = Object.freeze(
  COMMERCE_ROUTES.reduce<Record<string, FrozenRoute>>((accumulator, route) => {
    accumulator[route.id] = route;
    return accumulator;
  }, {}),
);

export const COMMERCE_ROUTE_IDS: readonly string[] = Object.freeze(
  COMMERCE_ROUTES.map((route) => route.id),
);

export const CommerceCapabilityManifestSchema = z
  .strictObject({
    capabilityVersion: z.literal(COMMERCE_CAPABILITY_VERSION),
    environment: z.literal(COMMERCE_CAPABILITY_ENVIRONMENT),
    network: z.literal(COMMERCE_CAPABILITY_NETWORK),
    capabilities: z.array(CommerceCapabilityEntrySchema).length(5),
    routes: z.array(CommerceRouteDescriptorSchema).length(41),
  })
  .superRefine((value, ctx) => {
    // Exact family inventory: each frozen family once, no extra/omitted.
    const seen = new Set<CommerceCapabilityFamily>();
    for (const [index, entry] of value.capabilities.entries()) {
      if (seen.has(entry.family)) {
        ctx.addIssue({
          code: "custom",
          path: ["capabilities", index, "family"],
          message: "Family may appear only once.",
        });
      }
      seen.add(entry.family);
      if (entry.state === "planned") {
        ctx.addIssue({
          code: "custom",
          path: ["capabilities", index, "state"],
          message: "Implemented families cannot report planned.",
        });
      }
    }
    for (const family of COMMERCE_CAPABILITY_FAMILY_ORDER) {
      if (!seen.has(family)) {
        ctx.addIssue({
          code: "custom",
          path: ["capabilities"],
          message: `Missing family ${family}.`,
        });
      }
    }
    // Exact route inventory: each frozen id once, no extra/omitted.
    const routeSeen = new Set<string>();
    for (const [index, route] of value.routes.entries()) {
      if (routeSeen.has(route.id)) {
        ctx.addIssue({
          code: "custom",
          path: ["routes", index, "id"],
          message: "Route id may appear only once.",
        });
      }
      routeSeen.add(route.id);
    }
    for (const id of COMMERCE_ROUTE_IDS) {
      if (!routeSeen.has(id)) {
        ctx.addIssue({
          code: "custom",
          path: ["routes"],
          message: `Missing route ${id}.`,
        });
      }
    }
  });

export type CommerceCapabilityManifest = z.infer<
  typeof CommerceCapabilityManifestSchema
>;

export const CommerceCapabilitiesSuccessEnvelopeSchema =
  createCommerceSuccessEnvelopeSchema(CommerceCapabilityManifestSchema);

export type CommerceCapabilitiesSuccessEnvelope = z.infer<
  typeof CommerceCapabilitiesSuccessEnvelopeSchema
>;

/**
 * Explicit builder inputs. Every field is a closed boolean flag; there is no
 * process.env, network, DB or arbitrary record access, and no raw config
 * spread. Unknown/extra/non-boolean input fails closed through the schema.
 */
export const CommerceCapabilityBuilderInputSchema = z.strictObject({
  auth: z.boolean(),
  tenantReads: z.boolean(),
  tenantWrites: z.boolean(),
  machineCredentials: z.boolean(),
  machineSessions: z.boolean(),
  authReady: z.boolean(),
  tenantDatabaseReady: z.boolean(),
  machineDatabaseReady: z.boolean(),
});

export type CommerceCapabilityBuilderInput = z.infer<
  typeof CommerceCapabilityBuilderInputSchema
>;

/** Parent feature chain per family (sessions ignores write/credentials). */
const FAMILY_FLAGS: Readonly<
  Record<
    CommerceCapabilityFamily,
    readonly (keyof CommerceCapabilityBuilderInput)[]
  >
> = Object.freeze({
  human_accounts: Object.freeze(["auth"] as const),
  tenant_reads: Object.freeze(["auth", "tenantReads"] as const),
  tenant_writes: Object.freeze([
    "auth",
    "tenantReads",
    "tenantWrites",
  ] as const),
  machine_credentials: Object.freeze([
    "auth",
    "tenantReads",
    "tenantWrites",
    "machineCredentials",
  ] as const),
  machine_sessions: Object.freeze([
    "auth",
    "tenantReads",
    "machineSessions",
  ] as const),
});

/** Runtime readiness each dependency requires. */
const DEPENDENCY_READY: Readonly<
  Record<CommerceCapabilityDependency, keyof CommerceCapabilityBuilderInput>
> = Object.freeze({
  auth: "authReady",
  tenantDatabase: "tenantDatabaseReady",
  machineDatabase: "machineDatabaseReady",
});

function familyState(
  family: CommerceCapabilityFamily,
  input: CommerceCapabilityBuilderInput,
): CommerceCapabilityState {
  // A disabled own flag is built_disabled even when dependencies are down.
  const ownFlag = FAMILY_FLAGS[family][FAMILY_FLAGS[family].length - 1] as
    | "auth"
    | "tenantReads"
    | "tenantWrites"
    | "machineCredentials"
    | "machineSessions";
  if (input[ownFlag] !== true) return "built_disabled";
  const parentsSatisfied = FAMILY_FLAGS[family].every(
    (flag) => input[flag] === true,
  );
  const runtimeSatisfied = COMMERCE_CAPABILITY_DEPENDENCIES[family].every(
    (dependency) => input[DEPENDENCY_READY[dependency]] === true,
  );
  return parentsSatisfied && runtimeSatisfied ? "enabled" : "unavailable";
}

function buildCapabilityEntry(
  family: CommerceCapabilityFamily,
  input: CommerceCapabilityBuilderInput,
): CommerceCapabilityEntry {
  return Object.freeze({
    family,
    audience: COMMERCE_CAPABILITY_AUDIENCE[family],
    state: familyState(family, input),
    // Fresh mutable copy keeps the parsed manifest type assignable while the
    // exported dependency truth above stays deeply frozen.
    dependencies: [...COMMERCE_CAPABILITY_DEPENDENCIES[family]],
  });
}

/**
 * Pure availability builder. Returns the full fixed manifest; callers cannot
 * receive a partially populated or caller-extended object. Input is validated
 * at runtime so unknown/extra/non-boolean values fail closed rather than
 * relying on TypeScript alone.
 */
export function buildCommerceCapabilityManifest(
  input: CommerceCapabilityBuilderInput,
): CommerceCapabilityManifest {
  const flags = CommerceCapabilityBuilderInputSchema.parse(input);
  const capabilities = COMMERCE_CAPABILITY_FAMILY_ORDER.map((family) =>
    buildCapabilityEntry(family, flags),
  );
  return CommerceCapabilityManifestSchema.parse({
    capabilityVersion: COMMERCE_CAPABILITY_VERSION,
    environment: COMMERCE_CAPABILITY_ENVIRONMENT,
    network: COMMERCE_CAPABILITY_NETWORK,
    capabilities,
    routes: COMMERCE_ROUTES,
  });
}

/** Convenience literal for the all-off builder baseline (tests/callers). */
export const COMMERCE_CAPABILITY_ALL_OFF: CommerceCapabilityBuilderInput =
  Object.freeze({
    auth: false,
    tenantReads: false,
    tenantWrites: false,
    machineCredentials: false,
    machineSessions: false,
    authReady: false,
    tenantDatabaseReady: false,
    machineDatabaseReady: false,
  });
