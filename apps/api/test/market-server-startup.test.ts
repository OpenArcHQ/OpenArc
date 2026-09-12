import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Startup ownership regressions for server.ts.
 *
 * Every runtime factory and `createApp`/`listen` is HONESTLY MOCKED (labelled):
 * these tests prove that resource acquisition happens under the SAME cleanup
 * try/finally, that a market start rejection closes the earlier auth+tenant
 * runtimes exactly once, that a later machine rejection closes the market
 * runtime too, that listen failure/normal shutdown retain their behavior, and
 * that all-off / catalog-only (AUTH false) / no-auth startups wire the market
 * runtime with the correct explicit arguments. No real server, network,
 * database or secret is constructed.
 */

interface Handle {
  name: string;
  closeCalls: number;
  order: string[];
}

type ServerConfig = Record<string, unknown>;

const state = vi.hoisted(() => ({
  order: [] as string[],
  handles: new Map<string, Handle>(),
  authError: false,
  tenantError: false,
  marketError: false,
  machineError: false,
  listenError: false,
  createAppError: false,
  closeCalls: [] as string[],
  exitCalls: 0,
  closed: 0,
  marketArgs: undefined as Record<string, unknown> | undefined,
  createAppArgs: undefined as Record<string, unknown> | undefined,
  marketStarts: 0,
  config: {} as ServerConfig,
}));

function defaultConfig(): ServerConfig {
  return {
    NODE_ENV: "test",
    AUTH_ENABLED: true,
    AUTH_DATABASE_URL: "postgres://openarc_auth_app:x@127.0.0.1:5432/openarc_auth_test",
    AUTH_SECRET: "synthetic_auth_secret_for_market_startup_0123456789",
    AUTH_RP_ID: "localhost",
    AUTH_RATE_GLOBAL_PER_MINUTE: 60,
    AUTH_RATE_PEER_PER_HOUR: 600,
    AUTH_RATE_BINDING_PER_HOUR: 60,
    AUTH_RATE_RECOVERY_PER_15MIN: 10,
    APP_ORIGIN: "http://localhost:5183",
    TENANT_READS_ENABLED: true,
    TENANT_WRITES_ENABLED: false,
    TENANT_DATABASE_URL: "postgres://openarc_tenant_app:y@127.0.0.1:5432/openarc_auth_test",
    MARKET_CATALOG_ENABLED: false,
    LISTING_MANAGEMENT_ENABLED: true,
    MARKET_MODERATION_ENABLED: false,
    MACHINE_CREDENTIAL_MANAGEMENT_ENABLED: true,
    MACHINE_SESSION_EXCHANGE_ENABLED: false,
    MACHINE_CREDENTIAL_PEPPER_VERSION: 1,
    MACHINE_CREDENTIAL_PEPPER: "synthetic_pepper",
    MACHINE_RATE_SECRET: "synthetic_rate_secret",
    ARC_OBSERVATION_ENABLED: false,
    REDIS_URL: undefined,
    COMMIT_SHA: "0123456789abcdef0123456789abcdef01234567",
    HOST: "127.0.0.1",
    PORT: 0,
  };
}

function makeHandle(name: string): Handle {
  const handle: Handle = { name, closeCalls: 0, order: state.order };
  state.handles.set(name, handle);
  return handle;
}

vi.mock("../src/auth/runtime.js", () => ({
  startAuthRuntime: async () => {
    state.order.push("auth");
    if (state.authError) throw new Error("AUTH_START_FAILED");
    const handle = makeHandle("auth");
    return {
      service: {},
      rateLimitStore: {},
      ready: async () => true,
      close: async () => {
        handle.closeCalls += 1;
        state.closeCalls.push("auth");
      },
    };
  },
}));

vi.mock("../src/tenant/runtime.js", () => ({
  startTenantRuntime: async () => {
    state.order.push("tenant");
    if (state.tenantError) throw new Error("TENANT_START_FAILED");
    const handle = makeHandle("tenant");
    return {
      service: {},
      ready: async () => true,
      close: async () => {
        handle.closeCalls += 1;
        state.closeCalls.push("tenant");
      },
    };
  },
}));

vi.mock("../src/market/runtime.js", () => ({
  startMarketRuntime: async (options: Record<string, unknown>) => {
    state.order.push("market");
    state.marketStarts += 1;
    state.marketArgs = options;
    if (state.marketError) throw new Error("MARKET_START_FAILED");
    const handle = makeHandle("market");
    const listing = options.listingManagementEnabled === true;
    const moderation = options.moderationEnabled === true;
    const catalog = options.catalogEnabled === true;
    return {
      // Mirrors the real runtime: only the enabled stores' services exist.
      ...(listing ? { service: {} } : {}),
      ...(listing || moderation ? { lifecycleService: {} } : {}),
      ...(catalog ? { catalogService: {} } : {}),
      ready: async () => true,
      close: async () => {
        handle.closeCalls += 1;
        state.closeCalls.push("market");
      },
    };
  },
}));

