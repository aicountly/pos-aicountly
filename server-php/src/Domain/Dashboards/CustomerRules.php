<?php

declare(strict_types=1);

namespace Aicountly\Api\Domain\Dashboards;

/**
 * What "loyal", "slipping away" and "inactive" mean — in one place.
 *
 * These thresholds used to be written as `INTERVAL '60 days'` inside four
 * separate queries on the customers board. That is how two panels on the same
 * screen start disagreeing: someone tunes the segment query, misses the
 * suggestion query, and the shop is told 713 customers are at risk directly
 * above a segment that counts 680. The numbers are here, the SQL fragments that
 * express them are here, and every caller asks this class.
 *
 * They are also returned to the browser on the board payload, so the front end
 * renders "60+ days" from the server's definition rather than carrying a second
 * copy of the number that can drift out of step with it.
 *
 * WHERE THESE SHOULD EVENTUALLY LIVE. Per-company configuration, next to the
 * other POS settings — a pharmacy's idea of "lapsed" is not a fine-dining
 * restaurant's. Until that setting exists these are the product's defaults and
 * the board says which numbers it used.
 */
final class CustomerRules
{
    /** No bill in this many days and a customer counts as lapsed. */
    public const INACTIVE_DAYS = 60;

    /** Bills on this POS before a customer counts as a regular. */
    public const LOYAL_MIN_VISITS = 3;

    /** More than one bill in the window is what "repeat" means here. */
    public const REPEAT_MIN_VISITS = 2;

    /** `last_at >= NOW() - INTERVAL '60 days'` — the recent side of the line. */
    public static function recentSql(string $column = 'last_at'): string
    {
        return $column . " >= NOW() - INTERVAL '" . self::INACTIVE_DAYS . " days'";
    }

    /** `last_at < NOW() - INTERVAL '60 days'` — the lapsed side of it. */
    public static function lapsedSql(string $column = 'last_at'): string
    {
        return $column . " < NOW() - INTERVAL '" . self::INACTIVE_DAYS . " days'";
    }

    /** A regular: enough bills, and still coming in. */
    public static function loyalSql(string $visits = 'visits', string $lastAt = 'last_at'): string
    {
        return $visits . ' >= ' . self::LOYAL_MIN_VISITS . ' AND ' . self::recentSql($lastAt);
    }

    /** Slipping away: bought more than once, then stopped. */
    public static function atRiskSql(string $visits = 'visits', string $lastAt = 'last_at'): string
    {
        return $visits . ' >= ' . self::REPEAT_MIN_VISITS . ' AND ' . self::lapsedSql($lastAt);
    }

    /**
     * One customer's standing, from their POS history alone.
     *
     * Deliberately the same ladder the segment query counts with, in the same
     * order, so a customer the table calls "Slipping away" is inside the
     * "Slipping away" segment total on the panel above it.
     *
     * NEW IS THE LAST RUNG, NOT THE FIRST. It used to be checked before
     * everything else, which looked right until the window was widened: over a
     * year, every customer's first bill falls inside it, so a customer with
     * twelve visits and one who had lapsed for two hundred days were both
     * labelled "New" and the column said nothing at all. Standing is a fact
     * about the customer and outranks the window. "New" now only refines the
     * bottom rung — someone whose single bill ever happens to be in this
     * period — which is exactly the claim it can support.
     *
     * @param bool $isNew their first bill on this POS fell inside the window
     * @return 'new'|'loyal'|'at_risk'|'regular'|'one_time'
     */
    public static function classify(int $visits, ?string $lastAt, bool $isNew): string
    {
        $lapsed = $lastAt !== null && strtotime($lastAt) < strtotime('-' . self::INACTIVE_DAYS . ' days');

        if ($visits >= self::LOYAL_MIN_VISITS && !$lapsed) {
            return 'loyal';
        }
        if ($visits >= self::REPEAT_MIN_VISITS && $lapsed) {
            return 'at_risk';
        }
        if ($visits >= self::REPEAT_MIN_VISITS) {
            return 'regular';
        }

        return $isNew ? 'new' : 'one_time';
    }

    /**
     * What the board tells the browser about its own thresholds.
     *
     * @return array<string, mixed>
     */
    public static function describe(): array
    {
        return [
            'inactive_days'     => self::INACTIVE_DAYS,
            'loyal_min_visits'  => self::LOYAL_MIN_VISITS,
            'repeat_min_visits' => self::REPEAT_MIN_VISITS,
            'note'              => 'A customer is counted as lapsed after ' . self::INACTIVE_DAYS
                . ' days without a bill on this POS, and as a regular from '
                . self::LOYAL_MIN_VISITS . ' bills. These are product defaults, not a per-shop setting yet.',
        ];
    }

    /**
     * A mobile number, safe to put on a dashboard.
     *
     * The last four digits are enough for a manager to recognise the customer
     * they are looking at; the whole number is a marketing list, and this board
     * is not where one gets exported from. The full number stays on the till,
     * where looking it up is a logged action against one customer.
     */
    public static function maskMobile(?string $raw): ?string
    {
        if ($raw === null) {
            return null;
        }

        $trimmed = trim($raw);
        if ($trimmed === '') {
            return null;
        }

        $digits = preg_replace('/\D+/', '', $trimmed) ?? '';
        if ($digits === '') {
            return null;
        }
        // Too short to mask meaningfully — showing four of five digits hides
        // nothing, so nothing is shown.
        if (strlen($digits) <= 4) {
            return str_repeat('•', strlen($digits));
        }

        return str_repeat('•', strlen($digits) - 4) . substr($digits, -4);
    }
}
