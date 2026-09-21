<?php

declare(strict_types=1);

namespace Aicountly\Api\Controllers;

use Aicountly\Api\Domain\ReturnService;
use Aicountly\Api\Http;
use Aicountly\Api\Permissions;

final class ReturnsController extends Controller
{
    /**
     * The filters the register and its analytics share.
     *
     * Read once, in one place, and handed to both — the table and the numbers
     * above it must never be looking at different rows.
     *
     * @return array<string, mixed>
     */
    private static function filters(string $search = ''): array
    {
        return [
            'from'        => Http::param('from'),
            'to'          => Http::param('to'),
            'status'      => Http::param('status'),
            'resolution'  => Http::param('resolution'),
            'channel'     => Http::param('channel'),
            'reason_code' => Http::param('reason_code'),
            'terminal_id' => Http::intParam('terminal_id'),
            'session_id'  => Http::intParam('session_id'),
            'cart_id'     => Http::intParam('cart_id'),
            'min_amount'  => Http::param('min_amount'),
            'max_amount'  => Http::param('max_amount'),
            'search'      => $search,
        ];
    }

    public static function index(): void
    {
        [$auth, $ctx] = self::enter();
        Permissions::assert($ctx, $auth, 'return.create');

        $params = Http::listParams(['return_date', 'refund_amount', 'created_at', 'return_no', 'status'], 'return_date');
        [$rows, $total] = (new ReturnService($ctx, $auth))->listReturns(
            self::filters($params['q']),
            $params['limit'],
            $params['offset'],
            $params['sort'],
            $params['order'],
        );

        Http::list($rows, $total, $params['limit'], $params['offset']);
    }

    /**
     * The numbers on the returns workspace.
     *
     * Separate from the register because they answer a different question over
     * the same rows, and because a page that summed a 50-row page to draw a
     * month's KPIs would be wrong from the fifty-first return onwards.
     */
    public static function summary(): void
    {
        [$auth, $ctx] = self::enter();
        Permissions::assert($ctx, $auth, 'return.create');

        Http::data((new ReturnService($ctx, $auth))->summary(self::filters(trim((string) Http::param('q', '')))));
    }

    /**
     * What a given sale still has coming back.
     *
     * The new-return flow asks this before it offers a quantity, so the cashier
     * is refused at the till rather than at submit — and so the number the
     * screen shows is the same one create() will enforce.
     */
    public static function eligibility(): void
    {
        [$auth, $ctx] = self::enter();

        $cartId = Http::intParam('cart_id');
        if ($cartId === null || $cartId <= 0) {
            Http::validationFailed('Which sale is coming back?', ['field' => 'cart_id']);
        }

        Http::data((new ReturnService($ctx, $auth))->eligibility($cartId));
    }

    public static function show(string $id): void
    {
        [$auth, $ctx] = self::enter();
        Permissions::assert($ctx, $auth, 'return.create');

        $return = (new ReturnService($ctx, $auth))->find((int) $id);
        if ($return === []) {
            Http::notFound('That return does not exist.');
        }
        Http::data($return);
    }

    public static function create(): void
    {
        [$auth, $ctx] = self::enter();
        Http::data((new ReturnService($ctx, $auth))->create(Http::body()), 201);
    }

    public static function approve(string $id): void
    {
        [$auth, $ctx] = self::enter();
        Http::data((new ReturnService($ctx, $auth))->approve((int) $id, Http::body()));
    }

    public static function receive(string $id): void
    {
        [$auth, $ctx] = self::enter();
        Http::data((new ReturnService($ctx, $auth))->receive((int) $id));
    }

    public static function settle(string $id): void
    {
        [$auth, $ctx] = self::enter();
        Http::data((new ReturnService($ctx, $auth))->settle((int) $id));
    }
}
