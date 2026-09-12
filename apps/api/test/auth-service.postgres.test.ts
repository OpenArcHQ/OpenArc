import { AuthStore, createDatabasePool, migrate } from "@openarc/db";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createApp } from "../src/app.js";
import { AUTH_ROUTES } from "../src/auth/routes.js";
import { AuthService, type AuthServiceConfig } from "../src/auth/service.js";
import type { AuthProofPort, AuthRuntime } from "../src/auth/ports.js";
import type { AuthOriginConfig, PasskeyProof } from "../src/auth/proofs.js";
import { loadConfig } from "../src/config.js";
import {
  adminPool,
  appUrl,
  ensureRoles,
  migratorUrl,
  resetSchema,
} from "../../../packages/db/test/postgres-fixture.js";

type Pool = ReturnType<typeof adminPool>;

/**
 * Real-PostgreSQL Fastify inject flows for the account-only API.
 *
 * The runtime repository is the real reviewed `AuthStore` over the disposable
 * fixture app role. The WebAuthn/SIWE proof adapters are MOCKED here (labelled)
 * because this suite proves repository/HTTP integration, not real crypto; the
 * reviewed adapter contract tests cover the crypto boundary.
 */

const ORIGIN = "http://localhost:5173";
const RP_ID = "localhost";
const SECRET = "synthetic_auth_secret_for_postgres_tests_0123456789";
const BUILD_SHA = "0123456789abcdef0123456789abcdef01234567";
const JSON_HEADERS = {
  origin: ORIGIN,
  "x-openarc-client": "browser-v1",
  "content-type": "application/json",
};

function b64(bytes: number, fill: number): string {
  return Buffer.alloc(bytes, fill).toString("base64url");
}

class MockProofs implements AuthProofPort {
  readonly registrationChallenge = b64(32, 71);
  readonly authenticationChallenge = b64(32, 72);
  readonly credentialId = b64(24, 73);
  readonly publicKey = new Uint8Array([9, 8, 7, 6]);
  assertionUserHandle: string | undefined;
  walletMessage = "";

  validateAuthOriginConfig(input: unknown): AuthOriginConfig {
    const value = input as {
      origin: string;
      rpId: string;
      environment: "development" | "production";
    };
    return { origin: value.origin, rpId: value.rpId, environment: value.environment };
  }

  async generatePasskeyRegistration(userHandle: string) {
    return {
      challenge: this.registrationChallenge,
      rp: { id: RP_ID, name: "OpenArc" },
      user: {
        id: userHandle,
        name: `OpenArc ${userHandle.slice(0, 8)}`,
        displayName: `OpenArc ${userHandle.slice(0, 8)}`,
      },
      pubKeyCredParams: [{ type: "public-key" as const, alg: -7 as const }],
      timeout: 60_000,
      attestation: "none" as const,
    };
  }

  async generatePasskeyAuthentication() {
    return {
      challenge: this.authenticationChallenge,
      timeout: 60_000,
      rpId: RP_ID,
      allowCredentials: [],
      userVerification: "required" as const,
    };
  }

  async verifyPasskeyRegistration(): Promise<PasskeyProof> {
    return {
      credentialId: this.credentialId,
      publicKey: this.publicKey,
      counter: 0,
      deviceType: "multiDevice",
      backedUp: false,
      transports: ["internal"],
    };
  }

  async verifyPasskeyAuthentication(): Promise<{
    newCounter: number;
    backedUp: boolean;
  }> {
    return { newCounter: 1, backedUp: false };
  }

  createWalletLoginMessage(context: {
    address: string;
    nonce: string;
    issuedAt: Date;
  }): string {
    this.walletMessage = `${context.address}|${context.nonce}|${context.issuedAt.getTime()}`;
    return this.walletMessage;
  }

  async verifyWalletLoginProof(
    message: string,
    signature: string,
    context: { address: string; nonce: string; issuedAt: Date },
  ): Promise<string> {
    const expected = `${context.address}|${context.nonce}|${context.issuedAt.getTime()}`;
    if (message !== expected || signature !== `0x${"cd".repeat(65)}`) {
      throw new Error("proof invalid");
    }
    return context.address.toLowerCase();
  }
}

