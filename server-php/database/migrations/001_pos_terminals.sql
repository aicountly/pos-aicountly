-- ---------------------------------------------------------------------------
-- Aicountly POS — terminals, registers, drawers and carts
--
-- POS is the REAL-TIME COUNTER application. It owns the operational facts of
-- running a shop or a restaurant, and nothing else:
--
--   OURS      terminals, registers, shifts, cash drawers, held carts, tables,
--             KOTs, kitchen stations, menu presentation, modifiers
--   NOT OURS  items, stock, batches, valuation      -> Inventory
--             the sale, the tax, the receivable      -> Smart Books
--             company, branch, financial year        -> Manage
--             the customer                           -> Contacts / Books
--
-- THE OFFLINE CACHE IS ON THE DEVICE, NOT HERE. A till that loses its internet
-- keeps selling from an encrypted IndexedDB cache in the browser — a copy that
-- is explicitly non-authoritative, versioned and safe to throw away. This
-- server database never becomes a replica of Inventory or Books, and the
-- release-blocking test in tests/integration.php fails if it starts to.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS pos_permission_profiles (
    profile_id      BIGSERIAL PRIMARY KEY,
    cmp_id          BIGINT       NOT NULL,
    profile_code    TEXT         NOT NULL,
    profile_name    TEXT         NOT NULL,
    description     TEXT,
    permissions     JSONB        NOT NULL DEFAULT '[]'::jsonb,
    is_system       BOOLEAN      NOT NULL DEFAULT FALSE,
    is_active       BOOLEAN      NOT NULL DEFAULT TRUE,
    created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    UNIQUE (cmp_id, profile_code)
);

CREATE TABLE IF NOT EXISTS pos_permission_assignments (
    assignment_id   BIGSERIAL PRIMARY KEY,
    cmp_id          BIGINT       NOT NULL,
    user_uuid       TEXT         NOT NULL,
    profile_id      BIGINT       NOT NULL REFERENCES pos_permission_profiles(profile_id) ON DELETE CASCADE,
    -- A hashed PIN for fast user switching at a shared till. Never the PIN.
    switch_pin_hash TEXT,
    created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    UNIQUE (cmp_id, user_uuid, profile_id)
);

CREATE INDEX IF NOT EXISTS idx_pos_perm_assign_user ON pos_permission_assignments (cmp_id, user_uuid);

-- --------------------------------------------------------------------------
-- Outlet profile — POS configuration for a branch Manage already owns
--
-- NOT a second branch master. It holds branch_id and the POS settings that
-- Manage has no opinion about.
-- --------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS pos_location_profiles (
    location_id     BIGSERIAL PRIMARY KEY,
    cmp_id          BIGINT       NOT NULL,
    -- Manage's branch. A reference; the branch's name and address stay there.
    bo_id           BIGINT       NOT NULL,
    location_code   TEXT         NOT NULL,
    display_name    TEXT,
    -- retail | restaurant
    pos_mode        TEXT         NOT NULL DEFAULT 'retail',
    -- qsr | cafe | grocery | fashion | electronics | pharmacy | fine_dining
    vertical_preset TEXT,
    -- Inventory's warehouse that stock is sold out of here. A reference.
    default_warehouse_id BIGINT,
    -- Books' account that cash lands in. A reference.
    default_cash_account_id BIGINT,
    -- Books' account for a walk-in customer with no name.
    walk_in_account_id BIGINT,
    currency_code   TEXT         NOT NULL DEFAULT 'INR',
    -- allow | warn | block — POS defers to Inventory's answer; this only
    -- decides whether the cashier may override a warning.
    allow_negative_override BOOLEAN NOT NULL DEFAULT FALSE,
    service_charge_pc NUMERIC(6,3) NOT NULL DEFAULT 0,
    tips_enabled    BOOLEAN      NOT NULL DEFAULT FALSE,
    is_active       BOOLEAN      NOT NULL DEFAULT TRUE,
    created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    UNIQUE (cmp_id, location_code)
);

