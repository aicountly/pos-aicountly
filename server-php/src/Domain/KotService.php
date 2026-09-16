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
 * Kitchen tickets and the kitchen display.
 *
 * A KOT is an INSTRUCTION TO COOK, and it is the only document in this product
 * that must not be rewritten. Once the kitchen has it, changing it silently is
 * how a customer gets a dish they cancelled and the shop eats the cost. So:
 *
 *   - Firing is additive. A second order at the same table is a NEW ticket of
 *     kind 'addon', never an edit of the first.
 *   - A change is an 'amend' ticket that says what changed, so the kitchen sees
 *     the change rather than having to spot it.
 *   - Cancelling a ticket the kitchen has accepted is permissioned and
 *     recorded, because by then food may already be made.
 *
 * Nothing here touches stock. The food leaves the kitchen; the INGREDIENTS
 * leave Inventory when the sale posts, against the recipe Inventory holds.
 * A POS that decremented ingredients itself would be keeping a second stock
 * ledger, which is exactly what this architecture refuses to do.
 */
final class KotService
{
    public function __construct(
        private readonly Context $ctx,
        private readonly Auth $auth,
    ) {
    }

    /**
     * Send the unfired lines of a cart to the kitchen.
     *
     * Lines are grouped by station, because the grill and the bar are different
     * screens in different rooms and a single combined ticket helps neither.
     *
     * @param array<string, mixed> $input
     * @return list<array<string, mixed>>
     */
    public function fire(int $cartId, array $input): array
    {
        Permissions::assert($this->ctx, $this->auth, 'kot.fire');

        $cart = (new CartService($this->ctx, $this->auth))->requireOpen($cartId);

        $only = array_values(array_filter(array_map(
            static fn ($id) => is_numeric($id) ? (int) $id : null,
            (array) ($input['line_ids'] ?? []),
        )));

        $lines = array_values(array_filter($cart['lines'], static function (array $line) use ($only): bool {
            if ((string) ($line['kitchen_status'] ?? '') !== 'NEW') {
                return false;
            }

            return $only === [] || in_array((int) $line['line_id'], $only, true);
        }));

        if ($lines === []) {
            Http::conflict('Everything on this order has already gone to the kitchen.');
        }

        $byStation = [];
        foreach ($lines as $line) {
            $stationId = $this->stationFor($line);
            $byStation[$stationId ?? 0][] = $line;
        }

        return Db::transaction(function () use ($cartId, $cart, $byStation, $input) {
            $kots = [];

            foreach ($byStation as $stationKey => $stationLines) {
                $stationId = $stationKey === 0 ? null : (int) $stationKey;

                $priorKot = Db::scalar(
                    "SELECT kot_id FROM pos_kots
                     WHERE cmp_id = :cmp AND cart_id = :cart AND status <> 'CANCELLED'
                     ORDER BY kot_id LIMIT 1",
                    ['cmp' => $this->ctx->cmpId, 'cart' => $cartId],
                );

                $kotId = (int) Db::insert('pos_kots', [
                    'cmp_id'           => $this->ctx->cmpId,
                    'fy_id'            => $this->ctx->fyId,
                    'location_id'      => $this->locationFor($cart),
                    'cart_id'          => $cartId,
                    'table_session_id' => self::id($cart['table_session_id']),
                    'station_id'       => $stationId,
                    'kot_no'           => NumberSeries::next($this->ctx, 'kot'),
                    // The first ticket for a table is 'new'; anything after it
                    // is an 'addon', so the kitchen knows this is a second
                    // round rather than a ticket it somehow missed.
                    'kot_kind'         => $priorKot === null ? 'new' : 'addon',
                    'parent_kot_id'    => $priorKot === null ? null : (int) $priorKot,
                    'token_no'         => $cart['token_no'],
                    'status'           => 'NEW',
                    'priority'         => self::priority($input['priority'] ?? null),
                    'waiter_uuid'      => self::text($cart['opened_by'] ?? null),
                    'fired_by'         => $this->auth->uuid,
                    'notes'            => self::text($input['notes'] ?? null),
                ], 'kot_id');

                $lineNo = 0;
                foreach ($stationLines as $line) {
                    Db::insert('pos_kot_lines', [
                        'kot_id'       => $kotId,
                        'cart_line_id' => (int) $line['line_id'],
                        'cmp_id'       => $this->ctx->cmpId,
                        'line_no'      => ++$lineNo,
                        'item_id'      => $line['item_id'],
                        'display_name' => (string) $line['display_name'],
                        'quantity'     => (float) $line['quantity'],
                        'modifiers'    => $line['modifiers'],
                        'instructions' => $line['instructions'],
                        'allergy_note' => self::text($input['allergy_note'] ?? null),
                        'status'       => 'NEW',
                    ], 'kot_line_id');

                    Db::update('pos_cart_lines', [
                        'kot_id'         => $kotId,
                        'kitchen_status' => 'SENT',
                        'updated_at'     => self::now(),
                    ], ['line_id' => (int) $line['line_id'], 'cmp_id' => $this->ctx->cmpId]);
                }

                $this->event($kotId, null, $stationId, 'fired', ['lines' => count($stationLines)]);
                $kots[] = $this->find($kotId);
            }

            Audit::record($this->ctx, $this->auth, 'kot.fired', 'cart', $cartId, null, ['kots' => count($kots)]);

            return $kots;
        });
    }

