import { describe, expect, it } from "vitest";

import { listingManagementEnabled } from "../src/tenant/listing-availability.js";

describe("listing management availability gate", () => {
  it("is false for every default/absent value", () => {
    expect(listingManagementEnabled(undefined, undefined, undefined, undefined)).toBe(false);
    expect(listingManagementEnabled(false, false, false, false)).toBe(false);
    expect(listingManagementEnabled("false", "true", "true", "true")).toBe(false);
  });

  it("requires the exact literal true on all four flags", () => {
    expect(listingManagementEnabled(true, true, true, true)).toBe(true);
    expect(listingManagementEnabled("true", "true", "true", "true")).toBe(true);
    expect(listingManagementEnabled(true, true, true, false)).toBe(false);
    expect(listingManagementEnabled(true, true, false, true)).toBe(false);
    expect(listingManagementEnabled(true, false, true, true)).toBe(false);
  });

  it("does not accept truthy non-boolean values", () => {
    expect(listingManagementEnabled(1 as never, "true", "true", "true")).toBe(false);
    expect(listingManagementEnabled("TRUE", "true", "true", "true")).toBe(false);
    expect(listingManagementEnabled("yes", "true", "true", "true")).toBe(false);
  });

  it("never depends on the tenant-writes or machine flags", () => {
    // The signature has no writes/machine parameter at all; the gate is
    // independent by construction. This test documents that contract.
    const fn = listingManagementEnabled as unknown;
    expect(typeof fn).toBe("function");
    expect(fn).toHaveLength(4);
  });
});
