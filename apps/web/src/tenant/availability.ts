export function tenantReadsEnabled(
  value: string | boolean | undefined = tenantReadsFlag(),
): boolean {
  return value === true || value === "true";
}

function tenantReadsFlag(): string | boolean | undefined {
  const env = (import.meta as unknown as { env?: Record<string, string | boolean | undefined> }).env;
  return env?.VITE_TENANT_READS_ENABLED;
}
