<?php

declare(strict_types=1);

namespace Aicountly\Api\Domain;

use Aicountly\Api\Audit;
use Aicountly\Api\Auth;
use Aicountly\Api\Context;
use Aicountly\Api\Db;
use Aicountly\Api\Http;
use Aicountly\Api\Permissions;

/**
 * Floors, tables and who is sitting at them.
 *
 * Entirely POS' own: no other product has an opinion about table 12. What this
 * does have to be careful about is the JOIN between a table session and the
 * cart that will become the bill — a table whose cart has gone through must
 * free up, and a table that still owes money must not.
 */
final class TableService
{
    /**
     * How far ahead a booking starts holding its table on the screen.
     *
     * Two hours, because a table booked for eight is not usefully "reserved" at
     * noon — it is free, and a floor that says otherwise loses covers.
     */
    private const RESERVATION_LEAD_MINUTES = 120;

    /** How close two bookings on one table may be before they are the same slot. */
    private const RESERVATION_SLOT_MINUTES = 45;

    private const SERVICE_STATES = ['READY', 'CLEANING', 'OUT_OF_SERVICE'];

    /** The shapes a table may be drawn as. */
    private const SHAPES = ['square', 'rectangle', 'round'];

    public function __construct(
        private readonly Context $ctx,
        private readonly Auth $auth,
    ) {
    }

    /**
     * The floor plan, with live status per table.
     *
     * One query, not one per table: a busy restaurant refreshes this screen
     * every few seconds and N+1 would make the floor plan the slowest page in
     * the product.
     *
     * Three separate facts decide what a table looks like, and none of them can
     * be worked out from the others, so all three are read here and resolved in
     * one place rather than in every caller:
     *
     *   the session   somebody is sitting there
     *   the service   it is being cleaned, or it is broken
     *   the booking   it is being held for a party due shortly
     *
     * The precedence is deliberate. A party already seated outranks a booking,
     * because the guests are in the room; out of service outranks cleaning,
     * because the more serious reason is the one to show.
     */
    public function floorPlan(?int $locationId = null): array
    {
        $params = ['cmp' => $this->ctx->cmpId, 'lead' => self::RESERVATION_LEAD_MINUTES];
        $where = 'f.cmp_id = :cmp AND f.is_active = TRUE';
        if ($locationId !== null) {
            $where .= ' AND f.location_id = :loc';
            $params['loc'] = $locationId;
        }

        $rows = Db::all(
            "SELECT f.floor_id, f.floor_code, f.floor_name, f.description AS floor_description,
                    f.floor_kind, f.is_open AS floor_is_open, f.location_id, f.sort_order AS floor_sort,
                    t.table_id, t.table_code, t.table_name, t.seats, t.layout_x, t.layout_y,
                    t.layout_w, t.layout_h, t.zone_name, t.shape, t.min_covers, t.max_covers,
                    t.service_state, t.service_note, t.service_state_by, t.service_state_at,
                    s.table_session_id, s.status AS session_status, s.covers, s.waiter_uuid,
                    s.waiter_name, s.opened_at, s.merged_into_id,
                    bill.cart_id, bill.total_amount, bill.bill_count,
                    (SELECT COUNT(*) FROM pos_cart_lines cl
                       JOIN pos_carts cc ON cc.cart_id = cl.cart_id
                      WHERE cc.table_session_id = s.table_session_id
                        AND cc.status IN ('OPEN', 'HELD')) AS line_count,
                    (SELECT COUNT(*) FROM pos_kots k
                      WHERE k.table_session_id = s.table_session_id
                        AND k.status NOT IN ('SERVED', 'CANCELLED')) AS open_kots,
                    r.reservation_id, r.reservation_no, r.guest_name, r.guest_mobile,
                    r.party_size, r.reserved_for, r.hold_minutes, r.notes AS reservation_notes,
                    r.customer_account_id,
                    (r.reserved_for <= NOW() + (INTERVAL '1 minute' * :lead)) AS reservation_due
             FROM pos_floors f
             JOIN pos_tables t ON t.floor_id = f.floor_id AND t.is_active = TRUE
             LEFT JOIN pos_table_sessions s
                    ON s.table_id = t.table_id AND s.status = 'OCCUPIED' AND s.cmp_id = f.cmp_id
             -- Aggregated, not joined: a split table has two open bills, and a
             -- join would put the table on the plan twice.
             LEFT JOIN LATERAL (
                 SELECT MIN(cc.cart_id) AS cart_id,
                        SUM(cc.total_amount) AS total_amount,
                        COUNT(*) AS bill_count
                 FROM pos_carts cc
                 WHERE cc.table_session_id = s.table_session_id AND cc.status IN ('OPEN', 'HELD')
             ) bill ON TRUE
             -- The next booking that still stands. One per table: the screen
             -- shows what is coming, not the whole diary.
             LEFT JOIN LATERAL (
                 SELECT rr.* FROM pos_table_reservations rr
                 WHERE rr.table_id = t.table_id AND rr.cmp_id = f.cmp_id AND rr.status = 'BOOKED'
                   AND rr.reserved_for >= NOW() - (INTERVAL '1 minute' * rr.hold_minutes)
                 ORDER BY rr.reserved_for
                 LIMIT 1
             ) r ON TRUE
             WHERE {$where}
             ORDER BY f.sort_order, f.floor_id, t.table_code",
            $params,
        );

        $floors = [];
        foreach ($rows as $row) {
            $floorId = (int) $row['floor_id'];
            $floors[$floorId] ??= [
                'floor_id'    => $floorId,
                'floor_code'  => $row['floor_code'],
                'floor_name'  => $row['floor_name'],
                'description' => $row['floor_description'],
                'floor_kind'  => (string) ($row['floor_kind'] ?? 'indoor'),
                'is_open'     => self::bool($row['floor_is_open']),
                'location_id' => $row['location_id'] === null ? null : (int) $row['location_id'],
                'sort_order'  => (int) ($row['floor_sort'] ?? 0),
                'tables'      => [],
            ];

            $occupied = $row['table_session_id'] !== null;
            $service  = (string) ($row['service_state'] ?? 'READY');
            $booking  = $row['reservation_id'] === null ? null : [
                'reservation_id'      => (int) $row['reservation_id'],
                'reservation_no'      => $row['reservation_no'],
                'guest_name'          => $row['guest_name'],
                'guest_mobile'        => $row['guest_mobile'],
                'customer_account_id' => $row['customer_account_id'] === null ? null : (int) $row['customer_account_id'],
                'party_size'          => (int) $row['party_size'],
                'reserved_for'        => $row['reserved_for'],
                'hold_minutes'        => (int) $row['hold_minutes'],
                'notes'               => $row['reservation_notes'],
                'is_due'              => self::bool($row['reservation_due']),
            ];

            $floors[$floorId]['tables'][] = [
                'table_id'         => (int) $row['table_id'],
                'table_code'       => $row['table_code'],
                'table_name'       => $row['table_name'],
                'seats'            => (int) $row['seats'],
                'min_covers'       => $row['min_covers'] === null ? null : (int) $row['min_covers'],
                'max_covers'       => $row['max_covers'] === null ? null : (int) $row['max_covers'],
                'zone_name'        => $row['zone_name'],
                'shape'            => (string) ($row['shape'] ?? 'square'),
                'layout_x'         => $row['layout_x'] === null ? null : (int) $row['layout_x'],
                'layout_y'         => $row['layout_y'] === null ? null : (int) $row['layout_y'],
                'layout_w'         => $row['layout_w'] === null ? null : (int) $row['layout_w'],
                'layout_h'         => $row['layout_h'] === null ? null : (int) $row['layout_h'],
                'table_session_id' => $occupied ? (int) $row['table_session_id'] : null,
                'status'           => self::tableStatus($occupied, $service, $booking),
                'service_state'    => $service,
                'service_note'     => $row['service_note'],
                'service_state_by' => $row['service_state_by'],
                'service_state_at' => $row['service_state_at'],
                'covers'           => $row['covers'] === null ? null : (int) $row['covers'],
                'waiter_uuid'      => $row['waiter_uuid'],
                'waiter_name'      => $row['waiter_name'],
                'opened_at'        => $row['opened_at'],
                'cart_id'          => $row['cart_id'] === null ? null : (int) $row['cart_id'],
                'running_total'    => $row['total_amount'] === null ? null : (float) $row['total_amount'],
                'bill_count'       => (int) ($row['bill_count'] ?? 0),
                'line_count'       => (int) ($row['line_count'] ?? 0),
                'open_kots'        => (int) $row['open_kots'],
                'reservation'      => $booking,
            ];
        }

        return array_values($floors);
    }

