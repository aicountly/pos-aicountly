<?php

declare(strict_types=1);

namespace Aicountly\Api\Domain\Shift;

use Aicountly\Api\Auth;
use Aicountly\Api\Context;
use Aicountly\Api\Db;
use Aicountly\Api\Domain\Dashboards\Tenders;
use Aicountly\Api\Domain\Dashboards\Window;
use Aicountly\Api\Http;
use Aicountly\Api\Permissions;

/**
 * One shift, in the ten seconds a manager has to understand it.
 *
 * WHAT THIS IS. The operational record of a single cashier's shift at a single
 * till: what it sold, how it was paid, what needed a manager, and whether the
 * drawer balances. Every figure on it is counted from POS' own rows.
 *
 * WHAT THIS IS NOT. It is not the shop's revenue and it is not an accounting
 * report. Books owns the ledger, its figure for the same day can legitimately
 * differ — a voucher cancelled by an accountant, a sale still in flight — and
 * this screen says so at the bottom rather than quietly showing a second number
 * under the same word.
 *
 * ONE ROUND TRIP. The screen asks six questions about the same shift, and six
 * endpoints answering them separately would be six connections from a tablet on
 * shop broadband and six chances to render half a shift. So the whole board is
 * one query set behind one response, and only the two genuinely unbounded
 * lists — the audit trail and the risk drill-downs — are paged separately and
 * fetched when someone asks for them.
 *
 * THE BUSINESS DATE IS THE OUTLET'S. A shift opened at 11pm on Friday belongs
 * to Friday even though it closes on Saturday in UTC, so every boundary here
 * comes from the outlet's own trading calendar — the same rule, and the same
 * code, the five dashboards use.
 */
final class ShiftReportBoard
{
    /**
     * Drawer events the trail does not repeat.
     *
     * `sale_tender` and `change_given` are every cash sale of the shift: a busy
     * Saturday puts four hundred of them in the trail and buries the six
     * movements somebody is actually looking for. They are in the tender mix
     * and the cash summary, which is where they answer a question.
     *
     * `opening_float` is the shift opening, which the audit log already
     * records as `shift.opened` — one fact, told once. The float itself rides
     * on that row, read out of the audit entry's own after-state.
     */
    private const NOISE_EVENTS = ["'sale_tender'", "'change_given'", "'opening_float'"];

    private function __construct(
        private readonly Context $ctx,
        private readonly Auth $auth,
        private readonly ShiftPolicy $policy,
        private readonly bool $seesEveryone,
        private readonly ?int $locationId,
        private readonly string $date,
        private readonly string $timezone,
        private readonly int $dayStartMinutes,
        private readonly string $dayStartsAt,
        private readonly string $dayEndsAt,
        /** @var array<string, mixed>|null */
        private readonly ?array $session,
    ) {
    }

    /**
     * Work out which shift is being asked about.
     *
     * `session_id` wins when it is given, and the outlet and date follow from
     * it — a link to one shift has to open that shift, not the shift that
     * happens to be on the same till today. With no session named, the outlet's
     * business date decides, and the open shift beats the most recent closed
     * one because an open till is the one somebody is standing at.
     */
    public static function fromRequest(Context $ctx, Auth $auth): self
    {
        $policy       = ShiftPolicy::forCompany($ctx->cmpId);
        $seesEveryone = Permissions::allows($ctx, $auth, 'reports.view');

        $session    = self::resolveSession($ctx, $auth, $seesEveryone);
        $locationId = self::resolveLocation($ctx, $session);

        [$timezone, $dayStart] = Window::outletCalendar($ctx, $locationId);

        $date = $session !== null
            ? self::businessDateOf((string) $session['opened_at'], $timezone, $dayStart)
            : self::requestedDate($timezone, $dayStart);

        return new self(
            $ctx,
            $auth,
            $policy,
            $seesEveryone,
            $locationId,
            $date,
            $timezone,
            $dayStart,
            Window::instantAt($date, $timezone, $dayStart),
            Window::instantAt(Window::plusDays($date, 1), $timezone, $dayStart),
            $session,
        );
    }

    public function sessionId(): ?int
    {
        return $this->session === null ? null : (int) $this->session['session_id'];
    }

    /** @return array<string, mixed> */
    public function build(): array
    {
        // With no shift chosen there is still a screen to draw: the filters,
        // the outlets, and an honest empty state. It is not an error.
        if ($this->session === null) {
            return [
                'context'      => $this->context(),
                'shift'        => null,
                'metrics'      => self::zeroMetrics(),
                'comparison'   => null,
                'cash'         => null,
                'payment_mix'  => [],
                'hourly_sales' => [],
                'channels'     => ['total_orders' => 0, 'rows' => []],
                'risk'         => ['tiles' => [], 'suspicious' => ['items' => [], 'note' => '']],
                'denominations' => null,
                'events'       => ['items' => [], 'total' => 0, 'kinds' => self::eventKinds([])],
                'policy'       => $this->policyBlock(),
                'source_note'  => self::SOURCE_NOTE,
                'generated_at' => gmdate('c'),
            ];
        }

        $sessionId = (int) $this->session['session_id'];
        $metrics   = $this->metrics($sessionId);
        $cash      = $this->cash($sessionId);
        $events    = $this->events($sessionId, null, 12, 0);

        return [
            'context'       => $this->context(),
            'shift'         => $this->shift($cash),
            'metrics'       => $metrics,
            'comparison'    => $this->comparison($metrics),
            'cash'          => $cash,
            'payment_mix'   => $this->paymentMix($sessionId),
            'hourly_sales'  => $this->hourlySales($sessionId),
            'channels'      => $this->channels($sessionId),
            'risk'          => $this->risk($sessionId, $cash),
            'denominations' => $this->denominations($sessionId, $cash),
            'events'        => $events,
            'policy'        => $this->policyBlock(),
            'source_note'   => self::SOURCE_NOTE,
            'generated_at'  => gmdate('c'),
        ];
    }

    public const SOURCE_NOTE = 'Figures are counted from this POS. Accounting figures are maintained in Books and may differ.';

    // -----------------------------------------------------------------------
    // Context — what the filters offer
    // -----------------------------------------------------------------------

    /** @return array<string, mixed> */
    private function context(): array
    {
        $outlets = Db::all(
            'SELECT location_id, location_code, display_name, pos_mode
             FROM pos_location_profiles WHERE cmp_id = :cmp AND is_active = TRUE ORDER BY location_code',
            ['cmp' => $this->ctx->cmpId],
        );

        return [
            'date'          => $this->date,
            'location_id'   => $this->locationId,
            'session_id'    => $this->sessionId(),
            'timezone'      => $this->timezone,
            'day_start_minutes' => $this->dayStartMinutes,
            'outlets'       => array_map(static fn (array $r): array => [
                'location_id'  => (int) $r['location_id'],
                'location_code' => (string) $r['location_code'],
                'display_name' => (string) ($r['display_name'] ?? $r['location_code']),
                'pos_mode'     => (string) $r['pos_mode'],
            ], $outlets),
            'shifts'        => $this->shiftsOnDate(),
            'scope_note'    => $this->seesEveryone
                ? 'Every till in this outlet.'
                : 'Only the shifts you opened. Ask a manager for the outlet view.',
        ];
    }

