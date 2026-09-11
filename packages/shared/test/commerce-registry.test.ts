import { describe, it, expect } from "vitest";
import { CommerceDataClassSchema } from "../src/commerce/privacy.js";
import { CommerceBoundarySchema } from "../src/commerce/privacy.js";
import {
  CommerceEvidenceClassSchema,
  CommerceStateSchema,
  CommerceStateDimensionsSchema,
} from "../src/commerce/states.js";
import {
  COMMERCE_REGISTRY_VERSION,
  CommerceSchemaDescriptorSchema,
} from "../src/commerce/schema.js";
import { EvidenceClassSchema } from "../src/evidence.js";
import type {
  CommerceDataClass,
  CommerceBoundary,
} from "../src/commerce/privacy.js";
import type {
  CommerceEvidenceClass,
  CommerceState,
  CommerceStateDimensions,
} from "../src/commerce/states.js";
import type { CommerceSchemaDescriptor } from "../src/commerce/schema.js";

const EVIDENCE_CLASSES = [
  "local",
  "signed",
  "agent_reported",
  "provider",
  "facilitator",
  "gateway",
  "onchain",
  "evaluator",
  "openarc_derived",
] as const;

const STATES = [
  "PROPOSED",
  "DENIED",
  "AUTHORIZED",
  "PAYMENT_REQUIRED",
  "PAYMENT_SUBMITTED",
  "PAID",
  "DELIVERY_PENDING",
  "DELIVERED",
  "ACCEPTED",
  "SETTLING",
  "SETTLED",
  "RECONCILED",
  "EXPIRED",
  "FAILED",
  "REFUNDED",
  "DISPUTED",
  "CONFLICTING_EVIDENCE",
] as const;

const DATA_CLASSES = [
  "public",
  "organization_protected",
  "local_private",
  "secret_ephemeral",
] as const;

const LEGAL_BOUNDARIES = [
  {
    dataClass: "public",
    audience: "public",
    serverPersistence: "allowed",
  },
  {
    dataClass: "organization_protected",
    audience: "organization",
    serverPersistence: "allowed",
  },
  {
    dataClass: "organization_protected",
    audience: "provider_minimal",
    serverPersistence: "allowed",
  },
  {
    dataClass: "local_private",
    audience: "local",
    serverPersistence: "forbidden",
  },
  {
    dataClass: "secret_ephemeral",
    audience: "ephemeral",
    serverPersistence: "forbidden",
  },
] as const;

function baseDimensions() {
  return {
    authorization: "authorized",
    payment: "paid",
    delivery: "pending",
    evaluation: "pending",
    settlement: "unknown",
    reconciliation: "unreconciled",
  } as const;
}

describe("commerce taxonomy", () => {
  it("exposes exactly the four data classes by content", () => {
    expect(CommerceDataClassSchema.options.length).toBe(4);
    expect(new Set(CommerceDataClassSchema.options)).toEqual(
      new Set(DATA_CLASSES),
    );
  });

  it("exposes exactly the nine evidence classes by content", () => {
    expect(CommerceEvidenceClassSchema.options.length).toBe(9);
    expect(new Set(CommerceEvidenceClassSchema.options)).toEqual(
      new Set(EVIDENCE_CLASSES),
    );
  });

  it("exposes exactly the seventeen commerce states by content", () => {
    expect(CommerceStateSchema.options.length).toBe(17);
    expect(new Set(CommerceStateSchema.options)).toEqual(new Set(STATES));
  });

  it("legacy evidence enum still rejects facilitator and evaluator", () => {
    expect(EvidenceClassSchema.safeParse("facilitator").success).toBe(false);
    expect(EvidenceClassSchema.safeParse("evaluator").success).toBe(false);
  });

  it("new evidence enum accepts facilitator and evaluator", () => {
    expect(CommerceEvidenceClassSchema.safeParse("facilitator").success).toBe(
      true,
    );
    expect(CommerceEvidenceClassSchema.safeParse("evaluator").success).toBe(
      true,
    );
  });

  it("accepts typed taxonomy values", () => {
    const dc: CommerceDataClass = "public";
    const ec: CommerceEvidenceClass = "onchain";
    const st: CommerceState = "CONFLICTING_EVIDENCE";
    expect([dc, ec, st]).toEqual(["public", "onchain", "CONFLICTING_EVIDENCE"]);
  });
});

