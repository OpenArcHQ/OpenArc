-- OpenArc durable tenant mutations (schema4).
-- Additive. See task.md P01-05b.
--
-- Owner: openarc_migrator. Runtime: openarc_tenant_app. Worker:
-- openarc_worker_app (pre-provisioned by deployment; this migration NEVER
-- creates roles). 0001/0002/0003 are frozen: this migration is purely additive
-- and only alters the named closed-union constraints/links needed to complete
-- durability for the EXISTING tenant writes. It adds no marketplace, financial
-- authorization, machine-credential or API surface.
--
-- Every new operation commits pending receipt -> business row -> committed
-- receipt -> one audit row -> one outbox row in ONE transaction, or rolls back
-- completely. The runtime has NO direct durable DML and can only execute the
-- narrow definer helpers below.

-- ---------------------------------------------------------------------------
-- Closed operation / resource / event union.
-- ---------------------------------------------------------------------------
ALTER TABLE openarc_durable.idempotency_records
  DROP CONSTRAINT idempotency_operation_valid,
  DROP CONSTRAINT idempotency_digest_version_valid,
  DROP CONSTRAINT idempotency_resource_type_valid,
  DROP CONSTRAINT idempotency_resource_shape,
  DROP CONSTRAINT idempotency_resource_fk;

ALTER TABLE openarc_durable.idempotency_records
  ADD CONSTRAINT idempotency_operation_valid CHECK (operation IN (
    'tenant.organization.create',
    'tenant.agent.create',
    'tenant.agent.update',
    'tenant.provider.create',
    'tenant.provider.update',
    'tenant.membership.set'
  )),
  ADD CONSTRAINT idempotency_digest_version_valid CHECK (digest_version IN (
    'tenant.organization.create.v1',
    'tenant.agent.create.v1',
    'tenant.agent.update.v1',
    'tenant.provider.create.v1',
    'tenant.provider.update.v1',
    'tenant.membership.set.v1'
  )),
  ADD CONSTRAINT idempotency_digest_version_matches_operation CHECK (
    digest_version = operation || '.v1'
  ),
  ADD CONSTRAINT idempotency_resource_type_valid CHECK (resource_type IS NULL OR resource_type IN (
    'organization', 'agent', 'provider', 'membership'
  )),
  ADD CONSTRAINT idempotency_resource_shape CHECK (
    (status = 'pending' AND resource_id IS NULL AND committed_at IS NULL)
    OR (status = 'committed' AND resource_type IS NOT NULL AND resource_id IS NOT NULL AND committed_at IS NOT NULL)
  );

-- Typed generated link columns. They are derived from the stored resource_type
-- so a receipt of one kind cannot be pointed at another kind's parent row, and
-- real same-org FKs (not application-only checks) enforce every link. The old
-- agent-only FK is replaced atomically by these stronger typed FKs.
--
-- The typed parent FKs validate EXISTING rows during this migration (an
-- upgrade from schema3 has committed agent receipts). RLS is FORCEd on the
-- tenant tables and the runtime predicate policies require transaction-local
-- GUCs, so the migrator needs its own read policy on agents/providers exactly
-- as 0002 already provides for organizations/memberships. Without it the FK
-- validation cannot see the parent rows on an upgrade. This is additive and
-- grants nothing to the runtime roles.
CREATE POLICY agents_select_migrator ON openarc_tenant.agents
  FOR SELECT TO openarc_migrator USING (true);
CREATE POLICY providers_select_migrator ON openarc_tenant.providers
  FOR SELECT TO openarc_migrator USING (true);

ALTER TABLE openarc_durable.idempotency_records
  ADD COLUMN agent_id text GENERATED ALWAYS AS (
    CASE WHEN resource_type = 'agent' THEN resource_id END
  ) STORED,
  ADD COLUMN provider_id text GENERATED ALWAYS AS (
    CASE WHEN resource_type = 'provider' THEN resource_id END
  ) STORED,
  ADD COLUMN organization_resource_id text GENERATED ALWAYS AS (
    CASE WHEN resource_type = 'organization' THEN resource_id END
  ) STORED,
  ADD COLUMN membership_account_id text GENERATED ALWAYS AS (
    CASE WHEN resource_type = 'membership' THEN resource_id END
  ) STORED;

ALTER TABLE openarc_durable.idempotency_records
  ADD CONSTRAINT idempotency_agent_fk FOREIGN KEY (organization_id, agent_id)
    REFERENCES openarc_tenant.agents(organization_id, agent_id) ON DELETE RESTRICT,
  ADD CONSTRAINT idempotency_provider_fk FOREIGN KEY (organization_id, provider_id)
    REFERENCES openarc_tenant.providers(organization_id, provider_id) ON DELETE RESTRICT,
  ADD CONSTRAINT idempotency_organization_fk FOREIGN KEY (organization_resource_id)
    REFERENCES openarc_tenant.organizations(organization_id) ON DELETE RESTRICT,
  ADD CONSTRAINT idempotency_membership_fk FOREIGN KEY (organization_id, membership_account_id)
    REFERENCES openarc_tenant.memberships(organization_id, account_id) ON DELETE RESTRICT;

-- A scoped receipt may only name an organization in its OWN organization_id:
-- the single-column organization FK alone would otherwise accept an orgA
-- receipt pointing at an existing orgB. The operation's single resource kind is
-- also pinned so privileged inserts cannot pair an operation with a different
-- kind (organization/agent/provider/membership) than the closed union allows.
ALTER TABLE openarc_durable.idempotency_records
  ADD CONSTRAINT idempotency_resource_matches_operation CHECK (
    resource_type IS NULL OR resource_type = CASE operation
      WHEN 'tenant.organization.create' THEN 'organization'
      WHEN 'tenant.agent.create' THEN 'agent'
      WHEN 'tenant.agent.update' THEN 'agent'
      WHEN 'tenant.provider.create' THEN 'provider'
      WHEN 'tenant.provider.update' THEN 'provider'
      WHEN 'tenant.membership.set' THEN 'membership'
    END
  ),
  ADD CONSTRAINT idempotency_resource_org_scope CHECK (
    resource_type IS DISTINCT FROM 'organization' OR resource_id = organization_id
  );

-- The outbox operation-pinned receipt binding references this exact tuple.
ALTER TABLE openarc_durable.idempotency_records
  ADD CONSTRAINT idempotency_receipt_operation_unique
    UNIQUE (organization_id, mutation_id, resource_type, resource_id, operation);

-- Global partial uniqueness for durable bootstrap: the derived org id is a
-- pure function of the mutation id, but the same idempotency key must NEVER be
-- able to create two separate organizations across accounts.
CREATE UNIQUE INDEX idempotency_bootstrap_key_global
  ON openarc_durable.idempotency_records (operation, key_hash)
  WHERE operation = 'tenant.organization.create';

-- Audit / outbox operation/resource/event unions. The derived typed parent FKs
-- and the receipt-binding compound FKs (below) enforce scope, so the old
-- agent-only FKs are removed only after the stronger typed links exist.
ALTER TABLE openarc_durable.audit_events
  DROP CONSTRAINT audit_operation_valid,
  DROP CONSTRAINT audit_resource_type_valid,
  DROP CONSTRAINT audit_resource_fk;

