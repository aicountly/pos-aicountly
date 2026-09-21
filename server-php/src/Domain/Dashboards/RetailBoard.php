<?php

declare(strict_types=1);

namespace Aicountly\Api\Domain\Dashboards;

use Aicountly\Api\Clients\InventoryClient;
use Aicountly\Api\Db;
use Aicountly\Api\IntegrationCommand;

/**
 * Retail Operations — the counters, and what is between a cashier and the next
 * customer.
 *
 * Two rules this board follows that a POS dashboard usually breaks:
 *
 * NO QUEUE LENGTHS. Nothing in this product observes a queue. There is no
 * camera, no ticket dispenser, no door counter, so there is no honest "3 people
 * waiting" figure and none is shown.
 *
 * NO "CONNECTED" DEVICES. A browser cannot ask whether a receipt printer has
 * paper. What POS knows is what someone CONFIGURED on the terminal and, for a
 * registered device, whether a token was ever issued and revoked. Those are
 * reported as configuration, explicitly "not verified", and a green dot is
 * never drawn from a configuration row.
 *
 * Checkout duration IS shown, because it is measured from this product's own
 * two timestamps — the cart opening and the cart completing — and the basis is
 * printed next to it.
 */
final class RetailBoard
{
    /**
     * The exception counts, which the KPI row and the attention panel both read.
     * Computing them twice is three needless passes over the approval trail.
     *
     * @var array<string, mixed>|null
     */
    private ?array $exceptionsMemo = null;

    /**
     * Everything one panel computes that another panel also needs.
     *
     * The alerts list reads the counters, the stock answer and the exception
     * counts; the readiness ring reads the counters again; the pulse strip
     * reads the alerts. Without this, one render of this board would run the
     * counter query four times and call Inventory twice.
     *
     * @var array<string, mixed>
     */
    private array $memo = [];

    public function __construct(private readonly Window $win)
    {
    }

    /** @param callable():mixed $compute */
    private function once(string $key, callable $compute): mixed
    {
        if (!array_key_exists($key, $this->memo)) {
            $this->memo[$key] = $compute();
        }

        return $this->memo[$key];
    }

    /** @return array<string, mixed> */
    public function build(): array
    {
        return [
            'window'          => $this->win->describe(),
            'kpis'            => $this->kpis(),
            'comparison'      => $this->comparison(),
            'trend'           => $this->trend(),
            'counters'        => $this->counters(),
            'checkout_health' => $this->checkoutHealth(),
            'categories'      => $this->topCategories(),
            'alerts'          => $this->alerts(),
            'readiness'       => $this->shiftReadiness(),
            'pulse'           => $this->pulse(),
            'held_bills'      => $this->heldBills(),
            'recent'          => $this->recentTransactions(),
            'devices'         => $this->devices(),
            'stock'           => $this->stockAttention(),
            'attention'       => $this->exceptions(),
        ];
    }

    /** @return array<string, mixed> */
    private function kpis(): array
    {
        return $this->once('kpis', fn (): array => $this->computeKpis());
    }

    /** @return array<string, mixed> */
    private function computeKpis(): array
    {
        [$tScope, $tParams] = $this->win->terminalScope('t');
        $counters = Db::first(
            "SELECT COUNT(*) AS tills,
                    COUNT(*) FILTER (WHERE s.session_id IS NOT NULL) AS active
             FROM pos_terminals t
             LEFT JOIN pos_register_sessions s
               ON s.terminal_id = t.terminal_id AND s.cmp_id = t.cmp_id AND s.status IN ('OPEN', 'CLOSING')
             WHERE {$tScope} AND t.is_active = TRUE",
            $tParams,
        ) ?? [];

        [$where, $params] = $this->win->clause('c');
        [$where, $params] = $this->win->narrow($where, $params, 'c');
        [$where, $params] = $this->mineOnly($where, $params);

        $sales = Db::first(
            "SELECT COUNT(*) AS bills, COALESCE(SUM(c.total_amount), 0) AS net
             FROM pos_carts c WHERE {$where} AND c.status = 'COMPLETED'",
            $params,
        ) ?? [];

        // Held bills are not windowed: a bill held on Tuesday is still on the
        // counter on Wednesday, and hiding it because the date filter moved is
        // how a held bill becomes a lost one.
        [$heldWhere, $heldParams] = $this->win->clause('c', false);
        [$heldWhere, $heldParams] = $this->win->narrow($heldWhere, $heldParams, 'c');
        $held = Db::first(
            "SELECT COUNT(*) AS bills, COALESCE(SUM(c.total_amount), 0) AS value
             FROM pos_carts c WHERE {$heldWhere} AND c.status = 'HELD'",
            $heldParams,
        ) ?? [];

        return [
            'active_counters' => (int) ($counters['active'] ?? 0),
            'total_counters'  => (int) ($counters['tills'] ?? 0),
            'bills'           => (int) ($sales['bills'] ?? 0),
            'net'             => (float) ($sales['net'] ?? 0),
            'held_bills'      => (int) ($held['bills'] ?? 0),
            'held_value'      => (float) ($held['value'] ?? 0),
            'checkout'        => $this->checkoutDuration(),
            'exceptions'      => $this->exceptionCount(),
            // The part of the headline count that IS windowed, so a trend
            // badge can compare it against the same measure over the
            // comparison window. `exceptions` also carries sales stuck on
            // every date, which has no previous value to compare with.
            'exceptions_windowed' => $this->windowedExceptionCount(),
        ];
    }

    /**
     * Median seconds from opening a cart to completing it.
     *
     * Median, not mean: one cart left open over lunch would drag an average
     * into uselessness. Only carts opened AND completed inside the window count,
     * so a bill that straddles the boundary does not produce a nonsense figure.
     *
     * THE ONE-SECOND FLOOR is not arbitrary. `created_at` is written by
     * PostgreSQL at microsecond precision and `updated_at` by PHP at second
     * precision, so their difference is meaningless below a second and can even
     * come out negative on a fast write. Nobody scans, tenders and closes a real
     * sale inside a second, so excluding those rows costs no real checkouts and
     * removes every artefact. The basis line on the card says so.
     *
     * @return array<string, mixed>
     */
    private function checkoutDuration(): array
    {
        return $this->once('checkout', fn (): array => $this->computeCheckoutDuration());
    }

    /** @return array<string, mixed> */
    private function computeCheckoutDuration(): array
    {
        [$where, $params] = $this->win->clause('c');
        [$where, $params] = $this->win->narrow($where, $params, 'c');

        $row = Db::first(
            "SELECT COUNT(*) AS sampled,
                    PERCENTILE_CONT(0.5) WITHIN GROUP (
                        ORDER BY EXTRACT(EPOCH FROM (c.updated_at - c.created_at))
                    ) AS median_seconds
             FROM pos_carts c
             WHERE {$where} AND c.status = 'COMPLETED'
               AND c.updated_at >= c.created_at + INTERVAL '1 second'
               AND c.offline_created = FALSE",
            $params,
        ) ?? [];

        $sampled = (int) ($row['sampled'] ?? 0);
        if ($sampled === 0) {
            return [
                'available' => false,
                'reason'    => 'not_measurable',
                'note'      => 'No completed bill in this window has a measurable duration. Nothing is inferred from that.',
            ];
        }

        return [
            'available'      => true,
            'median_seconds' => (int) round((float) ($row['median_seconds'] ?? 0)),
            'sampled'        => $sampled,
            'basis'          => 'Median time from the cart being opened to it being completed, on this POS. '
                . 'Sales uploaded from a till that was offline are excluded, because their timestamps are the device\'s, '
                . 'and so are bills recorded in under a second, whose timestamps are not precise enough to mean anything.',
        ];
    }

    /**
     * One card per till.
     *
     * @return list<array<string, mixed>>
     */
    private function counters(): array
    {
        return $this->once('counters', fn (): array => $this->computeCounters());
    }

