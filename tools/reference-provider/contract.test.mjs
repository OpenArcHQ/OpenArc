import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";

// The workspace has no root path alias, so import the actual built shared
// package through its relative dist entrypoint. This makes the tests exercise
// the real frozen schemas rather than a local copy.
const shared = await import("../../packages/shared/dist/index.js");

const {
  CommerceListingOwnerVersionSchema,
  CommerceListingPublicVersionSchema,
  projectCommerceListingPublicVersion,
} = shared;

function readFixture(name) {
  return readFileSync(new URL(`./${name}`, import.meta.url));
}

function parseFixture(name) {
  return JSON.parse(readFixture(name).toString("utf8"));
}

function sha256(bytes) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

const inputBytes = readFixture("input.schema.json");
const outputBytes = readFixture("output.schema.json");
const receiptBytes = readFixture("receipt.schema.json");
const inputSchema = JSON.parse(inputBytes.toString("utf8"));
const outputSchema = JSON.parse(outputBytes.toString("utf8"));
const receiptSchema = JSON.parse(receiptBytes.toString("utf8"));
const listing = parseFixture("listing.fixture.json");
const retrieval = parseFixture("retrieval-contract.json");
const readme = readFixture("README.md").toString("utf8");

const EXPECTED_DIGESTS = {
  input: "sha256:05ef830eca39e24fff9b1a8453fd2bf37d7f44b1218bce31dd4bfd814ac08357",
  output: "sha256:b3815e99c58414ca54149d6f6783d161b332343aff3494465289b7da13d376af",
  receipt: "sha256:41078ac65c37efa6e6d9a010f4468eb4348144494819258e3020d5adb06d9076",
};

const SYNTHETIC_ORG_ID =
  "openarc:org:11111111-1111-4111-8111-111111111111";
const SYNTHETIC_PROVIDER_ID =
  "openarc:provider:22222222-2222-4222-8222-222222222222";
const SYNTHETIC_LISTING_ID =
  "openarc:listing:33333333-3333-4333-8333-333333333333";
const RESERVED_ORIGIN = "https://reference.openarc.example";

// The reference receipt property names are the actual lowercase snake_case
// identifiers accepted by the frozen CommerceReceiptContractSchema identifier
// grammar. deliveryFields lists exactly these real properties; schemaVersion is
// a receipt property but is deliberately not a delivery field.
const EXPECTED_DELIVERY_FIELDS = Object.freeze([
  "delivery_id",
  "listing_id",
  "listing_version",
  "input_digest",
  "output_digest",
  "delivered_at",
]);

function assertStrictSchemaShape(schema) {
  assert.equal(
    schema.$schema,
    "https://json-schema.org/draft/2020-12/schema",
  );
  assert.equal(schema.type, "object");
  assert.equal(schema.additionalProperties, false);
  assert.ok(Array.isArray(schema.required));
  const required = [...schema.required].sort();
  const properties = Object.keys(schema.properties).sort();
  assert.deepEqual(
    required,
    properties,
    "required must list every declared property",
  );
}

test("input schema is strict, bounded and 2020-12", () => {
  assertStrictSchemaShape(inputSchema);
  assert.equal(inputSchema.properties.schemaVersion.const, "openarc.reference-input.v1");
  assert.equal(inputSchema.properties.a.type, "integer");
  assert.equal(inputSchema.properties.a.minimum, 0);
  assert.equal(inputSchema.properties.a.maximum, 1000000);
  assert.equal(inputSchema.properties.b.type, "integer");
  assert.equal(inputSchema.properties.b.minimum, 0);
  assert.equal(inputSchema.properties.b.maximum, 1000000);
});

test("output schema is strict, bounded and 2020-12", () => {
  assertStrictSchemaShape(outputSchema);
  assert.equal(
    outputSchema.properties.schemaVersion.const,
    "openarc.reference-output.v1",
  );
  assert.equal(outputSchema.properties.sum.type, "integer");
  assert.equal(outputSchema.properties.sum.minimum, 0);
  assert.equal(outputSchema.properties.sum.maximum, 2000000);
});

