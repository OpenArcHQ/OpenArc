import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { connectBudgetRedis } from "../src/limits/budget.js";

/** Dedicated loopback instance only. No silent skips or shared/remote databases. */
export async function disposableRedis() {
  const suppliedUrl = process.env.OPENARC_TEST_REDIS_URL;
  if (suppliedUrl) {
    const url = new URL(suppliedUrl);
    if (process.env.OPENARC_TEST_REDIS_DISPOSABLE !== "true" || url.protocol !== "redis:" ||
      !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) || url.username || url.password ||
      url.search || url.hash || !["", "/", "/0"].includes(url.pathname)) {
      throw new Error("Redis tests require a confirmed disposable loopback database");
    }
    return { url: suppliedUrl, stop: async () => undefined };
  }
  const binary = process.env.OPENARC_TEST_REDIS_SERVER;
  if (!binary || !path.isAbsolute(binary)) {
    throw new Error("Real Redis is required: set OPENARC_TEST_REDIS_SERVER to a local Redis 8 binary, or OPENARC_TEST_REDIS_URL plus OPENARC_TEST_REDIS_DISPOSABLE=true for a dedicated loopback instance");
  }
  const listener = createServer();
  listener.listen(0, "127.0.0.1");
  await once(listener, "listening");
  const address = listener.address();
  if (!address || typeof address === "string") throw new Error("Redis test port unavailable");
  const port = address.port;
  await new Promise<void>((resolve, reject) => listener.close((error) => error ? reject(error) : resolve()));
  const directory = await mkdtemp(path.join(tmpdir(), "openarc-m03-redis-"));
  const child = spawn(binary, ["--bind", "127.0.0.1", "--port", String(port), "--protected-mode", "yes",
    "--daemonize", "no", "--save", "", "--appendonly", "no", "--dir", directory,
    "--maxmemory", "32mb", "--maxmemory-policy", "noeviction", "--loglevel", "warning"], { stdio: "ignore" });
  let failed = false;
  child.on("error", () => { failed = true; });
  let stopped = false;
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    if (child.exitCode === null && child.signalCode === null && !failed) {
      const exited = once(child, "exit");
      child.kill("SIGTERM");
      const timer = setTimeout(() => child.kill("SIGKILL"), 2_000);
      await exited.finally(() => clearTimeout(timer));
    }
    await rm(directory, { recursive: true, force: true });
  };
  const url = `redis://127.0.0.1:${port}`;
  for (let attempt = 0; attempt < 30 && !failed && child.exitCode === null; attempt += 1) {
    try {
      const client = await connectBudgetRedis(url);
      const info = await client.info("server");
      client.destroy();
      if (!/redis_version:8\./u.test(info)) { await stop(); throw new Error("Redis 8 is required for integration tests"); }
      return { url, stop };
    } catch { await delay(30); }
  }
  await stop();
  throw new Error("The disposable Redis 8 process did not start");
}