    /**
     * The shifts the selector offers for this outlet and date.
     *
     * A shift belongs to the business date it OPENED on, so a night shift that
     * runs past midnight stays on the evening a manager would look for it.
     *
     * @return list<array<string, mixed>>
     */
    private function shiftsOnDate(): array
    {
        [$where, $params] = $this->dayScope();

        $rows = Db::all(
            'SELECT s.session_id, s.status, s.opened_at, s.closed_at, s.opened_by, s.counted_cash, s.variance,
                    t.terminal_code, t.display_name AS terminal_name, t.location_id
             FROM pos_register_sessions s
             JOIN pos_terminals t ON t.terminal_id = s.terminal_id
             WHERE ' . $where . '
             ORDER BY s.opened_at DESC, s.session_id DESC LIMIT 60',
            $params,
        );

        $ordered = array_reverse($rows);
        $out = [];
        foreach ($ordered as $index => $row) {
            $out[] = [
                'session_id'    => (int) $row['session_id'],
                'label'         => 'Shift ' . ($index + 1),
                'status'        => (string) $row['status'],
                'terminal_code' => (string) $row['terminal_code'],
                'terminal_name' => (string) ($row['terminal_name'] ?? $row['terminal_code']),
                'opened_at'     => self::iso($row['opened_at']),
                'closed_at'     => self::iso($row['closed_at']),
                'reconciled'    => $row['status'] === 'CLOSED' && $row['counted_cash'] !== null,
            ];
        }

        return array_reverse($out);
    }

    /** @return array{0:string, 1:array<string, mixed>} */
    private function dayScope(): array
    {
        $where  = 's.cmp_id = :cmp AND s.opened_at >= :day_from AND s.opened_at < :day_to';
        $params = [
            'cmp'      => $this->ctx->cmpId,
            'day_from' => $this->dayStartsAt,
            'day_to'   => $this->dayEndsAt,
        ];

        if ($this->locationId !== null) {
            $where .= ' AND t.location_id = :day_loc';
            $params['day_loc'] = $this->locationId;
        }
        // A cashier sees their own shifts. Enforced in the query, not by leaving
        // a control off the screen.
        if (!$this->seesEveryone) {
            $where .= ' AND s.opened_by = :day_me';
            $params['day_me'] = $this->auth->uuid;
        }

        return [$where, $params];
    }

    // -----------------------------------------------------------------------
    // The shift itself
    // -----------------------------------------------------------------------

    /**
     * @param array<string, mixed> $cash
     * @return array<string, mixed>
     */
    private function shift(array $cash): array
    {
        $s = $this->session ?? [];

        $openedAt = self::iso($s['opened_at']);
        $closedAt = self::iso($s['closed_at']);
        $endedAt  = $closedAt ?? gmdate('c');
        $minutes  = (int) round((strtotime($endedAt) - (int) strtotime((string) $openedAt)) / 60);

        $counted    = $cash['counted'];
        $reconciled = $s['status'] === 'CLOSED' && $counted !== null;
        $variance   = $this->policy->classify($cash['variance']);

        return [
            'session_id'   => (int) $s['session_id'],
            'session_uuid' => (string) ($s['session_uuid'] ?? ''),
            'status'       => (string) $s['status'],
            'state'        => self::state((string) $s['status'], $reconciled, $variance),
            'state_label'  => self::stateLabel((string) $s['status'], $reconciled, $variance),
            'date'         => $this->date,
            'started_at'   => $openedAt,
            'ended_at'     => $closedAt,
            'duration_minutes' => max(0, $minutes),
            'reconciled'   => $reconciled,
            'reconciled_at' => $reconciled ? $closedAt : null,
            'variance_reason' => $s['variance_reason'] === null ? null : (string) $s['variance_reason'],
            'cashier'      => $this->person((string) $s['opened_by']),
            'closed_by'    => $s['closed_by'] === null ? null : $this->person((string) $s['closed_by']),
            'approved_by'  => $s['approved_by'] === null ? null : $this->person((string) $s['approved_by']),
            'terminal'     => [
                'terminal_id' => (int) $s['terminal_id'],
                'code'        => (string) $s['terminal_code'],
                'name'        => (string) ($s['terminal_name'] ?? $s['terminal_code']),
            ],
            'outlet'       => [
                'location_id' => (int) $s['location_id'],
                'code'        => (string) $s['location_code'],
                'name'        => (string) ($s['location_name'] ?? $s['location_code']),
            ],
            'notes'        => $s['notes'] === null ? null : (string) $s['notes'],
        ];
    }

    private static function state(string $status, bool $reconciled, string $variance): string
    {
        if ($status !== 'CLOSED') {
            return $status === 'CLOSING' ? 'closing' : 'open';
        }
        if (!$reconciled) {
            return 'closed';
        }

        return $variance === 'out_of_tolerance' ? 'variance' : 'reconciled';
    }

    private static function stateLabel(string $status, bool $reconciled, string $variance): string
    {
        return match (self::state($status, $reconciled, $variance)) {
            'open'       => 'Open',
            'closing'    => 'Closing',
            'closed'     => 'Closed, not counted',
            'variance'   => 'Variance found',
            default      => 'Reconciled',
        };
    }

    /**
     * A person, as far as POS can name them.
     *
     * POS stores the actor's uuid and nothing else — the name belongs to the
     * portal, and copying it here would be a stale name the day somebody
     * marries. The signed-in user is named because this request carries their
     * session; everyone else is their uuid, shortened, until a directory
     * lookup exists.
     *
     * @return array<string, mixed>
     */
    private function person(string $uuid): array
    {
        $isYou = $uuid === $this->auth->uuid;

        return [
            'uuid'     => $uuid,
            'label'    => $isYou ? $this->auth->displayName() : self::shortUuid($uuid),
            'is_you'   => $isYou,
            'resolved' => $isYou,
        ];
    }

    private static function shortUuid(string $uuid): string
    {
        return strlen($uuid) > 14 ? substr($uuid, 0, 8) . '…' : $uuid;
    }

    // -----------------------------------------------------------------------
    // Metrics and the comparison
    // -----------------------------------------------------------------------

    /** @return array<string, float|int> */
    private function metrics(int $sessionId): array
    {
        $sales = Db::first(
            "SELECT COUNT(*) FILTER (WHERE status = 'COMPLETED')                                  AS bills,
                    COALESCE(SUM(total_amount)    FILTER (WHERE status = 'COMPLETED'), 0)          AS net_sales,
                    COALESCE(SUM(discount_amount) FILTER (WHERE status = 'COMPLETED'), 0)          AS discounts,
                    COUNT(*) FILTER (WHERE status = 'VOID')                                        AS voids
             FROM pos_carts WHERE cmp_id = :cmp AND session_id = :sid",
            ['cmp' => $this->ctx->cmpId, 'sid' => $sessionId],
        ) ?? [];

        $refunds = (float) Db::scalar(
            "SELECT COALESCE(SUM(refund_amount), 0) FROM pos_returns
             WHERE cmp_id = :cmp AND session_id = :sid AND status <> 'CANCELLED'",
            ['cmp' => $this->ctx->cmpId, 'sid' => $sessionId],
        );

        $bills = (int) ($sales['bills'] ?? 0);
        $net   = round((float) ($sales['net_sales'] ?? 0), 4);
        $discount = round((float) ($sales['discounts'] ?? 0), 4);

        return [
            'bills'        => $bills,
            'net_sales'    => $net,
            // What the counter would have charged with no discount given. Stated
            // rather than implied, because "gross" means four different things.
            'gross_sales'  => round($net + $discount, 4),
            'average_bill' => $bills === 0 ? 0.0 : round($net / $bills, 2),
            'discounts'    => $discount,
            'refunds'      => round($refunds, 4),
            'voids'        => (int) ($sales['voids'] ?? 0),
        ];
    }

    /** @return array<string, float|int> */
    private static function zeroMetrics(): array
    {
        return [
            'bills' => 0, 'net_sales' => 0.0, 'gross_sales' => 0.0, 'average_bill' => 0.0,
            'discounts' => 0.0, 'refunds' => 0.0, 'voids' => 0,
        ];
    }

