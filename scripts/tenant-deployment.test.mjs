import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

/**
 * Static deployment guards for the protected organization read proxy.
 *
 * These assertions read the real nginx directives (never comments) and the
 * Dockerfile wiring. They prove the surface is narrow and fail-closed; they do
 * not prove a live TLS upstream or end-to-end API behavior.
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (relativePath) => readFileSync(path.join(root, relativePath), "utf8");

const FILES = {
  locations: "apps/web/nginx-tenant-locations.conf",
  disabled: "apps/web/nginx-tenant-disabled.conf",
  tenantParams: "apps/web/tenant_proxy_params",
  apiTemplate: "apps/web/nginx-api.conf",
  arcTemplate: "apps/web/nginx-arc.conf",
  plainTemplate: "apps/web/nginx.conf",
  dockerfile: "apps/web/Dockerfile",
};

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
const ORG = `openarc:org:${UUID}`;
const INCLUDE = "include /etc/nginx/conf.d/openarc-tenant-locations.inc;";
const INCLUDE_TEMPLATE = "/etc/nginx/templates/openarc-tenant-locations.inc.template";

const locationsSource = read(FILES.locations);
const disabledSource = read(FILES.disabled);
const tenantParams = read(FILES.tenantParams);

function stripNginxComments(config) {
  return config
    .split("\n")
    .map((line) => line.replace(/(^|\s)#[^\n]*$/u, ""))
    .join("\n");
}

function parseLocations(config) {
  const locations = [];
  // A location path may be a bare token or a double-quoted regex that itself
  // contains braces, so capture the quoted string as one unit.
  const header = /location\s+([=^~]*)\s*("[^"]*"|\S+)\s*\{/gu;
  let match;
  while ((match = header.exec(config)) !== null) {
    // The opening brace is the last character matched by the header regex; the
    // path itself may contain nginx regex quantifiers such as `{8}`.
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

const locations = parseLocations(stripNginxComments(locationsSource));
const proxying = locations.filter((entry) => entry.body.includes("proxy_pass"));

test("only the four frozen GET organization routes proxy", () => {
  assert.equal(proxying.length, 4, "exactly four tenant locations may proxy");
  const exactList = locations.find((entry) => entry.modifier === "=" && entry.path === "/v1/operator/organizations");
  assert.ok(exactList, "the list route must be an exact location");
  const regexes = locations.filter((entry) => entry.modifier === "~");
  assert.equal(regexes.length, 3, "context, agents and providers must be regex locations");
  assert.ok(regexes[0].path.includes(ORG), "context regex must use the canonical organization id");
  assert.ok(regexes[1].path.endsWith("/agents$"), "agents regex must pin the /agents suffix");
  assert.ok(regexes[2].path.endsWith("/providers$"), "providers regex must pin the /providers suffix");
});

test("regex locations proxy with no URI part so the original path/query is preserved", () => {
  for (const entry of proxying) {
    assert.match(
      entry.body,
      /proxy_pass\s+https:\/\/\$\{API_UPSTREAM_HOST\};/u,
      `${entry.path} must proxy to the host with no URI part`,
    );
    assert.ok(
      !/proxy_pass\s+https:\/\/\$\{API_UPSTREAM_HOST\}\S+;/u.test(entry.body),
      `${entry.path} must not append a URI to the upstream`,
    );
  }
});

test("every proxying tenant location rejects non-GET, Authorization and bodies before proxying", () => {
  for (const entry of proxying) {
    assert.match(entry.body, /if\s*\(\$request_method\s*!=\s*GET\)\s*\{\s*return\s+405;\s*\}/u);
    assert.match(entry.body, /if\s*\(\$http_authorization\s*!=\s*""\)\s*\{\s*return\s+403;\s*\}/u);
    // Explicit rejection of a declared body before proxy_pass.
    assert.match(entry.body, /if\s*\(\$http_transfer_encoding\s*!=\s*""\)\s*\{\s*set\s+\$openarc_tenant_body_ok\s+0;\s*\}/u);
    assert.match(entry.body, /if\s*\(\$http_content_length\s*!=\s*""\)\s*\{\s*set\s+\$openarc_tenant_body_ok\s+0;\s*\}/u);
    assert.match(entry.body, /if\s*\(\$http_content_length\s*=\s*"0"\)\s*\{\s*set\s+\$openarc_tenant_body_ok\s+1;\s*\}/u);
    assert.match(entry.body, /if\s*\(\$openarc_tenant_body_ok\s*=\s*0\)\s*\{\s*return\s+400;\s*\}/u);
    // A finite defensive limit, never the unlimited `0`.
    assert.match(entry.body, /client_max_body_size\s+[1-9]\d*k;/u);
    assert.ok(!/client_max_body_size\s+0;/u.test(entry.body), `${entry.path} must not set an unlimited body size`);
  }
  assert.ok(!/proxy_set_header\s+Authorization/iu.test(locationsSource + tenantParams));
});

test("unknown operator subpaths are denied without a generic /v1 proxy", () => {
  assert.ok(!/location[^\n]*\/v1\/\s*\{/u.test(stripNginxComments(locationsSource)));
  const operatorBare = locations.find((entry) => entry.modifier === "" && entry.path === "/v1/operator/");
  assert.ok(operatorBare, "the generic /v1/operator/ prefix must be denied");
  assert.match(operatorBare.body, /return\s+404;/u);
  assert.ok(!operatorBare.body.includes("proxy_pass"), "deny prefix must never proxy");
  const exactOperator = locations.find((entry) => entry.modifier === "=" && entry.path === "/v1/operator");
  assert.ok(exactOperator, "the bare /v1/operator must be denied");
  assert.match(exactOperator.body, /return\s+404;/u);
});

test("disabled tenant include is fail-closed with no proxy or upstream", () => {
  assert.ok(!disabledSource.includes("proxy_pass"), "disabled file must not proxy");
  assert.ok(!disabledSource.includes("API_UPSTREAM_HOST"), "disabled file must not reference the API upstream");
  assert.ok(!disabledSource.includes("tenant_proxy_params"), "disabled file must not include proxy parameters");
  const disabledLocations = parseLocations(stripNginxComments(disabledSource));
  assert.ok(disabledLocations.length >= 1);
  for (const entry of disabledLocations) {
    assert.match(entry.body, /return\s+404;/u);
    assert.ok(!entry.body.includes("proxy_pass"));
  }
});

test("tenant proxy forwards only the reviewed request headers", () => {
  assert.match(tenantParams, /proxy_pass_request_headers\s+off;/u);
  const forwarded = directiveValues(tenantParams, "proxy_set_header").map(
    (value) => value.split(/\s+/u)[0].toLowerCase(),
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
  ];
  assert.deepEqual([...forwarded].sort(), [...allowed].sort());
  for (const forbidden of [
    "authorization",
    "x-openarc-csrf",
    "x-openarc-proxy-secret",
    "x-openarc-proxy-client-ip",
    "x-forwarded-for",
    "content-type",
  ]) {
    assert.ok(!forwarded.includes(forbidden), `must not forward ${forbidden}`);
  }
  assert.ok(!tenantParams.includes("SOURCE_PROXY_SECRET"));
});

test("tenant proxy enforces TLS, no retry and no caching/spooling", () => {
  for (const directive of [
    /proxy_ssl_server_name\s+on;/u,
    /proxy_ssl_verify\s+on;/u,
    /proxy_ssl_verify_depth\s+3;/u,
    /proxy_connect_timeout\s+3s;/u,
    /proxy_send_timeout\s+10s;/u,
    /proxy_read_timeout\s+10s;/u,
    /proxy_next_upstream\s+off;/u,
    /proxy_request_buffering\s+off;/u,
    /proxy_pass_request_body\s+off;/u,
    /proxy_buffering\s+off;/u,
    /proxy_max_temp_file_size\s+0;/u,
  ]) {
    assert.match(tenantParams, directive);
  }
  assert.ok(!/proxy_ssl_verify\s+off;/u.test(tenantParams));
  for (const forbidden of [/proxy_cache\b/u, /proxy_store\b/u, /proxy_cache_path\b/u, /proxy_temp_path\b/u]) {
    assert.ok(!forbidden.test(tenantParams), `tenant proxy must not contain ${forbidden}`);
  }
});

test("tenant locations never log bodies or persist request files", () => {
  const source = stripNginxComments(locationsSource) + tenantParams;
  assert.ok(!/access_log\s+(?!off)/u.test(source));
  assert.ok(!/error_log\s+(?!\/dev\/null)/u.test(source));
  assert.ok(!/client_body_in_file_only\s+on/iu.test(source));
});

test("api and arc templates include the generated tenant locations include", () => {
  for (const file of [FILES.apiTemplate, FILES.arcTemplate]) {
    const template = read(file);
    assert.ok(template.includes(INCLUDE), `${file} must include the tenant locations file`);
    assert.ok(!template.includes("/etc/nginx/openarc-tenant-locations.conf"), `${file} must use the generated include`);
  }
});

test("plain non-API nginx fails closed for the operator family", () => {
  const plain = stripNginxComments(read(FILES.plainTemplate));
  const plainLocations = parseLocations(plain);
  const operator = plainLocations.filter((entry) => entry.path.startsWith("/v1/operator"));
  assert.ok(operator.length >= 1, "plain nginx must declare an operator deny location");
  for (const entry of operator) {
    assert.match(entry.body, /return\s+404;/u);
    assert.ok(!entry.body.includes("proxy_pass"));
  }
  assert.ok(!plain.includes(INCLUDE), "plain nginx must not include the proxying tenant locations");
});

test("Dockerfile defaults the tenant flag off and fails closed on bad combinations", () => {
  const dockerfile = read(FILES.dockerfile);
  assert.match(dockerfile, /ARG VITE_TENANT_READS_ENABLED=false/u);
  assert.match(dockerfile, /case "\$\{VITE_TENANT_READS_ENABLED\}" in true\|false\) ;; \*\)/u);
  assert.ok(
    dockerfile.includes(
      'if [ "${VITE_TENANT_READS_ENABLED}" = "true" ] && { [ "${VITE_ACCOUNT_ACCESS_ENABLED}" != "true" ] || [ "${VITE_API_BOUNDARY_ENABLED}" != "true" ]; }',
    ),
  );
});

test("Dockerfile wires the tenant include selection and proxy params", () => {
  const dockerfile = read(FILES.dockerfile);
  assert.ok(dockerfile.includes(INCLUDE_TEMPLATE), "tenant include template must be installed");
  assert.ok(
    dockerfile.includes("cp /tmp/openarc-nginx/nginx-tenant-locations.conf /etc/nginx/templates/openarc-tenant-locations.inc.template"),
  );
  assert.ok(
    dockerfile.includes("cp /tmp/openarc-nginx/nginx-tenant-disabled.conf /etc/nginx/templates/openarc-tenant-locations.inc.template"),
  );
  assert.ok(dockerfile.includes("cp /tmp/openarc-nginx/tenant_proxy_params /etc/nginx/tenant_proxy_params"));
  for (const copy of [
    "apps/web/tenant_proxy_params",
    "apps/web/nginx-tenant-locations.conf",
    "apps/web/nginx-tenant-disabled.conf",
  ]) {
    assert.ok(dockerfile.includes(copy), `Dockerfile must copy ${copy}`);
  }
});

test("pure verifier rejects dangerous hypothetical tenant location fixtures", () => {
  const malicious = [
    "location /v1/operator/organizations/ { proxy_pass https://${API_UPSTREAM_HOST}; }",
    "location ~ ^/v1/operator/organizations/.*$ { proxy_pass https://${API_UPSTREAM_HOST}; }",
    "location ~ ^/v1/operator/organizations/openarc:org:[0-9a-f-]+$ { proxy_pass https://evil.example/v1/operator; }",
  ];
  const dangerous = parseLocations(malicious.join("\n"));
  assert.ok(dangerous.some((entry) => entry.modifier === "" && entry.path.startsWith("/v1/operator/organizations/")));
  assert.ok(dangerous.some((entry) => entry.path.includes("/.*$")));
  assert.ok(
    dangerous.some((entry) => !/proxy_pass\s+https:\/\/\$\{API_UPSTREAM_HOST\};/u.test(entry.body)),
  );
});
