<?php

declare(strict_types=1);

namespace Aicountly\Api\Domain\Dashboards;

use Aicountly\Api\Auth;
use Aicountly\Api\Context;
use Aicountly\Api\Db;
use Aicountly\Api\Http;
use Aicountly\Api\Permissions;

/**
 * The filter every dashboard shares: which outlet, which dates, which till.
 *
 * Two things here are easy to get wrong and expensive to get wrong.
 *
 * THE BUSINESS DATE IS NOT UTC MIDNIGHT. A bar that closes at 2am takes money
 * on Friday night that lands on Saturday in UTC. The outlet's timezone and its
 * day-start offset decide which business date a sale belongs to, and both come
 * from the outlet row rather than from the server's clock. Every window this
 * class builds is therefore expressed as a half-open interval of *instants*,
 * computed from the outlet's own day boundary, and the SQL compares
 * `created_at >= from AND created_at < to`. Never `::date`, which silently
 * means "UTC date" and would move a night shift's takings to the wrong day.
 *
 * THE SCOPE IS NOT A SUGGESTION. `cmp_id` and `fy_id` come from Context, which
 * has already checked them against Manage. The outlet and till ids arriving on
 * the query string are claims: they are resolved against this company's own
 * rows here, and an id belonging to someone else is a 404 rather than a query
 * that quietly returns nothing.
 */
final class Window
{
    private const MAX_SPAN_DAYS = 400;

    private function __construct(
        public readonly Context $ctx,
        public readonly Auth $auth,
        /** Inclusive business date, YYYY-MM-DD, in the outlet's own calendar. */
        public readonly string $from,
        /** Inclusive business date, YYYY-MM-DD. */
        public readonly string $to,
        /** Half-open instant bounds, UTC, derived from the outlet day boundary. */
        public readonly string $startsAt,
        public readonly string $endsAt,
        /** The comparison window, or null when none was asked for. */
        public readonly ?string $compareStartsAt,
        public readonly ?string $compareEndsAt,
        public readonly ?string $compareLabel,
        public readonly ?int $locationId,
        public readonly ?int $terminalId,
        public readonly ?int $sessionId,
        public readonly string $timezone,
        public readonly int $dayStartMinutes,
        /** True when the caller may see every till rather than only their own. */
        public readonly bool $seesEveryone,
    ) {
    }

    public static function fromRequest(Context $ctx, Auth $auth): self
    {
        $locationId = self::resolveLocation($ctx);
        [$timezone, $dayStart] = self::outletCalendar($ctx, $locationId);

        $today = self::businessToday($timezone, $dayStart);
        $from  = self::date(Http::param('from'), $today);
        $to    = self::date(Http::param('to'), $from);

        if (strcmp($to, $from) < 0) {
            [$from, $to] = [$to, $from];
        }
        if (self::spanDays($from, $to) > self::MAX_SPAN_DAYS) {
            Http::validationFailed(
                'That date range is longer than a year. Narrow it, or run the report in Books.',
                ['field' => 'to', 'max_days' => self::MAX_SPAN_DAYS],
            );
        }

        $startsAt = self::instant($from, $timezone, $dayStart);
        $endsAt   = self::instant(self::addDays($to, 1), $timezone, $dayStart);

        [$compareStart, $compareEnd, $compareLabel] = self::comparison($from, $to, $timezone, $dayStart);

        $terminalId = self::resolveTerminal($ctx, $locationId);
        $sessionId  = self::resolveSession($ctx);

        return new self(
            $ctx,
            $auth,
            $from,
            $to,
            $startsAt,
            $endsAt,
            $compareStart,
            $compareEnd,
            $compareLabel,
            $locationId,
            $terminalId,
            $sessionId,
            $timezone,
            $dayStart,
            Permissions::allows($ctx, $auth, 'reports.view'),
        );
    }

    /**
     * The WHERE fragment and bindings for a table that carries cmp/fy/bo.
     *
     * @param string $alias    table alias, or '' for none
     * @param bool   $windowed add the business-date bounds on `created_at`
     * @return array{0:string, 1:array<string, mixed>}
     */
    public function clause(string $alias = '', bool $windowed = true, string $dateColumn = 'created_at'): array
    {
        [$sql, $params] = $this->ctx->scopeClause($alias);
        $prefix = $alias === '' ? '' : $alias . '.';

        if ($windowed) {
            $sql .= " AND {$prefix}{$dateColumn} >= :win_from AND {$prefix}{$dateColumn} < :win_to";
            $params['win_from'] = $this->startsAt;
            $params['win_to']   = $this->endsAt;
        }

        return [$sql, $params];
    }

