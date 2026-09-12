import { useEffect, useMemo, useState } from "react";

import { Link } from "../navigation.js";
import { CANONICAL_DOCS, canonicalDoc, isCanonicalDocId, type CanonicalDocId } from "../docs/canonical.js";

function initialDoc(): CanonicalDocId {
  if (typeof window === "undefined") return "source-of-truth";
  const requested = new URLSearchParams(window.location.search).get("doc");
  return isCanonicalDocId(requested) ? requested : "source-of-truth";
}

export default function Docs() {
  const [activeId, setActiveId] = useState<CanonicalDocId>(initialDoc);
  const active = useMemo(() => canonicalDoc(activeId), [activeId]);

  useEffect(() => {
    const onPopState = () => setActiveId(initialDoc());
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  const select = (id: CanonicalDocId) => {
    setActiveId(id);
    const url = new URL(window.location.href);
    url.searchParams.set("doc", id);
    window.history.replaceState(null, "", url);
  };

  return (
    <div className="supplied-home min-h-screen bg-bg font-sans text-ink antialiased">
      <main id="supplied-main-content" tabIndex={-1} className="supplied-docs">
        <div className="supplied-docs__inner">
          <p className="tag-label">[ technical docs ]</p>
          <h1 className="supplied-docs__title">Canonical engineering documents</h1>
          <p className="supplied-docs__lede">
            These tabs render the existing canonical markdown as plain, escaped text. Commerce
            target notes are in development; the live product is read-only evidence and a locally
            encrypted investigation workspace.
          </p>

          <div className="supplied-docs__tabs" role="tablist" aria-label="Canonical documents">
            {CANONICAL_DOCS.map((doc) => {
              const selected = doc.id === activeId;
              return (
                <button
                  key={doc.id}
                  type="button"
                  role="tab"
                  id={`supplied-doc-tab-${doc.id}`}
                  aria-selected={selected}
                  aria-controls={`supplied-doc-panel-${doc.id}`}
                  data-doc-id={doc.id}
                  tabIndex={selected ? 0 : -1}
                  className={`supplied-docs__tab${selected ? " is-active" : ""}`}
                  onClick={() => select(doc.id)}
                  onKeyDown={(event) => {
                    if (event.key === "ArrowRight" || event.key === "ArrowLeft") {
                      event.preventDefault();
                      const currentId = event.currentTarget.dataset.docId;
                      const index = CANONICAL_DOCS.findIndex((item) => item.id === currentId);
                      const delta = event.key === "ArrowRight" ? 1 : -1;
                      const nextIndex = index < 0 ? 0 : (index + delta + CANONICAL_DOCS.length) % CANONICAL_DOCS.length;
                      const next = CANONICAL_DOCS[nextIndex];
                      if (next) {
                        select(next.id);
                        document.getElementById(`supplied-doc-tab-${next.id}`)?.focus();
                      }
                    }
                  }}
                >
                  {doc.label}
                </button>
              );
            })}
          </div>

          <section
            role="tabpanel"
            id={`supplied-doc-panel-${active.id}`}
            aria-labelledby={`supplied-doc-tab-${active.id}`}
            tabIndex={0}
            className="supplied-docs__panel"
          >
            <h2 className="supplied-docs__panel-title">{active.title}</h2>
            <pre className="supplied-docs__markdown" aria-label={`${active.title} markdown`}>
              {active.markdown}
            </pre>
          </section>

          <nav className="supplied-docs__nav" aria-label="Docs navigation">
            <Link to="/" className="btn-ghost">
              Back to overview
            </Link>
            <Link to="/faq" className="btn-ghost">
              Read the FAQ
            </Link>
          </nav>
        </div>
      </main>
    </div>
  );
}
