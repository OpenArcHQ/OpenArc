import {
  COMMERCE_API_ERRORS,
  COMMERCE_API_SCHEMA_VERSION,
  type CommerceHumanRole,
} from "@openarc/shared";
import { describe, expect, it, vi } from "vitest";

import type { AccountFlowController } from "../src/account/flow-controller.js";
import { ListingClient } from "../src/tenant/listing-client.js";
import {
  ListingController,
  appendCursor,
  canReadListings,
  canWriteListings,
  expectedLatestVersion,
  formatFixedPriceFromAtomic,
  parseFixedPriceToAtomic,
  derivedListingIdOf,
  resourceVersionOf,
  type ListingReadCoordinator,
} from "../src/tenant/listing-controller.js";

const META = {
  schemaVersion: COMMERCE_API_SCHEMA_VERSION,
  requestId: "018f47a2-3b4c-7def-8123-456789abcdef",
  buildSha: "0123456789abcdef0123456789abcdef01234567",
};

const V4 = "12345678-1234-4234-8123-123456789abc";
const ORG = `openarc:org:${V4}`;
const LISTING = `openarc:listing:${V4}`;
const PROVIDER = `openarc:provider:${V4}`;
const ACCOUNT_A = `openarc:account:${V4}`;
const ISO = "2026-01-01T00:00:00.000Z";
const DIGEST_A = `sha256:${"a".repeat(64)}`;
const DIGEST_B = `sha256:${"b".repeat(64)}`;

