import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

import { CANONICAL_DOCS, canonicalDoc, isCanonicalDocId } from "../src/supplied/docs/canonical.js";
import { SUPPLIED_FAQ_GROUPS, SUPPLIED_FAQ_ITEMS } from "../src/supplied/faq-content.js";
import { designHref } from "../src/supplied/navigation.js";

describe("design route mapping", () => {
  it("keeps the public shell on /design and sends dashboards to the real workspace", () => {
    expect(designHref("/")).toBe("/design");
    expect(designHref("/docs")).toBe("/design/docs");
    expect(designHref("/docs?doc=backend")).toBe("/design/docs?doc=backend");
    expect(designHref("/faq")).toBe("/design/faq");
    expect(designHref("/app")).toBe("/workspace");
    expect(designHref("/design/workspace")).toBe("/design/workspace");
  });
});

describe("canonical documentation", () => {
  it("exposes exactly the three canonical tabs", () => {
    expect(CANONICAL_DOCS.map((doc) => doc.id)).toEqual(["source-of-truth", "backend", "frontend"]);
    expect(isCanonicalDocId("backend")).toBe(true);
    expect(isCanonicalDocId("source-of-truth")).toBe(true);
    expect(isCanonicalDocId("frontend")).toBe(true);
    expect(isCanonicalDocId("other")).toBe(false);
    expect(isCanonicalDocId(null)).toBe(false);
  });

  it("bundles real canonical markdown text without HTML execution", () => {
    expect(canonicalDoc("source-of-truth").markdown).toContain("# OpenArc engineering source of truth");
    expect(canonicalDoc("backend").markdown).toContain("# OpenArc backend architecture");
    expect(canonicalDoc("frontend").markdown).toContain("# OpenArc frontend architecture");
    for (const doc of CANONICAL_DOCS) {
      expect(doc.markdown.length).toBeGreaterThan(1000);
      expect(doc.title.length).toBeGreaterThan(0);
    }
  });

  it("fails closed to the source of truth for an unknown id", () => {
    expect(canonicalDoc("backend").id).toBe("backend");
  });
});

describe("dedicated FAQ copy", () => {
  it("has unique, addressable items", () => {
    const ids = SUPPLIED_FAQ_ITEMS.map((item) => item.id);
    expect(ids.length).toBeGreaterThanOrEqual(9);
    expect(new Set(ids).size).toBe(ids.length);
    expect(SUPPLIED_FAQ_GROUPS.length).toBeGreaterThanOrEqual(3);
  });

  it("states the read-only live status and the in-development commerce target", () => {
    const text = SUPPLIED_FAQ_ITEMS.map((item) => `${item.question} ${item.answer}`).join(" ");
    expect(text).toMatch(/read-only evidence and investigation workspace/u);
    expect(text).toMatch(/in-development/u);
    expect(text).toMatch(/not a payment authority/u);
  });

  it("never claims zero retention, anonymity, mainnet, alpha or launch readiness", () => {
    const text = SUPPLIED_FAQ_ITEMS.map((item) => item.answer).join(" ").toLowerCase();
    expect(text).not.toContain("zero account-data retention");
    expect(text).toContain("not a zero-retention promise");
    expect(text).not.toMatch(/\bare anonymous\b/u);
    expect(text).toContain("not anonymous");
    expect(text).not.toMatch(/\bmainnet is enabled\b/u);
    expect(text).not.toMatch(/\balpha\b/u);
    expect(text).not.toMatch(/marketplace ready|launch ready/u);
  });
});

describe("web image canonical docs", () => {
  const dockerfile = readFileSync(new URL("../Dockerfile", import.meta.url), "utf8");
  const docsCopies = dockerfile
    .split("\n")
    .filter((line) => line.startsWith("COPY ") && line.includes("docs/"));

  it("copies exactly the three canonical engineering markdown files", () => {
    const expected =
      "COPY docs/engineering/openarc-engineering-source-of-truth.md docs/engineering/openarc-backend-architecture.md docs/engineering/openarc-frontend-architecture.md docs/engineering/";
    expect(docsCopies).toEqual([expected]);
  });

  it("does not copy the whole docs tree or unrelated records", () => {
    for (const line of docsCopies) {
      expect(line).not.toMatch(/COPY docs\s+docs/u);
      expect(line).not.toContain("archive");
      expect(line).not.toContain("releases");
      expect(line).not.toContain("private");
    }
    expect(dockerfile).toContain("openarc-engineering-source-of-truth.md");
    expect(dockerfile).toContain("openarc-backend-architecture.md");
    expect(dockerfile).toContain("openarc-frontend-architecture.md");
  });
});

