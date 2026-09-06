import { readFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";

const [listenValue, targetValue, keyPath, certificatePath] = process.argv.slice(2);
const listenPort = Number(listenValue);
const targetPort = Number(targetValue);
if (!Number.isInteger(listenPort) || !Number.isInteger(targetPort) || !keyPath || !certificatePath) {
  process.stderr.write("TLS_FORWARDER_CONFIGURATION_FAILED\n");
  process.exit(1);
}
const server = https.createServer({ key: readFileSync(keyPath), cert: readFileSync(certificatePath) }, (incoming, outgoing) => {
  const upstream = http.request({ host: "127.0.0.1", port: targetPort, method: incoming.method,
    path: incoming.url, headers: incoming.headers, agent: false }, (response) => {
    outgoing.writeHead(response.statusCode ?? 502, response.headers);
    response.pipe(outgoing);
  });
  upstream.once("error", () => { if (!outgoing.headersSent) outgoing.writeHead(502); outgoing.end(); });
  incoming.pipe(upstream);
});
server.requestTimeout = 12_000;
server.headersTimeout = 5_000;
server.keepAliveTimeout = 2_000;
server.listen(listenPort, "0.0.0.0", () => process.stdout.write("TLS_FORWARDER_READY\n"));
const close = () => server.close(() => process.exit(0));
process.once("SIGINT", close);
process.once("SIGTERM", close);