function success(data: unknown): Response {
  return new Response(JSON.stringify({ ok: true, data, meta: META }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function errorEnvelope(code: keyof typeof COMMERCE_API_ERRORS, status: number): Response {
  return new Response(
    JSON.stringify({
      ok: false,
      error: { code, message: COMMERCE_API_ERRORS[code].message, retryable: false },
      meta: META,
    }),
    { status, headers: { "content-type": "application/json" } },
  );
}

function owner(listingId = LISTING, activeVersion: string | null = null) {
  return {
    schemaVersion: "openarc.listing.v1",
    listingId,
    organizationId: ORG,
    providerId: PROVIDER,
    activeVersion,
    createdAt: ISO,
    updatedAt: ISO,
  };
}

function ownerVersion(
  version: string,
  options: { status?: string; originReviewState?: string; updatedAt?: string; listingId?: string } = {},
) {
  const status = options.status ?? "draft";
  const originReviewState = options.originReviewState ?? "unreviewed";
  const publishedAt = status === "active" ? ISO : null;
  return {
    schemaVersion: "openarc.listing-owner-version.v1",
    listingId: options.listingId ?? LISTING,
    organizationId: ORG,
    providerId: PROVIDER,
    version,
    kind: "api",
    title: "Listing title",
    description: "Listing description",
    manifest: {
      schemaVersion: "openarc.listing-manifest.v1",
      inputSchemaDigest: DIGEST_A,
      outputSchemaDigest: DIGEST_B,
    },
    price: {
      amount: {
        schemaVersion: "openarc.usdc-amount.v1",
        networkId: "eip155:5042002",
        asset: "USDC",
        representation: "erc20",
        decimals: 6,
        atomicAmount: "1000000",
      },
      pricingModel: "fixed",
    },
    evidenceContract: {
      schemaVersion: "openarc.receipt-contract.v1",
      receiptType: "receipt",
      receiptSchemaDigest: DIGEST_B,
      deliveryFields: ["field"],
    },
    endpointContract: { origin: "https://api.example.com", path: "/deliver" },
    originReviewState,
    termsRevision: "v1",
    privacySummary: "Privacy summary",
    paymentLane: "unavailable",
    availability: { status: "unavailable", rateLimitPerMinute: null },
    status,
    createdAt: ISO,
    updatedAt: options.updatedAt ?? ISO,
    publishedAt,
  };
}

function content() {
  return {
    kind: "api",
    title: "Listing title",
    description: "Listing description",
    manifest: {
      schemaVersion: "openarc.listing-manifest.v1",
      inputSchemaDigest: DIGEST_A,
      outputSchemaDigest: DIGEST_B,
    },
    price: {
      amount: {
        schemaVersion: "openarc.usdc-amount.v1",
        networkId: "eip155:5042002",
        asset: "USDC",
        representation: "erc20",
        decimals: 6,
        atomicAmount: "1000000",
      },
      pricingModel: "fixed",
    },
    evidenceContract: {
      schemaVersion: "openarc.receipt-contract.v1",
      receiptType: "receipt",
      receiptSchemaDigest: DIGEST_B,
      deliveryFields: ["field"],
    },
    endpointContract: { origin: "https://api.example.com", path: "/deliver" },
    termsRevision: "v1",
    privacySummary: "Privacy summary",
    paymentLane: "unavailable",
    availability: { status: "unavailable", rateLimitPerMinute: null },
  };
}

function fakeReads(
  role: CommerceHumanRole | null = "owner",
  organizationId: string | null = ORG,
): ListingReadCoordinator & { abortCalls: number; reloads: number } {
  const reads = {
    abortCalls: 0,
    reloads: 0,
    currentOrganizationId: () => organizationId,
    currentRole: () => role,
    currentAccountId: () => ACCOUNT_A,
    abortPendingReads() {
      reads.abortCalls += 1;
    },
    async reloadAfterCommit() {
      reads.reloads += 1;
    },
  };
  return reads;
}

function fakeAccount(initialAccountId: string | null = ACCOUNT_A) {
  let currentAccountId = initialAccountId;
  let generation = 0;
  const account = {
    get generation() {
      return generation;
    },
    state: {
      status: initialAccountId === null ? "signed-out" : "signed-in",
      csrfToken: "csrf" as string | null,
      session: initialAccountId === null
        ? { signedIn: false as const }
        : { signedIn: true as const, accountId: initialAccountId, method: "passkey", expiresAt: "2030-01-01T00:00:00.000Z" },
    },
    captureAccountBound() {
      return { generation, accountId: currentAccountId };
    },
    async mutate<T>(
      run: (context: {
        csrfToken: string;
        signal: AbortSignal;
        scope: { generation: number; isCurrent(): boolean };
        adopt: (data: { csrfToken: string; session: unknown }) => boolean;
      }) => Promise<T>,
    ): Promise<T> {
      if (currentAccountId === null || currentAccountId !== initialAccountId) {
        throw { failure: { kind: "account-changed" } } as unknown as Error;
      }
      return run({
        csrfToken: "csrf-from-bootstrap",
        signal: new AbortController().signal,
        scope: { generation, isCurrent: () => true },
        adopt: () => true,
      });
    },
    setAccount(id: string | null) {
      currentAccountId = id;
      generation += 1;
    },
  };
  return account as unknown as AccountFlowController & { setAccount(id: string | null): void };
}

function controllerWith(
  fetcher: typeof fetch,
  options: {
    role?: CommerceHumanRole | null;
    organizationId?: string | null;
    capability?: "enabled" | "unavailable";
    reads?: ListingReadCoordinator;
    account?: AccountFlowController;
  } = {},
) {
  const reads = options.reads ?? fakeReads(options.role ?? "owner", options.organizationId ?? ORG);
  const account = options.account ?? fakeAccount();
  const controller = new ListingController({
    account,
    reads,
    client: new ListingClient({ fetcher }),
    capabilityReader: async () => options.capability ?? "enabled",
  });
  return { controller, reads: reads as ReturnType<typeof fakeReads>, account };
}

const rootsPage = (items: unknown[], nextCursor: string | null = null) => ({
  organizationId: ORG,
  items,
  nextCursor,
});

const versionsPage = (items: unknown[], nextCursor: string | null = null) => ({
  organizationId: ORG,
  listingId: LISTING,
  providerId: PROVIDER,
  items,
  nextCursor,
});

describe("listing role matrix", () => {
  it("allows exactly owner, provider_admin and provider_developer to write", () => {
    expect(canWriteListings("owner")).toBe(true);
    expect(canWriteListings("provider_admin")).toBe(true);
    expect(canWriteListings("provider_developer")).toBe(true);
    expect(canWriteListings("operator")).toBe(false);
    expect(canWriteListings("viewer")).toBe(false);
    expect(canWriteListings(null)).toBe(false);
    expect(canWriteListings("unknown")).toBe(false);
  });

  it("lets every known role read and no unknown role", () => {
    for (const role of ["owner", "operator", "provider_admin", "provider_developer", "viewer"] as const) {
      expect(canReadListings(role)).toBe(true);
    }
    expect(canReadListings(null)).toBe(false);
    expect(canReadListings("unknown")).toBe(false);
  });
});

describe("listing price conversion", () => {
  it("converts exactly six decimals with BigInt and never Number", () => {
    expect(parseFixedPriceToAtomic("1")).toBe("1000000");
    expect(parseFixedPriceToAtomic("1.5")).toBe("1500000");
    expect(parseFixedPriceToAtomic("0.000001")).toBe("1");
    expect(formatFixedPriceFromAtomic("1000000")).toBe("1");
    expect(formatFixedPriceFromAtomic("1")).toBe("0.000001");
  });

  it("rejects zero, signs, exponents, whitespace and over-precision", () => {
    for (const bad of ["0", "0.0", "-1", "+1", "1e6", " 1", "01", "1.1234567", "", "abc"]) {
      expect(parseFixedPriceToAtomic(bad)).toBeNull();
    }
  });
});

describe("listing history helpers", () => {
  it("derives the latest version only from a final page", () => {
    expect(expectedLatestVersion([], false)).toBeNull();
    expect(expectedLatestVersion([ownerVersion("1")] as never, false)).toBeNull();
    expect(expectedLatestVersion([], true)).toBeNull();
    expect(expectedLatestVersion([ownerVersion("1"), ownerVersion("10")] as never, true)).toBe("10");
  });

  it("bounds the cursor stack at 20", () => {
    let stack: readonly string[] = [];
    for (let index = 0; index < 25; index += 1) stack = appendCursor(stack, String(index));
    expect(stack.length).toBe(20);
    expect(stack[0]).toBe("5");
    expect(stack[19]).toBe("24");
  });
});

describe("listing controller capability gate", () => {
  it("makes no listing request when the capability is unavailable", async () => {
    const fetcher = vi.fn(async () => success(rootsPage([])));
    const { controller } = controllerWith(fetcher as unknown as typeof fetch, { capability: "unavailable" });
    await controller.initialize({ kind: "roots" });
    expect(fetcher).not.toHaveBeenCalled();
    expect(controller.state.capability).toBe("unavailable");
  });

  it("loads roots only after the capability is enabled", async () => {
    const fetcher = vi.fn(async () => success(rootsPage([owner()])));
    const { controller } = controllerWith(fetcher as unknown as typeof fetch);
    await controller.initialize({ kind: "roots" });
    expect(controller.state.capability).toBe("enabled");
    expect(controller.state.roots.status).toBe("ready");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});

describe("listing controller reads", () => {
  it("bounds the root page and exposes an explicit next cursor", async () => {
    const fetcher = vi.fn(async (input: string) =>
      input.includes("afterListingId")
        ? success(rootsPage([], null))
        : success(rootsPage([owner()], LISTING)),
    );
    const { controller } = controllerWith(fetcher as unknown as typeof fetch);
    await controller.initialize({ kind: "roots" });
    expect(controller.state.roots.nextCursor).toBe(LISTING);
    await controller.loadNextRoots();
    expect(controller.state.roots.hasPrevious).toBe(true);
    const secondPath = (fetcher.mock.calls as unknown as Array<[string]>)[1]?.[0] ?? "";
    expect(secondPath).toContain(`afterListingId=${encodeURIComponent(LISTING)}`);
  });

  it("fetches root and first history independently and keeps a truthful not-found", async () => {
    const fetcher = vi.fn(async (input: string) =>
      input.includes("/versions")
        ? success(versionsPage([ownerVersion("1")]))
        : success({ organizationId: ORG, listingId: LISTING, item: null }),
    );
    const { controller } = controllerWith(fetcher as unknown as typeof fetch);
    await controller.initialize({ kind: "detail", listingId: LISTING });
    expect(controller.state.detail.status).toBe("not-found");
    expect(controller.state.detail.history.items).toHaveLength(1);
  });

  it("loads more versions with afterVersion and marks the final page complete", async () => {
    const fetcher = vi.fn(async (input: string) => {
      if (input.includes("/versions") && input.includes("afterVersion=10")) {
        return success(versionsPage([ownerVersion("11")], null));
      }
      if (input.includes("/versions")) {
        return success(versionsPage([ownerVersion("1"), ownerVersion("10")], "10"));
      }
      return success({ organizationId: ORG, listingId: LISTING, item: owner() });
    });
    const { controller } = controllerWith(fetcher as unknown as typeof fetch);
    await controller.initialize({ kind: "detail", listingId: LISTING });
    expect(controller.state.detail.history.historyComplete).toBe(false);
    expect(controller.state.detail.history.nextCursor).toBe("10");
    await controller.loadMoreVersions();
    expect(controller.state.detail.history.historyComplete).toBe(true);
    expect(controller.state.detail.history.cursorStack).toEqual(["10"]);
  });
});

describe("listing controller create version CAS", () => {
  it("sends expectedLatestVersion 10 when v1 is selected but the final page has v10", async () => {
    const routed = vi.fn(async (input: string, init?: RequestInit) => {
      if (init?.method === "POST" && input.endsWith("/versions")) {
        const body = JSON.parse(String(init.body)) as { mutationId: string };
        return success({
          replayed: false,
          receipt: {
            mutationId: body.mutationId,
            operation: "market.listing.version.create",
            resourceType: "listing_version",
            resourceId: `${LISTING}@2`,
            committedAt: ISO,
          },
        });
      }
      if (input.includes("/versions")) {
        return success(versionsPage([ownerVersion("1"), ownerVersion("10")], null));
      }
      return success({ organizationId: ORG, listingId: LISTING, item: owner() });
    });
    const { controller } = controllerWith(routed as unknown as typeof fetch);
    await controller.initialize({ kind: "detail", listingId: LISTING });
    expect(controller.state.detail.history.historyComplete).toBe(true);
    const v1 = controller.state.detail.history.items.find((item) => item.version === "1");
    expect(v1).toBeDefined();
    controller.selectVersion(v1!);
    expect(controller.beginCreateVersion(content() as never)).toBe(true);
    await controller.confirm();
    const postCalls = (routed.mock.calls as unknown as Array<[string, RequestInit]>).filter(
      ([, init]) => init?.method === "POST",
    );
    expect(postCalls.length).toBe(1);
    const body = JSON.parse(String(postCalls[0]![1].body)) as { expectedLatestVersion: string };
    expect(body.expectedLatestVersion).toBe("10");
  });

  it("refuses create version while the history is incomplete", async () => {
    const fetcher = vi.fn(async (input: string) => {
      if (input.includes("/versions")) return success(versionsPage([ownerVersion("1")], "1"));
      return success({ organizationId: ORG, listingId: LISTING, item: owner() });
    });
    const { controller } = controllerWith(fetcher as unknown as typeof fetch);
    await controller.initialize({ kind: "detail", listingId: LISTING });
    expect(controller.beginCreateVersion(content() as never)).toBe(false);
  });
});

describe("listing controller lifecycle CAS", () => {
  it("publishes with the exact version, expectedUpdatedAt and root expectedActiveVersion", async () => {
    const active = ownerVersion("1", { status: "draft", originReviewState: "approved", updatedAt: "2026-02-02T00:00:00.000Z" });
    const fetcher = vi.fn(async (input: string, init?: RequestInit) => {
      if (init?.method === "POST") {
        const body = JSON.parse(String(init.body)) as { mutationId: string; expectedUpdatedAt: string; expectedActiveVersion: string | null };
        return success({
          replayed: false,
          receipt: {
            mutationId: body.mutationId,
            operation: "market.listing.version.publish",
            resourceType: "listing_version",
            resourceId: `${LISTING}@1`,
            committedAt: ISO,
          },
        });
      }
      if (input.includes("/versions")) return success(versionsPage([active]));
      return success({ organizationId: ORG, listingId: LISTING, item: owner(LISTING, null) });
    });
    const { controller } = controllerWith(fetcher as unknown as typeof fetch);
    await controller.initialize({ kind: "detail", listingId: LISTING });
    controller.selectVersion(active as never);
    expect(controller.beginLifecycle("publish", active as never)).toBe(true);
    await controller.confirm();
    const post = (fetcher.mock.calls as unknown as Array<[string, RequestInit]>).find(([, init]) => init?.method === "POST");
    expect(post).toBeDefined();
    const body = JSON.parse(String(post![1].body)) as { expectedUpdatedAt: string; expectedActiveVersion: string | null };
    expect(body.expectedUpdatedAt).toBe("2026-02-02T00:00:00.000Z");
    expect(body.expectedActiveVersion).toBeNull();
    expect(controller.state.mutation.kind).toBe("committed");
  });

  it("keeps the committed receipt when the follow-up refresh fails", async () => {
    const active = ownerVersion("1", { status: "draft", originReviewState: "approved" });
    const reads = fakeReads();
    reads.reloadAfterCommit = async () => {
      throw new Error("refresh failed");
    };
    const fetcher = vi.fn(async (input: string, init?: RequestInit) => {
      if (init?.method === "POST") {
        const body = JSON.parse(String(init.body)) as { mutationId: string };
        return success({ replayed: false, receipt: { mutationId: body.mutationId, operation: "market.listing.version.publish", resourceType: "listing_version", resourceId: `${LISTING}@1`, committedAt: ISO } });
      }
      if (input.includes("/versions")) return success(versionsPage([active]));
      return success({ organizationId: ORG, listingId: LISTING, item: owner() });
    });
    const { controller } = controllerWith(fetcher as unknown as typeof fetch, { reads });
    await controller.initialize({ kind: "detail", listingId: LISTING });
    controller.selectVersion(active as never);
    controller.beginLifecycle("publish", active as never);
    await controller.confirm();
    expect(controller.state.mutation.kind).toBe("committed");
    if (controller.state.mutation.kind === "committed") {
      expect(controller.state.mutation.refreshError).toBe(true);
    }
  });

  it("requires an approved draft for publish and only active for pause", async () => {
    const fetcher = vi.fn(async (input: string) => {
      const draft = ownerVersion("1");
      if (input.includes("/versions")) return success(versionsPage([draft]));
      return success({ organizationId: ORG, listingId: LISTING, item: owner(LISTING, "1") });
    });
    const { controller } = controllerWith(fetcher as unknown as typeof fetch);
    await controller.initialize({ kind: "detail", listingId: LISTING });
    const draft = controller.state.detail.history.items[0]!;
    controller.selectVersion(draft);
    expect(controller.beginLifecycle("publish", draft)).toBe(false);
    expect(controller.beginLifecycle("pause", draft)).toBe(false);
  });
});

describe("listing controller context clearing", () => {
  it("clears selection, mutation and reads on clear()", async () => {
    const fetcher = vi.fn(async (input: string) => {
      if (input.includes("/versions")) return success(versionsPage([ownerVersion("1")]));
      return success({ organizationId: ORG, listingId: LISTING, item: owner() });
    });
    const { controller } = controllerWith(fetcher as unknown as typeof fetch);
    await controller.initialize({ kind: "detail", listingId: LISTING });
    controller.selectVersion(controller.state.detail.history.items[0]!);
    controller.clear();
    expect(controller.state.selection.selectedVersion).toBeNull();
    expect(controller.state.selection.prefill).toBeNull();
    expect(controller.state.mutation.kind).toBe("idle");
    expect(controller.state.detail.status).toBe("none");
    expect(controller.state.roots.status).toBe("none");
  });

  it("clears on a role change so a viewer never sees owner controls", async () => {
    const fetcher = vi.fn(async (input: string) => {
      if (input.includes("/versions")) return success(versionsPage([ownerVersion("1")]));
      return success({ organizationId: ORG, listingId: LISTING, item: owner() });
    });
    const reads = fakeReads("owner");
    const { controller } = controllerWith(fetcher as unknown as typeof fetch, { reads });
    await controller.initialize({ kind: "detail", listingId: LISTING });
    expect(controller.state.canWrite).toBe(true);
    reads.currentRole = () => "viewer";
    controller.reconcileRole("viewer");
    expect(controller.state.canWrite).toBe(false);
  });
});

describe("listing controller mutation outcomes", () => {
  it("treats a transport failure after send as outcome-unknown and never resends", async () => {
    let posts = 0;
    const active = ownerVersion("1", { status: "active", originReviewState: "approved" });
    const fetcher = vi.fn(async (input: string, init?: RequestInit) => {
      if (init?.method === "POST") {
        posts += 1;
        throw new Error("reset");
      }
      if (input.includes("/versions")) return success(versionsPage([active]));
      return success({ organizationId: ORG, listingId: LISTING, item: owner(LISTING, "1") });
    });
    const { controller } = controllerWith(fetcher as unknown as typeof fetch);
    await controller.initialize({ kind: "detail", listingId: LISTING });
    const draft = controller.state.detail.history.items[0]!;
    controller.selectVersion(draft);
    controller.beginLifecycle("retire", draft);
    await controller.confirm();
    expect(controller.state.mutation.kind).toBe("outcome-unknown");
    expect(posts).toBe(1);
  });

  it("maps a definite conflict to a reviewable conflict notice without auto-resubmission", async () => {
    const fetcher = vi.fn(async (input: string, init?: RequestInit) => {
      if (init?.method === "POST") return errorEnvelope("IDEMPOTENCY_CONFLICT", 409);
      if (input.includes("/versions")) {
        return success(versionsPage([ownerVersion("1", { status: "active", originReviewState: "approved" })]));
      }
      return success({ organizationId: ORG, listingId: LISTING, item: owner(LISTING, "1") });
    });
    const { controller } = controllerWith(fetcher as unknown as typeof fetch);
    await controller.initialize({ kind: "detail", listingId: LISTING });
    const active = controller.state.detail.history.items[0]!;
    controller.selectVersion(active);
    controller.beginLifecycle("pause", active);
    await controller.confirm();
    expect(controller.state.mutation.kind).toBe("rejected");
    if (controller.state.mutation.kind === "rejected") {
      expect(controller.state.mutation.notice.kind).toBe("conflict");
    }
  });
});

describe("listing receipt resource versions", () => {
  it("extracts v2+ version resources and null for a draft create", () => {
    expect(resourceVersionOf({
      mutationId: V4,
      operation: "market.listing.create",
      resourceType: "listing",
      resourceId: `openarc:listing:${V4}`,
      committedAt: ISO,
    } as never)).toBeNull();
    expect(resourceVersionOf({
      mutationId: V4,
      operation: "market.listing.version.create",
      resourceType: "listing_version",
      resourceId: `${LISTING}@2`,
      committedAt: ISO,
    } as never)).toBe("2");
  });

  it("opens the derived listing only after a committed first draft", async () => {
    const opened: string[] = [];
    let postedMutationId: string | null = null;
    const fetcher = vi.fn(async (input: string, init?: RequestInit) => {
      if (init?.method === "POST") {
        const body = JSON.parse(String(init.body)) as { mutationId: string };
        postedMutationId = body.mutationId;
        return success({
          replayed: false,
          receipt: {
            mutationId: body.mutationId,
            operation: "market.listing.create",
            resourceType: "listing",
            resourceId: `openarc:listing:${body.mutationId}`,
            committedAt: ISO,
          },
        });
      }
      return success({ organizationId: ORG, items: [], nextCursor: null });
    });
    const controller = new ListingController({
      account: fakeAccount(),
      reads: fakeReads(),
      client: new ListingClient({ fetcher: fetcher as unknown as typeof fetch }),
      capabilityReader: async () => "enabled",
      onCommittedListing: (listingId) => opened.push(listingId),
    });
    expect(derivedListingIdOf(`openarc:listing:${V4}`)).toBe(`openarc:listing:${V4}`);
    await controller.initialize({ kind: "new" });
    expect(opened).toEqual([]);
    expect(controller.beginCreateDraft(PROVIDER, content() as never)).toBe(true);
    await controller.confirm();
    expect(opened).toHaveLength(1);
    expect(postedMutationId).not.toBeNull();
    expect(opened[0]).toBe(`openarc:listing:${postedMutationId}`);
  });
});

describe("listing history continuation failure", () => {
  it("surfaces an explicit error, keeps the prior bounded page, disables create-version and recovers on retry", async () => {
    let failNext = true;
    const fetcher = vi.fn(async (input: string) => {
      if (input.includes("afterVersion=10")) {
        if (failNext) {
          failNext = false;
          throw new Error("continuation failed");
        }
        return success(versionsPage([ownerVersion("11")], null));
      }
      if (input.includes("/versions")) {
        return success(versionsPage([ownerVersion("1"), ownerVersion("10")], "10"));
      }
      return success({ organizationId: ORG, listingId: LISTING, item: owner() });
    });
    const { controller } = controllerWith(fetcher as unknown as typeof fetch);
    await controller.initialize({ kind: "detail", listingId: LISTING });
    expect(controller.state.detail.history.nextCursor).toBe("10");

    await controller.loadMoreVersions();
    const failed = controller.state.detail.history;
    expect(failed.status).toBe("error");
    // The one prior bounded page and cursor are preserved, not accumulated.
    expect(failed.items.map((item) => item.version)).toEqual(["1", "10"]);
    expect(failed.nextCursor).toBe("10");
    expect(failed.historyComplete).toBe(false);
    // No latest-version claim and no create-version action while failed.
    expect(controller.state.selection.knownLatestVersion).toBeNull();
    expect(controller.beginCreateVersion(content() as never)).toBe(false);

    // An explicit retry recovers to a final page.
    await controller.loadMoreVersions();
    const recovered = controller.state.detail.history;
    expect(recovered.status).toBe("ready");
    expect(recovered.historyComplete).toBe(true);
    expect(recovered.items.map((item) => item.version)).toEqual(["11"]);
    expect(controller.beginCreateVersion(content() as never)).toBe(true);
  });
});

describe("listing capability abort", () => {
  it("aborts the capability probe on clear/hidden and suppresses the late response", async () => {
    const deferred: { resolve: ((state: "enabled" | "unavailable") => void) | null } = { resolve: null };
    let receivedSignal: AbortSignal | null = null;
    const capabilityReader = (signal: AbortSignal) =>
      new Promise<"enabled" | "unavailable">((resolve) => {
        receivedSignal = signal;
        deferred.resolve = resolve;
      });
    const fetcher = vi.fn(async () => success(rootsPage([])));
    const controller = new ListingController({
      account: fakeAccount(),
      reads: fakeReads(),
      client: new ListingClient({ fetcher: fetcher as unknown as typeof fetch }),
      capabilityReader,
    });
    const pending = controller.initialize({ kind: "roots" });
    expect(controller.state.capability).toBe("checking");
    controller.clear();
    expect((receivedSignal as AbortSignal | null)?.aborted).toBe(true);
    deferred.resolve?.("enabled");
    await pending;
    expect(controller.state.capability).not.toBe("enabled");
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe("listing status mismatch never commits", () => {
  it("keeps outcome-unknown and makes no claim when the status receipt resource mismatches", async () => {
    let postedMutationId: string | null = null;
    const fetcher = vi.fn(async (input: string, init?: RequestInit) => {
      if (init?.method === "POST") {
        const body = JSON.parse(String(init.body)) as { mutationId: string };
        postedMutationId = body.mutationId;
        throw new Error("reset after send");
      }
      if (input.includes("listing-mutations/")) {
        return success({
          status: "committed",
          receipt: {
            mutationId: postedMutationId,
            operation: "market.listing.version.create",
            resourceType: "listing_version",
            resourceId: `${LISTING}@9`,
            committedAt: ISO,
          },
        });
      }
      if (input.includes("/versions")) {
        return success(versionsPage([ownerVersion("1")], null));
      }
      return success({ organizationId: ORG, listingId: LISTING, item: owner() });
    });
    const { controller } = controllerWith(fetcher as unknown as typeof fetch);
    await controller.initialize({ kind: "detail", listingId: LISTING });
    controller.selectVersion(controller.state.detail.history.items[0]!);
    expect(controller.beginCreateVersion(content() as never)).toBe(true);
    await controller.confirm();
    expect(controller.state.mutation.kind).toBe("outcome-unknown");

    await controller.checkStatus();
    const after = controller.state.mutation;
    expect(after.kind).toBe("outcome-unknown");
    if (after.kind === "outcome-unknown") {
      expect(after.checking).toBe(false);
      expect(after.statusMessage).not.toBeNull();
    }
  });
});
