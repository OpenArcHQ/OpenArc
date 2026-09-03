import { describe, expect, it } from "vitest";

import { encryptedWorkspaceEnabled } from "../src/app/availability.js";

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
