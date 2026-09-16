<?php

declare(strict_types=1);

namespace Aicountly\Api\Domain\Dashboards;

use Aicountly\Api\Db;
use Aicountly\Api\Permissions;

/**
 * Customers & Growth — repeat trade, measured only where it can be.
 *
 * THE HONEST CAVEAT, ON EVERY FIGURE. Most counter sales are anonymous. A
 * customer is "identified" here only when the cashier attached Books' account
 * id to the bill, and every metric on this board is computed over identified
 * bills alone. The unidentified share is shown next to them, because a repeat
 * rate of 31% means something completely different when 4% of bills carry a
 * customer than when 90% do.
 *
 * WHO OWNS THE CUSTOMER. Books owns the account; POS keeps `customer_account_id`
 * and the name typed on the bill for the receipt. Nothing here reads a balance,
 * a credit limit or a demographic, because POS holds none and inventing them
 * would be the exact thing this architecture forbids.
 *
 * LOYALTY DOES NOT EXIST IN THIS PRODUCT. There is no points table, no tier, no
 * liability. The panel says so. It does not show a zero, because a zero reads
 * as "nobody has any points" rather than "there is no loyalty scheme".
 *
 * NOTHING IS SENT. Suggested offers are prepared for a person to review. There
 * is no campaign sender in POS and this board never triggers one.
 */
final class CustomersBoard
{
    public function __construct(private readonly Window $win)
    {
    }

    /** @return array<string, mixed> */
    public function build(): array
    {
        $coverage = $this->coverage();

        return [
            'window'    => $this->win->describe(),
            'coverage'  => $coverage,
            'kpis'      => $this->kpis($coverage),
            'trend'     => $this->trend(),
            'recency'   => $this->recency(),
            'segments'  => $this->segments(),
            'combinations' => $this->combinations(),
            'loyalty'   => $this->loyalty(),
            'offers'    => $this->offers(),
            'suggestions' => $this->suggestions($coverage),
            'basis'     => 'Every figure on this board counts identified bills only — a bill a cashier attached a customer to. '
                . 'Anonymous counter sales are excluded and counted separately.',
        ];
    }

    /**
     * How much of the trade this board can actually see.
     *
     * @return array<string, mixed>
     */
    private function coverage(): array
    {
        [$where, $params] = $this->win->clause('c');
        [$where, $params] = $this->win->narrow($where, $params, 'c');

        $row = Db::first(
            "SELECT COUNT(*) AS bills,
                    COUNT(*) FILTER (WHERE c.customer_account_id IS NOT NULL) AS identified_bills,
                    COALESCE(SUM(c.total_amount), 0) AS net,
                    COALESCE(SUM(c.total_amount) FILTER (WHERE c.customer_account_id IS NOT NULL), 0) AS identified_net
             FROM pos_carts c WHERE {$where} AND c.status = 'COMPLETED'",
            $params,
        ) ?? [];

        $bills = (int) ($row['bills'] ?? 0);
        $identified = (int) ($row['identified_bills'] ?? 0);

        return [
            'bills'            => $bills,
            'identified_bills' => $identified,
            'anonymous_bills'  => $bills - $identified,
            'identified_pc'    => $bills > 0 ? round($identified / $bills * 100, 1) : null,
            'net'              => (float) ($row['net'] ?? 0),
            'identified_net'   => (float) ($row['identified_net'] ?? 0),
        ];
    }

    /**
     * @param array<string, mixed> $coverage
     * @return array<string, mixed>
     */
    private function kpis(array $coverage): array
    {
        [$where, $params] = $this->win->clause('c');
        [$where, $params] = $this->win->narrow($where, $params, 'c');

        // "New" means this account's FIRST bill on this POS fell inside the
        // window. It is a POS fact, not a claim about the customer's history
        // with the company — they may have bought from Sales for years.
        $row = Db::first(
            "WITH identified AS (
                 SELECT c.customer_account_id AS account_id,
                        COUNT(*) AS bills,
                        SUM(c.total_amount) AS net
                 FROM pos_carts c
                 WHERE {$where} AND c.status = 'COMPLETED' AND c.customer_account_id IS NOT NULL
                 GROUP BY c.customer_account_id
             ),
             first_seen AS (
                 SELECT customer_account_id AS account_id, MIN(created_at) AS first_at
                 FROM pos_carts
                 WHERE cmp_id = :fs_cmp AND status = 'COMPLETED' AND customer_account_id IS NOT NULL
                 GROUP BY customer_account_id
             )
             SELECT COUNT(*) AS customers,
                    COUNT(*) FILTER (WHERE f.first_at >= :win_from) AS new_customers,
                    COUNT(*) FILTER (WHERE i.bills > 1)             AS repeat_in_window,
                    COALESCE(SUM(i.net), 0)                         AS net,
                    COALESCE(SUM(i.bills), 0)                       AS bills
             FROM identified i
             JOIN first_seen f ON f.account_id = i.account_id",
            $params + ['fs_cmp' => $this->win->ctx->cmpId],
        ) ?? [];

