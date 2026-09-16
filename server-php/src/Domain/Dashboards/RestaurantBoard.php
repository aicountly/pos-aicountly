<?php

declare(strict_types=1);

namespace Aicountly\Api\Domain\Dashboards;

use Aicountly\Api\Db;

/**
 * Restaurant Operations — tables, tickets, and the two clocks that matter.
 *
 * A DELAY HERE IS A TIMER, NOT A PREDICTION. Every "late" figure on this board
 * is `fired_at + station.late_after_minutes < now`. The station's own threshold
 * is used rather than one global number, because a bar pouring a beer and a
 * grill cooking a steak are not late at the same minute. Nothing on this board
 * is labelled as a suggestion, because nothing on it is one.
 *
 * STOCK IS NOT TOUCHED HERE. Firing a KOT moves no stock and neither does this
 * screen; the single stock movement for a restaurant sale happens once, at
 * checkout, in CheckoutService. Menu availability is the kitchen's own flag —
 * a person saying the biryani is finished — and is not a stock figure.
 */
final class RestaurantBoard
{
    public function __construct(private readonly Window $win)
    {
    }

    /** @return array<string, mixed> */
    public function build(): array
    {
        return [
            'window'    => $this->win->describe(),
            'kpis'      => $this->kpis(),
            'floors'    => $this->floors(),
            'kitchen'   => $this->kitchen(),
            'channels'  => $this->channels(),
            'menu'      => $this->menuAvailability(),
            'delays'    => $this->delays(),
        ];
    }

    /** @return array<string, mixed> */
    private function kpis(): array
    {
        $params = ['cmp' => $this->win->ctx->cmpId];
        $locationFilter = '';
        if ($this->win->locationId !== null) {
            $locationFilter = ' AND f.location_id = :loc';
            $params['loc'] = $this->win->locationId;
        }

        $tables = Db::first(
            "SELECT COUNT(*) AS total,
                    COUNT(*) FILTER (WHERE ts.table_session_id IS NOT NULL) AS occupied,
                    COALESCE(SUM(ts.covers), 0) AS covers
             FROM pos_tables tb
             JOIN pos_floors f ON f.floor_id = tb.floor_id
             LEFT JOIN pos_table_sessions ts
               ON ts.table_id = tb.table_id AND ts.status <> 'CLOSED'
             WHERE tb.cmp_id = :cmp AND tb.is_active = TRUE{$locationFilter}",
            $params,
        ) ?? [];

        $tickets = Db::first(
            "SELECT COUNT(*) FILTER (WHERE k.status IN ('NEW', 'ACCEPTED'))   AS queued,
                    COUNT(*) FILTER (WHERE k.status = 'PREPARING')            AS preparing,
                    COUNT(*) FILTER (WHERE k.status = 'READY')                AS ready,
                    COUNT(*) FILTER (
                        WHERE k.status IN ('NEW', 'ACCEPTED', 'PREPARING')
                          AND k.fired_at < NOW() - (COALESCE(st.late_after_minutes, 15) || ' minutes')::interval
                    ) AS overdue
             FROM pos_kots k
             LEFT JOIN pos_kds_stations st ON st.station_id = k.station_id
             WHERE k.cmp_id = :cmp AND k.status IN ('NEW', 'ACCEPTED', 'PREPARING', 'READY')"
                . ($this->win->locationId === null ? '' : ' AND k.location_id = :loc'),
            $params,
        ) ?? [];

        $orders = Db::first(
            "SELECT COUNT(*) FILTER (WHERE c.status IN ('OPEN', 'HELD')) AS open_orders,
                    COUNT(*) FILTER (WHERE c.status IN ('OPEN', 'HELD') AND c.table_session_id IS NOT NULL) AS unsettled_bills,
                    COALESCE(SUM(c.total_amount) FILTER (WHERE c.status IN ('OPEN', 'HELD')), 0) AS unsettled_value
             FROM pos_carts c
             WHERE c.cmp_id = :cmp AND c.order_kind <> 'retail'",
            ['cmp' => $this->win->ctx->cmpId],
        ) ?? [];

        return [
            'tables_total'     => (int) ($tables['total'] ?? 0),
            'tables_occupied'  => (int) ($tables['occupied'] ?? 0),
            'covers'           => (int) ($tables['covers'] ?? 0),
            'open_orders'      => (int) ($orders['open_orders'] ?? 0),
            'tickets_pending'  => (int) ($tickets['queued'] ?? 0) + (int) ($tickets['preparing'] ?? 0),
            'tickets_overdue'  => (int) ($tickets['overdue'] ?? 0),
            'orders_ready'     => (int) ($tickets['ready'] ?? 0),
            'unsettled_bills'  => (int) ($orders['unsettled_bills'] ?? 0),
            'unsettled_value'  => (float) ($orders['unsettled_value'] ?? 0),
        ];
    }

