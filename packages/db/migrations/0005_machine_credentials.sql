-- OpenArc durable machine credentials and scoped sessions (schema5).
-- Additive over schema4. See task.md P01-07b.
--
-- Owner: openarc_migrator. Runtime: openarc_tenant_app. Worker:
-- openarc_worker_app (pre-provisioned; this migration NEVER creates roles).
-- 0001-0004 are frozen: this migration only extends the closed unions, adds the
-- credential/session tables and their narrow definer helpers, and filters the
-- legacy generic status readers so a credential receipt cannot leak.
--
-- No raw token, pepper or pre-hash column exists. The SQL never computes a KDF
-- and never chooses a pepper.

-- ---------------------------------------------------------------------------
-- Shared credential validation helpers (must precede the table constraints).
-- ---------------------------------------------------------------------------
CREATE FUNCTION openarc_durable.is_canonical_base64url(value text, byte_length integer)
RETURNS boolean
LANGUAGE sql IMMUTABLE
SET search_path = pg_catalog
AS $$
  SELECT value IS NOT NULL
     AND value ~ '^[A-Za-z0-9_-]+$'
     AND char_length(value) = CASE byte_length
       WHEN 16 THEN 22
       WHEN 32 THEN 43
       ELSE -1
     END;
$$;

CREATE FUNCTION openarc_durable.is_canonical_uuid_v4(value text)
RETURNS boolean
LANGUAGE sql IMMUTABLE
SET search_path = pg_catalog
AS $$
  SELECT value IS NOT NULL
     AND value ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$';
$$;

CREATE FUNCTION openarc_durable.is_canonical_hex64(value text)
RETURNS boolean
LANGUAGE sql IMMUTABLE
SET search_path = pg_catalog
AS $$
  SELECT value IS NOT NULL AND value ~ '^[0-9a-f]{64}$';
$$;

-- ---------------------------------------------------------------------------
-- Machine credential tables.
-- ---------------------------------------------------------------------------
ALTER TABLE openarc_tenant.agents ADD CONSTRAINT agents_org_id_key UNIQUE (organization_id, agent_id);
ALTER TABLE openarc_tenant.providers ADD CONSTRAINT providers_org_id_key UNIQUE (organization_id, provider_id);

CREATE TABLE openarc_durable.agent_credentials (
  organization_id text NOT NULL REFERENCES openarc_tenant.organizations(organization_id) ON DELETE RESTRICT,
  credential_id uuid NOT NULL,
  lookup_id uuid NOT NULL,
  agent_id text NOT NULL,
  issuer_account_id text NOT NULL REFERENCES openarc_auth.accounts(account_id) ON DELETE RESTRICT,
  scope text NOT NULL,
  scope_version integer NOT NULL DEFAULT 1,
  environment text NOT NULL,
  algorithm text NOT NULL,
  hash_version integer NOT NULL,
  pepper_version integer NOT NULL,
  kdf_n integer NOT NULL,
  kdf_r integer NOT NULL,
  kdf_p integer NOT NULL,
  salt text NOT NULL,
  digest text NOT NULL,
  key_prefix text NOT NULL,
  revocation_version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  PRIMARY KEY (organization_id, credential_id),
  CONSTRAINT agent_credentials_lookup_unique UNIQUE (lookup_id),
  CONSTRAINT agent_credentials_profile_fk FOREIGN KEY (organization_id, agent_id)
    REFERENCES openarc_tenant.agents(organization_id, agent_id) ON DELETE RESTRICT,
  CONSTRAINT agent_credentials_issuer_membership_fk FOREIGN KEY (organization_id, issuer_account_id)
    REFERENCES openarc_tenant.memberships(organization_id, account_id) ON DELETE RESTRICT,
  CONSTRAINT agent_credentials_scope_valid CHECK (scope = 'agent:self.read' AND scope_version = 1),
  CONSTRAINT agent_credentials_environment_valid CHECK (environment = 'eip155:5042002'),
  CONSTRAINT agent_credentials_algorithm_valid CHECK (algorithm = 'scrypt' AND hash_version = 1),
  CONSTRAINT agent_credentials_pepper_version_valid CHECK (pepper_version BETWEEN 1 AND 16),
  CONSTRAINT agent_credentials_kdf_valid CHECK (kdf_n = 32768 AND kdf_r = 8 AND kdf_p = 1),
  CONSTRAINT agent_credentials_salt_valid CHECK (openarc_durable.is_canonical_base64url(salt, 16)),
  CONSTRAINT agent_credentials_digest_valid CHECK (openarc_durable.is_canonical_base64url(digest, 32)),
  CONSTRAINT agent_credentials_prefix_valid CHECK (key_prefix = 'oac_ag_' || lookup_id::text),
  CONSTRAINT agent_credentials_revocation_version_valid CHECK (revocation_version >= 1),
  CONSTRAINT agent_credentials_revocation_shape CHECK (
    (revoked_at IS NULL AND revocation_version = 1)
    OR (revoked_at IS NOT NULL AND revocation_version >= 1)
  ),
  CONSTRAINT agent_credentials_expiry_valid CHECK (
    expires_at > created_at AND expires_at <= created_at + interval '90 days'
  )
);

CREATE TABLE openarc_durable.provider_credentials (
  organization_id text NOT NULL REFERENCES openarc_tenant.organizations(organization_id) ON DELETE RESTRICT,
  credential_id uuid NOT NULL,
  lookup_id uuid NOT NULL,
  provider_id text NOT NULL,
  issuer_account_id text NOT NULL REFERENCES openarc_auth.accounts(account_id) ON DELETE RESTRICT,
  scope text NOT NULL,
  scope_version integer NOT NULL DEFAULT 1,
  environment text NOT NULL,
  algorithm text NOT NULL,
  hash_version integer NOT NULL,
  pepper_version integer NOT NULL,
  kdf_n integer NOT NULL,
  kdf_r integer NOT NULL,
  kdf_p integer NOT NULL,
  salt text NOT NULL,
  digest text NOT NULL,
  key_prefix text NOT NULL,
  revocation_version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  PRIMARY KEY (organization_id, credential_id),
  CONSTRAINT provider_credentials_lookup_unique UNIQUE (lookup_id),
  CONSTRAINT provider_credentials_profile_fk FOREIGN KEY (organization_id, provider_id)
    REFERENCES openarc_tenant.providers(organization_id, provider_id) ON DELETE RESTRICT,
  CONSTRAINT provider_credentials_issuer_membership_fk FOREIGN KEY (organization_id, issuer_account_id)
    REFERENCES openarc_tenant.memberships(organization_id, account_id) ON DELETE RESTRICT,
  CONSTRAINT provider_credentials_scope_valid CHECK (scope = 'provider:self.read' AND scope_version = 1),
  CONSTRAINT provider_credentials_environment_valid CHECK (environment = 'eip155:5042002'),
  CONSTRAINT provider_credentials_algorithm_valid CHECK (algorithm = 'scrypt' AND hash_version = 1),
  CONSTRAINT provider_credentials_pepper_version_valid CHECK (pepper_version BETWEEN 1 AND 16),
  CONSTRAINT provider_credentials_kdf_valid CHECK (kdf_n = 32768 AND kdf_r = 8 AND kdf_p = 1),
  CONSTRAINT provider_credentials_salt_valid CHECK (openarc_durable.is_canonical_base64url(salt, 16)),
  CONSTRAINT provider_credentials_digest_valid CHECK (openarc_durable.is_canonical_base64url(digest, 32)),
  CONSTRAINT provider_credentials_prefix_valid CHECK (key_prefix = 'oac_pr_' || lookup_id::text),
  CONSTRAINT provider_credentials_revocation_version_valid CHECK (revocation_version >= 1),
  CONSTRAINT provider_credentials_revocation_shape CHECK (
    (revoked_at IS NULL AND revocation_version = 1)
    OR (revoked_at IS NOT NULL AND revocation_version >= 1)
  ),
  CONSTRAINT provider_credentials_expiry_valid CHECK (
    expires_at > created_at AND expires_at <= created_at + interval '90 days'
  )
);

-- ---------------------------------------------------------------------------
-- Scoped machine session tables.
-- ---------------------------------------------------------------------------
CREATE TABLE openarc_durable.agent_sessions (
  session_id uuid NOT NULL,
  token_hash text NOT NULL,
  organization_id text NOT NULL REFERENCES openarc_tenant.organizations(organization_id) ON DELETE RESTRICT,
  agent_id text NOT NULL,
  credential_id uuid NOT NULL,
  scope text NOT NULL,
  scope_version integer NOT NULL,
  environment text NOT NULL,
  revocation_version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  PRIMARY KEY (token_hash),
  CONSTRAINT agent_sessions_id_unique UNIQUE (session_id),
  CONSTRAINT agent_sessions_credential_fk FOREIGN KEY (organization_id, credential_id)
    REFERENCES openarc_durable.agent_credentials(organization_id, credential_id) ON DELETE RESTRICT,
  CONSTRAINT agent_sessions_profile_fk FOREIGN KEY (organization_id, agent_id)
    REFERENCES openarc_tenant.agents(organization_id, agent_id) ON DELETE RESTRICT,
  CONSTRAINT agent_sessions_scope_valid CHECK (scope = 'agent:self.read' AND scope_version = 1),
  CONSTRAINT agent_sessions_environment_valid CHECK (environment = 'eip155:5042002'),
  CONSTRAINT agent_sessions_token_hash_format CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT agent_sessions_revocation_version_valid CHECK (revocation_version >= 1),
  CONSTRAINT agent_sessions_revocation_shape CHECK (
    (revoked_at IS NULL AND revocation_version = 1)
    OR (revoked_at IS NOT NULL AND revocation_version >= 1)
  ),
  CONSTRAINT agent_sessions_expiry_valid CHECK (
    expires_at > created_at AND expires_at <= created_at + interval '15 minutes'
  )
);

CREATE TABLE openarc_durable.provider_sessions (
  session_id uuid NOT NULL,
  token_hash text NOT NULL,
  organization_id text NOT NULL REFERENCES openarc_tenant.organizations(organization_id) ON DELETE RESTRICT,
  provider_id text NOT NULL,
  credential_id uuid NOT NULL,
  scope text NOT NULL,
  scope_version integer NOT NULL,
  environment text NOT NULL,
  revocation_version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  PRIMARY KEY (token_hash),
  CONSTRAINT provider_sessions_id_unique UNIQUE (session_id),
  CONSTRAINT provider_sessions_credential_fk FOREIGN KEY (organization_id, credential_id)
    REFERENCES openarc_durable.provider_credentials(organization_id, credential_id) ON DELETE RESTRICT,
  CONSTRAINT provider_sessions_profile_fk FOREIGN KEY (organization_id, provider_id)
    REFERENCES openarc_tenant.providers(organization_id, provider_id) ON DELETE RESTRICT,
  CONSTRAINT provider_sessions_scope_valid CHECK (scope = 'provider:self.read' AND scope_version = 1),
  CONSTRAINT provider_sessions_environment_valid CHECK (environment = 'eip155:5042002'),
  CONSTRAINT provider_sessions_token_hash_format CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT provider_sessions_revocation_version_valid CHECK (revocation_version >= 1),
  CONSTRAINT provider_sessions_revocation_shape CHECK (
    (revoked_at IS NULL AND revocation_version = 1)
    OR (revoked_at IS NOT NULL AND revocation_version >= 1)
  ),
  CONSTRAINT provider_sessions_expiry_valid CHECK (
    expires_at > created_at AND expires_at <= created_at + interval '15 minutes'
  )
);

CREATE INDEX agent_credentials_org_profile_idx
  ON openarc_durable.agent_credentials (organization_id, agent_id, credential_id);
CREATE INDEX provider_credentials_org_profile_idx
  ON openarc_durable.provider_credentials (organization_id, provider_id, credential_id);
CREATE INDEX agent_sessions_credential_idx
  ON openarc_durable.agent_sessions (organization_id, credential_id);
CREATE INDEX provider_sessions_credential_idx
  ON openarc_durable.provider_sessions (organization_id, credential_id);

