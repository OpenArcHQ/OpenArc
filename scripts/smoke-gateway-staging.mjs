import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { chromium, expect } from "@playwright/test";
import { API_MAX_RESPONSE_BYTES, ARC_TESTNET, ARC_TRANSACTION_EVIDENCE_PATH, ArcTransactionEvidenceEnvelopeSchema,
  GATEWAY_TRANSFER_PATH, GatewayTransferEnvelopeSchema,
  X402ReceiptBundleSchema } from "../packages/shared/dist/index.js";

// Isolated disposable browser only. One explicit transfer read, plus at most one
// explicit Arc read if Gateway supplies a batch hash. No signing or payments.
const origin = "https://web-staging-1275.up.railway.app";
const expectedSha = process.env.EXPECTED_BUILD_SHA;
assert.match(expectedSha ?? "", /^[0-9a-f]{40}$/u, "An exact expected Git SHA is required");

async function readBundle(path, label) {
  assert.ok(typeof path === "string" && isAbsolute(path), `${label} requires an explicit absolute file path`);
  const metadata = await stat(path);
  assert.ok(metadata.isFile() && metadata.size <= 16_384, `${label} must be a file of at most 16 KiB`);
  let value;
  try { value = JSON.parse(await readFile(path, "utf8")); }
  catch { throw new Error(`${label} could not be read as JSON`); }
  const parsed = X402ReceiptBundleSchema.safeParse(value);
  assert.ok(parsed.success, `${label} must match the strict normalized metadata schema`);
  return parsed.data;
}

const complete = await readBundle(process.env.COMPLETE_BUNDLE_PATH, "COMPLETE_BUNDLE_PATH");
const incomplete = await readBundle(process.env.INCOMPLETE_BUNDLE_PATH, "INCOMPLETE_BUNDLE_PATH");
assert.ok(complete.requirement && complete.authorizationMetadata && complete.responseMetadata?.transferId,
  "The complete bundle must contain all metadata stages and a transfer UUID");
assert.ok(incomplete.requirement && incomplete.authorizationMetadata && !incomplete.responseMetadata,
  "The intentionally incomplete bundle must omit response metadata");
assert.notEqual(complete.bundleId, incomplete.bundleId, "The two artifacts need distinct bundle IDs");
// The incomplete artifact is the same controlled workflow, with one stage withheld.
// This exercises duplicate evidence, not a fabricated second executed payment.
assert.ok(JSON.stringify(complete.requirement) === JSON.stringify(incomplete.requirement), "Requirements must match the controlled workflow");
assert.ok(JSON.stringify(complete.authorizationMetadata) === JSON.stringify(incomplete.authorizationMetadata), "Authorization metadata must match the controlled workflow");
assert.ok(JSON.stringify(complete.resource) === JSON.stringify(incomplete.resource), "Resource digests must match the controlled workflow");

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: "reduce" });
const page = await context.newPage();
page.setDefaultTimeout(20_000);
const apiRequests = [];
const pendingBodies = new Map();
page.on("request", (request) => {
  const url = new URL(request.url());
  if (url.pathname.startsWith("/v1/private/")) apiRequests.push({
    origin: url.origin, path: url.pathname, method: request.method(), body: request.postData(), headers: request.allHeaders(),
  });
});
async function captureResponse(path) {
  const captured = new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pendingBodies.delete(path); reject(new Error("Browser response capture timed out")); }, 20_000);
    timer.unref();
    pendingBodies.set(path, (entry) => {
      clearTimeout(timer); pendingBodies.delete(path);
      if (entry.captureFailed) reject(new Error("Browser response could not be captured within strict bounds"));
      else resolve(entry);
    });
  });
  const [response, entry] = await Promise.all([
    page.waitForResponse((response) => new URL(response.url()).pathname === path && response.request().method() === "POST"), captured,
  ]);
  assert.ok(entry.url === response.url() && entry.status === response.status(), "Captured fetch response must match the network response");
  return { response, body: entry.body };
}
const passphrase = `disposable-gateway-staging-${randomUUID()}`;
const bundleCard = (bundle) => page.locator("article").filter({
  has: page.getByRole("heading", { name: `Imported bundle ${bundle.bundleId}`, exact: true }),
});
async function resultFor(bundle) {
  const card = bundleCard(bundle);
  await card.getByText("Reasons and exact evidence citations", { exact: true }).click();
  const text = await card.locator("details").filter({ has: page.getByText("Reasons and exact evidence citations", { exact: true }) })
    .locator("pre").textContent();
  let result;
  try { result = JSON.parse(text ?? "null"); }
  catch { throw new Error("Reconciliation proof is not valid JSON"); }
  assert.ok(result && result.ruleVersion === "openarc.x402-reconciliation.m07.v1", "Reconciliation proof must name the reviewed rule");
  await card.getByText("Reasons and exact evidence citations", { exact: true }).click();
  return result;
}

