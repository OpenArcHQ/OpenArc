import type { CommerceListingPublicVersion } from "@openarc/shared";

import {
  formatListingPrice,
  type MarketController,
  type MarketControllerState,
} from "./market-controller.js";

/**
 * Public provider profile plus its filtered first listing page. The display name
 * is the current (mutable) provider profile name, not an immutable version; the
 * listings reuse the accepted public list route with the providerId filter.
 */

export interface ProviderListingsPageProps {
  readonly controller: MarketController;
  readonly state: MarketControllerState;
  readonly providerId: string;
}

export function ProviderListingsPage({ controller, state }: ProviderListingsPageProps) {
  const gate = state.gate;
  return (
    <section aria-labelledby="market-provider-title">
      <p className="market-eyebrow">PUBLIC PROVIDER</p>
      <h1 className="market-title" id="market-provider-title">Provider profile</h1>
      {gate === "loading-capabilities" ? (
        <p className="market-status" role="status">Checking catalog availability…</p>
      ) : null}
      {gate === "unavailable" ? (
        <p className="market-status market-status--warning" role="status">
          The public catalog is not available in this deployment. No provider request was made.
        </p>
      ) : null}
      {gate === "enabled" ? <ProviderBody controller={controller} state={state} /> : null}
    </section>
  );
}

function ProviderBody(props: {
  controller: MarketController;
  state: MarketControllerState;
}) {
  const { provider } = props.state;
  if (provider.status === "loading") {
    return <p className="market-status" role="status" aria-live="polite">Loading provider…</p>;
  }
  if (provider.status === "not-found") {
    return (
      <p className="market-status" role="status">
        This provider is not available. No provider record was displayed.
      </p>
    );
  }
  if (provider.status === "error") {
    return (
      <p className="market-status market-status--error" role="alert">
        The provider could not be loaded right now. Try again.
      </p>
    );
  }
  const profile = provider.provider;
  if (profile === null) {
    return <p className="market-status" role="status">Choose a provider from a listing.</p>;
  }
  return (
    <article className="market-detail">
      <section className="market-panel" aria-labelledby="market-provider-name">
        <h2 id="market-provider-name">{profile.displayName}</h2>
        <dl className="market-meta">
          <dt>Provider ID</dt>
          <dd className="market-mono">{profile.providerId}</dd>
          <dt>Status</dt>
          <dd>
            <span className="market-pill market-pill--ok">{profile.status}</span>
          </dd>
          <dt>Profile schema</dt>
          <dd className="market-mono">{profile.schemaVersion}</dd>
        </dl>
        <p className="market-note" role="note">
          The display name is the current provider profile name, not an immutable version.
        </p>
      </section>

      <section aria-labelledby="market-provider-listings">
        <h2 id="market-provider-listings" className="market-title">Declared listings</h2>
        {provider.listings.status === "loading" ? (
          <p className="market-status" role="status">Loading listings…</p>
        ) : null}
        {provider.listings.status === "error" ? (
          <p className="market-status market-status--error" role="alert">
            The provider's listings could not be loaded right now.
          </p>
        ) : null}
        {provider.listings.status === "ready" && provider.listings.items.length === 0 ? (
          <p className="market-empty" role="status">This provider has no active declared listings.</p>
        ) : null}
        {provider.listings.items.length > 0 ? (
          <ul className="market-cards" aria-label="Provider listings">
            {provider.listings.items.map((item) => (
              <ProviderListingCard key={item.listingId} item={item} />
            ))}
          </ul>
        ) : null}
        {provider.listings.status === "ready" ? (
          <div className="market-pagination">
            {provider.listings.hasPrevious ? (
              <button
                type="button"
                className="market-button"
                onClick={() => void props.controller.loadPreviousProviderListings()}
              >
                Previous page
              </button>
            ) : null}
            <button
              type="button"
              className="market-button"
              disabled={provider.listings.nextCursor === null}
              onClick={() => void props.controller.loadNextProviderListings()}
            >
              Next page
            </button>
            <span className="market-pagination__status">
              {provider.listings.nextCursor === null
                ? "End of results."
                : "One bounded page at a time (≤ 50)."}
            </span>
          </div>
        ) : null}
      </section>
    </article>
  );
}

function ProviderListingCard({ item }: { item: CommerceListingPublicVersion }) {
  return (
    <li className="market-card">
      <div className="market-card__head">
        <h3 className="market-card__title">
          <a href={`/market/${encodeURIComponent(item.listingId)}`}>{item.title}</a>
        </h3>
        <span className="market-pill">{item.kind}</span>
      </div>
      <p className="market-card__desc">{item.description}</p>
      <p className="market-card__meta">
        <span className="market-price">{formatListingPrice(item.price.amount)} USDC</span>{" "}
        · version <span className="market-mono">{item.version}</span>
      </p>
    </li>
  );
}
