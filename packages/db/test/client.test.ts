import { describe, expect, it } from 'vitest';
import { createDatabasePool, DatabaseFoundationError } from '../src/index.js';

function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    if (error instanceof DatabaseFoundationError) {
      return error.code;
    }
    throw error;
  }
  throw new Error('expected error');
}

interface PoolOptions {
  host?: string;
  port?: number;
  database?: string;
  user?: string;
  password?: string;
  ssl?: unknown;
  max?: number;
}

function optionsOf(url: string): PoolOptions {
  const pool = createDatabasePool(url);
  const options = pool.options as unknown as PoolOptions;
  void pool.end().catch(() => undefined);
  return options;
}

describe('createDatabasePool URL policy', () => {
  const cases: Array<{ name: string; url: string; code: string }> = [
    { name: 'reject http protocol', url: 'http://u:p@localhost:5432/db', code: 'DATABASE_URL_INVALID' },
    { name: 'reject fragment', url: 'postgres://u:p@localhost:5432/db#frag', code: 'DATABASE_URL_INVALID' },
    { name: 'reject no database', url: 'postgres://u:p@localhost:5432/', code: 'DATABASE_URL_INVALID' },
    { name: 'reject multi-segment database', url: 'postgres://u:p@localhost:5432/a/b', code: 'DATABASE_URL_INVALID' },
    { name: 'reject empty user', url: 'postgres://:p@localhost:5432/db', code: 'DATABASE_URL_INVALID' },
    { name: 'reject repeated query param', url: 'postgres://u:p@localhost:5432/db?sslmode=disable&sslmode=disable', code: 'DATABASE_URL_INVALID' },
    { name: 'reject unknown query param', url: 'postgres://u:p@localhost:5432/db?sslmode=disable&foo=bar', code: 'DATABASE_URL_INVALID' },
    { name: 'reject empty query value', url: 'postgres://u:p@localhost:5432/db?sslmode=', code: 'DATABASE_URL_INVALID' },
    { name: 'reject nonstring', url: undefined as unknown as string, code: 'DATABASE_URL_INVALID' },
    { name: 'reject oversized', url: `postgres://u:p@localhost:5432/${'x'.repeat(5000)}`, code: 'DATABASE_URL_INVALID' },
    { name: 'reject remote without sslmode', url: 'postgres://u:p@db.example.com:5432/db', code: 'DATABASE_URL_TLS_INSECURE' },
    { name: 'reject remote disable', url: 'postgres://u:p@db.example.com:5432/db?sslmode=disable', code: 'DATABASE_URL_TLS_INSECURE' },
    { name: 'reject prefer downgrade', url: 'postgres://u:p@db.example.com:5432/db?sslmode=prefer', code: 'DATABASE_URL_TLS_INSECURE' },
    { name: 'reject require', url: 'postgres://u:p@db.example.com:5432/db?sslmode=require', code: 'DATABASE_URL_TLS_INSECURE' },
    { name: 'reject loopback disable false host', url: 'postgres://u:p@localhost.evil.com:5432/db?sslmode=disable', code: 'DATABASE_URL_TLS_INSECURE' },
  ];

  for (const testCase of cases) {
    it(testCase.name, () => {
      expect(codeOf(() => createDatabasePool(testCase.url))).toBe(testCase.code);
    });
  }

  it('allows loopback without query', () => {
    expect(optionsOf('postgres://u:p@127.0.0.1:5432/db').host).toBe('127.0.0.1');
  });

  it('allows loopback sslmode disable', () => {
    const options = optionsOf('postgresql://u:p@localhost:5432/db?sslmode=disable');
    expect(options.database).toBe('db');
    expect(options.ssl).toBeUndefined();
  });

  it('allows ::1 loopback', () => {
    expect(optionsOf('postgres://u:p@[::1]:5432/db').host).toBe('::1');
  });

  it('sets ssl rejectUnauthorized for verify-full', () => {
    const options = optionsOf('postgres://u:p@db.example.com:5432/db?sslmode=verify-full');
    expect(options.ssl).toEqual({ rejectUnauthorized: true });
    expect(options.max).toBe(5);
  });

  it('decodes credentials and database', () => {
    const options = optionsOf('postgres://u%40:p%3A@127.0.0.1:5432/db%20x');
    expect(options.user).toBe('u@');
    expect(options.password).toBe('p:');
    expect(options.database).toBe('db x');
  });
});
