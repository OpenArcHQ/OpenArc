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

export function agentJobsEnabled(
  value: string | boolean | undefined = import.meta.env.VITE_AGENT_JOBS_ENABLED,
): boolean {
  return value === true || value === "true";
}

export function workspaceSectionUsesNetwork(id: string, flags: {
  apiBoundary: boolean; arcObservation: boolean; agentRegistry: boolean; agentJobs: boolean;
}): boolean {
  if (!flags.apiBoundary) return false;
  if (id === "sources-title") return true;
  if (!flags.arcObservation) return false;
  if (id === "activity-title") return true;
  if (!flags.agentRegistry) return false;
  return id === "agents-title" || (id === "jobs-title" && flags.agentJobs);
}
