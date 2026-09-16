<?php

declare(strict_types=1);

namespace Aicountly\Api\Domain\Dashboards;

use Aicountly\Api\Clients\InventoryClient;
use Aicountly\Api\Db;
use Aicountly\Api\IntegrationCommand;
use Aicountly\Api\Permissions;

/**
 * Business Overview — what the shop took, where, and what needs a person.
 *
 * WHAT "NET SALES" MEANS HERE, because a dashboard that will not say is a
 * dashboard nobody can act on:
 *
 *   net sales = SUM(pos_carts.total_amount) over carts with status COMPLETED,
 *               whose created_at falls inside the outlet's business day
 *
 *   • TAX-INCLUSIVE. total_amount is what the customer paid at the counter.
 *   • Discounts are already deducted (they reduce the line and the total).
 *   • VOID carts are excluded entirely — a void never happened.
 *   • RETURNS ARE NOT DEDUCTED. They are shown as their own figure, because a
 *     refund against last week's sale would otherwise silently reduce today's
 *     takings and nobody could reconcile the drawer. The screen labels both.
 *   • This is THIS POS' counted takings. Books owns the accounting figure and
 *     it can legitimately differ; the screen says so rather than implying one
 *     number under two meanings.
 *
 * Every SUM runs in PostgreSQL over NUMERIC(18,4) columns, so the arithmetic is
 * decimal. PHP sees the result only to put it in JSON.
 */
final class OverviewBoard
{
    /**
     * Panels that other panels read.
     *
     * The daily brief is built from the same counts the KPI cards and the
     * attention list show, so without this each of those aggregates ran three
     * times per request — three passes over pos_carts to render one screen.
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
            'window'      => $this->win->describe(),
            'metric_basis' => [
                'net_sales' => 'Tax-inclusive counter takings on completed bills. Discounts deducted, voids excluded, returns shown separately.',
                'returns'   => 'Refund value of returns raised in this window, whatever date the original sale was.',
                'source'    => 'Counted from this POS. Books owns the accounting figure and it can differ.',
            ],
            'sales'       => $this->sales(),
            'comparison'  => $this->comparison(),
            'series'      => $this->series(),
            'outlets'     => $this->outlets(),
            'tenders'     => $this->tenders(),
            'top_items'   => $this->topItems(),
            'margin'      => $this->margin(),
            'attention'   => $this->attention(),
            'insights'    => $this->insights(),
        ];
    }

    /** @return array<string, mixed> */
    private function sales(): array
    {
        return $this->once('sales', fn (): array => $this->computeSales());
    }

    /** @return array<string, mixed> */
    private function computeSales(): array
    {
        [$where, $params] = $this->win->clause('c');
        [$where, $params] = $this->win->narrow($where, $params, 'c');

        $row = Db::first(
            "SELECT COUNT(*) AS bills,
                    COALESCE(SUM(c.total_amount), 0)          AS net,
                    COALESCE(SUM(c.discount_amount), 0)       AS discount,
                    COALESCE(SUM(c.estimated_tax_amount), 0)  AS estimated_tax,
                    COALESCE(AVG(c.total_amount), 0)          AS average_bill,
                    COUNT(DISTINCT c.terminal_id)             AS tills_used
             FROM pos_carts c
             WHERE {$where} AND c.status = 'COMPLETED'",
            $params,
        ) ?? [];

        [$rWhere, $rParams] = $this->win->clause('r');
        $returns = Db::first(
            "SELECT COUNT(*) AS count, COALESCE(SUM(r.refund_amount), 0) AS amount
             FROM pos_returns r
             WHERE {$rWhere} AND r.status <> 'CANCELLED'",
            $rParams,
        ) ?? [];

        [$tScope, $tParams] = $this->win->terminalScope('t');
        $counters = Db::first(
            "SELECT COUNT(*) FILTER (WHERE t.is_active) AS active_tills,
                    COUNT(*) FILTER (WHERE s.session_id IS NOT NULL) AS open_shifts
             FROM pos_terminals t
             LEFT JOIN pos_register_sessions s
               ON s.terminal_id = t.terminal_id AND s.cmp_id = t.cmp_id AND s.status IN ('OPEN', 'CLOSING')
             WHERE {$tScope}",
            $tParams,
        ) ?? [];

        return [
            'bills'         => (int) ($row['bills'] ?? 0),
            'net'           => (float) ($row['net'] ?? 0),
            'discount'      => (float) ($row['discount'] ?? 0),
            'estimated_tax' => (float) ($row['estimated_tax'] ?? 0),
            'average_bill'  => round((float) ($row['average_bill'] ?? 0), 2),
            'returns_count' => (int) ($returns['count'] ?? 0),
            'returns_value' => (float) ($returns['amount'] ?? 0),
            'active_tills'  => (int) ($counters['active_tills'] ?? 0),
            'open_shifts'   => (int) ($counters['open_shifts'] ?? 0),
        ];
    }

