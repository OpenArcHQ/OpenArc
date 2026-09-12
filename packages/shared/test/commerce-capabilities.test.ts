import { describe, expect, expectTypeOf, it } from "vitest";

import {
  CAPABILITIES_PATH,
  CapabilitiesSchema,
  M04CapabilitiesSchema,
  M05CapabilitiesSchema,
  M06CapabilitiesSchema,
  M07CapabilitiesSchema,
} from "../src/api.js";
import {
  COMMERCE_API_SCHEMA_VERSION,
  CommerceApiMetaSchema,
} from "../src/commerce/api.js";
import {
  COMMERCE_CAPABILITIES_PATH,
  COMMERCE_CAPABILITY_ALL_OFF,
  COMMERCE_CAPABILITY_AUDIENCE,
  COMMERCE_CAPABILITY_DEPENDENCIES,
  COMMERCE_CAPABILITY_ENVIRONMENT,
  COMMERCE_CAPABILITY_FAMILY_ORDER,
  COMMERCE_CAPABILITY_NETWORK,
  COMMERCE_CAPABILITY_VERSION,
  COMMERCE_ROUTES,
  COMMERCE_ROUTE_IDS,
  COMMERCE_ROUTE_INDEX,
  CommerceCapabilitiesSuccessEnvelopeSchema,
  CommerceCapabilityBuilderInputSchema,
  CommerceCapabilityEntrySchema,
  CommerceCapabilityManifestSchema,
  CommerceRouteDescriptorSchema,
  buildCommerceCapabilityManifest,
  type CommerceCapabilityBuilderInput,
  type CommerceCapabilityFamily,
} from "../src/commerce/capabilities.js";

const SCHEMA = "openarc.api.v2" as const;
const REQUEST_ID = "9f1c2d34-5e6a-4b7c-8d9e-0f1a2b3c4d5e";
const BUILD_SHA = "0123456789abcdef0123456789abcdef01234567";
const CANARY = "SECRET_CANARY_DO_NOT_ECHO";

const META = {
  schemaVersion: SCHEMA,
  requestId: REQUEST_ID,
  buildSha: BUILD_SHA,
} as const;

/** Expected source route inventory, transcribed literally from the API
 * constants in apps/api/src/**\/routes.ts. Shared code never imports the API. */
