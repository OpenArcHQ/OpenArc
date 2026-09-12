import { z } from "zod";

import {
  COMMERCE_CAPABILITY_ENVIRONMENT,
  COMMERCE_CAPABILITY_NETWORK,
} from "./capabilities.js";
import { createCommerceSuccessEnvelopeSchema } from "./api.js";

/**
 * Strict, bounded, browser-safe marketplace capability manifest and fixed
 * 18-entry marketplace-route registry.
 *
 * This module publishes a pure data contract only: a frozen three-family
 * capability manifest and the exact 18 marketplace route descriptors. It
 * contains no route handlers, no transport, no authorization, no request
 * dispatch, no database/network access and no runtime registration or
 * reflection. It does not import or mutate the legacy commerce capability
 * registry (5 families / 41 routes); its constants are separate.
 *
 * The contract is frozen for the current marketplace release. Availability in
 * this manifest does NOT grant a role, expose a live API route, or claim
 * mainnet support.
 */

export const MARKETPLACE_CAPABILITIES_PATH =
  "/v2/public/marketplace-capabilities" as const;

export const MARKETPLACE_CAPABILITY_VERSION =
  "openarc.capabilities.marketplace.v1" as const;

/** Closed family inventory, in the exact frozen publication order. */
export const MarketplaceCapabilityFamilySchema = z.enum([
  "public_catalog",
  "listing_management",
  "moderation",
]);

export type MarketplaceCapabilityFamily = z.infer<
  typeof MarketplaceCapabilityFamilySchema
>;

/** Marketplace audiences: public catalog is public, everything else browser. */
export const MarketplaceCapabilityAudienceSchema = z.enum([
  "public",
  "browser",
]);

export type MarketplaceCapabilityAudience = z.infer<
  typeof MarketplaceCapabilityAudienceSchema
>;

/** State enum. `planned` is deliberately absent from this frozen contract. */
export const MarketplaceCapabilityStateSchema = z.enum([
  "enabled",
  "built_disabled",
  "unavailable",
]);

export type MarketplaceCapabilityState = z.infer<
  typeof MarketplaceCapabilityStateSchema
>;

export const MarketplaceCapabilityDependencySchema = z.enum([
  "auth",
  "tenantDatabase",
  "marketDatabase",
]);

export type MarketplaceCapabilityDependency = z.infer<
  typeof MarketplaceCapabilityDependencySchema
>;

/** Exact frozen audience per family. */
export const MARKETPLACE_CAPABILITY_AUDIENCE: Readonly<
  Record<MarketplaceCapabilityFamily, MarketplaceCapabilityAudience>
> = Object.freeze({
  public_catalog: "public",
  listing_management: "browser",
  moderation: "browser",
});

/** Exact closed dependency arrays, in the frozen order. */
export const MARKETPLACE_CAPABILITY_DEPENDENCIES: Readonly<
  Record<MarketplaceCapabilityFamily, readonly MarketplaceCapabilityDependency[]>
> = Object.freeze({
  public_catalog: Object.freeze(["marketDatabase"] as const),
  listing_management: Object.freeze([
    "auth",
    "tenantDatabase",
    "marketDatabase",
  ] as const),
  moderation: Object.freeze(["auth", "marketDatabase"] as const),
});

/** Fixed deterministic family order for the manifest array. */
export const MARKETPLACE_CAPABILITY_FAMILY_ORDER: readonly MarketplaceCapabilityFamily[] =
  Object.freeze([
    "public_catalog",
    "listing_management",
    "moderation",
  ] as const);

const MarketplaceDependenciesSchema = z
  .array(MarketplaceCapabilityDependencySchema)
  .min(1)
  .max(3);

export const MarketplaceCapabilityEntrySchema = z
  .strictObject({
    family: MarketplaceCapabilityFamilySchema,
    audience: MarketplaceCapabilityAudienceSchema,
    state: MarketplaceCapabilityStateSchema,
    dependencies: MarketplaceDependenciesSchema,
  })
  .superRefine((value, ctx) => {
    if (value.audience !== MARKETPLACE_CAPABILITY_AUDIENCE[value.family]) {
      ctx.addIssue({
        code: "custom",
        path: ["audience"],
        message: "Audience does not match the frozen family descriptor.",
      });
    }
    const expected = MARKETPLACE_CAPABILITY_DEPENDENCIES[value.family];
    if (
      value.dependencies.length !== expected.length ||
      value.dependencies.some(
        (dependency, index) => dependency !== expected[index],
      )
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["dependencies"],
        message: "Dependencies do not match the frozen family descriptor.",
      });
    }
  });

