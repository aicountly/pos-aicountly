-- ---------------------------------------------------------------------------
-- Aicountly POS — restaurant: floors, tables, KOT and the kitchen display
--
-- A restaurant order is NOT an invoice, and that distinction is the whole
-- design. The table order carries the waiter, the seat, the modifiers, the
-- preparation times and the KOT routing — operational facts that exist for
-- hours before anybody asks for the bill and that no accounting system wants.
--
-- When the guest finally pays, ONE sale goes to Books. The KOT history stays
-- here because it is ours; it is never used as a sales ledger.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS pos_floors (
    floor_id        BIGSERIAL PRIMARY KEY,
    cmp_id          BIGINT       NOT NULL,
    location_id     BIGINT       NOT NULL REFERENCES pos_location_profiles(location_id) ON DELETE CASCADE,
    floor_code      TEXT         NOT NULL,
    floor_name      TEXT         NOT NULL,
    sort_order      INT          NOT NULL DEFAULT 0,
    is_active       BOOLEAN      NOT NULL DEFAULT TRUE,
    UNIQUE (cmp_id, location_id, floor_code)
);

CREATE TABLE IF NOT EXISTS pos_tables (
    table_id        BIGSERIAL PRIMARY KEY,
    cmp_id          BIGINT       NOT NULL,
    floor_id        BIGINT       NOT NULL REFERENCES pos_floors(floor_id) ON DELETE CASCADE,
    table_code      TEXT         NOT NULL,
    table_name      TEXT,
    seats           INT          NOT NULL DEFAULT 2,
    -- Where it sits on the floor plan, so the screen looks like the room.
    layout_x        INT,
    layout_y        INT,
    is_active       BOOLEAN      NOT NULL DEFAULT TRUE,
    UNIQUE (cmp_id, floor_id, table_code)
);