    /**
     * The same figures over the comparison window, or null.
     *
     * Null rather than zero: "no comparison was asked for" and "the same day
     * last week took nothing" are different facts and a percentage cannot be
     * computed from the first.
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

        $row = Db::first(
            "SELECT COUNT(*) AS bills,
                    COALESCE(SUM(c.total_amount), 0) AS net,
                    COALESCE(AVG(c.total_amount), 0) AS average_bill
             FROM pos_carts c
             WHERE {$where} AND c.status = 'COMPLETED'",
            $params,
        ) ?? [];

        return [
            'label'        => $this->win->compareLabel,
            'bills'        => (int) ($row['bills'] ?? 0),
            'net'          => (float) ($row['net'] ?? 0),
            'average_bill' => round((float) ($row['average_bill'] ?? 0), 2),
        ];
    }

    /**
     * Sales across the window: by hour for a single day, by day otherwise.
     *
     * Bucketed in the OUTLET's timezone, not the server's, or a 9pm sale in
     * Kolkata appears in the wrong hour and the evening peak disappears.
     *
     * @return array<string, mixed>
     */
    private function series(): array
    {
        $singleDay = $this->win->from === $this->win->to;
        $bucket = $singleDay ? 'hour' : 'day';

        [$where, $params] = $this->win->clause('c');
        [$where, $params] = $this->win->narrow($where, $params, 'c');
        $params['tz'] = $this->win->timezone;

        $expr = $singleDay
            ? "to_char(date_trunc('hour', c.created_at AT TIME ZONE :tz), 'HH24:00')"
            : "to_char(date_trunc('day', c.created_at AT TIME ZONE :tz), 'YYYY-MM-DD')";

        $rows = Db::all(
            "SELECT {$expr} AS bucket,
                    COUNT(*) AS bills,
                    COALESCE(SUM(c.total_amount), 0) AS net
             FROM pos_carts c
             WHERE {$where} AND c.status = 'COMPLETED'
             GROUP BY 1 ORDER BY 1",
            $params,
        );

        $comparisonPoints = [];
        $clause = $this->win->comparisonClause('c');
        if ($clause !== null) {
            [$cWhere, $cParams] = $clause;
            [$cWhere, $cParams] = $this->win->narrow($cWhere, $cParams, 'c');
            $cParams['tz'] = $this->win->timezone;

            foreach (Db::all(
                "SELECT {$expr} AS bucket, COALESCE(SUM(c.total_amount), 0) AS net
                 FROM pos_carts c WHERE {$cWhere} AND c.status = 'COMPLETED'
                 GROUP BY 1 ORDER BY 1",
                $cParams,
            ) as $row) {
                $comparisonPoints[(string) $row['bucket']] = (float) $row['net'];
            }
        }

        return [
            'bucket' => $bucket,
            'points' => array_map(static fn (array $r): array => [
                'bucket' => (string) $r['bucket'],
                'bills'  => (int) $r['bills'],
                'net'    => (float) $r['net'],
            ], $rows),
            // Keyed by the same bucket label so the chart can pair them without
            // assuming the two windows have the same number of points.
            'comparison_by_bucket' => $comparisonPoints === [] ? null : $comparisonPoints,
        ];
    }