test("receipt schema is strict with exact field names and bounded formats", () => {
  assertStrictSchemaShape(receiptSchema);
  assert.deepEqual(receiptSchema.required.slice().sort(), [
    "delivered_at",
    "delivery_id",
    "input_digest",
    "listing_id",
    "listing_version",
    "output_digest",
    "schemaVersion",
  ]);
  assert.equal(
    receiptSchema.properties.schemaVersion.const,
    "openarc.reference-receipt.v1",
  );
  assert.equal(receiptSchema.properties.schemaVersion.type, "string");
  assert.equal(receiptSchema.properties.schemaVersion.maxLength, 28);
  assert.equal(receiptSchema.properties.delivery_id.type, "string");
  assert.equal(receiptSchema.properties.delivery_id.maxLength, 36);
  assert.equal(
    receiptSchema.properties.delivery_id.pattern,
    "^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}(?![\\s\\S])",
  );
  assert.equal(receiptSchema.properties.listing_id.maxLength, 52);
  assert.equal(
    receiptSchema.properties.listing_id.pattern,
    "^openarc:listing:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}(?![\\s\\S])",
  );
  assert.equal(receiptSchema.properties.listing_version.maxLength, 9);
  assert.equal(
    receiptSchema.properties.listing_version.pattern,
    "^[1-9][0-9]{0,8}(?![\\s\\S])",
  );
  assert.equal(receiptSchema.properties.input_digest.maxLength, 71);
  assert.equal(
    receiptSchema.properties.input_digest.pattern,
    "^sha256:[0-9a-f]{64}(?![\\s\\S])",
  );
  assert.equal(receiptSchema.properties.output_digest.maxLength, 71);
  assert.equal(
    receiptSchema.properties.output_digest.pattern,
    "^sha256:[0-9a-f]{64}(?![\\s\\S])",
  );
  assert.equal(receiptSchema.properties.delivered_at.format, "date-time");
  assert.equal(receiptSchema.properties.delivered_at.maxLength, 27);
  assert.equal(
    receiptSchema.properties.delivered_at.pattern,
    "^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\\.[0-9]{1,6})?Z(?![\\s\\S])",
  );
});

test("bounded receipt strings reject overlong and trailing-newline vectors", () => {
  const delivered = receiptSchema.properties.delivered_at;
  const atBoundary = "2026-09-12T00:00:00.123456Z";
  assert.equal(atBoundary.length, delivered.maxLength);
  assert.ok(new RegExp(delivered.pattern, "u").test(atBoundary));
  // Valid SHORT values (below maxLength) must still be accepted.
  assert.ok(new RegExp(delivered.pattern, "u").test("2026-09-12T00:00:00Z"));
  assert.ok(
    new RegExp(receiptSchema.properties.listing_version.pattern, "u").test("1"),
  );
  const rejected = [
    `${atBoundary}\n`,
    "2026-09-12T00:00:00.1234567Z",
    "2026-09-12T00:00:00+00:00",
    "2026-09-12T00:00:00Z\n",
  ];
  for (const vector of rejected) {
    const overlong = vector.length > delivered.maxLength;
    const patternRejects = !new RegExp(delivered.pattern, "u").test(vector);
    assert.ok(
      overlong || patternRejects,
      `delivered_at must reject ${JSON.stringify(vector)}`,
    );
  }
  // Short trailing-newline vectors: below maxLength, so rejection MUST come
  // from the absolute end anchor rather than the maxLength bound.
  const shortRejected = [
    { field: "listing_version", vector: "1\n" },
    { field: "delivered_at", vector: "2026-09-12T00:00:00Z\n" },
  ];
  for (const { field, vector } of shortRejected) {
    const property = receiptSchema.properties[field];
    assert.ok(
      vector.length < property.maxLength,
      `${field} vector ${JSON.stringify(vector)} must be below maxLength`,
    );
    assert.ok(
      !new RegExp(property.pattern, "u").test(vector),
      `${field} must reject short trailing-newline ${JSON.stringify(vector)}`,
    );
  }
});

