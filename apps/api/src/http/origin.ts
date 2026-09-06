import { API_CLIENT_HEADER } from "@openarc/shared";

import { ApiBoundaryError } from "./errors.js";

type Headers = Readonly<Record<string, unknown>>;

function single(headers: Headers, key: string): string | undefined {
  const value = headers[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new ApiBoundaryError("INVALID_ORIGIN");
  return value;
}

export function rejectCredentials(headers: Headers): void {
  if (["cookie", "authorization", "proxy-authorization"].some((key) => headers[key] !== undefined)) {
    throw new ApiBoundaryError("CREDENTIALS_NOT_ALLOWED");
  }
}

export function verifyBrowserOrigin(headers: Headers, appOrigin: string, allowOriginlessGet: boolean): void {
  const origin = single(headers, "origin");
  const site = single(headers, "sec-fetch-site");
  const mode = single(headers, "sec-fetch-mode");
  const destination = single(headers, "sec-fetch-dest");
  if (single(headers, "x-openarc-client") !== API_CLIENT_HEADER ||
    (origin !== undefined && origin !== appOrigin) ||
    (origin === undefined && (!allowOriginlessGet || site !== "same-origin")) ||
    (site !== undefined && site !== "same-origin") ||
    (mode !== undefined && !["cors", "same-origin"].includes(mode)) ||
    (destination !== undefined && destination !== "empty")) {
    throw new ApiBoundaryError("INVALID_ORIGIN");
  }
  rejectCredentials(headers);
}

export function verifyPreflight(headers: Headers, appOrigin: string, method: "GET" | "POST"): void {
  rejectCredentials(headers);
  if (single(headers, "origin") !== appOrigin || single(headers, "access-control-request-method") !== method) {
    throw new ApiBoundaryError("INVALID_ORIGIN");
  }
  const requested = single(headers, "access-control-request-headers");
  if (!requested || requested.length > 128) throw new ApiBoundaryError("INVALID_ORIGIN");
  const fields = requested.toLowerCase().split(",").map((field) => field.trim());
  if (!fields.includes("x-openarc-client") || new Set(fields).size !== fields.length ||
    fields.some((field) => !["x-openarc-client", "content-type"].includes(field))) {
    throw new ApiBoundaryError("INVALID_ORIGIN");
  }
}
