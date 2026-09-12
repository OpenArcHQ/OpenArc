import { describe, expect, expectTypeOf, it } from "vitest";

import { COMMERCE_API_SCHEMA_VERSION, CommerceApiMetaSchema } from "../src/commerce/api.js";
import {
  COMMERCE_CAPABILITY_DEPENDENCIES,
  COMMERCE_CAPABILITY_FAMILY_ORDER,
  COMMERCE_ROUTES,
  CommerceCapabilitiesSuccessEnvelopeSchema,
} from "../src/commerce/capabilities.js";
import {
  MARKETPLACE_CAPABILITIES_PATH,
  MARKETPLACE_CAPABILITY_ALL_OFF,
  MARKETPLACE_CAPABILITY_AUDIENCE,
  MARKETPLACE_CAPABILITY_DEPENDENCIES,
  MARKETPLACE_CAPABILITY_FAMILY_ORDER,
  MARKETPLACE_CAPABILITY_VERSION,
  MARKETPLACE_ROUTES,
  MARKETPLACE_ROUTE_IDS,
  MARKETPLACE_ROUTE_INDEX,
  MarketplaceCapabilitiesSuccessEnvelopeSchema,
  MarketplaceCapabilityBuilderInputSchema,
  MarketplaceCapabilityEntrySchema,
  MarketplaceCapabilityManifestSchema,
  MarketplaceRouteDescriptorSchema,
  buildMarketplaceCapabilityManifest,
  type MarketplaceCapabilityBuilderInput,
  type MarketplaceCapabilityFamily,
} from "../src/commerce/market-capabilities.js";

const SCHEMA = "openarc.api.v2" as const;
const REQUEST_ID = "9f1c2d34-5e6a-4b7c-8d9e-0f1a2b3c4d5e";
const BUILD_SHA = "0123456789abcdef0123456789abcdef01234567";
const CANARY = "SECRET_CANARY_DO_NOT_ECHO";

const META = {
  schemaVersion: SCHEMA,
  requestId: REQUEST_ID,
  buildSha: BUILD_SHA,
} as const;

/** Expected inventory transcribed literally from the frozen task.md. */
const EXPECTED_ROUTES: readonly {
  readonly id: string;
  readonly family: MarketplaceCapabilityFamily;
  readonly audience: "public" | "browser";
  readonly method: "GET" | "POST";
  readonly path: string;
}[] = [
  { id: "catalog_list", family: "public_catalog", audience: "public", method: "GET", path: "/v2/public/market/listings" },
  { id: "catalog_detail", family: "public_catalog", audience: "public", method: "GET", path: "/v2/public/market/listings/:listingId" },
  { id: "catalog_provider", family: "public_catalog", audience: "public", method: "GET", path: "/v2/public/market/providers/:providerId" },
  { id: "listing_roots", family: "listing_management", audience: "browser", method: "GET", path: "/v2/provider/organizations/:organizationId/listings" },
  { id: "listing_create", family: "listing_management", audience: "browser", method: "POST", path: "/v2/provider/organizations/:organizationId/listings" },
  { id: "listing_root", family: "listing_management", audience: "browser", method: "GET", path: "/v2/provider/organizations/:organizationId/listings/:listingId" },
  { id: "listing_versions", family: "listing_management", audience: "browser", method: "GET", path: "/v2/provider/organizations/:organizationId/listings/:listingId/versions" },
  { id: "listing_version_create", family: "listing_management", audience: "browser", method: "POST", path: "/v2/provider/organizations/:organizationId/listings/:listingId/versions" },
  { id: "listing_version", family: "listing_management", audience: "browser", method: "GET", path: "/v2/provider/organizations/:organizationId/listings/:listingId/versions/:version" },
  { id: "listing_draft_mutation_status", family: "listing_management", audience: "browser", method: "GET", path: "/v2/provider/organizations/:organizationId/listing-mutations/:mutationId" },
  { id: "listing_provider_options", family: "listing_management", audience: "browser", method: "GET", path: "/v2/provider/organizations/:organizationId/listing-providers" },
  { id: "listing_publish", family: "listing_management", audience: "browser", method: "POST", path: "/v2/provider/organizations/:organizationId/listings/:listingId/versions/:version/publish" },
  { id: "listing_pause", family: "listing_management", audience: "browser", method: "POST", path: "/v2/provider/organizations/:organizationId/listings/:listingId/versions/:version/pause" },
  { id: "listing_retire", family: "listing_management", audience: "browser", method: "POST", path: "/v2/provider/organizations/:organizationId/listings/:listingId/versions/:version/retire" },
  { id: "listing_lifecycle_mutation_status", family: "listing_management", audience: "browser", method: "GET", path: "/v2/provider/organizations/:organizationId/listing-lifecycle-mutations/:mutationId" },
  { id: "moderation_version", family: "moderation", audience: "browser", method: "GET", path: "/v2/moderator/organizations/:organizationId/listings/:listingId/versions/:version" },
  { id: "moderation_origin_review", family: "moderation", audience: "browser", method: "POST", path: "/v2/moderator/organizations/:organizationId/listings/:listingId/versions/:version/origin-review" },
  { id: "moderation_mutation_status", family: "moderation", audience: "browser", method: "GET", path: "/v2/moderator/organizations/:organizationId/listing-lifecycle-mutations/:mutationId" },
];