test("receipt embeds no raw input or output values", () => {
  const keys = Object.keys(receiptSchema.properties);
  for (const forbidden of ["a", "b", "sum", "input", "output", "proof", "token"]) {
    assert.ok(!keys.includes(forbidden), `receipt must not embed ${forbidden}`);
  }
  // No remote $ref or external fetch.
  assert.ok(!JSON.stringify(receiptSchema).includes("$ref"));
  assert.ok(!JSON.stringify(inputSchema).includes("$ref"));
  assert.ok(!JSON.stringify(outputSchema).includes("$ref"));
});

test("schema byte digests include final newline and are pinned", () => {
  assert.ok(inputBytes.toString("utf8").endsWith("\n"));
  assert.ok(outputBytes.toString("utf8").endsWith("\n"));
  assert.ok(receiptBytes.toString("utf8").endsWith("\n"));
  assert.equal(sha256(inputBytes), EXPECTED_DIGESTS.input);
  assert.equal(sha256(outputBytes), EXPECTED_DIGESTS.output);
  assert.equal(sha256(receiptBytes), EXPECTED_DIGESTS.receipt);
});

test("tampered schema bytes produce a digest mismatch", () => {
  const tampered = Buffer.concat([inputBytes, Buffer.from(" ")]);
  assert.notEqual(sha256(tampered), EXPECTED_DIGESTS.input);
  assert.notEqual(sha256(tampered), listing.manifest.inputSchemaDigest);
});

test("listing fixture pins actual schema byte digests", () => {
  assert.equal(listing.manifest.inputSchemaDigest, sha256(inputBytes));
  assert.equal(listing.manifest.outputSchemaDigest, sha256(outputBytes));
  assert.equal(listing.evidenceContract.receiptSchemaDigest, sha256(receiptBytes));
  assert.equal(listing.manifest.inputSchemaDigest, EXPECTED_DIGESTS.input);
  assert.equal(listing.manifest.outputSchemaDigest, EXPECTED_DIGESTS.output);
  assert.equal(listing.evidenceContract.receiptSchemaDigest, EXPECTED_DIGESTS.receipt);
});

test("listing fixture validates against the built owner DTO", () => {
  const parsed = CommerceListingOwnerVersionSchema.parse(listing);
  assert.equal(parsed.schemaVersion, "openarc.listing-owner-version.v1");
  assert.equal(parsed.listingId, SYNTHETIC_LISTING_ID);
  assert.equal(parsed.organizationId, SYNTHETIC_ORG_ID);
  assert.equal(parsed.providerId, SYNTHETIC_PROVIDER_ID);
  assert.equal(parsed.version, "1");
  assert.equal(parsed.kind, "api");
  assert.equal(parsed.status, "draft");
  assert.equal(parsed.originReviewState, "unreviewed");
  assert.equal(parsed.publishedAt, null);
  assert.equal(parsed.paymentLane, "unavailable");
  assert.equal(parsed.availability.status, "unavailable");
  assert.equal(parsed.availability.rateLimitPerMinute, null);
  assert.equal(parsed.createdAt, "2026-09-12T00:00:00.000000Z");
  assert.equal(parsed.updatedAt, "2026-09-12T00:00:00.000000Z");
  assert.equal(parsed.termsRevision, "reference-fixture-v1");
  assert.equal(parsed.evidenceContract.receiptType, "reference_sum");
  assert.equal(parsed.endpointContract.origin, RESERVED_ORIGIN);
  assert.equal(parsed.endpointContract.path, "/v1/sum");
});

