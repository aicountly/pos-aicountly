<?php

declare(strict_types=1);

namespace Aicountly\Api\Domain;

use Aicountly\Api\Audit;
use Aicountly\Api\Auth;
use Aicountly\Api\Context;
use Aicountly\Api\Db;
use Aicountly\Api\Http;
use Aicountly\Api\Permissions;

/**
 * A cashier's shift at a till, and the cash in the drawer during it.
 *
 * WHAT THIS IS NOT: it is not the company's cash balance. Books owns that, and
 * every cash sale posts there like any other sale. What lives here is the
 * OPERATIONAL control — what the drawer should hold according to this shift's
 * own events, what the cashier actually counted, and who signed for the
 * difference. Storing a cash balance here would be a second copy of a number
 * Books already owns, and the release-blocking ownership test fails if one
 * appears.
 *
 * The distinction matters at close-out. When the drawer is short by 200, the
 * company's cash balance in Books is not wrong — the cash is genuinely missing.
 * What POS records is which shift it went missing in and who approved the
 * write-off; the accounting consequence, if any, is a voucher in Books.
 */
final class RegisterService
{
    public function __construct(
        private readonly Context $ctx,
        private readonly Auth $auth,
    ) {
    }

    /**
     * Open a till for a shift.
     *
     * One open session per terminal, enforced on read inside the transaction.
     * Two cashiers signing on to the same till at the same moment is a real
     * thing in a queue, and the second one must be told rather than given a
     * parallel drawer nobody will reconcile.
     *
     * @param array<string, mixed> $input
     */
    public function open(array $input): array
    {
        Permissions::assert($this->ctx, $this->auth, 'shift.open');

        $terminalId = (int) ($input['terminal_id'] ?? 0);
        if ($terminalId <= 0) {
            Http::validationFailed('Choose the till you are opening.', ['field' => 'terminal_id']);
        }

        $terminal = Db::first(
            'SELECT * FROM pos_terminals WHERE terminal_id = :id AND cmp_id = :cmp',
            ['id' => $terminalId, 'cmp' => $this->ctx->cmpId],
        );
        if ($terminal === null) {
            Http::notFound('That till does not exist.');
        }
        if (!$terminal['is_active']) {
            Http::conflict('That till has been deactivated. Ask an administrator to turn it back on.');
        }

        $float = self::amount($input['opening_float'] ?? 0);

        return Db::transaction(function () use ($terminalId, $float, $input) {
            $open = Db::first(
                "SELECT session_id, opened_by FROM pos_register_sessions
                 WHERE cmp_id = :cmp AND terminal_id = :terminal AND status IN ('OPEN', 'CLOSING')
                 FOR UPDATE",
                ['cmp' => $this->ctx->cmpId, 'terminal' => $terminalId],
            );
            if ($open !== null) {
                Http::conflict('This till is already open on another shift. Close that shift first.', [
                    'session_id' => (int) $open['session_id'],
                ]);
            }

            $sessionId = (int) Db::insert('pos_register_sessions', [
                'cmp_id'        => $this->ctx->cmpId,
                'fy_id'         => $this->ctx->fyId,
                'bo_id'         => $this->ctx->boId,
                'terminal_id'   => $terminalId,
                'opened_by'     => $this->auth->uuid,
                'status'        => 'OPEN',
                'opening_float' => $float,
                'expected_cash' => $float,
                'notes'         => self::text($input['notes'] ?? null),
            ], 'session_id');

            if ($float > 0) {
                $this->recordDrawerEvent($sessionId, 'opening_float', $float, 'Opening float');
            }

            Audit::record($this->ctx, $this->auth, 'shift.opened', 'register_session', $sessionId, null, [
                'terminal_id' => $terminalId, 'opening_float' => $float,
            ]);

            return $this->find($sessionId);
        });
    }

