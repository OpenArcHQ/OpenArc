import {
  ARC_TESTNET,
  CommerceAgentProfileSchema,
  CommerceProviderProfileSchema,
  type CommerceHumanRole,
} from "@openarc/shared";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { accountAccessEnabled } from "../account/availability.js";
import { AccountFlowController } from "../account/flow-controller.js";
import type { TenantFetch } from "./tenant-client.js";
import {
  MAX_PAGE_LIMIT,
  TenantController,
  canReadAgents,
  canReadProviders,
  type TenantViewControllerState,
  initialTenantState,
} from "./tenant-controller.js";
import { tenantReadsEnabled } from "./availability.js";

import tenantCssUrl from "./tenant.css?url";

/**
 * Protected organization workspace.
 *
 * The flag gate renders a static unavailable state and constructs no
 * controller, so a disabled deployment makes zero auth or tenant requests.
 * When enabled, the workspace is a same-origin link-loaded stylesheet scoped
 * entirely under `.tenant-shell`, mounted for the component lifetime only.
 */

type AppPath = "/app/overview" | "/app/agents" | "/app/provider";

function useTenantStyles(): void {
  useEffect(() => {
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = tenantCssUrl;
    link.dataset.tenantStyle = "true";
    document.head.append(link);
    return () => link.remove();
  }, []);
}

function currentPath(): AppPath | "/app" | "unknown" {
  if (typeof window === "undefined") return "/app";
  const raw = window.location.pathname.replace(/\/+$/u, "") || "/";
  if (raw === "/app") return "/app";
  if (raw === "/app/overview") return "/app/overview";
  if (raw === "/app/agents") return "/app/agents";
  if (raw === "/app/provider") return "/app/provider";
  if (raw.startsWith("/app/")) return "unknown";
  return "unknown";
}

/** True only for the three implemented static workspace paths (and `/app`). */
function isKnownPath(path: AppPath | "/app" | "unknown"): boolean {
  return path !== "unknown";
}

