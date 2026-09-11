/**
 * Passwordless proof adapters (WebAuthn/passkey + EOA SIWE).
 *
 * No routes, storage, sessions, network calls, signers or payment authority.
 * All public inputs are runtime validated; all failures collapse to a single
 * fixed, non-echoing AuthProofError.
 */
import {
  generateRegistrationOptions,
  generateAuthenticationOptions,
  verifyRegistrationResponse,
  verifyAuthenticationResponse,
} from '@simplewebauthn/server';
import type {
  RegistrationResponseJSON,
  AuthenticationResponseJSON,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
} from '@simplewebauthn/server';
import { Buffer } from 'node:buffer';
import { createSiweMessage } from 'viem/siwe';
import { getAddress, isAddress, verifyMessage } from 'viem';
import { z } from 'zod';

/** Fixed, non-echoing proof error. Never carries parser/library detail. */
export class AuthProofError extends Error {
  constructor() {
    super('AUTH_PROOF_INVALID');
    this.name = 'AuthProofError';
  }
}

function fail(): never {
  throw new AuthProofError();
}

/* ------------------------------------------------------------------ */
/* Origin configuration                                                */
/* ------------------------------------------------------------------ */

export interface AuthOriginConfig {
  origin: string;
  rpId: string;
  environment: 'development' | 'production';
}

const OriginConfigSchema = z
  .object({
    origin: z.string().min(1).max(2048),
    rpId: z.string().min(1).max(253),
    environment: z.enum(['development', 'production']),
  })
  .strict();

/** Validates and returns a canonical AuthOriginConfig, or throws AuthProofError. */
export function validateAuthOriginConfig(input: unknown): AuthOriginConfig {
  const parsed = OriginConfigSchema.safeParse(input);
  if (!parsed.success) fail();
  const { origin, rpId, environment } = parsed.data;

  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    fail();
  }
  // Canonical URL.origin only: no path/query/fragment/credentials/trailing slash.
  if (url.origin !== origin) fail();

  const isHttp = url.protocol === 'http:';
  const isHttps = url.protocol === 'https:';
  if (!isHttp && !isHttps) fail();

  const hostname = url.hostname;
  if (rpId.includes('*') || rpId.includes('/')) fail();
  if (rpId !== hostname) fail();
  if (rpId.startsWith('.') || rpId.endsWith('.')) fail();

  const isLoopback = hostname === 'localhost' || hostname === '127.0.0.1';

  if (isHttp) {
    // HTTP allowed ONLY in development on localhost/127.0.0.1.
    if (environment !== 'development') fail();
    if (!isLoopback) fail();
  }
  if (environment === 'production' && isLoopback) fail();

  return { origin, rpId, environment };
}

/* ------------------------------------------------------------------ */
/* Shared bounded schemas                                             */
/* ------------------------------------------------------------------ */

const TRANSPORTS = [
  'usb',
  'nfc',
  'ble',
  'internal',
  'hybrid',
  'cable',
  'smart-card',
] as const;

/** Local transports union (library 14 has no AuthenticatorTransportFuture). */
export type AuthTransport = (typeof TRANSPORTS)[number];
const transportSchema = z.enum(TRANSPORTS);

/**
 * Canonical base64url bounded string: no padding, no newline, exact
 * decode/re-encode equality, and nonempty decoded bytes. min/max are ENCODED
 * CHARACTER counts (frozen contract bounds).
 */
function canonicalB64url(minChars: number, maxChars: number) {
  return z
    .string()
    .min(minChars)
    .max(maxChars)
    .refine((s) => {
      if (!/^[A-Za-z0-9_-]+$/.test(s)) return false;
      let decoded: Buffer;
      try {
        decoded = Buffer.from(s, 'base64url');
      } catch {
        return false;
      }
      if (decoded.length === 0) return false;
      return decoded.toString('base64url') === s;
    });
}

const challengeSchema = canonicalB64url(16, 256);

const counterSchema = z.number().int().min(0).max(4_294_967_295);

const userHandleSchema = canonicalB64url(43, 43);

/* ------------------------------------------------------------------ */
/* Passkey registration / authentication options                       */
/* ------------------------------------------------------------------ */

const RP_NAME = 'OpenArc';