    /**
     * Per outlet, with target achievement ONLY where a target was set.
     *
     * @return list<array<string, mixed>>
     */
    private function outlets(): array
    {
        [$where, $params] = $this->win->clause('c');
        $params['cmp'] = $this->win->ctx->cmpId;

        $outletFilter = '';
        if ($this->win->locationId !== null) {
            $outletFilter = ' AND l.location_id = :only_loc';
            $params['only_loc'] = $this->win->locationId;
        }

        $days = max(1, (int) (new \DateTimeImmutable($this->win->from))
            ->diff(new \DateTimeImmutable($this->win->to))->days + 1);
        $params['days'] = $days;

        $rows = Db::all(
            "SELECT l.location_id, l.location_code, l.display_name, l.pos_mode, l.daily_target,
                    COUNT(c.cart_id) AS bills,
                    COALESCE(SUM(c.total_amount), 0) AS net,
                    COALESCE(AVG(c.total_amount), 0) AS average_bill,
                    CASE WHEN l.daily_target IS NULL THEN NULL
                         ELSE l.daily_target * :days END AS target
             FROM pos_location_profiles l
             LEFT JOIN pos_terminals t ON t.location_id = l.location_id AND t.cmp_id = l.cmp_id
             LEFT JOIN pos_carts c ON c.terminal_id = t.terminal_id AND c.status = 'COMPLETED' AND {$where}
             WHERE l.cmp_id = :cmp AND l.is_active = TRUE{$outletFilter}
             GROUP BY l.location_id, l.location_code, l.display_name, l.pos_mode, l.daily_target
             ORDER BY COALESCE(SUM(c.total_amount), 0) DESC, l.location_code",
            $params,
        );

        // Exceptions per outlet, counted separately so an outlet with none is a
        // zero rather than a missing row.
        $stuck = $this->stuckByLocation();

        return array_map(static function (array $r) use ($stuck): array {
            $target = $r['target'] === null ? null : (float) $r['target'];
            $net    = (float) $r['net'];
            $id     = (int) $r['location_id'];

            return [
                'location_id'   => $id,
                'location_code' => (string) $r['location_code'],
                'display_name'  => $r['display_name'] === null ? (string) $r['location_code'] : (string) $r['display_name'],
                'pos_mode'      => (string) $r['pos_mode'],
                'bills'         => (int) $r['bills'],
                'net'           => $net,
                'average_bill'  => round((float) $r['average_bill'], 2),
                'target'        => $target,
                'target_pc'     => $target === null || $target <= 0 ? null : round($net / $target * 100, 1),
                'exceptions'    => $stuck[$id] ?? 0,
            ];
        }, $rows);
    }

    /** @return array<int, int> */
    private function stuckByLocation(): array
    {
        $rows = Db::all(
            "SELECT t.location_id, COUNT(*) AS stuck
             FROM " . IntegrationCommand::TABLE . " k
             JOIN pos_carts c ON c.cart_id = k.entity_id AND k.entity_type = 'cart' AND c.cmp_id = k.cmp_id
             JOIN pos_terminals t ON t.terminal_id = c.terminal_id
             WHERE k.cmp_id = :cmp AND k.status IN ('FAILED', 'BLOCKED')
             GROUP BY t.location_id",
            ['cmp' => $this->win->ctx->cmpId],
        );

        $out = [];
        foreach ($rows as $row) {
            $out[(int) $row['location_id']] = (int) $row['stuck'];
        }

        return $out;
    }

    /** @return list<array<string, mixed>> */
    private function tenders(): array
    {
        [$where, $params] = $this->win->clause('c');
        [$where, $params] = $this->win->narrow($where, $params, 'c');

        $rows = Db::all(
            "SELECT p.payment_mode, SUM(p.amount) AS amount, COUNT(*) AS count
             FROM pos_cart_payments p
             JOIN pos_carts c ON c.cart_id = p.cart_id
             WHERE {$where} AND c.status = 'COMPLETED'
             GROUP BY p.payment_mode
             ORDER BY SUM(p.amount) DESC",
            $params,
        );

        return array_map(static fn (array $r): array => Tenders::describe($r), $rows);
    }