    /** @return list<array<string, mixed>> */
    private function computeCounters(): array
    {
        [$tScope, $params] = $this->win->terminalScope('t');
        $params['win_from'] = $this->win->startsAt;
        $params['win_to']   = $this->win->endsAt;

        $mine = '';
        if (!$this->win->seesEveryone) {
            $mine = ' AND (s.opened_by = :me OR s.session_id IS NULL)';
            $params['me'] = $this->win->auth->uuid;
        }

        $rows = Db::all(
            "SELECT t.terminal_id, t.terminal_code, t.display_name, t.terminal_kind, t.is_active,
                    t.receipt_printer,
                    t.location_id, l.display_name AS location_name, l.location_code, l.pos_mode,
                    s.session_id, s.status AS shift_status, s.opened_by, s.opened_at, s.expected_cash,
                    s.opening_float,
                    (SELECT COUNT(*) FROM pos_device_registrations d
                      WHERE d.cmp_id = t.cmp_id AND d.terminal_id = t.terminal_id AND d.status = 'ACTIVE') AS active_devices,
                    (SELECT COUNT(*) FROM pos_carts c
                      WHERE c.cmp_id = t.cmp_id AND c.terminal_id = t.terminal_id AND c.status = 'COMPLETED'
                        AND c.created_at >= :win_from AND c.created_at < :win_to) AS bills,
                    (SELECT COALESCE(SUM(c.total_amount), 0) FROM pos_carts c
                      WHERE c.cmp_id = t.cmp_id AND c.terminal_id = t.terminal_id AND c.status = 'COMPLETED'
                        AND c.created_at >= :win_from AND c.created_at < :win_to) AS net,
                    (SELECT COUNT(*) FROM pos_carts c
                      WHERE c.cmp_id = t.cmp_id AND c.terminal_id = t.terminal_id AND c.status IN ('OPEN', 'HELD')) AS open_carts,
                    (SELECT COUNT(*) FROM pos_carts c
                      WHERE c.cmp_id = t.cmp_id AND c.terminal_id = t.terminal_id AND c.status = 'VOID'
                        AND c.created_at >= :win_from AND c.created_at < :win_to) AS voids,
                    (SELECT MAX(c.created_at) FROM pos_carts c
                      WHERE c.cmp_id = t.cmp_id AND c.terminal_id = t.terminal_id AND c.status = 'COMPLETED'
                        AND c.created_at >= :win_from AND c.created_at < :win_to) AS last_bill,
                    (SELECT MAX(c.updated_at) FROM pos_carts c
                      WHERE c.cmp_id = t.cmp_id AND c.terminal_id = t.terminal_id) AS last_activity
             FROM pos_terminals t
             JOIN pos_location_profiles l ON l.location_id = t.location_id
             LEFT JOIN pos_register_sessions s
               ON s.terminal_id = t.terminal_id AND s.cmp_id = t.cmp_id AND s.status IN ('OPEN', 'CLOSING')
             WHERE {$tScope} AND t.is_active = TRUE{$mine}
             ORDER BY l.location_code, t.terminal_code",
            $params,
        );

        // The live portion of the window. A window that ended yesterday has no
        // "idle right now", and rate-per-hour over a closed day is the whole
        // day, not the time since the shift opened.
        $now         = time();
        $windowStart = self::epoch($this->win->startsAt);
        $windowEnd   = min($now, self::epoch($this->win->endsAt));
        $live        = $windowEnd >= $now - 60;

        return array_map(static function (array $r) use ($windowStart, $windowEnd, $live): array {
            $shift = $r['session_id'] === null ? null : [
                'session_id'    => (int) $r['session_id'],
                'status'        => (string) $r['shift_status'],
                'opened_by'     => (string) $r['opened_by'],
                'opened_at'     => (string) $r['opened_at'],
                'expected_cash' => (float) $r['expected_cash'],
                'opening_float' => (float) $r['opening_float'],
            ];

            $bills    = (int) $r['bills'];
            $lastBill = $r['last_bill'] === null ? null : (string) $r['last_bill'];

            return [
                'terminal_id'   => (int) $r['terminal_id'],
                'terminal_code' => (string) $r['terminal_code'],
                'display_name'  => $r['display_name'] === null ? (string) $r['terminal_code'] : (string) $r['display_name'],
                'terminal_kind' => (string) $r['terminal_kind'],
                'location_id'   => (int) $r['location_id'],
                'location_name' => $r['location_name'] === null ? (string) $r['location_code'] : (string) $r['location_name'],
                'pos_mode'      => (string) $r['pos_mode'],
                'shift'         => $shift,
                'state'         => self::counterState($shift, (int) $r['open_carts'], $lastBill, $windowEnd, $live),
                'bills'         => $bills,
                'net'           => (float) $r['net'],
                'open_carts'    => (int) $r['open_carts'],
                'voids'         => (int) $r['voids'],
                'active_devices' => (int) $r['active_devices'],
                'receipt_printer' => $r['receipt_printer'] === null || $r['receipt_printer'] === ''
                    ? null : (string) $r['receipt_printer'],
                // Bills an hour over the part of this shift that falls inside
                // the window. Null under fifteen minutes of trading, because a
                // rate extrapolated from four minutes is a made-up number.
                'bills_per_hour' => self::billsPerHour($bills, $shift, $windowStart, $windowEnd),
                'last_bill'     => $lastBill,
                'last_activity' => $r['last_activity'] === null ? null : (string) $r['last_activity'],
            ];
        }, $rows);
    }

    /**
     * What this counter is doing, in the five words a supervisor uses.
     *
     * "Idle" means a till with a shift open that has not rung anything up for
     * forty-five minutes, and it is only ever said about a window that includes
     * now. There is no "offline" state: a browser that is not talking to us
     * cannot tell us so, and a till that has not checked in is indistinguishable
     * from one that is simply quiet.
     *
     * @param array<string, mixed>|null $shift
     */
    private static function counterState(?array $shift, int $openCarts, ?string $lastBill, int $windowEnd, bool $live): string
    {
        if ($shift === null) {
            return 'closed';
        }
        if ($shift['status'] === 'CLOSING') {
            return 'closing';
        }
        if ($openCarts > 0) {
            return 'busy';
        }
        if (!$live) {
            return 'open';
        }

        $since = $lastBill === null ? self::epoch((string) $shift['opened_at']) : self::epoch($lastBill);

        return $windowEnd - $since >= 45 * 60 ? 'idle' : 'open';
    }

    /** @param array<string, mixed>|null $shift */
    private static function billsPerHour(int $bills, ?array $shift, int $windowStart, int $windowEnd): ?float
    {
        if ($shift === null) {
            return null;
        }

        $from  = max(self::epoch((string) $shift['opened_at']), $windowStart);
        $hours = ($windowEnd - $from) / 3600;

        return $hours >= 0.25 ? round($bills / $hours, 1) : null;
    }

    /**
     * Bills on hold, oldest first.
     *
     * Not windowed, for the reason in kpis(). Resume is guarded server-side by
     * CartService, which is where the concurrency check belongs — two cashiers
     * pressing Resume on the same bill is a real race and it is settled by the
     * row lock, not by this list being fresh.
     *
     * @return list<array<string, mixed>>
     */
    private function heldBills(): array
    {
        [$where, $params] = $this->win->clause('c', false);
        [$where, $params] = $this->win->narrow($where, $params, 'c');

        $rows = Db::all(
            "SELECT c.cart_id, c.cart_uuid, c.hold_label, c.customer_name, c.total_amount,
                    c.updated_at, c.opened_by, c.terminal_id, t.terminal_code,
                    (SELECT COUNT(*) FROM pos_cart_lines l WHERE l.cart_id = c.cart_id) AS items,
                    EXTRACT(EPOCH FROM (NOW() - c.updated_at))::bigint AS held_seconds
             FROM pos_carts c
             LEFT JOIN pos_terminals t ON t.terminal_id = c.terminal_id
             WHERE {$where} AND c.status = 'HELD'
             ORDER BY c.updated_at ASC
             LIMIT 25",
            $params,
        );

        return array_map(static fn (array $r): array => [
            'cart_id'       => (int) $r['cart_id'],
            'cart_uuid'     => (string) $r['cart_uuid'],
            'reference'     => $r['hold_label'] === null || $r['hold_label'] === '' ? '#' . $r['cart_id'] : (string) $r['hold_label'],
            'customer_name' => $r['customer_name'] === null ? null : (string) $r['customer_name'],
            'items'         => (int) $r['items'],
            'total_amount'  => (float) $r['total_amount'],
            'held_seconds'  => (int) $r['held_seconds'],
            'terminal_id'   => $r['terminal_id'] === null ? null : (int) $r['terminal_id'],
            'terminal_code' => $r['terminal_code'] === null ? null : (string) $r['terminal_code'],
            'opened_by'     => (string) $r['opened_by'],
        ], $rows);
    }

    /**
     * The last bills through this counter, with all THREE states visible.
     *
     * Payment, Books and Inventory are separate columns because they are
     * separate facts. A sale can be paid, invoiced and not yet relieved from
     * stock; collapsing that into one tick is how a shop discovers at
     * stock-take that a week of sales never moved.
     *
     * @return list<array<string, mixed>>
     */
    private function recentTransactions(): array
    {
        [$where, $params] = $this->win->clause('c');
        [$where, $params] = $this->win->narrow($where, $params, 'c');

        $rows = Db::all(
            "SELECT c.cart_id, c.cart_uuid, c.created_at, c.customer_name, c.total_amount,
                    c.books_voucher_no, c.books_voucher_uuid, c.inventory_document_uuid,
                    c.status, c.order_kind, c.terminal_id, t.terminal_code,
                    (SELECT string_agg(DISTINCT p.payment_mode, ',') FROM pos_cart_payments p WHERE p.cart_id = c.cart_id) AS modes,
                    (SELECT k.status FROM " . IntegrationCommand::TABLE . " k
                      WHERE k.cmp_id = c.cmp_id AND k.entity_type = 'cart' AND k.entity_id = c.cart_id
                        AND k.target_service = 'books' ORDER BY k.command_id DESC LIMIT 1) AS books_command,
                    (SELECT k.status FROM " . IntegrationCommand::TABLE . " k
                      WHERE k.cmp_id = c.cmp_id AND k.entity_type = 'cart' AND k.entity_id = c.cart_id
                        AND k.target_service = 'inventory' ORDER BY k.command_id DESC LIMIT 1) AS inventory_command
             FROM pos_carts c
             LEFT JOIN pos_terminals t ON t.terminal_id = c.terminal_id
             WHERE {$where} AND c.status IN ('COMPLETED', 'VOID')
             ORDER BY c.created_at DESC
             LIMIT 25",
            $params,
        );

        return array_map(static function (array $r): array {
            $modes = $r['modes'] === null || $r['modes'] === '' ? [] : explode(',', (string) $r['modes']);
            $tenderStates = array_values(array_unique(array_map(
                static fn (string $m): string => Tenders::state($m),
                $modes,
            )));

            return [
                'cart_id'      => (int) $r['cart_id'],
                'cart_uuid'    => (string) $r['cart_uuid'],
                'created_at'   => (string) $r['created_at'],
                'customer_name' => $r['customer_name'] === null ? null : (string) $r['customer_name'],
                'terminal_id'  => $r['terminal_id'] === null ? null : (int) $r['terminal_id'],
                'terminal_code' => $r['terminal_code'] === null ? null : (string) $r['terminal_code'],
                'total_amount' => (float) $r['total_amount'],
                'status'       => (string) $r['status'],
                'order_kind'   => (string) $r['order_kind'],
                'tenders'      => array_map(static fn (string $m): string => Tenders::displayName($m), $modes),
                'tender_state' => $tenderStates === [] ? 'none'
                    : (in_array(Tenders::RECORDED, $tenderStates, true) ? Tenders::RECORDED : Tenders::COLLECTED),
                'books'        => self::integrationState($r['books_voucher_uuid'], $r['books_command']),
                'books_voucher_no' => $r['books_voucher_no'] === null ? null : (string) $r['books_voucher_no'],
                'inventory'    => self::integrationState($r['inventory_document_uuid'], $r['inventory_command']),
            ];
        }, $rows);
    }