    /**
     * How this shift compares with the one before it on the same till.
     *
     * The previous shift, not the previous day: a manager reading a handover
     * wants to know whether this shift was busier than the one it took over
     * from. Where there is no previous shift, or where it took nothing, there is
     * no comparison — "up ∞%" is not a fact about a shop.
     *
     * @param array<string, float|int> $current
     * @return array<string, mixed>|null
     */
    private function comparison(array $current): ?array
    {
        $previous = Db::first(
            'SELECT session_id, opened_at FROM pos_register_sessions
             WHERE cmp_id = :cmp AND terminal_id = :terminal AND session_id < :sid
             ORDER BY session_id DESC LIMIT 1',
            [
                'cmp'      => $this->ctx->cmpId,
                'terminal' => (int) ($this->session['terminal_id'] ?? 0),
                'sid'      => (int) ($this->session['session_id'] ?? 0),
            ],
        );
        if ($previous === null) {
            return null;
        }

        $before = $this->metrics((int) $previous['session_id']);
        $deltas = [];
        foreach (['bills', 'net_sales', 'average_bill', 'discounts', 'refunds', 'voids'] as $key) {
            $deltas[$key . '_pct'] = self::changePc((float) $current[$key], (float) $before[$key]);
        }

        return [
            'label'      => 'vs. previous shift',
            'session_id' => (int) $previous['session_id'],
            'opened_at'  => self::iso($previous['opened_at']),
            'metrics'    => $before,
        ] + $deltas;
    }

    private static function changePc(float $now, float $before): ?float
    {
        if (abs($before) < 0.0001) {
            return null;
        }

        return round((($now - $before) / abs($before)) * 100, 1);
    }

    // -----------------------------------------------------------------------
    // Cash
    // -----------------------------------------------------------------------

    /**
     * The drawer, added up from this shift's own events.
     *
     *   expected = opening float + cash taken + pay-ins − refunds − payouts − drops
     *   variance = counted − expected            (negative is short)
     *
     * Recomputed here rather than read off the session row, and BOTH are
     * returned: the running total the till maintains as it goes, and the sum of
     * the events themselves. If they ever disagree that is a bug worth seeing
     * on the screen, not one to inherit silently.
     *
     * @return array<string, mixed>
     */
    private function cash(int $sessionId): array
    {
        $row = Db::first(
            "SELECT
                COALESCE(SUM(amount) FILTER (WHERE event_kind = 'opening_float'), 0) AS opening,
                COALESCE(SUM(amount) FILTER (WHERE event_kind = 'sale_tender'), 0)   AS cash_sales,
                COALESCE(SUM(amount) FILTER (WHERE event_kind = 'cash_in'), 0)       AS cash_in,
                COALESCE(SUM(amount) FILTER (WHERE event_kind = 'refund'), 0)        AS refunds,
                COALESCE(SUM(amount) FILTER (WHERE event_kind IN ('cash_out', 'petty_withdrawal')), 0) AS payouts,
                COALESCE(SUM(amount) FILTER (WHERE event_kind = 'safe_drop'), 0)     AS drops
             FROM pos_cash_drawer_events WHERE cmp_id = :cmp AND session_id = :sid",
            ['cmp' => $this->ctx->cmpId, 'sid' => $sessionId],
        ) ?? [];

        $opening   = round((float) ($row['opening'] ?? 0), 4);
        $cashSales = round((float) ($row['cash_sales'] ?? 0), 4);
        $cashIn    = round((float) ($row['cash_in'] ?? 0), 4);
        $refunds   = round((float) ($row['refunds'] ?? 0), 4);
        $payouts   = round((float) ($row['payouts'] ?? 0), 4);
        $drops     = round((float) ($row['drops'] ?? 0), 4);

        $expected = round($opening + $cashSales + $cashIn - $refunds - $payouts - $drops, 4);
        // Null, never zero. A drawer nobody has counted has no variance, and a
        // zero there would report every open till as balancing perfectly.
        $counted  = $this->session['counted_cash'] === null ? null : round((float) $this->session['counted_cash'], 4);
        $variance = $counted === null ? null : round($counted - $expected, 4);

        return [
            'opening'          => $opening,
            'cash_sales'       => $cashSales,
            'cash_in'          => $cashIn,
            'cash_refunds'     => $refunds,
            'cash_payouts'     => $payouts,
            'cash_drops'       => $drops,
            'expected'         => $expected,
            'running_expected' => round((float) $this->session['expected_cash'], 4),
            'counted'          => $counted,
            'variance'         => $variance,
            'variance_state'   => $this->policy->classify($variance),
            'tolerance'        => $this->policy->varianceTolerance,
            'formula'          => 'opening float + cash taken on sales + cash pay-ins − cash refunds − cash payouts − safe drops',
            'note'             => 'Card, UPI and on-account tenders never enter the drawer and are not in this sum. '
                . 'A split bill contributes only its cash portion.',
        ];
    }

    // -----------------------------------------------------------------------
    // Payment mix, hours, channels
    // -----------------------------------------------------------------------

    /**
     * How the shift was paid.
     *
     * Every tender mode the shift actually saw, whatever it is — there is no
     * fixed list of four here, and a shop that takes gift cards and store
     * credit sees both.
     *
     * @return list<array<string, mixed>>
     */
    private function paymentMix(int $sessionId): array
    {
        $rows = Db::all(
            "SELECT p.payment_mode, SUM(p.amount) AS amount, COUNT(*) AS count,
                    COALESCE(SUM(p.change_given), 0) AS change_given
             FROM pos_cart_payments p
             JOIN pos_carts c ON c.cart_id = p.cart_id
             WHERE c.cmp_id = :cmp AND c.session_id = :sid AND c.status = 'COMPLETED'
             GROUP BY p.payment_mode ORDER BY SUM(p.amount) DESC",
            ['cmp' => $this->ctx->cmpId, 'sid' => $sessionId],
        );

        $total = 0.0;
        foreach ($rows as $row) {
            $total += (float) $row['amount'];
        }

        return array_map(static function (array $row) use ($total): array {
            $described = Tenders::describe($row);
            $described['change_given'] = round((float) $row['change_given'], 4);
            $described['percentage'] = $total > 0 ? round(((float) $row['amount'] / $total) * 100, 1) : 0.0;

            return $described;
        }, $rows);
    }

