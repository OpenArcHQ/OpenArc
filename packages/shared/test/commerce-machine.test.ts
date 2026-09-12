import { describe, expect, expectTypeOf, it } from "vitest";

import {
  COMMERCE_API_ERRORS,
  CommerceApiErrorEnvelopeSchema,
  CommerceMachineCredentialIdSchema,
  CommerceMachineCredentialIssueBodySchema,
  CommerceMachineCredentialIssueResponseSchema,
  CommerceMachineCredentialIssueResultSchema,
  CommerceMachineCredentialMetadataSchema,
  CommerceMachineCredentialPageResponseSchema,
  CommerceMachineCredentialPageSchema,
  CommerceMachineCredentialRevokeBodySchema,
  CommerceMachineCredentialRevokeResponseSchema,
  CommerceMachineCredentialRevokeResultSchema,
  CommerceMachineCredentialStatusResponseSchema,
  CommerceMachineCredentialStatusSchema,
  CommerceMachineCredentialTokenSchema,
  CommerceMachineEmptyBodySchema,
  CommerceMachineKindSchema,
  CommerceMachineMutationReceiptSchema,
  CommerceMachineCredentialPublicPrefixSchema,
  CommerceMachineScopesSchema,
  CommerceMachineSessionExchangeResponseSchema,
  CommerceMachineSessionExchangeResultSchema,
  CommerceMachineSessionMetadataSchema,
  CommerceMachineSessionRevokeResponseSchema,
  CommerceMachineSessionRevokeResultSchema,
  CommerceMachineSessionSelfResponseSchema,
  CommerceMachineSessionSelfResultSchema,
  CommerceMachineSessionTokenSchema,
  type CommerceMachineCredentialMetadata,
  type CommerceMachineMutationReceipt,
  type CommerceMachineSessionMetadata,
} from "../src/index.js";

const V4 = "12345678-1234-4234-8123-123456789abc";
const V4_B = "87654321-4321-4321-b123-abcdefabcdef";

const ORG = `openarc:org:${V4}`;
const AGENT = `openarc:agent:${V4}`;
const PROVIDER = `openarc:provider:${V4}`;

const TOKEN_SECRET = `${"A".repeat(42)}A`;

const AGENT_PREFIX = `oac_ag_${V4}`;
const PROVIDER_PREFIX = `oac_pr_${V4}`;
const AGENT_CREDENTIAL = `oac_ag_${V4}_${TOKEN_SECRET}`;
const PROVIDER_CREDENTIAL = `oac_pr_${V4}_${TOKEN_SECRET}`;
const AGENT_SESSION = `oas_ag_${TOKEN_SECRET}`;
const PROVIDER_SESSION = `oas_pr_${TOKEN_SECRET}`;

const ISO = "2024-01-01T00:00:00.000Z";
const ISO_EXPIRES = "2024-01-02T00:00:00.000Z";
const ISO_SESSION_EXPIRES = "2024-01-01T00:10:00.000Z";
const ISO_REVOKED = "2024-01-01T06:00:00.000Z";

const CANARY = "PRIVATE_CANARY_DO_NOT_ECHO";
const SAMPLE_UUID = "9f1c2d34-5e6a-4b7c-8d9e-0f1a2b3c4d5e";
const SAMPLE_SHA = "0123456789abcdef0123456789abcdef01234567";

const META = {
  schemaVersion: "openarc.api.v2" as const,
  requestId: SAMPLE_UUID,
  buildSha: SAMPLE_SHA,
};

function agentMetadata(overrides: Record<string, unknown> = {}) {
  return {
    credentialId: V4,
    kind: "agent" as const,
    profileId: AGENT,
    publicPrefix: AGENT_PREFIX,
    environment: "eip155:5042002" as const,
    scopes: ["agent:self.read"] as const,
    scopeVersion: 1 as const,
    createdAt: ISO,
    expiresAt: ISO_EXPIRES,
    revokedAt: null,
    status: "active" as const,
    ...overrides,
  };
}

function providerMetadata(overrides: Record<string, unknown> = {}) {
  return {
    credentialId: V4,
    kind: "provider" as const,
    profileId: PROVIDER,
    publicPrefix: PROVIDER_PREFIX,
    environment: "eip155:5042002" as const,
    scopes: ["provider:self.read"] as const,
    scopeVersion: 1 as const,
    createdAt: ISO,
    expiresAt: ISO_EXPIRES,
    revokedAt: null,
    status: "active" as const,
    ...overrides,
  };
}

function agentSession(overrides: Record<string, unknown> = {}) {
  return {
    sessionId: V4,
    credentialId: V4_B,
    organizationId: ORG,
    kind: "agent" as const,
    profileId: AGENT,
    environment: "eip155:5042002" as const,
    scopes: ["agent:self.read"] as const,
    scopeVersion: 1 as const,
    createdAt: ISO,
    expiresAt: ISO_SESSION_EXPIRES,
    ...overrides,
  };
}

function providerSession(overrides: Record<string, unknown> = {}) {
  return {
    sessionId: V4,
    credentialId: V4_B,
    organizationId: ORG,
    kind: "provider" as const,
    profileId: PROVIDER,
    environment: "eip155:5042002" as const,
    scopes: ["provider:self.read"] as const,
    scopeVersion: 1 as const,
    createdAt: ISO,
    expiresAt: ISO_SESSION_EXPIRES,
    ...overrides,
  };
}