    /**
     * What we can honestly say about one leg of a sale.
     *
     * A stored reference is proof it landed. No reference and no command means
     * nothing was attempted — not that it failed.
     */
    private static function integrationState(mixed $reference, mixed $commandStatus): string
    {
        if (is_string($reference) && $reference !== '') {
            return 'posted';
        }

        return match ((string) ($commandStatus ?? '')) {
            'FAILED'             => 'failed',
            'BLOCKED'            => 'blocked',
            'PENDING', 'POSTING' => 'in_flight',
            'COMPLETED'          => 'posted',
            default              => 'not_attempted',
        };
    }

    /**
     * Peripherals, as CONFIGURATION — never as a live connection.
     *
     * @return array<string, mixed>
     */
    private function devices(): array
    {
        [$tScope, $params] = $this->win->terminalScope('t');

        $terminals = Db::all(
            "SELECT t.terminal_id, t.terminal_code, t.display_name, t.receipt_printer,
                    t.hardware_profile, t.kot_printer_routes,
                    (SELECT COUNT(*) FROM pos_device_registrations d
                      WHERE d.cmp_id = t.cmp_id AND d.terminal_id = t.terminal_id AND d.status = 'ACTIVE') AS active_devices,
                    (SELECT COUNT(*) FROM pos_device_registrations d
                      WHERE d.cmp_id = t.cmp_id AND d.terminal_id = t.terminal_id AND d.status <> 'ACTIVE') AS revoked_devices
             FROM pos_terminals t
             WHERE {$tScope} AND t.is_active = TRUE
             ORDER BY t.terminal_code",
            $params,
        );

        return [
            // The honest framing, carried to the screen so the panel cannot be
            // read as a health monitor.
            'verification' => 'not_verified',
            'note' => 'POS reports what each till is CONFIGURED with. A browser cannot check whether a printer '
                . 'has paper or a scanner is plugged in, so nothing here is a live connection status.',
            'terminals' => array_map(static function (array $r): array {
                $hardware = Db::jsonColumn($r['hardware_profile'] ?? null);
                $routes   = Db::jsonColumn($r['kot_printer_routes'] ?? null);

                $peripherals = [];
                $peripherals[] = [
                    'kind'      => 'receipt_printer',
                    'label'     => 'Receipt printer',
                    'value'     => $r['receipt_printer'] === null || $r['receipt_printer'] === '' ? null : (string) $r['receipt_printer'],
                    'state'     => $r['receipt_printer'] === null || $r['receipt_printer'] === '' ? 'not_configured' : 'configured',
                ];
                foreach (['barcode_scanner' => 'Barcode scanner', 'cash_drawer' => 'Cash drawer', 'customer_display' => 'Customer display', 'weighing_scale' => 'Weighing scale'] as $key => $label) {
                    $value = $hardware[$key] ?? null;
                    $peripherals[] = [
                        'kind'  => $key,
                        'label' => $label,
                        'value' => is_scalar($value) && (string) $value !== '' ? (string) $value : null,
                        'state' => is_scalar($value) && (string) $value !== '' ? 'configured' : 'not_configured',
                    ];
                }
                if ($routes !== []) {
                    $peripherals[] = [
                        'kind'  => 'kot_printers',
                        'label' => 'Kitchen printers',
                        'value' => (string) count($routes) . ' route(s)',
                        'state' => 'configured',
                    ];
                }

                return [
                    'terminal_id'     => (int) $r['terminal_id'],
                    'terminal_code'   => (string) $r['terminal_code'],
                    'display_name'    => $r['display_name'] === null ? (string) $r['terminal_code'] : (string) $r['display_name'],
                    'active_devices'  => (int) $r['active_devices'],
                    'revoked_devices' => (int) $r['revoked_devices'],
                    'peripherals'     => $peripherals,
                ];
            }, $terminals),
        ];
    }

    /**
     * Low stock, live from Inventory.
     *
     * An unreachable Inventory is reported as unreachable. It is NEVER reported
     * as "nothing is low", which is what an empty list would say, and which
     * would have a shop stop reordering on the strength of a timeout.
     *
     * @return array<string, mixed>
     */
    private function stockAttention(): array
    {
        return $this->once('stock', fn (): array => $this->computeStockAttention());
    }

    /** @return array<string, mixed> */
    private function computeStockAttention(): array
    {
        $warehouseId = null;
        if ($this->win->locationId !== null) {
            $raw = Db::scalar(
                'SELECT default_warehouse_id FROM pos_location_profiles WHERE location_id = :id AND cmp_id = :cmp',
                ['id' => $this->win->locationId, 'cmp' => $this->win->ctx->cmpId],
            );
            $warehouseId = $raw === null || $raw === false ? null : (int) $raw;
        }

        $response = (new InventoryClient())
            ->withSession($this->win->auth->sesKey())
            ->replenishment($this->win->ctx, array_filter([
                'warehouse_id' => $warehouseId,
                'limit'        => 15,
            ], static fn ($v) => $v !== null));

        if (!($response['ok'] ?? false)) {
            return [
                'available' => false,
                'reason'    => 'inventory_unavailable',
                'note'      => 'Inventory could not be reached, so stock levels are unknown. This is not the same as nothing being low.',
                'items'     => [],
                'fetched_at' => gmdate('c'),
            ];
        }

        $body = $response['body'] ?? [];
        $rows = is_array($body['data'] ?? null) ? $body['data'] : (is_array($body) ? $body : []);

        $items = [];
        foreach (array_slice($rows, 0, 15) as $row) {
            if (!is_array($row)) {
                continue;
            }
            $items[] = [
                'item_id'      => isset($row['item_id']) ? (int) $row['item_id'] : null,
                'display_name' => (string) ($row['item_name'] ?? $row['description'] ?? $row['name'] ?? 'Item'),
                'available'    => isset($row['available_qty']) ? (float) $row['available_qty']
                    : (isset($row['closing_qty']) ? (float) $row['closing_qty'] : null),
                'reorder_level' => isset($row['reorder_level']) ? (float) $row['reorder_level'] : null,
                'warehouse_id'  => isset($row['warehouse_id']) ? (int) $row['warehouse_id'] : null,
            ];
        }

        return [
            'available'  => true,
            'items'      => $items,
            // Read live on this request and not written down anywhere.
            'fetched_at' => gmdate('c'),
            'source'     => 'inventory.aicountly.com — read live on this request, never stored in POS.',
        ];
    }

    /** @return array<string, mixed> */
    private function exceptions(): array
    {
        return $this->exceptionsMemo ??= $this->computeExceptions();
    }

    /** @return array<string, mixed> */
    private function computeExceptions(): array
    {
        $approvals = Db::all(
            "SELECT event_kind, COUNT(*) AS count
             FROM pos_approval_events
             WHERE cmp_id = :cmp AND created_at >= :win_from AND created_at < :win_to
             GROUP BY event_kind ORDER BY COUNT(*) DESC",
            ['cmp' => $this->win->ctx->cmpId, 'win_from' => $this->win->startsAt, 'win_to' => $this->win->endsAt],
        );

        [$vWhere, $vParams] = $this->win->clause('c');
        [$vWhere, $vParams] = $this->win->narrow($vWhere, $vParams, 'c');
        $voids = (int) Db::scalar(
            "SELECT COUNT(*) FROM pos_carts c WHERE {$vWhere} AND c.status = 'VOID'",
            $vParams,
        );

        $stuck = (int) Db::scalar(
            "SELECT COUNT(*) FROM " . IntegrationCommand::TABLE . "
             WHERE cmp_id = :cmp AND status IN ('FAILED', 'BLOCKED')",
            ['cmp' => $this->win->ctx->cmpId],
        );

        return [
            'voids'     => $voids,
            'stuck'     => $stuck,
            'approvals' => array_map(static fn (array $r): array => [
                'event_kind' => (string) $r['event_kind'],
                'count'      => (int) $r['count'],
            ], $approvals),
        ];
    }

    private function windowedExceptionCount(): int
    {
        $e = $this->exceptions();
        $approvals = 0;
        foreach ($e['approvals'] as $row) {
            if (in_array($row['event_kind'], ['no_sale', 'price_override', 'discount'], true)) {
                $approvals += $row['count'];
            }
        }

        return $e['voids'] + $approvals;
    }

    private function exceptionCount(): int
    {
        return $this->windowedExceptionCount() + $this->exceptions()['stuck'];
    }