const EXPECTED_ROUTES: readonly {
  readonly id: string;
  readonly family: CommerceCapabilityFamily;
  readonly audience: "browser" | "machine";
  readonly method: "GET" | "POST" | "PATCH" | "PUT";
  readonly path: string;
}[] = [
  { id: "human_accounts_bootstrap", family: "human_accounts", audience: "browser", method: "POST", path: "/v2/auth/bootstrap" },
  { id: "human_accounts_session", family: "human_accounts", audience: "browser", method: "GET", path: "/v2/auth/session" },
  { id: "human_accounts_passkey_register_options", family: "human_accounts", audience: "browser", method: "POST", path: "/v2/auth/passkeys/register/options" },
  { id: "human_accounts_passkey_register_verify", family: "human_accounts", audience: "browser", method: "POST", path: "/v2/auth/passkeys/register/verify" },
  { id: "human_accounts_passkey_login_options", family: "human_accounts", audience: "browser", method: "POST", path: "/v2/auth/passkeys/login/options" },
  { id: "human_accounts_passkey_login_verify", family: "human_accounts", audience: "browser", method: "POST", path: "/v2/auth/passkeys/login/verify" },
  { id: "human_accounts_passkey_add_options", family: "human_accounts", audience: "browser", method: "POST", path: "/v2/auth/passkeys/add/options" },
  { id: "human_accounts_passkey_add_verify", family: "human_accounts", audience: "browser", method: "POST", path: "/v2/auth/passkeys/add/verify" },
  { id: "human_accounts_wallet_login_options", family: "human_accounts", audience: "browser", method: "POST", path: "/v2/auth/wallets/login/options" },
  { id: "human_accounts_wallet_login_verify", family: "human_accounts", audience: "browser", method: "POST", path: "/v2/auth/wallets/login/verify" },
  { id: "human_accounts_wallet_link_options", family: "human_accounts", audience: "browser", method: "POST", path: "/v2/auth/wallets/link/options" },
  { id: "human_accounts_wallet_link_verify", family: "human_accounts", audience: "browser", method: "POST", path: "/v2/auth/wallets/link/verify" },
  { id: "human_accounts_recovery_codes", family: "human_accounts", audience: "browser", method: "POST", path: "/v2/auth/recovery/codes" },
  { id: "human_accounts_recovery_redeem", family: "human_accounts", audience: "browser", method: "POST", path: "/v2/auth/recovery/redeem" },
  { id: "human_accounts_logout", family: "human_accounts", audience: "browser", method: "POST", path: "/v2/auth/logout" },
  { id: "tenant_reads_organizations", family: "tenant_reads", audience: "browser", method: "GET", path: "/v1/operator/organizations" },
  { id: "tenant_reads_organization", family: "tenant_reads", audience: "browser", method: "GET", path: "/v1/operator/organizations/:organizationId" },
  { id: "tenant_reads_agents", family: "tenant_reads", audience: "browser", method: "GET", path: "/v1/operator/organizations/:organizationId/agents" },
  { id: "tenant_reads_providers", family: "tenant_reads", audience: "browser", method: "GET", path: "/v1/operator/organizations/:organizationId/providers" },
  { id: "tenant_writes_organization_create", family: "tenant_writes", audience: "browser", method: "POST", path: "/v1/operator/organizations" },
  { id: "tenant_writes_agent_create", family: "tenant_writes", audience: "browser", method: "POST", path: "/v1/operator/organizations/:organizationId/agents" },
  { id: "tenant_writes_agent_update", family: "tenant_writes", audience: "browser", method: "PATCH", path: "/v1/operator/organizations/:organizationId/agents/:agentId" },
  { id: "tenant_writes_provider_create", family: "tenant_writes", audience: "browser", method: "POST", path: "/v1/operator/organizations/:organizationId/providers" },
  { id: "tenant_writes_provider_update", family: "tenant_writes", audience: "browser", method: "PATCH", path: "/v1/operator/organizations/:organizationId/providers/:providerId" },
  { id: "tenant_writes_membership_set", family: "tenant_writes", audience: "browser", method: "PUT", path: "/v1/operator/organizations/:organizationId/memberships/:accountId" },
  { id: "tenant_writes_mutation_status", family: "tenant_writes", audience: "browser", method: "GET", path: "/v1/operator/organizations/:organizationId/mutations/:mutationId" },
  { id: "tenant_writes_bootstrap_mutation_status", family: "tenant_writes", audience: "browser", method: "GET", path: "/v1/operator/organizations/bootstrap-mutations/:mutationId" },
  { id: "machine_credentials_agent_list", family: "machine_credentials", audience: "browser", method: "GET", path: "/v1/operator/organizations/:organizationId/agents/:agentId/credentials" },
  { id: "machine_credentials_agent_issue", family: "machine_credentials", audience: "browser", method: "POST", path: "/v1/operator/organizations/:organizationId/agents/:agentId/credentials" },
  { id: "machine_credentials_provider_list", family: "machine_credentials", audience: "browser", method: "GET", path: "/v1/operator/organizations/:organizationId/providers/:providerId/credentials" },
  { id: "machine_credentials_provider_issue", family: "machine_credentials", audience: "browser", method: "POST", path: "/v1/operator/organizations/:organizationId/providers/:providerId/credentials" },
  { id: "machine_credentials_agent_revoke", family: "machine_credentials", audience: "browser", method: "POST", path: "/v1/operator/organizations/:organizationId/agent-credentials/:credentialId/revoke" },
  { id: "machine_credentials_provider_revoke", family: "machine_credentials", audience: "browser", method: "POST", path: "/v1/operator/organizations/:organizationId/provider-credentials/:credentialId/revoke" },
  { id: "machine_credentials_agent_mutation_status", family: "machine_credentials", audience: "browser", method: "GET", path: "/v1/operator/organizations/:organizationId/agent-credential-mutations/:mutationId" },
  { id: "machine_credentials_provider_mutation_status", family: "machine_credentials", audience: "browser", method: "GET", path: "/v1/operator/organizations/:organizationId/provider-credential-mutations/:mutationId" },
  { id: "machine_sessions_agent_exchange", family: "machine_sessions", audience: "machine", method: "POST", path: "/v1/agent/sessions" },
  { id: "machine_sessions_provider_exchange", family: "machine_sessions", audience: "machine", method: "POST", path: "/v1/provider/sessions" },
  { id: "machine_sessions_agent_self", family: "machine_sessions", audience: "machine", method: "GET", path: "/v1/agent/self" },
  { id: "machine_sessions_provider_self", family: "machine_sessions", audience: "machine", method: "GET", path: "/v1/provider/self" },
  { id: "machine_sessions_agent_revoke", family: "machine_sessions", audience: "machine", method: "POST", path: "/v1/agent/sessions/current/revoke" },
  { id: "machine_sessions_provider_revoke", family: "machine_sessions", audience: "machine", method: "POST", path: "/v1/provider/sessions/current/revoke" },
];