function agentIssueReceipt(overrides: Record<string, unknown> = {}) {
  return {
    mutationId: V4,
    operation: "tenant.agent.credential.issue" as const,
    resourceType: "agent_credential" as const,
    credentialId: V4,
    committedAt: ISO,
    ...overrides,
  };
}

function providerIssueReceipt(overrides: Record<string, unknown> = {}) {
  return {
    mutationId: V4,
    operation: "tenant.provider.credential.issue" as const,
    resourceType: "provider_credential" as const,
    credentialId: V4,
    committedAt: ISO,
    ...overrides,
  };
}

function agentRevokeReceipt(overrides: Record<string, unknown> = {}) {
  return {
    mutationId: V4,
    operation: "tenant.agent.credential.revoke" as const,
    resourceType: "agent_credential" as const,
    credentialId: V4_B,
    committedAt: ISO,
    ...overrides,
  };
}

function providerRevokeReceipt(overrides: Record<string, unknown> = {}) {
  return {
    mutationId: V4,
    operation: "tenant.provider.credential.revoke" as const,
    resourceType: "provider_credential" as const,
    credentialId: V4_B,
    committedAt: ISO,
    ...overrides,
  };
}

describe("machine kind, ids and public prefix", () => {
  it("accepts only the agent/provider kind and canonical UUIDv4 ids", () => {
    expect(CommerceMachineKindSchema.safeParse("agent").success).toBe(true);
    expect(CommerceMachineKindSchema.safeParse("provider").success).toBe(true);
    for (const value of [V4, V4_B]) {
      expect(CommerceMachineCredentialIdSchema.safeParse(value).success).toBe(
        true,
      );
    }
  });

  it("rejects noncanonical, uppercase, padded and trailing-newline ids", () => {
    const bad = [
      V4.toUpperCase(),
      `${V4}\n`,
      `${V4} `,
      ` ${V4}`,
      V4.replace("4234", "3234"),
      V4.replace("8123", "c123"),
      "12345678123442348123123456789abc",
      V4.slice(0, -1),
      `${V4}0`,
      42,
      null,
      undefined,
      {},
    ];
    for (const value of bad) {
      expect(CommerceMachineCredentialIdSchema.safeParse(value).success).toBe(
        false,
      );
    }
  });

  it("accepts exact kind prefixes and rejects mismatch, secrets and trailing text", () => {
    expect(CommerceMachineCredentialPublicPrefixSchema.safeParse(AGENT_PREFIX).success).toBe(
      true,
    );
    expect(CommerceMachineCredentialPublicPrefixSchema.safeParse(PROVIDER_PREFIX).success).toBe(
      true,
    );
    const bad = [
      `oac_ag_${V4_B.toUpperCase()}`,
      `oac_xx_${V4}`,
      `${AGENT_PREFIX}_${TOKEN_SECRET}`,
      `${AGENT_PREFIX}\n`,
      `oac_ag_${V4.slice(0, -1)}`,
      "oac_ag_",
      "",
      null,
    ];
    for (const value of bad) {
      expect(
        CommerceMachineCredentialPublicPrefixSchema.safeParse(value).success,
      ).toBe(false);
    }
  });

  it("accepts canonical raw credential and session token forms", () => {
    expect(
      CommerceMachineCredentialTokenSchema.safeParse(AGENT_CREDENTIAL).success,
    ).toBe(true);
    expect(
      CommerceMachineCredentialTokenSchema.safeParse(PROVIDER_CREDENTIAL).success,
    ).toBe(true);
    expect(
      CommerceMachineSessionTokenSchema.safeParse(AGENT_SESSION).success,
    ).toBe(true);
    expect(
      CommerceMachineSessionTokenSchema.safeParse(PROVIDER_SESSION).success,
    ).toBe(true);
  });

  it("rejects short/long secrets, padded bits, whitespace and wrong prefixes", () => {
    const badCredentials = [
      `oac_ag_${V4}_${"A".repeat(42)}`,
      `oac_ag_${V4}_${"A".repeat(44)}`,
      `oac_ag_${V4}_${"A".repeat(42)}B`,
      `oac_ag_${V4}_${"A".repeat(42)}=`,
      `oac_ag_${V4}_${"A".repeat(42)}A\n`,
      `oac_ag_${V4.toUpperCase()}_${TOKEN_SECRET}`,
      `oac_ag_${V4}`,
      `oas_ag_${TOKEN_SECRET}`,
      `oac_zz_${V4}_${TOKEN_SECRET}`,
      null,
    ];
    for (const value of badCredentials) {
      expect(
        CommerceMachineCredentialTokenSchema.safeParse(value).success,
      ).toBe(false);
    }
    const badSessions = [
      `oas_ag_${"A".repeat(42)}`,
      `oas_ag_${"A".repeat(42)}B`,
      `oas_ag_${"A".repeat(42)}=`,
      `oas_ag_${"A".repeat(42)}A `,
      `oac_ag_${V4}_${TOKEN_SECRET}`,
      `oas_zz_${TOKEN_SECRET}`,
      null,
    ];
    for (const value of badSessions) {
      expect(CommerceMachineSessionTokenSchema.safeParse(value).success).toBe(
        false,
      );
    }
  });
});

