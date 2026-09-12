import { useEffect, useMemo, useRef, useState } from "react";

import {
  MarketController,
  initialMarketState,
  resolveMarketRoute,
  type MarketControllerState,
  type MarketInfoKind,
  type MarketRoute,
} from "./market-controller.js";
import { MarketListPage } from "./MarketListPage.js";
import { MarketDetailPage } from "./MarketDetailPage.js";
import { ProviderListingsPage } from "./ProviderListingsPage.js";
import { MarketInfoPage } from "./MarketInfoPage.js";
import { marketCatalogActive } from "./availability.js";

import marketCssUrl from "./market.css?url";

/**
 * Public marketplace shell and router.
 *
 * The flag gate renders a static disabled shell and constructs NO controller,
 * so a disabled deployment makes zero catalog requests. When enabled, the
 * catalog controller is constructed once for the component lifetime and the
 * scoped stylesheet is mounted as a same-origin <link> that is removed on
 * unmount (strict CSP: no inline style, no global reset leak).
 */

function useMarketStyles(): void {
  useEffect(() => {
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = marketCssUrl;
    link.dataset.marketStyle = "true";
    document.head.append(link);
    return () => link.remove();
  }, []);
}

function currentPath(): string {
  if (typeof window === "undefined") return "/market";
  return window.location.pathname;
}

