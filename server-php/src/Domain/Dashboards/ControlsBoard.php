<?php

declare(strict_types=1);

namespace Aicountly\Api\Domain\Dashboards;

use Aicountly\Api\Db;
use Aicountly\Api\IntegrationCommand;

/**
 * Cash, Shifts & Controls — closing the day, and everything that stops you.
 *
 * THE DRAWER FORMULA, spelled out because it is the number people argue over:
 *
 *   expected cash = opening float
 *                 + cash taken on sales (NET of change given)
 *                 + authorised cash pay-ins
 *                 − cash refunds paid out of the drawer
 *                 − cash payouts and petty withdrawals
 *                 − safe drops
 *
 *   variance      = counted cash − expected cash      (negative = short)
 *
 * NON-CASH TENDERS ARE NOT IN THE DRAWER and are not in this sum. A split bill
 * paid ₹400 card and ₹100 cash contributes ₹100, which is why the sum runs over
 * `pos_cash_drawer_events` — every row of which is a cash movement — rather than
 * over `pos_cart_payments`, where the card row would have to be remembered and
 * excluded each time.
 *
 * WHY IT IS RECOMPUTED HERE. `pos_register_sessions.expected_cash` is maintained
 * incrementally as events happen, which is what the till reads mid-shift. This
 * board recomputes the same figure from the events themselves and shows both.
 * If they ever disagree, that is a bug worth seeing on the screen rather than a
 * discrepancy silently inheriting the running total.
 */
final class ControlsBoard
{
    /**
     * Which drawer event kinds go which way.
     *
     * Kept as one list, used by the SQL and by the breakdown, so a new event
     * kind cannot be added to one and forgotten in the other.
     */
    private const ADDS      = ['opening_float', 'sale_tender', 'cash_in'];
    private const SUBTRACTS = ['refund', 'cash_out', 'petty_withdrawal', 'safe_drop'];
    /** Recorded, moves nothing: the count itself, and opening the drawer with no sale. */
    private const NEUTRAL   = ['closing_count', 'no_sale_open', 'change_given'];

    public function __construct(private readonly Window $win)
    {
    }

    /** @return array<string, mixed> */
    public function build(): array
    {
        $shifts = $this->shifts();

        return [
            'window'    => $this->win->describe(),
            'cash'      => $this->cashSummary(),
            'formula'   => [
                'expected_cash' => 'opening float + cash sales received + cash pay-ins − cash refunds − cash payouts − cash drops',
                'variance'      => 'counted cash − expected cash (negative is a shortage)',
                'note'          => 'Card, UPI and on-account tenders are not in the drawer and are not in this sum. '
                    . 'A split bill contributes only its cash portion.',
            ],
            'shifts'    => $shifts,
            'movements' => $this->movements(),
            'tenders'   => $this->tenderReconciliation(),
            'approvals' => $this->approvals(),
            'posting'   => $this->postingExceptions(),
            'audit'     => $this->auditTimeline(),
        ];
    }

