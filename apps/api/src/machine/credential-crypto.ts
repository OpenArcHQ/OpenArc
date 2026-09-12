/**
 * P01-07a machine credential cryptographic primitive.
 *
 * Pure helper only: it does NOT authorize a caller, issue a durable credential,
 * or own any one-time-display lifecycle. Later SQL/service code rechecks
 * ownership/expiry/revocation/current-proof atomically. No HTTP endpoint or DB
 * side effect lives here.
 *
 * Passwords are NEVER user passwords. Inputs are 256-bit random machine
 * credentials only. The high scrypt cost parameters below are intentionally
 * frozen for that random-secret use case.
 */
import { createHmac, randomBytes, scrypt, timingSafeEqual } from "node:crypto";

export type MachineCredentialKind = "agent" | "provider";

export type MachineCredentialErrorCode =
  | "INVALID_RAW"
  | "INVALID_KIND"
  | "INVALID_LOOKUP"
  | "INVALID_RECORD"
  | "INVALID_CONFIG"
  | "UNSUPPORTED_VERSION"
  | "BUSY"
  | "DISPOSED"
  | "CRYPTO_FAILURE";

/** Fixed, small, input-free error surface. Never carries raw input or causes. */
export class MachineCredentialError extends Error {
  readonly code: MachineCredentialErrorCode;
  constructor(code: MachineCredentialErrorCode) {
    super(code);
    this.name = "MachineCredentialError";
    this.code = code;
  }
}

/** Domain separator bound into the HMAC prehash; binds namespace and id. */
export const MACHINE_CREDENTIAL_DOMAIN = "openarc.machine.credential.v1\0";

export const SCRYPT_HASH_VERSION = 1;
export const SCRYPT_N = 32_768;
export const SCRYPT_R = 8;
export const SCRYPT_P = 1;
export const SCRYPT_MAXMEM = 64 * 1024 * 1024;
export const SCRYPT_KEYLEN = 32;
export const SCRYPT_SALT_BYTES = 16;
export const PEPPER_BYTES = 32;
export const MAX_PEPPER_VERSIONS = 2;
export const MIN_PEPPER_VERSION = 1;
export const MAX_PEPPER_VERSION = 16;
export const MAX_CONCURRENT_KDF = 2;
export const TOKEN_ENTROPY_BYTES = 32;

export interface MachineCredentialRecord {
  algorithm: "scrypt";
  hashVersion: number;
  pepperVersion: number;
  N: number;
  r: number;
  p: number;
  salt: string;
  digest: string;
}

export interface GeneratedMachineCredential {
  kind: MachineCredentialKind;
  lookupId: string;
  publicPrefix: string;
  raw: string;
}

export interface MachineCredentialKeyring {
  currentVersion: number;
  peppers: ReadonlyMap<number, Uint8Array>;
}

export interface HashOptions {
  kind: MachineCredentialKind;
  lookupId: string;
  raw: string;
}

export interface VerifyOptions {
  raw: string;
  record: MachineCredentialRecord;
  expectedKind?: MachineCredentialKind;
  expectedLookupId?: string;
}

const PREFIXES: Readonly<Record<MachineCredentialKind, string>> = {
  agent: "oac_ag_",
  provider: "oac_pr_",
};

const TOKEN_ENTROPY_CHARS = 43;
const RECORD_KEYS: ReadonlySet<string> = new Set([
  "algorithm",
  "hashVersion",
  "pepperVersion",
  "N",
  "r",
  "p",
  "salt",
  "digest",
]);
const RAW_TOKEN_LENGTH = "oac_ag_".length + 36 + 1 + TOKEN_ENTROPY_CHARS;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const BASE64URL_UNPADDED = /^[A-Za-z0-9_-]+$/u;
const RAW_TOKEN = /^oac_(ag|pr)_([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})_([A-Za-z0-9_-]{43})$/u;

function fail(code: MachineCredentialErrorCode): never {
  throw new MachineCredentialError(code);
}

function isKind(value: unknown): value is MachineCredentialKind {
  return value === "agent" || value === "provider";
}

