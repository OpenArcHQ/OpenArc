import { useEffect, useState } from "react";

import stagingCssUrl from "./staging.css?url";
import suppliedCssUrl from "./supplied.css?url";

import Home from "./pages/Home.js";
import Docs from "./pages/Docs.js";
import FaqPage from "./pages/FaqPage.js";
import { designHref } from "./navigation.js";

const SUPPLIED_STYLES = [
  { key: "supplied", href: suppliedCssUrl },
  { key: "staging", href: stagingCssUrl },
] as const;

/**
 * Mounts the design stylesheets as same-origin <link> assets for the lifetime
 * of this component only. They are created imperatively (not as React elements)
 * so React never hoists them into a permanent document-level resource, and they
 * are removed on unmount so the design reset cannot leak into legacy routes.
 * A CSP with `style-src 'self'` permits these; inline style elements do not.
 */
function useSuppliedStyles(): void {
  useEffect(() => {
    const links = SUPPLIED_STYLES.map(({ key, href }) => {
      const link = document.createElement("link");
      link.rel = "stylesheet";
      link.href = href;
      link.dataset.suppliedStyle = key;
      document.head.append(link);
      return link;
    });
    return () => {
      for (const link of links) link.remove();
    };
  }, []);
}

function SkipLink() {
  return (
    <a className="supplied-skip-link" href="#supplied-main-content">
      Skip to main content
    </a>
  );
}

function WorkspaceRedirect() {
  useEffect(() => {
    window.location.replace("/workspace");
  }, []);
  return (
    <div className="supplied-home min-h-screen bg-bg font-sans text-ink antialiased">
      <main id="supplied-main-content" tabIndex={-1}>
        <p className="supplied-redirect" role="status">
          Opening the working workspace… If nothing happens,{" "}
          <a href={designHref("/app")}>continue to the workspace</a>.
        </p>
      </main>
    </div>
  );
}

function currentPath(): string {
  if (typeof window === "undefined") return "/design";
  return window.location.pathname.replace(/\/+$/u, "") || "/";
}

function Route({ path }: { path: string }) {
  if (path === "/design/workspace") return <WorkspaceRedirect />;
  if (path === "/design/docs") return <Docs />;
  if (path === "/design/faq") return <FaqPage />;
  return <Home />;
}

export default function DesignApp() {
  const [path, setPath] = useState(currentPath);
  useSuppliedStyles();

  useEffect(() => {
    const onPopState = () => setPath(currentPath());
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  return (
    <div className="supplied-shell">
      <SkipLink />
      <Route path={path} />
    </div>
  );
}
