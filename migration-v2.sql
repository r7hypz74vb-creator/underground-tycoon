-- Apply only if you created the previous starter schema.
ALTER TABLE marketplace ADD COLUMN IF NOT EXISTS item_snapshot JSONB;
-- Remove the old inventory FK: an item is moved out of inventory when listed.
ALTER TABLE marketplace DROP CONSTRAINT IF EXISTS marketplace_item_id_fkey;
ALTER TABLE marketplace ALTER COLUMN item_id DROP NOT NULL;
CREATE INDEX IF NOT EXISTS marketplace_active_created_idx ON marketplace(status,created_at DESC);
CREATE INDEX IF NOT EXISTS referrals_inviter_idx ON referrals(inviter_id);
