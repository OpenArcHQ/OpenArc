import { ARC_TESTNET, BuildMarkerSchema, WorkspaceOriginSchema } from "@openarc/shared";
import { z } from "zod";

const flag = () => z.enum(["true", "false"]).default("false").transform((value) => value === "true");
const secret = () => z.string().regex(/^[A-Za-z0-9_-]{32,128}$/u);
const EnvironmentSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  HOST: z.string().min(1).max(255).default("0.0.0.0"),
  PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
  APP_ORIGIN: WorkspaceOriginSchema.default("http://localhost:5183"),
  COMMIT_SHA: BuildMarkerSchema.default("local"),
  LOG_LEVEL: z.enum(["silent", "error", "warn", "info"]).default("info"),
  API_BOUNDARY_ENABLED: flag(),
  ARC_OBSERVATION_ENABLED: flag(),
  AGENT_REGISTRY_ENABLED: flag(),
  AGENT_JOBS_ENABLED: flag(),
  GATEWAY_EVIDENCE_ENABLED: flag(),
  AUTH_ENABLED: flag(),
  AUTH_DATABASE_URL: z
    .string()
    .max(4096)
    .regex(/^postgres(?:ql)?:\/\//u)
    .optional(),
  AUTH_SECRET: secret().optional(),
  AUTH_RP_ID: z.string().min(1).max(253).optional(),
  AUTH_RATE_GLOBAL_PER_MINUTE: z.coerce.number().int().min(1).max(100_000).default(600),
  AUTH_RATE_PEER_PER_HOUR: z.coerce.number().int().min(1).max(100_000).default(120),
  AUTH_RATE_BINDING_PER_HOUR: z.coerce.number().int().min(1).max(100_000).default(120),
  AUTH_RATE_RECOVERY_PER_15MIN: z.coerce.number().int().min(1).max(10_000).default(5),
  ARC_TESTNET_RPC_URL: z.literal(ARC_TESTNET.rpcHttp).default(ARC_TESTNET.rpcHttp),
  ARC_TESTNET_EXPLORER_URL: z.literal(ARC_TESTNET.explorerOrigin).default(ARC_TESTNET.explorerOrigin),
  REDIS_URL: z.url({ protocol: /^rediss?$/u }).max(1024).optional(),
  ABUSE_LIMIT_SECRET: secret().optional(),
  SOURCE_PROXY_SECRET: secret().optional(),
  METRICS_TOKEN: secret().optional(),
  REQUESTS_PER_IP_HOUR: z.coerce.number().int().min(1).max(10_000).default(60),
  GLOBAL_SOURCE_UNITS_PER_DAY: z.coerce.number().int().min(1).max(1_000_000).default(10_000),
  SOURCE_TIMEOUT_MS: z.coerce.number().int().min(100).max(10_000).default(5_000),
  SOURCE_MAX_RESPONSE_BYTES: z.coerce.number().int().min(1024).max(256 * 1024).default(256 * 1024),
  SOURCE_MAX_SUBCALLS: z.coerce.number().int().min(1).max(16).default(8),
}).superRefine((config, context) => {
  if (config.NODE_ENV === "production") {
    if (!config.APP_ORIGIN.startsWith("https://")) {
      context.addIssue({ code: "custom", path: ["APP_ORIGIN"], message: "An exact HTTPS app origin is required" });
    }
    if (!/^[0-9a-f]{40}$/u.test(config.COMMIT_SHA)) {
      context.addIssue({ code: "custom", path: ["COMMIT_SHA"], message: "An exact Git SHA is required" });
    }
    if (!config.METRICS_TOKEN) {
      context.addIssue({ code: "custom", path: ["METRICS_TOKEN"], message: "A metrics secret is required" });
    }
  }
  const operatorSecrets = [config.ABUSE_LIMIT_SECRET, config.SOURCE_PROXY_SECRET, config.METRICS_TOKEN, config.AUTH_SECRET].filter(Boolean);
  if (new Set(operatorSecrets).size !== operatorSecrets.length) {
    context.addIssue({ code: "custom", message: "Operator secrets must be distinct" });
  }
  if (config.AUTH_ENABLED) {
    if (!config.AUTH_DATABASE_URL) {
      context.addIssue({ code: "custom", path: ["AUTH_DATABASE_URL"], message: "Authentication requires a dedicated database URL" });
    }
    if (!config.AUTH_SECRET) {
      context.addIssue({ code: "custom", path: ["AUTH_SECRET"], message: "Authentication requires a dedicated operator secret" });
    }
    if (!config.AUTH_RP_ID) {
      context.addIssue({ code: "custom", path: ["AUTH_RP_ID"], message: "Authentication requires an exact relying-party id" });
    } else {
      const rpId = config.AUTH_RP_ID;
      if (rpId.includes("*") || rpId.includes("/") || rpId.startsWith(".") || rpId.endsWith(".")) {
        context.addIssue({ code: "custom", path: ["AUTH_RP_ID"], message: "AUTH_RP_ID must be an exact hostname" });
      }
      let hostname: string | null = null;
      try {
        hostname = new URL(config.APP_ORIGIN).hostname;
      } catch {
        hostname = null;
      }
      if (hostname !== null && hostname !== rpId) {
        context.addIssue({ code: "custom", path: ["AUTH_RP_ID"], message: "AUTH_RP_ID must equal the APP_ORIGIN hostname" });
      }
    }
    if (config.NODE_ENV !== "production" && !config.APP_ORIGIN.startsWith("http://localhost") && !config.APP_ORIGIN.startsWith("http://127.0.0.1")) {
      context.addIssue({ code: "custom", path: ["APP_ORIGIN"], message: "Authentication development origin must be loopback" });
    }
  }
  if (config.GATEWAY_EVIDENCE_ENABLED) {
    if (!config.AGENT_JOBS_ENABLED) {
      context.addIssue({ code: "custom", path: ["GATEWAY_EVIDENCE_ENABLED"], message: "Gateway evidence requires the cumulative job evidence milestone" });
    }
  }
  if (config.ARC_OBSERVATION_ENABLED) {
    if (!config.API_BOUNDARY_ENABLED) {
      context.addIssue({ code: "custom", path: ["API_BOUNDARY_ENABLED"], message: "Arc observation requires the API boundary" });
    }
    if (!config.REDIS_URL || !config.ABUSE_LIMIT_SECRET || !config.SOURCE_PROXY_SECRET) {
      context.addIssue({ code: "custom", message: "Arc observation requires Redis and distinct abuse/proxy secrets" });
    }
    if (config.SOURCE_MAX_SUBCALLS < 5) {
      context.addIssue({ code: "custom", path: ["SOURCE_MAX_SUBCALLS"], message: "Arc observation requires five bounded source subcalls" });
    }
  }
  if (config.AGENT_REGISTRY_ENABLED) {
    if (!config.ARC_OBSERVATION_ENABLED) {
      context.addIssue({ code: "custom", path: ["AGENT_REGISTRY_ENABLED"], message: "Agent registry evidence requires Arc observation" });
    }
    if (config.SOURCE_MAX_SUBCALLS < 10) {
      context.addIssue({ code: "custom", path: ["SOURCE_MAX_SUBCALLS"], message: "Agent registry evidence requires ten bounded source subcalls" });
    }
  }
  if (config.AGENT_JOBS_ENABLED) {
    if (!config.AGENT_REGISTRY_ENABLED) {
      context.addIssue({ code: "custom", path: ["AGENT_JOBS_ENABLED"], message: "Job evidence requires the cumulative agent registry milestone" });
    }
    if (config.SOURCE_MAX_SUBCALLS < 11) {
      context.addIssue({ code: "custom", path: ["SOURCE_MAX_SUBCALLS"], message: "Job evidence requires eleven bounded source subcalls" });
    }
  }
});

export type ApiConfig = z.infer<typeof EnvironmentSchema>;

export function loadConfig(input: NodeJS.ProcessEnv = process.env): ApiConfig {
  return EnvironmentSchema.parse(input);
}