    /**
     * The same fragment against the comparison window.
     *
     * @return array{0:string, 1:array<string, mixed>}|null
     */
    public function comparisonClause(string $alias = '', string $dateColumn = 'created_at'): ?array
    {
        if ($this->compareStartsAt === null || $this->compareEndsAt === null) {
            return null;
        }

        [$sql, $params] = $this->ctx->scopeClause($alias);
        $prefix = $alias === '' ? '' : $alias . '.';
        $sql .= " AND {$prefix}{$dateColumn} >= :cmp_from AND {$prefix}{$dateColumn} < :cmp_to";
        $params['cmp_from'] = $this->compareStartsAt;
        $params['cmp_to']   = $this->compareEndsAt;

        return [$sql, $params];
    }

    /**
     * Narrow to one outlet, one till, one shift — whichever the caller asked for.
     *
     * Carts carry `terminal_id`, and a terminal belongs to an outlet, so the
     * outlet filter is expressed through the terminal rather than duplicated
     * onto the cart.
     *
     * @param array<string, mixed> $params
     * @return array{0:string, 1:array<string, mixed>}
     */
    public function narrow(string $sql, array $params, string $alias = 'c'): array
    {
        $prefix = $alias === '' ? '' : $alias . '.';

        if ($this->locationId !== null) {
            $sql .= " AND {$prefix}terminal_id IN (SELECT terminal_id FROM pos_terminals WHERE cmp_id = :nar_cmp AND location_id = :nar_loc)";
            $params['nar_cmp'] = $this->ctx->cmpId;
            $params['nar_loc'] = $this->locationId;
        }
        if ($this->terminalId !== null) {
            $sql .= " AND {$prefix}terminal_id = :nar_term";
            $params['nar_term'] = $this->terminalId;
        }
        if ($this->sessionId !== null) {
            $sql .= " AND {$prefix}session_id = :nar_sess";
            $params['nar_sess'] = $this->sessionId;
        }

        return [$sql, $params];
    }

    /** Terminal ids in scope, for panels that start from the till rather than the sale. */
    public function terminalScope(string $alias = 't'): array
    {
        $prefix = $alias === '' ? '' : $alias . '.';
        $sql = "{$prefix}cmp_id = :ctx_cmp_id";
        $params = ['ctx_cmp_id' => $this->ctx->cmpId];

        if ($this->locationId !== null) {
            $sql .= " AND {$prefix}location_id = :nar_loc";
            $params['nar_loc'] = $this->locationId;
        }
        if ($this->terminalId !== null) {
            $sql .= " AND {$prefix}terminal_id = :nar_term";
            $params['nar_term'] = $this->terminalId;
        }

        return [$sql, $params];
    }

    /** What the screen shows under "showing". */
    public function describe(): array
    {
        return [
            'from'             => $this->from,
            'to'               => $this->to,
            'starts_at'        => $this->startsAt,
            'ends_at'          => $this->endsAt,
            'timezone'         => $this->timezone,
            'day_start_minutes' => $this->dayStartMinutes,
            'location_id'      => $this->locationId,
            'terminal_id'      => $this->terminalId,
            'session_id'       => $this->sessionId,
            'comparison'       => $this->compareStartsAt === null ? null : [
                'label'     => $this->compareLabel,
                'starts_at' => $this->compareStartsAt,
                'ends_at'   => $this->compareEndsAt,
            ],
            'generated_at'     => gmdate('c'),
            'scope_note'       => $this->seesEveryone
                ? 'Every till in scope.'
                : 'Only the tills you are signed on to. Ask a manager for the outlet view.',
        ];
    }

    // -----------------------------------------------------------------------
    // Resolution
    // -----------------------------------------------------------------------