export default function TenantApp() {
  const enabled = useMemo(() => tenantReadsEnabled() && accountAccessEnabled(), []);
  const [state, setState] = useState<TenantViewControllerState>(initialTenantState);
  const [path, setPath] = useState<AppPath | "/app" | "unknown">(currentPath);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const menuButtonRef = useRef<HTMLButtonElement | null>(null);
  const drawerRef = useRef<HTMLDivElement | null>(null);
  const drawerCloseRef = useRef<HTMLButtonElement | null>(null);
  const restoreFocusRef = useRef(false);
  const controllerRef = useRef<TenantController | null>(null);
  const accountRef = useRef<AccountFlowController | null>(null);
  const known = isKnownPath(path);

  useTenantStyles();

  useEffect(() => {
    const onPopState = () => setPath(currentPath());
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  useEffect(() => {
    // An unknown /app/* route must construct no controller and make zero auth
    // or tenant requests; only the three implemented routes initialize.
    if (!enabled || !known) return;
    // A fresh controller per mount keeps React's development double-invoke
    // safe: the first instance is disposed and the second owns the reads.
    const account = new AccountFlowController();
    const controller = new TenantController({ account, onState: setState });
    accountRef.current = account;
    controllerRef.current = controller;
    const onVisibility = () => {
      if (document.visibilityState === "hidden") {
        setDrawerOpen(false);
        controller.onHidden();
      }
    };
    const onPageHide = () => controller.onHidden();
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("pagehide", onPageHide);
    void controller.initialize();
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pagehide", onPageHide);
      controller.dispose();
      if (controllerRef.current === controller) controllerRef.current = null;
      if (accountRef.current === account) accountRef.current = null;
    };
  }, [enabled, known]);

  useEffect(() => {
    if (!drawerOpen) return;
    // Initial focus moves into the dialog.
    drawerCloseRef.current?.focus();
    const main = document.querySelector<HTMLElement>(".tenant-main");
    const rail = document.querySelector<HTMLElement>(".tenant-rail--static");
    main?.setAttribute("inert", "");
    rail?.setAttribute("inert", "");
    return () => {
      main?.removeAttribute("inert");
      rail?.removeAttribute("inert");
    };
  }, [drawerOpen]);

  // Restore focus to the trigger only AFTER the drawer has unmounted, so the
  // browser cannot move focus to the body when the dialog's node is removed.
  useEffect(() => {
    if (drawerOpen || !restoreFocusRef.current) return;
    restoreFocusRef.current = false;
    menuButtonRef.current?.focus();
  }, [drawerOpen]);

  const closeDrawer = useCallback(() => {
    restoreFocusRef.current = true;
    setDrawerOpen(false);
  }, []);

  const onDrawerKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (event.key === "Escape") {
        event.preventDefault();
        closeDrawer();
        return;
      }
      if (event.key !== "Tab") return;
      const focusables = drawerRef.current?.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
      );
      if (focusables === undefined || focusables.length === 0) return;
      const first = focusables[0]!;
      const last = focusables[focusables.length - 1]!;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    },
    [closeDrawer],
  );

  const navigate = useCallback((next: AppPath) => {
    setDrawerOpen(false);
    window.history.pushState(null, "", next);
    setPath(next);
  }, []);

  const selectOrganization = useCallback(
    (organizationId: string) => {
      const controller = controllerRef.current;
      if (controller === null) return;
      void controller.selectOrganization(organizationId as never);
    },
    [],
  );

  if (!enabled) return <TenantUnavailable />;

  const context = state.context;
  const selectedId = state.selectedOrganizationId;
  const currentOrganization =
    context !== null
      ? { displayName: context.organization.displayName, role: context.access.role, status: context.access.membershipStatus }
      : null;

  const activePath: AppPath | null =
    path === "/app" ? "/app/overview" : path === "unknown" ? null : path;

  return (
    <div className="tenant-shell">
      <a className="tenant-skip" href="#tenant-main">
        Skip to workspace content
      </a>

      <Rail
        staticRail
        state={state}
        currentPath={activePath}
        currentOrganization={currentOrganization}
        onSelect={selectOrganization}
        onNavigate={navigate}
      />

      {drawerOpen ? (
        <>
          <div className="tenant-scrim" onClick={closeDrawer} aria-hidden="true" />
          <div
            id="tenant-drawer"
            ref={drawerRef}
            className="tenant-drawer"
            role="dialog"
            aria-modal="true"
            aria-label="Workspace navigation"
            onKeyDown={onDrawerKeyDown}
          >
            <button
              type="button"
              ref={drawerCloseRef}
              className="tenant-menu-button"
              style={{ margin: "12px 18px" }}
              onClick={closeDrawer}
            >
              Close navigation menu
            </button>
            <Rail
              state={state}
              currentPath={activePath}
              currentOrganization={currentOrganization}
              onSelect={(id) => {
                closeDrawer();
                selectOrganization(id);
              }}
              onNavigate={(next) => {
                closeDrawer();
                navigate(next);
              }}
            />
          </div>
        </>
      ) : null}

      <div className="tenant-main">
        <header className="tenant-topbar">
          <a className="tenant-topbar__brand" href="/design" aria-label="OpenArc home">
            <img src="/openarc-logo.jpeg" alt="" width={32} height={32} />
            <span>OPENARC</span>
          </a>
          <button
            type="button"
            ref={menuButtonRef}
            className="tenant-menu-button"
            aria-expanded={drawerOpen}
            aria-controls="tenant-drawer"
            onClick={() => setDrawerOpen((open) => !open)}
          >
            {drawerOpen ? "Close menu" : "Menu"}
          </button>
        </header>

        <main id="tenant-main" className="tenant-content" tabIndex={-1}>
          <Workspace
            path={path}
            state={state}
            selectedId={selectedId}
            currentOrganization={currentOrganization}
            onSelect={selectOrganization}
            onNavigate={navigate}
            controller={controllerRef.current}
          />
        </main>

        <footer className="tenant-footer">
          <span className="tenant-mono">
            NON-CUSTODIAL · READ-ONLY WORKSPACE · {ARC_TESTNET.caip2}
          </span>
        </footer>
      </div>
    </div>
  );
}

interface RailProps {
  state: TenantViewControllerState;
  currentPath: AppPath | null;
  currentOrganization: { displayName: string; role: CommerceHumanRole; status: "active" | "suspended" } | null;
  onSelect: (organizationId: string) => void;
  onNavigate: (path: AppPath) => void;
  staticRail?: boolean;
}

