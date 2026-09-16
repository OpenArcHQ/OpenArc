import type { ReactNode } from "react";

import { useSurfaceSheen } from "../app/surface-sheen.js";

/**
 * Presentational chrome for the organization workspace: nav icons and the
 * cursor-tracked surface sheen. Nothing here reads or holds protected state.
 */

const ICON_PATHS: Readonly<Record<string, ReactNode>> = {
  overview: (
    <>
      <path d="M3 11.5 12 4l9 7.5" />
      <path d="M5 10v10h14V10" />
    </>
  ),
  agents: (
    <>
      <rect x="5" y="8" width="14" height="11" rx="3" />
      <path d="M12 8V4M9 13h.01M15 13h.01" />
    </>
  ),
  provider: (
    <>
      <path d="M4 9h16l-1.5-5h-13z" />
      <path d="M5 9v11h14V9M10 20v-6h4v6" />
    </>
  ),
  listings: (
    <>
      <path d="M8 6h12M8 12h12M8 18h12" />
      <path d="M4 6h.01M4 12h.01M4 18h.01" />
    </>
  ),
  budgets: (
    <>
      <path d="M4 7h16v11H4z" />
      <path d="M4 11h16M8 15h3" />
    </>
  ),
  sessions: (
    <>
      <circle cx="12" cy="12" r="8" />
      <path d="M12 8v4l3 2" />
    </>
  ),
  actions: (
    <>
      <path d="M4 5h2l2.2 10.2a1 1 0 0 0 1 .8h8.6a1 1 0 0 0 1-.8L20 8H7" />
      <circle cx="10" cy="20" r="1.3" />
      <circle cx="17" cy="20" r="1.3" />
    </>
  ),
  grants: (
    <>
      <path d="M12 3 5 6v6c0 4 3 7.5 7 9 4-1.5 7-5 7-9V6z" />
      <path d="m9 12 2 2 4-4" />
    </>
  ),
  account: (
    <>
      <circle cx="12" cy="8" r="4" />
      <path d="M4 21c1.5-4 4.5-6 8-6s6.5 2 8 6" />
    </>
  ),
  docs: (
    <>
      <path d="M8 4h8l4 4v12H4V4h4z" />
      <path d="M8 12h8M8 16h5" />
    </>
  ),
  local: (
    <>
      <rect x="5" y="11" width="14" height="9" rx="2" />
      <path d="M8 11V8a4 4 0 0 1 8 0v3" />
    </>
  ),
};

export type WorkspaceIconName = keyof typeof ICON_PATHS;

export function WorkspaceIcon({ name, className }: { name: WorkspaceIconName; className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {ICON_PATHS[name]}
    </svg>
  );
}

const SHEEN_SELECTOR = ".tenant-card, .tenant-surface, .tenant-hero";

/** Cursor-tracked highlight for workspace surfaces. */
export function useWorkspaceSheen(): void {
  useSurfaceSheen(SHEEN_SELECTOR);
}

export function initials(name: string): string {
  const letters = name
    .split(/\s+/u)
    .filter((part) => part.length > 0)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("");
  return letters.length > 0 ? letters : "?";
}