vi.mock("../src/machine/runtime.js", () => ({
  startMachineRuntime: async () => {
    state.order.push("machine");
    if (state.machineError) throw new Error("MACHINE_START_FAILED");
    const handle = makeHandle("machine");
    return {
      managementService: {},
      sessionService: {},
      ready: async () => true,
      close: async () => {
        handle.closeCalls += 1;
        state.closeCalls.push("machine");
      },
    };
  },
}));

vi.mock("../src/app.js", () => ({
  createApp: (options: Record<string, unknown>) => {
    state.order.push("createApp");
    state.createAppArgs = options;
    if (state.createAppError) throw new Error("CREATE_APP_FAILED");
    return {
      close: async () => {
        state.closed += 1;
      },
      listen: async () => {
        state.order.push("listen");
        if (state.listenError) throw new Error("LISTEN_FAILED");
      },
    };
  },
}));

vi.mock("../src/config.js", () => ({
  loadConfig: () => state.config,
}));

async function loadServer(): Promise<void> {
  vi.resetModules();
  await import("../src/server.js");
  // Let the fire-and-forget start() settle.
  await new Promise((resolve) => setTimeout(resolve, 0));
}

let signalHandlers: Array<() => void> = [];

beforeEach(() => {
  state.order = [];
  state.handles = new Map();
  state.authError = false;
  state.tenantError = false;
  state.marketError = false;
  state.machineError = false;
  state.listenError = false;
  state.createAppError = false;
  state.closeCalls = [];
  state.exitCalls = 0;
  state.closed = 0;
  state.marketArgs = undefined;
  state.createAppArgs = undefined;
  state.marketStarts = 0;
  state.config = defaultConfig();
  signalHandlers = [];
  vi.spyOn(process, "once").mockImplementation(((event: string, handler: () => void) => {
    if (event === "SIGINT" || event === "SIGTERM") signalHandlers.push(handler);
    return process;
  }) as never);
  vi.spyOn(process, "exit").mockImplementation((() => {
    state.exitCalls += 1;
    return undefined;
  }) as never);
});

afterEach(() => {
  vi.restoreAllMocks();
});

function closeCount(name: string): number {
  return state.handles.get(name)?.closeCalls ?? 0;
}

