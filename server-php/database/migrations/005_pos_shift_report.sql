-- ---------------------------------------------------------------------------
-- 005 — what the Shift Report needs that closing a drawer did not
--
-- The Shift Report is the manager's control screen for one shift: what it
-- sold, what it took, what needed approving, and whether the drawer balances.
-- Four things were missing, and not one of them is another product's data.
--
--   1. THE DENOMINATION SHEET. A drawer is counted in notes and coins, and
--      "counted ₹32,400" throws away the count that produced it. The sheet is
--      the evidence behind the figure, so it is kept with the count event
--      rather than in a table of its own — one row per count, the sheet on it.
--
--   2. A VARIANCE TOLERANCE. "Is ₹50 short a problem?" is a decision the shop
--      makes, not a constant in a stylesheet. Zero — the default — means every
--      variance is reported, which is the safe answer for a shop that has not
--      decided yet.
--
--   3. THE DENOMINATIONS THEMSELVES. A shop counting in INR counts different
--      notes from one counting in AED, and a hard-coded list is wrong the first
--      time POS is sold outside India.
--
--   4. WHEN A COUNT OF NO-SALE DRAWER OPENS BECOMES A QUESTION. The single
--      most useful signal in a till-fraud investigation, and the number at
--      which it is worth looking is the shop's judgement.
--
-- None of this is accounting. Books owns the ledger; what is here is the
-- operational record of a physical drawer and the shop's own review policy.
-- ---------------------------------------------------------------------------

-- 1. The sheet behind the count.
ALTER TABLE pos_cash_drawer_events
    ADD COLUMN IF NOT EXISTS detail JSONB NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN pos_cash_drawer_events.detail IS
    'Operational evidence for this event. On a closing_count and an opening_float that is the denomination sheet: [{denomination, quantity, amount}]. Never an accounting entry.';

-- 2, 3, 4. The shop's own review policy.
ALTER TABLE pos_settings
    ADD COLUMN IF NOT EXISTS cash_variance_tolerance NUMERIC(18,4) NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS no_sale_review_threshold INT NOT NULL DEFAULT 5,
    ADD COLUMN IF NOT EXISTS cash_denominations JSONB NOT NULL
        DEFAULT '[500, 200, 100, 50, 20, 10, 5, 2, 1]'::jsonb;

COMMENT ON COLUMN pos_settings.cash_variance_tolerance IS
    'How far a counted drawer may be from expected before the shift report calls it a variance to act on. 0 reports every difference.';
COMMENT ON COLUMN pos_settings.no_sale_review_threshold IS
    'No-sale drawer opens in one shift above which the shift report raises it for review. 0 turns the rule off.';
COMMENT ON COLUMN pos_settings.cash_denominations IS
    'The notes and coins this shop counts its drawer in, largest first. POS operating configuration, not a currency master.';

-- ---------------------------------------------------------------------------
-- Read-side indexes for the shift report
--
-- Every query on that screen is (one session, one kind, in time order), which
-- is a slice the existing company-wide indexes cannot serve on their own.
-- ---------------------------------------------------------------------------

CREATE INDEX IF NOT EXISTS idx_pos_approvals_session
    ON pos_approval_events (session_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_pos_carts_session_status
    ON pos_carts (session_id, status, created_at);

CREATE INDEX IF NOT EXISTS idx_pos_returns_session
    ON pos_returns (session_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_pos_sessions_day
    ON pos_register_sessions (cmp_id, terminal_id, opened_at DESC);