    /**
     * The drawer, added up from the events themselves.
     *
     * @return array<string, mixed>
     */
    private function cashSummary(): array
    {
        [$scope, $params] = $this->sessionScope();

        $row = Db::first(
            "SELECT
                COALESCE(SUM(e.amount) FILTER (WHERE e.event_kind = 'opening_float'), 0)    AS opening_float,
                COALESCE(SUM(e.amount) FILTER (WHERE e.event_kind = 'sale_tender'), 0)      AS cash_sales,
                COALESCE(SUM(e.amount) FILTER (WHERE e.event_kind = 'cash_in'), 0)          AS cash_in,
                COALESCE(SUM(e.amount) FILTER (WHERE e.event_kind = 'refund'), 0)           AS cash_refunds,
                COALESCE(SUM(e.amount) FILTER (WHERE e.event_kind IN ('cash_out', 'petty_withdrawal')), 0) AS cash_payouts,
                COALESCE(SUM(e.amount) FILTER (WHERE e.event_kind = 'safe_drop'), 0)        AS cash_drops,
                COUNT(*) FILTER (WHERE e.event_kind = 'no_sale_open')                       AS no_sales
             FROM pos_cash_drawer_events e
             JOIN pos_register_sessions s ON s.session_id = e.session_id
             WHERE {$scope}",
            $params,
        ) ?? [];

        $openingFloat = (float) ($row['opening_float'] ?? 0);
        $cashSales    = (float) ($row['cash_sales'] ?? 0);
        $cashIn       = (float) ($row['cash_in'] ?? 0);
        $refunds      = (float) ($row['cash_refunds'] ?? 0);
        $payouts      = (float) ($row['cash_payouts'] ?? 0);
        $drops        = (float) ($row['cash_drops'] ?? 0);

        $expected = round($openingFloat + $cashSales + $cashIn - $refunds - $payouts - $drops, 4);

        // Counted cash exists only for shifts that have actually been counted.
        // Summing a null as zero would report a shortage the size of the float
        // for every shift still open.
        $counted = Db::first(
            "SELECT COALESCE(SUM(s.counted_cash), 0) AS counted,
                    COUNT(*) FILTER (WHERE s.counted_cash IS NOT NULL) AS counted_shifts,
                    COUNT(*) AS shifts,
                    COUNT(*) FILTER (WHERE s.status IN ('OPEN', 'CLOSING')) AS open_shifts,
                    COALESCE(SUM(s.expected_cash), 0) AS running_expected
             FROM pos_register_sessions s WHERE {$scope}",
            $params,
        ) ?? [];

        $countedShifts = (int) ($counted['counted_shifts'] ?? 0);
        $countedCash   = $countedShifts === 0 ? null : (float) ($counted['counted'] ?? 0);
        $runningTotal  = round((float) ($counted['running_expected'] ?? 0), 4);

        return [
            'opening_float' => $openingFloat,
            'cash_sales'    => $cashSales,
            'cash_in'       => $cashIn,
            'cash_refunds'  => $refunds,
            'cash_payouts'  => $payouts,
            'cash_drops'    => $drops,
            'expected_cash' => $expected,
            'counted_cash'  => $countedCash,
            // Null, not zero, while any shift is still open: a variance on a
            // drawer nobody has counted is not a variance.
            'variance'      => $countedCash === null ? null : round($countedCash - $expected, 4),
            'shifts'          => (int) ($counted['shifts'] ?? 0),
            'counted_shifts'  => $countedShifts,
            'open_shifts'     => (int) ($counted['open_shifts'] ?? 0),
            'no_sale_opens'   => (int) ($row['no_sales'] ?? 0),
            // The till's own running figure, for comparison. They should match.
            'running_expected_cash' => $runningTotal,
            'reconciles'    => abs($runningTotal - $expected) < 0.005,
        ];
    }

    /**
     * The shift register.
     *
     * @return list<array<string, mixed>>
     */
    private function shifts(): array
    {
        [$scope, $params] = $this->sessionScope();

        $rows = Db::all(
            "SELECT s.session_id, s.status, s.opened_by, s.closed_by, s.opened_at, s.closed_at,
                    s.opening_float, s.expected_cash, s.counted_cash, s.variance, s.variance_reason,
                    s.approved_by, s.terminal_id,
                    t.terminal_code, t.display_name AS terminal_name,
                    l.location_id, l.location_code, l.display_name AS location_name,
                    (SELECT COUNT(*) FROM pos_carts c WHERE c.session_id = s.session_id AND c.status = 'COMPLETED') AS bills,
                    (SELECT COALESCE(SUM(c.total_amount), 0) FROM pos_carts c WHERE c.session_id = s.session_id AND c.status = 'COMPLETED') AS net
             FROM pos_register_sessions s
             LEFT JOIN pos_terminals t ON t.terminal_id = s.terminal_id
             LEFT JOIN pos_location_profiles l ON l.location_id = t.location_id
             WHERE {$scope}
             ORDER BY s.opened_at DESC
             LIMIT 50",
            $params,
        );

        return array_map(static function (array $r): array {
            $variance = $r['variance'] === null ? null : (float) $r['variance'];

            return [
                'session_id'    => (int) $r['session_id'],
                'status'        => (string) $r['status'],
                'terminal_id'   => $r['terminal_id'] === null ? null : (int) $r['terminal_id'],
                'terminal_code' => $r['terminal_code'] === null ? null : (string) $r['terminal_code'],
                'terminal_name' => $r['terminal_name'] === null ? ($r['terminal_code'] === null ? null : (string) $r['terminal_code']) : (string) $r['terminal_name'],
                'location_id'   => $r['location_id'] === null ? null : (int) $r['location_id'],
                'location_name' => $r['location_name'] === null ? ($r['location_code'] === null ? null : (string) $r['location_code']) : (string) $r['location_name'],
                'opened_by'     => (string) $r['opened_by'],
                'closed_by'     => $r['closed_by'] === null ? null : (string) $r['closed_by'],
                'opened_at'     => (string) $r['opened_at'],
                'closed_at'     => $r['closed_at'] === null ? null : (string) $r['closed_at'],
                'opening_float' => (float) $r['opening_float'],
                'expected_cash' => (float) $r['expected_cash'],
                'counted_cash'  => $r['counted_cash'] === null ? null : (float) $r['counted_cash'],
                'variance'      => $variance,
                'variance_reason' => $r['variance_reason'] === null ? null : (string) $r['variance_reason'],
                'approved_by'   => $r['approved_by'] === null ? null : (string) $r['approved_by'],
                'bills'         => (int) $r['bills'],
                'net'           => (float) $r['net'],
                'review_state'  => self::reviewState((string) $r['status'], $variance, $r['approved_by']),
            ];
        }, $rows);
    }