ALTER TABLE openarc_durable.audit_events
  ADD CONSTRAINT audit_operation_valid CHECK (operation IN (
    'tenant.organization.create',
    'tenant.agent.create',
    'tenant.agent.update',
    'tenant.provider.create',
    'tenant.provider.update',
    'tenant.membership.set'
  )),
  ADD CONSTRAINT audit_resource_type_valid CHECK (resource_type IN (
    'organization', 'agent', 'provider', 'membership'
  ));

ALTER TABLE openarc_durable.audit_events
  ADD COLUMN agent_id text GENERATED ALWAYS AS (
    CASE WHEN resource_type = 'agent' THEN resource_id END
  ) STORED,
  ADD COLUMN provider_id text GENERATED ALWAYS AS (
    CASE WHEN resource_type = 'provider' THEN resource_id END
  ) STORED,
  ADD COLUMN organization_resource_id text GENERATED ALWAYS AS (
    CASE WHEN resource_type = 'organization' THEN resource_id END
  ) STORED,
  ADD COLUMN membership_account_id text GENERATED ALWAYS AS (
    CASE WHEN resource_type = 'membership' THEN resource_id END
  ) STORED,
  ADD CONSTRAINT audit_agent_fk FOREIGN KEY (organization_id, agent_id)
    REFERENCES openarc_tenant.agents(organization_id, agent_id) ON DELETE RESTRICT,
  ADD CONSTRAINT audit_provider_fk FOREIGN KEY (organization_id, provider_id)
    REFERENCES openarc_tenant.providers(organization_id, provider_id) ON DELETE RESTRICT,
  ADD CONSTRAINT audit_organization_fk FOREIGN KEY (organization_resource_id)
    REFERENCES openarc_tenant.organizations(organization_id) ON DELETE RESTRICT,
  ADD CONSTRAINT audit_membership_fk FOREIGN KEY (organization_id, membership_account_id)
    REFERENCES openarc_tenant.memberships(organization_id, account_id) ON DELETE RESTRICT;

-- Closed operation->resource mapping and the same own-organization scope. An
-- audit row cannot pair its operation with an unrelated resource kind, and an
-- organization audit row cannot name a different organization than its scope.
ALTER TABLE openarc_durable.audit_events
  ADD CONSTRAINT audit_resource_matches_operation CHECK (
    resource_type = CASE operation
      WHEN 'tenant.organization.create' THEN 'organization'
      WHEN 'tenant.agent.create' THEN 'agent'
      WHEN 'tenant.agent.update' THEN 'agent'
      WHEN 'tenant.provider.create' THEN 'provider'
      WHEN 'tenant.provider.update' THEN 'provider'
      WHEN 'tenant.membership.set' THEN 'membership'
    END
  ),
  ADD CONSTRAINT audit_resource_org_scope CHECK (
    resource_type <> 'organization' OR resource_id = organization_id
  );

ALTER TABLE openarc_durable.outbox_events
  DROP CONSTRAINT outbox_resource_type_valid,
  DROP CONSTRAINT outbox_event_type_valid,
  DROP CONSTRAINT outbox_resource_fk;

ALTER TABLE openarc_durable.outbox_events
  ADD CONSTRAINT outbox_resource_type_valid CHECK (resource_type IN (
    'organization', 'agent', 'provider', 'membership'
  )),
  ADD CONSTRAINT outbox_event_type_valid CHECK (event_type IN (
    'tenant.organization.created',
    'tenant.agent.created',
    'tenant.agent.updated',
    'tenant.provider.created',
    'tenant.provider.updated',
    'tenant.membership.set'
  ));

-- One exact event->operation mapping that matches the receipt operation, so an
-- event can never claim a different operation for the same receipt.
ALTER TABLE openarc_durable.outbox_events
  ADD COLUMN receipt_operation text GENERATED ALWAYS AS (
    CASE event_type
      WHEN 'tenant.organization.created' THEN 'tenant.organization.create'
      WHEN 'tenant.agent.created' THEN 'tenant.agent.create'
      WHEN 'tenant.agent.updated' THEN 'tenant.agent.update'
      WHEN 'tenant.provider.created' THEN 'tenant.provider.create'
      WHEN 'tenant.provider.updated' THEN 'tenant.provider.update'
      WHEN 'tenant.membership.set' THEN 'tenant.membership.set'
    END
  ) STORED;

ALTER TABLE openarc_durable.outbox_events
  ADD COLUMN agent_id text GENERATED ALWAYS AS (
    CASE WHEN resource_type = 'agent' THEN resource_id END
  ) STORED,
  ADD COLUMN provider_id text GENERATED ALWAYS AS (
    CASE WHEN resource_type = 'provider' THEN resource_id END
  ) STORED,
  ADD COLUMN organization_resource_id text GENERATED ALWAYS AS (
    CASE WHEN resource_type = 'organization' THEN resource_id END
  ) STORED,
  ADD COLUMN membership_account_id text GENERATED ALWAYS AS (
    CASE WHEN resource_type = 'membership' THEN resource_id END
  ) STORED,
  ADD CONSTRAINT outbox_agent_fk FOREIGN KEY (organization_id, agent_id)
    REFERENCES openarc_tenant.agents(organization_id, agent_id) ON DELETE RESTRICT,
  ADD CONSTRAINT outbox_provider_fk FOREIGN KEY (organization_id, provider_id)
    REFERENCES openarc_tenant.providers(organization_id, provider_id) ON DELETE RESTRICT,
  ADD CONSTRAINT outbox_organization_fk FOREIGN KEY (organization_resource_id)
    REFERENCES openarc_tenant.organizations(organization_id) ON DELETE RESTRICT,
  ADD CONSTRAINT outbox_membership_fk FOREIGN KEY (organization_id, membership_account_id)
    REFERENCES openarc_tenant.memberships(organization_id, account_id) ON DELETE RESTRICT;

-- Every event maps to exactly one resource kind, and an organization event must
-- name its own organization scope. This extends the event->operation mapping
-- (receipt_operation / outbox_receipt_fk) so a privileged insert cannot claim a
-- different operation/resource for the same receipt.
ALTER TABLE openarc_durable.outbox_events
  ADD CONSTRAINT outbox_resource_matches_event CHECK (
    resource_type = CASE event_type
      WHEN 'tenant.organization.created' THEN 'organization'
      WHEN 'tenant.agent.created' THEN 'agent'
      WHEN 'tenant.agent.updated' THEN 'agent'
      WHEN 'tenant.provider.created' THEN 'provider'
      WHEN 'tenant.provider.updated' THEN 'provider'
      WHEN 'tenant.membership.set' THEN 'membership'
    END
  ),
  ADD CONSTRAINT outbox_resource_org_scope CHECK (
    resource_type <> 'organization' OR resource_id = organization_id
  );

-- Preserve the accepted compound receipt bindings, but now also pin the receipt
-- operation to the outbox's fixed event->operation mapping.
ALTER TABLE openarc_durable.outbox_events
  DROP CONSTRAINT outbox_receipt_fk;
