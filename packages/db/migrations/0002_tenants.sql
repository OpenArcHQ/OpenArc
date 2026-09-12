-- OpenArc tenant foundation (schema2).
--
-- Owner: openarc_migrator. Runtime: openarc_tenant_app (pre-provisioned by
-- deployment; this migration NEVER creates roles). The runtime role is
-- deliberately restricted: no superuser, no createdb/createrole, no bypassrls.
--
-- Security model: authentication stays server-owned. The SECURITY DEFINER
-- bridge functions below are the only path for the tenant runtime to resolve a
-- live session; every policy uses transaction-local context
-- (openarc.account_id, openarc.organization_id, openarc.role). Missing or
-- empty context denies reads and writes. Context is trusted server state set
-- only by the repository/bridge, not an independently signed credential.

CREATE SCHEMA IF NOT EXISTS openarc_tenant AUTHORIZATION openarc_migrator;
ALTER SCHEMA openarc_tenant OWNER TO openarc_migrator;
REVOKE ALL ON SCHEMA openarc_tenant FROM PUBLIC;
GRANT USAGE ON SCHEMA openarc_tenant TO openarc_tenant_app;

-- Narrow migration-metadata read for tenant readiness; do not widen 0001.
GRANT USAGE ON SCHEMA openarc_meta TO openarc_tenant_app;
GRANT SELECT ON openarc_meta.schema_migrations TO openarc_tenant_app;

-- Tenant runtime may still need the auth schema usage for the definer bridge
-- to be resolvable, but receives no table privileges there.
GRANT USAGE ON SCHEMA openarc_auth TO openarc_tenant_app;