describe("machine scopes", () => {
  it("accepts exactly one matching self-read scope tuple", () => {
    expect(CommerceMachineScopesSchema.safeParse(["agent:self.read"]).success).toBe(
      true,
    );
    expect(
      CommerceMachineScopesSchema.safeParse(["provider:self.read"]).success,
    ).toBe(true);
  });

  it("rejects empty, duplicate, widened, unknown and non-tuple scopes", () => {
    const bad: readonly unknown[] = [
      [],
      ["agent:self.read", "agent:self.read"],
      ["agent:self.read", "provider:self.read"],
      ["agent:self.write"],
      ["provider:self.write"],
      ["agent:self.read", "extra"],
      "agent:self.read",
      null,
    ];
    for (const value of bad) {
      expect(CommerceMachineScopesSchema.safeParse(value).success).toBe(false);
    }
  });
});

describe("machine credential metadata", () => {
  it("accepts both kind-discriminated variants", () => {
    expect(
      CommerceMachineCredentialMetadataSchema.safeParse(agentMetadata()).success,
    ).toBe(true);
    expect(
      CommerceMachineCredentialMetadataSchema.safeParse(providerMetadata())
        .success,
    ).toBe(true);
  });

  it("rejects cross-kind profile, prefix and scope mismatches", () => {
    const bad = [
      agentMetadata({ profileId: PROVIDER }),
      agentMetadata({ publicPrefix: PROVIDER_PREFIX }),
      agentMetadata({ scopes: ["provider:self.read"] }),
      providerMetadata({ profileId: AGENT }),
      providerMetadata({ publicPrefix: AGENT_PREFIX }),
      providerMetadata({ scopes: ["agent:self.read"] }),
    ];
    for (const value of bad) {
      expect(
        CommerceMachineCredentialMetadataSchema.safeParse(value).success,
      ).toBe(false);
    }
  });

  it("enforces expiry ordering and the 90-day maximum", () => {
    const bad = [
      agentMetadata({ expiresAt: ISO }),
      agentMetadata({ expiresAt: "2023-12-31T00:00:00.000Z" }),
      agentMetadata({ expiresAt: "2024-04-02T00:00:00.000Z" }),
    ];
    for (const value of bad) {
      expect(
        CommerceMachineCredentialMetadataSchema.safeParse(value).success,
      ).toBe(false);
    }
    expect(
      CommerceMachineCredentialMetadataSchema.safeParse(
        agentMetadata({ expiresAt: "2024-03-30T00:00:00.000Z" }),
      ).success,
    ).toBe(true);
  });

  it("ties revokedAt to the revoked status and ordering", () => {
    expect(
      CommerceMachineCredentialMetadataSchema.safeParse(
        agentMetadata({ status: "revoked", revokedAt: ISO_REVOKED }),
      ).success,
    ).toBe(true);
    const bad = [
      agentMetadata({ status: "revoked", revokedAt: null }),
      agentMetadata({ status: "active", revokedAt: ISO_REVOKED }),
      agentMetadata({ status: "expired", revokedAt: ISO_REVOKED }),
      agentMetadata({
        status: "revoked",
        revokedAt: "2023-12-31T00:00:00.000Z",
      }),
    ];
    for (const value of bad) {
      expect(
        CommerceMachineCredentialMetadataSchema.safeParse(value).success,
      ).toBe(false);
    }
  });

  it("rejects bad environment, scopeVersion, kind and private canaries", () => {
    const bad = [
      agentMetadata({ environment: "eip155:1" }),
      agentMetadata({ scopeVersion: 2 }),
      agentMetadata({ kind: "service" }),
      agentMetadata({ status: "suspended" }),
      agentMetadata({ publicPrefix: `${AGENT_PREFIX}_${TOKEN_SECRET}` }),
    ];
    for (const value of bad) {
      expect(
        CommerceMachineCredentialMetadataSchema.safeParse(value).success,
      ).toBe(false);
    }
    for (const key of [
      "issuer",
      "hash",
      "pepper",
      "lookupId",
      "displayName",
      "session",
      "originalRequest",
      "credential",
      "token",
      "actor",
    ]) {
      expect(
        CommerceMachineCredentialMetadataSchema.safeParse(
          agentMetadata({ [key]: CANARY }),
        ).success,
      ).toBe(false);
    }
  });
});

