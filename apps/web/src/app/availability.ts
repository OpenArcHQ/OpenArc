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

export function arcObservationEnabled(
  value: string | boolean | undefined = import.meta.env.VITE_ARC_OBSERVATION_ENABLED,
): boolean {
  return value === true || value === "true";
}

export function agentRegistryEnabled(
  value: string | boolean | undefined = import.meta.env.VITE_AGENT_REGISTRY_ENABLED,
): boolean {
  return value === true || value === "true";
}