export default function MarketApp() {
  const catalogEnabled = useMemo(() => marketCatalogActive(), []);
  const [path, setPath] = useState(currentPath);
  const route = resolveMarketRoute(path);
  const catalogRoute =
    route.kind === "list" || route.kind === "detail" || route.kind === "provider";
  const catalogActive = catalogEnabled && catalogRoute;
  const [state, setState] = useState<MarketControllerState>(() =>
    initialMarketState(catalogActive ? "loading-capabilities" : "disabled"),
  );
  const controllerRef = useRef<MarketController | null>(null);

  useMarketStyles();

  useEffect(() => {
    const onPopState = () => setPath(currentPath());
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  // The catalog controller is constructed ONLY for the three catalog routes and
  // ONLY when the catalog flag and the accepted API boundary are both enabled.
  // Info routes (`/docs`, `/status`, `/legal`) never construct it, and a
  // disabled deployment issues no catalog request.
  useEffect(() => {
    if (!catalogActive) return;
    // A fresh controller per mount keeps React's development double-invoke
    // safe: the first instance is disposed and the second owns the reads.
    const controller = new MarketController({ enabled: true, onState: setState });
    controllerRef.current = controller;
    void controller.loadCapabilities();
    return () => {
      controller.dispose();
      if (controllerRef.current === controller) controllerRef.current = null;
    };
  }, [catalogActive]);

  // A route change clears all visible catalog data synchronously and aborts
  // in-flight reads.
  useEffect(() => {
    const controller = controllerRef.current;
    if (controller === null) return;
    controller.reset();
  }, [path]);

  // The route's data load waits for the capability gate. The catalog read is
  // only issued after the manifest reports `public_catalog` enabled, so no
  // catalog request races the capability check.
  useEffect(() => {
    const controller = controllerRef.current;
    if (controller === null) return;
    if (state.gate !== "enabled") return;
    const next = resolveMarketRoute(path);
    if (next.kind === "detail") void controller.loadListing(next.listingId);
    else if (next.kind === "provider") void controller.loadProvider(next.providerId);
    else if (next.kind === "list") void controller.loadList();
  }, [path, state.gate]);

  // Static information routes always render with no catalog controller and no
  // auth, regardless of either build flag. `/status` owns its own
  // API-boundary-gated capability read inside `MarketInfoPage`.
  if (route.kind === "info") {
    return (
      <Shell route={route}>
        <MarketInfoPage kind={route.info} />
      </Shell>
    );
  }

  if (!catalogEnabled) return <DisabledShell />;

  return (
    <Shell route={route}>
      {route.kind === "list" ? (
        <MarketListPage controller={controllerRef.current as MarketController} state={state} />
      ) : null}
      {route.kind === "detail" ? (
        <MarketDetailPage
          controller={controllerRef.current as MarketController}
          state={state}
          listingId={route.listingId}
        />
      ) : null}
      {route.kind === "provider" ? (
        <ProviderListingsPage
          controller={controllerRef.current as MarketController}
          state={state}
          providerId={route.providerId}
        />
      ) : null}
      {route.kind === "not-found" ? <MarketNotFound /> : null}
      {route.kind === "invalid" ? <MarketInvalid /> : null}
    </Shell>
  );
}

interface ShellProps {
  readonly route: MarketRoute;
  readonly children: React.ReactNode;
}

function Shell({ route, children }: ShellProps) {
  return (
    <div className="market-shell">
      <a className="market-skip" href="#market-main">Skip to main content</a>
      <header className="market-topbar">
        <a className="market-brand" href="/design" aria-label="OpenArc home">
          <img className="market-brand__logo" src="/openarc-logo.jpeg" alt="" width={32} height={32} />
          <span>OPENARC</span>
        </a>
        <nav className="market-nav" aria-label="Primary navigation">
          <a href="/design">Home</a>
          <a href="/market" aria-current={route.kind === "list" ? "page" : undefined}>Market</a>
          <a href="/docs" aria-current={isInfo(route, "docs") ? "page" : undefined}>Docs</a>
          <a href="/status" aria-current={isInfo(route, "status") ? "page" : undefined}>Status</a>
          <a href="/legal" aria-current={isInfo(route, "legal") ? "page" : undefined}>Information</a>
          <a href="/account">Account</a>
        </nav>
      </header>
      <main className="market-main" id="market-main" tabIndex={-1}>
        {children}
      </main>
      <footer className="market-footer">
        <p>
          OpenArc is independent concept software and is not endorsed by Arc or Circle. Public
          listings are declarations only and are not purchase authority.
        </p>
      </footer>
    </div>
  );
}

function isInfo(route: MarketRoute, info: MarketInfoKind): boolean {
  return route.kind === "info" && route.info === info;
}

function DisabledShell() {
  return (
    <div className="market-shell">
      <a className="market-skip" href="#market-main">Skip to main content</a>
      <header className="market-topbar">
        <a className="market-brand" href="/design" aria-label="OpenArc home">
          <img className="market-brand__logo" src="/openarc-logo.jpeg" alt="" width={32} height={32} />
          <span>OPENARC</span>
        </a>
        <nav className="market-nav" aria-label="Primary navigation">
          <a href="/design">Home</a>
          <a href="/market">Market</a>
          <a href="/docs">Docs</a>
          <a href="/status">Status</a>
          <a href="/legal">Information</a>
          <a href="/account">Account</a>
        </nav>
      </header>
      <main className="market-main" id="market-main" tabIndex={-1}>
        <div className="market-disabled" data-testid="market-disabled">
          <p className="market-eyebrow">PUBLIC MARKETPLACE</p>
          <h1 className="market-title">The public marketplace is not enabled here</h1>
          <p className="market-lede">
            The catalog is built but disabled in this deployment, so no listing request is made and
            no catalog data is shown.
          </p>
        </div>
      </main>
    </div>
  );
}

function MarketNotFound() {
  return (
    <section aria-labelledby="market-notfound-title">
      <p className="market-eyebrow">NOT FOUND</p>
      <h1 className="market-title" id="market-notfound-title">This page does not exist</h1>
      <p className="market-lede">
        The requested marketplace path is not a known public route. Nothing was loaded for it.
      </p>
      <div className="market-actions">
        <a className="market-button market-button--primary" href="/market">Back to the catalog</a>
      </div>
    </section>
  );
}

function MarketInvalid() {
  return (
    <section aria-labelledby="market-invalid-title">
      <p className="market-eyebrow">INVALID PATH</p>
      <h1 className="market-title" id="market-invalid-title">This address is invalid</h1>
      <p className="market-lede">
        The requested identifier could not be decoded safely. Nothing was loaded for it.
      </p>
      <div className="market-actions">
        <a className="market-button market-button--primary" href="/market">Back to the catalog</a>
      </div>
    </section>
  );
}
