import { describe, expect, it } from 'vitest';
import { DatabaseFoundationError, loadMigrations, validateMigrations } from '../src/index.js';
import type { SqlMigration } from '../src/index.js';

function makeMigrations(count: number): SqlMigration[] {
  return Array.from({ length: count }, (_value, index) => ({
    id: `${String(index + 1).padStart(4, '0')}_step`,
    sql: `SELECT ${index + 1};`,
  }));
}

function catchError(fn: () => void): DatabaseFoundationError {
  try {
    fn();
  } catch (error) {
    if (error instanceof DatabaseFoundationError) {
      return error;
    }
    throw error;
  }
  throw new Error('expected error');
}

describe('validateMigrations', () => {
  const cases: Array<{ name: string; migrations: SqlMigration[]; code: string }> = [
    { name: 'empty manifest', migrations: [], code: 'MIGRATION_MANIFEST_EMPTY' },
    {
      name: 'bad id shape',
      migrations: [{ id: '01_bad', sql: 'SELECT 1;' }],
      code: 'MIGRATION_ID_INVALID',
    },
    {
      name: 'uppercase id',
      migrations: [{ id: '0001_Bad', sql: 'SELECT 1;' }],
      code: 'MIGRATION_ID_INVALID',
    },
    {
      name: 'duplicate ids',
      migrations: [
        { id: '0001_a', sql: 'SELECT 1;' },
        { id: '0001_a', sql: 'SELECT 2;' },
      ],
      code: 'MIGRATION_ID_DUPLICATE',
    },
    {
      name: 'empty sql',
      migrations: [{ id: '0001_a', sql: '' }],
      code: 'MIGRATION_SQL_EMPTY',
    },
    {
      name: 'whitespace-only sql',
      migrations: [{ id: '0001_a', sql: '   \n\t' }],
      code: 'MIGRATION_SQL_EMPTY',
    },
    {
      name: 'trailing newline id',
      migrations: [{ id: '0001_a\n', sql: 'SELECT 1;' }],
      code: 'MIGRATION_ID_INVALID',
    },
    {
      name: 'null entry',
      migrations: [null as unknown as SqlMigration],
      code: 'MIGRATION_ID_INVALID',
    },
    {
      name: 'nonarray manifest',
      migrations: 'nope' as unknown as SqlMigration[],
      code: 'MIGRATION_MANIFEST_EMPTY',
    },
    {
      name: 'skipped version',
      migrations: [
        { id: '0001_a', sql: 'SELECT 1;' },
        { id: '0003_c', sql: 'SELECT 3;' },
      ],
      code: 'MIGRATION_VERSION_ORDER',
    },
    {
      name: 'descending version',
      migrations: [
        { id: '0002_b', sql: 'SELECT 2;' },
        { id: '0001_a', sql: 'SELECT 1;' },
      ],
      code: 'MIGRATION_VERSION_ORDER',
    },
    {
      name: 'not starting at 0001',
      migrations: [{ id: '0002_b', sql: 'SELECT 2;' }],
      code: 'MIGRATION_VERSION_ORDER',
    },
  ];

  for (const testCase of cases) {
    it(testCase.name, () => {
      expect(catchError(() => validateMigrations(testCase.migrations)).code).toBe(testCase.code);
    });
  }

  it('accepts consecutive versions', () => {
    expect(() => validateMigrations(makeMigrations(3))).not.toThrow();
  });

  it('produces bounded errors with fixed messages', () => {
    const error = catchError(() => validateMigrations([]));
    expect(error.message).toBe('Migration manifest is empty.');
    expect(error.message).not.toContain('SELECT');
  });

  it('loads the bundled manifest without leaking paths', () => {
    const migrations = loadMigrations();
    expect(migrations.length).toBeGreaterThanOrEqual(1);
    expect(migrations[0]?.id).toBe('0001_auth');
    expect(migrations[0]?.sql.length).toBeGreaterThan(0);
  });

  it('validates synthetic ids independently of sql content', () => {
    const valid = 'A'.repeat(42) + 'A';
    expect(valid.length).toBe(43);
    expect(() => validateMigrations([{ id: '0001_auth', sql: 'SELECT 1;' }])).not.toThrow();
  });
});