function Rail(props: RailProps) {
  const { organizations, principal } = props.state;
  const navItems: Array<{ path: AppPath; label: string }> = [
    { path: "/app/overview", label: "Overview" },
    { path: "/app/agents", label: "Agents" },
    { path: "/app/provider", label: "Provider" },
  ];
  return (
    <nav
      className={props.staticRail === true ? "tenant-rail tenant-rail--static" : "tenant-rail"}
      aria-label="Organization workspace"
    >
      <a className="tenant-brand" href="/design" aria-label="OpenArc home">
        <img className="tenant-brand__logo" src="/openarc-logo.jpeg" alt="" width={38} height={38} />
        <span>
          <span className="tenant-brand__name">OPENARC</span>
          <span className="tenant-brand__sub">AGENT CONSOLE</span>
        </span>
      </a>

      <div className="tenant-rail__section">
        <p className="tenant-rail__label" id="tenant-org-label">
          Organization
        </p>
        {principal.status === "signed-in" ? (
          <select
            className="tenant-org-select"
            aria-labelledby="tenant-org-label"
            value={props.state.selectedOrganizationId ?? ""}
            disabled={organizations.status === "loading"}
            onChange={(event) => {
              if (event.target.value.length > 0) props.onSelect(event.target.value);
            }}
          >
            <option value="">Choose an organization to continue.</option>
            {organizations.items.map((organization) => (
              <option key={organization.organizationId} value={organization.organizationId}>
                {organization.displayName}
              </option>
            ))}
          </select>
        ) : null}
        {props.currentOrganization !== null ? (
          <p className="tenant-org-current">
            <strong>{props.currentOrganization.displayName}</strong>
            <br />
            <span className="tenant-org-role">
              {roleLabel(props.currentOrganization.role)} ·{" "}
              {props.currentOrganization.status === "active" ? "ACTIVE" : "SUSPENDED"}
            </span>
          </p>
        ) : null}
      </div>

      <div className="tenant-rail__section">
        <p className="tenant-rail__label">Workspace</p>
        <ul className="tenant-nav">
          {navItems.map((item) => (
            <li key={item.path}>
              <a
                href={item.path}
                aria-current={props.currentPath === item.path ? "page" : undefined}
                onClick={(event) => {
                  event.preventDefault();
                  props.onNavigate(item.path);
                }}
              >
                {item.label}
              </a>
            </li>
          ))}
        </ul>
      </div>

      <div className="tenant-rail__section">
        <p className="tenant-rail__label">Elsewhere</p>
        <ul className="tenant-nav">
          <li>
            <a href="/account">Account</a>
          </li>
          <li>
            <a href="/design/docs">Docs</a>
          </li>
          <li>
            <a href="/workspace">Local workspace</a>
          </li>
        </ul>
      </div>

      <div className="tenant-rail__spacer" />
      <span className="tenant-testnet">
        <span className="tenant-testnet__dot" aria-hidden="true" />
        TESTNET
      </span>
      <p className="tenant-rail__meta">
        chain {ARC_TESTNET.chainId}
        <br />
        {ARC_TESTNET.currencySymbol}
      </p>
    </nav>
  );
}

interface WorkspaceProps {
  path: AppPath | "/app" | "unknown";
  state: TenantViewControllerState;
  selectedId: string | null;
  currentOrganization: { displayName: string; role: CommerceHumanRole; status: "active" | "suspended" } | null;
  onSelect: (organizationId: string) => void;
  onNavigate: (path: AppPath) => void;
  controller: TenantController | null;
}

