export type VaultErrorCode =
  | "INVALID_BACKUP"
  | "INVALID_PASSPHRASE"
  | "RECOVERY_FAILED"
  | "UNSUPPORTED_BROWSER"
  | "VAULT_CAPACITY"
  | "VAULT_CONFLICT"
  | "VAULT_EXISTS";

export class VaultError extends Error {
  readonly code: VaultErrorCode;

  constructor(code: VaultErrorCode, message: string) {
    super(message);
    this.name = "VaultError";
    this.code = code;
  }
}

export function vaultErrorMessage(error: unknown): string {
  if (!(error instanceof VaultError)) {
    if (error instanceof DOMException && error.name === "QuotaExceededError") {
      return "This browser could not save the encrypted workspace because its local storage quota is full.";
    }
    return "OpenArc could not complete that local encrypted-workspace operation.";
  }
  switch (error.code) {
    case "INVALID_PASSPHRASE":
    case "RECOVERY_FAILED":
      return "Wrong passphrase or damaged workspace.";
    case "INVALID_BACKUP":
    case "VAULT_CAPACITY":
    case "VAULT_CONFLICT":
    case "VAULT_EXISTS":
    case "UNSUPPORTED_BROWSER":
      return error.message;
  }
}