    /**
     * What the floor screen paints this table as.
     *
     * FREE and OCCUPIED are unchanged from the original contract; the three
     * others are new states that used to have nowhere to live.
     *
     * @param array<string, mixed>|null $booking
     */
    private static function tableStatus(bool $occupied, string $service, ?array $booking): string
    {
        if ($occupied) {
            return 'OCCUPIED';
        }
        if ($service === 'OUT_OF_SERVICE') {
            return 'OUT_OF_SERVICE';
        }
        if ($service === 'CLEANING') {
            return 'CLEANING';
        }
        if ($booking !== null && $booking['is_due'] === true) {
            return 'RESERVED';
        }

        return 'FREE';
    }

    /**
     * Seat a table.
     *
     * A table with a session already open is not seated again — that is how two
     * waiters end up with two bills for one table, and the second party leaves
     * without paying for half of it.
     *
     * @param array<string, mixed> $input
     */
    public function open(int $tableId, array $input): array
    {
        Permissions::assert($this->ctx, $this->auth, 'table.open');

        $table = Db::first('SELECT * FROM pos_tables WHERE table_id = :id AND cmp_id = :cmp', ['id' => $tableId, 'cmp' => $this->ctx->cmpId]);
        if ($table === null) {
            Http::notFound('That table does not exist.');
        }

        return Db::transaction(function () use ($tableId, $table, $input) {
            $open = Db::first(
                "SELECT table_session_id FROM pos_table_sessions
                 WHERE cmp_id = :cmp AND table_id = :table AND status = 'OCCUPIED' FOR UPDATE",
                ['cmp' => $this->ctx->cmpId, 'table' => $tableId],
            );
            if ($open !== null) {
                Http::conflict('That table is already occupied.', ['table_session_id' => (int) $open['table_session_id']]);
            }

            $covers = max(1, (int) ($input['covers'] ?? $table['seats'] ?? 1));

            $sessionId = (int) Db::insert('pos_table_sessions', [
                'cmp_id'      => $this->ctx->cmpId,
                'fy_id'       => $this->ctx->fyId,
                'table_id'    => $tableId,
                'status'      => 'OCCUPIED',
                'covers'      => $covers,
                'waiter_uuid' => self::text($input['waiter_uuid'] ?? null) ?? $this->auth->uuid,
                // The label, captured now. POS keeps no staff directory, so a
                // name resolved later would be a name POS had to store a copy
                // of; a name recorded at the moment of the event is a fact
                // about the event, which is the same trade a walk-in's name on
                // a cart already makes. Only defaulted when the person seating
                // the table IS the waiter.
                'waiter_name' => self::text($input['waiter_name'] ?? null)
                    ?? (self::text($input['waiter_uuid'] ?? null) === null ? $this->auth->displayName() : null),
                'opened_by'   => $this->auth->uuid,
                'notes'       => self::text($input['notes'] ?? null),
            ], 'table_session_id');

            // The cart is opened with the table, not at first order: a waiter
            // who takes a drink order before the food needs somewhere to put it.
            $cart = (new CartService($this->ctx, $this->auth))->open([
                'terminal_id'      => self::id($input['terminal_id'] ?? null),
                'order_kind'       => 'dine_in',
                'table_session_id' => $sessionId,
                'customer_name'    => self::text($input['customer_name'] ?? null),
                'customer_mobile'  => self::text($input['customer_mobile'] ?? null),
            ]);

            Audit::record($this->ctx, $this->auth, 'table.opened', 'table_session', $sessionId, null, [
                'table_id' => $tableId, 'covers' => $covers, 'cart_id' => $cart['cart_id'],
            ]);

            return $this->find($sessionId);
        });
    }

    /**
     * Move a party to another table, or hand it to another waiter.
     *
     * @param array<string, mixed> $input
     */
    public function transfer(int $sessionId, array $input): array
    {
        Permissions::assert($this->ctx, $this->auth, 'table.transfer');

        $session = $this->find($sessionId);
        if ($session === []) {
            Http::notFound('That table session does not exist.');
        }
        if ($session['status'] !== 'OCCUPIED') {
            Http::conflict('That table has already been cleared.');
        }

        $toTableId   = self::id($input['table_id'] ?? null);
        $toWaiter    = self::text($input['waiter_uuid'] ?? null);
        $toWaiterName = $input['waiter_name'] ?? null;

        if ($toTableId === null && $toWaiter === null) {
            Http::validationFailed('Say which table it is moving to, or who is taking it over.');
        }

        return Db::transaction(function () use ($sessionId, $session, $toTableId, $toWaiter, $toWaiterName) {
            $values = ['updated_at' => self::now()];

            if ($toTableId !== null) {
                $busy = Db::first(
                    "SELECT table_session_id FROM pos_table_sessions
                     WHERE cmp_id = :cmp AND table_id = :table AND status = 'OCCUPIED' FOR UPDATE",
                    ['cmp' => $this->ctx->cmpId, 'table' => $toTableId],
                );
                if ($busy !== null && (int) $busy['table_session_id'] !== $sessionId) {
                    Http::conflict('That table is occupied. Merge the tables instead of moving onto one.');
                }
                $values['table_id'] = $toTableId;
            }
            if ($toWaiter !== null) {
                $values['waiter_uuid'] = $toWaiter;
                $values['waiter_name'] = self::text($toWaiterName);
            }

            Db::update('pos_table_sessions', $values, ['table_session_id' => $sessionId, 'cmp_id' => $this->ctx->cmpId]);

            Audit::record($this->ctx, $this->auth, 'table.transferred', 'table_session', $sessionId,
                ['table_id' => $session['table_id'], 'waiter_uuid' => $session['waiter_uuid']],
                ['table_id' => $toTableId ?? $session['table_id'], 'waiter_uuid' => $toWaiter ?? $session['waiter_uuid']],
            );

            return $this->find($sessionId);
        });
    }

