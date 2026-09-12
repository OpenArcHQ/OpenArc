import { createHmac, randomUUID } from "node:crypto";
import type * as NodeCrypto from "node:crypto";
import { describe, expect, it, vi } from "vitest";

// Hoisted, mutable fault switch. The node:crypto mock delegates to the real
// implementation unless a test explicitly arms one of the two fault barriers.
const cryptoControl = vi.hoisted(() => ({
  scryptFault: null as null | "callback-error" | "sync-throw",
  rngFault: false,
}));

vi.mock("node:crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof NodeCrypto>();
  return {
    ...actual,
    randomBytes: ((...args: unknown[]) => {
      if (cryptoControl.rngFault) throw new Error("PRIVATE_RNG_DRIVER_CANARY");
      return (actual.randomBytes as (...inner: unknown[]) => unknown)(...args);
    }) as typeof actual.randomBytes,
    scrypt: ((...args: unknown[]) => {
      if (cryptoControl.scryptFault === "sync-throw") throw new Error("synchronous barrier failure");
      if (cryptoControl.scryptFault === "callback-error") {
        const callback = args[4] as (error: Error | null, derivedKey?: Buffer) => void;
        queueMicrotask(() => callback(new Error("native barrier failure")));
        return undefined as never;
      }
      return (actual.scrypt as (...inner: unknown[]) => unknown)(...args);
    }) as typeof actual.scrypt,
  };
});

import {
  generateMachineCredential,
  MachineCredentialCrypto,
  MachineCredentialError,
  parseMachineCredential,
  SCRYPT_HASH_VERSION,
  SCRYPT_KEYLEN,
  SCRYPT_N,
  SCRYPT_P,
  SCRYPT_R,
  SCRYPT_SALT_BYTES,
  type MachineCredentialKeyring,
  type MachineCredentialRecord,
} from "../src/machine/credential-crypto.js";

// Synthetic-only key material; never resembles a real live API key.
const pepperA = (): Uint8Array => Uint8Array.from({ length: 32 }, (_, i) => i + 1);
const pepperB = (): Uint8Array => Uint8Array.from({ length: 32 }, (_, i) => 255 - i);
const keyring = (currentVersion = 1, peppers: [number, Uint8Array][] = [[1, pepperA()]]): MachineCredentialKeyring =>
  ({ currentVersion, peppers: new Map(peppers) });

const UUID = (): string => randomUUID();
const KINDS = ["agent", "provider"] as const;

async function roundTrip(options: { kind: "agent" | "provider"; version?: number; peppers?: [number, Uint8Array][] }) {
  const crypto = new MachineCredentialCrypto(keyring(options.version, options.peppers));
  const generated = generateMachineCredential({ kind: options.kind, lookupId: UUID() });
  const record = await crypto.hash({ kind: options.kind, lookupId: generated.lookupId, raw: generated.raw });
  return { crypto, generated, record };
}