    private static function reviewState(string $status, ?float $variance, mixed $approvedBy): string
    {
        if ($status !== 'CLOSED') {
            return 'open';
        }
        if ($variance === null || abs($variance) < 0.0001) {
            return 'balanced';
        }

        return ($approvedBy === null || $approvedBy === '') ? 'needs_review' : 'approved';
    }

    /**
     * Every movement of cash, with who and why.
     *
     * @return list<array<string, mixed>>
     */
    private function movements(): array
    {
        [$scope, $params] = $this->sessionScope();

        $rows = Db::all(
            "SELECT e.event_id, e.event_kind, e.amount, e.reason, e.actor_uuid, e.approved_by,
                    e.books_voucher_uuid, e.created_at, e.session_id,
                    t.terminal_code
             FROM pos_cash_drawer_events e
             JOIN pos_register_sessions s ON s.session_id = e.session_id
             LEFT JOIN pos_terminals t ON t.terminal_id = s.terminal_id
             WHERE {$scope} AND e.event_kind NOT IN ('sale_tender')
             ORDER BY e.created_at DESC
             LIMIT 40",
            $params,
        );

        return array_map(static function (array $r): array {
            $kind = (string) $r['event_kind'];

            return [
                'event_id'   => (int) $r['event_id'],
                'event_kind' => $kind,
                'label'      => self::movementLabel($kind),
                'direction'  => match (true) {
                    in_array($kind, self::ADDS, true)      => 'in',
                    in_array($kind, self::SUBTRACTS, true) => 'out',
                    in_array($kind, self::NEUTRAL, true)   => 'none',
                    // An event kind nobody taught this board about. Saying so
                    // beats silently treating it as neutral and quietly losing
                    // it from the drawer sum.
                    default                                => 'unclassified',
                },
                'amount'     => (float) $r['amount'],
                'reason'     => $r['reason'] === null ? null : (string) $r['reason'],
                'actor_uuid' => (string) $r['actor_uuid'],
                'approved_by' => $r['approved_by'] === null ? null : (string) $r['approved_by'],
                'books_voucher_uuid' => $r['books_voucher_uuid'] === null ? null : (string) $r['books_voucher_uuid'],
                'session_id'   => (int) $r['session_id'],
                'terminal_code' => $r['terminal_code'] === null ? null : (string) $r['terminal_code'],
                'created_at' => (string) $r['created_at'],
            ];
        }, $rows);
    }

    private static function movementLabel(string $kind): string
    {
        return match ($kind) {
            'opening_float'    => 'Opening float',
            'sale_tender'      => 'Cash from sales',
            'change_given'     => 'Change given',
            'cash_in'          => 'Cash paid in',
            'cash_out'         => 'Cash paid out',
            'refund'           => 'Cash refund',
            'safe_drop'        => 'Safe drop',
            'petty_withdrawal' => 'Petty withdrawal',
            'no_sale_open'     => 'Drawer opened, no sale',
            'closing_count'    => 'Drawer counted',
            default            => ucfirst(str_replace('_', ' ', $kind)),
        };
    }

