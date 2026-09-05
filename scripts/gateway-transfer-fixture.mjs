import { readFileSync } from "node:fs";
import { createServer } from "node:https";

// Isolated CI source only. Never imported into the product or used as live evidence.
const keyPath = process.env.OPENARC_FIXTURE_TLS_KEY;
const certPath = process.env.OPENARC_FIXTURE_TLS_CERT;
if (!keyPath || !certPath) throw new Error("Fixture TLS paths are required");
const transfer = {
  id: "33333333-3333-4333-8333-333333333333", status: "completed", token: "USDC",
  sendingNetwork: "eip155:5042002", recipientNetwork: "eip155:5042002",
  fromAddress: "0x1111111111111111111111111111111111111111",
  toAddress: "0x2222222222222222222222222222222222222222",
  amount: "1000", nonce: `0x${"a".repeat(64)}`, txHash: null,
  createdAt: "2026-09-05T12:00:00Z", updatedAt: "2026-09-05T12:01:00Z",
};
const server = createServer({ key: readFileSync(keyPath), cert: readFileSync(certPath), maxHeaderSize: 8192 }, (request, response) => {
  response.setHeader("Content-Type", "application/json");
  response.setHeader("Cache-Control", "no-store");
  if (request.method !== "GET" || request.headers.host !== "gateway-api-testnet.circle.com" ||
    request.headers.authorization !== undefined || request.headers.cookie !== undefined ||
    request.headers["proxy-authorization"] !== undefined || request.headers["transfer-encoding"] !== undefined ||
    (request.headers["content-length"] !== undefined && request.headers["content-length"] !== "0")) {
    response.writeHead(400); response.end('{"error":"fixture_boundary_rejected"}'); return;
  }
  if (request.url !== `/v1/x402/transfers/${transfer.id}`) {
    response.writeHead(404); response.end('{"error":"fixture_not_found"}'); return;
  }
  response.writeHead(200); response.end(JSON.stringify(transfer));
});
server.requestTimeout = 5000;
server.headersTimeout = 5000;
server.listen(443, "0.0.0.0", () => process.stdout.write("gateway_fixture_ready\n"));