    /**
     * Sales by the hour, in the outlet's own clock, from opening to close.
     *
     * Empty hours are filled in rather than dropped: a quiet 3pm is a fact
     * about the shift, and a chart that skips it draws a straight line through
     * the gap and tells the manager the opposite.
     *
     * @return list<array<string, mixed>>
     */
    private function hourlySales(int $sessionId): array
    {
        $carts = Db::all(
            "SELECT to_char(date_trunc('hour', created_at AT TIME ZONE :tz), 'YYYY-MM-DD\"T\"HH24:MI:SS') AS bucket,
                    COUNT(*) FILTER (WHERE status = 'COMPLETED')                                  AS orders,
                    COALESCE(SUM(total_amount)    FILTER (WHERE status = 'COMPLETED'), 0)          AS net_sales,
                    COALESCE(SUM(discount_amount) FILTER (WHERE status = 'COMPLETED'), 0)          AS discounts,
                    COUNT(*) FILTER (WHERE status = 'VOID')                                        AS voids
             FROM pos_carts WHERE cmp_id = :cmp AND session_id = :sid
             GROUP BY 1 ORDER BY 1",
            ['cmp' => $this->ctx->cmpId, 'sid' => $sessionId, 'tz' => $this->timezone],
        );

        $returns = Db::all(
            "SELECT to_char(date_trunc('hour', created_at AT TIME ZONE :tz), 'YYYY-MM-DD\"T\"HH24:MI:SS') AS bucket,
                    COALESCE(SUM(refund_amount), 0) AS refunds
             FROM pos_returns WHERE cmp_id = :cmp AND session_id = :sid AND status <> 'CANCELLED'
             GROUP BY 1 ORDER BY 1",
            ['cmp' => $this->ctx->cmpId, 'sid' => $sessionId, 'tz' => $this->timezone],
        );

        $byBucket = [];
        foreach ($carts as $row) {
            $orders = (int) $row['orders'];
            $net    = round((float) $row['net_sales'], 4);
            $byBucket[(string) $row['bucket']] = [
                'orders'       => $orders,
                'net_sales'    => $net,
                'discounts'    => round((float) $row['discounts'], 4),
                'gross_sales'  => round($net + (float) $row['discounts'], 4),
                'average_bill' => $orders === 0 ? 0.0 : round($net / $orders, 2),
                'voids'        => (int) $row['voids'],
                'refunds'      => 0.0,
            ];
        }
        foreach ($returns as $row) {
            $key = (string) $row['bucket'];
            $byBucket[$key] ??= [
                'orders' => 0, 'net_sales' => 0.0, 'discounts' => 0.0, 'gross_sales' => 0.0,
                'average_bill' => 0.0, 'voids' => 0, 'refunds' => 0.0,
            ];
            $byBucket[$key]['refunds'] = round((float) $row['refunds'], 4);
        }

        $out = [];
        foreach ($this->shiftHours() as $hour) {
            $out[] = ['time' => $hour, 'label' => self::hourLabel($hour)]
                + ($byBucket[$hour] ?? [
                    'orders' => 0, 'net_sales' => 0.0, 'discounts' => 0.0, 'gross_sales' => 0.0,
                    'average_bill' => 0.0, 'voids' => 0, 'refunds' => 0.0,
                ]);
            unset($byBucket[$hour]);
        }

        // Anything outside the opening hours — a sale attributed to the shift
        // after it closed, which should not happen and is worth seeing if it
        // does — is appended rather than dropped.
        foreach ($byBucket as $hour => $values) {
            $out[] = ['time' => $hour, 'label' => self::hourLabel((string) $hour)] + $values;
        }
        usort($out, static fn (array $a, array $b) => strcmp((string) $a['time'], (string) $b['time']));

        return $out;
    }

    /** @return list<string> Local hour keys from the shift's opening hour to its last. */
    private function shiftHours(): array
    {
        $zone  = new \DateTimeZone($this->timezone);
        $start = (new \DateTimeImmutable((string) $this->session['opened_at']))->setTimezone($zone);
        $endIso = $this->session['closed_at'] ?? null;
        $end   = ($endIso === null ? new \DateTimeImmutable('now') : new \DateTimeImmutable((string) $endIso))
            ->setTimezone($zone);

        if ($end < $start) {
            $end = $start;
        }

        $cursor = $start->setTime((int) $start->format('H'), 0);
        $last   = $end->setTime((int) $end->format('H'), 0);
        $hours  = [];

        // A shift longer than 24 hours is a till nobody closed; cap the axis
        // rather than drawing a thousand points nobody can read.
        for ($i = 0; $i <= 24 && $cursor <= $last; $i++) {
            $hours[] = $cursor->format('Y-m-d\TH:i:s');
            $cursor = $cursor->modify('+1 hour');
        }

        return $hours;
    }

    private static function hourLabel(string $bucket): string
    {
        $hour = (int) substr($bucket, 11, 2);
        $suffix = $hour < 12 ? 'AM' : 'PM';
        $display = $hour % 12 === 0 ? 12 : $hour % 12;

        return $display . $suffix;
    }

    /**
     * Where the orders came from.
     *
     * Whatever `order_kind` the outlet actually writes — dine-in, takeaway, a
     * QR order, an aggregator, a kiosk. Nothing here decides what a channel is;
     * the counter does, and this counts them.
     *
     * @return array<string, mixed>
     */
    private function channels(int $sessionId): array
    {
        $rows = Db::all(
            "SELECT order_kind, COUNT(*) AS orders, COALESCE(SUM(total_amount), 0) AS net
             FROM pos_carts WHERE cmp_id = :cmp AND session_id = :sid AND status = 'COMPLETED'
             GROUP BY order_kind ORDER BY COUNT(*) DESC, order_kind",
            ['cmp' => $this->ctx->cmpId, 'sid' => $sessionId],
        );

        $total = 0;
        foreach ($rows as $row) {
            $total += (int) $row['orders'];
        }

        return [
            'total_orders' => $total,
            'rows' => array_map(static function (array $row) use ($total): array {
                $orders = (int) $row['orders'];

                return [
                    'channel'    => (string) $row['order_kind'],
                    'label'      => self::channelLabel((string) $row['order_kind']),
                    'orders'     => $orders,
                    'net'        => round((float) $row['net'], 4),
                    'percentage' => $total > 0 ? round(($orders / $total) * 100, 1) : 0.0,
                ];
            }, $rows),
        ];
    }

    private static function channelLabel(string $kind): string
    {
        return match (strtolower(trim($kind))) {
            'retail', 'counter' => 'Counter',
            'dine_in'   => 'Dine-in',
            'takeaway'  => 'Takeaway',
            'delivery'  => 'Delivery',
            'pickup'    => 'Pickup',
            'qr_order'  => 'QR ordering',
            'kiosk'     => 'Kiosk',
            'aggregator' => 'Aggregator',
            'room_service' => 'Room service',
            'drive_through' => 'Drive-through',
            default     => ucwords(str_replace('_', ' ', strtolower(trim($kind)))),
        };
    }

    // -----------------------------------------------------------------------
    // Risk
    // -----------------------------------------------------------------------

    /**
     * What needed, or still needs, a manager.
     *
     * Six counts, each with what it means and what to do about it. The tone is
     * decided by the state of the thing rather than by the category: four
     * overrides that a manager approved are a record; one that nobody approved
     * is a question. A screen where everything is red is a screen nobody reads.
     *
     * @param array<string, mixed> $cash
     * @return array<string, mixed>
     */
    private function risk(int $sessionId, array $cash): array
    {
        $params = ['cmp' => $this->ctx->cmpId, 'sid' => $sessionId];

        $approvals = Db::first(
            "SELECT
                COUNT(*) FILTER (WHERE event_kind = 'no_sale')                                   AS no_sales,
                COUNT(*) FILTER (WHERE event_kind IN ('discount', 'price_override'))              AS overrides,
                COUNT(*) FILTER (WHERE event_kind IN ('discount', 'price_override') AND approved_by IS NULL) AS overrides_open,
                COUNT(*) FILTER (WHERE event_kind IN ('refund', 'return'))                        AS refund_requests,
                COUNT(*) FILTER (WHERE approved_by IS NULL)                                       AS pending
             FROM pos_approval_events WHERE cmp_id = :cmp AND session_id = :sid",
            $params,
        ) ?? [];

        $voids = (int) Db::scalar(
            "SELECT COUNT(*) FROM pos_carts WHERE cmp_id = :cmp AND session_id = :sid AND status = 'VOID'",
            $params,
        );
        $refundsOpen = (int) Db::scalar(
            "SELECT COUNT(*) FROM pos_returns
             WHERE cmp_id = :cmp AND session_id = :sid AND status IN ('DRAFT', 'APPROVED', 'RECEIVED')",
            $params,
        );
        $refundsAll = (int) Db::scalar(
            "SELECT COUNT(*) FROM pos_returns WHERE cmp_id = :cmp AND session_id = :sid AND status <> 'CANCELLED'",
            $params,
        );

        $noSales        = (int) ($approvals['no_sales'] ?? 0);
        $overrides      = (int) ($approvals['overrides'] ?? 0);
        $overridesOpen  = (int) ($approvals['overrides_open'] ?? 0);
        $pending        = (int) ($approvals['pending'] ?? 0);

        $suspicious = $this->suspicious($sessionId, $cash, $noSales, $pending);

        $tiles = [
            self::tile('voids', 'Voids', $voids, $voids > 0 ? 'warning' : 'success',
                $voids > 0 ? 'Needs review' : 'None this shift',
                'Bills cancelled before payment.'),
            self::tile('no_sale', 'No-sale drawer opens', $noSales,
                $this->policy->noSaleReviewThreshold > 0 && $noSales >= $this->policy->noSaleReviewThreshold
                    ? 'danger' : ($noSales > 0 ? 'warning' : 'success'),
                $this->policy->noSaleReviewThreshold > 0 && $noSales >= $this->policy->noSaleReviewThreshold
                    ? 'Above the review threshold' : ($noSales > 0 ? 'Needs review' : 'None this shift'),
                'The drawer opened with no sale behind it.'),
            self::tile('override', 'Price/discount overrides', $overrides,
                $overridesOpen > 0 ? 'danger' : ($overrides > 0 ? 'warning' : 'success'),
                $overridesOpen > 0 ? 'Needs approval' : ($overrides > 0 ? 'Approved' : 'None this shift'),
                'A price or a discount changed at the counter.'),
            self::tile('refund', 'Refund requests', $refundsAll,
                $refundsOpen > 0 ? 'warning' : ($refundsAll > 0 ? 'success' : 'success'),
                $refundsOpen > 0 ? 'Needs approval' : ($refundsAll > 0 ? 'Settled' : 'None this shift'),
                'Returns taken at the counter on this shift.'),
            self::tile('approval', 'Manager approvals pending', $pending,
                $pending > 0 ? 'danger' : 'success',
                $pending > 0 ? 'Action required' : 'Nothing waiting',
                'Events recorded with nobody signed against them.'),
            self::tile('suspicious', 'Suspicious activity', count($suspicious['items']),
                count($suspicious['items']) > 0 ? 'danger' : 'success',
                count($suspicious['items']) > 0 ? 'Investigate' : 'Nothing flagged',
                $suspicious['note']),
        ];

        return ['tiles' => $tiles, 'suspicious' => $suspicious];
    }

