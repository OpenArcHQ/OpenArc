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

/**
 * The machine credential console is the strictest surface: it mounts only when
 * the machine flag is exactly true AND account access, tenant reads and tenant
 * writes are all enabled. It never depends on a machine browser session, a
 * bearer transport or the API boundary flag alone. All defaults are false.
 */
export function machineCredentialEnabled(
  machine: string | boolean | undefined,
  writes: string | boolean | undefined,
  reads: string | boolean | undefined,
  account: string | boolean | undefined,
): boolean {
  return (
    machineCredentialFlagValue(machine) &&
    tenantMutationEnabled(writes, reads, account)
  );
}

function machineCredentialFlagValue(value: string | boolean | undefined): boolean {
  return value === true || value === "true";
}

export function machineCredentialFlag(): string | boolean | undefined {
  const env = (import.meta as unknown as { env?: Record<string, string | boolean | undefined> }).env;
  return env?.VITE_MACHINE_CREDENTIAL_MANAGEMENT_ENABLED;
}

function tenantWritesFlag(): string | boolean | undefined {
  const env = (import.meta as unknown as { env?: Record<string, string | boolean | undefined> }).env;
  return env?.VITE_TENANT_WRITES_ENABLED;
}
