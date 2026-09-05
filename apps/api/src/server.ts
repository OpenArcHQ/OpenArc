import { createApp } from "./app.js";
import { ArcAccountService } from "./arc/account-service.js";
import { AgentRegistryService } from "./arc/agent-registry-service.js";
import { JobService } from "./arc/job-service.js";
import { ArcRpcClient } from "./arc/rpc-client.js";
import { ArcTransactionService } from "./arc/transaction-service.js";
import { loadConfig } from "./config.js";
import { connectBudgetRedis, SourceBudget } from "./limits/budget.js";
import { AggregateMetrics } from "./ops/metrics.js";
import { BoundedProviderClient } from "./providers/http.js";
import { BoundedGatewayClient } from "./gateway/client.js";
import { GatewayTransferService } from "./gateway/transfer-service.js";

async function start(): Promise<void> {
  const config = loadConfig();
  const metrics = new AggregateMetrics();
  const redis = config.ARC_OBSERVATION_ENABLED && config.REDIS_URL ? await connectBudgetRedis(config.REDIS_URL) : undefined;
  const sourceBudget = redis && config.ABUSE_LIMIT_SECRET ? new SourceBudget(redis, {
    secret: config.ABUSE_LIMIT_SECRET,
    requestsPerPeerHour: config.REQUESTS_PER_IP_HOUR,
    globalUnitsPerDay: config.GLOBAL_SOURCE_UNITS_PER_DAY,
    maxSubcalls: config.SOURCE_MAX_SUBCALLS,
    observe: (source, event) => metrics.recordBudget(source, event),
  }) : undefined;
  const rpc = config.ARC_OBSERVATION_ENABLED ? new ArcRpcClient(new BoundedProviderClient({
    timeoutMs: config.SOURCE_TIMEOUT_MS,
    maxResponseBytes: config.SOURCE_MAX_RESPONSE_BYTES,
  })) : undefined;
  const app = createApp({ config, metrics,
    ...(config.GATEWAY_EVIDENCE_ENABLED ? { gatewayTransferService: new GatewayTransferService(new BoundedGatewayClient({
      timeoutMs: config.SOURCE_TIMEOUT_MS, maxResponseBytes: config.SOURCE_MAX_RESPONSE_BYTES,
    })) } : {}),
    ...(sourceBudget ? { sourceBudget } : {}),
    ...(rpc ? { arcAccountService: new ArcAccountService(rpc), arcTransactionService: new ArcTransactionService(rpc),
      ...(config.AGENT_REGISTRY_ENABLED ? { agentRegistryService: new AgentRegistryService(rpc) } : {}),
      ...(config.AGENT_JOBS_ENABLED ? { jobService: new JobService(rpc) } : {}) } : {}) });
  const shutdown = async (): Promise<void> => {
    await app.close();
    if (redis?.isOpen) redis.destroy();
    process.exit(0);
  };
  process.once("SIGINT", () => void shutdown());
  process.once("SIGTERM", () => void shutdown());
  await app.listen({ host: config.HOST, port: config.PORT });
}

void start().catch(() => {
  // Never serialize environment validation, transport errors, identifiers, or stacks.
  process.stderr.write('{"event":"startup_failed","code":"CONFIGURATION_OR_LISTEN_FAILED"}\n');
  process.exit(1);
});
