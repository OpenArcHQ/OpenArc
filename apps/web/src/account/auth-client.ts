import {
  API_CLIENT_HEADER,
  API_MAX_RESPONSE_BYTES,
  COMMERCE_API_SCHEMA_VERSION,
  CommerceApiErrorEnvelopeSchema,
  CommerceApiMetaSchema,
} from "@openarc/shared";
import type { CommerceApiErrorCode } from "@openarc/shared";

/**
 * Own relative account transport for the `/v2/auth/*` surface.
 *
 * This module is deliberately independent of the legacy v1 client: it uses the
 * v2 commerce envelope and error catalogue, sends only relative same-origin
 * requests with `credentials: "same-origin"` and `cache: "no-store"`, and never
 * reflects raw response bodies, URLs or return targets. There is no automatic
 * retry: a lost write is an explicitly unknown outcome handled by the caller.
 */

export const ACCOUNT_API_PATHS = Object.freeze({
  bootstrap: "/v2/auth/bootstrap",
  session: "/v2/auth/session",
  registerOptions: "/v2/auth/passkeys/register/options",
  registerVerify: "/v2/auth/passkeys/register/verify",
  loginOptions: "/v2/auth/passkeys/login/options",
  loginVerify: "/v2/auth/passkeys/login/verify",
  addOptions: "/v2/auth/passkeys/add/options",
  addVerify: "/v2/auth/passkeys/add/verify",
  walletLoginOptions: "/v2/auth/wallets/login/options",
  walletLoginVerify: "/v2/auth/wallets/login/verify",
  walletLinkOptions: "/v2/auth/wallets/link/options",
  walletLinkVerify: "/v2/auth/wallets/link/verify",
  recoveryCodes: "/v2/auth/recovery/codes",
  recoveryRedeem: "/v2/auth/recovery/redeem",
  logout: "/v2/auth/logout",
} as const);

export type AccountApiPath =
  (typeof ACCOUNT_API_PATHS)[keyof typeof ACCOUNT_API_PATHS];

/**
 * Bounded, non-echoing failure taxonomy. `outcome-unknown` is distinct from a
 * confirmed rejection so the UI never claims a write did or did not happen
 * when the response was lost after the request was sent.
 */
export type AccountApiFailure =
  | { kind: "aborted" }
  | { kind: "pre-send" }
  | { kind: "account-changed" }
  | { kind: "outcome-unknown" }
  | { kind: "invalid-response" }
  | { kind: "server"; code: CommerceApiErrorCode };

export class AccountApiError extends Error {
  readonly failure: AccountApiFailure;

  constructor(failure: AccountApiFailure) {
    super(failure.kind === "server" ? failure.code : failure.kind);
    this.name = "AccountApiError";
    this.failure = failure;
  }
}

export type AccountFetch = typeof fetch;

type RuntimeSchema<T> = {
  safeParse(value: unknown): { success: true; data: T } | { success: false };
};

