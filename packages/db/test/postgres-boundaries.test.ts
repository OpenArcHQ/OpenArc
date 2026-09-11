import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { createDatabasePool, migrate } from '../src/index.js';
import {
  adminPool,
  ensureRoles,
  migratorUrl,
  resetSchema,
} from './postgres-fixture.js';

let admin: Pool;

beforeAll(async () => {
  admin = adminPool();
  try {
    await ensureRoles(admin);
  } finally {
    await resetSchema(admin);
  }
});

afterAll(async () => {
  try {
    await resetSchema(admin);
  } finally {
    await admin.end();
  }
});

describe('postgres boundary constraints', () => {
  it('accepts max-size credential and challenge, rejects the next size', async () => {
    await resetSchema(admin);
    const pool = createDatabasePool(migratorUrl());
    try {
      await migrate(pool);
      const client = await pool.connect();
      const handle = 'A'.repeat(42) + 'A';
      const accountId = 'openarc:account:55555555-5555-4555-8555-555555555555';
      const hash = 'b'.repeat(64);
      try {
        await client.query(
          'INSERT INTO openarc_auth.accounts (account_id, user_handle) VALUES ($1, $2)',
          [accountId, handle],
        );
        const maxCredential = 'c'.repeat(1024);
        await client.query(
          'INSERT INTO openarc_auth.passkeys (credential_id, account_id, public_key, counter, device_type, backed_up) VALUES ($1, $2, $3, 0, $4, false)',
          [maxCredential, accountId, Buffer.from([1]), 'singleDevice'],
        );
        await expect(
          client.query(
            'INSERT INTO openarc_auth.passkeys (credential_id, account_id, public_key, counter, device_type, backed_up) VALUES ($1, $2, $3, 0, $4, false)',
            ['c'.repeat(1025), accountId, Buffer.from([1]), 'singleDevice'],
          ),
        ).rejects.toBeTruthy();
        const maxChallenge = 'd'.repeat(256);
        await client.query(
          "INSERT INTO openarc_auth.challenges (challenge_hash, binding_hash, kind, challenge, wallet_address, expires_at) VALUES ($1, $2, 'wallet_login', $3, '0x' || repeat('1', 40), now() + interval '1 minute')",
          [hash, hash, maxChallenge],
        );
        await expect(
          client.query(
            "INSERT INTO openarc_auth.challenges (challenge_hash, binding_hash, kind, challenge, wallet_address, expires_at) VALUES ($1, $2, 'wallet_login', $3, '0x' || repeat('1', 40), now() + interval '1 minute')",
            ['e'.repeat(64), 'e'.repeat(64), 'd'.repeat(257)],
          ),
        ).rejects.toBeTruthy();
      } finally {
        client.release();
      }
    } finally {
      await pool.end();
    }
  });

  it('enforces user_handle final padding bits for accounts and challenges', async () => {
    await resetSchema(admin);
    const pool = createDatabasePool(migratorUrl());
    try {
      await migrate(pool);
      const client = await pool.connect();
      const prefix = 'A'.repeat(42);
      const validHandle = `${prefix}A`;
      const invalidHandle = `${prefix}B`;
      const accountId = 'openarc:account:66666666-6666-4666-8666-666666666666';
      try {
        await client.query(
          'INSERT INTO openarc_auth.accounts (account_id, user_handle) VALUES ($1, $2)',
          [accountId, validHandle],
        );
        await expect(
          client.query(
            'INSERT INTO openarc_auth.accounts (account_id, user_handle) VALUES ($1, $2)',
            ['openarc:account:77777777-7777-4777-8777-777777777777', invalidHandle],
          ),
        ).rejects.toBeTruthy();
        const hash = 'f'.repeat(64);
        await client.query(
          "INSERT INTO openarc_auth.challenges (challenge_hash, binding_hash, kind, challenge, user_handle, expires_at) VALUES ($1, $2, 'passkey_register', 'abc', $3, now() + interval '1 minute')",
          [hash, hash, validHandle],
        );
        await expect(
          client.query(
            "INSERT INTO openarc_auth.challenges (challenge_hash, binding_hash, kind, challenge, user_handle, expires_at) VALUES ($1, $2, 'passkey_register', 'abc', $3, now() + interval '1 minute')",
            ['1'.repeat(64), '1'.repeat(64), invalidHandle],
          ),
        ).rejects.toBeTruthy();
      } finally {
        client.release();
      }
    } finally {
      await pool.end();
    }
  });
});
