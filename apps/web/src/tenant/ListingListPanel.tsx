import { useState } from "react";

import type {
  CommerceMarketListingContent,
  CommerceMarketProviderOption,
} from "@openarc/shared";

import { ListingEditorPanel } from "./ListingEditorPanel.js";
import type { ListingControllerState } from "./listing-controller.js";

/**
 * Bounded owner listing root list (25/50 per page with an explicit next page).
 *
 * The list never auto-loads and never accumulates pages: "Next page" replaces
 * the current page. The provider picker used for a new draft is a separate
 * protected endpoint, not the owner-only legacy provider list. Inactive
 * providers are visible but disabled for writes.
 */
export function ListingListPanel(props: {
  readonly state: ListingControllerState;
  readonly creating: boolean;
  readonly selectedProviderId: string | null;
  readonly onSelectProvider: (providerId: string) => void;
  readonly onStartCreate: () => void;
  readonly onCancelCreate: () => void;
  readonly onLoadRoots: () => void;
  readonly onNextRoots: () => void;
  readonly onLoadMoreProviders: () => void;
  readonly onSubmitDraft: (providerId: string, content: CommerceMarketListingContent) => void;
  readonly onOpenListing: (listingId: string) => void;
}) {
  const { roots } = props.state;
  const [providerId, setProviderId] = useState<string | null>(props.selectedProviderId);
  const list = props.state.providerOptions;

  if (props.creating) {
    return (
      <ListingEditorPanel
        mode="create-draft"
        providerOptions={list.items}
        providerOptionsStatus={list.status}
        selectedProviderId={providerId}
        onSelectProvider={(id) => {
          setProviderId(id);
          props.onSelectProvider(id);
        }}
        prefill={null}
        baseVersion={null}
        canWrite={props.state.canWrite}
        onSubmitDraft={props.onSubmitDraft}
        onSubmitVersion={() => undefined}
        onCancel={props.onCancelCreate}
        onLoadMoreProviders={props.onLoadMoreProviders}
        hasNextProviders={list.nextCursor !== null}
      />
    );
  }

  return (
    <section className="tenant-listings__list" aria-labelledby="listing-list-title">
      <div className="tenant-listings__list-header">
        <h2 className="tenant-title tenant-title--small" id="listing-list-title">
          Listings
        </h2>
        {roots.status === "none" ? (
          <button type="button" className="tenant-button tenant-button--primary" onClick={props.onLoadRoots}>
            Load listings
          </button>
        ) : (
          <button
            type="button"
            className="tenant-button tenant-button--primary"
            disabled={!props.state.canWrite}
            onClick={props.onStartCreate}
          >
            Create first draft
          </button>
        )}
      </div>
      {roots.status === "loading" ? (
        <p className="tenant-status" role="status">Loading listings…</p>
      ) : null}
      {roots.status === "error" ? (
        <p className="tenant-status tenant-status--error" role="alert">
          Listings could not be loaded right now.
        </p>
      ) : null}
      {roots.status === "ready" && roots.items.length === 0 ? (
        <p className="tenant-empty">No listings in this organization yet.</p>
      ) : null}
      {roots.items.length > 0 ? (
        <div className="tenant-table-wrap">
          <table className="tenant-table">
            <caption>Listings in this organization</caption>
            <thead>
              <tr>
                <th scope="col">Listing ID</th>
                <th scope="col">Provider</th>
                <th scope="col">Active version</th>
                <th scope="col">Updated</th>
                <th scope="col">Open</th>
              </tr>
            </thead>
            <tbody>
              {roots.items.map((item) => (
                <tr key={item.listingId}>
                  <td className="tenant-mono">{item.listingId}</td>
                  <td className="tenant-mono">{item.providerId}</td>
                  <td className="tenant-mono">{item.activeVersion ?? "none"}</td>
                  <td className="tenant-mono">{item.updatedAt}</td>
                  <td>
                    <button
                      type="button"
                      className="tenant-button"
                      onClick={() => props.onOpenListing(item.listingId)}
                    >
                      Open listing
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      {roots.status === "ready" ? (
        <div className="tenant-pagination">
          {roots.hasPrevious ? (
            <button type="button" className="tenant-button" onClick={props.onLoadRoots}>
              Back to page 1
            </button>
          ) : null}
          <button
            type="button"
            className="tenant-button"
            disabled={roots.nextCursor === null}
            onClick={props.onNextRoots}
          >
            Next page
          </button>
          <span className="tenant-pagination__status">Bounded page, replaces the current page.</span>
        </div>
      ) : null}
    </section>
  );
}

export type { CommerceMarketProviderOption };