describe("machine credential page", () => {
  it("accepts a correlated page and null cursor", () => {
    const page = {
      organizationId: ORG,
      kind: "agent" as const,
      profileId: AGENT,
      items: [agentMetadata()],
      nextCursor: null,
    };
    expect(CommerceMachineCredentialPageSchema.safeParse(page).success).toBe(
      true,
    );
    const cursorPage = { ...page, nextCursor: V4_B };
    expect(
      CommerceMachineCredentialPageSchema.safeParse(cursorPage).success,
    ).toBe(true);
  });

  it("rejects outer/item kind and profile mismatches", () => {
    const bad = [
      {
        organizationId: ORG,
        kind: "agent" as const,
        profileId: AGENT,
        items: [providerMetadata()],
        nextCursor: null,
      },
      {
        organizationId: ORG,
        kind: "agent" as const,
        profileId: PROVIDER,
        items: [agentMetadata()],
        nextCursor: null,
      },
      {
        organizationId: ORG,
        kind: "provider" as const,
        profileId: AGENT,
        items: [providerMetadata()],
        nextCursor: null,
      },
    ];
    for (const value of bad) {
      expect(CommerceMachineCredentialPageSchema.safeParse(value).success).toBe(
        false,
      );
    }
  });

  it("rejects duplicate credentialIds and more than 50 items", () => {
    const duplicate = {
      organizationId: ORG,
      kind: "agent" as const,
      profileId: AGENT,
      items: [agentMetadata(), agentMetadata()],
      nextCursor: null,
    };
    expect(
      CommerceMachineCredentialPageSchema.safeParse(duplicate).success,
    ).toBe(false);

    const overfull = {
      organizationId: ORG,
      kind: "agent" as const,
      profileId: AGENT,
      items: Array.from({ length: 51 }, () => agentMetadata()),
      nextCursor: null,
    };
    expect(
      CommerceMachineCredentialPageSchema.safeParse(overfull).success,
    ).toBe(false);
  });

  it("rejects unknown and private page fields", () => {
    const page = {
      organizationId: ORG,
      kind: "agent" as const,
      profileId: AGENT,
      items: [agentMetadata()],
      nextCursor: null,
    };
    for (const key of ["total", "limit", "credential", "hash", "session"]) {
      expect(
        CommerceMachineCredentialPageSchema.safeParse({
          ...page,
          [key]: CANARY,
        }).success,
      ).toBe(false);
    }
  });
});

describe("machine request bodies", () => {
  it("accepts exact issue/revoke/empty bodies", () => {
    expect(
      CommerceMachineCredentialIssueBodySchema.safeParse({
        mutationId: V4,
        expiresAt: ISO_EXPIRES,
      }).success,
    ).toBe(true);
    expect(
      CommerceMachineCredentialRevokeBodySchema.safeParse({ mutationId: V4 })
        .success,
    ).toBe(true);
    expect(CommerceMachineEmptyBodySchema.safeParse({}).success).toBe(true);
  });

  it("rejects scope, org/profile/route ids, actor, key/hash in issue body", () => {
    const base = { mutationId: V4, expiresAt: ISO_EXPIRES };
    const forbidden = [
      "scope",
      "scopes",
      "organizationId",
      "profileId",
      "credentialId",
      "actor",
      "idempotencyKey",
      "hash",
      "role",
      "session",
      "kind",
    ];
    for (const key of forbidden) {
      expect(
        CommerceMachineCredentialIssueBodySchema.safeParse({
          ...base,
          [key]: CANARY,
        }).success,
      ).toBe(false);
    }
    expect(
      CommerceMachineCredentialIssueBodySchema.safeParse({
        mutationId: V4,
      }).success,
    ).toBe(false);
    expect(
      CommerceMachineCredentialIssueBodySchema.safeParse({
        mutationId: V4,
        expiresAt: ISO_EXPIRES,
        expiresAtExtra: ISO_EXPIRES,
      }).success,
    ).toBe(false);
  });

  it("rejects extra keys on revoke and non-empty exchange/revoke bodies", () => {
    for (const key of ["expiresAt", "credentialId", "actor", "hash"]) {
      expect(
        CommerceMachineCredentialRevokeBodySchema.safeParse({
          mutationId: V4,
          [key]: CANARY,
        }).success,
      ).toBe(false);
    }
    for (const key of ["token", "credential", "mutationId"]) {
      expect(
        CommerceMachineEmptyBodySchema.safeParse({ [key]: CANARY }).success,
      ).toBe(false);
    }
    expect(
      CommerceMachineCredentialIssueBodySchema.safeParse({
        mutationId: V4.toUpperCase(),
        expiresAt: ISO_EXPIRES,
      }).success,
    ).toBe(false);
  });
});

describe("machine mutation receipt", () => {
  it("accepts exactly the four machine operations", () => {
    const receipts = [
      agentIssueReceipt(),
      providerIssueReceipt(),
      agentRevokeReceipt(),
      providerRevokeReceipt(),
    ];
    for (const receipt of receipts) {
      expect(
        CommerceMachineMutationReceiptSchema.safeParse(receipt).success,
      ).toBe(true);
    }
  });

  it("requires issue credentialId to equal mutationId but not for revoke", () => {
    expect(
      CommerceMachineMutationReceiptSchema.safeParse(
        agentIssueReceipt({ credentialId: V4_B }),
      ).success,
    ).toBe(false);
    expect(
      CommerceMachineMutationReceiptSchema.safeParse(
        providerIssueReceipt({ credentialId: V4_B }),
      ).success,
    ).toBe(false);
    expect(
      CommerceMachineMutationReceiptSchema.safeParse(
        agentRevokeReceipt({ credentialId: V4_B }),
      ).success,
    ).toBe(true);
  });

  it("rejects wrong operation/resourceType pairings and unknown ops", () => {
    const bad = [
      { ...agentIssueReceipt(), resourceType: "provider_credential" },
      { ...providerIssueReceipt(), resourceType: "agent_credential" },
      { ...agentRevokeReceipt(), resourceType: "provider_credential" },
      { ...agentIssueReceipt(), operation: "tenant.agent.create" },
      { ...agentIssueReceipt(), credentialId: AGENT },
    ];
    for (const receipt of bad) {
      expect(
        CommerceMachineMutationReceiptSchema.safeParse(receipt).success,
      ).toBe(false);
    }
  });

  it("rejects raw/prefix/actor/resourceId aliases and canaries", () => {
    const base = agentIssueReceipt();
    for (const key of [
      "raw",
      "rawCredential",
      "token",
      "publicPrefix",
      "actor",
      "resourceId",
      "organizationId",
      "replayed",
      "payload",
    ]) {
      expect(
        CommerceMachineMutationReceiptSchema.safeParse({
          ...base,
          [key]: CANARY,
        }).success,
      ).toBe(false);
    }
  });
});

