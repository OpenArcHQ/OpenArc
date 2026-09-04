import { describe, expect, it } from "vitest";

import { agentRegistryEnabled, apiBoundaryEnabled, arcObservationEnabled, encryptedWorkspaceEnabled } from "../src/app/availability.js";

describe("encrypted workspace availability", () => {
  it("fails closed unless the build flag is exactly true", () => {
    expect(encryptedWorkspaceEnabled(undefined)).toBe(false);
    expect(encryptedWorkspaceEnabled("false")).toBe(false);
    expect(encryptedWorkspaceEnabled("TRUE")).toBe(false);
    expect(encryptedWorkspaceEnabled("1")).toBe(false);
    expect(encryptedWorkspaceEnabled("true")).toBe(true);
    expect(encryptedWorkspaceEnabled(true)).toBe(true);
  });
});

describe("API boundary availability", () => {
  it("fails closed unless the build flag is exactly true", () => {
    for (const value of [undefined, "false", "TRUE", "1", false]) expect(apiBoundaryEnabled(value)).toBe(false);
    expect(apiBoundaryEnabled("true")).toBe(true);
    expect(apiBoundaryEnabled(true)).toBe(true);
  });
});

describe("Arc observation availability", () => {
  it("fails closed unless the build flag is exactly true", () => {
    for (const value of [undefined, "false", "TRUE", "1", false]) expect(arcObservationEnabled(value)).toBe(false);
    expect(arcObservationEnabled("true")).toBe(true);
    expect(arcObservationEnabled(true)).toBe(true);
  });
});

describe("agent registry availability", () => {
  it("fails closed unless the build flag is exactly true", () => {
    for (const value of [undefined, "false", "TRUE", "1", false]) expect(agentRegistryEnabled(value)).toBe(false);
    expect(agentRegistryEnabled("true")).toBe(true);
    expect(agentRegistryEnabled(true)).toBe(true);
  });
});