function isCanonicalUuidV4(value: unknown): value is string {
  return typeof value === "string" && value.length === 36 && UUID_V4.test(value);
}

function decodeBase64Url(value: unknown, expectedBytes: number): Buffer | undefined {
  if (typeof value !== "string" || value.length === 0 || !BASE64URL_UNPADDED.test(value)) return undefined;
  if (value.length !== Math.ceil((expectedBytes * 4) / 3)) return undefined;
  const buffer = Buffer.from(value, "base64url");
  if (buffer.length !== expectedBytes) {
    buffer.fill(0);
    return undefined;
  }
  if (buffer.toString("base64url") !== value) {
    buffer.fill(0);
    return undefined;
  }
  return buffer;
}

interface ParsedToken {
  kind: MachineCredentialKind;
  lookupId: string;
  raw: string;
}

/** Parse without ever echoing the rejected raw input in the error. */
export function parseMachineCredential(raw: unknown): ParsedToken {
  if (typeof raw !== "string" || raw.length !== RAW_TOKEN_LENGTH) fail("INVALID_RAW");
  const match = RAW_TOKEN.exec(raw);
  if (match === null) fail("INVALID_RAW");
  const kind = match[1] === "ag" ? "agent" : "provider";
  const lookupId = match[2]!;
  if (lookupId.length !== 36) fail("INVALID_RAW");
  // Canonical suffix: decode/re-encode must be an identity, so any nonzero
  // unused base64url bits (noncanonical final char) are rejected.
  const entropy = decodeBase64Url(match[3]!, TOKEN_ENTROPY_BYTES);
  if (entropy === undefined) fail("INVALID_RAW");
  entropy.fill(0);
  return { kind, lookupId, raw };
}

function buildRaw(kind: MachineCredentialKind, lookupId: string, entropy: Buffer): string {
  return `${PREFIXES[kind]}${lookupId}_${entropy.toString("base64url")}`;
}

export interface GenerateOptions {
  kind: MachineCredentialKind;
  lookupId: string;
}

/**
 * Generate a fresh 256-bit random machine credential for an already-validated
 * canonical UUIDv4 lookup id. Caller owns the returned secret and must not log
 * or cache it. No caller-supplied entropy or RNG option exists in production.
 */
export function generateMachineCredential(options: GenerateOptions): GeneratedMachineCredential {
  if (options === null || typeof options !== "object") fail("INVALID_CONFIG");
  const { kind, lookupId } = options;
  if (!isKind(kind)) fail("INVALID_KIND");
  if (!isCanonicalUuidV4(lookupId)) fail("INVALID_LOOKUP");
  let entropy: Buffer;
  try {
    entropy = randomBytes(TOKEN_ENTROPY_BYTES);
  } catch {
    return fail("CRYPTO_FAILURE");
  }
  try {
    return {
      kind,
      lookupId,
      publicPrefix: `${PREFIXES[kind]}${lookupId}`,
      raw: buildRaw(kind, lookupId, entropy),
    };
  } finally {
    entropy.fill(0);
  }
}

const UINT8 = (value: unknown): value is Uint8Array =>
  value instanceof Uint8Array && value.byteLength === PEPPER_BYTES;

function copyPeppers(peppers: ReadonlyMap<number, Uint8Array>): Map<number, Buffer> {
  const copy = new Map<number, Buffer>();
  for (const [version, pepper] of peppers) copy.set(version, Buffer.from(pepper));
  return copy;
}

/**
 * In-process keyring. Key material is deep-copied from the constructor input,
 * never read from the environment and never exposed. Bounded to 1..2 configured
 * versions in 1..16, each exactly 32 bytes. Unknown stored pepper versions fail
 * closed rather than rotating or falling back.
 */
export class MachineCredentialCrypto {
  readonly #peppers: Map<number, Buffer>;
  readonly #currentVersion: number;
  #active = 0;
  #disposed = false;