describe("machine credential issue result", () => {
  it("accepts fresh one-time delivery for both kinds", () => {
    const agent = {
      organizationId: ORG,
      replayed: false as const,
      receipt: agentIssueReceipt(),
      delivery: {
        status: "available_once" as const,
        credential: AGENT_CREDENTIAL,
        publicPrefix: AGENT_PREFIX,
      },
    };
    expect(
      CommerceMachineCredentialIssueResultSchema.safeParse(agent).success,
    ).toBe(true);
    const provider = {
      organizationId: ORG,
      replayed: false as const,
      receipt: providerIssueReceipt(),
      delivery: {
        status: "available_once" as const,
        credential: PROVIDER_CREDENTIAL,
        publicPrefix: PROVIDER_PREFIX,
      },
    };
    expect(
      CommerceMachineCredentialIssueResultSchema.safeParse(provider).success,
    ).toBe(true);
  });

  it("accepts a replay with no reusable secret", () => {
    const replay = {
      organizationId: ORG,
      replayed: true as const,
      receipt: agentIssueReceipt(),
      delivery: { status: "token_not_replayable" as const },
    };
    expect(
      CommerceMachineCredentialIssueResultSchema.safeParse(replay).success,
    ).toBe(true);
  });

  it("denies raw values on replay and rejects delivery kind/prefix mismatches", () => {
    const replay = {
      organizationId: ORG,
      replayed: true as const,
      receipt: agentIssueReceipt(),
      delivery: { status: "token_not_replayable" as const, credential: AGENT_CREDENTIAL },
    };
    expect(
      CommerceMachineCredentialIssueResultSchema.safeParse(replay).success,
    ).toBe(false);

    const mismatched = [
      {
        organizationId: ORG,
        replayed: false as const,
        receipt: agentIssueReceipt(),
        delivery: {
          status: "available_once" as const,
          credential: PROVIDER_CREDENTIAL,
          publicPrefix: AGENT_PREFIX,
        },
      },
      {
        organizationId: ORG,
        replayed: false as const,
        receipt: agentIssueReceipt(),
        delivery: {
          status: "available_once" as const,
          credential: AGENT_CREDENTIAL,
          publicPrefix: PROVIDER_PREFIX,
        },
      },
      {
        organizationId: ORG,
        replayed: false as const,
        receipt: agentIssueReceipt(),
        delivery: {
          status: "available_once" as const,
          credential: `oac_ag_${V4_B}_${TOKEN_SECRET}`,
          publicPrefix: AGENT_PREFIX,
        },
      },
    ];
    for (const value of mismatched) {
      expect(
        CommerceMachineCredentialIssueResultSchema.safeParse(value).success,
      ).toBe(false);
    }
  });

  it("rejects revoke receipts on the issue result and extra fields", () => {
    expect(
      CommerceMachineCredentialIssueResultSchema.safeParse({
        organizationId: ORG,
        replayed: false as const,
        receipt: agentRevokeReceipt(),
        delivery: { status: "token_not_replayable" as const },
      }).success,
    ).toBe(false);
    for (const key of ["credential", "token", "publicPrefix", "hash"]) {
      expect(
        CommerceMachineCredentialIssueResultSchema.safeParse({
          organizationId: ORG,
          replayed: true as const,
          receipt: agentIssueReceipt(),
          delivery: { status: "token_not_replayable" as const },
          [key]: CANARY,
        }).success,
      ).toBe(false);
    }
  });
});