function Workspace(props: WorkspaceProps) {
  const { state } = props;
  const { principal } = state;

  // Unknown /app/* routes are bounded before any principal or read handling:
  // no controller is constructed and no auth or tenant request is made.
  if (props.path === "unknown") return <NotAvailable onNavigate={props.onNavigate} />;

  if (state.refreshRequired && principal.status === "signed-in" && state.organizations.status === "none") {
    return (
      <section aria-labelledby="tenant-refresh-title">
        <p className="tenant-eyebrow">WORKSPACE HIDDEN</p>
        <h1 className="tenant-title" id="tenant-refresh-title">Refresh required</h1>
        <p className="tenant-status tenant-status--warning" role="status">
          This page was hidden, so protected organization data was cleared. Refresh to sign in
          again and reload the workspace.
        </p>
        <div className="tenant-actions">
          <button
            type="button"
            className="tenant-button tenant-button--primary"
            disabled={state.busy}
            onClick={() => void props.controller?.refreshSession()}
          >
            Refresh workspace
          </button>
        </div>
      </section>
    );
  }

  if (principal.status === "idle" || principal.status === "loading") {
    return <p className="tenant-status" role="status">Loading the organization workspace…</p>;
  }
  if (principal.status === "signed-out") {
    return (
      <section aria-labelledby="tenant-signin-title">
        <p className="tenant-eyebrow">PROTECTED WORKSPACE</p>
        <h1 className="tenant-title" id="tenant-signin-title">Sign in required</h1>
        <p className="tenant-status" role="status">
          Organization access needs an active OpenArc session.
        </p>
        <div className="tenant-actions">
          <a className="tenant-button tenant-button--primary" href="/account">Go to account</a>
          <a className="tenant-button" href="/design/docs">Read the docs</a>
        </div>
      </section>
    );
  }
  if (principal.status === "expired") {
    return (
      <section aria-labelledby="tenant-expired-title">
        <p className="tenant-eyebrow">SESSION</p>
        <h1 className="tenant-title" id="tenant-expired-title">Session expired. Sign in again.</h1>
        <div className="tenant-actions">
          <a className="tenant-button tenant-button--primary" href="/account">Go to account</a>
        </div>
      </section>
    );
  }

  if (state.organizations.status === "error") {
    return (
      <section aria-labelledby="tenant-org-error-title">
        <p className="tenant-eyebrow">ORGANIZATIONS</p>
        <h1 className="tenant-title" id="tenant-org-error-title">Organizations could not be loaded</h1>
        <p className="tenant-status tenant-status--error" role="alert">
          The organization service is unavailable right now. Try again in a moment.
        </p>
      </section>
    );
  }

  if (state.organizations.status === "loading" && state.organizations.items.length === 0) {
    return <p className="tenant-status" role="status">Loading organizations…</p>;
  }

  if (state.organizations.items.length === 0 && state.organizations.nextCursor === null) {
    return (
      <section aria-labelledby="tenant-noorg-title">
        <p className="tenant-eyebrow">ORGANIZATIONS</p>
        <h1 className="tenant-title" id="tenant-noorg-title">No organizations available.</h1>
        <p className="tenant-lede">
          This account is not a member of any organization yet. If that seems wrong, an owner
          must invite this account first.
        </p>
      </section>
    );
  }

  if (props.selectedId === null || props.currentOrganization === null) {
    return (
      <section aria-labelledby="tenant-choose-title">
        <p className="tenant-eyebrow">ORGANIZATIONS</p>
        <h1 className="tenant-title" id="tenant-choose-title">Choose an organization to continue.</h1>
        <OrganizationList state={state} onSelect={props.onSelect} controller={props.controller} />
      </section>
    );
  }

  switch (props.path) {
    case "/app/agents":
      return <AgentPanel state={state} role={props.currentOrganization.role} controller={props.controller} />;
    case "/app/provider":
      return <ProviderPanel state={state} role={props.currentOrganization.role} controller={props.controller} />;
    default:
      return <Overview state={state} currentOrganization={props.currentOrganization} />;
  }
}

function OrganizationList(props: {
  state: TenantViewControllerState;
  onSelect: (organizationId: string) => void;
  controller: TenantController | null;
}) {
  const { organizations } = props.state;
  return (
    <>
      <ul className="tenant-table-wrap tenant-table" style={{ listStyle: "none", margin: 0, padding: 0 }}>
        {organizations.items.map((organization) => (
          <li key={organization.organizationId} style={{ display: "contents" }}>
            <button
              type="button"
              className="tenant-button"
              style={{ display: "flex", width: "100%", justifyContent: "flex-start" }}
              onClick={() => props.onSelect(organization.organizationId)}
            >
              {organization.displayName}{" "}
              <span className="tenant-mono" style={{ marginLeft: 12 }}>
                {organization.organizationId}
              </span>
            </button>
          </li>
        ))}
      </ul>
      <Pagination
        status={organizations.status}
        hasNext={organizations.nextCursor !== null}
        hasPrevious={organizations.hasPrevious}
        onNext={() => void props.controller?.loadNextOrganizations()}
        onFirst={() => void props.controller?.loadOrganizations()}
      />
    </>
  );
}