function runtime(): AuthRuntime {
  let counter = 0;
  return {
    randomBytes: (size: number) => {
      counter += 1;
      const value = new Uint8Array(size);
      for (let index = 0; index < size; index += 1) {
        value[index] = (counter * 7 + index * 3) % 256;
      }
      return value;
    },
    now: () => new Date(),
  };
}

let admin: Pool;
let app: Pool;
let migrator: Pool;

beforeAll(async () => {
  admin = adminPool();
  await ensureRoles(admin);
  migrator = createDatabasePool(migratorUrl());
});

afterAll(async () => {
  try {
    await resetSchema(admin);
  } finally {
    await migrator.end();
    await admin.end();
  }
});

beforeEach(async () => {
  await resetSchema(admin);
  await migrate(migrator);
  app = createDatabasePool(appUrl());
});

afterEach(async () => {
  await app.end();
});

function buildApp() {
  const proofs = new MockProofs();
  const service = new AuthService({
    config: {
      authSecret: SECRET,
      appOrigin: ORIGIN,
      rpId: RP_ID,
      environment: "development",
      secureCookies: false,
      cookieNames: { session: "openarc_session", binding: "openarc_binding" },
    } satisfies AuthServiceConfig,
    store: new AuthStore(app),
    proofs,
    runtime: runtime(),
  });
  const config = loadConfig({
    NODE_ENV: "test",
    APP_ORIGIN: ORIGIN,
    COMMIT_SHA: BUILD_SHA,
    AUTH_ENABLED: "true",
    AUTH_DATABASE_URL: appUrl(),
    AUTH_SECRET: SECRET,
    AUTH_RP_ID: RP_ID,
  });
  const instance = createApp({ config, logger: false, authService: service });
  return { instance, proofs, service };
}

function jar(response: { headers: Record<string, unknown> }): {
  session?: string;
  binding?: string;
} {
  const raw = [response.headers["set-cookie"]]
    .flat()
    .filter((value): value is string => typeof value === "string");
  const result: { session?: string; binding?: string } = {};
  for (const cookie of raw) {
    const [pair] = cookie.split(";");
    if (pair === undefined) continue;
    const separator = pair.indexOf("=");
    const name = pair.slice(0, separator);
    const value = pair.slice(separator + 1);
    if (name === "openarc_session") result.session = value;
    if (name === "openarc_binding") result.binding = value;
  }
  return result;
}

function headers(
  cookies: { session?: string | undefined; binding?: string | undefined },
  csrf?: string,
) {
  const pairs = [
    cookies.session ? `openarc_session=${cookies.session}` : undefined,
    cookies.binding ? `openarc_binding=${cookies.binding}` : undefined,
  ].filter((value): value is string => value !== undefined);
  return {
    ...JSON_HEADERS,
    ...(pairs.length > 0 ? { cookie: pairs.join("; ") } : {}),
    ...(csrf !== undefined ? { "x-openarc-csrf": csrf } : {}),
  };
}

function withBinding<T extends { session?: string }>(
  jarValue: T,
  binding: string | undefined,
): T & { binding?: string } {
  return { ...jarValue, ...(binding !== undefined ? { binding } : {}) };
}

async function bootstrap(instance: ReturnType<typeof createApp>) {
  const response = await instance.inject({
    method: "POST",
    url: AUTH_ROUTES.bootstrap,
    headers: JSON_HEADERS,
    payload: {},
  });
  expect(response.statusCode).toBe(200);
  return {
    csrf: response.json().data.csrfToken as string,
    cookies: jar(response),
  };
}