    /**
     * Count the drawer and close the shift.
     *
     * The variance is computed here, from this shift's own events, and is NEVER
     * silently absorbed. A shift that does not balance closes as CLOSED with a
     * recorded variance and an approver, or it does not close.
     *
     * @param array<string, mixed> $input
     */
    public function close(int $sessionId, array $input): array
    {
        Permissions::assert($this->ctx, $this->auth, 'shift.close');

        $session = $this->find($sessionId);
        if ($session === []) {
            Http::notFound('That shift does not exist.');
        }
        if ($session['status'] === 'CLOSED') {
            Http::conflict('This shift is already closed.');
        }

        $openCarts = (int) Db::scalar(
            "SELECT COUNT(*) FROM pos_carts WHERE cmp_id = :cmp AND session_id = :sid AND status IN ('OPEN', 'HELD')",
            ['cmp' => $this->ctx->cmpId, 'sid' => $sessionId],
        );
        if ($openCarts > 0) {
            Http::conflict(
                'There ' . ($openCarts === 1 ? 'is 1 sale' : "are {$openCarts} sales") . ' still on this till. Finish or void them before closing.',
                ['open_carts' => $openCarts],
            );
        }

        if (!array_key_exists('counted_cash', $input)) {
            Http::validationFailed('Count the drawer before closing the shift.', ['field' => 'counted_cash']);
        }

        $counted  = self::amount($input['counted_cash']);
        $expected = (float) $session['expected_cash'];
        $variance = round($counted - $expected, 4);
        $reason   = self::text($input['variance_reason'] ?? null);

        // A variance needs either a reason from someone who may approve one, or
        // the shift stays open. Silently closing a short drawer is how a slow
        // leak becomes a year-end surprise.
        if (abs($variance) > 0.0001) {
            if ($reason === null || $reason === '') {
                Http::validationFailed('The drawer does not balance. Say what happened before closing the shift.', [
                    'field' => 'variance_reason', 'expected_cash' => $expected, 'counted_cash' => $counted, 'variance' => $variance,
                ]);
            }
            if (!Permissions::allows($this->ctx, $this->auth, 'shift.approve_variance')) {
                Http::forbidden('This drawer is out by ' . number_format(abs($variance), 2) . '. A manager has to approve the close.');
            }
        }

        return Db::transaction(function () use ($sessionId, $session, $counted, $variance, $reason) {
            $this->recordDrawerEvent($sessionId, 'closing_count', $counted, 'Drawer counted at close');

            Db::update('pos_register_sessions', [
                'status'          => 'CLOSED',
                'closed_by'       => $this->auth->uuid,
                'closed_at'       => self::now(),
                'counted_cash'    => $counted,
                'variance'        => $variance,
                'variance_reason' => $reason,
                'approved_by'     => abs($variance) > 0.0001 ? $this->auth->uuid : null,
                'updated_at'      => self::now(),
            ], ['session_id' => $sessionId, 'cmp_id' => $this->ctx->cmpId]);

            if (abs($variance) > 0.0001) {
                Db::insert('pos_approval_events', [
                    'cmp_id'       => $this->ctx->cmpId,
                    'terminal_id'  => $session['terminal_id'],
                    'session_id'   => $sessionId,
                    'event_kind'   => 'shift_variance',
                    'requested_by' => $this->auth->uuid,
                    'approved_by'  => $this->auth->uuid,
                    'reason'       => $reason,
                    'detail'       => ['expected' => (float) $session['expected_cash'], 'counted' => $counted, 'variance' => $variance],
                ], 'approval_id');
            }

            Audit::record($this->ctx, $this->auth, 'shift.closed', 'register_session', $sessionId,
                ['status' => $session['status']],
                ['status' => 'CLOSED', 'counted_cash' => $counted, 'variance' => $variance],
                $reason ?? '',
            );

            return $this->find($sessionId);
        });
    }