-- ---------------------------------------------------------------------------
-- Closed operation / resource / event union additions.
-- ---------------------------------------------------------------------------
ALTER TABLE openarc_durable.idempotency_records
  DROP CONSTRAINT idempotency_operation_valid,
  DROP CONSTRAINT idempotency_digest_version_valid,
  DROP CONSTRAINT idempotency_resource_type_valid,
  DROP CONSTRAINT idempotency_resource_matches_operation;

ALTER TABLE openarc_durable.idempotency_records
  ADD CONSTRAINT idempotency_operation_valid CHECK (operation IN (
    'tenant.organization.create',
    'tenant.agent.create',
    'tenant.agent.update',
    'tenant.provider.create',
    'tenant.provider.update',
    'tenant.membership.set',
    'tenant.agent.credential.issue',
    'tenant.agent.credential.revoke',
    'tenant.provider.credential.issue',
    'tenant.provider.credential.revoke'
  )),
  ADD CONSTRAINT idempotency_digest_version_valid CHECK (digest_version IN (
    'tenant.organization.create.v1',
    'tenant.agent.create.v1',
    'tenant.agent.update.v1',
    'tenant.provider.create.v1',
    'tenant.provider.update.v1',
    'tenant.membership.set.v1',
    'tenant.agent.credential.issue.v1',
    'tenant.agent.credential.revoke.v1',
    'tenant.provider.credential.issue.v1',
    'tenant.provider.credential.revoke.v1'
  )),
  ADD CONSTRAINT idempotency_resource_type_valid CHECK (resource_type IS NULL OR resource_type IN (
    'organization', 'agent', 'provider', 'membership',
    'agent_credential', 'provider_credential'
  )),
  ADD CONSTRAINT idempotency_resource_matches_operation CHECK (
    resource_type IS NULL OR resource_type = CASE operation
      WHEN 'tenant.organization.create' THEN 'organization'
      WHEN 'tenant.agent.create' THEN 'agent'
      WHEN 'tenant.agent.update' THEN 'agent'
      WHEN 'tenant.provider.create' THEN 'provider'
      WHEN 'tenant.provider.update' THEN 'provider'
      WHEN 'tenant.membership.set' THEN 'membership'
      WHEN 'tenant.agent.credential.issue' THEN 'agent_credential'
      WHEN 'tenant.agent.credential.revoke' THEN 'agent_credential'
      WHEN 'tenant.provider.credential.issue' THEN 'provider_credential'
      WHEN 'tenant.provider.credential.revoke' THEN 'provider_credential'
    END
  );

ALTER TABLE openarc_durable.idempotency_records
  ADD COLUMN agent_credential_id uuid GENERATED ALWAYS AS (
    CASE WHEN resource_type = 'agent_credential' THEN resource_id::uuid END
  ) STORED,
  ADD COLUMN provider_credential_id uuid GENERATED ALWAYS AS (
    CASE WHEN resource_type = 'provider_credential' THEN resource_id::uuid END
  ) STORED,
  ADD CONSTRAINT idempotency_agent_credential_fk FOREIGN KEY (organization_id, agent_credential_id)
    REFERENCES openarc_durable.agent_credentials(organization_id, credential_id) ON DELETE RESTRICT,
  ADD CONSTRAINT idempotency_provider_credential_fk FOREIGN KEY (organization_id, provider_credential_id)
    REFERENCES openarc_durable.provider_credentials(organization_id, credential_id) ON DELETE RESTRICT;

ALTER TABLE openarc_durable.audit_events
  DROP CONSTRAINT audit_operation_valid,
  DROP CONSTRAINT audit_resource_type_valid,
  DROP CONSTRAINT audit_resource_matches_operation;

ALTER TABLE openarc_durable.audit_events
  ADD CONSTRAINT audit_operation_valid CHECK (operation IN (
    'tenant.organization.create',
    'tenant.agent.create',
    'tenant.agent.update',
    'tenant.provider.create',
    'tenant.provider.update',
    'tenant.membership.set',
    'tenant.agent.credential.issue',
    'tenant.agent.credential.revoke',
    'tenant.provider.credential.issue',
    'tenant.provider.credential.revoke'
  )),
  ADD CONSTRAINT audit_resource_type_valid CHECK (resource_type IN (
    'organization', 'agent', 'provider', 'membership',
    'agent_credential', 'provider_credential'
  )),
  ADD CONSTRAINT audit_resource_matches_operation CHECK (
    resource_type = CASE operation
      WHEN 'tenant.organization.create' THEN 'organization'
      WHEN 'tenant.agent.create' THEN 'agent'
      WHEN 'tenant.agent.update' THEN 'agent'
      WHEN 'tenant.provider.create' THEN 'provider'
      WHEN 'tenant.provider.update' THEN 'provider'
      WHEN 'tenant.membership.set' THEN 'membership'
      WHEN 'tenant.agent.credential.issue' THEN 'agent_credential'
      WHEN 'tenant.agent.credential.revoke' THEN 'agent_credential'
      WHEN 'tenant.provider.credential.issue' THEN 'provider_credential'
      WHEN 'tenant.provider.credential.revoke' THEN 'provider_credential'
    END
  );

ALTER TABLE openarc_durable.audit_events
  ADD COLUMN agent_credential_id uuid GENERATED ALWAYS AS (
    CASE WHEN resource_type = 'agent_credential' THEN resource_id::uuid END
  ) STORED,
  ADD COLUMN provider_credential_id uuid GENERATED ALWAYS AS (
    CASE WHEN resource_type = 'provider_credential' THEN resource_id::uuid END
  ) STORED,
  ADD CONSTRAINT audit_agent_credential_fk FOREIGN KEY (organization_id, agent_credential_id)
    REFERENCES openarc_durable.agent_credentials(organization_id, credential_id) ON DELETE RESTRICT,
  ADD CONSTRAINT audit_provider_credential_fk FOREIGN KEY (organization_id, provider_credential_id)
    REFERENCES openarc_durable.provider_credentials(organization_id, credential_id) ON DELETE RESTRICT;

ALTER TABLE openarc_durable.outbox_events
  DROP CONSTRAINT outbox_resource_type_valid,
  DROP CONSTRAINT outbox_event_type_valid,
  DROP CONSTRAINT outbox_resource_matches_event,
  DROP CONSTRAINT outbox_receipt_fk;

ALTER TABLE openarc_durable.outbox_events
  ADD CONSTRAINT outbox_resource_type_valid CHECK (resource_type IN (
    'organization', 'agent', 'provider', 'membership',
    'agent_credential', 'provider_credential'
  )),
  ADD CONSTRAINT outbox_event_type_valid CHECK (event_type IN (
    'tenant.organization.created',
    'tenant.agent.created',
    'tenant.agent.updated',
    'tenant.provider.created',
    'tenant.provider.updated',
    'tenant.membership.set',
    'tenant.agent.credential.created',
    'tenant.agent.credential.revoked',
    'tenant.provider.credential.created',
    'tenant.provider.credential.revoked'
  ));

ALTER TABLE openarc_durable.outbox_events
  DROP COLUMN receipt_operation;
ALTER TABLE openarc_durable.outbox_events
  ADD COLUMN receipt_operation text GENERATED ALWAYS AS (
    CASE event_type
      WHEN 'tenant.organization.created' THEN 'tenant.organization.create'
      WHEN 'tenant.agent.created' THEN 'tenant.agent.create'
      WHEN 'tenant.agent.updated' THEN 'tenant.agent.update'
      WHEN 'tenant.provider.created' THEN 'tenant.provider.create'
      WHEN 'tenant.provider.updated' THEN 'tenant.provider.update'
      WHEN 'tenant.membership.set' THEN 'tenant.membership.set'
      WHEN 'tenant.agent.credential.created' THEN 'tenant.agent.credential.issue'
      WHEN 'tenant.agent.credential.revoked' THEN 'tenant.agent.credential.revoke'
      WHEN 'tenant.provider.credential.created' THEN 'tenant.provider.credential.issue'
      WHEN 'tenant.provider.credential.revoked' THEN 'tenant.provider.credential.revoke'
    END
  ) STORED;

ALTER TABLE openarc_durable.outbox_events
  ADD CONSTRAINT outbox_resource_matches_event CHECK (
    resource_type = CASE event_type
      WHEN 'tenant.organization.created' THEN 'organization'
      WHEN 'tenant.agent.created' THEN 'agent'
      WHEN 'tenant.agent.updated' THEN 'agent'
      WHEN 'tenant.provider.created' THEN 'provider'
      WHEN 'tenant.provider.updated' THEN 'provider'
      WHEN 'tenant.membership.set' THEN 'membership'
      WHEN 'tenant.agent.credential.created' THEN 'agent_credential'
      WHEN 'tenant.agent.credential.revoked' THEN 'agent_credential'
      WHEN 'tenant.provider.credential.created' THEN 'provider_credential'
      WHEN 'tenant.provider.credential.revoked' THEN 'provider_credential'
    END
  ),
  ADD CONSTRAINT outbox_receipt_fk FOREIGN KEY (
    organization_id, mutation_id, resource_type, resource_id, receipt_operation
  ) REFERENCES openarc_durable.idempotency_records (
    organization_id, mutation_id, resource_type, resource_id, operation
  ) ON DELETE RESTRICT;

ALTER TABLE openarc_durable.outbox_events
  ADD COLUMN agent_credential_id uuid GENERATED ALWAYS AS (
    CASE WHEN resource_type = 'agent_credential' THEN resource_id::uuid END
  ) STORED,
  ADD COLUMN provider_credential_id uuid GENERATED ALWAYS AS (
    CASE WHEN resource_type = 'provider_credential' THEN resource_id::uuid END
  ) STORED,
  ADD CONSTRAINT outbox_agent_credential_fk FOREIGN KEY (organization_id, agent_credential_id)
    REFERENCES openarc_durable.agent_credentials(organization_id, credential_id) ON DELETE RESTRICT,
  ADD CONSTRAINT outbox_provider_credential_fk FOREIGN KEY (organization_id, provider_credential_id)
    REFERENCES openarc_durable.provider_credentials(organization_id, credential_id) ON DELETE RESTRICT;