function Overview(props: {
  state: TenantViewControllerState;
  currentOrganization: { displayName: string; role: CommerceHumanRole; status: "active" | "suspended" };
}) {
  const { currentOrganization, state } = props;
  return (
    <section aria-labelledby="tenant-overview-title">
      <p className="tenant-eyebrow">OVERVIEW</p>
      <h1 className="tenant-title" id="tenant-overview-title">
        {currentOrganization.displayName}
      </h1>
      <dl className="tenant-meta">
        <dt>Role</dt>
        <dd>
          {roleLabel(currentOrganization.role)}{" "}
          <span className="tenant-pill tenant-pill--active">{currentOrganization.status}</span>
        </dd>
        <dt>Network</dt>
        <dd>Arc Testnet ({ARC_TESTNET.chainId})</dd>
        <dt>Organization ID</dt>
        <dd className="tenant-mono">{state.selectedOrganizationId}</dd>
      </dl>
      <p className="tenant-lede">Choose Agents or Provider to view this organization.</p>
    </section>
  );
}

function AgentPanel(props: {
  state: TenantViewControllerState;
  role: CommerceHumanRole;
  controller: TenantController | null;
}) {
  if (!canReadAgents(props.role)) return <RoleNotAllowed role={props.role} action="agents" />;
  const { agents } = props.state;
  return (
    <section aria-labelledby="tenant-agents-title">
      <p className="tenant-eyebrow">AGENTS</p>
      <h1 className="tenant-title" id="tenant-agents-title">Agents</h1>
      {agents.status === "none" ? (
        <div className="tenant-actions">
          <button
            type="button"
            className="tenant-button tenant-button--primary"
            onClick={() => void props.controller?.loadAgents()}
          >
            Load agents
          </button>
        </div>
      ) : null}
      {agents.status === "loading" ? <p className="tenant-status" role="status">Loading agents…</p> : null}
      {agents.status === "error" ? (
        <p className="tenant-status tenant-status--error" role="alert">
          Agents could not be loaded right now.
        </p>
      ) : null}
      {agents.status === "ready" && agents.items.length === 0 ? (
        <p className="tenant-empty">No agents in this organization.</p>
      ) : null}
      {agents.items.length > 0 ? <ProfileTable kind="agent" items={agents.items} /> : null}
      <Pagination
        status={agents.status}
        hasNext={agents.nextCursor !== null}
        hasPrevious={agents.hasPrevious}
        onNext={() => void props.controller?.loadNextAgents()}
        onFirst={() => void props.controller?.loadAgents()}
      />
    </section>
  );
}

function ProviderPanel(props: {
  state: TenantViewControllerState;
  role: CommerceHumanRole;
  controller: TenantController | null;
}) {
  if (!canReadProviders(props.role)) return <RoleNotAllowed role={props.role} action="providers" />;
  const { providers } = props.state;
  return (
    <section aria-labelledby="tenant-providers-title">
      <p className="tenant-eyebrow">PROVIDER</p>
      <h1 className="tenant-title" id="tenant-providers-title">Provider</h1>
      {providers.status === "none" ? (
        <div className="tenant-actions">
          <button
            type="button"
            className="tenant-button tenant-button--primary"
            onClick={() => void props.controller?.loadProviders()}
          >
            Load providers
          </button>
        </div>
      ) : null}
      {providers.status === "loading" ? (
        <p className="tenant-status" role="status">Loading providers…</p>
      ) : null}
      {providers.status === "error" ? (
        <p className="tenant-status tenant-status--error" role="alert">
          Providers could not be loaded right now.
        </p>
      ) : null}
      {providers.status === "ready" && providers.items.length === 0 ? (
        <p className="tenant-empty">No providers in this organization.</p>
      ) : null}
      {providers.items.length > 0 ? <ProfileTable kind="provider" items={providers.items} /> : null}
      <Pagination
        status={providers.status}
        hasNext={providers.nextCursor !== null}
        hasPrevious={providers.hasPrevious}
        onNext={() => void props.controller?.loadNextProviders()}
        onFirst={() => void props.controller?.loadProviders()}
      />
    </section>
  );
}

type ProfileItems = TenantViewControllerState["agents"]["items"] | TenantViewControllerState["providers"]["items"];

