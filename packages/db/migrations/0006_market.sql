-- OpenArc durable listing drafts and immutable versions (schema6).
-- Additive over schema5. See task.md PORT02-01b.
--
-- Owner: openarc_migrator. Runtime: openarc_tenant_app. Worker:
-- openarc_worker_app (pre-provisioned; this migration NEVER creates roles or
-- schemas). 0001-0005 are frozen: this migration only adds the listing/version
-- tables, their restrictive definer helpers and the closed two-event outbox
-- support. No HTTP, activation, moderation, payment or origin-fetch behavior.
--
-- The runtime has NO direct SELECT/INSERT/UPDATE/DELETE/TRUNCATE on any new
-- table; every read/write goes through the narrow SECURITY DEFINER helpers.

-- ---------------------------------------------------------------------------
-- Shared content validation helpers (must precede the table constraints).
-- ---------------------------------------------------------------------------
CREATE FUNCTION openarc_durable.is_canonical_listing_id(value text) RETURNS boolean
LANGUAGE sql IMMUTABLE
SET search_path = pg_catalog
AS $$
  SELECT value IS NOT NULL
     AND value ~ '^openarc:listing:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$';
$$;

-- Canonical positive decimal version 1..999999999 (no leading zeros).
CREATE FUNCTION openarc_durable.is_canonical_listing_version(value text) RETURNS boolean
LANGUAGE sql IMMUTABLE
SET search_path = pg_catalog
AS $$
  SELECT value IS NOT NULL AND value ~ '^[1-9][0-9]{0,8}$';
$$;

-- Positive canonical uint256 decimal atomic amount (no signs/leading zeros).
CREATE FUNCTION openarc_durable.is_canonical_uint256_positive(value text) RETURNS boolean
LANGUAGE sql IMMUTABLE
SET search_path = pg_catalog
AS $$
  SELECT value IS NOT NULL
     AND value ~ '^[1-9][0-9]{0,77}$'
     AND value::numeric <= 115792089237316195423570985008687907853269984665640564039457584007913129639935::numeric;
$$;

-- Shared sha256 digest form: 'sha256:' || 64 lowercase hex.
CREATE FUNCTION openarc_durable.is_canonical_sha256_digest(value text) RETURNS boolean
LANGUAGE sql IMMUTABLE
SET search_path = pg_catalog
AS $$
  SELECT value IS NOT NULL AND value ~ '^sha256:[0-9a-f]{64}$';
$$;

-- JavaScript UTF-16 code-unit length, matching the shared TS `.min/.max`
-- semantics exactly: each astral code point counts as two units.
CREATE FUNCTION openarc_durable.js_length(value text) RETURNS integer
LANGUAGE sql IMMUTABLE
SET search_path = pg_catalog
AS $$
  SELECT char_length(value)
       + (char_length(value) - char_length(regexp_replace(value, '[\U00010000-\U0010ffff]', '', 'g')));
$$;

-- Mirrors the accepted shared `trimmedText`: JS-trimmed at both edges, no C0/C1
-- control characters anywhere, and 1..max JS UTF-16 code units. Boolean result
-- is FALSE (never NULL) for NULL input.
CREATE FUNCTION openarc_durable.is_js_trimmed_text(value text, max_length integer) RETURNS boolean
LANGUAGE sql IMMUTABLE
SET search_path = pg_catalog
AS $$
  SELECT value IS NOT NULL
     AND max_length > 0
     AND value !~ E'[\u0001-\u001f\u007f-\u009f]'
     AND value !~ E'^[\u0009-\u000d\u0020\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]'
     AND value !~ E'[\u0009-\u000d\u0020\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]$'
     AND openarc_durable.js_length(value) BETWEEN 1 AND max_length;
$$;

-- Lowercase identifier grammar shared by receipt types and delivery fields.
CREATE FUNCTION openarc_durable.is_canonical_identifier(value text) RETURNS boolean
LANGUAGE sql IMMUTABLE
SET search_path = pg_catalog
AS $$
  SELECT value IS NOT NULL AND value ~ '^[a-z][a-z0-9_.-]{0,63}$';
$$;

-- Endpoint path syntax only: initial slash, unreserved ASCII, no duplicate
-- slashes, no `.`/`..` path segments, 1..512 JS units.
CREATE FUNCTION openarc_durable.is_canonical_endpoint_path(value text) RETURNS boolean
LANGUAGE sql IMMUTABLE
SET search_path = pg_catalog
AS $$
  SELECT value IS NOT NULL
     AND value ~ '^/[A-Za-z0-9\-._~/]*$'
     AND strpos(value, '//') = 0
     AND NOT EXISTS (
       SELECT 1 FROM unnest(string_to_array(value, '/')) AS s
        WHERE s = '.' OR s = '..'
     )
     AND openarc_durable.js_length(value) BETWEEN 1 AND 512;
$$;

-- Canonical lowercase HTTPS DNS origin with an optional explicit non-default
-- port. This is SYNTAX validation only: no DNS/SSRF review and no fetch. It
-- mirrors the accepted platform-URL origin: no credentials/path/query/fragment/
-- percent/whitespace, 2+ DNS labels (no IPv4/IPv6/local/internal), each label
-- 1..63 with no leading/trailing hyphen, 253 total, and port 1..65535 with no
-- leading zero and never the default 443. A final all-numeric (or 0x-hex)
-- label would be reparsed as an IPv4 candidate by the platform URL and is
-- therefore not a DNS name.
CREATE FUNCTION openarc_durable.is_canonical_endpoint_origin(value text) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE
SET search_path = pg_catalog
AS $$
DECLARE
  v_rest text;
  v_host text;
  v_port text;
  v_labels text[];
  v_label text;
  v_last text;
BEGIN
  IF value IS NULL OR value !~ '^https://' THEN RETURN false; END IF;
  IF value <> lower(value) THEN RETURN false; END IF;
  v_rest := substring(value FROM 9);
  IF v_rest = '' THEN RETURN false; END IF;
  IF v_rest ~ '\s' OR v_rest ~ '[/\\?#@%]' OR v_rest ~ E'[\u0001-\u001f\u007f-\u009f]' THEN
    RETURN false;
  END IF;
  IF position(':' IN v_rest) > 0 THEN
    v_host := split_part(v_rest, ':', 1);
    v_port := split_part(v_rest, ':', 2);
    IF v_host = '' OR v_port = '' OR position(':' IN v_port) > 0 THEN RETURN false; END IF;
    IF v_port !~ '^[1-9][0-9]{0,4}$' THEN RETURN false; END IF;
    IF v_port::integer > 65535 OR v_port::integer = 443 THEN RETURN false; END IF;
  ELSE
    v_host := v_rest;
  END IF;
  -- The shared validator bounds the COMPLETE origin (not only the host) at 253
  -- JS UTF-16 units, while each DNS name is independently bounded at 253.
  IF v_host = '' OR char_length(v_host) > 253 THEN RETURN false; END IF;
  IF char_length(value) > 253 THEN RETURN false; END IF;
  IF v_host ~ '\s' THEN RETURN false; END IF;
  IF v_host LIKE '%..%' OR left(v_host, 1) = '.' OR right(v_host, 1) = '.' THEN RETURN false; END IF;
  IF v_host ~ '^[0-9.]+$' THEN RETURN false; END IF;
  IF v_host = 'localhost' OR v_host LIKE '%.localhost' OR v_host LIKE '%.local'
     OR v_host LIKE '%.internal' THEN
    RETURN false;
  END IF;
  v_labels := string_to_array(v_host, '.');
  IF array_length(v_labels, 1) IS NULL OR array_length(v_labels, 1) < 2 THEN RETURN false; END IF;
  FOREACH v_label IN ARRAY v_labels LOOP
    IF char_length(v_label) < 1 OR char_length(v_label) > 63 THEN RETURN false; END IF;
    IF v_label !~ '^[a-z0-9]([a-z0-9-]*[a-z0-9])?$' THEN RETURN false; END IF;
  END LOOP;
  v_last := v_labels[array_length(v_labels, 1)];
  IF v_last ~ '^[0-9]+$' OR v_last ~ '^0x[0-9a-f]+$' THEN RETURN false; END IF;
  RETURN true;