    /** @return list<array<string, mixed>> */
    private function topItems(): array
    {
        [$where, $params] = $this->win->clause('c');
        [$where, $params] = $this->win->narrow($where, $params, 'c');

        $rows = Db::all(
            "SELECT l.item_id, l.display_name,
                    SUM(l.quantity) AS qty,
                    SUM(l.line_amount) AS amount
             FROM pos_cart_lines l
             JOIN pos_carts c ON c.cart_id = l.cart_id
             WHERE {$where} AND c.status = 'COMPLETED'
             GROUP BY l.item_id, l.display_name
             ORDER BY SUM(l.line_amount) DESC
             LIMIT 10",
            $params,
        );

        // Returned quantity for the same items, so "sold 40, 6 came back" is one
        // row rather than two screens.
        $returned = [];
        [$rWhere, $rParams] = $this->win->clause('r');
        foreach (Db::all(
            "SELECT rl.item_id, SUM(rl.return_qty) AS qty
             FROM pos_return_lines rl
             JOIN pos_returns r ON r.return_id = rl.return_id
             WHERE {$rWhere} AND r.status <> 'CANCELLED' AND rl.item_id IS NOT NULL
             GROUP BY rl.item_id",
            $rParams,
        ) as $row) {
            $returned[(int) $row['item_id']] = (float) $row['qty'];
        }

        return array_map(static function (array $r) use ($returned): array {
            $itemId = $r['item_id'] === null ? null : (int) $r['item_id'];

            return [
                'item_id'       => $itemId,
                'display_name'  => (string) $r['display_name'],
                'qty'           => (float) $r['qty'],
                'amount'        => (float) $r['amount'],
                'returned_qty'  => $itemId === null ? 0.0 : ($returned[$itemId] ?? 0.0),
            ];
        }, $rows);
    }

    /**
     * Gross margin — only with the permission AND only if Inventory answers.
     *
     * SELLING PRICE IS NOT COST. The cost of what went out is Inventory's, read
     * live per item at the moment of the check and never stored here. When the
     * caller may not see margin, or Inventory cannot be reached, this returns
     * an explicit unavailable state and the screen shows no margin card at all
     * — rather than a margin computed from the only number POS happens to hold,
     * which is the price the customer paid.
     *
     * @return array<string, mixed>
     */
    private function margin(): array
    {
        if (!Permissions::allows($this->win->ctx, $this->win->auth, 'margin.view')) {
            return ['available' => false, 'reason' => 'not_permitted', 'note' => 'You do not have permission to see margin.'];
        }

        [$where, $params] = $this->win->clause('c');
        [$where, $params] = $this->win->narrow($where, $params, 'c');

        $lines = Db::all(
            "SELECT l.item_id, SUM(l.quantity) AS qty, SUM(l.line_amount) AS amount
             FROM pos_cart_lines l
             JOIN pos_carts c ON c.cart_id = l.cart_id
             WHERE {$where} AND c.status = 'COMPLETED' AND l.item_id IS NOT NULL
             GROUP BY l.item_id
             LIMIT 200",
            $params,
        );

        if ($lines === []) {
            return ['available' => false, 'reason' => 'no_sales', 'note' => 'Nothing sold in this window.'];
        }

        $itemIds = array_map(static fn (array $r): int => (int) $r['item_id'], $lines);
        $response = (new InventoryClient())
            ->withSession($this->win->auth->sesKey())
            ->unitCosts($this->win->ctx, $itemIds, $this->win->to);

        if (!($response['ok'] ?? false)) {
            return [
                'available' => false,
                'reason'    => 'inventory_unavailable',
                'note'      => 'Inventory could not be reached, so cost is unknown. Margin is not shown rather than guessed.',
            ];
        }

        $costs = [];
        $body = $response['body'] ?? [];
        foreach (($body['data'] ?? $body) as $row) {
            if (!is_array($row)) {
                continue;
            }
            $id = (int) ($row['item_id'] ?? 0);
            if ($id > 0 && isset($row['unit_cost'])) {
                $costs[$id] = (float) $row['unit_cost'];
            }
        }

        $revenue = 0.0;
        $cost    = 0.0;
        $priced  = 0;
        foreach ($lines as $line) {
            $id = (int) $line['item_id'];
            if (!isset($costs[$id])) {
                continue;
            }
            $revenue += (float) $line['amount'];
            $cost    += $costs[$id] * (float) $line['qty'];
            $priced++;
        }

        if ($priced === 0) {
            return [
                'available' => false,
                'reason'    => 'no_costs',
                'note'      => 'Inventory holds no unit cost for the items sold in this window.',
            ];
        }

        return [
            'available'      => true,
            // Line value BEFORE tax, deliberately: margin against a
            // tax-inclusive figure would count the government's share as the
            // shop's. It is therefore a different number from the Net sales
            // card above, and the note says which is which.
            'revenue'        => round($revenue, 2),
            'revenue_basis'  => 'Sale value of the costed lines, before tax. The Net sales card is tax-inclusive, so the two differ.',
            'cost'           => round($cost, 2),
            'gross_margin'   => round($revenue - $cost, 2),
            'margin_pc'      => $revenue > 0 ? round(($revenue - $cost) / $revenue * 100, 1) : null,
            'items_costed'   => $priced,
            'items_total'    => count($lines),
            'note'           => 'Sale value before tax, less Inventory\'s own unit cost. Cost is read live from Inventory and never stored here. '
                . ($priced < count($lines) ? 'Some items had no cost and are excluded.' : 'Every item sold had a cost.'),
        ];
    }

