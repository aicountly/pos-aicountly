-- ---------------------------------------------------------------------------
-- Aicountly POS — offline queue, returns, external orders, integration, audit
-- ---------------------------------------------------------------------------

-- --------------------------------------------------------------------------
-- The offline queue's SERVER SIDE
--
-- The queue itself lives on the device, in encrypted IndexedDB. What this table
-- holds is the record of a transaction that ARRIVED from a device — its uuid,
-- when the device made it, when we received it, and how posting went.
--
-- That is deliberately the only server-side offline structure. The cached item
-- list, the cached prices and the queued carts stay in the browser, are
-- versioned, are treated as stale and are safe to throw away. A POS server
-- database that held them would be a replica of Inventory, which is precisely
-- what this architecture refuses to build.
-- --------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS pos_offline_submissions (
    submission_id   BIGSERIAL PRIMARY KEY,
    cmp_id          BIGINT       NOT NULL,
    fy_id           BIGINT       NOT NULL,
    bo_id           BIGINT       NOT NULL DEFAULT 0,
    terminal_id     BIGINT       REFERENCES pos_terminals(terminal_id) ON DELETE SET NULL,
    device_uuid     UUID         NOT NULL,
    -- The uuid the DEVICE minted when it made the sale, offline. This is the
    -- idempotency key for the whole journey: the same sale submitted twice —
    -- because the response was lost, because the browser retried, because the
    -- till was rebooted — arrives with the same uuid and is recognised.
    client_uuid     UUID         NOT NULL,
    -- LOCAL_DRAFT and QUEUED never reach the server; they are device states.
    -- RECEIVED | POSTING | POSTED | FAILED | CONFLICT_REVIEW | DISCARDED
    status          TEXT         NOT NULL DEFAULT 'RECEIVED',
    -- When the till made the sale, per the till's own clock. Kept because it is
    -- what the customer's receipt says, and it may be hours before this row.
    client_created_at TIMESTAMPTZ NOT NULL,
    received_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    posted_at       TIMESTAMPTZ,
    -- The cart this became once accepted.
    cart_id         BIGINT       REFERENCES pos_carts(cart_id) ON DELETE SET NULL,
    -- Enough to rebuild the sale. It is the till's own record of its own cart,
    -- not a copy of anything another product owns.
    payload         JSONB        NOT NULL DEFAULT '{}'::jsonb,
    -- Why it could not be posted: item deactivated, price changed, period
    -- locked, customer blocked, stock refused. A manager decides.
    conflict_kind   TEXT,
    conflict_detail TEXT,
    resolved_by     TEXT,
    resolved_at     TIMESTAMPTZ,
    resolution_note TEXT,
    attempts        INT          NOT NULL DEFAULT 0,
    last_error      TEXT,
    created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    -- The guarantee: one sale per device uuid per company, whatever happens to
    -- the network. Enforced by the database, not by hopeful code.
    UNIQUE (cmp_id, client_uuid)
);

CREATE INDEX IF NOT EXISTS idx_pos_offline_open ON pos_offline_submissions (cmp_id, status)
    WHERE status IN ('RECEIVED', 'POSTING', 'FAILED', 'CONFLICT_REVIEW');
CREATE INDEX IF NOT EXISTS idx_pos_offline_device ON pos_offline_submissions (cmp_id, device_uuid, client_created_at DESC);