    /**
     * Tender reconciliation — and the gap it cannot close.
     *
     * Recorded totals are POS' own. There is NO provider-confirmed total,
     * because there is no provider integration, and the column says
     * "unavailable" rather than repeating the recorded figure under a second
     * heading — which would make an unreconciled shop look reconciled.
     *
     * @return array<string, mixed>
     */
    private function tenderReconciliation(): array
    {
        [$where, $params] = $this->win->clause('c');
        [$where, $params] = $this->win->narrow($where, $params, 'c');

        $rows = Db::all(
            "SELECT p.payment_mode,
                    SUM(p.amount) AS amount,
                    COUNT(*) AS count,
                    COALESCE(SUM(p.change_given), 0) AS change_given,
                    COUNT(*) FILTER (WHERE p.reference IS NOT NULL AND p.reference <> '') AS with_reference
             FROM pos_cart_payments p
             JOIN pos_carts c ON c.cart_id = p.cart_id
             WHERE {$where} AND c.status = 'COMPLETED'
             GROUP BY p.payment_mode
             ORDER BY SUM(p.amount) DESC",
            $params,
        );

        [$rWhere, $rParams] = $this->win->clause('r');
        $refunds = Db::all(
            "SELECT r.resolution, COUNT(*) AS count, COALESCE(SUM(r.refund_amount), 0) AS amount
             FROM pos_returns r
             WHERE {$rWhere} AND r.status <> 'CANCELLED'
             GROUP BY r.resolution ORDER BY SUM(r.refund_amount) DESC",
            $rParams,
        );

        return [
            'lines' => array_map(static function (array $r): array {
                $described = Tenders::describe($r);
                $described['change_given']  = (float) $r['change_given'];
                $described['with_reference'] = (int) $r['with_reference'];
                // Explicit null, not a repeat of the recorded figure.
                $described['provider_confirmed'] = null;
                $described['unmatched']          = null;

                return $described;
            }, $rows),
            'refunds' => array_map(static fn (array $r): array => [
                'resolution'   => (string) $r['resolution'],
                'display_name' => ucfirst(str_replace('_', ' ', (string) $r['resolution'])),
                'count'        => (int) $r['count'],
                'amount'       => (float) $r['amount'],
            ], $refunds),
            'provider' => [
                'available' => false,
                'reason'    => 'no_integration',
                'note'      => 'No payment provider is integrated with POS, so there is no confirmed or settled total to '
                    . 'reconcile against. Card and UPI rows are what a cashier typed from an external terminal slip.',
                'contract_gap' => 'To reconcile, a provider API would need: a settlement batch listing by business date, '
                    . 'a per-transaction status lookup keyed on a reference POS can store, and a refund status. '
                    . 'Aicountly Pay is a future product and is not a dependency of anything here.',
            ],
        ];
    }

    /**
     * Everything a manager has to sign for.
     *
     * @return array<string, mixed>
     */
    private function approvals(): array
    {
        $params = [
            'cmp'      => $this->win->ctx->cmpId,
            'win_from' => $this->win->startsAt,
            'win_to'   => $this->win->endsAt,
        ];

        $summary = Db::all(
            "SELECT event_kind, COUNT(*) AS count,
                    COUNT(*) FILTER (WHERE approved_by IS NULL) AS unapproved
             FROM pos_approval_events
             WHERE cmp_id = :cmp AND created_at >= :win_from AND created_at < :win_to
             GROUP BY event_kind ORDER BY COUNT(*) DESC",
            $params,
        );

        $rows = Db::all(
            "SELECT a.approval_id, a.event_kind, a.requested_by, a.approved_by, a.reason, a.detail,
                    a.created_at, a.cart_id, a.session_id, t.terminal_code
             FROM pos_approval_events a
             LEFT JOIN pos_terminals t ON t.terminal_id = a.terminal_id
             WHERE a.cmp_id = :cmp AND a.created_at >= :win_from AND a.created_at < :win_to
             ORDER BY a.approval_id DESC
             LIMIT 30",
            $params,
        );

        // A closed shift that is out and unsigned is the one approval that is
        // genuinely OUTSTANDING rather than merely recorded.
        [$scope, $scopeParams] = $this->sessionScope();
        $pendingVariances = Db::all(
            "SELECT s.session_id, s.terminal_id, s.variance, s.variance_reason, s.closed_at, s.closed_by,
                    t.terminal_code
             FROM pos_register_sessions s
             LEFT JOIN pos_terminals t ON t.terminal_id = s.terminal_id
             WHERE {$scope} AND s.status = 'CLOSED' AND s.variance IS NOT NULL
               AND ABS(s.variance) > 0.0001 AND s.approved_by IS NULL
             ORDER BY s.closed_at DESC LIMIT 20",
            $scopeParams,
        );

        return [
            'summary' => array_map(static fn (array $r): array => [
                'event_kind'   => (string) $r['event_kind'],
                'display_name' => self::approvalLabel((string) $r['event_kind']),
                'count'        => (int) $r['count'],
                'unapproved'   => (int) $r['unapproved'],
            ], $summary),
            'events' => array_map(static fn (array $r): array => [
                'approval_id'  => (int) $r['approval_id'],
                'event_kind'   => (string) $r['event_kind'],
                'display_name' => self::approvalLabel((string) $r['event_kind']),
                'requested_by' => (string) $r['requested_by'],
                'approved_by'  => $r['approved_by'] === null ? null : (string) $r['approved_by'],
                'reason'       => $r['reason'] === null ? null : (string) $r['reason'],
                'detail'       => Db::jsonColumn($r['detail'] ?? null),
                'cart_id'      => $r['cart_id'] === null ? null : (int) $r['cart_id'],
                'session_id'   => $r['session_id'] === null ? null : (int) $r['session_id'],
                'terminal_code' => $r['terminal_code'] === null ? null : (string) $r['terminal_code'],
                'created_at'   => (string) $r['created_at'],
            ], $rows),
            'pending_variances' => array_map(static fn (array $r): array => [
                'session_id'    => (int) $r['session_id'],
                'terminal_code' => $r['terminal_code'] === null ? null : (string) $r['terminal_code'],
                'variance'      => (float) $r['variance'],
                'reason'        => $r['variance_reason'] === null ? null : (string) $r['variance_reason'],
                'closed_at'     => $r['closed_at'] === null ? null : (string) $r['closed_at'],
                'closed_by'     => $r['closed_by'] === null ? null : (string) $r['closed_by'],
            ], $pendingVariances),
        ];
    }

