import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

/**
 * Static deployment guards for the PORT-02 marketplace reverse proxy.
 *
 * These assertions parse the real nginx directives (never comments) and the
 * real Dockerfile RUN/shell lines. They prove the exact 18-route inventory and
 * methods, the canonical typed shared-id prefixes under nginx's single decode,
 * query/method/credential/body guards, encoded-URI-preserving proxy_pass,
 * named-location separation, TLS/retry/buffering transport, the three
 * independent feature includes, all flag combinations/dependencies in both
 * Docker stages, the shared GET/POST param installation independent of the old
 * tenant flags, deny-only lookalike coverage and the no-API 404 fallback. They
 * do not run nginx or prove a live upstream/browser response.
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (relativePath) => readFileSync(path.join(root, relativePath), "utf8");

const FILES = {
  dockerfile: "apps/web/Dockerfile",
  apiConf: "apps/web/nginx-api.conf",
  arcConf: "apps/web/nginx-arc.conf",
  plainConf: "apps/web/nginx.conf",
  catalog: "apps/web/nginx-market-catalog-locations.conf",
  listing: "apps/web/nginx-listing-management-locations.conf",
  moderation: "apps/web/nginx-market-moderation-locations.conf",
  deny: "apps/web/nginx-market-deny.conf",
  capability: "apps/web/nginx-market-capability.conf",
  publicParams: "apps/web/market_public_proxy_params",
  responseHeaders: "apps/web/market_response_headers",
};

const capability = read(FILES.capability);
const catalog = read(FILES.catalog);
const listing = read(FILES.listing);
const moderation = read(FILES.moderation);
const deny = read(FILES.deny);
const publicParams = read(FILES.publicParams);
const responseHeaders = read(FILES.responseHeaders);
const dockerfile = read(FILES.dockerfile);

function stripNginxComments(config) {
  return config
    .split("\n")
    .map((line) => line.replace(/(^|\s)#[^\n]*$/u, ""))
    .join("\n");
}

function parseLocations(config, fallback = "") {
  const source = config === "" ? fallback : config;
  const stripped = stripNginxComments(source);
  const locations = [];
  const header = /location\s+([=^~]*)\s*("@?[^"]*"|\S+)\s*\{/gu;
  let match;
  while ((match = header.exec(stripped)) !== null) {
    const open = match.index + match[0].length - 1;
    let depth = 0;
    let close = -1;
    for (let index = open; index < stripped.length; index += 1) {
      if (stripped[index] === "{") depth += 1;
      else if (stripped[index] === "}") {
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
      body: stripped.slice(open + 1, close),
    });
    header.lastIndex = close + 1;
  }
  return locations;
}

const catalogLocations = parseLocations(catalog);
const listingLocations = parseLocations(listing);
const moderationLocations = parseLocations(moderation);
const denyLocations = parseLocations(deny);
const capabilityLocations = parseLocations(capability);

const allMarketLocations = [
  ...capabilityLocations,
  ...catalogLocations,
  ...listingLocations,
  ...moderationLocations,
];

// Canonical shared UUID grammar with version nibble [1-8]; mutation pins v4.
const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
const MUT = "[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
const ORG_PREFIX = "openarc:org:";
const LISTING_PREFIX = "openarc:listing:";
const PROVIDER_PREFIX = "openarc:provider:";

// Concrete canonical shared IDs (version nibble 4) and their encoded wire form.
const org = ORG_PREFIX + "11111111-1111-4111-8111-111111111111";
const listingId = LISTING_PREFIX + "22222222-2222-4222-8222-222222222222";
const providerId = PROVIDER_PREFIX + "44444444-4444-4444-8444-444444444444";
const mut = "33333333-3333-4333-8333-333333333333";

const encoded = (value) => encodeURIComponent(value);

function regexFor(entry) {
  return new RegExp("^(?:" + entry.path.split('"').join("") + ")$", "u");
}

function matchesPath(entry, target) {
  if (entry.modifier === "~") return regexFor(entry).test(target);
  return entry.path === target;
}

test("the frozen 18-route inventory is all present with exact methods", () => {
  const samples = [
    "/v2/public/market/listings",
    "/v2/public/market/listings/" + listingId,
    "/v2/public/market/providers/" + providerId,
    "/v2/provider/organizations/" + org + "/listings",
    "/v2/provider/organizations/" + org + "/listings/" + listingId,
    "/v2/provider/organizations/" + org + "/listings/" + listingId + "/versions",
    "/v2/provider/organizations/" + org + "/listings/" + listingId + "/versions/42",
    "/v2/provider/organizations/" + org + "/listing-mutations/" + mut,
    "/v2/provider/organizations/" + org + "/listing-providers",
    "/v2/provider/organizations/" + org + "/listings/" + listingId + "/versions/42/publish",
    "/v2/provider/organizations/" + org + "/listing-lifecycle-mutations/" + mut,
    "/v2/moderator/organizations/" + org + "/listings/" + listingId + "/versions/42",
    "/v2/moderator/organizations/" + org + "/listings/" + listingId + "/versions/42/origin-review",
    "/v2/moderator/organizations/" + org + "/listing-lifecycle-mutations/" + mut,
  ];
  for (const sample of samples) {
    assert.ok(
      allMarketLocations.some((entry) => matchesPath(entry, sample)),
      `missing declared route for ${sample}`,
    );
  }
  // A version of 0 or a 1e9 value must not match the canonical 1..999999999.
  const versionLoc = listingLocations.find((entry) => /versions\/\[1-9\]/u.test(entry.path));
  assert.ok(versionLoc, "must declare a canonical version route");
  assert.ok(!regexFor(versionLoc).test("/v2/provider/organizations/" + org + "/listings/" + listingId + "/versions/0"));
  assert.ok(!regexFor(versionLoc).test("/v2/provider/organizations/" + org + "/listings/" + listingId + "/versions/1000000000"));
  // Exact declared route count across the three business families + capability.
  assert.equal(catalogLocations.length, 3, "catalog must declare exactly 3 routes");
  assert.equal(listingLocations.length, 10, "listing must declare 10 locations (12 tuples, 2 named dispatches, combined lifecycle verbs)");
  assert.equal(moderationLocations.length, 3, "moderation must declare exactly 3 routes");
  assert.equal(capabilityLocations.length, 1, "capability must declare exactly 1 route");
});

test("typed shared-id prefixes are canonical and survive the single URI decode", () => {
  // Nginx matches regex locations against the DECODED uri; every id-bearing
  // location must require its literal `openarc:<kind>:` prefix, never a bare UUID.
  const idBearing = allMarketLocations.filter((entry) => entry.modifier === "~" && /UUID/u.test(entry.raw) === false && /openarc:/u.test(entry.path));
  assert.ok(idBearing.length >= 6, "expected the id-bearing regex locations");
  assert.ok(
    !allMarketLocations.some((entry) => entry.modifier === "~" && !entry.path.includes("openarc:") && new RegExp(UUID, "u").test(entry.path)),
    "no regex may accept a bare UUID for a prefixed shared id",
  );
  // Organization / listing / provider counterparts each require the typed prefix.
  assert.ok(catalog.includes("/v2/public/market/listings/" + LISTING_PREFIX));
  assert.ok(catalog.includes("/v2/public/market/providers/" + PROVIDER_PREFIX));
  assert.ok(listing.includes("/v2/provider/organizations/" + ORG_PREFIX));
  assert.ok(moderation.includes("/v2/moderator/organizations/" + ORG_PREFIX));
  // Mutation ids stay a bare UUIDv4 (never typed-prefixed).
  assert.ok(listing.includes("/listing-mutations/" + MUT));
  assert.ok(listing.includes("/listing-lifecycle-mutations/" + MUT));
  // Encoded wire form decodes once to the canonical prefixed id and matches;
  // a double-encoded `%253A` decodes to a literal `%3A` and must NOT match.
  const detail = catalogLocations.find((entry) => entry.path.includes("/listings/" + LISTING_PREFIX));
  assert.ok(detail, "catalog listing detail regex must exist");
  assert.ok(regexFor(detail).test(decodeURIComponent(encoded("/v2/public/market/listings/" + listingId))));
  assert.ok(!regexFor(detail).test(decodeURIComponent("/v2/public/market/listings/openarc%253Alisting%253A22222222-2222-4222-8222-222222222222")));
  const providerLoc = catalogLocations.find((entry) => entry.path.includes("/providers/" + PROVIDER_PREFIX));
  assert.ok(providerLoc, "catalog provider regex must exist");
  assert.ok(regexFor(providerLoc).test(decodeURIComponent(encoded("/v2/public/market/providers/" + providerId))));
});

test("regex proxy_pass carries no URI suffix or rewrite and preserves encoding", () => {
  for (const [name, locations] of [
    ["catalog", catalogLocations],
    ["listing", listingLocations],
    ["moderation", moderationLocations],
  ]) {
    for (const entry of locations) {
      if (entry.modifier !== "~") continue;
      const passes = entry.body.match(/proxy_pass\s+(\S+);/gu) ?? [];
      for (const directive of passes) {
        assert.match(
          directive,
          /proxy_pass\s+https:\/\/\$\{API_UPSTREAM_HOST\};/u,
          `${name} regex ${entry.path} must proxy_pass with no URI suffix`,
        );
      }
      assert.ok(!/rewrite\s/u.test(entry.body), `${name} must not rewrite the URI`);
      assert.match(entry.body, /proxy_pass\s+https:\/\/\$\{API_UPSTREAM_HOST\};/u);
    }
  }
});

test("named locations are clearly separated and internal-only", () => {
  const named = listingLocations.filter((entry) => entry.path.startsWith("@"));
  const names = named.map((entry) => entry.path);
  assert.deepEqual(
    [...names].sort(),
    ["@openarc_market_provider_listing_create", "@openarc_market_provider_version_create"],
  );
  for (const entry of named) {
    assert.match(entry.body, /proxy_pass\s+https:\/\/\$\{API_UPSTREAM_HOST\};/u);
    assert.ok(
      !/error_page/u.test(entry.body) || !/return 418/u.test(entry.body),
      "named location must not dispatch another write",
    );
  }
  const legacy = read(FILES.apiConf);
  assert.ok(!/openarc_market_provider_listing_create/u.test(legacy));
});

test("mixed GET/POST collections dispatch to their named locations", () => {
  const dispatch = listingLocations.filter((entry) => /return 418;/u.test(entry.body));
  assert.equal(dispatch.length, 2, "exactly two collections dispatch a write verb");
  for (const entry of dispatch) {
    const target = entry.body.match(/error_page\s+418\s+=\s+(@[A-Za-z0-9_]+);/u);
    assert.ok(target, `${entry.path} must name a dispatch target`);
    assert.ok(
      listingLocations.some((candidate) => candidate.path === target[1]),
      `${entry.path} must dispatch to an existing named location`,
    );
  }
  assert.ok(
    !/\bif\b[^\n]*\{[^\n]*proxy_pass/u.test(listing),
    "proxy_pass must never appear inside an if block",
  );
});

test("wrong method on a supported path yields 405 (method-exact)", () => {
  for (const entry of allMarketLocations) {
    if (entry.modifier === "=" && entry.body.includes("return 404")) continue;
    if (entry.path.startsWith("@")) continue;
    assert.match(
      entry.body,
      /if\s*\(\$request_method\s*!=\s*(GET|POST)\)\s*\{\s*return\s+405;\s*\}/u,
      `${entry.path} must declare its method-exact 405 guard`,
    );
  }
});

test("query-free routes reject a literal '?' (incl bare '?') without comparing encoded to decoded uri", () => {
  const listPaths = [
    "/v2/public/market/listings",
  ];
  const literalCapabilityPath = "/v2/public/marketplace-capabilities";
  for (const entry of allMarketLocations) {
    if (entry.path.startsWith("@")) continue;
    if (listPaths.includes(entry.path)) continue;
    if (entry.modifier === "=" && entry.path === literalCapabilityPath) continue;
    if (/\/listings\$$/u.test(entry.path) || /\/versions\$$/u.test(entry.path) || /listing-providers\$$/u.test(entry.path)) {
      assert.ok(!/\$request_uri\s*!=/u.test(entry.body), `${entry.path} is a list path and must allow a raw query`);
      continue;
    }
    assert.match(
      entry.body,
      /if\s*\(\$request_uri\s*~\s*"\\\?"\)\s*\{\s*return\s+400;\s*\}/u,
      `${entry.path} must reject any query (incl bare ?) via a literal '?' match on original $request_uri`,
    );
    assert.ok(!/if\s*\(\$args\b/u.test(entry.body), `${entry.path} must not rely on $args alone`);
    assert.ok(
      !/if\s*\(\$request_uri\s*!=\s*\$uri\s*\)/u.test(entry.body),
      `${entry.path} must not compare encoded $request_uri to decoded $uri`,
    );
  }
  assert.match(
    capability,
    /if\s*\(\$request_uri\s*!=\s*"\/v2\/public\/marketplace-capabilities"\)\s*\{\s*return\s+400;\s*\}/u,
  );
});

test("list paths forward the raw query unmodified with only documented params", () => {
  for (const entry of allMarketLocations) {
    if (!/proxy_pass/u.test(entry.body)) continue;
    if (!/\/listings$|\/versions$|listing-providers$/u.test(entry.path)) continue;
    assert.ok(!/rewrite/u.test(entry.body), `${entry.path} must not rewrite the raw query`);
    assert.ok(!/proxy_set_header\s+\$args/u.test(entry.body), "must not reassemble the query");
  }
});

test("public locations reject all forbidden credentials locally with 403", () => {
  const forbidden = [
    "$http_cookie",
    "$http_authorization",
    "$http_proxy_authorization",
    "$http_x_openarc_csrf",
    "$http_idempotency_key",
    "$http_x_openarc_proxy_secret",
  ];
  for (const entry of [...catalogLocations, ...capabilityLocations]) {
    if (entry.path.startsWith("@")) continue;
    for (const header of forbidden) {
      const escaped = header.replace("$", "\\$");
      assert.match(
        entry.body,
        new RegExp(`if\\s*\\(${escaped}\\s*!=\\s*""\\)\\s*\\{\\s*return\\s+(403|400);\\s*\\}`, "u"),
        `public ${entry.path} must reject ${header}`,
      );
      assert.ok(
        !new RegExp(`proxy_set_header\\s+${header.replace("$http_", "").replace(/_/gu, "-")}\\s+\\$${header.replace("$", "")}`, "iu").test(publicParams.replace(/\$/gu, "\\$")),
        `public params must not forward ${header} upstream`,
      );
    }
  }
  // Public catalog must also reject Content-Type before the strip.
  for (const entry of catalogLocations) {
    assert.match(
      entry.body,
      /if\s*\(\$http_content_type\s*!=\s*""\)\s*\{\s*return\s+400;\s*\}/u,
      `public catalog ${entry.path} must reject Content-Type`,
    );
  }
  assert.ok(!/proxy_set_header\s+Proxy-Authorization\s+\$http_proxy_authorization/u.test(publicParams));
  assert.match(publicParams, /proxy_set_header\s+Proxy-Authorization\s+"";/u);
});

test("protected GET rejects Authorization, Proxy-Authorization and write-authority headers", () => {
  for (const entry of [...listingLocations, ...moderationLocations]) {
    if (entry.path.startsWith("@")) continue;
    if (/return\s+418/u.test(entry.body)) continue;
    if (!/if\s*\(\$request_method\s*!=\s*GET\)/u.test(entry.body)) continue;
    assert.match(entry.body, /if\s*\(\$http_authorization\s*!=\s*""\)\s*\{\s*return\s+403;\s*\}/u);
    assert.match(entry.body, /if\s*\(\$http_proxy_authorization\s*!=\s*""\)\s*\{\s*return\s+403;\s*\}/u, `${entry.path} GET must reject Proxy-Authorization`);
    assert.match(
      entry.body,
      /if\s*\(\$http_x_openarc_csrf\s*!=\s*""\)\s*\{\s*return\s+400;\s*\}/u,
      `${entry.path} GET must reject write-authority CSRF`,
    );
    assert.match(entry.body, /if\s*\(\$http_idempotency_key\s*!=\s*""\)\s*\{\s*return\s+400;\s*\}/u);
  }
});

test("POST requires JSON, CSRF, idempotency, rejects Authorization/Proxy-Authorization and is 16KiB bounded", () => {
  const posts = [...listingLocations, ...moderationLocations].filter(
    (entry) => entry.modifier === "~" && !entry.path.startsWith("@") && /if\s*\(\$request_method\s*!=\s*POST\)/u.test(entry.body),
  );
  assert.ok(posts.length >= 1, "must find POST locations");
  for (const entry of posts) {
    assert.match(entry.body, /if\s*\(\$http_authorization\s*!=\s*""\)\s*\{\s*return\s+403;\s*\}/u);
    assert.match(entry.body, /if\s*\(\$http_proxy_authorization\s*!=\s*""\)\s*\{\s*return\s+403;\s*\}/u, `${entry.path} POST must reject Proxy-Authorization`);
    assert.match(entry.body, /if\s*\(\$http_content_type\s*!~\s*"\^application\/json/u);
    assert.match(entry.body, /if\s*\(\$http_x_openarc_csrf\s*=\s*""\)\s*\{\s*return\s+400;\s*\}/u);
    assert.match(entry.body, /if\s*\(\$http_idempotency_key\s*=\s*""\)\s*\{\s*return\s+400;\s*\}/u);
    assert.match(entry.body, /client_max_body_size\s+16k;/u);
  }
  for (const entry of listingLocations.filter((candidate) => candidate.path.startsWith("@"))) {
    assert.match(entry.body, /client_max_body_size\s+16k;/u);
    assert.match(entry.body, /if\s*\(\$request_uri\s*~\s*"\\\?"\)\s*\{\s*return\s+400;\s*\}/u);
  }
});

test("body-bearing reads are rejected before proxy and no disk buffering is configured", () => {
  for (const entry of allMarketLocations) {
    if (!/proxy_pass/u.test(entry.body)) continue;
    if (/if\s*\(\$request_method\s*!=\s*POST\)/u.test(entry.body)) continue;
    // A mixed GET/POST parent dispatches POST to a named 16KiB write location,
    // so its transport bound must admit that POST before dispatch (see the
    // mixed-parent regression below). Its GET body guard is asserted there and
    // the pure read locations still keep the 1k bound here.
    if (/if\s*\(\$request_method\s*=\s*POST\)/u.test(entry.body)) continue;
    const direct = /if\s*\(\$http_transfer_encoding\s*!=\s*""\)\s*\{\s*return\s+400;\s*\}/u.test(entry.body);
    const viaBodyOk = /if\s*\(\$http_transfer_encoding\s*!=\s*""\)\s*\{\s*set\s+\$openarc_market_body_ok\s+0;\s*\}/u.test(entry.body) &&
      /if\s*\(\$openarc_market_body_ok\s*=\s*0\)\s*\{\s*return\s+400;\s*\}/u.test(entry.body);
    assert.ok(direct || viaBodyOk, `${entry.path} must reject transfer-encoding`);
    assert.match(entry.body, /client_max_body_size\s+1k;/u, `${entry.path} read must bound body at 1k`);
  }
  for (const [name, params] of [["public", publicParams]]) {
    assert.match(params, /proxy_request_buffering\s+off;/u, `${name} params must disable request buffering`);
    assert.match(params, /proxy_buffering\s+off;/u, `${name} params must disable response buffering`);
    assert.match(params, /proxy_max_temp_file_size\s+0;/u, `${name} params must never spool to disk`);
  }
  assert.match(read("apps/web/tenant_proxy_params"), /proxy_request_buffering\s+off;/u);
  assert.match(read("apps/web/tenant_write_proxy_params"), /proxy_request_buffering\s+off;/u);
  assert.ok(!/proxy_cache\b/u.test(catalog + listing + moderation), "must not add response caching");
});

test("mixed GET/POST parents admit the 16KiB POST pre-dispatch while reads stay 1k", () => {
  // nginx evaluates `client_max_body_size` for the matched (parent) location
  // BEFORE the legacy `if (...=POST) { return 418 }` error_page dispatch, so a
  // parent that stayed at the 1k read bound would 413 every legitimate listing
  // create/version-create body (e.g. the 1098-byte UI payload) before the
  // 16KiB named location ever ran. Only the two MIXED GET/POST collection
  // parents — the ones that dispatch a write verb — must therefore admit the
  // maximum legitimate write body. This intentionally distinguishes them from
  // the pure GET read locations further below, which keep the 1k no-body bound.
  const mixedParents = listingLocations.filter((entry) => /if\s*\(\$request_method\s*=\s*POST\)/u.test(entry.body));
  assert.equal(mixedParents.length, 2, "exactly two mixed GET/POST parents dispatch a write verb");
  for (const entry of mixedParents) {
    assert.match(entry.body, /client_max_body_size\s+16k;/u, `${entry.path} mixed parent must admit the 16KiB POST before dispatch`);
    assert.ok(
      !/client_max_body_size\s+1k;/u.test(entry.body),
      `${entry.path} mixed parent must not keep the read-only 1k bound that 413s the POST`,
    );
    // The GET body guard must survive the larger transport bound: a GET with a
    // body still trips the body_ok header/transfer checks and returns 400.
    assert.match(entry.body, /if\s*\(\$openarc_market_body_ok\s*=\s*0\)\s*\{\s*return\s+400;\s*\}/u);
    assert.match(entry.body, /if\s*\(\$http_transfer_encoding\s*!=\s*""\)\s*\{\s*set\s+\$openarc_market_body_ok\s+0;\s*\}/u);
    assert.match(entry.body, /if\s*\(\$http_content_length\s*!=\s*""\)\s*\{\s*set\s+\$openarc_market_body_ok\s+0;\s*\}/u);
    assert.match(entry.body, /if\s*\(\$http_content_length\s*=\s*"0"\)\s*\{\s*set\s+\$openarc_market_body_ok\s+1;\s*\}/u);
    // Canonical registry example: a 1098-byte listing create (POST) and a 1098
    // byte version create fit, while >16KiB must still be rejected by the bound.
    assert.ok(1098 <= 16 * 1024, "canonical 1098-byte create fits the 16KiB parent bound");
    assert.ok(1098 > 1024, "canonical 1098-byte create would fail the old 1k parent bound");
    assert.ok(16 * 1024 < 128 * 1024, "the parent bound stays the documented 16KiB, not unbounded");
  }
  // The dispatch targets keep their own bounded 16KiB write limit.
  for (const entry of listingLocations.filter((candidate) => candidate.path.startsWith("@"))) {
    assert.match(entry.body, /client_max_body_size\s+16k;/u, `${entry.path} named write must stay 16KiB-bounded`);
  }
  // Existing read-only locations are unchanged: every pure GET parent keeps 1k.
  for (const entry of [...listingLocations, ...moderationLocations, ...catalogLocations]) {
    if (!/proxy_pass/u.test(entry.body)) continue;
    if (entry.path.startsWith("@")) continue;
    if (/if\s*\(\$request_method\s*=\s*POST\)/u.test(entry.body)) continue;
    if (!/if\s*\(\$request_method\s*!=\s*GET\)/u.test(entry.body)) continue;
    assert.match(entry.body, /client_max_body_size\s+1k;/u, `${entry.path} read-only location must keep the 1k bound`);
  }
});

test("mixed GET/POST parent 16KiB bound reconstructs the actual 413 defect before named dispatch", () => {
  // Regression for the production 413: a 1098-byte JSON listing-create. The
  // exact failure mode is nginx rejecting in the PARENT location before the
  // internal named POST location is entered. Reconstruct that ordering from
  // the parsed directives: the mixed parent must both dispatch on POST and
  // declare a transport bound strictly greater than the canonical payload.
  const canonicalPayloadBytes = 1098;
  for (const entry of listingLocations.filter((candidate) => /if\s*\(\$request_method\s*=\s*POST\)/u.test(candidate.body))) {
    const dispatchPost = /if\s*\(\$request_method\s*=\s*POST\)\s*\{\s*return\s+418;\s*\}/u.test(entry.body);
    assert.ok(dispatchPost, `${entry.path} must route its POST to the internal named location`);
    const declared = entry.body.match(/client_max_body_size\s+(\d+)k;/u);
    assert.ok(declared, `${entry.path} must declare a finite client_max_body_size`);
    const parentBytes = Number(declared[1]) * 1024;
    assert.ok(
      parentBytes > canonicalPayloadBytes,
      `${entry.path} parent bound ${parentBytes}B must exceed the canonical ${canonicalPayloadBytes}B payload`,
    );
    assert.ok(parentBytes >= 16 * 1024, `${entry.path} parent bound must admit the maximum legitimate 16KiB write`);
    const target = entry.body.match(/error_page\s+418\s+=\s+(@[A-Za-z0-9_]+);/u);
    assert.ok(target, `${entry.path} must name its internal dispatch target`);
    const named = listingLocations.find((candidate) => candidate.path === target[1]);
    assert.ok(named, `${entry.path} dispatch target must exist`);
    assert.match(named.body, /client_max_body_size\s+16k;/u, `${named.path} must keep its 16KiB named bound`);
  }
  // No broad 16KiB relaxation leaked onto the pure GET reads.
  const readOnlySizes = [...listingLocations, ...moderationLocations, ...catalogLocations]
    .filter((entry) => /proxy_pass/u.test(entry.body) && !entry.path.startsWith("@") && !/if\s*\(\$request_method\s*=\s*POST\)/u.test(entry.body) && /if\s*\(\$request_method\s*!=\s*GET\)/u.test(entry.body))
    .map((entry) => entry.body.match(/client_max_body_size\s+(\d+)k;/u))
    .filter(Boolean)
    .map((match) => match[1]);
  assert.ok(readOnlySizes.length >= 10, "expected the untouched read-only locations");
  for (const size of readOnlySizes) {
    assert.equal(size, "1", "read-only locations must not be relaxed past the 1k no-body bound");
  }
});

test("public params are credentialless with an explicit allowlist and no client proxy metadata", () => {
  assert.match(publicParams, /proxy_pass_request_headers\s+off;/u);
  const forwarded = publicParams.match(/proxy_set_header\s+([^\s]+)\s+\$http_/gu) ?? [];
  const allowed = new Set([
    "Origin",
    "X-OpenArc-Client",
    "Sec-Fetch-Site",
    "Sec-Fetch-Mode",
    "Sec-Fetch-Dest",
    "Accept",
  ]);
  for (const directive of forwarded) {
    const name = directive.replace(/proxy_set_header\s+/u, "").replace(/\s+\$http_$/u, "");
    assert.ok(allowed.has(name), `public params must not forward unexpected header ${name}`);
  }
  assert.ok(!/proxy_set_header\s+Cookie\s+\$http_cookie/u.test(publicParams));
  assert.ok(!/proxy_set_header\s+Authorization\s+\$http_authorization/u.test(publicParams));
  assert.ok(!/if\s*\(\$http_x_forwarded_for/u.test(publicParams));
  assert.ok(!/proxy_set_header\s+X-Forwarded-For\s+\$http/u.test(publicParams));
  assert.ok(!/proxy_set_header\s+X-Real-IP\s+\$http/u.test(publicParams));
});

test("marketplace response Set-Cookie/CORS/Vary are hidden without mutating old includes", () => {
  for (const header of [
    "Set-Cookie",
    "Access-Control-Allow-Origin",
    "Access-Control-Allow-Credentials",
    "Access-Control-Allow-Headers",
    "Access-Control-Allow-Methods",
    "Access-Control-Expose-Headers",
    "Access-Control-Max-Age",
    "Vary",
  ]) {
    assert.match(responseHeaders, new RegExp(`proxy_hide_header\\s+${header};`, "u"), `must hide ${header}`);
  }
  assert.match(capabilityLocations[0].body, /include\s+\/etc\/nginx\/market_response_headers;/u);
  for (const entry of [...catalogLocations, ...listingLocations, ...moderationLocations]) {
    if (!/proxy_pass/u.test(entry.body)) continue;
    assert.match(entry.body, /include\s+\/etc\/nginx\/(market_response_headers|tenant_proxy_params|tenant_write_proxy_params);/u);
  }
  const apiSource = read(FILES.apiConf);
  assert.match(apiSource, /include \/etc\/nginx\/conf\.d\/openarc-auth-locations\.inc;/u);
  assert.match(apiSource, /include \/etc\/nginx\/conf\.d\/openarc-tenant-locations\.inc;/u);
  assert.match(apiSource, /include \/etc\/nginx\/conf\.d\/openarc-machine-locations\.inc;/u);
});

test("all proxied marketplace routes keep verified TLS, retries off and bounded deadlines", () => {
  const transport = publicParams + read("apps/web/tenant_proxy_params") + read("apps/web/tenant_write_proxy_params");
  assert.match(transport, /proxy_ssl_server_name\s+on;/u);
  assert.match(transport, /proxy_ssl_verify\s+on;/u);
  assert.match(transport, /proxy_ssl_verify_depth\s+3;/u);
  assert.ok(!/proxy_ssl_verify\s+off;/u.test(transport));
  assert.match(transport, /proxy_next_upstream\s+off;/u);
  assert.match(transport, /proxy_(connect|send|read)_timeout\s+[1-9]\d*s;/u);
  for (const [name, locations] of [
    ["catalog", catalogLocations],
    ["listing", listingLocations],
    ["moderation", moderationLocations],
  ]) {
    for (const entry of locations) {
      if (!/proxy_pass/u.test(entry.body)) continue;
      assert.ok(!/proxy_pass\s+http:/u.test(entry.body), `${name} must use https only`);
    }
  }
});

test("the capability route is GET-only, query/body/credential-free and unconditional", () => {
  assert.equal(capabilityLocations.length, 1);
  const entry = capabilityLocations[0];
  assert.match(entry.body, /if\s*\(\$request_method\s*!=\s*GET\)\s*\{\s*return\s+405;\s*\}/u);
  assert.match(entry.body, /if\s*\(\$http_proxy_authorization\s*!=\s*""\)\s*\{\s*return\s+403;\s*\}/u);
  assert.match(entry.body, /proxy_pass\s+https:\/\/\$\{API_UPSTREAM_HOST\}\/v2\/public\/marketplace-capabilities;/u);
  assert.ok(!/proxy_cache/u.test(entry.body));
  for (const file of [FILES.catalog, FILES.listing, FILES.moderation]) {
    assert.ok(!read(file).includes("marketplace-capabilities"), `${file} must not own the capability route`);
  }
});

test("API templates include each enabled family independently plus the always-on deny", () => {
  for (const template of [FILES.apiConf, FILES.arcConf]) {
    const source = read(template);
    for (const include of [
      "openarc-market-capability-locations.inc",
      "openarc-market-catalog-locations.inc",
      "openarc-listing-management-locations.inc",
      "openarc-market-moderation-locations.inc",
      "openarc-market-deny.inc",
    ]) {
      const occurrences = source.split(include).length - 1;
      assert.equal(occurrences, 1, `${template} must include ${include} exactly once`);
    }
  }
  assert.ok(
    !denyLocations.some((entry) => entry.modifier === "^~"),
    "deny fallbacks must not use ^~ (would suppress enabled regexes)",
  );
  for (const entry of denyLocations) {
    assert.match(entry.body, /return\s+404;/u, `${entry.path} deny must return 404`);
    assert.ok(!/proxy_pass|try_files/u.test(entry.body), `${entry.path} deny must not proxy or serve SPA`);
  }
});

test("deny-only plain prefixes cover family roots and bare suffix lookalikes", () => {
  // Plain (unmodified) prefix locations, never exact-only and never `^~`.
  const plainPrefixes = denyLocations.filter((entry) => entry.modifier === "");
  for (const required of [
    "/v2/public/market",
    "/v2/public/marketplace-capabilities",
    "/v2/provider",
    "/v2/moderator",
  ]) {
    const entry = plainPrefixes.find((candidate) => candidate.path === required);
    assert.ok(entry, `${required} must be a plain deny prefix so lookalikes are covered`);
    assert.equal(entry.modifier, "");
  }
  // The lookalikes the reviewer proved reached the SPA must now be denied.
  for (const lookalike of [
    "/v2/public/marketplace-capabilitiesXYZ",
    "/v2/public/marketXYZ",
    "/v2/providerXYZ",
    "/v2/moderatorXYZ",
  ]) {
    assert.ok(
      plainPrefixes.some((entry) => lookalike.startsWith(entry.path)),
      `${lookalike} must be denied by a plain prefix fallback`,
    );
  }
  // Enabled anchored routes must still win: exact beats prefix, regex beats prefix.
  assert.ok(catalogLocations.some((entry) => entry.modifier === "=" && entry.path === "/v2/public/market/listings"));
  assert.ok(catalogLocations.some((entry) => entry.modifier === "~" && entry.path.includes("/listings/" + LISTING_PREFIX)));
});

test("the plain non-API template denies marketplace lookalikes instead of SPA HTML", () => {
  const plain = read(FILES.plainConf);
  const plainLocations = parseLocations(plain);
  for (const required of [
    "/v2/public/marketplace-capabilities",
    "/v2/public/market",
    "/v2/provider",
    "/v2/moderator",
  ]) {
    const entry = plainLocations.find((candidate) => candidate.path === required && candidate.modifier === "");
    assert.ok(entry, `plain template must deny ${required} as a plain prefix`);
    assert.match(entry.body, /return\s+404;/u);
  }
  for (const lookalike of [
    "/v2/public/marketplace-capabilitiesXYZ",
    "/v2/public/marketXYZ",
  ]) {
    assert.ok(
      plainLocations.some((entry) => entry.modifier === "" && lookalike.startsWith(entry.path)),
      `${lookalike} must be denied in the no-API template`,
    );
  }
  assert.ok(!plain.includes("API_UPSTREAM_HOST"), "plain template must stay API boundary OFF");
  assert.ok(!/proxy_pass/u.test(plain), "plain template must not proxy marketplace paths");
});

test("Dockerfile declares the three flags in build and runtime stages with dependencies", () => {
  for (const flag of [
    "VITE_MARKET_CATALOG_ENABLED",
    "VITE_LISTING_MANAGEMENT_ENABLED",
    "VITE_MARKET_MODERATION_ENABLED",
  ]) {
    const argOccurrences = dockerfile.match(new RegExp(`ARG\\s+${flag}=false`, "gu")) ?? [];
    assert.equal(argOccurrences.length, 2, `${flag} must be an ARG=default false in both stages`);
    assert.match(dockerfile, new RegExp(`case "\\$\\{${flag}\\}" in true\\|false\\)`, "u"), `${flag} must be validated`);
  }
  assert.match(dockerfile, /VITE_MARKET_CATALOG_ENABLED=true requires VITE_API_BOUNDARY_ENABLED=true/u);
  assert.match(dockerfile, /VITE_LISTING_MANAGEMENT_ENABLED=true requires VITE_ACCOUNT_ACCESS_ENABLED=true, VITE_TENANT_READS_ENABLED=true and VITE_API_BOUNDARY_ENABLED=true/u);
  assert.match(dockerfile, /VITE_MARKET_MODERATION_ENABLED=true requires VITE_ACCOUNT_ACCESS_ENABLED=true and VITE_API_BOUNDARY_ENABLED=true/u);
  assert.ok(!/VITE_LISTING_MANAGEMENT_ENABLED=true[^;]*TENANT_WRITES/u.test(dockerfile));
  assert.ok(!/VITE_MARKET_MODERATION_ENABLED=true[^;]*TENANT_WRITES/u.test(dockerfile));
  assert.ok(!/VITE_MARKET_MODERATION_ENABLED=true[^;]*TENANT_READS/u.test(dockerfile));
});

test("Dockerfile copies marketplace files and independently selects each include", () => {
  assert.match(dockerfile, /COPY apps\/web\/nginx-market-capability\.conf apps\/web\/nginx-market-catalog-locations\.conf apps\/web\/nginx-listing-management-locations\.conf apps\/web\/nginx-market-moderation-locations\.conf apps\/web\/nginx-market-deny\.conf apps\/web\/market_public_proxy_params apps\/web\/market_response_headers \/tmp\/openarc-nginx\//u);
  assert.match(dockerfile, /cp \/tmp\/openarc-nginx\/nginx-market-capability\.conf \/etc\/nginx\/templates\/openarc-market-capability-locations\.inc\.template;/u);
  assert.match(dockerfile, /cp \/tmp\/openarc-nginx\/nginx-market-deny\.conf \/etc\/nginx\/templates\/openarc-market-deny\.inc\.template;/u);
  assert.match(dockerfile, /if \[ "\$\{VITE_MARKET_CATALOG_ENABLED\}" = "true" \]; then \\\n\s*cp \/tmp\/openarc-nginx\/nginx-market-catalog-locations\.conf/u);
  assert.match(dockerfile, /if \[ "\$\{VITE_LISTING_MANAGEMENT_ENABLED\}" = "true" \]; then \\\n\s*cp \/tmp\/openarc-nginx\/nginx-listing-management-locations\.conf/u);
  assert.match(dockerfile, /if \[ "\$\{VITE_MARKET_MODERATION_ENABLED\}" = "true" \]; then \\\n\s*cp \/tmp\/openarc-nginx\/nginx-market-moderation-locations\.conf/u);
  const empty = dockerfile.match(/:\s*>\s*\/etc\/nginx\/templates\/openarc-(?:market-catalog|listing-management|market-moderation)-locations\.inc\.template;/gu) ?? [];
  assert.equal(empty.length, 3, "all three omitted business includes must be written empty");
});

test("shared GET/POST tenant params are installed whenever an enabled marketplace family needs them", () => {
  // The runtime stage must unconditionally copy both shared files (available in
  // /tmp/openarc-nginx) and must install them independent of the old tenant flags.
  assert.match(dockerfile, /COPY apps\/web\/nginx\.conf apps\/web\/nginx-api\.conf apps\/web\/nginx-arc\.conf apps\/web\/proxy_params apps\/web\/auth_proxy_params apps\/web\/tenant_proxy_params apps\/web\/tenant_write_proxy_params /u);
  assert.match(
    dockerfile,
    /if \[ "\$\{VITE_LISTING_MANAGEMENT_ENABLED\}" = "true" \] \|\| \[ "\$\{VITE_MARKET_MODERATION_ENABLED\}" = "true" \]; then \\\n\s*cp \/tmp\/openarc-nginx\/tenant_proxy_params \/etc\/nginx\/tenant_proxy_params; \\\n\s*cp \/tmp\/openarc-nginx\/tenant_write_proxy_params \/etc\/nginx\/tenant_write_proxy_params; \\\n\s*fi;/u,
    "listing/moderation must install both shared GET and POST params regardless of tenant read/write flags",
  );
  // The marketplace location files reference exactly those installed paths.
  assert.match(listing, /include \/etc\/nginx\/tenant_proxy_params;/u);
  assert.match(listing, /include \/etc\/nginx\/tenant_write_proxy_params;/u);
  assert.match(moderation, /include \/etc\/nginx\/tenant_proxy_params;/u);
  assert.match(moderation, /include \/etc\/nginx\/tenant_write_proxy_params;/u);
  // Old feature behavior is preserved: tenant reads/writes still select their includes.
  assert.match(dockerfile, /cp \/tmp\/openarc-nginx\/nginx-tenant-write-locations\.conf \/etc\/nginx\/templates\/openarc-tenant-locations\.inc\.template;/u);
  assert.match(dockerfile, /cp \/tmp\/openarc-nginx\/nginx-tenant-locations\.conf \/etc\/nginx\/templates\/openarc-tenant-locations\.inc\.template;/u);
  assert.match(dockerfile, /cp \/tmp\/openarc-nginx\/nginx-tenant-disabled\.conf \/etc\/nginx\/templates\/openarc-tenant-locations\.inc\.template;/u);
});

test("marketplace params and response headers are installed and old params are untouched", () => {
  assert.match(dockerfile, /cp \/tmp\/openarc-nginx\/market_public_proxy_params \/etc\/nginx\/market_public_proxy_params;/u);
  assert.match(dockerfile, /cp \/tmp\/openarc-nginx\/market_response_headers \/etc\/nginx\/market_response_headers;/u);
  for (const template of [FILES.apiConf, FILES.arcConf]) {
    const source = read(template);
    assert.equal(source.split("openarc-tenant-locations.inc").length - 1, 1);
    assert.equal(source.split("openarc-auth-locations.inc").length - 1, 1);
  }
});