    private static function resolveLocation(Context $ctx): ?int
    {
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

    private static function resolveTerminal(Context $ctx, ?int $locationId): ?int
    {
        $raw = Http::intParam('terminal_id');
        if ($raw === null || $raw <= 0) {
            return null;
        }

        $row = Db::first(
            'SELECT terminal_id, location_id FROM pos_terminals WHERE terminal_id = :id AND cmp_id = :cmp',
            ['id' => $raw, 'cmp' => $ctx->cmpId],
        );
        if ($row === null) {
            Http::notFound('That till does not exist in this company.');
        }
        if ($locationId !== null && (int) $row['location_id'] !== $locationId) {
            Http::validationFailed('That till is not in the outlet you chose.', ['field' => 'terminal_id']);
        }

        return (int) $row['terminal_id'];
    }

    private static function resolveSession(Context $ctx): ?int
    {
        $raw = Http::intParam('session_id');
        if ($raw === null || $raw <= 0) {
            return null;
        }

        $exists = Db::scalar(
            'SELECT session_id FROM pos_register_sessions WHERE session_id = :id AND cmp_id = :cmp',
            ['id' => $raw, 'cmp' => $ctx->cmpId],
        );
        if ($exists === null || $exists === false) {
            Http::notFound('That shift does not exist in this company.');
        }

        return (int) $exists;
    }

    /**
     * The outlet's timezone and the minute its business day starts.
     *
     * With no outlet chosen the company's outlets may disagree, so the safe
     * answer is UTC midnight and the screen says which it used.
     *
     * @return array{0:string, 1:int}
     */
    private static function outletCalendar(Context $ctx, ?int $locationId): array
    {
        if ($locationId === null) {
            return ['UTC', 0];
        }

        $row = Db::first(
            'SELECT trading_timezone AS timezone, day_start_minutes FROM pos_location_profiles WHERE location_id = :id AND cmp_id = :cmp',
            ['id' => $locationId, 'cmp' => $ctx->cmpId],
        ) ?? [];

        $tz = is_string($row['timezone'] ?? null) && $row['timezone'] !== '' ? $row['timezone'] : 'UTC';
        if (!in_array($tz, \DateTimeZone::listIdentifiers(), true)) {
            $tz = 'UTC';
        }

        $dayStart = (int) ($row['day_start_minutes'] ?? 0);

        return [$tz, max(0, min(23 * 60 + 59, $dayStart))];
    }

    /** Today, in the outlet's own calendar, allowing for a day that starts at 6am. */
    private static function businessToday(string $timezone, int $dayStartMinutes): string
    {
        $now = new \DateTimeImmutable('now', new \DateTimeZone($timezone));
        $minutes = ((int) $now->format('H')) * 60 + (int) $now->format('i');

        return $minutes < $dayStartMinutes
            ? $now->modify('-1 day')->format('Y-m-d')
            : $now->format('Y-m-d');
    }

    /** The UTC instant a business date begins at. */
    private static function instant(string $date, string $timezone, int $dayStartMinutes): string
    {
        $local = new \DateTimeImmutable($date . ' 00:00:00', new \DateTimeZone($timezone));

        return $local->modify('+' . $dayStartMinutes . ' minutes')
            ->setTimezone(new \DateTimeZone('UTC'))
            ->format('Y-m-d H:i:s');
    }

    /**
     * The comparison window.
     *
     * `compare=previous` is the same number of days immediately before, and
     * `compare=same_weekday` is the same span one week earlier — the only two a
     * shop actually reasons with. Anything else, including nothing, compares
     * against nothing and the screen shows no comparison rather than an
     * invented one.
     *
     * @return array{0:?string, 1:?string, 2:?string}
     */
    private static function comparison(string $from, string $to, string $timezone, int $dayStart): array
    {
        $mode = strtolower(trim((string) (Http::param('compare') ?? '')));
        if ($mode === '' || $mode === 'none') {
            return [null, null, null];
        }

        $days = self::spanDays($from, $to);

        if ($mode === 'same_weekday' || $mode === 'last_week') {
            $start = self::addDays($from, -7);
            $end   = self::addDays($to, -7);
            $label = $days === 1 ? 'vs the same day last week' : 'vs the same days last week';
        } elseif ($mode === 'previous') {
            $start = self::addDays($from, -$days);
            $end   = self::addDays($to, -$days);
            $label = $days === 1 ? 'vs the day before' : 'vs the previous ' . $days . ' days';
        } else {
            return [null, null, null];
        }

        return [
            self::instant($start, $timezone, $dayStart),
            self::instant(self::addDays($end, 1), $timezone, $dayStart),
            $label,
        ];
    }

    private static function date(?string $raw, string $fallback): string
    {
        if ($raw === null || trim($raw) === '') {
            return $fallback;
        }
        $raw = trim($raw);
        if (preg_match('/^\d{4}-\d{2}-\d{2}$/', $raw) !== 1) {
            Http::validationFailed('A date looks like 2026-03-31.', ['field' => 'from', 'value' => $raw]);
        }
        [$y, $m, $d] = array_map('intval', explode('-', $raw));
        if (!checkdate($m, $d, $y)) {
            Http::validationFailed('That date does not exist.', ['field' => 'from', 'value' => $raw]);
        }

        return $raw;
    }

    private static function addDays(string $date, int $days): string
    {
        return (new \DateTimeImmutable($date, new \DateTimeZone('UTC')))
            ->modify(($days >= 0 ? '+' : '') . $days . ' days')
            ->format('Y-m-d');
    }

    /** Inclusive span: 2026-03-01..2026-03-01 is one day. */
    private static function spanDays(string $from, string $to): int
    {
        $a = new \DateTimeImmutable($from, new \DateTimeZone('UTC'));
        $b = new \DateTimeImmutable($to, new \DateTimeZone('UTC'));

        return (int) $a->diff($b)->days + 1;
    }
}
