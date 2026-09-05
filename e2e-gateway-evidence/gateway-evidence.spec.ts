import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { ARC_TESTNET, X402ReceiptBundleSchema } from "../packages/shared/src/index.js";
import { GATEWAY_TEST_REQUEST, gatewayEnvelope } from "../apps/web/test/gateway-test-fixtures.js";

const passphrase = "synthetic gateway evidence passphrase";
const path = "/v1/private/gateway/transfer";
const exactSource = process.env.OPENARC_EXACT_SOURCE === "true";
const bundleId = "44444444-4444-4444-8444-444444444444";
function bundle() {
  const domain = { network: ARC_TESTNET.caip2, asset: ARC_TESTNET.contracts.usdc,
    domainName: "GatewayWalletBatched", domainVersion: "1", verifyingContract: ARC_TESTNET.contracts.gatewayWallet };
  return X402ReceiptBundleSchema.parse({ schemaVersion: "openarc.x402-receipt-bundle.v1", bundleId,
    capturedAt: "2026-09-05T12:03:00Z", provenance: "imported_metadata", authentication: "not_verified",
    resource: { originDigest: `sha256:${"b".repeat(64)}`, resourceDigest: `sha256:${"c".repeat(64)}` },
    requirement: { ...domain, x402Version: 2, scheme: "exact", payTo: `0x${"2".repeat(40)}`, amount: "1000", maxTimeoutSeconds: "604900" },
    authorizationMetadata: { ...domain, from: `0x${"1".repeat(40)}`, to: `0x${"2".repeat(40)}`, value: "1000", nonce: `0x${"a".repeat(64)}`,
      validAfter: String(Date.parse("2026-09-05T11:59:00Z") / 1000), validBefore: String(Date.parse("2026-09-13T12:00:00Z") / 1000) },
    responseMetadata: { respondedAt: "2026-09-05T12:01:00Z", httpStatus: 200, reportedSuccess: true,
      responseDigest: `sha256:${"d".repeat(64)}`, transferId: GATEWAY_TEST_REQUEST.transferId } });
}
async function createWorkspace(page: Page) {
  await page.goto("/workspace");
  await page.getByLabel("Workspace passphrase", { exact: false }).fill(passphrase);
  await page.getByLabel("Confirm passphrase").fill(passphrase);
  await page.getByRole("button", { name: "Create encrypted workspace" }).click();
  await page.getByRole("checkbox", { name: /I saved it somewhere private/u }).check();
  await page.getByRole("button", { name: "Continue to workspace" }).click();
  await page.getByRole("button", { name: "Skip" }).click();
  await page.getByRole("button", { name: /09 Payments/u }).click();
}
async function importBundle(page: Page, value: unknown = bundle()) {
  await page.getByLabel("Normalized x402 metadata JSON").fill(JSON.stringify(value));
  await page.getByRole("button", { name: "Encrypt metadata locally" }).click();
}
async function prepareRead(page: Page) {
  await page.getByLabel("Gateway transfer UUID").fill(GATEWAY_TEST_REQUEST.transferId);
  await page.getByLabel("Local metadata association").selectOption({ index: 1 });
  await page.getByRole("checkbox", { name: /I associate this report/u }).check();
  await page.getByRole("button", { name: "Review Gateway permission" }).click();
}
async function rawRecords(page: Page) {
  return page.evaluate(async () => {
    const opened = indexedDB.open("openarc-vault");
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      opened.onsuccess = () => resolve(opened.result); opened.onerror = () => reject(opened.error);
    });
    const query = db.transaction("records", "readonly").objectStore("records").getAll();
    const records = await new Promise<unknown[]>((resolve, reject) => {
      query.onsuccess = () => resolve(query.result);query.onerror = () => reject(query.error);
    });
    db.close();return records;
  });
}

