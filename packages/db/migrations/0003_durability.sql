-- OpenArc durability foundation (schema3).
--
-- Owner: openarc_migrator. Runtime: openarc_tenant_app. Worker: openarc_worker_app
-- (both pre-provisioned by deployment; this migration NEVER creates roles).
--
-- This slice proves ONE durable operation: tenant.agent.create. An agent insert,
-- its idempotency record, exactly one audit event and exactly one outbox event
-- commit or roll back together on one checked-out transaction. There is no
-- pending-only commit path and no runtime UPDATE/DELETE of audit/outbox.

CREATE SCHEMA IF NOT EXISTS openarc_durable AUTHORIZATION openarc_migrator;
ALTER SCHEMA openarc_durable OWNER TO openarc_migrator;
REVOKE ALL ON SCHEMA openarc_durable FROM PUBLIC;

-- The tenant runtime needs schema usage only; the definer helpers own every row
-- operation and the narrow RLS policies gate them.
GRANT USAGE ON SCHEMA openarc_durable TO openarc_tenant_app;

-- Worker readiness reads migration metadata like the tenant runtime does.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'openarc_worker_app') THEN
    GRANT USAGE ON SCHEMA openarc_durable TO openarc_worker_app;
    GRANT USAGE ON SCHEMA openarc_meta TO openarc_worker_app;
    GRANT SELECT ON openarc_meta.schema_migrations TO openarc_worker_app;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- idempotency_records