    private static function approvalLabel(string $kind): string
    {
        return match ($kind) {
            'discount'       => 'Discount override',
            'price_override' => 'Price override',
            'void_line'      => 'Line voided',
            'void_cart'      => 'Bill voided',
            'return'         => 'Return',
            'refund'         => 'Refund',
            'no_sale'        => 'Drawer opened, no sale',
            'drawer'         => 'Cash adjustment',
            'negative_stock' => 'Sold past a stock warning',
            'kot_cancel'     => 'Kitchen ticket cancelled',
            'reprint'        => 'Receipt reprinted',
            'shift_variance' => 'Shift variance',
            default          => ucfirst(str_replace('_', ' ', $kind)),
        };
    }

    /**
     * The four states of a sale that has left the counter, kept apart.
     *
     * A sale is not "done" or "not done". It has a payment outcome, a Books
     * outcome and an Inventory outcome, and the recovery action differs for
     * each. FAILED offers Retry; BLOCKED does not, because retrying a locked
     * period teaches people to press a button that cannot work.
     *
     * @return array<string, mixed>
     */
    private function postingExceptions(): array
    {
        $params = ['cmp' => $this->win->ctx->cmpId];

        $commands = Db::all(
            "SELECT k.command_id, k.target_service, k.command_type, k.entity_type, k.entity_id,
                    k.status, k.attempts, k.last_error, k.last_attempt_at, k.created_at,
                    k.idempotency_key, k.request_summary,
                    c.cart_uuid, c.total_amount, c.books_voucher_no, c.terminal_id, t.terminal_code
             FROM " . IntegrationCommand::TABLE . " k
             LEFT JOIN pos_carts c ON c.cart_id = k.entity_id AND k.entity_type = 'cart' AND c.cmp_id = k.cmp_id
             LEFT JOIN pos_terminals t ON t.terminal_id = c.terminal_id
             WHERE k.cmp_id = :cmp AND k.status IN ('PENDING', 'POSTING', 'FAILED', 'BLOCKED')
             ORDER BY k.command_id DESC
             LIMIT 30",
            $params,
        );

        $offline = Db::all(
            "SELECT o.submission_id, o.client_uuid, o.device_uuid, o.status, o.conflict_kind,
                    o.conflict_detail, o.attempts, o.last_error, o.client_created_at, o.received_at,
                    o.terminal_id, t.terminal_code
             FROM pos_offline_submissions o
             LEFT JOIN pos_terminals t ON t.terminal_id = o.terminal_id
             WHERE o.cmp_id = :cmp AND o.status NOT IN ('POSTED', 'ABANDONED')
             ORDER BY o.received_at DESC
             LIMIT 20",
            $params,
        );

        return [
            'note' => 'Payment, Books and Inventory are separate outcomes. A timeout is an UNKNOWN outcome, not a failure — '
                . 'the original idempotency key is kept so a retry lands on the same document instead of billing twice.',
            'commands' => array_map(static fn (array $r): array => [
                'command_id'     => (int) $r['command_id'],
                'target_service' => (string) $r['target_service'],
                'command_type'   => (string) $r['command_type'],
                'entity_type'    => (string) $r['entity_type'],
                'entity_id'      => (int) $r['entity_id'],
                'status'         => (string) $r['status'],
                'state_label'    => self::commandLabel((string) $r['status']),
                'retryable'      => in_array((string) $r['status'], ['FAILED'], true),
                'attempts'       => (int) $r['attempts'],
                'last_error'     => $r['last_error'] === null ? null : (string) $r['last_error'],
                'last_attempt_at' => $r['last_attempt_at'] === null ? null : (string) $r['last_attempt_at'],
                'created_at'     => (string) $r['created_at'],
                'cart_uuid'      => $r['cart_uuid'] === null ? null : (string) $r['cart_uuid'],
                'total_amount'   => $r['total_amount'] === null ? null : (float) $r['total_amount'],
                'books_voucher_no' => $r['books_voucher_no'] === null ? null : (string) $r['books_voucher_no'],
                'terminal_code'  => $r['terminal_code'] === null ? null : (string) $r['terminal_code'],
            ], $commands),
            'offline' => array_map(static fn (array $r): array => [
                'submission_id'  => (int) $r['submission_id'],
                'client_uuid'    => (string) $r['client_uuid'],
                'device_uuid'    => (string) $r['device_uuid'],
                'status'         => (string) $r['status'],
                'retryable'      => (string) $r['status'] !== 'CONFLICT',
                'conflict_kind'  => $r['conflict_kind'] === null ? null : (string) $r['conflict_kind'],
                'conflict_detail' => $r['conflict_detail'] === null ? null : (string) $r['conflict_detail'],
                'attempts'       => (int) $r['attempts'],
                'last_error'     => $r['last_error'] === null ? null : (string) $r['last_error'],
                'client_created_at' => (string) $r['client_created_at'],
                'received_at'    => (string) $r['received_at'],
                'terminal_code'  => $r['terminal_code'] === null ? null : (string) $r['terminal_code'],
            ], $offline),
        ];
    }

