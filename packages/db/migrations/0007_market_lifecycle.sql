-- OpenArc reviewed lifecycle + public catalog persistence (schema7).
-- Additive over schema6. This migration NEVER creates roles or schemas, never
-- fetches an endpoint, and executes no payment/grant/budget/transaction.
--
-- Owner: openarc_migrator. Runtime: openarc_tenant_app. New tables are
-- migrator-owned with forced RLS and a migrator-only policy; the runtime and
-- worker receive no direct table privilege and every access is through the
-- narrow SECURITY DEFINER helpers created below.

-- ---------------------------------------------------------------------------
-- Frozen origin-review descriptor digest. This is NOT generic JSON
-- serialization: it hashes the exact frozen string
--   'openarc.market.endpoint-review.v1\n' + listingId + '\n' + version + '\n'
--   + origin + '\n' + path   (no trailing newline)
-- with the built-in sha256/convert_to/encode (no extension).
-- ---------------------------------------------------------------------------
CREATE FUNCTION openarc_durable.reviewed_endpoint_digest(
  listing_id text,
  version text,
  origin text,
  path text
) RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog
AS $$
  SELECT 'sha256:' || encode(
    sha256(convert_to(
      'openarc.market.endpoint-review.v1' || E'\n' ||
      listing_id || E'\n' || version || E'\n' || origin || E'\n' || path,
      'UTF8'
    )),
    'hex'
  );
$$;

-- ---------------------------------------------------------------------------
-- market_moderator_grants: explicit account-level moderation authority in
-- openarc_tenant. ZERO seeded rows; ONLY the migrator may provision. No
-- organization role can ever confer moderation.
-- ---------------------------------------------------------------------------
CREATE TABLE openarc_tenant.market_moderator_grants (
  account_id text PRIMARY KEY REFERENCES openarc_auth.accounts(account_id) ON DELETE RESTRICT,
  status text NOT NULL,
  granted_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT market_moderator_grants_status_valid CHECK (status IN ('active', 'revoked')),
  CONSTRAINT market_moderator_grants_timestamps_valid CHECK (updated_at >= granted_at)
);

-- ---------------------------------------------------------------------------
-- listing_origin_reviews: append-only manual review metadata. A review is
-- metadata only, never proof of safe DNS/ownership/availability/endorsement or
-- payment authority. No fetched content, raw notes or arbitrary JSON is stored.
-- ---------------------------------------------------------------------------
CREATE TABLE openarc_tenant.listing_origin_reviews (
  review_id uuid NOT NULL,
  organization_id text NOT NULL,
  listing_id text NOT NULL,
  version text NOT NULL,
  provider_id text NOT NULL,
  mutation_id uuid NOT NULL,
  reviewer_account_id text NOT NULL REFERENCES openarc_auth.accounts(account_id) ON DELETE RESTRICT,
  decision text NOT NULL,
  reviewed_endpoint_digest text NOT NULL,
  reason_code text NOT NULL,
  reason_digest text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (organization_id, listing_id, version, review_id),
  CONSTRAINT listing_origin_reviews_review_unique UNIQUE (review_id),
  CONSTRAINT listing_origin_reviews_mutation_unique UNIQUE (organization_id, mutation_id),
  CONSTRAINT listing_origin_reviews_version_fk FOREIGN KEY (organization_id, listing_id, version)
    REFERENCES openarc_tenant.listing_versions(organization_id, listing_id, version) ON DELETE RESTRICT,
  CONSTRAINT listing_origin_reviews_provider_fk FOREIGN KEY (organization_id, provider_id, listing_id)
    REFERENCES openarc_tenant.listings(organization_id, provider_id, listing_id) ON DELETE RESTRICT,
  CONSTRAINT listing_origin_reviews_id_valid CHECK (openarc_durable.is_canonical_listing_id(listing_id)),
  CONSTRAINT listing_origin_reviews_version_valid CHECK (openarc_durable.is_canonical_listing_version(version)),
  CONSTRAINT listing_origin_reviews_decision_valid CHECK (decision IN ('approved', 'rejected')),
  CONSTRAINT listing_origin_reviews_reason_code_valid CHECK (
    reason_code IN ('manual_review', 'origin_policy', 'terms_policy', 'manifest_policy', 'other')
  ),
  CONSTRAINT listing_origin_reviews_reviewed_digest_valid CHECK (
    openarc_durable.is_canonical_sha256_digest(reviewed_endpoint_digest)
  ),
  CONSTRAINT listing_origin_reviews_reason_digest_valid CHECK (
    reason_digest IS NULL OR openarc_durable.is_canonical_sha256_digest(reason_digest)
  )
);

-- Generated receipt-shape columns: every review is exactly the origin-review
-- operation on a listing_version resource of the same org/listing/version.
ALTER TABLE openarc_tenant.listing_origin_reviews
  ADD COLUMN reviewed_resource_type text GENERATED ALWAYS AS ('listing_version') STORED,
  ADD COLUMN reviewed_resource_id text GENERATED ALWAYS AS (listing_id || '@' || version) STORED,
  ADD COLUMN reviewed_operation text GENERATED ALWAYS AS ('market.listing.origin_review.record') STORED;

-- Bind each review row to its exact durable receipt. The idempotency unique key
-- (organization_id, mutation_id, resource_type, resource_id, operation) already
-- exists from migration 0004 and the resource grammar is listingId@version.
ALTER TABLE openarc_tenant.listing_origin_reviews
  ADD CONSTRAINT listing_origin_reviews_receipt_fk FOREIGN KEY (
    organization_id, mutation_id, reviewed_resource_type, reviewed_resource_id, reviewed_operation
  ) REFERENCES openarc_durable.idempotency_records (
    organization_id, mutation_id, resource_type, resource_id, operation
  ) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED;

-- Append-only: reject UPDATE and DELETE for every caller including ordinary
-- migrator DML. Only the table owner may drop the trigger.
CREATE FUNCTION openarc_tenant.reject_listing_origin_review_mutation() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  RAISE EXCEPTION 'listing_origin_review_immutable' USING ERRCODE = '42501';
END;
$$;

CREATE TRIGGER listing_origin_reviews_append_only
  BEFORE UPDATE OR DELETE ON openarc_tenant.listing_origin_reviews
  FOR EACH ROW EXECUTE FUNCTION openarc_tenant.reject_listing_origin_review_mutation();

-- ---------------------------------------------------------------------------
-- Current-review pointer on listing_version_states. A reviewed state must
-- reference a review of the SAME organization/listing/version; an unreviewed
-- state has a null pointer.
-- ---------------------------------------------------------------------------
ALTER TABLE openarc_tenant.listing_version_states
  ADD COLUMN current_review_id uuid;

ALTER TABLE openarc_tenant.listing_version_states
  ADD CONSTRAINT listing_version_states_review_fk FOREIGN KEY (
    organization_id, listing_id, version, current_review_id
  ) REFERENCES openarc_tenant.listing_origin_reviews (
    organization_id, listing_id, version, review_id
  ) ON DELETE RESTRICT;

ALTER TABLE openarc_tenant.listing_version_states
  ADD CONSTRAINT listing_version_states_review_pointer_shape CHECK (
    (origin_review_state = 'unreviewed' AND current_review_id IS NULL)
    OR (origin_review_state IN ('approved', 'rejected') AND current_review_id IS NOT NULL)
  );

-- At most one active version per listing root.
CREATE UNIQUE INDEX listing_version_states_one_active
  ON openarc_tenant.listing_version_states (organization_id, listing_id)
  WHERE status = 'active';

