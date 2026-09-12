import {
  ARC_TESTNET,
  CommerceAgentProfileSchema,
  CommerceProviderProfileSchema,
  type CommerceListingOwnerVersion,
  type CommerceHumanRole,
} from "@openarc/shared";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";

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
import { machineCredentialEnabled, tenantMutationEnabled, tenantReadsEnabled } from "./availability.js";
import { listingManagementEnabledFromEnv } from "./listing-availability.js";
import { TenantMutationPanel } from "./TenantMutationPanel.js";
import { MachineCredentialPanel } from "./MachineCredentialPanel.js";
import { ListingListPanel } from "./ListingListPanel.js";
import { ListingEditorPanel, ListingLifecycleActions } from "./ListingEditorPanel.js";
import { ListingVersionHistory } from "./ListingVersionHistory.js";
import {
  ListingController,
  initialListingControllerState,
  suppressStaleListingContext,
  type ListingControllerState,
} from "./listing-controller.js";
import { parseListingRoute, type ListingRoute } from "./listing-routes.js";
import {
  MachineCredentialController,
  initialMachineConsoleState,
  initialMachineCredentialListState,
  suppressStaleMachineContext,
  type MachineConsoleState,
  type MachineCredentialListState,
  type MachineCredentialTarget,
  type MachineReadCoordinator,
  type MachineRenderContext,
} from "./machine-controller.js";
import {
  TenantWriteController,
  initialTenantMutationState,
  type TenantMutationState,
} from "./tenant-write-controller.js";
import {
  renderMutationState,
  suppressPriorAccountMutation,
} from "./tenant-mutation-render.js";

import tenantCssUrl from "./tenant.css?url";
import listingCssUrl from "./market-listing.css?url";

/**
 * Protected organization workspace.
 *
 * The flag gate renders a static unavailable state and constructs no
 * controller, so a disabled deployment makes zero auth or tenant requests.
 * When enabled, the workspace is a same-origin link-loaded stylesheet scoped
 * entirely under `.tenant-shell`, mounted for the component lifetime only.
 */

type AppPath =
  | "/app/overview"
  | "/app/agents"
  | "/app/provider"
  | "/app/provider/listings"
  | "/app/provider/listings/new";

type WorkspacePath =
  | AppPath
  | "/app"
  | { readonly kind: "listing-detail"; readonly listingId: string }
  | "unknown";

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

/** Mounts the scoped listing stylesheet for the feature lifetime only. */
function useListingStyles(active: boolean): void {
  useEffect(() => {
    if (!active) return;
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = listingCssUrl;
    link.dataset.listingStyle = "true";
    document.head.append(link);
    return () => link.remove();
  }, [active]);
}

function currentPath(): WorkspacePath {
  if (typeof window === "undefined") return "/app";
  const raw = window.location.pathname.replace(/\/+$/u, "") || "/";
  if (raw === "/app") return "/app";
  if (raw === "/app/overview") return "/app/overview";
  if (raw === "/app/agents") return "/app/agents";
  if (raw === "/app/provider") return "/app/provider";
  if (raw.startsWith("/app/provider/listings")) {
    const listing = parseListingRoute(raw);
    if (listing === null) return "unknown";
    if (listing.kind === "roots") return "/app/provider/listings";
    if (listing.kind === "new") return "/app/provider/listings/new";
    if (listing.kind === "detail") return { kind: "listing-detail", listingId: listing.listingId };
  }
  if (raw.startsWith("/app/")) return "unknown";
  return "unknown";
}

/** True only for an implemented static workspace or protected listing path. */
function isKnownPath(path: WorkspacePath): boolean {
  return path !== "unknown";
}

/** The route object for a listing workspace path, or null when not listing. */
function listingRouteOf(path: WorkspacePath): ListingRoute | null {
  if (path === "/app/provider/listings") return { kind: "roots" };
  if (path === "/app/provider/listings/new") return { kind: "new" };
  if (typeof path === "object" && path.kind === "listing-detail") {
    return { kind: "detail", listingId: path.listingId };
  }
  return null;
}

function isListingWorkspacePath(path: WorkspacePath): boolean {
  return listingRouteOf(path) !== null;
}

