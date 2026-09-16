-- ---------------------------------------------------------------------------
-- 004 — what the dashboards need that the counter did not
--
-- Three things, none of them a copy of another product's data:
--
--   1. The outlet's TRADING DAY. A bar that closes at 2am takes money on
--      Friday night that lands on Saturday in UTC, and every sales figure on
--      every dashboard is wrong by one night's takings until the day boundary
--      is the outlet's own rather than the server's. This is POS' operating
--      configuration of when its own counter day rolls over — the same kind of
--      thing as service_charge_pc next to it. It is NOT Manage's branch
--      calendar and nothing reads it as one.
--
--   2. A DAILY TARGET, so "% of target" on the outlet panel is a real figure a
--      manager set rather than a number invented to fill a progress bar. Null
--      means no target, and the dashboard then shows no target column at all.
--
--   3. Indexes for the aggregates the five dashboards run. They are read-side
--      only; no new table, no new copy, nothing to reconcile.
-- ---------------------------------------------------------------------------

ALTER TABLE pos_location_profiles
    ADD COLUMN IF NOT EXISTS trading_timezone  TEXT    NOT NULL DEFAULT 'UTC',
    ADD COLUMN IF NOT EXISTS day_start_minutes INT     NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS daily_target      NUMERIC(18,4);

COMMENT ON COLUMN pos_location_profiles.trading_timezone IS
    'IANA zone this outlet trades in. POS operating configuration for its own business date, not a copy of any Manage master.';
COMMENT ON COLUMN pos_location_profiles.day_start_minutes IS
    'Minutes past local midnight at which this outlet''s business day begins. 360 = a day that starts at 6am.';
COMMENT ON COLUMN pos_location_profiles.daily_target IS
    'Net sales target for one trading day, set by the shop. NULL means no target and the dashboards show none.';

-- The status comment in 001 lists the states that were planned; these are the
-- states the code actually writes. An applied migration cannot be edited
-- without tripping the checksum, so the correction lives here.
COMMENT ON COLUMN pos_carts.status IS
    'OPEN | HELD | CHECKING_OUT | COMPLETED | VOID';
COMMENT ON COLUMN pos_carts.total_amount IS
    'What the counter charged. The accounting value of the sale is Books'' and can differ.';

-- ---------------------------------------------------------------------------
-- Read-side indexes for the dashboard aggregates
--
-- Every dashboard query is (company, status, instant range), so that is the
-- index. The partial ones exist because "the tills open right now" and "what is
-- stuck" are both tiny slices of a table that grows forever.
-- ---------------------------------------------------------------------------

CREATE INDEX IF NOT EXISTS idx_pos_carts_board
    ON pos_carts (cmp_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_pos_carts_terminal_window
    ON pos_carts (cmp_id, terminal_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_pos_carts_customer
    ON pos_carts (cmp_id, customer_account_id, created_at)
    WHERE customer_account_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_pos_cart_payments_cart
    ON pos_cart_payments (cart_id, payment_mode);

CREATE INDEX IF NOT EXISTS idx_pos_drawer_kind
    ON pos_cash_drawer_events (cmp_id, event_kind, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_pos_returns_window
    ON pos_returns (cmp_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_pos_audit_recent
    ON pos_audit_log (cmp_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_pos_commands_stuck
    ON pos_integration_commands (cmp_id, status, created_at DESC)
    WHERE status IN ('PENDING', 'POSTING', 'FAILED', 'BLOCKED');

-- ---------------------------------------------------------------------------
-- Offline submissions: the comment and the index both named states the code
-- never writes
--
-- 003 documented RECEIVED | POSTING | POSTED | FAILED | CONFLICT_REVIEW |
-- DISCARDED. What CheckoutService actually writes is RECEIVED, POSTING,
-- POSTED, CONFLICT and ABANDONED. That mismatch is not cosmetic: the partial
-- index below was built WHERE status IN (..., 'CONFLICT_REVIEW'), so it did not
-- cover a single conflicted row — which is precisely the slice the offline
-- queue screen and the manager's attention count read every time they load.
-- ---------------------------------------------------------------------------

COMMENT ON COLUMN pos_offline_submissions.status IS
    'RECEIVED | POSTING | POSTED | CONFLICT | ABANDONED. LOCAL_DRAFT and QUEUED are device states and never reach the server.';

DROP INDEX IF EXISTS idx_pos_offline_open;
CREATE INDEX IF NOT EXISTS idx_pos_offline_open
    ON pos_offline_submissions (cmp_id, status, received_at DESC)
    WHERE status IN ('RECEIVED', 'POSTING', 'CONFLICT');
