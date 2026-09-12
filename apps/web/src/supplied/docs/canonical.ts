import backendArchitecture from "../../../../../docs/engineering/openarc-backend-architecture.md?raw";
import frontendArchitecture from "../../../../../docs/engineering/openarc-frontend-architecture.md?raw";
import sourceOfTruth from "../../../../../docs/engineering/openarc-engineering-source-of-truth.md?raw";

export type CanonicalDocId = "source-of-truth" | "backend" | "frontend";

export interface CanonicalDoc {
  id: CanonicalDocId;
  label: string;
  title: string;
  /** Canonical markdown is rendered as plain, escaped text. It is never injected as HTML. */
  markdown: string;
}

export const CANONICAL_DOCS: readonly CanonicalDoc[] = [
  {
    id: "source-of-truth",
    label: "Source of truth",
    title: "Engineering source of truth",
    markdown: sourceOfTruth,
  },
  {
    id: "backend",
    label: "Backend",
    title: "Backend architecture",
    markdown: backendArchitecture,
  },
  {
    id: "frontend",
    label: "Frontend",
    title: "Frontend architecture",
    markdown: frontendArchitecture,
  },
];

export function isCanonicalDocId(value: string | null | undefined): value is CanonicalDocId {
  return value === "source-of-truth" || value === "backend" || value === "frontend";
}

export function canonicalDoc(id: CanonicalDocId): CanonicalDoc {
  return CANONICAL_DOCS.find((doc) => doc.id === id) ?? CANONICAL_DOCS[0]!;
}
