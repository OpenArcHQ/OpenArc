/**
 * The public marketplace catalog is gated by its OWN build flag. The default is
 * false; only the exact boolean `true` or the exact string `"true"` enables it.
 * Every other value (including `"TRUE"`, `"1"`, `"yes"` and `undefined`) fails
 * closed.
 */
export function marketCatalogEnabled(
  value: string | boolean | undefined = marketCatalogFlag(),
): boolean {
  return value === true || value === "true";
}

/**
 * Reads the build flag without relying on a particular `ImportMeta.env` type
 * augmentation being in scope (the test-only tsconfig omits vite/client).
 */
function marketCatalogFlag(): string | boolean | undefined {
  const env = (import.meta as unknown as {
    env?: Record<string, string | boolean | undefined>;
  }).env;
  return env?.VITE_MARKET_CATALOG_ENABLED;
}

/**
 * Catalog clients/controllers are created only when the marketplace flag is
 * exactly true AND the accepted API boundary is enabled. The two flags are
 * independent: neither infers the other, and a disabled API boundary keeps the
 * public routes built-but-disabled with zero requests.
 */
export function marketCatalogReady(
  market: string | boolean | undefined,
  apiBoundary: string | boolean | undefined,
): boolean {
  return marketCatalogEnabled(market) && marketApiBoundaryEnabled(apiBoundary);
}

/**
 * The capability-fetch surface (used by `/status` and the catalog bootstrap)
 * requires only the accepted API boundary. It never depends on the catalog
 * flag, and it never queries the catalog or a protected resource.
 */
export function marketCapabilitiesEnabled(
  apiBoundary: string | boolean | undefined = marketApiBoundaryFlag(),
): boolean {
  return marketApiBoundaryEnabled(apiBoundary);
}

function marketApiBoundaryFlag(): string | boolean | undefined {
  const env = (import.meta as unknown as {
    env?: Record<string, string | boolean | undefined>;
  }).env;
  return env?.VITE_API_BOUNDARY_ENABLED;
}

/**
 * Reads the accepted API boundary flag structurally, matching the frozen
 * `app/availability.ts` semantics (`true` or the exact string `"true"`) without
 * depending on a particular `ImportMeta.env` type augmentation.
 */
export function marketApiBoundaryEnabled(
  value: string | boolean | undefined = marketApiBoundaryFlag(),
): boolean {
  return value === true || value === "true";
}

/**
 * Convenience read of both build flags for the app shell. Equivalent to
 * `marketCatalogReady(marketCatalogFlag(), marketApiBoundaryFlag())`; defined
 * here so no module outside this one touches `import.meta.env`.
 */
export function marketCatalogActive(): boolean {
  return marketCatalogReady(marketCatalogFlag(), marketApiBoundaryFlag());
}
