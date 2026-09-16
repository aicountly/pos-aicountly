<?php

declare(strict_types=1);

namespace Aicountly\Api\Domain\Dashboards;

/**
 * What a tender line actually proves.
 *
 * This is the smallest class in the product and the one most likely to be
 * misread, so it says the uncomfortable thing plainly:
 *
 * **NOTHING IN THIS PRODUCT IS PROVIDER-CONFIRMED.** There is no payment
 * gateway integration. Aicountly Pay does not exist yet, and no external
 * acquirer is wired in. A card or UPI row in `pos_cart_payments` means a
 * cashier looked at a separate terminal, saw an approval on it, and typed the
 * reference. That is a *recorded* tender, not a confirmed collection, and the
 * two must never be added together under one total on a reconciliation screen.
 *
 * Cash is different, and only cash: the money is in the drawer, the drawer is
 * counted at close, and the variance is the evidence. So cash is `collected`
 * and everything else is `recorded`.
 *
 * When a provider integration does land, it adds states to the right of this
 * list (`confirmed`, `failed`, `unknown`, `refunded`) and the screens already
 * have a column for them. What it must not do is quietly promote `recorded` to
 * `confirmed` because a reference exists.
 */
final class Tenders
{
    /** The drawer holds it and the count proves it. */
    public const COLLECTED = 'collected';

    /** A cashier recorded it from an external terminal. No provider confirmed it here. */
    public const RECORDED = 'recorded';

    public static function state(string $paymentMode): string
    {
        return strtolower(trim($paymentMode)) === 'cash' ? self::COLLECTED : self::RECORDED;
    }

    public static function label(string $state): string
    {
        return $state === self::COLLECTED
            ? 'In the drawer'
            : 'Recorded at the counter';
    }

    public static function evidence(string $state): string
    {
        return $state === self::COLLECTED
            ? 'Cash counted at shift close is the evidence.'
            : 'Typed from an external terminal slip. No payment provider integration exists in POS, so this is not a confirmed collection.';
    }

    public static function displayName(string $paymentMode): string
    {
        return match (strtolower(trim($paymentMode))) {
            'cash'            => 'Cash',
            'card'            => 'Card',
            'upi'             => 'UPI',
            'bank'            => 'Bank transfer',
            'customer_credit' => 'On account',
            'gift_card'       => 'Gift card',
            default           => ucfirst(str_replace('_', ' ', strtolower(trim($paymentMode)))),
        };
    }

    /**
     * One row of the tender mix, with its state spelled out.
     *
     * @param array<string, mixed> $row
     * @return array<string, mixed>
     */
    public static function describe(array $row): array
    {
        $mode  = (string) ($row['payment_mode'] ?? 'other');
        $state = self::state($mode);

        return [
            'payment_mode'     => $mode,
            'display_name'     => self::displayName($mode),
            'amount'           => (float) ($row['amount'] ?? 0),
            'count'            => (int) ($row['count'] ?? 0),
            'settlement_state' => $state,
            'settlement_label' => self::label($state),
            'evidence'         => self::evidence($state),
        ];
    }
}