    /**
     * The room, floor by floor.
     *
     * AVAILABLE is the absence of a session, which is why it is computed here
     * rather than stored: a table with no open session is free, and a status
     * column saying otherwise would be a second source of truth to go stale.
     *
     * @return list<array<string, mixed>>
     */
    private function floors(): array
    {
        $params = ['cmp' => $this->win->ctx->cmpId];
        $locationFilter = '';
        if ($this->win->locationId !== null) {
            $locationFilter = ' AND f.location_id = :loc';
            $params['loc'] = $this->win->locationId;
        }

        $rows = Db::all(
            "SELECT f.floor_id, f.floor_code, f.floor_name, f.sort_order,
                    tb.table_id, tb.table_code, tb.table_name, tb.seats, tb.layout_x, tb.layout_y,
                    ts.table_session_id, ts.status AS session_status, ts.covers, ts.waiter_uuid, ts.opened_at,
                    EXTRACT(EPOCH FROM (NOW() - ts.opened_at))::bigint AS seated_seconds,
                    (SELECT COALESCE(SUM(c.total_amount), 0) FROM pos_carts c
                      WHERE c.table_session_id = ts.table_session_id AND c.status <> 'VOID') AS running_total
             FROM pos_floors f
             JOIN pos_tables tb ON tb.floor_id = f.floor_id AND tb.is_active = TRUE
             LEFT JOIN pos_table_sessions ts ON ts.table_id = tb.table_id AND ts.status <> 'CLOSED'
             WHERE f.cmp_id = :cmp AND f.is_active = TRUE{$locationFilter}
             ORDER BY f.sort_order, f.floor_code, tb.table_code",
            $params,
        );

        $floors = [];
        foreach ($rows as $r) {
            $floorId = (int) $r['floor_id'];
            if (!isset($floors[$floorId])) {
                $floors[$floorId] = [
                    'floor_id'   => $floorId,
                    'floor_code' => (string) $r['floor_code'],
                    'floor_name' => (string) $r['floor_name'],
                    'tables'     => [],
                ];
            }

            $sessionId = $r['table_session_id'] === null ? null : (int) $r['table_session_id'];
            $status = $sessionId === null ? 'AVAILABLE' : (string) $r['session_status'];

            $floors[$floorId]['tables'][] = [
                'table_id'      => (int) $r['table_id'],
                'table_code'    => (string) $r['table_code'],
                'table_name'    => $r['table_name'] === null ? (string) $r['table_code'] : (string) $r['table_name'],
                'seats'         => (int) $r['seats'],
                'layout_x'      => $r['layout_x'] === null ? null : (int) $r['layout_x'],
                'layout_y'      => $r['layout_y'] === null ? null : (int) $r['layout_y'],
                'table_session_id' => $sessionId,
                'status'        => $status,
                'state'         => self::tableState($status),
                'covers'        => $sessionId === null ? null : (int) $r['covers'],
                'waiter_uuid'   => $r['waiter_uuid'] === null ? null : (string) $r['waiter_uuid'],
                'seated_seconds' => $sessionId === null ? null : (int) $r['seated_seconds'],
                'running_total' => $sessionId === null ? null : (float) $r['running_total'],
            ];
        }

        return array_values($floors);
    }