export async function requestAccount<TReq, TRes>(input: {
  path: AccountApiPath;
  method: "GET" | "POST";
  requestSchema?: RuntimeSchema<TReq>;
  responseSchema: RuntimeSchema<TRes>;
  body?: TReq;
  csrfToken?: string;
  signal: AbortSignal;
  fetcher?: AccountFetch;
}): Promise<TRes> {
  if (input.signal.aborted) {
    throw new AccountApiError({ kind: "aborted" });
  }
  if ((input.method === "GET") !== (input.body === undefined)) {
    throw new AccountApiError({ kind: "pre-send" });
  }
  if (
    input.body !== undefined &&
    (input.requestSchema === undefined ||
      !input.requestSchema.safeParse(input.body).success)
  ) {
    throw new AccountApiError({ kind: "pre-send" });
  }

  const headers: Record<string, string> = {
    "X-OpenArc-Client": API_CLIENT_HEADER,
  };
  let body: string | undefined;
  if (input.body !== undefined && input.requestSchema !== undefined) {
    const parsed = input.requestSchema.safeParse(input.body);
    if (!parsed.success) throw new AccountApiError({ kind: "pre-send" });
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(parsed.data);
  }
  if (input.csrfToken !== undefined) {
    headers["X-OpenArc-CSRF"] = input.csrfToken;
  }

  let response: Response;
  try {
    response = await (input.fetcher ?? fetch)(input.path, {
      method: input.method,
      headers,
      ...(body === undefined ? {} : { body }),
      credentials: "same-origin",
      cache: "no-store",
      redirect: "error",
      referrerPolicy: "no-referrer",
      signal: input.signal,
    });
  } catch {
    // Distinguishing a still-in-flight request from a failed one is impossible
    // here, so a transport error after send is an explicitly unknown outcome.
    throw new AccountApiError(
      input.signal.aborted ? { kind: "aborted" } : { kind: "outcome-unknown" },
    );
  }

  let decoded: unknown;
  try {
    decoded = await decodeJson(response);
  } catch {
    // The request was already sent. A body we cannot decode (truncated,
    // wrong content type, over-limit) does not prove the write rolled back,
    // so an unverifiable mutation response is always outcome-unknown.
    throw new AccountApiError(unverifiable(input.method));
  }

  if (!response.ok) {
    const parsed = CommerceApiErrorEnvelopeSchema.safeParse(decoded);
    if (!parsed.success) {
      throw new AccountApiError(unverifiable(input.method));
    }
    throw new AccountApiError({ kind: "server", code: parsed.data.error.code });
  }

  if (
    typeof decoded !== "object" ||
    decoded === null ||
    (decoded as { ok?: unknown }).ok !== true
  ) {
    throw new AccountApiError(unverifiable(input.method));
  }
  const keys = Object.keys(decoded).sort();
  if (keys.length !== 3 || keys[0] !== "data" || keys[1] !== "meta" || keys[2] !== "ok") {
    throw new AccountApiError(unverifiable(input.method));
  }
  const decodedRecord = decoded as { data?: unknown; meta?: unknown };
  const meta = CommerceApiMetaSchema.safeParse(decodedRecord.meta);
  if (!meta.success || meta.data.schemaVersion !== COMMERCE_API_SCHEMA_VERSION) {
    throw new AccountApiError(unverifiable(input.method));
  }
  if (
    !Object.prototype.hasOwnProperty.call(decodedRecord, "data")
  ) {
    throw new AccountApiError(unverifiable(input.method));
  }
  const parsed = input.responseSchema.safeParse(
    decodedRecord.data,
  );
  if (!parsed.success) throw new AccountApiError(unverifiable(input.method));
  return parsed.data;
}

/**
 * A malformed response to a sent POST is an unverifiable outcome: the write
 * may or may not have been applied. A malformed response to a GET is simply
 * an invalid read and does not imply any state change.
 */
function unverifiable(method: "GET" | "POST"): AccountApiFailure {
  return method === "POST" ? { kind: "outcome-unknown" } : { kind: "invalid-response" };
}

async function decodeJson(response: Response): Promise<unknown> {
  const type = response.headers.get("content-type");
  if (!type || !/^application\/json(?:\s*;\s*charset=utf-8)?$/iu.test(type)) {
    throw new AccountApiError({ kind: "invalid-response" });
  }
  const length = response.headers.get("content-length");
  if (
    length !== null &&
    (!/^(?:0|[1-9]\d{0,9})$/u.test(length) ||
      Number(length) > API_MAX_RESPONSE_BYTES)
  ) {
    throw new AccountApiError({ kind: "invalid-response" });
  }
  if (response.body === null) {
    throw new AccountApiError({ kind: "invalid-response" });
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > API_MAX_RESPONSE_BYTES) {
        throw new AccountApiError({ kind: "invalid-response" });
      }
      chunks.push(next.value);
    }
  } finally {
    void reader.cancel().catch(() => undefined);
  }
  if (length !== null && total !== Number(length)) {
    throw new AccountApiError({ kind: "invalid-response" });
  }
  const combined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.length;
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(combined));
  } catch {
    throw new AccountApiError({ kind: "invalid-response" });
  }
}