-- --------------------------------------------------------------------------
-- Returns at the counter
--
-- POS owns the front-counter workflow and the approval. Inventory takes the
-- goods back and Books issues the credit; we keep both references.
-- --------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS pos_returns (
    return_id       BIGSERIAL PRIMARY KEY,
    return_uuid     UUID         NOT NULL DEFAULT gen_random_uuid(),
    cmp_id          BIGINT       NOT NULL,
    fy_id           BIGINT       NOT NULL,
    bo_id           BIGINT       NOT NULL DEFAULT 0,
    terminal_id     BIGINT       REFERENCES pos_terminals(terminal_id) ON DELETE SET NULL,
    session_id      BIGINT       REFERENCES pos_register_sessions(session_id) ON DELETE SET NULL,
    return_no       TEXT         NOT NULL,
    return_date     DATE         NOT NULL,

    -- The counter sale this came off, when it was sold on this POS. Ours, so a
    -- foreign key is honest here. It is NOT how the return is valued — the
    -- amount credited comes from the lines the cashier is looking at, and the
    -- invoice itself is Books'.
    cart_id         BIGINT       REFERENCES pos_carts(cart_id) ON DELETE SET NULL,

    -- The original sale, found through Books. A reference; its value, tax and
    -- lines are read from Books when the return is being built.
    books_invoice_id   BIGINT,
    books_invoice_uuid TEXT,
    books_invoice_no   TEXT,
    customer_account_id BIGINT,

    -- DRAFT | APPROVED | RECEIVED | SETTLED | CANCELLED
    status          TEXT         NOT NULL DEFAULT 'DRAFT',
    -- refund_cash | refund_original | credit_note | exchange | store_credit
    resolution      TEXT         NOT NULL DEFAULT 'refund_cash',
    restock         BOOLEAN      NOT NULL DEFAULT TRUE,
    reason_code     TEXT,
    reason_note     TEXT,
    refund_amount   NUMERIC(18,4) NOT NULL DEFAULT 0,

    -- Where the goods went back, and where the credit was raised.
    inventory_document_uuid TEXT,
    books_credit_note_uuid  TEXT,
    books_credit_note_id    BIGINT,
    -- An exchange becomes a new cart; this links the two halves.
    exchange_cart_id BIGINT      REFERENCES pos_carts(cart_id) ON DELETE SET NULL,

    approved_by     TEXT,
    created_by      TEXT         NOT NULL,
    created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    UNIQUE (cmp_id, return_no)
);

CREATE TABLE IF NOT EXISTS pos_return_lines (
    line_id         BIGSERIAL PRIMARY KEY,
    return_id       BIGINT       NOT NULL REFERENCES pos_returns(return_id) ON DELETE CASCADE,
    cmp_id          BIGINT       NOT NULL,
    line_no         INT          NOT NULL,
    -- The line on the original cart, where there was one.
    cart_line_id    BIGINT       REFERENCES pos_cart_lines(line_id) ON DELETE SET NULL,
    item_id         BIGINT,
    unit_id         BIGINT,
    warehouse_id    BIGINT,
    batch_id        BIGINT,
    display_name    TEXT,
    return_qty      NUMERIC(18,4) NOT NULL DEFAULT 0,
    rate            NUMERIC(18,4) NOT NULL DEFAULT 0,
    line_amount     NUMERIC(18,4) NOT NULL DEFAULT 0,
    -- good | damaged | expired | wrong_item
    condition_code  TEXT         NOT NULL DEFAULT 'good',
    created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    UNIQUE (return_id, line_no)
);

-- --------------------------------------------------------------------------
-- External ordering channels
--
-- An aggregator or a website sends an order; POS turns it into a cart. What is
-- kept is the connector, the external id and our cart — never a copy of the
-- provider's settlement ledger.
-- --------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS pos_connectors (
    connector_id    BIGSERIAL PRIMARY KEY,
    cmp_id          BIGINT       NOT NULL,
    location_id     BIGINT       REFERENCES pos_location_profiles(location_id) ON DELETE CASCADE,
    connector_code  TEXT         NOT NULL,
    connector_name  TEXT         NOT NULL,
    -- aggregator | ecommerce | marketplace | website
    connector_kind  TEXT         NOT NULL DEFAULT 'aggregator',
    -- Non-secret settings only. Credentials belong in the platform's secret
    -- store, never in an application table and never in a backup of one.
    settings        JSONB        NOT NULL DEFAULT '{}'::jsonb,
    -- Accept every order, or let the counter decide each time.
    auto_accept     BOOLEAN      NOT NULL DEFAULT FALSE,
    is_active       BOOLEAN      NOT NULL DEFAULT TRUE,
    created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    UNIQUE (cmp_id, connector_code)
);

CREATE TABLE IF NOT EXISTS pos_external_orders (
    external_order_id BIGSERIAL PRIMARY KEY,
    cmp_id          BIGINT       NOT NULL,
    connector_id    BIGINT       NOT NULL REFERENCES pos_connectors(connector_id) ON DELETE CASCADE,
    -- The provider's own id. The unique index is what stops one webhook
    -- delivered twice becoming two orders in the kitchen.
    external_ref    TEXT         NOT NULL,
    cart_id         BIGINT       REFERENCES pos_carts(cart_id) ON DELETE SET NULL,
    -- RECEIVED | ACCEPTED | REJECTED | PREPARING | READY | DISPATCHED | CANCELLED
    status          TEXT         NOT NULL DEFAULT 'RECEIVED',
    raw_payload     JSONB        NOT NULL DEFAULT '{}'::jsonb,
    received_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    accepted_at     TIMESTAMPTZ,
    last_error      TEXT,
    UNIQUE (cmp_id, connector_id, external_ref)
);

