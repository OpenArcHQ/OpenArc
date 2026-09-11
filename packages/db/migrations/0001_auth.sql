CREATE SCHEMA IF NOT EXISTS openarc_auth AUTHORIZATION openarc_migrator;
ALTER SCHEMA openarc_auth OWNER TO openarc_migrator;
REVOKE ALL ON SCHEMA openarc_auth FROM PUBLIC;
GRANT USAGE ON SCHEMA openarc_auth TO openarc_auth_app;

CREATE TABLE openarc_auth.accounts (
  account_id text PRIMARY KEY,
  user_handle text NOT NULL UNIQUE,
  status text NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT accounts_account_id_format CHECK (
    account_id ~ '^openarc:account:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  ),
  CONSTRAINT accounts_user_handle_format CHECK (
    user_handle ~ '^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$'
  ),
  CONSTRAINT accounts_status_valid CHECK (status IN ('active', 'disabled'))
);

CREATE TABLE openarc_auth.passkeys (
  credential_id text PRIMARY KEY,
  account_id text NOT NULL REFERENCES openarc_auth.accounts(account_id) ON DELETE CASCADE,
  public_key bytea NOT NULL,
  counter bigint NOT NULL,
  device_type text NOT NULL,
  backed_up boolean NOT NULL,
  transports text[] NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT passkeys_credential_id_format CHECK (
    char_length(credential_id) BETWEEN 1 AND 1024
    AND credential_id ~ '^[A-Za-z0-9_-]+$'
  ),
  CONSTRAINT passkeys_public_key_length CHECK (octet_length(public_key) BETWEEN 1 AND 2048),
  CONSTRAINT passkeys_counter_range CHECK (counter BETWEEN 0 AND 4294967295),
  CONSTRAINT passkeys_device_type_valid CHECK (device_type IN ('singleDevice', 'multiDevice')),
  CONSTRAINT passkeys_transports_valid CHECK (
    (
      array_ndims(transports) IS NULL
      OR (
        array_ndims(transports) = 1
        AND coalesce(array_length(transports, 1), 0) <= 8
        AND array_position(transports, NULL) IS NULL
      )
    )
    AND transports <@ ARRAY['usb', 'nfc', 'ble', 'internal', 'hybrid', 'cable', 'smart-card']::text[]
  )
);

CREATE TABLE openarc_auth.wallets (
  address text NOT NULL,
  chain_id integer NOT NULL,
  account_id text NOT NULL REFERENCES openarc_auth.accounts(account_id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (chain_id, address),
  CONSTRAINT wallets_address_format CHECK (address ~ '^0x[0-9a-f]{40}$'),
  CONSTRAINT wallets_chain_id_valid CHECK (chain_id = 5042002)
);

CREATE TABLE openarc_auth.challenges (
  challenge_hash text PRIMARY KEY,
  binding_hash text NOT NULL,
  kind text NOT NULL,
  challenge text NOT NULL,
  user_handle text,
  account_id text REFERENCES openarc_auth.accounts(account_id) ON DELETE CASCADE,
  wallet_address text,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  CONSTRAINT challenges_challenge_hash_format CHECK (challenge_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT challenges_binding_hash_format CHECK (binding_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT challenges_kind_valid CHECK (
    kind IN ('passkey_register', 'passkey_login', 'passkey_add', 'wallet_login', 'wallet_link')
  ),
  CONSTRAINT challenges_challenge_format CHECK (
    char_length(challenge) BETWEEN 1 AND 256
    AND challenge ~ '^[A-Za-z0-9_-]+$'
  ),
  CONSTRAINT challenges_user_handle_format CHECK (
    user_handle IS NULL OR user_handle ~ '^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$'
  ),
  CONSTRAINT challenges_wallet_address_format CHECK (
    wallet_address IS NULL OR wallet_address ~ '^0x[0-9a-f]{40}$'
  ),
  CONSTRAINT challenges_expiry_window CHECK (
    expires_at > created_at AND expires_at <= created_at + interval '5 minutes'
  ),
  CONSTRAINT challenges_kind_consistency CHECK (
    (kind = 'passkey_register' AND user_handle IS NOT NULL AND account_id IS NULL AND wallet_address IS NULL)
    OR (kind = 'passkey_login' AND user_handle IS NULL AND account_id IS NULL AND wallet_address IS NULL)
    OR (kind = 'passkey_add' AND user_handle IS NOT NULL AND account_id IS NOT NULL AND wallet_address IS NULL)
    OR (kind = 'wallet_login' AND user_handle IS NULL AND account_id IS NULL AND wallet_address IS NOT NULL)
    OR (kind = 'wallet_link' AND user_handle IS NULL AND account_id IS NOT NULL AND wallet_address IS NOT NULL)
  )
);

CREATE TABLE openarc_auth.sessions (
  token_hash text PRIMARY KEY,
  account_id text NOT NULL REFERENCES openarc_auth.accounts(account_id) ON DELETE CASCADE,
  method text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  CONSTRAINT sessions_token_hash_format CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT sessions_method_valid CHECK (method IN ('passkey', 'wallet', 'recovery')),
  CONSTRAINT sessions_expiry_window CHECK (
    expires_at > created_at AND expires_at <= created_at + interval '24 hours'
  )
);

CREATE TABLE openarc_auth.recovery_codes (
  code_hash text PRIMARY KEY,
  account_id text NOT NULL REFERENCES openarc_auth.accounts(account_id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT recovery_codes_code_hash_format CHECK (code_hash ~ '^[0-9a-f]{64}$')
);

CREATE TABLE openarc_auth.rate_limits (
  key_hash text NOT NULL,
  window_start bigint NOT NULL,
  attempts integer NOT NULL,
  PRIMARY KEY (key_hash, window_start),
  CONSTRAINT rate_limits_key_hash_format CHECK (key_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT rate_limits_window_start_nonnegative CHECK (window_start >= 0),
  CONSTRAINT rate_limits_attempts_min CHECK (attempts >= 1)
);

CREATE INDEX passkeys_account_id_idx ON openarc_auth.passkeys (account_id);
CREATE INDEX wallets_account_id_idx ON openarc_auth.wallets (account_id);
CREATE INDEX challenges_account_id_idx ON openarc_auth.challenges (account_id);
CREATE INDEX challenges_expires_at_idx ON openarc_auth.challenges (expires_at);
CREATE INDEX sessions_account_id_idx ON openarc_auth.sessions (account_id);
CREATE INDEX sessions_expires_at_idx ON openarc_auth.sessions (expires_at);
CREATE INDEX recovery_codes_account_id_idx ON openarc_auth.recovery_codes (account_id);

REVOKE ALL ON ALL TABLES IN SCHEMA openarc_auth FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA openarc_auth TO openarc_auth_app;