    // -----------------------------------------------------------------------
    // The command centre
    //
    // Everything below is computed from POS' OWN rows or read live from the
    // product that owns the data. Nothing here is a model output, so nothing
    // here is badged as one: the pulse strip and the alert list are threshold
    // crossings and they say so. Where the counter cannot measure a thing —
    // how long a person stood in line, whether a printer has paper — the block
    // returns `available: false` with the reason, and the screen renders that
    // differently from empty.
    // -----------------------------------------------------------------------

    /**
     * The same figures over the comparison window, for the KPI trend badges.
     *
     * Only the WINDOWED figures are here. Bills on hold and the open-counter
     * count are both "right now" facts with no previous value to compare
     * against, and an invented one would put a green arrow on a number that
     * never moved.
     *
     * @return array<string, mixed>|null
     */
    private function comparison(): ?array
    {
        return $this->once('comparison', fn (): ?array => $this->computeComparison());
    }

    /** @return array<string, mixed>|null */
    private function computeComparison(): ?array
    {
        $clause = $this->win->comparisonClause('c');
        if ($clause === null) {
            return null;
        }

        [$where, $params] = $clause;
        [$where, $params] = $this->win->narrow($where, $params, 'c');
        [$where, $params] = $this->mineOnly($where, $params);

        $sales = Db::first(
            "SELECT COUNT(*) FILTER (WHERE c.status = 'COMPLETED') AS bills,
                    COALESCE(SUM(c.total_amount) FILTER (WHERE c.status = 'COMPLETED'), 0) AS net,
                    COUNT(*) FILTER (WHERE c.status = 'VOID') AS voids
             FROM pos_carts c WHERE {$where} AND c.status IN ('COMPLETED', 'VOID')",
            $params,
        ) ?? [];

        [$mWhere, $mParams] = $this->win->comparisonClause('c');
        [$mWhere, $mParams] = $this->win->narrow($mWhere, $mParams, 'c');
        $checkout = Db::first(
            "SELECT COUNT(*) AS sampled,
                    PERCENTILE_CONT(0.5) WITHIN GROUP (
                        ORDER BY EXTRACT(EPOCH FROM (c.updated_at - c.created_at))
                    ) AS median_seconds
             FROM pos_carts c
             WHERE {$mWhere} AND c.status = 'COMPLETED'
               AND c.updated_at >= c.created_at + INTERVAL '1 second'
               AND c.offline_created = FALSE",
            $mParams,
        ) ?? [];

        $approvals = (int) Db::scalar(
            "SELECT COUNT(*) FROM pos_approval_events
             WHERE cmp_id = :cmp AND event_kind IN ('no_sale', 'price_override', 'discount')
               AND created_at >= :cmp_from AND created_at < :cmp_to",
            [
                'cmp'      => $this->win->ctx->cmpId,
                'cmp_from' => $this->win->compareStartsAt,
                'cmp_to'   => $this->win->compareEndsAt,
            ],
        );

        $voids = (int) ($sales['voids'] ?? 0);

        return [
            'label'  => $this->win->compareLabel,
            'bills'  => (int) ($sales['bills'] ?? 0),
            'net'    => (float) ($sales['net'] ?? 0),
            'voids'  => $voids,
            'approvals' => $approvals,
            // Compared like with like: the KPI card's own windowed figure, not
            // the headline count, which also carries sales stuck on all dates.
            'exceptions_windowed' => $voids + $approvals,
            'checkout' => (int) ($checkout['sampled'] ?? 0) === 0
                ? ['available' => false]
                : [
                    'available'      => true,
                    'median_seconds' => (int) round((float) ($checkout['median_seconds'] ?? 0)),
                    'sampled'        => (int) $checkout['sampled'],
                ],
        ];
    }

    /**
     * The shape of the day: one point per hour, or per day over a longer range.
     *
     * Bucketed in the OUTLET's timezone rather than the server's, or an evening
     * peak in Kolkata lands in the small hours and the curve is a lie. Gaps
     * between the first and last bucket that took money are filled with real
     * zeros — an hour with no sales is a fact worth drawing — but nothing is
     * invented before the shop opened or after it closed.
     *
     * @return array<string, mixed>
     */
    private function trend(): array
    {
        return $this->once('trend', fn (): array => $this->computeTrend());
    }

    /** @return array<string, mixed> */
    private function computeTrend(): array
    {
        $singleDay = $this->win->from === $this->win->to;
        $bucket    = $singleDay ? 'hour' : 'day';

        [$where, $params] = $this->win->clause('c');
        [$where, $params] = $this->win->narrow($where, $params, 'c');
        [$where, $params] = $this->mineOnly($where, $params);
        $params['tz'] = $this->win->timezone;

        $expr = $singleDay
            ? "to_char(date_trunc('hour', c.created_at AT TIME ZONE :tz), 'HH24:00')"
            : "to_char(date_trunc('day', c.created_at AT TIME ZONE :tz), 'YYYY-MM-DD')";

        $sales = Db::all(
            "SELECT {$expr} AS bucket,
                    COUNT(*) AS bills,
                    COALESCE(SUM(c.total_amount), 0) AS sales,
                    PERCENTILE_CONT(0.5) WITHIN GROUP (
                        ORDER BY EXTRACT(EPOCH FROM (c.updated_at - c.created_at))
                    ) FILTER (
                        WHERE c.updated_at >= c.created_at + INTERVAL '1 second' AND c.offline_created = FALSE
                    ) AS checkout_seconds
             FROM pos_carts c
             WHERE {$where} AND c.status = 'COMPLETED'
             GROUP BY 1 ORDER BY 1",
            $params,
        );

        $items = Db::all(
            "SELECT {$expr} AS bucket, COALESCE(SUM(l.quantity), 0) AS items
             FROM pos_carts c JOIN pos_cart_lines l ON l.cart_id = c.cart_id
             WHERE {$where} AND c.status = 'COMPLETED'
             GROUP BY 1 ORDER BY 1",
            $params,
        );

        $voids = Db::all(
            "SELECT {$expr} AS bucket, COUNT(*) AS voids
             FROM pos_carts c
             WHERE {$where} AND c.status = 'VOID'
             GROUP BY 1 ORDER BY 1",
            $params,
        );

        $comparison = [];
        $clause = $this->win->comparisonClause('c');
        if ($clause !== null) {
            [$cWhere, $cParams] = $clause;
            [$cWhere, $cParams] = $this->win->narrow($cWhere, $cParams, 'c');
            [$cWhere, $cParams] = $this->mineOnly($cWhere, $cParams);
            $cParams['tz'] = $this->win->timezone;

            // The comparison window is a different set of DATES, so a daily
            // bucket cannot be matched on its own label. It is matched on its
            // offset from the start of its own window instead.
            $cExpr = $singleDay
                ? $expr
                : "to_char(date_trunc('day', c.created_at AT TIME ZONE :tz), 'YYYY-MM-DD')";

            foreach (Db::all(
                "SELECT {$cExpr} AS bucket, COALESCE(SUM(c.total_amount), 0) AS sales
                 FROM pos_carts c WHERE {$cWhere} AND c.status = 'COMPLETED'
                 GROUP BY 1 ORDER BY 1",
                $cParams,
            ) as $row) {
                $key = $singleDay
                    ? (string) $row['bucket']
                    : self::addDays((string) $row['bucket'], self::dayOffset($this->win->from, $this->win->compareStartsAt));
                $comparison[$key] = (float) $row['sales'];
            }
        }

        $byBucket = [];
        foreach ($sales as $row) {
            $byBucket[(string) $row['bucket']] = [
                'bills'            => (int) $row['bills'],
                'sales'            => (float) $row['sales'],
                'items'            => 0.0,
                'voids'            => 0,
                'checkout_seconds' => $row['checkout_seconds'] === null ? null : (int) round((float) $row['checkout_seconds']),
            ];
        }
        foreach ($items as $row) {
            $key = (string) $row['bucket'];
            $byBucket[$key] ??= ['bills' => 0, 'sales' => 0.0, 'items' => 0.0, 'voids' => 0, 'checkout_seconds' => null];
            $byBucket[$key]['items'] = (float) $row['items'];
        }
        foreach ($voids as $row) {
            $key = (string) $row['bucket'];
            $byBucket[$key] ??= ['bills' => 0, 'sales' => 0.0, 'items' => 0.0, 'voids' => 0, 'checkout_seconds' => null];
            $byBucket[$key]['voids'] = (int) $row['voids'];
        }

        $keys = self::fillBuckets(array_keys($byBucket), $bucket, $this->win->from, $this->win->to);

        $points = [];
        foreach ($keys as $key) {
            $row = $byBucket[$key] ?? ['bills' => 0, 'sales' => 0.0, 'items' => 0.0, 'voids' => 0, 'checkout_seconds' => null];
            $points[] = [
                'bucket'           => $key,
                'label'            => self::bucketLabel($key, $bucket),
                'bills'            => $row['bills'],
                'sales'            => $row['sales'],
                'items'            => $row['items'],
                'voids'            => $row['voids'],
                'average_bill'     => $row['bills'] > 0 ? round($row['sales'] / $row['bills'], 2) : 0.0,
                'checkout_seconds' => $row['checkout_seconds'],
                'comparison_sales' => $comparison[$key] ?? null,
            ];
        }

        return [
            'bucket'           => $bucket,
            'points'           => $points,
            'comparison_label' => $comparison === [] ? null : $this->win->compareLabel,
            // Which selectors the screen may offer. Gross margin is absent on
            // purpose: unit cost belongs to Inventory and a margin drawn from
            // the counter price alone would be a guess.
            'metrics' => [
                ['key' => 'sales', 'label' => 'Sales (\u{20B9})', 'kind' => 'money'],
                ['key' => 'bills', 'label' => 'Bills', 'kind' => 'count'],
                ['key' => 'average_bill', 'label' => 'Average bill', 'kind' => 'money'],
                ['key' => 'items', 'label' => 'Items sold', 'kind' => 'decimal'],
            ],
            'basis' => 'Completed bills, bucketed in ' . $this->win->timezone . ', this outlet\'s own trading calendar.',
        ];
    }

