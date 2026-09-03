export function encryptedWorkspaceEnabled(
  value: string | boolean | undefined = import.meta.env.VITE_ENCRYPTED_WORKSPACE_ENABLED,
): boolean {
  return value === true || value === "true";
}

export function apiBoundaryEnabled(
  value: string | boolean | undefined = import.meta.env.VITE_API_BOUNDARY_ENABLED,
): boolean {
  return value === true || value === "true";
}
