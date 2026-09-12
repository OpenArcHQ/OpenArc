import type { CommerceApiErrorCode } from "@openarc/shared";

import type { AccountApiFailure } from "./auth-client.js";

/**
 * Fixed, non-echoing UI copy. Nothing here reflects raw server text, provider
 * messages, credential IDs or error bodies. `fresh-session` guidance is
 * explicit so an expired session is never confused with a hard failure.
 */

export interface AccountNotice {
  readonly tone: "info" | "warning" | "error";
  readonly message: string;
  readonly needsFreshSession: boolean;
}

const NOTICE = (tone: AccountNotice["tone"], message: string, needsFreshSession = false): AccountNotice =>
  Object.freeze({ tone, message, needsFreshSession });

export function noticeForApiFailure(failure: AccountApiFailure): AccountNotice {
  switch (failure.kind) {
    case "aborted":
      return NOTICE("info", "That request was cancelled.");
    case "pre-send":
      return NOTICE("warning", "That action could not be started. Please try again.");
    case "account-changed":
      return NOTICE(
        "warning",
        "You are signed in to a different account than this action started with, so it was stopped. Review the account shown below, then start again.",
      );
    case "outcome-unknown":
      return NOTICE(
        "warning",
        "The request was sent but no response was received, so the outcome is unknown. Refresh your session to check before trying again.",
      );
    case "invalid-response":
      return NOTICE("error", "The server response could not be verified. Nothing was changed.");
    case "server":
      return noticeForServerCode(failure.code);
  }
}

export function noticeForServerCode(code: CommerceApiErrorCode): AccountNotice {
  if (code === "UNAUTHENTICATED" || code === "FORBIDDEN") {
    return NOTICE(
      "warning",
      "Your sign-in is no longer valid. Refresh your session, then sign in again.",
      true,
    );
  }
  if (code === "CSRF_REJECTED" || code === "INVALID_ORIGIN") {
    return NOTICE(
      "warning",
      "This page's security check expired. Refresh your session, then try again.",
      true,
    );
  }
  if (code === "RATE_LIMITED") {
    return NOTICE("warning", "Too many attempts. Please wait and try again.");
  }
  if (code === "FEATURE_DISABLED") {
    return NOTICE("info", "This feature is disabled for the current deployment.");
  }
  if (code === "INTERNAL_ERROR") {
    return NOTICE(
      "error",
      "The server failed while processing the request. The outcome is unknown: refresh your session before retrying.",
    );
  }
  return NOTICE(
    "error",
    "The request could not be completed and its outcome is unknown. Refresh your session before retrying.",
  );
}

export const ACCOUNT_NOTICES = Object.freeze({
  freshSessionRequired:
    "For this change you must sign in again with a wallet or passkey, then retry.",
  logoutUnconfirmed:
    "We could not confirm that the server session ended. Retry sign-out; if it still fails, close this tab.",
  codeUnknown:
    "The outcome is unknown. Your existing codes may or may not have been replaced; refresh your session before generating again.",
  codeReplaceUnknown:
    "The replacement request was sent but no response was received, so the outcome is unknown. Your old codes may have been invalidated. Refresh your session and sign in again with a wallet or passkey before generating a new set.",
  originWarning:
    "This is a disposable development origin. Passkeys are bound to this site, so a stable production origin is required before real users.",
  minimalRecord:
    "I understand OpenArc keeps the credential public key and ID, a pseudonymous account binding and necessary security records. Passkeys here are not anonymous and are not zero-retention.",
  walletPublic:
    "Your wallet address is public and is stored for authentication. Signing in does not authorize any payment.",
  walletSignOnly:
    "Only account access and a login signature are requested. No transaction, network switch or payment is authorized.",
});
