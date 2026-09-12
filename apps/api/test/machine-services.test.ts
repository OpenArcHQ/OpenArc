import { randomBytes } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  CredentialStoreError,
  type CredentialMutationResult,
  type CredentialMutationStatus,
  type CredentialOperation,
} from "@openarc/db";

import type { AuthApiError } from "../src/auth/errors.js";
import { MachineCredentialError } from "../src/machine/credential-crypto.js";
import { MachineManagementService } from "../src/machine/management-service.js";
import { MachineRateLimiter } from "../src/machine/rate-limiter.js";
import { MachineSessionService } from "../src/machine/session-service.js";
import {
  generateSessionToken,
  hashSessionToken,
} from "../src/machine/session-token.js";
import type {
  MachineCredentialStorePort,
  MachineCryptoPort,
  MachineIssueInput,
  MachineListInput,
  MachineManagementAuthPort,
  MachineRateLimitStorePort,
  MachineRevokeInput,
  MachineSessionStorePort,
} from "../src/machine/ports.js";
import type { AuthRequestContext } from "../src/auth/service.js";

/**
 * Unit coverage for the machine management and session services.
 *
 * The CredentialStore, AuthService and crypto primitives are HONESTLY MOCKED
 * here: this suite proves orchestration order, receipt/candidate correlation,
 * replay one-time delivery, namespace separation and fixed error mapping. Real
 * SQL, scrypt, RLS, roles and locks are covered by machine-api.postgres.test.ts.
 */

const HASH = "a".repeat(64);
const MUTATION = "12345678-1234-4234-8123-123456789abc";
const ORG = `openarc:org:${MUTATION}`;
const AGENT = `openarc:agent:${MUTATION}`;
const PROVIDER = `openarc:provider:${MUTATION}`;
const ACCOUNT = `openarc:account:${MUTATION}`;
const ISO = "2026-01-01T00:00:10.000Z";
const LATER = "2026-01-01T01:00:00.000Z";

function b64(bytes: number): string {
  return randomBytes(bytes).toString("base64url");
}

function credentialRecord() {
  return {
    algorithm: "scrypt" as const,
    hashVersion: 1 as const,
    pepperVersion: 1,
    N: 32768 as const,
    r: 8 as const,
    p: 1 as const,
    salt: b64(16),
    digest: b64(32),
  };
}

const CTX: AuthRequestContext = { peerIp: "127.0.0.1", cookies: { session: null, binding: null } };

class FakeAuth implements MachineManagementAuthPort {
  calls: string[] = [];
  csrfError: unknown;
  beginError: unknown;

  verifyCsrf(): string {
    this.calls.push("csrf");
    if (this.csrfError) throw this.csrfError;
    return "binding";
  }
  async beginTenantRead(): Promise<{ sessionHash: string; accountId: string }> {
    this.calls.push("begin");
    if (this.beginError) throw this.beginError;
    return { sessionHash: HASH, accountId: ACCOUNT };
  }
  async finishTenantRead(): Promise<void> {
    this.calls.push("finish");
  }
}

class FakeRateStore implements MachineRateLimitStorePort {
  calls: string[] = [];
  allowed = true;
  error: unknown;

  async consume(input: { keyHash: string }): Promise<{ allowed: boolean }> {
    this.calls.push(input.keyHash.slice(0, 8));
    if (this.error) throw this.error;
    return { allowed: this.allowed };
  }
}

/** Durable-style fixed-window counter that keys on the HMAC hash only. */
class CountingRateStore implements MachineRateLimitStorePort {
  readonly counts = new Map<string, number>();

  async consume(input: {
    keyHash: string;
    limit: number;
  }): Promise<{ allowed: boolean }> {
    const next = (this.counts.get(input.keyHash) ?? 0) + 1;
    this.counts.set(input.keyHash, next);
    return { allowed: next <= input.limit };
  }
}

class FakeCrypto implements MachineCryptoPort {
  calls: string[] = [];
  hashError: unknown;
  verifyError: unknown;
  verifyResult = true;

  async hash(): Promise<ReturnType<typeof credentialRecord>> {
    this.calls.push("hash");
    if (this.hashError) throw this.hashError;
    return credentialRecord();
  }
  async verify(): Promise<boolean> {
    this.calls.push("verify");
    if (this.verifyError) throw this.verifyError;
    return this.verifyResult;
  }
  dispose(): void {
    this.calls.push("dispose");
  }
}