    /** @return array<string, mixed> */
    private static function tile(string $kind, string $label, int $count, string $tone, string $action, string $note): array
    {
        return [
            'kind' => $kind, 'label' => $label, 'count' => $count,
            'tone' => $tone, 'action_label' => $action, 'note' => $note,
        ];
    }

    /**
     * The rules, and which of them fired.
     *
     * RULE-BASED, and labelled as such. There is no model here and no learned
     * threshold; each item below is a stated rule about this shift's own rows,
     * and the screen shows the rule next to the finding so a manager can judge
     * it rather than trust it.
     *
     * @param array<string, mixed> $cash
     * @return array<string, mixed>
     */
    private function suspicious(int $sessionId, array $cash, int $noSales, int $pendingApprovals): array
    {
        $items = [];

        if ($cash['variance_state'] === 'out_of_tolerance') {
            $items[] = [
                'id'       => 'variance_out_of_tolerance',
                'title'    => 'The drawer is outside the tolerance this shop set',
                'detail'   => 'Counted ' . self::plain((float) $cash['counted']) . ' against ' . self::plain((float) $cash['expected'])
                    . '. The shop\'s tolerance is ' . self::plain($this->policy->varianceTolerance) . '.',
                'severity' => 'danger',
                'rule'     => 'abs(variance) > cash_variance_tolerance',
            ];
        }

        if ($this->policy->noSaleReviewThreshold > 0 && $noSales >= $this->policy->noSaleReviewThreshold) {
            $items[] = [
                'id'       => 'no_sale_burst',
                'title'    => $noSales . ' no-sale drawer opens on one shift',
                'detail'   => 'The shop asks for a look at ' . $this->policy->noSaleReviewThreshold . ' or more.',
                'severity' => 'danger',
                'rule'     => 'no_sale opens >= no_sale_review_threshold',
            ];
        }

        $unapprovedVoids = (int) Db::scalar(
            "SELECT COUNT(*) FROM pos_approval_events
             WHERE cmp_id = :cmp AND session_id = :sid AND event_kind IN ('void_cart', 'void_line') AND approved_by IS NULL",
            ['cmp' => $this->ctx->cmpId, 'sid' => $sessionId],
        );
        if ($unapprovedVoids > 0) {
            $items[] = [
                'id'       => 'unapproved_voids',
                'title'    => $unapprovedVoids . ' void' . ($unapprovedVoids === 1 ? '' : 's') . ' with nobody signed against them',
                'detail'   => 'A void that no manager approved is the one a fraud investigation starts from.',
                'severity' => 'danger',
                'rule'     => 'void events with approved_by IS NULL',
            ];
        }

        if ($pendingApprovals > 0 && $this->session['status'] === 'CLOSED') {
            $items[] = [
                'id'       => 'closed_with_pending_approvals',
                'title'    => 'The shift closed with ' . $pendingApprovals . ' approval'
                    . ($pendingApprovals === 1 ? '' : 's') . ' still unsigned',
                'detail'   => 'Nothing can be approved retrospectively at the till. A manager has to account for these.',
                'severity' => 'warning',
                'rule'     => 'approval events with approved_by IS NULL on a closed shift',
            ];
        }

        return [
            'items' => $items,
            'kind'  => 'rule',
            'note'  => 'Rule-based checks on this shift. No AI is configured in POS and nothing here is a prediction.',
        ];
    }

    // -----------------------------------------------------------------------
    // Denominations
    // -----------------------------------------------------------------------

    /**
     * The notes and coins the drawer was counted in.
     *
     * The sheet is the evidence behind "counted ₹32,400", and it is kept with
     * the count event that produced it. Where a shift has not been counted the
     * sheet is the shop's configured denominations with nothing against them —
     * which is exactly what the reconcile dialog opens with.
     *
     * WHAT IS DELIBERATELY ABSENT: an expected quantity per denomination. POS
     * knows what the drawer should HOLD; it cannot know which notes it should
     * hold it in, because nobody records the denomination of a ₹500 sale paid
     * with two ₹200s and a ₹100. The authoritative comparison is the shift
     * total, and that is where this screen puts it.
     *
     * @param array<string, mixed> $cash
     * @return array<string, mixed>
     */
    private function denominations(int $sessionId, array $cash): array
    {
        $count = Db::first(
            "SELECT event_id, amount, detail, actor_uuid, created_at
             FROM pos_cash_drawer_events
             WHERE cmp_id = :cmp AND session_id = :sid AND event_kind = 'closing_count'
             ORDER BY event_id DESC LIMIT 1",
            ['cmp' => $this->ctx->cmpId, 'sid' => $sessionId],
        );

        $sheet = [];
        if ($count !== null) {
            foreach (Db::jsonColumn($count['detail'] ?? null)['denominations'] ?? [] as $row) {
                if (!is_array($row) || !isset($row['denomination'])) {
                    continue;
                }
                $value = round((float) $row['denomination'], 4);
                $qty   = max(0, (int) ($row['quantity'] ?? 0));
                $sheet[(string) $value] = $qty;
            }
        }

        $rows = [];
        $countedTotal = 0.0;
        foreach ($this->policy->denominations as $value) {
            $qty = $sheet[(string) $value] ?? null;
            $amount = $qty === null ? null : round($value * $qty, 4);
            if ($amount !== null) {
                $countedTotal += $amount;
            }
            $rows[] = [
                'denomination' => $value,
                'label'        => self::denominationLabel($value),
                'quantity'     => $qty,
                'amount'       => $amount,
            ];
            unset($sheet[(string) $value]);
        }

        // A denomination that was counted but is no longer in the shop's list
        // still belongs on the sheet — the count happened.
        foreach ($sheet as $value => $qty) {
            $amount = round((float) $value * $qty, 4);
            $countedTotal += $amount;
            $rows[] = [
                'denomination' => (float) $value,
                'label'        => self::denominationLabel((float) $value),
                'quantity'     => $qty,
                'amount'       => $amount,
            ];
        }

        $hasSheet = $count !== null && $rows !== [] && array_filter($rows, static fn (array $r) => $r['quantity'] !== null) !== [];

        foreach ($rows as $index => $row) {
            $rows[$index]['share_pc'] = $hasSheet && $countedTotal > 0 && $row['amount'] !== null
                ? round(($row['amount'] / $countedTotal) * 100, 1)
                : null;
        }

        return [
            'rows'          => $rows,
            'has_sheet'     => $hasSheet,
            'counted_total' => $hasSheet ? round($countedTotal, 4) : null,
            // The count the shift closed on is authoritative even where no sheet
            // was kept, so the panel always has a figure to compare.
            'counted'       => $cash['counted'],
            'expected'      => $cash['expected'],
            'variance'      => $cash['variance'],
            'variance_state' => $cash['variance_state'],
            'counted_at'    => $count === null ? null : self::iso($count['created_at']),
            'counted_by'    => $count === null ? null : $this->person((string) $count['actor_uuid']),
            'note'          => 'POS records the notes and coins the drawer was counted in. It holds no expectation '
                . 'per denomination — what the drawer should hold in total is the figure beside this table.',
        ];
    }

