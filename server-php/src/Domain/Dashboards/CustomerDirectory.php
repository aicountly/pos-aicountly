<?php

declare(strict_types=1);

namespace Aicountly\Api\Domain\Dashboards;

use Aicountly\Api\Db;

/**
 * The customer roster behind the Customers & Growth table.
 *
 * WHY THIS IS NOT ON THE BOARD PAYLOAD. A dashboard that ships every customer
 * to the browser so JavaScript can filter them is a dashboard that works for
 * the first six months of trading and then takes nine seconds to paint. The
 * search, the tab filter, the sort and the paging all happen in PostgreSQL, and
 * the browser holds one page of rows.
 *
 * WHICH CUSTOMERS EACH TAB COUNTS. Deliberately the same populations the KPI
 * cards count, so the tab totals and the cards above them agree:
 *
 *   All       bought at least once in the chosen period  = identified_customers
 *   New       their first bill on this POS fell in it    = new_customers
 *   Repeat    more than one bill inside it               = the repeat rate's numerator
 *   Lapsed    nothing for CustomerRules::INACTIVE_DAYS   — a lifetime question,
 *             so this one tab ignores the period and says so on screen.
 *
 * CONTACT DETAILS. The mobile is returned with only its last four digits
 * legible. That is enough for a manager to recognise the customer they are
 * looking at and useless as a marketing list, which is the distinction this
 * product has always drawn: the whole number lives on the till, where looking
 * one up is a logged action against a named customer. POS holds no email
 * address at all, so none is returned and the column says so rather than
 * rendering an empty cell that looks like missing data.
 *
 * WHOSE NAME IT IS. The most recent non-empty name typed on a bill for that
 * account. POS does not own the customer record — Books does — and this is the
 * name the counter last put on a receipt, not a claim to be the master copy.
 */
final class CustomerDirectory
{
    public const TABS = ['all', 'new', 'repeat', 'inactive'];

    private const SORTS = [
        'last_visit' => 'h.last_at',
        'spend'      => 'h.spend',
        'visits'     => 'h.visits',
        'name'       => 'h.customer_name',
    ];

    public function __construct(private readonly Window $win)
    {
    }

    /**
     * @param array{tab:string, q:string, sort:string, order:string, limit:int, offset:int} $request
     * @return array{rows:list<array<string, mixed>>, total:int, counts:array<string,int>, basis:string}
     */
    public function build(array $request): array
    {
        [$cte, $params] = $this->source();

        $tab   = in_array($request['tab'], self::TABS, true) ? $request['tab'] : 'all';
        $sort  = self::SORTS[$request['sort']] ?? self::SORTS['last_visit'];
        $order = strtoupper($request['order']) === 'ASC' ? 'ASC' : 'DESC';

        [$search, $searchParams] = $this->search($request['q']);
        $params += $searchParams;

        $where = $this->tabClause($tab) . $search;

        $total = (int) Db::scalar(
            "{$cte} SELECT COUNT(*) FROM history h LEFT JOIN scoped s ON s.account_id = h.account_id WHERE {$where}",
            $params,
        );

        // The four tab totals in one pass, over the same search, so the counts
        // on the tabs describe the list the person is actually looking at.
        $counts = Db::first(
            "{$cte}
             SELECT COUNT(*) FILTER (WHERE " . $this->tabClause('all') . ")      AS all_count,
                    COUNT(*) FILTER (WHERE " . $this->tabClause('new') . ")      AS new_count,
                    COUNT(*) FILTER (WHERE " . $this->tabClause('repeat') . ")   AS repeat_count,
                    COUNT(*) FILTER (WHERE " . $this->tabClause('inactive') . ") AS inactive_count
             FROM history h LEFT JOIN scoped s ON s.account_id = h.account_id
             WHERE TRUE{$search}",
            $params,
        ) ?? [];

        $rows = Db::all(
            "{$cte}
             SELECT h.account_id, h.customer_name, h.customer_mobile,
                    h.visits, h.spend, h.first_at, h.last_at,
                    h.last_location_id, l.display_name AS outlet_name, l.location_code AS outlet_code,
                    COALESCE(s.window_visits, 0) AS window_visits,
                    COALESCE(s.window_spend, 0)  AS window_spend,
                    (h.first_at >= :win_from) AS is_new
             FROM history h
             LEFT JOIN scoped s ON s.account_id = h.account_id
             LEFT JOIN pos_location_profiles l ON l.location_id = h.last_location_id AND l.cmp_id = h.cmp_id
             WHERE {$where}
             ORDER BY {$sort} {$order} NULLS LAST, h.account_id DESC
             LIMIT " . (int) $request['limit'] . ' OFFSET ' . (int) $request['offset'],
            $params,
        );

        return [
            'rows'   => array_map([$this, 'present'], $rows),
            'total'  => $total,
            'counts' => [
                'all'      => (int) ($counts['all_count'] ?? 0),
                'new'      => (int) ($counts['new_count'] ?? 0),
                'repeat'   => (int) ($counts['repeat_count'] ?? 0),
                'inactive' => (int) ($counts['inactive_count'] ?? 0),
            ],
            'basis'  => 'Visits and spend are this customer\'s whole history on this POS'
                . ($this->win->locationId !== null ? ' at the chosen outlet' : '')
                . '. The Lapsed tab is measured from today rather than from the chosen period.',
        ];
    }

