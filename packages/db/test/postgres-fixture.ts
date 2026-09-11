import { Pool } from 'pg';

/**
 * Shared disposable-fixture bootstrap for the PostgreSQL suites.
 *
 * Each suite calls these helpers in its own beforeAll so it bootstraps the
 * exact fixture roles independently; the suites are run sequentially by the
 * `test:postgres` script to avoid shared-schema races.
 */

const RAW_FIXTURE_URL = process.env['OPENARC_TEST_DATABASE_URL'];

export const MIGRATOR_PASSWORD = 'openarc_migrator_test_pw';
export const APP_PASSWORD = 'openarc_auth_app_test_pw';

export function assertFixtureUrl(raw: string | undefined): string {
  if (raw === undefined) {
    throw new Error('OPENARC_TEST_DATABASE_URL is required (fixture disposable database).');
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('OPENARC_TEST_DATABASE_URL is not a valid URL.');
  }
  const port = Number.parseInt(url.port, 10);
  const safe =
    (url.protocol === 'postgres:' || url.protocol === 'postgresql:') &&
    url.username === 'postgres' &&
    url.password === 'openarc_disposable_test' &&
    url.hostname === '127.0.0.1' &&
    Number.isInteger(port) &&
    port > 0 &&
    port <= 65535 &&
    url.pathname === '/openarc_auth_test' &&
    url.search === '' &&
    url.hash === '';
  if (!safe) {
    throw new Error('OPENARC_TEST_DATABASE_URL must be the exact disposable fixture URL.');
  }
  return raw;
}

export const fixtureUrl: string = assertFixtureUrl(RAW_FIXTURE_URL);

export function adminPool(): Pool {
  return new Pool({ connectionString: fixtureUrl, max: 2 });
}

export function migratorUrl(): string {
  return fixtureUrl.replace(
    'postgres:openarc_disposable_test',
    `openarc_migrator:${MIGRATOR_PASSWORD}`,
  );
}

export function appUrl(): string {
  return fixtureUrl.replace(
    'postgres:openarc_disposable_test',
    `openarc_auth_app:${APP_PASSWORD}`,
  );
}

export async function resetSchema(admin: Pool): Promise<void> {
  const client = await admin.connect();
  try {
    await client.query('DROP SCHEMA IF EXISTS openarc_meta CASCADE');
    await client.query('DROP SCHEMA IF EXISTS openarc_auth CASCADE');
  } finally {
    client.release();
  }
}

export async function ensureRoles(admin: Pool): Promise<void> {
  const client = await admin.connect();
  try {
    const roleResult = await client.query<{ rolname: string }>('SELECT rolname FROM pg_roles');
    const names = new Set(roleResult.rows.map((row) => row.rolname));
    if (!names.has('openarc_migrator')) {
      await client.query(
        `CREATE ROLE openarc_migrator LOGIN PASSWORD '${MIGRATOR_PASSWORD}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS`,
      );
    }
    if (!names.has('openarc_auth_app')) {
      await client.query(
        `CREATE ROLE openarc_auth_app LOGIN PASSWORD '${APP_PASSWORD}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS`,
      );
    }
    // Pin the exact fixture role attributes even if a prior run created them
    // with different state, so both suites observe identical roles.
    await client.query(
      `ALTER ROLE openarc_migrator WITH LOGIN PASSWORD '${MIGRATOR_PASSWORD}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS`,
    );
    await client.query(
      `ALTER ROLE openarc_auth_app WITH LOGIN PASSWORD '${APP_PASSWORD}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS`,
    );
    await client.query('GRANT CREATE, CONNECT ON DATABASE openarc_auth_test TO openarc_migrator');
    await client.query('GRANT CONNECT ON DATABASE openarc_auth_test TO openarc_auth_app');
    await client.query('GRANT USAGE ON SCHEMA public TO openarc_auth_app');
  } finally {
    client.release();
  }
}
