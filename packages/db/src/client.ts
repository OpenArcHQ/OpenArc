import { Pool } from 'pg';

export const DATABASE_FOUNDATION_ERROR_MESSAGES = {
  DATABASE_URL_INVALID: 'Database connection URL is invalid.',
  DATABASE_URL_TLS_INSECURE: 'Database connection URL requires a secure TLS policy.',
  MIGRATION_MANIFEST_EMPTY: 'Migration manifest is empty.',
  MIGRATION_ID_INVALID: 'Migration identifier is invalid.',
  MIGRATION_SQL_EMPTY: 'Migration SQL is empty.',
  MIGRATION_ID_DUPLICATE: 'Migration identifiers are duplicated.',
  MIGRATION_VERSION_ORDER: 'Migration versions are not consecutive from 0001.',
  MIGRATION_ROLE_INVALID: 'Migration role is not permitted to migrate.',
  MIGRATION_DB_NEWER: 'Database contains migrations newer than the manifest.',
  MIGRATION_DB_MISMATCH: 'Database migration entries do not match the manifest.',
  MIGRATION_CHECKSUM_DRIFT: 'Applied migration checksum does not match the manifest.',
  MIGRATION_APPLY_FAILED: 'Migration outcome could not be confirmed; a lost COMMIT reply may mean the migration actually committed.',
  MIGRATION_METADATA_MISSING: 'Migration metadata is absent or incomplete.',
  MIGRATION_MANIFEST_UNREADABLE: 'Bundled migration manifest could not be read.',
  MIGRATION_FAILED: 'Migration could not be completed.',
} as const;

export type DatabaseFoundationErrorCode = keyof typeof DATABASE_FOUNDATION_ERROR_MESSAGES;

export class DatabaseFoundationError extends Error {
  readonly code: DatabaseFoundationErrorCode;

  constructor(code: DatabaseFoundationErrorCode) {
    super(DATABASE_FOUNDATION_ERROR_MESSAGES[code]);
    this.name = 'DatabaseFoundationError';
    this.code = code;
  }
}

interface DatabaseConnectionConfig {
  host: string;
  port?: number;
  database: string;
  user: string;
  password: string;
  ssl?: { rejectUnauthorized: true };
}

function invalidUrl(): DatabaseFoundationError {
  return new DatabaseFoundationError('DATABASE_URL_INVALID');
}

function insecureUrl(): DatabaseFoundationError {
  return new DatabaseFoundationError('DATABASE_URL_TLS_INSECURE');
}

function decodeComponent(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    throw invalidUrl();
  }
}

function isLoopbackHost(hostname: string): boolean {
  const host = hostname.startsWith('[') && hostname.endsWith(']')
    ? hostname.slice(1, -1)
    : hostname;
  return host === 'localhost' || host === '127.0.0.1' || host === '::1';
}

function normalizeHost(hostname: string): string {
  if (hostname.startsWith('[') && hostname.endsWith(']')) {
    return hostname.slice(1, -1);
  }
  return hostname;
}

function parseQuery(url: URL): Record<string, string> {
  const result: Record<string, string> = {};
  for (const key of url.searchParams.keys()) {
    if (key !== 'sslmode') {
      throw invalidUrl();
    }
    const values = url.searchParams.getAll(key);
    if (values.length !== 1) {
      throw invalidUrl();
    }
    const value = values[0];
    if (value === undefined || value === '') {
      throw invalidUrl();
    }
    result[key] = value;
  }
  return result;
}

function parseDatabaseUrl(connectionString: string): DatabaseConnectionConfig {
  if (typeof connectionString !== 'string' || connectionString.length === 0 || connectionString.length > 4096) {
    throw invalidUrl();
  }
  let url: URL;
  try {
    url = new URL(connectionString);
  } catch {
    throw invalidUrl();
  }
  if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') {
    throw invalidUrl();
  }
  if (url.hash !== '' || url.hostname === '' || url.username === '') {
    throw invalidUrl();
  }
  const pathSegments = url.pathname.split('/');
  if (pathSegments.length !== 2 || pathSegments[0] !== '' || pathSegments[1] === '') {
    throw invalidUrl();
  }
  const database = decodeComponent(pathSegments[1] ?? '');
  if (database === '') {
    throw invalidUrl();
  }
  let port: number | undefined;
  if (url.port !== '') {
    port = Number.parseInt(url.port, 10);
    if (!Number.isInteger(port) || port <= 0 || port > 65535) {
      throw invalidUrl();
    }
  }
  const query = parseQuery(url);
  const loopback = isLoopbackHost(url.hostname);
  const sslMode = query['sslmode'];
  if (sslMode !== undefined) {
    if (sslMode !== 'verify-full' && sslMode !== 'disable') {
      throw insecureUrl();
    }
    if (sslMode === 'disable' && !loopback) {
      throw insecureUrl();
    }
  } else if (!loopback) {
    throw insecureUrl();
  }
  const user = decodeComponent(url.username);
  if (user === '') {
    throw invalidUrl();
  }
  const config: DatabaseConnectionConfig = {
    host: normalizeHost(url.hostname),
    database,
    user,
    password: decodeComponent(url.password),
  };
  if (port !== undefined) {
    config.port = port;
  }
  if (sslMode === 'verify-full') {
    config.ssl = { rejectUnauthorized: true };
  }
  return config;
}

export function createDatabasePool(connectionString: string): Pool {
  const config = parseDatabaseUrl(connectionString);
  return new Pool({
    host: config.host,
    port: config.port,
    database: config.database,
    user: config.user,
    password: config.password,
    ssl: config.ssl,
    max: 5,
    connectionTimeoutMillis: 2000,
    idleTimeoutMillis: 10000,
    statement_timeout: 5000,
  });
}
