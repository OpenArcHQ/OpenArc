import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

/**
 * Static deployment guards for the protected organization write proxy.
 *
 * These assertions read the real nginx directives (never comments) and the
 * Dockerfile wiring. They prove the write surface is narrow, method-exact and
 * fail-closed by default; they do not prove a live TLS upstream or end-to-end
 * API behavior.
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (relativePath) => readFileSync(path.join(root, relativePath), "utf8");

const FILES = {
  writeLocations: "apps/web/nginx-tenant-write-locations.conf",
  readLocations: "apps/web/nginx-tenant-locations.conf",
  disabled: "apps/web/nginx-tenant-disabled.conf",
  writeParams: "apps/web/tenant_write_proxy_params",
  readParams: "apps/web/tenant_proxy_params",
  dockerfile: "apps/web/Dockerfile",
};

const UUID_ID = "[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
const UUID_MUTATION = "[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
const ORG = `openarc:org:${UUID_ID}`;

const writeSource = read(FILES.writeLocations);
const readSource = read(FILES.readLocations);
const disabledSource = read(FILES.disabled);
const writeParams = read(FILES.writeParams);
const readParams = read(FILES.readParams);

function stripNginxComments(config) {
  return config
    .split("\n")
    .map((line) => line.replace(/(^|\s)#[^\n]*$/u, ""))
    .join("\n");
}

function parseLocations(config) {
  const locations = [];
  const header = /location\s+([=^~]*)\s*("@?[^"]*"|\S+)\s*\{/gu;
  let match;
  while ((match = header.exec(config)) !== null) {
    const open = match.index + match[0].length - 1;
    let depth = 0;
    let close = -1;
    for (let index = open; index < config.length; index += 1) {
      if (config[index] === "{") depth += 1;
      else if (config[index] === "}") {
        depth -= 1;
        if (depth === 0) {
          close = index;
          break;
        }
      }
    }
    assert.ok(close > open, `unterminated location block for ${match[2]}`);
    const rawPath = match[2];
    locations.push({
      modifier: match[1],
      path: rawPath.startsWith('"') ? rawPath.slice(1, -1) : rawPath,
      raw: rawPath,
      body: config.slice(open + 1, close),
    });
    header.lastIndex = close + 1;
  }
  return locations;
}

function directiveValues(config, name) {
  const values = [];
  const pattern = new RegExp(`^\\s*${name}\\s+([^;]+);`, "gmu");
  for (const match of config.matchAll(pattern)) values.push(match[1].trim());
  return values;
}

const stripped = stripNginxComments(writeSource);
const locations = parseLocations(stripped);
const proxying = locations.filter((entry) => entry.body.includes("proxy_pass"));
const named = locations.filter((entry) => entry.path.startsWith("@"));

test("write include proxies exactly the six writes and two status reads plus four reads", () => {
  // Four read-family GETs (list, context, agents, providers) and the write
  // routes/named locations. Every proxying location must be one of the
  // reviewed shapes.
  assert.ok(proxying.length >= 8, "the write surface must proxy its exact routes");
  const exactList = locations.find(
    (entry) => entry.modifier === "=" && entry.path === "/v1/operator/organizations",
  );
  assert.ok(exactList, "the list/org-create route must be an exact location");
  for (const suffix of ["agents$", "providers$", "mutations/", "bootstrap-mutations/", "memberships/", "agents/openarc:agent:", "providers/openarc:provider:"]) {
    assert.ok(
      locations.some((entry) => entry.raw.includes(suffix)),
      `write include must declare the ${suffix} route`,
    );
  }
});

test("identity UUIDs use the shared version nibble and mutations pin version 4", () => {
  const orgRegexes = locations.filter((entry) => entry.raw.includes(ORG));
  assert.ok(orgRegexes.length >= 1, "canonical organization regex must be present");
  for (const entry of locations.filter((entry) => entry.raw.includes("mutations/"))) {
    assert.ok(entry.raw.includes(UUID_MUTATION), "mutation routes must pin a version-4 UUID");
  }
  assert.ok(
    locations.filter((entry) => entry.raw.includes("/memberships/")).every((entry) => entry.raw.includes("openarc:account:")),
    "membership routes must target a canonical account id",
  );
});

test("regex locations proxy with no URI part so the original path is preserved", () => {
  for (const entry of proxying) {
    assert.match(entry.body, /proxy_pass\s+https:\/\/\$\{API_UPSTREAM_HOST\};/u);
    assert.ok(!/proxy_pass\s+https:\/\/\$\{API_UPSTREAM_HOST\}\S+;/u.test(entry.body));
  }
});

test("every write location pins its exact method and rejects Authorization", () => {
  for (const entry of named) {
    assert.match(entry.body, /if\s*\(\$request_method\s*!=\s*(POST|PATCH|PUT)\)\s*\{\s*return\s+405;\s*\}/u);
    assert.match(entry.body, /if\s*\(\$http_authorization\s*!=\s*""\)\s*\{\s*return\s+403;\s*\}/u);
  }
  for (const entry of locations.filter((entry) => /\/agents\/openarc:agent:|providers\/openarc:provider:/u.test(entry.raw))) {
    assert.match(entry.body, /if\s*\(\$request_method\s*!=\s*PATCH\)\s*\{\s*return\s+405;\s*\}/u);
  }
  for (const entry of locations.filter((entry) => entry.raw.includes("/memberships/"))) {
    assert.match(entry.body, /if\s*\(\$request_method\s*!=\s*PUT\)\s*\{\s*return\s+405;\s*\}/u);
  }
  for (const entry of locations.filter((entry) => entry.raw.includes("mutations/"))) {
    assert.match(entry.body, /if\s*\(\$request_method\s*!=\s*GET\)\s*\{\s*return\s+405;\s*\}/u);
  }
});

test("shared collections permit only GET and POST and route POST internally", () => {
  for (const suffix of ["agents$", "providers$"]) {
    const entry = locations.find((location) => location.raw.includes(suffix));
    assert.ok(entry, `shared ${suffix} location must exist`);
    assert.match(entry.body, /if\s*\(\$request_method\s*=\s*POST\)\s*\{\s*return\s+418;\s*\}/u);
    assert.match(entry.body, /if\s*\(\$request_method\s*!=\s*GET\)\s*\{\s*return\s+405;\s*\}/u);
    assert.match(entry.body, /error_page\s+418\s*=\s*@openarc_tenant_write_/u);
  }
  const list = locations.find((entry) => entry.modifier === "=" && entry.path === "/v1/operator/organizations");
  assert.match(list.body, /if\s*\(\$request_method\s*=\s*POST\)\s*\{\s*return\s+418;\s*\}/u);
  assert.match(list.body, /if\s*\(\$request_method\s*!=\s*GET\)\s*\{\s*return\s+405;\s*\}/u);
});

test("named write locations are internal-only and never externally addressable", () => {
  for (const name of ["@openarc_tenant_write_organizations", "@openarc_tenant_write_agents", "@openarc_tenant_write_providers"]) {
    assert.ok(named.some((entry) => entry.raw === name), `${name} must be a named location`);
  }
  // A named location cannot be reached by a client-supplied URL.
  for (const entry of named) {
    assert.ok(entry.raw.startsWith("@"), "write internal locations must use the @ prefix");
  }
  for (const name of ["@openarc_tenant_write_organizations", "@openarc_tenant_write_agents", "@openarc_tenant_write_providers"]) {
    const references = writeSource.split(name).length - 1;
    assert.equal(references, 2, `${name} must be declared once and referenced once`);
  }
  // Only non-named locations may use error_page; a named location must never
  // forward to another named location (no chained external bypass).
  for (const entry of named) {
    assert.ok(!entry.body.includes("error_page"), "named locations must not chain error_page");
  }
  for (const entry of locations.filter((location) => !location.path.startsWith("@"))) {
    if (entry.body.includes("error_page 418")) {
      assert.ok(/error_page\s+418\s*=\s*@openarc_tenant_write_\w+/u.test(entry.body));
    }
  }
});

test("no proxy directive is placed inside an if block", () => {
  for (const entry of locations) {
    const ifBlocks = entry.body.match(/if\s*\([^)]*\)\s*\{[^}]*\}/gu) ?? [];
    for (const block of ifBlocks) {
      assert.ok(!block.includes("proxy_pass"), "if block must not contain proxy_pass");
      assert.ok(!block.includes("proxy_set_header"), "if block must not contain proxy_set_header");
      assert.ok(!block.includes("include "), "if block must not contain include");
    }
  }
});

test("write locations require JSON, CSRF and an idempotency key with a finite body", () => {
  for (const entry of named) {
    assert.match(entry.body, /if\s*\(\$http_content_type\s*!~\s*"\^application\/json/u);
    assert.match(entry.body, /if\s*\(\$http_transfer_encoding\s*!=\s*""\)\s*\{\s*return\s+400;\s*\}/u);
    assert.match(entry.body, /if\s*\(\$http_x_openarc_csrf\s*=\s*""\)\s*\{\s*return\s+400;\s*\}/u);
    assert.match(entry.body, /if\s*\(\$http_idempotency_key\s*=\s*""\)\s*\{\s*return\s+400;\s*\}/u);
    assert.match(entry.body, /client_max_body_size\s+[1-9]\d*k;/u);
    assert.ok(!/client_max_body_size\s+0;/u.test(entry.body), "write location must never set an unlimited body");
  }
});

test("status GETs reject bodies, chunked encoding, CSRF and idempotency headers", () => {
  for (const entry of locations.filter((location) => location.raw.includes("mutations/"))) {
    assert.match(entry.body, /if\s*\(\$http_content_length\s*!=\s*""\)\s*\{\s*set\s+\$openarc_tenant_body_ok\s+0;\s*\}/u);
    assert.match(entry.body, /if\s*\(\$http_transfer_encoding\s*!=\s*""\)\s*\{\s*set\s+\$openarc_tenant_body_ok\s+0;\s*\}/u);
    assert.match(entry.body, /if\s*\(\$openarc_tenant_body_ok\s*=\s*0\)\s*\{\s*return\s+400;\s*\}/u);
    assert.match(entry.body, /if\s*\(\$http_x_openarc_csrf\s*!=\s*""\)\s*\{\s*return\s+400;\s*\}/u);
    assert.match(entry.body, /if\s*\(\$http_idempotency_key\s*!=\s*""\)\s*\{\s*return\s+400;\s*\}/u);
  }
});

test("the four read-enabled GET families reject CSRF and idempotency headers", () => {
  const readFamilies = [
    (entry) => entry.modifier === "=" && entry.path === "/v1/operator/organizations",
    (entry) =>
      entry.modifier === "~" &&
      entry.raw.includes(ORG) &&
      !/\/(agents|providers|mutations|memberships)/u.test(entry.raw),
    (entry) => entry.raw.includes("/agents$"),
    (entry) => entry.raw.includes("/providers$"),
  ];
  for (const select of readFamilies) {
    const entry = locations.find(select);
    assert.ok(entry, "every read-enabled GET family must exist");
    // GET must reject (not silently strip) the write-only headers.
    assert.match(
      entry.body,
      /if\s*\(\$http_x_openarc_csrf\s*!=\s*""\)\s*\{\s*return\s+400;\s*\}/u,
      `${entry.raw} must reject a CSRF header on GET`,
    );
    assert.match(
      entry.body,
      /if\s*\(\$http_idempotency_key\s*!=\s*""\)\s*\{\s*return\s+400;\s*\}/u,
      `${entry.raw} must reject an idempotency header on GET`,
    );
    // The read families keep their accepted bounded pagination queries.
    assert.ok(
      !/if\s*\(\$args\s*!=\s*""\)/u.test(entry.body),
      `${entry.raw} must preserve bounded read pagination queries`,
    );
  }
});

test("write and status locations reject nonempty query strings locally", () => {
  const queryRejecting = [
    ...named,
    ...locations.filter((entry) =>
      /\/(agents\/openarc:agent:|providers\/openarc:provider:|memberships\/|mutations\/|bootstrap-mutations\/)/u.test(
        entry.raw,
      ),
    ),
  ];
  assert.ok(queryRejecting.length >= 8, "the write/status surface must be present");
  for (const entry of queryRejecting) {
    assert.match(
      entry.body,
      /if\s*\(\$args\s*!=\s*""\)\s*\{\s*return\s+400;\s*\}/u,
      `${entry.raw} must reject a query string before proxying`,
    );
  }
});

test("unknown operator subpaths and lookalikes are denied without a broad proxy", () => {
  assert.ok(!/location[^\n]*\/v1\/\s*\{/u.test(stripped), "no broad /v1 proxy");
  const operatorBare = locations.find((entry) => entry.modifier === "" && entry.path === "/v1/operator/");
  assert.ok(operatorBare, "generic /v1/operator/ prefix must be denied");
  assert.match(operatorBare.body, /return\s+404;/u);
  assert.ok(!operatorBare.body.includes("proxy_pass"));
  const exactOperator = locations.find((entry) => entry.modifier === "=" && entry.path === "/v1/operator");
  assert.ok(exactOperator, "bare /v1/operator must be denied");
  assert.match(exactOperator.body, /return\s+404;/u);
  // No unanchored write regex may match a lookalike subpath.
  for (const entry of locations.filter((location) => location.modifier === "~")) {
    assert.ok(entry.raw.endsWith('"') || entry.raw.endsWith("$"), `${entry.raw} must be anchored/quoted`);
  }
});

test("write proxy forwards only the reviewed headers and a write body", () => {
  assert.match(writeParams, /proxy_pass_request_headers\s+off;/u);
  const forwarded = directiveValues(writeParams, "proxy_set_header").map((value) =>
    value.split(/\s+/u)[0].toLowerCase(),
  );
  const allowed = [
    "host",
    "cookie",
    "origin",
    "x-openarc-client",
    "sec-fetch-site",
    "sec-fetch-mode",
    "sec-fetch-dest",
    "accept",
    "content-type",
    "x-openarc-csrf",
    "idempotency-key",
  ];
  assert.deepEqual([...forwarded].sort(), [...allowed].sort());
  for (const forbidden of [
    "authorization",
    "x-openarc-proxy-secret",
    "x-openarc-proxy-client-ip",
    "x-forwarded-for",
    "transfer-encoding",
  ]) {
    assert.ok(!forwarded.includes(forbidden), `must not forward ${forbidden}`);
  }
  assert.match(writeParams, /proxy_pass_request_body\s+on;/u);
  assert.ok(!writeParams.includes("SOURCE_PROXY_SECRET"));
  // The read params keep the reviewed no-body behavior unchanged.
  assert.match(readParams, /proxy_pass_request_body\s+off;/u);
  assert.ok(!readParams.includes("Idempotency-Key"));
  assert.ok(!readParams.includes("X-OpenArc-CSRF"));
});

test("write proxy enforces TLS, no retry and no caching/spooling", () => {
  for (const directive of [
    /proxy_ssl_server_name\s+on;/u,
    /proxy_ssl_verify\s+on;/u,
    /proxy_ssl_verify_depth\s+3;/u,
    /proxy_connect_timeout\s+3s;/u,
    /proxy_send_timeout\s+10s;/u,
    /proxy_read_timeout\s+10s;/u,
    /proxy_next_upstream\s+off;/u,
    /proxy_request_buffering\s+off;/u,
    /proxy_buffering\s+off;/u,
    /proxy_max_temp_file_size\s+0;/u,
  ]) {
    assert.match(writeParams, directive);
  }
  assert.ok(!/proxy_ssl_verify\s+off;/u.test(writeParams));
  for (const forbidden of [/proxy_cache\b/u, /proxy_store\b/u, /proxy_cache_path\b/u, /proxy_temp_path\b/u]) {
    assert.ok(!forbidden.test(writeParams), `write proxy must not contain ${forbidden}`);
  }
});

test("disabled tenant include stays fail-closed with no proxy or upstream", () => {
  assert.ok(!disabledSource.includes("proxy_pass"));
  assert.ok(!disabledSource.includes("API_UPSTREAM_HOST"));
  assert.ok(!disabledSource.includes("tenant_proxy_params"));
  for (const entry of parseLocations(stripNginxComments(disabledSource))) {
    assert.match(entry.body, /return\s+404;/u);
  }
});

test("read include stays byte-unchanged and is used when writes are off", () => {
  // The accepted read include still has exactly four proxying GET locations.
  const readLocations = parseLocations(stripNginxComments(readSource)).filter((entry) =>
    entry.body.includes("proxy_pass"),
  );
  assert.equal(readLocations.length, 4, "the read include must keep exactly four proxying routes");
  for (const entry of readLocations) {
    assert.match(entry.body, /if\s*\(\$request_method\s*!=\s*GET\)/u);
  }
});

test("Dockerfile defaults the write flag off and fails closed on bad combinations", () => {
  const dockerfile = read(FILES.dockerfile);
  assert.match(dockerfile, /ARG VITE_TENANT_WRITES_ENABLED=false/u);
  assert.match(dockerfile, /case "\$\{VITE_TENANT_WRITES_ENABLED\}" in true\|false\) ;; \*\)/u);
  assert.ok(
    dockerfile.includes(
      'if [ "${VITE_TENANT_WRITES_ENABLED}" = "true" ] && { [ "${VITE_TENANT_READS_ENABLED}" != "true" ] || [ "${VITE_ACCOUNT_ACCESS_ENABLED}" != "true" ] || [ "${VITE_API_BOUNDARY_ENABLED}" != "true" ]; }',
    ),
  );
});

test("Dockerfile selects the write include only when the write flag is true", () => {
  const dockerfile = read(FILES.dockerfile);
  assert.ok(
    dockerfile.includes(
      "cp /tmp/openarc-nginx/nginx-tenant-write-locations.conf /etc/nginx/templates/openarc-tenant-locations.inc.template",
    ),
  );
  assert.ok(
    dockerfile.includes(
      "cp /tmp/openarc-nginx/nginx-tenant-locations.conf /etc/nginx/templates/openarc-tenant-locations.inc.template",
    ),
  );
  assert.ok(
    dockerfile.includes("cp /tmp/openarc-nginx/tenant_write_proxy_params /etc/nginx/tenant_write_proxy_params"),
  );
  for (const copy of [
    "apps/web/tenant_write_proxy_params",
    "apps/web/nginx-tenant-write-locations.conf",
  ]) {
    assert.ok(dockerfile.includes(copy), `Dockerfile must copy ${copy}`);
  }
  // The write include must be nested under the reads-enabled branch.
  const writeBranch = dockerfile.indexOf("nginx-tenant-write-locations.conf");
  const readsBranch = dockerfile.indexOf('if [ "${VITE_TENANT_READS_ENABLED}" = "true" ]');
  assert.ok(readsBranch !== -1 && writeBranch > readsBranch, "write include must be gated by reads");
});

test("pure verifier rejects dangerous hypothetical write fixtures", () => {
  const malicious = [
    "location /v1/operator/organizations/ { proxy_pass https://${API_UPSTREAM_HOST}; }",
    "location ~ ^/v1/operator/organizations/.*$ { proxy_pass https://${API_UPSTREAM_HOST}; }",
    "location = /v1/operator/organizations { if ($request_method = POST) { proxy_pass https://${API_UPSTREAM_HOST}; } }",
  ];
  const dangerous = parseLocations(malicious.join("\n"));
  assert.ok(dangerous.some((entry) => entry.modifier === "" && entry.path.startsWith("/v1/operator/organizations/")));
  assert.ok(dangerous.some((entry) => entry.path.includes("/.*$")));
  assert.ok(dangerous.some((entry) => entry.body.includes("if ($request_method = POST) { proxy_pass")));
});