    /**
     * Queue and checkout health — three things POS can actually measure.
     *
     * What is NOT here is the one every POS dashboard shows: average waiting
     * time. Nothing in this product observes a queue. There is no camera, no
     * ticket dispenser and no door counter, so `wait` is returned unavailable
     * with the reason rather than filled with a plausible number.
     *
     * @return array<string, mixed>
     */
    private function checkoutHealth(): array
    {
        [$where, $params] = $this->win->clause('c');
        [$where, $params] = $this->win->narrow($where, $params, 'c');
        [$where, $params] = $this->mineOnly($where, $params);

        $flow = Db::first(
            "SELECT COUNT(*) AS started,
                    COUNT(*) FILTER (WHERE c.status = 'COMPLETED') AS completed,
                    COUNT(*) FILTER (WHERE c.status = 'VOID') AS voided,
                    COUNT(*) FILTER (WHERE c.status IN ('OPEN', 'HELD', 'CHECKING_OUT')) AS unfinished
             FROM pos_carts c WHERE {$where}",
            $params,
        ) ?? [];

        [$pWhere, $pParams] = $this->win->clause('c');
        [$pWhere, $pParams] = $this->win->narrow($pWhere, $pParams, 'c');
        $p90 = Db::first(
            "SELECT COUNT(*) AS sampled,
                    PERCENTILE_CONT(0.9) WITHIN GROUP (
                        ORDER BY EXTRACT(EPOCH FROM (c.updated_at - c.created_at))
                    ) AS p90_seconds
             FROM pos_carts c
             WHERE {$pWhere} AND c.status = 'COMPLETED'
               AND c.updated_at >= c.created_at + INTERVAL '1 second'
               AND c.offline_created = FALSE",
            $pParams,
        ) ?? [];

        // What is sitting on a counter right now, whatever the date filter says.
        [$oWhere, $oParams] = $this->win->clause('c', false);
        [$oWhere, $oParams] = $this->win->narrow($oWhere, $oParams, 'c');
        $onCounter = Db::first(
            "SELECT COUNT(*) AS carts, COALESCE(SUM(c.total_amount), 0) AS value,
                    MAX(EXTRACT(EPOCH FROM (NOW() - c.updated_at)))::bigint AS oldest_seconds
             FROM pos_carts c WHERE {$oWhere} AND c.status IN ('OPEN', 'HELD')",
            $oParams,
        ) ?? [];

        $started    = (int) ($flow['started'] ?? 0);
        $completed  = (int) ($flow['completed'] ?? 0);
        $voided     = (int) ($flow['voided'] ?? 0);
        $unfinished = (int) ($flow['unfinished'] ?? 0);
        $settled    = $completed + $voided;

        $completionPc  = $settled > 0 ? round($completed / $settled * 100, 1) : null;
        $abandonmentPc = $started > 0 ? round($voided / $started * 100, 1) : null;

        $median   = $this->checkoutDuration();
        $carts    = (int) ($onCounter['carts'] ?? 0);
        $oldest   = $onCounter['oldest_seconds'] === null ? null : (int) $onCounter['oldest_seconds'];
        $p90Value = (int) ($p90['sampled'] ?? 0) === 0 ? null : (int) round((float) ($p90['p90_seconds'] ?? 0));

        $openCounters = 0;
        foreach ($this->counters() as $counter) {
            if ($counter['state'] !== 'closed') {
                $openCounters++;
            }
        }

        [$status, $summary] = self::queueVerdict(
            $started,
            $abandonmentPc,
            $median['available'] === true ? $median['median_seconds'] : null,
            $p90Value,
            $carts,
            $oldest,
            $openCounters,
        );

        return [
            // Said in the payload, not only on the screen, so no consumer of
            // this endpoint can mistake silence for zero.
            'wait' => [
                'available' => false,
                'reason'    => 'not_observed',
                'note'      => 'POS does not observe a queue. There is no camera, ticket dispenser or door counter, '
                    . 'so no waiting time is measured and none is estimated.',
            ],
            'checkout' => [
                'available'      => $median['available'],
                'median_seconds' => $median['available'] === true ? $median['median_seconds'] : null,
                'p90_seconds'    => $p90Value,
                'sampled'        => $median['available'] === true ? $median['sampled'] : 0,
            ],
            'completion' => [
                'available'  => $settled > 0,
                'rate_pc'    => $completionPc,
                'started'    => $started,
                'completed'  => $completed,
                'voided'     => $voided,
                'unfinished' => $unfinished,
            ],
            'abandonment' => [
                'available' => $started > 0,
                'rate_pc'   => $abandonmentPc,
                'voided'    => $voided,
            ],
            'on_counter' => [
                'carts'          => $carts,
                'value'          => (float) ($onCounter['value'] ?? 0),
                'oldest_seconds' => $oldest,
            ],
            'status'  => $status,
            'summary' => $summary,
            'basis'   => 'Carts opened in this window, counted by the state they are in now. '
                . '"Walked away" is a cart voided before it was paid for, which is the only abandonment this product can see.',
        ];
    }

    /**
     * The verdict, from the figures above and nothing else.
     *
     * @return array{0:string, 1:string}
     */
    private static function queueVerdict(
        int $started,
        ?float $abandonmentPc,
        ?int $median,
        ?int $p90,
        int $onCounter,
        ?int $oldestSeconds,
        int $openCounters,
    ): array {
        if ($started < 5) {
            return ['unknown', 'Too few bills in this period to say anything about checkout speed.'];
        }

        $slowTail  = $median !== null && $p90 !== null && $median > 0 && $p90 >= $median * 3;
        $piling    = $openCounters > 0 && $onCounter >= $openCounters * 3;
        $veryStale = $oldestSeconds !== null && $oldestSeconds >= 4 * 3600 && $onCounter >= 3;

        if (($abandonmentPc ?? 0) >= 15 || $veryStale) {
            return [
                'critical',
                $veryStale
                    ? 'Bills have been sitting on a counter for hours. Clear or void them before the drawer is counted.'
                    : 'More than one bill in seven was voided before payment. Check what is happening at the counter.',
            ];
        }
        if (($abandonmentPc ?? 0) >= 8 || $slowTail) {
            return [
                'high',
                $slowTail
                    ? 'A long tail: the slowest tenth of bills take three times the median. Usually one counter, one item or one tender.'
                    : 'Voids before payment are running high for this period.',
            ];
        }
        if (($abandonmentPc ?? 0) >= 4 || $piling) {
            return [
                'moderate',
                $piling
                    ? 'Several bills are open on each counter at once. Another till open would move them.'
                    : 'Checkout is holding up, with a few more voids than usual.',
            ];
        }

        return ['healthy', 'Checkout is holding up across the counters that are open.'];
    }