    /**
     * The two CTEs every query here starts from: a customer's whole history on
     * this POS, and what they did inside the chosen period.
     *
     * @return array{0:string, 1:array<string, mixed>}
     */
    private function source(): array
    {
        // Lifetime, by company — matching the segment and recency panels, which
        // are also lifetime. The outlet/till narrowing still applies, so a
        // manager looking at one outlet sees that outlet's trade.
        $historyWhere  = 'c.cmp_id = :cmp AND c.status = \'COMPLETED\' AND c.customer_account_id IS NOT NULL';
        $historyParams = ['cmp' => $this->win->ctx->cmpId];
        [$historyWhere, $historyParams] = $this->win->narrow($historyWhere, $historyParams, 'c');

        // Inside the chosen period — the same clause the KPI cards are counted
        // with, so the tab totals cannot drift away from them.
        [$scopedWhere, $scopedParams] = $this->win->clause('c');
        [$scopedWhere, $scopedParams] = $this->win->narrow($scopedWhere, $scopedParams, 'c');

        $cte = "WITH history AS (
                    SELECT c.customer_account_id AS account_id,
                           MIN(c.cmp_id) AS cmp_id,
                           COUNT(*) AS visits,
                           SUM(c.total_amount) AS spend,
                           MIN(c.created_at) AS first_at,
                           MAX(c.created_at) AS last_at,
                           (array_agg(c.customer_name ORDER BY c.created_at DESC)
                                FILTER (WHERE btrim(COALESCE(c.customer_name, '')) <> ''))[1] AS customer_name,
                           (array_agg(c.customer_mobile ORDER BY c.created_at DESC)
                                FILTER (WHERE btrim(COALESCE(c.customer_mobile, '')) <> ''))[1] AS customer_mobile,
                           (array_agg(t.location_id ORDER BY c.created_at DESC)
                                FILTER (WHERE t.location_id IS NOT NULL))[1] AS last_location_id
                    FROM pos_carts c
                    LEFT JOIN pos_terminals t ON t.terminal_id = c.terminal_id
                    WHERE {$historyWhere}
                    GROUP BY c.customer_account_id
                ),
                scoped AS (
                    SELECT c.customer_account_id AS account_id,
                           COUNT(*) AS window_visits,
                           SUM(c.total_amount) AS window_spend
                    FROM pos_carts c
                    WHERE {$scopedWhere} AND c.status = 'COMPLETED' AND c.customer_account_id IS NOT NULL
                    GROUP BY c.customer_account_id
                )";

        // Both halves name their bindings identically and bind them to the same
        // values, so the union is safe; only the window bounds are unique to one.
        return [$cte, $scopedParams + $historyParams];
    }

    /** The population one tab is about. */
    private function tabClause(string $tab): string
    {
        return match ($tab) {
            'new'      => 's.account_id IS NOT NULL AND h.first_at >= :win_from',
            'repeat'   => 'COALESCE(s.window_visits, 0) > 1',
            'inactive' => CustomerRules::lapsedSql('h.last_at'),
            default    => 's.account_id IS NOT NULL',
        };
    }

    /**
     * Name, mobile or account reference.
     *
     * The mobile is matched on digits alone so "9876" finds a number stored as
     * "+91 98765 43210" — a cashier types the digits they remember, not the
     * spacing the number happens to be saved with.
     *
     * @return array{0:string, 1:array<string, mixed>}
     */
    private function search(string $q): array
    {
        $q = trim($q);
        if ($q === '') {
            return ['', []];
        }

        $params = ['q_like' => '%' . $q . '%'];
        $clauses = ['h.customer_name ILIKE :q_like'];

        $digits = preg_replace('/\D+/', '', $q) ?? '';
        if ($digits !== '') {
            $clauses[] = "regexp_replace(COALESCE(h.customer_mobile, ''), '\\D', '', 'g') LIKE :q_digits";
            $params['q_digits'] = '%' . $digits . '%';
            // An exact account reference, for someone pasting one out of Books.
            $clauses[] = 'h.account_id = :q_id';
            $params['q_id'] = (int) $digits;
        }

        return [' AND (' . implode(' OR ', $clauses) . ')', $params];
    }

    /**
     * One row, as the screen needs it.
     *
     * @param array<string, mixed> $r
     * @return array<string, mixed>
     */
    private function present(array $r): array
    {
        $visits = (int) $r['visits'];
        $spend  = (float) $r['spend'];
        $lastAt = $r['last_at'] === null ? null : (string) $r['last_at'];
        $isNew  = $r['is_new'] === true || $r['is_new'] === 't' || $r['is_new'] === 1 || $r['is_new'] === '1';

        $name = $r['customer_name'] === null ? null : trim((string) $r['customer_name']);

        return [
            // Books' account for this customer. Shown as a reference, not as a
            // POS identifier — POS does not own the customer record.
            'account_id'    => (int) $r['account_id'],
            'name'          => $name === '' ? null : $name,
            'mobile_masked' => CustomerRules::maskMobile($r['customer_mobile'] === null ? null : (string) $r['customer_mobile']),
            // POS stores no email address on a bill, so there is nothing to
            // return and nothing to render as if it were missing.
            'email'         => null,
            'visits'        => $visits,
            'spend'         => $spend,
            'average_bill'  => $visits > 0 ? round($spend / $visits, 2) : null,
            'window_visits' => (int) $r['window_visits'],
            'window_spend'  => (float) $r['window_spend'],
            'first_at'      => $r['first_at'] === null ? null : (string) $r['first_at'],
            'last_at'       => $lastAt,
            'outlet_id'     => $r['last_location_id'] === null ? null : (int) $r['last_location_id'],
            'outlet_name'   => $r['outlet_name'] === null || $r['outlet_name'] === ''
                ? ($r['outlet_code'] === null ? null : (string) $r['outlet_code'])
                : (string) $r['outlet_name'],
            'customer_type' => CustomerRules::classify($visits, $lastAt, $isNew),
        ];
    }
}