  constructor(keyring: MachineCredentialKeyring) {
    if (keyring === null || typeof keyring !== "object") fail("INVALID_CONFIG");
    const { currentVersion, peppers } = keyring;
    if (!Number.isInteger(currentVersion) || currentVersion < MIN_PEPPER_VERSION || currentVersion > MAX_PEPPER_VERSION) {
      fail("INVALID_CONFIG");
    }
    if (!(peppers instanceof Map) || peppers.size < 1 || peppers.size > MAX_PEPPER_VERSIONS) fail("INVALID_CONFIG");
    const entries = [...peppers.entries()];
    for (const [version, material] of entries) {
      if (!Number.isInteger(version) || version < MIN_PEPPER_VERSION || version > MAX_PEPPER_VERSION) fail("INVALID_CONFIG");
      if (!UINT8(material)) fail("INVALID_CONFIG");
    }
    if (!peppers.has(currentVersion)) fail("INVALID_CONFIG");
    this.#currentVersion = currentVersion;
    this.#peppers = copyPeppers(peppers);
  }

  /** Zero out owned key material and refuse all future work. Idempotent. */
  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    for (const pepper of this.#peppers.values()) pepper.fill(0);
    this.#peppers.clear();
  }

  /**
   * Hash a parsed credential under the current pepper version. Runs the async
   * scrypt KDF under a strict concurrency cap; a third simultaneous request
   * fails with BUSY rather than queueing unbounded native work.
   */
  async hash(options: HashOptions): Promise<MachineCredentialRecord> {
    if (this.#disposed) fail("DISPOSED");
    const parsed = parseMachineCredential(options?.raw);
    if (!isKind(options.kind) || options.kind !== parsed.kind) fail("INVALID_KIND");
    if (!isCanonicalUuidV4(options.lookupId) || options.lookupId !== parsed.lookupId) fail("INVALID_LOOKUP");
    const pepper = this.#currentPepper();
    this.#acquire();
    let prehash: Buffer | undefined;
    try {
      prehash = this.#prehash(parsed.raw, pepper);
      return await this.#runScrypt(prehash);
    } finally {
      prehash?.fill(0);
      this.#release();
    }
  }

  /**
   * Verify a credential. When expectedKind/expectedLookupId are supplied they
   * are matched against the parsed token BEFORE any KDF work. Only a valid
   * comparison mismatch resolves to `false`; malformed input, unsupported
   * stored versions, busy/disposed state and crypto failures reject with a
   * fixed small error code. No raw input or cause is surfaced.
   */
  async verify(options: VerifyOptions): Promise<boolean> {
    if (this.#disposed) fail("DISPOSED");
    const parsed = parseMachineCredential(options?.raw);
    if (options.expectedKind !== undefined && !isKind(options.expectedKind)) fail("INVALID_KIND");
    if (options.expectedLookupId !== undefined && !isCanonicalUuidV4(options.expectedLookupId)) fail("INVALID_LOOKUP");
    const record = normalizeRecord(options.record);
    if (options.expectedKind !== undefined && options.expectedKind !== parsed.kind) return false;
    if (options.expectedLookupId !== undefined && options.expectedLookupId !== parsed.lookupId) return false;
    const pepper = this.#storedPepper(record.pepperVersion);
    this.#acquire();
    let prehash: Buffer | undefined;
    let salt: Buffer | undefined;
    let expected: Buffer | undefined;
    let derived: Buffer | undefined;
    try {
      prehash = this.#prehash(parsed.raw, pepper);
      salt = Buffer.from(record.salt, "base64url");
      derived = await scryptAsync(prehash, salt, SCRYPT_KEYLEN);
      // Disposal while inflight forfeits publication, but only after the
      // native scrypt callback has actually completed.
      if (this.#disposed) fail("DISPOSED");
      expected = Buffer.from(record.digest, "base64url");
      if (expected.length !== derived.length) return false;
      return timingSafeEqual(expected, derived);
    } finally {
      expected?.fill(0);
      derived?.fill(0);
      salt?.fill(0);
      prehash?.fill(0);
      this.#release();
    }
  }

  /** Acquire one of the bounded KDF slots before any HMAC/KDF work runs. */
  #acquire(): void {
    if (this.#active >= MAX_CONCURRENT_KDF) fail("BUSY");
    this.#active += 1;
  }

  /** Release only after the native scrypt callback has completed. */
  #release(): void {
    this.#active -= 1;
  }

  #currentPepper(): Buffer {
    const pepper = this.#peppers.get(this.#currentVersion);
    if (pepper === undefined) fail("DISPOSED");
    return pepper;
  }

  #storedPepper(version: number): Buffer {
    const pepper = this.#peppers.get(version);
    if (pepper === undefined) fail("UNSUPPORTED_VERSION");
    return pepper;
  }