describe("machine credential revoke result and status", () => {
  it("accepts revoke results for both replay flags and no delivery", () => {
    for (const replayed of [false, true]) {
      expect(
        CommerceMachineCredentialRevokeResultSchema.safeParse({
          organizationId: ORG,
          replayed,
          receipt: agentRevokeReceipt(),
        }).success,
      ).toBe(true);
    }
    expect(
      CommerceMachineCredentialRevokeResultSchema.safeParse({
        organizationId: ORG,
        replayed: false,
        receipt: providerRevokeReceipt(),
      }).success,
    ).toBe(true);
  });

  it("rejects issue receipts, raw fields and non-boolean replay on revoke", () => {
    const base = {
      organizationId: ORG,
      replayed: false,
      receipt: agentRevokeReceipt(),
    };
    expect(
      CommerceMachineCredentialRevokeResultSchema.safeParse({
        ...base,
        receipt: agentIssueReceipt(),
      }).success,
    ).toBe(false);
    for (const key of ["delivery", "credential", "token", "publicPrefix"]) {
      expect(
        CommerceMachineCredentialRevokeResultSchema.safeParse({
          ...base,
          [key]: CANARY,
        }).success,
      ).toBe(false);
    }
    expect(
      CommerceMachineCredentialRevokeResultSchema.safeParse({
        ...base,
        replayed: "false",
      }).success,
    ).toBe(false);
  });

  it("accepts committed and not_found status without raw secrets", () => {
    expect(
      CommerceMachineCredentialStatusSchema.safeParse({
        organizationId: ORG,
        status: "committed",
        receipt: agentIssueReceipt(),
      }).success,
    ).toBe(true);
    expect(
      CommerceMachineCredentialStatusSchema.safeParse({
        organizationId: ORG,
        status: "not_found",
      }).success,
    ).toBe(true);
  });

  it("rejects raw/delivery on status and pending/unknown discriminators", () => {
    const committed = {
      organizationId: ORG,
      status: "committed",
      receipt: providerRevokeReceipt(),
    };
    for (const key of ["delivery", "credential", "token", "publicPrefix"]) {
      expect(
        CommerceMachineCredentialStatusSchema.safeParse({
          ...committed,
          [key]: CANARY,
        }).success,
      ).toBe(false);
    }
    for (const status of ["pending", "failed", "unknown", ""]) {
      expect(
        CommerceMachineCredentialStatusSchema.safeParse({
          organizationId: ORG,
          status,
          receipt: agentIssueReceipt(),
        }).success,
      ).toBe(false);
    }
    expect(
      CommerceMachineCredentialStatusSchema.safeParse({
        organizationId: ORG,
        status: "not_found",
        receipt: agentIssueReceipt(),
      }).success,
    ).toBe(false);
  });
});

describe("machine session metadata and results", () => {
  it("accepts both kind-discriminated session metadata variants", () => {
    expect(
      CommerceMachineSessionMetadataSchema.safeParse(agentSession()).success,
    ).toBe(true);
    expect(
      CommerceMachineSessionMetadataSchema.safeParse(providerSession()).success,
    ).toBe(true);
  });

  it("enforces expiry ordering and the 15-minute hard maximum", () => {
    const bad = [
      agentSession({ expiresAt: ISO }),
      agentSession({ expiresAt: "2023-12-31T00:00:00.000Z" }),
      agentSession({ expiresAt: "2024-01-01T00:16:00.000Z" }),
      agentSession({ expiresAt: "2024-01-02T00:00:00.000Z" }),
    ];
    for (const value of bad) {
      expect(
        CommerceMachineSessionMetadataSchema.safeParse(value).success,
      ).toBe(false);
    }
  });

  it("rejects cross-kind profile/scope and private canaries", () => {
    const bad = [
      agentSession({ profileId: PROVIDER }),
      agentSession({ scopes: ["provider:self.read"] }),
      providerSession({ profileId: AGENT }),
      providerSession({ scopes: ["agent:self.read"] }),
      agentSession({ environment: "eip155:1" }),
      agentSession({ scopeVersion: 2 }),
    ];
    for (const value of bad) {
      expect(
        CommerceMachineSessionMetadataSchema.safeParse(value).success,
      ).toBe(false);
    }
    for (const key of [
      "issuer",
      "revocationVersion",
      "hash",
      "token",
      "credential",
      "publicPrefix",
      "actor",
    ]) {
      expect(
        CommerceMachineSessionMetadataSchema.safeParse(
          agentSession({ [key]: CANARY }),
        ).success,
      ).toBe(false);
    }
  });

  it("accepts exchange delivery correlated to the session kind", () => {
    expect(
      CommerceMachineSessionExchangeResultSchema.safeParse({
        session: agentSession(),
        delivery: { status: "available_once", token: AGENT_SESSION },
      }).success,
    ).toBe(true);
    expect(
      CommerceMachineSessionExchangeResultSchema.safeParse({
        session: providerSession(),
        delivery: { status: "available_once", token: PROVIDER_SESSION },
      }).success,
    ).toBe(true);
  });

  it("rejects token/session kind mismatch, missing session and extra fields", () => {
    const mismatched = [
      {
        session: agentSession(),
        delivery: { status: "available_once", token: PROVIDER_SESSION },
      },
      {
        session: providerSession(),
        delivery: { status: "available_once", token: AGENT_SESSION },
      },
      {
        session: agentSession(),
        delivery: { status: "available_once", token: AGENT_CREDENTIAL },
      },
    ];
    for (const value of mismatched) {
      expect(
        CommerceMachineSessionExchangeResultSchema.safeParse(value).success,
      ).toBe(false);
    }
    expect(
      CommerceMachineSessionExchangeResultSchema.safeParse({
        delivery: { status: "available_once", token: AGENT_SESSION },
      }).success,
    ).toBe(false);
    expect(
      CommerceMachineSessionExchangeResultSchema.safeParse({
        session: agentSession(),
        delivery: { status: "available_once", token: AGENT_SESSION },
        credential: CANARY,
      }).success,
    ).toBe(false);
  });

  it("accepts self and current-revoke results without raw tokens", () => {
    expect(
      CommerceMachineSessionSelfResultSchema.safeParse({
        session: agentSession(),
      }).success,
    ).toBe(true);
    expect(
      CommerceMachineSessionRevokeResultSchema.safeParse({
        kind: "provider",
        sessionId: V4,
        organizationId: ORG,
        revokedAt: ISO_REVOKED,
      }).success,
    ).toBe(true);
  });

  it("rejects raw delivery on self/revoke and malformed revoke fields", () => {
    for (const key of ["delivery", "token", "session", "credential"]) {
      expect(
        CommerceMachineSessionSelfResultSchema.safeParse({
          session: agentSession(),
          [key]: CANARY,
        }).success,
      ).toBe(false);
      expect(
        CommerceMachineSessionRevokeResultSchema.safeParse({
          kind: "agent",
          sessionId: V4,
          organizationId: ORG,
          revokedAt: ISO_REVOKED,
          [key]: CANARY,
        }).success,
      ).toBe(false);
    }
    expect(
      CommerceMachineSessionRevokeResultSchema.safeParse({
        kind: "service",
        sessionId: V4,
        organizationId: ORG,
        revokedAt: ISO_REVOKED,
      }).success,
    ).toBe(false);
  });
});