describe("commerce boundary contract", () => {
  it("accepts all five legal boundary combinations", () => {
    expect(LEGAL_BOUNDARIES.length).toBe(5);
    for (const boundary of LEGAL_BOUNDARIES) {
      const result = CommerceBoundarySchema.safeParse(boundary);
      expect(result.success).toBe(true);
    }
  });

  it("has exactly the five legal audience/persistence pairings", () => {
    const pairings = LEGAL_BOUNDARIES.map(
      (b) => `${b.dataClass}|${b.audience}|${b.serverPersistence}`,
    );
    expect(new Set(pairings)).toEqual(
      new Set([
        "public|public|allowed",
        "organization_protected|organization|allowed",
        "organization_protected|provider_minimal|allowed",
        "local_private|local|forbidden",
        "secret_ephemeral|ephemeral|forbidden",
      ]),
    );
  });

  it("denies every cross-class audience combination", () => {
    const crossClass = [
      { dataClass: "public", audience: "organization", serverPersistence: "allowed" },
      { dataClass: "public", audience: "provider_minimal", serverPersistence: "allowed" },
      { dataClass: "public", audience: "local", serverPersistence: "allowed" },
      { dataClass: "public", audience: "ephemeral", serverPersistence: "allowed" },
      { dataClass: "organization_protected", audience: "public", serverPersistence: "allowed" },
      { dataClass: "organization_protected", audience: "local", serverPersistence: "allowed" },
      { dataClass: "organization_protected", audience: "ephemeral", serverPersistence: "allowed" },
      { dataClass: "local_private", audience: "public", serverPersistence: "forbidden" },
      { dataClass: "local_private", audience: "organization", serverPersistence: "forbidden" },
      { dataClass: "local_private", audience: "provider_minimal", serverPersistence: "forbidden" },
      { dataClass: "local_private", audience: "ephemeral", serverPersistence: "forbidden" },
      { dataClass: "secret_ephemeral", audience: "public", serverPersistence: "forbidden" },
      { dataClass: "secret_ephemeral", audience: "organization", serverPersistence: "forbidden" },
      { dataClass: "secret_ephemeral", audience: "provider_minimal", serverPersistence: "forbidden" },
      { dataClass: "secret_ephemeral", audience: "local", serverPersistence: "forbidden" },
    ];
    for (const boundary of crossClass) {
      expect(CommerceBoundarySchema.safeParse(boundary).success).toBe(false);
    }
  });

  it("denies every cross-class serverPersistence combination", () => {
    const crossPersistence = [
      { dataClass: "public", audience: "public", serverPersistence: "forbidden" },
      { dataClass: "organization_protected", audience: "organization", serverPersistence: "forbidden" },
      { dataClass: "organization_protected", audience: "provider_minimal", serverPersistence: "forbidden" },
      { dataClass: "local_private", audience: "local", serverPersistence: "allowed" },
      { dataClass: "secret_ephemeral", audience: "ephemeral", serverPersistence: "allowed" },
    ];
    for (const boundary of crossPersistence) {
      expect(CommerceBoundarySchema.safeParse(boundary).success).toBe(false);
    }
  });

  it("private and secret can never be public or persistable", () => {
    const denied = [
      { dataClass: "local_private", audience: "public", serverPersistence: "forbidden" },
      { dataClass: "local_private", audience: "local", serverPersistence: "allowed" },
      { dataClass: "secret_ephemeral", audience: "public", serverPersistence: "forbidden" },
      { dataClass: "secret_ephemeral", audience: "ephemeral", serverPersistence: "allowed" },
    ];
    for (const boundary of denied) {
      expect(CommerceBoundarySchema.safeParse(boundary).success).toBe(false);
    }
  });

  it("rejects unknown keys on every legal boundary variant", () => {
    const extras = [
      { privatePrompt: "..." },
      { rawOutput: "..." },
      { signature: "..." },
      { arbitrary: true },
    ];
    for (const boundary of LEGAL_BOUNDARIES) {
      for (const extra of extras) {
        expect(
          CommerceBoundarySchema.safeParse({ ...boundary, ...extra }).success,
        ).toBe(false);
      }
    }
  });
});