    /**
     * Amend a ticket the kitchen already has.
     *
     * Produces a NEW ticket of kind 'amend' rather than editing the original,
     * because a cook reading a printed ticket cannot see an edit. The amend
     * ticket says plainly what changed.
     *
     * @param array<string, mixed> $input
     */
    public function amend(int $kotId, array $input): array
    {
        Permissions::assert($this->ctx, $this->auth, 'kot.fire');

        $kot = $this->find($kotId);
        if ($kot === []) {
            Http::notFound('That ticket does not exist.');
        }
        if ($kot['status'] === 'CANCELLED') {
            Http::conflict('That ticket was cancelled. Fire a new one.');
        }

        $note = self::text($input['note'] ?? null);
        if ($note === null) {
            Http::validationFailed('Say what changed, so the kitchen can see it.', ['field' => 'note']);
        }

        return Db::transaction(function () use ($kotId, $kot, $note, $input) {
            $amendId = (int) Db::insert('pos_kots', [
                'cmp_id'           => $this->ctx->cmpId,
                'fy_id'            => $this->ctx->fyId,
                'location_id'      => $kot['location_id'],
                'cart_id'          => $kot['cart_id'],
                'table_session_id' => $kot['table_session_id'],
                'station_id'       => $kot['station_id'],
                'kot_no'           => NumberSeries::next($this->ctx, 'kot'),
                'kot_kind'         => 'amend',
                'parent_kot_id'    => $kotId,
                'token_no'         => $kot['token_no'],
                'status'           => 'NEW',
                'priority'         => 'high',
                'waiter_uuid'      => $kot['waiter_uuid'],
                'fired_by'         => $this->auth->uuid,
                'notes'            => $note,
            ], 'kot_id');

            foreach ((array) ($input['lines'] ?? []) as $index => $line) {
                if (!is_array($line)) {
                    continue;
                }
                Db::insert('pos_kot_lines', [
                    'kot_id'       => $amendId,
                    'cmp_id'       => $this->ctx->cmpId,
                    'line_no'      => $index + 1,
                    'item_id'      => self::id($line['item_id'] ?? null),
                    'display_name' => (string) ($line['display_name'] ?? 'Change'),
                    'quantity'     => round((float) ($line['quantity'] ?? 1), 4),
                    'modifiers'    => is_array($line['modifiers'] ?? null) ? $line['modifiers'] : [],
                    'instructions' => self::text($line['instructions'] ?? null),
                    'status'       => 'NEW',
                ], 'kot_line_id');
            }

            $this->event($amendId, null, self::id($kot['station_id']), 'amended', ['parent_kot_id' => $kotId, 'note' => $note]);
            Audit::record($this->ctx, $this->auth, 'kot.amended', 'kot', $kotId, null, ['amend_kot_id' => $amendId], $note);

            return $this->find($amendId);
        });
    }