describe("server startup resource ownership", () => {
  it("closes the earlier auth and tenant runtimes exactly once when market start rejects", async () => {
    state.marketError = true;
    await loadServer();
    expect(state.order).toEqual(["auth", "tenant", "market"]);
    expect(closeCount("auth")).toBe(1);
    expect(closeCount("tenant")).toBe(1);
    expect(closeCount("market")).toBe(0);
    expect(state.exitCalls).toBe(1);
  });

  it("closes the prior market runtime too when a later machine start rejects", async () => {
    state.machineError = true;
    await loadServer();
    expect(state.order).toEqual(["auth", "tenant", "market", "machine"]);
    expect(closeCount("auth")).toBe(1);
    expect(closeCount("tenant")).toBe(1);
    expect(closeCount("market")).toBe(1);
    expect(closeCount("machine")).toBe(0);
  });

  it("closes the app, auth, tenant and market once when createApp/listen fails", async () => {
    state.listenError = true;
    await loadServer();
    expect(state.order).toContain("listen");
    expect(closeCount("auth")).toBe(1);
    expect(closeCount("tenant")).toBe(1);
    expect(closeCount("market")).toBe(1);
    expect(closeCount("machine")).toBe(1);
    expect(state.closed).toBe(1);
  });

  it("wires a successful startup and closes each runtime exactly once on shutdown", async () => {
    await loadServer();
    expect(state.order).toEqual([
      "auth",
      "tenant",
      "market",
      "machine",
      "createApp",
      "listen",
    ]);
    expect(closeCount("auth")).toBe(0);
    expect(state.closed).toBe(0);
    expect(signalHandlers).toHaveLength(2);

    // Trigger one registered shutdown path and await its async chain.
    signalHandlers[0]?.();
    await vi.waitFor(() => {
      expect(state.exitCalls).toBe(1);
    });
    expect(state.closed).toBe(1);
    expect(closeCount("auth")).toBe(1);
    expect(closeCount("tenant")).toBe(1);
    expect(closeCount("market")).toBe(1);
    expect(closeCount("machine")).toBe(1);
    expect(state.exitCalls).toBe(1);
  });

  it("passes explicit three booleans plus auth and wires the new services", async () => {
    await loadServer();
    expect(state.marketArgs).toMatchObject({
      catalogEnabled: false,
      listingManagementEnabled: true,
      moderationEnabled: false,
      marketDatabaseUrl: state.config.TENANT_DATABASE_URL,
    });
    expect(state.marketArgs?.auth).toBeDefined();
    expect(state.createAppArgs?.marketService).toBeDefined();
    expect(state.createAppArgs?.marketLifecycleService).toBeDefined();
    expect(state.createAppArgs?.marketCatalogService).toBeUndefined();
    // No lingering process listeners beyond the two shutdown handlers.
    expect(signalHandlers).toHaveLength(2);
  });

  it("does not start the market runtime when all three market flags are off", async () => {
    state.config.LISTING_MANAGEMENT_ENABLED = false;
    state.config.MARKET_CATALOG_ENABLED = false;
    state.config.MARKET_MODERATION_ENABLED = false;
    state.config.MACHINE_CREDENTIAL_MANAGEMENT_ENABLED = false;
    await loadServer();
    expect(state.marketStarts).toBe(0);
    expect(state.order).toEqual(["auth", "tenant", "createApp", "listen"]);
    expect(state.createAppArgs?.marketReady).toBeUndefined();
    expect(state.createAppArgs?.marketService).toBeUndefined();
    signalHandlers[0]?.();
    await vi.waitFor(() => {
      expect(state.exitCalls).toBe(1);
    });
    expect(closeCount("auth")).toBe(1);
    expect(closeCount("tenant")).toBe(1);
  });

  it("starts a catalog-only, AUTH-false runtime without an auth port or services", async () => {
    state.config.AUTH_ENABLED = false;
    state.config.TENANT_READS_ENABLED = false;
    state.config.TENANT_WRITES_ENABLED = false;
    state.config.LISTING_MANAGEMENT_ENABLED = false;
    state.config.MARKET_CATALOG_ENABLED = true;
    state.config.MARKET_MODERATION_ENABLED = false;
    state.config.MACHINE_CREDENTIAL_MANAGEMENT_ENABLED = false;
    state.config.MACHINE_SESSION_EXCHANGE_ENABLED = false;
    await loadServer();
    expect(state.order).toEqual(["market", "createApp", "listen"]);
    expect(state.marketArgs).toMatchObject({
      catalogEnabled: true,
      listingManagementEnabled: false,
      moderationEnabled: false,
    });
    // Catalog-only must not receive (or dereference) an auth seam.
    expect(state.marketArgs?.auth).toBeUndefined();
    expect(state.createAppArgs?.marketCatalogService).toBeDefined();
    expect(state.createAppArgs?.marketService).toBeUndefined();
    expect(state.createAppArgs?.marketLifecycleService).toBeUndefined();
    expect(state.createAppArgs?.authService).toBeUndefined();
    expect(state.createAppArgs?.tenantReadService).toBeUndefined();
    signalHandlers[0]?.();
    await vi.waitFor(() => {
      expect(state.exitCalls).toBe(1);
    });
    expect(closeCount("market")).toBe(1);
  });

  it("starts a moderation-only runtime with auth but no tenant/listing service", async () => {
    state.config.TENANT_READS_ENABLED = false;
    state.config.LISTING_MANAGEMENT_ENABLED = false;
    state.config.MARKET_MODERATION_ENABLED = true;
    state.config.MACHINE_CREDENTIAL_MANAGEMENT_ENABLED = false;
    await loadServer();
    expect(state.marketArgs).toMatchObject({
      catalogEnabled: false,
      listingManagementEnabled: false,
      moderationEnabled: true,
    });
    expect(state.marketArgs?.auth).toBeDefined();
    expect(state.createAppArgs?.marketLifecycleService).toBeDefined();
    expect(state.createAppArgs?.marketService).toBeUndefined();
    expect(state.createAppArgs?.marketCatalogService).toBeUndefined();
  });

  it("tears down every acquired runtime when createApp itself rejects", async () => {
    state.createAppError = true;
    await loadServer();
    expect(closeCount("auth")).toBe(1);
    expect(closeCount("tenant")).toBe(1);
    expect(closeCount("market")).toBe(1);
    expect(closeCount("machine")).toBe(1);
    expect(state.closed).toBe(0);
    expect(state.exitCalls).toBe(1);
  });
});