export default function TenantApp() {
  const enabled = useMemo(() => tenantReadsEnabled() && accountAccessEnabled(), []);
  const writesEnabled = useMemo(
    () =>
      tenantMutationEnabled(
        import.meta.env.VITE_TENANT_WRITES_ENABLED,
        import.meta.env.VITE_TENANT_READS_ENABLED,
        import.meta.env.VITE_ACCOUNT_ACCESS_ENABLED,
      ),
    [],
  );
  const machineEnabled = useMemo(
    () =>
      machineCredentialEnabled(
        import.meta.env.VITE_MACHINE_CREDENTIAL_MANAGEMENT_ENABLED,
        import.meta.env.VITE_TENANT_WRITES_ENABLED,
        import.meta.env.VITE_TENANT_READS_ENABLED,
        import.meta.env.VITE_ACCOUNT_ACCESS_ENABLED,
      ),
    [],
  );
  // The listing surface is independent of the write and machine flags: it has
  // its own server authority and its own capability probe. All defaults false.
  const listingEnabled = useMemo(() => listingManagementEnabledFromEnv(), []);
  const [state, setState] = useState<TenantViewControllerState>(initialTenantState);
  const [mutationState, setMutationState] = useState<TenantMutationState>(initialTenantMutationState);
  const [machineState, setMachineState] = useState<MachineConsoleState>(initialMachineConsoleState);
  const [machineList, setMachineList] = useState<MachineCredentialListState>(initialMachineCredentialListState);
  const [listingState, setListingState] = useState<ListingControllerState>(initialListingControllerState);
  const [listingCreating, setListingCreating] = useState(false);
  const [listingProviderId, setListingProviderId] = useState<string | null>(null);
  const [listingBaseVersion, setListingBaseVersion] = useState<CommerceListingOwnerVersion | null>(null);
  const [selectedProfile, setSelectedProfile] = useState<MachineCredentialTarget | null>(null);
  const [path, setPath] = useState<WorkspacePath>(currentPath);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const menuButtonRef = useRef<HTMLButtonElement | null>(null);
  const drawerRef = useRef<HTMLDivElement | null>(null);
  const drawerCloseRef = useRef<HTMLButtonElement | null>(null);
  const restoreFocusRef = useRef(false);
  const controllerRef = useRef<TenantController | null>(null);
  const writeControllerRef = useRef<TenantWriteController | null>(null);
  const machineControllerRef = useRef<MachineCredentialController | null>(null);
  const listingControllerRef = useRef<ListingController | null>(null);
  const boundMachineContextRef = useRef<MachineRenderContext | null>(null);
  const boundListingContextRef = useRef<{ accountId: string; organizationId: string; role: string | null } | null>(null);
  const listingOpenRef = useRef<((listingId: string) => void) | null>(null);
  const accountRef = useRef<AccountFlowController | null>(null);
  const known = isKnownPath(path);

  useTenantStyles();
  useListingStyles(listingEnabled);

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
    // The write controller is constructed ONLY when the write flag and all its
    // prerequisites are enabled. With writes off, no write client, controller
    // or form is ever created, so the read-only surface is byte-identical to
    // the accepted build and makes zero ADDITIONAL auth/write calls.
    const writeController = writesEnabled
      ? new TenantWriteController({
          account,
          reads: controller,
          onState: setMutationState,
        })
      : null;
    writeControllerRef.current = writeController;
    // The machine credential console is constructed ONLY when its own flag and
    // all four prerequisites are enabled. With it off, no machine client,
    // controller, panel, profile-selection control or machine request exists and
    // the surface is byte-identical to the accepted build. It never uses a
    // machine browser session or bearer transport.
    const machineReads: MachineReadCoordinator = {
      currentOrganizationId: () => controller.currentOrganizationId(),
      currentRole: () => controller.currentRole(),
      currentAccountId: () => account.state.session.signedIn ? account.state.session.accountId : null,
      abortPendingReads: () => controller.abortPendingReads(),
      reloadAfterCommit: async (kind) => {
        await controller.reloadAfterCommit(kind === "agent" ? "agents" : "providers");
      },
    };
    const machineController = machineEnabled
      ? new MachineCredentialController({
          account,
          reads: machineReads,
          isProfileActive: (kind, profileId) => profileIsActive(controller, kind, profileId),
          onState: setMachineState,
          onListState: setMachineList,
        })
      : null;
    machineControllerRef.current = machineController;
    // The listing controller is constructed ONLY when its own flag and all its
    // prerequisites are enabled. It mounts no read/write client request until a
    // protected listing route initializes the independent capability gate, and
    // it never depends on the tenant-write or machine-credential flags.
    const listingController = listingEnabled
      ? new ListingController({
          account,
          reads: {
            currentOrganizationId: () => controller.currentOrganizationId(),
            currentRole: () => controller.currentRole(),
            currentAccountId: () =>
              account.state.session.signedIn ? account.state.session.accountId : null,
            abortPendingReads: () => controller.abortPendingReads(),
            reloadAfterCommit: async () => {
              await controller.reloadAfterCommit("providers");
            },
          },
          onState: setListingState,
          onCommittedListing: (listingId) => listingOpenRef.current?.(listingId),
        })
      : null;
    listingControllerRef.current = listingController;
    const onVisibility = () => {
      if (document.visibilityState === "hidden") {
        // The hidden boundary is external and synchronous: a browser may
        // discard the page (or snapshot it) the moment this handler returns, so
        // clearing controller memory and committing the corresponding React
        // state must both finish before returning. flushSync forces
        // onState/onListState commits here instead of in a later render.
        flushSync(() => {
          setDrawerOpen(false);
          controller.onHidden();
          writeController?.clear();
          machineController?.clear();
          listingController?.clear();
        });
      }
    };
    const onPageHide = () => {
      flushSync(() => {
        controller.onHidden();
        writeController?.clear();
        machineController?.clear();
        listingController?.clear();
      });
    };
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("pagehide", onPageHide);
    void controller.initialize();
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pagehide", onPageHide);
      controller.dispose();
      writeController?.dispose();
      machineController?.dispose();
      listingController?.dispose();
      if (controllerRef.current === controller) controllerRef.current = null;
      if (writeControllerRef.current === writeController) writeControllerRef.current = null;
      if (machineControllerRef.current === machineController) machineControllerRef.current = null;
      if (listingControllerRef.current === listingController) listingControllerRef.current = null;
      if (accountRef.current === account) accountRef.current = null;
    };
  }, [enabled, known, writesEnabled, machineEnabled, listingEnabled]);

  // Clear the create/version selection when leaving the listing subtree.
  useEffect(() => {
    if (isListingWorkspacePath(path)) return;
    setListingCreating(false);
    setListingProviderId(null);
    setListingBaseVersion(null);
    listingControllerRef.current?.clearSensitive();
  }, [path]);

  // A signed-in identity change must never expose a previous account's
  // committed confirmation. The receipt belongs to the account that produced
  // it; a signed-out/expired transition (for example a self-demotion that
  // revoked this session) keeps the same account's committed evidence on
  // screen. Hidden/logout/navigation clears run separately in the flow.
  const accountId = state.principal.accountId;
  const lastAccountRef = useRef<string | null>(null);
  useEffect(() => {
    if (accountId === null) return;
    if (lastAccountRef.current === null) {
      lastAccountRef.current = accountId;
      return;
    }
    if (lastAccountRef.current !== accountId) {
      lastAccountRef.current = accountId;
      writeControllerRef.current?.clear();
      setMutationState(initialTenantMutationState());
      machineControllerRef.current?.clear();
      setMachineState(initialMachineConsoleState());
      setMachineList(initialMachineCredentialListState());
      listingControllerRef.current?.clear();
      setListingCreating(false);
      setListingProviderId(null);
      setListingBaseVersion(null);
      setSelectedProfile(null);
    }
  }, [accountId]);

  // An explicit profile selection binds the machine controller to exactly that
  // profile. A change of organization, role or profile clears the previous
  // context's list, receipt and one-time secret through the controller.
  const organizationId = state.selectedOrganizationId;
  const role: CommerceHumanRole | null = state.context?.access.role ?? null;
  useEffect(() => {
    // The listing controller is independent of the machine flag, so reconcile
    // its role before the machine early-return below.
    listingControllerRef.current?.reconcileRole(role);
    const machineController = machineControllerRef.current;
    if (machineController === null) return;
    // Role is authoritative from the current server context. Reconcile it
    // explicitly (before reselection) so an owner->viewer->owner round trip
    // clears a same-profile secret/receipt/list instead of resurrecting it once
    // the synchronous render guard releases.
    machineController.reconcileRole(role);
    machineController.select(selectedProfile);
  }, [selectedProfile, organizationId, role, accountId]);

  // Organization change clears an explicit profile selection so no credential
  // panel is shown for a stale profile.
  useEffect(() => {
    setSelectedProfile(null);
    setListingCreating(false);
    setListingProviderId(null);
    setListingBaseVersion(null);
    listingControllerRef.current?.clear();
  }, [organizationId]);

  // Initialize the listing controller only for a protected listing route. This
  // effect is declared AFTER the organization/role reconciliation effects so it
  // observes the authoritative context. The capability probe runs first and,
  // when it is not `enabled`, no listing request is made and an honest
  // unavailable state is rendered.
  useEffect(() => {
    const listingController = listingControllerRef.current;
    if (listingController === null) return;
    const route = listingRouteOf(path);
    if (route === null) return;
    void listingController.initialize(route);
  }, [path, listingEnabled, organizationId, role, accountId]);

  // After the render where the machine context is current, record the bound
  // context so the NEXT transition render can suppress synchronously. When the
  // controller is cleared/absent the bound context is null.
  useEffect(() => {
    const machineController = machineControllerRef.current;
    if (machineController === null || selectedProfile === null || organizationId === null || accountId === null) {
      boundMachineContextRef.current = null;
      return;
    }
    boundMachineContextRef.current = {
      accountId,
      organizationId,
      role,
      kind: selectedProfile.kind,
      profileId: selectedProfile.profileId,
    };
  }, [selectedProfile, organizationId, accountId, role]);

  // After the render where the listing context is current, record the bound
  // account/organization/role so the NEXT transition render suppresses
  // synchronously before any child can read a stale draft, receipt or list.
  useEffect(() => {
    if (
      listingControllerRef.current === null ||
      !isListingWorkspacePath(path) ||
      organizationId === null ||
      accountId === null
    ) {
      boundListingContextRef.current = null;
      return;
    }
    boundListingContextRef.current = { accountId, organizationId, role };
  }, [path, organizationId, accountId, role]);

  // Synchronous privacy guard: effects run after render, so the effect above
  // alone would paint one stale frame of account A's receipt/form for account
  // B. Compute this during render and expose only the guarded state/controller
  // to the Workspace, because the mutation panel also reads controller.state
  // directly. A->null is intentionally allowed so a self-demotion receipt from
  // the same account survives the session revocation.
  const suppressPriorMutation = suppressPriorAccountMutation(lastAccountRef.current, accountId);
  const renderedMutationState = renderMutationState(
    lastAccountRef.current,
    accountId,
    mutationState,
    initialTenantMutationState,
  );
  const renderedWriteController = suppressPriorMutation ? null : writeControllerRef.current;

  // Synchronous machine context guard. The credential console may hold a
  // one-time secret and a receipt bound to an exact account/organization/role
  // and profile. `boundMachineContextRef` is the context the controller was last
  // bound to; it is updated in an effect, so during a transition render the ref
  // still names the OLD context and the guard suppresses synchronously before
  // any child can read stale state. Effects alone would paint one stale frame.
  const currentMachineContext: MachineRenderContext = {
    accountId,
    organizationId,
    role,
    kind: selectedProfile?.kind ?? null,
    profileId: selectedProfile?.profileId ?? null,
  };
  const suppressMachine =
    machineControllerRef.current !== null &&
    (suppressPriorMutation ||
      suppressStaleMachineContext(boundMachineContextRef.current, currentMachineContext));

  const suppressListing =
    listingControllerRef.current !== null &&
    (suppressPriorMutation ||
      suppressStaleListingContext(
        boundListingContextRef.current !== null && accountId !== null && organizationId !== null
          ? {
              accountId: boundListingContextRef.current.accountId,
              organizationId: boundListingContextRef.current.organizationId,
              role: boundListingContextRef.current.role,
            }
          : null,
        { accountId, organizationId, role },
      ));

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
    writeControllerRef.current?.clear();
    listingControllerRef.current?.clearSensitive();
    setListingCreating(false);
    setListingProviderId(null);
    setListingBaseVersion(null);
    setMutationState(initialTenantMutationState());
    setDrawerOpen(false);
    window.history.pushState(null, "", next);
    setPath(next);
  }, []);

  const openListing = useCallback((listingId: string) => {
    const route = parseListingRoute(`/app/provider/listings/${encodeURIComponent(listingId)}`);
    if (route === null || route.kind !== "detail") return;
    setDrawerOpen(false);
    window.history.pushState(null, "", `/app/provider/listings/${encodeURIComponent(route.listingId)}`);
    setPath({ kind: "listing-detail", listingId: route.listingId });
  }, []);
  useEffect(() => {
    listingOpenRef.current = openListing;
  }, [openListing]);

  const selectOrganization = useCallback(
    (organizationId: string) => {
      writeControllerRef.current?.clear();
      setMutationState(initialTenantMutationState());
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
    path === "/app"
      ? "/app/overview"
      : path === "unknown"
        ? null
        : typeof path === "object"
          ? "/app/provider/listings"
          : path;

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
          {/*
            Keyed subtree + synchronous guard: while the machine context is
            suppressed the immediate subtree is keyed to the new context AND the
            machine props are null, so no credential state, secret or list can
            be read by a child during the transition render.
          */}
          <Workspace
            key={`machine-context:${suppressMachine ? "suppressed" : `${organizationId ?? "none"}/${
              selectedProfile?.kind ?? "none"
            }/${selectedProfile?.profileId ?? "none"}`}`}
            path={path}
            state={state}
            selectedId={selectedId}
            currentOrganization={currentOrganization}
            onSelect={selectOrganization}
            onNavigate={navigate}
            controller={controllerRef.current}
            writeController={renderedWriteController}
            mutationState={renderedMutationState}
            machineController={suppressMachine ? null : machineControllerRef.current}
            machineState={suppressMachine ? initialMachineConsoleState() : machineState}
            machineList={suppressMachine ? initialMachineCredentialListState() : machineList}
            onSelectProfile={setSelectedProfile}
            machineEnabled={machineEnabled}
            listingEnabled={listingEnabled}
            listingState={suppressListing ? initialListingControllerState() : listingState}
            listingController={suppressListing ? null : listingControllerRef.current}
            listingCreating={listingCreating}
            listingProviderId={listingProviderId}
            listingBaseVersion={listingBaseVersion}
            onSelectListingProvider={setListingProviderId}
            onStartListingCreate={() => {
              setListingCreating(true);
              void listingControllerRef.current?.loadProviderOptions();
            }}
            onCancelListingCreate={() => setListingCreating(false)}
            onSelectListingBaseVersion={(version) => {
              setListingBaseVersion(version);
              listingControllerRef.current?.selectVersion(version);
            }}
            onOpenListing={openListing}
          />
        </main>

        <footer className="tenant-footer">
          <span className="tenant-mono">
            {machineEnabled
              ? `NON-CUSTODIAL · NO PAYMENTS · MACHINE CREDENTIALS · ${ARC_TESTNET.caip2}`
              : writesEnabled
              ? `NON-CUSTODIAL · NO PAYMENTS · ${ARC_TESTNET.caip2}`
              : `NON-CUSTODIAL · READ-ONLY WORKSPACE · ${ARC_TESTNET.caip2}`}
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
    { path: "/app/provider/listings", label: "Listings" },
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
  path: WorkspacePath;
  state: TenantViewControllerState;
  selectedId: string | null;
  currentOrganization: { displayName: string; role: CommerceHumanRole; status: "active" | "suspended" } | null;
  onSelect: (organizationId: string) => void;
  onNavigate: (path: AppPath) => void;
  controller: TenantController | null;
  writeController: TenantWriteController | null;
  mutationState: TenantMutationState;
  machineController: MachineCredentialController | null;
  machineState: MachineConsoleState;
  machineList: MachineCredentialListState;
  onSelectProfile: (target: MachineCredentialTarget | null) => void;
  machineEnabled: boolean;
  listingEnabled: boolean;
  listingState: ListingControllerState;
  listingController: ListingController | null;
  listingCreating: boolean;
  listingProviderId: string | null;
  listingBaseVersion: CommerceListingOwnerVersion | null;
  onSelectListingProvider: (providerId: string) => void;
  onStartListingCreate: () => void;
  onCancelListingCreate: () => void;
  onSelectListingBaseVersion: (version: CommerceListingOwnerVersion) => void;
  onOpenListing: (listingId: string) => void;
}

function Workspace(props: WorkspaceProps) {
  const { state } = props;
  const { principal } = state;

  // A committed receipt or an unconfirmed outcome must stay visible while the
  // organization list refreshes after a bootstrap create and no organization
  // is selected yet. These are terminal, form-free states: they never enable a
  // new create outside the real first-organization context.
  const stickyMutation =
    props.writeController !== null &&
    (props.mutationState.kind === "committed" || props.mutationState.kind === "outcome-unknown");
  // After a session revocation only the authoritative committed receipt is
  // kept: never a draft, an in-flight unknown or a recoverable check action.
  const committedReceipt =
    props.writeController !== null && props.mutationState.kind === "committed";

  // Unknown /app/* routes are bounded before any principal or read handling:
  // no controller is constructed and no auth or tenant request is made.
  if (props.path === "unknown") return <NotAvailable onNavigate={props.onNavigate} />;

  const listingRoute = listingRouteOf(props.path);
  if (listingRoute !== null) {
    // A listing route is known (not "unknown"): with the flag off nothing was
    // constructed and the section is honestly unavailable. With the flag on the
    // controller's independent capability gate decides the rendered state.
    if (!props.listingEnabled) return <NotAvailable onNavigate={props.onNavigate} />;
  }

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
        {committedReceipt ? (
          <TenantMutationPanel
            controller={props.writeController}
            role={props.currentOrganization?.role ?? "owner"}
            organizationId={props.selectedId ?? ""}
            mode="receipt"
          />
        ) : null}
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
        {committedReceipt ? (
          <TenantMutationPanel
            controller={props.writeController}
            role={props.currentOrganization?.role ?? "owner"}
            organizationId={props.selectedId ?? ""}
            mode="receipt"
          />
        ) : null}
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
    return (
      <>
        <p className="tenant-status" role="status">Loading organizations…</p>
        {stickyMutation ? (
          <TenantMutationPanel
            controller={props.writeController}
            role={props.currentOrganization?.role ?? "owner"}
            organizationId={props.selectedId ?? ""}
            mode="receipt"
          />
        ) : null}
      </>
    );
  }

  if (state.organizations.items.length === 0 && state.organizations.nextCursor === null) {
    // First-organization bootstrap: a signed-in, writes-enabled user with zero
    // organizations gets the create-organization action. A known-recovery
    // session never sees the form (the server alone decides proof freshness),
    // and the failed reads/signed-out/flag-off paths returned above.
    const bootstrapAllowed =
      props.writeController !== null &&
      principal.method !== "recovery" &&
      principal.status === "signed-in";
    return (
      <section aria-labelledby="tenant-noorg-title">
        <p className="tenant-eyebrow">ORGANIZATIONS</p>
        <h1 className="tenant-title" id="tenant-noorg-title">No organizations available.</h1>
        <p className="tenant-lede">
          This account is not a member of any organization yet. If that seems wrong, an owner
          must invite this account first.
        </p>
        {bootstrapAllowed ? (
          <TenantMutationPanel
            controller={props.writeController}
            role={props.currentOrganization?.role ?? "owner"}
            organizationId={props.selectedId ?? ""}
            mode="bootstrap"
          />
        ) : stickyMutation ? (
          <TenantMutationPanel
            controller={props.writeController}
            role={props.currentOrganization?.role ?? "owner"}
            organizationId={props.selectedId ?? ""}
            mode="receipt"
          />
        ) : null}
      </section>
    );
  }

  if (props.selectedId === null || props.currentOrganization === null) {
    return (
      <section aria-labelledby="tenant-choose-title">
        <p className="tenant-eyebrow">ORGANIZATIONS</p>
        <h1 className="tenant-title" id="tenant-choose-title">Choose an organization to continue.</h1>
        {stickyMutation ? (
          <TenantMutationPanel
            controller={props.writeController}
            role={props.currentOrganization?.role ?? "owner"}
            organizationId={props.selectedId ?? ""}
            mode="receipt"
          />
        ) : null}
        <OrganizationList state={state} onSelect={props.onSelect} controller={props.controller} />
      </section>
    );
  }

  if (listingRoute !== null) {
    return (
      <ListingWorkspace
        route={listingRoute}
        state={props.listingState}
        controller={props.controller}
        listingController={props.listingController}
        creating={props.listingCreating}
        providerId={props.listingProviderId}
        baseVersion={props.listingBaseVersion}
        onSelectProvider={props.onSelectListingProvider}
        onStartCreate={props.onStartListingCreate}
        onCancelCreate={props.onCancelListingCreate}
        onSelectBaseVersion={props.onSelectListingBaseVersion}
        onOpenListing={props.onOpenListing}
        onNavigate={props.onNavigate}
      />
    );
  }

  switch (props.path) {
    case "/app/agents":
      return (
        <AgentPanel
          state={state}
          role={props.currentOrganization.role}
          controller={props.controller}
          writeController={props.writeController}
          organizationId={props.selectedId}
          machineController={props.machineController}
          machineState={props.machineState}
          machineList={props.machineList}
          onSelectProfile={props.onSelectProfile}
          machineEnabled={props.machineEnabled}
        />
      );
    case "/app/provider":
      return (
        <ProviderPanel
          state={state}
          role={props.currentOrganization.role}
          controller={props.controller}
          writeController={props.writeController}
          organizationId={props.selectedId}
          machineController={props.machineController}
          machineState={props.machineState}
          machineList={props.machineList}
          onSelectProfile={props.onSelectProfile}
          machineEnabled={props.machineEnabled}
        />
      );
    default:
      return (
        <Overview
          state={state}
          currentOrganization={props.currentOrganization}
          writeController={props.writeController}
          organizationId={props.selectedId}
        />
      );
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
  writeController: TenantWriteController | null;
  organizationId: string;
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
      {currentOrganization.role === "owner" ? (
        <TenantMutationPanel
          controller={props.writeController}
          role={currentOrganization.role}
          organizationId={props.organizationId}
        />
      ) : null}
    </section>
  );
}