export async function generatePasskeyRegistration(
  userHandle: string,
  config: AuthOriginConfig,
): Promise<PublicKeyCredentialCreationOptionsJSON> {
  const cfg = validateAuthOriginConfig(config);
  const parsedHandle = userHandleSchema.safeParse(userHandle);
  if (!parsedHandle.success) fail();
  const handle = parsedHandle.data;

  const userID = new Uint8Array(Buffer.from(handle, 'base64url'));

  try {
    return await generateRegistrationOptions({
      rpName: RP_NAME,
      rpID: cfg.rpId,
      userID,
      userName: `${RP_NAME} ${handle.slice(0, 8)}`,
      userDisplayName: `${RP_NAME} ${handle.slice(0, 8)}`,
      attestationType: 'none',
      authenticatorSelection: {
        residentKey: 'required',
        userVerification: 'required',
      },
      supportedAlgorithmIDs: [-7, -257],
    });
  } catch {
    fail();
  }
}

export async function generatePasskeyAuthentication(
  config: AuthOriginConfig,
): Promise<PublicKeyCredentialRequestOptionsJSON> {
  const cfg = validateAuthOriginConfig(config);
  try {
    return await generateAuthenticationOptions({
      rpID: cfg.rpId,
      userVerification: 'required',
      // Discoverable passkeys: no allowCredentials enumeration.
      allowCredentials: [],
    });
  } catch {
    fail();
  }
}

/* ------------------------------------------------------------------ */
/* Passkey proof verification                                          */
/* ------------------------------------------------------------------ */

export interface PasskeyProof {
  credentialId: string;
  publicKey: Uint8Array<ArrayBuffer>;
  counter: number;
  deviceType: 'singleDevice' | 'multiDevice';
  backedUp: boolean;
  transports: AuthTransport[];
}

const credentialIdSchema = canonicalB64url(1, 1024);
const publicKeySchema = z
  .instanceof(Uint8Array)
  .refine((b) => b.length >= 1 && b.length <= 2048)
  .transform((b) => new Uint8Array(b));

const PasskeyProofSchema = z
  .object({
    credentialId: credentialIdSchema,
    publicKey: publicKeySchema,
    counter: counterSchema,
    deviceType: z.enum(['singleDevice', 'multiDevice']),
    backedUp: z.boolean(),
    transports: z.array(transportSchema).max(8),
  })
  .strict();

function parsePasskeyProof(input: unknown): PasskeyProof {
  const parsed = PasskeyProofSchema.safeParse(input);
  if (!parsed.success) fail();
  if (parsed.data.deviceType === 'singleDevice' && parsed.data.backedUp) fail();
  return {
    credentialId: parsed.data.credentialId,
    publicKey: parsed.data.publicKey,
    counter: parsed.data.counter,
    deviceType: parsed.data.deviceType,
    backedUp: parsed.data.backedUp,
    transports: parsed.data.transports,
  };
}

const clientExtensionResultsSchema = z
  .object({
    credProps: z
      .object({ rk: z.boolean() })
      .strict()
      .optional(),
  })
  .strict();

const registrationSchema = z
  .object({
    id: credentialIdSchema,
    rawId: credentialIdSchema,
    type: z.literal('public-key'),
    response: z
      .object({
        clientDataJSON: canonicalB64url(1, 8192),
        attestationObject: canonicalB64url(1, 16384),
        authenticatorData: canonicalB64url(1, 16384).optional(),
        publicKey: canonicalB64url(1, 2048).optional(),
        publicKeyAlgorithm: z
          .union([z.literal(-7), z.literal(-257)])
          .optional(),
        transports: z.array(transportSchema).max(8).optional(),
      })
      .strict(),
    clientExtensionResults: clientExtensionResultsSchema.default({}),
    authenticatorAttachment: z
      .enum(['platform', 'cross-platform'])
      .optional(),
  })
  .strict();

