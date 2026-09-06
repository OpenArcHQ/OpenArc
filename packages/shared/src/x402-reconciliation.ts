import { z } from "zod";

import { ArcTransactionEvidenceSchema } from "./arc-observation.js";
import { IsoTimestampSchema, compareIsoTimestamps } from "./primitives.js";
import { CanonicalTransferIdSchema, GatewayTransferObservationSchema, X402ReceiptBundleSchema,
  type X402ReceiptBundle } from "./x402-evidence.js";

const BundleInputSchema = z.strictObject({ recordId: CanonicalTransferIdSchema, bundle: X402ReceiptBundleSchema });
export const X402ReconciliationInputSchema = z.strictObject({
  bundleRecordId: CanonicalTransferIdSchema, bundle: X402ReceiptBundleSchema,
  gateway: z.strictObject({ recordId: CanonicalTransferIdSchema, observation: GatewayTransferObservationSchema }).optional(),
  onchain: z.strictObject({ recordId: CanonicalTransferIdSchema, observation: ArcTransactionEvidenceSchema }).optional(),
  otherBundles: z.array(BundleInputSchema).max(63).default([]), evaluatedAt: IsoTimestampSchema,
}).superRefine((input, context) => {
  const ids = [input.bundleRecordId, ...(input.gateway ? [input.gateway.recordId] : []),
    ...(input.onchain ? [input.onchain.recordId] : []), ...input.otherBundles.map((entry) => entry.recordId)];
  if (new Set(ids).size !== ids.length) context.addIssue({ code: "custom", message: "Input record IDs must be unique" });
  const times = [input.bundle.capturedAt, ...input.otherBundles.map((entry) => entry.bundle.capturedAt),
    ...(input.gateway ? [input.gateway.observation.source.observedAt] : []),
    ...(input.onchain ? [input.onchain.observation.source.observedAt, input.onchain.observation.anchor.blockTimestamp] : [])];
  if (IsoTimestampSchema.safeParse(input.evaluatedAt).success) for (const time of times) {
    if (IsoTimestampSchema.safeParse(time).success && compareIsoTimestamps(time, input.evaluatedAt) > 0) {
      context.addIssue({ code: "custom", message: "Evaluation cannot predate supplied evidence" });
    }
  }
});

export const X402_RECONCILIATION_LIMITATIONS = [
  "Imported metadata is owner-supplied and unauthenticated; agreement does not verify a signature or authorization.",
  "A provider's reported success and HTTP status do not prove fulfillment or quality.",
  "Gateway status is a named provider observation; a separately matched successful Arc transaction proves batch transaction inclusion only.",
  "A shared batch transaction hash does not establish individual-payment inclusion or amount.",
  "Replay checks cover only the supplied local bundles, not all payments or other workspaces.",
  "Validity is compared with an imported response timestamp, not a verified execution time; old evidence does not expire merely because it is viewed later.",
] as const;

export type X402Finding = { code: string; recordIds: string[] };
export type X402ReconciliationInput = z.input<typeof X402ReconciliationInputSchema>;
export interface X402ReconciliationResult {
  ruleVersion: "openarc.x402-reconciliation.m07.v1";
  evaluatedAt: string;
  inputRecordIds: string[];
  replayScope: { kind: "supplied_local_bundles_only"; recordIds: string[] };
  metadataAgreement: "consistent" | "incomplete" | "conflicting";
  authorizationVerification: "not_verified";
  authorizationValidity: "not_supplied" | "response_time_missing" | "within_reported_window" | "outside_reported_window";
  providerResponse: "not_supplied" | "reported_success" | "reported_failure";
  fulfillment: "not_verified";
  gatewayStatus: "not_observed" | "received" | "batched" | "confirmed" | "completed" | "failed";
  onchainSettlement: "not_verified";
  batchInclusion: "not_observed" | "unlinked" | "conflicting" | "included_successfully";
  gaps: X402Finding[];
  conflicts: X402Finding[];
  duplicates: X402Finding[];
  limitations: string[];
}