const ALL_ON: MarketplaceCapabilityBuilderInput = {
  auth: true,
  tenantReads: true,
  marketCatalog: true,
  listingManagement: true,
  marketModeration: true,
  authReady: true,
  tenantDatabaseReady: true,
  marketDatabaseReady: true,
};

const BOOLEAN_KEYS = [
  "auth",
  "tenantReads",
  "marketCatalog",
  "listingManagement",
  "marketModeration",
  "authReady",
  "tenantDatabaseReady",
  "marketDatabaseReady",
] as const;

/** Independent explicit state oracle for a single family. */
function oracleState(
  family: MarketplaceCapabilityFamily,
  input: MarketplaceCapabilityBuilderInput,
): "enabled" | "built_disabled" | "unavailable" {
  if (family === "public_catalog") {
    if (!input.marketCatalog) return "built_disabled";
    return input.marketDatabaseReady ? "enabled" : "unavailable";
  }
  if (family === "listing_management") {
    if (!input.listingManagement) return "built_disabled";
    return input.auth &&
      input.tenantReads &&
      input.authReady &&
      input.tenantDatabaseReady &&
      input.marketDatabaseReady
      ? "enabled"
      : "unavailable";
  }
  if (!input.marketModeration) return "built_disabled";
  return input.auth && input.authReady && input.marketDatabaseReady
    ? "enabled"
    : "unavailable";
}

function stateOf(
  input: MarketplaceCapabilityBuilderInput,
  family: MarketplaceCapabilityFamily,
): string {
  const manifest = buildMarketplaceCapabilityManifest(input);
  const entry = manifest.capabilities.find((item) => item.family === family);
  if (entry === undefined) throw new Error(`missing family ${family}`);
  return entry.state;
}

function inputFromMask(mask: number): MarketplaceCapabilityBuilderInput {
  const input = {} as Record<string, boolean>;
  BOOLEAN_KEYS.forEach((key, index) => {
    input[key] = (mask & (1 << index)) !== 0;
  });
  return input as MarketplaceCapabilityBuilderInput;
}