describe("machine v2 success envelopes", () => {
  const issueEnvelope = {
    ok: true as const,
    data: {
      organizationId: ORG,
      replayed: false as const,
      receipt: agentIssueReceipt(),
      delivery: {
        status: "available_once" as const,
        credential: AGENT_CREDENTIAL,
        publicPrefix: AGENT_PREFIX,
      },
    },
    meta: { ...META },
  };

  it("parses strict v2 success envelopes for each result family", () => {
    expect(
      CommerceMachineCredentialIssueResponseSchema.safeParse(issueEnvelope)
        .success,
    ).toBe(true);
    expect(
      CommerceMachineCredentialRevokeResponseSchema.safeParse({
        ok: true,
        data: {
          organizationId: ORG,
          replayed: false,
          receipt: agentRevokeReceipt(),
        },
        meta: { ...META },
      }).success,
    ).toBe(true);
    expect(
      CommerceMachineCredentialStatusResponseSchema.safeParse({
        ok: true,
        data: { organizationId: ORG, status: "not_found" },
        meta: { ...META },
      }).success,
    ).toBe(true);
    expect(
      CommerceMachineCredentialPageResponseSchema.safeParse({
        ok: true,
        data: {
          organizationId: ORG,
          kind: "agent",
          profileId: AGENT,
          items: [agentMetadata()],
          nextCursor: null,
        },
        meta: { ...META },
      }).success,
    ).toBe(true);
    expect(
      CommerceMachineSessionExchangeResponseSchema.safeParse({
        ok: true,
        data: {
          session: agentSession(),
          delivery: { status: "available_once", token: AGENT_SESSION },
        },
        meta: { ...META },
      }).success,
    ).toBe(true);
    expect(
      CommerceMachineSessionSelfResponseSchema.safeParse({
        ok: true,
        data: { session: agentSession() },
        meta: { ...META },
      }).success,
    ).toBe(true);
    expect(
      CommerceMachineSessionRevokeResponseSchema.safeParse({
        ok: true,
        data: {
          kind: "agent",
          sessionId: V4,
          organizationId: ORG,
          revokedAt: ISO_REVOKED,
        },
        meta: { ...META },
      }).success,
    ).toBe(true);
  });

  it("rejects ok:false, invalid meta and extra envelope/error fields", () => {
    expect(
      CommerceMachineCredentialIssueResponseSchema.safeParse({
        ...issueEnvelope,
        ok: false,
      }).success,
    ).toBe(false);
    expect(
      CommerceMachineCredentialIssueResponseSchema.safeParse({
        ...issueEnvelope,
        meta: { ...META, schemaVersion: "openarc.api.v1" },
      }).success,
    ).toBe(false);
    expect(
      CommerceMachineCredentialIssueResponseSchema.safeParse({
        ...issueEnvelope,
        meta: { ...META, buildLabel: "x" },
      }).success,
    ).toBe(false);
    expect(
      CommerceMachineCredentialIssueResponseSchema.safeParse({
        ...issueEnvelope,
        error: { code: "INVALID_REQUEST" },
      }).success,
    ).toBe(false);
    expect(
      CommerceMachineCredentialIssueResponseSchema.safeParse({
        ...issueEnvelope,
        data: { ...issueEnvelope.data, token: CANARY },
      }).success,
    ).toBe(false);
  });

  it("reuses the existing error schema unchanged", () => {
    expect(COMMERCE_API_ERRORS.INVALID_REQUEST.retryable).toBe(false);
    expect(
      CommerceApiErrorEnvelopeSchema.safeParse({
        ok: false,
        error: {
          code: "INVALID_REQUEST",
          message: COMMERCE_API_ERRORS.INVALID_REQUEST.message,
          retryable: false,
        },
        meta: { ...META },
      }).success,
    ).toBe(true);
  });
});

