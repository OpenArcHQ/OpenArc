export function accountAccessEnabled(
  value: string | boolean | undefined = accountAccessFlag(),
): boolean {
  return value === true || value === "true";
}

/**
 * Reads the build flag without relying on a particular `ImportMeta.env` type
 * augmentation being in scope (the test-only tsconfig omits vite/client).
 */
function accountAccessFlag(): string | boolean | undefined {
  const env = (import.meta as unknown as { env?: Record<string, string | boolean | undefined> }).env;
  return env?.VITE_ACCOUNT_ACCESS_ENABLED;
}