    /**
     * Cash in, cash out, a safe drop, or opening the drawer with no sale.
     *
     * Every one of these is a moment a drawer can be emptied, so every one of
     * them is attributable and — for a no-sale — separately permissioned.
     *
     * @param array<string, mixed> $input
     */
    public function drawerEvent(int $sessionId, array $input): array
    {
        $kind = (string) ($input['event_kind'] ?? '');
        $allowed = ['cash_in', 'cash_out', 'safe_drop', 'petty_withdrawal', 'no_sale_open'];
        if (!in_array($kind, $allowed, true)) {
            Http::validationFailed('That is not something that can happen to a drawer.', ['field' => 'event_kind', 'allowed' => $allowed]);
        }

        Permissions::assert($this->ctx, $this->auth, $kind === 'no_sale_open' ? 'drawer.no_sale' : 'drawer.cash_io');

        $session = $this->find($sessionId);
        if ($session === []) {
            Http::notFound('That shift does not exist.');
        }
        if ($session['status'] !== 'OPEN') {
            Http::conflict('This shift is closed. Open a new one before touching the drawer.');
        }

        $amount = $kind === 'no_sale_open' ? 0.0 : self::amount($input['amount'] ?? 0);
        if ($kind !== 'no_sale_open' && $amount <= 0) {
            Http::validationFailed('How much money moved?', ['field' => 'amount']);
        }

        $reason = self::text($input['reason'] ?? null);
        if ($reason === null || $reason === '') {
            Http::validationFailed('Say why the drawer was opened.', ['field' => 'reason']);
        }

        return Db::transaction(function () use ($sessionId, $kind, $amount, $reason) {
            $this->recordDrawerEvent($sessionId, $kind, $amount, $reason);

            // Cash leaving the drawer reduces what should be in it; cash coming
            // in raises it. A no-sale moves nothing and is recorded anyway,
            // because it is the single most useful signal in a till fraud
            // investigation.
            $delta = match ($kind) {
                'cash_in'                                      => $amount,
                'cash_out', 'safe_drop', 'petty_withdrawal'    => -$amount,
                default                                        => 0.0,
            };

            if (abs($delta) > 0.0001) {
                Db::run(
                    'UPDATE pos_register_sessions SET expected_cash = expected_cash + :delta, updated_at = :now
                     WHERE session_id = :id AND cmp_id = :cmp',
                    ['delta' => $delta, 'now' => self::now(), 'id' => $sessionId, 'cmp' => $this->ctx->cmpId],
                );
            }

            Db::insert('pos_approval_events', [
                'cmp_id'       => $this->ctx->cmpId,
                'terminal_id'  => $this->find($sessionId)['terminal_id'] ?? null,
                'session_id'   => $sessionId,
                'event_kind'   => $kind === 'no_sale_open' ? 'no_sale' : 'drawer',
                'requested_by' => $this->auth->uuid,
                'approved_by'  => $this->auth->uuid,
                'reason'       => $reason,
                'detail'       => ['kind' => $kind, 'amount' => $amount],
            ], 'approval_id');

            Audit::record($this->ctx, $this->auth, 'drawer.' . $kind, 'register_session', $sessionId, null, ['amount' => $amount], $reason);

            return $this->find($sessionId);
        });
    }

    /**
     * The X report — where this shift stands right now, without closing it.
     *
     * Built from this shift's own carts and drawer events. It deliberately does
     * NOT ask Books for a sales total: Books' number is the accounting truth
     * and can differ (a sale still in flight, a voucher cancelled by an
     * accountant), and a cashier counting a drawer needs to reconcile against
     * what this till took, not against the ledger.
     */
    public function report(int $sessionId): array
    {
        Permissions::assert($this->ctx, $this->auth, 'reports.view');

        $session = $this->find($sessionId);
        if ($session === []) {
            Http::notFound('That shift does not exist.');
        }

        $tenders = Db::all(
            "SELECT p.payment_mode, SUM(p.amount) AS amount, COUNT(*) AS count
             FROM pos_cart_payments p
             JOIN pos_carts c ON c.cart_id = p.cart_id
             WHERE c.cmp_id = :cmp AND c.session_id = :sid AND c.status = 'COMPLETED'
             GROUP BY p.payment_mode ORDER BY p.payment_mode",
            ['cmp' => $this->ctx->cmpId, 'sid' => $sessionId],
        );

        $sales = Db::first(
            "SELECT COUNT(*) AS bills, COALESCE(SUM(total_amount), 0) AS net,
                    COALESCE(SUM(discount_amount), 0) AS discount, COALESCE(SUM(estimated_tax_amount), 0) AS tax
             FROM pos_carts
             WHERE cmp_id = :cmp AND session_id = :sid AND status = 'COMPLETED'",
            ['cmp' => $this->ctx->cmpId, 'sid' => $sessionId],
        ) ?? [];

        $voids = (int) Db::scalar(
            "SELECT COUNT(*) FROM pos_carts WHERE cmp_id = :cmp AND session_id = :sid AND status = 'VOID'",
            ['cmp' => $this->ctx->cmpId, 'sid' => $sessionId],
        );

        $refunds = (float) Db::scalar(
            "SELECT COALESCE(SUM(refund_amount), 0) FROM pos_returns
             WHERE cmp_id = :cmp AND session_id = :sid AND status <> 'CANCELLED'",
            ['cmp' => $this->ctx->cmpId, 'sid' => $sessionId],
        );

        $drawer = Db::all(
            'SELECT event_kind, SUM(amount) AS amount, COUNT(*) AS count
             FROM pos_cash_drawer_events WHERE session_id = :sid GROUP BY event_kind ORDER BY event_kind',
            ['sid' => $sessionId],
        );

        return [
            'session'  => $session,
            'sales'    => [
                'bills'    => (int) ($sales['bills'] ?? 0),
                'net'      => (float) ($sales['net'] ?? 0),
                'discount' => (float) ($sales['discount'] ?? 0),
                'tax'      => (float) ($sales['tax'] ?? 0),
                'voids'    => $voids,
                'refunds'  => $refunds,
            ],
            'tenders'  => array_map(static fn (array $r) => [
                'payment_mode' => (string) $r['payment_mode'],
                'amount'       => (float) $r['amount'],
                'count'        => (int) $r['count'],
            ], $tenders),
            'drawer'   => array_map(static fn (array $r) => [
                'event_kind' => (string) $r['event_kind'],
                'amount'     => (float) $r['amount'],
                'count'      => (int) $r['count'],
            ], $drawer),
            // What the drawer should hold, and how far off the last count was.
            // Written out rather than left to the caller's arithmetic, so the
            // till screen and the manager's screen cannot disagree.
            'expected_cash' => (float) $session['expected_cash'],
            'counted_cash'  => $session['counted_cash'] === null ? null : (float) $session['counted_cash'],
            'variance'      => $session['variance'] === null ? null : (float) $session['variance'],
        ];
    }

