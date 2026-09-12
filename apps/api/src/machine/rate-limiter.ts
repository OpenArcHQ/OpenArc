import { createHmac } from "node:crypto";

import { AUTH_ERRORS } from "../auth/errors.js";
import type { MachineRateLimitStorePort } from "./ports.js";
import type { MachineCredentialKind } from "./credential-crypto.js";

/**
 * Durable fixed-window machine rate limiting.
 *
 * Every bucket key is an HMAC-SHA256 over a private `MACHINE_RATE_SECRET` and
 * a domain/kind/bucket/value tuple; no raw IP, account id, lookup id or token
 * ever reaches the database. The exact frozen limits are exported for tests.
 * A limiter/store outage fails CLOSED (fixed 503) before any KDF or store
 * mutation, never open.
 */

export const MACHINE_RATE_WINDOW_SECONDS = 60;
export const MACHINE_RATE_DOMAIN = "openarc.machine.rate.v1";

export const MACHINE_RATE_LIMITS = Object.freeze({
  exchange: Object.freeze({ global: 120, peer: 20, lookup: 10 }),
  session: Object.freeze({ global: 600, peer: 120, session: 60 }),
  issuance: Object.freeze({ account: 10 }),
});

export type MachineRateBucket =
  | "global"
  | "peer"
  | "lookup"
  | "session"
  | "account";

/**
 * Operation family. Exchange and the shared self/revoke family have different
 * fixed limits, so their keys must be domain-separated: a burst of self reads
 * can never silently exhaust the exchange peer or global allowance.
 */
export type MachineRateFamily = "exchange" | "session" | "management";

export interface MachineRateCheck {
  readonly family: MachineRateFamily;
  readonly bucket: MachineRateBucket;
  readonly kind: MachineCredentialKind;
  readonly value: string;
  readonly limit: number;
}

export class MachineRateLimiter {
  readonly #secret: Buffer;
  readonly #store: MachineRateLimitStorePort;

  constructor(options: { secret: string; store: MachineRateLimitStorePort }) {
    if (
      options === null ||
      typeof options !== "object" ||
      typeof options.secret !== "string" ||
      options.secret.length === 0 ||
      options.store === null ||
      typeof options.store !== "object" ||
      typeof options.store.consume !== "function"
    ) {
      throw new Error("MACHINE_RATE_CONFIG");
    }
    this.#secret = Buffer.from(options.secret, "utf8");
    this.#store = options.store;
  }

  #key(check: MachineRateCheck): string {
    return createHmac("sha256", this.#secret)
      .update(
        `${MACHINE_RATE_DOMAIN}:${check.family}:${check.kind}:${check.bucket}:${check.value}`,
        "utf8",
      )
      .digest("hex");
  }

  /**
   * Consume one bucket. Ordered checks are enforced by `consumeAll`; global
   * first bounds bucket growth. A store error fails closed with the fixed
   * non-echoing 503 and never reports an allowed request.
   */
  async consume(check: MachineRateCheck): Promise<void> {
    let allowed: boolean;
    try {
      const result = await this.#store.consume({
        keyHash: this.#key(check),
        limit: check.limit,
        windowSeconds: MACHINE_RATE_WINDOW_SECONDS,
      });
      allowed = result.allowed === true;
    } catch {
      throw AUTH_ERRORS.unavailable();
    }
    if (!allowed) throw AUTH_ERRORS.rateLimited();
  }

  async consumeAll(checks: readonly MachineRateCheck[]): Promise<void> {
    for (const check of checks) await this.consume(check);
  }
}
