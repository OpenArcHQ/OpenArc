import { OutboxStore, asOutboxPool, createDatabasePool } from '@openarc/db';
import type { WorkerConfig } from './config.js';
import { createHandlerRegistry, type NotificationHandlerRegistry } from './handlers.js';
import {
  WorkerLoop,
  noopLogger,
  systemClock,
  type WorkerClock,
  type WorkerLogger,
  type WorkerStore,
} from './worker.js';

/**
 * Process lifecycle for the bounded tenant notification worker.
 *
 * LIMITATION: readiness means the worker opened a dedicated worker-role pool,
 * verified the exact bundled schema/role through OutboxStore.initialize and
 * began consuming durable tenant notifications. It asserts no commerce,
 * payment, projection, provider, notification or deployment readiness.
 *
 * The pool is closed exactly once on initialization failure or shutdown.
 * SIGINT/SIGTERM stop new claims immediately; inflight work is given the
 * configured grace to settle, then aborted with no late acknowledgement. The
 * pool close is bounded so a stuck query cannot hang process exit.
 *
 * A shutdown requested while initialization is still pending is honoured: once
 * initialize resolves the runtime rechecks the stop request and never builds the
 * loop, marks itself ready or claims. A shutdown that races an initialize that
 * never resolves still settles through the bounded pool close, and the pool is
 * closed at most once in every path.
 */

type DatabasePool = ReturnType<typeof createDatabasePool>;

export interface WorkerOutboxStore extends WorkerStore {
  initialize(): Promise<void>;
}

export interface WorkerRuntimeOptions {
  readonly config: WorkerConfig;
  readonly handlers?: NotificationHandlerRegistry;
  readonly clock?: WorkerClock;
  readonly logger?: WorkerLogger;
  readonly createPool?: (url: string) => DatabasePool;
  readonly createStore?: (pool: DatabasePool) => WorkerOutboxStore;
  readonly installSignalHandlers?: boolean;
  readonly poolCloseTimeoutMs?: number;
}

export type WorkerRuntimeState =
  | 'disabled'
  | 'starting'
  | 'ready'
  | 'stopping'
  | 'stopped'
  | 'failed';

export interface WorkerRuntime {
  readonly state: WorkerRuntimeState;
  readonly ready: Promise<void>;
  readonly stopped: Promise<void>;
  shutdown(): Promise<void>;
}

async function waitFor(promise: Promise<unknown>, milliseconds: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), milliseconds);
  });
  const outcome = await Promise.race([promise.then(() => true, () => true), timeout]);
  if (timer !== undefined) clearTimeout(timer);
  return outcome;
}

export function startWorkerRuntime(options: WorkerRuntimeOptions): WorkerRuntime {
  const logger = options.logger ?? noopLogger;
  const clock = options.clock ?? systemClock;
  const installSignals = options.installSignalHandlers ?? true;
  const poolCloseTimeoutMs = options.poolCloseTimeoutMs ?? 5000;
  const registry = options.handlers ?? createHandlerRegistry();
  const createPool = options.createPool ?? createDatabasePool;
  const createStore = options.createStore ?? ((pool: DatabasePool) => new OutboxStore(asOutboxPool(pool)));

  if (!options.config.enabled) {
    return {
      state: 'disabled',
      ready: Promise.resolve(),
      stopped: Promise.resolve(),
      shutdown: () => Promise.resolve(),
    };
  }
  const config = options.config;

  let state: WorkerRuntimeState = 'starting';
  let stopRequested = false;
  let pool: DatabasePool | undefined;
  let poolClosed = false;
  let loop: WorkerLoop | undefined;
  let shutdownPromise: Promise<void> | undefined;
  let stoppedSettled = false;

  let resolveReady: (() => void) | undefined;
  let rejectReady: ((error: unknown) => void) | undefined;
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  void ready.catch(() => undefined);

  let settleStopped: () => void = () => undefined;
  const stopped = new Promise<void>((resolve) => {
    settleStopped = resolve;
  });

  const removeSignalHandlers = (): void => {
    if (!installSignals) return;
    process.removeListener('SIGINT', onSignal);
    process.removeListener('SIGTERM', onSignal);
  };

  const finish = (): void => {
    if (stoppedSettled) return;
    stoppedSettled = true;
    removeSignalHandlers();
    settleStopped();
  };

  const closePool = async (): Promise<void> => {
    if (poolClosed || pool === undefined) return;
    poolClosed = true;
    let ended: Promise<unknown>;
    try {
      ended = pool.end();
    } catch {
      return;
    }
    await waitFor(Promise.resolve(ended).catch(() => undefined), poolCloseTimeoutMs);
  };

  const bootstrap = (async (): Promise<void> => {
    try {
      const created = createPool(config.databaseUrl);
      pool = created;
      const store = createStore(created);
      await store.initialize();
      // Shutdown may have been requested while initialize was pending. Do not
      // resurrect readiness: no loop construct, no ready, no claim.
      if (stopRequested) return;
      loop = new WorkerLoop({
        store,
        registry,
        claimLimit: config.claimLimit,
        pollMs: config.pollMs,
        idleMaxMs: config.idleMaxMs,
        clock,
        logger,
      });
      state = 'ready';
      logger.log({ status: 'ready' });
      resolveReady?.();
      await loop.run();
      if (state === 'ready') state = 'stopped';
    } catch (error) {
      if (state === 'starting') {
        state = 'failed';
        rejectReady?.(error);
      }
    } finally {
      await closePool();
      if (state !== 'failed') state = 'stopped';
      finish();
    }
  })();

  const requestShutdown = (): Promise<void> => {
    if (shutdownPromise !== undefined) return shutdownPromise;
    stopRequested = true;
    shutdownPromise = (async (): Promise<void> => {
      if (state === 'starting' || state === 'ready') {
        state = 'stopping';
        logger.log({ status: 'stopping' });
      }
      if (loop !== undefined) {
        loop.requestStop();
        const drained = await waitFor(loop.settled, config.shutdownGraceMs);
        if (!drained) {
          loop.abort();
          await waitFor(loop.settled, poolCloseTimeoutMs);
        }
      }
      await waitFor(bootstrap, poolCloseTimeoutMs + 100);
      await closePool();
      if (state === 'stopping') state = 'stopped';
      finish();
    })();
    return shutdownPromise;
  };

  function onSignal(): void {
    void requestShutdown();
  }

  if (installSignals) {
    process.on('SIGINT', onSignal);
    process.on('SIGTERM', onSignal);
  }

  return {
    get state() {
      return state;
    },
    ready,
    stopped,
    shutdown: requestShutdown,
  };
}