-- ---------------------------------------------------------------------------
CREATE TABLE openarc_durable.idempotency_records (
  organization_id text NOT NULL REFERENCES openarc_tenant.organizations(organization_id) ON DELETE RESTRICT,
  operation text NOT NULL,
  key_hash text NOT NULL,
  request_digest text NOT NULL,
  digest_version text NOT NULL,
  actor_account_id text NOT NULL REFERENCES openarc_auth.accounts(account_id) ON DELETE RESTRICT,
  session_context_digest text NOT NULL,
  network text NOT NULL,
  mutation_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  resource_type text,
  resource_id text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  committed_at timestamptz,
  PRIMARY KEY (organization_id, operation, key_hash),
  UNIQUE (organization_id, mutation_id),
  -- Compound bindings referenced by the audit/outbox compound FKs. The
  -- nullable receipt columns keep a pending row from satisfying a dependent
  -- row: dependent columns are NOT NULL, so only a committed receipt binds.
  UNIQUE (organization_id, mutation_id, resource_type, resource_id, actor_account_id, operation),
  UNIQUE (organization_id, mutation_id, resource_type, resource_id),
  CONSTRAINT idempotency_operation_valid CHECK (operation = 'tenant.agent.create'),
  CONSTRAINT idempotency_key_hash_format CHECK (key_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT idempotency_request_digest_format CHECK (request_digest ~ '^[0-9a-f]{64}$'),
  CONSTRAINT idempotency_digest_version_valid CHECK (digest_version = 'tenant.agent.create.v1'),
  CONSTRAINT idempotency_session_digest_format CHECK (session_context_digest ~ '^[0-9a-f]{64}$'),
  CONSTRAINT idempotency_network_valid CHECK (network = 'eip155:5042002'),
  CONSTRAINT idempotency_status_valid CHECK (status IN ('pending', 'committed')),
  CONSTRAINT idempotency_resource_type_valid CHECK (resource_type IS NULL OR resource_type = 'agent'),
  CONSTRAINT idempotency_resource_shape CHECK (
    (status = 'pending' AND resource_id IS NULL AND committed_at IS NULL)
    OR (status = 'committed' AND resource_type = 'agent' AND resource_id IS NOT NULL AND committed_at IS NOT NULL)
  ),
  CONSTRAINT idempotency_committed_at_valid CHECK (committed_at IS NULL OR committed_at >= created_at),
  -- A committed row is bound to a real same-org agent. The agent is inserted in
  -- the same transaction before this row flips to committed.
  CONSTRAINT idempotency_resource_fk FOREIGN KEY (organization_id, resource_id)
    REFERENCES openarc_tenant.agents(organization_id, agent_id) ON DELETE RESTRICT
);

-- ---------------------------------------------------------------------------
-- audit_events
-- ---------------------------------------------------------------------------
CREATE TABLE openarc_durable.audit_events (
  event_id uuid NOT NULL DEFAULT gen_random_uuid(),
  organization_id text NOT NULL REFERENCES openarc_tenant.organizations(organization_id) ON DELETE RESTRICT,
  actor_account_id text NOT NULL REFERENCES openarc_auth.accounts(account_id) ON DELETE RESTRICT,
  operation text NOT NULL,
  mutation_id uuid NOT NULL,
  resource_type text NOT NULL,
  resource_id text NOT NULL,
  outcome text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (event_id),
  CONSTRAINT audit_event_id_unique UNIQUE (organization_id, mutation_id),
  CONSTRAINT audit_operation_valid CHECK (operation = 'tenant.agent.create'),
  CONSTRAINT audit_resource_type_valid CHECK (resource_type = 'agent'),
  CONSTRAINT audit_outcome_valid CHECK (outcome = 'committed'),
  CONSTRAINT audit_resource_fk FOREIGN KEY (organization_id, resource_id)
    REFERENCES openarc_tenant.agents(organization_id, agent_id) ON DELETE RESTRICT,
  -- The audit row must name the exact committed receipt: same org, mutation,
  -- resource and actor/operation. A forged event cannot point at a different
  -- agent or actor than the idempotency parent.
  CONSTRAINT audit_receipt_fk FOREIGN KEY (
    organization_id, mutation_id, resource_type, resource_id, actor_account_id, operation
  ) REFERENCES openarc_durable.idempotency_records (
    organization_id, mutation_id, resource_type, resource_id, actor_account_id, operation
  ) ON DELETE RESTRICT
);

-- ---------------------------------------------------------------------------
-- outbox_events
-- ---------------------------------------------------------------------------
CREATE TABLE openarc_durable.outbox_events (
  event_id uuid NOT NULL DEFAULT gen_random_uuid(),
  organization_id text NOT NULL REFERENCES openarc_tenant.organizations(organization_id) ON DELETE RESTRICT,
  mutation_id uuid NOT NULL,
  resource_type text NOT NULL,
  resource_id text NOT NULL,
  event_type text NOT NULL,
  payload_version integer NOT NULL DEFAULT 1,
  state text NOT NULL DEFAULT 'pending',
  available_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  attempt_count integer NOT NULL DEFAULT 0,
  lease_until timestamptz,
  lease_generation bigint NOT NULL DEFAULT 0,
  last_failure_code text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  completed_at timestamptz,
  PRIMARY KEY (event_id),
  CONSTRAINT outbox_event_unique UNIQUE (organization_id, mutation_id, event_type),
  CONSTRAINT outbox_resource_type_valid CHECK (resource_type = 'agent'),
  CONSTRAINT outbox_event_type_valid CHECK (event_type = 'tenant.agent.created'),
  CONSTRAINT outbox_payload_version_valid CHECK (payload_version = 1),
  CONSTRAINT outbox_state_valid CHECK (state IN ('pending', 'leased', 'completed', 'dead_letter')),
  CONSTRAINT outbox_attempt_count_valid CHECK (attempt_count BETWEEN 0 AND 5),
  CONSTRAINT outbox_lease_generation_valid CHECK (lease_generation >= 0),
  CONSTRAINT outbox_last_failure_code_valid CHECK (
    last_failure_code IS NULL OR last_failure_code IN
      ('dependency_unavailable', 'invalid_event', 'handler_failed', 'attempts_exhausted')
  ),
  CONSTRAINT outbox_state_shape CHECK (
    (state IN ('pending', 'dead_letter') AND lease_until IS NULL)
    OR (state = 'leased' AND lease_until IS NOT NULL AND completed_at IS NULL)
    OR (state = 'completed' AND completed_at IS NOT NULL AND lease_until IS NULL)
  ),
  CONSTRAINT outbox_completed_at_valid CHECK (completed_at IS NULL OR completed_at >= created_at),
  CONSTRAINT outbox_resource_fk FOREIGN KEY (organization_id, resource_id)
    REFERENCES openarc_tenant.agents(organization_id, agent_id) ON DELETE RESTRICT,
  -- The outbox row is bound to the same committed idempotency receipt.
  CONSTRAINT outbox_receipt_fk FOREIGN KEY (
    organization_id, mutation_id, resource_type, resource_id
  ) REFERENCES openarc_durable.idempotency_records (
    organization_id, mutation_id, resource_type, resource_id
  ) ON DELETE RESTRICT
);

CREATE INDEX idempotency_records_mutation_idx
  ON openarc_durable.idempotency_records (organization_id, mutation_id);
CREATE INDEX audit_events_org_idx
  ON openarc_durable.audit_events (organization_id, created_at);
CREATE INDEX outbox_events_claim_idx
  ON openarc_durable.outbox_events (state, available_at, created_at);
CREATE INDEX outbox_events_org_idx
  ON openarc_durable.outbox_events (organization_id, created_at);

-- An idempotency record is append-once for its identity/context fields. Only the
-- pending -> committed transition may change status/receipt columns. This is the
-- last line behind the repository and the RLS policies.
CREATE FUNCTION openarc_durable.enforce_idempotency_immutable() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  IF NEW.organization_id IS DISTINCT FROM OLD.organization_id
     OR NEW.operation IS DISTINCT FROM OLD.operation
     OR NEW.key_hash IS DISTINCT FROM OLD.key_hash
     OR NEW.request_digest IS DISTINCT FROM OLD.request_digest
     OR NEW.digest_version IS DISTINCT FROM OLD.digest_version
     OR NEW.actor_account_id IS DISTINCT FROM OLD.actor_account_id
     OR NEW.session_context_digest IS DISTINCT FROM OLD.session_context_digest
     OR NEW.network IS DISTINCT FROM OLD.network
     OR NEW.mutation_id IS DISTINCT FROM OLD.mutation_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'durable_idempotency_immutable' USING ERRCODE = '42501';
  END IF;
  IF OLD.status = 'committed' THEN
    RAISE EXCEPTION 'durable_idempotency_terminal' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER idempotency_records_immutable BEFORE UPDATE ON openarc_durable.idempotency_records
  FOR EACH ROW EXECUTE FUNCTION openarc_durable.enforce_idempotency_immutable();

-- Append-only audit/outbox: no runtime UPDATE or DELETE at all.
CREATE FUNCTION openarc_durable.reject_mutation() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  RAISE EXCEPTION 'durable_append_only' USING ERRCODE = '42501';
END;
$$;

CREATE TRIGGER audit_events_append_only BEFORE UPDATE OR DELETE ON openarc_durable.audit_events
  FOR EACH ROW EXECUTE FUNCTION openarc_durable.reject_mutation();

-- Outbox is worker-owned state; worker UPDATE is constrained by the definer
-- helpers, so only a DELETE guard exists here. The worker role itself has no
-- UPDATE privilege except through those helpers.
CREATE TRIGGER outbox_events_no_delete BEFORE DELETE ON openarc_durable.outbox_events
  FOR EACH ROW EXECUTE FUNCTION openarc_durable.reject_mutation();

-- ---------------------------------------------------------------------------
-- Tenant runtime definer helper: the ONE durable agent mutation.
-- ---------------------------------------------------------------------------
-- Resolves the caller server-side (never accepting actor/role/digest), takes the
-- shared organization row lock used by lock_organization_access, inserts the
-- agent, one audit event, one outbox event and the committed idempotency
-- receipt. Rechecks the same held session immediately before returning, and the
-- caller's repository rechecks it before COMMIT as well.
CREATE FUNCTION openarc_durable.commit_agent_create(
  session_hash text,
  organization_id text,
  display_name text,
  mutation_id uuid,
  key_hash text,
  request_digest text,
  session_context_digest text
) RETURNS TABLE(
  out_replayed boolean,
  out_mutation_id uuid,
  out_operation text,
  out_resource_type text,
  out_resource_id text,
  out_committed_at timestamptz
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
  v_existing record;
  v_agent_id text;
  v_committed_at timestamptz;
  v_recheck text;
BEGIN
  IF organization_id IS NULL OR organization_id !~ '^openarc:org:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' THEN
    RAISE EXCEPTION 'durable_organization_invalid' USING ERRCODE = '22023';
  END IF;
  IF display_name IS NULL OR char_length(display_name) < 1 OR char_length(display_name) > 100
     OR display_name <> btrim(display_name)
     OR display_name ~ E'[\\u0001-\\u001f\\u007f-\\u009f]' THEN
    RAISE EXCEPTION 'durable_display_name_invalid' USING ERRCODE = '22023';
  END IF;
  IF mutation_id IS NULL THEN
    RAISE EXCEPTION 'durable_mutation_invalid' USING ERRCODE = '22023';
  END IF;
  IF key_hash IS NULL OR key_hash !~ '^[0-9a-f]{64}$'
     OR request_digest IS NULL OR request_digest !~ '^[0-9a-f]{64}$'
     OR session_context_digest IS NULL OR session_context_digest !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'durable_metadata_invalid' USING ERRCODE = '22023';
  END IF;

  SELECT l.account_id, l.method INTO v_actor, v_role
    FROM openarc_tenant.lock_auth_session(session_hash, NULL) AS l;
  IF v_actor IS NULL OR v_role = 'recovery' THEN
    RAISE EXCEPTION 'durable_session_invalid' USING ERRCODE = '28000';
  END IF;

  -- Shared serialization point: the organization row lock.
  PERFORM 1 FROM openarc_tenant.organizations o
   WHERE o.organization_id = organization_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'durable_forbidden' USING ERRCODE = '42501';
  END IF;

  SELECT m.role, m.status INTO v_role, v_status
    FROM openarc_tenant.memberships m
   WHERE m.organization_id = organization_id AND m.account_id = v_actor
   FOR UPDATE;
  IF NOT FOUND OR v_status <> 'active' OR v_role NOT IN ('owner', 'operator') THEN
    RAISE EXCEPTION 'durable_forbidden' USING ERRCODE = '42501';
  END IF;

  PERFORM set_config('openarc.account_id', v_actor, true);
  PERFORM set_config('openarc.organization_id', organization_id, true);
  PERFORM set_config('openarc.role', v_role, true);

  -- Same-key replay: only an exact identity/context/digest match returns the
  -- original safe receipt. Any drift is a fixed conflict with no leaked status.
  SELECT * INTO v_existing
    FROM openarc_durable.idempotency_records r
   WHERE r.organization_id = organization_id AND r.operation = 'tenant.agent.create'
     AND r.key_hash = key_hash
   FOR UPDATE;
  IF FOUND THEN
    IF v_existing.request_digest = request_digest
       AND v_existing.mutation_id = mutation_id
       AND v_existing.actor_account_id = v_actor
       AND v_existing.session_context_digest = session_context_digest
       AND v_existing.status = 'committed' THEN
      -- The idempotency row lock above may have waited for another committer.
      -- Re-validate the SAME held session against the DB clock before returning
      -- a replay receipt; a stale/rotated session cannot read the replay.
      SELECT l.account_id INTO v_recheck
        FROM openarc_tenant.lock_auth_session(session_hash, NULL) AS l;
      IF v_recheck IS NULL OR v_recheck <> v_actor THEN
        RAISE EXCEPTION 'durable_session_invalid' USING ERRCODE = '28000';
      END IF;
      out_replayed := true;
      out_mutation_id := v_existing.mutation_id;
      out_operation := v_existing.operation;
      out_resource_type := v_existing.resource_type;
      out_resource_id := v_existing.resource_id;
      out_committed_at := v_existing.committed_at;
      RETURN NEXT;
      RETURN;
    END IF;
    RAISE EXCEPTION 'durable_idempotency_conflict' USING ERRCODE = 'P0D01';
  END IF;

  -- A different key reusing the same mutation id is also a conflict.
  PERFORM 1 FROM openarc_durable.idempotency_records r
   WHERE r.organization_id = organization_id AND r.mutation_id = mutation_id
   FOR UPDATE;
  IF FOUND THEN
    RAISE EXCEPTION 'durable_idempotency_conflict' USING ERRCODE = 'P0D01';
  END IF;

  v_agent_id := 'openarc:agent:' || gen_random_uuid()::text;
  -- Statement order matters: the pending receipt is written first (resource
  -- unbound), then the agent, then the receipt flips to committed BEFORE the
  -- dependent audit/outbox rows. The compound FKs require a committed parent,
  -- so there is no pending-only runtime path and no partial commit.
  INSERT INTO openarc_durable.idempotency_records (
    organization_id, operation, key_hash, request_digest, digest_version,
    actor_account_id, session_context_digest, network, mutation_id, status
  ) VALUES (
    organization_id, 'tenant.agent.create', key_hash, request_digest, 'tenant.agent.create.v1',
    v_actor, session_context_digest, 'eip155:5042002', mutation_id, 'pending'
  );

  INSERT INTO openarc_tenant.agents (organization_id, agent_id, display_name)
  VALUES (organization_id, v_agent_id, display_name);

  UPDATE openarc_durable.idempotency_records r
     SET status = 'committed',
         resource_type = 'agent',
         resource_id = v_agent_id,
         committed_at = clock_timestamp()
   WHERE r.organization_id = organization_id AND r.operation = 'tenant.agent.create'
     AND r.key_hash = key_hash
   RETURNING r.committed_at INTO v_committed_at;

  INSERT INTO openarc_durable.audit_events (
    organization_id, actor_account_id, operation, mutation_id,
    resource_type, resource_id, outcome
  ) VALUES (
    organization_id, v_actor, 'tenant.agent.create', mutation_id,
    'agent', v_agent_id, 'committed'
  );

  INSERT INTO openarc_durable.outbox_events (
    organization_id, mutation_id, resource_type, resource_id, event_type, payload_version
  ) VALUES (
    organization_id, mutation_id, 'agent', v_agent_id, 'tenant.agent.created', 1
  );

  -- Recheck the SAME held session/account after every blocking write and before
  -- the repository COMMIT. A rotation cannot commit on a stale proof.
  SELECT l.account_id INTO v_recheck
    FROM openarc_tenant.lock_auth_session(session_hash, NULL) AS l;
  IF v_recheck IS NULL OR v_recheck <> v_actor THEN
    RAISE EXCEPTION 'durable_session_invalid' USING ERRCODE = '28000';
  END IF;

  out_replayed := false;
  out_mutation_id := mutation_id;
  out_operation := 'tenant.agent.create';
  out_resource_type := 'agent';
  out_resource_id := v_agent_id;
  out_committed_at := v_committed_at;
  RETURN NEXT;
END;
$$;

-- Status lookup for the SAME account under current owner/operator membership.
-- A mutation owned by another account is indistinguishable from not_found.
CREATE FUNCTION openarc_durable.read_agent_mutation_status(
  session_hash text,
  organization_id text,
  mutation_id uuid
) RETURNS TABLE(
  out_mutation_id uuid,
  out_operation text,
  out_resource_type text,
  out_resource_id text,
  out_committed_at timestamptz
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
  v_recheck text;
  v_found boolean := false;
  v_mutation_id uuid;
  v_operation text;
  v_resource_type text;
  v_resource_id text;
  v_committed_at timestamptz;
BEGIN
  IF organization_id IS NULL OR organization_id !~ '^openarc:org:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' THEN
    RAISE EXCEPTION 'durable_organization_invalid' USING ERRCODE = '22023';
  END IF;
  IF mutation_id IS NULL THEN
    RAISE EXCEPTION 'durable_mutation_invalid' USING ERRCODE = '22023';
  END IF;

  SELECT l.account_id INTO v_actor
    FROM openarc_tenant.lock_auth_session(session_hash, NULL) AS l;
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'durable_session_invalid' USING ERRCODE = '28000';
  END IF;

  PERFORM 1 FROM openarc_tenant.organizations o
   WHERE o.organization_id = organization_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'durable_forbidden' USING ERRCODE = '42501';
  END IF;

  SELECT m.role, m.status INTO v_role, v_status
    FROM openarc_tenant.memberships m
   WHERE m.organization_id = organization_id AND m.account_id = v_actor
   FOR UPDATE;
  IF NOT FOUND OR v_status <> 'active' OR v_role NOT IN ('owner', 'operator') THEN
    RAISE EXCEPTION 'durable_forbidden' USING ERRCODE = '42501';
  END IF;

  -- The organization/membership locks above may have waited. Re-validate the
  -- SAME held session against the DB clock before publishing context or
  -- returning either found or not_found; a session that expired/rotated during
  -- the wait cannot read status.
  SELECT l.account_id INTO v_recheck
    FROM openarc_tenant.lock_auth_session(session_hash, NULL) AS l;
  IF v_recheck IS NULL OR v_recheck <> v_actor THEN
    RAISE EXCEPTION 'durable_session_invalid' USING ERRCODE = '28000';
  END IF;

  PERFORM set_config('openarc.account_id', v_actor, true);
  PERFORM set_config('openarc.organization_id', organization_id, true);
  PERFORM set_config('openarc.role', v_role, true);

  -- Buffer the final receipt read instead of streaming it through RETURN QUERY:
  -- this SELECT can itself block on an ACCESS EXCLUSIVE table lock. Capture the
  -- row (or its absence), then re-validate the SAME held session/account against
  -- the DB clock before publishing found or not_found. A session that expires
  -- during that table-lock wait must not return a receipt.
  SELECT r.mutation_id, r.operation, r.resource_type, r.resource_id, r.committed_at
    INTO v_mutation_id, v_operation, v_resource_type, v_resource_id, v_committed_at
    FROM openarc_durable.idempotency_records r
   WHERE r.organization_id = organization_id
     AND r.mutation_id = mutation_id
     AND r.actor_account_id = v_actor
     AND r.status = 'committed';
  v_found := FOUND;

  SELECT l.account_id INTO v_recheck
    FROM openarc_tenant.lock_auth_session(session_hash, NULL) AS l;
  IF v_recheck IS NULL OR v_recheck <> v_actor THEN
    RAISE EXCEPTION 'durable_session_invalid' USING ERRCODE = '28000';
  END IF;

  IF NOT v_found THEN
    RETURN;
  END IF;

  out_mutation_id := v_mutation_id;
  out_operation := v_operation;
  out_resource_type := v_resource_type;
  out_resource_id := v_resource_id;
  out_committed_at := v_committed_at;
  RETURN NEXT;
END;
$$;

-- ---------------------------------------------------------------------------
-- Worker definer helpers. The restricted worker role has no durable CRUD; it
-- only claims cross-org opaque jobs and acknowledges them by id+generation.
-- ---------------------------------------------------------------------------
CREATE FUNCTION openarc_durable.claim_outbox_jobs(claim_limit integer)
RETURNS TABLE(
  event_id uuid,
  organization_id text,
  mutation_id uuid,
  resource_type text,
  resource_id text,
  event_type text,
  payload_version integer,
  lease_generation bigint,
  lease_until timestamptz,
  attempt_count integer
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
#variable_conflict use_variable
DECLARE
  v_now timestamptz;
  v_row record;
BEGIN
  IF claim_limit IS NULL OR claim_limit < 1 OR claim_limit > 50 THEN
    RAISE EXCEPTION 'durable_claim_limit_invalid' USING ERRCODE = '22023';
  END IF;

  -- Expired final-attempt rows become visible dead_letter during maintenance.
  -- Bound the batch and SKIP LOCKED so one locked poison row cannot block the
  -- whole worker queue; a skipped row is picked up on a later claim.
  WITH expired AS (
    SELECT e.event_id AS id
      FROM openarc_durable.outbox_events e
     WHERE e.state = 'leased'
       AND e.attempt_count >= 5
       AND e.lease_until < clock_timestamp()
     ORDER BY e.lease_until, e.created_at
     LIMIT claim_limit
     FOR UPDATE SKIP LOCKED
  )
  UPDATE openarc_durable.outbox_events e
     SET state = 'dead_letter',
         last_failure_code = 'attempts_exhausted',
         lease_until = NULL
    FROM expired
   WHERE e.event_id = expired.id;

  v_now := clock_timestamp();

  FOR v_row IN
    SELECT e.event_id AS id
      FROM openarc_durable.outbox_events e
     WHERE e.attempt_count < 5
       AND (
         (e.state = 'pending' AND e.available_at <= v_now)
         OR (e.state = 'leased' AND e.lease_until < v_now)
       )
     ORDER BY e.available_at, e.created_at
     LIMIT claim_limit
     FOR UPDATE SKIP LOCKED
  LOOP
    UPDATE openarc_durable.outbox_events e
       SET state = 'leased',
           attempt_count = e.attempt_count + 1,
           lease_generation = e.lease_generation + 1,
           lease_until = v_now + interval '30 seconds',
           last_failure_code = NULL
     WHERE e.event_id = v_row.id
     RETURNING e.event_id, e.organization_id, e.mutation_id, e.resource_type,
               e.resource_id, e.event_type, e.payload_version, e.lease_generation,
               e.lease_until, e.attempt_count
      INTO event_id, organization_id, mutation_id, resource_type, resource_id,
           event_type, payload_version, lease_generation, lease_until, attempt_count;
    RETURN NEXT;
  END LOOP;
END;
$$;

CREATE FUNCTION openarc_durable.complete_outbox_job(
  target_event_id uuid,
  expected_generation bigint
) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_applied boolean := false;
  v_state text;
  v_generation bigint;
  v_lease_until timestamptz;
BEGIN
  IF target_event_id IS NULL OR expected_generation IS NULL THEN
    RAISE EXCEPTION 'durable_ack_invalid' USING ERRCODE = '22023';
  END IF;

  -- Lock the row FIRST, then re-check state/generation against a FRESH DB clock
  -- after lock acquisition. A caller that passed a pre-wait predicate but was
  -- blocked until the lease expired must not complete an expired job.
  SELECT e.state, e.lease_generation, e.lease_until
    INTO v_state, v_generation, v_lease_until
    FROM openarc_durable.outbox_events e
   WHERE e.event_id = target_event_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN false;
  END IF;
  IF v_state <> 'leased'
     OR v_generation <> expected_generation
     OR v_lease_until IS NULL
     OR v_lease_until <= clock_timestamp() THEN
    RETURN false;
  END IF;

  UPDATE openarc_durable.outbox_events e
     SET state = 'completed',
         completed_at = clock_timestamp(),
         lease_until = NULL,
         last_failure_code = NULL
   WHERE e.event_id = target_event_id;
  v_applied := true;
  RETURN v_applied;
END;
$$;

CREATE FUNCTION openarc_durable.fail_outbox_job(
  target_event_id uuid,
  expected_generation bigint,
  failure_code text
) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_applied boolean := false;
  v_attempt integer;
  v_state text;
  v_generation bigint;
  v_lease_until timestamptz;
BEGIN
  IF target_event_id IS NULL OR expected_generation IS NULL THEN
    RAISE EXCEPTION 'durable_ack_invalid' USING ERRCODE = '22023';
  END IF;
  IF failure_code IS NULL OR failure_code NOT IN ('dependency_unavailable', 'invalid_event', 'handler_failed') THEN
    RAISE EXCEPTION 'durable_failure_code_invalid' USING ERRCODE = '22023';
  END IF;

  -- Lock FIRST, then test the FRESH DB-clock lease after acquisition, so a
  -- stale acknowledgement cannot fail a reclaimed or expired job.
  SELECT e.attempt_count, e.state, e.lease_generation, e.lease_until
    INTO v_attempt, v_state, v_generation, v_lease_until
    FROM openarc_durable.outbox_events e
   WHERE e.event_id = target_event_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN false;
  END IF;
  IF v_state <> 'leased'
     OR v_generation <> expected_generation
     OR v_lease_until IS NULL
     OR v_lease_until <= clock_timestamp() THEN
    RETURN false;
  END IF;

  IF failure_code = 'invalid_event' OR v_attempt >= 5 THEN
    UPDATE openarc_durable.outbox_events e
       SET state = 'dead_letter',
           lease_until = NULL,
           last_failure_code = CASE WHEN v_attempt >= 5 AND failure_code <> 'invalid_event'
                                    THEN 'attempts_exhausted' ELSE failure_code END
     WHERE e.event_id = target_event_id;
  ELSE
    UPDATE openarc_durable.outbox_events e
       SET state = 'pending',
           lease_until = NULL,
           available_at = clock_timestamp()
             + make_interval(secs => least(60, power(2, v_attempt)::int)),
           last_failure_code = failure_code
     WHERE e.event_id = target_event_id;
  END IF;
  v_applied := true;
  RETURN v_applied;
END;
$$;

-- ---------------------------------------------------------------------------
-- Row level security. FORCE so the owner is also subject.
-- ---------------------------------------------------------------------------
ALTER TABLE openarc_durable.idempotency_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE openarc_durable.idempotency_records FORCE ROW LEVEL SECURITY;
ALTER TABLE openarc_durable.audit_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE openarc_durable.audit_events FORCE ROW LEVEL SECURITY;
ALTER TABLE openarc_durable.outbox_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE openarc_durable.outbox_events FORCE ROW LEVEL SECURITY;

-- Definer/migrator policy. The SECURITY DEFINER helpers read and write as the
-- migrator owner; explicit migrator policies avoid recursive RLS evaluation.
CREATE POLICY idempotency_migrator ON openarc_durable.idempotency_records
  FOR ALL TO openarc_migrator USING (true) WITH CHECK (true);
CREATE POLICY audit_migrator ON openarc_durable.audit_events
  FOR ALL TO openarc_migrator USING (true) WITH CHECK (true);
CREATE POLICY outbox_migrator ON openarc_durable.outbox_events
  FOR ALL TO openarc_migrator USING (true) WITH CHECK (true);

-- The tenant runtime has NO direct durable DML: no tenant policy is defined for
-- SELECT/INSERT/UPDATE and no table privilege is granted. Every durable read and
-- write goes through the narrow SECURITY DEFINER helpers above, which own the
-- atomic coupled operation and the compound receipt bindings. This removes the
-- pending-only/forged-committed bypass that direct INSERT/UPDATE would allow.

-- Worker definer policy: the helpers run as migrator, so an explicit worker
-- policy is only needed for the restricted role's own (empty) surface. Keeping
-- it defined and false-by-default makes the no-direct-access contract explicit.
CREATE POLICY outbox_worker_none ON openarc_durable.outbox_events
  FOR SELECT TO openarc_worker_app USING (false);

-- ---------------------------------------------------------------------------
-- Privileges.
-- ---------------------------------------------------------------------------
REVOKE ALL ON ALL TABLES IN SCHEMA openarc_durable FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA openarc_durable FROM PUBLIC;

-- No direct table privilege is granted to the tenant runtime. It may only
-- EXECUTE the two narrowly authorized definer helpers below.

-- The worker role receives no table privilege at all; it can only execute the
-- narrow definer claim/complete/fail helpers. The tenant role cannot execute
-- worker helpers and vice versa.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'openarc_worker_app') THEN
    GRANT EXECUTE ON FUNCTION openarc_durable.claim_outbox_jobs(integer) TO openarc_worker_app;
    GRANT EXECUTE ON FUNCTION openarc_durable.complete_outbox_job(uuid, bigint) TO openarc_worker_app;
    GRANT EXECUTE ON FUNCTION openarc_durable.fail_outbox_job(uuid, bigint, text) TO openarc_worker_app;
    REVOKE CREATE ON SCHEMA openarc_durable FROM openarc_worker_app;
  END IF;
END $$;

GRANT EXECUTE ON FUNCTION openarc_durable.commit_agent_create(text, text, text, uuid, text, text, text) TO openarc_tenant_app;
GRANT EXECUTE ON FUNCTION openarc_durable.read_agent_mutation_status(text, text, uuid) TO openarc_tenant_app;

-- The tenant runtime may not execute worker helpers or create durable objects.
REVOKE CREATE ON SCHEMA openarc_durable FROM openarc_tenant_app;
REVOKE CREATE ON SCHEMA openarc_tenant FROM openarc_tenant_app;