    /** Four words a floor manager uses, mapped from the session's own states. */
    private static function tableState(string $status): string
    {
        return match ($status) {
            'AVAILABLE'      => 'available',
            'BILL_REQUESTED', 'PAYMENT_PENDING' => 'billing',
            'CLEANING'       => 'cleaning',
            default          => 'occupied',
        };
    }

    /**
     * The kitchen board, in the three columns a kitchen actually works in.
     *
     * @return array<string, mixed>
     */
    private function kitchen(): array
    {
        $params = ['cmp' => $this->win->ctx->cmpId];
        $locationFilter = $this->win->locationId === null ? '' : ' AND k.location_id = :loc';
        if ($this->win->locationId !== null) {
            $params['loc'] = $this->win->locationId;
        }

        $rows = Db::all(
            "SELECT k.kot_id, k.kot_no, k.kot_kind, k.status, k.priority, k.fired_at, k.token_no,
                    k.table_session_id, k.cart_id, k.station_id,
                    st.station_name, st.station_code, COALESCE(st.late_after_minutes, 15) AS late_after,
                    tb.table_code, c.order_kind,
                    EXTRACT(EPOCH FROM (NOW() - k.fired_at))::bigint AS elapsed_seconds,
                    (SELECT COUNT(*) FROM pos_kot_lines kl WHERE kl.kot_id = k.kot_id AND kl.status <> 'CANCELLED') AS line_count
             FROM pos_kots k
             LEFT JOIN pos_kds_stations st ON st.station_id = k.station_id
             LEFT JOIN pos_table_sessions ts ON ts.table_session_id = k.table_session_id
             LEFT JOIN pos_tables tb ON tb.table_id = ts.table_id
             LEFT JOIN pos_carts c ON c.cart_id = k.cart_id
             WHERE k.cmp_id = :cmp AND k.status IN ('NEW', 'ACCEPTED', 'PREPARING', 'READY'){$locationFilter}
             ORDER BY k.fired_at ASC
             LIMIT 60",
            $params,
        );

        $kotIds = array_map(static fn (array $r): int => (int) $r['kot_id'], $rows);
        $lines  = $this->kotLines($kotIds);

        $columns = ['queued' => [], 'preparing' => [], 'ready' => []];
        foreach ($rows as $r) {
            $status  = (string) $r['status'];
            $column  = match ($status) {
                'PREPARING' => 'preparing',
                'READY'     => 'ready',
                default     => 'queued',
            };
            $elapsed = (int) $r['elapsed_seconds'];
            $late    = (int) $r['late_after'] * 60;

            $columns[$column][] = [
                'kot_id'        => (int) $r['kot_id'],
                'kot_no'        => (string) $r['kot_no'],
                'kot_kind'      => (string) $r['kot_kind'],
                'status'        => $status,
                'priority'      => (string) $r['priority'],
                'token_no'      => $r['token_no'] === null ? null : (string) $r['token_no'],
                'table_code'    => $r['table_code'] === null ? null : (string) $r['table_code'],
                'order_kind'    => $r['order_kind'] === null ? 'dine_in' : (string) $r['order_kind'],
                'station_id'    => $r['station_id'] === null ? null : (int) $r['station_id'],
                'station_name'  => $r['station_name'] === null ? 'Unassigned' : (string) $r['station_name'],
                'fired_at'      => (string) $r['fired_at'],
                'elapsed_seconds' => $elapsed,
                'late_after_seconds' => $late,
                'overdue'       => $status !== 'READY' && $elapsed > $late,
                'overdue_by_seconds' => $status !== 'READY' && $elapsed > $late ? $elapsed - $late : 0,
                'line_count'    => (int) $r['line_count'],
                'lines'         => $lines[(int) $r['kot_id']] ?? [],
                'next_status'   => match ($status) {
                    'NEW', 'ACCEPTED' => 'PREPARING',
                    'PREPARING'       => 'READY',
                    'READY'           => 'SERVED',
                    default           => null,
                },
            ];
        }

        return $columns;
    }

