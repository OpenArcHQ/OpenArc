import { ARC_TESTNET } from "@openarc/shared";

import type { BuildInfo } from "@openarc/shared";

import { FixtureExplorer } from "./evidence/FixtureExplorer.js";

interface AppProps {
  build: BuildInfo;
}

const evidenceSteps = [
  ["01", "Permission", "What was the agent allowed to do?"],
  ["02", "Attempt", "What did the agent or tool report trying?"],
  ["03", "Authorization", "What exact payment or action was approved?"],
  ["04", "Settlement", "What can an authoritative source actually prove?"],
] as const;

export function App({ build }: AppProps) {
  const skipToExplorer = () => {
    requestAnimationFrame(() => document.querySelector<HTMLElement>("#fixture-explorer")?.focus());
  };

  return (
    <main>
      <a className="skip-link" href="#fixture-explorer" onClick={skipToExplorer}>
        Skip to fixture explorer
      </a>
      <nav className="topbar" aria-label="Primary navigation">
        <a className="brand" href="#top" aria-label="OpenArc home">
          <img src="/openarc-logo.jpeg" alt="" />
          <span>OPENARC</span>
        </a>
        <div className="topbar-links">
          <a href="#fixture-explorer">Explorer</a>
          <a href="#network">Network</a>
          <span className="phase">M01 · EVIDENCE ENGINE</span>
        </div>
      </nav>

      <section className="hero" id="top" aria-labelledby="hero-title">
        <div className="hero-copy">
          <p className="eyebrow">SYNTHETIC FIXTURES · READ ONLY · LOCAL FIRST</p>
          <h1 id="hero-title">See the full arc of every agent action.</h1>
          <p className="lede">
            OpenArc is an evidence and investigation workspace for economic agents. This first
            engine keeps intent, attempt, authorization, fulfillment, settlement, and refund
            evidence distinct—then explains exactly what agrees, conflicts, or remains missing.
          </p>
          <div className="status-row" aria-label="Current build status">
            <span className="status-dot" aria-hidden="true" />
            <strong>Fixture engine running</strong>
            <span>Six deterministic local cases. Live connectors remain deliberately disabled.</span>
          </div>
        </div>

        <div className="orbital" aria-hidden="true">
          <div className="orbit orbit-one" />
          <div className="orbit orbit-two" />
          <div className="core">OA</div>
          <span className="node node-a" />
          <span className="node node-b" />
          <span className="node node-c" />
        </div>
      </section>

      <FixtureExplorer />

      <section className="evidence" aria-labelledby="evidence-title">
        <header>
          <p className="eyebrow">THE CONTROL LAYER</p>
          <h2 id="evidence-title">One trail. No collapsed meanings.</h2>
        </header>
        <div className="evidence-grid">
          {evidenceSteps.map(([number, title, description]) => (
            <article key={number}>
              <span>{number}</span>
              <h3>{title}</h3>
              <p>{description}</p>
            </article>
          ))}
        </div>
      </section>

      <section className="network" id="network" aria-labelledby="network-title">
        <div>
          <p className="eyebrow">PINNED NETWORK REGISTRY</p>
          <h2 id="network-title">Arc Testnet, exactly.</h2>
          <p>
            Mainnet has been announced for September 16, 2026, but its public endpoints and
            contract registry are not available in the official references yet. This build will
            not guess or copy Testnet values forward.
          </p>
        </div>
        <dl>
          <div>
            <dt>CAIP-2</dt>
            <dd>{ARC_TESTNET.caip2}</dd>
          </div>
          <div>
            <dt>CHAIN ID</dt>
            <dd>{ARC_TESTNET.chainId}</dd>
          </div>
          <div>
            <dt>GAS</dt>
            <dd>{ARC_TESTNET.currencySymbol}</dd>
          </div>
          <div>
            <dt>FINALITY</dt>
            <dd>{ARC_TESTNET.finality}</dd>
          </div>
        </dl>
      </section>

      <footer>
        <p>OpenArc is independent concept software and is not endorsed by Arc or Circle.</p>
        <code data-testid="build-sha">BUILD {build.commitSha}</code>
      </footer>
    </main>
  );
}