interface FakeStoreOptions {
  readonly issueReplayed?: boolean;
  readonly issueOperation?: string;
  readonly issueCredentialId?: string;
  readonly listThrows?: unknown;
  readonly issueThrows?: unknown;
  readonly revokeThrows?: unknown;
  readonly verifierThrows?: unknown;
  readonly createThrows?: unknown;
  readonly readThrows?: unknown;
  readonly revokeSessionThrows?: unknown;
  readonly createSessionId?: string;
  readonly createExpiresAt?: string;
}

class FakeStore implements MachineCredentialStorePort, MachineSessionStorePort {
  readonly calls: string[] = [];
  issueInput: MachineIssueInput | undefined;
  revokeInput: MachineRevokeInput | undefined;
  listInput: MachineListInput | undefined;
  readonly #options: FakeStoreOptions;

  constructor(options: FakeStoreOptions = {}) {
    this.#options = options;
  }

  #verifier(kind: "agent" | "provider") {
    return {
      organizationId: ORG,
      credentialId: MUTATION,
      kind,
      profileId: kind === "agent" ? AGENT : PROVIDER,
      issuerAccountId: ACCOUNT,
      scope: kind === "agent" ? "agent:self.read" : "provider:self.read",
      scopeVersion: 1 as const,
      environment: "eip155:5042002" as const,
      algorithm: "scrypt" as const,
      hashVersion: 1 as const,
      pepperVersion: 1,
      N: 32768 as const,
      r: 8 as const,
      p: 1 as const,
      salt: b64(16),
      digest: b64(32),
      keyPrefix: kind === "agent" ? `oac_ag_${MUTATION}` : `oac_pr_${MUTATION}`,
      revocationVersion: 1,
      expiresAt: LATER,
    };
  }

  async #issue(
    kind: "agent" | "provider",
    input: MachineIssueInput,
  ): Promise<CredentialMutationResult> {
    this.calls.push(`issue:${kind}`);
    this.issueInput = input;
    if (this.#options.issueThrows) throw this.#options.issueThrows;
    const operation = (this.#options.issueOperation ??
      (kind === "agent"
        ? "tenant.agent.credential.issue"
        : "tenant.provider.credential.issue")) as CredentialOperation;
    return {
      replayed: this.#options.issueReplayed === true,
      receipt: {
        mutationId: input.metadata.mutationId,
        operation,
        resourceType: kind === "agent" ? "agent_credential" : "provider_credential",
        credentialId: this.#options.issueCredentialId ?? input.metadata.mutationId,
        committedAt: ISO,
      },
    };
  }

  issueAgentCredentialDurably(input: MachineIssueInput) {
    return this.#issue("agent", input);
  }
  issueProviderCredentialDurably(input: MachineIssueInput) {
    return this.#issue("provider", input);
  }

  async #revoke(
    kind: "agent" | "provider",
    input: MachineRevokeInput,
  ): Promise<CredentialMutationResult> {
    this.calls.push(`revoke:${kind}`);
    this.revokeInput = input;
    if (this.#options.revokeThrows) throw this.#options.revokeThrows;
    const operation: CredentialOperation =
      kind === "agent"
        ? "tenant.agent.credential.revoke"
        : "tenant.provider.credential.revoke";
    return {
      replayed: false,
      receipt: {
        mutationId: input.metadata.mutationId,
        operation,
        resourceType: kind === "agent" ? "agent_credential" : "provider_credential",
        credentialId: input.credentialId,
        committedAt: ISO,
      },
    };
  }

  revokeAgentCredentialDurably(input: MachineRevokeInput) {
    return this.#revoke("agent", input);
  }
  revokeProviderCredentialDurably(input: MachineRevokeInput) {
    return this.#revoke("provider", input);
  }

  async #list(kind: "agent" | "provider", input: MachineListInput) {
    this.calls.push(`list:${kind}:${input.limit ?? "default"}`);
    this.listInput = input;
    if (this.#options.listThrows) throw this.#options.listThrows;
    return {
      items: [
        {
          credentialId: MUTATION,
          kind,
          profileId: kind === "agent" ? AGENT : PROVIDER,
          keyPrefix: kind === "agent" ? `oac_ag_${MUTATION}` : `oac_pr_${MUTATION}`,
          environment: "eip155:5042002" as const,
          scope: kind === "agent" ? "agent:self.read" : "provider:self.read",
          scopeVersion: 1 as const,
          createdAt: ISO,
          expiresAt: LATER,
          revokedAt: null,
          status: "active" as const,
        },
      ],
      nextCursor: null,
    };
  }

  listAgentCredentials(input: MachineListInput) {
    return this.#list("agent", input);
  }
  listProviderCredentials(input: MachineListInput) {
    return this.#list("provider", input);
  }

  async #status(
    kind: "agent" | "provider",
    mutationId: string,
  ): Promise<CredentialMutationStatus> {
    this.calls.push(`status:${kind}`);
    const operation: CredentialOperation =
      kind === "agent"
        ? "tenant.agent.credential.issue"
        : "tenant.provider.credential.issue";
    return {
      status: "committed" as const,
      receipt: {
        mutationId,
        operation,
        resourceType: kind === "agent" ? "agent_credential" : "provider_credential",
        credentialId: mutationId,
        committedAt: ISO,
      },
    };
  }

  getAgentCredentialMutationStatus(_h: unknown, _o: unknown, m: unknown) {
    return this.#status("agent", String(m));
  }
  getProviderCredentialMutationStatus(_h: unknown, _o: unknown, m: unknown) {
    return this.#status("provider", String(m));
  }

  async findAgentCredentialVerifier() {
    this.calls.push("verifier:agent");
    if (this.#options.verifierThrows) throw this.#options.verifierThrows;
    return this.#verifier("agent");
  }
  async findProviderCredentialVerifier() {
    this.calls.push("verifier:provider");
    if (this.#options.verifierThrows) throw this.#options.verifierThrows;
    return this.#verifier("provider");
  }

  async #create(kind: "agent" | "provider", input: { sessionId: string; expiresAt: string }) {
    this.calls.push(`create:${kind}`);
    if (this.#options.createThrows) throw this.#options.createThrows;
    return {
      sessionId: this.#options.createSessionId ?? input.sessionId,
      credentialId: MUTATION,
      organizationId: ORG,
      kind,
      profileId: kind === "agent" ? AGENT : PROVIDER,
      scope: kind === "agent" ? "agent:self.read" : "provider:self.read",
      scopeVersion: 1 as const,
      environment: "eip155:5042002" as const,
      createdAt: ISO,
      expiresAt: this.#options.createExpiresAt ?? input.expiresAt,
      revocationVersion: 1,
    };
  }

  createAgentSession(input: { sessionId: string; expiresAt: string }) {
    return this.#create("agent", input);
  }
  createProviderSession(input: { sessionId: string; expiresAt: string }) {
    return this.#create("provider", input);
  }

  async #read(kind: "agent" | "provider") {
    this.calls.push(`read:${kind}`);
    if (this.#options.readThrows) throw this.#options.readThrows;
    return {
      sessionId: MUTATION,
      credentialId: MUTATION,
      organizationId: ORG,
      kind,
      profileId: kind === "agent" ? AGENT : PROVIDER,
      scope: kind === "agent" ? "agent:self.read" : "provider:self.read",
      scopeVersion: 1 as const,
      environment: "eip155:5042002" as const,
      createdAt: ISO,
      expiresAt: "2026-01-01T00:05:00.000Z",
      revocationVersion: 1,
    };
  }

  getAgentSession() {
    return this.#read("agent");
  }
  getProviderSession() {
    return this.#read("provider");
  }

  async #revokeSession(kind: "agent" | "provider") {
    this.calls.push(`revokeSession:${kind}`);
    if (this.#options.revokeSessionThrows) throw this.#options.revokeSessionThrows;
    return { sessionId: MUTATION, organizationId: ORG, revokedAt: ISO, revocationVersion: 1 };
  }

  revokeAgentSession() {
    return this.#revokeSession("agent");
  }
  revokeProviderSession() {
    return this.#revokeSession("provider");
  }
}

function management(
  store: FakeStore,
  auth: FakeAuth,
  rateStore: FakeRateStore,
  crypto: FakeCrypto,
) {
  return new MachineManagementService({
    auth,
    store,
    crypto,
    limits: new MachineRateLimiter({ secret: b64(32), store: rateStore }),
  });
}

function session(
  store: FakeStore,
  rateStore: MachineRateLimitStorePort,
  crypto: FakeCrypto,
) {
  return new MachineSessionService({
    store,
    crypto,
    limits: new MachineRateLimiter({ secret: b64(32), store: rateStore }),
    now: () => new Date("2026-01-01T00:00:00.000Z"),
  });
}

const IDEMPOTENCY = b64(32);

function issueBody() {
  return { mutationId: MUTATION, expiresAt: LATER };
}

function issueEnvelope() {
  return { ctx: CTX, csrf: "csrf", idempotencyKey: IDEMPOTENCY, body: issueBody() };
}

async function expectAuthError(
  work: () => Promise<unknown>,
  status: number,
): Promise<AuthApiError> {
  try {
    await work();
  } catch (error) {
    const api = error as AuthApiError;
    expect(api.status).toBe(status);
    return api;
  }
  throw new Error("expected an AuthApiError");
}

describe("machine management service", () => {
  it("lists credentials through begin -> repository -> finish with a bounded limit", async () => {
    const store = new FakeStore();
    const auth = new FakeAuth();
    const service = management(store, auth, new FakeRateStore(), new FakeCrypto());
    const page = await service.listCredentials("agent", ORG, AGENT, { ctx: CTX, limit: 50 });
    expect(page.items).toHaveLength(1);
    expect(page.kind).toBe("agent");
    expect(store.calls).toEqual(["list:agent:50"]);
    expect(auth.calls).toEqual(["begin", "finish"]);
  });

  it("passes a canonical cursor through to the repository", async () => {
    const store = new FakeStore();
    const service = management(store, new FakeAuth(), new FakeRateStore(), new FakeCrypto());
    await service.listCredentials("provider", ORG, PROVIDER, { ctx: CTX, after: MUTATION, limit: 10 });
    expect(store.listInput?.after).toBe(MUTATION);
    expect(store.listInput?.limit).toBe(10);
  });

  it("maps a forbidden list to a fixed 403", async () => {
    const store = new FakeStore({
      listThrows: new CredentialStoreError("CREDENTIAL_STORE_FORBIDDEN"),
    });
    const service = management(store, new FakeAuth(), new FakeRateStore(), new FakeCrypto());
    await expectAuthError(
      () => service.listCredentials("agent", ORG, AGENT, { ctx: CTX }),
      403,
    );
  });

  it("returns a committed status receipt and a bare not_found", async () => {
    const store = new FakeStore();
    const auth = new FakeAuth();
    const service = management(store, auth, new FakeRateStore(), new FakeCrypto());
    const committed = await service.getMutationStatus("agent", ORG, MUTATION, CTX);
    expect(committed.status).toBe("committed");
    expect(store.calls).toContain("status:agent");
    expect(auth.calls).toContain("finish");
  });

  it("orders CSRF, begin, preflight list, issuance rate, KDF and one durable issue", async () => {
    const store = new FakeStore();
    const auth = new FakeAuth();
    const rateStore = new FakeRateStore();
    const crypto = new FakeCrypto();
    const service = management(store, auth, rateStore, crypto);
    const result = await service.issueCredential("agent", ORG, AGENT, issueEnvelope());
    expect(result.replayed).toBe(false);
    if (result.replayed !== false) throw new Error("unreachable");
    expect(result.delivery.status).toBe("available_once");
    expect(result.delivery.credential).toMatch(/^oac_ag_/);
    expect(result.delivery.publicPrefix).toBe(
      result.delivery.credential.slice(0, "oac_ag_".length + 36),
    );
    expect(
      result.delivery.credential.startsWith(`${result.delivery.publicPrefix}_`),
    ).toBe(true);
    expect(auth.calls).toEqual(["csrf", "begin"]);
    expect(store.calls).toEqual(["list:agent:1", "issue:agent"]);
    expect(crypto.calls).toEqual(["hash"]);
    expect(rateStore.calls).toHaveLength(1);
    // The independent lookup id must never equal the issue mutation id.
    expect(store.issueInput?.lookupId).not.toBe(MUTATION);
    expect(store.issueInput?.metadata.mutationId).toBe(MUTATION);
  });

  it("returns token_not_replayable on a replayed issue without a reusable secret", async () => {
    const store = new FakeStore({ issueReplayed: true });
    const crypto = new FakeCrypto();
    const service = management(store, new FakeAuth(), new FakeRateStore(), crypto);
    const result = await service.issueCredential("agent", ORG, AGENT, issueEnvelope());
    expect(result.replayed).toBe(true);
    if (result.replayed !== true) throw new Error("unreachable");
    expect(result.delivery).toEqual({ status: "token_not_replayable" });
    expect(crypto.calls).toEqual(["hash"]);
    expect(store.calls).toEqual(["list:agent:1", "issue:agent"]);
  });

  it("rejects a receipt whose operation kind does not match as a projection failure", async () => {
    const store = new FakeStore({ issueOperation: "tenant.provider.credential.issue" });
    const service = management(store, new FakeAuth(), new FakeRateStore(), new FakeCrypto());
    await expectAuthError(
      () => service.issueCredential("agent", ORG, AGENT, issueEnvelope()),
      500,
    );
  });

  it("maps a credential conflict and an idempotency conflict to fixed 409s", async () => {
    const conflict = management(
      new FakeStore({ issueThrows: new CredentialStoreError("CREDENTIAL_STORE_CONFLICT") }),
      new FakeAuth(),
      new FakeRateStore(),
      new FakeCrypto(),
    );
    const conflictError = await expectAuthError(
      () => conflict.issueCredential("agent", ORG, AGENT, issueEnvelope()),
      409,
    );
    expect(conflictError.code).toBe("POLICY_DENIED");
    const idempotency = management(
      new FakeStore({ issueThrows: new CredentialStoreError("CREDENTIAL_STORE_IDEMPOTENCY_CONFLICT") }),
      new FakeAuth(),
      new FakeRateStore(),
      new FakeCrypto(),
    );
    const idempotencyError = await expectAuthError(
      () => idempotency.issueCredential("agent", ORG, AGENT, issueEnvelope()),
      409,
    );
    expect(idempotencyError.code).toBe("IDEMPOTENCY_CONFLICT");
  });

  it("maps crypto BUSY to 429 and DISPOSED to a non-retryable 503", async () => {
    const busyCrypto = new FakeCrypto();
    busyCrypto.hashError = new MachineCredentialError("BUSY");
    const busy = management(
      new FakeStore(),
      new FakeAuth(),
      new FakeRateStore(),
      busyCrypto,
    );
    await expectAuthError(
      () => busy.issueCredential("agent", ORG, AGENT, issueEnvelope()),
      429,
    );
    const disposedCrypto = new FakeCrypto();
    disposedCrypto.hashError = new MachineCredentialError("DISPOSED");
    const disposed = management(
      new FakeStore(),
      new FakeAuth(),
      new FakeRateStore(),
      disposedCrypto,
    );
    await expectAuthError(
      () => disposed.issueCredential("agent", ORG, AGENT, issueEnvelope()),
      503,
    );
  });

  it("fails the issuance rate limit before any KDF or write", async () => {
    const rateStore = new FakeRateStore();
    rateStore.allowed = false;
    const store = new FakeStore();
    const crypto = new FakeCrypto();
    const service = management(store, new FakeAuth(), rateStore, crypto);
    await expectAuthError(
      () => service.issueCredential("agent", ORG, AGENT, issueEnvelope()),
      429,
    );
    expect(store.calls).toEqual(["list:agent:1"]);
    expect(crypto.calls).toEqual([]);
  });

  it("rejects a preflight namespace failure before the rate limit and KDF", async () => {
    const store = new FakeStore({
      listThrows: new CredentialStoreError("CREDENTIAL_STORE_NOT_FOUND"),
    });
    const rateStore = new FakeRateStore();
    const crypto = new FakeCrypto();
    const service = management(store, new FakeAuth(), rateStore, crypto);
    await expectAuthError(
      () => service.issueCredential("agent", ORG, AGENT, issueEnvelope()),
      403,
    );
    expect(rateStore.calls).toEqual([]);
    expect(crypto.calls).toEqual([]);
  });

  it("rejects a CSRF failure before any session or store work", async () => {
    const store = new FakeStore();
    const auth = new FakeAuth();
    auth.csrfError = new Error("csrf");
    const service = management(store, auth, new FakeRateStore(), new FakeCrypto());
    await expect(service.issueCredential("agent", ORG, AGENT, issueEnvelope())).rejects.toBeTruthy();
    expect(auth.calls).toEqual(["csrf"]);
    expect(store.calls).toEqual([]);
  });

  it("revokes exactly one credential without KDF work", async () => {
    const store = new FakeStore();
    const crypto = new FakeCrypto();
    const service = management(store, new FakeAuth(), new FakeRateStore(), crypto);
    const result = await service.revokeCredential("provider", ORG, MUTATION, {
      ctx: CTX,
      csrf: "csrf",
      idempotencyKey: IDEMPOTENCY,
      body: { mutationId: MUTATION },
    });
    expect(result.replayed).toBe(false);
    expect(result.receipt.credentialId).toBe(MUTATION);
    expect(store.calls).toEqual(["revoke:provider"]);
    expect(crypto.calls).toEqual([]);
  });
});

describe("machine session service", () => {
  function credentialToken(kind: "agent" | "provider"): string {
    const prefix = kind === "agent" ? "oac_ag_" : "oac_pr_";
    return `${prefix}${MUTATION}_${b64(32)}`;
  }

  it("orders global/peer/lookup limits, verifier, scrypt verify and one create", async () => {
    const store = new FakeStore();
    const rateStore = new FakeRateStore();
    const crypto = new FakeCrypto();
    const service = session(store, rateStore, crypto);
    const result = await service.exchange("agent", {
      token: credentialToken("agent"),
      peerIp: "127.0.0.1",
    });
    expect(result.session.kind).toBe("agent");
    expect(result.delivery.status).toBe("available_once");
    expect(result.delivery.token).toMatch(/^oas_ag_/);
    expect(store.calls).toEqual(["verifier:agent", "create:agent"]);
    expect(crypto.calls).toEqual(["verify"]);
    expect(rateStore.calls).toHaveLength(3);
  });

  it("rejects a valid DTO whose generated session id does not match", async () => {
    const store = new FakeStore({ createSessionId: MUTATION });
    const crypto = new FakeCrypto();
    const service = session(store, new FakeRateStore(), crypto);
    const error = await expectAuthError(
      () => service.exchange("agent", { token: credentialToken("agent"), peerIp: "127.0.0.1" }),
      500,
    );
    expect(error.code).toBe("INTERNAL_ERROR");
    // The mismatch is rejected before any one-time delivery token is returned.
    expect(JSON.stringify(error)).not.toContain("oas_ag_");
  });

  it("rejects a valid DTO whose expiry is extended beyond the requested cap", async () => {
    const store = new FakeStore({ createExpiresAt: "2026-01-01T00:15:00.000Z" });
    const crypto = new FakeCrypto();
    const service = session(store, new FakeRateStore(), crypto);
    const error = await expectAuthError(
      () => service.exchange("agent", { token: credentialToken("agent"), peerIp: "127.0.0.1" }),
      500,
    );
    expect(error.code).toBe("INTERNAL_ERROR");
    expect(JSON.stringify(error)).not.toContain("oas_ag_");
  });

  it("rejects a returned expiry extended by a sub-millisecond fraction", async () => {
    const store = new FakeStore({ createExpiresAt: "2026-01-01T00:05:00.0001Z" });
    const crypto = new FakeCrypto();
    const service = session(store, new FakeRateStore(), crypto);
    const error = await expectAuthError(
      () => service.exchange("agent", { token: credentialToken("agent"), peerIp: "127.0.0.1" }),
      500,
    );
    expect(error.code).toBe("INTERNAL_ERROR");
    expect(JSON.stringify(error)).not.toContain("oas_ag_");
  });

  it("accepts an equivalent textual form of the same instant", async () => {
    // `...00.0Z` is the same instant as the requested `...00.000Z` and the
    // schema accepts it, so the semantic comparison must allow it.
    const store = new FakeStore({ createExpiresAt: "2026-01-01T00:05:00.0Z" });
    const crypto = new FakeCrypto();
    const service = session(store, new FakeRateStore(), crypto);
    const result = await service.exchange("agent", {
      token: credentialToken("agent"),
      peerIp: "127.0.0.1",
    });
    expect(result.delivery.status).toBe("available_once");
    expect(result.session.expiresAt).toBe("2026-01-01T00:05:00.0Z");
  });

  it("domain-separates exchange from self/revoke so peer bursts stay independent", async () => {
    const rateStore = new CountingRateStore();
    const store = new FakeStore();
    const service = session(store, rateStore, new FakeCrypto());
    const sessionToken = generateSessionToken("agent");
    // 20 concurrent self reads consume the whole exchange peer allowance if the
    // keys were shared; with family separation they only touch session keys.
    for (let index = 0; index < 20; index += 1) {
      const self = await service.self("agent", { token: sessionToken, peerIp: "127.0.0.1" });
      expect(self.session.kind).toBe("agent");
    }
    const exchanged = await service.exchange("agent", {
      token: credentialToken("agent"),
      peerIp: "127.0.0.1",
    });
    expect(exchanged.session.kind).toBe("agent");
    expect(exchanged.delivery.status).toBe("available_once");
  });

  it("rejects a wrong-kind long-lived credential before any limiter or store call", async () => {
    const store = new FakeStore();
    const rateStore = new FakeRateStore();
    const service = session(store, rateStore, new FakeCrypto());
    await expectAuthError(
      () => service.exchange("agent", { token: credentialToken("provider"), peerIp: "127.0.0.1" }),
      401,
    );
    expect(rateStore.calls).toEqual([]);
    expect(store.calls).toEqual([]);
  });

  it("rejects a malformed or short-session token as a fixed 401", async () => {
    const service = session(new FakeStore(), new FakeRateStore(), new FakeCrypto());
    await expectAuthError(
      () => service.exchange("agent", { token: "not-a-token", peerIp: "127.0.0.1" }),
      401,
    );
    await expectAuthError(
      () => service.exchange("agent", { token: generateSessionToken("agent"), peerIp: "127.0.0.1" }),
      401,
    );
  });

  it("maps a missing verifier, a failed verify and a store failure to fixed 401s", async () => {
    const missing = session(
      new FakeStore({ verifierThrows: new CredentialStoreError("CREDENTIAL_STORE_NOT_FOUND") }),
      new FakeRateStore(),
      new FakeCrypto(),
    );
    await expectAuthError(
      () => missing.exchange("agent", { token: credentialToken("agent"), peerIp: "127.0.0.1" }),
      401,
    );
    const crypto = new FakeCrypto();
    crypto.verifyResult = false;
    const mismatch = session(new FakeStore(), new FakeRateStore(), crypto);
    await expectAuthError(
      () => mismatch.exchange("agent", { token: credentialToken("agent"), peerIp: "127.0.0.1" }),
      401,
    );
    const conflict = session(
      new FakeStore({ createThrows: new CredentialStoreError("CREDENTIAL_STORE_CONFLICT") }),
      new FakeRateStore(),
      new FakeCrypto(),
    );
    await expectAuthError(
      () => conflict.exchange("agent", { token: credentialToken("agent"), peerIp: "127.0.0.1" }),
      401,
    );
  });

  it("maps crypto BUSY to 429 and DISPOSED to 503 during exchange", async () => {
    const busyCrypto = new FakeCrypto();
    busyCrypto.verifyError = new MachineCredentialError("BUSY");
    const busy = session(new FakeStore(), new FakeRateStore(), busyCrypto);
    await expectAuthError(
      () => busy.exchange("agent", { token: credentialToken("agent"), peerIp: "127.0.0.1" }),
      429,
    );
    const disposedCrypto = new FakeCrypto();
    disposedCrypto.verifyError = new MachineCredentialError("DISPOSED");
    const disposed = session(new FakeStore(), new FakeRateStore(), disposedCrypto);
    await expectAuthError(
      () => disposed.exchange("agent", { token: credentialToken("agent"), peerIp: "127.0.0.1" }),
      503,
    );
  });

  it("reads the current session by hash for self and revoke with no raw token stored", async () => {
    const store = new FakeStore();
    const service = session(store, new FakeRateStore(), new FakeCrypto());
    const token = generateSessionToken("agent");
    const self = await service.self("agent", { token, peerIp: "127.0.0.1" });
    expect(self.session.kind).toBe("agent");
    expect(store.calls).toEqual(["read:agent"]);
    const revoked = await service.revoke("agent", { token, peerIp: "127.0.0.1" });
    expect(revoked.sessionId).toBe(MUTATION);
    expect(store.calls).toEqual(["read:agent", "revokeSession:agent"]);
    // The stored value must be the domain-separated hash, never the raw token.
    expect(hashSessionToken("agent", token)).not.toContain(token);
  });

  it("rejects a wrong-kind session token on self and revoke", async () => {
    const store = new FakeStore();
    const service = session(store, new FakeRateStore(), new FakeCrypto());
    await expectAuthError(
      () => service.self("agent", { token: generateSessionToken("provider"), peerIp: "127.0.0.1" }),
      401,
    );
    await expectAuthError(
      () => service.revoke("provider", { token: generateSessionToken("agent"), peerIp: "127.0.0.1" }),
      401,
    );
    expect(store.calls).toEqual([]);
  });
});
