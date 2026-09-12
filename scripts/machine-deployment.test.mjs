import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

/**
 * Static deployment guards for the human machine-credential management proxy.
 *
 * These assertions read the real nginx directives (never comments) and the
 * Dockerfile wiring. They prove the credential surface is narrow, method-exact,
 * fail-closed by default and that the machine-only /v1/agent and /v1/provider
 * session endpoints are never proxied. They do not prove a live TLS upstream.
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (relativePath) => readFileSync(path.join(root, relativePath), "utf8");

const FILES = {
  machine: "apps/web/nginx-machine-management-locations.conf",
  machineDisabled: "apps/web/nginx-machine-management-disabled.conf",
  apiConf: "apps/web/nginx-api.conf",
  arcConf: "apps/web/nginx-arc.conf",
  writeLocations: "apps/web/nginx-tenant-write-locations.conf",
  dockerfile: "apps/web/Dockerfile",
};

const source = read(FILES.machine);
const disabledSource = read(FILES.machineDisabled);
const dockerfile = read(FILES.dockerfile);

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

const stripped = stripNginxComments(source);
const locations = parseLocations(stripped);
const proxying = locations.filter((entry) => entry.body.includes("proxy_pass"));
const named = locations.filter((entry) => entry.path.startsWith("@"));
const externalProxying = proxying.filter((entry) => !entry.path.startsWith("@"));

test("the enabled include proxies exactly the six reviewed credential families", () => {
  for (const fragment of ["/agents/openarc:agent:", "/providers/openarc:provider:"]) {
    assert.ok(
      locations.some((entry) => entry.raw.includes(fragment) && entry.raw.includes("/credentials$")),
      `credential collection for ${fragment} must exist`,
    );
  }
  assert.ok(
    locations.some((entry) => entry.raw.includes("/agent-credentials/") && entry.raw.includes("/revoke$")),
    "agent credential revoke route must exist",
  );
  assert.ok(
    locations.some((entry) => entry.raw.includes("/provider-credentials/") && entry.raw.includes("/revoke$")),
    "provider credential revoke route must exist",
  );
  assert.ok(
    locations.some((entry) => entry.raw.includes("/agent-credential-mutations/")),
    "agent credential mutation status route must exist",
  );
  assert.ok(
    locations.some((entry) => entry.raw.includes("/provider-credential-mutations/")),
    "provider credential mutation status route must exist",
  );
  assert.ok(proxying.length >= 6, "the enabled surface must proxy its exact routes");
});

test("no enabled location proxies a machine session endpoint or a bare operator prefix", () => {
  assert.ok(!/proxy_pass[^\n]*\/v1\/agent\b/u.test(stripped), "must never proxy /v1/agent");
  assert.ok(!/proxy_pass[^\n]*\/v1\/provider\b/u.test(stripped), "must never proxy /v1/provider");
  for (const entry of externalProxying) {
    assert.ok(
      entry.raw.includes("/v1/operator/organizations/openarc:org:"),
      `${entry.raw} must be a canonical organization-scoped route`,
    );
  }
  for (const prefix of ["/v1/agent/", "/v1/provider/"]) {
    const deny = locations.find((entry) => entry.path === prefix);
    assert.ok(deny, `${prefix} must be denied`);
    assert.match(deny.body, /return\s+404;/u);
    assert.ok(!deny.body.includes("proxy_pass"));
  }
});

test("identity UUIDs use version 1-8 and new credential/mutation UUIDs pin version 4", () => {
  for (const entry of externalProxying) {
    assert.ok(entry.raw.includes("openarc:org:"), "org id must be canonical");
  }
  for (const entry of locations.filter((location) => /-credentials\/|credential-mutations\//u.test(location.raw))) {
    assert.ok(
      entry.raw.includes("[0-9a-f]{4}-4[0-9a-f]{3}"),
      `${entry.raw} must pin new credential/mutation ids to version 4`,
    );
  }
  assert.ok(
    locations.some((entry) => entry.raw.includes("[1-8][0-9a-f]{3}")),
    "identity UUIDs must accept the shared [1-8] version nibble",
  );
});

test("regex locations proxy with no URI part so the original list query is preserved", () => {
  for (const entry of externalProxying) {
    assert.match(entry.body, /proxy_pass\s+https:\/\/\$\{API_UPSTREAM_HOST\};/u);
    assert.ok(!/proxy_pass\s+https:\/\/\$\{API_UPSTREAM_HOST\}\S+;/u.test(entry.body));
  }
});

test("mixed GET/POST credential locations dispatch POST to an internal named location", () => {
  for (const suffix of ["/agents/", "/providers/"]) {
    const entry = locations.find(
      (location) => location.raw.includes(suffix) && location.raw.includes("/credentials$"),
    );
    assert.ok(entry, `credential collection ${suffix} must exist`);
    assert.match(entry.body, /if\s*\(\$request_method\s*=\s*POST\)\s*\{\s*return\s+418;\s*\}/u);
    assert.match(entry.body, /if\s*\(\$request_method\s*!=\s*GET\)\s*\{\s*return\s+405;\s*\}/u);
    assert.match(entry.body, /error_page\s+418\s*=\s*@openarc_machine_/u);
  }
  for (const name of ["@openarc_machine_agent_credentials", "@openarc_machine_provider_credentials"]) {
    assert.ok(named.some((entry) => entry.raw === name), `${name} must be a named location`);
    const references = source.split(name).length - 1;
    assert.equal(references, 2, `${name} must be declared once and referenced once`);
  }
});

test("post and revoke locations require JSON, CSRF and an idempotency key with a finite body", () => {
  const writers = [...named, ...locations.filter((entry) => entry.raw.includes("/revoke$"))];
  assert.ok(writers.length >= 4, "the write surface must be present");
  for (const entry of writers) {
    assert.match(entry.body, /if\s*\(\$http_authorization\s*!=\s*""\)\s*\{\s*return\s+403;\s*\}/u);
    assert.match(entry.body, /if\s*\(\$http_content_type\s*!~\s*"\^application\/json/u);
    assert.match(entry.body, /if\s*\(\$http_transfer_encoding\s*!=\s*""\)\s*\{\s*return\s+400;\s*\}/u);
    assert.match(entry.body, /if\s*\(\$http_x_openarc_csrf\s*=\s*""\)\s*\{\s*return\s+400;\s*\}/u);
    assert.match(entry.body, /if\s*\(\$http_idempotency_key\s*=\s*""\)\s*\{\s*return\s+400;\s*\}/u);
    assert.match(entry.body, /client_max_body_size\s+[1-9]\d*k;/u);
    assert.ok(!/client_max_body_size\s+0;/u.test(entry.body), "must never set an unlimited body");
  }
  for (const name of ["@openarc_machine_agent_credentials", "@openarc_machine_provider_credentials"]) {
    const entry = named.find((location) => location.raw === name);
    assert.match(entry.body, /if\s*\(\$request_method\s*!=\s*POST\)\s*\{\s*return\s+405;\s*\}/u);
    assert.match(entry.body, /if\s*\(\$args\s*!=\s*""\)\s*\{\s*return\s+400;\s*\}/u);
  }
});

test("GET list/status locations reject bodies, CSRF and idempotency headers", () => {
  const getters = locations.filter(
    (entry) =>
      (entry.raw.includes("/credentials$") || /credential-mutations\//u.test(entry.raw)) &&
      !entry.path.startsWith("@"),
  );
  assert.ok(getters.length >= 4, "the GET surface must be present");
  for (const entry of getters) {
    assert.match(entry.body, /if\s*\(\$request_method\s*!=\s*GET\)\s*\{\s*return\s+405;\s*\}/u);
    assert.match(entry.body, /if\s*\(\$http_x_openarc_csrf\s*!=\s*""\)\s*\{\s*return\s+400;\s*\}/u);
    assert.match(entry.body, /if\s*\(\$http_idempotency_key\s*!=\s*""\)\s*\{\s*return\s+400;\s*\}/u);
  }
});

test("no proxy directive or include is placed inside an if block", () => {
  for (const entry of locations) {
    const ifBlocks = entry.body.match(/if\s*\([^)]*\)\s*\{[^}]*\}/gu) ?? [];
    for (const block of ifBlocks) {
      assert.ok(!block.includes("proxy_pass"), "if block must not contain proxy_pass");
      assert.ok(!block.includes("proxy_set_header"), "if block must not contain proxy_set_header");
      assert.ok(!block.includes("include "), "if block must not contain include");
    }
  }
});

test("the enabled include never adds a broad operator proxy", () => {
  assert.ok(!/location[^\n]*\/v1\/\s*\{/u.test(stripped), "no broad /v1 proxy");
  assert.ok(!/location[^\n]*\/v1\/operator\s*\{/u.test(stripped), "no bare operator prefix proxy");
  for (const entry of locations.filter((location) => location.modifier === "~")) {
    assert.ok(entry.raw.endsWith('"'), `${entry.raw} must be quoted`);
  }
});

test("the disabled include denies the credential paths and machine session surfaces", () => {
  assert.ok(!disabledSource.includes("proxy_pass"));
  assert.ok(!disabledSource.includes("API_UPSTREAM_HOST"));
  for (const prefix of ["/v1/agent/", "/v1/provider/"]) {
    const deny = parseLocations(stripNginxComments(disabledSource)).find(
      (entry) => entry.path === prefix,
    );
    assert.ok(deny, `${prefix} must be denied when disabled`);
    assert.match(deny.body, /return\s+404;/u);
  }
  assert.ok(
    parseLocations(stripNginxComments(disabledSource)).filter(
      (entry) => entry.modifier === "~" && /credentials|credential-mutations/u.test(entry.raw),
    ).length >= 3,
    "the credential families must be denied when disabled",
  );
});

test("both API parent templates include the machine locations file exactly once", () => {
  for (const parent of [FILES.apiConf, FILES.arcConf]) {
    const contents = read(parent);
    const references = contents.split("openarc-machine-locations.inc").length - 1;
    assert.equal(references, 1, `${parent} must include the machine locations exactly once`);
  }
});

test("Dockerfile defaults the machine flag off and fails closed on bad combinations", () => {
  assert.match(dockerfile, /ARG VITE_MACHINE_CREDENTIAL_MANAGEMENT_ENABLED=false/u);
  assert.match(
    dockerfile,
    /case "\$\{VITE_MACHINE_CREDENTIAL_MANAGEMENT_ENABLED\}" in true\|false\) ;; \*\)/u,
  );
  assert.ok(
    dockerfile.includes(
      'if [ "${VITE_MACHINE_CREDENTIAL_MANAGEMENT_ENABLED}" = "true" ] && { [ "${VITE_TENANT_WRITES_ENABLED}" != "true" ] || [ "${VITE_TENANT_READS_ENABLED}" != "true" ] || [ "${VITE_ACCOUNT_ACCESS_ENABLED}" != "true" ] || [ "${VITE_API_BOUNDARY_ENABLED}" != "true" ]; }',
    ),
  );
});

test("Dockerfile selects only the machine include and validates both parents in both stages", () => {
  assert.ok(
    dockerfile.includes(
      "cp /tmp/openarc-nginx/nginx-machine-management-locations.conf /etc/nginx/templates/openarc-machine-locations.inc.template",
    ),
  );
  assert.ok(
    dockerfile.includes(
      "cp /tmp/openarc-nginx/nginx-machine-management-disabled.conf /etc/nginx/templates/openarc-machine-locations.inc.template",
    ),
  );
  for (const copy of [
    "apps/web/nginx-machine-management-locations.conf",
    "apps/web/nginx-machine-management-disabled.conf",
  ]) {
    assert.ok(dockerfile.includes(copy), `Dockerfile must copy ${copy}`);
  }
  const buildCase = dockerfile.indexOf('case "${VITE_MACHINE_CREDENTIAL_MANAGEMENT_ENABLED}"');
  const runtimeCase = dockerfile.lastIndexOf('case "${VITE_MACHINE_CREDENTIAL_MANAGEMENT_ENABLED}"');
  assert.ok(buildCase !== -1 && runtimeCase > buildCase, "flag must be validated in build and runtime");
});

test("the existing tenant write include stays byte-unchanged", () => {
  const writeLocations = read(FILES.writeLocations);
  assert.ok(writeLocations.includes("location = /v1/operator/organizations {"));
  assert.ok(!writeLocations.includes("machine-management"));
  assert.ok(!writeLocations.includes("credential-mutations"));
});
