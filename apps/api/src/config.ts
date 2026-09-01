import { BuildMarkerSchema } from "@openarc/shared";
import { z } from "zod";

const EnvironmentSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  HOST: z.string().min(1).max(255).default("0.0.0.0"),
  PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
  APP_ORIGIN: z.url().default("http://localhost:5173"),
  COMMIT_SHA: BuildMarkerSchema.default("local"),
});

export type ApiConfig = z.infer<typeof EnvironmentSchema>;

export function loadConfig(input: NodeJS.ProcessEnv = process.env): ApiConfig {
  return EnvironmentSchema.parse(input);
}
