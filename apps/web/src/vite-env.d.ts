/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Only the exact string "true" enables the /account experience. */
  readonly VITE_ACCOUNT_ACCESS_ENABLED?: string;
  /** Only the exact string "true" enables the protected /app read surface. */
  readonly VITE_TENANT_READS_ENABLED?: string;
  /**
   * Only the exact string "true" enables the tenant mutation surface. It also
   * requires tenant reads, account access and the API boundary to be enabled.
   * Defaults to false when absent.
   */
  readonly VITE_TENANT_WRITES_ENABLED?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