describe("marketplace capability contract constants", () => {
  it("publishes the exact path, version, environment and network", () => {
    expect(MARKETPLACE_CAPABILITIES_PATH).toBe(
      "/v2/public/marketplace-capabilities",
    );
    expect(MARKETPLACE_CAPABILITY_VERSION).toBe(
      "openarc.capabilities.marketplace.v1",
    );
    const manifest = buildMarketplaceCapabilityManifest(ALL_ON);
    expect(manifest.environment).toBe("testnet");
    expect(manifest.network).toBe("eip155:5042002");
  });

  it("freezes exactly three families in deterministic order", () => {
    expect(MARKETPLACE_CAPABILITY_FAMILY_ORDER).toEqual([
      "public_catalog",
      "listing_management",
      "moderation",
    ]);
    expect(buildMarketplaceCapabilityManifest(ALL_ON).capabilities.map((e) => e.family)).toEqual([
      "public_catalog",
      "listing_management",
      "moderation",
    ]);
  });

  it("freezes exact audiences and ordered dependency arrays", () => {
    expect(MARKETPLACE_CAPABILITY_AUDIENCE).toEqual({
      public_catalog: "public",
      listing_management: "browser",
      moderation: "browser",
    });
    expect(MARKETPLACE_CAPABILITY_DEPENDENCIES.public_catalog).toEqual([
      "marketDatabase",
    ]);
    expect(MARKETPLACE_CAPABILITY_DEPENDENCIES.listing_management).toEqual([
      "auth",
      "tenantDatabase",
      "marketDatabase",
    ]);
    expect(MARKETPLACE_CAPABILITY_DEPENDENCIES.moderation).toEqual([
      "auth",
      "marketDatabase",
    ]);
  });

  it("deeply freezes family order, audience and dependency constants", () => {
    expect(Object.isFrozen(MARKETPLACE_CAPABILITY_FAMILY_ORDER)).toBe(true);
    expect(Object.isFrozen(MARKETPLACE_CAPABILITY_AUDIENCE)).toBe(true);
    expect(Object.isFrozen(MARKETPLACE_CAPABILITY_DEPENDENCIES)).toBe(true);
    for (const family of MARKETPLACE_CAPABILITY_FAMILY_ORDER) {
      expect(Object.isFrozen(MARKETPLACE_CAPABILITY_DEPENDENCIES[family])).toBe(
        true,
      );
    }
    expect(Object.isFrozen(MARKETPLACE_CAPABILITY_ALL_OFF)).toBe(true);
    expect(() => {
      (
        MARKETPLACE_CAPABILITY_AUDIENCE as Record<string, string>
      ).public_catalog = "browser";
    }).toThrow();
    expect(MARKETPLACE_CAPABILITY_AUDIENCE.public_catalog).toBe("public");
  });

  it("does not disturb the legacy 5-family / 41-route registry", () => {
    expect(COMMERCE_CAPABILITY_FAMILY_ORDER).toHaveLength(5);
    expect(COMMERCE_ROUTES).toHaveLength(41);
    expect(COMMERCE_CAPABILITY_DEPENDENCIES.human_accounts).toEqual(["auth"]);
    expect(
      CommerceCapabilitiesSuccessEnvelopeSchema.safeParse({
        ok: true,
        data: {
          capabilityVersion: "openarc.capabilities.commerce.v1",
          environment: "testnet",
          network: "eip155:5042002",
          capabilities: [],
          routes: [],
        },
        meta: META,
      }).success,
    ).toBe(false);
  });
});

describe("frozen marketplace route registry", () => {
  it("has exactly 18 unique routes with the expected family counts", () => {
    expect(MARKETPLACE_ROUTES).toHaveLength(18);
    expect(MARKETPLACE_ROUTE_IDS).toHaveLength(18);
    expect(new Set(MARKETPLACE_ROUTE_IDS).size).toBe(18);
    const counts = MARKETPLACE_ROUTES.reduce<Record<string, number>>(
      (accumulator, route) => {
        accumulator[route.family] = (accumulator[route.family] ?? 0) + 1;
        return accumulator;
      },
      {},
    );
    expect(counts).toEqual({
      public_catalog: 3,
      listing_management: 12,
      moderation: 3,
    });
  });

  it("maps one-to-one against the literal frozen inventory", () => {
    expect(EXPECTED_ROUTES).toHaveLength(18);
    expect(
      new Set(EXPECTED_ROUTES.map((route) => `${route.method} ${route.path}`))
        .size,
    ).toBe(18);
    for (const expected of EXPECTED_ROUTES) {
      const actual = MARKETPLACE_ROUTE_INDEX[expected.id];
      expect(actual, `missing id ${expected.id}`).toBeDefined();
      expect(actual).toMatchObject(expected);
    }
    for (const actual of MARKETPLACE_ROUTES) {
      const expected = EXPECTED_ROUTES.find((route) => route.id === actual.id);
      expect(expected, `extra id ${actual.id}`).toBeDefined();
      expect(actual).toMatchObject(expected as object);
    }
  });

  it("excludes manifest/health/fallback/checkout/payment descriptors", () => {
    const paths = MARKETPLACE_ROUTES.map((route) => route.path);
    expect(paths).not.toContain(MARKETPLACE_CAPABILITIES_PATH);
    expect(paths).not.toContain("/v1/private/capabilities");
    for (const route of MARKETPLACE_ROUTES) {
      expect(route.method === "GET" || route.method === "POST").toBe(true);
      expect(/checkout|sessions?|payment/i.test(route.path)).toBe(false);
      expect(route.path.startsWith("/v2/")).toBe(true);
    }
  });

  it("is deeply frozen so callers cannot mutate global truth", () => {
    expect(Object.isFrozen(MARKETPLACE_ROUTES)).toBe(true);
    for (const route of MARKETPLACE_ROUTES) {
      expect(Object.isFrozen(route)).toBe(true);
    }
    expect(Object.isFrozen(MARKETPLACE_ROUTE_IDS)).toBe(true);
    expect(Object.isFrozen(MARKETPLACE_ROUTE_INDEX)).toBe(true);
  });

  it("accepts every frozen descriptor and rejects altered tuples", () => {
    for (const route of EXPECTED_ROUTES) {
      expect(
        MarketplaceRouteDescriptorSchema.safeParse(route).success,
        route.id,
      ).toBe(true);
    }
    const first = EXPECTED_ROUTES[0] as (typeof EXPECTED_ROUTES)[number];
    const bad = [
      { ...first, method: "POST" },
      { ...first, path: "/v2/public/market/listings/:listingId" },
      { ...first, audience: "browser" },
      { ...first, family: "moderation" as const },
      { ...EXPECTED_ROUTES[3], method: "POST" },
      { ...EXPECTED_ROUTES[15], audience: "public" as const },
      { ...EXPECTED_ROUTES[15], family: "listing_management" as const },
      { ...first, id: "catalog_unknown" },
      { ...first, path: `${first.path}?x=1` },
      { ...first, path: `https://evil.example${first.path}` },
      { ...first, path: `${first.path}/${CANARY}` },
      { ...first, extra: CANARY },
    ];
    for (const route of bad) {
      expect(
        MarketplaceRouteDescriptorSchema.safeParse(route).success,
        JSON.stringify(route),
      ).toBe(false);
    }
  });
});

