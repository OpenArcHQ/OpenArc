import {
  AccountPasskeyAuthenticationResponseSchema,
  AccountPasskeyRegistrationResponseSchema,
  type AccountPasskeyAuthenticationResponse,
  type AccountPasskeyRegistrationResponse,
} from "@openarc/shared";
import {
  startAuthentication,
  startRegistration,
  WebAuthnAbortService,
} from "@simplewebauthn/browser";
import type {
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
} from "@simplewebauthn/browser";

/**
 * Browser WebAuthn boundary.
 *
 * The maintained SDK performs the ceremony; this module only allowlists and
 * validates its response against the frozen shared schemas before the value is
 * ever sent to the server. No custom cryptographic verification is performed
 * here. Optional `null` userHandle/attachment and unknown extensions are
 * omitted rather than forwarded.
 */

export type PasskeyCeremonyFailure =
  | "cancelled"
  | "unsupported"
  | "invalid-response";

export class PasskeyCeremonyError extends Error {
  readonly failure: PasskeyCeremonyFailure;

  constructor(failure: PasskeyCeremonyFailure) {
    super(failure);
    this.name = "PasskeyCeremonyError";
    this.failure = failure;
  }
}

/** Cancels the SDK's shared ceremony, e.g. on unmount or navigation. */
export function cancelPasskeyCeremony(): void {
  WebAuthnAbortService.cancelCeremony();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function normaliseExtensionResults(value: unknown): unknown {
  if (!isRecord(value)) return {};
  const out: Record<string, unknown> = {};
  if (isRecord(value["credProps"]) && typeof value["credProps"]["rk"] === "boolean") {
    out["credProps"] = { rk: value["credProps"]["rk"] };
  }
  return out;
}

/**
 * Builds the strict registration wire DTO from an SDK result. Any shape that
 * does not satisfy the shared schema is rejected rather than partially sent.
 */
export function toRegistrationWire(
  result: unknown,
): AccountPasskeyRegistrationResponse {
  if (!isRecord(result) || !isRecord(result["response"])) {
    throw new PasskeyCeremonyError("invalid-response");
  }
  const response = result["response"];
  const wire = {
    id: result["id"],
    rawId: result["rawId"],
    type: "public-key",
    response: {
      clientDataJSON: response["clientDataJSON"],
      attestationObject: response["attestationObject"],
      ...(typeof response["authenticatorData"] === "string"
        ? { authenticatorData: response["authenticatorData"] }
        : {}),
      ...(typeof response["publicKey"] === "string"
        ? { publicKey: response["publicKey"] }
        : {}),
      ...(response["publicKeyAlgorithm"] === -7 ||
      response["publicKeyAlgorithm"] === -257
        ? { publicKeyAlgorithm: response["publicKeyAlgorithm"] }
        : {}),
      ...(Array.isArray(response["transports"])
        ? { transports: response["transports"] }
        : {}),
    },
    clientExtensionResults: normaliseExtensionResults(
      result["clientExtensionResults"],
    ),
    ...(result["authenticatorAttachment"] === "platform" ||
    result["authenticatorAttachment"] === "cross-platform"
      ? { authenticatorAttachment: result["authenticatorAttachment"] }
      : {}),
  };
  const parsed = AccountPasskeyRegistrationResponseSchema.safeParse(wire);
  if (!parsed.success) throw new PasskeyCeremonyError("invalid-response");
  return parsed.data;
}

/**
 * Builds the strict authentication wire DTO from an SDK result, dropping a
 * nullable userHandle instead of sending `null`.
 */
export function toAuthenticationWire(
  result: unknown,
): AccountPasskeyAuthenticationResponse {
  if (!isRecord(result) || !isRecord(result["response"])) {
    throw new PasskeyCeremonyError("invalid-response");
  }
  const response = result["response"];
  const wire = {
    id: result["id"],
    rawId: result["rawId"],
    type: "public-key",
    response: {
      clientDataJSON: response["clientDataJSON"],
      authenticatorData: response["authenticatorData"],
      signature: response["signature"],
      ...(typeof response["userHandle"] === "string"
        ? { userHandle: response["userHandle"] }
        : {}),
    },
    clientExtensionResults: normaliseExtensionResults(
      result["clientExtensionResults"],
    ),
    ...(result["authenticatorAttachment"] === "platform" ||
    result["authenticatorAttachment"] === "cross-platform"
      ? { authenticatorAttachment: result["authenticatorAttachment"] }
      : {}),
  };
  const parsed = AccountPasskeyAuthenticationResponseSchema.safeParse(wire);
  if (!parsed.success) throw new PasskeyCeremonyError("invalid-response");
  return parsed.data;
}

/**
 * Collects `name` values from the SDK error and its `cause` chain. The
 * maintained SDK wraps DOM errors in its own error with the original
 * DOMException attached as `cause`, so the leaf name is what distinguishes a
 * user cancellation from a genuine failure.
 */
function errorNameChain(error: unknown): string[] {
  const names: string[] = [];
  for (let current: unknown = error, depth = 0; depth < 4; depth += 1) {
    if (!isRecord(current)) break;
    if (typeof current["name"] === "string") names.push(current["name"]);
    if (typeof current["code"] === "string") names.push(current["code"]);
    current = current["cause"];
    if (current === undefined || current === null) break;
  }
  return names;
}

function classify(error: unknown): PasskeyCeremonyError {
  const names = errorNameChain(error);
  const message =
    isRecord(error) && typeof error["message"] === "string"
      ? error["message"].toLowerCase()
      : "";
  if (
    names.includes("NotAllowedError") ||
    names.includes("AbortError") ||
    names.includes("ERROR_CEREMONY_ABORTED") ||
    names.includes("ERROR_AUTHENTICATOR_PREVIOUSLY_REGISTERED")
  ) {
    return new PasskeyCeremonyError("cancelled");
  }
  if (
    names.includes("NotSupportedError") ||
    names.includes("SecurityError") ||
    message.includes("not supported") ||
    typeof window.PublicKeyCredential === "undefined"
  ) {
    return new PasskeyCeremonyError("unsupported");
  }
  return new PasskeyCeremonyError("invalid-response");
}

export async function beginPasskeyRegistration(
  options: PublicKeyCredentialCreationOptionsJSON,
): Promise<AccountPasskeyRegistrationResponse> {
  try {
    const result = await startRegistration({ optionsJSON: options });
    return toRegistrationWire(result);
  } catch (error) {
    if (error instanceof PasskeyCeremonyError) throw error;
    throw classify(error);
  }
}

export async function beginPasskeyAuthentication(
  options: PublicKeyCredentialRequestOptionsJSON,
): Promise<AccountPasskeyAuthenticationResponse> {
  try {
    const result = await startAuthentication({ optionsJSON: options });
    return toAuthenticationWire(result);
  } catch (error) {
    if (error instanceof PasskeyCeremonyError) throw error;
    throw classify(error);
  }
}