CREATE TABLE IF NOT EXISTS pos_terminals (
    terminal_id     BIGSERIAL PRIMARY KEY,
    terminal_uuid   UUID         NOT NULL DEFAULT gen_random_uuid(),
    cmp_id          BIGINT       NOT NULL,
    location_id     BIGINT       NOT NULL REFERENCES pos_location_profiles(location_id) ON DELETE CASCADE,
    terminal_code   TEXT         NOT NULL,
    display_name    TEXT,
    -- counter | kiosk | waiter_tablet | kds | customer_display
    terminal_kind   TEXT         NOT NULL DEFAULT 'counter',
    -- Hardware and printing, as configuration this product genuinely owns.
    receipt_printer TEXT,
    kot_printer_routes JSONB     NOT NULL DEFAULT '{}'::jsonb,
    hardware_profile JSONB       NOT NULL DEFAULT '{}'::jsonb,
    default_payment_modes JSONB  NOT NULL DEFAULT '["cash"]'::jsonb,
    is_active       BOOLEAN      NOT NULL DEFAULT TRUE,
    created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    UNIQUE (cmp_id, terminal_code)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_pos_terminals_uuid ON pos_terminals (terminal_uuid);

-- A browser or tablet authorised to act as a terminal. Revocable when lost.
CREATE TABLE IF NOT EXISTS pos_device_registrations (
    device_id       BIGSERIAL PRIMARY KEY,
    cmp_id          BIGINT       NOT NULL,
    terminal_id     BIGINT       NOT NULL REFERENCES pos_terminals(terminal_id) ON DELETE CASCADE,
    device_uuid     UUID         NOT NULL,
    device_label    TEXT,
    -- Only the hash. A device token in a database is a device token in a backup.
    device_token_hash TEXT       NOT NULL,
    -- ACTIVE | REVOKED
    status          TEXT         NOT NULL DEFAULT 'ACTIVE',
    last_seen_at    TIMESTAMPTZ,
    registered_by   TEXT,
    revoked_at      TIMESTAMPTZ,
    revoked_reason  TEXT,
    created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    UNIQUE (cmp_id, device_uuid)
);

-- --------------------------------------------------------------------------
-- Register sessions — a cashier's shift at a till
--
-- NOT HR attendance, which belongs to HRMS, and NOT a cash ledger, which
-- belongs to Books. This is the operational control: what was in the drawer at
-- the start, what should be there now, what actually is, and who signed for it.
-- --------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS pos_register_sessions (
    session_id      BIGSERIAL PRIMARY KEY,
    session_uuid    UUID         NOT NULL DEFAULT gen_random_uuid(),
    cmp_id          BIGINT       NOT NULL,
    fy_id           BIGINT       NOT NULL,
    bo_id           BIGINT       NOT NULL DEFAULT 0,
    terminal_id     BIGINT       NOT NULL REFERENCES pos_terminals(terminal_id) ON DELETE CASCADE,
    opened_by       TEXT         NOT NULL,
    closed_by       TEXT,
    -- OPEN | CLOSING | CLOSED
    status          TEXT         NOT NULL DEFAULT 'OPEN',
    opened_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    closed_at       TIMESTAMPTZ,
    opening_float   NUMERIC(18,4) NOT NULL DEFAULT 0,
    -- What the drawer SHOULD hold, from this session's own cash events. It is
    -- an operational count, not the company's cash balance — Books owns that,
    -- and a cash sale posts there like any other.
    expected_cash   NUMERIC(18,4) NOT NULL DEFAULT 0,
    counted_cash    NUMERIC(18,4),
    variance        NUMERIC(18,4),
    variance_reason TEXT,
    approved_by     TEXT,
    notes           TEXT,
    created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_pos_sessions_open ON pos_register_sessions (cmp_id, terminal_id, status);

CREATE TABLE IF NOT EXISTS pos_cash_drawer_events (
    event_id        BIGSERIAL PRIMARY KEY,
    session_id      BIGINT       NOT NULL REFERENCES pos_register_sessions(session_id) ON DELETE CASCADE,
    cmp_id          BIGINT       NOT NULL,
    -- opening_float | sale_tender | change_given | refund | cash_in | cash_out
    -- | safe_drop | petty_withdrawal | no_sale_open | closing_count
    event_kind      TEXT         NOT NULL,
    amount          NUMERIC(18,4) NOT NULL DEFAULT 0,
    reason          TEXT,
    actor_uuid      TEXT         NOT NULL,
    approved_by     TEXT,
    -- Where a drawer movement has an accounting consequence (a safe drop, a
    -- petty withdrawal), Books records it and we keep the reference.
    books_voucher_uuid TEXT,
    created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_pos_drawer_session ON pos_cash_drawer_events (session_id, created_at);

-- --------------------------------------------------------------------------
-- Carts — everything BEFORE the sale exists
--
-- A cart is not an invoice. It is what is on the counter right now, and it
-- lives here only until checkout; after that Books holds the sale and this row
-- keeps a reference so the cashier can find the receipt.
-- --------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS pos_carts (
    cart_id         BIGSERIAL PRIMARY KEY,
    cart_uuid       UUID         NOT NULL DEFAULT gen_random_uuid(),
    cmp_id          BIGINT       NOT NULL,
    fy_id           BIGINT       NOT NULL,
    bo_id           BIGINT       NOT NULL DEFAULT 0,
    terminal_id     BIGINT       REFERENCES pos_terminals(terminal_id) ON DELETE SET NULL,
    session_id      BIGINT       REFERENCES pos_register_sessions(session_id) ON DELETE SET NULL,
    -- OPEN | HELD | CHECKING_OUT | POSTED | VOIDED
    status          TEXT         NOT NULL DEFAULT 'OPEN',
    -- retail | dine_in | takeaway | delivery | pickup | qr_order | kiosk
    order_kind      TEXT         NOT NULL DEFAULT 'retail',
    -- Books' account for the customer, or null for a walk-in.
    customer_account_id BIGINT,
    customer_name   TEXT,
    customer_mobile TEXT,
    table_session_id BIGINT,
    token_no        TEXT,
    hold_label      TEXT,
    -- Cart arithmetic on our own agreed prices, for the customer display and
    -- the cashier. Books computes the tax that is actually charged.
    subtotal_amount      NUMERIC(18,4) NOT NULL DEFAULT 0,
    discount_amount      NUMERIC(18,4) NOT NULL DEFAULT 0,
    service_charge_amount NUMERIC(18,4) NOT NULL DEFAULT 0,
    tip_amount           NUMERIC(18,4) NOT NULL DEFAULT 0,
    estimated_tax_amount NUMERIC(18,4) NOT NULL DEFAULT 0,
    total_amount         NUMERIC(18,4) NOT NULL DEFAULT 0,

    -- What Books made of it once it was paid for. A reference.
    books_voucher_id   BIGINT,
    books_voucher_uuid TEXT,
    books_voucher_no   TEXT,
    -- What Inventory called the stock movement for this sale. A reference, not
    -- a copy: the movement, its costing and its effect on stock are Inventory's
    -- and are read live from Inventory whenever they are needed.
    inventory_document_uuid TEXT,

    -- Where the cart came from when it was created on a device that was offline.
    offline_created  BOOLEAN     NOT NULL DEFAULT FALSE,
    device_uuid      UUID,

    opened_by       TEXT         NOT NULL,
    voided_by       TEXT,
    void_reason     TEXT,
    created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_pos_carts_uuid ON pos_carts (cart_uuid);
CREATE INDEX IF NOT EXISTS idx_pos_carts_open ON pos_carts (cmp_id, status, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_pos_carts_session ON pos_carts (session_id);

CREATE TABLE IF NOT EXISTS pos_cart_lines (
    line_id         BIGSERIAL PRIMARY KEY,
    cart_id         BIGINT       NOT NULL REFERENCES pos_carts(cart_id) ON DELETE CASCADE,
    cmp_id          BIGINT       NOT NULL,
    line_no          INT         NOT NULL,

    -- Inventory's ids. The item's name, stock and valuation stay there.
    item_id         BIGINT,
    unit_id         BIGINT,
    warehouse_id    BIGINT,
    batch_id        BIGINT,
    serials         JSONB        NOT NULL DEFAULT '[]'::jsonb,
    -- What was shown on screen. A receipt has to be reprintable months later
    -- and the item may have been renamed; that is the whole reason this is here.
    display_name    TEXT,

    -- The menu entry this came from, where POS presentation differs from the
    -- item (a "Regular Cappuccino" that is one Inventory item plus modifiers).
    menu_item_id    BIGINT,
    parent_line_id  BIGINT       REFERENCES pos_cart_lines(line_id) ON DELETE CASCADE,
    modifiers       JSONB        NOT NULL DEFAULT '[]'::jsonb,
    instructions    TEXT,

    quantity        NUMERIC(18,4) NOT NULL DEFAULT 0,
    rate            NUMERIC(18,4) NOT NULL DEFAULT 0,
    discount_pc     NUMERIC(6,3)  NOT NULL DEFAULT 0,
    discount_amount NUMERIC(18,4) NOT NULL DEFAULT 0,
    tax_cat_id      BIGINT,
    estimated_tax_pc NUMERIC(6,3) NOT NULL DEFAULT 0,
    -- An ESTIMATE, and the name says so. Books computes the statutory tax when
    -- it writes the invoice, because place of supply, reverse charge and
    -- composition are accounting rules that live with the accounts. This number
    -- exists so the customer knows what to pay at the counter; where Books
    -- disagrees, Books is right and the receipt shows Books' figure.
    estimated_tax_amount NUMERIC(18,4) NOT NULL DEFAULT 0,
    line_amount     NUMERIC(18,4) NOT NULL DEFAULT 0,

    -- Restaurant: which KOT this line went out on, if any.
    kot_id          BIGINT,
    -- NEW | SENT | PREPARING | READY | SERVED | CANCELLED
    kitchen_status  TEXT,

    created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    UNIQUE (cart_id, line_no)
);

CREATE INDEX IF NOT EXISTS idx_pos_cart_lines_item ON pos_cart_lines (cmp_id, item_id);

-- How a cart was paid for. The accounting entry is Books'; this is the
-- operational record of which tender the cashier took.
CREATE TABLE IF NOT EXISTS pos_cart_payments (
    payment_id      BIGSERIAL PRIMARY KEY,
    cart_id         BIGINT       NOT NULL REFERENCES pos_carts(cart_id) ON DELETE CASCADE,
    cmp_id          BIGINT       NOT NULL,
    -- cash | card | upi | bank | customer_credit | gift_card | other
    -- Aicountly Pay is a FUTURE product; no integrated gateway exists yet and
    -- nothing here pretends otherwise.
    payment_mode    TEXT         NOT NULL,
    amount          NUMERIC(18,4) NOT NULL DEFAULT 0,
    tendered        NUMERIC(18,4),
    change_given    NUMERIC(18,4) NOT NULL DEFAULT 0,
    -- A UPI reference or the last four of a card, typed by the cashier from the
    -- external terminal's slip. NEVER a card number, and never a PAN.
    reference       TEXT,
    -- Books' account the money landed in. A reference.
    books_account_id BIGINT,
    created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- --------------------------------------------------------------------------
-- Approvals and the fraud trail
--
-- Every high-risk thing a cashier can do, who approved it, and why.
-- --------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS pos_approval_events (
    approval_id     BIGSERIAL PRIMARY KEY,
    cmp_id          BIGINT       NOT NULL,
    terminal_id     BIGINT       REFERENCES pos_terminals(terminal_id) ON DELETE SET NULL,
    session_id      BIGINT       REFERENCES pos_register_sessions(session_id) ON DELETE SET NULL,
    cart_id         BIGINT       REFERENCES pos_carts(cart_id) ON DELETE SET NULL,
    -- discount | price_override | void_line | void_cart | return | refund
    -- | no_sale | negative_stock | kot_cancel | reprint | shift_variance
    event_kind      TEXT         NOT NULL,
    requested_by    TEXT         NOT NULL,
    approved_by     TEXT,
    reason          TEXT,
    detail          JSONB        NOT NULL DEFAULT '{}'::jsonb,
    created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_pos_approvals ON pos_approval_events (cmp_id, event_kind, created_at DESC);