describe("release gate inclusion", () => {
  const packageJson = JSON.parse(
    readFileSync(new URL("../../../package.json", import.meta.url), "utf8"),
  ) as { scripts?: Record<string, string> };
  const script = packageJson.scripts?.e2e ?? "";
  const required = [
    "playwright test",
    "playwright.flag-off.config.ts",
    "playwright.api-boundary.config.ts",
    "playwright.arc-observation.config.ts",
    "playwright.agent-registry.config.ts",
    "playwright.job-evidence.config.ts",
    "playwright.gateway-evidence.config.ts",
    "playwright.local-agent-import.config.ts",
    "playwright.investigations.config.ts",
    "playwright.investigations.flag-off.config.ts",
  ];

  it("keeps every existing e2e check and appends the supplied design suite", () => {
    for (const check of required) expect(script).toContain(check);
    expect(script.endsWith("playwright test -c playwright.supplied.config.ts")).toBe(true);
    const occurrences = script.split("playwright.supplied.config.ts").length - 1;
    expect(occurrences).toBe(1);
  });

  it("does not add or rename unrelated scripts", () => {
    expect(packageJson.scripts?.e2e).toBe(script);
    expect(packageJson.scripts).not.toHaveProperty("e2e:supplied");
  });
});

describe("production content security policy", () => {
  const policyFiles = ["nginx.conf", "nginx-api.conf", "nginx-arc.conf"] as const;
  const policies = policyFiles.map((name) => ({
    name,
    text: readFileSync(new URL(`../${name}`, import.meta.url), "utf8"),
  }));

  it("permits same-origin media and forbids unsafe inline or eval", () => {
    for (const { name, text } of policies) {
      expect(text, name).toContain("media-src 'self'");
      expect(text, name).not.toContain("media-src 'none'");
      expect(text, name).not.toContain("unsafe-inline");
      expect(text, name).not.toContain("unsafe-eval");
      expect(text, name).toContain("style-src 'self'");
      expect(text, name).toMatch(/Content-Security-Policy/u);
    }
  });

  it("mounts design CSS as same-origin stylesheet assets, not inline style blocks", () => {
    const designApp = readFileSync(new URL("../src/supplied/DesignApp.tsx", import.meta.url), "utf8");
    expect(designApp).toContain("staging.css?url");
    expect(designApp).toContain("supplied.css?url");
    expect(designApp).not.toContain("?inline");
    expect(designApp).not.toContain('createElement("style")');
    expect(designApp).not.toContain("<style");
    expect(designApp).toContain('link.rel = "stylesheet"');
    expect(designApp).toContain("link.remove()");
  });
});

describe("CSP bootstrap ordering", () => {
  const main = readFileSync(new URL("../src/main.tsx", import.meta.url), "utf8");
  const bootstrap = readFileSync(new URL("../src/csp-bootstrap.ts", import.meta.url), "utf8");
  const webPackage = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  ) as { dependencies?: Record<string, string> };

  it("configures zod jitless before any shared schema or App import evaluates", () => {
    const firstImport = main
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line.startsWith("import "));
    expect(firstImport).toBe('import "./csp-bootstrap.js";');
    const bootstrapIndex = main.indexOf('"./csp-bootstrap.js"');
    const appIndex = main.indexOf('"./App.js"');
    expect(bootstrapIndex).toBeGreaterThanOrEqual(0);
    expect(appIndex).toBeGreaterThan(bootstrapIndex);
    expect(bootstrap).toContain('from "zod"');
    expect(bootstrap).toContain("jitless: true");
  });

  it("pins the exact zod dependency the bootstrap imports directly", () => {
    expect(webPackage.dependencies?.zod).toBe("4.5.4");
  });
});
