import type { MarketplaceCapabilityManifest } from "@openarc/shared";
import { useEffect, useRef, useState } from "react";

import { marketApiBoundaryEnabled } from "./availability.js";
import { MarketClient, MarketApiError } from "./market-client.js";

/**
 * Static public information routes plus a capability status read.
 *
 * `/docs` and `/legal` are static: no auth, no network, no controller. `/status`
 * may fetch ONLY the new marketplace capability manifest, and only when the
 * accepted API boundary is enabled; it never constructs the catalog controller,
 * never queries the catalog and never touches a protected resource.
 */

export type MarketInfoKind = "docs" | "status" | "legal";

export interface MarketInfoPageProps {
  readonly kind: MarketInfoKind;
}

export function MarketInfoPage({ kind }: MarketInfoPageProps) {
  if (kind === "docs") return <MarketDocsPage />;
  if (kind === "status") return <MarketStatusPage />;
  return <MarketLegalPage />;
}

function MarketDocsPage() {
  return (
    <section aria-labelledby="market-docs-title">
      <p className="market-eyebrow">PRODUCT GUIDE</p>
      <h1 className="market-title" id="market-docs-title">How the public catalog works</h1>
      <p className="market-lede">
        OpenArc connects provider APIs and agents with permissions and evidence. This catalog is a
        preview of declared services; it does not execute a purchase or prove payment, delivery,
        quality or security.
      </p>
      <ol className="market-steps">
        <li>
          <strong>Step 1 · Browse</strong>
          Browse declared public listings and providers. Filters and search apply only to the
          current in-memory page.
        </li>
        <li>
          <strong>Step 2 · Read the exact version</strong>
          Open a listing to read its immutable version, manifest digests, endpoint origin, receipt
          contract, terms revision and privacy summary.
        </li>
        <li>
          <strong>Step 3 · Purchases are not yet available</strong>
          Buying is not implemented. The catalog never authorizes a payment, and viewing a listing
          is not purchase authority.
        </li>
      </ol>
      <section className="market-panel" aria-labelledby="market-docs-account">
        <h2 id="market-docs-account">Account options</h2>
        <p className="market-status">
          Accounts may use a wallet or a passkey. OpenArc requires only minimal credential and
          security records; a name and email are not mandatory, and a guest path remains
          available. Signing in to your account is not permission to pay and is not proof that any
          catalog listing executes.
        </p>
      </section>
      <div className="market-actions">
        <a className="market-button" href="/design/docs">Read the legacy evidence-engine guide</a>
        <a className="market-button market-button--primary" href="/market">Browse the catalog</a>
      </div>
    </section>
  );
}

function MarketLegalPage() {
  return (
    <section aria-labelledby="market-legal-title">
      <p className="market-eyebrow">PRODUCT &amp; PRIVACY INFORMATION</p>
      <h1 className="market-title" id="market-legal-title">Product and privacy information</h1>
      <p className="market-lede">
        This page describes what the public catalog does and how its data is classified. It is
        product information, not a formal legal agreement, and it names no retention period,
        support contact or legal guarantee.
      </p>
      <section className="market-panel" aria-labelledby="market-legal-public">
        <h2 id="market-legal-public">Public listing metadata and public chain facts</h2>
        <p className="market-status">
          Public listing metadata (title, description, kind, version, price, manifest digests,
          endpoint origin, receipt contract, terms revision, privacy summary, publishedAt and
          declared availability) and public chain facts are public read data. They are displayed
          as-is from the shared public DTO.
        </p>
      </section>
      <section className="market-panel" aria-labelledby="market-legal-protected">
        <h2 id="market-legal-protected">Protected account and provider records</h2>
        <p className="market-status">
          Protected account and provider records are separate. They are not exposed by the public
          catalog, and reading a public listing does not grant access to them. The catalog displays
          only the shared public DTO fields.
        </p>
      </section>
      <p className="market-note" role="note">
        No anonymous or zero-retention claim is made here. Retention duration, support contact
        details and formal legal terms are intentionally not invented.
      </p>
      <div className="market-actions">
        <a className="market-button" href="/docs">Read the product guide</a>
        <a className="market-button" href="/market">Browse the catalog</a>
      </div>
    </section>
  );
}

type StatusState =
  | { readonly kind: "disabled" }
  | { readonly kind: "loading" }
  | { readonly kind: "ready"; readonly manifest: MarketplaceCapabilityManifest }
  | { readonly kind: "unavailable" };

function MarketStatusPage() {
  const enabled = marketApiBoundaryEnabled();
  const [status, setStatus] = useState<StatusState>(
    enabled ? { kind: "loading" } : { kind: "disabled" },
  );
  // One in-flight capability read per component instance. React development
  // StrictMode re-runs mount effects; caching the promise keeps the read to
  // exactly one request without leaving a late state update behind.
  const capabilityRead = useRef<Promise<MarketplaceCapabilityManifest> | null>(null);

  useEffect(() => {
    // The status read constructs its OWN capability client (never the catalog
    // controller) and only when the API boundary is enabled.
    if (!marketApiBoundaryEnabled()) return;
    if (capabilityRead.current === null) {
      capabilityRead.current = new MarketClient().readCapabilities(
        new AbortController().signal,
      );
    }
    let cancelled = false;
    void capabilityRead.current
      .then((manifest) => {
        if (!cancelled) setStatus({ kind: "ready", manifest });
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        if (error instanceof MarketApiError && error.failure.kind === "aborted") return;
        setStatus({ kind: "unavailable" });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <section aria-labelledby="market-status-title">
      <p className="market-eyebrow">CAPABILITY STATUS</p>
      <h1 className="market-title" id="market-status-title">Marketplace capabilities</h1>
      <p className="market-lede">
        These are the declared capability families from the marketplace manifest. A family marked
        enabled is a contract statement, not a grant of a role and not proof of a live route.
      </p>
      {status.kind === "disabled" ? (
        <p className="market-status market-status--warning" role="status">
          The capability status check is unavailable because the API boundary is disabled. No
          request was made.
        </p>
      ) : null}
      {status.kind === "loading" ? (
        <p className="market-status" role="status">Reading marketplace capabilities…</p>
      ) : null}
      {status.kind === "unavailable" ? (
        <p className="market-status market-status--error" role="alert">
          Marketplace capabilities could not be read right now. No catalog request was made.
        </p>
      ) : null}
      {status.kind === "ready" ? (
        <>
          <dl className="market-meta">
            <dt>Capability version</dt>
            <dd className="market-mono">{status.manifest.capabilityVersion}</dd>
            <dt>Environment</dt>
            <dd>{status.manifest.environment}</dd>
            <dt>Network</dt>
            <dd className="market-mono">{status.manifest.network}</dd>
          </dl>
          <ul className="market-cards" aria-label="Capability families">
            {status.manifest.capabilities.map((entry) => (
              <li className="market-card" key={entry.family}>
                <div className="market-card__head">
                  <h2 className="market-card__title">{entry.family}</h2>
                  <span
                    className={`market-pill ${
                      entry.state === "enabled" ? "market-pill--ok" : ""
                    }`}
                  >
                    {entry.state}
                  </span>
                </div>
                <p className="market-card__meta">
                  Audience: {entry.audience} · dependencies: {entry.dependencies.join(", ")}
                </p>
              </li>
            ))}
          </ul>
        </>
      ) : null}
      <div className="market-actions">
        <a className="market-button" href="/market">Browse the catalog</a>
        <a className="market-button" href="/docs">Read the product guide</a>
      </div>
    </section>
  );
}
