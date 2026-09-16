<?php

declare(strict_types=1);

namespace Aicountly\Api\Controllers;

use Aicountly\Api\Db;
use Aicountly\Api\Http;
use Aicountly\Api\IntegrationCommand;
use Aicountly\Api\Permissions;

/**
 * The manager's view of the day.
 *
 * Built from POS' OWN rows: what these tills sold, what they took, what is
 * stuck. It does not claim to be the shop's revenue — that is Books', it can
 * differ, and a screen that quietly showed a different number under the same
 * word would be worse than one that says which number it is showing.
 */
final class DashboardController extends Controller
{
    public static function today(): void
    {
        [$auth, $ctx] = self::enter();
        Permissions::assert($ctx, $auth, 'reports.view');

        $from = Http::param('from') ?? gmdate('Y-m-d');
        $to   = Http::param('to') ?? $from;
        [$scope, $params] = $ctx->scopeClause();
        $params['from'] = $from;
        $params['to']   = $to;

        $window = " AND created_at >= :from::date AND created_at < (:to::date + INTERVAL '1 day')";

        $sales = Db::first(
            "SELECT COUNT(*) AS bills,
                    COALESCE(SUM(total_amount), 0) AS net,
                    COALESCE(SUM(discount_amount), 0) AS discount,
                    COALESCE(SUM(estimated_tax_amount), 0) AS estimated_tax,
                    COALESCE(AVG(NULLIF(total_amount, 0)), 0) AS average_bill
             FROM pos_carts WHERE {$scope} AND status = 'COMPLETED'{$window}",
            $params,
        ) ?? [];

        $tenders = Db::all(
            "SELECT p.payment_mode, SUM(p.amount) AS amount, COUNT(*) AS count
             FROM pos_cart_payments p JOIN pos_carts c ON c.cart_id = p.cart_id
             WHERE c.cmp_id = :cmp AND c.status = 'COMPLETED'
               AND c.created_at >= :from::date AND c.created_at < (:to::date + INTERVAL '1 day')
             GROUP BY p.payment_mode ORDER BY SUM(p.amount) DESC",
            ['cmp' => $ctx->cmpId, 'from' => $from, 'to' => $to],
        );

        $byKind = Db::all(
            "SELECT order_kind, COUNT(*) AS bills, COALESCE(SUM(total_amount), 0) AS net
             FROM pos_carts WHERE {$scope} AND status = 'COMPLETED'{$window}
             GROUP BY order_kind ORDER BY SUM(total_amount) DESC",
            $params,
        );

        $hourly = Db::all(
            "SELECT EXTRACT(HOUR FROM created_at)::int AS hour, COUNT(*) AS bills,
                    COALESCE(SUM(total_amount), 0) AS net
             FROM pos_carts WHERE {$scope} AND status = 'COMPLETED'{$window}
             GROUP BY 1 ORDER BY 1",
            $params,
        );

        $top = Db::all(
            "SELECT l.display_name, l.item_id, SUM(l.quantity) AS qty, SUM(l.line_amount) AS amount
             FROM pos_cart_lines l JOIN pos_carts c ON c.cart_id = l.cart_id
             WHERE c.cmp_id = :cmp AND c.status = 'COMPLETED'
               AND c.created_at >= :from::date AND c.created_at < (:to::date + INTERVAL '1 day')
             GROUP BY l.display_name, l.item_id ORDER BY SUM(l.line_amount) DESC LIMIT 10",
            ['cmp' => $ctx->cmpId, 'from' => $from, 'to' => $to],
        );

        $exceptions = Db::first(
            "SELECT
                (SELECT COUNT(*) FROM pos_carts WHERE {$scope} AND status = 'VOID'{$window}) AS voids,
                (SELECT COUNT(*) FROM pos_approval_events WHERE cmp_id = :cmp AND event_kind = 'no_sale'
                   AND created_at >= :from::date AND created_at < (:to::date + INTERVAL '1 day')) AS no_sales,
                (SELECT COUNT(*) FROM pos_approval_events WHERE cmp_id = :cmp AND event_kind IN ('discount', 'price_override')
                   AND created_at >= :from::date AND created_at < (:to::date + INTERVAL '1 day')) AS overrides,
                (SELECT COALESCE(SUM(refund_amount), 0) FROM pos_returns WHERE {$scope} AND status <> 'CANCELLED'{$window}) AS refunds",
            $params,
        ) ?? [];

        // The two numbers a manager needs and nobody else shows: sales that
        // have not reached the other products, and sales a till made offline
        // that are still not in.
        $stuck = (int) Db::scalar(
            "SELECT COUNT(*) FROM " . IntegrationCommand::TABLE . " WHERE {$scope} AND status IN ('FAILED', 'BLOCKED')",
            array_diff_key($params, ['from' => 1, 'to' => 1]),
        );
        $pendingOffline = (int) Db::scalar(
            "SELECT COUNT(*) FROM pos_offline_submissions WHERE {$scope} AND status NOT IN ('POSTED', 'ABANDONED')",
            array_diff_key($params, ['from' => 1, 'to' => 1]),
        );

        Http::data([
            'window' => ['from' => $from, 'to' => $to],
            'sales'  => [
                'bills'         => (int) ($sales['bills'] ?? 0),
                'net'           => (float) ($sales['net'] ?? 0),
                'discount'      => (float) ($sales['discount'] ?? 0),
                'estimated_tax' => (float) ($sales['estimated_tax'] ?? 0),
                'average_bill'  => round((float) ($sales['average_bill'] ?? 0), 2),
            ],
            'tenders' => array_map(static fn (array $r) => [
                'payment_mode' => (string) $r['payment_mode'],
                'amount' => (float) $r['amount'],
                'count' => (int) $r['count'],
            ], $tenders),
            'by_order_kind' => array_map(static fn (array $r) => [
                'order_kind' => (string) $r['order_kind'],
                'bills' => (int) $r['bills'],
                'net' => (float) $r['net'],
            ], $byKind),
            'hourly' => array_map(static fn (array $r) => [
                'hour' => (int) $r['hour'],
                'bills' => (int) $r['bills'],
                'net' => (float) $r['net'],
            ], $hourly),
            'top_items' => array_map(static fn (array $r) => [
                'display_name' => (string) $r['display_name'],
                'item_id' => $r['item_id'] === null ? null : (int) $r['item_id'],
                'qty' => (float) $r['qty'],
                'amount' => (float) $r['amount'],
            ], $top),
            'exceptions' => [
                'voids'     => (int) ($exceptions['voids'] ?? 0),
                'no_sales'  => (int) ($exceptions['no_sales'] ?? 0),
                'overrides' => (int) ($exceptions['overrides'] ?? 0),
                'refunds'   => (float) ($exceptions['refunds'] ?? 0),
            ],
            'needs_attention' => [
                'stuck_commands'   => $stuck,
                'pending_offline'  => $pendingOffline,
            ],
            // Said plainly, because two numbers under one word is how a manager
            // stops trusting a dashboard.
            'source_note' => 'Counted from this POS. The accounting figures are in Books and can differ.',
        ]);
    }