    /**
     * What sold, by category.
     *
     * POS owns the MENU's grouping and nothing else: a scanned retail item's
     * group belongs to Inventory. So this reads the menu category where the
     * line came from a menu item, asks Inventory live for the item group of
     * the rest, and reports how much of the period's takings it could place.
     * Nothing is stored here and no grouping is invented.
     *
     * @return array<string, mixed>
     */
    private function topCategories(): array
    {
        [$where, $params] = $this->win->clause('c');
        [$where, $params] = $this->win->narrow($where, $params, 'c');
        [$where, $params] = $this->mineOnly($where, $params);

        // Two bounded aggregates rather than one row per item: a busy retail
        // day touches thousands of distinct items and shipping all of them to
        // PHP to add up five categories is how a dashboard becomes the slowest
        // page in the product.
        $total = (float) Db::scalar(
            "SELECT COALESCE(SUM(l.line_amount), 0)
             FROM pos_cart_lines l JOIN pos_carts c ON c.cart_id = l.cart_id
             WHERE {$where} AND c.status = 'COMPLETED'",
            $params,
        );

        if ($total <= 0) {
            return [
                'available'   => false,
                'reason'      => 'no_sales',
                'note'        => 'No completed bill in this period has any lines to group.',
                'rows'        => [],
                'total'       => 0.0,
                'covered'     => 0.0,
                'uncategorised' => 0.0,
                'coverage_pc' => null,
                'source'      => null,
            ];
        }

        $named = [];
        foreach (Db::all(
            "SELECT cat.category_id, cat.category_name,
                    COALESCE(SUM(l.line_amount), 0) AS amount,
                    COALESCE(SUM(l.quantity), 0) AS qty,
                    COUNT(DISTINCT c.cart_id) AS bills
             FROM pos_cart_lines l
             JOIN pos_carts c ON c.cart_id = l.cart_id
             JOIN pos_menu_items mi ON mi.menu_item_id = l.menu_item_id
             JOIN pos_menu_categories cat ON cat.category_id = mi.category_id
             WHERE {$where} AND c.status = 'COMPLETED'
             GROUP BY 1, 2 ORDER BY 3 DESC",
            $params,
        ) as $row) {
            $named['menu:' . $row['category_id']] = [
                'label'  => (string) $row['category_name'],
                'amount' => (float) $row['amount'],
                'qty'    => (float) $row['qty'],
                'bills'  => (int) $row['bills'],
            ];
        }

        $fromMenu = $named !== [];

        // Everything the menu could not place, biggest first. POS keeps no
        // grouping of Inventory's items, so the group has to be asked for.
        $loose = Db::all(
            "SELECT l.item_id,
                    COALESCE(SUM(l.line_amount), 0) AS amount,
                    COALESCE(SUM(l.quantity), 0) AS qty,
                    COUNT(DISTINCT c.cart_id) AS bills
             FROM pos_cart_lines l
             JOIN pos_carts c ON c.cart_id = l.cart_id
             LEFT JOIN pos_menu_items mi ON mi.menu_item_id = l.menu_item_id
             WHERE {$where} AND c.status = 'COMPLETED'
               AND (l.menu_item_id IS NULL OR mi.category_id IS NULL)
             GROUP BY 1 ORDER BY 2 DESC
             LIMIT 200",
            $params,
        );

        $fromInventory = false;
        $uncategorised = max(0.0, $total - array_sum(array_column($named, 'amount'))
            - array_sum(array_map(static fn (array $r): float => (float) $r['amount'], $loose)));

        if ($loose !== []) {
            $groups = $this->inventoryItemGroups(array_values(array_filter(
                array_map(static fn (array $r): ?int => $r['item_id'] === null ? null : (int) $r['item_id'], $loose),
                static fn (?int $id): bool => $id !== null,
            )));

            foreach ($loose as $line) {
                $amount = (float) $line['amount'];
                $group  = $line['item_id'] === null ? null : ($groups[(int) $line['item_id']] ?? null);
                if ($group === null) {
                    $uncategorised += $amount;

                    continue;
                }

                $fromInventory = true;
                $key = 'inv:' . $group;
                $named[$key] ??= ['label' => $group, 'amount' => 0.0, 'qty' => 0.0, 'bills' => 0];
                $named[$key]['amount'] += $amount;
                $named[$key]['qty']    += (float) $line['qty'];
                $named[$key]['bills']  += (int) $line['bills'];
            }
        }

        if ($named === []) {
            return [
                'available' => false,
                'reason'    => 'no_grouping',
                'note'      => 'Nothing sold in this period carries a POS menu category, and Inventory did not return an '
                    . 'item group for these items. POS does not keep its own grouping of Inventory\'s items.',
                'rows'        => [],
                'total'       => round($total, 2),
                'covered'     => 0.0,
                'uncategorised' => round($total, 2),
                'coverage_pc' => 0.0,
                'source'      => null,
            ];
        }

        uasort($named, static fn (array $a, array $b): int => $b['amount'] <=> $a['amount']);

        $out  = [];
        $rest = 0.0;
        $restQty = 0.0;
        $i = 0;
        foreach ($named as $group) {
            if ($i < 5) {
                $out[] = $group;
            } else {
                $rest    += $group['amount'];
                $restQty += $group['qty'];
            }
            $i++;
        }
        if ($rest > 0) {
            $out[] = ['label' => 'Other categories', 'amount' => $rest, 'qty' => $restQty, 'bills' => 0];
        }

        $covered = array_sum(array_column($named, 'amount'));

        return [
            'available'   => true,
            // The share is of what could be PLACED, so the wedges add to a
            // hundred. What could not be placed is `uncategorised`, and
            // `coverage_pc` says how much of the period that leaves out.
            'rows'        => array_map(static fn (array $g): array => [
                'label'    => $g['label'],
                'amount'   => round($g['amount'], 2),
                'qty'      => round($g['qty'], 3),
                'bills'    => $g['bills'],
                'share_pc' => $covered > 0 ? round($g['amount'] / $covered * 100, 1) : null,
            ], $out),
            'total'         => round($total, 2),
            'covered'       => round($covered, 2),
            'uncategorised' => round($uncategorised, 2),
            'coverage_pc'   => $total > 0 ? round($covered / $total * 100, 1) : null,
            'source'        => $fromMenu && $fromInventory
                ? 'POS menu categories, and Inventory\'s item groups read live for everything scanned.'
                : ($fromMenu
                    ? 'POS menu categories. POS owns the menu\'s grouping; it owns no grouping of Inventory\'s items.'
                    : 'Inventory\'s item groups, read live on this request and not stored in POS.'),
        ];
    }

    /**
     * Item groups from Inventory, for items POS has no menu category for.
     *
     * One bulk call for the lot — never one per line. An Inventory that cannot
     * answer leaves those sales uncategorised and the panel says so; it does
     * not silently drop them out of the total.
     *
     * @param list<int> $itemIds
     * @return array<int, string>
     */
    private function inventoryItemGroups(array $itemIds): array
    {
        if ($itemIds === []) {
            return [];
        }

        $response = (new InventoryClient())
            ->withSession($this->win->auth->sesKey())
            ->bulkLookupItems($this->win->ctx, array_slice($itemIds, 0, 200));

        if (!($response['ok'] ?? false)) {
            return [];
        }

        $body = $response['body'] ?? [];
        $rows = is_array($body['data'] ?? null) ? $body['data'] : (is_array($body) ? $body : []);

        $out = [];
        foreach ($rows as $row) {
            if (!is_array($row) || !isset($row['item_id'])) {
                continue;
            }
            $group = self::groupName($row);
            if ($group !== null) {
                $out[(int) $row['item_id']] = $group;
            }
        }

        return $out;
    }

    /**
     * The group name out of whatever shape Inventory sent.
     *
     * @param array<string, mixed> $item
     */
    private static function groupName(array $item): ?string
    {
        foreach (['item_group_name', 'group_name', 'item_group', 'category_name', 'category', 'group'] as $key) {
            $value = $item[$key] ?? null;
            if (is_string($value) && trim($value) !== '') {
                return trim($value);
            }
            if (is_array($value)) {
                foreach (['name', 'display_name', 'item_group_name', 'group_name', 'label'] as $inner) {
                    $nested = $value[$inner] ?? null;
                    if (is_string($nested) && trim($nested) !== '') {
                        return trim($nested);
                    }
                }
            }
        }

        return null;
    }

    /**
     * What needs a person, newest and worst first.
     *
     * Every row is a threshold crossing over this POS' own rows or over what
     * Inventory answered on this request, and each carries the timestamp of the
     * thing it is about rather than the time the page was drawn. There are no
     * invented device alerts here: a browser cannot tell whether a till has
     * paper in it, so "low paper roll" is not a row this product can write.
     *
     * @return array<string, mixed>
     */
    private function alerts(): array
    {
        return $this->once('alerts', fn (): array => $this->computeAlerts());
    }