    /**
     * What is waiting for a person right now.
     *
     * Deliberately separate counters rather than one "issues" number: a sale
     * that Books refused and a drawer that is short need different people.
     *
     * @return array<string, mixed>
     */
    private function attention(): array
    {
        return $this->once('attention', fn (): array => $this->computeAttention());
    }

    /** @return array<string, mixed> */
    private function computeAttention(): array
    {
        $cmp = ['cmp' => $this->win->ctx->cmpId];

        $commands = Db::first(
            "SELECT COUNT(*) FILTER (WHERE status = 'FAILED')  AS failed,
                    COUNT(*) FILTER (WHERE status = 'BLOCKED') AS blocked,
                    COUNT(*) FILTER (WHERE status IN ('PENDING', 'POSTING')) AS in_flight
             FROM " . IntegrationCommand::TABLE . " WHERE cmp_id = :cmp",
            $cmp,
        ) ?? [];

        $offline = (int) Db::scalar(
            "SELECT COUNT(*) FROM pos_offline_submissions
             WHERE cmp_id = :cmp AND status NOT IN ('POSTED', 'ABANDONED')",
            $cmp,
        );

        $variances = (int) Db::scalar(
            "SELECT COUNT(*) FROM pos_register_sessions
             WHERE cmp_id = :cmp AND status = 'CLOSED' AND variance IS NOT NULL
               AND ABS(variance) > 0.0001 AND approved_by IS NULL",
            $cmp,
        );

        $lateTickets = (int) Db::scalar(
            "SELECT COUNT(*) FROM pos_kots k
             LEFT JOIN pos_kds_stations st ON st.station_id = k.station_id
             WHERE k.cmp_id = :cmp AND k.status IN ('NEW', 'ACCEPTED', 'PREPARING')
               AND k.fired_at < NOW() - (COALESCE(st.late_after_minutes, 15) || ' minutes')::interval",
            $cmp,
        );

        $heldBills = (int) Db::scalar(
            "SELECT COUNT(*) FROM pos_carts WHERE cmp_id = :cmp AND status = 'HELD'",
            $cmp,
        );

        return [
            'posting_failed'   => (int) ($commands['failed'] ?? 0),
            'posting_blocked'  => (int) ($commands['blocked'] ?? 0),
            'posting_in_flight' => (int) ($commands['in_flight'] ?? 0),
            'offline_pending'  => $offline,
            'cash_variances'   => $variances,
            'late_tickets'     => $lateTickets,
            'held_bills'       => $heldBills,
        ];
    }

