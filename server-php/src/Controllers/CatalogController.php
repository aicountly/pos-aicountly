<?php

declare(strict_types=1);

namespace Aicountly\Api\Controllers;

use Aicountly\Api\Clients\BooksClient;
use Aicountly\Api\Clients\InventoryClient;
use Aicountly\Api\Http;

/**
 * Read-through to the products that own the data.
 *
 * These exist so the browser makes ONE same-origin call instead of several
 * cross-origin ones, and so the session key never has to be handed to another
 * origin. They are pass-throughs in the strictest sense: NOTHING they return is
 * written to this database.
 *
 * That is worth stating plainly because a read-through cache would be the
 * easiest thing in the world to add here, and the first step back towards the
 * synchronised copies this architecture exists to avoid. The barcode lookup is
 * the tempting one — it is on the hot path of every scan — and it is still a
 * live call, because a price that is one sync behind is a price the customer
 * argues about at the counter.
 *
 * The DEVICE may cache these for offline selling. That cache is in the
 * browser, is explicitly non-authoritative, and is thrown away and refetched.
 * It is not this server's business and never lands in these tables.
 */
final class CatalogController extends Controller
{
    public static function items(): void
    {
        [$auth, $ctx] = self::enter();
        self::relay((new InventoryClient())->withSession($auth->sesKey())->items($ctx, [
            'q'        => Http::param('q'),
            'group_id' => Http::intParam('group_id'),
            'limit'    => Http::intParam('limit', 50),
            'offset'   => Http::intParam('offset', 0),
        ]));
    }

    public static function searchItems(): void
    {
        [$auth, $ctx] = self::enter();
        $term = Http::param('q', '') ?? '';
        if (trim($term) === '') {
            Http::data([]);
        }

        self::relay((new InventoryClient())->withSession($auth->sesKey())->searchItems($ctx, $term, Http::intParam('limit', 20) ?? 20));
    }

    /**
     * The scan.
     *
     * The single most used endpoint in the product, and deliberately still a
     * live call to Inventory.
     */
    public static function barcode(): void
    {
        [$auth, $ctx] = self::enter();
        $code = Http::param('code', '') ?? '';
        if (trim($code) === '') {
            Http::validationFailed('Scan or type a barcode.', ['field' => 'code']);
        }

        $response = (new InventoryClient())->withSession($auth->sesKey())->itemByBarcode($ctx, $code);
        if ($response['status'] === 404) {
            Http::notFound('Nothing in the catalogue has that barcode.');
        }

        self::relay($response);
    }

    public static function item(string $id): void
    {
        [$auth, $ctx] = self::enter();
        self::relay((new InventoryClient())->withSession($auth->sesKey())->item($ctx, (int) $id));
    }

    public static function availability(): void
    {
        [$auth, $ctx] = self::enter();
        $itemId = Http::intParam('item_id');
        if ($itemId === null) {
            Http::validationFailed('Which item?', ['field' => 'item_id']);
        }

        self::relay((new InventoryClient())->withSession($auth->sesKey())->availability(
            $ctx, $itemId, Http::intParam('warehouse_id'), Http::intParam('batch_id'),
        ));
    }

    public static function warehouses(): void
    {
        [$auth, $ctx] = self::enter();
        self::relay((new InventoryClient())->withSession($auth->sesKey())->warehouses($ctx));
    }

    public static function batches(string $id): void
    {
        [$auth, $ctx] = self::enter();
        self::relay((new InventoryClient())->withSession($auth->sesKey())->batches($ctx, (int) $id));
    }

    public static function customers(): void
    {
        [$auth, $ctx] = self::enter();
        self::relay((new BooksClient())->withSession($auth->sesKey())->accounts($ctx, [
            'q'       => Http::param('q'),
            'nature'  => 'sundry_debtor',
            'limit'   => Http::intParam('limit', 25),
        ]));
    }

    public static function taxCategories(): void
    {
        [$auth, $ctx] = self::enter();
        self::relay((new BooksClient())->withSession($auth->sesKey())->taxCategories($ctx));
    }

    public static function paymentAccounts(): void
    {
        [$auth, $ctx] = self::enter();
        self::relay((new BooksClient())->withSession($auth->sesKey())->accounts($ctx, [
            'nature' => 'cash_bank',
            'limit'  => 100,
        ]));
    }

    /**
     * Hand the other product's answer straight to the browser.
     *
     * An unreachable product is reported as unreachable — never as an empty
     * list, which a screen cannot tell apart from "there are none" and which
     * would have a cashier believe the catalogue was empty.
     *
     * @param array<string, mixed> $response
     */
    private static function relay(array $response): void
    {
        if (!$response['ok']) {
            Http::error(
                $response['status'] >= 400 && $response['status'] < 500 ? $response['status'] : 502,
                'upstream_unavailable',
                (string) ($response['error'] ?? 'That information could not be fetched right now.'),
                ['retryable' => true],
            );
        }

        $body = $response['body'] ?? [];
        Http::json(200, is_array($body) ? $body : ['data' => $body]);
    }
}