-- One party, from seating to paying. A table has many sessions over an evening.
CREATE TABLE IF NOT EXISTS pos_table_sessions (
    table_session_id BIGSERIAL PRIMARY KEY,
    session_uuid    UUID         NOT NULL DEFAULT gen_random_uuid(),
    cmp_id          BIGINT       NOT NULL,
    fy_id           BIGINT       NOT NULL,
    table_id        BIGINT       NOT NULL REFERENCES pos_tables(table_id) ON DELETE CASCADE,
    -- AVAILABLE is the table's resting state, so a session never carries it:
    -- OCCUPIED | ORDERING | KOT_SENT | FOOD_READY | BILL_REQUESTED
    -- | PAYMENT_PENDING | CLOSED | CLEANING
    status          TEXT         NOT NULL DEFAULT 'OCCUPIED',
    covers          INT          NOT NULL DEFAULT 1,
    -- The portal uuid of the waiter or captain. Not an employee record: HRMS
    -- owns those.
    waiter_uuid     TEXT,
    opened_by       TEXT         NOT NULL,
    opened_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    closed_at       TIMESTAMPTZ,
    -- Where a table was merged into another, or split out of one.
    merged_into_id  BIGINT       REFERENCES pos_table_sessions(table_session_id) ON DELETE SET NULL,
    notes           TEXT,
    created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_pos_table_sessions_open ON pos_table_sessions (cmp_id, status)
    WHERE status NOT IN ('CLOSED');
CREATE INDEX IF NOT EXISTS idx_pos_table_sessions_table ON pos_table_sessions (table_id, status);

-- --------------------------------------------------------------------------
-- Kitchen stations and the tickets routed to them
-- --------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS pos_kds_stations (
    station_id      BIGSERIAL PRIMARY KEY,
    cmp_id          BIGINT       NOT NULL,
    location_id     BIGINT       NOT NULL REFERENCES pos_location_profiles(location_id) ON DELETE CASCADE,
    station_code    TEXT         NOT NULL,
    station_name    TEXT         NOT NULL,
    -- main | bar | dessert | beverage | bakery | grill | packing | expo
    station_kind    TEXT         NOT NULL DEFAULT 'main',
    printer_name    TEXT,
    -- Minutes after which a ticket turns red on the kitchen screen.
    late_after_minutes INT       NOT NULL DEFAULT 15,
    sort_order      INT          NOT NULL DEFAULT 0,
    is_active       BOOLEAN      NOT NULL DEFAULT TRUE,
    UNIQUE (cmp_id, location_id, station_code)
);

CREATE TABLE IF NOT EXISTS pos_kots (
    kot_id          BIGSERIAL PRIMARY KEY,
    kot_uuid        UUID         NOT NULL DEFAULT gen_random_uuid(),
    cmp_id          BIGINT       NOT NULL,
    fy_id           BIGINT       NOT NULL,
    location_id     BIGINT       REFERENCES pos_location_profiles(location_id) ON DELETE SET NULL,
    cart_id         BIGINT       REFERENCES pos_carts(cart_id) ON DELETE CASCADE,
    table_session_id BIGINT      REFERENCES pos_table_sessions(table_session_id) ON DELETE SET NULL,
    station_id      BIGINT       REFERENCES pos_kds_stations(station_id) ON DELETE SET NULL,
    kot_no          TEXT         NOT NULL,
    -- new | supplementary | amendment
    kot_kind        TEXT         NOT NULL DEFAULT 'new',
    -- The KOT this one amends or supplements.
    parent_kot_id   BIGINT       REFERENCES pos_kots(kot_id) ON DELETE SET NULL,
    token_no        TEXT,
    -- NEW | ACCEPTED | PREPARING | READY | SERVED | CANCELLED
    status          TEXT         NOT NULL DEFAULT 'NEW',
    priority        TEXT         NOT NULL DEFAULT 'normal',
    waiter_uuid     TEXT,
    fired_by        TEXT         NOT NULL,
    fired_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    accepted_at     TIMESTAMPTZ,
    ready_at        TIMESTAMPTZ,
    served_at       TIMESTAMPTZ,
    cancelled_at    TIMESTAMPTZ,
    cancel_reason   TEXT,
    cancelled_by    TEXT,
    printed_at      TIMESTAMPTZ,
    notes           TEXT,
    created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    UNIQUE (cmp_id, kot_no)
);

CREATE INDEX IF NOT EXISTS idx_pos_kots_live ON pos_kots (cmp_id, station_id, status, fired_at)
    WHERE status IN ('NEW', 'ACCEPTED', 'PREPARING', 'READY');

CREATE TABLE IF NOT EXISTS pos_kot_lines (
    kot_line_id     BIGSERIAL PRIMARY KEY,
    kot_id          BIGINT       NOT NULL REFERENCES pos_kots(kot_id) ON DELETE CASCADE,
    cart_line_id    BIGINT       REFERENCES pos_cart_lines(line_id) ON DELETE SET NULL,
    cmp_id          BIGINT       NOT NULL,
    line_no         INT          NOT NULL,
    item_id         BIGINT,
    -- What the kitchen sees. The Inventory item may be "Cappuccino"; the ticket
    -- says "Cappuccino — extra shot, no sugar" and that is the useful thing.
    display_name    TEXT         NOT NULL,
    quantity        NUMERIC(18,4) NOT NULL DEFAULT 1,
    modifiers       JSONB        NOT NULL DEFAULT '[]'::jsonb,
    instructions    TEXT,
    -- Allergy notes are shown in red and never truncated.
    allergy_note    TEXT,
    -- NEW | PREPARING | READY | SERVED | CANCELLED
    status          TEXT         NOT NULL DEFAULT 'NEW',
    ready_at        TIMESTAMPTZ,
    cancelled_at    TIMESTAMPTZ,
    cancel_reason   TEXT,
    created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    UNIQUE (kot_id, line_no)
);

-- Every state change on a ticket, for the kitchen performance report and for
-- the argument about how long table six actually waited.
CREATE TABLE IF NOT EXISTS pos_kds_events (
    event_id        BIGSERIAL PRIMARY KEY,
    cmp_id          BIGINT       NOT NULL,
    kot_id          BIGINT       REFERENCES pos_kots(kot_id) ON DELETE CASCADE,
    kot_line_id     BIGINT       REFERENCES pos_kot_lines(kot_line_id) ON DELETE CASCADE,
    station_id      BIGINT       REFERENCES pos_kds_stations(station_id) ON DELETE SET NULL,
    -- fired | accepted | preparing | ready | bumped | recalled | served | cancelled
    event_kind      TEXT         NOT NULL,
    actor_uuid      TEXT,
    detail          JSONB        NOT NULL DEFAULT '{}'::jsonb,
    created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_pos_kds_events ON pos_kds_events (cmp_id, kot_id, created_at);

-- --------------------------------------------------------------------------
-- Menu — PRESENTATION ONLY
--
-- NOT a second item master. A menu entry points at an Inventory item (or a BOM,
-- for something made to order) and adds what Inventory has no opinion about:
-- which category it appears under on the till, what it is called on the menu,
-- which kitchen makes it, when it is available, and whether it is sold out
-- tonight.
--
-- Price is the one judgement call. A restaurant's menu price is genuinely a POS
-- decision — the same coffee costs more on the terrace — so it lives here and
-- is marked as authoritative for this channel. Where a company prices centrally
-- instead, menu_price is left null and the rate comes from the shared source.
-- --------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS pos_menu_categories (
    category_id     BIGSERIAL PRIMARY KEY,
    cmp_id          BIGINT       NOT NULL,
    location_id     BIGINT       REFERENCES pos_location_profiles(location_id) ON DELETE CASCADE,
    category_code   TEXT         NOT NULL,
    category_name   TEXT         NOT NULL,
    parent_id       BIGINT       REFERENCES pos_menu_categories(category_id) ON DELETE SET NULL,
    colour          TEXT,
    sort_order      INT          NOT NULL DEFAULT 0,
    is_active       BOOLEAN      NOT NULL DEFAULT TRUE,
    UNIQUE (cmp_id, location_id, category_code)
);

CREATE TABLE IF NOT EXISTS pos_menu_items (
    menu_item_id    BIGSERIAL PRIMARY KEY,
    cmp_id          BIGINT       NOT NULL,
    location_id     BIGINT       REFERENCES pos_location_profiles(location_id) ON DELETE CASCADE,
    category_id     BIGINT       REFERENCES pos_menu_categories(category_id) ON DELETE SET NULL,

    -- Inventory's item. Everything about the GOODS — SKU, unit, stock, batch,
    -- valuation — is read from Inventory and is not repeated here.
    item_id         BIGINT,
    -- For something made to order, Inventory's recipe. POS never computes
    -- consumption itself; it tells Inventory what was sold.
    bom_id          BIGINT,

    -- Presentation, which is ours.
    display_name    TEXT         NOT NULL,
    short_name      TEXT,
    description     TEXT,
    image_ref       TEXT,
    sort_order      INT          NOT NULL DEFAULT 0,

    -- The price for this channel, where POS is the designated owner of it.
    -- Null means "ask the shared pricing source".
    menu_price      NUMERIC(18,4),
    tax_cat_id      BIGINT,

    -- Where it may be ordered from.
    show_dine_in    BOOLEAN      NOT NULL DEFAULT TRUE,
    show_takeaway   BOOLEAN      NOT NULL DEFAULT TRUE,
    show_delivery   BOOLEAN      NOT NULL DEFAULT TRUE,
    show_qr         BOOLEAN      NOT NULL DEFAULT TRUE,
    available_from  TIME,
    available_to    TIME,

    -- Which kitchen makes it.
    station_id      BIGINT       REFERENCES pos_kds_stations(station_id) ON DELETE SET NULL,
    prep_minutes    INT,

    -- AVAILABLE | SOLD_OUT | PAUSED. A MENU override for tonight, and not a
    -- stock figure: Inventory still owns whether there is any left, and POS
    -- respects its answer as well as this one.
    availability    TEXT         NOT NULL DEFAULT 'AVAILABLE',
    availability_note TEXT,
    availability_set_at TIMESTAMPTZ,

    is_active       BOOLEAN      NOT NULL DEFAULT TRUE,
    created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_pos_menu_items ON pos_menu_items (cmp_id, location_id, category_id, sort_order);
CREATE INDEX IF NOT EXISTS idx_pos_menu_items_item ON pos_menu_items (cmp_id, item_id);

CREATE TABLE IF NOT EXISTS pos_modifier_groups (
    group_id        BIGSERIAL PRIMARY KEY,
    cmp_id          BIGINT       NOT NULL,
    location_id     BIGINT       REFERENCES pos_location_profiles(location_id) ON DELETE CASCADE,
    group_code      TEXT         NOT NULL,
    group_name      TEXT         NOT NULL,
    min_select      INT          NOT NULL DEFAULT 0,
    max_select      INT,
    is_required     BOOLEAN      NOT NULL DEFAULT FALSE,
    sort_order      INT          NOT NULL DEFAULT 0,
    UNIQUE (cmp_id, location_id, group_code)
);

CREATE TABLE IF NOT EXISTS pos_modifier_options (
    option_id       BIGSERIAL PRIMARY KEY,
    group_id        BIGINT       NOT NULL REFERENCES pos_modifier_groups(group_id) ON DELETE CASCADE,
    cmp_id          BIGINT       NOT NULL,
    option_name     TEXT         NOT NULL,
    price_delta     NUMERIC(18,4) NOT NULL DEFAULT 0,
    -- Where a modifier consumes stock (an extra shot, extra cheese), it maps to
    -- an Inventory item or a BOM component and Inventory does the consuming.
    item_id         BIGINT,
    consume_qty     NUMERIC(18,4),
    is_default      BOOLEAN      NOT NULL DEFAULT FALSE,
    sort_order      INT          NOT NULL DEFAULT 0,
    is_active       BOOLEAN      NOT NULL DEFAULT TRUE
);

CREATE TABLE IF NOT EXISTS pos_menu_item_modifiers (
    link_id         BIGSERIAL PRIMARY KEY,
    menu_item_id    BIGINT       NOT NULL REFERENCES pos_menu_items(menu_item_id) ON DELETE CASCADE,
    group_id        BIGINT       NOT NULL REFERENCES pos_modifier_groups(group_id) ON DELETE CASCADE,
    cmp_id          BIGINT       NOT NULL,
    sort_order      INT          NOT NULL DEFAULT 0,
    UNIQUE (menu_item_id, group_id)
);

-- A combo is a commercial bundle the till sells as one thing. What it CONSUMES
-- is the components' own Inventory items and BOMs — there is no second recipe
-- engine here.
CREATE TABLE IF NOT EXISTS pos_combo_components (
    component_id    BIGSERIAL PRIMARY KEY,
    combo_menu_item_id BIGINT    NOT NULL REFERENCES pos_menu_items(menu_item_id) ON DELETE CASCADE,
    component_menu_item_id BIGINT NOT NULL REFERENCES pos_menu_items(menu_item_id) ON DELETE CASCADE,
    cmp_id          BIGINT       NOT NULL,
    quantity        NUMERIC(18,4) NOT NULL DEFAULT 1,
    is_swappable    BOOLEAN      NOT NULL DEFAULT FALSE,
    sort_order      INT          NOT NULL DEFAULT 0
);