    /**
     * Move a ticket, or one of its lines, along the kitchen workflow.
     *
     * @param array<string, mixed> $input
     */
    public function advance(int $kotId, array $input): array
    {
        Permissions::assert($this->ctx, $this->auth, 'kds.operate');

        $kot = $this->find($kotId);
        if ($kot === []) {
            Http::notFound('That ticket does not exist.');
        }
        if ($kot['status'] === 'CANCELLED') {
            Http::conflict('That ticket was cancelled.');
        }

        $to = strtoupper((string) ($input['status'] ?? ''));
        $flow = ['NEW' => 'PREPARING', 'PREPARING' => 'READY', 'READY' => 'SERVED'];
        if (!isset($flow[$kot['status']]) && $to !== $kot['status']) {
            Http::conflict('That ticket is already ' . strtolower((string) $kot['status']) . '.');
        }
        if ($to === '') {
            $to = $flow[$kot['status']];
        }
        if (!in_array($to, ['PREPARING', 'READY', 'SERVED'], true)) {
            Http::validationFailed('A ticket goes to preparing, ready or served.', ['field' => 'status']);
        }

        $lineId = self::id($input['kot_line_id'] ?? null);

        return Db::transaction(function () use ($kotId, $kot, $to, $lineId) {
            if ($lineId !== null) {
                Db::update('pos_kot_lines', [
                    'status'   => $to,
                    'ready_at' => $to === 'READY' ? self::now() : null,
                ], ['kot_line_id' => $lineId, 'cmp_id' => $this->ctx->cmpId]);

                // The ticket follows its slowest line: a ticket is only ready
                // when everything on it is, or the waiter carries half a table's
                // food out.
                $pending = (int) Db::scalar(
                    "SELECT COUNT(*) FROM pos_kot_lines WHERE kot_id = :kot AND status NOT IN (:to, 'CANCELLED')",
                    ['kot' => $kotId, 'to' => $to],
                );
                if ($pending > 0) {
                    $this->event($kotId, $lineId, self::id($kot['station_id']), strtolower($to), ['line' => $lineId]);

                    return $this->find($kotId);
                }
            }

            Db::update('pos_kots', array_filter([
                'status'      => $to,
                'accepted_at' => $to === 'PREPARING' ? self::now() : null,
                'ready_at'    => $to === 'READY' ? self::now() : null,
                'served_at'   => $to === 'SERVED' ? self::now() : null,
                'updated_at'  => self::now(),
            ], static fn ($v) => $v !== null), ['kot_id' => $kotId, 'cmp_id' => $this->ctx->cmpId]);

            Db::run(
                "UPDATE pos_kot_lines SET status = :to, ready_at = CASE WHEN :to2 = 'READY' THEN :now::timestamptz ELSE ready_at END
                 WHERE kot_id = :kot AND status <> 'CANCELLED'",
                ['to' => $to, 'to2' => $to, 'now' => self::now(), 'kot' => $kotId],
            );

            Db::run(
                'UPDATE pos_cart_lines SET kitchen_status = :to, updated_at = :now WHERE kot_id = :kot AND cmp_id = :cmp',
                ['to' => $to, 'now' => self::now(), 'kot' => $kotId, 'cmp' => $this->ctx->cmpId],
            );

            $this->event($kotId, null, self::id($kot['station_id']), strtolower($to), []);

            return $this->find($kotId);
        });
    }

