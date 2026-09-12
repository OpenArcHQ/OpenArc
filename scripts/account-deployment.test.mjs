import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (relativePath) => readFileSync(path.join(root, relativePath), "utf8");

const FILES = {
  routes: "apps/api/src/auth/routes.ts",
  locations: "apps/web/nginx-account-locations.conf",
  disabled: "apps/web/nginx-account-disabled.conf",
  authParams: "apps/web/auth_proxy_params",
  legacyParams: "apps/web/proxy_params",
  apiTemplate: "apps/web/nginx-api.conf",
  arcTemplate: "apps/web/nginx-arc.conf",
  dockerfile: "apps/web/Dockerfile",
};

const CSP_CONFIGS = [
  "apps/web/nginx.conf",
  "apps/web/nginx-api.conf",
  "apps/web/nginx-arc.conf",
];

const INC_INCLUDE = "include /etc/nginx/conf.d/openarc-auth-locations.inc;";
const INC_TEMPLATE = "/etc/nginx/templates/openarc-auth-locations.inc.template";

/** Parse the frozen AUTH_ROUTES map without importing the application. */
function parseAuthRoutes(source) {
  const block = source.match(/export const AUTH_ROUTES\s*=\s*Object\.freeze\(\{([\s\S]*?)\}\s*as const\);/u);
  assert.ok(block, "AUTH_ROUTES object literal must be present");
  const routes = [];
  for (const match of block[1].matchAll(/\w+:\s*"(\/v2\/auth\/[^"]*)"/gu)) {
    routes.push(match[1]);
  }
  return routes;
}