test("local metadata, consented exact Gateway read and encrypted evidence survive reload without automatic refresh", async ({ page }) => {
  const bodies: string[] = [];
  let release: () => void = () => undefined;
  const waiting = new Promise<void>(resolve => { release = resolve; });
  page.on("request", request => { if (new URL(request.url()).pathname === path) bodies.push(request.postData() ?? ""); });
  if (!exactSource) await page.route(`**${path}`, async route => { await waiting;
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(gatewayEnvelope()) }); });
  await createWorkspace(page);
  if (exactSource) {
    expect(process.env.EXPECTED_BUILD_SHA).toMatch(/^[0-9a-f]{40}$/u);
    await expect(page.locator('meta[name="openarc-build-sha"]')).toHaveAttribute("content", process.env.EXPECTED_BUILD_SHA!);
  }
  await importBundle(page);
  await expect(page.getByRole("heading", { name: `Imported bundle ${bundleId}` })).toBeVisible();
  await expect(page.getByText("Metadata agreement:", { exact: false })).toContainText("incomplete");
  expect(bodies).toEqual([]);
  const before = (await rawRecords(page)).length;
  await prepareRead(page);
  await expect(page.getByRole("dialog")).toContainText("Bundle contents, labels, local associations, payer, nonce and resource digests are not sent.");
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  expect(bodies).toEqual([]);
  await page.getByRole("button", { name: "Review Gateway permission" }).click();
  const responseProof = page.waitForResponse(response => new URL(response.url()).pathname === path && response.request().method() === "POST")
    .then(async response => ({ status: response.status(), body: await response.json() as { meta: { buildSha: string } } }));
  await page.getByRole("button", { name: "Approve and read Gateway" }).click();
  await expect.poll(() => bodies.length).toBe(1);
  if (!exactSource) { expect((await rawRecords(page)).length).toBe(before + 1); release(); }
  const proof = await responseProof;
  expect(proof.status).toBe(200);
  if (exactSource) expect(proof.body.meta.buildSha).toBe(process.env.EXPECTED_BUILD_SHA);
  await expect(page.getByRole("heading", { name: "Gateway reports completed" })).toBeVisible();
  // A completed provider report without a batch hash still has an explicit gap.
  await expect(page.getByText("Metadata agreement:", { exact: false })).toContainText("incomplete");
  await expect(page.getByText("Authorization signature: not verified. Fulfillment: not verified.", { exact: true })).toBeVisible();
  expect(JSON.parse(bodies[0]!)).toEqual(GATEWAY_TEST_REQUEST);
  expect((await rawRecords(page)).length).toBe(before + 2);
  const encrypted = JSON.stringify(await rawRecords(page));
  for (const canary of [passphrase, bundleId, bundle().resource.resourceDigest, GATEWAY_TEST_REQUEST.transferId,
    "openarc.gateway-transfer-observation.v1", "openarc.x402-receipt-bundle.v1"]) expect(encrypted).not.toContain(canary);
  const a11y = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
  expect(a11y.violations.filter(violation => ["serious", "critical"].includes(violation.impact ?? ""))).toEqual([]);
  await page.screenshot({ path: `tmp/m07-payments-${test.info().project.name}.png`, fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  await page.screenshot({ path: `tmp/m07-payments-mobile-${test.info().project.name}.png`, fullPage: true });
  await page.reload();
  await expect(page.getByRole("heading", { name: "Unlock your private workspace" })).toBeVisible();
  await page.getByLabel("Workspace passphrase", { exact: false }).fill(passphrase);
  await page.getByRole("button", { name: "Unlock workspace", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Gateway reports completed" })).toBeVisible();
  expect(bodies).toHaveLength(1);
  await expect(page.getByRole("button", { name: "Delete metadata", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "Delete Gateway report" }).click();
  await expect(page.getByRole("heading", { name: "Gateway reports completed" })).toHaveCount(0);
  expect((await rawRecords(page)).length).toBe(before);
  await page.getByRole("button", { name: "Delete metadata", exact: true }).click();
  await expect(page.getByText("No payment evidence yet. Nothing is fetched automatically.", { exact: true })).toBeVisible();
});

test("saved Arc batch comparison remains local and cannot prove individual settlement", async ({ page }) => {
  test.skip(exactSource, "Controlled mocked transaction and Gateway sources only.");
  const matchingHash = `0x${"b".repeat(64)}`;
  const otherHash = `0x${"c".repeat(64)}`;
  const blockHash = `0x${"a".repeat(64)}`;
  const bodies: unknown[] = [];
  await page.route("**/v1/private/arc/transaction-evidence", async route => {
    const request = route.request().postDataJSON() as { network: string; transactionHash: string };
    bodies.push(request);
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true,
      meta: { schemaVersion: "openarc.api.v1", requestId: crypto.randomUUID(), buildSha: "gateway-evidence-e2e" },
      data: { schemaVersion: "openarc.arc-transaction-evidence.v1", network: ARC_TESTNET.caip2,
        transaction: { hash: request.transactionHash, blockNumber: "100", blockHash, transactionIndex: "2",
          from: `0x${"1".repeat(40)}`, to: `0x${"2".repeat(40)}`, nativeValue: { baseUnits: "0", decimals: 18, decimal: "0" } },
        receipt: { status: "success", gasUsed: "21000",
          effectiveGasPrice: { baseUnits: "20000000000", decimals: 18, decimal: "0.00000002" },
          fee: { baseUnits: "420000000000000", decimals: 18, decimal: "0.00042" } },
        anchor: { blockNumber: "100", blockHash, blockTimestamp: "2026-09-05T12:04:00Z", finality: "deterministic", confirmations: "1" },
        movements: [], coverage: { totalLogs: 0, canonicalMovements: 0, corroboratedMovements: 0, unsupportedLogs: 0, completeForUsdcTransfers: true },
        source: { sourceId: "arc_primary_rpc", origin: "https://rpc.testnet.arc.io", explorerOrigin: "https://testnet.arcscan.app",
          network: ARC_TESTNET.caip2, sourceRevision: "arc-docs-2026-09-03", observedAt: "2026-09-05T12:05:00Z", adapterVersion: "openarc.arc-observation.m04.v1" },
        limitations: ["This is a read-only observation of one Arc Testnet transaction and receipt.",
          "EIP-7708 system events are canonical; matching ERC-20 events are corroboration, not additional movements.",
          "Transaction inclusion does not prove intent, authorization, fulfillment, or service quality."] } }) });
  });
  const envelope = gatewayEnvelope();
  envelope.data.transfer.txHash = matchingHash;
  await page.route(`**${path}`, async route => { bodies.push(route.request().postDataJSON());
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(envelope) }); });
  await createWorkspace(page);
  await page.getByRole("button", { name: /03 Activity/u }).click();
  await page.getByRole("button", { name: "Transaction evidence", exact: true }).click();
  for (const transactionHash of [matchingHash, otherHash]) {
    await page.getByLabel("Public Arc Testnet transaction hash").fill(transactionHash);
    await page.getByRole("button", { name: "Review permission", exact: true }).click();
    await page.getByRole("button", { name: "Approve and observe", exact: true }).click();
    await expect(page.locator("article.activity-card").filter({ hasText: transactionHash })).toBeVisible();
  }
  await page.getByRole("button", { name: /09 Payments/u }).click();
  await importBundle(page); await prepareRead(page);
  await page.getByRole("button", { name: "Approve and read Gateway" }).click();
  await expect(page.getByRole("heading", { name: "Gateway reports completed" })).toBeVisible();
  const before = (await rawRecords(page)).length;
  const selector = page.getByLabel("Compare a saved batch transaction (local only)");
  await selector.selectOption({ label: matchingHash });
  await expect(page.getByText("Batch inclusion:", { exact: false })).toContainText("included_successfully");
  await page.getByText("Reasons and exact evidence citations", { exact: true }).click();
  await expect(page.locator("pre").first()).toContainText('"onchainSettlement": "not_verified"');
  await selector.selectOption({ label: otherHash });
  await expect(page.getByText("Metadata agreement:", { exact: false })).toContainText("conflicting");
  await expect(page.locator("pre").first()).toContainText("BATCH_TRANSACTION_HASH_MISMATCH");
  await expect(page.getByText("Batch inclusion:", { exact: false })).not.toContainText("included_successfully");
  await expect(page.locator("pre").first()).toContainText('"onchainSettlement": "not_verified"');
  expect(bodies).toEqual([{ network: ARC_TESTNET.caip2, transactionHash: matchingHash },
    { network: ARC_TESTNET.caip2, transactionHash: otherHash }, GATEWAY_TEST_REQUEST]);
  expect((await rawRecords(page)).length).toBe(before);
});

