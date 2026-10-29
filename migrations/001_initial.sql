CREATE TABLE users (
  id uuid PRIMARY KEY,
  email text NOT NULL UNIQUE CHECK (email = lower(email)),
  name text NOT NULL,
  api_key_hash text NOT NULL UNIQUE,
  blocked boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE wallets (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL UNIQUE REFERENCES users(id),
  currency text NOT NULL DEFAULT 'NGN' CHECK (currency = 'NGN'),
  balance_minor bigint NOT NULL DEFAULT 0 CHECK (balance_minor BETWEEN 0 AND 9007199254740991),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE blacklist (
  email text PRIMARY KEY CHECK (email = lower(email)),
  reason text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE transactions (
  id uuid PRIMARY KEY,
  actor text NOT NULL,
  idempotency_key text NOT NULL,
  request_hash text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('transfer', 'funding')),
  source_wallet_id uuid REFERENCES wallets(id),
  destination_wallet_id uuid NOT NULL REFERENCES wallets(id),
  amount_minor bigint NOT NULL CHECK (amount_minor BETWEEN 1 AND 9007199254740991),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (actor, idempotency_key),
  CHECK ((kind = 'transfer' AND source_wallet_id IS NOT NULL AND source_wallet_id <> destination_wallet_id)
      OR (kind = 'funding' AND source_wallet_id IS NULL))
);
CREATE INDEX transactions_source_history ON transactions(source_wallet_id, created_at DESC, id DESC);
CREATE INDEX transactions_destination_history ON transactions(destination_wallet_id, created_at DESC, id DESC);
CREATE TABLE ledger_entries (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  transaction_id uuid NOT NULL REFERENCES transactions(id),
  wallet_id uuid NOT NULL REFERENCES wallets(id),
  delta_minor bigint NOT NULL CHECK (delta_minor <> 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(transaction_id, wallet_id)
);
CREATE TABLE account_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id),
  blocked boolean NOT NULL,
  reason text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
