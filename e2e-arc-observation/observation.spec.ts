import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

const passphrase = "arc observation encrypted workspace passphrase";
const address = "0x1111111111111111111111111111111111111111";
const to = "0x2222222222222222222222222222222222222222";
const transactionHash = `0x${"b".repeat(64)}`;
const blockHash = `0x${"a".repeat(64)}`;
const network = "eip155:5042002";
const rpc = "https://rpc.testnet.arc.io";
const explorer = "https://testnet.arcscan.app";
const sourceRevision = "arc-docs-2026-09-03";
const systemEmitter = "0xfffffffffffffffffffffffffffffffffffffffe";
const usdc = "0x3600000000000000000000000000000000000000";
const exactSource = process.env.OPENARC_EXACT_SOURCE === "true";

function meta() {
  return { schemaVersion: "openarc.api.v1", requestId: crypto.randomUUID(), buildSha: "arc-observation-e2e" };
}

function source() {
  return { sourceId: "arc_primary_rpc", origin: rpc, explorerOrigin: explorer, network,
    sourceRevision, observedAt: new Date().toISOString(), adapterVersion: "openarc.arc-observation.m04.v1" };
}

function accountEnvelope() {
  return { ok: true, meta: meta(), data: { schemaVersion: "openarc.arc-account-snapshot.v1", network, address,
    anchor: { blockNumber: "100", blockHash, blockTimestamp: "2026-09-03T11:59:59Z",
      finality: "deterministic", confirmations: "1" },
    nativeUsdc: { asset: "USDC", interface: "native",
      amount: { baseUnits: "1000000100000000000", decimals: 18, decimal: "1.0000001" } },
    erc20UsdcView: { asset: "USDC", interface: "erc20", contract: usdc,
      amount: { baseUnits: "1000000", decimals: 6, decimal: "1" },
      relationship: "same_underlying_balance", truncatesSubMicroUsdc: true }, source: source(),
    limitations: ["This is a read-only observation at one exact Arc Testnet block.",
      "The 6-decimal ERC-20 view truncates native precision below one micro-USDC.",
      "A public address is not proof that its owner or controller is an agent."] } };
}