  #prehash(raw: string, pepper: Buffer): Buffer {
    try {
      const hmac = createHmac("sha256", pepper);
      hmac.update(MACHINE_CREDENTIAL_DOMAIN, "utf8");
      hmac.update(raw, "utf8");
      return hmac.digest();
    } catch {
      return fail("CRYPTO_FAILURE");
    }
  }

  async #runScrypt(prehash: Buffer): Promise<MachineCredentialRecord> {
    let salt: Buffer;
    try {
      salt = randomBytes(SCRYPT_SALT_BYTES);
    } catch {
      return fail("CRYPTO_FAILURE");
    }
    try {
      const digest = await scryptAsync(prehash, salt, SCRYPT_KEYLEN);
      try {
        // Disposal while inflight forfeits publication, but only after the
        // native scrypt callback has actually completed.
        if (this.#disposed) fail("DISPOSED");
        return {
          algorithm: "scrypt",
          hashVersion: SCRYPT_HASH_VERSION,
          pepperVersion: this.#currentVersion,
          N: SCRYPT_N,
          r: SCRYPT_R,
          p: SCRYPT_P,
          salt: salt.toString("base64url"),
          digest: digest.toString("base64url"),
        };
      } finally {
        digest.fill(0);
      }
    } finally {
      salt.fill(0);
    }
  }
}

function scryptAsync(password: Buffer, salt: Buffer, keylen: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    try {
      scrypt(password, salt, keylen, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P, maxmem: SCRYPT_MAXMEM }, (error, derivedKey) => {
        if (error) reject(new MachineCredentialError("CRYPTO_FAILURE"));
        else resolve(derivedKey);
      });
    } catch {
      // Synchronous native/setup throw (bad params/OOM) is normalized too.
      reject(new MachineCredentialError("CRYPTO_FAILURE"));
    }
  });
}

/** Validate stored parameters exactly before trusting them for expensive work. */
function normalizeRecord(value: unknown): MachineCredentialRecord {
  if (value === null || typeof value !== "object") fail("INVALID_RECORD");
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length !== RECORD_KEYS.size) fail("INVALID_RECORD");
  for (const key of keys) if (!RECORD_KEYS.has(key)) fail("INVALID_RECORD");
  if (record.algorithm !== "scrypt") fail("INVALID_RECORD");
  if (record.hashVersion !== SCRYPT_HASH_VERSION) fail("UNSUPPORTED_VERSION");
  if (!Number.isInteger(record.pepperVersion) ||
    (record.pepperVersion as number) < MIN_PEPPER_VERSION || (record.pepperVersion as number) > MAX_PEPPER_VERSION) {
    fail("INVALID_RECORD");
  }
  if (record.N !== SCRYPT_N || record.r !== SCRYPT_R || record.p !== SCRYPT_P) fail("INVALID_RECORD");
  const salt = decodeBase64Url(record.salt, SCRYPT_SALT_BYTES);
  if (salt === undefined) fail("INVALID_RECORD");
  salt.fill(0);
  const digest = decodeBase64Url(record.digest, SCRYPT_KEYLEN);
  if (digest === undefined) fail("INVALID_RECORD");
  digest.fill(0);
  return {
    algorithm: "scrypt",
    hashVersion: SCRYPT_HASH_VERSION,
    pepperVersion: record.pepperVersion as number,
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    salt: record.salt as string,
    digest: record.digest as string,
  };
}