describe("marketplace builder availability semantics", () => {
  it("all-off is built_disabled for every family", () => {
    const manifest = buildMarketplaceCapabilityManifest(
      MARKETPLACE_CAPABILITY_ALL_OFF,
    );
    expect(manifest.capabilities).toHaveLength(3);
    for (const entry of manifest.capabilities) {
      expect(entry.state).toBe("built_disabled");
    }
    expect(MARKETPLACE_CAPABILITY_ALL_OFF).toEqual({
      auth: false,
      tenantReads: false,
      marketCatalog: false,
      listingManagement: false,
      marketModeration: false,
      authReady: false,
      tenantDatabaseReady: false,
      marketDatabaseReady: false,
    });
  });

  it("all-on with all readiness is enabled for every family", () => {
    const manifest = buildMarketplaceCapabilityManifest(ALL_ON);
    for (const entry of manifest.capabilities) {
      expect(entry.state).toBe("enabled");
    }
  });

  it("public catalog needs marketDatabaseReady but not auth/tenantReads", () => {
    expect(
      stateOf(
        { ...ALL_ON, auth: false, tenantReads: false, authReady: false, tenantDatabaseReady: false },
        "public_catalog",
      ),
    ).toBe("enabled");
    expect(
      stateOf({ ...ALL_ON, marketDatabaseReady: false }, "public_catalog"),
    ).toBe("unavailable");
    expect(
      stateOf({ ...ALL_ON, marketCatalog: false, marketDatabaseReady: false }, "public_catalog"),
    ).toBe("built_disabled");
  });

  it("listing management needs auth, tenantReads and all three readiness flags", () => {
    for (const key of [
      "auth",
      "tenantReads",
      "authReady",
      "tenantDatabaseReady",
      "marketDatabaseReady",
    ] as const) {
      expect(
        stateOf({ ...ALL_ON, [key]: false }, "listing_management"),
        key,
      ).toBe("unavailable");
    }
    expect(
      stateOf({ ...ALL_ON, listingManagement: false }, "listing_management"),
    ).toBe("built_disabled");
  });

  it("moderation needs auth+authReady+marketDatabaseReady but not tenantReads", () => {
    expect(
      stateOf(
        { ...ALL_ON, tenantReads: false, tenantDatabaseReady: false },
        "moderation",
      ),
    ).toBe("enabled");
    for (const key of ["auth", "authReady", "marketDatabaseReady"] as const) {
      expect(stateOf({ ...ALL_ON, [key]: false }, "moderation"), key).toBe(
        "unavailable",
      );
    }
    expect(
      stateOf({ ...ALL_ON, marketModeration: false }, "moderation"),
    ).toBe("built_disabled");
  });

  it("disabled own flag stays built_disabled even with dependencies down", () => {
    for (const family of MARKETPLACE_CAPABILITY_FAMILY_ORDER) {
      expect(stateOf(MARKETPLACE_CAPABILITY_ALL_OFF, family)).toBe(
        "built_disabled",
      );
    }
  });

  it("exhaustively covers 256 boolean combinations against an explicit oracle", () => {
    let cases = 0;
    for (let mask = 0; mask < 256; mask += 1) {
      const input = inputFromMask(mask);
      const parsed = MarketplaceCapabilityBuilderInputSchema.safeParse(input);
      expect(parsed.success).toBe(true);
      const manifest = buildMarketplaceCapabilityManifest(
        parsed.data as MarketplaceCapabilityBuilderInput,
      );
      cases += 1;
      for (const entry of manifest.capabilities) {
        expect(entry.state, `${mask}:${entry.family}`).toBe(
          oracleState(entry.family, input),
        );
      }
    }
    expect(cases).toBe(256);
  });
});