function ProfileTable(props: { kind: "agent" | "provider"; items: ProfileItems }) {
  const isAgent = props.kind === "agent";
  return (
    <div className="tenant-table-wrap">
      <table className="tenant-table">
        <caption>{isAgent ? "Agents" : "Providers"} in this organization</caption>
        <thead>
          <tr>
            <th scope="col">Name</th>
            <th scope="col">Status</th>
            <th scope="col">{isAgent ? "Agent ID" : "Provider ID"}</th>
            <th scope="col">Created</th>
            <th scope="col">Updated</th>
          </tr>
        </thead>
        <tbody>
          {props.items.map((item) => {
            const parsed = isAgent
              ? CommerceAgentProfileSchema.safeParse(item)
              : CommerceProviderProfileSchema.safeParse(item);
            const id = isAgent
              ? (item as TenantViewControllerState["agents"]["items"][number]).agentId
              : (item as TenantViewControllerState["providers"]["items"][number]).providerId;
            if (!parsed.success) return null;
            return (
              <tr key={id}>
                <td>{parsed.data.displayName}</td>
                <td>
                  <span className={`tenant-pill ${parsed.data.status === "active" ? "tenant-pill--active" : ""}`}>
                    {parsed.data.status}
                  </span>
                </td>
                <td className="tenant-mono">{id}</td>
                <td className="tenant-mono">{parsed.data.createdAt}</td>
                <td className="tenant-mono">{parsed.data.updatedAt}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function Pagination(props: {
  status: TenantViewControllerState["agents"]["status"];
  hasNext: boolean;
  hasPrevious: boolean;
  onNext: () => void;
  onFirst: () => void;
}) {
  if (props.status !== "ready" && !props.hasNext && !props.hasPrevious) return null;
  const loading = props.status === "loading";
  return (
    <div className="tenant-pagination">
      {props.hasPrevious ? (
        <button
          type="button"
          className="tenant-button"
          disabled={loading}
          onClick={props.onFirst}
        >
          Back to page 1
        </button>
      ) : null}
      <button
        type="button"
        className="tenant-button"
        disabled={loading || !props.hasNext}
        onClick={props.onNext}
      >
        Next page
      </button>
      <span className="tenant-pagination__status">
        Page size ≤ {MAX_PAGE_LIMIT}. Replaces the current page.
      </span>
    </div>
  );
}

function RoleNotAllowed(props: { role: CommerceHumanRole; action: "agents" | "providers" }) {
  return (
    <section aria-labelledby="tenant-role-denied-title">
      <p className="tenant-eyebrow">NOT ALLOWED</p>
      <h1 className="tenant-title" id="tenant-role-denied-title">
        Your role cannot view {props.action === "agents" ? "agents" : "providers"}
      </h1>
      <p className="tenant-status tenant-status--warning" role="status">
        The current organization role <strong>{roleLabel(props.role)}</strong> is not permitted to
        read this panel. No request was made.
      </p>
      <div className="tenant-actions">
        <a className="tenant-button" href="/app/overview">Back to overview</a>
      </div>
    </section>
  );
}

function NotAvailable(props: { onNavigate: (path: AppPath) => void }) {
  return (
    <section aria-labelledby="tenant-unavailable-title">
      <p className="tenant-eyebrow">WORKSPACE</p>
      <h1 className="tenant-title" id="tenant-unavailable-title">This section is not available yet</h1>
      <p className="tenant-lede">
        The requested workspace route does not exist. Nothing was loaded for it.
      </p>
      <div className="tenant-actions">
        <a
          className="tenant-button tenant-button--primary"
          href="/app/overview"
          onClick={(event) => {
            event.preventDefault();
            props.onNavigate("/app/overview");
          }}
        >
          Go to overview
        </a>
      </div>
    </section>
  );
}

function TenantUnavailable() {
  return (
    <div className="tenant-shell" style={{ gridTemplateColumns: "minmax(0, 1fr)" }}>
      <main className="tenant-content" style={{ gridColumn: "1" }}>
        <p className="tenant-eyebrow">ORGANIZATION WORKSPACE</p>
        <h1 className="tenant-title">Organization workspace is not available in this deployment</h1>
        <p className="tenant-lede">
          Protected organization reads are disabled here. You can keep using the public docs or
          open the local workspace.
        </p>
        <div className="tenant-actions">
          <a className="tenant-button" href="/design/docs">Read the docs</a>
          <a className="tenant-button tenant-button--primary" href="/workspace">Local workspace</a>
        </div>
      </main>
    </div>
  );
}

function roleLabel(role: CommerceHumanRole): string {
  switch (role) {
    case "owner":
      return "Owner";
    case "operator":
      return "Operator";
    case "provider_admin":
      return "Provider admin";
    case "provider_developer":
      return "Provider developer";
    case "viewer":
      return "Viewer";
  }
}

export type { TenantFetch };
