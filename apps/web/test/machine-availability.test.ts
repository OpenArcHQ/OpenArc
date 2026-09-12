import { describe, expect, it } from "vitest";

import { machineCredentialEnabled } from "../src/tenant/availability.js";

/**
 * The machine credential console is the strictest surface. It mounts only when
 * its own flag is exactly true AND tenant writes, tenant reads and account
 * access are all exactly true. Every default is false.
 */
describe("machine credential availability", () => {
  it("fails closed unless the machine flag is exactly true", () => {
    for (const value of [undefined, "false", "TRUE", "True", "1", "yes", false]) {
      expect(machineCredentialEnabled(value, "true", "true", "true")).toBe(false);
    }
    expect(machineCredentialEnabled("true", "true", "true", "true")).toBe(true);
    expect(machineCredentialEnabled(true, "true", "true", "true")).toBe(true);
  });

  it("requires writes, reads and account access together", () => {
    expect(machineCredentialEnabled("true", "false", "true", "true")).toBe(false);
    expect(machineCredentialEnabled("true", "true", "false", "true")).toBe(false);
    expect(machineCredentialEnabled("true", "true", "true", "false")).toBe(false);
    expect(machineCredentialEnabled("true", undefined, "true", "true")).toBe(false);
    expect(machineCredentialEnabled("true", "true", undefined, "true")).toBe(false);
    expect(machineCredentialEnabled("true", "true", "true", undefined)).toBe(false);
  });

  it("never enables on the API-boundary flag alone or a machine browser session", () => {
    // There is no dependency on a machine session, bearer transport or the API
    // boundary flag: only these four flags participate.
    expect(machineCredentialEnabled(undefined, undefined, undefined, undefined)).toBe(false);
    expect(machineCredentialEnabled("false", "true", "true", "true")).toBe(false);
  });
});