function AgentPanel(props: {
  state: TenantViewControllerState;
  role: CommerceHumanRole;
  controller: TenantController | null;
  writeController: TenantWriteController | null;
  organizationId: string;
  machineController: MachineCredentialController | null;
  machineState: MachineConsoleState;
  machineList: MachineCredentialListState;
  onSelectProfile: (target: MachineCredentialTarget | null) => void;
  machineEnabled: boolean;
}) {
  if (!canReadAgents(props.role)) return <RoleNotAllowed role={props.role} action="agents" />;
  const { agents } = props.state;
  const selected = props.machineList.target;
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
      {agents.items.length > 0 ? (
        <ProfileTable
          kind="agent"
          items={agents.items}
          machineEnabled={props.machineEnabled && (props.role === "owner" || props.role === "operator")}
          selectedProfileId={selected?.kind === "agent" ? selected.profileId : null}
          onSelectProfile={(profileId) =>
            props.onSelectProfile(
              profileId === null ? null : { kind: "agent", profileId },
            )
          }
        />
      ) : null}
      <Pagination
        status={agents.status}
        hasNext={agents.nextCursor !== null}
        hasPrevious={agents.hasPrevious}
        onNext={() => void props.controller?.loadNextAgents()}
        onFirst={() => void props.controller?.loadAgents()}
      />
      {props.machineEnabled &&
      selected?.kind === "agent" &&
      props.machineController !== null &&
      (props.role === "owner" || props.role === "operator") ? (
        <MachineCredentialPanel
          controller={props.machineController}
          role={props.role}
          target={selected}
          credentials={props.machineList}
        />
      ) : null}
      {props.role === "owner" || props.role === "operator" ? (
        <TenantMutationPanel
          controller={props.writeController}
          role={props.role}
          organizationId={props.organizationId}
        />
      ) : null}
    </section>
  );
}