    /**
     * Merge one table's party into another's — two tables, one bill.
     *
     * The lines move onto the target cart rather than being copied, so there is
     * exactly one bill afterwards and no chance of charging both.
     *
     * @param array<string, mixed> $input
     */
    public function merge(int $sessionId, array $input): array
    {
        Permissions::assert($this->ctx, $this->auth, 'table.merge');

        $intoId = self::id($input['into_table_session_id'] ?? null);
        if ($intoId === null) {
            Http::validationFailed('Which table is the bill going onto?', ['field' => 'into_table_session_id']);
        }
        if ($intoId === $sessionId) {
            Http::validationFailed('A table cannot be merged into itself.');
        }

        $from = $this->find($sessionId);
        $into = $this->find($intoId);
        if ($from === [] || $into === []) {
            Http::notFound('One of those tables does not exist.');
        }
        if ($from['status'] !== 'OCCUPIED' || $into['status'] !== 'OCCUPIED') {
            Http::conflict('Both tables have to be occupied to merge them.');
        }

        return Db::transaction(function () use ($sessionId, $intoId, $from, $into) {
            $fromCart = $this->openCartFor($sessionId);
            $intoCart = $this->openCartFor($intoId);

            if ($fromCart !== null && $intoCart !== null) {
                // The lock is on the CART, not on an aggregate over its lines:
                // PostgreSQL refuses FOR UPDATE with an aggregate, and the cart row
                // is the right thing to lock anyway — line numbers are unique per
                // cart, so holding that row is what makes the next number exclusive.
                Db::run('SELECT cart_id FROM pos_carts WHERE cart_id = :cart FOR UPDATE', ['cart' => $intoCart]);
                $nextLineNo = 1 + (int) Db::scalar(
                    'SELECT COALESCE(MAX(line_no), 0) FROM pos_cart_lines WHERE cart_id = :cart',
                    ['cart' => $intoCart],
                );

                foreach (Db::all('SELECT line_id FROM pos_cart_lines WHERE cart_id = :cart ORDER BY line_no', ['cart' => $fromCart]) as $line) {
                    Db::update('pos_cart_lines', [
                        'cart_id'    => $intoCart,
                        'line_no'    => $nextLineNo++,
                        'updated_at' => self::now(),
                    ], ['line_id' => (int) $line['line_id']]);
                }

                // Tickets follow their lines, so the kitchen screen keeps
                // showing them against the table that will actually be served.
                Db::run(
                    'UPDATE pos_kots SET cart_id = :into_cart, table_session_id = :into, updated_at = :now
                     WHERE cart_id = :from_cart AND cmp_id = :cmp',
                    ['into_cart' => $intoCart, 'into' => $intoId, 'now' => self::now(), 'from_cart' => $fromCart, 'cmp' => $this->ctx->cmpId],
                );

                Db::update('pos_carts', [
                    'status'      => 'VOID',
                    'voided_by'   => $this->auth->uuid,
                    'void_reason' => 'Merged into table session ' . $intoId,
                    'updated_at'  => self::now(),
                ], ['cart_id' => $fromCart, 'cmp_id' => $this->ctx->cmpId]);

                (new CartService($this->ctx, $this->auth))->recalculate($intoCart);
            }

            Db::update('pos_table_sessions', [
                'status'         => 'MERGED',
                'merged_into_id' => $intoId,
                'closed_at'      => self::now(),
                'updated_at'     => self::now(),
            ], ['table_session_id' => $sessionId, 'cmp_id' => $this->ctx->cmpId]);

            Db::update('pos_table_sessions', [
                'covers'     => (int) $into['covers'] + (int) $from['covers'],
                'updated_at' => self::now(),
            ], ['table_session_id' => $intoId, 'cmp_id' => $this->ctx->cmpId]);

            Audit::record($this->ctx, $this->auth, 'table.merged', 'table_session', $sessionId, null, ['into' => $intoId]);

            return $this->find($intoId);
        });
    }

    /**
     * Split a table — move chosen lines onto a new cart on the same table.
     *
     * Used when one of the party pays separately. The new cart is a sibling of
     * the original, both against the same table session, and both must be
     * settled before the table frees.
     *
     * @param array<string, mixed> $input
     */
    public function split(int $sessionId, array $input): array
    {
        Permissions::assert($this->ctx, $this->auth, 'table.merge');

        $lineIds = array_values(array_filter(array_map(
            static fn ($id) => is_numeric($id) ? (int) $id : null,
            (array) ($input['line_ids'] ?? []),
        )));
        if ($lineIds === []) {
            Http::validationFailed('Choose the lines going onto the separate bill.', ['field' => 'line_ids']);
        }

        $session = $this->find($sessionId);
        if ($session === [] || $session['status'] !== 'OCCUPIED') {
            Http::conflict('That table is not occupied.');
        }

        $sourceCart = $this->openCartFor($sessionId);
        if ($sourceCart === null) {
            Http::conflict('That table has no open bill to split.');
        }

        return Db::transaction(function () use ($sessionId, $sourceCart, $lineIds, $input) {
            $placeholders = implode(',', array_map(static fn (int $i) => ':l' . $i, array_keys($lineIds)));
            $params = ['cart' => $sourceCart];
            foreach ($lineIds as $i => $id) {
                $params['l' . $i] = $id;
            }

            $lines = Db::all(
                'SELECT * FROM pos_cart_lines WHERE cart_id = :cart AND line_id IN (' . $placeholders . ') ORDER BY line_no',
                $params,
            );
            if (count($lines) !== count($lineIds)) {
                Http::validationFailed('Some of those lines are not on this bill.');
            }

            $source = Db::first('SELECT * FROM pos_carts WHERE cart_id = :id', ['id' => $sourceCart]) ?? [];

            $newCartId = (int) Db::insert('pos_carts', [
                'cmp_id'           => $this->ctx->cmpId,
                'fy_id'            => $this->ctx->fyId,
                'bo_id'            => $this->ctx->boId,
                'terminal_id'      => $source['terminal_id'] ?? null,
                'session_id'       => $source['session_id'] ?? null,
                'status'           => 'OPEN',
                'order_kind'       => 'dine_in',
                'table_session_id' => $sessionId,
                'customer_name'    => self::text($input['customer_name'] ?? null),
                'opened_by'        => $this->auth->uuid,
            ], 'cart_id');

            $lineNo = 0;
            foreach ($lines as $line) {
                Db::update('pos_cart_lines', [
                    'cart_id'    => $newCartId,
                    'line_no'    => ++$lineNo,
                    'updated_at' => self::now(),
                ], ['line_id' => (int) $line['line_id']]);
            }

            $carts = new CartService($this->ctx, $this->auth);
            $carts->recalculate($sourceCart);
            $carts->recalculate($newCartId);

            Audit::record($this->ctx, $this->auth, 'table.split', 'table_session', $sessionId, null, [
                'from_cart' => $sourceCart, 'to_cart' => $newCartId, 'lines' => count($lines),
            ]);

            return ['table_session_id' => $sessionId, 'new_cart_id' => $newCartId, 'lines_moved' => count($lines)];
        });
    }