    /** @return array<string, mixed> */
    private function computeAlerts(): array
    {
        $items = [];
        $cmp   = ['cmp' => $this->win->ctx->cmpId];

        [$tScope, $tParams] = $this->win->terminalScope('t');
        $inScope = "terminal_id IN (SELECT t.terminal_id FROM pos_terminals t WHERE {$tScope})";

        // Sales that have not reached Books or Inventory. Not windowed: a sale
        // stuck last Tuesday is still stuck.
        $posting = Db::first(
            "SELECT COUNT(*) FILTER (WHERE status = 'BLOCKED') AS blocked,
                    COUNT(*) FILTER (WHERE status = 'FAILED') AS failed,
                    MAX(created_at) FILTER (WHERE status = 'BLOCKED') AS blocked_at,
                    MAX(created_at) FILTER (WHERE status = 'FAILED') AS failed_at
             FROM " . IntegrationCommand::TABLE . "
             WHERE cmp_id = :cmp AND status IN ('FAILED', 'BLOCKED')",
            $cmp,
        ) ?? [];

        if ((int) ($posting['blocked'] ?? 0) > 0) {
            $items[] = self::alert(
                'posting-blocked',
                'critical',
                (int) $posting['blocked'] . ' sale(s) Books or Inventory refused',
                'Refused for a business reason. Retrying cannot help until the cause is fixed.',
                $posting['blocked_at'] ?? null,
                '/controls?panel=posting',
            );
        }
        if ((int) ($posting['failed'] ?? 0) > 0) {
            $items[] = self::alert(
                'posting-failed',
                'warning',
                (int) $posting['failed'] . ' sale(s) have not reached Books or Inventory',
                'A transport failure. The original idempotency key is kept, so a retry lands on the same invoice.',
                $posting['failed_at'] ?? null,
                '/controls?panel=posting',
            );
        }

        $offline = Db::first(
            "SELECT COUNT(*) AS pending,
                    COUNT(*) FILTER (WHERE status = 'CONFLICT_REVIEW') AS conflicts,
                    MAX(received_at) AS at
             FROM pos_offline_submissions
             WHERE cmp_id = :cmp AND status IN ('RECEIVED', 'POSTING', 'FAILED', 'CONFLICT_REVIEW')",
            $cmp,
        ) ?? [];

        if ((int) ($offline['conflicts'] ?? 0) > 0) {
            $items[] = self::alert(
                'offline-conflicts',
                'critical',
                (int) $offline['conflicts'] . ' offline sale(s) need a decision',
                'A till sold these while it was off the network and the server will not take them as they stand.',
                $offline['at'] ?? null,
                '/offline',
            );
        } elseif ((int) ($offline['pending'] ?? 0) > 0) {
            $items[] = self::alert(
                'offline-pending',
                'warning',
                (int) $offline['pending'] . ' offline sale(s) still to land',
                'Made on a till that was off the network and not yet accepted here.',
                $offline['at'] ?? null,
                '/offline',
            );
        }

        $variance = Db::first(
            "SELECT COUNT(*) AS n, MAX(closed_at) AS at
             FROM pos_register_sessions
             WHERE cmp_id = :cmp AND status = 'CLOSED'
               AND variance IS NOT NULL AND variance <> 0 AND approved_by IS NULL
               AND {$inScope}",
            $cmp + $tParams,
        ) ?? [];

        if ((int) ($variance['n'] ?? 0) > 0) {
            $items[] = self::alert(
                'cash-variance',
                'warning',
                (int) $variance['n'] . ' closed drawer(s) are out and unsigned',
                'The count did not match what the shift\'s own events say it should hold, and nobody has approved the difference.',
                $variance['at'] ?? null,
                '/controls?panel=shifts',
            );
        }

        // Bills left on a counter. Not windowed, for the reason in kpis().
        [$hWhere, $hParams] = $this->win->clause('c', false);
        [$hWhere, $hParams] = $this->win->narrow($hWhere, $hParams, 'c');
        $aging = Db::first(
            "SELECT COUNT(*) AS n, MIN(c.updated_at) AS oldest
             FROM pos_carts c
             WHERE {$hWhere} AND c.status = 'HELD' AND c.updated_at < NOW() - INTERVAL '2 hours'",
            $hParams,
        ) ?? [];

        if ((int) ($aging['n'] ?? 0) > 0) {
            $items[] = self::alert(
                'held-aging',
                'warning',
                (int) $aging['n'] . ' bill(s) held for more than two hours',
                'A held bill nobody comes back for is a bill that is never counted.',
                $aging['oldest'] ?? null,
                '/retail',
            );
        }

        // Voids by counter, over the chosen period.
        [$vWhere, $vParams] = $this->win->clause('c');
        [$vWhere, $vParams] = $this->win->narrow($vWhere, $vParams, 'c');
        [$vWhere, $vParams] = $this->mineOnly($vWhere, $vParams);
        foreach (Db::all(
            "SELECT t.terminal_code, t.display_name,
                    COUNT(*) FILTER (WHERE c.status = 'COMPLETED') AS completed,
                    COUNT(*) FILTER (WHERE c.status = 'VOID') AS voided,
                    MAX(c.created_at) FILTER (WHERE c.status = 'VOID') AS last_void
             FROM pos_carts c
             JOIN pos_terminals t ON t.terminal_id = c.terminal_id
             WHERE {$vWhere} AND c.status IN ('COMPLETED', 'VOID')
             GROUP BY 1, 2
             HAVING COUNT(*) >= 8 AND COUNT(*) FILTER (WHERE c.status = 'VOID') * 100 >= COUNT(*) * 5
             ORDER BY COUNT(*) FILTER (WHERE c.status = 'VOID') DESC
             LIMIT 3",
            $vParams,
        ) as $row) {
            $all  = (int) $row['completed'] + (int) $row['voided'];
            $rate = $all > 0 ? round((int) $row['voided'] / $all * 100, 1) : 0.0;
            $items[] = self::alert(
                'void-rate-' . $row['terminal_code'],
                'warning',
                'High void rate (' . $rate . '%)',
                'Counter ' . ($row['display_name'] ?? $row['terminal_code']) . ' voided '
                    . (int) $row['voided'] . ' of ' . $all . ' bills in this period.',
                $row['last_void'] ?? null,
                '/controls?panel=approvals',
            );
        }

        // Counters with a shift open and nothing rung up for the last while.
        foreach ($this->counters() as $counter) {
            if ($counter['state'] !== 'idle') {
                continue;
            }
            $items[] = self::alert(
                'idle-' . $counter['terminal_code'],
                'info',
                $counter['display_name'] . ' has been quiet',
                'A shift is open on this counter and it has not completed a bill for at least 45 minutes.',
                $counter['last_bill'] ?? ($counter['shift']['opened_at'] ?? null),
                '/retail?terminal_id=' . $counter['terminal_id'],
            );
        }

        // What Inventory said, on this request. Never a stored stock figure.
        $stock = $this->stockAttention();
        if (($stock['available'] ?? false) === true) {
            $out = array_values(array_filter(
                $stock['items'],
                static fn (array $item): bool => ($item['available'] ?? null) !== null && (float) $item['available'] <= 0,
            ));
            if ($out !== []) {
                $items[] = self::alert(
                    'stock-out',
                    'warning',
                    count($out) . ' item(s) Inventory reports out of stock',
                    'Read live from Inventory: ' . implode(', ', array_slice(array_column($out, 'display_name'), 0, 3))
                        . (count($out) > 3 ? ' and others.' : '.'),
                    $stock['fetched_at'] ?? null,
                    '/retail',
                );
            }
        }

        $order = ['critical' => 0, 'warning' => 1, 'info' => 2];
        usort($items, static function (array $a, array $b) use ($order): int {
            $bySeverity = ($order[$a['severity']] ?? 3) <=> ($order[$b['severity']] ?? 3);

            return $bySeverity !== 0 ? $bySeverity : strcmp((string) ($b['at'] ?? ''), (string) ($a['at'] ?? ''));
        });

        return [
            'items' => array_slice($items, 0, 6),
            'total' => count($items),
            'kind'  => 'rule',
            'note'  => 'Every row is a threshold crossed in this POS\' own rows, or what Inventory answered on this '
                . 'request. Nothing here is a device telling us about itself: a browser cannot see a paper roll.',
        ];
    }

    /**
     * One alert row.
     *
     * @return array<string, mixed>
     */
    private static function alert(
        string $id,
        string $severity,
        string $title,
        string $context,
        mixed $at,
        ?string $href,
    ): array {
        return [
            'id'       => $id,
            'kind'     => 'rule',
            'severity' => $severity,
            'title'    => $title,
            'context'  => $context,
            'at'       => is_string($at) && $at !== '' ? self::iso($at) : null,
            'href'     => $href,
        ];
    }

    /**
     * Is this shop ready to trade?
     *
     * Each check is a real column. There is no "receipt paper" check, because
     * nothing in this product knows how much paper is in a till — what it knows
     * is whether a printer was ever configured, and that is what the row says.
     *
     * @return array<string, mixed>
     */
    private function shiftReadiness(): array
    {
        $counters = $this->counters();
        $total    = count($counters);

        if ($total === 0) {
            return [
                'available' => false,
                'reason'    => 'no_counters',
                'note'      => 'No till is set up in this scope, so there is nothing to be ready.',
                'ready'     => 0,
                'total'     => 0,
                'percent'   => null,
                'checks'    => [],
            ];
        }

        $withShift = 0;
        $withFloat = 0;
        $withPrinter = 0;
        $withDevice = 0;

        foreach ($counters as $counter) {
            if ($counter['state'] !== 'closed') {
                $withShift++;
                if (($counter['shift']['opening_float'] ?? 0) > 0) {
                    $withFloat++;
                }
            }
            if ($counter['receipt_printer'] !== null) {
                $withPrinter++;
            }
            if ($counter['active_devices'] > 0) {
                $withDevice++;
            }
        }

        [$tScope, $tParams] = $this->win->terminalScope('t');
        $awaiting = (int) Db::scalar(
            "SELECT COUNT(*) FROM pos_register_sessions
             WHERE cmp_id = :cmp AND status = 'CLOSED'
               AND variance IS NOT NULL AND variance <> 0 AND approved_by IS NULL
               AND terminal_id IN (SELECT t.terminal_id FROM pos_terminals t WHERE {$tScope})",
            ['cmp' => $this->win->ctx->cmpId] + $tParams,
        );

        $checks = [
            [
                'key'   => 'shift_open',
                'label' => 'Tills with a shift open',
                'ready' => $withShift,
                'of'    => $total,
                'note'  => 'A till cannot take money until someone opens a shift on it.',
            ],
            [
                'key'   => 'float',
                'label' => 'Opening float entered',
                'ready' => $withFloat,
                'of'    => $withShift,
                'note'  => 'Counted from each open shift\'s own opening float.',
            ],
            [
                'key'   => 'printer',
                'label' => 'Receipt printer configured',
                'ready' => $withPrinter,
                'of'    => $total,
                'note'  => 'What was set up on the till. POS cannot check the paper.',
            ],
            [
                'key'   => 'device',
                'label' => 'Device registered',
                'ready' => $withDevice,
                'of'    => $total,
                'note'  => 'At least one active device registration against the till.',
            ],
            [
                'key'   => 'approval',
                'label' => 'Drawer differences signed off',
                'ready' => $awaiting === 0 ? 1 : 0,
                'of'    => 1,
                'note'  => $awaiting === 0
                    ? 'No closed drawer is waiting for a manager.'
                    : $awaiting . ' closed drawer(s) are out and waiting for a manager.',
            ],
        ];

        $ready = 0;
        $of    = 0;
        foreach ($checks as $check) {
            if ($check['of'] > 0) {
                $ready += $check['ready'];
                $of    += $check['of'];
            }
        }

        return [
            'available' => true,
            'ready'     => $withShift,
            'total'     => $total,
            'percent'   => $of > 0 ? (int) round($ready / $of * 100) : null,
            'checks'    => array_values(array_filter($checks, static fn (array $c): bool => $c['of'] > 0)),
            'note'      => 'Every row is a column this product actually keeps. Readiness is the share of those checks that pass.',
        ];
    }