describe("commerce registry descriptor", () => {
  const validBoundary = {
    dataClass: "organization_protected",
    audience: "provider_minimal",
    serverPersistence: "allowed",
  } as const;

  function descriptor(contractId: unknown) {
    return {
      schemaVersion: COMMERCE_REGISTRY_VERSION,
      contractId,
      boundary: validBoundary,
    };
  }

  it("accepts valid v1 and v12 contract IDs", () => {
    expect(
      CommerceSchemaDescriptorSchema.safeParse(
        descriptor("openarc.commerce.transfer.v1"),
      ).success,
    ).toBe(true);
    expect(
      CommerceSchemaDescriptorSchema.safeParse(
        descriptor("openarc.commerce.settlement_v12.v12"),
      ).success,
    ).toBe(true);
  });

  it("rejects contract IDs with trailing LF, CR, CRLF and whitespace", () => {
    const trailing = [
      "openarc.commerce.test.v1\n",
      "openarc.commerce.test.v1\r",
      "openarc.commerce.test.v1\r\n",
      "openarc.commerce.test.v1 ",
      "openarc.commerce.test.v1\t",
    ];
    for (const contractId of trailing) {
      expect(
        CommerceSchemaDescriptorSchema.safeParse(descriptor(contractId)).success,
      ).toBe(false);
    }
  });

  it("rejects invalid, empty, oversized, version0, malformed and legacy IDs", () => {
    const bad = [
      "",
      "openarc.commerce.foo",
      "openarc.commerce.foo.v0",
      "openarc.commerce.foo.v01",
      "openarc.commerce..v1",
      "openarc.commerce.Foo.v1",
      "Openarc.commerce.foo.v1",
      "openarc.commerce.foo.v1.extra",
      "openarc.evidence.foo.v1",
      "openarc.commerce.foo.v-1",
      `openarc.commerce.${"a".repeat(90)}.v1`,
      123,
    ];
    for (const contractId of bad) {
      expect(
        CommerceSchemaDescriptorSchema.safeParse(descriptor(contractId)).success,
      ).toBe(false);
    }
  });

  it("rejects a wrong registry version", () => {
    expect(
      CommerceSchemaDescriptorSchema.safeParse({
        schemaVersion: "openarc.commerce.registry.v2",
        contractId: "openarc.commerce.transfer.v1",
        boundary: validBoundary,
      }).success,
    ).toBe(false);
  });

  it("rejects unknown keys at the descriptor level", () => {
    for (const extra of [
      { privatePrompt: "..." },
      { rawOutput: "..." },
      { signature: "..." },
      { payload: {} },
      { arbitrary: 1 },
    ]) {
      expect(
        CommerceSchemaDescriptorSchema.safeParse({
          ...descriptor("openarc.commerce.transfer.v1"),
          ...extra,
        }).success,
      ).toBe(false);
    }
  });

  it("rejects unknown keys nested in every legal descriptor boundary", () => {
    for (const boundary of LEGAL_BOUNDARIES) {
      for (const extra of [
        { privatePrompt: "..." },
        { rawOutput: "..." },
        { signature: "..." },
        { arbitrary: true },
      ]) {
        expect(
          CommerceSchemaDescriptorSchema.safeParse({
            schemaVersion: COMMERCE_REGISTRY_VERSION,
            contractId: "openarc.commerce.transfer.v1",
            boundary: { ...boundary, ...extra },
          }).success,
        ).toBe(false);
      }
    }
  });

  it("validates the nested boundary", () => {
    expect(
      CommerceSchemaDescriptorSchema.safeParse({
        schemaVersion: COMMERCE_REGISTRY_VERSION,
        contractId: "openarc.commerce.transfer.v1",
        boundary: {
          dataClass: "local_private",
          audience: "local",
          serverPersistence: "allowed",
        },
      }).success,
    ).toBe(false);
  });

  it("accepts a typed descriptor value", () => {
    const d: CommerceSchemaDescriptor = {
      schemaVersion: COMMERCE_REGISTRY_VERSION,
      contractId: "openarc.commerce.transfer.v1",
      boundary: validBoundary,
    };
    expect(d.contractId).toBe("openarc.commerce.transfer.v1");
  });
});