function transactionEnvelope() {
  return { ok: true, meta: meta(), data: { schemaVersion: "openarc.arc-transaction-evidence.v1", network,
    transaction: { hash: transactionHash, blockNumber: "100", blockHash, transactionIndex: "2",
      from: address, to, nativeValue: { baseUnits: "0", decimals: 18, decimal: "0" } },
    receipt: { status: "success", gasUsed: "21000",
      effectiveGasPrice: { baseUnits: "20000000000", decimals: 18, decimal: "0.00000002" },
      fee: { baseUnits: "420000000000000", decimals: 18, decimal: "0.00042" } },
    anchor: { blockNumber: "100", blockHash, blockTimestamp: "2026-09-03T11:59:59Z",
      finality: "deterministic", confirmations: "1" },
    movements: [{ classification: "canonical_eip7708_usdc", emitter: systemEmitter,
      logIndex: "0", from: address, to,
      amount: { baseUnits: "1000000000000000000", decimals: 18, decimal: "1" },
      erc20Corroboration: { emitter: usdc, logIndex: "1",
        amount: { baseUnits: "1000000", decimals: 6, decimal: "1" } } }],
    coverage: { totalLogs: 2, canonicalMovements: 1, corroboratedMovements: 1,
      unsupportedLogs: 0, completeForUsdcTransfers: true }, source: source(),
    limitations: ["This is a read-only observation of one Arc Testnet transaction and receipt.",
      "EIP-7708 system events are canonical; matching ERC-20 events are corroboration, not additional movements.",
      "Transaction inclusion does not prove intent, authorization, fulfillment, or service quality."] } };
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

async function rawEnvelopes(page: Page) {
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

test("requires encrypted permission, saves account and transaction evidence, and does not double count", async ({ page }) => {
  let accountRelease: () => void = () => undefined;
  let accountSeen: () => void = () => undefined;
  const accountGate = new Promise<void>((resolve) => { accountRelease = resolve; });
  const accountRequest = new Promise<void>((resolve) => { accountSeen = resolve; });
  const requestBodies: string[] = [];
  page.on("request", (request) => {
    if (request.url().endsWith("/v1/private/arc/account-snapshot")) accountSeen();
    if (request.url().includes("/v1/private/arc/")) requestBodies.push(request.postData() ?? "");
  });
  if (!exactSource) {
    await page.route(`**/v1/private/arc/account-snapshot`, async (route) => {
      await accountGate;
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(accountEnvelope()) });
    });
    await page.route(`**/v1/private/arc/transaction-evidence`, async (route) => {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(transactionEnvelope()) });
    });
  }

  await createWorkspace(page);
  await page.getByRole("button", { name: /03 Activity/u }).click();
  expect(requestBodies).toEqual([]);
  await page.getByLabel("Public Arc Testnet address").fill(address);
  await page.getByRole("button", { name: "Review permission", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Allow this account observation?" })).toBeVisible();
  await expect(page.getByText(`POST /v1/private/arc/account-snapshot`, { exact: true })).toBeVisible();
  await expect(page.getByText(rpc, { exact: true })).toBeVisible();
  await expect(page.getByText(/no cookies, wallet connection, private key, or account token/iu)).toBeVisible();
  await page.getByRole("button", { name: "Approve and observe" }).click();
  await accountRequest;
  const approvalState = await rawEnvelopes(page);
  if (exactSource) expect(approvalState.length).toBeGreaterThanOrEqual(3);
  else expect(approvalState).toHaveLength(3);
  expect(JSON.stringify(approvalState)).not.toContain(address);
  if (!exactSource) accountRelease();
  await expect(page.getByText("Arc account snapshot validated and encrypted locally.", { exact: false })).toBeVisible();
  await expect(page.getByText("1.0000001 USDC", { exact: true })).toBeVisible();
  expect(JSON.parse(requestBodies[0]!)).toEqual({ network, address });

  await page.getByRole("button", { name: "Transaction evidence" }).click();
  await page.getByLabel("Public Arc Testnet transaction hash").fill(transactionHash);
  await page.getByRole("button", { name: "Review permission", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Allow this transaction observation?" })).toBeVisible();
  await expect(page.getByText(`POST /v1/private/arc/transaction-evidence`, { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Approve and observe" }).click();
  await expect(page.getByText("Matching ERC-20 logs were not double-counted.", { exact: false })).toBeVisible();
  await expect(page.getByText("1 (1 ERC-20 corroborated)", { exact: true })).toBeVisible();
  const transactionCard = page.locator("article.activity-card").filter({ hasText: transactionHash });
  await transactionCard.getByText("Limitations and source details").click();
  await expect(transactionCard.getByText(/it is not counted twice/iu)).toBeVisible();
  expect(JSON.parse(requestBodies[1]!)).toEqual({ network, transactionHash });

  const raw = await rawEnvelopes(page);
  expect(raw).toHaveLength(6);
  const rawText = JSON.stringify(raw);
  expect(rawText).not.toContain(address);
  expect(rawText).not.toContain(transactionHash);
  expect(rawText).not.toContain("openarc.arc-observation-record.v1");
});

test("a failed refresh preserves prior ciphertext, marks it stale, and remains accessible on mobile", async ({ page }) => {
  test.skip(exactSource, "The exact production source fixture proves the success path; bounded failures run without external contact.");
  await page.route(`**/v1/private/arc/account-snapshot`, async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(accountEnvelope()) });
  });
  await createWorkspace(page);
  await page.getByRole("button", { name: /03 Activity/u }).click();
  await page.getByLabel("Public Arc Testnet address").fill(address);
  await page.getByRole("button", { name: "Review permission", exact: true }).click();
  await page.getByRole("button", { name: "Approve and observe" }).click();
  await expect(page.getByText("1.0000001 USDC", { exact: true })).toBeVisible();
  const before = await rawEnvelopes(page);

  await page.unroute(`**/v1/private/arc/account-snapshot`);
  await page.route(`**/v1/private/arc/account-snapshot`, async (route) => {
    await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ ok: false,
      error: { code: "SOURCE_UNAVAILABLE", message: "The approved source is temporarily unavailable.", retryable: true },
      meta: meta() }) });
  });
  const card = page.locator("article.activity-card").filter({ hasText: address });
  await card.getByRole("button", { name: "Review permission to refresh" }).click();
  await page.getByRole("button", { name: "Approve and observe" }).click();
  await expect(page.getByRole("alert")).toContainText("Prior encrypted evidence remains unchanged");
  await expect(card.getByRole("heading", { name: "STALE · LAST REFRESH FAILED" })).toBeVisible();
  const after = await rawEnvelopes(page);
  const beforeSerialized = new Set(before.map((record) => JSON.stringify(record)));
  expect(after.filter((record) => beforeSerialized.has(JSON.stringify(record))).length).toBeGreaterThanOrEqual(3);

  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
  expect(results.violations.filter((violation) => ["serious", "critical"].includes(violation.impact ?? ""))).toEqual([]);
});