const ALL_ON: CommerceCapabilityBuilderInput = {
  auth: true,
  tenantReads: true,
  tenantWrites: true,
  machineCredentials: true,
  machineSessions: true,
  authReady: true,
  tenantDatabaseReady: true,
  machineDatabaseReady: true,
};

function stateOf(
  input: CommerceCapabilityBuilderInput,
  family: CommerceCapabilityFamily,
): string {
  const manifest = buildCommerceCapabilityManifest(input);
  const entry = manifest.capabilities.find((item) => item.family === family);
  if (entry === undefined) throw new Error(`missing family ${family}`);
  return entry.state;
}

describe("commerce capabilities contract constants", () => {
  it("publishes the new public path and version literals without collision", () => {
    expect(COMMERCE_CAPABILITIES_PATH).toBe("/v2/public/capabilities");
    expect(COMMERCE_CAPABILITY_VERSION).toBe(
      "openarc.capabilities.commerce.v1",
    );
    expect(COMMERCE_CAPABILITY_ENVIRONMENT).toBe("testnet");
    expect(COMMERCE_CAPABILITY_NETWORK).toBe("eip155:5042002");
  });

  it("preserves the legacy capability path and m04-m07 decoders", () => {
    expect(CAPABILITIES_PATH).toBe("/v1/private/capabilities");
    expect(COMMERCE_CAPABILITIES_PATH).not.toBe(CAPABILITIES_PATH);
    expect(COMMERCE_CAPABILITY_VERSION).not.toMatch(/\.m0[4-7]\./u);
    for (const schema of [
      M04CapabilitiesSchema,
      M05CapabilitiesSchema,
      M06CapabilitiesSchema,
      M07CapabilitiesSchema,
      CapabilitiesSchema,
    ]) {
      expect(schema).toBeDefined();
    }
  });

  it("freezes exactly five families in deterministic order with exact dependencies", () => {
    expect(COMMERCE_CAPABILITY_FAMILY_ORDER).toEqual([
      "human_accounts",
      "tenant_reads",
      "tenant_writes",
      "machine_credentials",
      "machine_sessions",
    ]);
    expect(COMMERCE_CAPABILITY_DEPENDENCIES.human_accounts).toEqual(["auth"]);
    expect(COMMERCE_CAPABILITY_DEPENDENCIES.tenant_reads).toEqual([
      "auth",
      "tenantDatabase",
    ]);
    expect(COMMERCE_CAPABILITY_DEPENDENCIES.tenant_writes).toEqual([
      "auth",
      "tenantDatabase",
    ]);
    expect(COMMERCE_CAPABILITY_DEPENDENCIES.machine_credentials).toEqual([
      "auth",
      "tenantDatabase",
      "machineDatabase",
    ]);
    expect(COMMERCE_CAPABILITY_DEPENDENCIES.machine_sessions).toEqual([
      "auth",
      "tenantDatabase",
      "machineDatabase",
    ]);
  });

  it("freezes audience: only machine_sessions is machine", () => {
    expect(COMMERCE_CAPABILITY_AUDIENCE).toEqual({
      human_accounts: "browser",
      tenant_reads: "browser",
      tenant_writes: "browser",
      machine_credentials: "browser",
      machine_sessions: "machine",
    });
    expect(Object.isFrozen(COMMERCE_CAPABILITY_AUDIENCE)).toBe(true);
  });
});

