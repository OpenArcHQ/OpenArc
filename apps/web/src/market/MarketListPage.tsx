import {
  CommerceListingKindSchema,
  type CommerceListingKind,
  type CommerceListingPublicVersion,
} from "@openarc/shared";
import { useState, type FormEvent } from "react";

import {
  formatListingPrice,
  type MarketController,
  type MarketControllerState,
  type MarketListSection,
} from "./market-controller.js";

/**
 * Public catalog index. Every value is rendered as React text (never HTML) and
 * only from the shared public DTO. There is no buy/connect/approve/review or
 * create control here, and no query is ever written to the URL or storage.
 */

const KIND_OPTIONS: readonly CommerceListingKind[] = CommerceListingKindSchema.options;

export interface MarketListPageProps {
  readonly controller: MarketController;
  readonly state: MarketControllerState;
}

export function MarketListPage({ controller, state }: MarketListPageProps) {
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState<"all" | CommerceListingKind>("all");
  const [providerId, setProviderId] = useState("");
  const gate = state.gate;

  const submitSearch = (event: FormEvent) => {
    event.preventDefault();
    void controller.applyFilters({
      q: query.trim() === "" ? null : query,
      kind: kind === "all" ? null : kind,
      providerId: providerId.trim() === "" ? null : providerId.trim(),
    });
  };

  return (
    <section aria-labelledby="market-list-title">
      <p className="market-eyebrow">PUBLIC CATALOG</p>
      <h1 className="market-title" id="market-list-title">Declared provider services</h1>
      <p className="market-lede">
        OpenArc connects provider APIs and agents with permissions and evidence. This catalog
        previews declared services; it does not execute a purchase or prove payment, delivery,
        quality or security.
      </p>

      {gate === "unavailable" ? <GateUnavailable /> : null}
      {gate === "loading-capabilities" ? (
        <p className="market-status" role="status">Checking catalog availability…</p>
      ) : null}
      {gate === "enabled" ? (
        <>
          <form className="market-toolbar" onSubmit={submitSearch} aria-label="Catalog filters">
            <div className="market-field">
              <label htmlFor="market-q">Search declared titles</label>
              <input
                id="market-q"
                className="market-input"
                type="text"
                value={query}
                maxLength={80}
                autoComplete="off"
                onChange={(event) => setQuery(event.target.value)}
              />
            </div>
            <div className="market-field">
              <label htmlFor="market-kind">Kind</label>
              <select
                id="market-kind"
                className="market-select"
                value={kind}
                onChange={(event) => setKind(event.target.value as "all" | CommerceListingKind)}
              >
                <option value="all">All kinds</option>
                {KIND_OPTIONS.map((option) => (
                  <option key={option} value={option}>{optionLabel(option)}</option>
                ))}
              </select>
            </div>
            <div className="market-field">
              <label htmlFor="market-provider">Provider ID</label>
              <input
                id="market-provider"
                className="market-input"
                type="text"
                value={providerId}
                autoComplete="off"
                placeholder="openarc:provider:…"
                onChange={(event) => setProviderId(event.target.value)}
              />
            </div>
            <button type="submit" className="market-button market-button--primary">
              Search catalog
            </button>
          </form>

          <ListBody controller={controller} list={state.list} />
        </>
      ) : null}
    </section>
  );
}

function ListBody(props: {
  controller: MarketController;
  list: MarketListSection;
}) {
  const { list, controller } = props;
  return (
    <>
      {list.status === "loading" ? (
        <p className="market-status" role="status" aria-live="polite">Loading listings…</p>
      ) : null}
      {list.status === "error" ? (
        <>
          <p className="market-status market-status--error" role="alert">
            {failureCopy(list.failure)}
          </p>
          <div className="market-actions">
            <button
              type="button"
              className="market-button"
              onClick={() => void controller.retryList()}
            >
              Retry catalog
            </button>
          </div>
        </>
      ) : null}
      {list.status === "ready" && list.items.length === 0 ? (
        <p className="market-empty" role="status">No declared services match these filters.</p>
      ) : null}
      {list.items.length > 0 ? (
        <ul className="market-cards" aria-label="Public listings">
          {list.items.map((item) => (
            <ListingCard key={item.listingId} item={item} />
          ))}
        </ul>
      ) : null}
      {list.status === "ready" ? (
        <div className="market-pagination">
          {list.hasPrevious ? (
            <button
              type="button"
              className="market-button"
              onClick={() => void controller.loadPreviousList()}
            >
              Previous page
            </button>
          ) : null}
          <button
            type="button"
            className="market-button"
            disabled={list.nextCursor === null}
            onClick={() => void controller.loadNextList()}
          >
            Next page
          </button>
          <span className="market-pagination__status">
            {list.nextCursor === null
              ? "End of results."
              : "One bounded page at a time (≤ 50)."}
          </span>
        </div>
      ) : null}
    </>
  );
}

function ListingCard({ item }: { item: CommerceListingPublicVersion }) {
  return (
    <li className="market-card">
      <div className="market-card__head">
        <h2 className="market-card__title">
          <a href={`/market/${encodeURIComponent(item.listingId)}`}>{item.title}</a>
        </h2>
        <span className="market-pill">{item.kind}</span>
      </div>
      <p className="market-card__desc">{item.description}</p>
      <p className="market-card__meta">
        <span className="market-price">{formatListingPrice(item.price.amount)} USDC</span>{" "}
        · fixed price
      </p>
      <p className="market-card__meta">
        Version <span className="market-mono">{item.version}</span> · provider{" "}
        <a href={`/providers/${encodeURIComponent(item.providerId)}`} className="market-mono">
          {item.providerId}
        </a>
      </p>
    </li>
  );
}

export function GateUnavailable() {
  return (
    <p className="market-status market-status--warning" role="status">
      The public catalog is not available in this deployment right now. No catalog request was
      made.
    </p>
  );
}

function failureCopy(failure: MarketListSection["failure"]): string {
  switch (failure) {
    case "invalid-response":
      return "The catalog returned an invalid response. Nothing was displayed.";
    case "feature-disabled":
      return "The public catalog is disabled for this deployment.";
    case "unavailable":
    default:
      return "The catalog could not be loaded right now. Try again.";
  }
}

function optionLabel(kind: CommerceListingKind): string {
  switch (kind) {
    case "api":
      return "API";
    case "mcp_tool":
      return "MCP tool";
    case "data":
      return "Data";
    case "model":
      return "Model";
    case "workflow":
      return "Workflow";
    case "agent":
      return "Agent";
  }
}
