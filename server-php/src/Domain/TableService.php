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
     */
    public function floorPlan(?int $locationId = null): array
    {
        $params = ['cmp' => $this->ctx->cmpId];
        $where = 'f.cmp_id = :cmp AND f.is_active = TRUE';
        if ($locationId !== null) {
            $where .= ' AND f.location_id = :loc';
            $params['loc'] = $locationId;
        }

        $rows = Db::all(
            "SELECT f.floor_id, f.floor_code, f.floor_name, f.sort_order AS floor_sort,
                    t.table_id, t.table_code, t.table_name, t.seats, t.layout_x, t.layout_y,
                    s.table_session_id, s.status AS session_status, s.covers, s.waiter_uuid,
                    s.opened_at, s.merged_into_id,
                    c.cart_id, c.total_amount, c.status AS cart_status,
                    (SELECT COUNT(*) FROM pos_kots k
                      WHERE k.table_session_id = s.table_session_id
                        AND k.status NOT IN ('SERVED', 'CANCELLED')) AS open_kots
             FROM pos_floors f
             JOIN pos_tables t ON t.floor_id = f.floor_id AND t.is_active = TRUE
             LEFT JOIN pos_table_sessions s
                    ON s.table_id = t.table_id AND s.status = 'OCCUPIED' AND s.cmp_id = f.cmp_id
             LEFT JOIN pos_carts c
                    ON c.table_session_id = s.table_session_id AND c.status IN ('OPEN', 'HELD')
             WHERE {$where}
             ORDER BY f.sort_order, f.floor_id, t.table_code",
            $params,
        );

        $floors = [];
        foreach ($rows as $row) {
            $floorId = (int) $row['floor_id'];
            $floors[$floorId] ??= [
                'floor_id'   => $floorId,
                'floor_code' => $row['floor_code'],
                'floor_name' => $row['floor_name'],
                'tables'     => [],
            ];

            $floors[$floorId]['tables'][] = [
                'table_id'         => (int) $row['table_id'],
                'table_code'       => $row['table_code'],
                'table_name'       => $row['table_name'],
                'seats'            => (int) $row['seats'],
                'layout_x'         => $row['layout_x'] === null ? null : (int) $row['layout_x'],
                'layout_y'         => $row['layout_y'] === null ? null : (int) $row['layout_y'],
                'table_session_id' => $row['table_session_id'] === null ? null : (int) $row['table_session_id'],
                'status'           => $row['table_session_id'] === null ? 'FREE' : (string) $row['session_status'],
                'covers'           => $row['covers'] === null ? null : (int) $row['covers'],
                'waiter_uuid'      => $row['waiter_uuid'],
                'opened_at'        => $row['opened_at'],
                'cart_id'          => $row['cart_id'] === null ? null : (int) $row['cart_id'],
                'running_total'    => $row['total_amount'] === null ? null : (float) $row['total_amount'],
                'open_kots'        => (int) $row['open_kots'],
            ];
        }

        return array_values($floors);
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

        $toTableId = self::id($input['table_id'] ?? null);
        $toWaiter  = self::text($input['waiter_uuid'] ?? null);

        if ($toTableId === null && $toWaiter === null) {
            Http::validationFailed('Say which table it is moving to, or who is taking it over.');
        }

        return Db::transaction(function () use ($sessionId, $session, $toTableId, $toWaiter) {
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
}
