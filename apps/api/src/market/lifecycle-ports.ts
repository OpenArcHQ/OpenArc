import type {
  CommerceListingOwner,
  CommerceListingOwnerVersion,
} from "@openarc/shared";
import type {
  LifecycleMutationReceipt,
  LifecycleMutationResult,
  LifecycleTransitionInput,
  ListMarketProvidersInput,
  ListMarketProvidersResult,
  MarketMutationMetadata,
  OriginReviewInput,
} from "@openarc/db";

import type { TenantWriteAuthPort } from "../tenant/write-ports.js";

/**
 * Structural seam over the reviewed `@openarc/db` MarketLifecycleStore.
 *
 * The service depends ONLY on the eight frozen lifecycle methods with their
 * exact accepted signatures:
 *   getOwnerListing, listMarketProviders, getModeratorListingVersion,
 *   recordOriginReview, publishListingVersion, pauseListingVersion,
 *   retireListingVersion, getLifecycleMutationStatus.
 *
 * It cannot reach a raw pool, client, SQL string, generic callback or any
 * non-lifecycle operation. The concrete runtime implementation is the reviewed
 * `MarketLifecycleStore`; unit tests inject an honest fake. The raw idempotency
 * key is never logged, stored or echoed by this module.
 */

/** Closed lifecycle status result: a safe receipt or a truthful miss. */
export type MarketLifecycleMutationStatus =
  | { readonly status: "committed"; readonly receipt: LifecycleMutationReceipt }
  | { readonly status: "not_found" };

export interface MarketLifecycleStorePort {
  getOwnerListing(
    sessionHash: string,
    organizationId: string,
    listingId: string,
  ): Promise<CommerceListingOwner | null>;
  listMarketProviders(
    sessionHash: string,
    organizationId: string,
    options?: ListMarketProvidersInput,
  ): Promise<ListMarketProvidersResult>;
  getModeratorListingVersion(
    sessionHash: string,
    organizationId: string,
    listingId: string,
    version: string,
  ): Promise<CommerceListingOwnerVersion | null>;
  recordOriginReview(
    sessionHash: string,
    organizationId: string,
    listingId: string,
    version: string,
    input: OriginReviewInput,
    metadata: MarketMutationMetadata,
  ): Promise<LifecycleMutationResult>;
  publishListingVersion(
    sessionHash: string,
    organizationId: string,
    listingId: string,
    version: string,
    input: LifecycleTransitionInput,
    metadata: MarketMutationMetadata,
  ): Promise<LifecycleMutationResult>;
  pauseListingVersion(
    sessionHash: string,
    organizationId: string,
    listingId: string,
    version: string,
    input: LifecycleTransitionInput,
    metadata: MarketMutationMetadata,
  ): Promise<LifecycleMutationResult>;
  retireListingVersion(
    sessionHash: string,
    organizationId: string,
    listingId: string,
    version: string,
    input: LifecycleTransitionInput,
    metadata: MarketMutationMetadata,
  ): Promise<LifecycleMutationResult>;
  getLifecycleMutationStatus(
    sessionHash: string,
    organizationId: string,
    mutationId: string,
  ): Promise<MarketLifecycleMutationStatus>;
}

/**
 * Auth seam for the protected lifecycle family. This is EXACTLY the accepted
 * tenant write auth port: CSRF verification for writes plus the internal
 * read-session begin/finish guards. No new auth method is introduced and no
 * cookie is ever minted, rotated or cleared.
 */
export type MarketLifecycleAuthPort = TenantWriteAuthPort;

export type {
  CommerceListingOwner,
  CommerceListingOwnerVersion,
  LifecycleMutationReceipt,
  LifecycleMutationResult,
  LifecycleTransitionInput,
  ListMarketProvidersInput,
  ListMarketProvidersResult,
  MarketMutationMetadata,
  OriginReviewInput,
};
