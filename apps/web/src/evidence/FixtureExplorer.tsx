import { useId, useMemo, useState } from "react";

import { M01_FIXTURES } from "@openarc/shared";

import { buildEvidenceFixtureView } from "./view-model.js";

const stateLabels = {
  RECONCILED: "Reconciled",
  INTENT_NOT_SUPPLIED: "Intent not supplied",
  CONFLICTING_EVIDENCE: "Conflicting evidence",
  EXPIRED: "Expired",
  FAILED: "Failed",
  REFUNDED: "Refunded",
} as const;

function shortId(value: string) {
  return `${value.slice(0, 8)}…${value.slice(-6)}`;
}

export function FixtureExplorer() {
  const [selectedId, setSelectedId] = useState(M01_FIXTURES[0]!.fixtureId);
  const selected = M01_FIXTURES.find((fixture) => fixture.fixtureId === selectedId) ?? M01_FIXTURES[0]!;
  const view = useMemo(() => buildEvidenceFixtureView(selected), [selected]);
  const headingId = useId();
  const selectByKeyboard = (index: number) => {
    const fixture = M01_FIXTURES[index];
    if (!fixture) return;
    setSelectedId(fixture.fixtureId);
    document.querySelector<HTMLButtonElement>(`#fixture-tab-${fixture.fixtureId}`)?.focus();
  };

  return (
    <section className="explorer" id="fixture-explorer" aria-labelledby={headingId} tabIndex={-1}>
      <header className="explorer-heading">
        <div>
          <p className="eyebrow">M01 · FIXTURE EXPLORER</p>
          <h2 id={headingId}>Read the evidence before the conclusion.</h2>
        </div>
        <p>
          Six synthetic, local-only cases exercise the exact same deterministic rule. No wallet,
          provider, Arc RPC, browser storage, or OpenArc API is contacted.
        </p>
      </header>

      <div className="fixture-tabs" role="tablist" aria-label="Synthetic evidence cases">
        {M01_FIXTURES.map((fixture, index) => (
          <button
            key={fixture.fixtureId}
            id={`fixture-tab-${fixture.fixtureId}`}
            type="button"
            role="tab"
            aria-selected={fixture.fixtureId === selectedId}
            aria-controls="fixture-panel"
            tabIndex={fixture.fixtureId === selectedId ? 0 : -1}
            onClick={() => setSelectedId(fixture.fixtureId)}
            onKeyDown={(event) => {
              if (event.key === "ArrowRight" || event.key === "ArrowDown") {
                event.preventDefault();
                selectByKeyboard((index + 1) % M01_FIXTURES.length);
              } else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
                event.preventDefault();
                selectByKeyboard((index - 1 + M01_FIXTURES.length) % M01_FIXTURES.length);
              } else if (event.key === "Home") {
                event.preventDefault();
                selectByKeyboard(0);
              } else if (event.key === "End") {
                event.preventDefault();
                selectByKeyboard(M01_FIXTURES.length - 1);
              }
            }}
          >
            <span>{fixture.title}</span>
            <small>{stateLabels[fixture.expectedState as keyof typeof stateLabels]}</small>
          </button>
        ))}
      </div>

      <div
        className="fixture-panel"
        id="fixture-panel"
        role="tabpanel"
        aria-labelledby={`fixture-tab-${selected.fixtureId}`}
      >
        <header className="fixture-summary">
          <div>
            <span className={`state-badge state-${selected.result.state.toLowerCase()}`}>
              {stateLabels[selected.result.state as keyof typeof stateLabels] ?? selected.result.state}
            </span>
            <h3>{selected.title}</h3>
            <p>{selected.summary}</p>
          </div>
          <dl>
            <div>
              <dt>Rule</dt>
              <dd>{selected.result.ruleVersion}</dd>
            </div>
            <div>
              <dt>Policy</dt>
              <dd>LOCAL MONITORING ONLY · {selected.result.policyEvaluation.state}</dd>
            </div>
            <div>
              <dt>Evaluated</dt>
              <dd>{selected.result.evaluatedAt}</dd>
            </div>
          </dl>
        </header>

        <section className="evidence-graph" aria-labelledby="graph-title">
          <div className="subsection-heading">
            <div>
              <p className="eyebrow">VISUAL SUMMARY</p>
              <h3 id="graph-title">Evidence graph</h3>
            </div>
            <p>Every node links to the same chronological record in the semantic list below.</p>
          </div>
          <div className="graph-track" data-testid="evidence-graph">
            {view.nodes.map((node, index) => (
              <div className="graph-step" key={node.id}>
                {index > 0 ? (
                  <span className="graph-edge" aria-hidden="true">
                    <span>{view.edges[index - 1]!.relationship}</span>
                  </span>
                ) : null}
                <a
                  className={`graph-node authority-${node.authority}`}
                  href={`#evidence-${node.id}`}
                  aria-label={`${node.typeLabel}, ${node.authorityLabel}, ${node.timeLabel}. ${node.limitations.length} limitation.`}
                >
                  <span>{String(index + 1).padStart(2, "0")}</span>
                  <strong>{node.typeLabel}</strong>
                  <small>{node.authorityLabel}</small>
                  <time dateTime={node.time}>{node.timeLabel}</time>
                  <em>{node.limitations.length} limitation</em>
                </a>
              </div>
            ))}
          </div>
          <ol className="sr-only" aria-label="Evidence relationships">
            {view.edges.map((edge) => (
              <li key={`${edge.fromId}-${edge.toId}`}>
                {shortId(edge.fromId)} to {shortId(edge.toId)}: {edge.relationship}.
              </li>
            ))}
          </ol>
        </section>

        <section className="semantic-evidence" aria-labelledby="list-title">
          <div className="subsection-heading">
            <div>
              <p className="eyebrow">SOURCE OF TRUTH</p>
              <h3 id="list-title">Chronological evidence list</h3>
            </div>
            <p>{view.nodes.length} cited records · exact normalized fixture data</p>
          </div>
          <ol data-testid="evidence-list">
            {view.nodes.map((node, index) => (
              <li id={`evidence-${node.id}`} key={node.id} tabIndex={-1}>
                <div className="evidence-index" aria-hidden="true">
                  {String(index + 1).padStart(2, "0")}
                </div>
                <article>
                  <header>
                    <div>
                      <p>{node.authorityLabel}</p>
                      <h4>{node.typeLabel}</h4>
                    </div>
                    <time dateTime={node.time}>{node.time.replace("T", " ")}</time>
                  </header>
                  <dl>
                    <div>
                      <dt>Schema</dt>
                      <dd>{node.schemaVersion}</dd>
                    </div>
                    <div>
                      <dt>Evidence ID</dt>
                      <dd>{node.id}</dd>
                    </div>
                    <div>
                      <dt>Action ID</dt>
                      <dd>{node.actionId}</dd>
                    </div>
                    <div>
                      <dt>Source</dt>
                      <dd>{node.sourceLabel}</dd>
                    </div>
                    <div>
                      <dt>Source ID</dt>
                      <dd>{node.sourceId}</dd>
                    </div>
                    <div>
                      <dt>Reference</dt>
                      <dd>{node.sourceReference}</dd>
                    </div>
                    <div>
                      <dt>Source kind</dt>
                      <dd>{node.sourceKind}</dd>
                    </div>
                    <div>
                      <dt>Environment</dt>
                      <dd>{node.sourceEnvironment}</dd>
                    </div>
                    <div>
                      <dt>Adapter</dt>
                      <dd>{node.sourceAdapterVersion}</dd>
                    </div>
                    <div>
                      <dt>Source network</dt>
                      <dd>{node.sourceNetwork ?? "NOT CLAIMED"}</dd>
                    </div>
                    <div>
                      <dt>Occurred</dt>
                      <dd>{node.occurredAt ?? "NOT SUPPLIED"}</dd>
                    </div>
                    <div>
                      <dt>Observed</dt>
                      <dd>{node.observedAt}</dd>
                    </div>
                  </dl>
                  <section className="normalized-facts" aria-label={`${node.typeLabel} normalized facts`}>
                    <h5>Normalized facts</h5>
                    <dl data-testid={`evidence-facts-${node.id}`}>
                      {node.facts.map((fact) => (
                        <div key={fact.label}>
                          <dt>{fact.label}</dt>
                          <dd><code>{fact.value}</code></dd>
                        </div>
                      ))}
                    </dl>
                  </section>
                  <div className="limitations">
                    <strong>Limitations</strong>
                    <ul>
                      {node.limitations.map((limitation) => (
                        <li key={limitation}>{limitation}</li>
                      ))}
                    </ul>
                  </div>
                </article>
              </li>
            ))}
          </ol>
        </section>

        <section className="conclusion" aria-labelledby="conclusion-title" aria-live="polite">
          <div>
            <p className="eyebrow">DETERMINISTIC RESULT</p>
            <h3 id="conclusion-title">{selected.result.state.replaceAll("_", " ")}</h3>
          </div>

          {selected.result.gaps.length > 0 ? (
            <div>
              <h4>Missing evidence</h4>
              <ul>
                {selected.result.gaps.map((gap) => (
                  <li key={gap.code}>
                    <strong>{gap.code}</strong> — {gap.detail}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          {selected.result.conflicts.length > 0 ? (
            <div>
              <h4>Conflicts</h4>
              <ul>
                {selected.result.conflicts.map((conflict) => (
                  <li key={`${conflict.code}-${conflict.evidenceIds.join("-")}`}>
                    <strong>{conflict.code}</strong> — {conflict.detail}
                    <code>{conflict.evidenceIds.join(", ")}</code>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          <div>
            <h4>Evidence cited by this result</h4>
            <code className="citation" data-testid="result-evidence-citation">
              {view.evidenceCitation}
            </code>
          </div>
          <div>
            <h4>Result limitations</h4>
            <ul>
              {selected.result.limitations.map((limitation) => (
                <li key={limitation}>{limitation}</li>
              ))}
            </ul>
          </div>
        </section>
      </div>
    </section>
  );
}
