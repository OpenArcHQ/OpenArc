import type { CommerceListingOwnerVersion } from "@openarc/shared";

import type { ListingVersionHistoryState } from "./listing-controller.js";

/**
 * Immutable, ascending version history with explicit bounded pagination.
 *
 * Only the current page is rendered. "Load more versions" is the single
 * explicit action that advances `afterVersion`; there is no auto-load and no
 * unbounded accumulation. Create-version stays disabled until the history is
 * known complete, and an empty/errored history is presented as missing rather
 * than as version 0.
 */
export function ListingVersionHistory(props: {
  readonly history: ListingVersionHistoryState;
  readonly selectedVersion: CommerceListingOwnerVersion | null;
  readonly onLoadMore: () => void;
  readonly onSelect: (version: CommerceListingOwnerVersion) => void;
}) {
  const { history } = props;
  const latest = history.historyComplete && history.items.length > 0
    ? history.items[history.items.length - 1]?.version
    : null;
  return (
    <section className="tenant-listings__history" aria-labelledby="listing-history-title">
      <h2 className="tenant-title tenant-title--small" id="listing-history-title">
        Version history
      </h2>
      <p className="tenant-status" role="status">
        {history.historyComplete
          ? `All versions loaded. Latest known version: ${latest ?? "none"}.`
          : "History is incomplete. Load more versions before creating a new version."}
      </p>
      {history.status === "loading" ? (
        <p className="tenant-status" role="status">Loading versions…</p>
      ) : null}
      {history.status === "error" ? (
        <p className="tenant-status tenant-status--error" role="alert">
          Version history could not be loaded. A missing history is not an empty one.
        </p>
      ) : null}
      {history.status === "ready" && history.items.length === 0 ? (
        <p className="tenant-empty">No versions are available for this listing.</p>
      ) : null}
      {history.items.length > 0 ? (
        <div className="tenant-table-wrap">
          <table className="tenant-table">
            <caption>Immutable versions for this listing</caption>
            <thead>
              <tr>
                <th scope="col">Version</th>
                <th scope="col">Status</th>
                <th scope="col">Origin review</th>
                <th scope="col">Updated</th>
                <th scope="col">Action</th>
              </tr>
            </thead>
            <tbody>
              {history.items.map((version) => {
                const selected = props.selectedVersion?.version === version.version;
                return (
                  <tr key={version.version}>
                    <td className="tenant-mono">{version.version}</td>
                    <td>{version.status}</td>
                    <td>{version.originReviewState}</td>
                    <td className="tenant-mono">{version.updatedAt}</td>
                    <td>
                      <button
                        type="button"
                        className="tenant-button"
                        aria-pressed={selected}
                        onClick={() => props.onSelect(version)}
                      >
                        {selected ? "Selected as new-version base" : "Use as new-version base"}
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : null}
      {!history.historyComplete && history.nextCursor !== null ? (
        <div className="tenant-actions">
          <button
            type="button"
            className="tenant-button"
            disabled={history.status === "loading"}
            onClick={props.onLoadMore}
          >
            Load more versions
          </button>
        </div>
      ) : null}
    </section>
  );
}
