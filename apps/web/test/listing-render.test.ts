import { describe, expect, it, vi } from "vitest";

import { ListingClient } from "../src/tenant/listing-client.js";
import {
  ListingController,
  canWriteListings,
  initialListingControllerState,
  renderListingState,
  suppressStaleListingContext,
  type ListingReadCoordinator,
} from "../src/tenant/listing-controller.js";
import { listingRouteHref, parseListingRoute } from "../src/tenant/listing-routes.js";

const ORG = "openarc:org:12345678-1234-4234-8123-123456789abc";
const LISTING = "openarc:listing:12345678-1234-4234-8123-123456789abc";
const ACCOUNT_A = "openarc:account:12345678-1234-4234-8123-123456789abc";
const ACCOUNT_B = "openarc:account:87654321-4321-4321-b123-abcdefabcdef";

function reads(role = "owner", organizationId: string | null = ORG, accountId = ACCOUNT_A) {
  return {
    currentOrganizationId: () => organizationId,
    currentRole: () => role,
    currentAccountId: () => accountId,
    abortPendingReads: () => undefined,
    reloadAfterCommit: async () => undefined,
  } satisfies ListingReadCoordinator;
}

describe("synchronous listing render guard", () => {
  it("does not suppress the first binding", () => {
    expect(
      suppressStaleListingContext(null, { accountId: ACCOUNT_A, organizationId: ORG, role: "owner" }),
    ).toBe(false);
  });

  it("suppresses an account change synchronously", () => {
    expect(
      suppressStaleListingContext(
        { accountId: ACCOUNT_A, organizationId: ORG, role: "owner" },
        { accountId: ACCOUNT_B, organizationId: ORG, role: "owner" },
      ),
    ).toBe(true);
  });

  it("suppresses an organization or role change", () => {
    expect(
      suppressStaleListingContext(
        { accountId: ACCOUNT_A, organizationId: ORG, role: "owner" },
        { accountId: ACCOUNT_A, organizationId: "openarc:org:87654321-4321-4321-b123-abcdefabcdef", role: "owner" },
      ),
    ).toBe(true);
    expect(
      suppressStaleListingContext(
        { accountId: ACCOUNT_A, organizationId: ORG, role: "owner" },
        { accountId: ACCOUNT_A, organizationId: ORG, role: "viewer" },
      ),
    ).toBe(true);
  });

  it("suppresses when the current identity is lost", () => {
    expect(
      suppressStaleListingContext(
        { accountId: ACCOUNT_A, organizationId: ORG, role: "owner" },
        { accountId: null, organizationId: ORG, role: "owner" },
      ),
    ).toBe(true);
  });

  it("renders the initial state whenever suppressed", () => {
    const state = initialListingControllerState();
    expect(renderListingState(true, state)).toEqual(initialListingControllerState());
    expect(renderListingState(false, state)).toBe(state);
  });
});

describe("listing render-state isolation across contexts", () => {
  it("clears selected version and mutation state when the role changes to readonly", async () => {
    const state = initialListingControllerState();
    let currentRole = "owner";
    const coordinator = reads();
    coordinator.currentRole = () => currentRole;
    const fetcher = vi.fn(async (input: string) => {
      if (input.includes("/versions")) {
        return new Response(JSON.stringify({ ok: true, data: { organizationId: ORG, listingId: LISTING, providerId: "openarc:provider:12345678-1234-4234-8123-123456789abc", items: [], nextCursor: null }, meta: { schemaVersion: "openarc.api.v2", requestId: "018f47a2-3b4c-7def-8123-456789abcdef", buildSha: "0123456789abcdef0123456789abcdef01234567" } }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response(JSON.stringify({ ok: true, data: { organizationId: ORG, listingId: LISTING, item: null }, meta: { schemaVersion: "openarc.api.v2", requestId: "018f47a2-3b4c-7def-8123-456789abcdef", buildSha: "0123456789abcdef0123456789abcdef01234567" } }), { status: 200, headers: { "content-type": "application/json" } });
    });
    const controller = new ListingController({
      account: { captureAccountBound: () => ({ generation: 0, accountId: ACCOUNT_A }), mutate: async (run: never) => run } as never,
      reads: coordinator,
      client: new ListingClient({ fetcher: fetcher as unknown as typeof fetch }),
      capabilityReader: async () => "enabled",
    });
    await controller.initialize({ kind: "detail", listingId: LISTING });
    expect(controller.state.canWrite).toBe(true);
    currentRole = "viewer";
    controller.reconcileRole("viewer");
    expect(controller.state.canWrite).toBe(false);
    expect(controller.state.detail.status).toBe("none");
    expect(controller.state.selection.selectedVersion).toBeNull();
    expect(state.canWrite).toBe(false);
  });

  it("has no write controls for an unknown role", () => {
    expect(canWriteListings(undefined)).toBe(false);
    expect(canWriteListings("nobody")).toBe(false);
  });
});

describe("route identity for render", () => {
  it("changes identity between roots, new and detail", () => {
    expect(parseListingRoute("/app/provider/listings")).toEqual({ kind: "roots" });
    expect(parseListingRoute("/app/provider/listings/new")).toEqual({ kind: "new" });
    expect(parseListingRoute(listingRouteHref({ kind: "detail", listingId: LISTING }))).toEqual({
      kind: "detail",
      listingId: LISTING,
    });
  });
});