    /**
     * Who did what that needs explaining.
     *
     * The fraud trail, in one list, newest first.
     */
    public static function exceptions(): void
    {
        [$auth, $ctx] = self::enter();
        Permissions::assert($ctx, $auth, 'reports.view');

        $params = Http::listParams(['created_at'], 'created_at');
        $where = ['cmp_id = :cmp'];
        $args = ['cmp' => $ctx->cmpId];

        if (Http::param('event_kind') !== null) {
            $where[] = 'event_kind = :kind';
            $args['kind'] = Http::param('event_kind');
        }
        if (Http::param('from') !== null) {
            $where[] = 'created_at >= :from::date';
            $args['from'] = Http::param('from');
        }

        $clause = implode(' AND ', $where);
        $total = (int) Db::scalar('SELECT COUNT(*) FROM pos_approval_events WHERE ' . $clause, $args);
        $rows = Db::all(
            'SELECT * FROM pos_approval_events WHERE ' . $clause . '
             ORDER BY approval_id DESC LIMIT ' . (int) $params['limit'] . ' OFFSET ' . (int) $params['offset'],
            $args,
        );

        Http::list(array_map(static function (array $r): array {
            $r['approval_id'] = (int) $r['approval_id'];
            $r['detail'] = Db::jsonColumn($r['detail'] ?? null);

            return $r;
        }, $rows), $total, $params['limit'], $params['offset']);
    }
}