export async function verifyPasskeyRegistration(
  response: unknown,
  expectedChallenge: string,
  config: AuthOriginConfig,
): Promise<PasskeyProof> {
  const cfg = validateAuthOriginConfig(config);
  const parsedChallenge = challengeSchema.safeParse(expectedChallenge);
  if (!parsedChallenge.success) fail();

  const parsedResponse = registrationSchema.safeParse(response);
  if (!parsedResponse.success) fail();
  const reg = parsedResponse.data;
  if (reg.id !== reg.rawId) fail();

  // Explicit allowlisted SDK wire object: optional response fields are only
  // present when defined so exactOptionalPropertyTypes is satisfied without
  // casting away verifier type errors.
  const registrationWire: RegistrationResponseJSON = {
    id: reg.id,
    rawId: reg.rawId,
    type: 'public-key',
    response: {
      clientDataJSON: reg.response.clientDataJSON,
      attestationObject: reg.response.attestationObject,
      ...(reg.response.authenticatorData !== undefined
        ? { authenticatorData: reg.response.authenticatorData }
        : {}),
      ...(reg.response.publicKey !== undefined
        ? { publicKey: reg.response.publicKey }
        : {}),
      ...(reg.response.publicKeyAlgorithm !== undefined
        ? { publicKeyAlgorithm: reg.response.publicKeyAlgorithm }
        : {}),
      ...(reg.response.transports !== undefined
        ? { transports: reg.response.transports }
        : {}),
    },
    clientExtensionResults: {
      ...(reg.clientExtensionResults.credProps !== undefined
        ? { credProps: reg.clientExtensionResults.credProps }
        : {}),
    },
    ...(reg.authenticatorAttachment !== undefined
      ? { authenticatorAttachment: reg.authenticatorAttachment }
      : {}),
  };

  let verification: Awaited<ReturnType<typeof verifyRegistrationResponse>>;
  try {
    verification = await verifyRegistrationResponse({
      response: registrationWire,
      expectedChallenge: parsedChallenge.data,
      expectedOrigin: cfg.origin,
      expectedRPID: cfg.rpId,
      requireUserVerification: true,
      supportedAlgorithmIDs: [-7, -257],
    });
  } catch {
    fail();
  }

  if (!verification.verified || !verification.registrationInfo) fail();

  const info = verification.registrationInfo;
  const credential = info.credential;
  if (!credential) fail();

  const proof = parsePasskeyProof({
    credentialId: credential.id,
    publicKey: credential.publicKey,
    counter: credential.counter,
    deviceType: info.credentialDeviceType,
    backedUp: info.credentialBackedUp,
    transports: credential.transports ?? [],
  });
  return proof;
}

const authenticationSchema = z
  .object({
    id: credentialIdSchema,
    rawId: credentialIdSchema,
    type: z.literal('public-key'),
    response: z
      .object({
        clientDataJSON: canonicalB64url(1, 8192),
        authenticatorData: canonicalB64url(1, 4096),
        signature: canonicalB64url(1, 4096),
        userHandle: canonicalB64url(1, 128).optional(),
      })
      .strict(),
    clientExtensionResults: clientExtensionResultsSchema.default({}),
    authenticatorAttachment: z
      .enum(['platform', 'cross-platform'])
      .optional(),
  })
  .strict();

export async function verifyPasskeyAuthentication(
  response: unknown,
  expectedChallenge: string,
  config: AuthOriginConfig,
  credential: PasskeyProof,
): Promise<{ newCounter: number; backedUp: boolean }> {
  const cfg = validateAuthOriginConfig(config);
  const parsedChallenge = challengeSchema.safeParse(expectedChallenge);
  if (!parsedChallenge.success) fail();

  const stored = parsePasskeyProof(credential);

  const parsedResponse = authenticationSchema.safeParse(response);
  if (!parsedResponse.success) fail();
  const auth = parsedResponse.data;
  if (auth.id !== auth.rawId) fail();
  if (auth.id !== stored.credentialId) fail();

  const authenticationWire: AuthenticationResponseJSON = {
    id: auth.id,
    rawId: auth.rawId,
    type: 'public-key',
    response: {
      clientDataJSON: auth.response.clientDataJSON,
      authenticatorData: auth.response.authenticatorData,
      signature: auth.response.signature,
      ...(auth.response.userHandle !== undefined
        ? { userHandle: auth.response.userHandle }
        : {}),
    },
    clientExtensionResults: {
      ...(auth.clientExtensionResults.credProps !== undefined
        ? { credProps: auth.clientExtensionResults.credProps }
        : {}),
    },
    ...(auth.authenticatorAttachment !== undefined
      ? { authenticatorAttachment: auth.authenticatorAttachment }
      : {}),
  };

  let verification: Awaited<ReturnType<typeof verifyAuthenticationResponse>>;
  try {
    verification = await verifyAuthenticationResponse({
      response: authenticationWire,
      expectedChallenge: parsedChallenge.data,
      expectedOrigin: cfg.origin,
      expectedRPID: cfg.rpId,
      requireUserVerification: true,
      credential: {
        id: stored.credentialId,
        publicKey: new Uint8Array(stored.publicKey),
        counter: stored.counter,
        transports: stored.transports,
      },
    });
  } catch {
    fail();
  }

  if (!verification.verified) fail();
  if (!verification.authenticationInfo) fail();

  // Backup eligibility is immutable: deviceType and credentialID must match
  // the stored proof. backedUp may legitimately change.
  if (verification.authenticationInfo.credentialDeviceType !== stored.deviceType)
    fail();
  if (verification.authenticationInfo.credentialID !== stored.credentialId) fail();

  const newCounter = counterSchema.safeParse(
    verification.authenticationInfo.newCounter,
  );
  if (!newCounter.success) fail();
  const backedUp = z
    .boolean()
    .safeParse(verification.authenticationInfo.credentialBackedUp);
  if (!backedUp.success) fail();

  // A single-device credential cannot be backed up.
  if (stored.deviceType === 'singleDevice' && backedUp.data) fail();

  return { newCounter: newCounter.data, backedUp: backedUp.data };
}