        $customers = (int) ($row['customers'] ?? 0);
        $bills     = (int) ($row['bills'] ?? 0);
        $net       = (float) ($row['net'] ?? 0);

        return [
            'identified_customers' => $customers,
            'new_customers'        => (int) ($row['new_customers'] ?? 0),
            'returning_customers'  => $customers - (int) ($row['new_customers'] ?? 0),
            'repeat_rate_pc'       => $customers > 0 ? round((int) ($row['repeat_in_window'] ?? 0) / $customers * 100, 1) : null,
            'identified_average_bill' => $bills > 0 ? round($net / $bills, 2) : null,
            'identified_pc'        => $coverage['identified_pc'],
        ];
    }

    /**
     * New against returning, bucketed like the sales chart.
     *
     * @return array<string, mixed>
     */
    private function trend(): array
    {
        $singleDay = $this->win->from === $this->win->to;
        [$where, $params] = $this->win->clause('c');
        [$where, $params] = $this->win->narrow($where, $params, 'c');
        $params['tz'] = $this->win->timezone;
        $params['fs_cmp'] = $this->win->ctx->cmpId;

        $expr = $singleDay
            ? "to_char(date_trunc('hour', c.created_at AT TIME ZONE :tz), 'HH24:00')"
            : "to_char(date_trunc('day', c.created_at AT TIME ZONE :tz), 'YYYY-MM-DD')";

        $rows = Db::all(
            "WITH first_seen AS (
                 SELECT customer_account_id AS account_id, MIN(created_at) AS first_at
                 FROM pos_carts
                 WHERE cmp_id = :fs_cmp AND status = 'COMPLETED' AND customer_account_id IS NOT NULL
                 GROUP BY customer_account_id
             )
             SELECT {$expr} AS bucket,
                    COUNT(*) FILTER (WHERE f.first_at >= c.created_at) AS new_bills,
                    COUNT(*) FILTER (WHERE f.first_at <  c.created_at) AS returning_bills
             FROM pos_carts c
             JOIN first_seen f ON f.account_id = c.customer_account_id
             WHERE {$where} AND c.status = 'COMPLETED' AND c.customer_account_id IS NOT NULL
             GROUP BY 1 ORDER BY 1",
            $params,
        );

        return [
            'bucket' => $singleDay ? 'hour' : 'day',
            'points' => array_map(static fn (array $r): array => [
                'bucket'          => (string) $r['bucket'],
                'new_bills'       => (int) $r['new_bills'],
                'returning_bills' => (int) $r['returning_bills'],
            ], $rows),
        ];
    }

    /**
     * How long since each identified customer last bought here.
     *
     * Measured across this POS' whole history rather than the window, because
     * "last seen 40 days ago" is meaningless if the window is one day.
     *
     * @return array<string, mixed>
     */
    private function recency(): array
    {
        $rows = Db::all(
            "WITH last_seen AS (
                 SELECT customer_account_id AS account_id,
                        MAX(created_at) AS last_at,
                        COUNT(*) AS visits
                 FROM pos_carts
                 WHERE cmp_id = :cmp AND status = 'COMPLETED' AND customer_account_id IS NOT NULL
                 GROUP BY customer_account_id
             )
             SELECT CASE
                        WHEN last_at >= NOW() - INTERVAL '30 days'  THEN '0-30'
                        WHEN last_at >= NOW() - INTERVAL '60 days'  THEN '31-60'
                        WHEN last_at >= NOW() - INTERVAL '90 days'  THEN '61-90'
                        ELSE '90+'
                    END AS bucket,
                    COUNT(*) AS customers,
                    SUM(visits) AS visits
             FROM last_seen GROUP BY 1",
            ['cmp' => $this->win->ctx->cmpId],
        );

        $buckets = ['0-30' => 0, '31-60' => 0, '61-90' => 0, '90+' => 0];
        $visits  = ['0-30' => 0, '31-60' => 0, '61-90' => 0, '90+' => 0];
        foreach ($rows as $r) {
            $buckets[(string) $r['bucket']] = (int) $r['customers'];
            $visits[(string) $r['bucket']]  = (int) $r['visits'];
        }

        return [
            'basis'   => 'Days since the customer last bought at one of these tills. POS history only.',
            'points' => array_map(static fn (string $k) => [
                'bucket'    => $k,
                'label'     => $k === '90+' ? 'Over 90 days' : $k . ' days ago',
                'customers' => $buckets[$k],
                'visits'    => $visits[$k],
            ], array_keys($buckets)),
        ];
    }

    /**
     * Segments, each with its definition written next to it.
     *
     * Three segments, defined by counting and nothing else. There is no model,
     * no propensity score and no demographic — POS holds none of those.
     *
     * @return array<string, mixed>
     */
    private function segments(): array
    {
        $params = ['cmp' => $this->win->ctx->cmpId];

        $row = Db::first(
            "WITH history AS (
                 SELECT customer_account_id AS account_id,
                        COUNT(*) AS visits,
                        MAX(created_at) AS last_at,
                        SUM(total_amount) AS spend
                 FROM pos_carts
                 WHERE cmp_id = :cmp AND status = 'COMPLETED' AND customer_account_id IS NOT NULL
                 GROUP BY customer_account_id
             )
             SELECT COUNT(*) AS total,
                    COUNT(*) FILTER (WHERE visits = 1) AS one_time,
                    COUNT(*) FILTER (WHERE visits >= 3 AND last_at >= NOW() - INTERVAL '60 days') AS loyal,
                    COUNT(*) FILTER (WHERE visits >= 2 AND last_at <  NOW() - INTERVAL '60 days') AS at_risk,
                    COALESCE(SUM(spend) FILTER (WHERE visits >= 3 AND last_at >= NOW() - INTERVAL '60 days'), 0) AS loyal_spend,
                    COALESCE(SUM(spend) FILTER (WHERE visits >= 2 AND last_at <  NOW() - INTERVAL '60 days'), 0) AS at_risk_spend,
                    COALESCE(SUM(spend) FILTER (WHERE visits = 1), 0) AS one_time_spend
             FROM history",
            $params,
        ) ?? [];

        $total = (int) ($row['total'] ?? 0);

        $segment = static fn (string $key, string $label, string $definition, int $count, float $spend): array => [
            'key'        => $key,
            'label'      => $label,
            'definition' => $definition,
            'customers'  => $count,
            'spend'      => $spend,
            'share_pc'   => null,
        ];

        $segments = [
            $segment('loyal', 'Regulars',
                'Three or more bills on this POS, the most recent within 60 days.',
                (int) ($row['loyal'] ?? 0), (float) ($row['loyal_spend'] ?? 0)),
            $segment('at_risk', 'Slipping away',
                'Two or more bills on this POS, but nothing in the last 60 days.',
                (int) ($row['at_risk'] ?? 0), (float) ($row['at_risk_spend'] ?? 0)),
            $segment('one_time', 'Bought once',
                'Exactly one bill on this POS, ever.',
                (int) ($row['one_time'] ?? 0), (float) ($row['one_time_spend'] ?? 0)),
        ];

        foreach ($segments as $i => $s) {
            $segments[$i]['share_pc'] = $total > 0 ? round($s['customers'] / $total * 100, 1) : null;
        }

        return [
            'total'    => $total,
            'segments' => $segments,
            'basis'    => 'Counted from bills on this POS only. A customer who buys through Sales or another channel is not counted here.',
        ];
    }

    /**
     * Pairs of items that appear on the same bill.
     *
     * A plain co-occurrence count over this window — nothing is inferred about
     * why. The supporting bill count is returned with every pair so a manager
     * can see whether 24% is 24% of 186 baskets or of 4.
     *
     * @return array<string, mixed>
     */
    private function combinations(): array
    {
        [$where, $params] = $this->win->clause('c');
        [$where, $params] = $this->win->narrow($where, $params, 'c');

        $rows = Db::all(
            "WITH basket AS (
                 SELECT DISTINCT l.cart_id, l.item_id, l.display_name
                 FROM pos_cart_lines l
                 JOIN pos_carts c ON c.cart_id = l.cart_id
                 WHERE {$where} AND c.status = 'COMPLETED' AND l.item_id IS NOT NULL
             ),
             totals AS (SELECT COUNT(DISTINCT cart_id) AS baskets FROM basket)
             SELECT a.item_id AS left_item, a.display_name AS left_name,
                    b.item_id AS right_item, b.display_name AS right_name,
                    COUNT(*) AS together,
                    (SELECT baskets FROM totals) AS baskets
             FROM basket a
             JOIN basket b ON b.cart_id = a.cart_id AND b.item_id > a.item_id
             GROUP BY a.item_id, a.display_name, b.item_id, b.display_name
             HAVING COUNT(*) >= 2
             ORDER BY COUNT(*) DESC
             LIMIT 8",
            $params,
        );

        $baskets = $rows === [] ? 0 : (int) $rows[0]['baskets'];

        return [
            'baskets' => $baskets,
            'pairs'   => array_map(static function (array $r) use ($baskets): array {
                $together = (int) $r['together'];

                return [
                    'left_item'   => (int) $r['left_item'],
                    'left_name'   => (string) $r['left_name'],
                    'right_item'  => (int) $r['right_item'],
                    'right_name'  => (string) $r['right_name'],
                    'together'    => $together,
                    'baskets'     => $baskets,
                    'share_pc'    => $baskets > 0 ? round($together / $baskets * 100, 1) : null,
                ];
            }, $rows),
            'basis' => 'Bills in this window containing both items, out of all bills with at least one item. '
                . 'A count, not a recommendation model. Pairs seen fewer than twice are not shown.',
        ];
    }

    /**
     * Loyalty, told straight.
     *
     * @return array<string, mixed>
     */
    private function loyalty(): array
    {
        return [
            'available' => false,
            'reason'    => 'not_implemented',
            'note'      => 'POS has no loyalty scheme: there is no points balance, no tier and no liability in this product, '
                . 'and none is read from another. Nothing is shown rather than a zero, because a zero would read as '
                . '"no customer has any points".',
            'contract_gap' => 'A loyalty module would need: an accrual rule, a redemption call that is idempotent under '
                . 'concurrent use, and a reversal path that a return triggers. None of those exist to integrate with yet.',
        ];
    }

    /**
     * Offer performance needs attribution data. There is none.
     *
     * @return array<string, mixed>
     */
    private function offers(): array
    {
        return [
            'available' => false,
            'reason'    => 'no_attribution',
            'note'      => 'Nothing in POS records that a bill was the result of an offer, so offer performance cannot be '
                . 'measured here. Discounts given at the counter are on the Controls board as approvals, which is a '
                . 'different question from whether an offer worked.',
        ];
    }

    /**
     * Follow-ups, prepared for review and never sent.
     *
     * Contact details are not returned here at all — a segment size is enough
     * to decide with, and a marketing list is a different permission from
     * looking up the customer in front of you.
     *
     * @param array<string, mixed> $coverage
     * @return array<string, mixed>
     */
    private function suggestions(array $coverage): array
    {
        $segments = $this->segments();
        $items = [];

        foreach ($segments['segments'] as $segment) {
            if ($segment['customers'] < 5) {
                continue;
            }
            if ($segment['key'] === 'at_risk') {
                $items[] = [
                    'id'          => 'follow-up-at-risk',
                    'kind'        => 'rule',
                    'segment'     => $segment['key'],
                    'title'       => $segment['customers'] . ' regulars have not been back in 60 days',
                    'definition'  => $segment['definition'],
                    'explanation' => 'They bought at least twice and then stopped. Worth a look before the next print run.',
                    'supporting_customers' => $segment['customers'],
                    'period_label' => 'All POS history',
                    'evidence_href' => '/customers?segment=at_risk',
                    'action_label'  => 'Review this segment',
                ];
            }
            if ($segment['key'] === 'one_time' && $segment['share_pc'] !== null && $segment['share_pc'] > 60) {
                $items[] = [
                    'id'          => 'follow-up-one-time',
                    'kind'        => 'rule',
                    'segment'     => $segment['key'],
                    'title'       => round($segment['share_pc']) . '% of identified customers bought once and not again',
                    'definition'  => $segment['definition'],
                    'explanation' => 'A high single-visit share usually means the counter is capturing customers at the first '
                        . 'sale and nothing brings them back.',
                    'supporting_customers' => $segment['customers'],
                    'period_label' => 'All POS history',
                    'evidence_href' => '/customers?segment=one_time',
                    'action_label'  => 'Review this segment',
                ];
            }
        }

        if ($coverage['identified_pc'] !== null && $coverage['identified_pc'] < 20 && $coverage['bills'] >= 20) {
            $items[] = [
                'id'          => 'low-identification',
                'kind'        => 'rule',
                'segment'     => null,
                'title'       => 'Only ' . $coverage['identified_pc'] . '% of bills have a customer on them',
                'definition'  => 'Completed bills in this window carrying a customer account.',
                'explanation' => 'Every figure on this board is computed from that share, so it is a small sample of the trade. '
                    . 'Attaching a customer at the counter is what widens it.',
                'supporting_customers' => $coverage['identified_bills'],
                'period_label' => $this->win->from . ' — ' . $this->win->to,
                'evidence_href' => '/retail?panel=recent',
                'action_label'  => null,
            ];
        }

        return [
            'items' => array_slice($items, 0, 3),
            'ai' => [
                'available' => false,
                'reason'    => 'not_configured',
                'note'      => 'No model integration is configured for POS. These are threshold checks over counts, not model output.',
            ],
            'sending' => [
                'available' => false,
                'note'      => 'POS does not send campaigns or messages. These are prepared for a person to act on elsewhere.',
            ],
            'contact_details' => [
                'visible' => Permissions::allows($this->win->ctx, $this->win->auth, 'reports.view'),
                'note'    => 'Contact details are never returned to this board. Look a customer up on the till to see them, '
                    . 'where the lookup is logged.',
            ],
            'generated_at' => gmdate('c'),
        ];
    }
}