test("listing price is exact accepted erc20/6 TestnetUSDC fixed 0.01", () => {
  assert.equal(listing.price.pricingModel, "fixed");
  const amount = listing.price.amount;
  assert.equal(amount.schemaVersion, "openarc.usdc-amount.v1");
  assert.equal(amount.networkId, "eip155:5042002");
  assert.equal(amount.asset, "USDC");
  assert.equal(amount.representation, "erc20");
  assert.equal(amount.decimals, 6);
  assert.equal(amount.atomicAmount, "10000");
  assert.equal(BigInt(amount.atomicAmount), 10000n);
});

test("synthetic identifiers bind the fixture without real ownership", () => {
  assert.equal(listing.listingId, SYNTHETIC_LISTING_ID);
  assert.equal(listing.organizationId, SYNTHETIC_ORG_ID);
  assert.equal(listing.providerId, SYNTHETIC_PROVIDER_ID);
  assert.notEqual(listing.organizationId, listing.providerId);
});

test("draft/unreviewed fixture has no eligible public projection", () => {
  assert.equal(projectCommerceListingPublicVersion(listing), null);
});

test("public projection allowlist drops organizationId and endpoint path", () => {
  const activeListing = {
    ...listing,
    status: "active",
    originReviewState: "approved",
    publishedAt: "2026-09-12T00:00:00.000000Z",
  };
  const projected = projectCommerceListingPublicVersion(activeListing);
  assert.notEqual(projected, null);
  CommerceListingPublicVersionSchema.parse(projected);
  assert.equal(projected.listingId, SYNTHETIC_LISTING_ID);
  assert.equal(projected.providerId, SYNTHETIC_PROVIDER_ID);
  assert.equal(projected.endpointOrigin, RESERVED_ORIGIN);
  assert.ok(!("organizationId" in projected));
  assert.ok(!("endpointContract" in projected));
  assert.ok(!("endpointPath" in projected));
  const serialized = JSON.stringify(projected);
  assert.ok(!serialized.includes("/v1/sum"));
  assert.ok(!serialized.includes(SYNTHETIC_ORG_ID));
});

test("reserved origin is documentation only in fixture and README", () => {
  assert.equal(listing.endpointContract.origin, RESERVED_ORIGIN);
  assert.ok(listing.privacySummary.includes("no active or deployed endpoint"));
  assert.ok(listing.privacySummary.includes("synthetic integer operands"));
  assert.ok(listing.title.includes("TESTNET REFERENCE ONLY"));
  assert.ok(listing.description.includes("TESTNET REFERENCE ONLY"));
  assert.ok(
    listing.privacySummary.toLowerCase().includes("not a zero-retention account claim"),
  );
  assert.ok(readme.includes("RESERVED DOCUMENTATION") || readme.includes("reserved documentation"));
});

test("README documents the 1+2=3 sample", () => {
  assert.ok(readme.includes('"a": 1, "b": 2'));
  assert.ok(readme.includes('"sum": 3'));
});

test("retrieval contract is honestly contract_only", () => {
  assert.equal(retrieval.schemaVersion, "openarc.reference-retrieval-contract.v1");
  assert.equal(retrieval.implementationStatus, "contract_only");
  assert.equal(retrieval.environment, "testnet");
  assert.equal(retrieval.network, "eip155:5042002");
  assert.equal(retrieval.paymentLane, "unavailable");
  assert.equal(retrieval.endpoint.method, "GET");
  assert.equal(retrieval.endpoint.origin, RESERVED_ORIGIN);
  assert.equal(retrieval.endpoint.pathTemplate, "/v1/deliveries/:deliveryId");
  assert.equal(retrieval.endpoint.active, false);
  assert.equal(retrieval.authentication.location, "Authorization");
  assert.equal(retrieval.authentication.tokenGenerationImplemented, false);
  assert.equal(retrieval.authentication.fixtureContainsTokenValues, false);
  assert.equal(retrieval.authentication.digestAloneGrantsRetrieval, false);
  for (const forbidden of ["query", "cookie", "browser_storage"]) {
    assert.ok(retrieval.authentication.forbiddenLocations.includes(forbidden));
  }
});

