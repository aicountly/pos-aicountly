<?php

declare(strict_types=1);

namespace Aicountly\Api;

use Aicountly\Api\Controllers\AdminController;
use Aicountly\Api\Controllers\CatalogController;
use Aicountly\Api\Controllers\DashboardController;
use Aicountly\Api\Controllers\RestaurantController;
use Aicountly\Api\Controllers\ReturnsController;
use Aicountly\Api\Controllers\SettingsController;
use Aicountly\Api\Controllers\TillController;

/**
 * Every route this API serves.
 *
 * The shape follows the rest of the fleet: `/api/v1/<resource>`, company context
 * on the query string or in the body, `{data}` / `{data, meta}` envelopes.
 *
 * Note what is NOT here: there is no endpoint that accepts a bulk import of
 * items, prices or stock, and none that exports them for another product to
 * store. The catalog routes are live read-throughs and nothing they return is
 * written down.
 */
final class Routes
{
    public static function register(Router $router): void
    {
        // Who am I, what may I do, how is this shop set up.
        $router->get('v1/session', [SettingsController::class, 'session']);
        $router->get('v1/permissions', [SettingsController::class, 'permissions']);
        $router->get('v1/settings', [SettingsController::class, 'show']);
        $router->put('v1/settings', [SettingsController::class, 'update']);
        $router->get('v1/outstanding', [SettingsController::class, 'outstanding']);

        // Live read-through to the products that own the data. Pass-throughs:
        // nothing they return is stored here.
        $router->get('v1/catalog/items', [CatalogController::class, 'items']);
        $router->get('v1/catalog/items/search', [CatalogController::class, 'searchItems']);
        $router->get('v1/catalog/barcode', [CatalogController::class, 'barcode']);
        $router->get('v1/catalog/items/{id}', [CatalogController::class, 'item']);
        $router->get('v1/catalog/items/{id}/batches', [CatalogController::class, 'batches']);
        $router->get('v1/catalog/availability', [CatalogController::class, 'availability']);
        $router->get('v1/catalog/warehouses', [CatalogController::class, 'warehouses']);
        $router->get('v1/catalog/customers', [CatalogController::class, 'customers']);
        $router->get('v1/catalog/tax-categories', [CatalogController::class, 'taxCategories']);
        $router->get('v1/catalog/payment-accounts', [CatalogController::class, 'paymentAccounts']);

        // Shifts and the drawer.
        $router->get('v1/shifts', [TillController::class, 'shifts']);
        $router->post('v1/shifts', [TillController::class, 'openShift']);
        $router->get('v1/shifts/current', [TillController::class, 'currentShift']);
        $router->get('v1/shifts/{id}', [TillController::class, 'shift']);
        $router->post('v1/shifts/{id}/close', [TillController::class, 'closeShift']);
        $router->post('v1/shifts/{id}/drawer', [TillController::class, 'drawerEvent']);
        $router->get('v1/shifts/{id}/report', [TillController::class, 'shiftReport']);

        // The sale in front of the cashier.
        $router->get('v1/carts', [TillController::class, 'carts']);
        $router->post('v1/carts', [TillController::class, 'openCart']);
        $router->get('v1/carts/{id}', [TillController::class, 'cart']);
        $router->post('v1/carts/{id}/lines', [TillController::class, 'addLine']);
        $router->put('v1/carts/{id}/lines/{lineId}', [TillController::class, 'updateLine']);
        $router->delete('v1/carts/{id}/lines/{lineId}', [TillController::class, 'removeLine']);
        $router->put('v1/carts/{id}/charges', [TillController::class, 'charges']);
        $router->post('v1/carts/{id}/hold', [TillController::class, 'hold']);
        $router->post('v1/carts/{id}/resume', [TillController::class, 'resume']);
        $router->post('v1/carts/{id}/void', [TillController::class, 'void']);
        $router->get('v1/carts/{id}/stock-check', [TillController::class, 'stockCheck']);
        $router->post('v1/carts/{id}/checkout', [TillController::class, 'checkout']);
        $router->post('v1/carts/{id}/retry', [TillController::class, 'retry']);

        // Offline. The device sends what it sold while it was cut off; every
        // sale carries the uuid the device minted, and the same uuid twice is
        // recognised rather than billed twice.
        $router->post('v1/offline/submit', [TillController::class, 'submitOffline']);
        $router->get('v1/offline/queue', [TillController::class, 'offlineQueue']);
        $router->post('v1/offline/{id}/retry', [TillController::class, 'retryOffline']);
        $router->post('v1/offline/{id}/abandon', [TillController::class, 'abandonOffline']);

        // Restaurant: floors, tables, tickets.
        $router->get('v1/floor-plan', [RestaurantController::class, 'floorPlan']);
        $router->post('v1/tables/{id}/open', [RestaurantController::class, 'openTable']);
        $router->get('v1/table-sessions/{id}', [RestaurantController::class, 'tableSession']);
        $router->post('v1/table-sessions/{id}/transfer', [RestaurantController::class, 'transferTable']);
        $router->post('v1/table-sessions/{id}/merge', [RestaurantController::class, 'mergeTable']);
        $router->post('v1/table-sessions/{id}/split', [RestaurantController::class, 'splitTable']);
        $router->post('v1/table-sessions/{id}/close', [RestaurantController::class, 'closeTable']);

        $router->post('v1/carts/{id}/kot', [RestaurantController::class, 'fireKot']);
        $router->get('v1/kots/{id}', [RestaurantController::class, 'kot']);
        $router->post('v1/kots/{id}/amend', [RestaurantController::class, 'amendKot']);
        $router->post('v1/kots/{id}/advance', [RestaurantController::class, 'advanceKot']);
        $router->post('v1/kots/{id}/cancel', [RestaurantController::class, 'cancelKot']);
        $router->get('v1/kds', [RestaurantController::class, 'kitchenDisplay']);

        // Menu — POS' presentation of Inventory's items.
        $router->get('v1/menu', [RestaurantController::class, 'menu']);
        $router->post('v1/menu/items', [RestaurantController::class, 'createMenuItem']);
        $router->get('v1/menu/items/{id}', [RestaurantController::class, 'menuItem']);
        $router->put('v1/menu/items/{id}', [RestaurantController::class, 'updateMenuItem']);
        $router->put('v1/menu/items/{id}/availability', [RestaurantController::class, 'setAvailability']);
        $router->get('v1/menu/items/{id}/modifiers', [RestaurantController::class, 'modifiers']);

        // Counter returns.
        $router->get('v1/returns', [ReturnsController::class, 'index']);
        $router->post('v1/returns', [ReturnsController::class, 'create']);
        $router->get('v1/returns/{id}', [ReturnsController::class, 'show']);
        $router->post('v1/returns/{id}/approve', [ReturnsController::class, 'approve']);
        $router->post('v1/returns/{id}/receive', [ReturnsController::class, 'receive']);
        $router->post('v1/returns/{id}/settle', [ReturnsController::class, 'settle']);

        // Setting the shop up.
        $router->get('v1/locations', [AdminController::class, 'locations']);
        $router->post('v1/locations', [AdminController::class, 'saveLocation']);
        $router->put('v1/locations/{id}', [AdminController::class, 'saveLocation']);
        $router->get('v1/terminals', [AdminController::class, 'terminals']);
        $router->post('v1/terminals', [AdminController::class, 'saveTerminal']);
        $router->put('v1/terminals/{id}', [AdminController::class, 'saveTerminal']);
        $router->get('v1/devices', [AdminController::class, 'devices']);
        $router->post('v1/devices', [AdminController::class, 'registerDevice']);
        $router->post('v1/devices/{id}/revoke', [AdminController::class, 'revokeDevice']);
        $router->get('v1/floors', [AdminController::class, 'floors']);
        $router->post('v1/floors', [AdminController::class, 'createFloor']);
        $router->post('v1/tables', [AdminController::class, 'createTable']);
        $router->get('v1/stations', [AdminController::class, 'stations']);
        $router->post('v1/stations', [AdminController::class, 'createStation']);

        // Roles.
        $router->post('v1/roles', [AdminController::class, 'saveProfile']);
        $router->put('v1/roles/{id}', [AdminController::class, 'saveProfile']);
        $router->get('v1/role-assignments', [AdminController::class, 'assignments']);
        $router->post('v1/role-assignments', [AdminController::class, 'assignProfile']);

        // The manager's view.
        $router->get('v1/dashboard', [DashboardController::class, 'today']);
        $router->get('v1/dashboard/exceptions', [DashboardController::class, 'exceptions']);
    }
}