-- ---------------------------------------------------------------------------
-- Deferred consistency: root.active_version iff the matching state is active,
-- and no orphan active state may exist. Active states already require an
-- approved review and published_at through the schema6 publication-shape CHECK.
-- ---------------------------------------------------------------------------
CREATE FUNCTION openarc_durable.assert_listing_active_pointer(
  p_organization_id text,
  p_listing_id text
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_active text;
  v_active_count integer;
  v_match integer;
BEGIN
  SELECT l.active_version INTO v_active
    FROM openarc_tenant.listings l
   WHERE l.organization_id = p_organization_id AND l.listing_id = p_listing_id;
  IF NOT FOUND THEN
    RETURN;
  END IF;
  SELECT count(*) INTO v_active_count
    FROM openarc_tenant.listing_version_states s
   WHERE s.organization_id = p_organization_id
     AND s.listing_id = p_listing_id
     AND s.status = 'active';
  IF v_active IS NULL THEN
    IF v_active_count <> 0 THEN
      RAISE EXCEPTION 'listing_active_orphan' USING ERRCODE = '23514';
    END IF;
    RETURN;
  END IF;
  IF v_active_count <> 1 THEN
    RAISE EXCEPTION 'listing_active_pointer' USING ERRCODE = '23514';
  END IF;
  SELECT count(*) INTO v_match
    FROM openarc_tenant.listing_version_states s
   WHERE s.organization_id = p_organization_id
     AND s.listing_id = p_listing_id
     AND s.version = v_active
     AND s.status = 'active'
     AND s.origin_review_state = 'approved'
     AND s.published_at IS NOT NULL;
  IF v_match <> 1 THEN
    RAISE EXCEPTION 'listing_active_pointer' USING ERRCODE = '23514';
  END IF;
END;
$$;

CREATE FUNCTION openarc_tenant.check_listings_active_pointer() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
BEGIN
  PERFORM openarc_durable.assert_listing_active_pointer(NEW.organization_id, NEW.listing_id);
  RETURN NULL;
END;
$$;

CREATE FUNCTION openarc_tenant.check_states_active_pointer() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
BEGIN
  PERFORM openarc_durable.assert_listing_active_pointer(NEW.organization_id, NEW.listing_id);
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER listings_active_pointer_consistent
  AFTER INSERT OR UPDATE ON openarc_tenant.listings
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION openarc_tenant.check_listings_active_pointer();

CREATE CONSTRAINT TRIGGER listing_version_states_active_consistent
  AFTER INSERT OR UPDATE ON openarc_tenant.listing_version_states
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION openarc_tenant.check_states_active_pointer();

-- ---------------------------------------------------------------------------
-- Root immutability is redefined: identity and latest_version invariants are
-- unchanged, but active_version may only advance when the transaction-local
-- lifecycle flag is set by a reviewed helper. The deferred constraint trigger
-- above is the stronger consistency guarantee.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION openarc_tenant.enforce_listing_root_immutable() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  IF NEW.organization_id IS DISTINCT FROM OLD.organization_id
     OR NEW.provider_id IS DISTINCT FROM OLD.provider_id
     OR NEW.listing_id IS DISTINCT FROM OLD.listing_id
     OR NEW.latest_version::numeric < OLD.latest_version::numeric THEN
    RAISE EXCEPTION 'listing_root_immutable' USING ERRCODE = '42501';
  END IF;
  IF NEW.active_version IS DISTINCT FROM OLD.active_version
     AND coalesce(current_setting('openarc.lifecycle_active_swap', true), '') <> 'on' THEN
    RAISE EXCEPTION 'listing_root_immutable' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;

-- ---------------------------------------------------------------------------
-- RLS: migrator-only policies on the new tables. Runtime/worker/PUBLIC get no
-- policy and no direct privilege.
-- ---------------------------------------------------------------------------
ALTER TABLE openarc_tenant.market_moderator_grants ENABLE ROW LEVEL SECURITY;
ALTER TABLE openarc_tenant.market_moderator_grants FORCE ROW LEVEL SECURITY;
ALTER TABLE openarc_tenant.listing_origin_reviews ENABLE ROW LEVEL SECURITY;
ALTER TABLE openarc_tenant.listing_origin_reviews FORCE ROW LEVEL SECURITY;

CREATE POLICY market_moderator_grants_migrator ON openarc_tenant.market_moderator_grants
  FOR ALL TO openarc_migrator USING (true) WITH CHECK (true);
CREATE POLICY listing_origin_reviews_migrator ON openarc_tenant.listing_origin_reviews
  FOR ALL TO openarc_migrator USING (true) WITH CHECK (true);

-- Regression fix (discovered by the real API integration): the accepted
-- `SELECT providers ... FOR UPDATE` row lock in the market definer helpers is
-- evaluated against the UPDATE policies, and schema4 only added a migrator
-- SELECT policy. provider_admin/provider_developer drafts therefore failed
-- while owner succeeded. This migrator-only UPDATE policy restores the row lock
-- for SECURITY DEFINER helpers. It grants NOTHING to any runtime role (which
-- holds no table privilege) and does not weaken the owner-only runtime
-- providers_update policy. The helper-level role checks are retained.
CREATE POLICY providers_update_migrator ON openarc_tenant.providers
  FOR UPDATE TO openarc_migrator
  USING (current_user = 'openarc_migrator')
  WITH CHECK (current_user = 'openarc_migrator');

REVOKE ALL ON TABLE openarc_tenant.market_moderator_grants FROM PUBLIC;
REVOKE ALL ON TABLE openarc_tenant.listing_origin_reviews FROM PUBLIC;
REVOKE ALL ON FUNCTION openarc_durable.reviewed_endpoint_digest(text, text, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION openarc_durable.assert_listing_active_pointer(text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION openarc_tenant.check_listings_active_pointer() FROM PUBLIC;
REVOKE ALL ON FUNCTION openarc_tenant.check_states_active_pointer() FROM PUBLIC;
REVOKE ALL ON FUNCTION openarc_tenant.reject_listing_origin_review_mutation() FROM PUBLIC;

CREATE INDEX listing_origin_reviews_org_idx
  ON openarc_tenant.listing_origin_reviews (organization_id, listing_id, version, created_at);

-- ---------------------------------------------------------------------------
-- Closed operation/digest/event union extensions for the four lifecycle
-- operations, applied atomically. The listing_version grammar is per-operation:
-- the two legacy creation operations still require version >= 2, while the four
-- lifecycle operations may target version 1.
-- ---------------------------------------------------------------------------
ALTER TABLE openarc_durable.idempotency_records
  DROP CONSTRAINT idempotency_operation_valid,
  DROP CONSTRAINT idempotency_digest_version_valid,
  DROP CONSTRAINT idempotency_resource_type_valid,
  DROP CONSTRAINT idempotency_resource_matches_operation,
  DROP CONSTRAINT idempotency_market_resource_shape;

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
    'tenant.provider.credential.revoke',
    'market.listing.create',
    'market.listing.version.create',
    'market.listing.origin_review.record',
    'market.listing.version.publish',
    'market.listing.version.pause',
    'market.listing.version.retire'
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
    'tenant.provider.credential.revoke.v1',
    'market.listing.create.v1',
    'market.listing.version.create.v1',
    'market.listing.origin_review.record.v1',
    'market.listing.version.publish.v1',
    'market.listing.version.pause.v1',
    'market.listing.version.retire.v1'
  )),
  ADD CONSTRAINT idempotency_resource_type_valid CHECK (resource_type IS NULL OR resource_type IN (
    'organization', 'agent', 'provider', 'membership',
    'agent_credential', 'provider_credential',
    'listing', 'listing_version'
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
      WHEN 'market.listing.create' THEN 'listing'
      WHEN 'market.listing.version.create' THEN 'listing_version'
      WHEN 'market.listing.origin_review.record' THEN 'listing_version'
      WHEN 'market.listing.version.publish' THEN 'listing_version'
      WHEN 'market.listing.version.pause' THEN 'listing_version'
      WHEN 'market.listing.version.retire' THEN 'listing_version'
    END
  ),
  ADD CONSTRAINT idempotency_market_resource_shape CHECK (
    (resource_type = 'listing' AND resource_id IS NOT NULL AND listing_id = resource_id AND listing_version IS NULL)
    OR (resource_type = 'listing_version' AND listing_version IS NOT NULL
        AND openarc_durable.is_canonical_listing_id(listing_id)
        AND openarc_durable.is_canonical_listing_version(listing_version)
        AND resource_id = listing_id || '@' || listing_version
        AND CASE
          WHEN operation IN ('market.listing.version.create') THEN listing_version::numeric >= 2
          WHEN operation IN (
            'market.listing.origin_review.record',
            'market.listing.version.publish',
            'market.listing.version.pause',
            'market.listing.version.retire'
          ) THEN listing_version::numeric >= 1
          ELSE false
        END)
    OR (resource_type IS NULL OR resource_type NOT IN ('listing', 'listing_version'))
  );

-- ---------------------------------------------------------------------------
-- Moderator authority preamble. Resolves the actual account from the held
-- session, requires fresh non-recovery proof (<5 minutes by DB clock), an active
-- explicit moderator grant, and an active organization. It DENIES any
-- membership of that account in the target organization, even an inactive one,
-- so an organization role can never confer or launder moderation.
-- ---------------------------------------------------------------------------
CREATE FUNCTION openarc_durable.lock_moderator_actor(
  session_hash text,
  organization_id text
) RETURNS TABLE(out_actor text)
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
  v_now timestamptz;
BEGIN
  IF NOT openarc_durable.is_canonical_org_id(organization_id) THEN
    RAISE EXCEPTION 'moderator_organization_invalid' USING ERRCODE = '22023';
  END IF;
  SELECT l.account_id, l.method, l.session_created_at, l.session_expires_at
    INTO v_actor, v_method, v_created_at, v_expires_at
    FROM openarc_tenant.lock_auth_session(session_hash, NULL) AS l;
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'moderator_session_invalid' USING ERRCODE = '28000';
  END IF;
  PERFORM 1 FROM openarc_tenant.organizations o
   WHERE o.organization_id = organization_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'moderator_forbidden' USING ERRCODE = '42501';
  END IF;
  IF EXISTS (
    SELECT 1 FROM openarc_tenant.memberships m
     WHERE m.organization_id = organization_id AND m.account_id = v_actor FOR UPDATE
  ) THEN
    RAISE EXCEPTION 'moderator_forbidden' USING ERRCODE = '42501';
  END IF;
  PERFORM 1 FROM openarc_tenant.market_moderator_grants g
   WHERE g.account_id = v_actor AND g.status = 'active' FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'moderator_forbidden' USING ERRCODE = '42501';
  END IF;
  SELECT l.account_id, l.method, l.session_created_at, l.session_expires_at
    INTO v_actor, v_method, v_created_at, v_expires_at
    FROM openarc_tenant.lock_auth_session(session_hash, NULL) AS l;
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'moderator_session_invalid' USING ERRCODE = '28000';
  END IF;
  SELECT clock_timestamp() INTO v_now;
  IF NOT (v_expires_at > v_now) THEN
    RAISE EXCEPTION 'moderator_session_invalid' USING ERRCODE = '28000';
  END IF;
  IF v_method = 'recovery' OR NOT (v_created_at > v_now - interval '5 minutes') THEN
    RAISE EXCEPTION 'moderator_proof_stale' USING ERRCODE = '28000';
  END IF;
  out_actor := v_actor;
  RETURN NEXT;
END;
$$;

-- Shared owner-write preamble for the three lifecycle transition helpers. Keeps
-- the accepted market write authority: active owner/provider_admin/
-- provider_developer, active org + same active provider, fresh non-recovery
-- proof. Returns the resolved actor, role and provider id.
CREATE FUNCTION openarc_durable.lock_lifecycle_writer(
  session_hash text,
  organization_id text,
  listing_id text
) RETURNS TABLE(out_actor text, out_role text, out_provider_id text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
#variable_conflict use_variable
DECLARE
  v_actor text;
  v_role text;
  v_provider_id text;
  v_provider_status text;
BEGIN
  SELECT l.out_actor, l.out_role INTO v_actor, v_role
    FROM openarc_durable.lock_market_actor(session_hash, organization_id, true, false) AS l;
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'lifecycle_forbidden' USING ERRCODE = '42501';
  END IF;
  IF v_role NOT IN ('owner', 'provider_admin', 'provider_developer') THEN
    RAISE EXCEPTION 'lifecycle_forbidden' USING ERRCODE = '42501';
  END IF;
  IF NOT openarc_durable.is_canonical_listing_id(listing_id) THEN
    RAISE EXCEPTION 'lifecycle_listing_invalid' USING ERRCODE = '22023';
  END IF;
  -- Resolve the owning provider WITHOUT authority first, then lock/revalidate.
  SELECT l.provider_id INTO v_provider_id
    FROM openarc_tenant.listings l
   WHERE l.organization_id = organization_id AND l.listing_id = listing_id;
  IF NOT FOUND OR v_provider_id IS NULL THEN
    RAISE EXCEPTION 'lifecycle_not_found' USING ERRCODE = '23503';
  END IF;
  SELECT p.status INTO v_provider_status
    FROM openarc_tenant.providers p
   WHERE p.organization_id = organization_id AND p.provider_id = v_provider_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lifecycle_not_found' USING ERRCODE = '23503';
  END IF;
  IF v_provider_status <> 'active' THEN
    RAISE EXCEPTION 'lifecycle_forbidden' USING ERRCODE = '42501';
  END IF;
  out_actor := v_actor;
  out_role := v_role;
  out_provider_id := v_provider_id;
  RETURN NEXT;
END;
$$;

-- ---------------------------------------------------------------------------
-- market.listing.origin_review.record
-- ---------------------------------------------------------------------------
CREATE FUNCTION openarc_durable.commit_origin_review(
  session_hash text,
  organization_id text,
  listing_id text,
  version text,
  expected_updated_at timestamptz,
  decision text,
  reviewed_digest text,
  reason_code text,
  reason_digest text,
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
  v_provider_id text;
  v_state_status text;
  v_origin text;
  v_path text;
  v_computed text;
  v_existing record;
  v_review_id uuid;
  v_resource_id text;
  v_committed_at timestamptz;
  v_new_updated timestamptz;
  v_recheck text;
BEGIN
  IF NOT openarc_durable.is_canonical_listing_id(listing_id) THEN
    RAISE EXCEPTION 'lifecycle_listing_invalid' USING ERRCODE = '22023';
  END IF;
  IF NOT openarc_durable.is_canonical_listing_version(version) THEN
    RAISE EXCEPTION 'lifecycle_version_invalid' USING ERRCODE = '22023';
  END IF;
  IF expected_updated_at IS NULL THEN
    RAISE EXCEPTION 'lifecycle_cas_invalid' USING ERRCODE = '22023';
  END IF;
  IF decision IS NULL OR decision NOT IN ('approved', 'rejected') THEN
    RAISE EXCEPTION 'lifecycle_decision_invalid' USING ERRCODE = '22023';
  END IF;
  IF reason_code IS NULL OR reason_code NOT IN (
    'manual_review', 'origin_policy', 'terms_policy', 'manifest_policy', 'other'
  ) THEN
    RAISE EXCEPTION 'lifecycle_reason_invalid' USING ERRCODE = '22023';
  END IF;
  IF NOT openarc_durable.is_canonical_sha256_digest(reviewed_digest) THEN
    RAISE EXCEPTION 'lifecycle_digest_invalid' USING ERRCODE = '22023';
  END IF;
  IF reason_digest IS NOT NULL AND NOT openarc_durable.is_canonical_sha256_digest(reason_digest) THEN
    RAISE EXCEPTION 'lifecycle_reason_digest_invalid' USING ERRCODE = '22023';
  END IF;
  IF mutation_id IS NULL OR NOT openarc_durable.is_canonical_uuid_v4(mutation_id::text) THEN
    RAISE EXCEPTION 'lifecycle_mutation_invalid' USING ERRCODE = '22023';
  END IF;
  IF NOT openarc_durable.is_canonical_hex64(key_hash)
     OR NOT openarc_durable.is_canonical_hex64(request_digest)
     OR NOT openarc_durable.is_canonical_hex64(session_context_digest) THEN
    RAISE EXCEPTION 'lifecycle_metadata_invalid' USING ERRCODE = '22023';
  END IF;

  SELECT m.out_actor INTO v_actor
    FROM openarc_durable.lock_moderator_actor(session_hash, organization_id) AS m;
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'lifecycle_forbidden' USING ERRCODE = '42501';
  END IF;

  -- Same-key replay follows current authority but MUST precede every state/CAS
  -- check so a committed review replays its original receipt even after the
  -- version was subsequently retired or its token advanced.
  SELECT * INTO v_existing
    FROM openarc_durable.idempotency_records r
   WHERE r.organization_id = organization_id AND r.operation = 'market.listing.origin_review.record'
     AND r.key_hash = key_hash FOR UPDATE;
  IF FOUND THEN
    IF v_existing.request_digest = request_digest
       AND v_existing.mutation_id = mutation_id
       AND v_existing.actor_account_id = v_actor
       AND v_existing.session_context_digest = session_context_digest
       AND v_existing.status = 'committed' THEN
      SELECT m.out_actor INTO v_recheck
        FROM openarc_durable.lock_moderator_actor(session_hash, organization_id) AS m;
      IF v_recheck IS NULL OR v_recheck <> v_actor THEN
        RAISE EXCEPTION 'lifecycle_session_invalid' USING ERRCODE = '28000';
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
    RAISE EXCEPTION 'lifecycle_idempotency_conflict' USING ERRCODE = 'P0D01';
  END IF;
  SELECT l.provider_id INTO v_provider_id
    FROM openarc_tenant.listings l
   WHERE l.organization_id = organization_id AND l.listing_id = listing_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lifecycle_not_found' USING ERRCODE = '23503';
  END IF;
  SELECT s.status INTO v_state_status
    FROM openarc_tenant.listing_version_states s
   WHERE s.organization_id = organization_id AND s.listing_id = listing_id AND s.version = version
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lifecycle_not_found' USING ERRCODE = '23503';
  END IF;
  IF v_state_status = 'retired' THEN
    RAISE EXCEPTION 'lifecycle_retired' USING ERRCODE = '23514';
  END IF;
  SELECT v.endpoint_contract->>'origin', v.endpoint_contract->>'path'
    INTO v_origin, v_path
    FROM openarc_tenant.listing_versions v
   WHERE v.organization_id = organization_id AND v.listing_id = listing_id AND v.version = version;
  IF v_origin IS NULL OR v_path IS NULL THEN
    RAISE EXCEPTION 'lifecycle_not_found' USING ERRCODE = '23503';
  END IF;
  v_computed := openarc_durable.reviewed_endpoint_digest(listing_id, version, v_origin, v_path);
  IF v_computed <> reviewed_digest THEN
    RAISE EXCEPTION 'lifecycle_digest_mismatch' USING ERRCODE = '23514';
  END IF;

  PERFORM 1 FROM openarc_durable.idempotency_records r
   WHERE r.organization_id = organization_id AND r.mutation_id = mutation_id FOR UPDATE;
  IF FOUND THEN
    RAISE EXCEPTION 'lifecycle_idempotency_conflict' USING ERRCODE = 'P0D01';
  END IF;

  PERFORM 1 FROM openarc_tenant.listing_version_states s
   WHERE s.organization_id = organization_id AND s.listing_id = listing_id
     AND s.version = version AND s.updated_at = expected_updated_at FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lifecycle_cas_conflict' USING ERRCODE = '23505';
  END IF;

  v_review_id := mutation_id;
  v_resource_id := listing_id || '@' || version;
  v_new_updated := GREATEST(clock_timestamp(), expected_updated_at + interval '1 microsecond');

  INSERT INTO openarc_durable.idempotency_records (
    organization_id, operation, key_hash, request_digest, digest_version,
    actor_account_id, session_context_digest, network, mutation_id, status
  ) VALUES (
    organization_id, 'market.listing.origin_review.record', key_hash, request_digest,
    'market.listing.origin_review.record.v1', v_actor, session_context_digest,
    'eip155:5042002', mutation_id, 'pending'
  );

  INSERT INTO openarc_tenant.listing_origin_reviews (
    review_id, organization_id, listing_id, version, provider_id, mutation_id,
    reviewer_account_id, decision, reviewed_endpoint_digest, reason_code, reason_digest
  ) VALUES (
    v_review_id, organization_id, listing_id, version, v_provider_id, mutation_id,
    v_actor, decision, reviewed_digest, reason_code, reason_digest
  );

  IF decision = 'rejected' AND v_state_status = 'active' THEN
    PERFORM set_config('openarc.lifecycle_active_swap', 'on', true);
    UPDATE openarc_tenant.listing_version_states s
       SET status = 'paused',
           origin_review_state = decision,
           current_review_id = v_review_id,
           updated_at = v_new_updated
     WHERE s.organization_id = organization_id AND s.listing_id = listing_id
       AND s.version = version AND s.updated_at = expected_updated_at;
    UPDATE openarc_tenant.listings l
       SET active_version = NULL, updated_at = GREATEST(clock_timestamp(), l.updated_at + interval '1 microsecond')
     WHERE l.organization_id = organization_id AND l.listing_id = listing_id;
    PERFORM set_config('openarc.lifecycle_active_swap', 'off', true);
  ELSE
    UPDATE openarc_tenant.listing_version_states s
       SET origin_review_state = decision,
           current_review_id = v_review_id,
           updated_at = v_new_updated
     WHERE s.organization_id = organization_id AND s.listing_id = listing_id
       AND s.version = version AND s.updated_at = expected_updated_at;
  END IF;

  UPDATE openarc_durable.idempotency_records r
     SET status = 'committed', resource_type = 'listing_version',
         resource_id = v_resource_id, committed_at = clock_timestamp()
   WHERE r.organization_id = organization_id AND r.operation = 'market.listing.origin_review.record'
     AND r.key_hash = key_hash
   RETURNING r.committed_at INTO v_committed_at;

  INSERT INTO openarc_durable.audit_events (
    organization_id, actor_account_id, operation, mutation_id, resource_type, resource_id, outcome
  ) VALUES (
    organization_id, v_actor, 'market.listing.origin_review.record', mutation_id,
    'listing_version', v_resource_id, 'committed'
  );
  INSERT INTO openarc_durable.outbox_events (
    organization_id, mutation_id, resource_type, resource_id, event_type, payload_version
  ) VALUES (
    organization_id, mutation_id, 'listing_version', v_resource_id,
    'market.listing.origin_review.recorded', 1
  );

  SELECT m.out_actor INTO v_recheck
    FROM openarc_durable.lock_moderator_actor(session_hash, organization_id) AS m;
  IF v_recheck IS NULL OR v_recheck <> v_actor THEN
    RAISE EXCEPTION 'lifecycle_session_invalid' USING ERRCODE = '28000';
  END IF;

  out_replayed := false;
  out_mutation_id := mutation_id;
  out_operation := 'market.listing.origin_review.record';
  out_resource_type := 'listing_version';
  out_resource_id := v_resource_id;
  out_committed_at := v_committed_at;
  RETURN NEXT;
END;
$$;

-- ---------------------------------------------------------------------------
-- Public catalog. Explicit public allowlist only: no organization, account,
-- session, review, endpoint path, credential or private note is returned. A
-- snapshot of eligible metadata is NOT purchase authorization.
-- ---------------------------------------------------------------------------
CREATE FUNCTION openarc_durable.list_public_listings(
  after_listing_id text,
  page_limit integer,
  filter_kind text,
  filter_provider_id text,
  search_q text
) RETURNS TABLE(
  out_listing_id text,
  out_provider_id text,
  out_version text,
  out_kind text,
  out_title text,
  out_description text,
  out_manifest jsonb,
  out_price jsonb,
  out_evidence_contract jsonb,
  out_endpoint_origin text,
  out_terms_revision text,
  out_privacy_summary text,
  out_payment_lane text,
  out_availability jsonb,
  out_status text,
  out_published_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
#variable_conflict use_variable
DECLARE
  v_limit integer;
BEGIN
  IF page_limit IS NULL OR page_limit < 1 OR page_limit > 51 THEN
    RAISE EXCEPTION 'catalog_page_invalid' USING ERRCODE = '22023';
  END IF;
  IF after_listing_id IS NOT NULL AND NOT openarc_durable.is_canonical_listing_id(after_listing_id) THEN
    RAISE EXCEPTION 'catalog_page_invalid' USING ERRCODE = '22023';
  END IF;
  IF filter_kind IS NOT NULL AND filter_kind NOT IN (
    'api', 'mcp_tool', 'data', 'model', 'workflow', 'agent'
  ) THEN
    RAISE EXCEPTION 'catalog_kind_invalid' USING ERRCODE = '22023';
  END IF;
  IF filter_provider_id IS NOT NULL
     AND filter_provider_id !~ '^openarc:provider:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' THEN
    RAISE EXCEPTION 'catalog_provider_invalid' USING ERRCODE = '22023';
  END IF;
  -- The public query is the exact shared trimmed-text contract: JS-trimmed at
  -- both edges, no C0/C1 control characters, and 1..80 UTF-16 code units. A
  -- SQL wildcard stays a literal character searched with strpos.
  IF search_q IS NOT NULL AND NOT openarc_durable.is_js_trimmed_text(search_q, 80) THEN
    RAISE EXCEPTION 'catalog_query_invalid' USING ERRCODE = '22023';
  END IF;
  v_limit := page_limit;
  RETURN QUERY
    SELECT l.listing_id, l.provider_id, v.version, v.kind, v.title, v.description,
           v.manifest, v.price, v.evidence_contract, v.endpoint_contract->>'origin',
           v.terms_revision, v.privacy_summary, v.payment_lane, v.availability,
           'active'::text, s.published_at
      FROM openarc_tenant.listings l
      JOIN openarc_tenant.listing_version_states s
        ON s.organization_id = l.organization_id
       AND s.listing_id = l.listing_id
       AND s.version = l.active_version
      JOIN openarc_tenant.listing_versions v
        ON v.organization_id = l.organization_id
       AND v.listing_id = l.listing_id
       AND v.version = l.active_version
      JOIN openarc_tenant.providers p
        ON p.organization_id = l.organization_id
       AND p.provider_id = l.provider_id
      JOIN openarc_tenant.organizations o
        ON o.organization_id = l.organization_id
     WHERE l.active_version IS NOT NULL
       AND s.status = 'active'
       AND s.origin_review_state = 'approved'
       AND s.published_at IS NOT NULL
       AND p.status = 'active'
       AND (after_listing_id IS NULL OR l.listing_id > after_listing_id)
       AND (filter_kind IS NULL OR v.kind = filter_kind)
       AND (filter_provider_id IS NULL OR l.provider_id = filter_provider_id)
       AND (
         search_q IS NULL
         OR strpos(lower(v.title), lower(search_q)) > 0
         OR strpos(lower(v.description), lower(search_q)) > 0
       )
     ORDER BY l.listing_id
     LIMIT v_limit;
END;
$$;

CREATE FUNCTION openarc_durable.get_public_listing(
  listing_id text
) RETURNS TABLE(
  out_listing_id text,
  out_provider_id text,
  out_version text,
  out_kind text,
  out_title text,
  out_description text,
  out_manifest jsonb,
  out_price jsonb,
  out_evidence_contract jsonb,
  out_endpoint_origin text,
  out_terms_revision text,
  out_privacy_summary text,
  out_payment_lane text,
  out_availability jsonb,
  out_status text,
  out_published_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
#variable_conflict use_variable
BEGIN
  IF NOT openarc_durable.is_canonical_listing_id(listing_id) THEN
    RAISE EXCEPTION 'catalog_listing_invalid' USING ERRCODE = '22023';
  END IF;
  RETURN QUERY
    SELECT l.listing_id, l.provider_id, v.version, v.kind, v.title, v.description,
           v.manifest, v.price, v.evidence_contract, v.endpoint_contract->>'origin',
           v.terms_revision, v.privacy_summary, v.payment_lane, v.availability,
           'active'::text, s.published_at
      FROM openarc_tenant.listings l
      JOIN openarc_tenant.listing_version_states s
        ON s.organization_id = l.organization_id
       AND s.listing_id = l.listing_id
       AND s.version = l.active_version
      JOIN openarc_tenant.listing_versions v
        ON v.organization_id = l.organization_id
       AND v.listing_id = l.listing_id
       AND v.version = l.active_version
      JOIN openarc_tenant.providers p
        ON p.organization_id = l.organization_id
       AND p.provider_id = l.provider_id
      JOIN openarc_tenant.organizations o
        ON o.organization_id = l.organization_id
     WHERE l.listing_id = listing_id
       AND l.active_version IS NOT NULL
       AND s.status = 'active'
       AND s.origin_review_state = 'approved'
       AND s.published_at IS NOT NULL
       AND p.status = 'active';
END;
$$;

-- A public provider exists only for an active provider with at least one
-- currently eligible active listing. No public profile for a private/empty
-- provider merely because its own status is active.
CREATE FUNCTION openarc_durable.get_public_provider(
  provider_id text
) RETURNS TABLE(
  out_provider_id text,
  out_display_name text,
  out_status text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
#variable_conflict use_variable
BEGIN
  IF provider_id IS NULL
     OR provider_id !~ '^openarc:provider:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' THEN
    RAISE EXCEPTION 'catalog_provider_invalid' USING ERRCODE = '22023';
  END IF;
  RETURN QUERY
    SELECT p.provider_id, p.display_name, 'active'::text
      FROM openarc_tenant.providers p
     WHERE p.provider_id = provider_id
       AND p.status = 'active'
       AND EXISTS (
         SELECT 1
           FROM openarc_tenant.listings l
           JOIN openarc_tenant.listing_version_states s
             ON s.organization_id = l.organization_id
            AND s.listing_id = l.listing_id
            AND s.version = l.active_version
          WHERE l.organization_id = p.organization_id
            AND l.provider_id = p.provider_id
            AND l.active_version IS NOT NULL
            AND s.status = 'active'
            AND s.origin_review_state = 'approved'
            AND s.published_at IS NOT NULL
       );
END;
$$;

-- ---------------------------------------------------------------------------
-- Owner root read. All five active organization roles may read; recovery is
-- allowed. An inactive provider does not deny owner history reads.
-- ---------------------------------------------------------------------------
CREATE FUNCTION openarc_durable.read_owner_listing(
  session_hash text,
  organization_id text,
  listing_id text
) RETURNS TABLE(
  out_listing_id text,
  out_organization_id text,
  out_provider_id text,
  out_active_version text,
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
  v_recheck text;
BEGIN
  IF NOT openarc_durable.is_canonical_listing_id(listing_id) THEN
    RAISE EXCEPTION 'lifecycle_listing_invalid' USING ERRCODE = '22023';
  END IF;
  SELECT l.out_actor INTO v_actor
    FROM openarc_durable.lock_market_actor(session_hash, organization_id, false, true) AS l;
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'lifecycle_forbidden' USING ERRCODE = '42501';
  END IF;
  SELECT l.out_actor INTO v_recheck
    FROM openarc_durable.lock_market_actor(session_hash, organization_id, false, true) AS l;
  IF v_recheck IS NULL OR v_recheck <> v_actor THEN
    RAISE EXCEPTION 'lifecycle_session_invalid' USING ERRCODE = '28000';
  END IF;
  RETURN QUERY
    SELECT l.listing_id, l.organization_id, l.provider_id, l.active_version,
           l.created_at, l.updated_at
      FROM openarc_tenant.listings l
     WHERE l.organization_id = organization_id AND l.listing_id = listing_id;
  SELECT l.out_actor INTO v_recheck
    FROM openarc_durable.lock_market_actor(session_hash, organization_id, false, true) AS l;
  IF v_recheck IS NULL OR v_recheck <> v_actor THEN
    RAISE EXCEPTION 'lifecycle_session_invalid' USING ERRCODE = '28000';
  END IF;
END;
$$;

-- ---------------------------------------------------------------------------
-- Read-only provider picker for a single organization. Includes inactive
-- provider metadata for history/picker; strictly ascending provider id.
-- ---------------------------------------------------------------------------
CREATE FUNCTION openarc_durable.list_market_providers(
  session_hash text,
  organization_id text,
  after_provider_id text,
  page_limit integer
) RETURNS TABLE(
  out_provider_id text,
  out_display_name text,
  out_status text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
#variable_conflict use_variable
DECLARE
  v_actor text;
  v_limit integer;
  v_recheck text;
BEGIN
  IF page_limit IS NULL OR page_limit < 1 OR page_limit > 51 THEN
    RAISE EXCEPTION 'lifecycle_page_invalid' USING ERRCODE = '22023';
  END IF;
  IF after_provider_id IS NOT NULL
     AND after_provider_id !~ '^openarc:provider:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' THEN
    RAISE EXCEPTION 'lifecycle_page_invalid' USING ERRCODE = '22023';
  END IF;
  v_limit := page_limit;
  SELECT l.out_actor INTO v_actor
    FROM openarc_durable.lock_market_actor(session_hash, organization_id, false, true) AS l;
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'lifecycle_forbidden' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
    SELECT p.provider_id, p.display_name, p.status
      FROM openarc_tenant.providers p
     WHERE p.organization_id = organization_id
       AND (after_provider_id IS NULL OR p.provider_id > after_provider_id)
     ORDER BY p.provider_id
     LIMIT v_limit;
  SELECT l.out_actor INTO v_recheck
    FROM openarc_durable.lock_market_actor(session_hash, organization_id, false, true) AS l;
  IF v_recheck IS NULL OR v_recheck <> v_actor THEN
    RAISE EXCEPTION 'lifecycle_session_invalid' USING ERRCODE = '28000';
  END IF;
END;
$$;

-- ---------------------------------------------------------------------------
-- Moderator version read: same accepted owner-version projection as the owner
-- reader, resolved under explicit moderator authority.
-- ---------------------------------------------------------------------------
CREATE FUNCTION openarc_durable.get_moderator_listing_version(
  session_hash text,
  organization_id text,
  listing_id text,
  version text
) RETURNS TABLE(
  out_listing_id text,
  out_organization_id text,
  out_provider_id text,
  out_version text,
  out_kind text,
  out_title text,
  out_description text,
  out_manifest jsonb,
  out_price jsonb,
  out_evidence_contract jsonb,
  out_endpoint_contract jsonb,
  out_origin_review_state text,
  out_terms_revision text,
  out_privacy_summary text,
  out_payment_lane text,
  out_availability jsonb,
  out_status text,
  out_created_at timestamptz,
  out_updated_at timestamptz,
  out_published_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
#variable_conflict use_variable
DECLARE
  v_actor text;
  v_recheck text;
BEGIN
  IF NOT openarc_durable.is_canonical_listing_id(listing_id) THEN
    RAISE EXCEPTION 'lifecycle_listing_invalid' USING ERRCODE = '22023';
  END IF;
  IF NOT openarc_durable.is_canonical_listing_version(version) THEN
    RAISE EXCEPTION 'lifecycle_version_invalid' USING ERRCODE = '22023';
  END IF;
  SELECT m.out_actor INTO v_actor
    FROM openarc_durable.lock_moderator_actor(session_hash, organization_id) AS m;
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'lifecycle_forbidden' USING ERRCODE = '42501';
  END IF;
  SELECT m.out_actor INTO v_recheck
    FROM openarc_durable.lock_moderator_actor(session_hash, organization_id) AS m;
  IF v_recheck IS NULL OR v_recheck <> v_actor THEN
    RAISE EXCEPTION 'lifecycle_session_invalid' USING ERRCODE = '28000';
  END IF;
  RETURN QUERY
    SELECT v.listing_id, v.organization_id, v.provider_id, v.version, v.kind,
           v.title, v.description, v.manifest, v.price, v.evidence_contract,
           v.endpoint_contract, s.origin_review_state, v.terms_revision,
           v.privacy_summary, v.payment_lane, v.availability, s.status,
           v.created_at, s.updated_at, s.published_at
      FROM openarc_tenant.listing_versions v
      JOIN openarc_tenant.listing_version_states s
        ON s.organization_id = v.organization_id
       AND s.listing_id = v.listing_id
       AND s.version = v.version
     WHERE v.organization_id = organization_id AND v.listing_id = listing_id
       AND v.version = version;
  SELECT m.out_actor INTO v_recheck
    FROM openarc_durable.lock_moderator_actor(session_hash, organization_id) AS m;
  IF v_recheck IS NULL OR v_recheck <> v_actor THEN
    RAISE EXCEPTION 'lifecycle_session_invalid' USING ERRCODE = '28000';
  END IF;
END;
$$;

-- ---------------------------------------------------------------------------
-- Lifecycle mutation status: the same actor's committed receipt for one of the
-- four lifecycle operations, resolved with current provider read authority OR
-- current independent moderator authority. Unknown/cross-actor -> no row.
-- ---------------------------------------------------------------------------
CREATE FUNCTION openarc_durable.read_lifecycle_mutation_status(
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
  v_read_actor text;
  v_recheck text;
  v_found boolean := false;
  v_mutation_id uuid;
  v_operation text;
  v_resource_type text;
  v_resource_id text;
  v_committed_at timestamptz;
BEGIN
  IF NOT openarc_durable.is_canonical_org_id(organization_id) THEN
    RAISE EXCEPTION 'lifecycle_organization_invalid' USING ERRCODE = '22023';
  END IF;
  IF mutation_id IS NULL THEN
    RAISE EXCEPTION 'lifecycle_mutation_invalid' USING ERRCODE = '22023';
  END IF;
  -- Provider read authority (all five active roles, recovery allowed). An
  -- independent moderator has no membership, so the org read predicate raises
  -- the expected 42501; ONLY that expected permission code is absorbed so the
  -- strict moderator fallback can run. Session/proof errors (28000) and every
  -- other SQL error still propagate unchanged.
  BEGIN
    SELECT l.out_actor INTO v_read_actor
      FROM openarc_durable.lock_market_actor(session_hash, organization_id, false, true) AS l;
  EXCEPTION WHEN SQLSTATE '42501' THEN
    v_read_actor := NULL;
  END;
  IF v_read_actor IS NOT NULL THEN
    v_actor := v_read_actor;
  ELSE
    SELECT m.out_actor INTO v_actor
      FROM openarc_durable.lock_moderator_actor(session_hash, organization_id) AS m;
    IF v_actor IS NULL THEN
      RAISE EXCEPTION 'lifecycle_forbidden' USING ERRCODE = '42501';
    END IF;
  END IF;
  SELECT r.mutation_id, r.operation, r.resource_type, r.resource_id, r.committed_at
    INTO v_mutation_id, v_operation, v_resource_type, v_resource_id, v_committed_at
    FROM openarc_durable.idempotency_records r
   WHERE r.organization_id = organization_id AND r.mutation_id = mutation_id
     AND r.actor_account_id = v_actor AND r.status = 'committed'
     AND r.operation IN (
       'market.listing.origin_review.record',
       'market.listing.version.publish',
       'market.listing.version.pause',
       'market.listing.version.retire'
     );
  v_found := FOUND;
  IF v_read_actor IS NOT NULL THEN
    SELECT l.out_actor INTO v_recheck
      FROM openarc_durable.lock_market_actor(session_hash, organization_id, false, true) AS l;
  ELSE
    SELECT m.out_actor INTO v_recheck
      FROM openarc_durable.lock_moderator_actor(session_hash, organization_id) AS m;
  END IF;
  IF v_recheck IS NULL OR v_recheck <> v_actor THEN
    RAISE EXCEPTION 'lifecycle_session_invalid' USING ERRCODE = '28000';
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
-- market.listing.version.publish / pause / retire. One helper with an explicit
-- closed operation; exact CAS on both the state updated_at token and the root
-- active-version pointer. Idempotent replay is checked before the CAS.
-- ---------------------------------------------------------------------------
CREATE FUNCTION openarc_durable.commit_lifecycle_transition(
  session_hash text,
  organization_id text,
  listing_id text,
  version text,
  operation text,
  expected_updated_at timestamptz,
  expected_active_version text,
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
  v_provider_id text;
  v_status text;
  v_review_state text;
  v_review_id uuid;
  v_published_at timestamptz;
  v_state_updated timestamptz;
  v_root_active text;
  v_expected_op text;
  v_existing record;
  v_resource_id text;
  v_committed_at timestamptz;
  v_new_updated timestamptz;
  v_now timestamptz;
  v_recheck text;
BEGIN
  IF operation NOT IN (
    'market.listing.version.publish',
    'market.listing.version.pause',
    'market.listing.version.retire'
  ) THEN
    RAISE EXCEPTION 'lifecycle_operation_invalid' USING ERRCODE = '22023';
  END IF;
  IF NOT openarc_durable.is_canonical_listing_id(listing_id) THEN
    RAISE EXCEPTION 'lifecycle_listing_invalid' USING ERRCODE = '22023';
  END IF;
  IF NOT openarc_durable.is_canonical_listing_version(version) THEN
    RAISE EXCEPTION 'lifecycle_version_invalid' USING ERRCODE = '22023';
  END IF;
  IF expected_updated_at IS NULL THEN
    RAISE EXCEPTION 'lifecycle_cas_invalid' USING ERRCODE = '22023';
  END IF;
  IF expected_active_version IS NOT NULL
     AND NOT openarc_durable.is_canonical_listing_version(expected_active_version) THEN
    RAISE EXCEPTION 'lifecycle_active_version_invalid' USING ERRCODE = '22023';
  END IF;
  IF mutation_id IS NULL OR NOT openarc_durable.is_canonical_uuid_v4(mutation_id::text) THEN
    RAISE EXCEPTION 'lifecycle_mutation_invalid' USING ERRCODE = '22023';
  END IF;
  IF NOT openarc_durable.is_canonical_hex64(key_hash)
     OR NOT openarc_durable.is_canonical_hex64(request_digest)
     OR NOT openarc_durable.is_canonical_hex64(session_context_digest) THEN
    RAISE EXCEPTION 'lifecycle_metadata_invalid' USING ERRCODE = '22023';
  END IF;

  SELECT l.provider_id INTO v_provider_id
    FROM openarc_tenant.listings l
   WHERE l.organization_id = organization_id AND l.listing_id = listing_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lifecycle_not_found' USING ERRCODE = '23503';
  END IF;
  SELECT w.out_actor INTO v_actor
    FROM openarc_durable.lock_lifecycle_writer(session_hash, organization_id, listing_id) AS w;
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'lifecycle_forbidden' USING ERRCODE = '42501';
  END IF;

  SELECT l.active_version INTO v_root_active
    FROM openarc_tenant.listings l
   WHERE l.organization_id = organization_id AND l.listing_id = listing_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lifecycle_not_found' USING ERRCODE = '23503';
  END IF;
  SELECT s.status, s.origin_review_state, s.current_review_id, s.published_at, s.updated_at
    INTO v_status, v_review_state, v_review_id, v_published_at, v_state_updated
    FROM openarc_tenant.listing_version_states s
   WHERE s.organization_id = organization_id AND s.listing_id = listing_id AND s.version = version
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lifecycle_not_found' USING ERRCODE = '23503';
  END IF;

  -- Same-key replay is checked BEFORE the CAS, after authority/provider checks.
  SELECT * INTO v_existing
    FROM openarc_durable.idempotency_records r
   WHERE r.organization_id = organization_id AND r.operation = operation
     AND r.key_hash = key_hash FOR UPDATE;
  IF FOUND THEN
    IF v_existing.request_digest = request_digest
       AND v_existing.mutation_id = mutation_id
       AND v_existing.actor_account_id = v_actor
       AND v_existing.session_context_digest = session_context_digest
       AND v_existing.status = 'committed' THEN
      SELECT w.out_actor INTO v_recheck
        FROM openarc_durable.lock_lifecycle_writer(session_hash, organization_id, listing_id) AS w;
      IF v_recheck IS NULL OR v_recheck <> v_actor THEN
        RAISE EXCEPTION 'lifecycle_session_invalid' USING ERRCODE = '28000';
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
    RAISE EXCEPTION 'lifecycle_idempotency_conflict' USING ERRCODE = 'P0D01';
  END IF;
  PERFORM 1 FROM openarc_durable.idempotency_records r
   WHERE r.organization_id = organization_id AND r.mutation_id = mutation_id FOR UPDATE;
  IF FOUND THEN
    RAISE EXCEPTION 'lifecycle_idempotency_conflict' USING ERRCODE = 'P0D01';
  END IF;

  -- Exact CAS on both the state token and the root pointer.
  IF v_status IS NULL OR v_state_updated IS DISTINCT FROM expected_updated_at THEN
    RAISE EXCEPTION 'lifecycle_cas_conflict' USING ERRCODE = '23505';
  END IF;
  IF v_root_active IS DISTINCT FROM expected_active_version THEN
    RAISE EXCEPTION 'lifecycle_active_conflict' USING ERRCODE = '23505';
  END IF;

  SELECT clock_timestamp() INTO v_now;
  v_new_updated := GREATEST(v_now, expected_updated_at + interval '1 microsecond');
  v_resource_id := listing_id || '@' || version;

  IF operation = 'market.listing.version.publish' THEN
    IF v_status NOT IN ('draft', 'paused') THEN
      RAISE EXCEPTION 'lifecycle_state_conflict' USING ERRCODE = '23514';
    END IF;
    IF v_review_state <> 'approved' OR v_review_id IS NULL THEN
      RAISE EXCEPTION 'lifecycle_review_required' USING ERRCODE = '23514';
    END IF;
    -- Pause the previous active version first so the partial unique index never
    -- sees two active rows mid-transaction.
    IF v_root_active IS NOT NULL AND v_root_active <> version THEN
      UPDATE openarc_tenant.listing_version_states s
         SET status = 'paused',
             updated_at = GREATEST(v_now, s.updated_at + interval '1 microsecond')
       WHERE s.organization_id = organization_id AND s.listing_id = listing_id
         AND s.version = v_root_active AND s.status = 'active';
    END IF;
    UPDATE openarc_tenant.listing_version_states s
       SET status = 'active',
           published_at = COALESCE(s.published_at, v_new_updated),
           updated_at = v_new_updated
     WHERE s.organization_id = organization_id AND s.listing_id = listing_id
       AND s.version = version AND s.updated_at = expected_updated_at;
    PERFORM set_config('openarc.lifecycle_active_swap', 'on', true);
    UPDATE openarc_tenant.listings l
       SET active_version = version,
           updated_at = GREATEST(v_now, l.updated_at + interval '1 microsecond')
     WHERE l.organization_id = organization_id AND l.listing_id = listing_id;
    PERFORM set_config('openarc.lifecycle_active_swap', 'off', true);
  ELSIF operation = 'market.listing.version.pause' THEN
    IF v_status <> 'active' OR v_root_active IS DISTINCT FROM version THEN
      RAISE EXCEPTION 'lifecycle_state_conflict' USING ERRCODE = '23514';
    END IF;
    UPDATE openarc_tenant.listing_version_states s
       SET status = 'paused', updated_at = v_new_updated
     WHERE s.organization_id = organization_id AND s.listing_id = listing_id
       AND s.version = version AND s.updated_at = expected_updated_at;
    PERFORM set_config('openarc.lifecycle_active_swap', 'on', true);
    UPDATE openarc_tenant.listings l
       SET active_version = NULL,
           updated_at = GREATEST(v_now, l.updated_at + interval '1 microsecond')
     WHERE l.organization_id = organization_id AND l.listing_id = listing_id;
    PERFORM set_config('openarc.lifecycle_active_swap', 'off', true);
  ELSE
    IF v_status NOT IN ('draft', 'paused', 'active') THEN
      RAISE EXCEPTION 'lifecycle_state_conflict' USING ERRCODE = '23514';
    END IF;
    UPDATE openarc_tenant.listing_version_states s
       SET status = 'retired', updated_at = v_new_updated
     WHERE s.organization_id = organization_id AND s.listing_id = listing_id
       AND s.version = version AND s.updated_at = expected_updated_at;
    IF v_status = 'active' THEN
      PERFORM set_config('openarc.lifecycle_active_swap', 'on', true);
      UPDATE openarc_tenant.listings l
         SET active_version = NULL,
             updated_at = GREATEST(v_now, l.updated_at + interval '1 microsecond')
       WHERE l.organization_id = organization_id AND l.listing_id = listing_id;
      PERFORM set_config('openarc.lifecycle_active_swap', 'off', true);
    END IF;
  END IF;

  INSERT INTO openarc_durable.idempotency_records (
    organization_id, operation, key_hash, request_digest, digest_version,
    actor_account_id, session_context_digest, network, mutation_id, status
  ) VALUES (
    organization_id, operation, key_hash, request_digest,
    operation || '.v1', v_actor, session_context_digest,
    'eip155:5042002', mutation_id, 'pending'
  );
  UPDATE openarc_durable.idempotency_records r
     SET status = 'committed', resource_type = 'listing_version',
         resource_id = v_resource_id, committed_at = clock_timestamp()
   WHERE r.organization_id = organization_id AND r.operation = operation
     AND r.key_hash = key_hash
   RETURNING r.committed_at INTO v_committed_at;

  INSERT INTO openarc_durable.audit_events (
    organization_id, actor_account_id, operation, mutation_id, resource_type, resource_id, outcome
  ) VALUES (
    organization_id, v_actor, operation, mutation_id,
    'listing_version', v_resource_id, 'committed'
  );
  INSERT INTO openarc_durable.outbox_events (
    organization_id, mutation_id, resource_type, resource_id, event_type, payload_version
  ) VALUES (
    organization_id, mutation_id, 'listing_version', v_resource_id,
    CASE operation
      WHEN 'market.listing.version.publish' THEN 'market.listing.version.published'
      WHEN 'market.listing.version.pause' THEN 'market.listing.version.paused'
      WHEN 'market.listing.version.retire' THEN 'market.listing.version.retired'
    END, 1
  );

  SELECT w.out_actor INTO v_recheck
    FROM openarc_durable.lock_lifecycle_writer(session_hash, organization_id, listing_id) AS w;
  IF v_recheck IS NULL OR v_recheck <> v_actor THEN
    RAISE EXCEPTION 'lifecycle_session_invalid' USING ERRCODE = '28000';
  END IF;

  out_replayed := false;
  out_mutation_id := mutation_id;
  out_operation := operation;
  out_resource_type := 'listing_version';
  out_resource_id := v_resource_id;
  out_committed_at := v_committed_at;
  RETURN NEXT;
END;
$$;

ALTER TABLE openarc_durable.audit_events
  DROP CONSTRAINT audit_operation_valid,
  DROP CONSTRAINT audit_resource_type_valid,
  DROP CONSTRAINT audit_resource_matches_operation,
  DROP CONSTRAINT audit_market_resource_shape;

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
    'tenant.provider.credential.revoke',
    'market.listing.create',
    'market.listing.version.create',
    'market.listing.origin_review.record',
    'market.listing.version.publish',
    'market.listing.version.pause',
    'market.listing.version.retire'
  )),
  ADD CONSTRAINT audit_resource_type_valid CHECK (resource_type IN (
    'organization', 'agent', 'provider', 'membership',
    'agent_credential', 'provider_credential',
    'listing', 'listing_version'
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
      WHEN 'market.listing.create' THEN 'listing'
      WHEN 'market.listing.version.create' THEN 'listing_version'
      WHEN 'market.listing.origin_review.record' THEN 'listing_version'
      WHEN 'market.listing.version.publish' THEN 'listing_version'
      WHEN 'market.listing.version.pause' THEN 'listing_version'
      WHEN 'market.listing.version.retire' THEN 'listing_version'
    END
  ),
  ADD CONSTRAINT audit_market_resource_shape CHECK (
    (resource_type = 'listing' AND listing_id = resource_id AND listing_version IS NULL)
    OR (resource_type = 'listing_version' AND listing_version IS NOT NULL
        AND openarc_durable.is_canonical_listing_id(listing_id)
        AND openarc_durable.is_canonical_listing_version(listing_version)
        AND resource_id = listing_id || '@' || listing_version
        AND CASE
          WHEN operation IN ('market.listing.version.create') THEN listing_version::numeric >= 2
          WHEN operation IN (
            'market.listing.origin_review.record',
            'market.listing.version.publish',
            'market.listing.version.pause',
            'market.listing.version.retire'
          ) THEN listing_version::numeric >= 1
          ELSE false
        END)
    OR (resource_type IS NULL OR resource_type NOT IN ('listing', 'listing_version'))
  );

ALTER TABLE openarc_durable.outbox_events
  DROP CONSTRAINT outbox_resource_type_valid,
  DROP CONSTRAINT outbox_event_type_valid,
  DROP CONSTRAINT outbox_resource_matches_event,
  DROP CONSTRAINT outbox_receipt_fk,
  DROP CONSTRAINT outbox_market_resource_shape;

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
      WHEN 'market.listing.created' THEN 'market.listing.create'
      WHEN 'market.listing.version.created' THEN 'market.listing.version.create'
      WHEN 'market.listing.origin_review.recorded' THEN 'market.listing.origin_review.record'
      WHEN 'market.listing.version.published' THEN 'market.listing.version.publish'
      WHEN 'market.listing.version.paused' THEN 'market.listing.version.pause'
      WHEN 'market.listing.version.retired' THEN 'market.listing.version.retire'
    END
  ) STORED;

ALTER TABLE openarc_durable.outbox_events
  ADD CONSTRAINT outbox_resource_type_valid CHECK (resource_type IN (
    'organization', 'agent', 'provider', 'membership',
    'agent_credential', 'provider_credential',
    'listing', 'listing_version'
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
    'tenant.provider.credential.revoked',
    'market.listing.created',
    'market.listing.version.created',
    'market.listing.origin_review.recorded',
    'market.listing.version.published',
    'market.listing.version.paused',
    'market.listing.version.retired'
  )),
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
      WHEN 'market.listing.created' THEN 'listing'
      WHEN 'market.listing.version.created' THEN 'listing_version'
      WHEN 'market.listing.origin_review.recorded' THEN 'listing_version'
      WHEN 'market.listing.version.published' THEN 'listing_version'
      WHEN 'market.listing.version.paused' THEN 'listing_version'
      WHEN 'market.listing.version.retired' THEN 'listing_version'
    END
  ),
  ADD CONSTRAINT outbox_receipt_fk FOREIGN KEY (
    organization_id, mutation_id, resource_type, resource_id, receipt_operation
  ) REFERENCES openarc_durable.idempotency_records (
    organization_id, mutation_id, resource_type, resource_id, operation
  ) ON DELETE RESTRICT,
  ADD CONSTRAINT outbox_market_resource_shape CHECK (
    (resource_type = 'listing' AND listing_id = resource_id AND listing_version IS NULL)
    OR (resource_type = 'listing_version' AND listing_version IS NOT NULL
        AND openarc_durable.is_canonical_listing_id(listing_id)
        AND openarc_durable.is_canonical_listing_version(listing_version)
        AND resource_id = listing_id || '@' || listing_version
        AND CASE
          WHEN event_type IN ('market.listing.version.created') THEN listing_version::numeric >= 2
          WHEN event_type IN (
            'market.listing.origin_review.recorded',
            'market.listing.version.published',
            'market.listing.version.paused',
            'market.listing.version.retired'
          ) THEN listing_version::numeric >= 1
          ELSE false
        END)
    OR (resource_type IS NULL OR resource_type NOT IN ('listing', 'listing_version'))
  );

-- ---------------------------------------------------------------------------
-- Privileges. Runtime executes exactly the public lifecycle/catalog helpers.
-- Internal validators/helpers (digest, active-pointer checks, append-only
-- triggers, lifecycle writer preamble) remain migrator-only.
-- ---------------------------------------------------------------------------
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA openarc_durable FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA openarc_tenant FROM PUBLIC;

GRANT EXECUTE ON FUNCTION openarc_durable.commit_origin_review(text, text, text, text, timestamptz, text, text, text, text, uuid, text, text, text) TO openarc_tenant_app;
GRANT EXECUTE ON FUNCTION openarc_durable.commit_lifecycle_transition(text, text, text, text, text, timestamptz, text, uuid, text, text, text) TO openarc_tenant_app;
GRANT EXECUTE ON FUNCTION openarc_durable.lock_moderator_actor(text, text) TO openarc_tenant_app;
GRANT EXECUTE ON FUNCTION openarc_durable.lock_lifecycle_writer(text, text, text) TO openarc_tenant_app;
GRANT EXECUTE ON FUNCTION openarc_durable.read_owner_listing(text, text, text) TO openarc_tenant_app;
GRANT EXECUTE ON FUNCTION openarc_durable.list_market_providers(text, text, text, integer) TO openarc_tenant_app;
GRANT EXECUTE ON FUNCTION openarc_durable.get_moderator_listing_version(text, text, text, text) TO openarc_tenant_app;
GRANT EXECUTE ON FUNCTION openarc_durable.read_lifecycle_mutation_status(text, text, uuid) TO openarc_tenant_app;
GRANT EXECUTE ON FUNCTION openarc_durable.list_public_listings(text, integer, text, text, text) TO openarc_tenant_app;
GRANT EXECUTE ON FUNCTION openarc_durable.get_public_listing(text) TO openarc_tenant_app;
GRANT EXECUTE ON FUNCTION openarc_durable.get_public_provider(text) TO openarc_tenant_app;
