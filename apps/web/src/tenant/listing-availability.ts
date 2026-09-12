import { accountAccessEnabled } from "../account/availability.js";
import { apiBoundaryEnabled } from "../app/availability.js";
import { tenantReadsEnabled } from "./availability.js";

/**
 * The listing-management surface is a strict superset of the protected tenant
 * reads and the API privacy boundary: it mounts only when the listing flag is
 * exactly true AND account access, tenant reads and the API boundary are all
 * enabled. It deliberately does NOT depend on `VITE_TENANT_WRITES_ENABLED` or
 * the machine-credential flag: listing writes have their own server authority.
 *
 * All values default to false so a disabled deployment makes zero additional
 * listing or capability requests.
 */
export function listingManagementEnabled(
  listing: string | boolean | undefined,
  reads: string | boolean | undefined,
  account: string | boolean | undefined,
  apiBoundary: string | boolean | undefined,
): boolean {
  return (
    listingFlagValue(listing) &&
    tenantReadsEnabled(reads) &&
    accountAccessEnabled(account) &&
    apiBoundaryEnabled(apiBoundary)
  );
}

function listingFlagValue(value: string | boolean | undefined): boolean {
  return value === true || value === "true";
}

export function listingManagementFlag(): string | boolean | undefined {
  const env = (import.meta as unknown as { env?: Record<string, string | boolean | undefined> }).env;
  return env?.VITE_LISTING_MANAGEMENT_ENABLED;
}

/** Reads the effective flag from the Vite environment (default false). */
export function listingManagementEnabledFromEnv(): boolean {
  const env = (import.meta as unknown as { env?: Record<string, string | boolean | undefined> }).env;
  return listingManagementEnabled(
    env?.VITE_LISTING_MANAGEMENT_ENABLED,
    env?.VITE_TENANT_READS_ENABLED,
    env?.VITE_ACCOUNT_ACCESS_ENABLED,
    env?.VITE_API_BOUNDARY_ENABLED,
  );
}
