import { describe, expect, it } from "vitest";

import {
  marketCapabilitiesEnabled,
  marketCatalogEnabled,
  marketCatalogReady,
} from "../src/market/availability.js";

/**
 * The public catalog mounts only when its OWN flag is exactly true AND the
 * accepted API boundary is enabled. Every other value fails closed, and the
 * capability-status surface depends only on the API boundary.
 */
describe("market catalog availability", () => {
  it("enables the catalog only for exact true and exact 'true'", () => {
    expect(marketCatalogEnabled(true)).toBe(true);
    expect(marketCatalogEnabled("true")).toBe(true);
    for (const value of [
      undefined,
      false,
      "false",
      "TRUE",
      "True",
      "1",
      "yes",
      "",
    ]) {
      expect(marketCatalogEnabled(value)).toBe(false);
    }
  });

  it("defaults to false when the flag is absent", () => {
    expect(marketCatalogEnabled()).toBe(false);
  });

  it("requires the API boundary as a separate parent check", () => {
    expect(marketCatalogReady("true", "true")).toBe(true);
    expect(marketCatalogReady(true, true)).toBe(true);
    expect(marketCatalogReady("true", "false")).toBe(false);
    expect(marketCatalogReady("true", undefined)).toBe(false);
    expect(marketCatalogReady("false", "true")).toBe(false);
    expect(marketCatalogReady(undefined, "true")).toBe(false);
    // Neither flag infers the other.
    expect(marketCatalogReady(undefined, undefined)).toBe(false);
    expect(marketCatalogReady("true", "TRUE")).toBe(false);
  });

  it("gates the capability-status surface on the API boundary only", () => {
    expect(marketCapabilitiesEnabled("true")).toBe(true);
    expect(marketCapabilitiesEnabled(true)).toBe(true);
    expect(marketCapabilitiesEnabled()).toBe(false);
    expect(marketCapabilitiesEnabled("false")).toBe(false);
    expect(marketCapabilitiesEnabled("TRUE")).toBe(false);
    expect(marketCapabilitiesEnabled(undefined)).toBe(false);
  });
});