    /**
     * Clear the table.
     *
     * Refuses while any bill against it is unpaid. This is the check that stops
     * a table being reseated over an unsettled bill, which is the most
     * expensive mistake a busy floor makes.
     */
    public function close(int $sessionId): array
    {
        Permissions::assert($this->ctx, $this->auth, 'table.open');

        $session = $this->find($sessionId);
        if ($session === []) {
            Http::notFound('That table session does not exist.');
        }
        if ($session['status'] !== 'OCCUPIED') {
            Http::conflict('That table is already clear.');
        }

        $unpaid = Db::all(
            "SELECT cart_id, total_amount FROM pos_carts
             WHERE cmp_id = :cmp AND table_session_id = :sid AND status IN ('OPEN', 'HELD')",
            ['cmp' => $this->ctx->cmpId, 'sid' => $sessionId],
        );
        $owing = array_values(array_filter($unpaid, static fn (array $c) => (float) $c['total_amount'] > 0));

        if ($owing !== []) {
            Http::conflict(
                count($owing) === 1
                    ? 'This table still has an unpaid bill.'
                    : 'This table still has ' . count($owing) . ' unpaid bills.',
                ['cart_ids' => array_map(static fn (array $c) => (int) $c['cart_id'], $owing)],
            );
        }

        return Db::transaction(function () use ($sessionId, $unpaid) {
            // Empty carts left behind by a party that ordered nothing are tidied
            // away rather than left to clutter the till's held list.
            foreach ($unpaid as $cart) {
                Db::update('pos_carts', [
                    'status'      => 'VOID',
                    'voided_by'   => $this->auth->uuid,
                    'void_reason' => 'Table cleared with nothing ordered',
                    'updated_at'  => self::now(),
                ], ['cart_id' => (int) $cart['cart_id'], 'cmp_id' => $this->ctx->cmpId]);
            }

            Db::update('pos_table_sessions', [
                'status'     => 'CLOSED',
                'closed_at'  => self::now(),
                'updated_at' => self::now(),
            ], ['table_session_id' => $sessionId, 'cmp_id' => $this->ctx->cmpId]);

            Audit::record($this->ctx, $this->auth, 'table.closed', 'table_session', $sessionId, null, null);

            return $this->find($sessionId);
        });
    }

    // -----------------------------------------------------------------------
    // Setting the room out
    // -----------------------------------------------------------------------
    //
    // Coordinates are hundredths of a percent of the plan — 0 to 10000 on both
    // axes — so a layout is resolution-independent and a table dragged on a
    // laptop lands in the same place on the till's screen. Nothing here is
    // accounting data; it is how the shop chooses to draw itself.

    /**
     * Create a floor, optionally with its tables already laid out.
     *
     * The quick setup exists because the alternative — a shop with an empty
     * floor and eighteen tables to add one at a time before the screen shows
     * anything — is where restaurant setup is usually abandoned.
     *
     * @param array<string, mixed> $input
     */
    public function createFloor(array $input): array
    {
        Permissions::assert($this->ctx, $this->auth, 'terminal.manage');

        $name = self::text($input['floor_name'] ?? null);
        if ($name === null) {
            Http::validationFailed('Give the floor a name.', ['field' => 'floor_name']);
        }

        $locationId = self::id($input['location_id'] ?? null) ?? self::id(Db::scalar(
            'SELECT location_id FROM pos_location_profiles
             WHERE cmp_id = :cmp AND is_active = TRUE ORDER BY location_id LIMIT 1',
            ['cmp' => $this->ctx->cmpId],
        ));
        if ($locationId === null) {
            Http::validationFailed('Set an outlet up before adding floors to it.', ['field' => 'location_id']);
        }

        $tableCount = min(120, max(0, (int) ($input['table_count'] ?? 0)));
        $seats      = min(40, max(1, (int) ($input['seats'] ?? 4)));
        $zone       = self::text($input['zone_name'] ?? null);

        return Db::transaction(function () use ($input, $name, $locationId, $tableCount, $seats, $zone) {
            $floorId = (int) Db::insert('pos_floors', [
                'cmp_id'      => $this->ctx->cmpId,
                'location_id' => $locationId,
                'floor_code'  => self::text($input['floor_code'] ?? null) ?? self::codeFrom($name),
                'floor_name'  => $name,
                'description' => self::text($input['description'] ?? null),
                'floor_kind'  => self::floorKind($input['floor_kind'] ?? null),
                'sort_order'  => (int) ($input['sort_order'] ?? 0),
            ], 'floor_id');

            for ($i = 1; $i <= $tableCount; $i++) {
                [$x, $y] = self::gridSlot($i - 1);
                Db::insert('pos_tables', [
                    'cmp_id'     => $this->ctx->cmpId,
                    'floor_id'   => $floorId,
                    'table_code' => 'T' . str_pad((string) $i, 2, '0', STR_PAD_LEFT),
                    'seats'      => $seats,
                    'zone_name'  => $zone,
                    'shape'      => 'square',
                    'layout_x'   => $x,
                    'layout_y'   => $y,
                ], 'table_id');
            }

            Audit::record($this->ctx, $this->auth, 'floor.created', 'floor', $floorId, null, [
                'floor_name' => $name, 'tables' => $tableCount,
            ]);

            return $this->floor($floorId);
        });
    }

    /**
     * Rename a floor, re-describe it, or shut it for the evening.
     *
     * @param array<string, mixed> $input
     */
    public function updateFloor(int $floorId, array $input): array
    {
        Permissions::assert($this->ctx, $this->auth, 'terminal.manage');

        $before = $this->floor($floorId);
        if ($before === []) {
            Http::notFound('That floor does not exist.');
        }

        $values = [];
        foreach (['floor_name' => 'floor_name', 'floor_code' => 'floor_code', 'description' => 'description'] as $field => $column) {
            if (array_key_exists($field, $input)) {
                $values[$column] = self::text($input[$field]);
            }
        }
        if (array_key_exists('floor_name', $values) && $values['floor_name'] === null) {
            Http::validationFailed('A floor needs a name.', ['field' => 'floor_name']);
        }
        if (array_key_exists('floor_kind', $input)) {
            $values['floor_kind'] = self::floorKind($input['floor_kind']);
        }
        if (array_key_exists('is_open', $input)) {
            $values['is_open'] = (bool) $input['is_open'];
        }
        if (array_key_exists('sort_order', $input)) {
            $values['sort_order'] = (int) $input['sort_order'];
        }

        if ($values !== []) {
            Db::update('pos_floors', $values, ['floor_id' => $floorId, 'cmp_id' => $this->ctx->cmpId]);
            Audit::record($this->ctx, $this->auth, 'floor.updated', 'floor', $floorId, $before, $values);
        }

        return $this->floor($floorId);
    }

    /**
     * Retire a floor.
     *
     * Marked inactive rather than deleted: its tables carry sessions, and those
     * sessions carry bills that have already gone to Books. A DELETE here would
     * cascade through history that is somebody else's record.
     *
     * Refused while anyone is sitting on it, which is the only case where the
     * shop would notice the difference immediately.
     */
    public function deleteFloor(int $floorId): array
    {
        Permissions::assert($this->ctx, $this->auth, 'terminal.manage');

        $floor = $this->floor($floorId);
        if ($floor === []) {
            Http::notFound('That floor does not exist.');
        }

        $seated = (int) Db::scalar(
            "SELECT COUNT(*) FROM pos_table_sessions s
             JOIN pos_tables t ON t.table_id = s.table_id
             WHERE t.floor_id = :floor AND s.cmp_id = :cmp AND s.status = 'OCCUPIED'",
            ['floor' => $floorId, 'cmp' => $this->ctx->cmpId],
        );
        if ($seated > 0) {
            Http::conflict($seated === 1
                ? 'There is still a party on that floor.'
                : 'There are still ' . $seated . ' parties on that floor.');
        }

        Db::update('pos_floors', ['is_active' => false], ['floor_id' => $floorId, 'cmp_id' => $this->ctx->cmpId]);
        Audit::record($this->ctx, $this->auth, 'floor.retired', 'floor', $floorId, $floor, null);

        return ['floor_id' => $floorId, 'is_active' => false];
    }

