/**
 * Bounded startup configuration for the tenant notification worker.
 *
 * LIMITATION: this worker consumes durable TENANT MUTATION NOTIFICATIONS only.
 * Accepted notification success means allowlisted metadata was validated and
 * the worker consumed the event. It is NOT a payment, provider call,
 * notification send, business projection, reconciliation or broadcast, and no
 * commerce side effect is claimed. A future projection phase owns side effects.
 *
 * Only the documented keys below are read; unrelated OS environment variables
 * are ignored. The database URL is never logged.
 */

export const WORKER_CONFIG_ERROR_MESSAGE = 'Worker configuration is invalid.';

/** Fixed, non-echoing configuration error. Never carries the bad value. */
export class WorkerConfigError extends Error {
  constructor() {
    super(WORKER_CONFIG_ERROR_MESSAGE);
    this.name = 'WorkerConfigError';
  }
}

export interface DisabledWorkerConfig {
  readonly enabled: false;
}

export interface EnabledWorkerConfig {
  readonly enabled: true;
  /** Dedicated worker connection URL. Never logged. */
  readonly databaseUrl: string;
  readonly claimLimit: number;
  readonly pollMs: number;
  readonly idleMaxMs: number;
  readonly shutdownGraceMs: number;
}

export type WorkerConfig = DisabledWorkerConfig | EnabledWorkerConfig;

export type WorkerEnvironment = Readonly<Record<string, string | undefined>>;

const CLAIM_LIMIT_DEFAULT = 10;
const CLAIM_LIMIT_MIN = 1;
const CLAIM_LIMIT_MAX = 50;
const POLL_MS_DEFAULT = 1000;
const POLL_MS_MIN = 250;
const POLL_MS_MAX = 10000;
const IDLE_MAX_MS_DEFAULT = 5000;
const IDLE_MAX_MS_MIN = 1000;
const IDLE_MAX_MS_MAX = 30000;
const SHUTDOWN_GRACE_MS_DEFAULT = 10000;
const SHUTDOWN_GRACE_MS_MIN = 100;
const SHUTDOWN_GRACE_MS_MAX = 15000;
const DATABASE_URL_MAX = 4096;

const INTEGER = /^(0|[1-9][0-9]*)$/;

function parseInteger(
  raw: string | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  if (raw === undefined) return fallback;
  if (raw.length === 0 || !INTEGER.test(raw)) throw new WorkerConfigError();
  const value = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new WorkerConfigError();
  }
  return value;
}

function parseEnabled(raw: string | undefined): boolean {
  if (raw === undefined || raw === 'false') return false;
  if (raw === 'true') return true;
  throw new WorkerConfigError();
}

function requireDatabaseUrl(raw: string | undefined): string {
  if (
    raw === undefined ||
    raw.length === 0 ||
    raw.length > DATABASE_URL_MAX ||
    (!raw.startsWith('postgres://') && !raw.startsWith('postgresql://'))
  ) {
    throw new WorkerConfigError();
  }
  return raw;
}

/**
 * Parse exactly the documented worker settings. Disabled is the default and a
 * disabled process requires no database URL and opens no connection.
 */
export function parseWorkerConfig(env: WorkerEnvironment): WorkerConfig {
  const enabled = parseEnabled(env['WORKER_ENABLED']);
  if (!enabled) return { enabled: false };

  const databaseUrl = requireDatabaseUrl(env['WORKER_DATABASE_URL']);
  const claimLimit = parseInteger(
    env['WORKER_CLAIM_LIMIT'],
    CLAIM_LIMIT_DEFAULT,
    CLAIM_LIMIT_MIN,
    CLAIM_LIMIT_MAX,
  );
  const pollMs = parseInteger(env['WORKER_POLL_MS'], POLL_MS_DEFAULT, POLL_MS_MIN, POLL_MS_MAX);
  const idleMaxMs = parseInteger(
    env['WORKER_IDLE_MAX_MS'],
    IDLE_MAX_MS_DEFAULT,
    IDLE_MAX_MS_MIN,
    IDLE_MAX_MS_MAX,
  );
  const shutdownGraceMs = parseInteger(
    env['WORKER_SHUTDOWN_GRACE_MS'],
    SHUTDOWN_GRACE_MS_DEFAULT,
    SHUTDOWN_GRACE_MS_MIN,
    SHUTDOWN_GRACE_MS_MAX,
  );
  if (idleMaxMs < pollMs) throw new WorkerConfigError();

  return { enabled: true, databaseUrl, claimLimit, pollMs, idleMaxMs, shutdownGraceMs };
}
