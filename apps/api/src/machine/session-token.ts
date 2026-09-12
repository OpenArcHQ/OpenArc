import { createHash, randomBytes, randomUUID } from "node:crypto";

import {
  CommerceMachineSessionTokenSchema,
  type CommerceMachineKind,
} from "@openarc/shared";

/**
 * Short-lived machine session token primitive.
 *
 * A session token is 32 random bytes rendered as exactly 43 canonical unpadded
 * base64url characters behind a kind-bound `oas_ag_`/`oas_pr_` prefix. The
 * stored value is a SHA-256 over an explicit kind-bound domain plus the ENTIRE
 * canonical token; the raw token never enters the store, a log or an error.
 * A wrong-namespace token can never be hashed as the other kind.
 */

export const MACHINE_SESSION_TOKEN_BYTES = 32;

export const MACHINE_SESSION_TOKEN_PREFIX: Readonly<
  Record<CommerceMachineKind, string>
> = Object.freeze({ agent: "oas_ag_", provider: "oas_pr_" });

export const MACHINE_SESSION_HASH_DOMAIN: Readonly<
  Record<CommerceMachineKind, string>
> = Object.freeze({
  agent: "openarc.machine.session.agent.v1\0",
  provider: "openarc.machine.session.provider.v1\0",
});

export function generateSessionToken(kind: CommerceMachineKind): string {
  return `${MACHINE_SESSION_TOKEN_PREFIX[kind]}${randomBytes(
    MACHINE_SESSION_TOKEN_BYTES,
  ).toString("base64url")}`;
}

/** Canonical lower-case UUIDv4 session id; not a secret. */
export function generateSessionId(): string {
  return randomUUID();
}

/** True only for a canonical token of the exact expected kind namespace. */
export function isSessionTokenForKind(
  kind: CommerceMachineKind,
  token: unknown,
): token is string {
  if (typeof token !== "string") return false;
  if (!CommerceMachineSessionTokenSchema.safeParse(token).success) return false;
  return token.startsWith(MACHINE_SESSION_TOKEN_PREFIX[kind]);
}

/** Classify a canonical session token by namespace, or null when malformed. */
export function sessionTokenKind(
  token: unknown,
): CommerceMachineKind | null {
  if (typeof token !== "string") return null;
  if (!CommerceMachineSessionTokenSchema.safeParse(token).success) return null;
  if (token.startsWith(MACHINE_SESSION_TOKEN_PREFIX.agent)) return "agent";
  if (token.startsWith(MACHINE_SESSION_TOKEN_PREFIX.provider)) return "provider";
  return null;
}

/**
 * Domain-separated SHA-256 of the entire canonical token. Callers MUST have
 * validated the token/kind with `isSessionTokenForKind` first.
 */
export function hashSessionToken(
  kind: CommerceMachineKind,
  token: string,
): string {
  return createHash("sha256")
    .update(MACHINE_SESSION_HASH_DOMAIN[kind], "utf8")
    .update(token, "utf8")
    .digest("hex");
}
