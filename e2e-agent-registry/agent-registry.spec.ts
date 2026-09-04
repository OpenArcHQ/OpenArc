import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

const passphrase = "agent registry encrypted workspace passphrase";
const network = "eip155:5042002";
const rpc = "https://rpc.testnet.arc.io";
const agentId = "1";
const owner = "0x1111111111111111111111111111111111111111";
const wallet = "0x2222222222222222222222222222222222222222";
const observer = "0x3333333333333333333333333333333333333333";
const validator = "0x4444444444444444444444444444444444444444";
const requestHash = `0x${"a".repeat(64)}`;
const responseHash = `0x${"b".repeat(64)}`;
const blockHash = `0x${"c".repeat(64)}`;
const exactSource = process.env.OPENARC_EXACT_SOURCE === "true";

function envelope() {
  return { ok: true, meta: { schemaVersion: "openarc.api.v1", requestId: crypto.randomUUID(), buildSha: "agent-registry-e2e" },
    data: { schemaVersion: "openarc.agent-registry-evidence.v1", network, agentId,
      anchor: { blockNumber: "100", blockHash, blockTimestamp: "2026-09-04T11:59:59Z",
        finality: "deterministic", confirmations: "1" },
      identity: { owner, agentWallet: wallet,
        metadata: { uri: "https://example.test/agent.json", kind: "https",
          trust: "untrusted_external_metadata", fetched: false } },
      feedback: { observer, feedbackIndex: "0", value: "875", valueDecimals: 1, decimal: "87.5",
        tag1: "delivery", tag2: "testnet", revoked: false, relationship: "observer_specific_claim" },
      validation: { requestHash, validator, agentId, response: 91, responseHash, tag: "benchmark",
        lastUpdate: "123", relationship: "validator_specific_response" },
      source: { sourceId: "arc_primary_rpc", registrySourceId: "erc8004_registries", origin: rpc,
        explorerOrigin: "https://testnet.arcscan.app", network, sourceRevision: "arc-erc8004-docs-2026-09-04",
        reviewedAt: "2026-09-04", specificationStatus: "draft",
        contractsRevision: "b9e466c250744a7e06b13dff9d3c2844ed64f825",
        registries: { identity: "0x8004a818bfb912233c491871b3d84c89a494bd9e",
          reputation: "0x8004b663056a597dffe9eccc1965a193b7388713",
          validation: "0x8004cb1bf31daf7788923b405b754f57aceb4272" },
        observedAt: new Date().toISOString(), adapterVersion: "openarc.agent-registry-evidence.m05.v1" },
      limitations: ["ERC-8004 is a draft standard; registry facts may change before finalization.",
        "Identity ownership and metadata are registry claims, not proof of safety, quality, or control.",
        "Feedback is one observer's claim and validation is one validator's response; neither is a universal score.",
        "Metadata is untrusted external text and was not fetched or rendered by OpenArc."] } };
}

async function createWorkspace(page: Page) {
  await page.goto("/workspace");
  await page.getByLabel("Workspace passphrase", { exact: false }).fill(passphrase);
  await page.getByLabel("Confirm passphrase").fill(passphrase);
  await page.getByRole("button", { name: "Create encrypted workspace" }).click();
  await page.getByRole("checkbox", { name: /I saved it somewhere private/u }).check();
  await page.getByRole("button", { name: "Continue to workspace" }).click();
  await page.getByRole("button", { name: "Skip" }).click();
}

async function rawRecords(page: Page) {
  return page.evaluate(async () => {
    const opened = indexedDB.open("openarc-vault");
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      opened.onsuccess = () => resolve(opened.result);
      opened.onerror = () => reject(opened.error);
    });
    const request = database.transaction("records", "readonly").objectStore("records").getAll();
    const records = await new Promise<unknown[]>((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    database.close();
    return records;
  });
}