test("retrieval scope cannot dispatch payment or purchase", () => {
  assert.equal(retrieval.scope.retrievalOnly, true);
  assert.equal(retrieval.scope.canInitiatePurchase, false);
  assert.equal(retrieval.scope.canCharge, false);
  assert.equal(retrieval.scope.canRetryPurchase, false);
  assert.equal(retrieval.replaySemantics.chargesAgain, false);
  assert.equal(retrieval.replaySemantics.rerunsOperation, false);
  assert.equal(
    retrieval.replaySemantics.repeatedAuthorizedRetrievalReturnsByteIdenticalOutput,
    true,
  );
  assert.equal(retrieval.replaySemantics.sameOutputDigest, true);
  assert.equal(retrieval.replaySemantics.rechecksProofExpiryEachTime, true);
  assert.equal(retrieval.replaySemantics.rechecksProofRevocationEachTime, true);
  assert.equal(retrieval.replaySemantics.rechecksOwnershipEachTime, true);
  const serialized = JSON.stringify(retrieval);
  assert.ok(!serialized.includes("charge("));
  assert.ok(!serialized.includes("purchase("));
});

test("retrieval transport and retention invariants are explicit", () => {
  assert.equal(retrieval.transport.cacheControl, "no-store");
  assert.equal(retrieval.transport.redirectsRejected, true);
  assert.equal(retrieval.transport.maxResponseBytes, 65536);
  assert.equal(retrieval.transport.logsRawPayload, false);
  assert.equal(retrieval.transport.logsToken, false);
  assert.equal(retrieval.retention.status, "proposed_controlled_test_policy");
  assert.equal(retrieval.retention.windowHours, 24);
  assert.equal(retrieval.retention.clockStarts, "first_delivery");
  assert.equal(retrieval.retention.expiryImmutable, true);
  assert.equal(retrieval.retention.getExtendsExpiry, false);
  assert.equal(retrieval.retention.afterExpiryStatus, 410);
  assert.equal(retrieval.retention.afterExpiryReturnsOutput, false);
  assert.equal(retrieval.retention.afterExpiryRecharges, false);
  assert.equal(retrieval.retention.proofFailureStatus, 403);
  assert.equal(retrieval.retention.proofFailureRevealsExistenceDetails, false);
  assert.equal(retrieval.retention.beforeKnownCompletionStatus, 409);
  assert.equal(retrieval.retention.neverFakesSuccessForMissingArtifact, true);
  assert.equal(retrieval.retention.platformUniquenessAuditRetentionSeparatelyGoverned, true);
  assert.equal(retrieval.retention.durableFinancialTombstonesPreserved, true);
  assert.equal(retrieval.retention.guessedProductionLegalRetentionPeriod, null);
  assert.equal(retrieval.retention.mainnetAddresses, null);
});

test("delivery fields name exact receipt properties without alias mapping", () => {
  const declared = [...listing.evidenceContract.deliveryFields];
  assert.deepEqual(declared, EXPECTED_DELIVERY_FIELDS);
  assert.equal(new Set(declared).size, declared.length);
  for (const field of declared) {
    assert.match(field, /^[a-z][a-z0-9_.-]{0,63}$/u);
    assert.ok(
      Object.prototype.hasOwnProperty.call(receiptSchema.properties, field),
      `${field} must be an actual receipt property`,
    );
  }
  // schemaVersion is a real receipt property but is deliberately not a delivery
  // field, and no camelCase alias form is present.
  assert.ok("schemaVersion" in receiptSchema.properties);
  assert.ok(!declared.includes("schemaVersion"));
  assert.ok(!declared.includes("deliveryId"));
  assert.ok(!declared.includes("deliveredAt"));
});