    private static function denominationLabel(float $value): string
    {
        $whole = abs($value - round($value)) < 0.0001;

        return ($whole ? (string) (int) round($value) : rtrim(rtrim(number_format($value, 2, '.', ''), '0'), '.'));
    }

    // -----------------------------------------------------------------------
    // Events
    // -----------------------------------------------------------------------

    /**
     * The shift's trail, from the three tables that record one.
     *
     * Each fact comes from exactly ONE of them, which is the whole difficulty:
     * opening a drawer with no sale writes a drawer event, an approval event
     * and an audit row, and a trail that read all three would show it three
     * times. So the audit log supplies the shift's own open and close, the
     * drawer supplies cash movements, and approvals supply what a manager had
     * to allow.
     *
     * @return array<string, mixed>
     */
    public function events(int $sessionId, ?string $kind, int $limit, int $offset): array
    {
        $noise = implode(', ', self::NOISE_EVENTS);
        $params = [
            'cmp' => $this->ctx->cmpId,
            'sid' => $sessionId,
            'sid_text' => (string) $sessionId,
        ];

        $sql = "
            SELECT * FROM (
                SELECT 'drawer:' || e.event_id AS id, e.created_at, e.event_kind AS code,
                       e.amount, e.reason, e.actor_uuid, e.approved_by, NULL::bigint AS cart_id, 'drawer' AS origin
                FROM pos_cash_drawer_events e
                WHERE e.cmp_id = :cmp AND e.session_id = :sid AND e.event_kind NOT IN ({$noise})

                UNION ALL

                SELECT 'approval:' || a.approval_id, a.created_at, a.event_kind,
                       NULL::numeric, a.reason, a.requested_by, a.approved_by, a.cart_id, 'approval'
                FROM pos_approval_events a
                WHERE a.cmp_id = :cmp AND a.session_id = :sid AND a.event_kind NOT IN ('no_sale', 'drawer')

                UNION ALL

                SELECT 'audit:' || l.audit_id, l.created_at, l.action,
                       COALESCE(
                           (l.after_state ->> 'opening_float')::numeric,
                           (l.after_state ->> 'counted_cash')::numeric
                       ),
                       l.reason, l.actor_uuid, NULL::text, NULL::bigint, 'audit'
                FROM pos_audit_log l
                WHERE l.cmp_id = :cmp AND l.entity_type = 'register_session' AND l.entity_id = :sid_text
                  AND l.action IN ('shift.opened', 'shift.closed')
            ) AS trail
        ";

        if ($kind !== null && $kind !== '' && $kind !== 'all') {
            $codes = self::codesFor($kind);
            if ($codes === []) {
                return ['items' => [], 'total' => 0, 'kinds' => $this->eventKindCounts($sessionId)];
            }
            $placeholders = [];
            foreach ($codes as $i => $code) {
                $placeholders[] = ':code' . $i;
                $params['code' . $i] = $code;
            }
            $sql .= ' WHERE trail.code IN (' . implode(', ', $placeholders) . ')';
        }

        $total = (int) Db::scalar('SELECT COUNT(*) FROM (' . $sql . ') AS counted', $params);
        $rows = Db::all(
            $sql . ' ORDER BY trail.created_at ASC, trail.id ASC LIMIT ' . (int) $limit . ' OFFSET ' . (int) $offset,
            $params,
        );

        return [
            'items' => array_map(fn (array $row): array => $this->describeEvent($row), $rows),
            'total' => $total,
            'kinds' => $this->eventKindCounts($sessionId),
        ];
    }

    /** @return array<string, mixed> */
    private function describeEvent(array $row): array
    {
        $code   = (string) $row['code'];
        $origin = (string) $row['origin'];
        $amount = $row['amount'] === null ? null : round((float) $row['amount'], 4);

        [$title, $category, $severity] = self::classifyEvent($code, $origin);

        $detail = $row['reason'] === null || trim((string) $row['reason']) === ''
            ? null
            : trim((string) $row['reason']);

        return [
            'id'        => (string) $row['id'],
            'at'        => self::iso($row['created_at']),
            'code'      => $code,
            'category'  => $category,
            'title'     => $title,
            'detail'    => $detail,
            'amount'    => $amount,
            'severity'  => $severity,
            'actor'     => $this->person((string) $row['actor_uuid']),
            'approved_by' => $row['approved_by'] === null ? null : $this->person((string) $row['approved_by']),
            'cart_id'   => $row['cart_id'] === null ? null : (int) $row['cart_id'],
        ];
    }

    /** @return array{0:string, 1:string, 2:string} title, category, severity */
    private static function classifyEvent(string $code, string $origin): array
    {
        if ($origin === 'audit') {
            return $code === 'shift.opened'
                ? ['Shift opened', 'shift', 'normal']
                : ['Shift closed', 'shift', 'normal'];
        }

        // opening_float never reaches here — it is the shift opening, and the
        // audit row above is the one telling of it.


        if ($origin === 'drawer') {
            return match ($code) {
                'closing_count'    => ['Drawer counted at close', 'reconciliation', 'normal'],
                'no_sale_open'     => ['No-sale drawer open', 'drawer', 'review'],
                'cash_in'          => ['Cash paid in', 'drawer', 'normal'],
                'cash_out'         => ['Cash paid out', 'drawer', 'review'],
                'safe_drop'        => ['Safe drop', 'drawer', 'review'],
                'petty_withdrawal' => ['Petty withdrawal', 'drawer', 'review'],
                'refund'           => ['Refund paid from the drawer', 'refund', 'review'],
                default            => [self::titleCase($code), 'drawer', 'review'],
            };
        }

        return match ($code) {
            'discount'        => ['Discount override', 'discount', 'review'],
            'price_override'  => ['Price override', 'override', 'exception'],
            'void_line'       => ['Line voided', 'void', 'review'],
            'void_cart'       => ['Bill voided', 'void', 'exception'],
            'return'          => ['Return approved', 'refund', 'review'],
            'refund'          => ['Refund issued', 'refund', 'review'],
            'negative_stock'  => ['Sold past a stock warning', 'approval', 'exception'],
            'kot_cancel'      => ['Kitchen ticket cancelled', 'approval', 'review'],
            'reprint'         => ['Receipt reprinted', 'approval', 'review'],
            'shift_variance'  => ['Drawer variance approved', 'reconciliation', 'exception'],
            default           => [self::titleCase($code), 'approval', 'review'],
        };
    }

