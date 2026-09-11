import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Pool, PoolClient } from 'pg';
import { DatabaseFoundationError } from './client.js';

export interface SqlMigration {
  id: string;
  sql: string;
}

interface AppliedMigration {
  id: string;
  checksum: string;
}

const MIGRATION_ID_PATTERN = /^(\d{4})_([a-z0-9_]+)$/;
const MIGRATION_LOCK_ID = 874261035;

function migrationsDirectory(): string {
  return fileURLToPath(new URL('../migrations/', import.meta.url));
}

function migrationChecksum(sql: string): string {
  return createHash('sha256').update(sql, 'utf8').digest('hex');
}

export function validateMigrations(migrations: readonly SqlMigration[]): void {
  if (!Array.isArray(migrations)) {
    throw new DatabaseFoundationError('MIGRATION_MANIFEST_EMPTY');
  }
  if (migrations.length === 0) {
    throw new DatabaseFoundationError('MIGRATION_MANIFEST_EMPTY');
  }
  const seen = new Set<string>();
  let expectedVersion = 1;
  for (const migration of migrations) {
    if (migration === null || typeof migration !== 'object') {
      throw new DatabaseFoundationError('MIGRATION_ID_INVALID');
    }
    if (typeof migration.id !== 'string' || migration.id.endsWith('\n') || seen.has(migration.id)) {
      throw new DatabaseFoundationError(
        seen.has(migration.id) ? 'MIGRATION_ID_DUPLICATE' : 'MIGRATION_ID_INVALID',
      );
    }
    const match = MIGRATION_ID_PATTERN.exec(migration.id);
    if (match === null) {
      throw new DatabaseFoundationError('MIGRATION_ID_INVALID');
    }
    if (typeof migration.sql !== 'string' || migration.sql.trim().length === 0) {
      throw new DatabaseFoundationError('MIGRATION_SQL_EMPTY');
    }
    const version = Number.parseInt(match[1] ?? '', 10);
    if (version !== expectedVersion) {
      throw new DatabaseFoundationError('MIGRATION_VERSION_ORDER');
    }
    seen.add(migration.id);
    expectedVersion += 1;
  }
}

export function loadMigrations(): SqlMigration[] {
  let migrations: SqlMigration[];
  try {
    const directory = migrationsDirectory();
    const files = readdirSync(directory)
      .filter((file) => file.endsWith('.sql'))
      .sort();
    migrations = files.map((file) => ({
      id: file.slice(0, -'.sql'.length),
      sql: readFileSync(join(directory, file), 'utf8'),
    }));
  } catch {
    throw new DatabaseFoundationError('MIGRATION_MANIFEST_UNREADABLE');
  }
  validateMigrations(migrations);
  return migrations;
}

async function ensureMetadata(client: PoolClient): Promise<void> {
  await client.query('CREATE SCHEMA IF NOT EXISTS openarc_meta');
  await client.query(
    'CREATE TABLE IF NOT EXISTS openarc_meta.schema_migrations (' +
      'id text PRIMARY KEY, ' +
      'checksum text NOT NULL, ' +
      'applied_at timestamptz NOT NULL DEFAULT clock_timestamp())',
  );
  await client.query('REVOKE ALL ON SCHEMA openarc_meta FROM PUBLIC');
  await client.query('GRANT USAGE ON SCHEMA openarc_meta TO openarc_auth_app');
  await client.query(
    'GRANT SELECT ON openarc_meta.schema_migrations TO openarc_auth_app',
  );
}

async function loadApplied(client: PoolClient): Promise<AppliedMigration[]> {
  const result = await client.query<AppliedMigration>(
    'SELECT id, checksum FROM openarc_meta.schema_migrations ORDER BY id',
  );
  return result.rows;
}

function assertPrefixMatchesManifest(
  applied: readonly AppliedMigration[],
  migrations: readonly SqlMigration[],
): void {
  for (let index = 0; index < applied.length; index += 1) {
    const record = applied[index];
    const manifest = migrations[index];
    if (record === undefined || manifest === undefined) {
      throw new DatabaseFoundationError('MIGRATION_DB_MISMATCH');
    }
    if (record.id !== manifest.id) {
      throw new DatabaseFoundationError('MIGRATION_DB_MISMATCH');
    }
    if (record.checksum !== migrationChecksum(manifest.sql)) {
      throw new DatabaseFoundationError('MIGRATION_CHECKSUM_DRIFT');
    }
  }
}

export async function migrate(
  pool: Pool,
  migrations: readonly SqlMigration[] = loadMigrations(),
): Promise<void> {
  validateMigrations(migrations);
  let client: PoolClient | undefined;
  let locked = false;
  let cleanupFailed = false;
  try {
    client = await pool.connect();
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_ID]);
    locked = true;
    const roleResult = await client.query<{ current_user: string }>(
      'SELECT current_user AS current_user',
    );
    if (roleResult.rows[0]?.current_user !== 'openarc_migrator') {
      throw new DatabaseFoundationError('MIGRATION_ROLE_INVALID');
    }
    await ensureMetadata(client);
    const applied = await loadApplied(client);
    if (applied.length > migrations.length) {
      throw new DatabaseFoundationError('MIGRATION_DB_NEWER');
    }
    assertPrefixMatchesManifest(applied, migrations);
    for (let index = applied.length; index < migrations.length; index += 1) {
      const migration = migrations[index];
      if (migration === undefined) {
        break;
      }
      const checksum = migrationChecksum(migration.sql);
      await client.query('BEGIN');
      try {
        await client.query(migration.sql);
        await client.query(
          'INSERT INTO openarc_meta.schema_migrations (id, checksum) VALUES ($1, $2)',
          [migration.id, checksum],
        );
        await client.query('COMMIT');
      } catch {
        try {
          await client.query('ROLLBACK');
        } catch {
          cleanupFailed = true;
        }
        throw new DatabaseFoundationError('MIGRATION_APPLY_FAILED');
      }
    }
  } catch (error) {
    if (error instanceof DatabaseFoundationError) {
      throw error;
    }
    throw new DatabaseFoundationError('MIGRATION_FAILED');
  } finally {
    if (client !== undefined) {
      if (locked && !cleanupFailed) {
        try {
          await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_ID]);
        } catch {
          cleanupFailed = true;
        }
      }
      client.release(cleanupFailed);
    }
  }
}

export async function readSchemaVersion(pool: Pool): Promise<number> {
  const migrations = loadMigrations();
  let client: PoolClient | undefined;
  try {
    client = await pool.connect();
    const applied = await loadApplied(client);
    if (applied.length === 0) {
      throw new DatabaseFoundationError('MIGRATION_METADATA_MISSING');
    }
    if (applied.length > migrations.length) {
      throw new DatabaseFoundationError('MIGRATION_DB_NEWER');
    }
    assertPrefixMatchesManifest(applied, migrations);
    if (applied.length < migrations.length) {
      throw new DatabaseFoundationError('MIGRATION_METADATA_MISSING');
    }
    return applied.length;
  } catch (error) {
    if (error instanceof DatabaseFoundationError) {
      throw error;
    }
    throw new DatabaseFoundationError('MIGRATION_METADATA_MISSING');
  } finally {
    client?.release();
  }
}
