<?php

declare(strict_types=1);

namespace Aicountly\Api\Domain\Shift;

use Aicountly\Api\Db;

/**
 * The shop's own judgement about its drawer, read rather than assumed.
 *
 * Three numbers decide how the Shift Report reads: how far a drawer may be out
 * before anyone should act on it, how many no-sale opens in one shift is worth
 * a question, and which notes and coins this shop counts in. All three are
 * settings, because all three differ per shop and a constant in a stylesheet is
 * a policy nobody agreed to.
 *
 * The defaults are deliberately strict-and-silent: tolerance 0 reports every
 * difference, and the denomination list is the Indian one because that is the
 * currency every outlet in the product trades in today. A shop that trades in
 * another sets its own; nothing here assumes INR beyond that default.
 */
final class ShiftPolicy
{
    /** @var list<float> */
    private const FALLBACK_DENOMINATIONS = [500, 200, 100, 50, 20, 10, 5, 2, 1];

    private function __construct(
        public readonly float $varianceTolerance,
        public readonly int $noSaleReviewThreshold,
        /** @var list<float> Largest first. */
        public readonly array $denominations,
        public readonly bool $requiresReasonOnVariance,
    ) {
    }

    public static function forCompany(int $cmpId): self
    {
        $row = Db::first(
            'SELECT cash_variance_tolerance, no_sale_review_threshold, cash_denominations
             FROM pos_settings WHERE cmp_id = :cmp',
            ['cmp' => $cmpId],
        ) ?? [];

        $values = [];
        foreach (Db::jsonColumn($row['cash_denominations'] ?? null) as $value) {
            if (is_numeric($value) && (float) $value > 0) {
                $values[] = round((float) $value, 4);
            }
        }
        if ($values === []) {
            $values = self::FALLBACK_DENOMINATIONS;
        }
        $values = array_values(array_unique($values));
        rsort($values);

        return new self(
            max(0.0, round((float) ($row['cash_variance_tolerance'] ?? 0), 4)),
            max(0, (int) ($row['no_sale_review_threshold'] ?? 5)),
            $values,
            // A variance always needs saying-why: RegisterService refuses a close
            // without one, so the dialog must ask for one.
            true,
        );
    }

    /**
     * How a variance reads.
     *
     * Exactly zero balances. Inside the tolerance it is a difference the shop
     * has already said it can live with, and it is reported rather than hidden.
     * Outside it, somebody has to do something.
     */
    public function classify(?float $variance): string
    {
        if ($variance === null) {
            return 'uncounted';
        }
        if (abs($variance) <= 0.0001) {
            return 'balanced';
        }

        return abs($variance) <= $this->varianceTolerance ? 'within_tolerance' : 'out_of_tolerance';
    }

    /** @return array<string, mixed> */
    public function describe(): array
    {
        return [
            'variance_tolerance'          => $this->varianceTolerance,
            'no_sale_review_threshold'    => $this->noSaleReviewThreshold,
            'denominations'               => $this->denominations,
            'requires_reason_on_variance' => $this->requiresReasonOnVariance,
        ];
    }
}