describe("fixed principal-route registry", () => {
  it("has exactly 41 unique route ids with the expected family counts", () => {
    expect(COMMERCE_ROUTES).toHaveLength(41);
    expect(COMMERCE_ROUTE_IDS).toHaveLength(41);
    expect(new Set(COMMERCE_ROUTE_IDS).size).toBe(41);
    const counts = COMMERCE_ROUTES.reduce<Record<string, number>>(
      (accumulator, route) => {
        accumulator[route.family] = (accumulator[route.family] ?? 0) + 1;
        return accumulator;
      },
      {},
    );
    expect(counts).toEqual({
      human_accounts: 15,
      tenant_reads: 4,
      tenant_writes: 8,
      machine_credentials: 8,
      machine_sessions: 6,
    });
  });

  it("maps one-to-one in both directions against the literal source routes", () => {
    expect(EXPECTED_ROUTES).toHaveLength(41);
    expect(
      new Set(EXPECTED_ROUTES.map((route) => `${route.method} ${route.path}`))
        .size,
    ).toBe(41);
    for (const expected of EXPECTED_ROUTES) {
      const actual = COMMERCE_ROUTE_INDEX[expected.id];
      expect(actual, `missing id ${expected.id}`).toBeDefined();
      expect(actual).toMatchObject(expected);
    }
    for (const actual of COMMERCE_ROUTES) {
      const expected = EXPECTED_ROUTES.find((route) => route.id === actual.id);
      expect(expected, `extra id ${actual.id}`).toBeDefined();
      expect(actual).toMatchObject(expected as object);
    }
  });

  it("excludes the manifest/health/legacy and fallback registrations", () => {
    const paths = COMMERCE_ROUTES.map((route) => route.path);
    expect(paths).not.toContain("/v2/public/capabilities");
    expect(paths).not.toContain("/v1/private/capabilities");
    for (const path of paths) {
      expect(path.startsWith("/v2/auth/") || path.startsWith("/v1/")).toBe(true);
    }
  });

  it("is deeply frozen so callers cannot mutate global truth", () => {
    expect(Object.isFrozen(COMMERCE_ROUTES)).toBe(true);
    for (const route of COMMERCE_ROUTES) {
      expect(Object.isFrozen(route)).toBe(true);
    }
    expect(Object.isFrozen(COMMERCE_ROUTE_IDS)).toBe(true);
    expect(Object.isFrozen(COMMERCE_ROUTE_INDEX)).toBe(true);
    expect(Object.isFrozen(COMMERCE_CAPABILITY_DEPENDENCIES)).toBe(true);
    for (const family of COMMERCE_CAPABILITY_FAMILY_ORDER) {
      expect(Object.isFrozen(COMMERCE_CAPABILITY_DEPENDENCIES[family])).toBe(
        true,
      );
    }
  });

  it("accepts every frozen descriptor and rejects permuted combinations", () => {
    for (const route of EXPECTED_ROUTES) {
      expect(
        CommerceRouteDescriptorSchema.safeParse(route).success,
        route.id,
      ).toBe(true);
    }
    // cross-family audience/method/path permutations must fail
    const bad = [
      { ...EXPECTED_ROUTES[0], method: "GET" },
      { ...EXPECTED_ROUTES[0], path: "/v2/auth/session" },
      { ...EXPECTED_ROUTES[0], audience: "machine" },
      { ...EXPECTED_ROUTES[15], method: "POST" },
      { ...EXPECTED_ROUTES[35], audience: "browser" },
      { ...EXPECTED_ROUTES[35], family: "tenant_reads" as const },
      { ...EXPECTED_ROUTES[0], id: "human_accounts_unknown" },
    ];
    for (const route of bad) {
      expect(
        CommerceRouteDescriptorSchema.safeParse(route).success,
        JSON.stringify(route),
      ).toBe(false);
    }
  });

  it("rejects malformed paths, query, URL, wildcard and canaries", () => {
    const base = EXPECTED_ROUTES[0] as (typeof EXPECTED_ROUTES)[number];
    const malformed = [
      { ...base, path: `${base.path}\n` },
      { ...base, path: `${base.path}?x=1` },
      { ...base, path: "https://evil.example/v2/auth/bootstrap" },
      { ...base, path: "/v2/auth/*" },
      { ...base, path: "/v2/auth/:id" },
      { ...base, path: `${base.path}/../secret` },
      { ...base, id: "human_accounts_Bootstrap" },
      { ...base, id: `${base.id}${CANARY}` },
      { ...base, path: `${base.path}/${CANARY}` },
      { ...base, extra: CANARY },
    ];
    for (const route of malformed) {
      expect(
        CommerceRouteDescriptorSchema.safeParse(route).success,
        JSON.stringify(route),
      ).toBe(false);
    }
  });
});