    /**
     * Add one table.
     *
     * @param array<string, mixed> $input
     */
    public function createTable(array $input): array
    {
        Permissions::assert($this->ctx, $this->auth, 'terminal.manage');

        $floorId = self::id($input['floor_id'] ?? null);
        if ($floorId === null) {
            Http::validationFailed('Which floor is the table on?', ['field' => 'floor_id']);
        }
        if ($this->floor($floorId) === []) {
            Http::notFound('That floor does not exist.');
        }

        $code = self::text($input['table_code'] ?? null);
        if ($code === null) {
            Http::validationFailed('Give the table a number or a name.', ['field' => 'table_code']);
        }

        $taken = Db::scalar(
            'SELECT table_id FROM pos_tables WHERE cmp_id = :cmp AND floor_id = :floor AND table_code = :code',
            ['cmp' => $this->ctx->cmpId, 'floor' => $floorId, 'code' => $code],
        );
        if ($taken !== null) {
            Http::conflict('There is already a table called ' . $code . ' on this floor.');
        }

        $position = (int) Db::scalar(
            'SELECT COUNT(*) FROM pos_tables WHERE cmp_id = :cmp AND floor_id = :floor AND is_active = TRUE',
            ['cmp' => $this->ctx->cmpId, 'floor' => $floorId],
        );
        [$slotX, $slotY] = self::gridSlot($position);

        $tableId = (int) Db::insert('pos_tables', [
            'cmp_id'     => $this->ctx->cmpId,
            'floor_id'   => $floorId,
            'table_code' => $code,
            'table_name' => self::text($input['table_name'] ?? null),
            'seats'      => min(40, max(1, (int) ($input['seats'] ?? 2))),
            'min_covers' => self::covers($input['min_covers'] ?? null),
            'max_covers' => self::covers($input['max_covers'] ?? null),
            'zone_name'  => self::text($input['zone_name'] ?? null),
            'shape'      => self::shape($input['shape'] ?? null),
            'layout_x'   => self::coordinate($input['layout_x'] ?? null) ?? $slotX,
            'layout_y'   => self::coordinate($input['layout_y'] ?? null) ?? $slotY,
            'layout_w'   => self::coordinate($input['layout_w'] ?? null),
            'layout_h'   => self::coordinate($input['layout_h'] ?? null),
        ], 'table_id');

        Audit::record($this->ctx, $this->auth, 'table.created', 'table', $tableId, null, [
            'floor_id' => $floorId, 'table_code' => $code,
        ]);

        return $this->table($tableId);
    }

    /**
     * Retire a table. Inactive, not deleted, for the same reason as a floor.
     */
    public function deleteTable(int $tableId): array
    {
        Permissions::assert($this->ctx, $this->auth, 'terminal.manage');

        $seated = Db::scalar(
            "SELECT table_session_id FROM pos_table_sessions
             WHERE cmp_id = :cmp AND table_id = :table AND status = 'OCCUPIED'",
            ['cmp' => $this->ctx->cmpId, 'table' => $tableId],
        );
        if ($seated !== null) {
            Http::conflict('There is a party at that table.');
        }

        $changed = Db::update(
            'pos_tables',
            ['is_active' => false],
            ['table_id' => $tableId, 'cmp_id' => $this->ctx->cmpId],
        );
        if ($changed === 0) {
            Http::notFound('That table does not exist.');
        }

        Db::run(
            "UPDATE pos_table_reservations SET status = 'CANCELLED', cancelled_at = :now,
                    cancelled_by = :by, cancel_reason = 'Table removed', updated_at = :now
             WHERE cmp_id = :cmp AND table_id = :table AND status = 'BOOKED'",
            ['now' => self::now(), 'by' => $this->auth->uuid, 'cmp' => $this->ctx->cmpId, 'table' => $tableId],
        );

        Audit::record($this->ctx, $this->auth, 'table.retired', 'table', $tableId, null, null);

        return ['table_id' => $tableId, 'is_active' => false];
    }

    /**
     * Edit one table, from the inspector rather than the layout editor.
     *
     * @param array<string, mixed> $input
     */
    public function updateTable(int $tableId, array $input): array
    {
        Permissions::assert($this->ctx, $this->auth, 'terminal.manage');

        $before = Db::first(
            'SELECT table_id, floor_id, table_code FROM pos_tables
             WHERE table_id = :id AND cmp_id = :cmp AND is_active = TRUE',
            ['id' => $tableId, 'cmp' => $this->ctx->cmpId],
        );
        if ($before === null) {
            Http::notFound('That table does not exist.');
        }

        $values = [];
        if (array_key_exists('table_code', $input)) {
            $code = self::text($input['table_code']);
            if ($code === null) {
                Http::validationFailed('A table needs a number or a name.', ['field' => 'table_code']);
            }
            $taken = Db::scalar(
                'SELECT table_id FROM pos_tables
                 WHERE cmp_id = :cmp AND floor_id = :floor AND table_code = :code AND table_id <> :id AND is_active = TRUE',
                ['cmp' => $this->ctx->cmpId, 'floor' => (int) $before['floor_id'], 'code' => $code, 'id' => $tableId],
            );
            if ($taken !== null) {
                Http::conflict('There is already a table called ' . $code . ' on this floor.');
            }
            $values['table_code'] = $code;
        }
        if (array_key_exists('table_name', $input)) {
            $values['table_name'] = self::text($input['table_name']);
        }
        if (array_key_exists('zone_name', $input)) {
            $values['zone_name'] = self::text($input['zone_name']);
        }
        if (array_key_exists('shape', $input)) {
            $values['shape'] = self::shape($input['shape']);
        }
        if (array_key_exists('seats', $input)) {
            $values['seats'] = min(40, max(1, (int) $input['seats']));
        }
        foreach (['min_covers', 'max_covers'] as $field) {
            if (array_key_exists($field, $input)) {
                $values[$field] = self::covers($input[$field]);
            }
        }
        foreach (['layout_x', 'layout_y', 'layout_w', 'layout_h'] as $field) {
            if (array_key_exists($field, $input)) {
                $values[$field] = self::coordinate($input[$field]);
            }
        }

        if ($values !== []) {
            Db::update('pos_tables', $values, ['table_id' => $tableId, 'cmp_id' => $this->ctx->cmpId]);
            Audit::record($this->ctx, $this->auth, 'table.updated', 'table', $tableId, $before, $values);
        }

        return $this->table($tableId);
    }