    /**
     * @param list<int> $kotIds
     * @return array<int, list<array<string, mixed>>>
     */
    private function kotLines(array $kotIds): array
    {
        if ($kotIds === []) {
            return [];
        }

        $placeholders = [];
        $params = ['cmp' => $this->win->ctx->cmpId];
        foreach (array_values($kotIds) as $i => $id) {
            $placeholders[] = ':k' . $i;
            $params['k' . $i] = $id;
        }

        $rows = Db::all(
            'SELECT kot_id, display_name, quantity, modifiers, instructions, allergy_note, status
             FROM pos_kot_lines
             WHERE cmp_id = :cmp AND kot_id IN (' . implode(', ', $placeholders) . ")
               AND status <> 'CANCELLED'
             ORDER BY kot_id, line_no",
            $params,
        );

        $out = [];
        foreach ($rows as $r) {
            $out[(int) $r['kot_id']][] = [
                'display_name' => (string) $r['display_name'],
                'quantity'     => (float) $r['quantity'],
                'modifiers'    => Db::jsonColumn($r['modifiers'] ?? null),
                'instructions' => $r['instructions'] === null ? null : (string) $r['instructions'],
                'allergy_note' => $r['allergy_note'] === null ? null : (string) $r['allergy_note'],
                'status'       => (string) $r['status'],
            ];
        }

        return $out;
    }

    /**
     * Where the orders came from.
     *
     * Only the channels this outlet has actually taken an order through appear.
     * There is no marketplace integration in this product, so no marketplace
     * name is drawn on a panel.
     *
     * @return array<string, mixed>
     */
    private function channels(): array
    {
        [$where, $params] = $this->win->clause('c');
        [$where, $params] = $this->win->narrow($where, $params, 'c');

        $rows = Db::all(
            "SELECT c.order_kind, COUNT(*) AS orders, COALESCE(SUM(c.total_amount), 0) AS net
             FROM pos_carts c
             WHERE {$where} AND c.status = 'COMPLETED' AND c.order_kind <> 'retail'
             GROUP BY c.order_kind ORDER BY COUNT(*) DESC",
            $params,
        );

        $total = 0;
        foreach ($rows as $r) {
            $total += (int) $r['orders'];
        }

        $connectors = (int) Db::scalar(
            'SELECT COUNT(*) FROM pos_connectors WHERE cmp_id = :cmp AND is_active = TRUE',
            ['cmp' => $this->win->ctx->cmpId],
        );

        return [
            'total'    => $total,
            'channels' => array_map(static fn (array $r): array => [
                'order_kind'   => (string) $r['order_kind'],
                'display_name' => ucfirst(str_replace('_', '-', (string) $r['order_kind'])),
                'orders'       => (int) $r['orders'],
                'net'          => (float) $r['net'],
                'share_pc'     => 0.0,
            ], $rows),
            'external_connectors' => $connectors,
            'note' => $connectors === 0
                ? 'No external ordering connector is configured, so every order here was taken on this POS.'
                : $connectors . ' external ordering connector(s) configured.',
        ];
    }

    /**
     * Menu availability — the kitchen's own flag.
     *
     * `availability` is set by a person and cleared by a person. It is not a
     * stock figure and does not move when Inventory moves, because a portion is
     * not a unit and ingredients spoil. Where a menu item is built from a BOM,
     * the component constraint is Inventory's to answer and is read there, not
     * inferred here.
     *
     * @return array<string, mixed>
     */
    private function menuAvailability(): array
    {
        $params = ['cmp' => $this->win->ctx->cmpId];
        $locationFilter = '';
        if ($this->win->locationId !== null) {
            $locationFilter = ' AND mi.location_id = :loc';
            $params['loc'] = $this->win->locationId;
        }

        $summary = Db::first(
            "SELECT COUNT(*) AS total,
                    COUNT(*) FILTER (WHERE mi.availability = 'AVAILABLE') AS available,
                    COUNT(*) FILTER (WHERE mi.availability <> 'AVAILABLE') AS unavailable
             FROM pos_menu_items mi
             WHERE mi.cmp_id = :cmp AND mi.is_active = TRUE{$locationFilter}",
            $params,
        ) ?? [];

        $rows = Db::all(
            "SELECT mi.menu_item_id, mi.display_name, mi.availability, mi.availability_note,
                    mi.availability_set_at, mi.item_id, mi.bom_id, mi.menu_price
             FROM pos_menu_items mi
             WHERE mi.cmp_id = :cmp AND mi.is_active = TRUE AND mi.availability <> 'AVAILABLE'{$locationFilter}
             ORDER BY mi.availability_set_at DESC NULLS LAST, mi.display_name
             LIMIT 15",
            $params,
        );

        return [
            'total'       => (int) ($summary['total'] ?? 0),
            'available'   => (int) ($summary['available'] ?? 0),
            'unavailable' => (int) ($summary['unavailable'] ?? 0),
            'items'       => array_map(static fn (array $r): array => [
                'menu_item_id' => (int) $r['menu_item_id'],
                'display_name' => (string) $r['display_name'],
                'availability' => (string) $r['availability'],
                'note'         => $r['availability_note'] === null ? null : (string) $r['availability_note'],
                'set_at'       => $r['availability_set_at'] === null ? null : (string) $r['availability_set_at'],
                'item_id'      => $r['item_id'] === null ? null : (int) $r['item_id'],
                'menu_price'   => $r['menu_price'] === null ? null : (float) $r['menu_price'],
            ], $rows),
            'note' => 'Availability is the kitchen saying an item is finished. It is set by a person, not by a stock figure.',
        ];
    }

    /**
     * Tickets past their station's threshold, worst first.
     *
     * @return array<string, mixed>
     */
    private function delays(): array
    {
        $params = ['cmp' => $this->win->ctx->cmpId];
        $locationFilter = $this->win->locationId === null ? '' : ' AND k.location_id = :loc';
        if ($this->win->locationId !== null) {
            $params['loc'] = $this->win->locationId;
        }

        $rows = Db::all(
            "SELECT k.kot_id, k.kot_no, k.status, k.fired_at, k.priority,
                    st.station_name, COALESCE(st.late_after_minutes, 15) AS late_after,
                    tb.table_code, c.order_kind,
                    EXTRACT(EPOCH FROM (NOW() - k.fired_at))::bigint AS elapsed_seconds
             FROM pos_kots k
             LEFT JOIN pos_kds_stations st ON st.station_id = k.station_id
             LEFT JOIN pos_table_sessions ts ON ts.table_session_id = k.table_session_id
             LEFT JOIN pos_tables tb ON tb.table_id = ts.table_id
             LEFT JOIN pos_carts c ON c.cart_id = k.cart_id
             WHERE k.cmp_id = :cmp AND k.status IN ('NEW', 'ACCEPTED', 'PREPARING')
               AND k.fired_at < NOW() - (COALESCE(st.late_after_minutes, 15) || ' minutes')::interval{$locationFilter}
             ORDER BY k.fired_at ASC
             LIMIT 15",
            $params,
        );

        return [
            'kind'  => 'rule',
            'note'  => 'A ticket is late when it has been out longer than its own station allows. A timer, not a prediction.',
            'items' => array_map(static function (array $r): array {
                $elapsed = (int) $r['elapsed_seconds'];
                $late    = (int) $r['late_after'] * 60;

                return [
                    'kot_id'       => (int) $r['kot_id'],
                    'kot_no'       => (string) $r['kot_no'],
                    'status'       => (string) $r['status'],
                    'priority'     => (string) $r['priority'],
                    'station_name' => $r['station_name'] === null ? 'Unassigned' : (string) $r['station_name'],
                    'table_code'   => $r['table_code'] === null ? null : (string) $r['table_code'],
                    'order_kind'   => $r['order_kind'] === null ? 'dine_in' : (string) $r['order_kind'],
                    'elapsed_seconds'    => $elapsed,
                    'late_after_seconds' => $late,
                    'overdue_by_seconds' => max(0, $elapsed - $late),
                ];
            }, $rows),
        ];
    }
}
