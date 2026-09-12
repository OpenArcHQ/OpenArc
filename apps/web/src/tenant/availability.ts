import { accountAccessEnabled } from "../account/availability.js";

export function tenantReadsEnabled(
  value: string | boolean | undefined = tenantReadsFlag(),
): boolean {
  return value === true || value === "true";
}

function tenantReadsFlag(): string | boolean | undefined {
  const env = (import.meta as unknown as { env?: Record<string, string | boolean | undefined> }).env;
  return env?.VITE_TENANT_READS_ENABLED;
}

export function tenantWritesEnabled(
  value: string | boolean | undefined = tenantWritesFlag(),
): boolean {
  return value === true || value === "true";
}

/**
 * Writes are a strict superset of reads: the write flag alone never enables
 * the surface. Callers must also require reads, account access and the API
 * boundary before constructing any write client, controller or form.
 */
export function tenantMutationEnabled(
  writes: string | boolean | undefined,
  reads: string | boolean | undefined,
  account: string | boolean | undefined,
): boolean {
  return tenantReadsEnabled(reads) && accountAccessEnabled(account) && tenantWritesEnabled(writes);
}

function tenantWritesFlag(): string | boolean | undefined {
  const env = (import.meta as unknown as { env?: Record<string, string | boolean | undefined> }).env;
  return env?.VITE_TENANT_WRITES_ENABLED;
}