    /**
     * Save a whole floor's layout in one go.
     *
     * The editor does not write while the manager drags — it writes once, here,
     * when they press Save. That is why this takes every table at once and runs
     * in a single transaction: a layout half-applied is a floor plan that no
     * longer matches the room, and the person who would notice is a waiter
     * mid-service.
     *
     * Only presentation is writable. Seats and capacity are here because they
     * are set in the same editor; status, sessions and bills are not, and a
     * payload that names them is ignored rather than obeyed.
     *
     * @param array<string, mixed> $input
     */
    public function saveLayout(int $floorId, array $input): array
    {
        Permissions::assert($this->ctx, $this->auth, 'terminal.manage');

        if ($this->floor($floorId) === []) {
            Http::notFound('That floor does not exist.');
        }

        $tables = $input['tables'] ?? null;
        if (!is_array($tables)) {
            Http::validationFailed('Send the tables to save.', ['field' => 'tables']);
        }

        $known = [];
        foreach (Db::all(
            'SELECT table_id, table_code FROM pos_tables WHERE cmp_id = :cmp AND floor_id = :floor AND is_active = TRUE',
            ['cmp' => $this->ctx->cmpId, 'floor' => $floorId],
        ) as $row) {
            $known[(int) $row['table_id']] = (string) $row['table_code'];
        }

        $removed = array_values(array_filter(array_map(
            static fn ($id) => is_numeric($id) ? (int) $id : null,
            (array) ($input['removed_table_ids'] ?? []),
        )));

        // Validate the whole room before writing any of it. Half a layout is
        // worse than none, and the database's own unique index would report the
        // clash as a constraint name rather than as "two tables called T2".
        $planned = [];
        $seen    = [];
        foreach ($tables as $raw) {
            if (!is_array($raw)) {
                continue;
            }
            $tableId = self::id($raw['table_id'] ?? null);
            if ($tableId === null || !isset($known[$tableId])) {
                Http::validationFailed('One of those tables is not on this floor.', ['table_id' => $tableId]);
            }
            if (in_array($tableId, $removed, true)) {
                continue;
            }

            $code = self::text($raw['table_code'] ?? null) ?? $known[$tableId];
            $key  = mb_strtolower($code);
            if (isset($seen[$key])) {
                Http::validationFailed('Two tables on this floor are both called ' . $code . '.', ['table_code' => $code]);
            }
            $seen[$key] = true;

            $planned[$tableId] = [
                'table_code' => $code,
                'table_name' => self::text($raw['table_name'] ?? null),
                'seats'      => min(40, max(1, (int) ($raw['seats'] ?? 2))),
                'min_covers' => self::covers($raw['min_covers'] ?? null),
                'max_covers' => self::covers($raw['max_covers'] ?? null),
                'zone_name'  => self::text($raw['zone_name'] ?? null),
                'shape'      => self::shape($raw['shape'] ?? null),
                'layout_x'   => self::coordinate($raw['layout_x'] ?? null),
                'layout_y'   => self::coordinate($raw['layout_y'] ?? null),
                'layout_w'   => self::coordinate($raw['layout_w'] ?? null),
                'layout_h'   => self::coordinate($raw['layout_h'] ?? null),
            ];
        }

        // A table kept on the floor but left out of the payload still holds its
        // name, so a rename onto that name is a clash too.
        foreach ($known as $tableId => $code) {
            if (!isset($planned[$tableId]) && !in_array($tableId, $removed, true) && isset($seen[mb_strtolower($code)])) {
                Http::validationFailed('Another table on this floor is already called ' . $code . '.', ['table_code' => $code]);
            }
        }

        return Db::transaction(function () use ($floorId, $planned, $removed, $known) {
            // Renames happen in two passes. The unique index on (floor, code) is
            // checked row by row, so swapping T1 and T2 in one pass fails on the
            // first row even though the finished layout is perfectly valid.
            foreach ($planned as $tableId => $values) {
                if ($values['table_code'] !== $known[$tableId]) {
                    Db::update(
                        'pos_tables',
                        ['table_code' => '~' . $tableId],
                        ['table_id' => $tableId, 'cmp_id' => $this->ctx->cmpId],
                    );
                }
            }

            foreach ($planned as $tableId => $values) {
                Db::update('pos_tables', $values, ['table_id' => $tableId, 'cmp_id' => $this->ctx->cmpId]);
            }

            // Tables the editor removed. Retired one at a time so each gets the
            // occupied check and its own audit entry.
            foreach ($removed as $tableId) {
                if (isset($known[$tableId])) {
                    $this->deleteTable($tableId);
                }
            }

            Audit::record($this->ctx, $this->auth, 'floor.layout_saved', 'floor', $floorId, null, [
                'tables' => count($planned), 'removed' => count($removed),
            ]);

            return $this->floor($floorId) + ['saved' => count($planned), 'removed' => count($removed)];
        });
    }

    /** One floor's configuration row, or [] when there is no such floor. */
    public function floor(int $floorId): array
    {
        $row = Db::first(
            'SELECT floor_id, cmp_id, location_id, floor_code, floor_name, description,
                    floor_kind, is_open, sort_order, is_active
             FROM pos_floors WHERE floor_id = :id AND cmp_id = :cmp AND is_active = TRUE',
            ['id' => $floorId, 'cmp' => $this->ctx->cmpId],
        );
        if ($row === null) {
            return [];
        }

        return [
            'floor_id'    => (int) $row['floor_id'],
            'location_id' => (int) $row['location_id'],
            'floor_code'  => $row['floor_code'],
            'floor_name'  => $row['floor_name'],
            'description' => $row['description'],
            'floor_kind'  => (string) $row['floor_kind'],
            'is_open'     => self::bool($row['is_open']),
            'sort_order'  => (int) $row['sort_order'],
        ];
    }

    // -----------------------------------------------------------------------
    // Why a table with nobody at it still cannot be seated
    // -----------------------------------------------------------------------

    /**
     * Mark a table as being cleaned, out of service, or ready again.
     *
     * Refused while a party is sitting there. "Out of service" is a statement
     * about the furniture, not about the guests, and a floor that lets one be
     * used to clear the other loses the check that stops a table being reseated
     * over an unpaid bill.
     *
     * @param array<string, mixed> $input
     */
    public function setServiceState(int $tableId, array $input): array
    {
        $state = strtoupper(trim((string) ($input['service_state'] ?? '')));
        if (!in_array($state, self::SERVICE_STATES, true)) {
            Http::validationFailed(
                'A table is either ready, being cleaned, or out of service.',
                ['field' => 'service_state', 'allowed' => self::SERVICE_STATES],
            );
        }

        // Cleaning is floor work; taking a table out of service is a change to
        // how the shop is set up, and is held to the same permission as adding
        // the table in the first place.
        Permissions::assert($this->ctx, $this->auth, $state === 'OUT_OF_SERVICE' ? 'terminal.manage' : 'table.open');

        $table = Db::first(
            'SELECT table_id, table_code, service_state FROM pos_tables WHERE table_id = :id AND cmp_id = :cmp AND is_active = TRUE',
            ['id' => $tableId, 'cmp' => $this->ctx->cmpId],
        );
        if ($table === null) {
            Http::notFound('That table does not exist.');
        }

        $seated = Db::scalar(
            "SELECT table_session_id FROM pos_table_sessions
             WHERE cmp_id = :cmp AND table_id = :table AND status = 'OCCUPIED'",
            ['cmp' => $this->ctx->cmpId, 'table' => $tableId],
        );
        if ($seated !== null && $state !== 'READY') {
            Http::conflict(
                'There is a party at that table. Clear it first.',
                ['table_session_id' => (int) $seated],
            );
        }

        Db::update('pos_tables', [
            'service_state'    => $state,
            'service_note'     => $state === 'READY' ? null : self::text($input['note'] ?? null),
            'service_state_by' => $state === 'READY' ? null : $this->auth->displayName(),
            'service_state_at' => $state === 'READY' ? null : self::now(),
        ], ['table_id' => $tableId, 'cmp_id' => $this->ctx->cmpId]);

        Audit::record(
            $this->ctx,
            $this->auth,
            'table.service_state',
            'table',
            $tableId,
            ['service_state' => $table['service_state']],
            ['service_state' => $state, 'note' => self::text($input['note'] ?? null)],
        );

        return $this->table($tableId);
    }

    // -----------------------------------------------------------------------
    // Bookings
    // -----------------------------------------------------------------------