    private static function commandLabel(string $status): string
    {
        return match ($status) {
            'PENDING'  => 'Not sent yet',
            'POSTING'  => 'In flight — outcome unknown until it answers',
            'FAILED'   => 'Transport failure — safe to retry on the same key',
            'BLOCKED'  => 'Refused for a business reason — retrying will not help',
            default    => ucfirst(strtolower($status)),
        };
    }

    /**
     * Who did what, with the before and after.
     *
     * @return list<array<string, mixed>>
     */
    private function auditTimeline(): array
    {
        [$where, $params] = $this->win->clause('a');

        $rows = Db::all(
            "SELECT a.audit_id, a.actor_uuid, a.actor_kind, a.source_app, a.action,
                    a.entity_type, a.entity_id, a.before_state, a.after_state, a.reason, a.created_at
             FROM " . \Aicountly\Api\Audit::TABLE . " a
             WHERE {$where}
             ORDER BY a.audit_id DESC
             LIMIT 40",
            $params,
        );

        return array_map(static fn (array $r): array => [
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
        ], $rows);
    }

    /**
     * Which shifts this board is about.
     *
     * A shift is IN the window when it was opened in it — a night shift that
     * closes at 3am belongs to the night it opened, which is the same rule the
     * business date uses.
     *
     * Without `reports.view` a cashier sees their own shifts and nobody else's,
     * enforced here in SQL rather than by hiding a panel.
     *
     * @return array{0:string, 1:array<string, mixed>}
     */
    private function sessionScope(): array
    {
        [$sql, $params] = $this->win->clause('s', true, 'opened_at');

        if ($this->win->locationId !== null) {
            $sql .= ' AND s.terminal_id IN (SELECT terminal_id FROM pos_terminals WHERE cmp_id = :sc_cmp AND location_id = :sc_loc)';
            $params['sc_cmp'] = $this->win->ctx->cmpId;
            $params['sc_loc'] = $this->win->locationId;
        }
        if ($this->win->terminalId !== null) {
            $sql .= ' AND s.terminal_id = :sc_term';
            $params['sc_term'] = $this->win->terminalId;
        }
        if ($this->win->sessionId !== null) {
            $sql .= ' AND s.session_id = :sc_sess';
            $params['sc_sess'] = $this->win->sessionId;
        }
        if (!$this->win->seesEveryone) {
            $sql .= ' AND s.opened_by = :sc_me';
            $params['sc_me'] = $this->win->auth->uuid;
        }

        return [$sql, $params];
    }
}