test("invalid imports, duplicates, bad UUID and unconfirmed local association make no request", async ({ page }) => {
  test.skip(exactSource, "Mocked/local input failure journey.");
  const requests: string[] = [];
  page.on("request", request => { if (new URL(request.url()).pathname === path) requests.push(request.url()); });
  await createWorkspace(page);
  for (const value of [{ ...bundle(), signature: `0x${"e".repeat(130)}` }, { ...bundle(), authentication: "verified" }]) {
    await importBundle(page, value);
    await expect(page.getByRole("alert")).toContainText("Unknown fields are rejected");
  }
  await importBundle(page);
  await expect(page.getByRole("heading", { name: `Imported bundle ${bundleId}` })).toBeVisible();
  await importBundle(page);
  await expect(page.getByRole("alert")).toContainText("already stored");
  await page.getByLabel("Gateway transfer UUID").fill("bad-uuid");
  await page.getByRole("button", { name: "Review Gateway permission" }).click();
  await expect(page.getByRole("alert")).toContainText("lowercase transfer UUID");
  await page.getByLabel("Gateway transfer UUID").fill(GATEWAY_TEST_REQUEST.transferId);
  await page.getByLabel("Local metadata association").selectOption({ index: 1 });
  await page.getByRole("button", { name: "Review Gateway permission" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(requests).toEqual([]);
});

test("later Gateway timestamps stay renderable and mismatches remain conflicts after failed refresh", async ({ page }) => {
  test.skip(exactSource, "Mocked source conflict and failure journey.");
  let calls = 0;
  const envelope = gatewayEnvelope();
  envelope.data.transfer.amount = "999";
  // A source observation can be later than bundle capture; comparison must use
  // the latest evidence timestamp, not re-use the historical capture time.
  envelope.data.source.observedAt = "2026-09-05T13:00:00Z";
  await page.route(`**${path}`, async route => { calls += 1;
    await route.fulfill({ status: calls === 1 ? 200 : 404, contentType: "application/json",
      body: JSON.stringify(calls === 1 ? envelope : { ok: false, error: { code: "SOURCE_NOT_FOUND", message: "Source evidence was not found." }, meta: envelope.meta }) }); });
  await createWorkspace(page);await importBundle(page);await prepareRead(page);
  await page.getByRole("button", { name: "Approve and read Gateway" }).click();
  await expect(page.getByRole("heading", { name: "Gateway reports completed" })).toBeVisible();
  await expect(page.getByText("Metadata agreement:", { exact: false })).toContainText("conflicting");
  await page.getByText("Reasons and exact evidence citations", { exact: true }).click();
  await expect(page.locator("pre").first()).toContainText("AMOUNT_MISMATCH");
  await page.getByRole("button", { name: "Prepare another explicit read" }).click();
  await page.getByRole("checkbox", { name: /I associate this report/u }).check();
  await page.getByRole("button", { name: "Review Gateway permission" }).click();
  await page.getByRole("button", { name: "Approve and read Gateway" }).click();
  await expect(page.getByRole("alert")).toContainText("Prior evidence remains unchanged");
  await expect(page.getByRole("heading", { name: "Gateway reports completed" })).toHaveCount(1);
  await expect(page.getByText("Metadata agreement:", { exact: false })).toContainText("conflicting");
});