    /**
     * The diary, for one table or for the whole shop.
     *
     * @param array<string, mixed> $filters
     * @return list<array<string, mixed>>
     */
    public function reservations(array $filters = []): array
    {
        $params = ['cmp' => $this->ctx->cmpId];
        $where  = ['r.cmp_id = :cmp'];

        if (self::id($filters['table_id'] ?? null) !== null) {
            $where[] = 'r.table_id = :table';
            $params['table'] = self::id($filters['table_id']);
        }
        if (self::id($filters['floor_id'] ?? null) !== null) {
            $where[] = 't.floor_id = :floor';
            $params['floor'] = self::id($filters['floor_id']);
        }
        $status = self::text($filters['status'] ?? null);
        if ($status !== null) {
            $where[] = 'r.status = :status';
            $params['status'] = strtoupper($status);
        }

        return array_map(self::readReservation(...), Db::all(
            'SELECT r.*, t.table_code, t.table_name, f.floor_id, f.floor_name
             FROM pos_table_reservations r
             JOIN pos_tables t ON t.table_id = r.table_id
             JOIN pos_floors f ON f.floor_id = t.floor_id
             WHERE ' . implode(' AND ', $where) . '
             ORDER BY r.reserved_for
             LIMIT 200',
            $params,
        ));
    }

    /**
     * Book a table.
     *
     * Two bookings that overlap on the same table are refused: the whole point
     * of a booking is that the table will be there, and a floor screen showing
     * two names against one table at eight o'clock is worse than no booking at
     * all. A table already out of service cannot be booked either.
     *
     * @param array<string, mixed> $input
     */
    public function createReservation(array $input): array
    {
        Permissions::assert($this->ctx, $this->auth, 'table.open');

        $tableId = self::id($input['table_id'] ?? null);
        if ($tableId === null) {
            Http::validationFailed('Which table is being booked?', ['field' => 'table_id']);
        }

        $reservedFor = self::timestamp($input['reserved_for'] ?? null);
        if ($reservedFor === null) {
            Http::validationFailed('When is the booking for?', ['field' => 'reserved_for']);
        }

        $table = Db::first(
            'SELECT table_id, seats, service_state FROM pos_tables
             WHERE table_id = :id AND cmp_id = :cmp AND is_active = TRUE',
            ['id' => $tableId, 'cmp' => $this->ctx->cmpId],
        );
        if ($table === null) {
            Http::notFound('That table does not exist.');
        }
        if ($table['service_state'] === 'OUT_OF_SERVICE') {
            Http::conflict('That table is out of service, so it cannot be booked.');
        }

        $partySize = max(1, (int) ($input['party_size'] ?? $table['seats'] ?? 2));
        $hold      = max(0, (int) ($input['hold_minutes'] ?? 20));

        $slot = self::RESERVATION_SLOT_MINUTES;
        $when = new \DateTimeImmutable($reservedFor);
        $from = $when->modify('-' . $slot . ' minutes')->format('Y-m-d H:i:sP');
        $to   = $when->modify('+' . $slot . ' minutes')->format('Y-m-d H:i:sP');

        return Db::transaction(function () use ($tableId, $reservedFor, $partySize, $hold, $input, $from, $to) {
            // The lock is on the TABLE row, not on the bookings: two clerks
            // taking the same slot at the same second both find no clash, and a
            // FOR UPDATE that matches nothing locks nothing.
            Db::run(
                'SELECT table_id FROM pos_tables WHERE table_id = :table AND cmp_id = :cmp FOR UPDATE',
                ['table' => $tableId, 'cmp' => $this->ctx->cmpId],
            );

            $clash = Db::first(
                "SELECT reservation_id, reserved_for FROM pos_table_reservations
                 WHERE cmp_id = :cmp AND table_id = :table AND status = 'BOOKED'
                   AND reserved_for > :from::timestamptz AND reserved_for < :to::timestamptz",
                ['cmp' => $this->ctx->cmpId, 'table' => $tableId, 'from' => $from, 'to' => $to],
            );
            if ($clash !== null) {
                Http::conflict('That table is already booked around then.', [
                    'reservation_id' => (int) $clash['reservation_id'],
                    'reserved_for'   => $clash['reserved_for'],
                ]);
            }

            $reservationId = (int) Db::insert('pos_table_reservations', [
                'cmp_id'              => $this->ctx->cmpId,
                'fy_id'               => $this->ctx->fyId,
                'table_id'            => $tableId,
                'reservation_no'      => NumberSeries::next($this->ctx, 'reservation'),
                'customer_account_id' => self::id($input['customer_account_id'] ?? null),
                'guest_name'          => self::text($input['guest_name'] ?? null),
                'guest_mobile'        => self::text($input['guest_mobile'] ?? null),
                'party_size'          => $partySize,
                'reserved_for'        => $reservedFor,
                'hold_minutes'        => $hold,
                'status'              => 'BOOKED',
                'notes'               => self::text($input['notes'] ?? null),
                'created_by'          => $this->auth->uuid,
            ], 'reservation_id');

            Audit::record($this->ctx, $this->auth, 'reservation.created', 'reservation', $reservationId, null, [
                'table_id' => $tableId, 'reserved_for' => $reservedFor, 'party_size' => $partySize,
            ]);

            return $this->reservation($reservationId);
        });
    }

    /**
     * Cancel a booking, or record that nobody came.
     *
     * @param array<string, mixed> $input
     */
    public function cancelReservation(int $reservationId, array $input): array
    {
        Permissions::assert($this->ctx, $this->auth, 'table.open');

        $booking = $this->reservation($reservationId);
        if ($booking === []) {
            Http::notFound('That booking does not exist.');
        }
        if ($booking['status'] !== 'BOOKED') {
            Http::conflict('That booking has already been ' . strtolower((string) $booking['status']) . '.');
        }

        $noShow = ($input['no_show'] ?? false) === true;

        Db::update('pos_table_reservations', [
            'status'        => $noShow ? 'NO_SHOW' : 'CANCELLED',
            'cancelled_at'  => self::now(),
            'cancelled_by'  => $this->auth->uuid,
            'cancel_reason' => self::text($input['reason'] ?? null),
            'updated_at'    => self::now(),
        ], ['reservation_id' => $reservationId, 'cmp_id' => $this->ctx->cmpId]);

        Audit::record($this->ctx, $this->auth, $noShow ? 'reservation.no_show' : 'reservation.cancelled',
            'reservation', $reservationId, ['status' => 'BOOKED'], ['reason' => self::text($input['reason'] ?? null)]);

        return $this->reservation($reservationId);
    }

    /**
     * The party arrived: seat them and close the booking in one step.
     *
     * Seating goes through open() rather than around it, so a booked table gets
     * the same cart, the same audit entry and the same "already occupied" check
     * as a walk-in. The booking is only marked seated once that has succeeded.
     *
     * @param array<string, mixed> $input
     */
    public function seatReservation(int $reservationId, array $input): array
    {
        $booking = $this->reservation($reservationId);
        if ($booking === []) {
            Http::notFound('That booking does not exist.');
        }
        if ($booking['status'] !== 'BOOKED') {
            Http::conflict('That booking has already been ' . strtolower((string) $booking['status']) . '.');
        }

        $session = $this->open((int) $booking['table_id'], [
            'covers'          => $input['covers'] ?? $booking['party_size'],
            'terminal_id'     => $input['terminal_id'] ?? null,
            'customer_name'   => $booking['guest_name'],
            'customer_mobile' => $booking['guest_mobile'],
            'notes'           => $booking['notes'],
        ]);

        Db::update('pos_table_reservations', [
            'status'            => 'SEATED',
            'seated_session_id' => (int) $session['table_session_id'],
            'seated_at'         => self::now(),
            'updated_at'        => self::now(),
        ], ['reservation_id' => $reservationId, 'cmp_id' => $this->ctx->cmpId]);

        Audit::record($this->ctx, $this->auth, 'reservation.seated', 'reservation', $reservationId, null, [
            'table_session_id' => (int) $session['table_session_id'],
        ]);

        return $session;
    }