-- --------------------------------------------------------------------------
-- Integration commands — intent and outcome, never data
-- --------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS pos_integration_commands (
    command_id      BIGSERIAL PRIMARY KEY,
    cmp_id          BIGINT       NOT NULL,
    fy_id           BIGINT       NOT NULL,
    bo_id           BIGINT       NOT NULL DEFAULT 0,
    target_service  TEXT         NOT NULL,
    command_type    TEXT         NOT NULL,
    entity_type     TEXT         NOT NULL,
    entity_id       BIGINT       NOT NULL,
    -- For a sale that began offline this is derived from the DEVICE's uuid, so
    -- the key is the same whether the till posts it now or after a reboot.
    idempotency_key TEXT         NOT NULL,
    status          TEXT         NOT NULL DEFAULT 'PENDING',
    attempts        INT          NOT NULL DEFAULT 0,
    request_summary JSONB        NOT NULL DEFAULT '{}'::jsonb,
    external_reference JSONB,
    last_error      TEXT,
    last_attempt_at TIMESTAMPTZ,
    completed_at    TIMESTAMPTZ,
    created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    UNIQUE (cmp_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_pos_commands_entity ON pos_integration_commands (cmp_id, entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_pos_commands_open   ON pos_integration_commands (cmp_id, status)
    WHERE status IN ('PENDING', 'POSTING', 'FAILED', 'BLOCKED');

-- --------------------------------------------------------------------------
-- Audit — ours only, append-only and enforced
-- --------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS pos_audit_log (
    audit_id        BIGSERIAL PRIMARY KEY,
    cmp_id          BIGINT       NOT NULL,
    fy_id           BIGINT       NOT NULL,
    bo_id           BIGINT       NOT NULL DEFAULT 0,
    actor_uuid      TEXT         NOT NULL,
    actor_kind      TEXT         NOT NULL,
    source_app      TEXT         NOT NULL,
    action          TEXT         NOT NULL,
    entity_type     TEXT         NOT NULL,
    entity_id       TEXT,
    before_state    JSONB,
    after_state     JSONB,
    reason          TEXT,
    ip_address      TEXT,
    created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_pos_audit_entity ON pos_audit_log (cmp_id, entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_pos_audit_time   ON pos_audit_log (cmp_id, created_at DESC);

CREATE OR REPLACE FUNCTION pos_audit_immutable() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'pos_audit_log is append-only (attempted %)', TG_OP;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_pos_audit_no_update ON pos_audit_log;
CREATE TRIGGER trg_pos_audit_no_update
    BEFORE UPDATE ON pos_audit_log
    FOR EACH ROW EXECUTE FUNCTION pos_audit_immutable();

DROP TRIGGER IF EXISTS trg_pos_audit_no_delete ON pos_audit_log;
CREATE TRIGGER trg_pos_audit_no_delete
    BEFORE DELETE ON pos_audit_log
    FOR EACH ROW EXECUTE FUNCTION pos_audit_immutable();

-- --------------------------------------------------------------------------
-- Settings
-- --------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS pos_settings (
    cmp_id              BIGINT       PRIMARY KEY,
    return_prefix       TEXT         NOT NULL DEFAULT 'POSRET',
    kot_prefix          TEXT         NOT NULL DEFAULT 'KOT',
    -- Above this a discount needs a manager. Below it the cashier may give it.
    cashier_discount_limit_pc NUMERIC(6,3) NOT NULL DEFAULT 5,
    require_reason_on_void BOOLEAN   NOT NULL DEFAULT TRUE,
    require_reason_on_return BOOLEAN NOT NULL DEFAULT TRUE,
    -- How long a till may keep selling with no connection before it refuses.
    -- 0 means no limit, which is what a shop with bad broadband needs.
    offline_grace_minutes INT        NOT NULL DEFAULT 0,
    -- How stale a cached price may be before the till warns the cashier.
    cache_warn_after_minutes INT     NOT NULL DEFAULT 120,
    updated_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);
