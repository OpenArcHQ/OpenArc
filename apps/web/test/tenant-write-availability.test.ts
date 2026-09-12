import { describe, expect, it } from "vitest";

import {
  tenantMutationEnabled,
  tenantReadsEnabled,
  tenantWritesEnabled,
} from "../src/tenant/availability.js";

describe("tenant writes availability", () => {
  it("fails closed unless the write flag is exactly true", () => {
    for (const value of [undefined, "false", "TRUE", "True", "1", "yes", false]) {
      expect(tenantWritesEnabled(value)).toBe(false);
    }
    expect(tenantWritesEnabled("true")).toBe(true);
    expect(tenantWritesEnabled(true)).toBe(true);
  });

  it("requires reads and account access in addition to writes", () => {
    expect(tenantMutationEnabled("true", "true", "true")).toBe(true);
    expect(tenantMutationEnabled("false", "true", "true")).toBe(false);
    expect(tenantMutationEnabled("true", "false", "true")).toBe(false);
    expect(tenantMutationEnabled("true", "true", "false")).toBe(false);
    expect(tenantMutationEnabled(undefined, "true", "true")).toBe(false);
    expect(tenantMutationEnabled("true", undefined, "true")).toBe(false);
    expect(tenantMutationEnabled("true", "true", undefined)).toBe(false);
  });

  it("keeps the read flag semantics unchanged", () => {
    expect(tenantReadsEnabled("true")).toBe(true);
    expect(tenantReadsEnabled("false")).toBe(false);
  });
});