export type MarketplaceCapabilityEntry = z.infer<
  typeof MarketplaceCapabilityEntrySchema
>;

/**
 * One frozen marketplace route descriptor. The entire tuple is validated
 * against the canonical registry below, not merely the `id` shape.
 */
export const MarketplaceRouteDescriptorSchema = z
  .strictObject({
    id: z.string().regex(/^[a-z][a-z0-9_]*$/u),
    family: MarketplaceCapabilityFamilySchema,
    audience: MarketplaceCapabilityAudienceSchema,
    method: z.enum(["GET", "POST"]),
    path: z.string().min(1).max(512),
  })
  .superRefine((value, ctx) => {
    if (value.audience !== MARKETPLACE_CAPABILITY_AUDIENCE[value.family]) {
      ctx.addIssue({
        code: "custom",
        path: ["audience"],
        message: "Route audience does not match the frozen family descriptor.",
      });
    }
    const expected = MARKETPLACE_ROUTE_INDEX[value.id];
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

export type MarketplaceRouteDescriptor = z.infer<
  typeof MarketplaceRouteDescriptorSchema
>;

interface FrozenMarketplaceRoute {
  readonly id: string;
  readonly family: MarketplaceCapabilityFamily;
  readonly audience: MarketplaceCapabilityAudience;
  readonly method: "GET" | "POST";
  readonly path: string;
}

const PUBLIC_BASE = "/v2/public/market";
const PROVIDER_BASE = "/v2/provider/organizations";
const MODERATOR_BASE = "/v2/moderator/organizations";

/**
 * The frozen marketplace-route inventory: 3 public catalog + 12 listing
 * management + 3 moderation = 18 entries. Paths use exact camelCase
 * `:parameter` templates. GET and POST are the only methods. No manifest,
 * health, fallback, checkout, session or payment descriptors exist here.
 */
export const MARKETPLACE_ROUTES: readonly MarketplaceRouteDescriptor[] =
  Object.freeze(
    (
      [
        // public_catalog (3, audience public)
        { id: "catalog_list", family: "public_catalog", audience: "public", method: "GET", path: `${PUBLIC_BASE}/listings` },
        { id: "catalog_detail", family: "public_catalog", audience: "public", method: "GET", path: `${PUBLIC_BASE}/listings/:listingId` },
        { id: "catalog_provider", family: "public_catalog", audience: "public", method: "GET", path: `${PUBLIC_BASE}/providers/:providerId` },
        // listing_management (12, audience browser)
        { id: "listing_roots", family: "listing_management", audience: "browser", method: "GET", path: `${PROVIDER_BASE}/:organizationId/listings` },
        { id: "listing_create", family: "listing_management", audience: "browser", method: "POST", path: `${PROVIDER_BASE}/:organizationId/listings` },
        { id: "listing_root", family: "listing_management", audience: "browser", method: "GET", path: `${PROVIDER_BASE}/:organizationId/listings/:listingId` },
        { id: "listing_versions", family: "listing_management", audience: "browser", method: "GET", path: `${PROVIDER_BASE}/:organizationId/listings/:listingId/versions` },
        { id: "listing_version_create", family: "listing_management", audience: "browser", method: "POST", path: `${PROVIDER_BASE}/:organizationId/listings/:listingId/versions` },
        { id: "listing_version", family: "listing_management", audience: "browser", method: "GET", path: `${PROVIDER_BASE}/:organizationId/listings/:listingId/versions/:version` },
        { id: "listing_draft_mutation_status", family: "listing_management", audience: "browser", method: "GET", path: `${PROVIDER_BASE}/:organizationId/listing-mutations/:mutationId` },
        { id: "listing_provider_options", family: "listing_management", audience: "browser", method: "GET", path: `${PROVIDER_BASE}/:organizationId/listing-providers` },
        { id: "listing_publish", family: "listing_management", audience: "browser", method: "POST", path: `${PROVIDER_BASE}/:organizationId/listings/:listingId/versions/:version/publish` },
        { id: "listing_pause", family: "listing_management", audience: "browser", method: "POST", path: `${PROVIDER_BASE}/:organizationId/listings/:listingId/versions/:version/pause` },
        { id: "listing_retire", family: "listing_management", audience: "browser", method: "POST", path: `${PROVIDER_BASE}/:organizationId/listings/:listingId/versions/:version/retire` },
        { id: "listing_lifecycle_mutation_status", family: "listing_management", audience: "browser", method: "GET", path: `${PROVIDER_BASE}/:organizationId/listing-lifecycle-mutations/:mutationId` },
        // moderation (3, audience browser)
        { id: "moderation_version", family: "moderation", audience: "browser", method: "GET", path: `${MODERATOR_BASE}/:organizationId/listings/:listingId/versions/:version` },
        { id: "moderation_origin_review", family: "moderation", audience: "browser", method: "POST", path: `${MODERATOR_BASE}/:organizationId/listings/:listingId/versions/:version/origin-review` },
        { id: "moderation_mutation_status", family: "moderation", audience: "browser", method: "GET", path: `${MODERATOR_BASE}/:organizationId/listing-lifecycle-mutations/:mutationId` },
      ] satisfies readonly FrozenMarketplaceRoute[]
    ).map((route) => Object.freeze(route)),
  );

/** Exact-id index used by the strict lookup refinement (not a mutable map). */
export const MARKETPLACE_ROUTE_INDEX: Readonly<
  Record<string, FrozenMarketplaceRoute>
> = Object.freeze(
  MARKETPLACE_ROUTES.reduce<Record<string, FrozenMarketplaceRoute>>(
    (accumulator, route) => {
      accumulator[route.id] = route;
      return accumulator;
    },
    {},
  ),
);

export const MARKETPLACE_ROUTE_IDS: readonly string[] = Object.freeze(
  MARKETPLACE_ROUTES.map((route) => route.id),
);

export const MarketplaceCapabilityManifestSchema = z
  .strictObject({
    capabilityVersion: z.literal(MARKETPLACE_CAPABILITY_VERSION),
    environment: z.literal(COMMERCE_CAPABILITY_ENVIRONMENT),
    network: z.literal(COMMERCE_CAPABILITY_NETWORK),
    capabilities: z.array(MarketplaceCapabilityEntrySchema).length(3),
    routes: z.array(MarketplaceRouteDescriptorSchema).length(18),
  })
  .superRefine((value, ctx) => {
    // Exact family inventory: each frozen family once, no extra/omitted.
    const seen = new Set<MarketplaceCapabilityFamily>();
    for (const [index, entry] of value.capabilities.entries()) {
      if (seen.has(entry.family)) {
        ctx.addIssue({
          code: "custom",
          path: ["capabilities", index, "family"],
          message: "Family may appear only once.",
        });
      }
      seen.add(entry.family);
    }
    for (const family of MARKETPLACE_CAPABILITY_FAMILY_ORDER) {
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
    for (const id of MARKETPLACE_ROUTE_IDS) {
      if (!routeSeen.has(id)) {
        ctx.addIssue({
          code: "custom",
          path: ["routes"],
          message: `Missing route ${id}.`,
        });
      }
    }
  });

export type MarketplaceCapabilityManifest = z.infer<
  typeof MarketplaceCapabilityManifestSchema
>;

export const MarketplaceCapabilitiesSuccessEnvelopeSchema =
  createCommerceSuccessEnvelopeSchema(MarketplaceCapabilityManifestSchema);

export type MarketplaceCapabilitiesSuccessEnvelope = z.infer<
  typeof MarketplaceCapabilitiesSuccessEnvelopeSchema
>;

/**
 * Explicit builder inputs. Every field is a closed boolean flag; there is no
 * process.env, network, DB or arbitrary record access, and no raw config
 * spread. Unknown/extra/non-boolean input fails closed through the schema.
 */
export const MarketplaceCapabilityBuilderInputSchema = z.strictObject({
  auth: z.boolean(),
  tenantReads: z.boolean(),
  marketCatalog: z.boolean(),
  listingManagement: z.boolean(),
  marketModeration: z.boolean(),
  authReady: z.boolean(),
  tenantDatabaseReady: z.boolean(),
  marketDatabaseReady: z.boolean(),
});

export type MarketplaceCapabilityBuilderInput = z.infer<
  typeof MarketplaceCapabilityBuilderInputSchema
>;

/** Own feature flag per family. False always yields built_disabled. */
const FAMILY_OWN_FLAG: Readonly<
  Record<MarketplaceCapabilityFamily, keyof MarketplaceCapabilityBuilderInput>
> = Object.freeze({
  public_catalog: "marketCatalog",
  listing_management: "listingManagement",
  moderation: "marketModeration",
});

/**
 * Additional flag prerequisites per family (own flag excluded here; it is
 * checked first). public_catalog has NO auth/tenantReads prerequisite;
 * moderation has NO tenantReads prerequisite. Tenant writes and machine
 * credentials never appear in this contract.
 */
const FAMILY_GATING_FLAGS: Readonly<
  Record<
    MarketplaceCapabilityFamily,
    readonly (keyof MarketplaceCapabilityBuilderInput)[]
  >
> = Object.freeze({
  public_catalog: Object.freeze([] as const),
  listing_management: Object.freeze(["auth", "tenantReads"] as const),
  moderation: Object.freeze(["auth"] as const),
});

/** Runtime readiness each dependency requires. */
const DEPENDENCY_READY: Readonly<
  Record<MarketplaceCapabilityDependency, keyof MarketplaceCapabilityBuilderInput>
> = Object.freeze({
  auth: "authReady",
  tenantDatabase: "tenantDatabaseReady",
  marketDatabase: "marketDatabaseReady",
});

function familyState(
  family: MarketplaceCapabilityFamily,
  input: MarketplaceCapabilityBuilderInput,
): MarketplaceCapabilityState {
  // A disabled own flag is built_disabled independent of dependencies.
  if (input[FAMILY_OWN_FLAG[family]] !== true) return "built_disabled";
  const flagsSatisfied = FAMILY_GATING_FLAGS[family].every(
    (flag) => input[flag] === true,
  );
  const runtimeSatisfied = MARKETPLACE_CAPABILITY_DEPENDENCIES[family].every(
    (dependency) => input[DEPENDENCY_READY[dependency]] === true,
  );
  return flagsSatisfied && runtimeSatisfied ? "enabled" : "unavailable";
}

function buildCapabilityEntry(
  family: MarketplaceCapabilityFamily,
  input: MarketplaceCapabilityBuilderInput,
): MarketplaceCapabilityEntry {
  return Object.freeze({
    family,
    audience: MARKETPLACE_CAPABILITY_AUDIENCE[family],
    state: familyState(family, input),
    // Fresh mutable copy keeps the parsed manifest type assignable while the
    // exported dependency truth above stays deeply frozen.
    dependencies: [...MARKETPLACE_CAPABILITY_DEPENDENCIES[family]],
  });
}

/**
 * Pure availability builder. Returns the full fixed manifest; callers cannot
 * receive a partially populated or caller-extended object. Input is validated
 * at runtime so unknown/extra/non-boolean values fail closed rather than
 * relying on TypeScript alone.
 */
export function buildMarketplaceCapabilityManifest(
  input: MarketplaceCapabilityBuilderInput,
): MarketplaceCapabilityManifest {
  const flags = MarketplaceCapabilityBuilderInputSchema.parse(input);
  const capabilities = MARKETPLACE_CAPABILITY_FAMILY_ORDER.map((family) =>
    buildCapabilityEntry(family, flags),
  );
  return MarketplaceCapabilityManifestSchema.parse({
    capabilityVersion: MARKETPLACE_CAPABILITY_VERSION,
    environment: COMMERCE_CAPABILITY_ENVIRONMENT,
    network: COMMERCE_CAPABILITY_NETWORK,
    capabilities,
    routes: MARKETPLACE_ROUTES,
  });
}

/** Convenience literal for the all-off builder baseline (tests/callers). */
export const MARKETPLACE_CAPABILITY_ALL_OFF: MarketplaceCapabilityBuilderInput =
  Object.freeze({
    auth: false,
    tenantReads: false,
    marketCatalog: false,
    listingManagement: false,
    marketModeration: false,
    authReady: false,
    tenantDatabaseReady: false,
    marketDatabaseReady: false,
  });
