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

    /**
     * The window clause for returns, narrowed the same way carts are.
     *
     * `pos_returns` carries `terminal_id`, so an outlet or till filter applies
     * to a refund exactly as it applies to a sale. Without this the Returns
     * card answered for the whole company while every other figure beside it
     * answered for one outlet, and the two were read as one story.
     *
     * @return array{0:string, 1:array<string, mixed>}
     */
    private function returnsClause(bool $comparison = false): array
    {
        $clause = $comparison ? $this->win->comparisonClause('r') : $this->win->clause('r');
        if ($clause === null) {
            return ['FALSE', []];
        }

        [$where, $params] = $clause;

        return $this->win->narrow($where, $params, 'r');
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
            'returns_voids' => $this->returnsVoids(),
            'activity'    => $this->activity(),
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
                    COUNT(*) FILTER (WHERE c.discount_amount > 0) AS discounted_bills,
                    COUNT(DISTINCT c.terminal_id)             AS tills_used
             FROM pos_carts c
             WHERE {$where} AND c.status = 'COMPLETED'",
            $params,
        ) ?? [];

        [$rWhere, $rParams] = $this->returnsClause();
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
            'discounted_bills' => (int) ($row['discounted_bills'] ?? 0),
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
                    COALESCE(AVG(c.total_amount), 0) AS average_bill,
                    COUNT(*) FILTER (WHERE c.discount_amount > 0) AS discounted_bills
             FROM pos_carts c
             WHERE {$where} AND c.status = 'COMPLETED'",
            $params,
        ) ?? [];

        [$rWhere, $rParams] = $this->returnsClause(true);
        $returns = Db::first(
            "SELECT COUNT(*) AS count, COALESCE(SUM(r.refund_amount), 0) AS amount
             FROM pos_returns r
             WHERE {$rWhere} AND r.status <> 'CANCELLED'",
            $rParams,
        ) ?? [];

        return [
            'label'         => $this->win->compareLabel,
            'bills'         => (int) ($row['bills'] ?? 0),
            'net'           => (float) ($row['net'] ?? 0),
            'average_bill'  => round((float) ($row['average_bill'] ?? 0), 2),
            'discounted_bills' => (int) ($row['discounted_bills'] ?? 0),
            'returns_count' => (int) ($returns['count'] ?? 0),
            'returns_value' => (float) ($returns['amount'] ?? 0),
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
        return $this->once('series', fn (): array => $this->computeSeries());
    }

    /** @return array<string, mixed> */
    private function computeSeries(): array
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

        // Refunds on the same buckets, so the Returns card has a shape and not
        // just a total. Keyed rather than joined: a bucket with a refund and no
        // sale is real, and an inner join would drop it.
        $refunds = [];
        [$rWhere, $rParams] = $this->returnsClause();
        $rParams['tz'] = $this->win->timezone;
        $rExpr = $singleDay
            ? "to_char(date_trunc('hour', r.created_at AT TIME ZONE :tz), 'HH24:00')"
            : "to_char(date_trunc('day', r.created_at AT TIME ZONE :tz), 'YYYY-MM-DD')";

        foreach (Db::all(
            "SELECT {$rExpr} AS bucket, COALESCE(SUM(r.refund_amount), 0) AS amount
             FROM pos_returns r
             WHERE {$rWhere} AND r.status <> 'CANCELLED'
             GROUP BY 1",
            $rParams,
        ) as $row) {
            $refunds[(string) $row['bucket']] = (float) $row['amount'];
        }

        return [
            'bucket' => $bucket,
            'points' => array_map(static fn (array $r): array => [
                'bucket'  => (string) $r['bucket'],
                'bills'   => (int) $r['bills'],
                'net'     => (float) $r['net'],
                'returns' => $refunds[(string) $r['bucket']] ?? 0.0,
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
        return $this->once('outlets', fn (): array => $this->computeOutlets());
    }

    /** @return list<array<string, mixed>> */
    private function computeOutlets(): array
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
        return $this->once('top_items', fn (): array => $this->computeTopItems());
    }

    /** @return list<array<string, mixed>> */
    private function computeTopItems(): array
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
        [$rWhere, $rParams] = $this->returnsClause();
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
     * Why money went back over the counter.
     *
     * A RETURN AND A VOID ARE NOT THE SAME EVENT and are counted separately
     * here even though the panel stacks them in one list. A return moves goods
     * and raises a credit; a void says the sale never happened and moves
     * nothing. Adding them would produce a "refunded" figure that reconciles
     * against nothing, so each keeps its own count, its own value and its own
     * `kind`, and the screen labels which is which.
     *
     * Voids are valued at the cart total for sizing only — no money changed
     * hands, and `amount_is_money` says so rather than leaving a reader to
     * assume the column means the same thing on every row.
     *
     * @return array<string, mixed>
     */
    private function returnsVoids(): array
    {
        return $this->once('returns_voids', fn (): array => $this->computeReturnsVoids());
    }

    /** @return array<string, mixed> */
    private function computeReturnsVoids(): array
    {
        [$rWhere, $rParams] = $this->returnsClause();

        $returns = Db::all(
            "SELECT COALESCE(NULLIF(BTRIM(r.reason_code), ''), 'unspecified') AS reason,
                    COUNT(*) AS count,
                    COALESCE(SUM(r.refund_amount), 0) AS amount
             FROM pos_returns r
             WHERE {$rWhere} AND r.status <> 'CANCELLED'
             GROUP BY 1
             ORDER BY SUM(r.refund_amount) DESC, COUNT(*) DESC
             LIMIT 8",
            $rParams,
        );

        [$vWhere, $vParams] = $this->win->clause('c');
        [$vWhere, $vParams] = $this->win->narrow($vWhere, $vParams, 'c');

        $voids = Db::all(
            "SELECT COALESCE(NULLIF(BTRIM(c.void_reason), ''), 'unspecified') AS reason,
                    COUNT(*) AS count,
                    COALESCE(SUM(c.total_amount), 0) AS amount
             FROM pos_carts c
             WHERE {$vWhere} AND c.status = 'VOID'
             GROUP BY 1
             ORDER BY COUNT(*) DESC
             LIMIT 8",
            $vParams,
        );

        $line = static function (array $row, string $kind): array {
            $reason = (string) $row['reason'];

            return [
                'kind'            => $kind,
                'reason'          => $reason,
                'display_name'    => self::reasonName($reason),
                'count'           => (int) $row['count'],
                'amount'          => (float) $row['amount'],
                'amount_is_money' => $kind === 'return',
            ];
        };

        $returnLines = array_map(static fn (array $r): array => $line($r, 'return'), $returns);
        $voidLines   = array_map(static fn (array $r): array => $line($r, 'void'), $voids);

        return [
            'returns' => $returnLines,
            'voids'   => $voidLines,
            'totals'  => [
                'returns_count' => array_sum(array_column($returnLines, 'count')),
                'returns_value' => array_sum(array_column($returnLines, 'amount')),
                'voids_count'   => array_sum(array_column($voidLines, 'count')),
                'voids_value'   => array_sum(array_column($voidLines, 'amount')),
            ],
            'note' => 'Returns move goods and raise a credit. Voids cancel a bill before it was ever taken, '
                . 'so a void\'s value is what the bill would have been and is not money that went back.',
        ];
    }

    /** A reason code as a cashier would say it. Unknown codes are shown, not swallowed. */
    private static function reasonName(string $code): string
    {
        return match (strtolower(trim($code))) {
            'unspecified'      => 'No reason recorded',
            'item_cancelled'   => 'Item cancelled',
            'wrong_item'       => 'Wrong item',
            'customer_change'  => 'Customer changed their mind',
            'quality_issue'    => 'Quality issue',
            'damaged'          => 'Damaged',
            'expired'          => 'Expired',
            'price_error'      => 'Price error',
            'billing_error'    => 'Billing error',
            'duplicate'        => 'Duplicate bill',
            'training'         => 'Training / test bill',
            'other'            => 'Other',
            default            => ucfirst(str_replace('_', ' ', strtolower(trim($code)))),
        };
    }

    /**
     * When the counter is busy: business day of the week against hour of the day.
     *
     * TWO DIFFERENT CLOCKS, deliberately. The COLUMN is the wall-clock hour in
     * the outlet's timezone, because "when is the lunch rush" is a question
     * about the clock on the wall. The ROW is the BUSINESS day the sale belongs
     * to, shifted by the outlet's day-start — so a bar's 1am Saturday takings
     * land on Friday's row, the same way they land on Friday everywhere else on
     * this board.
     *
     * Returned as raw hourly cells. The screen bins them into the columns it
     * has room for; binning here would fix the shape of a picture in the API.
     *
     * @return array<string, mixed>
     */
    private function activity(): array
    {
        [$where, $params] = $this->win->clause('c');
        [$where, $params] = $this->win->narrow($where, $params, 'c');
        $params['tz'] = $this->win->timezone;
        $params['day_start'] = (string) $this->win->dayStartMinutes;

        $local = "(c.created_at AT TIME ZONE :tz)";
        $businessDate = "({$local} - (:day_start || ' minutes')::interval)";

        $rows = Db::all(
            "SELECT EXTRACT(ISODOW FROM {$businessDate})::int AS dow,
                    EXTRACT(HOUR FROM {$local})::int AS hour,
                    COUNT(*) AS bills,
                    COALESCE(SUM(c.total_amount), 0) AS net
             FROM pos_carts c
             WHERE {$where} AND c.status = 'COMPLETED'
             GROUP BY 1, 2
             ORDER BY 1, 2",
            $params,
        );

        return [
            // 1 = Monday, 7 = Sunday, matching ISO and the row order on screen.
            'cells' => array_map(static fn (array $r): array => [
                'dow'   => (int) $r['dow'],
                'hour'  => (int) $r['hour'],
                'bills' => (int) $r['bills'],
                'net'   => (float) $r['net'],
            ], $rows),
            'timezone' => $this->win->timezone,
            'basis'    => 'Completed bills only, by the outlet\'s own clock. The day is the business day, '
                . 'so a late-night sale stays on the day it was trading.',
        ];
    }

    /**
     * Net takings per till, for the productivity rule.
     *
     * Only tills that were actually open are compared: a till nobody signed on
     * to is not an underperforming till, and including it would make every
     * quiet shop look like it had a problem counter.
     *
     * @return list<array<string, mixed>>
     */
    private function counterProductivity(): array
    {
        return $this->once('counters', function (): array {
            [$where, $params] = $this->win->clause('c');
            [$where, $params] = $this->win->narrow($where, $params, 'c');
            [$tScope, $tParams] = $this->win->terminalScope('t');

            return array_map(static fn (array $r): array => [
                'terminal_id'   => (int) $r['terminal_id'],
                'display_name'  => $r['display_name'] === null || $r['display_name'] === ''
                    ? (string) $r['terminal_code']
                    : (string) $r['display_name'],
                'bills'         => (int) $r['bills'],
                'net'           => (float) $r['net'],
            ], Db::all(
                "SELECT t.terminal_id, t.terminal_code, t.display_name,
                        COUNT(c.cart_id) AS bills,
                        COALESCE(SUM(c.total_amount), 0) AS net
                 FROM pos_terminals t
                 LEFT JOIN pos_carts c
                   ON c.terminal_id = t.terminal_id AND c.status = 'COMPLETED' AND {$where}
                 WHERE {$tScope} AND t.is_active = TRUE
                 GROUP BY t.terminal_id, t.terminal_code, t.display_name
                 HAVING COUNT(c.cart_id) > 0
                 ORDER BY COALESCE(SUM(c.total_amount), 0) DESC",
                $params + $tParams,
            ));
        });
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
     * The briefing strip.
     *
     * RULE-BASED, AND LABELLED AS SUCH. Every item here is a threshold crossing
     * computed from this POS' own rows — a count, a ratio, a comparison against
     * the window the person chose. None of it is a model output, so none of it
     * is called an AI suggestion and none of it carries a confidence, because
     * nothing here produces one. The strip is headed "Aicountly AI Insights"
     * because that is the surface a model will eventually publish to; until it
     * does, every card on it says "Rule-based alert" and the panel says why.
     *
     * A rule only fires when the numbers behind it exist. There is no "no data"
     * card, no placeholder and no rounded-up encouragement: a quiet shop gets a
     * short strip, which is the honest shape of a quiet shop.
     *
     * `metric` and `detail` are the two short lines the strip shows; `title`
     * and `explanation` are what the drawer shows. Both come from the same
     * numbers, so the summary can never disagree with the detail.
     *
     * @return array<string, mixed>
     */
    private function insights(): array
    {
        $attention = $this->attention();
        $sales     = $this->sales();
        $items     = [];

        $push = static function (array $item) use (&$items): void {
            $items[] = $item + [
                'kind'          => 'rule',
                'severity'      => 'info',
                'metric'        => null,
                'detail'        => null,
                'evidence_href' => null,
                'action_label'  => null,
            ];
        };

        if ($attention['posting_blocked'] > 0) {
            $push([
                'id'          => 'posting-blocked',
                'severity'    => 'danger',
                'title'       => 'Refused by Books or Inventory',
                'metric'      => $attention['posting_blocked'] . ' sale' . ($attention['posting_blocked'] === 1 ? '' : 's'),
                'detail'      => 'Retrying will not clear these',
                'explanation' => 'These were refused for a business reason — a locked period, a deactivated item, a customer on hold. '
                    . 'Retrying will not help until the cause is fixed.',
                'evidence_href' => '/controls?panel=posting',
                'action_label'  => 'Open posting exceptions',
                'period_label'  => 'Right now, all dates',
            ]);
        }

        if ($attention['posting_failed'] > 0) {
            $push([
                'id'          => 'posting-failed',
                'severity'    => 'warning',
                'title'       => 'Not yet reached Books or Inventory',
                'metric'      => $attention['posting_failed'] . ' sale' . ($attention['posting_failed'] === 1 ? '' : 's'),
                'detail'      => 'Safe to retry on the same key',
                'explanation' => 'A transport failure. The original idempotency key is kept, so a retry lands on the same '
                    . 'invoice rather than billing the customer twice.',
                'evidence_href' => '/controls?panel=posting',
                'action_label'  => 'Retry from posting exceptions',
                'period_label'  => 'Right now, all dates',
            ]);
        }

        if ($attention['cash_variances'] > 0) {
            $push([
                'id'          => 'cash-variance',
                'severity'    => 'warning',
                'title'       => 'Drawers out and unsigned',
                'metric'      => $attention['cash_variances'] . ' shift' . ($attention['cash_variances'] === 1 ? '' : 's'),
                'detail'      => 'Nobody has approved the difference',
                'explanation' => 'The drawer did not match what this shift\'s own events say it should hold, and nobody has signed for the difference.',
                'evidence_href' => '/controls?panel=shifts',
                'action_label'  => 'Review shift closings',
                'period_label'  => 'Right now, all dates',
            ]);
        }

        if ($attention['late_tickets'] > 0) {
            $push([
                'id'          => 'late-tickets',
                'severity'    => 'warning',
                'title'       => 'Kitchen tickets running late',
                'metric'      => $attention['late_tickets'] . ' ticket' . ($attention['late_tickets'] === 1 ? '' : 's'),
                'detail'      => 'Past their own station time',
                'explanation' => 'Measured against each station\'s own late-after minutes. This is a timer, not a prediction.',
                'evidence_href' => '/restaurant?panel=delays',
                'action_label'  => 'Open the kitchen board',
                'period_label'  => 'Right now',
            ]);
        }

        foreach ($this->derivedRules($sales) as $item) {
            $push($item);
        }

        // Worst first. A drawer that is out should not sit under a note about
        // the lunch rush because the lunch rush was computed first.
        $weight = ['danger' => 0, 'warning' => 1, 'success' => 2, 'info' => 3];
        usort($items, static fn (array $a, array $b): int => ($weight[$a['severity']] ?? 9) <=> ($weight[$b['severity']] ?? 9));

        return [
            'items' => array_slice($items, 0, 8),
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
            'context' => [
                'outlets' => count($this->outlets()),
                'bills'   => $sales['bills'],
                'items'   => count($this->topItems()),
            ],
        ];
    }

    /**
     * The rules that read the trading figures rather than the queues.
     *
     * Each one states the number it fired on. A rule that cannot state its own
     * number does not fire.
     *
     * @param array<string, mixed> $sales
     * @return list<array<string, mixed>>
     */
    private function derivedRules(array $sales): array
    {
        $items      = [];
        $comparison = $this->comparison();
        $net        = (float) $sales['net'];
        $bills      = (int) $sales['bills'];
        $period     = $this->win->from === $this->win->to
            ? $this->win->from
            : $this->win->from . ' — ' . $this->win->to;

        // --- Takings against the comparison window -------------------------
        if ($comparison !== null && $comparison['net'] > 0) {
            $change = ($net - $comparison['net']) / $comparison['net'] * 100;
            if (abs($change) >= 15) {
                $items[] = [
                    'id'          => 'sales-swing',
                    'severity'    => $change > 0 ? 'success' : 'warning',
                    'title'       => 'Takings ' . ($change > 0 ? 'up' : 'down') . ' sharply',
                    'metric'      => ($change > 0 ? '+' : '-') . abs(round($change)) . '%',
                    'detail'      => (string) $comparison['label'],
                    'explanation' => 'Counter takings this window against the comparison window. Both figures are on this screen.',
                    'period_label' => $period,
                ];
            }
        }

        // --- When the counter was busiest ----------------------------------
        $peak = $this->peak();
        if ($peak !== null) {
            $items[] = [
                'id'          => 'peak-period',
                'severity'    => 'info',
                'title'       => $this->series()['bucket'] === 'hour' ? 'Peak hour' : 'Best day',
                'metric'      => $peak['label'],
                'detail'      => 'Took ' . $this->rupees($peak['net']) . ' over ' . $peak['bills'] . ' bill' . ($peak['bills'] === 1 ? '' : 's'),
                'explanation' => 'The busiest bucket by takings in this window, counted on completed bills in the outlet\'s own timezone.',
                'period_label' => $period,
            ];
        }

        // --- Discounting ---------------------------------------------------
        if ($bills > 0) {
            $rate = $sales['discounted_bills'] / $bills * 100;
            $baseline = $comparison !== null && $comparison['bills'] > 0
                ? $comparison['discounted_bills'] / $comparison['bills'] * 100
                : null;

            if ($baseline !== null && $rate - $baseline >= 3.0 && $rate >= 5.0) {
                $items[] = [
                    'id'          => 'discount-spike',
                    'severity'    => 'warning',
                    'title'       => 'More bills discounted than usual',
                    'metric'      => round($rate, 1) . '% of bills',
                    'detail'      => 'Was ' . round($baseline, 1) . '% ' . $comparison['label'],
                    'explanation' => 'Share of completed bills carrying any discount, against the same share over the comparison window. '
                        . 'Worth a look at who is authorising them.',
                    'evidence_href' => '/controls?panel=approvals',
                    'action_label'  => 'Open approvals',
                    'period_label'  => $period,
                ];
            } elseif ($baseline === null && $rate >= 25.0) {
                $items[] = [
                    'id'          => 'discount-share',
                    'severity'    => 'info',
                    'title'       => 'Most bills carry a discount',
                    'metric'      => round($rate, 1) . '% of bills',
                    'detail'      => $this->rupees((float) $sales['discount']) . ' given away',
                    'explanation' => 'Share of completed bills carrying any discount. Choose a comparison period to see whether that is normal here.',
                    'period_label' => $period,
                ];
            }
        }

        // --- Returns --------------------------------------------------------
        if ($sales['returns_value'] > 0) {
            $share = $net > 0 ? $sales['returns_value'] / $net * 100 : null;
            $reasons = $this->returnsVoids()['returns'];
            $top = $reasons[0] ?? null;

            $items[] = [
                'id'          => 'returns-rate',
                'severity'    => $share !== null && $share >= 5.0 ? 'danger' : ($share !== null && $share >= 2.0 ? 'warning' : 'info'),
                'title'       => 'Money went back over the counter',
                'metric'      => $this->rupees((float) $sales['returns_value']),
                'detail'      => ($share === null ? $sales['returns_count'] . ' return' . ($sales['returns_count'] === 1 ? '' : 's') : round($share, 1) . '% of takings')
                    . ($top === null ? '' : ' · ' . $top['display_name']),
                'explanation' => 'Refund value of returns raised in this window, whatever date the original sale was. '
                    . 'It is not deducted from net sales, so the two figures reconcile separately.',
                'evidence_href' => '/returns',
                'action_label'  => 'Open returns',
                'period_label'  => $period,
            ];
        }

        // --- A till doing noticeably less than its neighbours ---------------
        $counters = $this->counterProductivity();
        if (count($counters) >= 3) {
            $nets   = array_column($counters, 'net');
            $median = $this->median($nets);
            $worst  = $counters[count($counters) - 1];

            if ($median > 0 && $worst['net'] < $median * 0.6) {
                $items[] = [
                    'id'          => 'counter-productivity',
                    'severity'    => 'warning',
                    'title'       => $worst['display_name'] . ' is behind the others',
                    'metric'      => round((1 - $worst['net'] / $median) * 100) . '% below median',
                    'detail'      => 'Took ' . $this->rupees((float) $worst['net']) . ' over ' . $worst['bills'] . ' bill' . ($worst['bills'] === 1 ? '' : 's'),
                    'explanation' => 'Compared with the median till that took anything in this window. Tills nobody signed on to are not counted, '
                        . 'so this is about how a working counter did and not about a counter being shut.',
                    'evidence_href' => '/retail',
                    'action_label'  => 'Open the counters',
                    'period_label'  => $period,
                ];
            }
        }

        // --- The spread between outlets -------------------------------------
        $outlets = array_values(array_filter($this->outlets(), static fn (array $o): bool => $o['net'] > 0));
        if (count($outlets) >= 2) {
            $best  = $outlets[0];
            $worst = $outlets[count($outlets) - 1];
            if ($best['net'] > 0 && $worst['net'] < $best['net'] * 0.5) {
                $items[] = [
                    'id'          => 'outlet-spread',
                    'severity'    => 'info',
                    'title'       => $best['display_name'] . ' is carrying the period',
                    'metric'      => $this->rupees((float) $best['net']),
                    'detail'      => $worst['display_name'] . ' took ' . $this->rupees((float) $worst['net']),
                    'explanation' => 'Net takings by outlet over the same window. Outlets that took nothing at all are left out rather than ranked last.',
                    'period_label' => $period,
                ];
            }
        }

        return $items;
    }

    /**
     * The busiest bucket in the series, or null when nothing was taken.
     *
     * @return array{label:string, net:float, bills:int}|null
     */
    private function peak(): ?array
    {
        $series = $this->series();
        $best   = null;

        foreach ($series['points'] as $point) {
            if ($point['net'] <= 0) {
                continue;
            }
            if ($best === null || $point['net'] > $best['net']) {
                $best = $point;
            }
        }

        if ($best === null) {
            return null;
        }

        return [
            'label' => $series['bucket'] === 'hour'
                ? self::hourRange((string) $best['bucket'])
                : self::dayLabel((string) $best['bucket']),
            'net'   => (float) $best['net'],
            'bills' => (int) $best['bills'],
        ];
    }

    /** "13:00" as "1 PM – 2 PM", which is how a shop talks about the lunch rush. */
    private static function hourRange(string $bucket): string
    {
        $hour = (int) substr($bucket, 0, 2);
        $name = static function (int $h): string {
            $h = ($h + 24) % 24;
            $suffix = $h < 12 ? 'AM' : 'PM';
            $twelve = $h % 12 === 0 ? 12 : $h % 12;

            return $twelve . ' ' . $suffix;
        };

        return $name($hour) . ' – ' . $name($hour + 1);
    }

    private static function dayLabel(string $bucket): string
    {
        $date = \DateTimeImmutable::createFromFormat('Y-m-d', $bucket);

        return $date === false ? $bucket : $date->format('D j M');
    }

    /** @param list<float> $values */
    private function median(array $values): float
    {
        if ($values === []) {
            return 0.0;
        }
        sort($values);
        $mid = (int) floor((count($values) - 1) / 2);

        return count($values) % 2 === 1
            ? (float) $values[$mid]
            : ((float) $values[$mid] + (float) $values[$mid + 1]) / 2;
    }

    /**
     * A rupee figure for a one-line summary.
     *
     * Rounded to the rupee on purpose: these strings are headlines, and every
     * one of them sits beside a panel that carries the exact figure.
     */
    private function rupees(float $value): string
    {
        $sign  = $value < 0 ? '-' : '';
        $whole = (string) (int) round(abs($value));

        if (strlen($whole) > 3) {
            $last  = substr($whole, -3);
            $rest  = substr($whole, 0, -3);
            // 12,34,567 — pairs above the last three, not the western triples.
            $whole = preg_replace('/\\B(?=(\\d{2})+(?!\\d))/', ',', $rest) . ',' . $last;
        }

        return $sign . '₹' . $whole;
    }
}