CREATE TABLE openarc_tenant.organizations (
  organization_id text PRIMARY KEY,
  display_name text NOT NULL,
  created_by text NOT NULL REFERENCES openarc_auth.accounts(account_id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT organizations_id_format CHECK (
    organization_id ~ '^openarc:org:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  ),
  CONSTRAINT organizations_display_name_valid CHECK (
    char_length(display_name) BETWEEN 1 AND 100
    AND display_name !~ '^[[:space:]]'
    AND display_name !~ '[[:space:]]$'
    AND display_name !~ E'[\u0001-\u001f\u007f-\u009f]'
  ),
  CONSTRAINT organizations_timestamps_valid CHECK (updated_at >= created_at)
);

CREATE TABLE openarc_tenant.memberships (
  organization_id text NOT NULL REFERENCES openarc_tenant.organizations(organization_id) ON DELETE RESTRICT,
  account_id text NOT NULL REFERENCES openarc_auth.accounts(account_id) ON DELETE RESTRICT,
  role text NOT NULL,
  status text NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (organization_id, account_id),
  CONSTRAINT memberships_role_valid CHECK (
    role IN ('owner', 'operator', 'provider_admin', 'provider_developer', 'viewer')
  ),
  CONSTRAINT memberships_status_valid CHECK (status IN ('active', 'suspended')),
  CONSTRAINT memberships_timestamps_valid CHECK (updated_at >= created_at)
);

CREATE TABLE openarc_tenant.agents (
  organization_id text NOT NULL REFERENCES openarc_tenant.organizations(organization_id) ON DELETE RESTRICT,
  agent_id text NOT NULL UNIQUE,
  display_name text NOT NULL,
  status text NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (organization_id, agent_id),
  CONSTRAINT agents_id_format CHECK (
    agent_id ~ '^openarc:agent:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  ),
  CONSTRAINT agents_display_name_valid CHECK (
    char_length(display_name) BETWEEN 1 AND 100
    AND display_name !~ '^[[:space:]]'
    AND display_name !~ '[[:space:]]$'
    AND display_name !~ E'[\u0001-\u001f\u007f-\u009f]'
  ),
  CONSTRAINT agents_status_valid CHECK (status IN ('active', 'suspended', 'revoked')),
  CONSTRAINT agents_timestamps_valid CHECK (updated_at >= created_at)
);

CREATE TABLE openarc_tenant.providers (
  organization_id text NOT NULL REFERENCES openarc_tenant.organizations(organization_id) ON DELETE RESTRICT,
  provider_id text NOT NULL UNIQUE,
  display_name text NOT NULL,
  status text NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (organization_id, provider_id),
  CONSTRAINT providers_id_format CHECK (
    provider_id ~ '^openarc:provider:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  ),
  CONSTRAINT providers_display_name_valid CHECK (
    char_length(display_name) BETWEEN 1 AND 100
    AND display_name !~ '^[[:space:]]'
    AND display_name !~ '[[:space:]]$'
    AND display_name !~ E'[\u0001-\u001f\u007f-\u009f]'
  ),
  CONSTRAINT providers_status_valid CHECK (status IN ('active', 'suspended', 'retired')),
  CONSTRAINT providers_timestamps_valid CHECK (updated_at >= created_at)
);

CREATE INDEX memberships_account_id_idx ON openarc_tenant.memberships (account_id);
CREATE INDEX agents_organization_id_idx ON openarc_tenant.agents (organization_id);
CREATE INDEX providers_organization_id_idx ON openarc_tenant.providers (organization_id);

-- Ownership is immutable: no cross-org move and no resurrection of terminal
-- profile states. These triggers are the last line behind the repository and
-- RLS WITH CHECK.
CREATE FUNCTION openarc_tenant.reject_ownership_change() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  IF NEW.organization_id IS DISTINCT FROM OLD.organization_id THEN
    RAISE EXCEPTION 'tenant_ownership_immutable' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION openarc_tenant.enforce_agent_status_transition() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  IF OLD.status = 'revoked' AND NEW.status <> 'revoked' THEN
    RAISE EXCEPTION 'tenant_agent_terminal' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION openarc_tenant.enforce_provider_status_transition() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  IF OLD.status = 'retired' AND NEW.status <> 'retired' THEN
    RAISE EXCEPTION 'tenant_provider_terminal' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER agents_ownership_immutable BEFORE UPDATE ON openarc_tenant.agents
  FOR EACH ROW EXECUTE FUNCTION openarc_tenant.reject_ownership_change();
CREATE TRIGGER providers_ownership_immutable BEFORE UPDATE ON openarc_tenant.providers
  FOR EACH ROW EXECUTE FUNCTION openarc_tenant.reject_ownership_change();
CREATE TRIGGER agents_status_transition BEFORE UPDATE ON openarc_tenant.agents
  FOR EACH ROW EXECUTE FUNCTION openarc_tenant.enforce_agent_status_transition();
CREATE TRIGGER providers_status_transition BEFORE UPDATE ON openarc_tenant.providers
  FOR EACH ROW EXECUTE FUNCTION openarc_tenant.enforce_provider_status_transition();

-- Bridge: resolve + lock a live, active-account session. Ordered locks only:
-- the actor account (discovered without a lock), then any caller-supplied
-- additional account IDs sorted ascending, then the session row rechecked
-- against the database clock AFTER any wait. Only the internal 64-hex hash is
-- accepted and never returned.
CREATE FUNCTION openarc_tenant.lock_auth_session(
  session_hash text,
  additional_account_id text DEFAULT NULL
) RETURNS TABLE(
  account_id text,
  method text,
  session_created_at timestamptz,
  session_expires_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
#variable_conflict use_variable
DECLARE
  v_actor text;
  v_lock_set text[];
  v_id text;
  v_row record;
  v_now timestamptz;
BEGIN
  IF session_hash IS NULL OR session_hash !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'tenant_session_invalid' USING ERRCODE = '28000';
  END IF;

  SELECT s.account_id INTO v_actor
    FROM openarc_auth.sessions s
   WHERE s.token_hash = session_hash;
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'tenant_session_invalid' USING ERRCODE = '28000';
  END IF;

  v_lock_set := ARRAY[v_actor];
  IF additional_account_id IS NOT NULL THEN
    IF additional_account_id = '' OR char_length(additional_account_id) > 200 THEN
      RAISE EXCEPTION 'tenant_account_invalid' USING ERRCODE = '22023';
    END IF;
    v_lock_set := v_lock_set || additional_account_id;
  END IF;
  SELECT array_agg(DISTINCT x ORDER BY x) INTO v_lock_set FROM unnest(v_lock_set) AS x;

  FOREACH v_id IN ARRAY v_lock_set LOOP
    PERFORM 1 FROM openarc_auth.accounts a WHERE a.account_id = v_id FOR UPDATE;
  END LOOP;

  SELECT s.account_id, s.method, s.created_at, s.expires_at
    INTO v_row
    FROM openarc_auth.sessions s
    JOIN openarc_auth.accounts a ON a.account_id = s.account_id
   WHERE s.token_hash = session_hash
     AND s.account_id = v_actor
     AND a.status = 'active'
     AND s.expires_at > clock_timestamp()
   FOR UPDATE OF s;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'tenant_session_invalid' USING ERRCODE = '28000';
  END IF;

  -- Re-read the DB clock after the session lock wait and recheck explicitly.
  SELECT clock_timestamp() INTO v_now;
  IF NOT (v_row.expires_at > v_now) THEN
    RAISE EXCEPTION 'tenant_session_invalid' USING ERRCODE = '28000';
  END IF;

  account_id := v_row.account_id;
  method := v_row.method;
  session_created_at := v_row.created_at;
  session_expires_at := v_row.expires_at;
  RETURN NEXT;
END;
$$;

-- Bootstrap enumeration: ONLY the authenticated account's own active
-- membership organization IDs, stable and bounded to 100. Validates the
-- caller itself (lock order included) and never exposes another account.
CREATE FUNCTION openarc_tenant.list_account_organization_ids(
  session_hash text,
  after_organization_id text DEFAULT NULL,
  page_size integer DEFAULT 50
) RETURNS TABLE(organization_id text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
#variable_conflict use_variable
DECLARE
  v_actor text;
  v_now timestamptz;
  v_limit integer;
  v_row record;
BEGIN
  IF page_size IS NULL OR page_size < 1 OR page_size > 100 THEN
    RAISE EXCEPTION 'tenant_page_invalid' USING ERRCODE = '22023';
  END IF;
  IF after_organization_id IS NOT NULL
     AND after_organization_id !~ '^openarc:org:[0-9a-f-]{36}$' THEN
    RAISE EXCEPTION 'tenant_page_invalid' USING ERRCODE = '22023';
  END IF;

  SELECT s.account_id INTO v_actor
    FROM openarc_auth.sessions s
   WHERE s.token_hash = session_hash;
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'tenant_session_invalid' USING ERRCODE = '28000';
  END IF;
  PERFORM 1 FROM openarc_auth.accounts a WHERE a.account_id = v_actor FOR UPDATE;
  SELECT s.account_id, s.expires_at INTO v_row
    FROM openarc_auth.sessions s
    JOIN openarc_auth.accounts a ON a.account_id = s.account_id
   WHERE s.token_hash = session_hash
     AND s.account_id = v_actor
     AND a.status = 'active'
     AND s.expires_at > clock_timestamp()
   FOR UPDATE OF s;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'tenant_session_invalid' USING ERRCODE = '28000';
  END IF;
  SELECT clock_timestamp() INTO v_now;
  IF NOT (v_row.expires_at > v_now) THEN
    RAISE EXCEPTION 'tenant_session_invalid' USING ERRCODE = '28000';
  END IF;

  PERFORM set_config('openarc.account_id', v_actor, true);
  v_limit := page_size;
  RETURN QUERY
    SELECT m.organization_id
      FROM openarc_tenant.memberships m
     WHERE m.account_id = v_actor
       AND m.status = 'active'
       AND (after_organization_id IS NULL OR m.organization_id > after_organization_id)
     ORDER BY m.organization_id
     LIMIT v_limit;
END;
$$;

-- Membership mutation + revocation helper. Fresh proof required (<=5 minutes,
-- passkey/wallet only), owner-only, target must be an existing active account.
-- Lock order: sorted account IDs -> session -> organization -> memberships.
-- Maintains at least one active owner under parallel owner demotion/suspension
-- and only revokes the target account's sessions/challenges on an actual
-- role/status change. Exposes only this one operation, never arbitrary revoke.
CREATE FUNCTION openarc_tenant.set_membership(
  session_hash text,
  organization_id text,
  target_account_id text,
  requested_role text,
  requested_status text
) RETURNS TABLE(
  out_organization_id text,
  out_account_id text,
  out_role text,
  out_status text,
  out_created_at timestamptz,
  out_updated_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
#variable_conflict use_variable
DECLARE
  v_actor text;
  v_lock_set text[];
  v_id text;
  v_session record;
  v_now timestamptz;
  v_caller_role text;
  v_caller_status text;
  v_target_status text;
  v_existing record;
  v_changed boolean;
  v_active_owners integer;
BEGIN
  IF session_hash IS NULL OR session_hash !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'tenant_session_invalid' USING ERRCODE = '28000';
  END IF;
  IF organization_id IS NULL OR organization_id !~ '^openarc:org:[0-9a-f-]{36}$' THEN
    RAISE EXCEPTION 'tenant_organization_invalid' USING ERRCODE = '22023';
  END IF;
  IF target_account_id IS NULL OR target_account_id = '' OR char_length(target_account_id) > 200 THEN
    RAISE EXCEPTION 'tenant_account_invalid' USING ERRCODE = '22023';
  END IF;
  IF requested_role IS NULL OR requested_role NOT IN
     ('owner', 'operator', 'provider_admin', 'provider_developer', 'viewer') THEN
    RAISE EXCEPTION 'tenant_role_invalid' USING ERRCODE = '22023';
  END IF;
  IF requested_status IS NULL OR requested_status NOT IN ('active', 'suspended') THEN
    RAISE EXCEPTION 'tenant_status_invalid' USING ERRCODE = '22023';
  END IF;

  SELECT s.account_id INTO v_actor FROM openarc_auth.sessions s WHERE s.token_hash = session_hash;
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'tenant_session_invalid' USING ERRCODE = '28000';
  END IF;

  v_lock_set := ARRAY[v_actor, target_account_id];
  SELECT array_agg(DISTINCT x ORDER BY x) INTO v_lock_set FROM unnest(v_lock_set) AS x;
  FOREACH v_id IN ARRAY v_lock_set LOOP
    PERFORM 1 FROM openarc_auth.accounts a WHERE a.account_id = v_id FOR UPDATE;
  END LOOP;

  SELECT s.account_id, s.method, s.created_at, s.expires_at INTO v_session
    FROM openarc_auth.sessions s
    JOIN openarc_auth.accounts a ON a.account_id = s.account_id
   WHERE s.token_hash = session_hash
     AND s.account_id = v_actor
     AND a.status = 'active'
     AND s.expires_at > clock_timestamp()
   FOR UPDATE OF s;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'tenant_session_invalid' USING ERRCODE = '28000';
  END IF;
  IF v_session.method = 'recovery' THEN
    RAISE EXCEPTION 'tenant_session_invalid' USING ERRCODE = '28000';
  END IF;

  -- Provisional self-row lookup establishes context only to fail early before
  -- any row lock. Expiry and proof freshness are deliberately NOT trusted here.
  PERFORM set_config('openarc.account_id', v_actor, true);
  PERFORM set_config('openarc.organization_id', organization_id, true);
  SELECT m.role, m.status INTO v_caller_role, v_caller_status
    FROM openarc_tenant.memberships m
   WHERE m.organization_id = organization_id AND m.account_id = v_actor;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'tenant_forbidden' USING ERRCODE = '42501';
  END IF;

  -- Fixed global lock order: sorted accounts (above) -> session (above) ->
  -- organization ROW lock -> membership ROW locks -> profiles. The
  -- organization row is the single serialization point shared with
  -- lock_organization_access; no advisory lock is involved.
  PERFORM 1 FROM openarc_tenant.organizations o
   WHERE o.organization_id = organization_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'tenant_forbidden' USING ERRCODE = '42501';
  END IF;

  -- Caller membership row lock after the organization row.
  SELECT m.role, m.status INTO v_caller_role, v_caller_status
    FROM openarc_tenant.memberships m
   WHERE m.organization_id = organization_id AND m.account_id = v_actor
   FOR UPDATE;
  IF NOT FOUND OR v_caller_status <> 'active' OR v_caller_role <> 'owner' THEN
    RAISE EXCEPTION 'tenant_forbidden' USING ERRCODE = '42501';
  END IF;
  PERFORM set_config('openarc.role', 'owner', true);

  -- Target membership row lock before the target profile read.
  SELECT m.role, m.status INTO v_existing
    FROM openarc_tenant.memberships m
   WHERE m.organization_id = organization_id AND m.account_id = target_account_id
   FOR UPDATE;

  -- Recheck account/session/membership against the DATABASE clock after every
  -- potentially blocking lock and immediately before any mutation. Expiry and
  -- passkey/wallet proof freshness are re-evaluated here, so a transaction
  -- that waited past the five-minute boundary cannot mutate on a stale proof.
  SELECT s.account_id, s.method, s.created_at, s.expires_at INTO v_session
    FROM openarc_auth.sessions s
    JOIN openarc_auth.accounts a ON a.account_id = s.account_id
   WHERE s.token_hash = session_hash
     AND s.account_id = v_actor
     AND a.status = 'active'
     AND s.expires_at > clock_timestamp()
   FOR UPDATE OF s;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'tenant_session_invalid' USING ERRCODE = '28000';
  END IF;
  SELECT clock_timestamp() INTO v_now;
  IF NOT (v_session.expires_at > v_now) THEN
    RAISE EXCEPTION 'tenant_session_invalid' USING ERRCODE = '28000';
  END IF;
  IF NOT (v_session.created_at > v_now - interval '5 minutes') THEN
    RAISE EXCEPTION 'tenant_proof_stale' USING ERRCODE = '28000';
  END IF;

  SELECT a.status INTO v_target_status FROM openarc_auth.accounts a
   WHERE a.account_id = target_account_id;
  IF v_target_status IS NULL THEN
    RAISE EXCEPTION 'tenant_account_missing' USING ERRCODE = '23503';
  END IF;
  IF v_target_status <> 'active' THEN
    RAISE EXCEPTION 'tenant_account_disabled' USING ERRCODE = '28000';
  END IF;

  IF v_existing IS NULL THEN
    IF requested_status <> 'active' THEN
      RAISE EXCEPTION 'tenant_status_invalid' USING ERRCODE = '22023';
    END IF;
    INSERT INTO openarc_tenant.memberships (organization_id, account_id, role, status)
    VALUES (organization_id, target_account_id, requested_role, requested_status);
    v_changed := true;
  ELSE
    v_changed := (v_existing.role IS DISTINCT FROM requested_role)
              OR (v_existing.status IS DISTINCT FROM requested_status);
    IF v_changed THEN
      IF NOT (v_existing.role = 'owner' AND v_existing.status = 'active')
         AND requested_status = 'active' THEN
        NULL;
      END IF;
      UPDATE openarc_tenant.memberships m
         SET role = requested_role,
             status = requested_status,
             updated_at = clock_timestamp()
       WHERE m.organization_id = organization_id AND m.account_id = target_account_id;
    END IF;
  END IF;

  -- Owner invariant: at least one active owner must remain. Locking the org
  -- first serializes competing owner-demotion/suspension attempts.
  SELECT count(*)::int INTO v_active_owners
    FROM openarc_tenant.memberships m
   WHERE m.organization_id = organization_id
     AND m.role = 'owner'
     AND m.status = 'active';
  IF v_active_owners < 1 THEN
    RAISE EXCEPTION 'tenant_last_owner' USING ERRCODE = '23505';
  END IF;

  IF v_changed THEN
    DELETE FROM openarc_auth.sessions s WHERE s.account_id = target_account_id;
    DELETE FROM openarc_auth.challenges c WHERE c.account_id = target_account_id;
  END IF;

  RETURN QUERY
    SELECT m.organization_id, m.account_id, m.role, m.status, m.created_at, m.updated_at
      FROM openarc_tenant.memberships m
     WHERE m.organization_id = organization_id AND m.account_id = target_account_id;
END;
$$;

-- Authorization + lock helper for the TenantStore consumer. Fixed global lock
-- order: live account -> session (via lock_auth_session) -> organization ROW
-- lock -> caller membership ROW lock -> profile reads. It shares the exact
-- organization row serialization point with set_membership (no advisory lock)
-- and rechecks session expiry plus the current active membership after all
-- waits before publishing transaction-local context. Returns only safe
-- organization+role metadata. SECURITY DEFINER is required solely because the
-- restricted runtime lacks the UPDATE privilege needed for SELECT ... FOR
-- UPDATE; no arbitrary context/callback surface is added.
CREATE FUNCTION openarc_tenant.lock_organization_access(
  session_hash text,
  organization_id text
) RETURNS TABLE(
  out_organization_id text,
  out_role text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
#variable_conflict use_variable
DECLARE
  v_actor text;
  v_role text;
  v_status text;
  v_recheck_actor text;
BEGIN
  IF organization_id IS NULL OR organization_id !~ '^openarc:org:[0-9a-f-]{36}$' THEN
    RAISE EXCEPTION 'tenant_organization_invalid' USING ERRCODE = '22023';
  END IF;

  SELECT l.account_id INTO v_actor
    FROM openarc_tenant.lock_auth_session(session_hash, NULL) AS l;
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'tenant_session_invalid' USING ERRCODE = '28000';
  END IF;

  PERFORM 1 FROM openarc_tenant.organizations o
   WHERE o.organization_id = organization_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'tenant_forbidden' USING ERRCODE = '42501';
  END IF;

  SELECT m.role, m.status INTO v_role, v_status
    FROM openarc_tenant.memberships m
   WHERE m.organization_id = organization_id AND m.account_id = v_actor
   FOR UPDATE;
  IF NOT FOUND OR v_status <> 'active'
     OR v_role NOT IN ('owner', 'operator', 'provider_admin', 'provider_developer', 'viewer') THEN
    RAISE EXCEPTION 'tenant_forbidden' USING ERRCODE = '42501';
  END IF;

  -- Re-resolve the live account+session after the organization and membership
  -- waits; lock_auth_session rechecks the DB clock and account status.
  SELECT l.account_id INTO v_recheck_actor
    FROM openarc_tenant.lock_auth_session(session_hash, NULL) AS l;
  IF v_recheck_actor IS NULL OR v_recheck_actor <> v_actor THEN
    RAISE EXCEPTION 'tenant_session_invalid' USING ERRCODE = '28000';
  END IF;

  -- The membership row stays locked for this transaction; re-read it after the
  -- waits to confirm the caller is still active before publishing context.
  SELECT m.role, m.status INTO v_role, v_status
    FROM openarc_tenant.memberships m
   WHERE m.organization_id = organization_id AND m.account_id = v_actor;
  IF NOT FOUND OR v_status <> 'active' THEN
    RAISE EXCEPTION 'tenant_forbidden' USING ERRCODE = '42501';
  END IF;

  PERFORM set_config('openarc.account_id', v_actor, true);
  PERFORM set_config('openarc.organization_id', organization_id, true);
  PERFORM set_config('openarc.role', v_role, true);

  out_organization_id := organization_id;
  out_role := v_role;
  RETURN NEXT;
END;
$$;

-- Frozen zero-argument access-kind predicate. Fixed pg_catalog search_path and
-- owned by the migrator: the SECURITY DEFINER body is evaluated with the
-- migrator-only SELECT policies below, never the runtime predicate policies, so
-- the organization and unfiltered membership reads cannot recurse. It returns
-- no rows or identifiers, only a narrow verdict derived from trusted
-- transaction-local context (SERVER-set GUC, not an independent credential).
--
--   * real role  -> the context account has an ACTIVE membership in the selected
--                   organization (the actual stored role).
--   * 'bootstrap' -> the selected organization was created by the context
--                    account in the CURRENT transaction AND still has ZERO
--                    membership rows. The first membership insertion ends this
--                    eligibility immediately, within the same transaction.
--   * NULL       -> everything else, including missing/invalid context,
--                   suspended membership, foreign organization and any creator
--                   whose organization already has members or is committed.
CREATE FUNCTION openarc_tenant.current_context_access_kind() RETURNS text
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
  SELECT CASE
    WHEN o.organization_id IS NULL THEN NULL
    WHEN m.role IS NOT NULL THEN m.role
    WHEN o.created_by = nullif(current_setting('openarc.account_id', true), '')
      AND o.xmin::text::bigint = txid_current()
      AND NOT EXISTS (
        SELECT 1 FROM openarc_tenant.memberships any_m
         WHERE any_m.organization_id = o.organization_id
      )
      THEN 'bootstrap'
    ELSE NULL
  END
  FROM (SELECT 1) AS anchor
  LEFT JOIN openarc_tenant.organizations o
    ON o.organization_id = nullif(current_setting('openarc.organization_id', true), '')
   AND o.organization_id ~ '^openarc:org:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  LEFT JOIN openarc_tenant.memberships m
    ON m.organization_id = o.organization_id
   AND m.account_id = nullif(current_setting('openarc.account_id', true), '')
   AND m.status = 'active';
$$;

-- Row level security. FORCE so the table owner is also subject; only explicit
-- transaction-local context, established by the bridge/repository, grants
-- access. Empty or missing context fails closed for reads and writes.
ALTER TABLE openarc_tenant.organizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE openarc_tenant.organizations FORCE ROW LEVEL SECURITY;
ALTER TABLE openarc_tenant.memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE openarc_tenant.memberships FORCE ROW LEVEL SECURITY;
ALTER TABLE openarc_tenant.agents ENABLE ROW LEVEL SECURITY;
ALTER TABLE openarc_tenant.agents FORCE ROW LEVEL SECURITY;
ALTER TABLE openarc_tenant.providers ENABLE ROW LEVEL SECURITY;
ALTER TABLE openarc_tenant.providers FORCE ROW LEVEL SECURITY;

-- Runtime membership reads: the selected organization is mandatory. A caller
-- may always read its OWN active row (the initial role lookup). An owner whose
-- trusted role GUC and the frozen predicate agree may enumerate every
-- membership in the selected organization, including suspended members.
-- Nonowners only see their own active row; missing selection, suspended and
-- absent callers see nothing.
CREATE POLICY memberships_select_app ON openarc_tenant.memberships
  FOR SELECT
  TO openarc_tenant_app
  USING (
    organization_id = nullif(current_setting('openarc.organization_id', true), '')
    AND organization_id <> ''
    AND (
      (
        account_id = nullif(current_setting('openarc.account_id', true), '')
        AND status = 'active'
      )
      OR (
        nullif(current_setting('openarc.role', true), '') = 'owner'
        AND openarc_tenant.current_context_access_kind() = 'owner'
      )
    )
  );

-- Migrator-only read policy. This is what makes the predicate body free of
-- recursion: definer reads never evaluate the runtime predicate policy above.
CREATE POLICY memberships_select_migrator ON openarc_tenant.memberships
  FOR SELECT
  TO openarc_migrator
  USING (true);

-- Bootstrap ONLY: an authenticated account may insert its own initial owner
-- membership into a newly created, still-empty organization it owns. The
-- predicate ends bootstrap eligibility on the first membership insertion, so
-- this can never re-enter after the organization gains members. Adding any
-- other account or touching an existing organization MUST go through
-- set_membership.
CREATE POLICY memberships_insert ON openarc_tenant.memberships
  FOR INSERT
  TO openarc_tenant_app
  WITH CHECK (
    organization_id = nullif(current_setting('openarc.organization_id', true), '')
    AND organization_id <> ''
    AND account_id = nullif(current_setting('openarc.account_id', true), '')
    AND role = 'owner'
    AND status = 'active'
    AND openarc_tenant.current_context_access_kind() = 'bootstrap'
  );

CREATE POLICY memberships_insert_migrator ON openarc_tenant.memberships
  FOR INSERT
  TO openarc_migrator
  WITH CHECK (true);

-- Membership changes are exclusively the definer-owned set_membership path.
-- The restricted runtime receives no UPDATE privilege; the owner's direct
-- write is denied by privileges and can never satisfy this policy.
CREATE POLICY memberships_update ON openarc_tenant.memberships
  FOR UPDATE
  USING (
    current_user = 'openarc_migrator'
  )
  WITH CHECK (
    current_user = 'openarc_migrator'
  );

-- Runtime organization reads require the selected organization and a predicate
-- verdict of either a real ACTIVE role or the narrowly true bootstrap state
-- (created by this account in this transaction with zero memberships). A
-- committed organization, an organization that already has members, or a
-- suspended creator can never be read through the bootstrap path.
CREATE POLICY organizations_select_app ON openarc_tenant.organizations
  FOR SELECT
  TO openarc_tenant_app
  USING (
    organization_id = nullif(current_setting('openarc.organization_id', true), '')
    AND organization_id <> ''
    AND openarc_tenant.current_context_access_kind() IS NOT NULL
  );

-- Migrator-only read policy for definer maintenance and the predicate body.
CREATE POLICY organizations_select_migrator ON openarc_tenant.organizations
  FOR SELECT
  TO openarc_migrator
  USING (true);

CREATE POLICY organizations_insert ON openarc_tenant.organizations
  FOR INSERT
  WITH CHECK (
    created_by = nullif(current_setting('openarc.account_id', true), '')
    AND organization_id = nullif(current_setting('openarc.organization_id', true), '')
  );

-- SELECT ... FOR UPDATE also evaluates the UPDATE policy. Only the definer
-- migration owner may take the organization row lock used as the shared
-- serialization point; the restricted runtime receives no UPDATE privilege.
CREATE POLICY organizations_update ON openarc_tenant.organizations
  FOR UPDATE
  USING (current_user = 'openarc_migrator')
  WITH CHECK (current_user = 'openarc_migrator');

CREATE POLICY agents_select ON openarc_tenant.agents
  FOR SELECT
  USING (
    organization_id = nullif(current_setting('openarc.organization_id', true), '')
    AND nullif(current_setting('openarc.role', true), '') IN ('owner', 'operator', 'viewer')
    AND EXISTS (
      SELECT 1 FROM openarc_tenant.memberships m
       WHERE m.organization_id = nullif(current_setting('openarc.organization_id', true), '')
         AND m.account_id = nullif(current_setting('openarc.account_id', true), '')
         AND m.status = 'active'
    )
  );

CREATE POLICY agents_insert ON openarc_tenant.agents
  FOR INSERT
  WITH CHECK (
    organization_id = nullif(current_setting('openarc.organization_id', true), '')
    AND nullif(current_setting('openarc.role', true), '') IN ('owner', 'operator')
    AND EXISTS (
      SELECT 1 FROM openarc_tenant.memberships m
       WHERE m.organization_id = nullif(current_setting('openarc.organization_id', true), '')
         AND m.account_id = nullif(current_setting('openarc.account_id', true), '')
         AND m.status = 'active'
    )
  );

CREATE POLICY agents_update ON openarc_tenant.agents
  FOR UPDATE
  USING (
    organization_id = nullif(current_setting('openarc.organization_id', true), '')
    AND nullif(current_setting('openarc.role', true), '') IN ('owner', 'operator')
    AND EXISTS (
      SELECT 1 FROM openarc_tenant.memberships m
       WHERE m.organization_id = nullif(current_setting('openarc.organization_id', true), '')
         AND m.account_id = nullif(current_setting('openarc.account_id', true), '')
         AND m.status = 'active'
    )
  )
  WITH CHECK (
    organization_id = nullif(current_setting('openarc.organization_id', true), '')
    AND nullif(current_setting('openarc.role', true), '') IN ('owner', 'operator')
    AND EXISTS (
      SELECT 1 FROM openarc_tenant.memberships m
       WHERE m.organization_id = nullif(current_setting('openarc.organization_id', true), '')
         AND m.account_id = nullif(current_setting('openarc.account_id', true), '')
         AND m.status = 'active'
    )
  );

CREATE POLICY providers_select ON openarc_tenant.providers
  FOR SELECT
  USING (
    organization_id = nullif(current_setting('openarc.organization_id', true), '')
    AND nullif(current_setting('openarc.role', true), '') = 'owner'
    AND EXISTS (
      SELECT 1 FROM openarc_tenant.memberships m
       WHERE m.organization_id = nullif(current_setting('openarc.organization_id', true), '')
         AND m.account_id = nullif(current_setting('openarc.account_id', true), '')
         AND m.status = 'active'
    )
  );

CREATE POLICY providers_insert ON openarc_tenant.providers
  FOR INSERT
  WITH CHECK (
    organization_id = nullif(current_setting('openarc.organization_id', true), '')
    AND nullif(current_setting('openarc.role', true), '') = 'owner'
    AND EXISTS (
      SELECT 1 FROM openarc_tenant.memberships m
       WHERE m.organization_id = nullif(current_setting('openarc.organization_id', true), '')
         AND m.account_id = nullif(current_setting('openarc.account_id', true), '')
         AND m.status = 'active'
    )
  );

CREATE POLICY providers_update ON openarc_tenant.providers
  FOR UPDATE
  USING (
    organization_id = nullif(current_setting('openarc.organization_id', true), '')
    AND nullif(current_setting('openarc.role', true), '') = 'owner'
    AND EXISTS (
      SELECT 1 FROM openarc_tenant.memberships m
       WHERE m.organization_id = nullif(current_setting('openarc.organization_id', true), '')
         AND m.account_id = nullif(current_setting('openarc.account_id', true), '')
         AND m.status = 'active'
    )
  )
  WITH CHECK (
    organization_id = nullif(current_setting('openarc.organization_id', true), '')
    AND nullif(current_setting('openarc.role', true), '') = 'owner'
    AND EXISTS (
      SELECT 1 FROM openarc_tenant.memberships m
       WHERE m.organization_id = nullif(current_setting('openarc.organization_id', true), '')
         AND m.account_id = nullif(current_setting('openarc.account_id', true), '')
         AND m.status = 'active'
    )
  );

-- Privileges: revoke PUBLIC everywhere; grant the tenant runtime only the
-- scoped table verbs it needs. No DELETE on any tenant table (history is
-- preserved by status) and no auth table privileges.
REVOKE ALL ON ALL TABLES IN SCHEMA openarc_tenant FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA openarc_tenant FROM PUBLIC;

GRANT SELECT ON openarc_tenant.organizations TO openarc_tenant_app;
GRANT INSERT ON openarc_tenant.organizations TO openarc_tenant_app;

-- No UPDATE on memberships: changes are exclusively the definer-owned
-- set_membership path. INSERT remains only for the narrow initial-owner
-- bootstrap enforced by the memberships_insert policy.
GRANT SELECT, INSERT ON openarc_tenant.memberships TO openarc_tenant_app;

GRANT SELECT, INSERT, UPDATE ON openarc_tenant.agents TO openarc_tenant_app;
GRANT SELECT, INSERT, UPDATE ON openarc_tenant.providers TO openarc_tenant_app;

GRANT EXECUTE ON FUNCTION openarc_tenant.lock_auth_session(text, text) TO openarc_tenant_app;
GRANT EXECUTE ON FUNCTION openarc_tenant.list_account_organization_ids(text, text, integer) TO openarc_tenant_app;
GRANT EXECUTE ON FUNCTION openarc_tenant.set_membership(text, text, text, text, text) TO openarc_tenant_app;
GRANT EXECUTE ON FUNCTION openarc_tenant.lock_organization_access(text, text) TO openarc_tenant_app;
GRANT EXECUTE ON FUNCTION openarc_tenant.current_context_access_kind() TO openarc_tenant_app;

-- Runtime can never run DDL or migrate.
REVOKE CREATE ON SCHEMA openarc_tenant FROM openarc_tenant_app;
REVOKE CREATE ON SCHEMA openarc_auth FROM openarc_tenant_app;
REVOKE CREATE ON SCHEMA openarc_meta FROM openarc_tenant_app;
