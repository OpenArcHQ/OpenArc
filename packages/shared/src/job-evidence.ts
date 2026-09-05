import { z } from "zod";

import { ApiMetaSchema } from "./api.js";
import { ArcAnchorSchema } from "./arc-observation.js";
import { ARC_ERC8183, ARC_TESTNET } from "./network.js";
import { CanonicalDecimalSchema, EvmAddressSchema, IsoTimestampSchema, TransactionHashSchema,
  Uint256DecimalSchema } from "./primitives.js";

export const JOB_EVIDENCE_PATH = "/v1/private/arc/job-evidence" as const;
export const JOB_STATUSES = ["Open", "Funded", "Submitted", "Completed", "Rejected", "Expired"] as const;
export const JOB_LIMITATIONS = [
  "This observation covers one reviewed Arc Testnet reference contract, not all ERC-8183 jobs.",
  "A contract status does not prove service quality, intent, authorization, payment amounts, or refund amounts.",
  "Passing the deadline does not automatically change the recorded contract status to Expired.",
  "The description is untrusted contract text; external content and hooks were not fetched or executed.",
  "A deliverable digest requires an explicitly supplied submission receipt; it does not verify the deliverable's content or quality.",
] as const;

export const JobEvidenceRequestSchema = z.strictObject({
  network: z.literal(ARC_TESTNET.caip2),
  jobId: Uint256DecimalSchema.refine((value) => value !== "0", "Job IDs start at 1"),
  submissionTransactionHash: TransactionHashSchema.optional(),
});

export const JobEvidenceSchema = z.strictObject({
  schemaVersion: z.literal("openarc.job-evidence.v1"),
  network: z.literal(ARC_TESTNET.caip2),
  jobId: Uint256DecimalSchema.refine((value) => value !== "0"),
  anchor: ArcAnchorSchema.extend({ blockNumber: Uint256DecimalSchema }),
  client: EvmAddressSchema,
  provider: EvmAddressSchema,
  evaluator: EvmAddressSchema,
  hook: EvmAddressSchema,
  description: z.string().max(4096),
  budget: z.strictObject({
    asset: z.literal("USDC"),
    contract: z.literal(ARC_TESTNET.contracts.usdc.toLowerCase()),
    baseUnits: Uint256DecimalSchema,
    decimals: z.literal(6),
    decimal: CanonicalDecimalSchema,
    explicitlySet: z.boolean(),
  }),
  expiry: z.strictObject({
    unixSeconds: Uint256DecimalSchema.refine((value) => /^[1-9][0-9]{0,11}$/u.test(value) && BigInt(value) <= 253_402_300_799n),
    timestamp: IsoTimestampSchema,
    deadlineReachedAtAnchor: z.boolean(),
  }),
  status: z.enum(JOB_STATUSES),
  deliverable: z.discriminatedUnion("availability", [
    z.strictObject({ availability: z.literal("not_observed"), reason: z.literal("not_returned_by_getJob") }),
    z.strictObject({ availability: z.literal("submission_event"), digest: TransactionHashSchema,
      transactionHash: TransactionHashSchema, blockNumber: Uint256DecimalSchema,
      blockHash: TransactionHashSchema, logIndex: Uint256DecimalSchema }),
  ]),
  source: z.strictObject({
    sourceId: z.literal("arc_primary_rpc"), jobSourceId: z.literal("erc8183_reference"),
    origin: z.literal(ARC_TESTNET.rpcHttp), explorerOrigin: z.literal(ARC_TESTNET.explorerOrigin),
    network: z.literal(ARC_TESTNET.caip2), contract: z.literal(ARC_TESTNET.contracts.erc8183AgenticCommerce.toLowerCase()),
    implementation: z.literal(ARC_ERC8183.implementation), sourceRevision: z.literal(ARC_ERC8183.sourceRevision),
    reviewedAt: z.literal(ARC_ERC8183.reviewedAt), sourceSha256: z.literal(ARC_ERC8183.sourceSha256),
    observedAt: IsoTimestampSchema, adapterVersion: z.literal("openarc.job-evidence.m06.v1"),
  }),
  limitations: z.tuple(JOB_LIMITATIONS.map((text) => z.literal(text)) as [
    z.ZodLiteral<typeof JOB_LIMITATIONS[0]>, z.ZodLiteral<typeof JOB_LIMITATIONS[1]>,
    z.ZodLiteral<typeof JOB_LIMITATIONS[2]>, z.ZodLiteral<typeof JOB_LIMITATIONS[3]>,
    z.ZodLiteral<typeof JOB_LIMITATIONS[4]>,
  ]),
}).superRefine((job, context) => {
  // Zod can continue refinements after a dirty child check; never coerce invalid strings.
  if (![job.budget.baseUnits, job.expiry.unixSeconds, job.anchor.blockNumber,
    ...(job.deliverable.availability === "submission_event" ? [job.deliverable.blockNumber] : [])]
    .every((value) => Uint256DecimalSchema.safeParse(value).success)) return;
  const issue = (path: string[], message: string) => context.addIssue({ code: "custom", path, message });
  const units = BigInt(job.budget.baseUnits);
  const digits = units.toString().padStart(7, "0");
  const fraction = digits.slice(-6).replace(/0+$/u, "");
  const decimal = `${digits.slice(0, -6)}${fraction ? `.${fraction}` : ""}`;
  if (decimal !== job.budget.decimal) issue(["budget", "decimal"], "Budget must match exact USDC base units");
  if (!job.budget.explicitlySet && units !== 0n) issue(["budget"], "Nonzero budget requires a recorded budget assignment");
  const expiry = Number(job.expiry.unixSeconds) * 1000;
  if (Date.parse(job.expiry.timestamp) !== expiry) issue(["expiry"], "Expiry timestamp must match seconds");
  if ((Date.parse(job.anchor.blockTimestamp) >= expiry) !== job.expiry.deadlineReachedAtAnchor) {
    issue(["expiry"], "Deadline comparison must use the observation block");
  }
  const zero = "0x0000000000000000000000000000000000000000";
  if (job.client === zero || job.evaluator === zero) issue(["client"], "Existing jobs require a client and evaluator");
  if (job.provider === zero && job.status !== "Open" && job.status !== "Rejected") {
    issue(["provider"], "This state requires an assigned provider");
  }
  if (job.provider === zero && job.budget.explicitlySet) issue(["budget"], "An unassigned provider cannot have set a budget");
  if (job.status === "Expired" && !job.expiry.deadlineReachedAtAnchor) issue(["status"], "Expired state precedes deadline");
  if (job.deliverable.availability === "submission_event") {
    if (job.provider === zero) issue(["deliverable"], "Submission requires an assigned provider");
    if (job.status === "Open" || job.status === "Funded") issue(["deliverable"], "Submission conflicts with current state");
    if (BigInt(job.deliverable.blockNumber) > BigInt(job.anchor.blockNumber)) issue(["deliverable"], "Submission is after observation");
    if (job.deliverable.blockNumber === job.anchor.blockNumber && job.deliverable.blockHash !== job.anchor.blockHash) {
      issue(["deliverable"], "Submission block conflicts with observation");
    }
  }
});

export const JobEvidenceEnvelopeSchema = z.strictObject({ ok: z.literal(true), data: JobEvidenceSchema, meta: ApiMetaSchema });
export type JobEvidenceRequest = z.infer<typeof JobEvidenceRequestSchema>;
export type JobEvidence = z.infer<typeof JobEvidenceSchema>;
export type JobEvidenceEnvelope = z.infer<typeof JobEvidenceEnvelopeSchema>;
