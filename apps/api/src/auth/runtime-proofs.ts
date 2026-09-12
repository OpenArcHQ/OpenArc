import type { AuthProofPort } from "./ports.js";
import type { AuthTransport } from "./proofs.js";
import {
  createWalletLoginMessage,
  generatePasskeyAuthentication,
  generatePasskeyRegistration,
  validateAuthOriginConfig,
  verifyPasskeyAuthentication,
  verifyPasskeyRegistration,
  verifyWalletLoginProof,
} from "./proofs.js";

const AUTH_TRANSPORTS: readonly AuthTransport[] = [
  "usb",
  "nfc",
  "ble",
  "internal",
  "hybrid",
  "cable",
  "smart-card",
];

function narrowTransports(values: readonly string[]): AuthTransport[] {
  return values.filter((value): value is AuthTransport =>
    (AUTH_TRANSPORTS as readonly string[]).includes(value),
  );
}

/**
 * Runtime proof port over the reviewed `./proofs.js` adapters. This is the
 * only production implementation; no test adapter or configuration path is
 * present here. It narrows the maintained SDK outputs to the allowlisted wire
 * shapes the service consumes.
 */
export const proofs: AuthProofPort = {
  validateAuthOriginConfig,
  async generatePasskeyRegistration(userHandle, config) {
    const options = await generatePasskeyRegistration(userHandle, config);
    return {
      challenge: options.challenge,
      rp: {
        ...(options.rp.id !== undefined ? { id: options.rp.id } : {}),
        name: options.rp.name,
      },
      user: {
        id: options.user.id,
        name: options.user.name,
        displayName: options.user.displayName,
      },
      pubKeyCredParams: options.pubKeyCredParams.map((entry) => ({
        type: "public-key" as const,
        alg: entry.alg === -257 ? (-257 as const) : (-7 as const),
      })),
      ...(options.timeout !== undefined ? { timeout: options.timeout } : {}),
      ...(options.excludeCredentials !== undefined
        ? {
            excludeCredentials: options.excludeCredentials.map((entry) => ({
              id: entry.id,
              type: "public-key" as const,
              ...(entry.transports !== undefined
                ? { transports: narrowTransports(entry.transports) }
                : {}),
            })),
          }
        : {}),
      ...(options.authenticatorSelection !== undefined
        ? {
            authenticatorSelection: {
              ...(options.authenticatorSelection.authenticatorAttachment !==
              undefined
                ? {
                    authenticatorAttachment:
                      options.authenticatorSelection.authenticatorAttachment,
                  }
                : {}),
              ...(options.authenticatorSelection.residentKey !== undefined
                ? { residentKey: options.authenticatorSelection.residentKey }
                : {}),
              ...(options.authenticatorSelection.requireResidentKey !==
              undefined
                ? {
                    requireResidentKey:
                      options.authenticatorSelection.requireResidentKey,
                  }
                : {}),
              ...(options.authenticatorSelection.userVerification !== undefined
                ? {
                    userVerification:
                      options.authenticatorSelection.userVerification,
                  }
                : {}),
            },
          }
        : {}),
      ...(options.attestation !== undefined
        ? { attestation: options.attestation }
        : {}),
      ...(options.extensions !== undefined
        ? {
            extensions:
              options.extensions.credProps === undefined
                ? {}
                : { credProps: options.extensions.credProps },
          }
        : {}),
    };
  },
  async generatePasskeyAuthentication(config) {
    const options = await generatePasskeyAuthentication(config);
    return {
      challenge: options.challenge,
      ...(options.timeout !== undefined ? { timeout: options.timeout } : {}),
      ...(options.rpId !== undefined ? { rpId: options.rpId } : {}),
      ...(options.allowCredentials !== undefined
        ? {
            allowCredentials: options.allowCredentials.map((entry) => ({
              id: entry.id,
              type: "public-key" as const,
            })),
          }
        : {}),
      ...(options.userVerification !== undefined
        ? { userVerification: options.userVerification }
        : {}),
      ...(options.extensions !== undefined
        ? {
            extensions:
              options.extensions.credProps === undefined
                ? {}
                : { credProps: options.extensions.credProps },
          }
        : {}),
    };
  },
  verifyPasskeyRegistration,
  verifyPasskeyAuthentication,
  createWalletLoginMessage,
  verifyWalletLoginProof,
};