/** Pure comparison of named evidence. It has no signing, fulfillment, or settlement inference. */
export function reconcileX402(value: X402ReconciliationInput): X402ReconciliationResult {
  const input = X402ReconciliationInputSchema.parse(value);
  const { requirement, authorizationMetadata: auth, responseMetadata: response } = input.bundle;
  const gateway = input.gateway?.observation.transfer;
  const gaps: X402Finding[] = [];
  const conflicts: X402Finding[] = [];
  const duplicates: X402Finding[] = [];
  const primary = [input.bundleRecordId];
  const pair = input.gateway ? [input.bundleRecordId, input.gateway.recordId].sort() : primary;
  const gap = (code: string, ids = primary) => gaps.push({ code, recordIds: [...ids].sort() });
  const conflict = (code: string, ids = primary) => conflicts.push({ code, recordIds: [...ids].sort() });
  const duplicate = (code: string, ids: string[]) => duplicates.push({ code, recordIds: [...ids].sort() });
  if (!requirement) gap("REQUIREMENT_NOT_SUPPLIED");
  if (!auth) gap("AUTHORIZATION_METADATA_NOT_SUPPLIED");
  if (!response) gap("RESPONSE_METADATA_NOT_SUPPLIED");
  if (!gateway) gap("GATEWAY_NOT_OBSERVED");
  if (requirement && auth) {
    if (requirement.payTo !== auth.to) conflict("REQUIREMENT_AUTHORIZATION_RECIPIENT_MISMATCH");
    if (requirement.amount !== auth.value) conflict("REQUIREMENT_AUTHORIZATION_AMOUNT_MISMATCH");
  }
  let authorizationValidity: X402ReconciliationResult["authorizationValidity"] = "not_supplied";
  if (auth) {
    authorizationValidity = "response_time_missing";
    if (!response) gap("AUTHORIZATION_EXECUTION_TIME_NOT_SUPPLIED");
    else {
      // EIP-3009 uses strict boundaries. Preserve fractions rather than rounding a response down.
      const after = new Date(Number(auth.validAfter) * 1000).toISOString();
      const before = new Date(Number(auth.validBefore) * 1000).toISOString();
      const inWindow = compareIsoTimestamps(response.respondedAt, after) > 0 && compareIsoTimestamps(response.respondedAt, before) < 0;
      authorizationValidity = inWindow ? "within_reported_window" : "outside_reported_window";
      if (!inWindow) conflict("REPORTED_RESPONSE_OUTSIDE_AUTHORIZATION_WINDOW");
    }
  }
  if (response?.reportedSuccess && (response.httpStatus < 200 || response.httpStatus >= 300)) {
    conflict("REPORTED_SUCCESS_HTTP_STATUS_MISMATCH");
  }
  if (gateway) {
    if (!response?.transferId) gap("TRANSFER_ID_LINK_NOT_SUPPLIED", pair);
    else if (response.transferId !== gateway.id) conflict("GATEWAY_TRANSFER_ID_MISMATCH", pair);
    if (auth) {
      if (auth.from !== gateway.fromAddress) conflict("GATEWAY_PAYER_MISMATCH", pair);
      if (auth.to !== gateway.toAddress) conflict("GATEWAY_RECIPIENT_MISMATCH", pair);
      if (auth.value !== gateway.amount) conflict("GATEWAY_AMOUNT_MISMATCH", pair);
      if (auth.nonce !== gateway.nonce) conflict("GATEWAY_NONCE_MISMATCH", pair);
    }
    if (requirement) {
      if (requirement.payTo !== gateway.toAddress) conflict("REQUIREMENT_GATEWAY_RECIPIENT_MISMATCH", pair);
      if (requirement.amount !== gateway.amount) conflict("REQUIREMENT_GATEWAY_AMOUNT_MISMATCH", pair);
    }
    if (!gateway.txHash) gap("BATCH_TRANSACTION_NOT_OBSERVED", pair);
  }
  let batchInclusion: X402ReconciliationResult["batchInclusion"] = "not_observed";
  if (input.onchain) {
    const transaction = input.onchain.observation;
    const ids = [...pair, input.onchain.recordId];
    batchInclusion = "unlinked";
    if (!gateway?.txHash) gap("BATCH_TRANSACTION_LINK_NOT_SUPPLIED", ids);
    else {
      const mismatch = transaction.transaction.hash !== gateway.txHash;
      const invalidAnchor = transaction.transaction.blockNumber !== transaction.anchor.blockNumber ||
        transaction.transaction.blockHash !== transaction.anchor.blockHash ||
        compareIsoTimestamps(transaction.anchor.blockTimestamp, transaction.source.observedAt) > 0;
      if (mismatch) conflict("BATCH_TRANSACTION_HASH_MISMATCH", ids);
      if (invalidAnchor) conflict("BATCH_TRANSACTION_ANCHOR_MISMATCH", ids);
      if (transaction.receipt.status !== "success") conflict("BATCH_TRANSACTION_FAILED", ids);
      batchInclusion = mismatch || invalidAnchor || transaction.receipt.status !== "success" ? "conflicting" : "included_successfully";
    }
  }
  for (const other of [...input.otherBundles].sort((a, b) => a.recordId.localeCompare(b.recordId))) {
    const ids = [input.bundleRecordId, other.recordId];
    if (semanticContent(input.bundle) === semanticContent(other.bundle)) {
      duplicate("DUPLICATE_METADATA", ids);
      continue;
    }
    if (other.bundle.bundleId === input.bundle.bundleId) conflict("BUNDLE_ID_CONTENT_MISMATCH", ids);
    if (auth && authorizationKey(input.bundle) === authorizationKey(other.bundle)) {
      if (JSON.stringify(auth) !== JSON.stringify(other.bundle.authorizationMetadata)) conflict("AUTHORIZATION_NONCE_CONTENT_MISMATCH", ids);
      else duplicate("DUPLICATE_AUTHORIZATION_METADATA", ids);
      if (JSON.stringify(input.bundle.resource) !== JSON.stringify(other.bundle.resource)) conflict("AUTHORIZATION_RESOURCE_MISMATCH", ids);
    }
    if (response?.transferId && response.transferId === other.bundle.responseMetadata?.transferId) {
      if (overlappingContentMatches(input.bundle, other.bundle)) duplicate("DUPLICATE_TRANSFER_METADATA", ids);
      else conflict("TRANSFER_ID_CONTENT_MISMATCH", ids);
    }
  }
  const compareFindings = (a: X402Finding, b: X402Finding) => a.code.localeCompare(b.code) || a.recordIds.join().localeCompare(b.recordIds.join());
  gaps.sort(compareFindings); conflicts.sort(compareFindings); duplicates.sort(compareFindings);
  return {
    ruleVersion: "openarc.x402-reconciliation.m07.v1", evaluatedAt: input.evaluatedAt,
    inputRecordIds: [input.bundleRecordId, ...(input.gateway ? [input.gateway.recordId] : []),
      ...(input.onchain ? [input.onchain.recordId] : []),
      ...input.otherBundles.map((entry) => entry.recordId)].sort(),
    replayScope: { kind: "supplied_local_bundles_only", recordIds: [input.bundleRecordId, ...input.otherBundles.map((entry) => entry.recordId)].sort() },
    metadataAgreement: conflicts.length ? "conflicting" : gaps.length ? "incomplete" : "consistent",
    authorizationVerification: "not_verified", authorizationValidity,
    providerResponse: response ? response.reportedSuccess ? "reported_success" : "reported_failure" : "not_supplied",
    fulfillment: "not_verified", gatewayStatus: gateway?.status ?? "not_observed", onchainSettlement: "not_verified",
    batchInclusion, gaps, conflicts, duplicates, limitations: [...X402_RECONCILIATION_LIMITATIONS],
  };
}

function authorizationKey(bundle: X402ReceiptBundle): string | null {
  const auth = bundle.authorizationMetadata;
  return auth ? [auth.network, auth.asset, auth.verifyingContract, auth.domainName, auth.domainVersion, auth.from, auth.nonce].join(":") : null;
}

function semanticContent(bundle: X402ReceiptBundle): string {
  return JSON.stringify({ resource: bundle.resource, requirement: bundle.requirement,
    authorizationMetadata: bundle.authorizationMetadata, responseMetadata: bundle.responseMetadata });
}

function overlappingContentMatches(left: X402ReceiptBundle, right: X402ReceiptBundle): boolean {
  for (const field of ["resource", "requirement", "authorizationMetadata", "responseMetadata"] as const) {
    if (left[field] && right[field] && JSON.stringify(left[field]) !== JSON.stringify(right[field])) return false;
  }
  return true;
}
