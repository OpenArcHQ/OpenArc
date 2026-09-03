import { readFileSync } from "node:fs";
import { createServer } from "node:https";

const keyPath = process.env.OPENARC_FIXTURE_TLS_KEY;
const certPath = process.env.OPENARC_FIXTURE_TLS_CERT;
if (!keyPath || !certPath) throw new Error("Fixture TLS paths are required");

const address = "0x1111111111111111111111111111111111111111";
const to = "0x2222222222222222222222222222222222222222";
const transactionHash = `0x${"b".repeat(64)}`;
const blockHash = `0x${"a".repeat(64)}`;
const usdc = "0x3600000000000000000000000000000000000000";
const systemEmitter = "0xfffffffffffffffffffffffffffffffffffffffe";
const transferTopic = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const word = (value) => `0x${value.toString(16).padStart(64, "0")}`;
const topic = (value) => `0x${value.slice(2).padStart(64, "0")}`;
const block = { number: "0x64", hash: blockHash, timestamp: "0x68b86d7f" };
const transaction = { hash: transactionHash, blockHash, blockNumber: "0x64", transactionIndex: "0x2",
  from: address, to, value: "0x0" };
const log = (emitter, index, value) => ({ address: emitter,
  topics: [transferTopic, topic(address), topic(to)], data: word(value), transactionHash, blockHash,
  blockNumber: "0x64", transactionIndex: "0x2", logIndex: index, removed: false });
const receipt = { transactionHash, blockHash, blockNumber: "0x64", transactionIndex: "0x2",
  from: address, to, status: "0x1", gasUsed: "0x5208", effectiveGasPrice: "0x4a817c800",
  logs: [log(systemEmitter, "0x0", 1_000_000_000_000_000_000n), log(usdc, "0x1", 1_000_000n)] };

function result(method, params) {
  if (method === "eth_chainId" && params.length === 0) return "0x4cef52";
  if (method === "eth_getBlockByNumber" && params.length === 2 && params[1] === false &&
    (params[0] === "latest" || params[0] === "0x64")) return block;
  if (method === "eth_getBlockByHash" && params.length === 2 && params[0] === blockHash && params[1] === false) return block;
  if (method === "eth_getBalance" && params[0] === address && params[1] === "0x64") {
    return `0x${1_000_000_100_000_000_000n.toString(16)}`;
  }
  if (method === "eth_call" && params.length === 2 && params[1] === "0x64" &&
    params[0]?.to === usdc && params[0]?.data === `0x70a08231${address.slice(2).padStart(64, "0")}`) {
    return word(1_000_000n);
  }
  if (method === "eth_getTransactionByHash" && params[0] === transactionHash) return transaction;
  if (method === "eth_getTransactionReceipt" && params[0] === transactionHash) return receipt;
  return null;
}

const server = createServer({ key: readFileSync(keyPath), cert: readFileSync(certPath) }, (request, response) => {
  if (request.method !== "POST" || request.url !== "/") {
    response.writeHead(404, { "Content-Type": "application/json" }).end("{}");
    return;
  }
  const chunks = [];
  let bytes = 0;
  request.on("data", (chunk) => {
    bytes += chunk.length;
    if (bytes > 16_384) request.destroy();
    else chunks.push(chunk);
  });
  request.on("end", () => {
    try {
      const input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (!input || input.jsonrpc !== "2.0" || typeof input.id !== "string" ||
        typeof input.method !== "string" || !Array.isArray(input.params)) throw new Error("invalid fixture request");
      const body = JSON.stringify({ jsonrpc: "2.0", id: input.id, result: result(input.method, input.params) });
      response.writeHead(200, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body),
        "Cache-Control": "no-store" }).end(body);
    } catch {
      response.writeHead(400, { "Content-Type": "application/json" }).end("{}");
    }
  });
});

server.listen(443, "0.0.0.0", () => process.stdout.write("fixture_ready\n"));
const shutdown = () => server.close(() => process.exit(0));
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