    /**
     * The one-line brief across the top of the board.
     *
     * RULE-BASED, and the payload says so. These are the worst two alerts, the
     * swing against the comparison window and the hour this outlet is usually
     * busiest — all four computed from rows, none of them a model output, and
     * no confidence percentage anywhere because nothing here produces one.
     *
     * @return array<string, mixed>
     */
    private function pulse(): array
    {
        $items = [];

        foreach (array_slice($this->alerts()['items'], 0, 2) as $alert) {
            $items[] = [
                'id'            => 'pulse-' . $alert['id'],
                'kind'          => 'rule',
                'severity'      => $alert['severity'] === 'critical' ? 'danger' : $alert['severity'],
                'title'         => $alert['title'],
                'explanation'   => $alert['context'],
                // `metric` and `detail` are what the strip's chip shows: the
                // same numbers as the explanation, in fewer words.
                'metric'        => null,
                'detail'        => $alert['context'],
                'period_label'  => 'Right now',
                'evidence_href' => $alert['href'],
                'action_label'  => null,
            ];
        }

        $comparison = $this->comparison();
        $kpis       = $this->kpis();
        if ($comparison !== null && $comparison['net'] > 0) {
            $change = ($kpis['net'] - $comparison['net']) / $comparison['net'] * 100;
            if (abs($change) >= 15) {
                $items[] = [
                    'id'            => 'pulse-swing',
                    'kind'          => 'rule',
                    'severity'      => $change > 0 ? 'success' : 'warning',
                    'title'         => 'Takings are ' . ($change > 0 ? 'up' : 'down') . ' ' . abs((int) round($change)) . '% '
                        . ($comparison['label'] ?? 'on the comparison window'),
                    'explanation'   => 'Counter takings this window against the comparison window. Both figures are on this screen.',
                    'metric'        => ($change > 0 ? '+' : '−') . abs((int) round($change)) . '%',
                    'detail'        => 'Against ' . number_format($comparison['net'], 0) . ' in the comparison window.',
                    'period_label'  => $this->win->from . ' — ' . $this->win->to,
                    'evidence_href' => null,
                    'action_label'  => null,
                ];
            }
        }

        $peak = $this->peakHour();
        if ($peak !== null) {
            $items[] = [
                'id'            => 'pulse-peak',
                'kind'          => 'rule',
                'severity'      => 'info',
                'title'         => $peak['minutes_until'] === null
                    ? 'Busiest hour is usually ' . $peak['label']
                    : 'Busiest hour usually starts in ' . $peak['minutes_until'] . ' min',
                'explanation'   => $peak['basis'],
                'metric'        => $peak['label'],
                'detail'        => 'Across ' . $peak['days_sampled'] . ' trading day(s) of this outlet\'s own bills.',
                'period_label'  => 'Last 28 days',
                'evidence_href' => null,
                'action_label'  => null,
            ];
        }

        return [
            'items' => array_slice($items, 0, 3),
            'peak'  => $peak,
            'ai' => [
                'available' => false,
                'reason'    => 'not_configured',
                'note'      => 'POS has no model integration configured, so nothing on this strip is model-generated. '
                    . 'Every item is a deterministic rule over this POS\' own rows.',
            ],
            'generated_at'    => gmdate('c'),
            'sufficient_data' => $items !== [],
        ];
    }

    /**
     * The hour this outlet is usually busiest, from the last 28 days.
     *
     * A HISTORICAL AGGREGATE, not a forecast. It is only offered when the
     * window includes today — telling someone about a peak on a day that is
     * over is noise — and only when there is enough history for the answer to
     * mean anything.
     *
     * @return array<string, mixed>|null
     */
    private function peakHour(): ?array
    {
        return $this->once('peak', function (): ?array {
            $tz  = new \DateTimeZone($this->win->timezone);
            $now = new \DateTimeImmutable('now', $tz);

            // Only while the chosen window is still running.
            if (self::epoch($this->win->endsAt) < $now->getTimestamp()) {
                return null;
            }

            [$where, $params] = $this->win->clause('c', false);
            [$where, $params] = $this->win->narrow($where, $params, 'c');
            [$where, $params] = $this->mineOnly($where, $params);
            $params['tz']        = $this->win->timezone;
            $params['peak_from'] = $now->modify('-28 days')->setTimezone(new \DateTimeZone('UTC'))->format('Y-m-d H:i:s');

            $rows = Db::all(
                "SELECT EXTRACT(HOUR FROM c.created_at AT TIME ZONE :tz)::int AS hour,
                        COUNT(*) AS bills,
                        COALESCE(SUM(c.total_amount), 0) AS net,
                        COUNT(DISTINCT (c.created_at AT TIME ZONE :tz)::date) AS days
                 FROM pos_carts c
                 WHERE {$where} AND c.status = 'COMPLETED' AND c.created_at >= :peak_from
                 GROUP BY 1 ORDER BY 3 DESC",
                $params,
            );

            if ($rows === []) {
                return null;
            }

            $bills = array_sum(array_map(static fn (array $r): int => (int) $r['bills'], $rows));
            $days  = max(array_map(static fn (array $r): int => (int) $r['days'], $rows));
            if ($bills < 20 || $days < 5) {
                return null;
            }

            $top     = $rows[0];
            $hour    = (int) $top['hour'];
            $minutes = ((int) $now->format('H')) * 60 + (int) $now->format('i');
            $until   = $hour * 60 - $minutes;

            return [
                'hour'          => $hour,
                'label'         => self::hourRangeLabel($hour),
                'bills'         => (int) $top['bills'],
                'net'           => (float) $top['net'],
                'days_sampled'  => (int) $top['days'],
                'minutes_until' => $until > 0 && $until <= 180 ? $until : null,
                'basis'         => 'The hour that took the most money over the last 28 days at this outlet, across '
                    . (int) $top['days'] . ' trading day(s). A pattern in the rows, not a forecast.',
            ];
        });
    }

    // -----------------------------------------------------------------------
    // Small shared helpers
    // -----------------------------------------------------------------------

    /** Seconds since the epoch. A bare timestamp from Window is UTC; a Postgres one carries its own offset. */
    private static function epoch(string $value): int
    {
        if ($value === '') {
            return 0;
        }

        try {
            return (new \DateTimeImmutable($value, new \DateTimeZone('UTC')))->getTimestamp();
        } catch (\Throwable) {
            return 0;
        }
    }

    /** RFC3339, so the browser does not have to guess at a Postgres timestamp. */
    private static function iso(string $value): ?string
    {
        try {
            return (new \DateTimeImmutable($value, new \DateTimeZone('UTC')))->format('c');
        } catch (\Throwable) {
            return null;
        }
    }

    /**
     * The date this many days from that one.
     *
     * Window's, not a second copy: two implementations of a date boundary is
     * two chances for a night shift to land on different days on two screens.
     */
    private static function addDays(string $date, int $days): string
    {
        try {
            return Window::plusDays($date, $days);
        } catch (\Throwable) {
            return $date;
        }
    }

    /** Whole days between the start of the comparison window and the start of this one. */
    private static function dayOffset(string $from, ?string $compareStartsAt): int
    {
        if ($compareStartsAt === null) {
            return 0;
        }

        try {
            $a = new \DateTimeImmutable(substr($compareStartsAt, 0, 10), new \DateTimeZone('UTC'));
            $b = new \DateTimeImmutable($from, new \DateTimeZone('UTC'));

            return (int) $a->diff($b)->days;
        } catch (\Throwable) {
            return 0;
        }
    }

    /**
     * Every bucket between the first and the last that took money.
     *
     * An hour with no sales is drawn as a zero because it happened. An hour
     * before the shop opened is not drawn at all, because nothing happened and
     * nothing is claimed. Long ranges are left as they came back rather than
     * filled to four hundred points.
     *
     * @param list<string> $observed
     * @return list<string>
     */
    private static function fillBuckets(array $observed, string $bucket, string $from, string $to): array
    {
        if ($observed === []) {
            return [];
        }

        sort($observed);

        if ($bucket === 'hour') {
            $first = (int) substr($observed[0], 0, 2);
            $last  = (int) substr($observed[count($observed) - 1], 0, 2);
            $out   = [];
            for ($h = $first; $h <= $last; $h++) {
                $out[] = str_pad((string) $h, 2, '0', STR_PAD_LEFT) . ':00';
            }

            return $out;
        }

        $span = (int) (new \DateTimeImmutable($from, new \DateTimeZone('UTC')))
            ->diff(new \DateTimeImmutable($to, new \DateTimeZone('UTC')))->days + 1;
        if ($span > 92) {
            return $observed;
        }

        $out  = [];
        $date = $from;
        for ($i = 0; $i < $span; $i++) {
            $out[] = $date;
            $date  = self::addDays($date, 1);
        }

        return $out;
    }

    private static function bucketLabel(string $key, string $bucket): string
    {
        if ($bucket === 'hour') {
            $hour = (int) substr($key, 0, 2);

            return (($hour % 12) === 0 ? 12 : $hour % 12) . ($hour < 12 ? ' AM' : ' PM');
        }

        try {
            return (new \DateTimeImmutable($key, new \DateTimeZone('UTC')))->format('j M');
        } catch (\Throwable) {
            return $key;
        }
    }

    private static function hourRangeLabel(int $hour): string
    {
        $one = static fn (int $h): string => (($h % 12) === 0 ? 12 : $h % 12) . ($h < 12 || $h === 24 ? ' AM' : ' PM');

        return $one($hour) . '–' . $one(($hour + 1) % 24);
    }

    /**
     * A cashier without reports.view sees their own shifts and nobody else's.
     *
     * @param array<string, mixed> $params
     * @return array{0:string, 1:array<string, mixed>}
     */
    private function mineOnly(string $where, array $params): array
    {
        if ($this->win->seesEveryone) {
            return [$where, $params];
        }

        $where .= ' AND c.session_id IN (SELECT session_id FROM pos_register_sessions WHERE cmp_id = :mine_cmp AND opened_by = :mine_me)';
        $params['mine_cmp'] = $this->win->ctx->cmpId;
        $params['mine_me']  = $this->win->auth->uuid;

        return [$where, $params];
    }
}
