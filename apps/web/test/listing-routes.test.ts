import { describe, expect, it } from "vitest";

import {
  LISTING_NEW_PATH,
  LISTING_ROOTS_PATH,
  isListingPath,
  listingRouteHref,
  parseListingRoute,
} from "../src/tenant/listing-routes.js";

const LISTING = "openarc:listing:12345678-1234-4234-8123-123456789abc";
const LISTING_B = "openarc:listing:87654321-4321-4321-b123-abcdefabcdef";

describe("protected listing route parser", () => {
  it("matches /new before the dynamic listing id branch", () => {
    expect(parseListingRoute(LISTING_NEW_PATH)).toEqual({ kind: "new" });
  });

  it("matches the roots route exactly and with a trailing slash", () => {
    expect(parseListingRoute(LISTING_ROOTS_PATH)).toEqual({ kind: "roots" });
    expect(parseListingRoute(`${LISTING_ROOTS_PATH}/`)).toEqual({ kind: "roots" });
  });

  it("decodes exactly one canonical encoded listing id", () => {
    const encoded = encodeURIComponent(LISTING);
    expect(parseListingRoute(`${LISTING_ROOTS_PATH}/${encoded}`)).toEqual({
      kind: "detail",
      listingId: LISTING,
    });
  });

  it("returns null outside the listing subtree", () => {
    expect(parseListingRoute("/app/provider")).toBeNull();
    expect(parseListingRoute("/app/overview")).toBeNull();
    expect(parseListingRoute("/app/provider/listingsish")).toBeNull();
  });

  it("rejects a residual escape (%25) without decoding twice", () => {
    expect(parseListingRoute(`${LISTING_ROOTS_PATH}/%2520`)).toEqual({ kind: "invalid" });
  });

  it("rejects slashes, backslashes and control characters", () => {
    expect(parseListingRoute(`${LISTING_ROOTS_PATH}/a/b`)).toEqual({ kind: "invalid" });
    expect(parseListingRoute(`${LISTING_ROOTS_PATH}/a%2Fb`)).toEqual({ kind: "invalid" });
    expect(parseListingRoute(`${LISTING_ROOTS_PATH}/a%5Cb`)).toEqual({ kind: "invalid" });
    expect(parseListingRoute(`${LISTING_ROOTS_PATH}/a%00b`)).toEqual({ kind: "invalid" });
  });

  it("rejects non-ASCII lookalike suffixes", () => {
    expect(parseListingRoute(`${LISTING_ROOTS_PATH}/${encodeURIComponent(LISTING)}%EF%BC%8Fextra`)).toEqual({
      kind: "invalid",
    });
  });

  it("rejects a non-canonical encoding that does not round-trip", () => {
    // Unnecessary escape of a character that encodeURIComponent leaves literal.
    expect(parseListingRoute(`${LISTING_ROOTS_PATH}/%6Fpenarc%3Alisting%3A${LISTING.slice(16)}`)).toEqual({
      kind: "invalid",
    });
  });

  it("rejects an unknown suffix appended to a valid id", () => {
    expect(parseListingRoute(`${LISTING_ROOTS_PATH}/${encodeURIComponent(LISTING)}x`)).toEqual({ kind: "invalid" });
  });

  it("builds a canonical href that re-encodes exactly once", () => {
    expect(listingRouteHref({ kind: "detail", listingId: LISTING })).toBe(
      `${LISTING_ROOTS_PATH}/${encodeURIComponent(LISTING)}`,
    );
    expect(listingRouteHref({ kind: "roots" })).toBe(LISTING_ROOTS_PATH);
    expect(listingRouteHref({ kind: "new" })).toBe(LISTING_NEW_PATH);
  });

  it("round-trips every canonical listing id through href + parser", () => {
    for (const listingId of [LISTING, LISTING_B]) {
      const parsed = parseListingRoute(listingRouteHref({ kind: "detail", listingId }));
      expect(parsed).toEqual({ kind: "detail", listingId });
    }
  });

  it("treats any listing-subtree path as a listing path", () => {
    expect(isListingPath(LISTING_ROOTS_PATH)).toBe(true);
    expect(isListingPath(`${LISTING_ROOTS_PATH}/bogus`)).toBe(true);
    expect(isListingPath("/app/provider")).toBe(false);
  });
});