/* ------------------------------------------------------------------ */
/* EOA SIWE wallet login (no contract wallets, no network)             */
/* ------------------------------------------------------------------ */

export interface WalletLoginContext {
  address: string;
  nonce: string;
  issuedAt: Date;
  config: AuthOriginConfig;
}

export const WALLET_LOGIN_STATEMENT =
  'Sign in to OpenArc. This does not authorize payments.';
export const WALLET_LOGIN_CHAIN_ID = 5_042_002;
export const WALLET_LOGIN_EXPIRY_MS = 5 * 60 * 1000;

const addressSchema = z
  .string()
  .length(42)
  .regex(/^0x[0-9a-fA-F]{40}$/)
  .refine((a) => isAddress(a, { strict: true }));
const nonceSchema = z.string().length(32).regex(/^[0-9a-f]{32}$/);

const walletContextSchema = z
  .object({
    address: addressSchema,
    nonce: nonceSchema,
    issuedAt: z
      .date()
      .refine((d) => Number.isFinite(d.getTime())),
    config: OriginConfigSchema,
  })
  .strict();

function parseContext(context: unknown): {
  address: `0x${string}`;
  nonce: string;
  issuedAt: Date;
  config: AuthOriginConfig;
} {
  const parsed = walletContextSchema.safeParse(context);
  if (!parsed.success) fail();
  const cfg = validateAuthOriginConfig(parsed.data.config);

  let checksummed: `0x${string}`;
  try {
    checksummed = getAddress(parsed.data.address as `0x${string}`);
  } catch {
    fail();
  }

  return {
    address: checksummed,
    nonce: parsed.data.nonce,
    issuedAt: parsed.data.issuedAt,
    config: cfg,
  };
}

function buildMessage(
  address: `0x${string}`,
  nonce: string,
  issuedAt: Date,
  config: AuthOriginConfig,
): string {
  const origin = new URL(config.origin);
  return createSiweMessage({
    address,
    chainId: WALLET_LOGIN_CHAIN_ID,
    domain: origin.host,
    uri: `${config.origin}/account`,
    version: '1',
    statement: WALLET_LOGIN_STATEMENT,
    nonce,
    issuedAt,
    expirationTime: new Date(issuedAt.getTime() + WALLET_LOGIN_EXPIRY_MS),
    scheme: origin.protocol.replace(':', ''),
  });
}

export function createWalletLoginMessage(context: WalletLoginContext): string {
  const parsed = parseContext(context);
  try {
    return buildMessage(
      parsed.address,
      parsed.nonce,
      parsed.issuedAt,
      parsed.config,
    );
  } catch {
    fail();
  }
}

const signatureSchema = z
  .string()
  .length(132)
  .regex(/^0x[0-9a-fA-F]{130}$/);

export async function verifyWalletLoginProof(
  message: string,
  signature: string,
  context: WalletLoginContext,
  now: Date,
): Promise<string> {
  const parsed = parseContext(context);
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) fail();

  const parsedMessage = z.string().min(1).max(4096).safeParse(message);
  if (!parsedMessage.success) fail();
  const parsedSignature = signatureSchema.safeParse(signature);
  if (!parsedSignature.success) fail();

  let expected: string;
  try {
    expected = buildMessage(
      parsed.address,
      parsed.nonce,
      parsed.issuedAt,
      parsed.config,
    );
  } catch {
    fail();
  }
  // Never trust parsed caller fields: byte-exact local comparison.
  if (parsedMessage.data !== expected) fail();

  const expiry = parsed.issuedAt.getTime() + WALLET_LOGIN_EXPIRY_MS;
  const t = now.getTime();
  if (t < parsed.issuedAt.getTime() || t >= expiry) fail();

  let valid: boolean;
  try {
    valid = await verifyMessage({
      address: parsed.address,
      message: parsedMessage.data,
      signature: parsedSignature.data as `0x${string}`,
    });
  } catch {
    fail();
  }
  if (!valid) fail();

  return parsed.address.toLowerCase();
}
