import type {
  AuthChallengeKind,
  AuthSessionView,
  AuthStoredCredential,
  ConsumedChallenge,
  CreatedPasskeyAccount,
  ExpectedPasskeyCredential,
  FoundPasskey,
  IssuedChallenge,
  IssuedSession,
  PurgedExpired,
} from "@openarc/db";

import type {
  AuthOriginConfig,
  AuthTransport,
  PasskeyProof,
} from "./proofs.js";

/**
 * Narrow structural port over the durable account repository.
 *
 * The runtime implementation is the reviewed `@openarc/db` `AuthStore`. Unit
 * tests inject a hand-written fake that satisfies this interface; that fake is
 * HONESTLY a test double and never a production adapter path.
 */
export interface AuthStorePort {
  issueChallenge(input: {
    challengeHash: string;
    bindingHash: string;
    kind: AuthChallengeKind;
    challenge: string;
    userHandle?: string;
    walletAddress?: string;
    sessionHash?: string;
  }): Promise<IssuedChallenge>;
  consumeChallenge(input: {
    challengeHash: string;
    bindingHash: string;
    kind: AuthChallengeKind;
    sessionHash?: string;
  }): Promise<ConsumedChallenge>;
  createPasskeyAccount(input: {
    userHandle: string;
    credential: AuthStoredCredential;
    sessionHash: string;
    previousSessionHash?: string;
  }): Promise<CreatedPasskeyAccount>;
  findPasskey(credentialId: unknown): Promise<FoundPasskey | null>;
  loginWallet(input: {
    address: string;
    sessionHash: string;
    previousSessionHash?: string;
  }): Promise<IssuedSession>;
  loginPasskey(input: {
    expectedCredential: ExpectedPasskeyCredential;
    newCounter: number;
    backedUp: boolean;
    sessionHash: string;
    previousSessionHash?: string;
  }): Promise<IssuedSession>;
  getSession(sessionHash: unknown): Promise<AuthSessionView | null>;
  logout(sessionHash: unknown): Promise<void>;
  addPasskey(input: {
    sessionHash: string;
    credential: AuthStoredCredential;
    userHandle: string;
  }): Promise<AuthStoredCredential>;
  linkWallet(input: { sessionHash: string; address: string }): Promise<void>;
  replaceRecoveryCodes(input: {
    sessionHash: string;
    codeHashes: readonly string[];
  }): Promise<void>;
  redeemRecoveryCode(input: {
    codeHash: string;
    newSessionHash: string;
  }): Promise<IssuedSession>;
  consumeRateLimit(input: {
    keyHash: string;
    limit: number;
    windowSeconds: number;
  }): Promise<{ allowed: boolean }>;
  purgeExpired(input: { limit: number }): Promise<PurgedExpired>;
}

/**
 * Narrow structural port over the reviewed proof adapters. The runtime
 * implementation is `./proofs.js`; unit tests may inject an in-memory double
 * for wiring coverage only, clearly labelled as mocked.
 */
export interface AuthProofPort {
  validateAuthOriginConfig(input: unknown): AuthOriginConfig;
  generatePasskeyRegistration(
    userHandle: string,
    config: AuthOriginConfig,
  ): Promise<{
    challenge: string;
    rp: { id?: string; name: string };
    user: { id: string; name: string; displayName: string };
    pubKeyCredParams: Array<{ type: "public-key"; alg: -7 | -257 }>;
    timeout?: number;
    excludeCredentials?: Array<{
      id: string;
      type: "public-key";
      transports?: AuthTransport[];
    }>;
    authenticatorSelection?: {
      authenticatorAttachment?: "platform" | "cross-platform";
      residentKey?: "discouraged" | "preferred" | "required";
      requireResidentKey?: boolean;
      userVerification?: "discouraged" | "preferred" | "required";
    };
    attestation?: "none" | "indirect" | "direct" | "enterprise";
    extensions?: { credProps?: boolean };
  }>;
  generatePasskeyAuthentication(config: AuthOriginConfig): Promise<{
    challenge: string;
    timeout?: number;
    rpId?: string;
    allowCredentials?: Array<{ id: string; type: "public-key" }>;
    userVerification?: "discouraged" | "preferred" | "required";
    extensions?: { credProps?: boolean };
  }>;
  verifyPasskeyRegistration(
    response: unknown,
    expectedChallenge: string,
    config: AuthOriginConfig,
  ): Promise<PasskeyProof>;
  verifyPasskeyAuthentication(
    response: unknown,
    expectedChallenge: string,
    config: AuthOriginConfig,
    credential: PasskeyProof,
  ): Promise<{ newCounter: number; backedUp: boolean }>;
  createWalletLoginMessage(context: {
    address: string;
    nonce: string;
    issuedAt: Date;
    config: AuthOriginConfig;
  }): string;
  verifyWalletLoginProof(
    message: string,
    signature: string,
    context: {
      address: string;
      nonce: string;
      issuedAt: Date;
      config: AuthOriginConfig;
    },
    now: Date,
  ): Promise<string>;
}

/** Injectable random/clock seam so the service is deterministic under test. */
export interface AuthRuntime {
  randomBytes(size: number): Uint8Array;
  now(): Date;
}