ALTER TABLE openarc_durable.outbox_events
  ADD CONSTRAINT outbox_receipt_fk FOREIGN KEY (
    organization_id, mutation_id, resource_type, resource_id, receipt_operation
  ) REFERENCES openarc_durable.idempotency_records (
    organization_id, mutation_id, resource_type, resource_id, operation
  ) ON DELETE RESTRICT;

-- Audit's compound FK already includes actor/operation, which pins the
-- operation; preserve it as-is.

-- ---------------------------------------------------------------------------
-- Shared internal validation.
-- ---------------------------------------------------------------------------
CREATE FUNCTION openarc_durable.is_canonical_org_id(value text) RETURNS boolean
LANGUAGE sql IMMUTABLE
SET search_path = pg_catalog
AS $$
  SELECT value IS NOT NULL
     AND value ~ '^openarc:org:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$';
$$;

CREATE FUNCTION openarc_durable.is_canonical_display_name(value text) RETURNS boolean
LANGUAGE sql IMMUTABLE
SET search_path = pg_catalog
AS $$
  SELECT value IS NOT NULL
     AND char_length(value) BETWEEN 1 AND 100
     AND value = btrim(value)
     AND value !~ E'[\u0001-\u001f\u007f-\u009f]';
$$;

-- ---------------------------------------------------------------------------
-- Durable organization bootstrap.
-- ---------------------------------------------------------------------------
-- Derives organization_id = 'openarc:org:' || mutation_id. The derived global
-- partial unique index makes the same key map to at most one organization.
CREATE FUNCTION openarc_durable.commit_organization_create(
  session_hash text,
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
  v_method text;
  v_created_at timestamptz;
  v_expires_at timestamptz;
  v_org text;
  v_existing record;
  v_committed_at timestamptz;
  v_recheck text;
BEGIN
  IF NOT openarc_durable.is_canonical_display_name(display_name) THEN
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

  SELECT l.account_id, l.method, l.session_created_at, l.session_expires_at
    INTO v_actor, v_method, v_created_at, v_expires_at
    FROM openarc_tenant.lock_auth_session(session_hash, NULL) AS l;
  IF v_actor IS NULL OR v_method = 'recovery' THEN
    RAISE EXCEPTION 'durable_session_invalid' USING ERRCODE = '28000';
  END IF;
  IF NOT (v_created_at > clock_timestamp() - interval '5 minutes') THEN
    RAISE EXCEPTION 'durable_proof_stale' USING ERRCODE = '28000';
  END IF;

  v_org := 'openarc:org:' || mutation_id::text;

  -- Same-key replay before any business write. The bootstrap partial unique
  -- index guarantees at most one row exists for this operation+key globally.
  SELECT * INTO v_existing
    FROM openarc_durable.idempotency_records r
   WHERE r.operation = 'tenant.organization.create' AND r.key_hash = key_hash
   FOR UPDATE;
  IF FOUND THEN
    IF v_existing.request_digest = request_digest
       AND v_existing.mutation_id = mutation_id
       AND v_existing.actor_account_id = v_actor
       AND v_existing.session_context_digest = session_context_digest
       AND v_existing.status = 'committed' THEN
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

  -- A different key reusing the same derived mutation/organization id conflicts.
  PERFORM 1 FROM openarc_durable.idempotency_records r
   WHERE r.operation = 'tenant.organization.create' AND r.mutation_id = mutation_id
   FOR UPDATE;
  IF FOUND THEN
    RAISE EXCEPTION 'durable_idempotency_conflict' USING ERRCODE = 'P0D01';
  END IF;
  IF EXISTS (SELECT 1 FROM openarc_tenant.organizations o WHERE o.organization_id = v_org) THEN
    RAISE EXCEPTION 'durable_idempotency_conflict' USING ERRCODE = 'P0D01';
  END IF;

  -- The receipt's organization FK means a brand-new organization must exist
  -- before the pending receipt: organization -> pending receipt -> membership ->
  -- committed receipt -> audit/outbox, all in this one transaction.
  PERFORM set_config('openarc.account_id', v_actor, true);
  PERFORM set_config('openarc.organization_id', v_org, true);
  INSERT INTO openarc_tenant.organizations (organization_id, display_name, created_by)
  VALUES (v_org, display_name, v_actor);

  INSERT INTO openarc_durable.idempotency_records (
    organization_id, operation, key_hash, request_digest, digest_version,
    actor_account_id, session_context_digest, network, mutation_id, status
  ) VALUES (
    v_org, 'tenant.organization.create', key_hash, request_digest, 'tenant.organization.create.v1',
    v_actor, session_context_digest, 'eip155:5042002', mutation_id, 'pending'
  );

  PERFORM set_config('openarc.role', 'owner', true);
  INSERT INTO openarc_tenant.memberships (organization_id, account_id, role, status)
  VALUES (v_org, v_actor, 'owner', 'active');

  UPDATE openarc_durable.idempotency_records r
     SET status = 'committed',
         resource_type = 'organization',
         resource_id = v_org,
         committed_at = clock_timestamp()
   WHERE r.organization_id = v_org AND r.operation = 'tenant.organization.create'
     AND r.key_hash = key_hash
   RETURNING r.committed_at INTO v_committed_at;

  INSERT INTO openarc_durable.audit_events (
    organization_id, actor_account_id, operation, mutation_id,
    resource_type, resource_id, outcome
  ) VALUES (
    v_org, v_actor, 'tenant.organization.create', mutation_id,
    'organization', v_org, 'committed'
  );

  INSERT INTO openarc_durable.outbox_events (
    organization_id, mutation_id, resource_type, resource_id, event_type, payload_version
  ) VALUES (
    v_org, mutation_id, 'organization', v_org, 'tenant.organization.created', 1
  );

  -- Recheck the SAME held session / account freshness AFTER every blocking write.
  SELECT l.account_id, l.session_created_at, l.session_expires_at
    INTO v_recheck, v_created_at, v_expires_at
    FROM openarc_tenant.lock_auth_session(session_hash, NULL) AS l;
  IF v_recheck IS NULL OR v_recheck <> v_actor THEN
    RAISE EXCEPTION 'durable_session_invalid' USING ERRCODE = '28000';
  END IF;
  IF NOT (v_created_at > clock_timestamp() - interval '5 minutes') THEN
    RAISE EXCEPTION 'durable_proof_stale' USING ERRCODE = '28000';
  END IF;

  out_replayed := false;
  out_mutation_id := mutation_id;
  out_operation := 'tenant.organization.create';
  out_resource_type := 'organization';
  out_resource_id := v_org;
  out_committed_at := v_committed_at;
  RETURN NEXT;
END;
$$;

-- ---------------------------------------------------------------------------
-- Durable agent update.
-- ---------------------------------------------------------------------------
CREATE FUNCTION openarc_durable.commit_agent_update(
  session_hash text,
  organization_id text,
  agent_id text,
  has_display_name boolean,
  display_name text,
  has_status boolean,
  status text,
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
  v_current record;
  v_committed_at timestamptz;
  v_recheck text;
BEGIN
  IF NOT openarc_durable.is_canonical_org_id(organization_id) THEN
    RAISE EXCEPTION 'durable_organization_invalid' USING ERRCODE = '22023';
  END IF;
  IF agent_id IS NULL OR agent_id !~ '^openarc:agent:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' THEN
    RAISE EXCEPTION 'durable_agent_invalid' USING ERRCODE = '22023';
  END IF;
  IF has_display_name IS NULL OR has_status IS NULL
     OR (has_display_name AND NOT openarc_durable.is_canonical_display_name(display_name))
     OR (NOT has_display_name AND display_name IS NOT NULL)
     OR (has_status AND (status IS NULL OR status NOT IN ('active', 'suspended', 'revoked')))
     OR (NOT has_status AND status IS NOT NULL) THEN
    RAISE EXCEPTION 'durable_patch_invalid' USING ERRCODE = '22023';
  END IF;
  IF NOT (has_display_name OR has_status) THEN
    RAISE EXCEPTION 'durable_patch_invalid' USING ERRCODE = '22023';
  END IF;
  IF mutation_id IS NULL THEN
    RAISE EXCEPTION 'durable_mutation_invalid' USING ERRCODE = '22023';
  END IF;
  IF key_hash IS NULL OR key_hash !~ '^[0-9a-f]{64}$'
     OR request_digest IS NULL OR request_digest !~ '^[0-9a-f]{64}$'
     OR session_context_digest IS NULL OR session_context_digest !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'durable_metadata_invalid' USING ERRCODE = '22023';
  END IF;

  SELECT l.account_id INTO v_actor
    FROM openarc_tenant.lock_auth_session(session_hash, NULL) AS l;
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'durable_session_invalid' USING ERRCODE = '28000';
  END IF;

  PERFORM 1 FROM openarc_tenant.organizations o
   WHERE o.organization_id = organization_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'durable_forbidden' USING ERRCODE = '42501';
  END IF;
  SELECT m.role, m.status INTO v_role, v_status
    FROM openarc_tenant.memberships m
   WHERE m.organization_id = organization_id AND m.account_id = v_actor FOR UPDATE;
  IF NOT FOUND OR v_status <> 'active' OR v_role NOT IN ('owner', 'operator') THEN
    RAISE EXCEPTION 'durable_forbidden' USING ERRCODE = '42501';
  END IF;

  SELECT l.account_id INTO v_recheck
    FROM openarc_tenant.lock_auth_session(session_hash, NULL) AS l;
  IF v_recheck IS NULL OR v_recheck <> v_actor THEN
    RAISE EXCEPTION 'durable_session_invalid' USING ERRCODE = '28000';
  END IF;

  PERFORM set_config('openarc.account_id', v_actor, true);
  PERFORM set_config('openarc.organization_id', organization_id, true);
  PERFORM set_config('openarc.role', v_role, true);

  -- Replay precedes re-applying any terminal-state change so a retry of the
  -- accepted terminal update can recover the receipt without mutating again.
  SELECT * INTO v_existing
    FROM openarc_durable.idempotency_records r
   WHERE r.organization_id = organization_id AND r.operation = 'tenant.agent.update'
     AND r.key_hash = key_hash FOR UPDATE;
  IF FOUND THEN
    IF v_existing.request_digest = request_digest
       AND v_existing.mutation_id = mutation_id
       AND v_existing.actor_account_id = v_actor
       AND v_existing.session_context_digest = session_context_digest
       AND v_existing.status = 'committed' THEN
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
  PERFORM 1 FROM openarc_durable.idempotency_records r
   WHERE r.organization_id = organization_id AND r.mutation_id = mutation_id FOR UPDATE;
  IF FOUND THEN
    RAISE EXCEPTION 'durable_idempotency_conflict' USING ERRCODE = 'P0D01';
  END IF;

  SELECT a.agent_id, a.display_name, a.status INTO v_current
    FROM openarc_tenant.agents a
   WHERE a.organization_id = organization_id AND a.agent_id = agent_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'durable_not_found' USING ERRCODE = '23503';
  END IF;
  IF v_current.status = 'revoked' THEN
    RAISE EXCEPTION 'durable_terminal_conflict' USING ERRCODE = '23505';
  END IF;

  INSERT INTO openarc_durable.idempotency_records (
    organization_id, operation, key_hash, request_digest, digest_version,
    actor_account_id, session_context_digest, network, mutation_id, status
  ) VALUES (
    organization_id, 'tenant.agent.update', key_hash, request_digest, 'tenant.agent.update.v1',
    v_actor, session_context_digest, 'eip155:5042002', mutation_id, 'pending'
  );

  UPDATE openarc_tenant.agents a
     SET display_name = CASE WHEN has_display_name THEN display_name ELSE a.display_name END,
         status = CASE WHEN has_status THEN status ELSE a.status END,
         updated_at = clock_timestamp()
   WHERE a.organization_id = organization_id AND a.agent_id = agent_id;

  UPDATE openarc_durable.idempotency_records r
     SET status = 'committed',
         resource_type = 'agent',
         resource_id = agent_id,
         committed_at = clock_timestamp()
   WHERE r.organization_id = organization_id AND r.operation = 'tenant.agent.update'
     AND r.key_hash = key_hash
   RETURNING r.committed_at INTO v_committed_at;

  INSERT INTO openarc_durable.audit_events (
    organization_id, actor_account_id, operation, mutation_id,
    resource_type, resource_id, outcome
  ) VALUES (
    organization_id, v_actor, 'tenant.agent.update', mutation_id,
    'agent', agent_id, 'committed'
  );
  INSERT INTO openarc_durable.outbox_events (
    organization_id, mutation_id, resource_type, resource_id, event_type, payload_version
  ) VALUES (
    organization_id, mutation_id, 'agent', agent_id, 'tenant.agent.updated', 1
  );

  SELECT l.account_id INTO v_recheck
    FROM openarc_tenant.lock_auth_session(session_hash, NULL) AS l;
  IF v_recheck IS NULL OR v_recheck <> v_actor THEN
    RAISE EXCEPTION 'durable_session_invalid' USING ERRCODE = '28000';
  END IF;

  out_replayed := false;
  out_mutation_id := mutation_id;
  out_operation := 'tenant.agent.update';
  out_resource_type := 'agent';
  out_resource_id := agent_id;
  out_committed_at := v_committed_at;
  RETURN NEXT;
END;
$$;

-- ---------------------------------------------------------------------------
-- Durable provider create / update.
-- ---------------------------------------------------------------------------
CREATE FUNCTION openarc_durable.commit_provider_create(
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
  v_provider_id text;
  v_committed_at timestamptz;
  v_recheck text;
BEGIN
  IF NOT openarc_durable.is_canonical_org_id(organization_id) THEN
    RAISE EXCEPTION 'durable_organization_invalid' USING ERRCODE = '22023';
  END IF;
  IF NOT openarc_durable.is_canonical_display_name(display_name) THEN
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

  SELECT l.account_id INTO v_actor
    FROM openarc_tenant.lock_auth_session(session_hash, NULL) AS l;
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'durable_session_invalid' USING ERRCODE = '28000';
  END IF;

  PERFORM 1 FROM openarc_tenant.organizations o
   WHERE o.organization_id = organization_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'durable_forbidden' USING ERRCODE = '42501';
  END IF;
  SELECT m.role, m.status INTO v_role, v_status
    FROM openarc_tenant.memberships m
   WHERE m.organization_id = organization_id AND m.account_id = v_actor FOR UPDATE;
  IF NOT FOUND OR v_status <> 'active' OR v_role <> 'owner' THEN
    RAISE EXCEPTION 'durable_forbidden' USING ERRCODE = '42501';
  END IF;
  SELECT l.account_id INTO v_recheck
    FROM openarc_tenant.lock_auth_session(session_hash, NULL) AS l;
  IF v_recheck IS NULL OR v_recheck <> v_actor THEN
    RAISE EXCEPTION 'durable_session_invalid' USING ERRCODE = '28000';
  END IF;

  PERFORM set_config('openarc.account_id', v_actor, true);
  PERFORM set_config('openarc.organization_id', organization_id, true);
  PERFORM set_config('openarc.role', 'owner', true);

  SELECT * INTO v_existing
    FROM openarc_durable.idempotency_records r
   WHERE r.organization_id = organization_id AND r.operation = 'tenant.provider.create'
     AND r.key_hash = key_hash FOR UPDATE;
  IF FOUND THEN
    IF v_existing.request_digest = request_digest
       AND v_existing.mutation_id = mutation_id
       AND v_existing.actor_account_id = v_actor
       AND v_existing.session_context_digest = session_context_digest
       AND v_existing.status = 'committed' THEN
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
  PERFORM 1 FROM openarc_durable.idempotency_records r
   WHERE r.organization_id = organization_id AND r.mutation_id = mutation_id FOR UPDATE;
  IF FOUND THEN
    RAISE EXCEPTION 'durable_idempotency_conflict' USING ERRCODE = 'P0D01';
  END IF;

  v_provider_id := 'openarc:provider:' || gen_random_uuid()::text;
  INSERT INTO openarc_durable.idempotency_records (
    organization_id, operation, key_hash, request_digest, digest_version,
    actor_account_id, session_context_digest, network, mutation_id, status
  ) VALUES (
    organization_id, 'tenant.provider.create', key_hash, request_digest, 'tenant.provider.create.v1',
    v_actor, session_context_digest, 'eip155:5042002', mutation_id, 'pending'
  );
  INSERT INTO openarc_tenant.providers (organization_id, provider_id, display_name)
  VALUES (organization_id, v_provider_id, display_name);
  UPDATE openarc_durable.idempotency_records r
     SET status = 'committed', resource_type = 'provider', resource_id = v_provider_id,
         committed_at = clock_timestamp()
   WHERE r.organization_id = organization_id AND r.operation = 'tenant.provider.create'
     AND r.key_hash = key_hash
   RETURNING r.committed_at INTO v_committed_at;
  INSERT INTO openarc_durable.audit_events (
    organization_id, actor_account_id, operation, mutation_id, resource_type, resource_id, outcome
  ) VALUES (
    organization_id, v_actor, 'tenant.provider.create', mutation_id, 'provider', v_provider_id, 'committed'
  );
  INSERT INTO openarc_durable.outbox_events (
    organization_id, mutation_id, resource_type, resource_id, event_type, payload_version
  ) VALUES (
    organization_id, mutation_id, 'provider', v_provider_id, 'tenant.provider.created', 1
  );

  SELECT l.account_id INTO v_recheck
    FROM openarc_tenant.lock_auth_session(session_hash, NULL) AS l;
  IF v_recheck IS NULL OR v_recheck <> v_actor THEN
    RAISE EXCEPTION 'durable_session_invalid' USING ERRCODE = '28000';
  END IF;

  out_replayed := false;
  out_mutation_id := mutation_id;
  out_operation := 'tenant.provider.create';
  out_resource_type := 'provider';
  out_resource_id := v_provider_id;
  out_committed_at := v_committed_at;
  RETURN NEXT;
END;
$$;

CREATE FUNCTION openarc_durable.commit_provider_update(
  session_hash text,
  organization_id text,
  provider_id text,
  has_display_name boolean,
  display_name text,
  has_status boolean,
  status text,
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
  v_current record;
  v_committed_at timestamptz;
  v_recheck text;
BEGIN
  IF NOT openarc_durable.is_canonical_org_id(organization_id) THEN
    RAISE EXCEPTION 'durable_organization_invalid' USING ERRCODE = '22023';
  END IF;
  IF provider_id IS NULL OR provider_id !~ '^openarc:provider:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' THEN
    RAISE EXCEPTION 'durable_provider_invalid' USING ERRCODE = '22023';
  END IF;
  IF has_display_name IS NULL OR has_status IS NULL
     OR (has_display_name AND NOT openarc_durable.is_canonical_display_name(display_name))
     OR (NOT has_display_name AND display_name IS NOT NULL)
     OR (has_status AND (status IS NULL OR status NOT IN ('active', 'suspended', 'retired')))
     OR (NOT has_status AND status IS NOT NULL) THEN
    RAISE EXCEPTION 'durable_patch_invalid' USING ERRCODE = '22023';
  END IF;
  IF NOT (has_display_name OR has_status) THEN
    RAISE EXCEPTION 'durable_patch_invalid' USING ERRCODE = '22023';
  END IF;
  IF mutation_id IS NULL THEN
    RAISE EXCEPTION 'durable_mutation_invalid' USING ERRCODE = '22023';
  END IF;
  IF key_hash IS NULL OR key_hash !~ '^[0-9a-f]{64}$'
     OR request_digest IS NULL OR request_digest !~ '^[0-9a-f]{64}$'
     OR session_context_digest IS NULL OR session_context_digest !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'durable_metadata_invalid' USING ERRCODE = '22023';
  END IF;

  SELECT l.account_id INTO v_actor
    FROM openarc_tenant.lock_auth_session(session_hash, NULL) AS l;
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'durable_session_invalid' USING ERRCODE = '28000';
  END IF;

  PERFORM 1 FROM openarc_tenant.organizations o
   WHERE o.organization_id = organization_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'durable_forbidden' USING ERRCODE = '42501';
  END IF;
  SELECT m.role, m.status INTO v_role, v_status
    FROM openarc_tenant.memberships m
   WHERE m.organization_id = organization_id AND m.account_id = v_actor FOR UPDATE;
  IF NOT FOUND OR v_status <> 'active' OR v_role <> 'owner' THEN
    RAISE EXCEPTION 'durable_forbidden' USING ERRCODE = '42501';
  END IF;
  SELECT l.account_id INTO v_recheck
    FROM openarc_tenant.lock_auth_session(session_hash, NULL) AS l;
  IF v_recheck IS NULL OR v_recheck <> v_actor THEN
    RAISE EXCEPTION 'durable_session_invalid' USING ERRCODE = '28000';
  END IF;

  PERFORM set_config('openarc.account_id', v_actor, true);
  PERFORM set_config('openarc.organization_id', organization_id, true);
  PERFORM set_config('openarc.role', 'owner', true);

  SELECT * INTO v_existing
    FROM openarc_durable.idempotency_records r
   WHERE r.organization_id = organization_id AND r.operation = 'tenant.provider.update'
     AND r.key_hash = key_hash FOR UPDATE;
  IF FOUND THEN
    IF v_existing.request_digest = request_digest
       AND v_existing.mutation_id = mutation_id
       AND v_existing.actor_account_id = v_actor
       AND v_existing.session_context_digest = session_context_digest
       AND v_existing.status = 'committed' THEN
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
  PERFORM 1 FROM openarc_durable.idempotency_records r
   WHERE r.organization_id = organization_id AND r.mutation_id = mutation_id FOR UPDATE;
  IF FOUND THEN
    RAISE EXCEPTION 'durable_idempotency_conflict' USING ERRCODE = 'P0D01';
  END IF;

  SELECT p.provider_id, p.display_name, p.status INTO v_current
    FROM openarc_tenant.providers p
   WHERE p.organization_id = organization_id AND p.provider_id = provider_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'durable_not_found' USING ERRCODE = '23503';
  END IF;
  IF v_current.status = 'retired' THEN
    RAISE EXCEPTION 'durable_terminal_conflict' USING ERRCODE = '23505';
  END IF;

  INSERT INTO openarc_durable.idempotency_records (
    organization_id, operation, key_hash, request_digest, digest_version,
    actor_account_id, session_context_digest, network, mutation_id, status
  ) VALUES (
    organization_id, 'tenant.provider.update', key_hash, request_digest, 'tenant.provider.update.v1',
    v_actor, session_context_digest, 'eip155:5042002', mutation_id, 'pending'
  );
  UPDATE openarc_tenant.providers p
     SET display_name = CASE WHEN has_display_name THEN display_name ELSE p.display_name END,
         status = CASE WHEN has_status THEN status ELSE p.status END,
         updated_at = clock_timestamp()
   WHERE p.organization_id = organization_id AND p.provider_id = provider_id;
  UPDATE openarc_durable.idempotency_records r
     SET status = 'committed', resource_type = 'provider', resource_id = provider_id,
         committed_at = clock_timestamp()
   WHERE r.organization_id = organization_id AND r.operation = 'tenant.provider.update'
     AND r.key_hash = key_hash
   RETURNING r.committed_at INTO v_committed_at;
  INSERT INTO openarc_durable.audit_events (
    organization_id, actor_account_id, operation, mutation_id, resource_type, resource_id, outcome
  ) VALUES (
    organization_id, v_actor, 'tenant.provider.update', mutation_id, 'provider', provider_id, 'committed'
  );
  INSERT INTO openarc_durable.outbox_events (
    organization_id, mutation_id, resource_type, resource_id, event_type, payload_version
  ) VALUES (
    organization_id, mutation_id, 'provider', provider_id, 'tenant.provider.updated', 1
  );

  SELECT l.account_id INTO v_recheck
    FROM openarc_tenant.lock_auth_session(session_hash, NULL) AS l;
  IF v_recheck IS NULL OR v_recheck <> v_actor THEN
    RAISE EXCEPTION 'durable_session_invalid' USING ERRCODE = '28000';
  END IF;

  out_replayed := false;
  out_mutation_id := mutation_id;
  out_operation := 'tenant.provider.update';
  out_resource_type := 'provider';
  out_resource_id := provider_id;
  out_committed_at := v_committed_at;
  RETURN NEXT;
END;
$$;

-- ---------------------------------------------------------------------------
-- Durable membership set (intentional self-revocation aware).
-- ---------------------------------------------------------------------------
-- Resolves the caller provisionally, locks the caller + target accounts SORTED,
-- then the session, organization, caller and target memberships, and rechecks
-- active owner, fresh passkey/wallet proof and an active target. Returns the
-- bounded internal actor/role and the held proof timestamps so the TS layer can
-- compute the digest under these locks; it exposes no browser surface.
CREATE FUNCTION openarc_durable.lock_membership_set(
  session_hash text,
  organization_id text,
  target_account_id text
) RETURNS TABLE(
  out_actor text,
  out_role text,
  out_proof_created_at timestamptz,
  out_session_expires_at timestamptz
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
BEGIN
  IF session_hash IS NULL OR session_hash !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'durable_session_invalid' USING ERRCODE = '28000';
  END IF;
  IF NOT openarc_durable.is_canonical_org_id(organization_id) THEN
    RAISE EXCEPTION 'durable_organization_invalid' USING ERRCODE = '22023';
  END IF;
  IF target_account_id IS NULL OR target_account_id = '' OR char_length(target_account_id) > 200 THEN
    RAISE EXCEPTION 'durable_account_invalid' USING ERRCODE = '22023';
  END IF;

  SELECT s.account_id INTO v_actor FROM openarc_auth.sessions s WHERE s.token_hash = session_hash;
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'durable_session_invalid' USING ERRCODE = '28000';
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
  IF NOT FOUND OR v_session.method = 'recovery' THEN
    RAISE EXCEPTION 'durable_session_invalid' USING ERRCODE = '28000';
  END IF;

  PERFORM set_config('openarc.account_id', v_actor, true);
  PERFORM set_config('openarc.organization_id', organization_id, true);

  PERFORM 1 FROM openarc_tenant.organizations o
   WHERE o.organization_id = organization_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'durable_forbidden' USING ERRCODE = '42501';
  END IF;
  SELECT m.role, m.status INTO v_caller_role, v_caller_status
    FROM openarc_tenant.memberships m
   WHERE m.organization_id = organization_id AND m.account_id = v_actor FOR UPDATE;
  IF NOT FOUND OR v_caller_status <> 'active' OR v_caller_role <> 'owner' THEN
    RAISE EXCEPTION 'durable_forbidden' USING ERRCODE = '42501';
  END IF;
  PERFORM set_config('openarc.role', 'owner', true);
  PERFORM 1 FROM openarc_tenant.memberships m
   WHERE m.organization_id = organization_id AND m.account_id = target_account_id FOR UPDATE;

  SELECT s.account_id, s.method, s.created_at, s.expires_at INTO v_session
    FROM openarc_auth.sessions s
    JOIN openarc_auth.accounts a ON a.account_id = s.account_id
   WHERE s.token_hash = session_hash
     AND s.account_id = v_actor
     AND a.status = 'active'
     AND s.expires_at > clock_timestamp()
   FOR UPDATE OF s;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'durable_session_invalid' USING ERRCODE = '28000';
  END IF;
  SELECT clock_timestamp() INTO v_now;
  IF NOT (v_session.expires_at > v_now) THEN
    RAISE EXCEPTION 'durable_session_invalid' USING ERRCODE = '28000';
  END IF;
  IF NOT (v_session.created_at > v_now - interval '5 minutes') THEN
    RAISE EXCEPTION 'durable_proof_stale' USING ERRCODE = '28000';
  END IF;

  SELECT a.status INTO v_target_status FROM openarc_auth.accounts a
   WHERE a.account_id = target_account_id;
  IF v_target_status IS NULL THEN
    RAISE EXCEPTION 'durable_not_found' USING ERRCODE = '23503';
  END IF;
  IF v_target_status <> 'active' THEN
    RAISE EXCEPTION 'durable_session_invalid' USING ERRCODE = '28000';
  END IF;

  out_actor := v_actor;
  out_role := 'owner';
  out_proof_created_at := v_session.created_at;
  out_session_expires_at := v_session.expires_at;
  RETURN NEXT;
END;
$$;

CREATE FUNCTION openarc_durable.commit_membership_set(
  session_hash text,
  organization_id text,
  target_account_id text,
  requested_role text,
  requested_status text,
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
  v_proof_created_at timestamptz;
  v_session_expires_at timestamptz;
  v_existing record;
  v_before record;
  v_changed boolean;
  v_committed_at timestamptz;
  v_recheck text;
  v_self boolean;
  v_now timestamptz;
BEGIN
  IF NOT openarc_durable.is_canonical_org_id(organization_id) THEN
    RAISE EXCEPTION 'durable_organization_invalid' USING ERRCODE = '22023';
  END IF;
  IF requested_role IS NULL OR requested_role NOT IN
     ('owner', 'operator', 'provider_admin', 'provider_developer', 'viewer') THEN
    RAISE EXCEPTION 'durable_role_invalid' USING ERRCODE = '22023';
  END IF;
  IF requested_status IS NULL OR requested_status NOT IN ('active', 'suspended') THEN
    RAISE EXCEPTION 'durable_status_invalid' USING ERRCODE = '22023';
  END IF;
  IF mutation_id IS NULL THEN
    RAISE EXCEPTION 'durable_mutation_invalid' USING ERRCODE = '22023';
  END IF;
  IF key_hash IS NULL OR key_hash !~ '^[0-9a-f]{64}$'
     OR request_digest IS NULL OR request_digest !~ '^[0-9a-f]{64}$'
     OR session_context_digest IS NULL OR session_context_digest !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'durable_metadata_invalid' USING ERRCODE = '22023';
  END IF;

  -- Prelock the EXACT accepted order (sorted accounts -> session -> org ->
  -- memberships) here. set_membership below re-locks the same rows in the same
  -- order, so its repeated locks cannot invert order.
  SELECT l.out_actor, l.out_role, l.out_proof_created_at, l.out_session_expires_at
    INTO v_actor, v_role, v_proof_created_at, v_session_expires_at
    FROM openarc_durable.lock_membership_set(session_hash, organization_id, target_account_id) AS l;
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'durable_forbidden' USING ERRCODE = '42501';
  END IF;

  -- Replay lookup BEFORE changing membership (no-op or otherwise).
  SELECT * INTO v_existing
    FROM openarc_durable.idempotency_records r
   WHERE r.organization_id = organization_id AND r.operation = 'tenant.membership.set'
     AND r.key_hash = key_hash FOR UPDATE;
  IF FOUND THEN
    IF v_existing.request_digest = request_digest
       AND v_existing.mutation_id = mutation_id
       AND v_existing.actor_account_id = v_actor
       AND v_existing.session_context_digest = session_context_digest
       AND v_existing.status = 'committed' THEN
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
  PERFORM 1 FROM openarc_durable.idempotency_records r
   WHERE r.organization_id = organization_id AND r.mutation_id = mutation_id FOR UPDATE;
  IF FOUND THEN
    RAISE EXCEPTION 'durable_idempotency_conflict' USING ERRCODE = 'P0D01';
  END IF;

  SELECT m.role, m.status INTO v_before
    FROM openarc_tenant.memberships m
   WHERE m.organization_id = organization_id AND m.account_id = target_account_id;
  v_changed := v_before IS NULL
            OR v_before.role IS DISTINCT FROM requested_role
            OR v_before.status IS DISTINCT FROM requested_status;
  v_self := (target_account_id = v_actor);

  INSERT INTO openarc_durable.idempotency_records (
    organization_id, operation, key_hash, request_digest, digest_version,
    actor_account_id, session_context_digest, network, mutation_id, status
  ) VALUES (
    organization_id, 'tenant.membership.set', key_hash, request_digest, 'tenant.membership.set.v1',
    v_actor, session_context_digest, 'eip155:5042002', mutation_id, 'pending'
  );

  -- Reuse the accepted schema2 mutation/last-owner/target-session logic.
  PERFORM 1 FROM openarc_tenant.set_membership(
    session_hash, organization_id, target_account_id, requested_role, requested_status
  );

  UPDATE openarc_durable.idempotency_records r
     SET status = 'committed',
         resource_type = 'membership',
         resource_id = target_account_id,
         committed_at = clock_timestamp()
   WHERE r.organization_id = organization_id AND r.operation = 'tenant.membership.set'
     AND r.key_hash = key_hash
   RETURNING r.committed_at INTO v_committed_at;

  INSERT INTO openarc_durable.audit_events (
    organization_id, actor_account_id, operation, mutation_id, resource_type, resource_id, outcome
  ) VALUES (
    organization_id, v_actor, 'tenant.membership.set', mutation_id, 'membership', target_account_id, 'committed'
  );
  INSERT INTO openarc_durable.outbox_events (
    organization_id, mutation_id, resource_type, resource_id, event_type, payload_version
  ) VALUES (
    organization_id, mutation_id, 'membership', target_account_id, 'tenant.membership.set', 1
  );

  IF v_changed AND v_self THEN
    -- Intentional self-demotion/suspension revoked this very session. Recheck
    -- the captured proof/expiry against the FRESH DB clock and the held actor
    -- account only; do NOT perform an impossible live-session recheck.
    SELECT a.status INTO v_recheck FROM openarc_auth.accounts a WHERE a.account_id = v_actor;
    SELECT clock_timestamp() INTO v_now;
    IF v_recheck IS NULL OR v_recheck <> 'active'
       OR NOT (v_session_expires_at > v_now)
       OR NOT (v_proof_created_at > v_now - interval '5 minutes') THEN
      RAISE EXCEPTION 'durable_session_invalid' USING ERRCODE = '28000';
    END IF;
  ELSE
    SELECT l.account_id INTO v_recheck
      FROM openarc_tenant.lock_auth_session(session_hash, NULL) AS l;
    IF v_recheck IS NULL OR v_recheck <> v_actor THEN
      RAISE EXCEPTION 'durable_session_invalid' USING ERRCODE = '28000';
    END IF;
  END IF;

  out_replayed := false;
  out_mutation_id := mutation_id;
  out_operation := 'tenant.membership.set';
  out_resource_type := 'membership';
  out_resource_id := target_account_id;
  out_committed_at := v_committed_at;
  RETURN NEXT;
END;
$$;

-- ---------------------------------------------------------------------------
-- Durable status readers.
-- ---------------------------------------------------------------------------
CREATE FUNCTION openarc_durable.read_tenant_mutation_status(
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
  v_required text;
  v_operation text;
  v_recheck text;
  v_found boolean := false;
  v_mutation_id uuid;
  v_resource_type text;
  v_resource_id text;
  v_committed_at timestamptz;
BEGIN
  IF NOT openarc_durable.is_canonical_org_id(organization_id) THEN
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
   WHERE o.organization_id = organization_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'durable_forbidden' USING ERRCODE = '42501';
  END IF;
  SELECT m.role, m.status INTO v_role, v_status
    FROM openarc_tenant.memberships m
   WHERE m.organization_id = organization_id AND m.account_id = v_actor FOR UPDATE;
  IF NOT FOUND OR v_status <> 'active' THEN
    RAISE EXCEPTION 'durable_forbidden' USING ERRCODE = '42501';
  END IF;

  -- Operation-specific role constraint. provider/membership/organization are
  -- owner-only; agent is owner/operator.
  SELECT r.operation INTO v_operation
    FROM openarc_durable.idempotency_records r
   WHERE r.organization_id = organization_id AND r.mutation_id = mutation_id
     AND r.actor_account_id = v_actor AND r.status = 'committed';
  IF FOUND THEN
    v_required := CASE WHEN v_operation IN ('tenant.agent.create', 'tenant.agent.update')
                       THEN 'agent' ELSE 'owner' END;
    IF v_required = 'agent' THEN
      IF v_role NOT IN ('owner', 'operator') THEN
        RAISE EXCEPTION 'durable_forbidden' USING ERRCODE = '42501';
      END IF;
    ELSIF v_role <> 'owner' THEN
      RAISE EXCEPTION 'durable_forbidden' USING ERRCODE = '42501';
    END IF;
  END IF;

  SELECT l.account_id INTO v_recheck
    FROM openarc_tenant.lock_auth_session(session_hash, NULL) AS l;
  IF v_recheck IS NULL OR v_recheck <> v_actor THEN
    RAISE EXCEPTION 'durable_session_invalid' USING ERRCODE = '28000';
  END IF;

  PERFORM set_config('openarc.account_id', v_actor, true);
  PERFORM set_config('openarc.organization_id', organization_id, true);
  PERFORM set_config('openarc.role', v_role, true);

  SELECT r.mutation_id, r.operation, r.resource_type, r.resource_id, r.committed_at
    INTO v_mutation_id, v_operation, v_resource_type, v_resource_id, v_committed_at
    FROM openarc_durable.idempotency_records r
   WHERE r.organization_id = organization_id AND r.mutation_id = mutation_id
     AND r.actor_account_id = v_actor AND r.status = 'committed';
  v_found := FOUND;

  -- Recheck the SAME held session AFTER the final possibly blocking table read.
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

-- Bootstrap recovery: derives the organization from the mutation id, then
-- authorizes the CURRENT live account. A found receipt must belong to the same
-- actor and the current active owner membership of the created organization.
CREATE FUNCTION openarc_durable.read_organization_mutation_status(
  session_hash text,
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
  v_org text;
  v_recheck text;
  v_found boolean := false;
  v_mutation_id uuid;
  v_operation text;
  v_resource_type text;
  v_resource_id text;
  v_committed_at timestamptz;
BEGIN
  IF mutation_id IS NULL THEN
    RAISE EXCEPTION 'durable_mutation_invalid' USING ERRCODE = '22023';
  END IF;
  v_org := 'openarc:org:' || mutation_id::text;

  SELECT l.account_id INTO v_actor
    FROM openarc_tenant.lock_auth_session(session_hash, NULL) AS l;
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'durable_session_invalid' USING ERRCODE = '28000';
  END IF;

  -- The organization may not exist for an unknown/different-actor mutation; a
  -- missing organization is not_found after the live-session check, never a
  -- resource disclosure.
  IF EXISTS (SELECT 1 FROM openarc_tenant.organizations o WHERE o.organization_id = v_org) THEN
    PERFORM 1 FROM openarc_tenant.organizations o
     WHERE o.organization_id = v_org FOR UPDATE;
    SELECT m.role, m.status INTO v_role, v_status
      FROM openarc_tenant.memberships m
     WHERE m.organization_id = v_org AND m.account_id = v_actor FOR UPDATE;
  END IF;

  SELECT l.account_id INTO v_recheck
    FROM openarc_tenant.lock_auth_session(session_hash, NULL) AS l;
  IF v_recheck IS NULL OR v_recheck <> v_actor THEN
    RAISE EXCEPTION 'durable_session_invalid' USING ERRCODE = '28000';
  END IF;

  PERFORM set_config('openarc.account_id', v_actor, true);
  PERFORM set_config('openarc.organization_id', v_org, true);
  PERFORM set_config('openarc.role', coalesce(v_role, ''), true);

  SELECT r.mutation_id, r.operation, r.resource_type, r.resource_id, r.committed_at
    INTO v_mutation_id, v_operation, v_resource_type, v_resource_id, v_committed_at
    FROM openarc_durable.idempotency_records r
   WHERE r.organization_id = v_org AND r.mutation_id = mutation_id
     AND r.actor_account_id = v_actor
     AND r.operation = 'tenant.organization.create' AND r.status = 'committed';
  v_found := FOUND;

  -- Recheck the SAME held session after the final possibly blocking read.
  SELECT l.account_id INTO v_recheck
    FROM openarc_tenant.lock_auth_session(session_hash, NULL) AS l;
  IF v_recheck IS NULL OR v_recheck <> v_actor THEN
    RAISE EXCEPTION 'durable_session_invalid' USING ERRCODE = '28000';
  END IF;

  IF NOT v_found THEN
    RETURN;
  END IF;
  -- A found same-actor receipt with no current active owner membership is
  -- forbidden, never a bypass around tenant role state.
  IF v_role IS NULL OR v_status <> 'active' OR v_role <> 'owner' THEN
    RAISE EXCEPTION 'durable_forbidden' USING ERRCODE = '42501';
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
-- Privileges: revoke PUBLIC everywhere, grant the tenant runtime only the exact
-- required helper EXECUTE. No tenant direct durable DML.
-- ---------------------------------------------------------------------------
REVOKE ALL ON FUNCTION openarc_durable.is_canonical_org_id(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION openarc_durable.is_canonical_display_name(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION openarc_durable.commit_organization_create(text, text, uuid, text, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION openarc_durable.commit_agent_update(text, text, text, boolean, text, boolean, text, uuid, text, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION openarc_durable.commit_provider_create(text, text, text, uuid, text, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION openarc_durable.commit_provider_update(text, text, text, boolean, text, boolean, text, uuid, text, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION openarc_durable.lock_membership_set(text, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION openarc_durable.commit_membership_set(text, text, text, text, text, uuid, text, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION openarc_durable.read_tenant_mutation_status(text, text, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION openarc_durable.read_organization_mutation_status(text, uuid) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION openarc_durable.commit_organization_create(text, text, uuid, text, text, text) TO openarc_tenant_app;
GRANT EXECUTE ON FUNCTION openarc_durable.commit_agent_update(text, text, text, boolean, text, boolean, text, uuid, text, text, text) TO openarc_tenant_app;
GRANT EXECUTE ON FUNCTION openarc_durable.commit_provider_create(text, text, text, uuid, text, text, text) TO openarc_tenant_app;
GRANT EXECUTE ON FUNCTION openarc_durable.commit_provider_update(text, text, text, boolean, text, boolean, text, uuid, text, text, text) TO openarc_tenant_app;
GRANT EXECUTE ON FUNCTION openarc_durable.lock_membership_set(text, text, text) TO openarc_tenant_app;
GRANT EXECUTE ON FUNCTION openarc_durable.commit_membership_set(text, text, text, text, text, uuid, text, text, text) TO openarc_tenant_app;
GRANT EXECUTE ON FUNCTION openarc_durable.read_tenant_mutation_status(text, text, uuid) TO openarc_tenant_app;
GRANT EXECUTE ON FUNCTION openarc_durable.read_organization_mutation_status(text, uuid) TO openarc_tenant_app;