    /**
     * Cancel a ticket.
     *
     * Permissioned separately from firing, because by the time the kitchen has
     * accepted it, cancelling means food already made and money already spent.
     * The wastage is recorded on the approval trail.
     *
     * @param array<string, mixed> $input
     */
    public function cancel(int $kotId, array $input): array
    {
        Permissions::assert($this->ctx, $this->auth, 'kot.cancel');

        $kot = $this->find($kotId);
        if ($kot === []) {
            Http::notFound('That ticket does not exist.');
        }
        if ($kot['status'] === 'CANCELLED') {
            Http::conflict('That ticket is already cancelled.');
        }
        if ($kot['status'] === 'SERVED') {
            Http::conflict('That food has been served. Take a return if it is coming back.');
        }

        $reason = self::text($input['reason'] ?? null);
        if ($reason === null) {
            Http::validationFailed('Say why the kitchen should stop.', ['field' => 'reason']);
        }

        return Db::transaction(function () use ($kotId, $kot, $reason) {
            Db::update('pos_kots', [
                'status'        => 'CANCELLED',
                'cancelled_at'  => self::now(),
                'cancelled_by'  => $this->auth->uuid,
                'cancel_reason' => $reason,
                'updated_at'    => self::now(),
            ], ['kot_id' => $kotId, 'cmp_id' => $this->ctx->cmpId]);

            Db::run(
                "UPDATE pos_kot_lines SET status = 'CANCELLED', cancelled_at = :now, cancel_reason = :reason
                 WHERE kot_id = :kot AND status <> 'CANCELLED'",
                ['now' => self::now(), 'reason' => $reason, 'kot' => $kotId],
            );

            Db::run(
                "UPDATE pos_cart_lines SET kitchen_status = 'CANCELLED', updated_at = :now WHERE kot_id = :kot AND cmp_id = :cmp",
                ['now' => self::now(), 'kot' => $kotId, 'cmp' => $this->ctx->cmpId],
            );

            Db::insert('pos_approval_events', [
                'cmp_id'       => $this->ctx->cmpId,
                'cart_id'      => self::id($kot['cart_id']),
                'event_kind'   => 'kot_cancel',
                'requested_by' => $this->auth->uuid,
                'approved_by'  => $this->auth->uuid,
                'reason'       => $reason,
                'detail'       => [
                    'kot_id' => $kotId, 'kot_no' => $kot['kot_no'], 'status_when_cancelled' => $kot['status'],
                    'lines'  => array_map(static fn (array $l) => ['name' => $l['display_name'], 'qty' => (float) $l['quantity']], $kot['lines']),
                ],
            ], 'approval_id');

            $this->event($kotId, null, self::id($kot['station_id']), 'cancelled', ['reason' => $reason]);
            Audit::record($this->ctx, $this->auth, 'kot.cancelled', 'kot', $kotId, ['status' => $kot['status']], ['status' => 'CANCELLED'], $reason);

            return $this->find($kotId);
        });
    }

