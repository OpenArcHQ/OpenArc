import {
  formatListingPrice,
  type MarketController,
  type MarketControllerState,
} from "./market-controller.js";

/**
 * Active public listing detail. Renders ONLY the shared public DTO fields: the
 * immutable version, kind, provider id, public title/description, bounded
 * manifest digests, exact USDC decimal price, endpoint ORIGIN (never the owner
 * path), receipt/delivery contract, terms revision, privacy summary and
 * publishedAt. No organization, account, review or private metadata exists in
 * the DTO to render, and there is no purchase control.
 */

export interface MarketDetailPageProps {
  readonly controller: MarketController;
  readonly state: MarketControllerState;
  readonly listingId: string;
}

export function MarketDetailPage({ controller, state }: MarketDetailPageProps) {
  const gate = state.gate;
  return (
    <section aria-labelledby="market-detail-title">
      <p className="market-eyebrow">PUBLIC LISTING</p>
      <h1 className="market-title" id="market-detail-title">Listing detail</h1>

      {gate === "loading-capabilities" ? (
        <p className="market-status" role="status">Checking catalog availability…</p>
      ) : null}
      {gate === "unavailable" ? (
        <p className="market-status market-status--warning" role="status">
          The public catalog is not available in this deployment. No listing request was made.
        </p>
      ) : null}
      {gate === "enabled" ? <DetailBody controller={controller} state={state} /> : null}
    </section>
  );
}

function DetailBody(props: {
  controller: MarketController;
  state: MarketControllerState;
}) {
  const { detail } = props.state;
  if (detail.status === "loading") {
    return <p className="market-status" role="status" aria-live="polite">Loading listing…</p>;
  }
  if (detail.status === "not-found") {
    return (
      <p className="market-status" role="status">
        This listing is not available. It may have been paused, retired or never published.
      </p>
    );
  }
  if (detail.status === "error") {
    return (
      <>
        <p className="market-status market-status--error" role="alert">
          {detail.failure === "invalid-response"
            ? "The listing returned an invalid response. Nothing was displayed."
            : "The listing could not be loaded right now. Try again."}
        </p>
        {detail.requestedListingId !== null ? (
          <div className="market-actions">
            <button
              type="button"
              className="market-button"
              onClick={() => void props.controller.loadListing(detail.requestedListingId as string)}
            >
              Retry listing
            </button>
          </div>
        ) : null}
      </>
    );
  }
  const item = detail.item;
  if (item === null) {
    return <p className="market-status" role="status">Choose a listing from the catalog.</p>;
  }
  return (
    <article className="market-detail">
      <header>
        <h2 className="market-title">{item.title}</h2>
        <p className="market-card__meta">
          <span className="market-pill">{item.kind}</span>{" "}
          <span className="market-pill market-pill--ok">ACTIVE</span>{" "}
          <span className="market-pill market-pill--gold">TESTNET</span>
        </p>
        <p className="market-lede">{item.description}</p>
      </header>

      <section className="market-panel" aria-labelledby="market-price-title">
        <h2 id="market-price-title">Price and availability</h2>
        <dl className="market-meta">
          <dt>Price</dt>
          <dd className="market-price">{formatListingPrice(item.price.amount)} USDC</dd>
          <dt>Pricing model</dt>
          <dd>{item.price.pricingModel}</dd>
          <dt>Environment</dt>
          <dd>Testnet ({item.price.amount.networkId})</dd>
          <dt>Declared availability</dt>
          <dd>
            {item.availability.status}
            {item.availability.rateLimitPerMinute !== null
              ? ` · ≤ ${item.availability.rateLimitPerMinute}/min`
              : ""}
          </dd>
          <dt>Purchase</dt>
          <dd>Not yet available. This catalog does not execute or authorize payments.</dd>
        </dl>
      </section>

      <section className="market-panel" aria-labelledby="market-version-title">
        <h2 id="market-version-title">Exact version</h2>
        <dl className="market-meta">
          <dt>Listing ID</dt>
          <dd className="market-mono">{item.listingId}</dd>
          <dt>Immutable version</dt>
          <dd className="market-mono">{item.version}</dd>
          <dt>Kind</dt>
          <dd>{item.kind}</dd>
          <dt>Provider</dt>
          <dd>
            <a href={`/providers/${encodeURIComponent(item.providerId)}`} className="market-mono">
              {item.providerId}
            </a>
          </dd>
          <dt>Published</dt>
          <dd className="market-mono">{item.publishedAt}</dd>
        </dl>
      </section>

      <section className="market-panel" aria-labelledby="market-manifest-title">
        <h2 id="market-manifest-title">Manifest</h2>
        <dl className="market-meta">
          <dt>Manifest schema</dt>
          <dd className="market-mono">{item.manifest.schemaVersion}</dd>
          <dt>Input digest</dt>
          <dd className="market-mono">{item.manifest.inputSchemaDigest}</dd>
          <dt>Output digest</dt>
          <dd className="market-mono">{item.manifest.outputSchemaDigest}</dd>
        </dl>
      </section>

      <section className="market-panel" aria-labelledby="market-contract-title">
        <h2 id="market-contract-title">Endpoint and receipt contract</h2>
        <dl className="market-meta">
          <dt>Endpoint origin</dt>
          <dd className="market-mono">{item.endpointOrigin}</dd>
          <dt>Receipt type</dt>
          <dd className="market-mono">{item.evidenceContract.receiptType}</dd>
          <dt>Receipt schema</dt>
          <dd className="market-mono">{item.evidenceContract.receiptSchemaDigest}</dd>
          <dt>Delivery fields</dt>
          <dd>
            <ul className="market-list">
              {item.evidenceContract.deliveryFields.map((field) => (
                <li key={field} className="market-mono">{field}</li>
              ))}
            </ul>
          </dd>
        </dl>
      </section>

      <section className="market-panel" aria-labelledby="market-terms-title">
        <h2 id="market-terms-title">Terms and privacy</h2>
        <dl className="market-meta">
          <dt>Terms revision</dt>
          <dd className="market-mono">{item.termsRevision}</dd>
          <dt>Privacy summary</dt>
          <dd>{item.privacySummary}</dd>
        </dl>
      </section>

      <p className="market-note" role="note">
        Origin review is manual metadata; it is not SSRF proof and is not an endorsement of the
        provider or the declared service.
      </p>
    </article>
  );
}
