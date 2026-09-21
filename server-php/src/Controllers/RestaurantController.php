<?php

declare(strict_types=1);

namespace Aicountly\Api\Controllers;

use Aicountly\Api\Domain\KotService;
use Aicountly\Api\Domain\MenuService;
use Aicountly\Api\Domain\TableService;
use Aicountly\Api\Http;

/**
 * Floors, tables, tickets and the menu.
 *
 * All POS-owned. Nothing in here calls another product except the live item
 * check when a menu item is pointed at an Inventory item.
 */
final class RestaurantController extends Controller
{
    // -----------------------------------------------------------------------
    // Tables
    // -----------------------------------------------------------------------

    public static function floorPlan(): void
    {
        [$auth, $ctx] = self::enter();
        Http::data(['floors' => (new TableService($ctx, $auth))->floorPlan(Http::intParam('location_id'))]);
    }

    public static function openTable(string $id): void
    {
        [$auth, $ctx] = self::enter();
        Http::data((new TableService($ctx, $auth))->open((int) $id, Http::body()), 201);
    }

    public static function tableSession(string $id): void
    {
        [$auth, $ctx] = self::enter();
        $session = (new TableService($ctx, $auth))->find((int) $id);
        if ($session === []) {
            Http::notFound('That table session does not exist.');
        }
        Http::data($session);
    }

    public static function transferTable(string $id): void
    {
        [$auth, $ctx] = self::enter();
        Http::data((new TableService($ctx, $auth))->transfer((int) $id, Http::body()));
    }

    public static function mergeTable(string $id): void
    {
        [$auth, $ctx] = self::enter();
        Http::data((new TableService($ctx, $auth))->merge((int) $id, Http::body()));
    }

    public static function splitTable(string $id): void
    {
        [$auth, $ctx] = self::enter();
        Http::data((new TableService($ctx, $auth))->split((int) $id, Http::body()), 201);
    }

    public static function closeTable(string $id): void
    {
        [$auth, $ctx] = self::enter();
        Http::data((new TableService($ctx, $auth))->close((int) $id));
    }

    /**
     * Cleaning, out of service, or ready again.
     *
     * A POST rather than a PUT on the table: this records that somebody decided
     * something about the table just now, and the audit entry is the point.
     */
    public static function tableServiceState(string $id): void
    {
        [$auth, $ctx] = self::enter();
        Http::data((new TableService($ctx, $auth))->setServiceState((int) $id, Http::body()));
    }

    // -----------------------------------------------------------------------
    // Bookings
    // -----------------------------------------------------------------------

    public static function reservations(): void
    {
        [$auth, $ctx] = self::enter();
        Http::data(['reservations' => (new TableService($ctx, $auth))->reservations([
            'table_id' => Http::intParam('table_id'),
            'floor_id' => Http::intParam('floor_id'),
            'status'   => Http::param('status'),
        ])]);
    }

    public static function createReservation(): void
    {
        [$auth, $ctx] = self::enter();
        Http::data((new TableService($ctx, $auth))->createReservation(Http::body()), 201);
    }

    public static function cancelReservation(string $id): void
    {
        [$auth, $ctx] = self::enter();
        Http::data((new TableService($ctx, $auth))->cancelReservation((int) $id, Http::body()));
    }

    public static function seatReservation(string $id): void
    {
        [$auth, $ctx] = self::enter();
        Http::data((new TableService($ctx, $auth))->seatReservation((int) $id, Http::body()), 201);
    }

    // -----------------------------------------------------------------------
    // Kitchen tickets
    // -----------------------------------------------------------------------

    public static function fireKot(string $id): void
    {
        [$auth, $ctx] = self::enter();
        Http::data(['kots' => (new KotService($ctx, $auth))->fire((int) $id, Http::body())], 201);
    }

    public static function kot(string $id): void
    {
        [$auth, $ctx] = self::enter();
        $kot = (new KotService($ctx, $auth))->find((int) $id);
        if ($kot === []) {
            Http::notFound('That ticket does not exist.');
        }
        Http::data($kot);
    }

    public static function amendKot(string $id): void
    {
        [$auth, $ctx] = self::enter();
        Http::data((new KotService($ctx, $auth))->amend((int) $id, Http::body()), 201);
    }

    public static function advanceKot(string $id): void
    {
        [$auth, $ctx] = self::enter();
        Http::data((new KotService($ctx, $auth))->advance((int) $id, Http::body()));
    }

    public static function cancelKot(string $id): void
    {
        [$auth, $ctx] = self::enter();
        Http::data((new KotService($ctx, $auth))->cancel((int) $id, Http::body()));
    }

    /**
     * Everything one kitchen screen needs, in one round trip.
     *
     * `kots` is unchanged and remains the live queue. What is added beside it
     * is what a kitchen display cannot work without and should not have to ask
     * three more times for: the tickets just served (so the pass can check
     * what went out), what each station is carrying, and today's prep
     * performance — all counted by PostgreSQL, none of it derived in a
     * browser.
     */
    public static function kitchenDisplay(): void
    {
        [$auth, $ctx] = self::enter();

        $service = new KotService($ctx, $auth);
        $stationId = Http::intParam('station_id');
        $filters = ['location_id' => Http::intParam('location_id')];

        Http::data([
            'kots'     => $service->display($stationId, $filters),
            'served'   => $service->servedRecently($stationId, $filters, Http::intParam('served_limit', 10) ?? 10),
            'stations' => $service->stationLoad($filters),
            'metrics'  => $service->metrics($stationId, $filters),
        ]);
    }

    // -----------------------------------------------------------------------
    // Menu
    // -----------------------------------------------------------------------

    public static function menu(): void
    {
        [$auth, $ctx] = self::enter();
        Http::data((new MenuService($ctx, $auth))->present([
            'location_id' => Http::intParam('location_id'),
            'channel'     => Http::param('channel'),
            'search'      => Http::param('q'),
        ]));
    }

    public static function menuItem(string $id): void
    {
        [$auth, $ctx] = self::enter();
        $item = (new MenuService($ctx, $auth))->findItem((int) $id);
        if ($item === []) {
            Http::notFound('That menu item does not exist.');
        }
        Http::data($item);
    }

    public static function createMenuItem(): void
    {
        [$auth, $ctx] = self::enter();
        Http::data((new MenuService($ctx, $auth))->save(null, Http::body()), 201);
    }

    public static function updateMenuItem(string $id): void
    {
        [$auth, $ctx] = self::enter();
        Http::data((new MenuService($ctx, $auth))->save((int) $id, Http::body()));
    }

    public static function setAvailability(string $id): void
    {
        [$auth, $ctx] = self::enter();
        Http::data((new MenuService($ctx, $auth))->setAvailability((int) $id, Http::body()));
    }

    public static function modifiers(string $id): void
    {
        [$auth, $ctx] = self::enter();
        Http::data(['groups' => (new MenuService($ctx, $auth))->modifiers((int) $id)]);
    }
}
