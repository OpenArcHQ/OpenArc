import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const root = path.resolve(import.meta.dirname, "..");
const failures = [];

if (Number.parseInt(process.versions.node.split(".")[0] ?? "0", 10) !== 22) {
  failures.push(`Node 22 is required; found ${process.version}`);
}

for (const required of ["pnpm-lock.yaml", "pnpm-workspace.yaml", "apps/api/Dockerfile", "apps/web/Dockerfile"]) {
  try {
    await stat(path.join(root, required));
  } catch {
    failures.push(`Missing required foundation file: ${required}`);
  }
}

const networkSource = await readFile(path.join(root, "packages/shared/src/network.ts"), "utf8");
for (const requiredValue of ["5042002", "0x4cef52", "https://rpc.testnet.arc.io"]) {
  if (!networkSource.includes(requiredValue)) failures.push(`Network registry is missing ${requiredValue}`);
}

if (/mainnet\s*[:=]/iu.test(networkSource) || /ARC_MAINNET/u.test(networkSource)) {
  failures.push("M00 must not contain a mainnet network configuration");
}

if (failures.length > 0) {
  for (const failure of failures) console.error(`[release-check] ${failure}`);
  process.exit(1);
}

console.log("[release-check] M00 repository and Testnet-only registry verified");