try {
  await page.exposeBinding("__openarcSmokeResponse", (_source, entry) => {
    const url = new URL(entry.url);
    assert.equal(url.origin, origin, "Response capture must remain same-origin");
    pendingBodies.get(url.pathname)?.(entry);
  });
  await page.addInitScript(({ paths, maxBytes }) => {
    const originalFetch = globalThis.fetch;
    // Test-only observation in this disposable browser. Return the original
    // promise/response untouched; never intercept, replay or change request options.
    // Reading a bounded clone avoids Chromium's flaky CDP getResponseBody cache.
    globalThis.fetch = function (...args) {
      const pending = Reflect.apply(originalFetch, this, args);
      void pending.then(async (response) => {
        if (!paths.includes(new URL(response.url).pathname)) return;
        const entry = { url: response.url, status: response.status };
        let reader;
        try {
          reader = response.clone().body?.getReader();
          if (!reader) throw new Error("Missing response body");
          const chunks = []; let size = 0;
          while (true) {
            const next = await reader.read();
            if (next.done) break;
            size += next.value.byteLength;
            if (size > maxBytes) throw new Error("Response cap exceeded");
            chunks.push(next.value);
          }
          const bytes = new Uint8Array(size); let offset = 0;
          for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
          const body = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
          await globalThis.__openarcSmokeResponse({ ...entry, body });
        } catch {
          await globalThis.__openarcSmokeResponse({ ...entry, captureFailed: true });
        } finally { void reader?.cancel().catch(() => undefined); }
      }, () => undefined).catch(() => undefined);
      return pending;
    };
  }, { paths: [GATEWAY_TRANSFER_PATH, ARC_TRANSACTION_EVIDENCE_PATH], maxBytes: API_MAX_RESPONSE_BYTES });
  await page.goto(`${origin}/workspace?view=payments`);
  assert.equal(await page.locator('meta[name="openarc-build-sha"]').getAttribute("content"), expectedSha);
  await page.getByLabel("Workspace passphrase", { exact: false }).fill(passphrase);
  await page.getByLabel("Confirm passphrase").fill(passphrase);
  await page.getByRole("button", { name: "Create encrypted workspace" }).click();
  await page.getByRole("checkbox", { name: /I saved it somewhere private/u }).check();
  await page.getByRole("button", { name: "Continue to workspace" }).click();
  await page.getByRole("button", { name: "Skip", exact: true }).click();
  await page.getByRole("button", { name: /09 Payments/u }).click();
  assert.equal(apiRequests.length, 0);

  for (const bundle of [complete, incomplete]) {
    await page.getByLabel("Normalized x402 metadata JSON").fill(JSON.stringify(bundle));
    await page.getByRole("button", { name: "Encrypt metadata locally", exact: true }).click();
    await bundleCard(bundle).getByRole("heading", { name: `Imported bundle ${bundle.bundleId}`, exact: true }).waitFor();
  }
  assert.equal(apiRequests.length, 0, "Local imports must not contact the API");

  await page.getByLabel("Gateway transfer UUID", { exact: true }).fill(complete.responseMetadata.transferId);
  await page.getByLabel("Local metadata association").selectOption({ label: complete.bundleId });
  await page.getByRole("checkbox", { name: /I associate this report with this local bundle/u }).check();
  await page.getByRole("button", { name: "Review Gateway permission", exact: true }).click();
  assert.equal(apiRequests.length, 0, "Review alone must not send identifiers");
  await page.getByRole("dialog", { name: "Allow this Gateway read?" }).getByRole("button", { name: "Cancel", exact: true }).click();
  assert.equal(apiRequests.length, 0, "Cancelling permission must not contact the API");
  await page.getByRole("button", { name: "Review Gateway permission", exact: true }).click();
  const pending = captureResponse(GATEWAY_TRANSFER_PATH);
  const [{ response, body }] = await Promise.all([
    pending, page.getByRole("button", { name: "Approve and read Gateway", exact: true }).click(),
  ]);
  assert.equal(response.status(), 200, "The exact staging transfer read must succeed");
  const cacheDirectives = (response.headers()["cache-control"] ?? "").split(",").map((value) => value.trim());
  assert.ok(cacheDirectives.length > 0 && cacheDirectives.every((value) => value === "no-store"), "Source responses must not be cached");
  const parsed = GatewayTransferEnvelopeSchema.safeParse(body);
  assert.ok(parsed.success, "Staging must return a valid bounded Gateway envelope");
  const envelope = parsed.data;
  assert.equal(envelope.meta.buildSha, expectedSha);
  assert.ok(envelope.data.transfer.id === complete.responseMetadata.transferId, "Response must bind the explicitly released UUID");
  assert.equal(apiRequests.length, 1, "Exactly one consented read is permitted");
  const sent = apiRequests[0];
  assert.equal(sent.origin, origin);
  assert.equal(sent.path, GATEWAY_TRANSFER_PATH);
  assert.equal(sent.method, "POST");
  let payload;
  try { payload = JSON.parse(sent.body ?? "null"); }
  catch { throw new Error("The outgoing request is not JSON"); }
  assert.ok(JSON.stringify(payload) === JSON.stringify({ network: ARC_TESTNET.caip2, transferId: complete.responseMetadata.transferId }),
    "Only network and transfer UUID may be released");
  const sentHeaders = await sent.headers;
  for (const header of ["cookie", "authorization", "referer"]) assert.ok(sentHeaders[header] === undefined, `${header} must be omitted`);
  await page.getByRole("heading", { name: `Gateway reports ${envelope.data.transfer.status}`, exact: true }).waitFor();
  await expect(bundleCard(complete)).toContainText(`Gateway: reports ${envelope.data.transfer.status}`);
  let completeResult = await resultFor(complete);
  const incompleteResult = await resultFor(incomplete);
  assert.ok(["consistent", "incomplete"].includes(completeResult.metadataAgreement), "Observed complete metadata must not contradict the controlled Gateway read");
  assert.equal(incompleteResult.metadataAgreement, "incomplete");
  assert.ok(incompleteResult.gaps.some((finding) => finding.code === "RESPONSE_METADATA_NOT_SUPPLIED"));
  for (const result of [completeResult, incompleteResult]) {
    assert.equal(result.conflicts.length, 0, "Repeated imported authorization metadata is not an executed replay");
    assert.ok(result.duplicates.some((finding) => finding.code === "DUPLICATE_AUTHORIZATION_METADATA"));
    assert.equal(result.authorizationVerification, "not_verified");
    assert.equal(result.fulfillment, "not_verified");
    assert.equal(result.onchainSettlement, "not_verified");
    assert.equal(result.batchInclusion, "not_observed");
  }

  let batchAnchor = null;
  const batchHash = envelope.data.transfer.txHash;
  const expectedRequests = batchHash ? 2 : 1;
  if (batchHash) {
    await page.getByRole("button", { name: /03 Activity/u }).click();
    await page.getByRole("button", { name: "Transaction evidence", exact: true }).click();
    await page.getByLabel("Public Arc Testnet transaction hash", { exact: false }).fill(batchHash);
    await page.getByRole("button", { name: "Review permission", exact: true }).click();
    assert.equal(apiRequests.length, 1, "Preparing the batch comparison must not make a request");
    const pendingBatch = captureResponse(ARC_TRANSACTION_EVIDENCE_PATH);
    const [{ response: batchResponse, body: batchBody }] = await Promise.all([
      pendingBatch, page.getByRole("button", { name: "Approve and observe", exact: true }).click(),
    ]);
    assert.equal(batchResponse.status(), 200, "The explicitly selected Arc batch read must succeed");
    const directives = (batchResponse.headers()["cache-control"] ?? "").split(",").map((value) => value.trim());
    assert.ok(directives.length > 0 && directives.every((value) => value === "no-store"));
    const parsedBatch = ArcTransactionEvidenceEnvelopeSchema.safeParse(batchBody);
    assert.ok(parsedBatch.success, "Arc must return strict transaction evidence");
    assert.equal(parsedBatch.data.meta.buildSha, expectedSha);
    assert.ok(parsedBatch.data.data.transaction.hash === batchHash, "Arc response must match the released batch hash");
    assert.equal(parsedBatch.data.data.network, ARC_TESTNET.caip2);
    assert.equal(parsedBatch.data.data.receipt.status, "success");
    assert.equal(apiRequests.length, 2, "Only one optional Arc transaction read is permitted");
    const batchRequest = apiRequests[1];
    assert.equal(batchRequest.origin, origin);
    assert.equal(batchRequest.path, ARC_TRANSACTION_EVIDENCE_PATH);
    assert.equal(batchRequest.method, "POST");
    let batchPayload;
    try { batchPayload = JSON.parse(batchRequest.body ?? "null"); }
    catch { throw new Error("The batch request is not JSON"); }
    assert.ok(JSON.stringify(batchPayload) === JSON.stringify({ network: ARC_TESTNET.caip2, transactionHash: batchHash }),
      "Only network and exact batch transaction hash may be released");
    const batchHeaders = await batchRequest.headers;
    for (const header of ["cookie", "authorization", "referer"]) assert.ok(batchHeaders[header] === undefined, `${header} must be omitted`);
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await page.getByRole("button", { name: /09 Payments/u }).click();
    await bundleCard(complete).getByLabel("Compare a saved batch transaction (local only)").selectOption({ label: batchHash });
    await expect(bundleCard(complete)).toContainText("Batch inclusion: included_successfully");
    completeResult = await resultFor(complete);
    assert.equal(completeResult.batchInclusion, "included_successfully");
    assert.equal(completeResult.onchainSettlement, "not_verified");
    assert.equal(completeResult.fulfillment, "not_verified");
    assert.equal(completeResult.conflicts.length, 0);
    assert.ok(["consistent", "incomplete"].includes(completeResult.metadataAgreement));
    assert.ok(completeResult.duplicates.some((finding) => finding.code === "DUPLICATE_AUTHORIZATION_METADATA"));
    batchAnchor = parsedBatch.data.data.anchor;
  }

  const raw = await page.evaluate(async () => {
    const opened = globalThis.indexedDB.open("openarc-vault");
    const db = await new Promise((resolve, reject) => { opened.onsuccess = () => resolve(opened.result); opened.onerror = () => reject(opened.error); });
    const query = db.transaction("records", "readonly").objectStore("records").getAll();
    const records = await new Promise((resolve, reject) => { query.onsuccess = () => resolve(query.result); query.onerror = () => reject(query.error); });
    db.close(); return JSON.stringify(records);
  });
  for (const canary of [passphrase, complete.bundleId, incomplete.bundleId, complete.authorizationMetadata.nonce,
    complete.resource.resourceDigest, "openarc.x402-receipt-bundle.v1", "openarc.gateway-transfer-observation.v1",
    ...(batchHash ? [batchHash, "openarc.arc-transaction-evidence.v1"] : [])]) {
    assert.ok(!raw.includes(canary), "Private evidence must not appear in plaintext IndexedDB records");
  }
  await mkdir("tmp/m07-staging", { recursive: true });
  await page.screenshot({ path: "tmp/m07-staging/payments-desktop.png", fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => globalThis.document.documentElement.scrollWidth <= globalThis.document.documentElement.clientWidth), true);
  await page.screenshot({ path: "tmp/m07-staging/payments-mobile.png", fullPage: true });
  await page.reload();
  await page.getByRole("heading", { name: "Unlock your private workspace" }).waitFor();
  assert.equal(await page.getByRole("heading", { name: `Imported bundle ${complete.bundleId}`, exact: true }).count(), 0);
  await page.getByLabel("Workspace passphrase", { exact: false }).fill(passphrase);
  await page.getByRole("button", { name: "Unlock workspace", exact: true }).click();
  await bundleCard(complete).waitFor();
  await bundleCard(incomplete).waitFor();
  await page.getByRole("heading", { name: `Gateway reports ${envelope.data.transfer.status}`, exact: true }).waitFor();
  if (batchHash) {
    // The comparison selection is intentionally ephemeral. Reselect the saved,
    // encrypted transaction after unlock; this must not issue another read.
    await bundleCard(complete).getByLabel("Compare a saved batch transaction (local only)").selectOption({ label: batchHash });
    await expect(bundleCard(complete)).toContainText("Batch inclusion: included_successfully");
    const restored = await resultFor(complete);
    assert.equal(restored.onchainSettlement, "not_verified");
    assert.equal(restored.conflicts.length, 0);
  }
  assert.equal(apiRequests.length, expectedRequests, "Reload and unlock must not repeat a source read");
  process.stdout.write(`${JSON.stringify({ passed: true, buildSha: expectedSha, publicLookups: apiRequests.length,
    gatewayStatus: envelope.data.transfer.status, metadataAgreement: completeResult.metadataAgreement,
    incompleteGaps: incompleteResult.gaps.map((finding) => finding.code),
    duplicateEvidence: completeResult.duplicates.map((finding) => finding.code),
    batchInclusion: completeResult.batchInclusion, batchAnchor,
    encryptedPersistence: true, automaticRefresh: false, individualSettlementVerified: false })}\n`);
} finally {
  await context.close();
  await browser.close();
}
