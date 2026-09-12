import type { CommerceListingOwner, CommerceListingOwnerVersion } from "@openarc/shared";
import type {
  CreateListingVersionInput,
  ListOwnerListingVersionsInput,
  ListOwnerListingVersionsResult,
  ListOwnerListingsInput,
  ListOwnerListingsResult,
  MarketListingContent,
  MarketMutationMetadata,
  MarketMutationResult,
  MarketMutationStatus,
} from "@openarc/db";

import type { TenantWriteAuthPort } from "../tenant/write-ports.js";

/**
 * Structural seam over the accepted `@openarc/db` MarketStore.
 *
 * The service depends ONLY on the six frozen market methods with their exact
 * accepted signatures. It cannot reach a raw pool, client, SQL string, generic
 * callback or non-market operation. The concrete runtime implementation is the
 * reviewed `MarketStore`; unit tests inject an honest fake.
 *
 * Metadata is the canonical `{mutationId, idempotencyKey}` pair. The raw
 * idempotency key is never logged, stored or echoed by this module.
 */

export interface MarketStorePort {
  createListingDraft(
    sessionHash: string,
    organizationId: string,
    providerId: string,
    content: MarketListingContent,
    metadata: MarketMutationMetadata,
  ): Promise<MarketMutationResult>;
  createListingVersion(
    sessionHash: string,
    organizationId: string,
    listingId: string,
    input: CreateListingVersionInput,
    metadata: MarketMutationMetadata,
  ): Promise<MarketMutationResult>;
  listOwnerListings(
    sessionHash: string,
    organizationId: string,
    input: ListOwnerListingsInput,
  ): Promise<ListOwnerListingsResult>;
  listOwnerListingVersions(
    sessionHash: string,
    organizationId: string,
    listingId: string,
    input: ListOwnerListingVersionsInput,
  ): Promise<ListOwnerListingVersionsResult>;
  getOwnerListingVersion(
    sessionHash: string,
    organizationId: string,
    listingId: string,
    version: string,
  ): Promise<CommerceListingOwnerVersion | null>;
  getMarketMutationStatus(
    sessionHash: string,
    organizationId: string,
    mutationId: string,
  ): Promise<MarketMutationStatus>;
}

/**
 * Auth seam for the protected market family. This is EXACTLY the accepted
 * tenant write auth port: CSRF verification for writes plus the internal
 * read-session begin/finish guards. The market service introduces no new auth
 * method and never mints, rotates or clears a cookie.
 */
export type MarketAuthPort = TenantWriteAuthPort;

/** Validated response data shapes returned by the six market methods. */
export type {
  CommerceListingOwner,
  CommerceListingOwnerVersion,
  MarketListingContent,
  MarketMutationMetadata,
  MarketMutationResult,
  MarketMutationStatus,
};