function ProviderPanel(props: {
  state: TenantViewControllerState;
  role: CommerceHumanRole;
  controller: TenantController | null;
  writeController: TenantWriteController | null;
  organizationId: string;
  machineController: MachineCredentialController | null;
  machineState: MachineConsoleState;
  machineList: MachineCredentialListState;
  onSelectProfile: (target: MachineCredentialTarget | null) => void;
  machineEnabled: boolean;
}) {
  if (!canReadProviders(props.role)) return <RoleNotAllowed role={props.role} action="providers" />;
  const { providers } = props.state;
  const selected = props.machineList.target;
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
      {providers.items.length > 0 ? (
        <ProfileTable
          kind="provider"
          items={providers.items}
          machineEnabled={props.machineEnabled && props.role === "owner"}
          selectedProfileId={selected?.kind === "provider" ? selected.profileId : null}
          onSelectProfile={(profileId) =>
            props.onSelectProfile(
              profileId === null ? null : { kind: "provider", profileId },
            )
          }
        />
      ) : null}
      <Pagination
        status={providers.status}
        hasNext={providers.nextCursor !== null}
        hasPrevious={providers.hasPrevious}
        onNext={() => void props.controller?.loadNextProviders()}
        onFirst={() => void props.controller?.loadProviders()}
      />
      {props.machineEnabled &&
      selected?.kind === "provider" &&
      props.machineController !== null &&
      props.role === "owner" ? (
        <MachineCredentialPanel
          controller={props.machineController}
          role={props.role}
          target={selected}
          credentials={props.machineList}
        />
      ) : null}
      {props.role === "owner" ? (
        <TenantMutationPanel
          controller={props.writeController}
          role={props.role}
          organizationId={props.organizationId}
        />
      ) : null}
    </section>
  );
}

