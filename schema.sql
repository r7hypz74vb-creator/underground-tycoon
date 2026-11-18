CREATE TABLE IF NOT EXISTS players (
  telegram_id BIGINT PRIMARY KEY,
  username TEXT,
  coins BIGINT NOT NULL DEFAULT 250,
  xp BIGINT NOT NULL DEFAULT 0,
  level INT NOT NULL DEFAULT 1,
  business_level INT NOT NULL DEFAULT 1,
  prestige INT NOT NULL DEFAULT 0,
  reputation BIGINT NOT NULL DEFAULT 0,
  earned BIGINT NOT NULL DEFAULT 0,
  referred_by BIGINT REFERENCES players(telegram_id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS inventory (
  id BIGSERIAL PRIMARY KEY,
  telegram_id BIGINT NOT NULL REFERENCES players(telegram_id),
  item_key TEXT NOT NULL,
  item_name TEXT NOT NULL,
  rarity TEXT NOT NULL,
  value BIGINT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS referrals (
  id BIGSERIAL PRIMARY KEY,
  inviter_id BIGINT NOT NULL REFERENCES players(telegram_id),
  invitee_id BIGINT NOT NULL UNIQUE REFERENCES players(telegram_id),
  rewarded BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS marketplace (
  id BIGSERIAL PRIMARY KEY,
  seller_id BIGINT NOT NULL REFERENCES players(telegram_id),
  item_id BIGINT NOT NULL,
  item_snapshot JSONB NOT NULL,
  price BIGINT NOT NULL CHECK(price > 0),
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','sold','cancelled')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS payment_events (
  telegram_charge_id TEXT PRIMARY KEY,
  telegram_id BIGINT NOT NULL REFERENCES players(telegram_id),
  product_key TEXT NOT NULL,
  stars INT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS marketplace_active_created_idx ON marketplace(status,created_at DESC);
CREATE INDEX IF NOT EXISTS referrals_inviter_idx ON referrals(inviter_id);
