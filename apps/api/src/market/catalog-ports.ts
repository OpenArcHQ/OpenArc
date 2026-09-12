import type {
  CommerceListingPublicVersion,
  CommerceMarketPublicProvider,
} from "@openarc/shared";
import type {
  ListPublicListingsInput,
  ListPublicListingsResult,
} from "@openarc/db";

/**
 * Structural seam over the reviewed `@openarc/db` MarketCatalogStore.
 *
 * The public catalog service depends ONLY on these three read-only methods with
 * their exact accepted signatures. It constructs no AuthService, session,
 * wallet or credential, imports no auth module, and can reach no raw pool,
 * client, SQL string or generic callback. The concrete runtime implementation
 * is the reviewed `MarketCatalogStore`; unit tests inject an honest fake.
 */

export interface MarketCatalogStorePort {
  listPublicListings(
    input?: ListPublicListingsInput,
  ): Promise<ListPublicListingsResult>;
  getPublicListing(
    listingId: string,
  ): Promise<CommerceListingPublicVersion | null>;
  getPublicProvider(
    providerId: string,
  ): Promise<CommerceMarketPublicProvider | null>;
}

export type {
  CommerceListingPublicVersion,
  CommerceMarketPublicProvider,
  ListPublicListingsInput,
  ListPublicListingsResult,
};
