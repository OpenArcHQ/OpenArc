export function encryptedWorkspaceEnabled(
  value: string | boolean | undefined = import.meta.env.VITE_ENCRYPTED_WORKSPACE_ENABLED,
): boolean {
  return value === true || value === "true";
}