    /** @return list<string> */
    private static function codesFor(string $category): array
    {
        return match ($category) {
            'shift'   => ['shift.opened', 'shift.closed'],
            'drawer'  => ['no_sale_open', 'cash_in', 'cash_out', 'safe_drop', 'petty_withdrawal'],
            'discount' => ['discount'],
            'override' => ['price_override'],
            'void'     => ['void_line', 'void_cart'],
            'refund'   => ['refund', 'return'],
            'approval' => ['negative_stock', 'kot_cancel', 'reprint'],
            'reconciliation' => ['closing_count', 'shift_variance'],
            default    => [],
        };
    }

    /** @return list<array<string, mixed>> */
    private function eventKindCounts(int $sessionId): array
    {
        $noise = implode(', ', self::NOISE_EVENTS);
        $params = ['cmp' => $this->ctx->cmpId, 'sid' => $sessionId, 'sid_text' => (string) $sessionId];

        $rows = Db::all(
            "SELECT code, COUNT(*) AS total FROM (
                SELECT e.event_kind AS code FROM pos_cash_drawer_events e
                WHERE e.cmp_id = :cmp AND e.session_id = :sid AND e.event_kind NOT IN ({$noise})
                UNION ALL
                SELECT a.event_kind FROM pos_approval_events a
                WHERE a.cmp_id = :cmp AND a.session_id = :sid AND a.event_kind NOT IN ('no_sale', 'drawer')
                UNION ALL
                SELECT l.action FROM pos_audit_log l
                WHERE l.cmp_id = :cmp AND l.entity_type = 'register_session' AND l.entity_id = :sid_text
                  AND l.action IN ('shift.opened', 'shift.closed')
            ) AS trail GROUP BY code",
            $params,
        );

        $byCode = [];
        foreach ($rows as $row) {
            $byCode[(string) $row['code']] = (int) $row['total'];
        }