describe("marketplace manifest schema, envelope and fail-closed input", () => {
  it("validates builder output and exposes a strict success envelope", () => {
    const manifest = buildMarketplaceCapabilityManifest(ALL_ON);
    expect(MarketplaceCapabilityManifestSchema.safeParse(manifest).success).toBe(
      true,
    );
    const envelope = { ok: true as const, data: manifest, meta: META };
    expect(
      MarketplaceCapabilitiesSuccessEnvelopeSchema.safeParse(envelope).success,
    ).toBe(true);
    expect(CommerceApiMetaSchema.safeParse(META).success).toBe(true);
    expect(COMMERCE_API_SCHEMA_VERSION).toBe("openarc.api.v2");
  });

  it("rejects extra, non-boolean, undefined and unknown builder input", () => {
    const invalid = [
      { ...ALL_ON, extra: true },
      { ...ALL_ON, auth: "yes" },
      { ...ALL_ON, authReady: 1 },
      { ...ALL_ON, role: "admin" },
      { ...ALL_ON, wallet: "0x0" },
    ];
    for (const input of invalid) {
      expect(
        MarketplaceCapabilityBuilderInputSchema.safeParse(input).success,
        JSON.stringify(input),
      ).toBe(false);
    }
    expect(() =>
      buildMarketplaceCapabilityManifest(undefined as unknown as MarketplaceCapabilityBuilderInput),
    ).toThrow();
    expect(() =>
      buildMarketplaceCapabilityManifest({
        ...ALL_ON,
        extra: true,
      } as unknown as MarketplaceCapabilityBuilderInput),
    ).toThrow();
  });

  it("rejects incomplete, duplicated and extra manifest inventories", () => {
    const valid = buildMarketplaceCapabilityManifest(ALL_ON);
    const missingFamily = {
      ...valid,
      capabilities: valid.capabilities.slice(0, 2),
    };
    const duplicateFamily = {
      ...valid,
      capabilities: [valid.capabilities[0], ...valid.capabilities.slice(0, 2)],
    };
    const missingRoute = { ...valid, routes: valid.routes.slice(0, 17) };
    const extraRoute = {
      ...valid,
      routes: [...valid.routes, { ...valid.routes[0], id: "catalog_extra" }],
    };
    const unknownFamily = {
      ...valid,
      capabilities: [
        { ...valid.capabilities[0], family: "payments" },
        valid.capabilities[1],
        valid.capabilities[2],
      ],
    };
    for (const candidate of [
      missingFamily,
      duplicateFamily,
      missingRoute,
      extraRoute,
      unknownFamily,
    ]) {
      expect(
        MarketplaceCapabilityManifestSchema.safeParse(candidate).success,
      ).toBe(false);
    }
  });

  it("rejects altered version, network, extra fields and altered descriptors", () => {
    const valid = buildMarketplaceCapabilityManifest(ALL_ON);
    const alteredVersion = { ...valid, capabilityVersion: "openarc.capabilities.other.v1" };
    const alteredNetwork = { ...valid, network: "eip155:1" };
    const extraTop = { ...valid, secretConfig: CANARY };
    const alteredMethod = {
      ...valid,
      routes: valid.routes.map((route) =>
        route.id === "listing_create" ? { ...route, method: "GET" } : route,
      ),
    };
    const alteredPath = {
      ...valid,
      routes: valid.routes.map((route) =>
        route.id === "catalog_list" ? { ...route, path: "/v2/public/market/x" } : route,
      ),
    };
    const alteredAudience = {
      ...valid,
      routes: valid.routes.map((route) =>
        route.id === "catalog_list" ? { ...route, audience: "browser" } : route,
      ),
    };
    for (const candidate of [
      alteredVersion,
      alteredNetwork,
      extraTop,
      alteredMethod,
      alteredPath,
      alteredAudience,
    ]) {
      expect(
        MarketplaceCapabilityManifestSchema.safeParse(candidate).success,
        JSON.stringify(candidate).slice(0, 80),
      ).toBe(false);
    }
  });

  it("rejects wrong dependency order/contents, audience and extra keys", () => {
    const valid = buildMarketplaceCapabilityManifest(ALL_ON);
    const reversed = {
      ...valid,
      capabilities: valid.capabilities.map((entry) =>
        entry.family === "listing_management"
          ? {
              ...entry,
              dependencies: ["marketDatabase", "tenantDatabase", "auth"],
            }
          : entry,
      ),
    };
    const removed = {
      ...valid,
      capabilities: valid.capabilities.map((entry) =>
        entry.family === "moderation"
          ? { ...entry, dependencies: ["auth"] }
          : entry,
      ),
    };
    const extra = {
      ...valid,
      capabilities: valid.capabilities.map((entry) => ({
        ...entry,
        provider: "x",
      })),
    };
    const badAudience = {
      ...valid,
      capabilities: valid.capabilities.map((entry) =>
        entry.family === "public_catalog"
          ? { ...entry, audience: "browser" }
          : entry,
      ),
    };
    for (const candidate of [reversed, removed, extra, badAudience]) {
      expect(
        MarketplaceCapabilityManifestSchema.safeParse(candidate).success,
      ).toBe(false);
    }
  });

  it("rejects entry states outside the closed enabled/built_disabled/unavailable set", () => {
    expect(
      MarketplaceCapabilityEntrySchema.safeParse({
        family: "public_catalog",
        audience: "public",
        state: "planned",
        dependencies: ["marketDatabase"],
      }).success,
    ).toBe(false);
    expect(
      MarketplaceCapabilityEntrySchema.safeParse({
        family: "public_catalog",
        audience: "public",
        state: "enabled",
        dependencies: ["marketDatabase"],
      }).success,
    ).toBe(true);
  });

  it("safeParse never throws on arbitrary malformed bounded input", () => {
    const samples: unknown[] = [
      undefined,
      null,
      0,
      "",
      "x",
      true,
      [],
      {},
      { capabilities: null, routes: {} },
      { auth: true },
      { ...ALL_ON, auth: null, tenantReads: [] },
      { ...EXPECTED_ROUTES[0], method: 7, path: {} },
      { ...EXPECTED_ROUTES[0], dependencies: "marketDatabase" },
      { family: "unknown", audience: "public", state: "enabled", dependencies: [] },
    ];
    for (const sample of samples) {
      expect(() => MarketplaceCapabilityBuilderInputSchema.safeParse(sample)).not.toThrow();
      expect(() => MarketplaceCapabilityEntrySchema.safeParse(sample)).not.toThrow();
      expect(() => MarketplaceRouteDescriptorSchema.safeParse(sample)).not.toThrow();
      expect(() => MarketplaceCapabilityManifestSchema.safeParse(sample)).not.toThrow();
    }
  });
});

describe("static typing", () => {
  it("narrows manifest, builder input and entry types", () => {
    expectTypeOf(buildMarketplaceCapabilityManifest)
      .parameter(0)
      .toEqualTypeOf<MarketplaceCapabilityBuilderInput>();
    const manifest = buildMarketplaceCapabilityManifest(ALL_ON);
    expectTypeOf(manifest.capabilityVersion).toEqualTypeOf<
      "openarc.capabilities.marketplace.v1"
    >();
    expectTypeOf(manifest.capabilities[0]?.state).toEqualTypeOf<
      "enabled" | "built_disabled" | "unavailable" | undefined
    >();
  });
});
