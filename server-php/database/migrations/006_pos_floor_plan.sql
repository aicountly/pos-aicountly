-- ---------------------------------------------------------------------------
-- Aicountly POS — the floor plan as the floor actually looks
--
-- 002 gave a table a code, a number of seats and a pair of coordinates. That is
-- enough to list tables; it is not enough to draw the room. A waiter reads the
-- floor screen the way they read the floor: by zone, by shape, and by which
-- tables are not available to seat right now — being wiped down, out of service,
-- or held for a booking that arrives at eight.
--
-- Everything added here is POS' own operational configuration. No master data
-- is copied: a reservation points at a Books account by id when the guest has
-- one, and carries a typed-in name and mobile when they do not, exactly as a
-- walk-in cart already does.
-- ---------------------------------------------------------------------------

-- --------------------------------------------------------------------------
-- Floors gain the things the floor card shows
-- --------------------------------------------------------------------------

ALTER TABLE pos_floors ADD COLUMN IF NOT EXISTS description TEXT;

-- indoor | outdoor | rooftop | private_dining | banquet | other. Presentation
-- only: it picks the icon and tint on the floor card and changes no rule.
ALTER TABLE pos_floors ADD COLUMN IF NOT EXISTS floor_kind TEXT NOT NULL DEFAULT 'indoor';

-- A floor that is shut for the evening. Distinct from is_active, which means
-- the floor no longer exists as far as the shop is concerned.
ALTER TABLE pos_floors ADD COLUMN IF NOT EXISTS is_open BOOLEAN NOT NULL DEFAULT TRUE;

-- --------------------------------------------------------------------------
-- Tables gain a place in the room and a reason to be unavailable
-- --------------------------------------------------------------------------

-- The zone is a label on the table rather than a row in a zones table, because
-- a zone has no life of its own: it is created by naming it on a table and
-- disappears when the last table stops using it. A shop that invents "Terrace"
-- on a Tuesday should not need a migration.
ALTER TABLE pos_tables ADD COLUMN IF NOT EXISTS zone_name TEXT;

-- square | rectangle | round
ALTER TABLE pos_tables ADD COLUMN IF NOT EXISTS shape TEXT NOT NULL DEFAULT 'square';

-- Size on the plan, in the same hundredths-of-the-room units as layout_x/y.
ALTER TABLE pos_tables ADD COLUMN IF NOT EXISTS layout_w INT;
ALTER TABLE pos_tables ADD COLUMN IF NOT EXISTS layout_h INT;

ALTER TABLE pos_tables ADD COLUMN IF NOT EXISTS min_covers INT;
ALTER TABLE pos_tables ADD COLUMN IF NOT EXISTS max_covers INT;

-- Why a table with no party at it still cannot be seated.
--   READY          | nothing in the way
--   CLEANING       | being turned around
--   OUT_OF_SERVICE | broken, or the corner is being redecorated
-- A table's status on the screen is this AND its session AND its bookings; none
-- of the three is derivable from the others, so all three are read together.
ALTER TABLE pos_tables ADD COLUMN IF NOT EXISTS service_state TEXT NOT NULL DEFAULT 'READY';
ALTER TABLE pos_tables ADD COLUMN IF NOT EXISTS service_note TEXT;
ALTER TABLE pos_tables ADD COLUMN IF NOT EXISTS service_state_by TEXT;
ALTER TABLE pos_tables ADD COLUMN IF NOT EXISTS service_state_at TIMESTAMPTZ;

-- --------------------------------------------------------------------------
-- The waiter's name at the moment of seating
-- --------------------------------------------------------------------------
--
-- waiter_uuid is the portal identity and stays the authority. This is the label
-- captured when the table was seated, so the floor screen can say "Ramesh"
-- hours later without POS keeping a copy of the staff directory — the same
-- trade pos_carts.customer_name already makes for a walk-in.
ALTER TABLE pos_table_sessions ADD COLUMN IF NOT EXISTS waiter_name TEXT;

-- --------------------------------------------------------------------------
-- Bookings
-- --------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS pos_table_reservations (
    reservation_id   BIGSERIAL PRIMARY KEY,
    reservation_uuid UUID        NOT NULL DEFAULT gen_random_uuid(),
    cmp_id           BIGINT      NOT NULL,
    fy_id            BIGINT      NOT NULL,
    table_id         BIGINT      NOT NULL REFERENCES pos_tables(table_id) ON DELETE CASCADE,
    reservation_no   TEXT        NOT NULL,
    -- The guest, when they are somebody Books already knows. A reference, not a
    -- copy: the name and mobile below are what was typed on the phone, which is
    -- often neither the account name nor the account's number.
    customer_account_id BIGINT,
    guest_name       TEXT,
    guest_mobile     TEXT,
    party_size       INT         NOT NULL DEFAULT 2,
    reserved_for     TIMESTAMPTZ NOT NULL,
    -- How long the table is held past the booking before it is offered again.
    hold_minutes     INT         NOT NULL DEFAULT 20,
    -- BOOKED | SEATED | CANCELLED | NO_SHOW
    status           TEXT        NOT NULL DEFAULT 'BOOKED',
    notes            TEXT,
    seated_session_id BIGINT     REFERENCES pos_table_sessions(table_session_id) ON DELETE SET NULL,
    seated_at        TIMESTAMPTZ,
    cancelled_at     TIMESTAMPTZ,
    cancelled_by     TEXT,
    cancel_reason    TEXT,
    created_by       TEXT        NOT NULL,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (cmp_id, reservation_no)
);

-- The floor screen asks one question of this table, every few seconds, for
-- every table on the floor: what is the next booking that still stands.
CREATE INDEX IF NOT EXISTS idx_pos_reservations_upcoming
    ON pos_table_reservations (cmp_id, table_id, reserved_for)
    WHERE status = 'BOOKED';