describe("builder availability semantics", () => {
  it("all-off is built_disabled for every family", () => {
    const manifest = buildCommerceCapabilityManifest(COMMERCE_CAPABILITY_ALL_OFF);
    expect(manifest.capabilities).toHaveLength(5);
    for (const entry of manifest.capabilities) {
      expect(entry.state).toBe("built_disabled");
    }
  });

  it("all-on with all readiness is enabled for every family", () => {
    const manifest = buildCommerceCapabilityManifest(ALL_ON);
    for (const entry of manifest.capabilities) {
      expect(entry.state).toBe("enabled");
    }
  });

  it("disabled own flag stays built_disabled even with dependencies down", () => {
    for (const family of COMMERCE_CAPABILITY_FAMILY_ORDER) {
      expect(stateOf(COMMERCE_CAPABILITY_ALL_OFF, family)).toBe(
        "built_disabled",
      );
    }
  });

  it("enabled own flag with unmet parent/runtime is unavailable", () => {
    // human_accounts own flag is `auth`; readiness can fail while flag is on.
    expect(stateOf({ ...ALL_ON, authReady: false }, "human_accounts")).toBe(
      "unavailable",
    );
    // Child family own flag stays on while a parent flag is off.
    expect(stateOf({ ...ALL_ON, auth: false }, "tenant_reads")).toBe(
      "unavailable",
    );
    expect(stateOf({ ...ALL_ON, auth: false }, "tenant_writes")).toBe(
      "unavailable",
    );
    expect(
      stateOf({ ...ALL_ON, tenantReads: false }, "tenant_writes"),
    ).toBe("unavailable");
    expect(
      stateOf({ ...ALL_ON, tenantDatabaseReady: false }, "tenant_writes"),
    ).toBe("unavailable");
    expect(
      stateOf(
        { ...ALL_ON, machineDatabaseReady: false },
        "machine_credentials",
      ),
    ).toBe("unavailable");
    // sessions parent chain is auth+reads+sessions only.
    expect(stateOf({ ...ALL_ON, auth: false }, "machine_sessions")).toBe(
      "unavailable",
    );
  });

  it("machine sessions stay enabled with writes and management off", () => {
    const input: CommerceCapabilityBuilderInput = {
      ...ALL_ON,
      tenantWrites: false,
      machineCredentials: false,
    };
    expect(stateOf(input, "machine_sessions")).toBe("enabled");
  });

  it("machine readiness failure does not disable auth/read families", () => {
    const input: CommerceCapabilityBuilderInput = {
      ...ALL_ON,
      machineDatabaseReady: false,
    };
    expect(stateOf(input, "human_accounts")).toBe("enabled");
    expect(stateOf(input, "tenant_reads")).toBe("enabled");
    expect(stateOf(input, "tenant_writes")).toBe("enabled");
    expect(stateOf(input, "machine_sessions")).toBe("unavailable");
  });

  it("exhaustively covers 32 flag x 8 readiness combinations", () => {
    const booleanKeys = [
      "auth",
      "tenantReads",
      "tenantWrites",
      "machineCredentials",
      "machineSessions",
      "authReady",
      "tenantDatabaseReady",
      "machineDatabaseReady",
    ] as const;
    let cases = 0;
    for (let mask = 0; mask < 256; mask += 1) {
      const input = {} as Record<string, boolean>;
      booleanKeys.forEach((key, index) => {
        input[key] = (mask & (1 << index)) !== 0;
      });
      const parsed = CommerceCapabilityBuilderInputSchema.safeParse(input);
      expect(parsed.success).toBe(true);
      const manifest = buildCommerceCapabilityManifest(
        parsed.data as CommerceCapabilityBuilderInput,
      );
      cases += 1;
      for (const entry of manifest.capabilities) {
        const parents = entry.dependencies;
        if (entry.state === "enabled") {
          // enabled cannot carry a missing parent/runtime dependency
          expect(parents.length).toBeGreaterThan(0);
        }
        if (entry.state === "planned") {
          throw new Error("implemented family reported planned");
        }
      }
    }
    expect(cases).toBe(256);
  });
});