describe("commerce state dimensions", () => {
  it("requires every dimension", () => {
    const keys = [
      "authorization",
      "payment",
      "delivery",
      "evaluation",
      "settlement",
      "reconciliation",
    ] as const;
    for (const key of keys) {
      const partial: Record<string, unknown> = { ...baseDimensions() };
      delete partial[key];
      expect(
        CommerceStateDimensionsSchema.safeParse(partial).success,
      ).toBe(false);
    }
  });

  it("rejects invalid values and unknown keys", () => {
    expect(
      CommerceStateDimensionsSchema.safeParse({
        ...baseDimensions(),
        payment: "settled",
      }).success,
    ).toBe(false);
    expect(
      CommerceStateDimensionsSchema.safeParse({
        ...baseDimensions(),
        delivery: "complete",
      }).success,
    ).toBe(false);
    expect(
      CommerceStateDimensionsSchema.safeParse({
        ...baseDimensions(),
        settlement: "accepted",
      }).success,
    ).toBe(false);
    expect(
      CommerceStateDimensionsSchema.safeParse({
        ...baseDimensions(),
        accepted: true,
      }).success,
    ).toBe(false);
  });

  it("rejects privatePrompt, rawOutput and signature extras on dimensions", () => {
    for (const extra of [
      { privatePrompt: "..." },
      { rawOutput: "..." },
      { signature: "..." },
    ]) {
      expect(
        CommerceStateDimensionsSchema.safeParse({
          ...baseDimensions(),
          ...extra,
        }).success,
      ).toBe(false);
    }
  });

  it("does not coerce numbers, nulls or strings", () => {
    const coercionCases = [
      { ...baseDimensions(), authorization: 1 },
      { ...baseDimensions(), payment: null },
      { ...baseDimensions(), delivery: "DELIVERED" },
      { ...baseDimensions(), settlement: 0 },
      { ...baseDimensions(), reconciliation: null },
    ];
    for (const value of coercionCases) {
      expect(CommerceStateDimensionsSchema.safeParse(value).success).toBe(
        false,
      );
    }
  });

  it("preserves paid with delivery pending and settlement unknown", () => {
    const result = CommerceStateDimensionsSchema.safeParse({
      authorization: "authorized",
      payment: "paid",
      delivery: "pending",
      evaluation: "pending",
      settlement: "unknown",
      reconciliation: "unreconciled",
    });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.payment).toBe("paid");
    expect(result.data.delivery).toBe("pending");
    expect(result.data.settlement).toBe("unknown");
  });

  it("preserves delivered with payment unknown", () => {
    const result = CommerceStateDimensionsSchema.safeParse({
      authorization: "authorized",
      payment: "unknown",
      delivery: "delivered",
      evaluation: "pending",
      settlement: "pending",
      reconciliation: "unreconciled",
    });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.delivery).toBe("delivered");
    expect(result.data.payment).toBe("unknown");
  });

  it("keeps conflicting evidence explicit", () => {
    const result = CommerceStateDimensionsSchema.safeParse({
      authorization: "authorized",
      payment: "refunded",
      delivery: "delivered",
      evaluation: "disputed",
      settlement: "settled",
      reconciliation: "conflicting",
    });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.reconciliation).toBe("conflicting");
    expect(result.data.evaluation).toBe("disputed");
  });

  it("invents no implied accepted or settled field", () => {
    const result = CommerceStateDimensionsSchema.safeParse(baseDimensions());
    expect(result.success).toBe(true);
    if (!result.success) return;
    const keys = Object.keys(result.data);
    expect(keys).not.toContain("accepted");
    expect(keys).not.toContain("settled");
    expect(new Set(keys)).toEqual(
      new Set([
        "authorization",
        "payment",
        "delivery",
        "evaluation",
        "settlement",
        "reconciliation",
      ]),
    );
  });

  it("accepts typed dimensions values", () => {
    const b: CommerceBoundary = LEGAL_BOUNDARIES[0];
    const d: CommerceStateDimensions = baseDimensions();
    expect(b.dataClass).toBe("public");
    expect(d.payment).toBe("paid");
  });
});
