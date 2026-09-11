import { describe, expect, it } from 'vitest';
import { migrate } from '../src/index.js';
import type { Pool, PoolClient } from 'pg';

interface MockState {
  queries: string[];
  releases: boolean[];
  rollbacks: number;
}

interface MockOptions {
  unlockFails?: boolean;
  migrateFails?: boolean;
  rollbackFails?: boolean;
}

function makeClient(state: MockState, options: MockOptions = {}): PoolClient {
  const client = {
    query: async (text: string) => {
      state.queries.push(text);
      if (text.includes('ROLLBACK')) {
        state.rollbacks += 1;
        if (options.rollbackFails === true) {
          throw new Error('rollback failed');
        }
        return { rows: [] };
      }
      if (text.includes('pg_advisory_unlock') && options.unlockFails === true) {
        throw new Error('unlock failed');
      }
      if (text.includes('current_user')) {
        return { rows: [{ current_user: 'openarc_migrator' }] };
      }
      if (text.includes('SELECT id, checksum')) {
        return { rows: [] };
      }
      if (options.migrateFails === true && text.includes('FAILING MIGRATION')) {
        throw new Error('migration failed');
      }
      return { rows: [] };
    },
    release: (discard?: boolean) => {
      state.releases.push(discard === true);
    },
  };
  return client as unknown as PoolClient;
}

function makePool(client: PoolClient): Pool {
  return { connect: async () => client } as unknown as Pool;
}

const MANIFEST = [{ id: '0001_test', sql: 'SELECT 1;' }];
const FAILING_MANIFEST = [{ id: '0001_test', sql: 'FAILING MIGRATION;' }];

describe('migrate connection cleanup', () => {
  it('releases normally when cleanup succeeds', async () => {
    const state: MockState = { queries: [], releases: [], rollbacks: 0 };
    await migrate(makePool(makeClient(state)), MANIFEST);
    expect(state.releases).toEqual([false]);
  });

  it('discards the client when advisory unlock fails', async () => {
    const state: MockState = { queries: [], releases: [], rollbacks: 0 };
    await migrate(makePool(makeClient(state, { unlockFails: true })), MANIFEST);
    expect(state.releases).toEqual([true]);
  });

  it('rolls back a failing migration and releases the client normally', async () => {
    const state: MockState = { queries: [], releases: [], rollbacks: 0 };
    const client = makeClient(state, { migrateFails: true });
    const pool = makePool(client);
    await expect(migrate(pool, FAILING_MANIFEST)).rejects.toMatchObject({
      code: 'MIGRATION_APPLY_FAILED',
      message: 'Migration outcome could not be confirmed; a lost COMMIT reply may mean the migration actually committed.',
    });
    expect(state.rollbacks).toBe(1);
    expect(state.releases).toEqual([false]);
  });

  it('discards the client when rollback fails', async () => {
    const state: MockState = { queries: [], releases: [], rollbacks: 0 };
    const client = makeClient(state, { migrateFails: true, rollbackFails: true });
    const pool = makePool(client);
    await expect(migrate(pool, FAILING_MANIFEST)).rejects.toMatchObject({
      code: 'MIGRATION_APPLY_FAILED',
      message: 'Migration outcome could not be confirmed; a lost COMMIT reply may mean the migration actually committed.',
    });
    expect(state.rollbacks).toBe(1);
    expect(state.releases).toEqual([true]);
  });
});