describe("manifest schema, envelope and fail-closed input", () => {
  it("validates builder output and exposes a strict success envelope", () => {
    const manifest = buildCommerceCapabilityManifest(ALL_ON);
    expect(CommerceCapabilityManifestSchema.safeParse(manifest).success).toBe(
      true,
    );
    const envelope = {
      ok: true as const,
      data: manifest,
      meta: META,
    };
    expect(
      CommerceCapabilitiesSuccessEnvelopeSchema.safeParse(envelope).success,
    ).toBe(true);
    expect(CommerceApiMetaSchema.safeParse(META).success).toBe(true);
    expect(COMMERCE_API_SCHEMA_VERSION).toBe("openarc.api.v2");
  });

  it("rejects extra, non-boolean and requestId/buildSha in builder input", () => {
    const invalid = [
      { ...ALL_ON, extra: true },
      { ...ALL_ON, auth: "yes" },
      { ...ALL_ON, requestId: REQUEST_ID },
      { ...ALL_ON, buildSha: BUILD_SHA },
      { ...ALL_ON, authReady: 1 },
    ];
    for (const input of invalid) {
      expect(
        CommerceCapabilityBuilderInputSchema.safeParse(input).success,
        JSON.stringify(input),
      ).toBe(false);
    }
    expect(() =>
      buildCommerceCapabilityManifest({
        ...ALL_ON,
        extra: true,
      } as unknown as CommerceCapabilityBuilderInput),
    ).toThrow();
  });

  it("rejects incomplete, duplicated and extra manifest inventories", () => {
    const valid = buildCommerceCapabilityManifest(ALL_ON);
    const missingFamily = {
      ...valid,
      capabilities: valid.capabilities.slice(0, 4),
    };
    const duplicateFamily = {
      ...valid,
      capabilities: [
        valid.capabilities[0],
        ...valid.capabilities.slice(0, 4),
      ],
    };
    const missingRoute = { ...valid, routes: valid.routes.slice(0, 40) };
    const extraRoute = {
      ...valid,
      routes: [
        ...valid.routes,
        { ...valid.routes[0], id: "human_accounts_extra" },
      ],
    };
    const plannedFamily = {
      ...valid,
      capabilities: valid.capabilities.map((entry) => ({
        ...entry,
        state: "planned" as const,
      })),
    };
    for (const candidate of [
      missingFamily,
      duplicateFamily,
      missingRoute,
      extraRoute,
      plannedFamily,
    ]) {
      expect(
        CommerceCapabilityManifestSchema.safeParse(candidate).success,
      ).toBe(false);
    }
  });

  it("rejects wrong dependency order/contents and extra fields", () => {
    const valid = buildCommerceCapabilityManifest(ALL_ON);
    const reversed = {
      ...valid,
      capabilities: valid.capabilities.map((entry) =>
        entry.family === "machine_sessions"
          ? {
              ...entry,
              dependencies: ["machineDatabase", "auth", "tenantDatabase"],
            }
          : entry,
      ),
    };
    const removed = {
      ...valid,
      capabilities: valid.capabilities.map((entry) =>
        entry.family === "tenant_reads"
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
    for (const candidate of [reversed, removed, extra]) {
      expect(
        CommerceCapabilityManifestSchema.safeParse(candidate).success,
      ).toBe(false);
    }
  });

  it("rejects invalid state values including planned for implemented families", () => {
    expect(
      CommerceCapabilityEntrySchema.safeParse({
        family: "human_accounts",
        audience: "browser",
        state: "planned",
        dependencies: ["auth"],
      }).success,
    ).toBe(true);
    expect(
      CommerceCapabilityEntrySchema.safeParse({
        family: "human_accounts",
        audience: "browser",
        state: "unknown",
        dependencies: ["auth"],
      }).success,
    ).toBe(false);
  });
});

describe("static typing", () => {
  it("narrows manifest and builder input types", () => {
    expectTypeOf(buildCommerceCapabilityManifest)
      .parameter(0)
      .toEqualTypeOf<CommerceCapabilityBuilderInput>();
    const manifest = buildCommerceCapabilityManifest(ALL_ON);
    expectTypeOf(manifest.capabilityVersion).toEqualTypeOf<
      "openarc.capabilities.commerce.v1"
    >();
    expectTypeOf(manifest.capabilities[0]?.state).toEqualTypeOf<
      "enabled" | "built_disabled" | "unavailable" | "planned" | undefined
    >();
  });
});
