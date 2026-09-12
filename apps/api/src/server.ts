import { createApp } from "./app.js";
import { authCookieNames } from "./auth/cookies.js";
import { startAuthRuntime, type StartedAuthRuntime } from "./auth/runtime.js";
import { startTenantRuntime, type StartedTenantRuntime } from "./tenant/runtime.js";
import { startMachineRuntime, type StartedMachineRuntime } from "./machine/runtime.js";
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
  const authRuntime: StartedAuthRuntime | undefined = config.AUTH_ENABLED
    ? await startAuthRuntime({
        authDatabaseUrl: config.AUTH_DATABASE_URL as string,
        authSecret: config.AUTH_SECRET as string,
        appOrigin: config.APP_ORIGIN,
        rpId: config.AUTH_RP_ID as string,
        environment: config.NODE_ENV === "production" ? "production" : "development",
        secureCookies: config.APP_ORIGIN.startsWith("https://"),
        cookieNames: authCookieNames(config.APP_ORIGIN.startsWith("https://")),
        rateLimits: {
          globalLimit: config.AUTH_RATE_GLOBAL_PER_MINUTE,
          globalWindowSeconds: 60,
          peerLimit: config.AUTH_RATE_PEER_PER_HOUR,
          peerWindowSeconds: 3600,
          bindingLimit: config.AUTH_RATE_BINDING_PER_HOUR,
          bindingWindowSeconds: 3600,
          recoveryLimit: config.AUTH_RATE_RECOVERY_PER_15MIN,
          recoveryWindowSeconds: 900,
        },
    })
    : undefined;
  const tenantRuntime: StartedTenantRuntime | undefined = config.TENANT_READS_ENABLED
    ? await startTenantRuntime({
        tenantDatabaseUrl: config.TENANT_DATABASE_URL as string,
        auth: authRuntime!.service,
        writesEnabled: config.TENANT_WRITES_ENABLED,
        writeAuth: authRuntime!.service,
      })
    : undefined;
  const machineEnabled =
    config.MACHINE_CREDENTIAL_MANAGEMENT_ENABLED ||
    config.MACHINE_SESSION_EXCHANGE_ENABLED;
  const machineRuntime: StartedMachineRuntime | undefined = machineEnabled
    ? await startMachineRuntime({
        tenantDatabaseUrl: config.TENANT_DATABASE_URL as string,
        currentPepperVersion: config.MACHINE_CREDENTIAL_PEPPER_VERSION as number,
        currentPepper: config.MACHINE_CREDENTIAL_PEPPER as string,
        ...(config.MACHINE_CREDENTIAL_PREVIOUS_VERSION !== undefined
          ? { previousPepperVersion: config.MACHINE_CREDENTIAL_PREVIOUS_VERSION }
          : {}),
        ...(config.MACHINE_CREDENTIAL_PREVIOUS_PEPPER !== undefined
          ? { previousPepper: config.MACHINE_CREDENTIAL_PREVIOUS_PEPPER }
          : {}),
        rateSecret: config.MACHINE_RATE_SECRET as string,
        rateLimitStore: authRuntime!.rateLimitStore,
        managementAuth: authRuntime!.service,
      })
    : undefined;
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
    ...(authRuntime
      ? { authService: authRuntime.service, authReady: () => authRuntime.ready() }
      : {}),
    ...(tenantRuntime
      ? { tenantReadService: tenantRuntime.service, tenantReady: () => tenantRuntime.ready(),
          ...(tenantRuntime.writeService !== undefined
            ? { tenantWriteService: tenantRuntime.writeService }
            : {}) }
      : {}),
    ...(machineRuntime
      ? {
          machineManagementService: machineRuntime.managementService,
          machineSessionService: machineRuntime.sessionService,
          machineReady: () => machineRuntime.ready(),
        }
      : {}),
    ...(config.GATEWAY_EVIDENCE_ENABLED ? { gatewayTransferService: new GatewayTransferService(new BoundedGatewayClient({
      timeoutMs: config.SOURCE_TIMEOUT_MS, maxResponseBytes: config.SOURCE_MAX_RESPONSE_BYTES,
    })) } : {}),
    ...(sourceBudget ? { sourceBudget } : {}),
    ...(rpc ? { arcAccountService: new ArcAccountService(rpc), arcTransactionService: new ArcTransactionService(rpc),
      ...(config.AGENT_REGISTRY_ENABLED ? { agentRegistryService: new AgentRegistryService(rpc) } : {}),
      ...(config.AGENT_JOBS_ENABLED ? { jobService: new JobService(rpc) } : {}) } : {}) });
  const shutdown = async (): Promise<void> => {
    await app.close();
    await authRuntime?.close();
    await tenantRuntime?.close();
    await machineRuntime?.close();
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