    public function reservation(int $reservationId): array
    {
        $row = Db::first(
            'SELECT r.*, t.table_code, t.table_name, f.floor_id, f.floor_name
             FROM pos_table_reservations r
             JOIN pos_tables t ON t.table_id = r.table_id
             JOIN pos_floors f ON f.floor_id = t.floor_id
             WHERE r.reservation_id = :id AND r.cmp_id = :cmp',
            ['id' => $reservationId, 'cmp' => $this->ctx->cmpId],
        );

        return $row === null ? [] : self::readReservation($row);
    }

    /** One table, shaped the way the floor plan shapes it. */
    public function table(int $tableId): array
    {
        $floors = $this->floorPlan();
        foreach ($floors as $floor) {
            foreach ($floor['tables'] as $table) {
                if ($table['table_id'] === $tableId) {
                    return $table + ['floor_id' => $floor['floor_id'], 'floor_name' => $floor['floor_name']];
                }
            }
        }

        return [];
    }

    public function find(int $sessionId): array
    {
        $row = Db::first(
            'SELECT s.*, t.table_code, t.table_name, f.floor_name
             FROM pos_table_sessions s
             JOIN pos_tables t ON t.table_id = s.table_id
             JOIN pos_floors f ON f.floor_id = t.floor_id
             WHERE s.table_session_id = :id AND s.cmp_id = :cmp',
            ['id' => $sessionId, 'cmp' => $this->ctx->cmpId],
        );
        if ($row === null) {
            return [];
        }

        $row['table_session_id'] = (int) $row['table_session_id'];
        $row['table_id'] = (int) $row['table_id'];
        $row['covers'] = (int) $row['covers'];
        $row['carts'] = Db::all(
            "SELECT cart_id, status, total_amount, books_voucher_no FROM pos_carts
             WHERE cmp_id = :cmp AND table_session_id = :sid AND status <> 'VOID' ORDER BY cart_id",
            ['cmp' => $this->ctx->cmpId, 'sid' => $sessionId],
        );

        return $row;
    }

    private function openCartFor(int $sessionId): ?int
    {
        $cart = Db::scalar(
            "SELECT cart_id FROM pos_carts
             WHERE cmp_id = :cmp AND table_session_id = :sid AND status IN ('OPEN', 'HELD')
             ORDER BY cart_id LIMIT 1",
            ['cmp' => $this->ctx->cmpId, 'sid' => $sessionId],
        );

        return $cart === null ? null : (int) $cart;
    }

    private static function id(mixed $raw): ?int
    {
        if ($raw === null || $raw === '' || $raw === 0 || $raw === '0') {
            return null;
        }

        return (int) $raw;
    }

    private static function text(mixed $raw): ?string
    {
        if (!is_string($raw)) {
            return null;
        }
        $trimmed = trim($raw);

        return $trimmed === '' ? null : $trimmed;
    }

    private static function now(): string
    {
        return gmdate('Y-m-d H:i:s');
    }

    /** One of the shapes a table may be drawn as, defaulting to a square. */
    private static function shape(mixed $raw): string
    {
        $value = is_string($raw) ? strtolower(trim($raw)) : '';

        return in_array($value, self::SHAPES, true) ? $value : 'square';
    }

    private static function floorKind(mixed $raw): string
    {
        $value = is_string($raw) ? strtolower(trim($raw)) : '';
        $known = ['indoor', 'outdoor', 'rooftop', 'private_dining', 'banquet', 'other'];

        return in_array($value, $known, true) ? $value : 'indoor';
    }

    /**
     * A position on the plan: hundredths of a percent, clamped to it.
     *
     * Clamped rather than rejected, because the value comes from a drag and a
     * pointer that left the plan by three pixels is not a validation error.
     */
    private static function coordinate(mixed $raw): ?int
    {
        if ($raw === null || $raw === '') {
            return null;
        }
        if (!is_numeric($raw)) {
            return null;
        }

        return max(0, min(10000, (int) round((float) $raw)));
    }

    private static function covers(mixed $raw): ?int
    {
        if ($raw === null || $raw === '' || !is_numeric($raw)) {
            return null;
        }

        return max(1, min(99, (int) $raw));
    }

    /** A short code from a name: "Ground Floor" becomes GF, "Rooftop" ROOFTOP. */
    private static function codeFrom(string $name): string
    {
        $words = preg_split('/\s+/', trim($name)) ?: [];
        $code = count($words) > 1
            ? implode('', array_map(static fn (string $w) => mb_substr($w, 0, 1), $words))
            : $name;

        $code = strtoupper(preg_replace('/[^A-Za-z0-9]/', '', $code) ?? '');

        return $code === '' ? 'FL' : mb_substr($code, 0, 12);
    }

    /**
     * Where the nth table goes when nobody has drawn the room yet.
     *
     * Six to a row, spaced so the plan looks like a plan on first load rather
     * than a pile of tables in one corner waiting to be dragged apart.
     *
     * @return array{int, int}
     */
    private static function gridSlot(int $index): array
    {
        $perRow = 6;
        $column = $index % $perRow;
        $row    = intdiv($index, $perRow);

        return [800 + ($column * 1500), 1200 + ($row * 1600)];
    }

    /** PostgreSQL hands booleans back as 't'/'f' through PDO, not as booleans. */
    private static function bool(mixed $raw): bool
    {
        return $raw === true || $raw === 't' || $raw === 'true' || $raw === 1 || $raw === '1';
    }

    /**
     * An instant the caller sent, normalised, or null if it is not one.
     *
     * Accepts what a browser sends from a datetime-local field as well as a
     * full ISO instant. A booking half an hour ago is legitimate — a table held
     * for a party that is running late — so no window is enforced here.
     */
    private static function timestamp(mixed $raw): ?string
    {
        $text = self::text($raw);
        if ($text === null) {
            return null;
        }

        try {
            return (new \DateTimeImmutable($text))->format('Y-m-d H:i:sP');
        } catch (\Throwable) {
            return null;
        }
    }

    /**
     * @param array<string, mixed> $row
     * @return array<string, mixed>
     */
    private static function readReservation(array $row): array
    {
        return [
            'reservation_id'      => (int) $row['reservation_id'],
            'reservation_no'      => $row['reservation_no'],
            'table_id'            => (int) $row['table_id'],
            'table_code'          => $row['table_code'] ?? null,
            'table_name'          => $row['table_name'] ?? null,
            'floor_id'            => isset($row['floor_id']) ? (int) $row['floor_id'] : null,
            'floor_name'          => $row['floor_name'] ?? null,
            'customer_account_id' => $row['customer_account_id'] === null ? null : (int) $row['customer_account_id'],
            'guest_name'          => $row['guest_name'],
            'guest_mobile'        => $row['guest_mobile'],
            'party_size'          => (int) $row['party_size'],
            'reserved_for'        => $row['reserved_for'],
            'hold_minutes'        => (int) $row['hold_minutes'],
            'status'              => (string) $row['status'],
            'notes'               => $row['notes'],
            'seated_session_id'   => $row['seated_session_id'] === null ? null : (int) $row['seated_session_id'],
            'seated_at'           => $row['seated_at'],
            'cancelled_at'        => $row['cancelled_at'],
            'cancel_reason'       => $row['cancel_reason'],
            'created_at'          => $row['created_at'],
        ];
    }
}
