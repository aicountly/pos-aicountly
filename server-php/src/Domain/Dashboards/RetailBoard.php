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

    public function __construct(private readonly Window $win)
    {
    }

    /** @return array<string, mixed> */
    public function build(): array
    {
        return [
            'window'      => $this->win->describe(),
            'kpis'        => $this->kpis(),
            'counters'    => $this->counters(),
            'held_bills'  => $this->heldBills(),
            'recent'      => $this->recentTransactions(),
            'devices'     => $this->devices(),
            'stock'       => $this->stockAttention(),
            'attention'   => $this->exceptions(),
        ];
    }

    /** @return array<string, mixed> */
    private function kpis(): array
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
                    t.location_id, l.display_name AS location_name, l.location_code, l.pos_mode,
                    s.session_id, s.status AS shift_status, s.opened_by, s.opened_at, s.expected_cash,
                    (SELECT COUNT(*) FROM pos_carts c
                      WHERE c.cmp_id = t.cmp_id AND c.terminal_id = t.terminal_id AND c.status = 'COMPLETED'
                        AND c.created_at >= :win_from AND c.created_at < :win_to) AS bills,
                    (SELECT COALESCE(SUM(c.total_amount), 0) FROM pos_carts c
                      WHERE c.cmp_id = t.cmp_id AND c.terminal_id = t.terminal_id AND c.status = 'COMPLETED'
                        AND c.created_at >= :win_from AND c.created_at < :win_to) AS net,
                    (SELECT COUNT(*) FROM pos_carts c
                      WHERE c.cmp_id = t.cmp_id AND c.terminal_id = t.terminal_id AND c.status IN ('OPEN', 'HELD')) AS open_carts,
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

        return array_map(static function (array $r): array {
            $shift = $r['session_id'] === null ? null : [
                'session_id'    => (int) $r['session_id'],
                'status'        => (string) $r['shift_status'],
                'opened_by'     => (string) $r['opened_by'],
                'opened_at'     => (string) $r['opened_at'],
                'expected_cash' => (float) $r['expected_cash'],
            ];

            return [
                'terminal_id'   => (int) $r['terminal_id'],
                'terminal_code' => (string) $r['terminal_code'],
                'display_name'  => $r['display_name'] === null ? (string) $r['terminal_code'] : (string) $r['display_name'],
                'terminal_kind' => (string) $r['terminal_kind'],
                'location_id'   => (int) $r['location_id'],
                'location_name' => $r['location_name'] === null ? (string) $r['location_code'] : (string) $r['location_name'],
                'pos_mode'      => (string) $r['pos_mode'],
                'shift'         => $shift,
                'state'         => $shift === null ? 'closed' : ((int) $r['open_carts'] > 0 ? 'busy' : 'open'),
                'bills'         => (int) $r['bills'],
                'net'           => (float) $r['net'],
                'open_carts'    => (int) $r['open_carts'],
                'last_activity' => $r['last_activity'] === null ? null : (string) $r['last_activity'],
            ];
        }, $rows);
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

    private function exceptionCount(): int
    {
        $e = $this->exceptions();
        $approvals = 0;
        foreach ($e['approvals'] as $row) {
            if (in_array($row['event_kind'], ['no_sale', 'price_override', 'discount'], true)) {
                $approvals += $row['count'];
            }
        }

        return $e['voids'] + $e['stuck'] + $approvals;
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
