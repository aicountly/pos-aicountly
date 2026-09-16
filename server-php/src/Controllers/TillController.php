<?php

declare(strict_types=1);

namespace Aicountly\Api\Controllers;

use Aicountly\Api\Domain\CartService;
use Aicountly\Api\Domain\CheckoutService;
use Aicountly\Api\Domain\RegisterService;
use Aicountly\Api\Http;
use Aicountly\Api\Permissions;

/**
 * The till — shifts, the drawer, and the sale in front of the cashier.
 */
final class TillController extends Controller
{
    // -----------------------------------------------------------------------
    // Shifts
    // -----------------------------------------------------------------------

    public static function openShift(): void
    {
        [$auth, $ctx] = self::enter();
        Http::data((new RegisterService($ctx, $auth))->open(Http::body()), 201);
    }

    public static function closeShift(string $id): void
    {
        [$auth, $ctx] = self::enter();
        Http::data((new RegisterService($ctx, $auth))->close((int) $id, Http::body()));
    }

    public static function shift(string $id): void
    {
        [$auth, $ctx] = self::enter();
        $session = (new RegisterService($ctx, $auth))->find((int) $id);
        if ($session === []) {
            Http::notFound('That shift does not exist.');
        }
        Http::data($session);
    }

    public static function shifts(): void
    {
        [$auth, $ctx] = self::enter();
        $params = Http::listParams(['opened_at', 'closed_at'], 'opened_at');
        [$rows, $total] = (new RegisterService($ctx, $auth))->listSessions([
            'terminal_id' => Http::intParam('terminal_id'),
            'status'      => Http::param('status'),
        ], $params['limit'], $params['offset']);

        Http::list($rows, $total, $params['limit'], $params['offset']);
    }

    /** The shift open on a till right now — what a cashier's screen asks for first. */
    public static function currentShift(): void
    {
        [$auth, $ctx] = self::enter();
        $terminalId = Http::intParam('terminal_id');
        if ($terminalId === null) {
            Http::validationFailed('Which till?', ['field' => 'terminal_id']);
        }

        Http::data(['session' => (new RegisterService($ctx, $auth))->currentForTerminal($terminalId)]);
    }

    public static function drawerEvent(string $id): void
    {
        [$auth, $ctx] = self::enter();
        Http::data((new RegisterService($ctx, $auth))->drawerEvent((int) $id, Http::body()), 201);
    }

    public static function shiftReport(string $id): void
    {
        [$auth, $ctx] = self::enter();
        Http::data((new RegisterService($ctx, $auth))->report((int) $id));
    }

    // -----------------------------------------------------------------------
    // Carts
    // -----------------------------------------------------------------------

    public static function openCart(): void
    {
        [$auth, $ctx] = self::enter();
        Http::data((new CartService($ctx, $auth))->open(Http::body()), 201);
    }

    public static function carts(): void
    {
        [$auth, $ctx] = self::enter();
        $params = Http::listParams(['created_at', 'total_amount'], 'created_at');
        [$rows, $total] = (new CartService($ctx, $auth))->listCarts([
            'status'           => Http::param('status'),
            'terminal_id'      => Http::intParam('terminal_id'),
            'session_id'       => Http::intParam('session_id'),
            'table_session_id' => Http::intParam('table_session_id'),
            'search'           => $params['q'],
        ], $params['limit'], $params['offset']);

        Http::list($rows, $total, $params['limit'], $params['offset']);
    }

    public static function cart(string $id): void
    {
        [$auth, $ctx] = self::enter();
        $cart = (new CartService($ctx, $auth))->find((int) $id);
        if ($cart === []) {
            Http::notFound('That sale does not exist.');
        }
        Http::data($cart);
    }

    public static function addLine(string $id): void
    {
        [$auth, $ctx] = self::enter();
        Http::data((new CartService($ctx, $auth))->addLine((int) $id, Http::body()), 201);
    }

    public static function updateLine(string $id, string $lineId): void
    {
        [$auth, $ctx] = self::enter();
        Http::data((new CartService($ctx, $auth))->updateLine((int) $id, (int) $lineId, Http::body()));
    }

    public static function removeLine(string $id, string $lineId): void
    {
        [$auth, $ctx] = self::enter();
        Http::data((new CartService($ctx, $auth))->removeLine((int) $id, (int) $lineId, Http::body()));
    }

    public static function charges(string $id): void
    {
        [$auth, $ctx] = self::enter();
        Http::data((new CartService($ctx, $auth))->applyCharges((int) $id, Http::body()));
    }

    public static function hold(string $id): void
    {
        [$auth, $ctx] = self::enter();
        Http::data((new CartService($ctx, $auth))->hold((int) $id, Http::body()));
    }

    public static function resume(string $id): void
    {
        [$auth, $ctx] = self::enter();
        Http::data((new CartService($ctx, $auth))->resume((int) $id));
    }

    public static function void(string $id): void
    {
        [$auth, $ctx] = self::enter();
        Http::data((new CartService($ctx, $auth))->void((int) $id, Http::body()));
    }

    public static function stockCheck(string $id): void
    {
        [$auth, $ctx] = self::enter();
        Http::data((new CartService($ctx, $auth))->stockCheck((int) $id));
    }

    // -----------------------------------------------------------------------
    // Checkout
    // -----------------------------------------------------------------------

    public static function checkout(string $id): void
    {
        [$auth, $ctx] = self::enter();
        Http::data((new CheckoutService($ctx, $auth))->checkout((int) $id, Http::body()));
    }

    public static function retry(string $id): void
    {
        [$auth, $ctx] = self::enter();
        Http::data((new CheckoutService($ctx, $auth))->retry((int) $id));
    }

    // -----------------------------------------------------------------------
    // Offline
    // -----------------------------------------------------------------------

    /**
     * A till uploading what it sold while it was cut off.
     *
     * Always 200, never 201: the answer is per-sale, and a batch where two
     * sales posted and one conflicted is not a single status code.
     */
    public static function submitOffline(): void
    {
        [$auth, $ctx] = self::enter();
        Http::data((new CheckoutService($ctx, $auth))->submitOffline(Http::body()));
    }

    public static function offlineQueue(): void
    {
        [$auth, $ctx] = self::enter();
        Permissions::assert($ctx, $auth, 'reports.view');

        $params = Http::listParams(['received_at'], 'received_at');
        [$rows, $total] = (new CheckoutService($ctx, $auth))->offlineQueue([
            'status'      => Http::param('status'),
            'terminal_id' => Http::intParam('terminal_id'),
        ], $params['limit'], $params['offset']);

        Http::list($rows, $total, $params['limit'], $params['offset']);
    }

    public static function retryOffline(string $id): void
    {
        [$auth, $ctx] = self::enter();
        Http::data((new CheckoutService($ctx, $auth))->retryOffline((int) $id));
    }

    public static function abandonOffline(string $id): void
    {
        [$auth, $ctx] = self::enter();
        Http::data((new CheckoutService($ctx, $auth))->abandonOffline((int) $id, Http::body()));
    }
}
