import { execFileSync } from "node:child_process";

const denied = /(^|[^L])AGPL|(^|[^L])GPL|SSPL|BUSL|Commons Clause|Elastic License/iu;
const raw = execFileSync("pnpm", ["licenses", "list", "--prod", "--json"], {
  encoding: "utf8",
  maxBuffer: 16 * 1024 * 1024,
});
const report = JSON.parse(raw);
const licenses = Array.isArray(report)
  ? report.flatMap((entry) => Object.keys(entry.licenses ?? {}))
  : Object.keys(report);
const blocked = [...new Set(licenses.filter((license) => denied.test(license)))];

if (blocked.length > 0) {
  console.error(`[licenses] blocked production license families: ${blocked.join(", ")}`);
  process.exit(1);
}

console.log(`[licenses] production dependency policy passed (${licenses.length} license groups inspected)`);
