import { BuildInfoSchema, type BuildInfo } from "@openarc/shared";

export function getWebBuildInfo(commitSha: string | undefined): BuildInfo {
  const candidate = commitSha?.trim();
  const safeCommitSha = /^[A-Za-z0-9._-]{1,64}$/u.test(candidate ?? "")
    ? (candidate ?? "local")
    : "local";

  return BuildInfoSchema.parse({
    service: "openarc-web",
    version: "0.0.0",
    commitSha: safeCommitSha,
  });
}
