<?php

declare(strict_types=1);

namespace Aicountly\Api\Domain;

use Aicountly\Api\Context;
use Aicountly\Api\Db;

/**
 * Document numbers for the documents POS owns.
 *
 * POS owns exactly two numbered things: the kitchen ticket and the counter
 * return. It does NOT number the sale. A retail sale becomes a tax invoice, a
 * tax invoice number is a statutory series, and that series lives in Books —
 * there can only be one of it, and it cannot be minted on a till that may be
 * offline and out of touch with the other tills in the shop.
 *
 * A till that is offline therefore has NO invoice number to show. It shows the
 * token number it minted itself, prints a "sale receipt" rather than a tax
 * invoice, and the real invoice number arrives when the sale reaches Books.
 * The alternative — letting each till guess at the series — produces duplicate
 * invoice numbers, which is a notice from the tax department, not a bug report.
 */
final class NumberSeries
{
    /**
     * Next number for a document kind: return | kot | reservation.
     *
     * Allocated inside the caller's transaction with the row locked, so two
     * tills pressing the same button in the same second get consecutive
     * numbers rather than the same one. MAX(number)+1 without the lock would
     * hand both of them the same one.
     */
    public static function next(Context $ctx, string $kind): string
    {
        [$table, $column, $prefixColumn, $default, $scoped] = match ($kind) {
            'return' => ['pos_returns', 'return_no', 'return_prefix', 'POSRET', true],
            'kot'    => ['pos_kots', 'kot_no', 'kot_prefix', 'KOT', true],
            // A booking is POS' own and nobody has asked to rename it, so it has
            // no settings column to read. A null prefix column means the default
            // stands rather than that the lookup is skipped by accident.
            'reservation' => ['pos_table_reservations', 'reservation_no', null, 'RSV', true],
            default  => throw new \InvalidArgumentException('Unknown document kind ' . $kind),
        };

        $prefix = $prefixColumn === null ? $default : (string) (Db::scalar(
            'SELECT ' . Db::quoteIdentifier($prefixColumn) . ' FROM pos_settings WHERE cmp_id = :cmp',
            ['cmp' => $ctx->cmpId],
        ) ?? $default);

        $stem = sprintf('%s/%d/', $prefix, $ctx->fyId);

        $params = ['cmp' => $ctx->cmpId, 'stem' => $stem . '%'];
        $where = 'cmp_id = :cmp';
        if ($scoped) {
            $where .= ' AND fy_id = :fy';
            $params['fy'] = $ctx->fyId;
        }

        $highest = Db::scalar(
            'SELECT ' . Db::quoteIdentifier($column) . '
             FROM ' . Db::quoteIdentifier($table) . '
             WHERE ' . $where . ' AND ' . Db::quoteIdentifier($column) . ' LIKE :stem
             ORDER BY length(' . Db::quoteIdentifier($column) . ') DESC, ' . Db::quoteIdentifier($column) . ' DESC
             LIMIT 1
             FOR UPDATE',
            $params,
        );

        $sequence = 1;
        if (is_string($highest) && preg_match('/(\d+)$/', $highest, $m) === 1) {
            $sequence = (int) $m[1] + 1;
        }

        return $stem . str_pad((string) $sequence, 4, '0', STR_PAD_LEFT);
    }

    /**
     * The token a customer is called by while they wait.
     *
     * Deliberately NOT a document number: it resets daily, it is per terminal,
     * and it is meaningless the next morning. A queue-buzzer number is not a
     * record.
     */
    public static function nextToken(Context $ctx, int $terminalId): string
    {
        $today = gmdate('Y-m-d');

        $highest = Db::scalar(
            "SELECT token_no FROM pos_carts
             WHERE cmp_id = :cmp AND terminal_id = :terminal
               AND token_no IS NOT NULL AND token_no ~ '^[0-9]+$'
               AND created_at >= :today::date
             ORDER BY token_no::int DESC LIMIT 1
             FOR UPDATE",
            ['cmp' => $ctx->cmpId, 'terminal' => $terminalId, 'today' => $today],
        );

        return (string) (((int) ($highest ?? 0)) + 1);
    }
}