describe("real-PG auth flows", () => {
  it("registers, reads the safe session and logs out", async () => {
    const { instance, proofs } = buildApp();
    const { csrf, cookies } = await bootstrap(instance);
    const options = await instance.inject({
      method: "POST",
      url: AUTH_ROUTES.registerOptions,
      headers: headers(cookies, csrf),
      payload: { acceptMinimalRecords: true },
    });
    expect(options.statusCode).toBe(200);
    const flowId = options.json().data.flowId as string;
    const verify = await instance.inject({
      method: "POST",
      url: AUTH_ROUTES.registerVerify,
      headers: headers(cookies, csrf),
      payload: {
        flowId,
        response: {
          id: proofs.credentialId,
          rawId: proofs.credentialId,
          type: "public-key",
          response: { clientDataJSON: b64(16, 81), attestationObject: b64(16, 82) },
        },
      },
    });
    expect(verify.statusCode).toBe(200);
    const signed = jar(verify);
    expect(signed.session).toBeTruthy();

    const session = await instance.inject({
      method: "GET",
      url: AUTH_ROUTES.session,
      headers: headers(withBinding(signed, cookies.binding)),
    });
    expect(session.statusCode).toBe(200);
    expect(session.json().data.session).toMatchObject({
      signedIn: true,
      method: "passkey",
    });
    expect(session.body).not.toContain(proofs.credentialId);

    const fresh = await bootstrap(instance);
    const logout = await instance.inject({
      method: "POST",
      url: AUTH_ROUTES.logout,
      headers: headers(
        { ...signed, binding: cookies.binding },
        verify.json().data.csrfToken as string,
      ),
      payload: {},
    });
    expect(logout.statusCode).toBe(200);
    const after = await instance.inject({
      method: "GET",
      url: AUTH_ROUTES.session,
      headers: headers(withBinding(signed, cookies.binding)),
    });
    expect(after.json().data.session).toEqual({ signedIn: false });
    expect(fresh.csrf).toBeTruthy();
  });

  it("rejects a DB-consumed (replayed) challenge", async () => {
    const { instance, proofs } = buildApp();
    const { csrf, cookies } = await bootstrap(instance);
    const options = await instance.inject({
      method: "POST",
      url: AUTH_ROUTES.registerOptions,
      headers: headers(cookies, csrf),
      payload: { acceptMinimalRecords: true },
    });
    const flowId = options.json().data.flowId as string;
    const payload = {
      flowId,
      response: {
        id: proofs.credentialId,
        rawId: proofs.credentialId,
        type: "public-key",
        response: { clientDataJSON: b64(16, 91), attestationObject: b64(16, 92) },
      },
    };
    const first = await instance.inject({
      method: "POST",
      url: AUTH_ROUTES.registerVerify,
      headers: headers(cookies, csrf),
      payload,
    });
    expect(first.statusCode).toBe(200);
    const replay = await instance.inject({
      method: "POST",
      url: AUTH_ROUTES.registerVerify,
      headers: headers(cookies, csrf),
      payload,
    });
    expect(replay.statusCode).toBe(401);
  });

  it("creates one wallet account and links a wallet through a fresh session", async () => {
    const { instance, proofs } = buildApp();
    const { csrf, cookies } = await bootstrap(instance);
    const address = "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed";
    const options = await instance.inject({
      method: "POST",
      url: AUTH_ROUTES.walletLoginOptions,
      headers: headers(cookies, csrf),
      payload: { address },
    });
    expect(options.statusCode).toBe(200);
    const message = options.json().data.message as string;
    const flowId = options.json().data.flowId as string;
    const verify = await instance.inject({
      method: "POST",
      url: AUTH_ROUTES.walletLoginVerify,
      headers: headers(cookies, csrf),
      payload: { flowId, message, signature: `0x${"cd".repeat(65)}` },
    });
    expect(verify.statusCode).toBe(200);
    expect(verify.json().data.session).toMatchObject({ signedIn: true, method: "wallet" });
    const signed = jar(verify);

    const link = await instance.inject({
      method: "POST",
      url: AUTH_ROUTES.walletLinkOptions,
      headers: headers(
        withBinding(signed, cookies.binding),
        verify.json().data.csrfToken as string,
      ),
      payload: { address: "0x1111111111111111111111111111111111111111" },
    });
    expect(link.statusCode).toBe(200);
    expect(proofs.walletMessage).toContain("0x1111111111111111111111111111111111111111");
  });

  it("issues and redeems recovery codes once with hash-only storage", async () => {
    const { instance, proofs } = buildApp();
    const { csrf, cookies } = await bootstrap(instance);
    const options = await instance.inject({
      method: "POST",
      url: AUTH_ROUTES.registerOptions,
      headers: headers(cookies, csrf),
      payload: { acceptMinimalRecords: true },
    });
    const flowId = options.json().data.flowId as string;
    const verify = await instance.inject({
      method: "POST",
      url: AUTH_ROUTES.registerVerify,
      headers: headers(cookies, csrf),
      payload: {
        flowId,
        response: {
          id: proofs.credentialId,
          rawId: proofs.credentialId,
          type: "public-key",
          response: { clientDataJSON: b64(16, 101), attestationObject: b64(16, 102) },
        },
      },
    });
    const signed = jar(verify);
    const signedCsrf = verify.json().data.csrfToken as string;
    const codes = await instance.inject({
      method: "POST",
      url: AUTH_ROUTES.recoveryCodes,
      headers: headers(withBinding(signed, cookies.binding), signedCsrf),
      payload: {},
    });
    expect(codes.statusCode).toBe(200);
    const list = codes.json().data.codes as string[];
    expect(list).toHaveLength(8);
    const stored = await admin.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM openarc_auth.recovery_codes",
    );
    expect(stored.rows[0]?.n).toBe(8);

    const redeem = await instance.inject({
      method: "POST",
      url: AUTH_ROUTES.recoveryRedeem,
      headers: headers(withBinding(signed, cookies.binding), signedCsrf),
      payload: { code: list[0] },
    });
    expect(redeem.statusCode).toBe(200);
    expect(redeem.json().data.session).toMatchObject({ signedIn: true, method: "recovery" });
    const redeemAgain = await instance.inject({
      method: "POST",
      url: AUTH_ROUTES.recoveryRedeem,
      headers: headers(cookies, csrf),
      payload: { code: list[0] },
    });
    expect(redeemAgain.statusCode).toBe(400);
    const remaining = await admin.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM openarc_auth.recovery_codes",
    );
    expect(remaining.rows[0]?.n).toBe(7);
  });

  it("rejects a session that changes during an account-bound proof", async () => {
    const { instance, proofs } = buildApp();
    const { csrf, cookies } = await bootstrap(instance);
    const options = await instance.inject({
      method: "POST",
      url: AUTH_ROUTES.registerOptions,
      headers: headers(cookies, csrf),
      payload: { acceptMinimalRecords: true },
    });
    const flowId = options.json().data.flowId as string;
    const verify = await instance.inject({
      method: "POST",
      url: AUTH_ROUTES.registerVerify,
      headers: headers(cookies, csrf),
      payload: {
        flowId,
        response: {
          id: proofs.credentialId,
          rawId: proofs.credentialId,
          type: "public-key",
          response: { clientDataJSON: b64(16, 111), attestationObject: b64(16, 112) },
        },
      },
    });
    const signed = jar(verify);
    const signedCsrf = verify.json().data.csrfToken as string;
    const addOptions = await instance.inject({
      method: "POST",
      url: AUTH_ROUTES.addOptions,
      headers: headers(withBinding(signed, cookies.binding), signedCsrf),
      payload: {},
    });
    expect(addOptions.statusCode).toBe(200);
    // Revoke the session out from under the in-flight add challenge.
    await admin.query(
      `UPDATE openarc_auth.sessions
          SET created_at = now() - interval '25 hours',
              expires_at = now() - interval '1 hour'`,
    );
    const addFlowId = addOptions.json().data.flowId as string;
    const addVerify = await instance.inject({
      method: "POST",
      url: AUTH_ROUTES.addVerify,
      headers: headers(withBinding(signed, cookies.binding), signedCsrf),
      payload: {
        flowId: addFlowId,
        response: {
          id: b64(24, 113),
          rawId: b64(24, 113),
          type: "public-key",
          response: { clientDataJSON: b64(16, 114), attestationObject: b64(16, 115) },
        },
      },
    });
    expect(addVerify.statusCode).toBe(401);
  });
});