/** Extract location blocks (modifier, path, body) including nested braces. */
function parseLocations(config) {
  const locations = [];
  const header = /location\s+([=^~]*)\s*(\S+)\s*\{/gu;
  let match;
  while ((match = header.exec(config)) !== null) {
    const open = config.indexOf("{", match.index);
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
    locations.push({
      modifier: match[1],
      path: match[2],
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

/** Extract a Content-Security-Policy directive value from real add_header lines, never comments. */
function parseCspDirective(config, name) {
  const match = stripNginxComments(config).match(
    /add_header\s+Content-Security-Policy\s+"([^"]*)"/iu,
  );
  assert.ok(match, `Content-Security-Policy add_header must be present for directive ${name}`);
  const policy = match[1].trim();
  const tokens = policy.split(";").map((token) => token.trim()).filter(Boolean);
  const directive = tokens.find(
    (token) => token.split(/\s+/u)[0].toLowerCase() === name.toLowerCase(),
  );
  assert.ok(directive, `CSP directive ${name} must be present`);
  return directive.split(/\s+/u).slice(1);
}

/** Remove full-line and trailing nginx comments so assertions never read commented directives. */
function stripNginxComments(config) {
  return config
    .split("\n")
    .map((line) => line.replace(/(^|\s)#[^\n]*$/u, ""))
    .join("\n");
}

const authRoutes = parseAuthRoutes(read(FILES.routes));
const locationsSource = read(FILES.locations);
const locations = parseLocations(locationsSource);
const exactLocations = locations.filter((entry) => entry.modifier === "=");
const authParams = read(FILES.authParams);

test("AUTH_ROUTES exposes exactly 15 account paths", () => {
  assert.equal(authRoutes.length, 15);
  assert.equal(new Set(authRoutes).size, 15);
  for (const route of authRoutes) assert.match(route, /^\/v2\/auth\//u);
});

test("enabled account locations proxy exactly the 15 routes to the same path", () => {
  const proxied = exactLocations.filter((entry) => entry.path.startsWith("/v2/auth/"));
  const proxiedPaths = proxied.map((entry) => entry.path).sort();
  assert.deepEqual(proxiedPaths, [...authRoutes].sort());

  for (const entry of proxied) {
    const expected = `proxy_pass https://\${API_UPSTREAM_HOST}${entry.path};`;
    assert.ok(entry.body.includes(expected), `${entry.path} must proxy to the same upstream path`);
    assert.ok(entry.body.includes("include /etc/nginx/auth_proxy_params;"));
    assert.ok(entry.body.includes("client_max_body_size 16k;"));
    assert.ok(entry.body.includes("client_body_buffer_size 16k;"));
    assert.ok(entry.body.includes("client_body_in_file_only off;"));
  }

  assert.equal(proxied.length, 15);
});

test("unknown /v2/auth prefixes are denied without a catch-all proxy", () => {
  const bare = exactLocations.find((entry) => entry.path === "/v2/auth");
  assert.ok(bare, "bare /v2/auth must be an exact 404 location");
  assert.match(bare.body, /return\s+404;/u);

  const prefix = locations.find((entry) => entry.modifier === "" && entry.path === "/v2/auth/");
  assert.ok(prefix, "prefix /v2/auth/ must be denied");
  assert.match(prefix.body, /return\s+404;/u);
  assert.ok(!prefix.body.includes("proxy_pass"), "deny prefix must never proxy");

  const proxyCount = locations.filter((entry) => entry.body.includes("proxy_pass")).length;
  assert.equal(proxyCount, 15, "only the 15 exact routes may proxy");
});

test("disabled account include is fail-closed with no proxy or upstream", () => {
  const disabled = read(FILES.disabled);
  assert.ok(!disabled.includes("proxy_pass"), "disabled file must not proxy");
  assert.ok(!disabled.includes("API_UPSTREAM_HOST"), "disabled file must not reference the API upstream");
  assert.ok(!disabled.includes("auth_proxy_params"), "disabled file must not include proxy parameters");
  const disabledLocations = parseLocations(disabled);
  assert.ok(disabledLocations.length >= 1);
  for (const entry of disabledLocations) {
    assert.match(entry.body, /return\s+404;/u);
  }
});

test("auth proxy forwards only the reviewed request headers", () => {
  assert.match(authParams, /proxy_pass_request_headers\s+off;/u);
  const forwarded = directiveValues(authParams, "proxy_set_header").map(
    (value) => value.split(/\s+/u)[0].toLowerCase(),
  );
  const allowed = [
    "host",
    "content-type",
    "origin",
    "x-openarc-client",
    "x-openarc-csrf",
    "cookie",
    "sec-fetch-site",
    "sec-fetch-mode",
    "sec-fetch-dest",
  ];
  assert.deepEqual([...forwarded].sort(), [...allowed].sort());
  for (const forbidden of [
    "authorization",
    "x-forwarded-for",
    "x-forwarded-host",
    "x-forwarded-proto",
    "x-real-ip",
    "x-openarc-proxy-secret",
    "x-openarc-proxy-client-ip",
  ]) {
    assert.ok(!forwarded.includes(forbidden), `must not forward ${forbidden}`);
  }
  assert.ok(!authParams.includes("SOURCE_PROXY_SECRET"));
});

test("auth proxy enforces TLS, timeouts, no retry and no caching/spooling", () => {
  for (const directive of [
    /proxy_ssl_server_name\s+on;/u,
    /proxy_ssl_verify\s+on;/u,
    /proxy_ssl_verify_depth\s+3;/u,
    /proxy_connect_timeout\s+3s;/u,
    /proxy_send_timeout\s+10s;/u,
    /proxy_read_timeout\s+10s;/u,
    /proxy_next_upstream\s+off;/u,
    /proxy_buffering\s+off;/u,
    /proxy_max_temp_file_size\s+0;/u,
  ]) {
    assert.match(authParams, directive);
  }
  assert.ok(!/proxy_ssl_verify\s+off;/u.test(authParams));
  for (const forbidden of [/proxy_cache\b/u, /proxy_store\b/u, /proxy_cache_path\b/u, /proxy_temp_path\b/u]) {
    assert.ok(!forbidden.test(authParams), `auth proxy must not contain ${forbidden}`);
  }
});

test("auth locations keep Set-Cookie intact and never log or persist bodies", () => {
  assert.ok(!/proxy_hide_header\s+Set-Cookie/iu.test(authParams));
  assert.ok(!/proxy_ignore_headers\s+Set-Cookie/iu.test(authParams));
  assert.ok(!/access_log\s+(?!off)/u.test(locationsSource + authParams));
  assert.ok(!authParams.includes("client_body_in_file_only on"));
});

test("templates include the generated account locations include", () => {
  for (const file of [FILES.apiTemplate, FILES.arcTemplate]) {
    const template = read(file);
    assert.ok(template.includes(INC_INCLUDE), `${file} must include the account locations file`);
    assert.ok(!template.includes("/etc/nginx/openarc-auth-locations.conf"), `${file} must use the generated include`);
    assert.ok(/proxy_ssl_name\s+\$\{API_UPSTREAM_SNI\};/u.test(template));
    assert.ok(/proxy_ssl_trusted_certificate\s+\$\{API_TRUST_BUNDLE\};/u.test(template));
  }
});

test("legacy proxy params keep their positive security directives", () => {
  const legacy = read(FILES.legacyParams);
  for (const directive of [
    /proxy_ssl_server_name\s+on;/u,
    /proxy_ssl_verify\s+on;/u,
    /proxy_ssl_verify_depth\s+3;/u,
    /proxy_http_version\s+1\.1;/u,
    /proxy_set_header\s+Host\s+\$proxy_host;/u,
    /proxy_set_header\s+X-Forwarded-For\s+"";/u,
    /proxy_set_header\s+X-Real-IP\s+"";/u,
    /proxy_max_temp_file_size\s+0;/u,
    /proxy_connect_timeout\s+3s;/u,
  ]) {
    assert.match(legacy, directive);
  }
  assert.ok(!/proxy_ssl_verify\s+off;/u.test(legacy));
});

test("Dockerfile defaults the flag off and fails closed on bad combinations", () => {
  const dockerfile = read(FILES.dockerfile);
  assert.match(dockerfile, /ARG VITE_ACCOUNT_ACCESS_ENABLED=false/u);
  assert.match(dockerfile, /case "\$\{VITE_ACCOUNT_ACCESS_ENABLED\}" in true\|false\) ;; \*\)/u);
  assert.ok(
    dockerfile.includes(
      'if [ "${VITE_ACCOUNT_ACCESS_ENABLED}" = "true" ] && [ "${VITE_API_BOUNDARY_ENABLED}" != "true" ]',
    ),
  );
});

test("Dockerfile wires the include selection, template and proxy params", () => {
  const dockerfile = read(FILES.dockerfile);
  assert.ok(dockerfile.includes(INC_TEMPLATE), "account include template must be installed");
  assert.ok(
    dockerfile.includes("cp /tmp/openarc-nginx/nginx-account-locations.conf /etc/nginx/templates/openarc-auth-locations.inc.template"),
  );
  assert.ok(
    dockerfile.includes("cp /tmp/openarc-nginx/nginx-account-disabled.conf /etc/nginx/templates/openarc-auth-locations.inc.template"),
  );
  assert.ok(dockerfile.includes("cp /tmp/openarc-nginx/auth_proxy_params /etc/nginx/auth_proxy_params"));
  for (const copy of [
    "apps/web/auth_proxy_params",
    "apps/web/nginx-account-locations.conf",
    "apps/web/nginx-account-disabled.conf",
  ]) {
    assert.ok(dockerfile.includes(copy), `Dockerfile must copy ${copy}`);
  }
  assert.ok(!dockerfile.includes("/etc/nginx/openarc-auth-locations.conf"), "Dockerfile must not use the superseded path");
});

test("pinned base, frozen install and legacy params copy remain", () => {
  const dockerfile = read(FILES.dockerfile);
  assert.match(dockerfile, /FROM node:22-alpine@sha256:[0-9a-f]{64} AS build/u);
  assert.match(dockerfile, /FROM nginx:1\.29-alpine@sha256:[0-9a-f]{64} AS runtime/u);
  assert.match(dockerfile, /pnpm install --frozen-lockfile/u);
  assert.ok(dockerfile.includes("cp /tmp/openarc-nginx/proxy_params /etc/nginx/proxy_params"));
});

test("pure verifier rejects dangerous hypothetical location fixtures", () => {
  const malicious = [
    "location /v2/auth/ { proxy_pass https://${API_UPSTREAM_HOST}; }",
    "location = /v2/auth/bootstrap { include /etc/nginx/auth_proxy_params; proxy_pass https://evil.example/v2/auth/bootstrap; }",
  ];
  const dangerous = parseLocations(malicious.join("\n"));
  const proxied = dangerous.filter((entry) => entry.body.includes("proxy_pass"));
  assert.equal(proxied.length, 2);
  assert.ok(proxied.some((entry) => entry.modifier === "" && entry.path === "/v2/auth/"));
  assert.ok(
    proxied.some(
      (entry) => !entry.body.includes(`proxy_pass https://\${API_UPSTREAM_HOST}${entry.path};`),
    ),
  );
});

test("media CSP is exactly self-only across all three nginx configs", () => {
  for (const config of CSP_CONFIGS) {
    const source = read(config);
    const mediaValues = parseCspDirective(source, "media-src");
    assert.deepEqual(mediaValues, ["'self'"], `${config} media-src must be exactly 'self'`);
  }
});

test("media CSP admits no remote, wildcard, data or blob sources", () => {
  for (const config of CSP_CONFIGS) {
    const mediaValues = parseCspDirective(read(config), "media-src");
    for (const value of mediaValues) {
      assert.ok(!/^(?:https?:|data:|blob:|\*)/iu.test(value), `${config} media-src must not allow ${value}`);
    }
    assert.ok(!mediaValues.includes("*"), `${config} media-src must not use a wildcard`);
    assert.ok(!mediaValues.some((value) => value.includes("*")), `${config} media-src must not use a wildcard host`);
  }
});

test("local-only CSP keeps connect-src none, worker-src none and safe script/style policies", () => {
  for (const config of CSP_CONFIGS) {
    const source = read(config);
    const scriptValues = parseCspDirective(source, "script-src");
    const styleValues = parseCspDirective(source, "style-src");
    if (config === "apps/web/nginx.conf") {
      assert.deepEqual(parseCspDirective(source, "connect-src"), ["'none'"], `${config} must keep connect-src 'none'`);
      assert.deepEqual(parseCspDirective(source, "worker-src"), ["'none'"], `${config} must keep worker-src 'none'`);
    } else {
      assert.deepEqual(parseCspDirective(source, "connect-src"), ["'self'"], `${config} keeps same-origin connect only`);
      assert.deepEqual(parseCspDirective(source, "worker-src"), ["'none'"], `${config} must keep worker-src 'none'`);
    }
    for (const values of [scriptValues, styleValues]) {
      assert.ok(!values.includes("'unsafe-inline'"), `${config} must not allow unsafe-inline`);
      assert.ok(!values.includes("'unsafe-eval'"), `${config} must not allow unsafe-eval`);
    }
  }
});
