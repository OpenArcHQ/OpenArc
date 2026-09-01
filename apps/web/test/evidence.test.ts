import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import { M01_FIXTURES } from "@openarc/shared";
import { describe, expect, it } from "vitest";

import { buildEvidenceFixtureView } from "../src/evidence/view-model.js";

describe("fixture explorer view model", () => {
  it("keeps graph and semantic list records in exact chronological parity", () => {
    for (const fixture of M01_FIXTURES) {
      const view = buildEvidenceFixtureView(fixture);
      const expected = fixture.result.evidenceIds;
      expect(view.nodes.map((node) => node.id)).toEqual(expected);
      expect(view.edges).toHaveLength(Math.max(0, expected.length - 1));
      expect(view.edges.map((edge) => edge.fromId)).toEqual(expected.slice(0, -1));
      expect(view.edges.map((edge) => edge.toId)).toEqual(expected.slice(1));
      expect(view.evidenceCitation.split(", ")).toEqual(expected);
    }
  });

  it("exposes authority, source, time, and limitations on every node", () => {
    for (const fixture of M01_FIXTURES) {
      for (const node of buildEvidenceFixtureView(fixture).nodes) {
        expect(node.authorityLabel.length).toBeGreaterThan(0);
        expect(node.sourceLabel.length).toBeGreaterThan(0);
        expect(node.time).toMatch(/Z$/u);
        expect(node.limitations.length).toBeGreaterThan(0);
      }
    }
  });

  it("labels the complete arc with distinct relationship meanings", () => {
    const fixture = M01_FIXTURES.find((item) => item.fixtureId === "complete")!;
    expect(buildEvidenceFixtureView(fixture).edges.map((edge) => edge.relationship)).toEqual([
      "reported relationship",
      "provider association",
      "cryptographic link",
      "provider association",
      "OpenArc-derived match",
    ]);
  });
});

describe("M01 static privacy boundary", () => {
  it("contains no network, persistence, analytics, wallet, signing, or broadcast APIs", async () => {
    const directory = path.resolve(import.meta.dirname, "../src/evidence");
    const sources = await Promise.all(
      (await readdir(directory))
        .filter((file) => /\.(ts|tsx)$/u.test(file))
        .map(async (file) => `${file}\n${await readFile(path.join(directory, file), "utf8")}`),
    );
    const source = sources.join("\n");
    const forbidden = [
      "fetch(",
      "XMLHttpRequest",
      "WebSocket",
      "EventSource",
      "sendBeacon",
      "localStorage",
      "sessionStorage",
      "indexedDB",
      "caches.",
      "document.cookie",
      "ethereum.request",
      "signMessage",
      "sendTransaction",
      "broadcastTransaction",
    ];

    for (const token of forbidden) expect(source).not.toContain(token);
  });
});