        return self::eventKinds($byCode);
    }

    /**
     * @param array<string, int> $byCode
     * @return list<array<string, mixed>>
     */
    private static function eventKinds(array $byCode): array
    {
        $kinds = [
            'all'      => 'All events',
            'shift'    => 'Shift',
            'drawer'   => 'Drawer',
            'discount' => 'Discount',
            'refund'   => 'Refund',
            'void'     => 'Void',
            'override' => 'Override',
            'approval' => 'Approval',
            'reconciliation' => 'Reconciliation',
        ];

        $out = [];
        $all = array_sum($byCode);
        foreach ($kinds as $key => $label) {
            $count = $key === 'all'
                ? $all
                : array_sum(array_map(static fn (string $c) => $byCode[$c] ?? 0, self::codesFor($key)));
            $out[] = ['key' => $key, 'label' => $label, 'count' => $count];
        }

        return $out;
    }

    // -----------------------------------------------------------------------
    // Risk drill-down
    // -----------------------------------------------------------------------

    /**
     * The rows behind one risk tile.
     *
     * Paged and fetched only when somebody opens the drawer for it — the whole
     * point of the tile is that a manager reads six numbers and looks at one.
     *
     * @return array<string, mixed>
     */
    public function riskDetail(int $sessionId, string $kind, int $limit, int $offset): array
    {
        $params = ['cmp' => $this->ctx->cmpId, 'sid' => $sessionId];

        if ($kind === 'voids') {
            $sql = "FROM pos_carts c WHERE c.cmp_id = :cmp AND c.session_id = :sid AND c.status = 'VOID'";
            $total = (int) Db::scalar('SELECT COUNT(*) ' . $sql, $params);
            $rows = Db::all(
                'SELECT c.cart_id, c.cart_uuid, c.total_amount, c.void_reason, c.voided_by, c.opened_by,
                        c.updated_at, c.order_kind ' . $sql . '
                 ORDER BY c.updated_at DESC LIMIT ' . (int) $limit . ' OFFSET ' . (int) $offset,
                $params,
            );

            return [
                'kind'  => $kind,
                'total' => $total,
                'rows'  => array_map(fn (array $r): array => [
                    'id'        => 'cart:' . (int) $r['cart_id'],
                    'at'        => self::iso($r['updated_at']),
                    'reference' => '#' . (int) $r['cart_id'],
                    'amount'    => round((float) $r['total_amount'], 4),
                    'actor'     => $this->person((string) ($r['voided_by'] ?? $r['opened_by'])),
                    'reason'    => $r['void_reason'] === null ? null : (string) $r['void_reason'],
                    'approved_by' => null,
                    'status'    => 'Voided',
                    'detail'    => self::channelLabel((string) $r['order_kind']),
                ], $rows),
            ];
        }

        if ($kind === 'refund') {
            $sql = "FROM pos_returns r WHERE r.cmp_id = :cmp AND r.session_id = :sid AND r.status <> 'CANCELLED'";
            $total = (int) Db::scalar('SELECT COUNT(*) ' . $sql, $params);
            $rows = Db::all(
                'SELECT r.return_id, r.return_no, r.refund_amount, r.status, r.resolution, r.reason_note,
                        r.created_by, r.approved_by, r.created_at ' . $sql . '
                 ORDER BY r.created_at DESC LIMIT ' . (int) $limit . ' OFFSET ' . (int) $offset,
                $params,
            );

            return [
                'kind'  => $kind,
                'total' => $total,
                'rows'  => array_map(fn (array $r): array => [
                    'id'        => 'return:' . (int) $r['return_id'],
                    'at'        => self::iso($r['created_at']),
                    'reference' => (string) $r['return_no'],
                    'amount'    => round((float) $r['refund_amount'], 4),
                    'actor'     => $this->person((string) $r['created_by']),
                    'reason'    => $r['reason_note'] === null ? null : (string) $r['reason_note'],
                    'approved_by' => $r['approved_by'] === null ? null : $this->person((string) $r['approved_by']),
                    'status'    => self::titleCase((string) $r['status']),
                    'detail'    => self::titleCase((string) $r['resolution']),
                ], $rows),
            ];
        }

        if ($kind === 'suspicious') {
            $cash = $this->cash($sessionId);
            $noSales = (int) Db::scalar(
                "SELECT COUNT(*) FROM pos_approval_events WHERE cmp_id = :cmp AND session_id = :sid AND event_kind = 'no_sale'",
                $params,
            );
            $pending = (int) Db::scalar(
                'SELECT COUNT(*) FROM pos_approval_events WHERE cmp_id = :cmp AND session_id = :sid AND approved_by IS NULL',
                $params,
            );
            $found = $this->suspicious($sessionId, $cash, $noSales, $pending);

            return [
                'kind'  => $kind,
                'total' => count($found['items']),
                'rows'  => array_map(static fn (array $item): array => [
                    'id'        => $item['id'],
                    'at'        => null,
                    'reference' => $item['title'],
                    'amount'    => null,
                    'actor'     => null,
                    'reason'    => $item['detail'],
                    'approved_by' => null,
                    'status'    => $item['severity'] === 'danger' ? 'Investigate' : 'Review',
                    'detail'    => $item['rule'],
                ], $found['items']),
                'note'  => $found['note'],
            ];
        }

        // Everything else is an approval event, narrowed by kind.
        $codes = match ($kind) {
            'no_sale'  => ['no_sale'],
            'override' => ['discount', 'price_override'],
            'approval' => [],
            default    => [],
        };

        $where = 'a.cmp_id = :cmp AND a.session_id = :sid';
        if ($codes !== []) {
            $placeholders = [];
            foreach ($codes as $i => $code) {
                $placeholders[] = ':k' . $i;
                $params['k' . $i] = $code;
            }
            $where .= ' AND a.event_kind IN (' . implode(', ', $placeholders) . ')';
        } elseif ($kind === 'approval') {
            $where .= ' AND a.approved_by IS NULL';
        }

        $sql = 'FROM pos_approval_events a WHERE ' . $where;
        $total = (int) Db::scalar('SELECT COUNT(*) ' . $sql, $params);
        $rows = Db::all(
            'SELECT a.approval_id, a.event_kind, a.requested_by, a.approved_by, a.reason, a.detail,
                    a.cart_id, a.created_at ' . $sql . '
             ORDER BY a.created_at DESC LIMIT ' . (int) $limit . ' OFFSET ' . (int) $offset,
            $params,
        );

        return [
            'kind'  => $kind,
            'total' => $total,
            'rows'  => array_map(function (array $r): array {
                $detail = Db::jsonColumn($r['detail'] ?? null);
                $amount = null;
                foreach (['amount', 'discount_amount', 'value'] as $key) {
                    if (isset($detail[$key]) && is_numeric($detail[$key])) {
                        $amount = round((float) $detail[$key], 4);
                        break;
                    }
                }

                return [
                    'id'        => 'approval:' . (int) $r['approval_id'],
                    'at'        => self::iso($r['created_at']),
                    'reference' => $r['cart_id'] === null ? '—' : '#' . (int) $r['cart_id'],
                    'amount'    => $amount,
                    'actor'     => $this->person((string) $r['requested_by']),
                    'reason'    => $r['reason'] === null ? null : (string) $r['reason'],
                    'approved_by' => $r['approved_by'] === null ? null : $this->person((string) $r['approved_by']),
                    'status'    => $r['approved_by'] === null ? 'Waiting on a manager' : 'Approved',
                    'detail'    => self::titleCase((string) $r['event_kind']),
                ];
            }, $rows),
        ];
    }

    // -----------------------------------------------------------------------
    // Policy
    // -----------------------------------------------------------------------

    /** @return array<string, mixed> */
    private function policyBlock(): array
    {
        return $this->policy->describe() + [
            'can_view'      => true,
            'can_reconcile' => Permissions::allows($this->ctx, $this->auth, 'shift.close'),
            'can_approve_variance' => Permissions::allows($this->ctx, $this->auth, 'shift.approve_variance'),
            'can_view_audit' => Permissions::allows($this->ctx, $this->auth, 'reports.view'),
            'sees_every_till' => $this->seesEveryone,
        ];
    }

    // -----------------------------------------------------------------------
    // Resolution helpers
    // -----------------------------------------------------------------------

    /** @return array<string, mixed>|null */
    private static function resolveSession(Context $ctx, Auth $auth, bool $seesEveryone): ?array
    {
        $select = 'SELECT s.*, t.terminal_code, t.display_name AS terminal_name, t.location_id,
                          l.location_code, l.display_name AS location_name
                   FROM pos_register_sessions s
                   JOIN pos_terminals t ON t.terminal_id = s.terminal_id
                   JOIN pos_location_profiles l ON l.location_id = t.location_id
                   WHERE s.cmp_id = :cmp';

        $requested = Http::intParam('session_id');
        if ($requested !== null && $requested > 0) {
            $row = Db::first($select . ' AND s.session_id = :sid', ['cmp' => $ctx->cmpId, 'sid' => $requested]);
            if ($row === null) {
                Http::notFound('That shift does not exist in this company.');
            }
            if (!$seesEveryone && (string) $row['opened_by'] !== $auth->uuid) {
                Http::forbidden('That shift belongs to another cashier. Ask a manager for the outlet view.');
            }

            return self::hydrate($row);
        }

        // No shift named: the outlet's business date decides, and an open till
        // wins over a closed one because somebody is standing at it.
        $locationId = self::resolveLocation($ctx, null);
        [$timezone, $dayStart] = Window::outletCalendar($ctx, $locationId);
        $date = self::requestedDate($timezone, $dayStart);

        $where  = ' AND s.opened_at >= :day_from AND s.opened_at < :day_to';
        $params = [
            'cmp'      => $ctx->cmpId,
            'day_from' => Window::instantAt($date, $timezone, $dayStart),
            'day_to'   => Window::instantAt(Window::plusDays($date, 1), $timezone, $dayStart),
        ];
        if ($locationId !== null) {
            $where .= ' AND t.location_id = :loc';
            $params['loc'] = $locationId;
        }
        if (Http::intParam('terminal_id') !== null) {
            $where .= ' AND s.terminal_id = :term';
            $params['term'] = Http::intParam('terminal_id');
        }
        if (!$seesEveryone) {
            $where .= ' AND s.opened_by = :me';
            $params['me'] = $auth->uuid;
        }

        $row = Db::first(
            $select . $where . " ORDER BY (s.status IN ('OPEN', 'CLOSING')) DESC, s.opened_at DESC, s.session_id DESC LIMIT 1",
            $params,
        );

        return $row === null ? null : self::hydrate($row);
    }

    /** @param array<string, mixed> $row */
    private static function hydrate(array $row): array
    {
        $row['session_id']    = (int) $row['session_id'];
        $row['terminal_id']   = (int) $row['terminal_id'];
        $row['location_id']   = (int) $row['location_id'];
        $row['opening_float'] = (float) $row['opening_float'];
        $row['expected_cash'] = (float) $row['expected_cash'];
        $row['counted_cash']  = $row['counted_cash'] === null ? null : (float) $row['counted_cash'];
        $row['variance']      = $row['variance'] === null ? null : (float) $row['variance'];

        return $row;
    }

    /** @param array<string, mixed>|null $session */
    private static function resolveLocation(Context $ctx, ?array $session): ?int
    {
        if ($session !== null) {
            return (int) $session['location_id'];
        }

        $raw = Http::intParam('location_id');
        if ($raw === null || $raw <= 0) {
            return null;
        }

        $exists = Db::scalar(
            'SELECT location_id FROM pos_location_profiles WHERE location_id = :id AND cmp_id = :cmp',
            ['id' => $raw, 'cmp' => $ctx->cmpId],
        );
        if ($exists === null || $exists === false) {
            Http::notFound('That outlet does not exist in this company.');
        }

        return (int) $exists;
    }

    private static function requestedDate(string $timezone, int $dayStartMinutes): string
    {
        $raw = Http::param('date');
        if ($raw === null || trim($raw) === '') {
            return Window::businessTodayIn($timezone, $dayStartMinutes);
        }
        $raw = trim($raw);
        if (preg_match('/^\d{4}-\d{2}-\d{2}$/', $raw) !== 1) {
            Http::validationFailed('A date looks like 2026-05-26.', ['field' => 'date', 'value' => $raw]);
        }
        [$y, $m, $d] = array_map('intval', explode('-', $raw));
        if (!checkdate($m, $d, $y)) {
            Http::validationFailed('That date does not exist.', ['field' => 'date', 'value' => $raw]);
        }

        return $raw;
    }

    private static function businessDateOf(string $instant, string $timezone, int $dayStartMinutes): string
    {
        $local = (new \DateTimeImmutable($instant))->setTimezone(new \DateTimeZone($timezone));
        $minutes = ((int) $local->format('H')) * 60 + (int) $local->format('i');

        return $minutes < $dayStartMinutes
            ? $local->modify('-1 day')->format('Y-m-d')
            : $local->format('Y-m-d');
    }

    private static function iso(mixed $value): ?string
    {
        if ($value === null || $value === '') {
            return null;
        }

        try {
            return (new \DateTimeImmutable((string) $value))
                ->setTimezone(new \DateTimeZone('UTC'))
                ->format('Y-m-d\TH:i:s\Z');
        } catch (\Throwable) {
            return (string) $value;
        }
    }

    private static function plain(float $value): string
    {
        return number_format($value, 2, '.', ',');
    }

    private static function titleCase(string $value): string
    {
        return ucfirst(str_replace(['_', '.'], ' ', strtolower(trim($value))));
    }
}