describe("machine type integration", () => {
  it("exposes inferred discriminated types without any", () => {
    expectTypeOf<
      CommerceMachineCredentialMetadata["kind"]
    >().toEqualTypeOf<"agent" | "provider">();
    expectTypeOf<
      CommerceMachineMutationReceipt["operation"]
    >().toEqualTypeOf<
      | "tenant.agent.credential.issue"
      | "tenant.provider.credential.issue"
      | "tenant.agent.credential.revoke"
      | "tenant.provider.credential.revoke"
    >();
    expectTypeOf<
      CommerceMachineSessionMetadata["kind"]
    >().toEqualTypeOf<"agent" | "provider">();
  });

  it("keeps raw secret fields off safe metadata types", () => {
    const metadata: CommerceMachineCredentialMetadata =
      CommerceMachineCredentialMetadataSchema.parse(agentMetadata());
    expect(Object.hasOwn(metadata, "credential")).toBe(false);
    expect(Object.hasOwn(metadata, "token")).toBe(false);
    expect("publicPrefix" in metadata).toBe(true);
  });
});

describe("machine review regressions", () => {
  const V7 = "12345678-1234-7234-8123-123456789abc";
  const V8 = "12345678-1234-8234-8123-123456789abc";
  const PROVIDER_V8 = `openarc:provider:${V8}`;

  it("keeps lookup UUID independent from the receipt credentialId", () => {
    // credentialId === mutationId === V4, lookup embedded in the raw token and
    // publicPrefix is a distinct UUIDv4. This must be accepted for both kinds.
    const lookup = V4_B;
    const agentToken = `oac_ag_${lookup}_${TOKEN_SECRET}`;
    const agentPrefix = `oac_ag_${lookup}`;
    expect(
      CommerceMachineCredentialIssueResultSchema.safeParse({
        organizationId: ORG,
        replayed: false,
        receipt: agentIssueReceipt(),
        delivery: {
          status: "available_once",
          credential: agentToken,
          publicPrefix: agentPrefix,
        },
      }).success,
    ).toBe(true);

    const providerToken = `oac_pr_${lookup}_${TOKEN_SECRET}`;
    const providerPrefix = `oac_pr_${lookup}`;
    expect(
      CommerceMachineCredentialIssueResultSchema.safeParse({
        organizationId: ORG,
        replayed: false,
        receipt: providerIssueReceipt(),
        delivery: {
          status: "available_once",
          credential: providerToken,
          publicPrefix: providerPrefix,
        },
      }).success,
    ).toBe(true);

    // Correlate the raw token's full public prefix to delivery.publicPrefix:
    // a mismatched lookup UUID between them is rejected.
    const mismatches = [
      {
        organizationId: ORG,
        replayed: false as const,
        receipt: agentIssueReceipt(),
        delivery: {
          status: "available_once" as const,
          credential: agentToken,
          publicPrefix: `oac_ag_${V4}`,
        },
      },
      {
        organizationId: ORG,
        replayed: false as const,
        receipt: agentIssueReceipt(),
        delivery: {
          status: "available_once" as const,
          credential: `oac_ag_${V4}_${TOKEN_SECRET}`,
          publicPrefix: agentPrefix,
        },
      },
      {
        organizationId: ORG,
        replayed: false as const,
        receipt: providerIssueReceipt(),
        delivery: {
          status: "available_once" as const,
          credential: providerToken,
          publicPrefix: `oac_ag_${lookup}`,
        },
      },
    ];
    for (const value of mismatches) {
      expect(
        CommerceMachineCredentialIssueResultSchema.safeParse(value).success,
      ).toBe(false);
    }
  });

  it("rejects empty cross-kind pages using independently generated ids", () => {
    const emptyBad = [
      {
        organizationId: ORG,
        kind: "agent" as const,
        profileId: PROVIDER,
        items: [],
        nextCursor: null,
      },
      {
        organizationId: ORG,
        kind: "provider" as const,
        profileId: AGENT,
        items: [],
        nextCursor: null,
      },
      {
        organizationId: ORG,
        kind: "agent" as const,
        // A provider-namespaced id is not an agent profile id.
        profileId: PROVIDER_V8,
        items: [],
        nextCursor: null,
      },
    ];
    for (const value of emptyBad) {
      expect(
        CommerceMachineCredentialPageSchema.safeParse(value).success,
      ).toBe(false);
    }
    // Empty and matching namespaces remain accepted.
    expect(
      CommerceMachineCredentialPageSchema.safeParse({
        organizationId: ORG,
        kind: "agent",
        profileId: AGENT,
        items: [],
        nextCursor: null,
      }).success,
    ).toBe(true);
    expect(
      CommerceMachineCredentialPageSchema.safeParse({
        organizationId: ORG,
        kind: "provider",
        profileId: PROVIDER,
        items: [],
        nextCursor: null,
      }).success,
    ).toBe(true);
  });

  it("accepts existing v1/v7/v8 profile ids and reserves v4-only for new ids", () => {
    const v1 = "12345678-1234-1234-8123-123456789abc";
    const existing = [v1, V7, V8];
    for (const version of existing) {
      expect(
        CommerceMachineCredentialMetadataSchema.safeParse(
          agentMetadata({ profileId: `openarc:agent:${version}` }),
        ).success,
      ).toBe(true);
      expect(
        CommerceMachineCredentialMetadataSchema.safeParse(
          providerMetadata({ profileId: `openarc:provider:${version}` }),
        ).success,
      ).toBe(true);
    }
    // New credential/lookup/session ids stay v4-only.
    for (const value of [V7, V8]) {
      expect(CommerceMachineCredentialIdSchema.safeParse(value).success).toBe(
        false,
      );
    }
  });
});