test("separates local labels from exact ERC-8004 observer and validator evidence", async ({ page }) => {
  let release: () => void = () => undefined;
  let seen: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const contacted = new Promise<void>((resolve) => { seen = resolve; });
  const bodies: string[] = [];
  page.on("request", (request) => {
    if (request.url().endsWith("/v1/private/arc/agent-registry-evidence")) {
      bodies.push(request.postData() ?? "");
      seen();
    }
  });
  if (!exactSource) await page.route("**/v1/private/arc/agent-registry-evidence", async (route) => {
    await gate;
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(envelope()) });
  });

  await createWorkspace(page);
  await page.getByRole("button", { name: /02 Agents/u }).click();
  await page.getByRole("button", { name: "Add agent profile" }).click();
  await page.getByLabel("Display name").fill("LOCAL PRIVATE LABEL");
  await page.getByRole("button", { name: "Encrypt and save" }).click();
  await expect(page.getByText("Agent profile encrypted and saved.", { exact: true })).toBeVisible();
  await page.getByLabel("ERC-8004 agent ID").fill(agentId);
  await page.getByLabel("Link to a local profile (optional)").selectOption({ label: "LOCAL PRIVATE LABEL" });
  await expect(page.getByLabel("Link to a local profile (optional)")).toHaveValue(/.+/u);
  await page.getByRole("checkbox", { name: /Include one exact observer feedback/u }).check();
  await page.getByLabel("Observer address").fill(observer);
  await page.getByLabel("Feedback index").fill("0");
  await page.getByRole("checkbox", { name: /Include one exact validation request/u }).check();
  await page.getByLabel("Validation request hash").fill(requestHash);
  await page.getByRole("button", { name: "Review permission", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Allow this registry observation?" })).toBeVisible();
  await expect(page.getByText("Local profile and label", { exact: true })).toBeVisible();
  await expect(page.getByText("Not released", { exact: true })).toBeVisible();
  await expect(page.getByText(`POST ${"/v1/private/arc/agent-registry-evidence"}`, { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Approve and observe" }).click();
  await contacted;
  const approvalState = await rawRecords(page);
  expect(JSON.stringify(approvalState)).not.toContain("LOCAL PRIVATE LABEL");
  if (!exactSource) release();
  await expect(page.getByText("ERC-8004 registry evidence validated and encrypted locally.", { exact: false })).toBeVisible();
  await expect(page.getByText("Local label above is owner-supplied.", { exact: false })).toBeVisible();
  await expect(page.getByText("87.5", { exact: true })).toBeVisible();
  await expect(page.getByText("91/100", { exact: true })).toBeVisible();
  await expect(page.getByText("This is one observer’s claim.", { exact: false })).toBeVisible();
  await expect(page.getByText("it is not a general safety certification", { exact: false })).toBeVisible();
  expect(JSON.parse(bodies[0]!)).toEqual({ network, agentId,
    feedbackQuery: { clientAddress: observer, feedbackIndex: "0" }, validationRequestHash: requestHash });
  expect(bodies[0]).not.toContain("LOCAL PRIVATE LABEL");
  const raw = JSON.stringify(await rawRecords(page));
  for (const privateValue of ["LOCAL PRIVATE LABEL", owner, observer, requestHash, "openarc.agent-registry-evidence.v1"]) {
    expect(raw).not.toContain(privateValue);
  }
  const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
  expect(results.violations.filter((violation) => ["serious", "critical"].includes(violation.impact ?? ""))).toEqual([]);
});

test("malformed input makes no request and the UI remains usable on mobile", async ({ page }) => {
  test.skip(exactSource, "Production fixture exercises the successful exact-source path.");
  const requests: string[] = [];
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === "/v1/private/arc/agent-registry-evidence") requests.push(request.url());
  });
  await createWorkspace(page);
  await page.getByRole("button", { name: /02 Agents/u }).click();
  await page.getByLabel("ERC-8004 agent ID").fill("01");
  await page.getByRole("button", { name: "Review permission", exact: true }).click();
  await expect(page.getByText(/canonical registry agent ID/iu)).toBeVisible();
  expect(requests).toEqual([]);
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
});