END;
$$;

CREATE FUNCTION openarc_durable.is_valid_listing_manifest(value jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE
SET search_path = pg_catalog
AS $$
  SELECT value IS NOT NULL
     AND jsonb_typeof(value) = 'object'
     AND value ?& ARRAY['schemaVersion', 'inputSchemaDigest', 'outputSchemaDigest']
     AND value - ARRAY['schemaVersion', 'inputSchemaDigest', 'outputSchemaDigest'] = '{}'::jsonb
     AND jsonb_typeof(value->'schemaVersion') = 'string'
     AND value->>'schemaVersion' = 'openarc.listing-manifest.v1'
     AND jsonb_typeof(value->'inputSchemaDigest') = 'string'
     AND openarc_durable.is_canonical_sha256_digest(value->>'inputSchemaDigest')
     AND jsonb_typeof(value->'outputSchemaDigest') = 'string'
     AND openarc_durable.is_canonical_sha256_digest(value->>'outputSchemaDigest');
$$;

CREATE FUNCTION openarc_durable.is_valid_receipt_contract(value jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE
SET search_path = pg_catalog
AS $$
  SELECT value IS NOT NULL
     AND jsonb_typeof(value) = 'object'
     AND value ?& ARRAY['schemaVersion', 'receiptType', 'receiptSchemaDigest', 'deliveryFields']
     AND value - ARRAY['schemaVersion', 'receiptType', 'receiptSchemaDigest', 'deliveryFields'] = '{}'::jsonb
     AND jsonb_typeof(value->'schemaVersion') = 'string'
     AND value->>'schemaVersion' = 'openarc.receipt-contract.v1'
     AND jsonb_typeof(value->'receiptType') = 'string'
     AND openarc_durable.is_canonical_identifier(value->>'receiptType')
     AND jsonb_typeof(value->'receiptSchemaDigest') = 'string'
     AND openarc_durable.is_canonical_sha256_digest(value->>'receiptSchemaDigest')
     AND jsonb_typeof(value->'deliveryFields') = 'array'
     AND jsonb_array_length(value->'deliveryFields') BETWEEN 1 AND 32
     AND NOT EXISTS (
       SELECT 1 FROM jsonb_array_elements(value->'deliveryFields') AS e
        WHERE jsonb_typeof(e) <> 'string'
           OR NOT openarc_durable.is_canonical_identifier(e #>> '{}')
     )
     AND (SELECT count(*) FROM jsonb_array_elements_text(value->'deliveryFields')) =
         (SELECT count(DISTINCT x) FROM jsonb_array_elements_text(value->'deliveryFields') AS x);
$$;

CREATE FUNCTION openarc_durable.is_valid_endpoint_contract(value jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE
SET search_path = pg_catalog
AS $$
  SELECT value IS NOT NULL
     AND jsonb_typeof(value) = 'object'
     AND value ?& ARRAY['origin', 'path']
     AND value - ARRAY['origin', 'path'] = '{}'::jsonb
     AND jsonb_typeof(value->'origin') = 'string'
     AND openarc_durable.is_canonical_endpoint_origin(value->>'origin')
     AND jsonb_typeof(value->'path') = 'string'
     AND openarc_durable.is_canonical_endpoint_path(value->>'path');
$$;

CREATE FUNCTION openarc_durable.is_valid_listing_price(value jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE
SET search_path = pg_catalog
AS $$
  SELECT value IS NOT NULL
     AND jsonb_typeof(value) = 'object'
     AND value ?& ARRAY['amount', 'pricingModel']
     AND value - ARRAY['amount', 'pricingModel'] = '{}'::jsonb
     AND jsonb_typeof(value->'pricingModel') = 'string'
     AND value->>'pricingModel' = 'fixed'
     AND jsonb_typeof(value->'amount') = 'object'
     AND (value->'amount') ?& ARRAY['schemaVersion', 'networkId', 'asset', 'atomicAmount', 'representation', 'decimals']
     AND (value->'amount') - ARRAY['schemaVersion', 'networkId', 'asset', 'atomicAmount', 'representation', 'decimals'] = '{}'::jsonb
     AND jsonb_typeof((value->'amount')->'schemaVersion') = 'string'
     AND (value->'amount')->>'schemaVersion' = 'openarc.usdc-amount.v1'
     AND jsonb_typeof((value->'amount')->'networkId') = 'string'
     AND (value->'amount')->>'networkId' = 'eip155:5042002'
     AND jsonb_typeof((value->'amount')->'asset') = 'string'
     AND (value->'amount')->>'asset' = 'USDC'
     AND jsonb_typeof((value->'amount')->'representation') = 'string'
     AND (value->'amount')->>'representation' = 'erc20'
     AND jsonb_typeof((value->'amount')->'decimals') = 'number'
     AND (value->'amount')->'decimals' = '6'::jsonb
     AND jsonb_typeof((value->'amount')->'atomicAmount') = 'string'
     AND openarc_durable.is_canonical_uint256_positive((value->'amount')->>'atomicAmount');
$$;

CREATE FUNCTION openarc_durable.is_valid_listing_availability(value jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE
SET search_path = pg_catalog
AS $$
  SELECT value IS NOT NULL
     AND jsonb_typeof(value) = 'object'
     AND value ?& ARRAY['status', 'rateLimitPerMinute']
     AND value - ARRAY['status', 'rateLimitPerMinute'] = '{}'::jsonb
     AND jsonb_typeof(value->'status') = 'string'
     AND value->>'status' IN ('available', 'unavailable')
     AND (
       (value->'rateLimitPerMinute') = 'null'::jsonb
       OR (
         jsonb_typeof(value->'rateLimitPerMinute') = 'string'
         AND (value->>'rateLimitPerMinute') ~ '^[1-9][0-9]{0,6}$'
         AND (value->>'rateLimitPerMinute')::numeric <= 1000000
       )
     );
$$;

-- Full closed content validator. Every branch is an explicit JSON type/literal
-- check so JSON null can never masquerade as an allowed value or an absence.
CREATE FUNCTION openarc_durable.is_valid_listing_content(
  kind text,
  title text,
  description text,
  manifest jsonb,
  price jsonb,
  evidence_contract jsonb,
  endpoint_contract jsonb,
  terms_revision text,
  privacy_summary text,
  payment_lane text,
  availability jsonb
) RETURNS boolean
LANGUAGE sql IMMUTABLE
SET search_path = pg_catalog
AS $$
  SELECT kind IS NOT NULL
     AND kind IN ('api', 'mcp_tool', 'data', 'model', 'workflow', 'agent')
     AND openarc_durable.is_js_trimmed_text(title, 100)
     AND openarc_durable.is_js_trimmed_text(description, 2000)
     AND openarc_durable.is_js_trimmed_text(terms_revision, 128)
     AND openarc_durable.is_js_trimmed_text(privacy_summary, 1500)
     AND payment_lane IS NOT DISTINCT FROM 'unavailable'
     AND openarc_durable.is_valid_listing_manifest(manifest)
     AND openarc_durable.is_valid_listing_price(price)
     AND openarc_durable.is_valid_receipt_contract(evidence_contract)
     AND openarc_durable.is_valid_endpoint_contract(endpoint_contract)
     AND openarc_durable.is_valid_listing_availability(availability);
$$;

-- ---------------------------------------------------------------------------
-- Listing root. One root per (organization, provider, listing). The compound
-- unique key is the ownership anchor referenced by versions and receipts.
-- ---------------------------------------------------------------------------
CREATE TABLE openarc_tenant.listings (
  organization_id text NOT NULL,
  provider_id text NOT NULL,
  listing_id text NOT NULL,
  latest_version text NOT NULL,
  active_version text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (organization_id, listing_id),
  CONSTRAINT listings_listing_unique UNIQUE (listing_id),
  CONSTRAINT listings_ownership_unique UNIQUE (organization_id, provider_id, listing_id),
  CONSTRAINT listings_provider_fk FOREIGN KEY (organization_id, provider_id)
    REFERENCES openarc_tenant.providers(organization_id, provider_id) ON DELETE RESTRICT,
  CONSTRAINT listings_id_valid CHECK (openarc_durable.is_canonical_listing_id(listing_id)),
  CONSTRAINT listings_latest_version_valid CHECK (
    openarc_durable.is_canonical_listing_version(latest_version)
  ),
  CONSTRAINT listings_active_version_valid CHECK (
    active_version IS NULL OR openarc_durable.is_canonical_listing_version(active_version)
  ),
  CONSTRAINT listings_timestamps_valid CHECK (updated_at >= created_at)
);

-- ---------------------------------------------------------------------------
-- Immutable version content. The identity columns and every one of the twelve
-- content fields are frozen by a BEFORE UPDATE/DELETE trigger; a version row
-- can never be edited in place. JSONB is used only for the closed manifest /
-- receipt / availability structures with exact-key CHECK constraints.
-- ---------------------------------------------------------------------------
CREATE TABLE openarc_tenant.listing_versions (
  organization_id text NOT NULL,
  listing_id text NOT NULL,
  version text NOT NULL,
  provider_id text NOT NULL,
  kind text NOT NULL,
  title text NOT NULL,
  description text NOT NULL,
  manifest jsonb NOT NULL,
  price jsonb NOT NULL,
  evidence_contract jsonb NOT NULL,
  endpoint_contract jsonb NOT NULL,
  terms_revision text NOT NULL,
  privacy_summary text NOT NULL,
  payment_lane text NOT NULL,
  availability jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (organization_id, listing_id, version),
  CONSTRAINT listing_versions_root_fk FOREIGN KEY (organization_id, provider_id, listing_id)
    REFERENCES openarc_tenant.listings(organization_id, provider_id, listing_id)
    ON DELETE RESTRICT,
  CONSTRAINT listing_versions_version_valid CHECK (
    openarc_durable.is_canonical_listing_version(version)
  ),
  CONSTRAINT listing_versions_kind_valid CHECK (
    kind IN ('api', 'mcp_tool', 'data', 'model', 'workflow', 'agent')
  ),
  CONSTRAINT listing_versions_title_valid CHECK (
    openarc_durable.is_js_trimmed_text(title, 100)
  ),
  CONSTRAINT listing_versions_description_valid CHECK (
    openarc_durable.is_js_trimmed_text(description, 2000)
  ),
  CONSTRAINT listing_versions_terms_valid CHECK (
    openarc_durable.is_js_trimmed_text(terms_revision, 128)
  ),
  CONSTRAINT listing_versions_privacy_valid CHECK (
    openarc_durable.is_js_trimmed_text(privacy_summary, 1500)
  ),
  CONSTRAINT listing_versions_payment_lane_valid CHECK (payment_lane = 'unavailable'),
  CONSTRAINT listing_versions_manifest_valid CHECK (
    openarc_durable.is_valid_listing_manifest(manifest)
  ),
  CONSTRAINT listing_versions_price_valid CHECK (
    openarc_durable.is_valid_listing_price(price)
  ),
  CONSTRAINT listing_versions_evidence_valid CHECK (
    openarc_durable.is_valid_receipt_contract(evidence_contract)
  ),
  CONSTRAINT listing_versions_endpoint_valid CHECK (
    openarc_durable.is_valid_endpoint_contract(endpoint_contract)
  ),
  CONSTRAINT listing_versions_availability_valid CHECK (
    openarc_durable.is_valid_listing_availability(availability)
  )
);

-- Root pointer ownership: latest_version may only ever reference a version of
-- this same organization/listing (deferred for the first draft insertion where
-- the root is written before its first version), and active_version is a
-- separate nullable publication pointer that this packet never populates.
ALTER TABLE openarc_tenant.listings
  ADD CONSTRAINT listings_latest_version_fk FOREIGN KEY (organization_id, listing_id, latest_version)
    REFERENCES openarc_tenant.listing_versions(organization_id, listing_id, version)
    ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  ADD CONSTRAINT listings_active_version_fk FOREIGN KEY (organization_id, listing_id, active_version)
    REFERENCES openarc_tenant.listing_versions(organization_id, listing_id, version)
    ON DELETE RESTRICT;

-- ---------------------------------------------------------------------------
-- Mutable per-version state. Content never lives here, so the content trigger
-- and state transitions stay independent.
-- ---------------------------------------------------------------------------
CREATE TABLE openarc_tenant.listing_version_states (
  organization_id text NOT NULL,
  listing_id text NOT NULL,
  version text NOT NULL,
  status text NOT NULL,
  origin_review_state text NOT NULL,
  published_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (organization_id, listing_id, version),
  CONSTRAINT listing_version_states_version_fk FOREIGN KEY (organization_id, listing_id, version)
    REFERENCES openarc_tenant.listing_versions(organization_id, listing_id, version)
    ON DELETE RESTRICT,
  CONSTRAINT listing_version_states_status_valid CHECK (status IN ('draft', 'active', 'paused', 'retired')),
  CONSTRAINT listing_version_states_review_valid CHECK (
    origin_review_state IN ('unreviewed', 'approved', 'rejected')
  ),
  CONSTRAINT listing_version_states_publication_shape CHECK (
    (status = 'active' AND origin_review_state = 'approved' AND published_at IS NOT NULL)
    OR (status <> 'active')
  )
);

CREATE INDEX listings_org_provider_idx
  ON openarc_tenant.listings (organization_id, provider_id, listing_id);
CREATE INDEX listing_versions_org_listing_idx
  ON openarc_tenant.listing_versions (organization_id, listing_id, version);

-- Content immutability: reject UPDATE and DELETE of a version row for every
-- caller including the migrator's ordinary DML. Only the table owner may drop
-- the trigger; runtime has no such privilege.
CREATE FUNCTION openarc_tenant.reject_listing_version_mutation() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  RAISE EXCEPTION 'listing_version_immutable' USING ERRCODE = '42501';
END;
$$;

CREATE TRIGGER listing_versions_immutable
  BEFORE UPDATE OR DELETE ON openarc_tenant.listing_versions
  FOR EACH ROW EXECUTE FUNCTION openarc_tenant.reject_listing_version_mutation();

-- Root identity/ownership is immutable and latest_version may only advance to a
-- larger canonical version that already exists for the same listing.
CREATE FUNCTION openarc_tenant.enforce_listing_root_immutable() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  IF NEW.organization_id IS DISTINCT FROM OLD.organization_id
     OR NEW.provider_id IS DISTINCT FROM OLD.provider_id
     OR NEW.listing_id IS DISTINCT FROM OLD.listing_id
     OR NEW.active_version IS DISTINCT FROM OLD.active_version
     OR NEW.latest_version::numeric < OLD.latest_version::numeric THEN
    RAISE EXCEPTION 'listing_root_immutable' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER listings_root_immutable
  BEFORE UPDATE ON openarc_tenant.listings
  FOR EACH ROW EXECUTE FUNCTION openarc_tenant.enforce_listing_root_immutable();

-- ---------------------------------------------------------------------------
-- Row level security: migrator-only policies. The runtime and worker get no
-- policy and no direct table privilege; all access is through definers.
-- ---------------------------------------------------------------------------
ALTER TABLE openarc_tenant.listings ENABLE ROW LEVEL SECURITY;
ALTER TABLE openarc_tenant.listings FORCE ROW LEVEL SECURITY;
ALTER TABLE openarc_tenant.listing_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE openarc_tenant.listing_versions FORCE ROW LEVEL SECURITY;
ALTER TABLE openarc_tenant.listing_version_states ENABLE ROW LEVEL SECURITY;
ALTER TABLE openarc_tenant.listing_version_states FORCE ROW LEVEL SECURITY;

CREATE POLICY listings_migrator ON openarc_tenant.listings
  FOR ALL TO openarc_migrator USING (true) WITH CHECK (true);
CREATE POLICY listing_versions_migrator ON openarc_tenant.listing_versions
  FOR ALL TO openarc_migrator USING (true) WITH CHECK (true);
CREATE POLICY listing_version_states_migrator ON openarc_tenant.listing_version_states
  FOR ALL TO openarc_migrator USING (true) WITH CHECK (true);

REVOKE ALL ON TABLE openarc_tenant.listings FROM PUBLIC;
REVOKE ALL ON TABLE openarc_tenant.listing_versions FROM PUBLIC;
REVOKE ALL ON TABLE openarc_tenant.listing_version_states FROM PUBLIC;

-- ---------------------------------------------------------------------------
-- Closed operation / resource / event union additions for market durability.
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
    'tenant.provider.credential.revoke',
    'market.listing.create',
    'market.listing.version.create'
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
    'market.listing.version.create.v1'
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
    END
  );

-- Typed generated link columns for the market resource kinds. A 'listing'
-- resource_id IS the canonical listing id; a 'listing_version' resource_id is
-- listingId || '@' || canonicalVersion. The compound real FKs bind both to the
-- owning listing/version in the same organization, so a receipt cannot point at
-- another org's listing or a missing version.
ALTER TABLE openarc_durable.idempotency_records
  ADD COLUMN listing_id text GENERATED ALWAYS AS (
    CASE WHEN resource_type = 'listing' THEN resource_id
         WHEN resource_type = 'listing_version' THEN split_part(resource_id, '@', 1)
    END
  ) STORED,
  ADD COLUMN listing_version text GENERATED ALWAYS AS (
    CASE WHEN resource_type = 'listing_version' THEN split_part(resource_id, '@', 2)
    END
  ) STORED,
  ADD CONSTRAINT idempotency_listing_fk FOREIGN KEY (organization_id, listing_id)
    REFERENCES openarc_tenant.listings(organization_id, listing_id) ON DELETE RESTRICT,
  ADD CONSTRAINT idempotency_listing_version_fk FOREIGN KEY (organization_id, listing_id, listing_version)
    REFERENCES openarc_tenant.listing_versions(organization_id, listing_id, version) ON DELETE RESTRICT,
  ADD CONSTRAINT idempotency_market_resource_shape CHECK (
    (resource_type = 'listing' AND resource_id IS NOT NULL AND listing_id = resource_id AND listing_version IS NULL)
    OR (resource_type = 'listing_version' AND listing_version IS NOT NULL
        AND openarc_durable.is_canonical_listing_id(listing_id)
        AND openarc_durable.is_canonical_listing_version(listing_version)
        -- Exact recomposition: `@2@extra` and truncations are rejected, and a
        -- version resource is never version 1. The numeric cast is guarded by
        -- the canonical-version predicate so it can never see a non-numeric or
        -- unbounded value.
        AND resource_id = listing_id || '@' || listing_version
        AND CASE WHEN openarc_durable.is_canonical_listing_version(listing_version)
                 THEN listing_version::numeric >= 2 ELSE false END)
    OR (resource_type IS NULL OR resource_type NOT IN ('listing', 'listing_version'))
  );

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
    'tenant.provider.credential.revoke',
    'market.listing.create',
    'market.listing.version.create'
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
    END
  );

ALTER TABLE openarc_durable.audit_events
  ADD COLUMN listing_id text GENERATED ALWAYS AS (
    CASE WHEN resource_type = 'listing' THEN resource_id
         WHEN resource_type = 'listing_version' THEN split_part(resource_id, '@', 1)
    END
  ) STORED,
  ADD COLUMN listing_version text GENERATED ALWAYS AS (
    CASE WHEN resource_type = 'listing_version' THEN split_part(resource_id, '@', 2)
    END
  ) STORED,
  ADD CONSTRAINT audit_listing_fk FOREIGN KEY (organization_id, listing_id)
    REFERENCES openarc_tenant.listings(organization_id, listing_id) ON DELETE RESTRICT,
  ADD CONSTRAINT audit_listing_version_fk FOREIGN KEY (organization_id, listing_id, listing_version)
    REFERENCES openarc_tenant.listing_versions(organization_id, listing_id, version) ON DELETE RESTRICT,
  ADD CONSTRAINT audit_market_resource_shape CHECK (
    (resource_type = 'listing' AND listing_id = resource_id AND listing_version IS NULL)
    OR (resource_type = 'listing_version' AND listing_version IS NOT NULL
        AND openarc_durable.is_canonical_listing_id(listing_id)
        AND openarc_durable.is_canonical_listing_version(listing_version)
        AND resource_id = listing_id || '@' || listing_version
        AND CASE WHEN openarc_durable.is_canonical_listing_version(listing_version)
                 THEN listing_version::numeric >= 2 ELSE false END)
    OR (resource_type IS NULL OR resource_type NOT IN ('listing', 'listing_version'))
  );

ALTER TABLE openarc_durable.outbox_events
  DROP CONSTRAINT outbox_resource_type_valid,
  DROP CONSTRAINT outbox_event_type_valid,
  DROP CONSTRAINT outbox_resource_matches_event,
  DROP CONSTRAINT outbox_receipt_fk;

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
    'market.listing.version.created'
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
      WHEN 'market.listing.created' THEN 'market.listing.create'
      WHEN 'market.listing.version.created' THEN 'market.listing.version.create'
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
      WHEN 'market.listing.created' THEN 'listing'
      WHEN 'market.listing.version.created' THEN 'listing_version'
    END
  ),
  ADD CONSTRAINT outbox_receipt_fk FOREIGN KEY (
    organization_id, mutation_id, resource_type, resource_id, receipt_operation
  ) REFERENCES openarc_durable.idempotency_records (
    organization_id, mutation_id, resource_type, resource_id, operation
  ) ON DELETE RESTRICT;

ALTER TABLE openarc_durable.outbox_events
  ADD COLUMN listing_id text GENERATED ALWAYS AS (
    CASE WHEN resource_type = 'listing' THEN resource_id
         WHEN resource_type = 'listing_version' THEN split_part(resource_id, '@', 1)
    END
  ) STORED,
  ADD COLUMN listing_version text GENERATED ALWAYS AS (
    CASE WHEN resource_type = 'listing_version' THEN split_part(resource_id, '@', 2)
    END
  ) STORED,
  ADD CONSTRAINT outbox_listing_fk FOREIGN KEY (organization_id, listing_id)
    REFERENCES openarc_tenant.listings(organization_id, listing_id) ON DELETE RESTRICT,
  ADD CONSTRAINT outbox_listing_version_fk FOREIGN KEY (organization_id, listing_id, listing_version)
    REFERENCES openarc_tenant.listing_versions(organization_id, listing_id, version) ON DELETE RESTRICT,
  ADD CONSTRAINT outbox_market_resource_shape CHECK (
    (resource_type = 'listing' AND listing_id = resource_id AND listing_version IS NULL)
    OR (resource_type = 'listing_version' AND listing_version IS NOT NULL
        AND openarc_durable.is_canonical_listing_id(listing_id)
        AND openarc_durable.is_canonical_listing_version(listing_version)
        AND resource_id = listing_id || '@' || listing_version
        AND CASE WHEN openarc_durable.is_canonical_listing_version(listing_version)
                 THEN listing_version::numeric >= 2 ELSE false END)
    OR (resource_type IS NULL OR resource_type NOT IN ('listing', 'listing_version'))
  );

-- ---------------------------------------------------------------------------
-- Shared market actor preamble. Resolves the session/actor/role under the
-- accepted lock order (account -> organization -> membership -> provider) and
-- rechecks the SAME held session after every wait. The runtime can never supply
-- a principal, role or clock; all authority is DB-resolved.
-- ---------------------------------------------------------------------------
CREATE FUNCTION openarc_durable.lock_market_actor(
  session_hash text,
  organization_id text,
  require_proof boolean,
  allow_recovery boolean
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
  v_method text;
  v_role text;
  v_status text;
  v_created_at timestamptz;
  v_expires_at timestamptz;
  v_now timestamptz;
BEGIN
  IF require_proof IS NULL OR allow_recovery IS NULL THEN
    RAISE EXCEPTION 'market_actor_invalid' USING ERRCODE = '22023';
  END IF;
  IF NOT openarc_durable.is_canonical_org_id(organization_id) THEN
    RAISE EXCEPTION 'market_organization_invalid' USING ERRCODE = '22023';
  END IF;

  SELECT l.account_id, l.method, l.session_created_at, l.session_expires_at
    INTO v_actor, v_method, v_created_at, v_expires_at
    FROM openarc_tenant.lock_auth_session(session_hash, NULL) AS l;
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'market_session_invalid' USING ERRCODE = '28000';
  END IF;
  IF NOT allow_recovery AND v_method = 'recovery' THEN
    RAISE EXCEPTION 'market_session_invalid' USING ERRCODE = '28000';
  END IF;

  PERFORM 1 FROM openarc_tenant.organizations o
   WHERE o.organization_id = organization_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'market_forbidden' USING ERRCODE = '42501';
  END IF;
  SELECT m.role, m.status INTO v_role, v_status
    FROM openarc_tenant.memberships m
   WHERE m.organization_id = organization_id AND m.account_id = v_actor FOR UPDATE;
  IF NOT FOUND OR v_status <> 'active'
     OR v_role NOT IN ('owner', 'operator', 'provider_admin', 'provider_developer', 'viewer') THEN
    RAISE EXCEPTION 'market_forbidden' USING ERRCODE = '42501';
  END IF;

  PERFORM set_config('openarc.account_id', v_actor, true);
  PERFORM set_config('openarc.organization_id', organization_id, true);
  PERFORM set_config('openarc.role', v_role, true);

  -- Re-resolve the SAME held session after the organization/membership waits.
  SELECT l.account_id, l.method, l.session_created_at, l.session_expires_at
    INTO v_actor, v_method, v_created_at, v_expires_at
    FROM openarc_tenant.lock_auth_session(session_hash, NULL) AS l;
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'market_session_invalid' USING ERRCODE = '28000';
  END IF;
  SELECT clock_timestamp() INTO v_now;
  IF NOT (v_expires_at > v_now) THEN
    RAISE EXCEPTION 'market_session_invalid' USING ERRCODE = '28000';
  END IF;
  IF require_proof THEN
    IF v_method = 'recovery' OR NOT (v_created_at > v_now - interval '5 minutes') THEN
      RAISE EXCEPTION 'market_proof_stale' USING ERRCODE = '28000';
    END IF;
  END IF;

  out_actor := v_actor;
  out_role := v_role;
  out_proof_created_at := v_created_at;
  out_session_expires_at := v_expires_at;
  RETURN NEXT;
END;
$$;

-- Canonical request validation for the twelve immutable content fields. Raises
-- market_content_invalid on any violation; used by both commit helpers so a raw
-- invalid SQL caller cannot bypass the bounded TS validation.
CREATE FUNCTION openarc_durable.assert_listing_content(
  kind text,
  title text,
  description text,
  manifest jsonb,
  price jsonb,
  evidence_contract jsonb,
  endpoint_contract jsonb,
  terms_revision text,
  privacy_summary text,
  payment_lane text,
  availability jsonb
) RETURNS void
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  IF NOT openarc_durable.is_valid_listing_content(
       kind, title, description, manifest, price, evidence_contract,
       endpoint_contract, terms_revision, privacy_summary, payment_lane, availability) THEN
    RAISE EXCEPTION 'market_content_invalid' USING ERRCODE = '22023';
  END IF;
END;
$$;

CREATE FUNCTION openarc_durable.commit_listing_create(
  session_hash text,
  organization_id text,
  provider_id text,
  kind text,
  title text,
  description text,
  manifest jsonb,
  price jsonb,
  evidence_contract jsonb,
  endpoint_contract jsonb,
  terms_revision text,
  privacy_summary text,
  payment_lane text,
  availability jsonb,
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
  v_provider_status text;
  v_existing record;
  v_listing_id text;
  v_committed_at timestamptz;
  v_recheck text;
BEGIN
  PERFORM openarc_durable.assert_listing_content(
    kind, title, description, manifest, price, evidence_contract,
    endpoint_contract, terms_revision, privacy_summary, payment_lane, availability);
  IF provider_id IS NULL OR provider_id !~ '^openarc:provider:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' THEN
    RAISE EXCEPTION 'market_provider_invalid' USING ERRCODE = '22023';
  END IF;
  IF mutation_id IS NULL OR NOT openarc_durable.is_canonical_uuid_v4(mutation_id::text) THEN
    RAISE EXCEPTION 'market_mutation_invalid' USING ERRCODE = '22023';
  END IF;
  IF NOT openarc_durable.is_canonical_hex64(key_hash)
     OR NOT openarc_durable.is_canonical_hex64(request_digest)
     OR NOT openarc_durable.is_canonical_hex64(session_context_digest) THEN
    RAISE EXCEPTION 'market_metadata_invalid' USING ERRCODE = '22023';
  END IF;

  SELECT l.out_actor, l.out_role INTO v_actor, v_role
    FROM openarc_durable.lock_market_actor(session_hash, organization_id, true, false) AS l;
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'market_forbidden' USING ERRCODE = '42501';
  END IF;
  IF v_role NOT IN ('owner', 'provider_admin', 'provider_developer') THEN
    RAISE EXCEPTION 'market_forbidden' USING ERRCODE = '42501';
  END IF;

  -- Provider must belong to this organization and be active.
  SELECT p.status INTO v_provider_status
    FROM openarc_tenant.providers p
   WHERE p.organization_id = organization_id AND p.provider_id = provider_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'market_not_found' USING ERRCODE = '23503';
  END IF;
  IF v_provider_status <> 'active' THEN
    RAISE EXCEPTION 'market_forbidden' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_existing
    FROM openarc_durable.idempotency_records r
   WHERE r.organization_id = organization_id AND r.operation = 'market.listing.create'
     AND r.key_hash = key_hash FOR UPDATE;
  IF FOUND THEN
    IF v_existing.request_digest = request_digest
       AND v_existing.mutation_id = mutation_id
       AND v_existing.actor_account_id = v_actor
       AND v_existing.session_context_digest = session_context_digest
       AND v_existing.status = 'committed' THEN
      SELECT l.out_actor INTO v_recheck
        FROM openarc_durable.lock_market_actor(session_hash, organization_id, true, false) AS l;
      IF v_recheck IS NULL OR v_recheck <> v_actor THEN
        RAISE EXCEPTION 'market_session_invalid' USING ERRCODE = '28000';
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
    RAISE EXCEPTION 'market_idempotency_conflict' USING ERRCODE = 'P0D01';
  END IF;
  PERFORM 1 FROM openarc_durable.idempotency_records r
   WHERE r.organization_id = organization_id AND r.mutation_id = mutation_id FOR UPDATE;
  IF FOUND THEN
    RAISE EXCEPTION 'market_idempotency_conflict' USING ERRCODE = 'P0D01';
  END IF;

  v_listing_id := 'openarc:listing:' || mutation_id::text;
  IF EXISTS (SELECT 1 FROM openarc_tenant.listings l WHERE l.listing_id = v_listing_id) THEN
    RAISE EXCEPTION 'market_idempotency_conflict' USING ERRCODE = 'P0D01';
  END IF;

  INSERT INTO openarc_durable.idempotency_records (
    organization_id, operation, key_hash, request_digest, digest_version,
    actor_account_id, session_context_digest, network, mutation_id, status
  ) VALUES (
    organization_id, 'market.listing.create', key_hash, request_digest,
    'market.listing.create.v1', v_actor, session_context_digest,
    'eip155:5042002', mutation_id, 'pending'
  );
  INSERT INTO openarc_tenant.listings (
    organization_id, provider_id, listing_id, latest_version
  ) VALUES (
    organization_id, provider_id, v_listing_id, '1'
  );
  INSERT INTO openarc_tenant.listing_versions (
    organization_id, listing_id, version, provider_id, kind, title, description,
    manifest, price, evidence_contract, endpoint_contract, terms_revision,
    privacy_summary, payment_lane, availability
  ) VALUES (
    organization_id, v_listing_id, '1', provider_id, kind, title, description,
    manifest, price, evidence_contract, endpoint_contract, terms_revision,
    privacy_summary, payment_lane, availability
  );
  INSERT INTO openarc_tenant.listing_version_states (
    organization_id, listing_id, version, status, origin_review_state, published_at
  ) VALUES (
    organization_id, v_listing_id, '1', 'draft', 'unreviewed', NULL
  );
  UPDATE openarc_durable.idempotency_records r
     SET status = 'committed', resource_type = 'listing',
         resource_id = v_listing_id, committed_at = clock_timestamp()
   WHERE r.organization_id = organization_id AND r.operation = 'market.listing.create'
     AND r.key_hash = key_hash
   RETURNING r.committed_at INTO v_committed_at;
  INSERT INTO openarc_durable.audit_events (
    organization_id, actor_account_id, operation, mutation_id, resource_type, resource_id, outcome
  ) VALUES (
    organization_id, v_actor, 'market.listing.create', mutation_id,
    'listing', v_listing_id, 'committed'
  );
  INSERT INTO openarc_durable.outbox_events (
    organization_id, mutation_id, resource_type, resource_id, event_type, payload_version
  ) VALUES (
    organization_id, mutation_id, 'listing', v_listing_id, 'market.listing.created', 1
  );

  SELECT l.out_actor INTO v_recheck
    FROM openarc_durable.lock_market_actor(session_hash, organization_id, true, false) AS l;
  IF v_recheck IS NULL OR v_recheck <> v_actor THEN
    RAISE EXCEPTION 'market_session_invalid' USING ERRCODE = '28000';
  END IF;

  out_replayed := false;
  out_mutation_id := mutation_id;
  out_operation := 'market.listing.create';
  out_resource_type := 'listing';
  out_resource_id := v_listing_id;
  out_committed_at := v_committed_at;
  RETURN NEXT;
END;
$$;

CREATE FUNCTION openarc_durable.commit_listing_version_create(
  session_hash text,
  organization_id text,
  listing_id text,
  expected_latest_version text,
  kind text,
  title text,
  description text,
  manifest jsonb,
  price jsonb,
  evidence_contract jsonb,
  endpoint_contract jsonb,
  terms_revision text,
  privacy_summary text,
  payment_lane text,
  availability jsonb,
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
  v_provider_id text;
  v_provider_status text;
  v_latest text;
  v_next text;
  v_existing record;
  v_resource_id text;
  v_committed_at timestamptz;
  v_recheck text;
BEGIN
  PERFORM openarc_durable.assert_listing_content(
    kind, title, description, manifest, price, evidence_contract,
    endpoint_contract, terms_revision, privacy_summary, payment_lane, availability);
  IF NOT openarc_durable.is_canonical_listing_id(listing_id) THEN
    RAISE EXCEPTION 'market_listing_invalid' USING ERRCODE = '22023';
  END IF;
  IF NOT openarc_durable.is_canonical_listing_version(expected_latest_version) THEN
    RAISE EXCEPTION 'market_version_invalid' USING ERRCODE = '22023';
  END IF;
  IF mutation_id IS NULL OR NOT openarc_durable.is_canonical_uuid_v4(mutation_id::text) THEN
    RAISE EXCEPTION 'market_mutation_invalid' USING ERRCODE = '22023';
  END IF;
  IF NOT openarc_durable.is_canonical_hex64(key_hash)
     OR NOT openarc_durable.is_canonical_hex64(request_digest)
     OR NOT openarc_durable.is_canonical_hex64(session_context_digest) THEN
    RAISE EXCEPTION 'market_metadata_invalid' USING ERRCODE = '22023';
  END IF;

  SELECT l.out_actor, l.out_role INTO v_actor, v_role
    FROM openarc_durable.lock_market_actor(session_hash, organization_id, true, false) AS l;
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'market_forbidden' USING ERRCODE = '42501';
  END IF;
  IF v_role NOT IN ('owner', 'provider_admin', 'provider_developer') THEN
    RAISE EXCEPTION 'market_forbidden' USING ERRCODE = '42501';
  END IF;

  -- Resolve the owning provider WITHOUT authority, then lock it before the
  -- listing, preserving account/session -> org -> membership -> provider ->
  -- listing ordering. The provider binding is revalidated under the root lock.
  SELECT l.provider_id INTO v_provider_id
    FROM openarc_tenant.listings l
   WHERE l.organization_id = organization_id AND l.listing_id = listing_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'market_not_found' USING ERRCODE = '23503';
  END IF;
  SELECT p.status INTO v_provider_status
    FROM openarc_tenant.providers p
   WHERE p.organization_id = organization_id AND p.provider_id = v_provider_id FOR UPDATE;
  IF NOT FOUND OR v_provider_status <> 'active' THEN
    RAISE EXCEPTION 'market_forbidden' USING ERRCODE = '42501';
  END IF;
  SELECT l.provider_id, l.latest_version INTO v_provider_id, v_latest
    FROM openarc_tenant.listings l
   WHERE l.organization_id = organization_id AND l.listing_id = listing_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'market_not_found' USING ERRCODE = '23503';
  END IF;

  -- Same-key replay is checked BEFORE the expected-version CAS.
  SELECT * INTO v_existing
    FROM openarc_durable.idempotency_records r
   WHERE r.organization_id = organization_id AND r.operation = 'market.listing.version.create'
     AND r.key_hash = key_hash FOR UPDATE;
  IF FOUND THEN
    IF v_existing.request_digest = request_digest
       AND v_existing.mutation_id = mutation_id
       AND v_existing.actor_account_id = v_actor
       AND v_existing.session_context_digest = session_context_digest
       AND v_existing.status = 'committed' THEN
      SELECT l.out_actor INTO v_recheck
        FROM openarc_durable.lock_market_actor(session_hash, organization_id, true, false) AS l;
      IF v_recheck IS NULL OR v_recheck <> v_actor THEN
        RAISE EXCEPTION 'market_session_invalid' USING ERRCODE = '28000';
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
    RAISE EXCEPTION 'market_idempotency_conflict' USING ERRCODE = 'P0D01';
  END IF;
  PERFORM 1 FROM openarc_durable.idempotency_records r
   WHERE r.organization_id = organization_id AND r.mutation_id = mutation_id FOR UPDATE;
  IF FOUND THEN
    RAISE EXCEPTION 'market_idempotency_conflict' USING ERRCODE = 'P0D01';
  END IF;

  -- Exact CAS: latest_version must still equal the expected value.
  IF v_latest IS DISTINCT FROM expected_latest_version THEN
    RAISE EXCEPTION 'market_version_conflict' USING ERRCODE = '23505';
  END IF;
  IF v_latest::numeric >= 999999999 THEN
    RAISE EXCEPTION 'market_version_exhausted' USING ERRCODE = '22003';
  END IF;
  v_next := (v_latest::numeric + 1)::text;
  v_resource_id := listing_id || '@' || v_next;

  INSERT INTO openarc_durable.idempotency_records (
    organization_id, operation, key_hash, request_digest, digest_version,
    actor_account_id, session_context_digest, network, mutation_id, status
  ) VALUES (
    organization_id, 'market.listing.version.create', key_hash, request_digest,
    'market.listing.version.create.v1', v_actor, session_context_digest,
    'eip155:5042002', mutation_id, 'pending'
  );
  INSERT INTO openarc_tenant.listing_versions (
    organization_id, listing_id, version, provider_id, kind, title, description,
    manifest, price, evidence_contract, endpoint_contract, terms_revision,
    privacy_summary, payment_lane, availability
  ) VALUES (
    organization_id, listing_id, v_next, v_provider_id, kind, title, description,
    manifest, price, evidence_contract, endpoint_contract, terms_revision,
    privacy_summary, payment_lane, availability
  );
  INSERT INTO openarc_tenant.listing_version_states (
    organization_id, listing_id, version, status, origin_review_state, published_at
  ) VALUES (
    organization_id, listing_id, v_next, 'draft', 'unreviewed', NULL
  );
  UPDATE openarc_tenant.listings l
     SET latest_version = v_next, updated_at = clock_timestamp()
   WHERE l.organization_id = organization_id AND l.listing_id = listing_id;
  UPDATE openarc_durable.idempotency_records r
     SET status = 'committed', resource_type = 'listing_version',
         resource_id = v_resource_id, committed_at = clock_timestamp()
   WHERE r.organization_id = organization_id AND r.operation = 'market.listing.version.create'
     AND r.key_hash = key_hash
   RETURNING r.committed_at INTO v_committed_at;
  INSERT INTO openarc_durable.audit_events (
    organization_id, actor_account_id, operation, mutation_id, resource_type, resource_id, outcome
  ) VALUES (
    organization_id, v_actor, 'market.listing.version.create', mutation_id,
    'listing_version', v_resource_id, 'committed'
  );
  INSERT INTO openarc_durable.outbox_events (
    organization_id, mutation_id, resource_type, resource_id, event_type, payload_version
  ) VALUES (
    organization_id, mutation_id, 'listing_version', v_resource_id, 'market.listing.version.created', 1
  );

  SELECT l.out_actor INTO v_recheck
    FROM openarc_durable.lock_market_actor(session_hash, organization_id, true, false) AS l;
  IF v_recheck IS NULL OR v_recheck <> v_actor THEN
    RAISE EXCEPTION 'market_session_invalid' USING ERRCODE = '28000';
  END IF;

  out_replayed := false;
  out_mutation_id := mutation_id;
  out_operation := 'market.listing.version.create';
  out_resource_type := 'listing_version';
  out_resource_id := v_resource_id;
  out_committed_at := v_committed_at;
  RETURN NEXT;
END;
$$;

-- ---------------------------------------------------------------------------
-- Owner/history readers. All five active org roles may read; recovery may read.
-- The returned content is bounded and never includes another org's data.
-- ---------------------------------------------------------------------------
CREATE FUNCTION openarc_durable.read_owner_listings(
  session_hash text,
  organization_id text,
  after_listing_id text,
  page_limit integer
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
  v_limit integer;
  v_recheck text;
BEGIN
  IF page_limit IS NULL OR page_limit < 1 OR page_limit > 51 THEN
    RAISE EXCEPTION 'market_page_invalid' USING ERRCODE = '22023';
  END IF;
  IF after_listing_id IS NOT NULL AND NOT openarc_durable.is_canonical_listing_id(after_listing_id) THEN
    RAISE EXCEPTION 'market_page_invalid' USING ERRCODE = '22023';
  END IF;
  v_limit := page_limit;
  SELECT l.out_actor INTO v_actor
    FROM openarc_durable.lock_market_actor(session_hash, organization_id, false, true) AS l;
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'market_forbidden' USING ERRCODE = '42501';
  END IF;
  SELECT l.out_actor INTO v_recheck
    FROM openarc_durable.lock_market_actor(session_hash, organization_id, false, true) AS l;
  IF v_recheck IS NULL OR v_recheck <> v_actor THEN
    RAISE EXCEPTION 'market_session_invalid' USING ERRCODE = '28000';
  END IF;
  RETURN QUERY
    SELECT l.listing_id, l.organization_id, l.provider_id, l.active_version,
           l.created_at, l.updated_at
      FROM openarc_tenant.listings l
     WHERE l.organization_id = organization_id
       AND (after_listing_id IS NULL OR l.listing_id > after_listing_id)
     ORDER BY l.listing_id
     LIMIT v_limit;
  -- A concurrent table lock could have blocked the materialization above, so
  -- re-resolve the SAME live session/actor/DB expiry before returning rows.
  SELECT l.out_actor INTO v_recheck
    FROM openarc_durable.lock_market_actor(session_hash, organization_id, false, true) AS l;
  IF v_recheck IS NULL OR v_recheck <> v_actor THEN
    RAISE EXCEPTION 'market_session_invalid' USING ERRCODE = '28000';
  END IF;
END;
$$;

CREATE FUNCTION openarc_durable.read_owner_listing_versions(
  session_hash text,
  organization_id text,
  listing_id text,
  after_version text,
  page_limit integer
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
  v_limit integer;
  v_recheck text;
BEGIN
  IF NOT openarc_durable.is_canonical_listing_id(listing_id) THEN
    RAISE EXCEPTION 'market_listing_invalid' USING ERRCODE = '22023';
  END IF;
  IF page_limit IS NULL OR page_limit < 1 OR page_limit > 51 THEN
    RAISE EXCEPTION 'market_page_invalid' USING ERRCODE = '22023';
  END IF;
  IF after_version IS NOT NULL AND NOT openarc_durable.is_canonical_listing_version(after_version) THEN
    RAISE EXCEPTION 'market_page_invalid' USING ERRCODE = '22023';
  END IF;
  v_limit := page_limit;
  SELECT l.out_actor INTO v_actor
    FROM openarc_durable.lock_market_actor(session_hash, organization_id, false, true) AS l;
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'market_forbidden' USING ERRCODE = '42501';
  END IF;
  PERFORM 1 FROM openarc_tenant.listings l
   WHERE l.organization_id = organization_id AND l.listing_id = listing_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'market_not_found' USING ERRCODE = '23503';
  END IF;
  SELECT l.out_actor INTO v_recheck
    FROM openarc_durable.lock_market_actor(session_hash, organization_id, false, true) AS l;
  IF v_recheck IS NULL OR v_recheck <> v_actor THEN
    RAISE EXCEPTION 'market_session_invalid' USING ERRCODE = '28000';
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
       AND (after_version IS NULL OR v.version::numeric > after_version::numeric)
     ORDER BY v.version::numeric
     LIMIT v_limit;
  SELECT l.out_actor INTO v_recheck
    FROM openarc_durable.lock_market_actor(session_hash, organization_id, false, true) AS l;
  IF v_recheck IS NULL OR v_recheck <> v_actor THEN
    RAISE EXCEPTION 'market_session_invalid' USING ERRCODE = '28000';
  END IF;
END;
$$;

CREATE FUNCTION openarc_durable.read_owner_listing_version(
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
    RAISE EXCEPTION 'market_listing_invalid' USING ERRCODE = '22023';
  END IF;
  IF NOT openarc_durable.is_canonical_listing_version(version) THEN
    RAISE EXCEPTION 'market_version_invalid' USING ERRCODE = '22023';
  END IF;
  SELECT l.out_actor INTO v_actor
    FROM openarc_durable.lock_market_actor(session_hash, organization_id, false, true) AS l;
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'market_forbidden' USING ERRCODE = '42501';
  END IF;
  PERFORM 1 FROM openarc_tenant.listings l
   WHERE l.organization_id = organization_id AND l.listing_id = listing_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'market_not_found' USING ERRCODE = '23503';
  END IF;
  SELECT l.out_actor INTO v_recheck
    FROM openarc_durable.lock_market_actor(session_hash, organization_id, false, true) AS l;
  IF v_recheck IS NULL OR v_recheck <> v_actor THEN
    RAISE EXCEPTION 'market_session_invalid' USING ERRCODE = '28000';
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
  SELECT l.out_actor INTO v_recheck
    FROM openarc_durable.lock_market_actor(session_hash, organization_id, false, true) AS l;
  IF v_recheck IS NULL OR v_recheck <> v_actor THEN
    RAISE EXCEPTION 'market_session_invalid' USING ERRCODE = '28000';
  END IF;
END;
$$;

CREATE FUNCTION openarc_durable.read_market_mutation_status(
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
  v_recheck text;
  v_found boolean := false;
  v_mutation_id uuid;
  v_operation text;
  v_resource_type text;
  v_resource_id text;
  v_committed_at timestamptz;
BEGIN
  IF NOT openarc_durable.is_canonical_org_id(organization_id) THEN
    RAISE EXCEPTION 'market_organization_invalid' USING ERRCODE = '22023';
  END IF;
  IF mutation_id IS NULL THEN
    RAISE EXCEPTION 'market_mutation_invalid' USING ERRCODE = '22023';
  END IF;
  SELECT l.out_actor INTO v_actor
    FROM openarc_durable.lock_market_actor(session_hash, organization_id, false, true) AS l;
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'market_forbidden' USING ERRCODE = '42501';
  END IF;
  SELECT r.mutation_id, r.operation, r.resource_type, r.resource_id, r.committed_at
    INTO v_mutation_id, v_operation, v_resource_type, v_resource_id, v_committed_at
    FROM openarc_durable.idempotency_records r
   WHERE r.organization_id = organization_id AND r.mutation_id = mutation_id
     AND r.actor_account_id = v_actor AND r.status = 'committed'
     AND r.operation IN ('market.listing.create', 'market.listing.version.create');
  v_found := FOUND;
  SELECT l.out_actor INTO v_recheck
    FROM openarc_durable.lock_market_actor(session_hash, organization_id, false, true) AS l;
  IF v_recheck IS NULL OR v_recheck <> v_actor THEN
    RAISE EXCEPTION 'market_session_invalid' USING ERRCODE = '28000';
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
-- Privileges: runtime executes only the market helpers; no table access.
-- ---------------------------------------------------------------------------
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA openarc_durable FROM PUBLIC;
GRANT EXECUTE ON FUNCTION openarc_durable.commit_listing_create(text, text, text, text, text, text, jsonb, jsonb, jsonb, jsonb, text, text, text, jsonb, uuid, text, text, text) TO openarc_tenant_app;
GRANT EXECUTE ON FUNCTION openarc_durable.commit_listing_version_create(text, text, text, text, text, text, text, jsonb, jsonb, jsonb, jsonb, text, text, text, jsonb, uuid, text, text, text) TO openarc_tenant_app;
GRANT EXECUTE ON FUNCTION openarc_durable.lock_market_actor(text, text, boolean, boolean) TO openarc_tenant_app;
GRANT EXECUTE ON FUNCTION openarc_durable.read_owner_listings(text, text, text, integer) TO openarc_tenant_app;
GRANT EXECUTE ON FUNCTION openarc_durable.read_owner_listing_versions(text, text, text, text, integer) TO openarc_tenant_app;
GRANT EXECUTE ON FUNCTION openarc_durable.read_owner_listing_version(text, text, text, text) TO openarc_tenant_app;
GRANT EXECUTE ON FUNCTION openarc_durable.read_market_mutation_status(text, text, uuid) TO openarc_tenant_app;