type ProfileItems = TenantViewControllerState["agents"]["items"] | TenantViewControllerState["providers"]["items"];

function ProfileTable(props: {
  kind: "agent" | "provider";
  items: ProfileItems;
  machineEnabled: boolean;
  selectedProfileId: string | null;
  onSelectProfile: (profileId: string | null) => void;
}) {
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
            {props.machineEnabled ? <th scope="col">Credentials</th> : null}
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
                {props.machineEnabled ? (
                  <td>
                    {props.selectedProfileId === id ? (
                      <button
                        type="button"
                        className="tenant-button tenant-button--primary"
                        aria-pressed="true"
                        onClick={() => props.onSelectProfile(null)}
                      >
                        Close credentials
                      </button>
                    ) : (
                      <button
                        type="button"
                        className="tenant-button"
                        aria-pressed="false"
                        onClick={() => props.onSelectProfile(id)}
                      >
                        Manage credentials
                      </button>
                    )}
                  </td>
                ) : null}
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

/**
 * Protected listing workspace. The independent capability gate is rendered
 * honestly: `checking` is a status, `unavailable` is never fake empty data.
 */
function ListingWorkspace(props: {
  route: ListingRoute;
  state: ListingControllerState;
  controller: TenantController | null;
  listingController: ListingController | null;
  creating: boolean;
  providerId: string | null;
  baseVersion: CommerceListingOwnerVersion | null;
  onSelectProvider: (providerId: string) => void;
  onStartCreate: () => void;
  onCancelCreate: () => void;
  onSelectBaseVersion: (version: CommerceListingOwnerVersion) => void;
  onOpenListing: (listingId: string) => void;
  onNavigate: (path: AppPath) => void;
}) {
  const controller = props.listingController;
  if (props.state.capability === "unknown" || props.state.capability === "checking") {
    return <p className="tenant-status" role="status">Checking listing availability…</p>;
  }
  if (props.state.capability === "unavailable") {
    return (
      <section aria-labelledby="listing-unavailable-title">
        <p className="tenant-eyebrow">LISTINGS</p>
        <h1 className="tenant-title" id="listing-unavailable-title">
          Listing management is not available in this deployment
        </h1>
        <p className="tenant-status tenant-status--warning" role="status">
          The marketplace capability manifest does not enable listing management here. No listing
          request was made and no empty catalogue is implied.
        </p>
      </section>
    );
  }
  return (
    <div className="tenant-listings">
      <p className="tenant-eyebrow">PROVIDER LISTINGS</p>
      <h1 className="tenant-title">Listings</h1>
      <p className="tenant-status" role="status">
        {props.state.canWrite
          ? "You can create and manage listings. Every write requires an explicit confirmation and is server-authorized."
          : "Your role is read-only here. Only owner, provider admin and provider developer roles can write."}
      </p>
      <ListingMutationStatusView state={props.state.mutation} controller={controller} />
      {props.route.kind === "roots" || props.route.kind === "new" ? (
        <ListingListPanel
          state={props.state}
          creating={props.creating || props.route.kind === "new"}
          selectedProviderId={props.providerId}
          onSelectProvider={props.onSelectProvider}
          onStartCreate={props.onStartCreate}
          onCancelCreate={props.onCancelCreate}
          onLoadRoots={() => void controller?.loadRoots()}
          onNextRoots={() => void controller?.loadNextRoots()}
          onLoadMoreProviders={() => void controller?.loadNextProviderOptions()}
          onSubmitDraft={(providerId, content) => controller?.beginCreateDraft(providerId, content)}
          onOpenListing={props.onOpenListing}
        />
      ) : (
        <ListingDetailView
          state={props.state}
          controller={controller}
          baseVersion={props.baseVersion}
          onSelectBaseVersion={props.onSelectBaseVersion}
        />
      )}
    </div>
  );
}

function ListingMutationStatusView(props: {
  state: ListingControllerState["mutation"];
  controller: ListingController | null;
}) {
  const mutation = props.state;
  if (mutation.kind === "idle") return null;
  if (mutation.kind === "confirming") {
    const draft = mutation.draft;
    if (draft.op === "publish" || draft.op === "pause" || draft.op === "retire") {
      const heading =
        draft.op === "publish"
          ? `Publish version ${draft.version}`
          : draft.op === "pause"
            ? `Pause version ${draft.version}`
            : `Retire version ${draft.version}`;
      return (
        <section className="tenant-listings__disclosure" aria-labelledby="listing-lifecycle-confirm-title">
          <h3 className="tenant-title tenant-title--small" id="listing-lifecycle-confirm-title">
            {heading}
          </h3>
          <p className="tenant-status">
            {draft.op === "publish"
              ? "Publishing makes the title, description, provider name, fixed price, terms revision and privacy summary public. The protected endpoint path is NOT disclosed. Publishing atomically pauses the prior active version; origin review approval remains a manual moderation step and is never self-service."
              : draft.op === "pause"
                ? "Pausing removes the active pointer. Buyers can no longer purchase this version until another is published."
                : "Retiring is terminal. This version cannot be reactivated."}
          </p>
          <p className="tenant-mono">
            version {draft.version} · expectedUpdatedAt {draft.expectedUpdatedAt} · expectedActiveVersion{" "}
            {draft.expectedActiveVersion ?? "null"}
          </p>
          <div className="tenant-actions">
            <button
              type="button"
              className="tenant-button tenant-button--primary"
              onClick={() => void props.controller?.confirm()}
            >
              Confirm {draft.op}
            </button>
            <button type="button" className="tenant-button" onClick={() => props.controller?.cancel()}>
              Cancel
            </button>
          </div>
        </section>
      );
    }
    return (
      <section className="tenant-listings__disclosure" aria-labelledby="listing-confirm-title">
        <h3 className="tenant-title tenant-title--small" id="listing-confirm-title">
          Confirm this write
        </h3>
        <p className="tenant-status">
          One explicit confirmation sends exactly one logical write with a fresh mutation id and an
          idempotency key held in memory only. There is no automatic retry.
        </p>
        <p className="tenant-mono">operation {mutation.draft.op}</p>
        <div className="tenant-actions">
          <button
            type="button"
            className="tenant-button tenant-button--primary"
            onClick={() => void props.controller?.confirm()}
          >
            Confirm write
          </button>
          <button type="button" className="tenant-button" onClick={() => props.controller?.cancel()}>
            Cancel
          </button>
        </div>
      </section>
    );
  }
  if (mutation.kind === "pending") {
    return <p className="tenant-status" role="status">Sending the confirmed write…</p>;
  }
  if (mutation.kind === "committed") {
    return (
      <p className="tenant-status" role="status">
        Committed operation {mutation.receipt.operation}
        {mutation.resourceVersion === null ? "" : ` (resource version ${mutation.resourceVersion})`}.
        {mutation.refreshError ? " The follow-up refresh failed; the committed receipt stands." : ""}
      </p>
    );
  }
  if (mutation.kind === "rejected") {
    const notice = mutation.notice;
    return (
      <p className="tenant-status tenant-status--error" role="alert">
        {notice.kind === "conflict"
          ? "A conflict was detected. Review the latest state and confirm explicitly again; no automatic retry was performed."
          : notice.kind === "forbidden"
            ? "Your role cannot perform this write."
            : notice.kind === "unauthenticated"
              ? "Your session needs re-authentication before this write."
              : notice.kind === "csrf"
                ? "The request origin or anti-forgery token was rejected."
                : notice.kind === "not-found"
                  ? "The target no longer exists."
                  : notice.kind === "account-changed"
                    ? "The account changed during the write; nothing was applied to the new account."
                    : notice.kind === "capability-disabled"
                      ? "Listing management is not enabled."
                      : "The write was rejected. Review the values and confirm explicitly again."}
      </p>
    );
  }
  return (
    <section aria-labelledby="listing-unknown-title">
      <h3 className="tenant-title tenant-title--small" id="listing-unknown-title">
        The write outcome is unknown
      </h3>
      <p className="tenant-status tenant-status--warning" role="status">
        {mutation.statusMessage ??
          "The write may have committed. Only an explicit status check with the original mutation id can resolve it."}
      </p>
      <div className="tenant-actions">
        <button
          type="button"
          className="tenant-button"
          disabled={mutation.checking}
          onClick={() => void props.controller?.checkStatus()}
        >
          Check status
        </button>
      </div>
    </section>
  );
}

function ListingDetailView(props: {
  state: ListingControllerState;
  controller: ListingController | null;
  baseVersion: CommerceListingOwnerVersion | null;
  onSelectBaseVersion: (version: CommerceListingOwnerVersion) => void;
}) {
  const detail = props.state.detail;
  const controller = props.controller;
  if (detail.status === "loading" || detail.status === "none") {
    return <p className="tenant-status" role="status">Loading listing detail…</p>;
  }
  if (detail.status === "not-found") {
    return (
      <p className="tenant-status tenant-status--warning" role="status">
        This listing was not found. No empty or fabricated listing is shown.
      </p>
    );
  }
  if (detail.status === "error") {
    return (
      <p className="tenant-status tenant-status--error" role="alert">
        The listing detail could not be loaded.
      </p>
    );
  }
  const root = detail.root;
  if (root === null) return null;
  const historyComplete = detail.history.historyComplete;
  const selected = props.baseVersion;
  return (
    <>
      <section aria-labelledby="listing-root-title">
        <h2 className="tenant-title tenant-title--small" id="listing-root-title">
          Listing {root.listingId}
        </h2>
        <dl className="tenant-meta">
          <dt>Provider</dt>
          <dd className="tenant-mono">{root.providerId}</dd>
          <dt>Active version</dt>
          <dd className="tenant-mono">{root.activeVersion ?? "none"}</dd>
          <dt>Updated</dt>
          <dd className="tenant-mono">{root.updatedAt}</dd>
        </dl>
      </section>
      <ListingVersionHistory
        history={detail.history}
        selectedVersion={selected}
        onLoadMore={() => void controller?.loadMoreVersions()}
        onSelect={props.onSelectBaseVersion}
      />
      {!historyComplete ? (
        <p className="tenant-status tenant-status--warning" role="status">
          Create version is disabled while the version history is incomplete.
        </p>
      ) : null}
      {historyComplete && selected !== null ? (
        <>
          <ListingLifecycleActions
            version={selected}
            activeVersion={root.activeVersion}
            canWrite={props.state.canWrite}
            onPublish={() => controller?.beginLifecycle("publish", selected)}
            onPause={() => controller?.beginLifecycle("pause", selected)}
            onRetire={() => controller?.beginLifecycle("retire", selected)}
          />
          <ListingEditorPanel
            mode="create-version"
            providerOptions={[]}
            providerOptionsStatus="ready"
            selectedProviderId={null}
            onSelectProvider={() => undefined}
            prefill={props.state.selection.prefill}
            baseVersion={selected}
            canWrite={props.state.canWrite}
            onSubmitDraft={() => undefined}
            onSubmitVersion={(content) => controller?.beginCreateVersion(content)}
            onCancel={() => controller?.cancel()}
            onLoadMoreProviders={() => undefined}
            hasNextProviders={false}
          />
        </>
      ) : null}
    </>
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

/**
 * Reads the addressed profile's status from the bounded read controller so an
 * issue for an inactive (suspended/revoked/retired) profile is refused before
 * any request. An unknown profile is treated as inactive.
 */
function profileIsActive(
  controller: TenantController,
  kind: "agent" | "provider",
  profileId: string,
): boolean {
  const state = controller.state;
  if (kind === "agent") {
    return state.agents.items.some(
      (item) => item.agentId === profileId && item.status === "active",
    );
  }
  return state.providers.items.some(
    (item) => item.providerId === profileId && item.status === "active",
  );
}

export type { TenantFetch };