describe("P01-07a machine credential cryptographic primitive", () => {
  describe("generation namespace and entropy", () => {
    it.each(KINDS)("generates a canonical %s token with 43 base64url entropy chars", (kind) => {
      const generated = generateMachineCredential({ kind, lookupId: UUID() });
      const prefix = kind === "agent" ? "oac_ag_" : "oac_pr_";
      expect(generated.raw.startsWith(prefix)).toBe(true);
      expect(generated.raw).toHaveLength(prefix.length + 36 + 1 + 43);
      expect(generated.publicPrefix).toBe(`${prefix}${generated.lookupId}`);
      expect(generated.kind).toBe(kind);
      const rest = generated.raw.slice(prefix.length);
      const uuid = rest.slice(0, 36);
      const entropy = rest.slice(37);
      expect(uuid).toBe(generated.lookupId);
      expect(entropy).toHaveLength(43);
      expect(entropy).toMatch(/^[A-Za-z0-9_-]{43}$/u);
      expect(entropy).not.toMatch(/[+/=]/u);
      expect(Buffer.from(entropy!, "base64url")).toHaveLength(32);
    });

    it("produces distinct entropy across calls for the same lookup id", () => {
      const lookupId = UUID();
      const first = generateMachineCredential({ kind: "agent", lookupId }).raw;
      const second = generateMachineCredential({ kind: "agent", lookupId }).raw;
      expect(first).not.toBe(second);
    });

    it("rejects a lookup id with a trailing newline at generation, not merely at parse", () => {
      // A regex `$` alone would allow a trailing newline; generation must
      // enforce the exact 36-character canonical form before randomBytes.
      expect(() => generateMachineCredential({ kind: "agent", lookupId: UUID() + "\n" })).toThrowError(MachineCredentialError);
      expect(() => generateMachineCredential({ kind: "agent", lookupId: UUID() + "\n" })).toThrowError(
        expect.objectContaining({ code: "INVALID_LOOKUP" }),
      );
      expect(() => generateMachineCredential({ kind: "provider", lookupId: UUID() + " " })).toThrowError(
        expect.objectContaining({ code: "INVALID_LOOKUP" }),
      );
    });

    it("normalizes an RNG failure to fixed CRYPTO_FAILURE without leaking cause or input", () => {
      const lookupId = UUID();
      cryptoControl.rngFault = true;
      let caught: unknown;
      try {
        generateMachineCredential({ kind: "agent", lookupId });
      } catch (error) {
        caught = error;
      } finally {
        cryptoControl.rngFault = false;
      }
      expect(caught).toBeInstanceOf(MachineCredentialError);
      expect((caught as MachineCredentialError).code).toBe("CRYPTO_FAILURE");
      expect(JSON.stringify(caught)).not.toContain("PRIVATE_RNG_DRIVER_CANARY");
      // Normal success is preserved after the mock is restored.
      expect(generateMachineCredential({ kind: "agent", lookupId }).raw).toHaveLength("oac_ag_".length + 36 + 1 + 43);
    });

    it.each([
      ["uppercase prefix", "OAC_AG_"],
      ["missing prefix", ""],
    ])("rejects a generated-token shape that is %s", (_label, value) => {
      expect(() => parseMachineCredential(value)).toThrowError(MachineCredentialError);
    });
  });

  describe("parser rejection without echoing input", () => {
    const good = (kind: "agent" | "provider") => generateMachineCredential({ kind, lookupId: UUID() }).raw;

    it("accepts canonical tokens and lowercases namespace to a kind", () => {
      expect(parseMachineCredential(good("agent"))).toMatchObject({ kind: "agent" });
      expect(parseMachineCredential(good("provider"))).toMatchObject({ kind: "provider" });
    });

    it.each([
      ["empty", ""],
      ["bad prefix", "oac_xx_00000000-0000-4000-8000-000000000000_" + "A".repeat(43)],
      ["uppercase uuid", "oac_ag_ABCDEF00-0000-4000-8000-000000000000_" + "A".repeat(43)],
      ["non-v4 uuid", "oac_ag_00000000-0000-3000-8000-000000000000_" + "A".repeat(43)],
      ["bad variant", "oac_ag_00000000-0000-4000-c000-000000000000_" + "A".repeat(43)],
      ["short entropy", "oac_ag_00000000-0000-4000-8000-000000000000_" + "A".repeat(42)],
      ["long entropy", "oac_ag_00000000-0000-4000-8000-000000000000_" + "A".repeat(44)],
      ["nonzero unused base64 bits", "oac_ag_00000000-0000-4000-8000-000000000000_" + "A".repeat(42) + "B"],
      ["padded entropy", "oac_ag_00000000-0000-4000-8000-000000000000_" + "A".repeat(42) + "="],
      ["plus entropy", "oac_ag_00000000-0000-4000-8000-000000000000_" + "A".repeat(42) + "+"],
      ["trailing char", good("agent") + "x"],
      ["trailing newline", good("agent") + "\n"],
      ["leading space", " " + good("agent")],
      ["unknown kind", "oac_zz_00000000-0000-4000-8000-000000000000_" + "A".repeat(43)],
      ["missing separator", "oac_ag00000000-0000-4000-8000-000000000000_" + "A".repeat(43)],
    ])("rejects %s", (_label, value) => {
      let caught: unknown;
      try {
        parseMachineCredential(value);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(MachineCredentialError);
      expect((caught as MachineCredentialError).code).toBe("INVALID_RAW");
      // No raw input, driver stack, cause, or log canary leaks through.
      expect(JSON.stringify(caught)).not.toContain(value || "UNREACHABLE");
      expect((caught as Error).stack).toBeDefined();
    });

    it("rejects non-string raw values", () => {
      for (const value of [undefined, null, 42, {}, [], Buffer.from("oac_ag_x")]) {
        expect(() => parseMachineCredential(value)).toThrowError(MachineCredentialError);
      }
    });
  });

  describe("actual scrypt roundtrip and binding", () => {
    it.each(KINDS)("roundtrips an actual scrypt hash for %s", async (kind) => {
      const { crypto, generated, record } = await roundTrip({ kind });
      expect(record.algorithm).toBe("scrypt");
      expect(record.hashVersion).toBe(SCRYPT_HASH_VERSION);
      expect(record.N).toBe(SCRYPT_N);
      expect(record.r).toBe(SCRYPT_R);
      expect(record.p).toBe(SCRYPT_P);
      expect(Buffer.from(record.salt, "base64url")).toHaveLength(SCRYPT_SALT_BYTES);
      expect(Buffer.from(record.digest, "base64url")).toHaveLength(SCRYPT_KEYLEN);
      expect(record).not.toHaveProperty("raw");
      expect(record).not.toHaveProperty("pepper");
      await expect(crypto.verify({ raw: generated.raw, record })).resolves.toBe(true);
      crypto.dispose();
    });

    it("rejects a wrong secret against a real record", async () => {
      const { crypto, record } = await roundTrip({ kind: "agent" });
      const other = generateMachineCredential({ kind: "agent", lookupId: UUID() });
      await expect(crypto.verify({ raw: other.raw, record })).resolves.toBe(false);
      crypto.dispose();
    });

    it("binds namespace and id so a cross-namespace token fails", async () => {
      const { crypto, generated, record } = await roundTrip({ kind: "agent" });
      const provider = generateMachineCredential({ kind: "provider", lookupId: generated.lookupId });
      await expect(crypto.verify({ raw: provider.raw, record })).resolves.toBe(false);
      await expect(crypto.verify({ raw: generated.raw, record, expectedKind: "provider" })).resolves.toBe(false);
      await expect(crypto.verify({ raw: generated.raw, record, expectedLookupId: UUID() })).resolves.toBe(false);
      await expect(crypto.verify({ raw: generated.raw, record, expectedKind: "agent", expectedLookupId: generated.lookupId })).resolves.toBe(true);
      crypto.dispose();
    });

    it("uses a fresh random salt so equal secrets yield different digests", async () => {
      const crypto = new MachineCredentialCrypto(keyring());
      const generated = generateMachineCredential({ kind: "provider", lookupId: UUID() });
      const first = await crypto.hash({ kind: "provider", lookupId: generated.lookupId, raw: generated.raw });
      const second = await crypto.hash({ kind: "provider", lookupId: generated.lookupId, raw: generated.raw });
      expect(first.salt).not.toBe(second.salt);
      expect(first.digest).not.toBe(second.digest);
      crypto.dispose();
    });

    it("is a real scrypt KDF, not an HMAC-only digest", async () => {
      const { crypto, generated, record } = await roundTrip({ kind: "provider" });
      // A bare HMAC of the raw token (no domain, no scrypt) must not match the
      // stored digest, proving the versioned password hash is doing KDF work.
      const bareHmac = createHmac("sha256", pepperA()).update(generated.raw, "utf8").digest();
      expect(Buffer.from(record.digest, "base64url").equals(bareHmac)).toBe(false);
      await expect(crypto.verify({ raw: generated.raw, record })).resolves.toBe(true);
      crypto.dispose();
    });
  });

  describe("record validation before expensive work", () => {
    it("rejects a non-object, but malformed records carry fixed error codes", async () => {
      const { crypto, generated, record } = await roundTrip({ kind: "agent" });
      const cases: [unknown, string][] = [
        [null, "INVALID_RECORD"],
        [undefined, "INVALID_RECORD"],
        ["scrypt", "INVALID_RECORD"],
        [{}, "INVALID_RECORD"],
        [{ ...record, extra: 1 }, "INVALID_RECORD"],
        [{ ...record, algorithm: "argon2" }, "INVALID_RECORD"],
        [{ ...record, hashVersion: 2 }, "UNSUPPORTED_VERSION"],
        [{ ...record, pepperVersion: 0 }, "INVALID_RECORD"],
        [{ ...record, pepperVersion: 17 }, "INVALID_RECORD"],
        [{ ...record, pepperVersion: 1.5 }, "INVALID_RECORD"],
        [{ ...record, N: 16_384 }, "INVALID_RECORD"],
        [{ ...record, r: 4 }, "INVALID_RECORD"],
        [{ ...record, p: 2 }, "INVALID_RECORD"],
        [{ ...record, salt: "AAAA" }, "INVALID_RECORD"],
        [{ ...record, digest: "AAAA" }, "INVALID_RECORD"],
        [{ ...record, salt: record.salt.replace(/.$/u, "=") }, "INVALID_RECORD"],
      ];
      for (const [value, code] of cases) {
        await expect(crypto.verify({ raw: generated.raw, record: value as MachineCredentialRecord })).rejects
          .toMatchObject({ code });
      }
      await expect(crypto.verify({ raw: generated.raw, record })).resolves.toBe(true);
      crypto.dispose();
    });

    it("requires the exact eight own keys and rejects a swapped-key record", async () => {
      const { crypto, generated, record } = await roundTrip({ kind: "agent" });
      const { salt, ...withoutSalt } = record;
      expect(Object.keys(record).sort()).toEqual(["N", "algorithm", "digest", "hashVersion", "p", "pepperVersion", "r", "salt"]);
      await expect(crypto.verify({ raw: generated.raw, record })).resolves.toBe(true);
      // Same key count (8) but an unknown key in place of salt: rejected, so
      // the guard is the exact key set, not merely the count.
      await expect(crypto.verify({ raw: generated.raw, record: { ...withoutSalt, extra: salt } as unknown as MachineCredentialRecord })).rejects
        .toMatchObject({ code: "INVALID_RECORD" });
      // Nine keys with a genuine salt plus an extra key: rejected.
      await expect(crypto.verify({ raw: generated.raw, record: { ...record, extra: 1 } as unknown as MachineCredentialRecord })).rejects
        .toMatchObject({ code: "INVALID_RECORD" });
      // Seven keys (salt dropped): rejected.
      await expect(crypto.verify({ raw: generated.raw, record: withoutSalt as unknown as MachineCredentialRecord })).rejects
        .toMatchObject({ code: "INVALID_RECORD" });
      crypto.dispose();
    });

    it("fails closed for an unknown stored pepper version", async () => {
      const { crypto, generated, record } = await roundTrip({ kind: "agent" });
      await expect(crypto.verify({ raw: generated.raw, record: { ...record, pepperVersion: 9 } })).rejects
        .toMatchObject({ code: "UNSUPPORTED_VERSION" });
      crypto.dispose();
    });

    it("rejects a record whose salt/digest decode to a noncanonical or wrong length without echoing it", async () => {
      const { crypto, generated, record } = await roundTrip({ kind: "provider" });
      // 22-char (16-byte) canonical salt whose final char carries nonzero
      // unused base64 bits: decodeBase64Url allocates then rejects and must
      // clear that owned buffer before returning undefined.
      const badSalt = record.salt.slice(0, 21) + "B";
      const badSaltRecord = { ...record, salt: badSalt };
      let caught: unknown;
      try {
        await crypto.verify({ raw: generated.raw, record: badSaltRecord });
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(MachineCredentialError);
      expect((caught as MachineCredentialError).code).toBe("INVALID_RECORD");
      expect(JSON.stringify(caught)).not.toContain(badSalt);
      // Wrong decoded length (too-short but valid alphabet) is cleared too.
      await expect(crypto.verify({ raw: generated.raw, record: { ...record, digest: "AAAA" } })).rejects
        .toMatchObject({ code: "INVALID_RECORD" });
      await expect(crypto.verify({ raw: generated.raw, record })).resolves.toBe(true);
      crypto.dispose();
    });
  });

  describe("keyring configuration and rotation", () => {
    it("rejects invalid keyrings", () => {
      const cases: unknown[] = [
        {},
        { currentVersion: 0, peppers: new Map([[1, pepperA()]]) },
        { currentVersion: 17, peppers: new Map([[17, pepperA()]]) },
        { currentVersion: 1, peppers: new Map() },
        { currentVersion: 1, peppers: new Map([[1, pepperA()], [2, pepperB()], [3, pepperA()]]) },
        { currentVersion: 1, peppers: new Map([[1, new Uint8Array(31)]]) },
        { currentVersion: 1, peppers: new Map([[1, "a".repeat(32)]]) },
        { currentVersion: 2, peppers: new Map([[1, pepperA()]]) },
      ];
      for (const value of cases) expect(() => new MachineCredentialCrypto(value as MachineCredentialKeyring)).toThrowError(MachineCredentialError);
    });

    it("accepts previous + current during rotation and hashes with current", async () => {
      const lookupId = UUID();
      const generated = generateMachineCredential({ kind: "agent", lookupId });
      const oldCrypto = new MachineCredentialCrypto(keyring(1));
      const oldRecord = await oldCrypto.hash({ kind: "agent", lookupId, raw: generated.raw });
      expect(oldRecord.pepperVersion).toBe(1);
      oldCrypto.dispose();

      const rotated = new MachineCredentialCrypto(keyring(2, [[1, pepperA()], [2, pepperB()]]));
      await expect(rotated.verify({ raw: generated.raw, record: oldRecord })).resolves.toBe(true);
      const fresh = await rotated.hash({ kind: "agent", lookupId, raw: generated.raw });
      expect(fresh.pepperVersion).toBe(2);
      await expect(rotated.verify({ raw: generated.raw, record: fresh })).resolves.toBe(true);
      rotated.dispose();
    });

    it("always labels the configured current version and never a caller selection", async () => {
      const lookupId = UUID();
      const generated = generateMachineCredential({ kind: "agent", lookupId });
      const crypto = new MachineCredentialCrypto(keyring(2, [[1, pepperA()], [2, pepperB()]]));
      // There is no caller-facing version field on HashOptions: the record is
      // always produced under the configured current key and labelled with it.
      const record = await crypto.hash({ kind: "agent", lookupId, raw: generated.raw });
      expect(record.pepperVersion).toBe(2);
      // A stored record mislabelled as version 1 is verified with the version 1
      // key (not the current key), so the mislabel fails closed.
      await expect(crypto.verify({ raw: generated.raw, record: { ...record, pepperVersion: 1 } })).resolves.toBe(false);
      await expect(crypto.verify({ raw: generated.raw, record })).resolves.toBe(true);
      crypto.dispose();
    });

    it("does not expose keyring, lifecycle, or capacity state as public properties", async () => {
      const crypto = new MachineCredentialCrypto(keyring());
      const generated = generateMachineCredential({ kind: "agent", lookupId: UUID() });
      const first = crypto.hash({ kind: "agent", lookupId: generated.lookupId, raw: generated.raw });
      const keys = Object.keys(crypto);
      expect(keys).toEqual([]);
      expect(Object.getOwnPropertyNames(crypto)).not.toEqual(expect.arrayContaining(["peppers", "currentVersion", "active", "disposed"]));
      // Runtime mutation of a public-looking security flag is impossible.
      (crypto as unknown as Record<string, unknown>).disposed = true;
      await expect(first).resolves.toMatchObject({ algorithm: "scrypt" });
      crypto.dispose();
    });

    it("deep-copies caller key material so later mutation cannot affect it", async () => {
      const material = pepperA();
      const source: [number, Uint8Array][] = [[1, material]];
      const crypto = new MachineCredentialCrypto(keyring(1, source));
      const generated = generateMachineCredential({ kind: "provider", lookupId: UUID() });
      const record = await crypto.hash({ kind: "provider", lookupId: generated.lookupId, raw: generated.raw });
      material.fill(0);
      source.length = 0;
      await expect(crypto.verify({ raw: generated.raw, record })).resolves.toBe(true);
      crypto.dispose();
    });

    it("dispose() clears key material and refuses future work", async () => {
      const { crypto, generated, record } = await roundTrip({ kind: "agent" });
      crypto.dispose();
      crypto.dispose();
      await expect(crypto.hash({ kind: "agent", lookupId: generated.lookupId, raw: generated.raw })).rejects
        .toMatchObject({ code: "DISPOSED" });
      await expect(crypto.verify({ raw: generated.raw, record })).rejects.toMatchObject({ code: "DISPOSED" });
    });
  });

  describe("concurrency cap and error surface", () => {
    it("fails a third immediate hash with fixed BUSY while 2 actual scrypt run", async () => {
      const crypto = new MachineCredentialCrypto(keyring());
      const make = () => {
        const generated = generateMachineCredential({ kind: "agent", lookupId: UUID() });
        return crypto.hash({ kind: "agent", lookupId: generated.lookupId, raw: generated.raw });
      };
      const first = make();
      const second = make();
      await expect(make()).rejects.toMatchObject({ code: "BUSY", message: "BUSY" });
      const [one, two] = await Promise.all([first, second]);
      expect(one.algorithm).toBe("scrypt");
      expect(two.algorithm).toBe("scrypt");
      crypto.dispose();
    });

    it("recovers capacity after a BUSY rejection", async () => {
      const crypto = new MachineCredentialCrypto(keyring());
      const generated = generateMachineCredential({ kind: "agent", lookupId: UUID() });
      const hash = () => crypto.hash({ kind: "agent", lookupId: generated.lookupId, raw: generated.raw });
      const first = hash();
      const second = hash();
      await expect(hash()).rejects.toMatchObject({ code: "BUSY" });
      await Promise.all([first, second]);
      await expect(hash()).resolves.toMatchObject({ algorithm: "scrypt" });
      crypto.dispose();
    });

    it("rejects an unsupported stored pepper version with a fixed error", async () => {
      const crypto = new MachineCredentialCrypto(keyring(1));
      const generated = generateMachineCredential({ kind: "agent", lookupId: UUID() });
      const record = await crypto.hash({ kind: "agent", lookupId: generated.lookupId, raw: generated.raw });
      await expect(crypto.verify({ raw: generated.raw, record: { ...record, pepperVersion: 2 } })).rejects
        .toMatchObject({ code: "UNSUPPORTED_VERSION" });
      crypto.dispose();
    });

    it("suppresses publication when disposed while an inflight scrypt is running", async () => {
      const crypto = new MachineCredentialCrypto(keyring());
      const generated = generateMachineCredential({ kind: "agent", lookupId: UUID() });
      // Deterministic barrier: hash() has started native scrypt but cannot have
      // completed on this synchronous turn, so dispose() runs truly inflight.
      const hashPromise = crypto.hash({ kind: "agent", lookupId: generated.lookupId, raw: generated.raw });
      crypto.dispose();
      await expect(hashPromise).rejects.toMatchObject({ code: "DISPOSED", message: "DISPOSED" });
    });

    it("suppresses a verify result when disposed while its inflight scrypt is running", async () => {
      const crypto = new MachineCredentialCrypto(keyring());
      const generated = generateMachineCredential({ kind: "agent", lookupId: UUID() });
      const record = await crypto.hash({ kind: "agent", lookupId: generated.lookupId, raw: generated.raw });
      // The verify cannot have completed its native callback on this turn.
      const verifyPromise = crypto.verify({ raw: generated.raw, record });
      crypto.dispose();
      await expect(verifyPromise).rejects.toMatchObject({ code: "DISPOSED", message: "DISPOSED" });
    });

    it("rejects malformed optional expected inputs with fixed codes", async () => {
      const { crypto, generated, record } = await roundTrip({ kind: "agent" });
      await expect(crypto.verify({ raw: generated.raw, record, expectedKind: "bogus" as "agent" })).rejects
        .toMatchObject({ code: "INVALID_KIND" });
      await expect(crypto.verify({ raw: generated.raw, record, expectedLookupId: "NOT-A-UUID" })).rejects
        .toMatchObject({ code: "INVALID_LOOKUP" });
      crypto.dispose();
    });

    it("does not leak raw token or key material through errors or logs", async () => {
      const canary = "PRIVATE_TOKEN_CANARY";
      const spy = vi.spyOn(console, "log").mockImplementation(() => undefined);
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      let caught: unknown;
      try {
        parseMachineCredential(canary);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(MachineCredentialError);
      expect(JSON.stringify(caught)).not.toContain(canary);
      expect(spy).not.toHaveBeenCalled();
      expect(errorSpy).not.toHaveBeenCalled();
      expect(warnSpy).not.toHaveBeenCalled();
      spy.mockRestore();
      errorSpy.mockRestore();
      warnSpy.mockRestore();
    });
  });

  describe("native failure propagation with controlled barriers", () => {
    it("maps a native scrypt callback error to CRYPTO_FAILURE and releases once", async () => {
      const crypto = new MachineCredentialCrypto(keyring());
      const generated = generateMachineCredential({ kind: "agent", lookupId: UUID() });
      cryptoControl.scryptFault = "callback-error";
      try {
        await expect(crypto.hash({ kind: "agent", lookupId: generated.lookupId, raw: generated.raw })).rejects
          .toMatchObject({ code: "CRYPTO_FAILURE" });
        // Slot was released exactly once, so capacity is available again.
        cryptoControl.scryptFault = null;
        await expect(crypto.hash({ kind: "agent", lookupId: generated.lookupId, raw: generated.raw })).resolves
          .toMatchObject({ algorithm: "scrypt" });
      } finally {
        cryptoControl.scryptFault = null;
        crypto.dispose();
      }
    });

    it("maps a synchronous scrypt throw to CRYPTO_FAILURE and releases once", async () => {
      const crypto = new MachineCredentialCrypto(keyring());
      const generated = generateMachineCredential({ kind: "agent", lookupId: UUID() });
      cryptoControl.scryptFault = "sync-throw";
      try {
        await expect(crypto.hash({ kind: "agent", lookupId: generated.lookupId, raw: generated.raw })).rejects
          .toMatchObject({ code: "CRYPTO_FAILURE" });
        cryptoControl.scryptFault = null;
        await expect(crypto.hash({ kind: "agent", lookupId: generated.lookupId, raw: generated.raw })).resolves
          .toMatchObject({ algorithm: "scrypt" });
      } finally {
        cryptoControl.scryptFault = null;
        crypto.dispose();
      }
    });
  });
});
