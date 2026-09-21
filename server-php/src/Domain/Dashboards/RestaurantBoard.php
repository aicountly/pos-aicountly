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
    /**
     * Aggregates more than one panel reads, computed once.
     *
     * The KPI row, the order flow and the served figure are three views of one
     * count over pos_kots. Three separate passes could straddle a write and
     * disagree, which on this board reads as the kitchen gaining a ticket
     * between two cards on the same screen.
     *
     * @var array<string, mixed>
     */
    private array $memo = [];

    public function __construct(private readonly Window $win)
    {
    }

    /** @return array<string, mixed> */
    public function build(): array
    {
        return [
            'window'    => $this->win->describe(),
            'kpis'      => $this->kpis(),
            'service'   => $this->service(),
            'flow'      => $this->flow(),
            'sales'     => $this->sales(),
            'serve'     => $this->serveTime(),
            'rating'    => $this->rating(),
            'orders'    => $this->orders(),
            'floors'    => $this->floors(),
            'kitchen'   => $this->kitchen(),
            'channels'  => $this->channels(),
            'menu'      => $this->menuAvailability(),
            'delays'    => $this->delays(),
            'setup'     => $this->setup(),
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

        $tickets = $this->tickets();

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
            'tickets_pending'  => $tickets['queued'] + $tickets['preparing'],
            'tickets_overdue'  => $tickets['overdue'],
            'orders_ready'     => $tickets['ready'],
            'tickets_served'   => $tickets['served'],
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
        $rows = $this->channelRows();

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

    // -----------------------------------------------------------------------
    // The command-centre figures
    // -----------------------------------------------------------------------

    /**
     * Ticket counts by state, and what went out inside the window.
     *
     * One pass over pos_kots. Three panels read it — the KPI row, the order
     * flow and the served figure — and computing it three times is how a
     * screen ends up showing four tickets in the kitchen next to a flow that
     * says five.
     *
     * @return array{queued:int, preparing:int, ready:int, overdue:int, served:int}
     */
    private function tickets(): array
    {
        if (isset($this->memo['tickets'])) {
            return $this->memo['tickets'];
        }

        $params = [
            'cmp'      => $this->win->ctx->cmpId,
            'win_from' => $this->win->startsAt,
            'win_to'   => $this->win->endsAt,
        ];
        $locationFilter = '';
        if ($this->win->locationId !== null) {
            $locationFilter = ' AND k.location_id = :loc';
            $params['loc'] = $this->win->locationId;
        }

        $row = Db::first(
            "SELECT COUNT(*) FILTER (WHERE k.status IN ('NEW', 'ACCEPTED'))   AS queued,
                    COUNT(*) FILTER (WHERE k.status = 'PREPARING')            AS preparing,
                    COUNT(*) FILTER (WHERE k.status = 'READY')                AS ready,
                    COUNT(*) FILTER (
                        WHERE k.status IN ('NEW', 'ACCEPTED', 'PREPARING')
                          AND k.fired_at < NOW() - (COALESCE(st.late_after_minutes, 15) || ' minutes')::interval
                    ) AS overdue,
                    COUNT(*) FILTER (WHERE k.status = 'SERVED')               AS served
             FROM pos_kots k
             LEFT JOIN pos_kds_stations st ON st.station_id = k.station_id
             WHERE k.cmp_id = :cmp
               AND (
                     k.status IN ('NEW', 'ACCEPTED', 'PREPARING', 'READY')
                     OR (k.status = 'SERVED' AND k.served_at >= :win_from AND k.served_at < :win_to)
                   ){$locationFilter}",
            $params,
        ) ?? [];

        return $this->memo['tickets'] = [
            'queued'    => (int) ($row['queued'] ?? 0),
            'preparing' => (int) ($row['preparing'] ?? 0),
            'ready'     => (int) ($row['ready'] ?? 0),
            'overdue'   => (int) ($row['overdue'] ?? 0),
            'served'    => (int) ($row['served'] ?? 0),
        ];
    }

    /**
     * Restaurant orders by channel in the window, computed once.
     *
     * Both the channel breakdown and the takings figure are this one group-by,
     * so it is run once and summed rather than queried twice under two names.
     *
     * @return list<array<string, mixed>>
     */
    private function channelRows(): array
    {
        if (isset($this->memo['channel_rows'])) {
            return $this->memo['channel_rows'];
        }

        [$where, $params] = $this->win->clause('c');
        [$where, $params] = $this->win->narrow($where, $params, 'c');

        return $this->memo['channel_rows'] = Db::all(
            "SELECT c.order_kind, COUNT(*) AS orders, COALESCE(SUM(c.total_amount), 0) AS net
             FROM pos_carts c
             WHERE {$where} AND c.status = 'COMPLETED' AND c.order_kind <> 'retail'
             GROUP BY c.order_kind ORDER BY COUNT(*) DESC",
            $params,
        );
    }

    /**
     * Whether the restaurant is serving, read from the tills.
     *
     * There is no open/closed switch in this product and this does not invent
     * one: a shift being open on a till at this outlet IS the restaurant being
     * open, and `changeable` is false so the screen renders it as a state
     * rather than as a control that would do nothing.
     *
     * @return array<string, mixed>
     */
    private function service(): array
    {
        if (isset($this->memo['service'])) {
            return $this->memo['service'];
        }

        [$where, $params] = $this->win->terminalScope('t');

        $row = Db::first(
            "SELECT COUNT(*) AS open_shifts, MIN(rs.opened_at) AS since
             FROM pos_register_sessions rs
             JOIN pos_terminals t ON t.terminal_id = rs.terminal_id
             WHERE rs.cmp_id = :rs_cmp AND rs.status IN ('OPEN', 'CLOSING') AND {$where}",
            $params + ['rs_cmp' => $this->win->ctx->cmpId],
        ) ?? [];

        $open = (int) ($row['open_shifts'] ?? 0);

        return $this->memo['service'] = [
            'state'       => $open > 0 ? 'open' : 'closed',
            'label'       => $open > 0 ? 'Open' : 'Closed',
            'open_shifts' => $open,
            'since'       => $open > 0 && $row['since'] !== null ? (string) $row['since'] : null,
            'changeable'  => false,
            'note'        => $open > 0
                ? 'Open because a till here has a shift open. POS has no separate service switch — closing the last shift closes the restaurant.'
                : 'No till at this outlet has a shift open. Open one to start taking money; the floor can still be seated without it.',
        ];
    }

    /**
     * The journey a ticket takes, as four counts.
     *
     * Received, In the kitchen and Ready are LIVE: a ticket resting in that
     * state right now, whatever the date filter says. Served is the only
     * windowed figure of the four, because being served is an event and not a
     * state a ticket sits in. The screen labels which is which — a row of four
     * numbers where one of them means something different is a trap.
     *
     * @return array<string, mixed>
     */
    private function flow(): array
    {
        $tickets = $this->tickets();

        return [
            'stages' => [
                ['key' => 'received',   'label' => 'Received',       'count' => $tickets['queued'],    'basis' => 'live'],
                ['key' => 'in_kitchen', 'label' => 'In kitchen',     'count' => $tickets['preparing'], 'basis' => 'live'],
                ['key' => 'ready',      'label' => 'Ready',          'count' => $tickets['ready'],     'basis' => 'live'],
                ['key' => 'served',     'label' => 'Served',         'count' => $tickets['served'],    'basis' => 'window'],
            ],
            'overdue' => $tickets['overdue'],
            'note'    => 'Received, in the kitchen and ready are live counts of tickets out now. Served is what went out inside the chosen period.',
        ];
    }

    /**
     * What the restaurant took, against the period immediately before it.
     *
     * The comparison is computed here rather than from the `compare` filter
     * because this board deliberately has no comparison control: it is a live
     * operations screen, and a takings figure with nothing beside it says how
     * big the number is but not whether the service is going well.
     *
     * @return array<string, mixed>
     */
    private function sales(): array
    {
        $orders = 0;
        $net    = 0.0;
        foreach ($this->channelRows() as $row) {
            $orders += (int) $row['orders'];
            $net    += (float) $row['net'];
        }

        [$prevFrom, $prevTo, $label] = $this->precedingWindow();

        [$where, $params] = $this->win->clause('c', false);
        $where .= ' AND c.created_at >= :prev_from AND c.created_at < :prev_to';
        $params['prev_from'] = $prevFrom;
        $params['prev_to']   = $prevTo;
        [$where, $params] = $this->win->narrow($where, $params, 'c');

        $previous = Db::first(
            "SELECT COUNT(*) AS orders, COALESCE(SUM(c.total_amount), 0) AS net
             FROM pos_carts c
             WHERE {$where} AND c.status = 'COMPLETED' AND c.order_kind <> 'retail'",
            $params,
        ) ?? [];

        $previousNet = (float) ($previous['net'] ?? 0);

        return [
            'orders'        => $orders,
            'net'           => round($net, 2),
            'average_order' => $orders > 0 ? round($net / $orders, 2) : null,
            'previous'      => [
                'label'  => $label,
                'orders' => (int) ($previous['orders'] ?? 0),
                'net'    => round($previousNet, 2),
            ],
            // Null rather than a percentage against nothing: "up ∞%" is not a
            // fact about a restaurant.
            'change_pc' => $previousNet > 0 ? round((($net - $previousNet) / $previousNet) * 100, 1) : null,
            'basis'     => 'Settled restaurant orders counted on this POS. Retail bills are not in it, and Books owns the accounting figure.',
        ];
    }

    /**
     * How long a ticket took, fired to served.
     *
     * Only tickets that were actually marked served are in it. A kitchen that
     * never presses Served has NO figure here rather than a flattering one
     * built from the few that were, which is why `available` is a separate
     * field from a zero.
     *
     * @return array<string, mixed>
     */
    private function serveTime(): array
    {
        $current = $this->servedSample($this->win->startsAt, $this->win->endsAt);
        [$prevFrom, $prevTo, $label] = $this->precedingWindow();
        $previous = $this->servedSample($prevFrom, $prevTo);

        $change = null;
        if ($current['average_seconds'] !== null && $previous['average_seconds'] !== null && $previous['average_seconds'] > 0) {
            $change = round(
                (($current['average_seconds'] - $previous['average_seconds']) / $previous['average_seconds']) * 100,
                1,
            );
        }

        return [
            'available'       => $current['sampled'] > 0,
            'reason'          => $current['sampled'] > 0 ? null : 'nothing_served',
            'average_seconds' => $current['average_seconds'],
            'sampled'         => $current['sampled'],
            'previous'        => [
                'label'           => $label,
                'average_seconds' => $previous['average_seconds'],
                'sampled'         => $previous['sampled'],
            ],
            'change_pc' => $change,
            'basis'     => 'Measured on this POS from the moment a ticket was fired to the kitchen to the moment it was marked served.',
            'note'      => 'Counted over tickets marked served in this period. Tickets the kitchen never marked are not in it, so the sample size is shown beside the figure.',
        ];
    }

    /**
     * @return array{sampled:int, average_seconds:?int}
     */
    private function servedSample(string $from, string $to): array
    {
        $params = ['cmp' => $this->win->ctx->cmpId, 'from' => $from, 'to' => $to];
        $locationFilter = '';
        if ($this->win->locationId !== null) {
            $locationFilter = ' AND k.location_id = :loc';
            $params['loc'] = $this->win->locationId;
        }

        $row = Db::first(
            "SELECT COUNT(*) AS sampled,
                    AVG(EXTRACT(EPOCH FROM (k.served_at - k.fired_at))) AS average_seconds
             FROM pos_kots k
             WHERE k.cmp_id = :cmp AND k.status = 'SERVED'
               AND k.served_at IS NOT NULL AND k.served_at > k.fired_at
               AND k.served_at >= :from AND k.served_at < :to{$locationFilter}",
            $params,
        ) ?? [];

        $sampled = (int) ($row['sampled'] ?? 0);

        return [
            'sampled'         => $sampled,
            'average_seconds' => $sampled > 0 && $row['average_seconds'] !== null
                ? (int) round((float) $row['average_seconds'])
                : null,
        ];
    }

    /**
     * Guest satisfaction, which this product does not collect.
     *
     * Deliberately not a zero and not a placeholder score. There is no review,
     * no rating and no survey anywhere in POS, and none is read from another
     * product, so any number under this heading would be invented.
     *
     * @return array<string, mixed>
     */
    private function rating(): array
    {
        return [
            'available'    => false,
            'reason'       => 'not_implemented',
            'note'         => 'POS collects no guest feedback. There is no rating, review or survey in this product and none is read from another, so there is no score to show.',
            'contract_gap' => 'A feedback capture POS can count — a prompt on the bill or a rating written back by an ordering channel — giving a score per settled order.',
        ];
    }

    /**
     * The orders on the board right now, and what has just gone out.
     *
     * OPEN ORDERS ARE NOT WINDOWED. An order on the floor is open whatever the
     * date filter says, and a screen that hid last night's unsettled table
     * because the filter says today would hide the one thing a manager most
     * needs to see. Settled orders are windowed, because those are history.
     *
     * The status is DERIVED from the order's own tickets rather than stored, so
     * there is no second column to go stale against pos_kots.
     *
     * @return array<string, mixed>
     */
    private function orders(): array
    {
        [$where, $params] = $this->win->clause('c', false);
        $where .= " AND c.order_kind <> 'retail'
                    AND (c.status IN ('OPEN', 'HELD') OR (c.created_at >= :win_from AND c.created_at < :win_to))";
        $params['win_from'] = $this->win->startsAt;
        $params['win_to']   = $this->win->endsAt;
        [$where, $params] = $this->win->narrow($where, $params, 'c');
        $params['k_cmp'] = $this->win->ctx->cmpId;
        $params['l_cmp'] = $this->win->ctx->cmpId;

        $rows = Db::all(
            "SELECT c.cart_id, c.cart_uuid, c.status, c.order_kind, c.token_no, c.total_amount,
                    c.customer_name, c.created_at, c.table_session_id,
                    tb.table_code,
                    COALESCE(li.items, 0)      AS item_count,
                    COALESCE(kk.tickets, 0)    AS tickets,
                    COALESCE(kk.queued, 0)     AS queued,
                    COALESCE(kk.preparing, 0)  AS preparing,
                    COALESCE(kk.ready, 0)      AS ready,
                    COALESCE(kk.served, 0)     AS served,
                    COALESCE(kk.late, 0)       AS late,
                    EXTRACT(EPOCH FROM (NOW() - c.created_at))::bigint      AS running_seconds,
                    EXTRACT(EPOCH FROM (c.updated_at - c.created_at))::bigint AS settled_seconds
             FROM pos_carts c
             LEFT JOIN pos_table_sessions ts ON ts.table_session_id = c.table_session_id
             LEFT JOIN pos_tables tb ON tb.table_id = ts.table_id
             LEFT JOIN (
                 SELECT cl.cart_id, COUNT(*) AS items
                 FROM pos_cart_lines cl
                 WHERE cl.cmp_id = :l_cmp
                 GROUP BY cl.cart_id
             ) li ON li.cart_id = c.cart_id
             LEFT JOIN (
                 SELECT k.cart_id,
                        COUNT(*) FILTER (WHERE k.status <> 'CANCELLED')        AS tickets,
                        COUNT(*) FILTER (WHERE k.status IN ('NEW', 'ACCEPTED')) AS queued,
                        COUNT(*) FILTER (WHERE k.status = 'PREPARING')          AS preparing,
                        COUNT(*) FILTER (WHERE k.status = 'READY')              AS ready,
                        COUNT(*) FILTER (WHERE k.status = 'SERVED')             AS served,
                        COUNT(*) FILTER (
                            WHERE k.status IN ('NEW', 'ACCEPTED', 'PREPARING')
                              AND k.fired_at < NOW() - (COALESCE(st.late_after_minutes, 15) || ' minutes')::interval
                        ) AS late
                 FROM pos_kots k
                 LEFT JOIN pos_kds_stations st ON st.station_id = k.station_id
                 WHERE k.cmp_id = :k_cmp
                 GROUP BY k.cart_id
             ) kk ON kk.cart_id = c.cart_id
             WHERE {$where}
             ORDER BY (c.status IN ('OPEN', 'HELD')) DESC, c.created_at DESC
             LIMIT 12",
            $params,
        );

        return [
            'items' => array_map(static function (array $r): array {
                $settled = in_array((string) $r['status'], ['COMPLETED', 'VOID'], true);

                return [
                    'cart_id'      => (int) $r['cart_id'],
                    'cart_uuid'    => (string) $r['cart_uuid'],
                    'reference'    => $r['token_no'] === null || $r['token_no'] === ''
                        ? '#' . (int) $r['cart_id']
                        : (string) $r['token_no'],
                    'order_kind'   => (string) $r['order_kind'],
                    'table_code'   => $r['table_code'] === null ? null : (string) $r['table_code'],
                    'table_session_id' => $r['table_session_id'] === null ? null : (int) $r['table_session_id'],
                    'customer_name' => $r['customer_name'] === null ? null : (string) $r['customer_name'],
                    'item_count'   => (int) $r['item_count'],
                    'total_amount' => (float) $r['total_amount'],
                    'cart_status'  => (string) $r['status'],
                    'state'        => self::orderState($r),
                    'late'         => (int) $r['late'] > 0,
                    'tickets'      => (int) $r['tickets'],
                    'created_at'   => (string) $r['created_at'],
                    // Two different clocks, named: how long this order has been
                    // running, or how long it took. Showing both as one unlabelled
                    // "18 min" is how a served order reads as a late one.
                    'elapsed_seconds' => $settled ? max(0, (int) $r['settled_seconds']) : max(0, (int) $r['running_seconds']),
                    'elapsed_basis'   => $settled ? 'took' : 'running',
                ];
            }, $rows),
            'note' => 'Open orders are listed whatever the date filter says — an order on the floor is open until it is settled. Settled orders are the ones inside the period.',
        ];
    }

    /**
     * Where an order has got to, derived from its own tickets.
     *
     * Order matters: late beats everything, because a manager reading this list
     * is looking for the table to walk over to.
     *
     * @param array<string, mixed> $r
     */
    private static function orderState(array $r): string
    {
        $status = (string) $r['status'];
        if ($status === 'VOID') {
            return 'cancelled';
        }
        if ($status === 'COMPLETED') {
            return 'paid';
        }

        if ((int) $r['late'] > 0) {
            return 'delayed';
        }
        if ((int) $r['preparing'] > 0 || (int) $r['queued'] > 0) {
            return 'in_kitchen';
        }
        if ((int) $r['ready'] > 0) {
            return 'ready';
        }
        if ((int) $r['tickets'] > 0 && (int) $r['served'] === (int) $r['tickets']) {
            return 'served';
        }

        // Nothing has been fired to the kitchen yet: the party is seated and
        // ordering, or the bill is waiting to be settled.
        return (int) $r['item_count'] > 0 ? 'placed' : 'seated';
    }

    /**
     * How much of the restaurant module is actually configured.
     *
     * Read so the screen can tell "this restaurant is quiet" apart from "no
     * restaurant has been set up here", which are the same zeroes and entirely
     * different problems.
     *
     * @return array<string, mixed>
     */
    private function setup(): array
    {
        $params = ['cmp' => $this->win->ctx->cmpId];
        $outletFilter = '';
        $floorFilter  = '';
        $menuFilter   = '';
        $stationFilter = '';
        if ($this->win->locationId !== null) {
            $params['loc']  = $this->win->locationId;
            $outletFilter   = ' AND lp.location_id = :loc';
            $floorFilter    = ' AND f.location_id = :loc';
            $menuFilter     = ' AND mi.location_id = :loc';
            $stationFilter  = ' AND st.location_id = :loc';
        }

        $row = Db::first(
            "SELECT
                (SELECT COUNT(*) FROM pos_location_profiles lp
                  WHERE lp.cmp_id = :cmp AND lp.is_active = TRUE
                    AND lp.pos_mode IN ('restaurant', 'quick_service', 'hybrid'){$outletFilter}) AS outlets,
                (SELECT COUNT(*) FROM pos_floors f
                  WHERE f.cmp_id = :cmp AND f.is_active = TRUE{$floorFilter}) AS floors,
                (SELECT COUNT(*) FROM pos_tables tb
                  JOIN pos_floors f ON f.floor_id = tb.floor_id AND f.is_active = TRUE
                  WHERE tb.cmp_id = :cmp AND tb.is_active = TRUE{$floorFilter}) AS tables,
                (SELECT COUNT(*) FROM pos_kds_stations st
                  WHERE st.cmp_id = :cmp AND st.is_active = TRUE{$stationFilter}) AS stations,
                (SELECT COUNT(*) FROM pos_menu_items mi
                  WHERE mi.cmp_id = :cmp AND mi.is_active = TRUE{$menuFilter}) AS menu_items",
            $params,
        ) ?? [];

        $steps = [
            ['key' => 'outlet',   'label' => 'A restaurant outlet',   'count' => (int) ($row['outlets'] ?? 0),    'done' => (int) ($row['outlets'] ?? 0) > 0],
            ['key' => 'floors',   'label' => 'Floors or zones',       'count' => (int) ($row['floors'] ?? 0),     'done' => (int) ($row['floors'] ?? 0) > 0],
            ['key' => 'tables',   'label' => 'Tables on those floors', 'count' => (int) ($row['tables'] ?? 0),    'done' => (int) ($row['tables'] ?? 0) > 0],
            ['key' => 'stations', 'label' => 'Kitchen stations',      'count' => (int) ($row['stations'] ?? 0),   'done' => (int) ($row['stations'] ?? 0) > 0],
            ['key' => 'menu',     'label' => 'Menu items',            'count' => (int) ($row['menu_items'] ?? 0), 'done' => (int) ($row['menu_items'] ?? 0) > 0],
            ['key' => 'shift',    'label' => 'A shift open on a till', 'count' => $this->service()['open_shifts'], 'done' => $this->service()['open_shifts'] > 0],
        ];

        $done = 0;
        foreach ($steps as $step) {
            if ($step['done']) {
                ++$done;
            }
        }

        return [
            // "Nothing has been set up" is not "nothing happened today". The
            // screen shows an onboarding checklist for the first and an empty
            // service for the second.
            'configured' => (int) ($row['tables'] ?? 0) > 0 || (int) ($row['menu_items'] ?? 0) > 0,
            'steps'      => $steps,
            'done'       => $done,
            'total'      => count($steps),
        ];
    }

    /**
     * The window of the same length immediately before this one.
     *
     * @return array{0:string, 1:string, 2:string}
     */
    private function precedingWindow(): array
    {
        $start = new \DateTimeImmutable($this->win->startsAt, new \DateTimeZone('UTC'));
        $end   = new \DateTimeImmutable($this->win->endsAt, new \DateTimeZone('UTC'));
        $span  = max(1, $end->getTimestamp() - $start->getTimestamp());

        $days  = (int) round($span / 86400);
        $label = $days <= 1 ? 'vs the day before' : 'vs the previous ' . $days . ' days';

        return [
            $start->modify('-' . $span . ' seconds')->format('Y-m-d H:i:s'),
            $start->format('Y-m-d H:i:s'),
            $label,
        ];
    }
}
