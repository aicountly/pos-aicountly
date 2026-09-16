<?php

declare(strict_types=1);

namespace Aicountly\Api\Controllers;

use Aicountly\Api\Audit;
use Aicountly\Api\Auth;
use Aicountly\Api\Context;
use Aicountly\Api\Db;
use Aicountly\Api\Domain\Dashboards\ControlsBoard;
use Aicountly\Api\Domain\Dashboards\CustomersBoard;
use Aicountly\Api\Domain\Dashboards\OverviewBoard;
use Aicountly\Api\Domain\Dashboards\RestaurantBoard;
use Aicountly\Api\Domain\Dashboards\RetailBoard;
use Aicountly\Api\Domain\Dashboards\Window;
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

    // -----------------------------------------------------------------------
    // The five dashboards
    //
    // Each one asserts its OWN permission before it touches a row. The rule is
    // not "can this person see a dashboard" but "what may this person see on
    // it": a cashier opening Retail or Controls gets their own tills and their
    // own shifts, scoped in SQL by Window::seesEveryone, not by a panel the UI
    // decided to leave out. Hiding a panel is presentation; this is the check.
    // -----------------------------------------------------------------------

    /** Business Overview — the owner's view. Consolidated figures need reports.view. */
    public static function overview(): void
    {
        [$auth, $ctx] = self::enter();
        Permissions::assert($ctx, $auth, 'reports.view');

        Http::data((new OverviewBoard(Window::fromRequest($ctx, $auth)))->build());
    }

    /** Retail Operations — a cashier may open this for their own counter. */
    public static function retail(): void
    {
        [$auth, $ctx] = self::enter();
        self::assertAny($ctx, $auth, ['reports.view', 'sell'], 'the retail counters');

        Http::data((new RetailBoard(Window::fromRequest($ctx, $auth)))->build());
    }

    /** Restaurant Operations — waiters, captains and the kitchen screen. */
    public static function restaurant(): void
    {
        [$auth, $ctx] = self::enter();
        self::assertAny($ctx, $auth, ['reports.view', 'table.open', 'kds.operate'], 'the restaurant floor');

        Http::data((new RestaurantBoard(Window::fromRequest($ctx, $auth)))->build());
    }

    /**
     * Customers & Growth.
     *
     * reports.view only, with no cashier fallback: a till needs to look up the
     * customer in front of it, which is what the catalog endpoint is for. This
     * board is the aggregate view of everyone who has ever bought here, and
     * that is a different question and a different permission.
     */
    public static function customers(): void
    {
        [$auth, $ctx] = self::enter();
        Permissions::assert($ctx, $auth, 'reports.view');

        Http::data((new CustomersBoard(Window::fromRequest($ctx, $auth)))->build());
    }

    /** Cash, Shifts & Controls — a cashier sees their own drawer, a manager sees the outlet. */
    public static function controls(): void
    {
        [$auth, $ctx] = self::enter();
        self::assertAny($ctx, $auth, ['reports.view', 'shift.close', 'shift.open'], 'shifts and the drawer');

        Http::data((new ControlsBoard(Window::fromRequest($ctx, $auth)))->build());
    }

    /**
     * Any one of these will do.
     *
     * @param list<string> $permissions
     */
    private static function assertAny(Context $ctx, Auth $auth, array $permissions, string $what): void
    {
        foreach ($permissions as $permission) {
            if (Permissions::allows($ctx, $auth, $permission)) {
                return;
            }
        }

        Http::forbidden('You cannot see ' . $what . '. Ask a manager.');
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

    // -----------------------------------------------------------------------
    // Drill-downs
    // -----------------------------------------------------------------------

    /**
     * Cash in and out of the drawer, paged.
     *
     * Sale tenders are excluded by default because they are every cash sale of
     * the day and would bury the six movements a manager is actually looking
     * for. `include_sales=1` puts them back.
     */
    public static function cashMovements(): void
    {
        [$auth, $ctx] = self::enter();
        self::assertAny($ctx, $auth, ['reports.view', 'drawer.cash_io', 'shift.close'], 'cash movements');

        $params = Http::listParams(['created_at'], 'created_at');
        $where  = ['s.cmp_id = :cmp'];
        $args   = ['cmp' => $ctx->cmpId];

        // A cashier sees their own drawer. Enforced here, in the query.
        if (!Permissions::allows($ctx, $auth, 'reports.view')) {
            $where[] = 's.opened_by = :me';
            $args['me'] = $auth->uuid;
        }
        if (Http::intParam('session_id') !== null) {
            $where[] = 'e.session_id = :sid';
            $args['sid'] = Http::intParam('session_id');
        }
        if (Http::intParam('terminal_id') !== null) {
            $where[] = 's.terminal_id = :tid';
            $args['tid'] = Http::intParam('terminal_id');
        }
        if (Http::param('event_kind') !== null) {
            $where[] = 'e.event_kind = :kind';
            $args['kind'] = Http::param('event_kind');
        } elseif (Http::param('include_sales') !== '1') {
            $where[] = "e.event_kind <> 'sale_tender'";
        }

        $clause = implode(' AND ', $where);
        $joined = 'FROM pos_cash_drawer_events e JOIN pos_register_sessions s ON s.session_id = e.session_id WHERE ' . $clause;

        $total = (int) Db::scalar('SELECT COUNT(*) ' . $joined, $args);
        $rows = Db::all(
            'SELECT e.event_id, e.session_id, e.event_kind, e.amount, e.reason, e.actor_uuid,
                    e.approved_by, e.books_voucher_uuid, e.created_at, s.terminal_id
             ' . $joined . ' ORDER BY e.event_id DESC LIMIT ' . (int) $params['limit'] . ' OFFSET ' . (int) $params['offset'],
            $args,
        );

        Http::list(array_map(static fn (array $r): array => [
            'event_id'   => (int) $r['event_id'],
            'session_id' => (int) $r['session_id'],
            'terminal_id' => $r['terminal_id'] === null ? null : (int) $r['terminal_id'],
            'event_kind' => (string) $r['event_kind'],
            'amount'     => (float) $r['amount'],
            'reason'     => $r['reason'] === null ? null : (string) $r['reason'],
            'actor_uuid' => (string) $r['actor_uuid'],
            'approved_by' => $r['approved_by'] === null ? null : (string) $r['approved_by'],
            'books_voucher_uuid' => $r['books_voucher_uuid'] === null ? null : (string) $r['books_voucher_uuid'],
            'created_at' => (string) $r['created_at'],
        ], $rows), $total, $params['limit'], $params['offset']);
    }

    /**
     * The audit trail, paged and filterable.
     *
     * Append-only at the database level, so this endpoint reads and nothing
     * else — there is deliberately no way to edit or delete a row through the
     * API, because the table itself would refuse.
     */
    public static function auditLog(): void
    {
        [$auth, $ctx] = self::enter();
        Permissions::assert($ctx, $auth, 'reports.view');

        $params = Http::listParams(['created_at'], 'created_at');
        $where  = ['cmp_id = :cmp'];
        $args   = ['cmp' => $ctx->cmpId];

        foreach ([['entity_type', 'entity_type'], ['entity_id', 'entity_id'], ['action', 'action'], ['actor_uuid', 'actor']] as [$column, $key]) {
            $value = Http::param($column);
            if ($value !== null && $value !== '') {
                $where[] = $column . ' = :' . $key;
                $args[$key] = $value;
            }
        }
        if (Http::param('from') !== null && Http::param('from') !== '') {
            $where[] = 'created_at >= :from';
            $args['from'] = Http::param('from');
        }

        $clause = implode(' AND ', $where);
        $total = (int) Db::scalar('SELECT COUNT(*) FROM ' . Audit::TABLE . ' WHERE ' . $clause, $args);
        $rows = Db::all(
            'SELECT audit_id, actor_uuid, actor_kind, source_app, action, entity_type, entity_id,
                    before_state, after_state, reason, created_at
             FROM ' . Audit::TABLE . ' WHERE ' . $clause . '
             ORDER BY audit_id DESC LIMIT ' . (int) $params['limit'] . ' OFFSET ' . (int) $params['offset'],
            $args,
        );

        Http::list(array_map(static fn (array $r): array => [
            'audit_id'     => (int) $r['audit_id'],
            'actor_uuid'   => (string) $r['actor_uuid'],
            'actor_kind'   => (string) $r['actor_kind'],
            'source_app'   => (string) $r['source_app'],
            'action'       => (string) $r['action'],
            'entity_type'  => (string) $r['entity_type'],
            'entity_id'    => $r['entity_id'] === null ? null : (string) $r['entity_id'],
            'before_state' => $r['before_state'] === null ? null : Db::jsonColumn($r['before_state']),
            'after_state'  => $r['after_state'] === null ? null : Db::jsonColumn($r['after_state']),
            'reason'       => $r['reason'] === null ? null : (string) $r['reason'],
            'created_at'   => (string) $r['created_at'],
        ], $rows), $total, $params['limit'], $params['offset']);
    }
}