    /**
     * The kitchen display for a station.
     *
     * Ordered oldest first — a kitchen works a queue, and a screen that sorts
     * any other way loses tickets at the bottom.
     *
     * @return list<array<string, mixed>>
     */
    public function display(?int $stationId, array $filters = []): array
    {
        Permissions::assert($this->ctx, $this->auth, 'kds.operate');

        $params = ['cmp' => $this->ctx->cmpId];
        $where = ["k.cmp_id = :cmp", "k.status NOT IN ('SERVED', 'CANCELLED')"];

        if ($stationId !== null) {
            $where[] = 'k.station_id = :station';
            $params['station'] = $stationId;
        }
        if (!empty($filters['location_id'])) {
            $where[] = 'k.location_id = :loc';
            $params['loc'] = (int) $filters['location_id'];
        }

        $kots = Db::all(
            'SELECT k.*, s.station_name, s.late_after_minutes, t.table_code
             FROM pos_kots k
             LEFT JOIN pos_kds_stations s ON s.station_id = k.station_id
             LEFT JOIN pos_table_sessions ts ON ts.table_session_id = k.table_session_id
             LEFT JOIN pos_tables t ON t.table_id = ts.table_id
             WHERE ' . implode(' AND ', $where) . '
             ORDER BY k.fired_at
             LIMIT 200',
            $params,
        );

        if ($kots === []) {
            return [];
        }

        $ids = array_map(static fn (array $k) => (int) $k['kot_id'], $kots);
        $placeholders = implode(',', array_map(static fn (int $i) => ':k' . $i, array_keys($ids)));
        $lineParams = [];
        foreach ($ids as $i => $id) {
            $lineParams['k' . $i] = $id;
        }

        $linesByKot = [];
        foreach (Db::all('SELECT * FROM pos_kot_lines WHERE kot_id IN (' . $placeholders . ') ORDER BY kot_id, line_no', $lineParams) as $line) {
            $line['modifiers'] = Db::jsonColumn($line['modifiers'] ?? null);
            $line['quantity'] = (float) $line['quantity'];
            $linesByKot[(int) $line['kot_id']][] = $line;
        }

        $now = time();

        return array_map(static function (array $kot) use ($linesByKot, $now): array {
            $kot['kot_id'] = (int) $kot['kot_id'];
            $kot['lines'] = $linesByKot[$kot['kot_id']] ?? [];
            $firedAt = strtotime((string) $kot['fired_at']) ?: $now;
            $kot['waiting_minutes'] = (int) floor(($now - $firedAt) / 60);
            // "Late" is the station's own threshold, not a global one: a bar
            // ticket is late after four minutes and a tandoor ticket is not.
            $kot['is_late'] = $kot['waiting_minutes'] > (int) ($kot['late_after_minutes'] ?? 15);

            return $kot;
        }, $kots);
    }

    public function find(int $kotId): array
    {
        $kot = Db::first('SELECT * FROM pos_kots WHERE kot_id = :id AND cmp_id = :cmp', ['id' => $kotId, 'cmp' => $this->ctx->cmpId]);
        if ($kot === null) {
            return [];
        }

        $kot['kot_id'] = (int) $kot['kot_id'];
        $kot['lines'] = array_map(static function (array $line): array {
            $line['quantity'] = (float) $line['quantity'];
            $line['modifiers'] = Db::jsonColumn($line['modifiers'] ?? null);

            return $line;
        }, Db::all('SELECT * FROM pos_kot_lines WHERE kot_id = :kot ORDER BY line_no', ['kot' => $kotId]));

        return $kot;
    }

    /** @param array<string, mixed> $line */
    private function stationFor(array $line): ?int
    {
        if ($line['menu_item_id'] === null) {
            return null;
        }

        $station = Db::scalar(
            'SELECT station_id FROM pos_menu_items WHERE menu_item_id = :id AND cmp_id = :cmp',
            ['id' => (int) $line['menu_item_id'], 'cmp' => $this->ctx->cmpId],
        );

        return $station === null ? null : (int) $station;
    }

    /** @param array<string, mixed> $cart */
    private function locationFor(array $cart): ?int
    {
        if ($cart['terminal_id'] === null) {
            return null;
        }

        $location = Db::scalar(
            'SELECT location_id FROM pos_terminals WHERE terminal_id = :id AND cmp_id = :cmp',
            ['id' => (int) $cart['terminal_id'], 'cmp' => $this->ctx->cmpId],
        );

        return $location === null ? null : (int) $location;
    }

    /** @param array<string, mixed> $detail */
    private function event(int $kotId, ?int $kotLineId, ?int $stationId, string $kind, array $detail): void
    {
        Db::insert('pos_kds_events', [
            'cmp_id'      => $this->ctx->cmpId,
            'kot_id'      => $kotId,
            'kot_line_id' => $kotLineId,
            'station_id'  => $stationId,
            'event_kind'  => $kind,
            'actor_uuid'  => $this->auth->uuid,
            'detail'      => $detail,
        ], 'event_id');
    }

    private static function priority(mixed $raw): string
    {
        $value = is_string($raw) ? strtolower(trim($raw)) : 'normal';

        return in_array($value, ['normal', 'high', 'rush'], true) ? $value : 'normal';
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
