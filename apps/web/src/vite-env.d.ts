/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Only the exact string "true" enables the /account experience. */
  readonly VITE_ACCOUNT_ACCESS_ENABLED?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
