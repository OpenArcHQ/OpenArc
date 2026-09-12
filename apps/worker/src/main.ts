import { parseWorkerConfig } from './config.js';
import { startWorkerRuntime } from './runtime.js';

/**
 * Bounded tenant notification worker entry point.
 *
 * LIMITATION: this process consumes durable tenant mutation notifications only.
 * It does not execute payments, materialize projections, send notifications,
 * call providers, sign or broadcast, reconcile evidence or require Redis.
 *
 * Disabled exits cleanly without opening a database connection. Enabled exits
 * non-zero on initialization failure; SIGINT/SIGTERM trigger graceful shutdown
 * with signal-handler cleanup and a bounded pool close.
 */
async function main(): Promise<void> {
  const config = parseWorkerConfig(process.env);
  if (!config.enabled) return;
  const runtime = startWorkerRuntime({ config });
  // A signal during startup leaves ready pending by design; settle on either
  // the ready barrier or the stopped barrier so a graceful stop never hangs.
  await Promise.race([runtime.ready, runtime.stopped]);
  await runtime.stopped;
}

main().then(
  () => {
    process.exitCode = 0;
  },
  () => {
    process.exitCode = 1;
  },
);