    /**
     * The daily brief.
     *
     * RULE-BASED, and labelled as such. Every item here is a threshold crossing
     * computed from POS' own rows — a count, a comparison, a timer. None of it
     * is a model output, so none of it is called an AI suggestion, and there is
     * no confidence percentage because nothing here produces one.
     *
     * A separate AI briefing lands on this panel when POS' own authorised model
     * integration exists; until it does, the honest thing on screen is the
     * deterministic alerts plus a note saying which of the two you are reading.
     *
     * @return array<string, mixed>
     */
    private function insights(): array
    {
        $attention = $this->attention();
        $sales     = $this->sales();
        $items     = [];

        if ($attention['posting_blocked'] > 0) {
            $items[] = [
                'id'          => 'posting-blocked',
                'kind'        => 'rule',
                'severity'    => 'danger',
                'title'       => $attention['posting_blocked'] . ' sale(s) Books or Inventory refused',
                'explanation' => 'These were refused for a business reason — a locked period, a deactivated item, a customer on hold. '
                    . 'Retrying will not help until the cause is fixed.',
                'evidence_href' => '/controls?panel=posting',
                'action_label'  => 'Open posting exceptions',
                'period_label'  => 'Right now, all dates',
            ];
        }

        if ($attention['posting_failed'] > 0) {
            $items[] = [
                'id'          => 'posting-failed',
                'kind'        => 'rule',
                'severity'    => 'warning',
                'title'       => $attention['posting_failed'] . ' sale(s) have not reached Books or Inventory',
                'explanation' => 'A transport failure. The original idempotency key is kept, so a retry lands on the same '
                    . 'invoice rather than billing the customer twice.',
                'evidence_href' => '/controls?panel=posting',
                'action_label'  => 'Retry from posting exceptions',
                'period_label'  => 'Right now, all dates',
            ];
        }

        if ($attention['cash_variances'] > 0) {
            $items[] = [
                'id'          => 'cash-variance',
                'kind'        => 'rule',
                'severity'    => 'warning',
                'title'       => $attention['cash_variances'] . ' closed shift(s) are out and unapproved',
                'explanation' => 'The drawer did not match what this shift\'s own events say it should hold, and nobody has signed for the difference.',
                'evidence_href' => '/controls?panel=shifts',
                'action_label'  => 'Review shift closings',
                'period_label'  => 'Right now, all dates',
            ];
        }

        if ($attention['late_tickets'] > 0) {
            $items[] = [
                'id'          => 'late-tickets',
                'kind'        => 'rule',
                'severity'    => 'warning',
                'title'       => $attention['late_tickets'] . ' kitchen ticket(s) past their station time',
                'explanation' => 'Measured against each station\'s own late-after minutes. This is a timer, not a prediction.',
                'evidence_href' => '/restaurant?panel=delays',
                'action_label'  => 'Open the kitchen board',
                'period_label'  => 'Right now',
            ];
        }

        $comparison = $this->comparison();
        if ($comparison !== null && $comparison['net'] > 0) {
            $change = ($sales['net'] - $comparison['net']) / $comparison['net'] * 100;
            if (abs($change) >= 15) {
                $items[] = [
                    'id'          => 'sales-swing',
                    'kind'        => 'rule',
                    'severity'    => $change > 0 ? 'success' : 'warning',
                    'title'       => 'Takings are ' . ($change > 0 ? 'up' : 'down') . ' ' . abs(round($change)) . '% ' . $comparison['label'],
                    'explanation' => 'Counter takings this window against the comparison window. Both figures are on this screen.',
                    'evidence_href' => '/overview',
                    'action_label'  => null,
                    'period_label'  => $this->win->from . ' — ' . $this->win->to,
                ];
            }
        }

        return [
            'items' => array_slice($items, 0, 3),
            // Said out loud so an "AI suggestion" badge never appears over a
            // threshold check.
            'ai' => [
                'available' => false,
                'reason'    => 'not_configured',
                'note'      => 'POS has no model integration configured, so nothing on this panel is model-generated. '
                    . 'The items above are deterministic alerts computed from this POS\' own rows.',
            ],
            'generated_at' => gmdate('c'),
            'sufficient_data' => $sales['bills'] > 0 || $items !== [],
        ];
    }
}
