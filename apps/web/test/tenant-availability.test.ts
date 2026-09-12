import { describe, expect, it } from "vitest";

import { tenantReadsEnabled } from "../src/tenant/availability.js";

describe("tenant reads availability", () => {
  it("fails closed unless the build flag is exactly true", () => {
    for (const value of [undefined, "false", "TRUE", "True", "1", "yes", false]) {
      expect(tenantReadsEnabled(value)).toBe(false);
    }
    expect(tenantReadsEnabled("true")).toBe(true);
    expect(tenantReadsEnabled(true)).toBe(true);
  });

  it("does not enable on an invalid flag value", () => {
    expect(tenantReadsEnabled("")).toBe(false);
    expect(tenantReadsEnabled(" true")).toBe(false);
    expect(tenantReadsEnabled(1 as unknown as string)).toBe(false);
  });
});