    /** The shift currently open on a till, if there is one. */
    public function currentForTerminal(int $terminalId): ?array
    {
        $row = Db::first(
            "SELECT * FROM pos_register_sessions
             WHERE cmp_id = :cmp AND terminal_id = :terminal AND status IN ('OPEN', 'CLOSING')
             ORDER BY session_id DESC LIMIT 1",
            ['cmp' => $this->ctx->cmpId, 'terminal' => $terminalId],
        );

        return $row === null ? null : $this->hydrate($row);
    }

    /** @return list<array<string, mixed>> */
    public function listSessions(array $filters, int $limit, int $offset): array
    {
        [$scope, $params] = $this->ctx->scopeClause();
        $where = [$scope];

        if (!empty($filters['terminal_id'])) {
            $where[] = 'terminal_id = :terminal';
            $params['terminal'] = (int) $filters['terminal_id'];
        }
        if (!empty($filters['status'])) {
            $where[] = 'status = :status';
            $params['status'] = (string) $filters['status'];
        }

        $clause = implode(' AND ', $where);
        $total = (int) Db::scalar('SELECT COUNT(*) FROM pos_register_sessions WHERE ' . $clause, $params);
        $rows = Db::all(
            'SELECT * FROM pos_register_sessions WHERE ' . $clause . ' ORDER BY session_id DESC LIMIT ' . (int) $limit . ' OFFSET ' . (int) $offset,
            $params,
        );

        return [array_map(fn (array $r) => $this->hydrate($r), $rows), $total];
    }

    public function find(int $sessionId): array
    {
        $row = Db::first(
            'SELECT * FROM pos_register_sessions WHERE session_id = :id AND cmp_id = :cmp',
            ['id' => $sessionId, 'cmp' => $this->ctx->cmpId],
        );

        return $row === null ? [] : $this->hydrate($row);
    }

    private function recordDrawerEvent(int $sessionId, string $kind, float $amount, ?string $reason): void
    {
        Db::insert('pos_cash_drawer_events', [
            'session_id' => $sessionId,
            'cmp_id'     => $this->ctx->cmpId,
            'event_kind' => $kind,
            'amount'     => $amount,
            'reason'     => $reason,
            'actor_uuid' => $this->auth->uuid,
        ], 'event_id');
    }

    /** @param array<string, mixed> $row */
    private function hydrate(array $row): array
    {
        $row['session_id']    = (int) $row['session_id'];
        $row['terminal_id']   = (int) $row['terminal_id'];
        $row['opening_float'] = (float) $row['opening_float'];
        $row['expected_cash'] = (float) $row['expected_cash'];
        $row['counted_cash']  = $row['counted_cash'] === null ? null : (float) $row['counted_cash'];
        $row['variance']      = $row['variance'] === null ? null : (float) $row['variance'];

        return $row;
    }

    private static function amount(mixed $raw): float
    {
        return round((float) $raw, 4);
    }

    private static function text(mixed $raw): ?string
    {
        if (!is_string($raw)) {
            return null;
        }
        $trimmed = trim($raw);

        return $trimmed === '' ? null : $trimmed;
    }

    private static function now(): string
    {
        return gmdate('Y-m-d H:i:s');
    }
}