-- ---------------------------------------------------------------------------
-- Credential issuer resolution (shared internal lock preamble).
-- ---------------------------------------------------------------------------
CREATE FUNCTION openarc_durable.lock_credential_issuer(
  session_hash text,
  organization_id text,
  kind text,
  profile_id text,
  require_issue_proof boolean
) RETURNS TABLE(
  out_actor text,
  out_role text,
  out_profile_status text,
  out_session_created_at timestamptz,
  out_session_expires_at timestamptz
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
  v_profile_status text;
  v_created_at timestamptz;
  v_expires_at timestamptz;
  v_method text;
  v_now timestamptz;
BEGIN
  IF kind IS NULL OR kind NOT IN ('agent', 'provider') THEN
    RAISE EXCEPTION 'durable_kind_invalid' USING ERRCODE = '22023';
  END IF;
  IF NOT openarc_durable.is_canonical_org_id(organization_id) THEN
    RAISE EXCEPTION 'durable_organization_invalid' USING ERRCODE = '22023';
  END IF;
  IF require_issue_proof IS NULL THEN
    RAISE EXCEPTION 'durable_session_invalid' USING ERRCODE = '28000';
  END IF;
  IF kind = 'agent' THEN
    IF profile_id IS NULL OR profile_id !~ '^openarc:agent:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' THEN
      RAISE EXCEPTION 'durable_agent_invalid' USING ERRCODE = '22023';
    END IF;
  ELSE
    IF profile_id IS NULL OR profile_id !~ '^openarc:provider:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' THEN
      RAISE EXCEPTION 'durable_provider_invalid' USING ERRCODE = '22023';
    END IF;
  END IF;

  SELECT l.account_id, l.method, l.session_created_at, l.session_expires_at
    INTO v_actor, v_method, v_created_at, v_expires_at
    FROM openarc_tenant.lock_auth_session(session_hash, NULL) AS l;
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'durable_session_invalid' USING ERRCODE = '28000';
  END IF;
  IF require_issue_proof AND v_method = 'recovery' THEN
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
  IF kind = 'provider' THEN
    IF v_role <> 'owner' THEN
      RAISE EXCEPTION 'durable_forbidden' USING ERRCODE = '42501';
    END IF;
  ELSIF v_role NOT IN ('owner', 'operator') THEN
    RAISE EXCEPTION 'durable_forbidden' USING ERRCODE = '42501';
  END IF;
  PERFORM set_config('openarc.account_id', v_actor, true);
  PERFORM set_config('openarc.organization_id', organization_id, true);
  PERFORM set_config('openarc.role', 'owner', true);

  IF kind = 'agent' THEN
    SELECT a.status INTO v_profile_status FROM openarc_tenant.agents a
     WHERE a.organization_id = organization_id AND a.agent_id = profile_id FOR UPDATE;
  ELSE
    SELECT p.status INTO v_profile_status FROM openarc_tenant.providers p
     WHERE p.organization_id = organization_id AND p.provider_id = profile_id FOR UPDATE;
  END IF;
  IF v_profile_status IS NULL THEN
    RAISE EXCEPTION 'durable_not_found' USING ERRCODE = '23503';
  END IF;
  IF v_profile_status <> 'active' THEN
    RAISE EXCEPTION 'durable_forbidden' USING ERRCODE = '42501';
  END IF;

  SELECT l.account_id, l.session_created_at, l.session_expires_at
    INTO v_actor, v_created_at, v_expires_at
    FROM openarc_tenant.lock_auth_session(session_hash, NULL) AS l;
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'durable_session_invalid' USING ERRCODE = '28000';
  END IF;
  SELECT clock_timestamp() INTO v_now;
  IF NOT (v_expires_at > v_now) THEN
    RAISE EXCEPTION 'durable_session_invalid' USING ERRCODE = '28000';
  END IF;
  IF require_issue_proof AND NOT (v_created_at > v_now - interval '5 minutes') THEN
    RAISE EXCEPTION 'durable_proof_stale' USING ERRCODE = '28000';
  END IF;

  out_actor := v_actor;
  out_role := v_role;
  out_profile_status := v_profile_status;
  out_session_created_at := v_created_at;
  out_session_expires_at := v_expires_at;
  RETURN NEXT;
END;
$$;

CREATE FUNCTION openarc_durable.commit_agent_credential_issue(
  session_hash text,
  organization_id text,
  agent_id text,
  credential_id uuid,
  lookup_id uuid,
  key_prefix text,
  pepper_version integer,
  salt text,
  digest text,
  expires_at timestamptz,
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
  v_session_created_at timestamptz;
  v_session_expires_at timestamptz;
  v_existing record;
  v_committed_at timestamptz;
  v_recheck text;
  v_now timestamptz;
BEGIN
  IF credential_id IS NULL OR NOT openarc_durable.is_canonical_uuid_v4(credential_id::text) THEN
    RAISE EXCEPTION 'durable_credential_invalid' USING ERRCODE = '22023';
  END IF;
  IF lookup_id IS NULL OR NOT openarc_durable.is_canonical_uuid_v4(lookup_id::text) THEN
    RAISE EXCEPTION 'durable_lookup_invalid' USING ERRCODE = '22023';
  END IF;
  IF key_prefix IS DISTINCT FROM 'oac_ag_' || lookup_id::text THEN
    RAISE EXCEPTION 'durable_prefix_invalid' USING ERRCODE = '22023';
  END IF;
  IF pepper_version IS NULL OR pepper_version NOT BETWEEN 1 AND 16 THEN
    RAISE EXCEPTION 'durable_pepper_invalid' USING ERRCODE = '22023';
  END IF;
  IF NOT openarc_durable.is_canonical_base64url(salt, 16) THEN
    RAISE EXCEPTION 'durable_salt_invalid' USING ERRCODE = '22023';
  END IF;
  IF NOT openarc_durable.is_canonical_base64url(digest, 32) THEN
    RAISE EXCEPTION 'durable_digest_invalid' USING ERRCODE = '22023';
  END IF;
  IF expires_at IS NULL THEN
    RAISE EXCEPTION 'durable_expiry_invalid' USING ERRCODE = '22023';
  END IF;
  IF mutation_id IS NULL OR NOT openarc_durable.is_canonical_uuid_v4(mutation_id::text) THEN
    RAISE EXCEPTION 'durable_mutation_invalid' USING ERRCODE = '22023';
  END IF;
  IF NOT openarc_durable.is_canonical_hex64(key_hash)
     OR NOT openarc_durable.is_canonical_hex64(request_digest)
     OR NOT openarc_durable.is_canonical_hex64(session_context_digest) THEN
    RAISE EXCEPTION 'durable_metadata_invalid' USING ERRCODE = '22023';
  END IF;
  SELECT l.out_actor, l.out_role, l.out_session_created_at, l.out_session_expires_at
    INTO v_actor, v_role, v_session_created_at, v_session_expires_at
    FROM openarc_durable.lock_credential_issuer(session_hash, organization_id, 'agent', agent_id, true) AS l;
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'durable_forbidden' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_existing
    FROM openarc_durable.idempotency_records r
   WHERE r.organization_id = organization_id AND r.operation = 'tenant.agent.credential.issue'
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

  INSERT INTO openarc_durable.idempotency_records (
    organization_id, operation, key_hash, request_digest, digest_version,
    actor_account_id, session_context_digest, network, mutation_id, status
  ) VALUES (
    organization_id, 'tenant.agent.credential.issue', key_hash, request_digest,
    'tenant.agent.credential.issue.v1', v_actor, session_context_digest,
    'eip155:5042002', mutation_id, 'pending'
  );
  INSERT INTO openarc_durable.agent_credentials (
    organization_id, credential_id, lookup_id, agent_id, issuer_account_id,
    scope, scope_version, environment, algorithm, hash_version, pepper_version,
    kdf_n, kdf_r, kdf_p, salt, digest, key_prefix, expires_at
  ) VALUES (
    organization_id, credential_id, lookup_id, agent_id, v_actor,
    'agent:self.read', 1, 'eip155:5042002', 'scrypt', 1, pepper_version,
    32768, 8, 1, salt, digest, key_prefix, expires_at
  );
  UPDATE openarc_durable.idempotency_records r
     SET status = 'committed', resource_type = 'agent_credential',
         resource_id = credential_id::text, committed_at = clock_timestamp()
   WHERE r.organization_id = organization_id AND r.operation = 'tenant.agent.credential.issue'
     AND r.key_hash = key_hash
   RETURNING r.committed_at INTO v_committed_at;
  INSERT INTO openarc_durable.audit_events (
    organization_id, actor_account_id, operation, mutation_id, resource_type, resource_id, outcome
  ) VALUES (
    organization_id, v_actor, 'tenant.agent.credential.issue', mutation_id,
    'agent_credential', credential_id::text, 'committed'
  );
  INSERT INTO openarc_durable.outbox_events (
    organization_id, mutation_id, resource_type, resource_id, event_type, payload_version
  ) VALUES (
    organization_id, mutation_id, 'agent_credential', credential_id::text,
    'tenant.agent.credential.created', 1
  );

  SELECT l.account_id INTO v_recheck
    FROM openarc_tenant.lock_auth_session(session_hash, NULL) AS l;
  IF v_recheck IS NULL OR v_recheck <> v_actor THEN
    RAISE EXCEPTION 'durable_session_invalid' USING ERRCODE = '28000';
  END IF;
  SELECT clock_timestamp() INTO v_now;
  IF NOT (expires_at > v_now) OR expires_at > v_now + interval '90 days' THEN
    RAISE EXCEPTION 'durable_expiry_invalid' USING ERRCODE = '22023';
  END IF;
  IF NOT (v_session_created_at > v_now - interval '5 minutes') THEN
    RAISE EXCEPTION 'durable_proof_stale' USING ERRCODE = '28000';
  END IF;

  out_replayed := false;
  out_mutation_id := mutation_id;
  out_operation := 'tenant.agent.credential.issue';
  out_resource_type := 'agent_credential';
  out_resource_id := credential_id::text;
  out_committed_at := v_committed_at;
  RETURN NEXT;
END;
$$;

-- Function privileges are declared once at the END of this migration, after
-- every function exists. See the trailing privileges section.

-- ---------------------------------------------------------------------------
-- Credential list readers (metadata only, no hash/prefix secret fields leaked
-- beyond the already-public key_prefix binding; never the digest/salt).
-- ---------------------------------------------------------------------------
CREATE FUNCTION openarc_durable.list_agent_credentials(
  session_hash text,
  organization_id text,
  agent_id text,
  after_credential_id uuid,
  page_limit integer
) RETURNS TABLE(
  out_credential_id uuid,
  out_lookup_id uuid,
  out_agent_id text,
  out_scope text,
  out_environment text,
  out_key_prefix text,
  out_created_at timestamptz,
  out_expires_at timestamptz,
  out_revoked_at timestamptz,
  out_status text
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
  v_profile_status text;
  v_recheck text;
  v_limit integer;
BEGIN
  IF NOT openarc_durable.is_canonical_org_id(organization_id) THEN
    RAISE EXCEPTION 'durable_organization_invalid' USING ERRCODE = '22023';
  END IF;
  IF agent_id IS NULL OR agent_id !~ '^openarc:agent:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' THEN
    RAISE EXCEPTION 'durable_agent_invalid' USING ERRCODE = '22023';
  END IF;
  IF page_limit IS NULL OR page_limit < 1 OR page_limit > 50 THEN
    RAISE EXCEPTION 'durable_page_invalid' USING ERRCODE = '22023';
  END IF;
  v_limit := page_limit;
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
  PERFORM set_config('openarc.account_id', v_actor, true);
  PERFORM set_config('openarc.organization_id', organization_id, true);
  PERFORM set_config('openarc.role', v_role, true);
  SELECT a.status INTO v_profile_status FROM openarc_tenant.agents a
   WHERE a.organization_id = organization_id AND a.agent_id = agent_id FOR UPDATE;
  IF v_profile_status IS NULL THEN
    RAISE EXCEPTION 'durable_not_found' USING ERRCODE = '23503';
  END IF;
  SELECT l.account_id INTO v_recheck
    FROM openarc_tenant.lock_auth_session(session_hash, NULL) AS l;
  IF v_recheck IS NULL OR v_recheck <> v_actor THEN
    RAISE EXCEPTION 'durable_session_invalid' USING ERRCODE = '28000';
  END IF;
  RETURN QUERY
    SELECT c.credential_id, c.lookup_id, c.agent_id, c.scope, c.environment,
           c.key_prefix, c.created_at, c.expires_at, c.revoked_at,
           CASE
             WHEN c.revoked_at IS NOT NULL THEN 'revoked'
             WHEN c.expires_at <= clock_timestamp() THEN 'expired'
             ELSE 'active'
           END
      FROM openarc_durable.agent_credentials c
     WHERE c.organization_id = organization_id AND c.agent_id = agent_id
       AND (after_credential_id IS NULL OR c.credential_id > after_credential_id)
     ORDER BY c.credential_id
     LIMIT v_limit;
END;
$$;

-- ---------------------------------------------------------------------------
-- Verifier readers: bounded internal hash+binding+immutable version snapshot
-- for the trusted API only. Reading this is not an auth claim; the API must
-- verify the scrypt digest before any exchange.
-- ---------------------------------------------------------------------------
CREATE FUNCTION openarc_durable.find_agent_credential_verifier(lookup_id uuid)
RETURNS TABLE(
  out_organization_id text,
  out_credential_id uuid,
  out_agent_id text,
  out_issuer_account_id text,
  out_scope text,
  out_scope_version integer,
  out_environment text,
  out_algorithm text,
  out_hash_version integer,
  out_pepper_version integer,
  out_kdf_n integer,
  out_kdf_r integer,
  out_kdf_p integer,
  out_salt text,
  out_digest text,
  out_key_prefix text,
  out_revocation_version integer,
  out_expires_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
#variable_conflict use_variable
DECLARE
  v_org text;
  v_credential_id uuid;
  v_agent_id text;
  v_issuer text;
  v_role text;
  v_now timestamptz;
  v_hash record;
BEGIN
  IF lookup_id IS NULL OR NOT openarc_durable.is_canonical_uuid_v4(lookup_id::text) THEN
    RAISE EXCEPTION 'durable_lookup_invalid' USING ERRCODE = '22023';
  END IF;
  -- Resolve identifiers WITHOUT a lock, then acquire every binding in the
  -- accepted order: account -> organization -> membership -> profile ->
  -- credential. Never authorize from this prelock snapshot.
  SELECT c.organization_id, c.credential_id, c.agent_id, c.issuer_account_id
    INTO v_org, v_credential_id, v_agent_id, v_issuer
    FROM openarc_durable.agent_credentials c
   WHERE c.lookup_id = lookup_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'durable_not_found' USING ERRCODE = '23503';
  END IF;
  PERFORM 1 FROM openarc_auth.accounts a
   WHERE a.account_id = v_issuer AND a.status = 'active' FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'durable_forbidden' USING ERRCODE = '42501';
  END IF;
  PERFORM 1 FROM openarc_tenant.organizations o
   WHERE o.organization_id = v_org FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'durable_forbidden' USING ERRCODE = '42501';
  END IF;
  SELECT m.role INTO v_role
    FROM openarc_tenant.memberships m
   WHERE m.organization_id = v_org
     AND m.account_id = v_issuer
     AND m.status = 'active' AND m.role IN ('owner', 'operator')
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'durable_forbidden' USING ERRCODE = '42501';
  END IF;
  PERFORM set_config('openarc.account_id', v_issuer, true);
  PERFORM set_config('openarc.organization_id', v_org, true);
  PERFORM set_config('openarc.role', v_role, true);
  PERFORM 1 FROM openarc_tenant.agents a
   WHERE a.organization_id = v_org
     AND a.agent_id = v_agent_id AND a.status = 'active' FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'durable_forbidden' USING ERRCODE = '42501';
  END IF;
  -- Re-lock the credential under the accepted order and revalidate every
  -- identity/version binding; the prelock snapshot is not trusted.
  SELECT c.organization_id, c.credential_id, c.agent_id, c.issuer_account_id,
         c.scope, c.scope_version, c.environment, c.algorithm, c.hash_version,
         c.pepper_version, c.kdf_n, c.kdf_r, c.kdf_p, c.salt, c.digest,
         c.key_prefix, c.revocation_version, c.expires_at, c.revoked_at
    INTO v_hash
    FROM openarc_durable.agent_credentials c
   WHERE c.credential_id = v_credential_id AND c.lookup_id = lookup_id
   FOR UPDATE;
  IF NOT FOUND
     OR v_hash.organization_id IS DISTINCT FROM v_org
     OR v_hash.agent_id IS DISTINCT FROM v_agent_id
     OR v_hash.issuer_account_id IS DISTINCT FROM v_issuer THEN
    RAISE EXCEPTION 'durable_forbidden' USING ERRCODE = '42501';
  END IF;
  SELECT clock_timestamp() INTO v_now;
  IF v_hash.revoked_at IS NOT NULL OR NOT (v_hash.expires_at > v_now) THEN
    RAISE EXCEPTION 'durable_forbidden' USING ERRCODE = '42501';
  END IF;
  out_organization_id := v_hash.organization_id;
  out_credential_id := v_hash.credential_id;
  out_agent_id := v_hash.agent_id;
  out_issuer_account_id := v_hash.issuer_account_id;
  out_scope := v_hash.scope;
  out_scope_version := v_hash.scope_version;
  out_environment := v_hash.environment;
  out_algorithm := v_hash.algorithm;
  out_hash_version := v_hash.hash_version;
  out_pepper_version := v_hash.pepper_version;
  out_kdf_n := v_hash.kdf_n;
  out_kdf_r := v_hash.kdf_r;
  out_kdf_p := v_hash.kdf_p;
  out_salt := v_hash.salt;
  out_digest := v_hash.digest;
  out_key_prefix := v_hash.key_prefix;
  out_revocation_version := v_hash.revocation_version;
  out_expires_at := v_hash.expires_at;
  RETURN NEXT;
END;
$$;

-- ---------------------------------------------------------------------------
-- Scoped machine session helpers (no human login session is required; the
-- trusted API has already verified the scrypt digest).
-- ---------------------------------------------------------------------------
CREATE FUNCTION openarc_durable.create_agent_session(
  organization_id text,
  agent_id text,
  credential_id uuid,
  expected_version integer,
  session_id uuid,
  token_hash text,
  expires_at timestamptz
) RETURNS TABLE(
  out_session_id uuid,
  out_credential_id uuid,
  out_organization_id text,
  out_agent_id text,
  out_scope text,
  out_scope_version integer,
  out_environment text,
  out_created_at timestamptz,
  out_expires_at timestamptz,
  out_revocation_version integer
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
#variable_conflict use_variable
DECLARE
  v_issuer text;
  v_role text;
  v_membership_status text;
  v_profile_status text;
  v_revocation_version integer;
  v_credential_expires timestamptz;
  v_revoked_at timestamptz;
  v_scope text;
  v_scope_version integer;
  v_environment text;
  v_now timestamptz;
  v_session_created timestamptz;
BEGIN
  IF NOT openarc_durable.is_canonical_org_id(organization_id) THEN
    RAISE EXCEPTION 'durable_organization_invalid' USING ERRCODE = '22023';
  END IF;
  IF agent_id IS NULL OR agent_id !~ '^openarc:agent:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' THEN
    RAISE EXCEPTION 'durable_agent_invalid' USING ERRCODE = '22023';
  END IF;
  IF credential_id IS NULL OR NOT openarc_durable.is_canonical_uuid_v4(credential_id::text) THEN
    RAISE EXCEPTION 'durable_credential_invalid' USING ERRCODE = '22023';
  END IF;
  IF session_id IS NULL OR NOT openarc_durable.is_canonical_uuid_v4(session_id::text) THEN
    RAISE EXCEPTION 'durable_session_id_invalid' USING ERRCODE = '22023';
  END IF;
  IF NOT openarc_durable.is_canonical_hex64(token_hash) THEN
    RAISE EXCEPTION 'durable_token_invalid' USING ERRCODE = '22023';
  END IF;
  IF expected_version IS NULL OR expected_version < 1 THEN
    RAISE EXCEPTION 'durable_version_invalid' USING ERRCODE = '22023';
  END IF;
  IF expires_at IS NULL THEN
    RAISE EXCEPTION 'durable_expiry_invalid' USING ERRCODE = '22023';
  END IF;

  -- Resolve issuer from the credential without locking it yet; then take the
  -- account -> organization -> membership -> profile locks in the accepted
  -- order, and finally re-lock the credential and revalidate every binding.
  SELECT c.issuer_account_id INTO v_issuer
    FROM openarc_durable.agent_credentials c
   WHERE c.organization_id = organization_id AND c.credential_id = credential_id
     AND c.agent_id = agent_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'durable_not_found' USING ERRCODE = '23503';
  END IF;
  PERFORM 1 FROM openarc_auth.accounts a
   WHERE a.account_id = v_issuer AND a.status = 'active' FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'durable_forbidden' USING ERRCODE = '42501';
  END IF;
  PERFORM 1 FROM openarc_tenant.organizations o
   WHERE o.organization_id = organization_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'durable_forbidden' USING ERRCODE = '42501';
  END IF;
  SELECT m.role, m.status INTO v_role, v_membership_status
    FROM openarc_tenant.memberships m
   WHERE m.organization_id = organization_id AND m.account_id = v_issuer
   FOR UPDATE;
  IF NOT FOUND OR v_membership_status <> 'active'
     OR v_role NOT IN ('owner', 'operator') THEN
    RAISE EXCEPTION 'durable_forbidden' USING ERRCODE = '42501';
  END IF;
  PERFORM set_config('openarc.account_id', v_issuer, true);
  PERFORM set_config('openarc.organization_id', organization_id, true);
  PERFORM set_config('openarc.role', v_role, true);
  SELECT a.status INTO v_profile_status FROM openarc_tenant.agents a
   WHERE a.organization_id = organization_id AND a.agent_id = agent_id FOR UPDATE;
  IF NOT FOUND OR v_profile_status <> 'active' THEN
    RAISE EXCEPTION 'durable_forbidden' USING ERRCODE = '42501';
  END IF;

  SELECT c.revocation_version, c.expires_at, c.revoked_at, c.scope,
         c.scope_version, c.environment
    INTO v_revocation_version, v_credential_expires, v_revoked_at, v_scope,
         v_scope_version, v_environment
    FROM openarc_durable.agent_credentials c
   WHERE c.organization_id = organization_id AND c.credential_id = credential_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'durable_not_found' USING ERRCODE = '23503';
  END IF;
  IF v_revoked_at IS NOT NULL OR v_revocation_version <> expected_version THEN
    RAISE EXCEPTION 'durable_conflict' USING ERRCODE = '23505';
  END IF;
  IF v_scope <> 'agent:self.read' OR v_scope_version <> 1
     OR v_environment <> 'eip155:5042002' THEN
    RAISE EXCEPTION 'durable_forbidden' USING ERRCODE = '42501';
  END IF;
  SELECT clock_timestamp() INTO v_now;
  IF NOT (v_credential_expires > v_now) THEN
    RAISE EXCEPTION 'durable_expiry_invalid' USING ERRCODE = '22023';
  END IF;
  IF NOT (expires_at > v_now)
     OR expires_at > v_now + interval '15 minutes'
     OR expires_at > v_credential_expires THEN
    RAISE EXCEPTION 'durable_expiry_invalid' USING ERRCODE = '22023';
  END IF;

  INSERT INTO openarc_durable.agent_sessions (
    session_id, token_hash, organization_id, agent_id, credential_id,
    scope, scope_version, environment, expires_at
  ) VALUES (
    session_id, token_hash, organization_id, agent_id, credential_id,
    'agent:self.read', 1, 'eip155:5042002', expires_at
  )
  RETURNING created_at INTO v_session_created;
  out_session_id := session_id;
  out_credential_id := credential_id;
  out_organization_id := organization_id;
  out_agent_id := agent_id;
  out_scope := 'agent:self.read';
  out_scope_version := 1;
  out_environment := 'eip155:5042002';
  out_created_at := v_session_created;
  out_expires_at := expires_at;
  out_revocation_version := 1;
  RETURN NEXT;
END;
$$;

-- ---------------------------------------------------------------------------
-- Machine session read/revoke. Current request rechecks every current binding.
-- ---------------------------------------------------------------------------
CREATE FUNCTION openarc_durable.read_agent_session(token_hash text)
RETURNS TABLE(
  out_session_id uuid,
  out_organization_id text,
  out_agent_id text,
  out_credential_id uuid,
  out_issuer_account_id text,
  out_scope text,
  out_scope_version integer,
  out_environment text,
  out_created_at timestamptz,
  out_expires_at timestamptz,
  out_revocation_version integer
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
#variable_conflict use_variable
DECLARE
  v_session record;
  v_issuer text;
  v_org text;
  v_agent_id text;
  v_credential_id uuid;
  v_role text;
  v_credential_expires timestamptz;
  v_now timestamptz;
BEGIN
  IF NOT openarc_durable.is_canonical_hex64(token_hash) THEN
    RAISE EXCEPTION 'durable_token_invalid' USING ERRCODE = '22023';
  END IF;
  -- Resolve the session identifiers WITHOUT a lock, then take every binding in
  -- Resolve the session identifiers WITHOUT a lock, then take every binding in
  -- the accepted order (account -> organization -> membership -> profile ->
  -- credential -> machine session) and revalidate under the locks.
  SELECT s.organization_id, s.agent_id, s.credential_id
    INTO v_org, v_agent_id, v_credential_id
    FROM openarc_durable.agent_sessions s
   WHERE s.token_hash = token_hash;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'durable_not_found' USING ERRCODE = '23503';
  END IF;
  SELECT c.issuer_account_id INTO v_issuer
    FROM openarc_durable.agent_credentials c
   WHERE c.organization_id = v_org AND c.credential_id = v_credential_id;
  IF v_issuer IS NULL THEN
    RAISE EXCEPTION 'durable_forbidden' USING ERRCODE = '42501';
  END IF;
  PERFORM 1 FROM openarc_auth.accounts a
   WHERE a.account_id = v_issuer AND a.status = 'active' FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'durable_forbidden' USING ERRCODE = '42501';
  END IF;
  PERFORM 1 FROM openarc_tenant.organizations o
   WHERE o.organization_id = v_org FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'durable_forbidden' USING ERRCODE = '42501';
  END IF;
  SELECT m.role INTO v_role
    FROM openarc_tenant.memberships m
   WHERE m.organization_id = v_org AND m.account_id = v_issuer
     AND m.status = 'active' AND m.role IN ('owner', 'operator') FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'durable_forbidden' USING ERRCODE = '42501';
  END IF;
  PERFORM set_config('openarc.account_id', v_issuer, true);
  PERFORM set_config('openarc.organization_id', v_org, true);
  PERFORM set_config('openarc.role', v_role, true);
  PERFORM 1 FROM openarc_tenant.agents a
   WHERE a.organization_id = v_org AND a.agent_id = v_agent_id
     AND a.status = 'active' FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'durable_forbidden' USING ERRCODE = '42501';
  END IF;
  SELECT c.expires_at INTO v_credential_expires
    FROM openarc_durable.agent_credentials c
   WHERE c.organization_id = v_org AND c.credential_id = v_credential_id
     AND c.revoked_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'durable_forbidden' USING ERRCODE = '42501';
  END IF;
  IF NOT (v_credential_expires > clock_timestamp()) THEN
    RAISE EXCEPTION 'durable_forbidden' USING ERRCODE = '42501';
  END IF;
  SELECT s.session_id, s.organization_id, s.agent_id, s.credential_id,
         s.scope, s.scope_version, s.environment, s.created_at, s.expires_at,
         s.revoked_at, s.revocation_version
    INTO v_session
    FROM openarc_durable.agent_sessions s
   WHERE s.token_hash = token_hash FOR UPDATE;
  IF NOT FOUND
     OR v_session.organization_id IS DISTINCT FROM v_org
     OR v_session.agent_id IS DISTINCT FROM v_agent_id
     OR v_session.credential_id IS DISTINCT FROM v_credential_id
     OR v_session.scope <> 'agent:self.read'
     OR v_session.scope_version <> 1
     OR v_session.environment <> 'eip155:5042002' THEN
    RAISE EXCEPTION 'durable_forbidden' USING ERRCODE = '42501';
  END IF;
  SELECT clock_timestamp() INTO v_now;
  IF v_session.revoked_at IS NOT NULL OR NOT (v_session.expires_at > v_now) THEN
    RAISE EXCEPTION 'durable_forbidden' USING ERRCODE = '42501';
  END IF;
  out_session_id := v_session.session_id;
  out_organization_id := v_session.organization_id;
  out_agent_id := v_session.agent_id;
  out_credential_id := v_session.credential_id;
  out_issuer_account_id := v_issuer;
  out_scope := v_session.scope;
  out_scope_version := v_session.scope_version;
  out_environment := v_session.environment;
  out_created_at := v_session.created_at;
  out_expires_at := v_session.expires_at;
  out_revocation_version := v_session.revocation_version;
  RETURN NEXT;
END;
$$;

-- ---------------------------------------------------------------------------
-- Row level security: migrator-owned with FORCE; the tenant runtime has no
-- direct policy or table privilege. The worker gets nothing at all.
-- ---------------------------------------------------------------------------
ALTER TABLE openarc_durable.agent_credentials ENABLE ROW LEVEL SECURITY;
ALTER TABLE openarc_durable.agent_credentials FORCE ROW LEVEL SECURITY;
ALTER TABLE openarc_durable.provider_credentials ENABLE ROW LEVEL SECURITY;
ALTER TABLE openarc_durable.provider_credentials FORCE ROW LEVEL SECURITY;
ALTER TABLE openarc_durable.agent_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE openarc_durable.agent_sessions FORCE ROW LEVEL SECURITY;
ALTER TABLE openarc_durable.provider_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE openarc_durable.provider_sessions FORCE ROW LEVEL SECURITY;

CREATE POLICY agent_credentials_migrator ON openarc_durable.agent_credentials
  FOR ALL TO openarc_migrator USING (true) WITH CHECK (true);
CREATE POLICY provider_credentials_migrator ON openarc_durable.provider_credentials
  FOR ALL TO openarc_migrator USING (true) WITH CHECK (true);
CREATE POLICY agent_sessions_migrator ON openarc_durable.agent_sessions
  FOR ALL TO openarc_migrator USING (true) WITH CHECK (true);
CREATE POLICY provider_sessions_migrator ON openarc_durable.provider_sessions
  FOR ALL TO openarc_migrator USING (true) WITH CHECK (true);

-- The tenant runtime may only resolve a live session through the frozen auth
-- bridge used by read_agent_session; it is granted no credential table access.
GRANT USAGE ON SCHEMA openarc_durable TO openarc_tenant_app;

REVOKE ALL ON ALL TABLES IN SCHEMA openarc_durable FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA openarc_durable FROM PUBLIC;
REVOKE ALL ON TABLE openarc_durable.agent_credentials FROM PUBLIC;
REVOKE ALL ON TABLE openarc_durable.provider_credentials FROM PUBLIC;
REVOKE ALL ON TABLE openarc_durable.agent_sessions FROM PUBLIC;
REVOKE ALL ON TABLE openarc_durable.provider_sessions FROM PUBLIC;


CREATE FUNCTION openarc_durable.read_provider_session(token_hash text)
RETURNS TABLE(
  out_session_id uuid,
  out_organization_id text,
  out_provider_id text,
  out_credential_id uuid,
  out_issuer_account_id text,
  out_scope text,
  out_scope_version integer,
  out_environment text,
  out_created_at timestamptz,
  out_expires_at timestamptz,
  out_revocation_version integer
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
#variable_conflict use_variable
DECLARE
  v_session record;
  v_issuer text;
  v_org text;
  v_provider_id text;
  v_credential_id uuid;
  v_credential_expires timestamptz;
  v_now timestamptz;
BEGIN
  IF NOT openarc_durable.is_canonical_hex64(token_hash) THEN
    RAISE EXCEPTION 'durable_token_invalid' USING ERRCODE = '22023';
  END IF;
  -- Resolve identifiers WITHOUT a lock, then account -> organization ->
  -- membership -> profile -> credential -> machine session.
  SELECT s.organization_id, s.provider_id, s.credential_id
    INTO v_org, v_provider_id, v_credential_id
    FROM openarc_durable.provider_sessions s
   WHERE s.token_hash = token_hash;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'durable_not_found' USING ERRCODE = '23503';
  END IF;
  SELECT c.issuer_account_id INTO v_issuer
    FROM openarc_durable.provider_credentials c
   WHERE c.organization_id = v_org AND c.credential_id = v_credential_id;
  IF v_issuer IS NULL THEN
    RAISE EXCEPTION 'durable_forbidden' USING ERRCODE = '42501';
  END IF;
  PERFORM 1 FROM openarc_auth.accounts a
   WHERE a.account_id = v_issuer AND a.status = 'active' FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'durable_forbidden' USING ERRCODE = '42501';
  END IF;
  PERFORM 1 FROM openarc_tenant.organizations o
   WHERE o.organization_id = v_org FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'durable_forbidden' USING ERRCODE = '42501';
  END IF;
  PERFORM 1 FROM openarc_tenant.memberships m
   WHERE m.organization_id = v_org AND m.account_id = v_issuer
     AND m.status = 'active' AND m.role = 'owner' FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'durable_forbidden' USING ERRCODE = '42501';
  END IF;
  PERFORM set_config('openarc.account_id', v_issuer, true);
  PERFORM set_config('openarc.organization_id', v_org, true);
  PERFORM set_config('openarc.role', 'owner', true);
  PERFORM 1 FROM openarc_tenant.providers p
   WHERE p.organization_id = v_org AND p.provider_id = v_provider_id
     AND p.status = 'active' FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'durable_forbidden' USING ERRCODE = '42501';
  END IF;
  SELECT c.expires_at INTO v_credential_expires
    FROM openarc_durable.provider_credentials c
   WHERE c.organization_id = v_org AND c.credential_id = v_credential_id
     AND c.revoked_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'durable_forbidden' USING ERRCODE = '42501';
  END IF;
  IF NOT (v_credential_expires > clock_timestamp()) THEN
    RAISE EXCEPTION 'durable_forbidden' USING ERRCODE = '42501';
  END IF;
  SELECT s.session_id, s.organization_id, s.provider_id, s.credential_id,
         s.scope, s.scope_version, s.environment, s.created_at, s.expires_at,
         s.revoked_at, s.revocation_version
    INTO v_session
    FROM openarc_durable.provider_sessions s
   WHERE s.token_hash = token_hash FOR UPDATE;
  IF NOT FOUND
     OR v_session.organization_id IS DISTINCT FROM v_org
     OR v_session.provider_id IS DISTINCT FROM v_provider_id
     OR v_session.credential_id IS DISTINCT FROM v_credential_id
     OR v_session.scope <> 'provider:self.read'
     OR v_session.scope_version <> 1
     OR v_session.environment <> 'eip155:5042002' THEN
    RAISE EXCEPTION 'durable_forbidden' USING ERRCODE = '42501';
  END IF;
  SELECT clock_timestamp() INTO v_now;
  IF v_session.revoked_at IS NOT NULL OR NOT (v_session.expires_at > v_now) THEN
    RAISE EXCEPTION 'durable_forbidden' USING ERRCODE = '42501';
  END IF;
  out_session_id := v_session.session_id;
  out_organization_id := v_session.organization_id;
  out_provider_id := v_session.provider_id;
  out_credential_id := v_session.credential_id;
  out_issuer_account_id := v_issuer;
  out_scope := v_session.scope;
  out_scope_version := v_session.scope_version;
  out_environment := v_session.environment;
  out_created_at := v_session.created_at;
  out_expires_at := v_session.expires_at;
  out_revocation_version := v_session.revocation_version;
  RETURN NEXT;
END;
$$;

CREATE FUNCTION openarc_durable.revoke_provider_session(token_hash text)
RETURNS TABLE(
  out_session_id uuid,
  out_organization_id text,
  out_revoked_at timestamptz,
  out_revocation_version integer
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
#variable_conflict use_variable
DECLARE
  v_session record;
  v_now timestamptz;
BEGIN
  IF NOT openarc_durable.is_canonical_hex64(token_hash) THEN
    RAISE EXCEPTION 'durable_token_invalid' USING ERRCODE = '22023';
  END IF;
  SELECT s.session_id, s.organization_id, s.revoked_at, s.revocation_version
    INTO v_session
    FROM openarc_durable.provider_sessions s
   WHERE s.token_hash = token_hash
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'durable_not_found' USING ERRCODE = '23503';
  END IF;
  IF v_session.revoked_at IS NULL THEN
    SELECT clock_timestamp() INTO v_now;
    UPDATE openarc_durable.provider_sessions s
       SET revoked_at = v_now,
           revocation_version = s.revocation_version + 1
     WHERE s.token_hash = token_hash
     RETURNING s.revoked_at, s.revocation_version INTO v_session.revoked_at, v_session.revocation_version;
  END IF;
  out_session_id := v_session.session_id;
  out_organization_id := v_session.organization_id;
  out_revoked_at := v_session.revoked_at;
  out_revocation_version := v_session.revocation_version;
  RETURN NEXT;
END;
$$;

CREATE FUNCTION openarc_durable.revoke_agent_session(token_hash text)
RETURNS TABLE(
  out_session_id uuid,
  out_organization_id text,
  out_revoked_at timestamptz,
  out_revocation_version integer
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
#variable_conflict use_variable
DECLARE
  v_session record;
  v_now timestamptz;
BEGIN
  IF NOT openarc_durable.is_canonical_hex64(token_hash) THEN
    RAISE EXCEPTION 'durable_token_invalid' USING ERRCODE = '22023';
  END IF;
  SELECT s.session_id, s.organization_id, s.revoked_at, s.revocation_version
    INTO v_session
    FROM openarc_durable.agent_sessions s
   WHERE s.token_hash = token_hash
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'durable_not_found' USING ERRCODE = '23503';
  END IF;
  IF v_session.revoked_at IS NULL THEN
    SELECT clock_timestamp() INTO v_now;
    UPDATE openarc_durable.agent_sessions s
       SET revoked_at = v_now,
           revocation_version = s.revocation_version + 1
     WHERE s.token_hash = token_hash
     RETURNING s.revoked_at, s.revocation_version INTO v_session.revoked_at, v_session.revocation_version;
  END IF;
  out_session_id := v_session.session_id;
  out_organization_id := v_session.organization_id;
  out_revoked_at := v_session.revoked_at;
  out_revocation_version := v_session.revocation_version;
  RETURN NEXT;
END;
$$;

CREATE FUNCTION openarc_durable.create_provider_session(
  organization_id text,
  provider_id text,
  credential_id uuid,
  expected_version integer,
  session_id uuid,
  token_hash text,
  expires_at timestamptz
) RETURNS TABLE(
  out_session_id uuid,
  out_credential_id uuid,
  out_organization_id text,
  out_provider_id text,
  out_scope text,
  out_scope_version integer,
  out_environment text,
  out_created_at timestamptz,
  out_expires_at timestamptz,
  out_revocation_version integer
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
#variable_conflict use_variable
DECLARE
  v_issuer text;
  v_role text;
  v_membership_status text;
  v_profile_status text;
  v_revocation_version integer;
  v_credential_expires timestamptz;
  v_revoked_at timestamptz;
  v_scope text;
  v_scope_version integer;
  v_environment text;
  v_now timestamptz;
  v_session_created timestamptz;
BEGIN
  IF NOT openarc_durable.is_canonical_org_id(organization_id) THEN
    RAISE EXCEPTION 'durable_organization_invalid' USING ERRCODE = '22023';
  END IF;
  IF provider_id IS NULL OR provider_id !~ '^openarc:provider:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' THEN
    RAISE EXCEPTION 'durable_provider_invalid' USING ERRCODE = '22023';
  END IF;
  IF credential_id IS NULL OR NOT openarc_durable.is_canonical_uuid_v4(credential_id::text) THEN
    RAISE EXCEPTION 'durable_credential_invalid' USING ERRCODE = '22023';
  END IF;
  IF session_id IS NULL OR NOT openarc_durable.is_canonical_uuid_v4(session_id::text) THEN
    RAISE EXCEPTION 'durable_session_id_invalid' USING ERRCODE = '22023';
  END IF;
  IF NOT openarc_durable.is_canonical_hex64(token_hash) THEN
    RAISE EXCEPTION 'durable_token_invalid' USING ERRCODE = '22023';
  END IF;
  IF expected_version IS NULL OR expected_version < 1 THEN
    RAISE EXCEPTION 'durable_version_invalid' USING ERRCODE = '22023';
  END IF;
  IF expires_at IS NULL THEN
    RAISE EXCEPTION 'durable_expiry_invalid' USING ERRCODE = '22023';
  END IF;

  SELECT c.issuer_account_id INTO v_issuer
    FROM openarc_durable.provider_credentials c
   WHERE c.organization_id = organization_id AND c.credential_id = credential_id
     AND c.provider_id = provider_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'durable_not_found' USING ERRCODE = '23503';
  END IF;
  PERFORM 1 FROM openarc_auth.accounts a
   WHERE a.account_id = v_issuer AND a.status = 'active' FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'durable_forbidden' USING ERRCODE = '42501';
  END IF;
  PERFORM 1 FROM openarc_tenant.organizations o
   WHERE o.organization_id = organization_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'durable_forbidden' USING ERRCODE = '42501';
  END IF;
  SELECT m.role, m.status INTO v_role, v_membership_status
    FROM openarc_tenant.memberships m
   WHERE m.organization_id = organization_id AND m.account_id = v_issuer
   FOR UPDATE;
  IF NOT FOUND OR v_membership_status <> 'active' OR v_role <> 'owner' THEN
    RAISE EXCEPTION 'durable_forbidden' USING ERRCODE = '42501';
  END IF;
  PERFORM set_config('openarc.account_id', v_issuer, true);
  PERFORM set_config('openarc.organization_id', organization_id, true);
  PERFORM set_config('openarc.role', 'owner', true);
  SELECT p.status INTO v_profile_status FROM openarc_tenant.providers p
   WHERE p.organization_id = organization_id AND p.provider_id = provider_id FOR UPDATE;
  IF NOT FOUND OR v_profile_status <> 'active' THEN
    RAISE EXCEPTION 'durable_forbidden' USING ERRCODE = '42501';
  END IF;

  SELECT c.revocation_version, c.expires_at, c.revoked_at, c.scope,
         c.scope_version, c.environment
    INTO v_revocation_version, v_credential_expires, v_revoked_at, v_scope,
         v_scope_version, v_environment
    FROM openarc_durable.provider_credentials c
   WHERE c.organization_id = organization_id AND c.credential_id = credential_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'durable_not_found' USING ERRCODE = '23503';
  END IF;
  IF v_revoked_at IS NOT NULL OR v_revocation_version <> expected_version THEN
    RAISE EXCEPTION 'durable_conflict' USING ERRCODE = '23505';
  END IF;
  IF v_scope <> 'provider:self.read' OR v_scope_version <> 1
     OR v_environment <> 'eip155:5042002' THEN
    RAISE EXCEPTION 'durable_forbidden' USING ERRCODE = '42501';
  END IF;
  SELECT clock_timestamp() INTO v_now;
  IF NOT (v_credential_expires > v_now) THEN
    RAISE EXCEPTION 'durable_expiry_invalid' USING ERRCODE = '22023';
  END IF;
  IF NOT (expires_at > v_now)
     OR expires_at > v_now + interval '15 minutes'
     OR expires_at > v_credential_expires THEN
    RAISE EXCEPTION 'durable_expiry_invalid' USING ERRCODE = '22023';
  END IF;

  INSERT INTO openarc_durable.provider_sessions (
    session_id, token_hash, organization_id, provider_id, credential_id,
    scope, scope_version, environment, expires_at
  ) VALUES (
    session_id, token_hash, organization_id, provider_id, credential_id,
    'provider:self.read', 1, 'eip155:5042002', expires_at
  )
  RETURNING created_at INTO v_session_created;
  out_session_id := session_id;
  out_credential_id := credential_id;
  out_organization_id := organization_id;
  out_provider_id := provider_id;
  out_scope := 'provider:self.read';
  out_scope_version := 1;
  out_environment := 'eip155:5042002';
  out_created_at := v_session_created;
  out_expires_at := expires_at;
  out_revocation_version := 1;
  RETURN NEXT;
END;
$$;

CREATE FUNCTION openarc_durable.find_provider_credential_verifier(lookup_id uuid)
RETURNS TABLE(
  out_organization_id text,
  out_credential_id uuid,
  out_provider_id text,
  out_issuer_account_id text,
  out_scope text,
  out_scope_version integer,
  out_environment text,
  out_algorithm text,
  out_hash_version integer,
  out_pepper_version integer,
  out_kdf_n integer,
  out_kdf_r integer,
  out_kdf_p integer,
  out_salt text,
  out_digest text,
  out_key_prefix text,
  out_revocation_version integer,
  out_expires_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
#variable_conflict use_variable
DECLARE
  v_org text;
  v_credential_id uuid;
  v_provider_id text;
  v_issuer text;
  v_now timestamptz;
  v_hash record;
BEGIN
  IF lookup_id IS NULL OR NOT openarc_durable.is_canonical_uuid_v4(lookup_id::text) THEN
    RAISE EXCEPTION 'durable_lookup_invalid' USING ERRCODE = '22023';
  END IF;
  SELECT c.organization_id, c.credential_id, c.provider_id, c.issuer_account_id
    INTO v_org, v_credential_id, v_provider_id, v_issuer
    FROM openarc_durable.provider_credentials c
   WHERE c.lookup_id = lookup_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'durable_not_found' USING ERRCODE = '23503';
  END IF;
  PERFORM 1 FROM openarc_auth.accounts a
   WHERE a.account_id = v_issuer AND a.status = 'active' FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'durable_forbidden' USING ERRCODE = '42501';
  END IF;
  PERFORM 1 FROM openarc_tenant.organizations o
   WHERE o.organization_id = v_org FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'durable_forbidden' USING ERRCODE = '42501';
  END IF;
  PERFORM 1 FROM openarc_tenant.memberships m
   WHERE m.organization_id = v_org AND m.account_id = v_issuer
     AND m.status = 'active' AND m.role = 'owner'
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'durable_forbidden' USING ERRCODE = '42501';
  END IF;
  PERFORM set_config('openarc.account_id', v_issuer, true);
  PERFORM set_config('openarc.organization_id', v_org, true);
  PERFORM set_config('openarc.role', 'owner', true);
  PERFORM 1 FROM openarc_tenant.providers p
   WHERE p.organization_id = v_org AND p.provider_id = v_provider_id
     AND p.status = 'active' FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'durable_forbidden' USING ERRCODE = '42501';
  END IF;
  SELECT c.organization_id, c.credential_id, c.provider_id, c.issuer_account_id,
         c.scope, c.scope_version, c.environment, c.algorithm, c.hash_version,
         c.pepper_version, c.kdf_n, c.kdf_r, c.kdf_p, c.salt, c.digest,
         c.key_prefix, c.revocation_version, c.expires_at, c.revoked_at
    INTO v_hash
    FROM openarc_durable.provider_credentials c
   WHERE c.credential_id = v_credential_id AND c.lookup_id = lookup_id
   FOR UPDATE;
  IF NOT FOUND
     OR v_hash.organization_id IS DISTINCT FROM v_org
     OR v_hash.provider_id IS DISTINCT FROM v_provider_id
     OR v_hash.issuer_account_id IS DISTINCT FROM v_issuer THEN
    RAISE EXCEPTION 'durable_forbidden' USING ERRCODE = '42501';
  END IF;
  SELECT clock_timestamp() INTO v_now;
  IF v_hash.revoked_at IS NOT NULL OR NOT (v_hash.expires_at > v_now) THEN
    RAISE EXCEPTION 'durable_forbidden' USING ERRCODE = '42501';
  END IF;
  out_organization_id := v_hash.organization_id;
  out_credential_id := v_hash.credential_id;
  out_provider_id := v_hash.provider_id;
  out_issuer_account_id := v_hash.issuer_account_id;
  out_scope := v_hash.scope;
  out_scope_version := v_hash.scope_version;
  out_environment := v_hash.environment;
  out_algorithm := v_hash.algorithm;
  out_hash_version := v_hash.hash_version;
  out_pepper_version := v_hash.pepper_version;
  out_kdf_n := v_hash.kdf_n;
  out_kdf_r := v_hash.kdf_r;
  out_kdf_p := v_hash.kdf_p;
  out_salt := v_hash.salt;
  out_digest := v_hash.digest;
  out_key_prefix := v_hash.key_prefix;
  out_revocation_version := v_hash.revocation_version;
  out_expires_at := v_hash.expires_at;
  RETURN NEXT;
END;
$$;

CREATE FUNCTION openarc_durable.list_provider_credentials(
  session_hash text,
  organization_id text,
  provider_id text,
  after_credential_id uuid,
  page_limit integer
) RETURNS TABLE(
  out_credential_id uuid,
  out_lookup_id uuid,
  out_provider_id text,
  out_scope text,
  out_environment text,
  out_key_prefix text,
  out_created_at timestamptz,
  out_expires_at timestamptz,
  out_revoked_at timestamptz,
  out_status text
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
  v_profile_status text;
  v_recheck text;
  v_limit integer;
BEGIN
  IF NOT openarc_durable.is_canonical_org_id(organization_id) THEN
    RAISE EXCEPTION 'durable_organization_invalid' USING ERRCODE = '22023';
  END IF;
  IF provider_id IS NULL OR provider_id !~ '^openarc:provider:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' THEN
    RAISE EXCEPTION 'durable_provider_invalid' USING ERRCODE = '22023';
  END IF;
  IF page_limit IS NULL OR page_limit < 1 OR page_limit > 50 THEN
    RAISE EXCEPTION 'durable_page_invalid' USING ERRCODE = '22023';
  END IF;
  v_limit := page_limit;
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
  PERFORM set_config('openarc.account_id', v_actor, true);
  PERFORM set_config('openarc.organization_id', organization_id, true);
  PERFORM set_config('openarc.role', 'owner', true);
  SELECT p.status INTO v_profile_status FROM openarc_tenant.providers p
   WHERE p.organization_id = organization_id AND p.provider_id = provider_id FOR UPDATE;
  IF v_profile_status IS NULL THEN
    RAISE EXCEPTION 'durable_not_found' USING ERRCODE = '23503';
  END IF;
  SELECT l.account_id INTO v_recheck
    FROM openarc_tenant.lock_auth_session(session_hash, NULL) AS l;
  IF v_recheck IS NULL OR v_recheck <> v_actor THEN
    RAISE EXCEPTION 'durable_session_invalid' USING ERRCODE = '28000';
  END IF;
  RETURN QUERY
    SELECT c.credential_id, c.lookup_id, c.provider_id, c.scope, c.environment,
           c.key_prefix, c.created_at, c.expires_at, c.revoked_at,
           CASE
             WHEN c.revoked_at IS NOT NULL THEN 'revoked'
             WHEN c.expires_at <= clock_timestamp() THEN 'expired'
             ELSE 'active'
           END
      FROM openarc_durable.provider_credentials c
     WHERE c.organization_id = organization_id AND c.provider_id = provider_id
       AND (after_credential_id IS NULL OR c.credential_id > after_credential_id)
     ORDER BY c.credential_id
     LIMIT v_limit;
END;
$$;

-- ---------------------------------------------------------------------------
-- Credential status readers (same current authorization for found/not_found).
-- ---------------------------------------------------------------------------
CREATE FUNCTION openarc_durable.read_agent_credential_mutation_status(
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
  SELECT r.mutation_id, r.operation, r.resource_type, r.resource_id, r.committed_at
    INTO v_mutation_id, v_operation, v_resource_type, v_resource_id, v_committed_at
    FROM openarc_durable.idempotency_records r
   WHERE r.organization_id = organization_id AND r.mutation_id = mutation_id
     AND r.actor_account_id = v_actor AND r.status = 'committed'
     AND r.operation IN ('tenant.agent.credential.issue', 'tenant.agent.credential.revoke');
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

CREATE FUNCTION openarc_durable.read_provider_credential_mutation_status(
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
  SELECT r.mutation_id, r.operation, r.resource_type, r.resource_id, r.committed_at
    INTO v_mutation_id, v_operation, v_resource_type, v_resource_id, v_committed_at
    FROM openarc_durable.idempotency_records r
   WHERE r.organization_id = organization_id AND r.mutation_id = mutation_id
     AND r.actor_account_id = v_actor AND r.status = 'committed'
     AND r.operation IN ('tenant.provider.credential.issue', 'tenant.provider.credential.revoke');
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
-- Legacy generic status readers: explicitly restrict the original operation
-- union so a credential receipt can never surface through legacy status.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION openarc_durable.read_tenant_mutation_status(
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
  SELECT r.operation INTO v_operation
    FROM openarc_durable.idempotency_records r
   WHERE r.organization_id = organization_id AND r.mutation_id = mutation_id
     AND r.actor_account_id = v_actor AND r.status = 'committed'
     AND r.operation IN (
       'tenant.organization.create', 'tenant.agent.create', 'tenant.agent.update',
       'tenant.provider.create', 'tenant.provider.update', 'tenant.membership.set'
     );
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
     AND r.actor_account_id = v_actor AND r.status = 'committed'
     AND r.operation IN (
       'tenant.organization.create', 'tenant.agent.create', 'tenant.agent.update',
       'tenant.provider.create', 'tenant.provider.update', 'tenant.membership.set'
     );
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

CREATE OR REPLACE FUNCTION openarc_durable.read_agent_mutation_status(
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
  SELECT r.mutation_id, r.operation, r.resource_type, r.resource_id, r.committed_at
    INTO v_mutation_id, v_operation, v_resource_type, v_resource_id, v_committed_at
    FROM openarc_durable.idempotency_records r
   WHERE r.organization_id = organization_id AND r.mutation_id = mutation_id
     AND r.actor_account_id = v_actor AND r.status = 'committed'
     AND r.operation = 'tenant.agent.create';
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

CREATE FUNCTION openarc_durable.commit_provider_credential_revoke(
  session_hash text,
  organization_id text,
  credential_id uuid,
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
  v_existing record;
  v_cred record;
  v_committed_at timestamptz;
  v_recheck text;
BEGIN
  IF credential_id IS NULL OR NOT openarc_durable.is_canonical_uuid_v4(credential_id::text) THEN
    RAISE EXCEPTION 'durable_credential_invalid' USING ERRCODE = '22023';
  END IF;
  IF mutation_id IS NULL OR NOT openarc_durable.is_canonical_uuid_v4(mutation_id::text) THEN
    RAISE EXCEPTION 'durable_mutation_invalid' USING ERRCODE = '22023';
  END IF;
  IF NOT openarc_durable.is_canonical_org_id(organization_id)
     OR NOT openarc_durable.is_canonical_hex64(key_hash)
     OR NOT openarc_durable.is_canonical_hex64(request_digest)
     OR NOT openarc_durable.is_canonical_hex64(session_context_digest) THEN
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
  SELECT m.role INTO v_role FROM openarc_tenant.memberships m
   WHERE m.organization_id = organization_id AND m.account_id = v_actor FOR UPDATE;
  IF NOT FOUND OR v_role <> 'owner' THEN
    RAISE EXCEPTION 'durable_forbidden' USING ERRCODE = '42501';
  END IF;
  PERFORM set_config('openarc.account_id', v_actor, true);
  PERFORM set_config('openarc.organization_id', organization_id, true);
  PERFORM set_config('openarc.role', 'owner', true);

  SELECT c.provider_id, c.issuer_account_id, c.expires_at, c.revoked_at, c.revocation_version
    INTO v_cred
    FROM openarc_durable.provider_credentials c
   WHERE c.organization_id = organization_id AND c.credential_id = credential_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'durable_not_found' USING ERRCODE = '23503';
  END IF;

  SELECT * INTO v_existing
    FROM openarc_durable.idempotency_records r
   WHERE r.organization_id = organization_id AND r.operation = 'tenant.provider.credential.revoke'
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

  INSERT INTO openarc_durable.idempotency_records (
    organization_id, operation, key_hash, request_digest, digest_version,
    actor_account_id, session_context_digest, network, mutation_id, status
  ) VALUES (
    organization_id, 'tenant.provider.credential.revoke', key_hash, request_digest,
    'tenant.provider.credential.revoke.v1', v_actor, session_context_digest,
    'eip155:5042002', mutation_id, 'pending'
  );
  IF v_cred.revoked_at IS NULL THEN
    UPDATE openarc_durable.provider_credentials c
       SET revoked_at = clock_timestamp(),
           revocation_version = c.revocation_version + 1
     WHERE c.organization_id = organization_id AND c.credential_id = credential_id;
    UPDATE openarc_durable.provider_sessions s
       SET revoked_at = clock_timestamp(),
           revocation_version = s.revocation_version + 1
     WHERE s.organization_id = organization_id AND s.credential_id = credential_id
       AND s.revoked_at IS NULL;
  END IF;
  UPDATE openarc_durable.idempotency_records r
     SET status = 'committed', resource_type = 'provider_credential',
         resource_id = credential_id::text, committed_at = clock_timestamp()
   WHERE r.organization_id = organization_id AND r.operation = 'tenant.provider.credential.revoke'
     AND r.key_hash = key_hash
   RETURNING r.committed_at INTO v_committed_at;
  INSERT INTO openarc_durable.audit_events (
    organization_id, actor_account_id, operation, mutation_id, resource_type, resource_id, outcome
  ) VALUES (
    organization_id, v_actor, 'tenant.provider.credential.revoke', mutation_id,
    'provider_credential', credential_id::text, 'committed'
  );
  INSERT INTO openarc_durable.outbox_events (
    organization_id, mutation_id, resource_type, resource_id, event_type, payload_version
  ) VALUES (
    organization_id, mutation_id, 'provider_credential', credential_id::text,
    'tenant.provider.credential.revoked', 1
  );

  SELECT l.account_id INTO v_recheck
    FROM openarc_tenant.lock_auth_session(session_hash, NULL) AS l;
  IF v_recheck IS NULL OR v_recheck <> v_actor THEN
    RAISE EXCEPTION 'durable_session_invalid' USING ERRCODE = '28000';
  END IF;

  out_replayed := false;
  out_mutation_id := mutation_id;
  out_operation := 'tenant.provider.credential.revoke';
  out_resource_type := 'provider_credential';
  out_resource_id := credential_id::text;
  out_committed_at := v_committed_at;
  RETURN NEXT;
END;
$$;

-- ---------------------------------------------------------------------------
-- Credential revoke helpers.
-- ---------------------------------------------------------------------------
CREATE FUNCTION openarc_durable.commit_agent_credential_revoke(
  session_hash text,
  organization_id text,
  credential_id uuid,
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
  v_session_created_at timestamptz;
  v_session_expires_at timestamptz;
  v_existing record;
  v_cred record;
  v_committed_at timestamptz;
  v_recheck text;
  v_now timestamptz;
BEGIN
  IF credential_id IS NULL OR NOT openarc_durable.is_canonical_uuid_v4(credential_id::text) THEN
    RAISE EXCEPTION 'durable_credential_invalid' USING ERRCODE = '22023';
  END IF;
  IF mutation_id IS NULL OR NOT openarc_durable.is_canonical_uuid_v4(mutation_id::text) THEN
    RAISE EXCEPTION 'durable_mutation_invalid' USING ERRCODE = '22023';
  END IF;
  IF NOT openarc_durable.is_canonical_org_id(organization_id)
     OR NOT openarc_durable.is_canonical_hex64(key_hash)
     OR NOT openarc_durable.is_canonical_hex64(request_digest)
     OR NOT openarc_durable.is_canonical_hex64(session_context_digest) THEN
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
  SELECT m.role INTO v_role FROM openarc_tenant.memberships m
   WHERE m.organization_id = organization_id AND m.account_id = v_actor FOR UPDATE;
  IF NOT FOUND OR v_role NOT IN ('owner', 'operator') THEN
    RAISE EXCEPTION 'durable_forbidden' USING ERRCODE = '42501';
  END IF;
  PERFORM set_config('openarc.account_id', v_actor, true);
  PERFORM set_config('openarc.organization_id', organization_id, true);
  PERFORM set_config('openarc.role', 'owner', true);

  SELECT c.agent_id, c.issuer_account_id, c.expires_at, c.revoked_at, c.revocation_version
    INTO v_cred
    FROM openarc_durable.agent_credentials c
   WHERE c.organization_id = organization_id AND c.credential_id = credential_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'durable_not_found' USING ERRCODE = '23503';
  END IF;

  SELECT * INTO v_existing
    FROM openarc_durable.idempotency_records r
   WHERE r.organization_id = organization_id AND r.operation = 'tenant.agent.credential.revoke'
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

  INSERT INTO openarc_durable.idempotency_records (
    organization_id, operation, key_hash, request_digest, digest_version,
    actor_account_id, session_context_digest, network, mutation_id, status
  ) VALUES (
    organization_id, 'tenant.agent.credential.revoke', key_hash, request_digest,
    'tenant.agent.credential.revoke.v1', v_actor, session_context_digest,
    'eip155:5042002', mutation_id, 'pending'
  );
  IF v_cred.revoked_at IS NULL THEN
    UPDATE openarc_durable.agent_credentials c
       SET revoked_at = clock_timestamp(),
           revocation_version = c.revocation_version + 1
     WHERE c.organization_id = organization_id AND c.credential_id = credential_id;
    UPDATE openarc_durable.agent_sessions s
       SET revoked_at = clock_timestamp(),
           revocation_version = s.revocation_version + 1
     WHERE s.organization_id = organization_id AND s.credential_id = credential_id
       AND s.revoked_at IS NULL;
  END IF;
  UPDATE openarc_durable.idempotency_records r
     SET status = 'committed', resource_type = 'agent_credential',
         resource_id = credential_id::text, committed_at = clock_timestamp()
   WHERE r.organization_id = organization_id AND r.operation = 'tenant.agent.credential.revoke'
     AND r.key_hash = key_hash
   RETURNING r.committed_at INTO v_committed_at;
  INSERT INTO openarc_durable.audit_events (
    organization_id, actor_account_id, operation, mutation_id, resource_type, resource_id, outcome
  ) VALUES (
    organization_id, v_actor, 'tenant.agent.credential.revoke', mutation_id,
    'agent_credential', credential_id::text, 'committed'
  );
  INSERT INTO openarc_durable.outbox_events (
    organization_id, mutation_id, resource_type, resource_id, event_type, payload_version
  ) VALUES (
    organization_id, mutation_id, 'agent_credential', credential_id::text,
    'tenant.agent.credential.revoked', 1
  );

  SELECT l.account_id INTO v_recheck
    FROM openarc_tenant.lock_auth_session(session_hash, NULL) AS l;
  IF v_recheck IS NULL OR v_recheck <> v_actor THEN
    RAISE EXCEPTION 'durable_session_invalid' USING ERRCODE = '28000';
  END IF;

  out_replayed := false;
  out_mutation_id := mutation_id;
  out_operation := 'tenant.agent.credential.revoke';
  out_resource_type := 'agent_credential';
  out_resource_id := credential_id::text;
  out_committed_at := v_committed_at;
  RETURN NEXT;
END;
$$;

CREATE FUNCTION openarc_durable.commit_provider_credential_issue(
  session_hash text,
  organization_id text,
  provider_id text,
  credential_id uuid,
  lookup_id uuid,
  key_prefix text,
  pepper_version integer,
  salt text,
  digest text,
  expires_at timestamptz,
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
  v_session_created_at timestamptz;
  v_session_expires_at timestamptz;
  v_existing record;
  v_committed_at timestamptz;
  v_recheck text;
  v_now timestamptz;
BEGIN
  IF credential_id IS NULL OR NOT openarc_durable.is_canonical_uuid_v4(credential_id::text) THEN
    RAISE EXCEPTION 'durable_credential_invalid' USING ERRCODE = '22023';
  END IF;
  IF lookup_id IS NULL OR NOT openarc_durable.is_canonical_uuid_v4(lookup_id::text) THEN
    RAISE EXCEPTION 'durable_lookup_invalid' USING ERRCODE = '22023';
  END IF;
  IF key_prefix IS DISTINCT FROM 'oac_pr_' || lookup_id::text THEN
    RAISE EXCEPTION 'durable_prefix_invalid' USING ERRCODE = '22023';
  END IF;
  IF pepper_version IS NULL OR pepper_version NOT BETWEEN 1 AND 16 THEN
    RAISE EXCEPTION 'durable_pepper_invalid' USING ERRCODE = '22023';
  END IF;
  IF NOT openarc_durable.is_canonical_base64url(salt, 16) THEN
    RAISE EXCEPTION 'durable_salt_invalid' USING ERRCODE = '22023';
  END IF;
  IF NOT openarc_durable.is_canonical_base64url(digest, 32) THEN
    RAISE EXCEPTION 'durable_digest_invalid' USING ERRCODE = '22023';
  END IF;
  IF expires_at IS NULL THEN
    RAISE EXCEPTION 'durable_expiry_invalid' USING ERRCODE = '22023';
  END IF;
  IF mutation_id IS NULL OR NOT openarc_durable.is_canonical_uuid_v4(mutation_id::text) THEN
    RAISE EXCEPTION 'durable_mutation_invalid' USING ERRCODE = '22023';
  END IF;
  IF NOT openarc_durable.is_canonical_hex64(key_hash)
     OR NOT openarc_durable.is_canonical_hex64(request_digest)
     OR NOT openarc_durable.is_canonical_hex64(session_context_digest) THEN
    RAISE EXCEPTION 'durable_metadata_invalid' USING ERRCODE = '22023';
  END IF;
  SELECT l.out_actor, l.out_role, l.out_session_created_at, l.out_session_expires_at
    INTO v_actor, v_role, v_session_created_at, v_session_expires_at
    FROM openarc_durable.lock_credential_issuer(session_hash, organization_id, 'provider', provider_id, true) AS l;
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'durable_forbidden' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_existing
    FROM openarc_durable.idempotency_records r
   WHERE r.organization_id = organization_id AND r.operation = 'tenant.provider.credential.issue'
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

  INSERT INTO openarc_durable.idempotency_records (
    organization_id, operation, key_hash, request_digest, digest_version,
    actor_account_id, session_context_digest, network, mutation_id, status
  ) VALUES (
    organization_id, 'tenant.provider.credential.issue', key_hash, request_digest,
    'tenant.provider.credential.issue.v1', v_actor, session_context_digest,
    'eip155:5042002', mutation_id, 'pending'
  );
  INSERT INTO openarc_durable.provider_credentials (
    organization_id, credential_id, lookup_id, provider_id, issuer_account_id,
    scope, scope_version, environment, algorithm, hash_version, pepper_version,
    kdf_n, kdf_r, kdf_p, salt, digest, key_prefix, expires_at
  ) VALUES (
    organization_id, credential_id, lookup_id, provider_id, v_actor,
    'provider:self.read', 1, 'eip155:5042002', 'scrypt', 1, pepper_version,
    32768, 8, 1, salt, digest, key_prefix, expires_at
  );
  UPDATE openarc_durable.idempotency_records r
     SET status = 'committed', resource_type = 'provider_credential',
         resource_id = credential_id::text, committed_at = clock_timestamp()
   WHERE r.organization_id = organization_id AND r.operation = 'tenant.provider.credential.issue'
     AND r.key_hash = key_hash
   RETURNING r.committed_at INTO v_committed_at;
  INSERT INTO openarc_durable.audit_events (
    organization_id, actor_account_id, operation, mutation_id, resource_type, resource_id, outcome
  ) VALUES (
    organization_id, v_actor, 'tenant.provider.credential.issue', mutation_id,
    'provider_credential', credential_id::text, 'committed'
  );
  INSERT INTO openarc_durable.outbox_events (
    organization_id, mutation_id, resource_type, resource_id, event_type, payload_version
  ) VALUES (
    organization_id, mutation_id, 'provider_credential', credential_id::text,
    'tenant.provider.credential.created', 1
  );

  SELECT l.account_id INTO v_recheck
    FROM openarc_tenant.lock_auth_session(session_hash, NULL) AS l;
  IF v_recheck IS NULL OR v_recheck <> v_actor THEN
    RAISE EXCEPTION 'durable_session_invalid' USING ERRCODE = '28000';
  END IF;
  SELECT clock_timestamp() INTO v_now;
  IF NOT (expires_at > v_now) OR expires_at > v_now + interval '90 days' THEN
    RAISE EXCEPTION 'durable_expiry_invalid' USING ERRCODE = '22023';
  END IF;
  IF NOT (v_session_created_at > v_now - interval '5 minutes') THEN
    RAISE EXCEPTION 'durable_proof_stale' USING ERRCODE = '28000';
  END IF;

  out_replayed := false;
  out_mutation_id := mutation_id;
  out_operation := 'tenant.provider.credential.issue';
  out_resource_type := 'provider_credential';
  out_resource_id := credential_id::text;
  out_committed_at := v_committed_at;
  RETURN NEXT;
END;
$$;

-- ---------------------------------------------------------------------------
-- Function privileges: revoke PUBLIC everywhere, grant only the reviewed
-- signatures to the tenant runtime. The worker receives nothing.
-- ---------------------------------------------------------------------------
REVOKE ALL ON FUNCTION openarc_durable.is_canonical_base64url(text, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION openarc_durable.is_canonical_uuid_v4(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION openarc_durable.is_canonical_hex64(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION openarc_durable.lock_credential_issuer(text, text, text, text, boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION openarc_durable.commit_agent_credential_issue(text, text, text, uuid, uuid, text, integer, text, text, timestamptz, uuid, text, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION openarc_durable.commit_provider_credential_issue(text, text, text, uuid, uuid, text, integer, text, text, timestamptz, uuid, text, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION openarc_durable.commit_agent_credential_revoke(text, text, uuid, uuid, text, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION openarc_durable.commit_provider_credential_revoke(text, text, uuid, uuid, text, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION openarc_durable.read_agent_credential_mutation_status(text, text, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION openarc_durable.read_provider_credential_mutation_status(text, text, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION openarc_durable.list_agent_credentials(text, text, text, uuid, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION openarc_durable.list_provider_credentials(text, text, text, uuid, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION openarc_durable.find_agent_credential_verifier(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION openarc_durable.find_provider_credential_verifier(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION openarc_durable.create_agent_session(text, text, uuid, integer, uuid, text, timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION openarc_durable.create_provider_session(text, text, uuid, integer, uuid, text, timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION openarc_durable.read_agent_session(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION openarc_durable.read_provider_session(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION openarc_durable.revoke_agent_session(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION openarc_durable.revoke_provider_session(text) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION openarc_durable.commit_agent_credential_issue(text, text, text, uuid, uuid, text, integer, text, text, timestamptz, uuid, text, text, text) TO openarc_tenant_app;
GRANT EXECUTE ON FUNCTION openarc_durable.commit_provider_credential_issue(text, text, text, uuid, uuid, text, integer, text, text, timestamptz, uuid, text, text, text) TO openarc_tenant_app;
GRANT EXECUTE ON FUNCTION openarc_durable.commit_agent_credential_revoke(text, text, uuid, uuid, text, text, text) TO openarc_tenant_app;
GRANT EXECUTE ON FUNCTION openarc_durable.commit_provider_credential_revoke(text, text, uuid, uuid, text, text, text) TO openarc_tenant_app;
GRANT EXECUTE ON FUNCTION openarc_durable.read_agent_credential_mutation_status(text, text, uuid) TO openarc_tenant_app;
GRANT EXECUTE ON FUNCTION openarc_durable.read_provider_credential_mutation_status(text, text, uuid) TO openarc_tenant_app;
GRANT EXECUTE ON FUNCTION openarc_durable.list_agent_credentials(text, text, text, uuid, integer) TO openarc_tenant_app;
GRANT EXECUTE ON FUNCTION openarc_durable.list_provider_credentials(text, text, text, uuid, integer) TO openarc_tenant_app;
GRANT EXECUTE ON FUNCTION openarc_durable.find_agent_credential_verifier(uuid) TO openarc_tenant_app;
GRANT EXECUTE ON FUNCTION openarc_durable.find_provider_credential_verifier(uuid) TO openarc_tenant_app;
GRANT EXECUTE ON FUNCTION openarc_durable.create_agent_session(text, text, uuid, integer, uuid, text, timestamptz) TO openarc_tenant_app;
GRANT EXECUTE ON FUNCTION openarc_durable.create_provider_session(text, text, uuid, integer, uuid, text, timestamptz) TO openarc_tenant_app;
GRANT EXECUTE ON FUNCTION openarc_durable.read_agent_session(text) TO openarc_tenant_app;
GRANT EXECUTE ON FUNCTION openarc_durable.read_provider_session(text) TO openarc_tenant_app;
GRANT EXECUTE ON FUNCTION openarc_durable.revoke_agent_session(text) TO openarc_tenant_app;
GRANT EXECUTE ON FUNCTION openarc_durable.revoke_provider_session(text) TO openarc_tenant_app;
