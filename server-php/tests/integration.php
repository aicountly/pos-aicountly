<?php

declare(strict_types=1);

/**
 * Integration tests for the POS domain.
 *
 * They run against a REAL PostgreSQL database and a stub standing in for Books
 * and Inventory, so what is tested is the actual SQL, the actual HTTP client
 * and the actual idempotency behaviour — not mocks of them.
 *
 *   server-php/tests/run.sh
 *
 * The last section is RELEASE-BLOCKING. It reads information_schema and fails
 * if a mirror table, a cached remote master or a stored balance has appeared.
 * If someone adds a nightly sync to this product, that section goes red.
 */

namespace Aicountly\Api;

require __DIR__ . '/../src/Env.php';
require __DIR__ . '/../src/Autoload.php';

Env::load(__DIR__ . '/../.env');

use Aicountly\Api\Domain\CartService;
use Aicountly\Api\Domain\Dashboards\ControlsBoard;
use Aicountly\Api\Domain\Dashboards\CustomersBoard;
use Aicountly\Api\Domain\Dashboards\OverviewBoard;
use Aicountly\Api\Domain\Dashboards\RestaurantBoard;
use Aicountly\Api\Domain\Dashboards\RetailBoard;
use Aicountly\Api\Domain\Dashboards\Tenders;
use Aicountly\Api\Domain\Dashboards\Window;
use Aicountly\Api\Domain\Shift\ShiftReportBoard;
use Aicountly\Api\Domain\CheckoutService;
use Aicountly\Api\Domain\KotService;
use Aicountly\Api\Domain\MenuService;
use Aicountly\Api\Domain\RegisterService;
use Aicountly\Api\Domain\ReturnService;
use Aicountly\Api\Domain\TableService;

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

$passed = 0;
$failed = 0;

function check(string $name, callable $fn): void
{
    global $passed, $failed;
    try {
        $fn();
        echo "  ok    {$name}\n";
        $passed++;
    } catch (\Throwable $e) {
        echo "  FAIL  {$name}\n        {$e->getMessage()}\n";
        if (getenv('VERBOSE')) {
            echo '        ' . $e->getFile() . ':' . $e->getLine() . "\n";
        }
        $failed++;
    }
}

function assertSame(mixed $expected, mixed $actual, string $what): void
{
    if ($expected !== $actual) {
        throw new \RuntimeException(sprintf('%s: expected %s, got %s', $what, var_export($expected, true), var_export($actual, true)));
    }
}

function assertTrue(bool $condition, string $what): void
{
    if (!$condition) {
        throw new \RuntimeException($what);
    }
}

function assertThrows(callable $fn, string $expectFragment, string $what): void
{
    try {
        $fn();
    } catch (\Throwable $e) {
        if ($expectFragment !== '' && !str_contains($e->getMessage(), $expectFragment)) {
            throw new \RuntimeException($what . ': wrong error — ' . $e->getMessage());
        }

        return;
    }
    throw new \RuntimeException($what . ': expected a failure, none was thrown');
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function freshContext(int $cmpId = 88, int $fyId = 5, int $boId = 0): Context
{
    $r = new \ReflectionClass(Context::class);
    $ctx = $r->newInstanceWithoutConstructor();
    foreach (['cmpId' => $cmpId, 'fyId' => $fyId, 'boId' => $boId] as $prop => $value) {
        $p = $r->getProperty($prop);
        $p->setAccessible(true);
        $p->setValue($ctx, $value);
    }

    return $ctx;
}

function ownerAuth(): Auth
{
    $r = new \ReflectionClass(Auth::class);
    $auth = $r->newInstanceWithoutConstructor();
    foreach ([
        'uuid'      => 'user-owner',
        'kind'      => 'user',
        'sourceApp' => 'pos',
        'sesKey'    => 'stub-ses-key',
        // acs_type 1 = company owner, so Permissions grants everything and the
        // tests exercise the domain rather than the permission table.
        'session'   => ['acs_type' => 1, 'name' => 'Owner'],
    ] as $prop => $value) {
        $p = $r->getProperty($prop);
        $p->setAccessible(true);
        $p->setValue($auth, $value);
    }

    return $auth;
}

/** A cashier with the shipped 'cashier' role, for the permission tests. */
function cashierAuth(): Auth
{
    $r = new \ReflectionClass(Auth::class);
    $auth = $r->newInstanceWithoutConstructor();
    foreach ([
        'uuid'      => 'user-cashier',
        'kind'      => 'user',
        'sourceApp' => 'pos',
        'sesKey'    => 'stub-ses-key',
        'session'   => ['acs_type' => 3, 'name' => 'Cashier'],
    ] as $prop => $value) {
        $p = $r->getProperty($prop);
        $p->setAccessible(true);
        $p->setValue($auth, $value);
    }

    return $auth;
}

/**
 * A ShiftReportBoard, built the way a request would build one.
 *
 * The same reasoning as dashboardWindow: the board resolves its own shift from
 * the query string, so the tests set $_GET and let the real resolution,
 * validation and permission narrowing run. A hand-built board would test a
 * constructor nobody calls.
 *
 * @param array<string, string|int> $query
 */
function shiftBoard(Context $ctx, Auth $auth, array $query = []): ShiftReportBoard
{
    $previous = $_GET;
    $_GET = array_map(static fn ($v): string => (string) $v, $query);
    $r = new \ReflectionClass(Http::class);
    $bodyProp = $r->getProperty('body');
    $bodyProp->setAccessible(true);
    $bodyProp->setValue(null, []);

    try {
        return ShiftReportBoard::fromRequest($ctx, $auth);
    } finally {
        $_GET = $previous;
        $bodyProp->setValue(null, null);
    }
}

/**
 * A dashboard Window, built the way a request would build one.
 *
 * Window::fromRequest reads the query string, so the tests set $_GET and let
 * the real parsing, validation and outlet resolution run — a hand-built Window
 * would test a constructor nobody calls.
 *
 * @param array<string, string|int> $query
 */
function dashboardWindow(Context $ctx, Auth $auth, array $query = []): Window
{
    $previous = $_GET;
    $_GET = array_map(static fn ($v): string => (string) $v, $query);
    // Http caches the parsed body per request; a stale one would leak params
    // between tests.
    $r = new \ReflectionClass(Http::class);
    $bodyProp = $r->getProperty('body');
    $bodyProp->setAccessible(true);
    $bodyProp->setValue(null, []);

    try {
        return Window::fromRequest($ctx, $auth);
    } finally {
        $_GET = $previous;
        $bodyProp->setValue(null, null);
    }
}

/**
 * A signed-in human the portal reported no acs_type for.
 *
 * This is what every real user looks like: `validatesession` is handed a
 * session key and no company, so it cannot say whether this person owns the
 * company they are opening. Only Manage knows that.
 */
function unknownAuth(string $uuid = 'user-unknown'): Auth
{
    $r = new \ReflectionClass(Auth::class);
    $auth = $r->newInstanceWithoutConstructor();
    foreach ([
        'uuid'      => $uuid,
        'kind'      => 'user',
        'sourceApp' => 'pos',
        'sesKey'    => 'stub-ses-key',
        'session'   => ['name' => 'Somebody'],
    ] as $prop => $value) {
        $p = $r->getProperty($prop);
        $p->setAccessible(true);
        $p->setValue($auth, $value);
    }

    return $auth;
}

/** What Manage will say the caller is on the company, for the next companyinfo call. */
function stubOwnership(string $ownership): void
{
    file_put_contents(sys_get_temp_dir() . '/stub-ownership.txt', $ownership);
}

/** Forget Context's memo of who may open what, so a test starts clean. */
function forgetContextMemo(): void
{
    $r = new \ReflectionClass(Context::class);
    foreach (['verified', 'accessTypes'] as $prop) {
        $p = $r->getProperty($prop);
        $p->setAccessible(true);
        $p->setValue(null, []);
    }
}

function resetDatabase(): void
{
    $tables = [
        'pos_return_lines', 'pos_returns', 'pos_offline_submissions',
        'pos_kds_events', 'pos_kot_lines', 'pos_kots',
        'pos_cart_payments', 'pos_cart_lines', 'pos_carts',
        'pos_approval_events', 'pos_cash_drawer_events', 'pos_register_sessions',
        'pos_table_reservations', 'pos_table_sessions', 'pos_tables', 'pos_floors',
        'pos_combo_components', 'pos_menu_item_modifiers', 'pos_modifier_options',
        'pos_modifier_groups', 'pos_menu_items', 'pos_menu_categories',
        'pos_kds_stations', 'pos_external_orders', 'pos_connectors',
        'pos_device_registrations', 'pos_terminals', 'pos_location_profiles',
        'pos_permission_assignments', 'pos_permission_profiles',
        'pos_integration_commands', 'pos_settings',
    ];
    // TRUNCATE, not DELETE: the audit table's row-level triggers refuse DELETE,
    // and deliberately do not fire on TRUNCATE so a suite can reset itself.
    Db::connect()->exec('TRUNCATE ' . implode(', ', $tables) . ', pos_audit_log RESTART IDENTITY CASCADE');
    @unlink(sys_get_temp_dir() . '/stub-ownership.txt');
    forgetContextMemo();
    @unlink(sys_get_temp_dir() . '/stub-idempotency.json');
    @unlink(sys_get_temp_dir() . '/stub-requests.jsonl');
    @unlink(sys_get_temp_dir() . '/stub-documents.json');
    stubRecover();

    // Clear the per-process permission memo, or a cashier keeps the owner's
    // grants for the rest of the run.
    $r = new \ReflectionClass(Permissions::class);
    $p = $r->getProperty('cache');
    $p->setAccessible(true);
    $p->setValue(null, []);
}

/** Make the stub fail for every path containing $pathFragment, until cleared. */
function stubFail(string $pathFragment, int $status): void
{
    file_put_contents(sys_get_temp_dir() . '/stub-control.json', json_encode(['path' => $pathFragment, 'status' => $status]));
}

function stubRecover(): void
{
    @unlink(sys_get_temp_dir() . '/stub-control.json');
}

/** @return list<array<string, mixed>> every request the stub received */
function stubRequests(): array
{
    $log = sys_get_temp_dir() . '/stub-requests.jsonl';
    if (!is_file($log)) {
        return [];
    }
    $out = [];
    foreach (explode("\n", trim((string) file_get_contents($log))) as $line) {
        if ($line !== '') {
            $out[] = json_decode($line, true);
        }
    }

    return $out;
}

/** An outlet and a till to sell from. @return array{0:int, 1:int} */
function seedOutlet(Context $ctx, string $mode = 'retail'): array
{
    $locationId = (int) Db::insert('pos_location_profiles', [
        'cmp_id'               => $ctx->cmpId,
        'bo_id'                => $ctx->boId,
        'location_code'        => 'MAIN',
        'display_name'         => 'Main shop',
        'pos_mode'             => $mode,
        'default_warehouse_id' => 3,
        'default_cash_account_id' => 11,
    ], 'location_id');

    $terminalId = (int) Db::insert('pos_terminals', [
        'cmp_id'        => $ctx->cmpId,
        'location_id'   => $locationId,
        'terminal_code' => 'T1',
        'display_name'  => 'Front counter',
    ], 'terminal_id');

    return [$locationId, $terminalId];
}

function openShift(Context $ctx, Auth $auth, int $terminalId, float $float = 2000.0): int
{
    $session = (new RegisterService($ctx, $auth))->open(['terminal_id' => $terminalId, 'opening_float' => $float]);

    return (int) $session['session_id'];
}

/** A cart with two lines, ready to pay for. */
function seedCart(Context $ctx, Auth $auth, int $terminalId, int $sessionId): array
{
    $carts = new CartService($ctx, $auth);
    $cart = $carts->open(['terminal_id' => $terminalId, 'session_id' => $sessionId, 'order_kind' => 'retail']);
    $cartId = (int) $cart['cart_id'];

    $carts->addLine($cartId, ['item_id' => 101, 'quantity' => 2, 'rate' => 120, 'estimated_tax_pc' => 18]);
    $carts->addLine($cartId, ['item_id' => 102, 'quantity' => 1, 'rate' => 200, 'estimated_tax_pc' => 18]);

    return $carts->find($cartId);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

$ctx = freshContext();
$auth = ownerAuth();

echo "\nShifts and the drawer\n";

check('opens a till with a float that lands in the drawer', function () use ($ctx, $auth) {
    resetDatabase();
    [, $terminalId] = seedOutlet($ctx);
    $session = (new RegisterService($ctx, $auth))->open(['terminal_id' => $terminalId, 'opening_float' => 2000]);

    assertSame('OPEN', $session['status'], 'status');
    assertSame(2000.0, $session['expected_cash'], 'the float is what the drawer should hold');
    assertSame(1, (int) Db::scalar('SELECT COUNT(*) FROM pos_cash_drawer_events WHERE session_id = :s', ['s' => $session['session_id']]), 'float recorded as a drawer event');
});

check('refuses a second shift on the same till', function () use ($ctx, $auth) {
    resetDatabase();
    [, $terminalId] = seedOutlet($ctx);
    openShift($ctx, $auth, $terminalId);

    assertThrows(
        fn () => (new RegisterService($ctx, $auth))->open(['terminal_id' => $terminalId, 'opening_float' => 500]),
        'already open',
        'a till cannot have two shifts',
    );
});

check('cash out reduces what the drawer should hold', function () use ($ctx, $auth) {
    resetDatabase();
    [, $terminalId] = seedOutlet($ctx);
    $sessionId = openShift($ctx, $auth, $terminalId);

    $after = (new RegisterService($ctx, $auth))->drawerEvent($sessionId, [
        'event_kind' => 'safe_drop', 'amount' => 500, 'reason' => 'Drop to the safe',
    ]);

    assertSame(1500.0, $after['expected_cash'], 'expected cash after a safe drop');
});

check('a no-sale is recorded even though no money moves', function () use ($ctx, $auth) {
    resetDatabase();
    [, $terminalId] = seedOutlet($ctx);
    $sessionId = openShift($ctx, $auth, $terminalId);

    $after = (new RegisterService($ctx, $auth))->drawerEvent($sessionId, [
        'event_kind' => 'no_sale_open', 'reason' => 'Customer wanted change',
    ]);

    assertSame(2000.0, $after['expected_cash'], 'a no-sale moves nothing');
    assertSame(1, (int) Db::scalar("SELECT COUNT(*) FROM pos_approval_events WHERE event_kind = 'no_sale'"), 'but it is on the fraud trail');
});

check('closing a drawer that does not balance needs a reason', function () use ($ctx, $auth) {
    resetDatabase();
    [, $terminalId] = seedOutlet($ctx);
    $sessionId = openShift($ctx, $auth, $terminalId);

    assertThrows(
        fn () => (new RegisterService($ctx, $auth))->close($sessionId, ['counted_cash' => 1800]),
        'does not balance',
        'a short drawer needs an explanation',
    );

    $closed = (new RegisterService($ctx, $auth))->close($sessionId, ['counted_cash' => 1800, 'variance_reason' => 'Short — under investigation']);
    assertSame('CLOSED', $closed['status'], 'status');
    assertSame(-200.0, $closed['variance'], 'variance');
    assertSame(1, (int) Db::scalar("SELECT COUNT(*) FROM pos_approval_events WHERE event_kind = 'shift_variance'"), 'variance leaves an approval record');
});

check('a till with an unfinished sale on it will not close', function () use ($ctx, $auth) {
    resetDatabase();
    [, $terminalId] = seedOutlet($ctx);
    $sessionId = openShift($ctx, $auth, $terminalId);
    seedCart($ctx, $auth, $terminalId, $sessionId);

    assertThrows(
        fn () => (new RegisterService($ctx, $auth))->close($sessionId, ['counted_cash' => 2000]),
        'still on this till',
        'open sales block the close',
    );
});

echo "\nThe cart\n";

check('a line is priced live from Inventory when no rate is typed', function () use ($ctx, $auth) {
    resetDatabase();
    [, $terminalId] = seedOutlet($ctx);
    $sessionId = openShift($ctx, $auth, $terminalId);

    $carts = new CartService($ctx, $auth);
    $cart = $carts->open(['terminal_id' => $terminalId, 'session_id' => $sessionId]);
    $cart = $carts->addLine((int) $cart['cart_id'], ['item_id' => 101, 'quantity' => 3]);

    // The stub answers sale_rate 120 and tax_rate 18 — neither is stored
    // anywhere but on this sale's own line.
    assertSame(120.0, (float) $cart['lines'][0]['rate'], 'rate came from Inventory');
    assertSame('Stub item 101', $cart['lines'][0]['display_name'], 'name came from Inventory');
    assertSame(360.0, (float) $cart['lines'][0]['line_amount'], 'line amount');
    assertSame(424.8, round((float) $cart['total_amount'], 2), 'total with 18% estimated tax');
});

check('totals recompute when a line changes', function () use ($ctx, $auth) {
    resetDatabase();
    [, $terminalId] = seedOutlet($ctx);
    $sessionId = openShift($ctx, $auth, $terminalId);
    $cart = seedCart($ctx, $auth, $terminalId, $sessionId);

    // 2 x 120 + 1 x 200 = 440 ; tax 18% = 79.20 ; total 519.20
    assertSame(440.0, (float) $cart['subtotal_amount'], 'subtotal');
    assertSame(519.2, round((float) $cart['total_amount'], 2), 'total');

    $carts = new CartService($ctx, $auth);
    $updated = $carts->updateLine((int) $cart['cart_id'], (int) $cart['lines'][0]['line_id'], ['quantity' => 5]);

    assertSame(800.0, (float) $updated['subtotal_amount'], 'subtotal after the change');
    assertSame(944.0, round((float) $updated['total_amount'], 2), 'total after the change');
});

check('a discount past the cashier limit needs a manager', function () use ($ctx) {
    resetDatabase();
    $owner = ownerAuth();
    [, $terminalId] = seedOutlet($ctx);
    Permissions::seed($ctx);

    // Give the cashier the shipped cashier role — 5% is their ceiling.
    $profileId = (int) Db::scalar(
        'SELECT profile_id FROM pos_permission_profiles WHERE cmp_id = :c AND profile_code = :p',
        ['c' => $ctx->cmpId, 'p' => 'cashier'],
    );
    Db::insert('pos_permission_assignments', [
        'cmp_id' => $ctx->cmpId, 'user_uuid' => 'user-cashier', 'profile_id' => $profileId,
    ], 'assignment_id');

    $sessionId = openShift($ctx, $owner, $terminalId);
    $cashier = cashierAuth();
    $carts = new CartService($ctx, $cashier);
    $cart = $carts->open(['terminal_id' => $terminalId, 'session_id' => $sessionId]);

    $carts->addLine((int) $cart['cart_id'], ['item_id' => 101, 'quantity' => 1, 'rate' => 120, 'discount_pc' => 4]);

    assertThrows(
        fn () => $carts->addLine((int) $cart['cart_id'], ['item_id' => 102, 'quantity' => 1, 'rate' => 200, 'discount_pc' => 30]),
        'manager has to approve',
        '30% is past the cashier limit',
    );
});

check('removing a line records who removed it and why', function () use ($ctx, $auth) {
    resetDatabase();
    [, $terminalId] = seedOutlet($ctx);
    $sessionId = openShift($ctx, $auth, $terminalId);
    $cart = seedCart($ctx, $auth, $terminalId, $sessionId);

    $carts = new CartService($ctx, $auth);
    $after = $carts->removeLine((int) $cart['cart_id'], (int) $cart['lines'][0]['line_id'], ['reason' => 'Customer changed their mind']);

    assertSame(1, count($after['lines']), 'one line left');
    assertSame(200.0, (float) $after['subtotal_amount'], 'subtotal recomputed');
    assertSame(1, (int) Db::scalar("SELECT COUNT(*) FROM pos_approval_events WHERE event_kind = 'void_line'"), 'the void is on the trail');
});

check('a stock check that cannot reach Inventory says so rather than guessing', function () use ($ctx, $auth) {
    resetDatabase();
    [, $terminalId] = seedOutlet($ctx);
    $sessionId = openShift($ctx, $auth, $terminalId);
    $cart = seedCart($ctx, $auth, $terminalId, $sessionId);

    stubFail('/v1/availability/check', 503);
    $result = (new CartService($ctx, $auth))->stockCheck((int) $cart['cart_id']);
    stubRecover();

    assertSame(false, $result['reachable'], 'unreachable is reported as unreachable');
    assertSame([], $result['lines'], 'and not as an empty stock answer');
});

echo "\nCheckout\n";

check('a sale posts one invoice to Books and one movement to Inventory', function () use ($ctx, $auth) {
    resetDatabase();
    [, $terminalId] = seedOutlet($ctx);
    $sessionId = openShift($ctx, $auth, $terminalId);
    $cart = seedCart($ctx, $auth, $terminalId, $sessionId);

    $result = (new CheckoutService($ctx, $auth))->checkout((int) $cart['cart_id'], [
        'payments' => [['payment_mode' => 'cash', 'amount' => 519.2, 'tendered' => 600, 'change_given' => 80.8]],
    ]);

    assertSame('COMPLETED', $result['status'], 'status');
    assertTrue($result['books_voucher_uuid'] !== null, 'Books gave us an invoice');
    assertTrue($result['inventory_document_uuid'] !== null, 'Inventory recorded the movement');

    $commands = Db::all('SELECT command_type, status FROM pos_integration_commands ORDER BY command_id');
    assertSame(2, count($commands), 'exactly two commands');
    foreach ($commands as $command) {
        assertSame('COMPLETED', $command['status'], $command['command_type'] . ' completed');
    }
});

check('cash taken lands on the drawer, net of change', function () use ($ctx, $auth) {
    resetDatabase();
    [, $terminalId] = seedOutlet($ctx);
    $sessionId = openShift($ctx, $auth, $terminalId);
    $cart = seedCart($ctx, $auth, $terminalId, $sessionId);

    (new CheckoutService($ctx, $auth))->checkout((int) $cart['cart_id'], [
        'payments' => [['payment_mode' => 'cash', 'amount' => 519.2, 'tendered' => 600, 'change_given' => 80.8]],
    ]);

    $session = (new RegisterService($ctx, $auth))->find($sessionId);
    // 2000 float + 519.20 taken - 80.80 change already handed back = 2438.40
    assertSame(2438.4, round($session['expected_cash'], 2), 'expected cash');
});

check('checking out twice does not bill the customer twice', function () use ($ctx, $auth) {
    resetDatabase();
    [, $terminalId] = seedOutlet($ctx);
    $sessionId = openShift($ctx, $auth, $terminalId);
    $cart = seedCart($ctx, $auth, $terminalId, $sessionId);

    $checkout = new CheckoutService($ctx, $auth);
    $payments = ['payments' => [['payment_mode' => 'cash', 'amount' => 519.2]]];

    $first  = $checkout->checkout((int) $cart['cart_id'], $payments);
    $second = $checkout->checkout((int) $cart['cart_id'], $payments);

    assertSame($first['books_voucher_uuid'], $second['books_voucher_uuid'], 'the same invoice comes back');
    assertSame(1, (int) Db::scalar("SELECT COUNT(*) FROM pos_integration_commands WHERE command_type = 'pos.sale.invoice'"), 'one invoice command, not two');
});

check('a payment short of the total is refused unless it is on account', function () use ($ctx, $auth) {
    resetDatabase();
    [, $terminalId] = seedOutlet($ctx);
    $sessionId = openShift($ctx, $auth, $terminalId);
    $cart = seedCart($ctx, $auth, $terminalId, $sessionId);

    assertThrows(
        fn () => (new CheckoutService($ctx, $auth))->checkout((int) $cart['cart_id'], [
            'payments' => [['payment_mode' => 'cash', 'amount' => 100]],
        ]),
        'short by',
        'a short payment is refused',
    );
});

check('a card number typed into the reference box is refused, not truncated', function () use ($ctx, $auth) {
    resetDatabase();
    [, $terminalId] = seedOutlet($ctx);
    $sessionId = openShift($ctx, $auth, $terminalId);
    $cart = seedCart($ctx, $auth, $terminalId, $sessionId);

    assertThrows(
        fn () => (new CheckoutService($ctx, $auth))->checkout((int) $cart['cart_id'], [
            'payments' => [['payment_mode' => 'card', 'amount' => 519.2, 'reference' => '4111 1111 1111 1111']],
        ]),
        'Do not type card numbers',
        'a PAN never reaches the database',
    );
});

check('Books refusing the sale leaves nothing billed and a retryable command', function () use ($ctx, $auth) {
    resetDatabase();
    [, $terminalId] = seedOutlet($ctx);
    $sessionId = openShift($ctx, $auth, $terminalId);
    $cart = seedCart($ctx, $auth, $terminalId, $sessionId);

    stubFail('/vouchers/drafts', 503);
    assertThrows(
        fn () => (new CheckoutService($ctx, $auth))->checkout((int) $cart['cart_id'], [
            'payments' => [['payment_mode' => 'cash', 'amount' => 519.2]],
        ]),
        'could not be recorded in Books',
        'the cashier is told plainly',
    );
    stubRecover();

    $command = Db::first("SELECT * FROM pos_integration_commands WHERE command_type = 'pos.sale.invoice'");
    assertSame('FAILED', $command['status'], 'transport failure is FAILED, so Retry is offered');

    $state = Db::first('SELECT status, books_voucher_uuid FROM pos_carts WHERE cart_id = :id', ['id' => $cart['cart_id']]);
    assertSame(null, $state['books_voucher_uuid'], 'nothing was billed');
});

check('retry reuses the original idempotency key', function () use ($ctx, $auth) {
    resetDatabase();
    [, $terminalId] = seedOutlet($ctx);
    $sessionId = openShift($ctx, $auth, $terminalId);
    $cart = seedCart($ctx, $auth, $terminalId, $sessionId);

    stubFail('/vouchers/drafts', 503);
    try {
        (new CheckoutService($ctx, $auth))->checkout((int) $cart['cart_id'], ['payments' => [['payment_mode' => 'cash', 'amount' => 519.2]]]);
    } catch (\Throwable) {
        // expected
    }
    $keyBefore = Db::scalar("SELECT idempotency_key FROM pos_integration_commands WHERE command_type = 'pos.sale.invoice'");
    stubRecover();

    $result = (new CheckoutService($ctx, $auth))->retry((int) $cart['cart_id']);
    $keyAfter = Db::scalar("SELECT idempotency_key FROM pos_integration_commands WHERE command_type = 'pos.sale.invoice'");

    assertSame($keyBefore, $keyAfter, 'the key survives the retry — this is what stops a double invoice');
    assertSame('COMPLETED', $result['status'], 'the sale went through on retry');
});

check('a business refusal is BLOCKED, not FAILED', function () use ($ctx, $auth) {
    resetDatabase();
    [, $terminalId] = seedOutlet($ctx);
    $sessionId = openShift($ctx, $auth, $terminalId);
    $cart = seedCart($ctx, $auth, $terminalId, $sessionId);

    stubFail('/vouchers/drafts', 422);
    try {
        (new CheckoutService($ctx, $auth))->checkout((int) $cart['cart_id'], ['payments' => [['payment_mode' => 'cash', 'amount' => 519.2]]]);
    } catch (\Throwable) {
        // expected
    }
    stubRecover();

    $command = Db::first("SELECT status FROM pos_integration_commands WHERE command_type = 'pos.sale.invoice'");
    assertSame('BLOCKED', $command['status'], 'retrying a business refusal is pointless, and the status says so');
});

check('Inventory being down does not undo a sale that is already billed', function () use ($ctx, $auth) {
    resetDatabase();
    [, $terminalId] = seedOutlet($ctx);
    $sessionId = openShift($ctx, $auth, $terminalId);
    $cart = seedCart($ctx, $auth, $terminalId, $sessionId);

    stubFail('/v1/inventory-documents/post', 503);
    $result = (new CheckoutService($ctx, $auth))->checkout((int) $cart['cart_id'], [
        'payments' => [['payment_mode' => 'cash', 'amount' => 519.2]],
    ]);
    stubRecover();

    assertSame('COMPLETED', $result['status'], 'the customer has paid and gone; the sale stands');
    assertTrue($result['books_voucher_uuid'] !== null, 'the invoice is real');
    assertSame(null, $result['inventory_document_uuid'], 'stock has not moved yet');

    $issue = Db::first("SELECT status FROM pos_integration_commands WHERE command_type = 'pos.sale.stock_issue'");
    assertSame('FAILED', $issue['status'], 'and that is visible, retryable, and on the sale');

    $finished = (new CheckoutService($ctx, $auth))->retry((int) $cart['cart_id']);
    assertTrue($finished['inventory_document_uuid'] !== null, 'retry finishes the stock movement');
});

echo "\nOffline\n";

check('an offline sale posts and keeps the price the device charged', function () use ($ctx, $auth) {
    resetDatabase();
    [, $terminalId] = seedOutlet($ctx);

    $result = (new CheckoutService($ctx, $auth))->submitOffline(['sales' => [[
        'client_uuid'       => '11111111-1111-4111-8111-111111111111',
        'device_uuid'       => '22222222-2222-4222-8222-222222222222',
        'terminal_id'       => $terminalId,
        'client_created_at' => '2026-09-15T18:30:00Z',
        'order_kind'        => 'retail',
        // 95, not the catalogue's 120: this is what the customer was charged
        // and what their receipt says.
        'lines'    => [['item_id' => 101, 'quantity' => 2, 'rate' => 95, 'display_name' => 'Stub item 101', 'estimated_tax_pc' => 18]],
        'payments' => [['payment_mode' => 'cash', 'amount' => 224.2]],
    ]]]);

    assertSame(1, $result['accepted'], 'accepted');
    assertSame(0, $result['failed'], 'nothing failed');
    assertSame('POSTED', $result['results'][0]['status'], 'status');

    $rate = Db::scalar('SELECT rate FROM pos_cart_lines WHERE cmp_id = :c', ['c' => $ctx->cmpId]);
    assertSame('95.0000', (string) $rate, 'the device price is kept, not re-derived from the catalogue');
});

check('the same offline sale twice is recognised, not billed twice', function () use ($ctx, $auth) {
    resetDatabase();
    [, $terminalId] = seedOutlet($ctx);

    $sale = [
        'client_uuid'       => '33333333-3333-4333-8333-333333333333',
        'device_uuid'       => '22222222-2222-4222-8222-222222222222',
        'terminal_id'       => $terminalId,
        'client_created_at' => '2026-09-15T18:35:00Z',
        'lines'    => [['item_id' => 101, 'quantity' => 1, 'rate' => 120, 'display_name' => 'Stub item 101']],
        'payments' => [['payment_mode' => 'cash', 'amount' => 120]],
    ];

    $checkout = new CheckoutService($ctx, $auth);
    $first  = $checkout->submitOffline(['sales' => [$sale]]);
    $second = $checkout->submitOffline(['sales' => [$sale]]);

    assertSame(0, $first['duplicate'], 'the first is new');
    assertSame(1, $second['duplicate'], 'the second is a replay');
    assertSame($first['results'][0]['cart_id'], $second['results'][0]['cart_id'], 'and it points at the same sale');
    assertSame(1, (int) Db::scalar('SELECT COUNT(*) FROM pos_carts WHERE cmp_id = :c', ['c' => $ctx->cmpId]), 'one sale exists, not two');
    assertSame(1, (int) Db::scalar('SELECT COUNT(*) FROM pos_offline_submissions WHERE cmp_id = :c', ['c' => $ctx->cmpId]), 'one submission row');
});

check('the whole offline queue can be resent as often as the device likes', function () use ($ctx, $auth) {
    resetDatabase();
    [, $terminalId] = seedOutlet($ctx);

    $queue = [];
    foreach (['aaaaaaaa', 'bbbbbbbb', 'cccccccc'] as $stem) {
        $queue[] = [
            'client_uuid'       => $stem . '-4444-4444-8444-444444444444',
            'device_uuid'       => '22222222-2222-4222-8222-222222222222',
            'terminal_id'       => $terminalId,
            'client_created_at' => '2026-09-15T19:00:00Z',
            'lines'    => [['item_id' => 101, 'quantity' => 1, 'rate' => 100, 'display_name' => 'Stub item 101']],
            'payments' => [['payment_mode' => 'cash', 'amount' => 100]],
        ];
    }

    $checkout = new CheckoutService($ctx, $auth);
    $checkout->submitOffline(['sales' => $queue]);
    $checkout->submitOffline(['sales' => $queue]);
    $third = $checkout->submitOffline(['sales' => $queue]);

    assertSame(3, $third['duplicate'], 'every sale is recognised on the third send');
    assertSame(3, (int) Db::scalar('SELECT COUNT(*) FROM pos_carts WHERE cmp_id = :c', ['c' => $ctx->cmpId]), 'still three sales');
    assertSame(3, (int) Db::scalar("SELECT COUNT(*) FROM pos_integration_commands WHERE command_type = 'pos.sale.invoice'"), 'three invoices, no more');
});

check('an offline sale Books refuses is held as a conflict for a person to look at', function () use ($ctx, $auth) {
    resetDatabase();
    [, $terminalId] = seedOutlet($ctx);

    stubFail('/vouchers/drafts', 422);
    $result = (new CheckoutService($ctx, $auth))->submitOffline(['sales' => [[
        'client_uuid'       => '55555555-5555-4555-8555-555555555555',
        'device_uuid'       => '22222222-2222-4222-8222-222222222222',
        'terminal_id'       => $terminalId,
        'client_created_at' => '2026-09-15T19:10:00Z',
        'lines'    => [['item_id' => 101, 'quantity' => 1, 'rate' => 100, 'display_name' => 'Stub item 101']],
        'payments' => [['payment_mode' => 'cash', 'amount' => 100]],
    ]]]);
    stubRecover();

    assertSame('CONFLICT', $result['results'][0]['status'], 'a business refusal is a conflict, not a retry loop');
    assertSame(1, $result['failed'], 'and it is counted as failed, not quietly accepted');
});

check('an offline sale that timed out retries onto the same invoice', function () use ($ctx, $auth) {
    resetDatabase();
    [, $terminalId] = seedOutlet($ctx);

    $sale = [
        'client_uuid'       => '66666666-6666-4666-8666-666666666666',
        'device_uuid'       => '22222222-2222-4222-8222-222222222222',
        'terminal_id'       => $terminalId,
        'client_created_at' => '2026-09-15T19:20:00Z',
        'lines'    => [['item_id' => 101, 'quantity' => 1, 'rate' => 100, 'display_name' => 'Stub item 101']],
        'payments' => [['payment_mode' => 'cash', 'amount' => 100]],
    ];

    $checkout = new CheckoutService($ctx, $auth);

    stubFail('/vouchers/drafts', 503);
    $failed = $checkout->submitOffline(['sales' => [$sale]]);
    stubRecover();

    assertSame('RECEIVED', $failed['results'][0]['status'], 'a timeout leaves it retryable');

    $retried = $checkout->submitOffline(['sales' => [$sale]]);
    assertSame('POSTED', $retried['results'][0]['status'], 'the resend gets it through');
    assertSame(1, (int) Db::scalar('SELECT COUNT(*) FROM pos_carts WHERE cmp_id = :c', ['c' => $ctx->cmpId]), 'and only ever built one sale');
});

check('abandoning an offline sale demands a reason and keeps the row', function () use ($ctx, $auth) {
    resetDatabase();
    [, $terminalId] = seedOutlet($ctx);

    stubFail('/vouchers/drafts', 422);
    $result = (new CheckoutService($ctx, $auth))->submitOffline(['sales' => [[
        'client_uuid'       => '77777777-7777-4777-8777-777777777777',
        'device_uuid'       => '22222222-2222-4222-8222-222222222222',
        'terminal_id'       => $terminalId,
        'client_created_at' => '2026-09-15T19:30:00Z',
        'lines'    => [['item_id' => 101, 'quantity' => 1, 'rate' => 100, 'display_name' => 'Stub item 101']],
        'payments' => [['payment_mode' => 'cash', 'amount' => 100]],
    ]]]);
    stubRecover();

    $submissionId = (int) $result['results'][0]['submission_id'];
    $checkout = new CheckoutService($ctx, $auth);

    assertThrows(fn () => $checkout->abandonOffline($submissionId, []), 'Say why', 'abandoning needs a reason');

    $abandoned = $checkout->abandonOffline($submissionId, ['note' => 'Duplicate of a manual bill']);
    assertSame('ABANDONED', $abandoned['status'], 'status');
    assertSame(1, (int) Db::scalar('SELECT COUNT(*) FROM pos_offline_submissions'), 'the row stays as the record of the hole');
});

check('an offline sale with no device uuid is refused', function () use ($ctx, $auth) {
    resetDatabase();
    seedOutlet($ctx);

    $result = (new CheckoutService($ctx, $auth))->submitOffline(['sales' => [[
        'client_uuid' => '88888888-8888-4888-8888-888888888888',
        'lines'       => [['item_id' => 101, 'quantity' => 1, 'rate' => 100]],
    ]]]);

    assertSame(1, $result['failed'], 'a sale without the device uuid cannot be made idempotent, so it is refused');
});

echo "\nRestaurant\n";

check('seating a table opens a bill with it', function () use ($ctx, $auth) {
    resetDatabase();
    [$locationId, $terminalId] = seedOutlet($ctx, 'restaurant');
    $floorId = (int) Db::insert('pos_floors', ['cmp_id' => $ctx->cmpId, 'location_id' => $locationId, 'floor_code' => 'GF', 'floor_name' => 'Ground'], 'floor_id');
    $tableId = (int) Db::insert('pos_tables', ['cmp_id' => $ctx->cmpId, 'floor_id' => $floorId, 'table_code' => 'T5', 'seats' => 4], 'table_id');

    $session = (new TableService($ctx, $auth))->open($tableId, ['terminal_id' => $terminalId, 'covers' => 3]);

    assertSame('OCCUPIED', $session['status'], 'status');
    assertSame(3, $session['covers'], 'covers');
    assertSame(1, count($session['carts']), 'a bill opened with the table');
});

check('a table cannot be seated twice', function () use ($ctx, $auth) {
    resetDatabase();
    [$locationId, $terminalId] = seedOutlet($ctx, 'restaurant');
    $floorId = (int) Db::insert('pos_floors', ['cmp_id' => $ctx->cmpId, 'location_id' => $locationId, 'floor_code' => 'GF', 'floor_name' => 'Ground'], 'floor_id');
    $tableId = (int) Db::insert('pos_tables', ['cmp_id' => $ctx->cmpId, 'floor_id' => $floorId, 'table_code' => 'T5'], 'table_id');

    $tables = new TableService($ctx, $auth);
    $tables->open($tableId, ['terminal_id' => $terminalId]);

    assertThrows(fn () => $tables->open($tableId, ['terminal_id' => $terminalId]), 'already occupied', 'two parties, one table');
});

check('a table with an unpaid bill will not clear', function () use ($ctx, $auth) {
    resetDatabase();
    [$locationId, $terminalId] = seedOutlet($ctx, 'restaurant');
    $floorId = (int) Db::insert('pos_floors', ['cmp_id' => $ctx->cmpId, 'location_id' => $locationId, 'floor_code' => 'GF', 'floor_name' => 'Ground'], 'floor_id');
    $tableId = (int) Db::insert('pos_tables', ['cmp_id' => $ctx->cmpId, 'floor_id' => $floorId, 'table_code' => 'T5'], 'table_id');

    $tables = new TableService($ctx, $auth);
    $session = $tables->open($tableId, ['terminal_id' => $terminalId]);
    $cartId = (int) $session['carts'][0]['cart_id'];
    (new CartService($ctx, $auth))->addLine($cartId, ['item_id' => 101, 'quantity' => 1, 'rate' => 400]);

    assertThrows(fn () => $tables->close((int) $session['table_session_id']), 'unpaid bill', 'the bill has to be settled first');
});

check('merging two tables leaves exactly one bill', function () use ($ctx, $auth) {
    resetDatabase();
    [$locationId, $terminalId] = seedOutlet($ctx, 'restaurant');
    $floorId = (int) Db::insert('pos_floors', ['cmp_id' => $ctx->cmpId, 'location_id' => $locationId, 'floor_code' => 'GF', 'floor_name' => 'Ground'], 'floor_id');
    $t1 = (int) Db::insert('pos_tables', ['cmp_id' => $ctx->cmpId, 'floor_id' => $floorId, 'table_code' => 'T1'], 'table_id');
    $t2 = (int) Db::insert('pos_tables', ['cmp_id' => $ctx->cmpId, 'floor_id' => $floorId, 'table_code' => 'T2'], 'table_id');

    $tables = new TableService($ctx, $auth);
    $carts = new CartService($ctx, $auth);

    $s1 = $tables->open($t1, ['terminal_id' => $terminalId, 'covers' => 2]);
    $s2 = $tables->open($t2, ['terminal_id' => $terminalId, 'covers' => 3]);
    $carts->addLine((int) $s1['carts'][0]['cart_id'], ['item_id' => 101, 'quantity' => 1, 'rate' => 300]);
    $carts->addLine((int) $s2['carts'][0]['cart_id'], ['item_id' => 102, 'quantity' => 1, 'rate' => 200]);

    $merged = $tables->merge((int) $s1['table_session_id'], ['into_table_session_id' => (int) $s2['table_session_id']]);

    assertSame(5, $merged['covers'], 'covers add up');
    assertSame(1, count($merged['carts']), 'one bill on the surviving table');
    assertSame(500.0, (float) $carts->find((int) $s2['carts'][0]['cart_id'])['subtotal_amount'], 'and it carries both parties lines');
});

check('firing a ticket sends it to the right station and marks the lines sent', function () use ($ctx, $auth) {
    resetDatabase();
    [$locationId, $terminalId] = seedOutlet($ctx, 'restaurant');
    $sessionId = openShift($ctx, $auth, $terminalId);
    $stationId = (int) Db::insert('pos_kds_stations', [
        'cmp_id' => $ctx->cmpId, 'location_id' => $locationId, 'station_code' => 'GRILL', 'station_name' => 'Grill',
    ], 'station_id');
    $menuItemId = (int) Db::insert('pos_menu_items', [
        'cmp_id' => $ctx->cmpId, 'location_id' => $locationId, 'item_id' => 101,
        'display_name' => 'Grilled fish', 'menu_price' => 450, 'station_id' => $stationId,
    ], 'menu_item_id');

    $carts = new CartService($ctx, $auth);
    $cart = $carts->open(['terminal_id' => $terminalId, 'session_id' => $sessionId, 'order_kind' => 'dine_in']);
    $cart = $carts->addLine((int) $cart['cart_id'], ['menu_item_id' => $menuItemId, 'quantity' => 2]);

    assertSame(450.0, (float) $cart['lines'][0]['rate'], 'the menu price wins over the catalogue rate');

    $kots = (new KotService($ctx, $auth))->fire((int) $cart['cart_id'], []);

    assertSame(1, count($kots), 'one ticket');
    assertSame($stationId, (int) $kots[0]['station_id'], 'routed to the grill');
    assertSame('new', $kots[0]['kot_kind'], 'the first ticket for this bill');
    assertSame('SENT', (string) $carts->find((int) $cart['cart_id'])['lines'][0]['kitchen_status'], 'the line knows it is gone');
});

check('a second round is an addon ticket, never an edit of the first', function () use ($ctx, $auth) {
    resetDatabase();
    [$locationId, $terminalId] = seedOutlet($ctx, 'restaurant');
    $sessionId = openShift($ctx, $auth, $terminalId);
    $menuItemId = (int) Db::insert('pos_menu_items', [
        'cmp_id' => $ctx->cmpId, 'location_id' => $locationId, 'item_id' => 101, 'display_name' => 'Soup', 'menu_price' => 150,
    ], 'menu_item_id');

    $carts = new CartService($ctx, $auth);
    $kots = new KotService($ctx, $auth);
    $cart = $carts->open(['terminal_id' => $terminalId, 'session_id' => $sessionId, 'order_kind' => 'dine_in']);
    $cartId = (int) $cart['cart_id'];

    $carts->addLine($cartId, ['menu_item_id' => $menuItemId, 'quantity' => 1]);
    $kots->fire($cartId, []);

    $carts->addLine($cartId, ['menu_item_id' => $menuItemId, 'quantity' => 2]);
    $second = $kots->fire($cartId, []);

    assertSame('addon', $second[0]['kot_kind'], 'the second round is an addon');
    assertSame(2, (int) Db::scalar('SELECT COUNT(*) FROM pos_kots'), 'two tickets exist');
});

check('a line the kitchen is cooking cannot be quietly edited', function () use ($ctx, $auth) {
    resetDatabase();
    [$locationId, $terminalId] = seedOutlet($ctx, 'restaurant');
    $sessionId = openShift($ctx, $auth, $terminalId);
    $menuItemId = (int) Db::insert('pos_menu_items', [
        'cmp_id' => $ctx->cmpId, 'location_id' => $locationId, 'item_id' => 101, 'display_name' => 'Curry', 'menu_price' => 250,
    ], 'menu_item_id');

    $carts = new CartService($ctx, $auth);
    $kots = new KotService($ctx, $auth);
    $cart = $carts->open(['terminal_id' => $terminalId, 'session_id' => $sessionId, 'order_kind' => 'dine_in']);
    $cartId = (int) $cart['cart_id'];
    $cart = $carts->addLine($cartId, ['menu_item_id' => $menuItemId, 'quantity' => 1]);
    $lineId = (int) $cart['lines'][0]['line_id'];

    $fired = $kots->fire($cartId, []);
    $kots->advance((int) $fired[0]['kot_id'], ['status' => 'PREPARING']);

    assertThrows(
        fn () => $carts->updateLine($cartId, $lineId, ['quantity' => 5]),
        'kitchen has already started',
        'the kitchen has to see a change',
    );
});

check('cancelling a ticket needs a reason and lands on the fraud trail', function () use ($ctx, $auth) {
    resetDatabase();
    [$locationId, $terminalId] = seedOutlet($ctx, 'restaurant');
    $sessionId = openShift($ctx, $auth, $terminalId);
    $menuItemId = (int) Db::insert('pos_menu_items', [
        'cmp_id' => $ctx->cmpId, 'location_id' => $locationId, 'item_id' => 101, 'display_name' => 'Biryani', 'menu_price' => 320,
    ], 'menu_item_id');

    $carts = new CartService($ctx, $auth);
    $kots = new KotService($ctx, $auth);
    $cart = $carts->open(['terminal_id' => $terminalId, 'session_id' => $sessionId, 'order_kind' => 'dine_in']);
    $carts->addLine((int) $cart['cart_id'], ['menu_item_id' => $menuItemId, 'quantity' => 1]);
    $fired = $kots->fire((int) $cart['cart_id'], []);
    $kotId = (int) $fired[0]['kot_id'];

    assertThrows(fn () => $kots->cancel($kotId, []), 'Say why', 'a cancel needs a reason');

    $cancelled = $kots->cancel($kotId, ['reason' => 'Customer left']);
    assertSame('CANCELLED', $cancelled['status'], 'status');
    assertSame(1, (int) Db::scalar("SELECT COUNT(*) FROM pos_approval_events WHERE event_kind = 'kot_cancel'"), 'recorded for the manager');
});

check('a sold-out item cannot be added to a bill', function () use ($ctx, $auth) {
    resetDatabase();
    [$locationId, $terminalId] = seedOutlet($ctx, 'restaurant');
    $sessionId = openShift($ctx, $auth, $terminalId);
    $menuItemId = (int) Db::insert('pos_menu_items', [
        'cmp_id' => $ctx->cmpId, 'location_id' => $locationId, 'item_id' => 101, 'display_name' => 'Prawns', 'menu_price' => 600,
    ], 'menu_item_id');

    (new MenuService($ctx, $auth))->setAvailability($menuItemId, ['availability' => 'SOLD_OUT', 'note' => 'None left']);

    $carts = new CartService($ctx, $auth);
    $cart = $carts->open(['terminal_id' => $terminalId, 'session_id' => $sessionId, 'order_kind' => 'dine_in']);

    assertThrows(
        fn () => $carts->addLine((int) $cart['cart_id'], ['menu_item_id' => $menuItemId, 'quantity' => 1]),
        'sold out',
        'the kitchen said no',
    );
});


// ---------------------------------------------------------------------------
// The floor plan: three reasons a table is not simply free
// ---------------------------------------------------------------------------

/** A restaurant outlet with one floor and one table on it. @return array{0:int,1:int,2:int} */
function seedFloor(Context $ctx, string $code = 'T5', int $seats = 4): array
{
    [$locationId, $terminalId] = seedOutlet($ctx, 'restaurant');
    $floorId = (int) Db::insert('pos_floors', [
        'cmp_id' => $ctx->cmpId, 'location_id' => $locationId, 'floor_code' => 'GF', 'floor_name' => 'Ground',
    ], 'floor_id');
    $tableId = (int) Db::insert('pos_tables', [
        'cmp_id' => $ctx->cmpId, 'floor_id' => $floorId, 'table_code' => $code, 'seats' => $seats,
    ], 'table_id');

    return [$terminalId, $floorId, $tableId];
}

/** The one table on the one floor, as the floor plan reports it. */
function planTable(TableService $tables, int $tableId): array
{
    foreach ($tables->floorPlan() as $floor) {
        foreach ($floor['tables'] as $table) {
            if ($table['table_id'] === $tableId) {
                return $table;
            }
        }
    }

    return [];
}

check('a table being cleaned reads as cleaning, not as free', function () use ($ctx, $auth) {
    resetDatabase();
    [, , $tableId] = seedFloor($ctx);

    $tables = new TableService($ctx, $auth);
    assertSame('FREE', planTable($tables, $tableId)['status'], 'before');

    $tables->setServiceState($tableId, ['service_state' => 'CLEANING', 'note' => 'Spill']);
    assertSame('CLEANING', planTable($tables, $tableId)['status'], 'after');

    $tables->setServiceState($tableId, ['service_state' => 'READY']);
    assertSame('FREE', planTable($tables, $tableId)['status'], 'once it is wiped down');
});

check('a table with a party at it cannot be taken out of service', function () use ($ctx, $auth) {
    resetDatabase();
    [$terminalId, , $tableId] = seedFloor($ctx);

    $tables = new TableService($ctx, $auth);
    $tables->open($tableId, ['terminal_id' => $terminalId]);

    assertThrows(
        fn () => $tables->setServiceState($tableId, ['service_state' => 'OUT_OF_SERVICE']),
        'party at that table',
        'the furniture is not how a table gets cleared',
    );
});

check('a booking due shortly holds its table; one due tomorrow does not', function () use ($ctx, $auth) {
    resetDatabase();
    [, , $tableId] = seedFloor($ctx);

    $tables = new TableService($ctx, $auth);

    $tables->createReservation([
        'table_id' => $tableId, 'guest_name' => 'Meera', 'party_size' => 2,
        'reserved_for' => (new \DateTimeImmutable('+10 days'))->format(DATE_ATOM),
    ]);
    assertSame('FREE', planTable($tables, $tableId)['status'], 'a booking next week does not close the table tonight');

    $tables->createReservation([
        'table_id' => $tableId, 'guest_name' => 'Arun', 'party_size' => 4,
        'reserved_for' => (new \DateTimeImmutable('+30 minutes'))->format(DATE_ATOM),
    ]);

    $table = planTable($tables, $tableId);
    assertSame('RESERVED', $table['status'], 'a booking half an hour out does');
    assertSame('Arun', $table['reservation']['guest_name'], 'and it is the nearer booking that is shown');
});

check('two bookings cannot be taken for the same table at the same time', function () use ($ctx, $auth) {
    resetDatabase();
    [, , $tableId] = seedFloor($ctx);

    $tables = new TableService($ctx, $auth);
    $when = (new \DateTimeImmutable('+2 hours'))->format(DATE_ATOM);
    $tables->createReservation(['table_id' => $tableId, 'guest_name' => 'Meera', 'reserved_for' => $when]);

    assertThrows(
        fn () => $tables->createReservation(['table_id' => $tableId, 'guest_name' => 'Arun', 'reserved_for' => $when]),
        'already booked',
        'one table, one party',
    );
});

check('seating a booking opens the bill and closes the booking', function () use ($ctx, $auth) {
    resetDatabase();
    [$terminalId, , $tableId] = seedFloor($ctx);

    $tables = new TableService($ctx, $auth);
    $booking = $tables->createReservation([
        'table_id' => $tableId, 'guest_name' => 'Meera', 'guest_mobile' => '9800000000',
        'party_size' => 3, 'reserved_for' => (new \DateTimeImmutable('+20 minutes'))->format(DATE_ATOM),
    ]);

    $session = $tables->seatReservation((int) $booking['reservation_id'], ['terminal_id' => $terminalId]);

    assertSame('OCCUPIED', $session['status'], 'the party is seated');
    assertSame(3, $session['covers'], 'covers come from the booking');
    assertSame(1, count($session['carts']), 'and a bill opened with them');

    $after = $tables->reservation((int) $booking['reservation_id']);
    assertSame('SEATED', $after['status'], 'the booking is closed out');
    assertSame((int) $session['table_session_id'], $after['seated_session_id'], 'and points at the party it became');
});

check('a booking cannot be seated twice', function () use ($ctx, $auth) {
    resetDatabase();
    [$terminalId, , $tableId] = seedFloor($ctx);

    $tables = new TableService($ctx, $auth);
    $booking = $tables->createReservation([
        'table_id' => $tableId, 'reserved_for' => (new \DateTimeImmutable('+20 minutes'))->format(DATE_ATOM),
    ]);
    $tables->seatReservation((int) $booking['reservation_id'], ['terminal_id' => $terminalId]);

    assertThrows(
        fn () => $tables->seatReservation((int) $booking['reservation_id'], ['terminal_id' => $terminalId]),
        'already been seated',
        'the second press does nothing',
    );
});

check('the floor plan counts a split table once, with both bills added up', function () use ($ctx, $auth) {
    resetDatabase();
    [$terminalId, , $tableId] = seedFloor($ctx);

    $tables = new TableService($ctx, $auth);
    $session = $tables->open($tableId, ['terminal_id' => $terminalId, 'covers' => 4]);
    $cartId = (int) $session['carts'][0]['cart_id'];

    $carts = new CartService($ctx, $auth);
    $carts->addLine($cartId, ['item_id' => 101, 'quantity' => 1, 'rate' => 300, 'estimated_tax_pc' => 0]);
    $carts->addLine($cartId, ['item_id' => 102, 'quantity' => 1, 'rate' => 200, 'estimated_tax_pc' => 0]);

    $moving = [];
    foreach ($carts->find($cartId)['lines'] as $line) {
        if ((int) $line['item_id'] === 102) {
            $moving[] = (int) $line['line_id'];
        }
    }

    $tables->split((int) $session['table_session_id'], ['line_ids' => $moving]);

    $rows = 0;
    foreach ($tables->floorPlan() as $floor) {
        foreach ($floor['tables'] as $table) {
            if ($table['table_id'] === $tableId) {
                $rows++;
                assertSame(2, $table['bill_count'], 'two bills');
                assertSame(2, $table['line_count'], 'across which there are two lines');
                assertSame(500.0, round((float) $table['running_total'], 2), 'and the table owes the sum of them');
            }
        }
    }
    assertSame(1, $rows, 'the table appears on the plan exactly once');
});

check('a saved layout keeps its coordinates and refuses two tables with one name', function () use ($ctx, $auth) {
    resetDatabase();
    [, $floorId, $tableId] = seedFloor($ctx, 'T1');
    $secondId = (int) Db::insert('pos_tables', [
        'cmp_id' => $ctx->cmpId, 'floor_id' => $floorId, 'table_code' => 'T2', 'seats' => 2,
    ], 'table_id');

    $tables = new TableService($ctx, $auth);
    $tables->saveLayout($floorId, ['tables' => [
        ['table_id' => $tableId, 'table_code' => 'T1', 'seats' => 4, 'zone_name' => 'Window', 'shape' => 'round', 'layout_x' => 1200, 'layout_y' => 3400],
        ['table_id' => $secondId, 'table_code' => 'T2', 'seats' => 2, 'layout_x' => 9999, 'layout_y' => 200],
    ]]);

    $saved = planTable($tables, $tableId);
    assertSame(1200, $saved['layout_x'], 'x');
    assertSame(3400, $saved['layout_y'], 'y');
    assertSame('round', $saved['shape'], 'shape');
    assertSame('Window', $saved['zone_name'], 'zone');

    assertThrows(
        fn () => $tables->saveLayout($floorId, ['tables' => [
            ['table_id' => $tableId, 'table_code' => 'T2'],
            ['table_id' => $secondId, 'table_code' => 'T2'],
        ]]),
        'both called T2',
        'two tables with one name is how a waiter serves the wrong party',
    );

    // Nothing was written: the clash was found before the first row moved.
    assertSame('T1', planTable($tables, $tableId)['table_code'], 'the refused save changed nothing');
});

check('two tables can swap names in one save', function () use ($ctx, $auth) {
    resetDatabase();
    [, $floorId, $tableId] = seedFloor($ctx, 'T1');
    $secondId = (int) Db::insert('pos_tables', [
        'cmp_id' => $ctx->cmpId, 'floor_id' => $floorId, 'table_code' => 'T2', 'seats' => 2,
    ], 'table_id');

    // The unique index is checked row by row, so a one-pass rename would fail
    // on the first table even though the finished layout is valid.
    $tables = new TableService($ctx, $auth);
    $tables->saveLayout($floorId, ['tables' => [
        ['table_id' => $tableId, 'table_code' => 'T2'],
        ['table_id' => $secondId, 'table_code' => 'T1'],
    ]]);

    assertSame('T2', planTable($tables, $tableId)['table_code'], 'the first took the second\'s name');
    assertSame('T1', planTable($tables, $secondId)['table_code'], 'and the second the first\'s');
});

check('a floor with a party on it will not be retired', function () use ($ctx, $auth) {
    resetDatabase();
    [$terminalId, $floorId, $tableId] = seedFloor($ctx);

    $tables = new TableService($ctx, $auth);
    $tables->open($tableId, ['terminal_id' => $terminalId]);

    assertThrows(fn () => $tables->deleteFloor($floorId), 'still a party', 'the room is in use');
});

check('a floor created with a quick setup comes back with its tables laid out', function () use ($ctx, $auth) {
    resetDatabase();
    [$locationId] = seedOutlet($ctx, 'restaurant');

    $tables = new TableService($ctx, $auth);
    $floor = $tables->createFloor([
        'location_id' => $locationId, 'floor_name' => 'Ground Floor',
        'description' => 'Main dining', 'floor_kind' => 'indoor',
        'table_count' => 8, 'seats' => 4, 'zone_name' => 'Main Dining',
    ]);

    assertSame('GF', $floor['floor_code'], 'a code derived from the name');

    $plan = $tables->floorPlan($locationId);
    assertSame(1, count($plan), 'one floor');
    assertSame(8, count($plan[0]['tables']), 'eight tables');
    assertSame('Main Dining', $plan[0]['tables'][0]['zone_name'], 'all in the named zone');
    assertTrue($plan[0]['tables'][0]['layout_x'] !== null, 'and each already has a place on the plan');
});


echo "\nReturns\n";

check('a counter return goes back to stock and raises a credit note', function () use ($ctx, $auth) {
    resetDatabase();
    [, $terminalId] = seedOutlet($ctx);
    $sessionId = openShift($ctx, $auth, $terminalId);
    $cart = seedCart($ctx, $auth, $terminalId, $sessionId);
    (new CheckoutService($ctx, $auth))->checkout((int) $cart['cart_id'], ['payments' => [['payment_mode' => 'cash', 'amount' => 519.2]]]);

    $returns = new ReturnService($ctx, $auth);
    $return = $returns->create([
        'cart_id'    => (int) $cart['cart_id'],
        'session_id' => $sessionId,
        'resolution' => 'refund_cash',
        'reason_code' => 'faulty',
        'lines' => [['item_id' => 101, 'return_qty' => 1, 'rate' => 120, 'display_name' => 'Stub item 101', 'warehouse_id' => 3]],
    ]);
    $returnId = (int) $return['return_id'];

    $returns->approve($returnId, ['note' => 'Manager approved']);
    $received = $returns->receive($returnId);
    assertTrue($received['inventory_document_uuid'] !== null, 'the goods went back to Inventory');

    $settled = $returns->settle($returnId);
    assertSame('SETTLED', $settled['status'], 'status');
    assertTrue($settled['books_credit_note_uuid'] !== null, 'Books raised the credit');

    $session = (new RegisterService($ctx, $auth))->find($sessionId);
    assertSame(2399.2, round($session['expected_cash'], 2), 'and the cash left the drawer');
});

check('more cannot come back than went out', function () use ($ctx, $auth) {
    resetDatabase();
    [, $terminalId] = seedOutlet($ctx);
    $sessionId = openShift($ctx, $auth, $terminalId);
    $cart = seedCart($ctx, $auth, $terminalId, $sessionId);
    (new CheckoutService($ctx, $auth))->checkout((int) $cart['cart_id'], ['payments' => [['payment_mode' => 'cash', 'amount' => 519.2]]]);

    $returns = new ReturnService($ctx, $auth);
    $returns->create([
        'cart_id' => (int) $cart['cart_id'], 'reason_code' => 'faulty',
        'lines' => [['item_id' => 101, 'return_qty' => 2, 'rate' => 120, 'display_name' => 'Stub item 101']],
    ]);

    assertThrows(
        fn () => $returns->create([
            'cart_id' => (int) $cart['cart_id'], 'reason_code' => 'faulty',
            'lines' => [['item_id' => 101, 'return_qty' => 1, 'rate' => 120, 'display_name' => 'Stub item 101']],
        ]),
        'can still come back',
        'two were sold and two are already back',
    );
});

check('a return against an unfinished sale is refused', function () use ($ctx, $auth) {
    resetDatabase();
    [, $terminalId] = seedOutlet($ctx);
    $sessionId = openShift($ctx, $auth, $terminalId);
    $cart = seedCart($ctx, $auth, $terminalId, $sessionId);

    assertThrows(
        fn () => (new ReturnService($ctx, $auth))->create([
            'cart_id' => (int) $cart['cart_id'], 'reason_code' => 'faulty',
            'lines' => [['item_id' => 101, 'return_qty' => 1, 'rate' => 120]],
        ]),
        'never went through',
        'you cannot return something that was not sold',
    );
});

check('the register and the figures above it are built from one filter', function () use ($ctx, $auth) {
    resetDatabase();
    [, $terminalId] = seedOutlet($ctx);
    $sessionId = openShift($ctx, $auth, $terminalId);
    $cart = seedCart($ctx, $auth, $terminalId, $sessionId);
    $cartId = (int) $cart['cart_id'];
    (new CheckoutService($ctx, $auth))->checkout($cartId, ['payments' => [['payment_mode' => 'cash', 'amount' => 519.2]]]);
    Db::update('pos_carts', ['customer_name' => 'Amit Sharma'], ['cart_id' => $cartId, 'cmp_id' => $ctx->cmpId]);

    $returns = new ReturnService($ctx, $auth);
    $returns->create([
        'cart_id' => $cartId, 'session_id' => $sessionId, 'resolution' => 'refund_cash', 'reason_code' => 'size_fit',
        'lines' => [['item_id' => 101, 'return_qty' => 1, 'rate' => 120, 'display_name' => 'Stub item 101']],
    ]);
    $returns->create([
        'cart_id' => $cartId, 'session_id' => $sessionId, 'resolution' => 'exchange', 'reason_code' => 'damaged',
        'lines' => [['item_id' => 102, 'return_qty' => 1, 'rate' => 200, 'display_name' => 'Stub item 102']],
    ]);

    [$rows, $total] = $returns->listReturns([], 50, 0);
    assertSame(2, $total, 'both returns are in the register');
    assertSame('Amit Sharma', $rows[0]['customer_name'], 'the customer is read from the sale, not copied onto the return');
    assertSame('retail', $rows[0]['order_kind'], 'and so is the channel');
    assertSame(1, $rows[0]['line_count'], 'the line count is aggregated on the server');

    [, $exchanges] = $returns->listReturns(['resolution' => 'exchange'], 50, 0);
    assertSame(1, $exchanges, 'the type filter narrows to exchanges');

    [, $searched] = $returns->listReturns(['search' => 'Stub item 102'], 50, 0);
    assertSame(1, $searched, 'search reaches the items that came back');

    [, $byCustomer] = $returns->listReturns(['search' => 'Amit'], 50, 0);
    assertSame(2, $byCustomer, 'and the customer on the original sale');

    $summary = $returns->summary([]);
    assertSame(2, $summary['kpis']['total_returns'], 'the KPI counts the same rows the register does');
    assertSame(320.0, $summary['kpis']['return_value'], 'value credited');
    assertSame(2.0, $summary['kpis']['items_returned'], 'quantity across every returned line');
    assertSame(50.0, $summary['kpis']['exchange_ratio_pc'], 'one of the two was an exchange');
    assertSame(1, $summary['register_counts']['exchanges'], 'the Exchanges tab count');
    assertSame(1, $summary['register_counts']['refunds'], 'the Refunds tab count');
    assertSame(2, $summary['register_counts']['pending'], 'neither has been settled');

    assertSame(2, count($summary['reasons']), 'both reasons are counted');
    assertSame(50.0, $summary['reasons'][0]['share_pc'], 'each reason took half the items');
    assertSame('retail', $summary['channels'][0]['channel'], 'both came off in-store sales');
    assertSame(100.0, $summary['channels'][0]['share_pc'], 'which is all of them');
});

check('an empty window reports no exchange rate rather than nought per cent', function () use ($ctx, $auth) {
    resetDatabase();
    seedOutlet($ctx);

    $summary = (new ReturnService($ctx, $auth))->summary([]);
    assertSame(0, $summary['kpis']['total_returns'], 'nothing came back');
    assertSame(null, $summary['kpis']['exchange_ratio_pc'], 'and no share is asserted on nothing');
    assertSame([], $summary['reasons'], 'no reasons to attribute');
});

check('the trend has a point for every day, and compares against the window before it', function () use ($ctx, $auth) {
    resetDatabase();
    seedOutlet($ctx);

    $to = gmdate('Y-m-d');
    $from = gmdate('Y-m-d', strtotime($to . ' -6 days'));

    $summary = (new ReturnService($ctx, $auth))->summary(['from' => $from, 'to' => $to]);

    assertSame(7, count($summary['trend']), 'seven days, including the quiet ones');
    assertSame($from, $summary['trend'][0]['date'], 'starting on the first day of the window');
    assertSame(0, $summary['trend'][0]['return_count'], 'a day with nothing is a zero, not a missing point');

    assertSame(7, $summary['comparison_window']['days'], 'the comparison window is the same length');
    assertSame(gmdate('Y-m-d', strtotime($from . ' -1 day')), $summary['comparison_window']['to'], 'and ends the day before this one starts');
});

check('what the till offers to return is what the server will accept', function () use ($ctx, $auth) {
    resetDatabase();
    [, $terminalId] = seedOutlet($ctx);
    $sessionId = openShift($ctx, $auth, $terminalId);
    $cart = seedCart($ctx, $auth, $terminalId, $sessionId);
    $cartId = (int) $cart['cart_id'];
    (new CheckoutService($ctx, $auth))->checkout($cartId, ['payments' => [['payment_mode' => 'cash', 'amount' => 519.2]]]);

    $returns = new ReturnService($ctx, $auth);

    $before = $returns->eligibility($cartId);
    assertTrue($before['returnable'], 'a completed sale can be returned against');
    assertSame(3, count($before['lines']) + 1, 'both sold lines are offered');
    $item101 = array_values(array_filter($before['items'], static fn (array $i) => $i['item_id'] === 101))[0];
    assertSame(2.0, $item101['returnable_qty'], 'two were sold and none has come back');

    $returns->create([
        'cart_id' => $cartId, 'reason_code' => 'damaged',
        'lines' => [['item_id' => 101, 'return_qty' => 1, 'rate' => 120, 'display_name' => 'Stub item 101']],
    ]);

    $after = $returns->eligibility($cartId);
    $item101 = array_values(array_filter($after['items'], static fn (array $i) => $i['item_id'] === 101))[0];
    assertSame(1.0, $item101['returnable_qty'], 'one is left');
    assertSame(1, count($after['returns']), 'and the earlier return is listed against the sale');

    // The screen and the server must agree: one more is fine, two is refused.
    assertThrows(
        fn () => $returns->create([
            'cart_id' => $cartId, 'reason_code' => 'damaged',
            'lines' => [['item_id' => 101, 'return_qty' => 2, 'rate' => 120, 'display_name' => 'Stub item 101']],
        ]),
        'can still come back',
        'asking for more than eligibility offered is refused',
    );
});

check('a return with no linked sale is labelled as one, not counted as a walk-in', function () use ($ctx, $auth) {
    resetDatabase();
    [, $terminalId] = seedOutlet($ctx);
    openShift($ctx, $auth, $terminalId);

    $returns = new ReturnService($ctx, $auth);
    $returns->create([
        'terminal_id' => $terminalId,
        'reason_note' => 'Paper invoice from the old till',
        'lines' => [['item_id' => 101, 'return_qty' => 1, 'rate' => 120, 'display_name' => 'Stub item 101']],
    ]);

    $summary = $returns->summary([]);
    assertSame(ReturnService::CHANNEL_UNLINKED, $summary['channels'][0]['channel'], 'no sale means no channel, and it says so');
    assertSame(ReturnService::REASON_UNSPECIFIED, $summary['reasons'][0]['reason_code'], 'no reason code means unspecified, counted rather than hidden');

    [$rows] = $returns->listReturns([], 50, 0);
    assertSame(null, $rows[0]['customer_name'], 'and there is no customer to read');
});

check('the detail carries the sale and the till without storing either', function () use ($ctx, $auth) {
    resetDatabase();
    [, $terminalId] = seedOutlet($ctx);
    $sessionId = openShift($ctx, $auth, $terminalId);
    $cart = seedCart($ctx, $auth, $terminalId, $sessionId);
    $cartId = (int) $cart['cart_id'];
    (new CheckoutService($ctx, $auth))->checkout($cartId, ['payments' => [['payment_mode' => 'cash', 'amount' => 519.2]]]);
    Db::update('pos_carts', ['customer_name' => 'Priya Mehta'], ['cart_id' => $cartId, 'cmp_id' => $ctx->cmpId]);

    $returns = new ReturnService($ctx, $auth);
    $return = $returns->create([
        'cart_id' => $cartId, 'session_id' => $sessionId, 'terminal_id' => $terminalId, 'reason_code' => 'size_fit',
        'lines' => [['item_id' => 101, 'return_qty' => 1, 'rate' => 120, 'display_name' => 'Stub item 101']],
    ]);

    assertSame('Priya Mehta', $return['context']['customer_name'], 'the customer is joined at read time');
    assertSame('T1', $return['context']['terminal_code'], 'and so is the till');
    assertSame('retail', $return['context']['channel'], 'and the channel of the original sale');
    assertSame(null, $return['context']['exchange_sale'], 'nothing was exchanged, so nothing is invented');

    // Renaming the till renames it on the return too, which is the point of
    // joining rather than copying.
    Db::update('pos_terminals', ['terminal_code' => 'T9'], ['terminal_id' => $terminalId, 'cmp_id' => $ctx->cmpId]);
    $again = $returns->find((int) $return['return_id']);
    assertSame('T9', $again['context']['terminal_code'], 'the return followed the rename');
});

echo "\nAudit\n";

check('the audit log cannot be edited or deleted', function () use ($ctx, $auth) {
    resetDatabase();
    [, $terminalId] = seedOutlet($ctx);
    openShift($ctx, $auth, $terminalId);

    $auditId = (int) Db::scalar('SELECT audit_id FROM pos_audit_log ORDER BY audit_id LIMIT 1');
    assertTrue($auditId > 0, 'something was audited');

    assertThrows(
        fn () => Db::run('UPDATE pos_audit_log SET action = :a WHERE audit_id = :id', ['a' => 'tampered', 'id' => $auditId]),
        '',
        'UPDATE on the audit log is refused by the database',
    );
    assertThrows(
        fn () => Db::run('DELETE FROM pos_audit_log WHERE audit_id = :id', ['id' => $auditId]),
        '',
        'DELETE on the audit log is refused by the database',
    );
});

// ---------------------------------------------------------------------------
// RELEASE-BLOCKING: data ownership
//
// These read the real schema. If someone adds a table that mirrors another
// product's data, or a column that caches a master or stores a balance another
// product owns, these go red and the build stops.
// ---------------------------------------------------------------------------

echo "\nCompany access\n";

check('a company owner gets their permissions even though the portal never said they were one', function () use ($ctx) {
    resetDatabase();
    seedOutlet($ctx);
    Permissions::seed($ctx);
    stubOwnership('owner');

    // Exactly what a real sign-in produces: validatesession answered about the
    // user and said nothing about this company.
    $owner = unknownAuth('user-real-owner');
    assertSame(null, $owner->accessType(), 'the portal reported no access type');
    assertSame([], Permissions::granted($ctx, $owner), 'and so this person has nothing yet');

    // The tenant check runs on every scoped endpoint and already holds Manage's
    // company row. Reading ownership out of it is what was missing.
    $ctx->assertAllowed($owner);

    assertSame(1, $owner->accessType(), 'Manage says they own the company');
    assertSame(Permissions::all(), Permissions::granted($ctx, $owner), 'so they hold every permission');
    assertTrue(Permissions::allows($ctx, $owner, 'terminal.manage'), 'including the one that reaches Setup');
    assertTrue(Permissions::allows($ctx, $owner, 'access.manage'), 'and the one that grants roles to everyone else');
});

check('a delegated user is not promoted, and keeps only what they were assigned', function () use ($ctx) {
    resetDatabase();
    seedOutlet($ctx);
    Permissions::seed($ctx);
    stubOwnership('shared');

    $user = unknownAuth('user-delegated');
    $ctx->assertAllowed($user);

    assertSame(0, $user->accessType(), 'Manage says they do not own the company');
    assertSame([], Permissions::granted($ctx, $user), 'and nobody has given them a role');

    // Give them the cashier role the way an owner would.
    $profileId = (int) Db::scalar(
        'SELECT profile_id FROM pos_permission_profiles WHERE cmp_id = :cmp AND profile_code = :code',
        ['cmp' => $ctx->cmpId, 'code' => 'cashier'],
    );
    Db::insert('pos_permission_assignments', [
        'cmp_id' => $ctx->cmpId, 'user_uuid' => $user->uuid, 'profile_id' => $profileId,
    ], 'assignment_id');

    $r = new \ReflectionClass(Permissions::class);
    $p = $r->getProperty('cache');
    $p->setAccessible(true);
    $p->setValue(null, []);

    assertTrue(Permissions::allows($ctx, $user, 'sell'), 'a cashier may sell');
    assertSame(false, Permissions::allows($ctx, $user, 'access.manage'), 'and may not hand out roles');
});

check('promotion only ever upgrades, so a bad answer from Manage cannot demote an owner', function () use ($ctx) {
    forgetContextMemo();
    stubOwnership('shared');

    $owner = ownerAuth();
    assertSame(1, $owner->accessType(), 'starts as an owner');
    $ctx->assertAllowed($owner);
    assertSame(1, $owner->accessType(), 'and is still an owner after Manage said otherwise');

    // An unrecognised shape resolves to null and changes nothing either.
    forgetContextMemo();
    stubOwnership('something-new-manage-started-sending');
    $unknown = unknownAuth('user-unreadable');
    $ctx->assertAllowed($unknown);
    assertSame(null, $unknown->accessType(), 'an unreadable answer leaves the session alone');
});

check('the promotion survives the memo, so the second request of a session gets it too', function () use ($ctx) {
    forgetContextMemo();
    stubOwnership('owner');

    // First request warms Context's memo.
    $first = unknownAuth('user-same-person');
    $ctx->assertAllowed($first);
    assertSame(1, $first->accessType(), 'the first request promotes');

    // The next request builds a fresh Auth for the same session and takes the
    // memo's early return. Before the memo carried the access type, this is
    // where the promotion silently stopped.
    $second = unknownAuth('user-same-person');
    assertSame(null, $second->accessType(), 'a fresh Auth starts unpromoted');
    $ctx->assertAllowed($second);
    assertSame(1, $second->accessType(), 'and is promoted from the memo, with no second call to Manage');
});

echo "\nDashboards\n";

check('the drawer formula: float 2000 + sales 16500 - refunds 700 - payouts 500 - drops 8000 = 9300', function () use ($ctx, $auth) {
    resetDatabase();
    [, $terminalId] = seedOutlet($ctx);
    $sessionId = openShift($ctx, $auth, $terminalId, 2000.0);

    // Cash taken on sales, as the drawer sees it: one event for the net cash.
    Db::insert('pos_cash_drawer_events', [
        'session_id' => $sessionId, 'cmp_id' => $ctx->cmpId,
        'event_kind' => 'sale_tender', 'amount' => 16500, 'reason' => 'fixture', 'actor_uuid' => $auth->uuid,
    ], 'event_id');
    Db::insert('pos_cash_drawer_events', [
        'session_id' => $sessionId, 'cmp_id' => $ctx->cmpId,
        'event_kind' => 'refund', 'amount' => 700, 'reason' => 'fixture', 'actor_uuid' => $auth->uuid,
    ], 'event_id');
    Db::insert('pos_cash_drawer_events', [
        'session_id' => $sessionId, 'cmp_id' => $ctx->cmpId,
        'event_kind' => 'cash_out', 'amount' => 500, 'reason' => 'fixture', 'actor_uuid' => $auth->uuid,
    ], 'event_id');
    Db::insert('pos_cash_drawer_events', [
        'session_id' => $sessionId, 'cmp_id' => $ctx->cmpId,
        'event_kind' => 'safe_drop', 'amount' => 8000, 'reason' => 'fixture', 'actor_uuid' => $auth->uuid,
    ], 'event_id');

    $board = (new ControlsBoard(dashboardWindow($ctx, $auth)))->build();

    assertSame(2000.0,  $board['cash']['opening_float'], 'opening float');
    assertSame(16500.0, $board['cash']['cash_sales'], 'cash sales');
    assertSame(700.0,   $board['cash']['cash_refunds'], 'cash refunds');
    assertSame(500.0,   $board['cash']['cash_payouts'], 'cash payouts');
    assertSame(8000.0,  $board['cash']['cash_drops'], 'cash drops');
    assertSame(9300.0,  $board['cash']['expected_cash'], 'expected cash');
    // Nothing counted yet, so there is no variance to report.
    assertSame(null, $board['cash']['counted_cash'], 'counted cash before the count');
    assertSame(null, $board['cash']['variance'], 'variance before the count');
});

check('counting 9200 against that drawer is a 100 shortage, not a 100 surplus', function () use ($ctx, $auth) {
    $sessionId = (int) Db::scalar('SELECT session_id FROM pos_register_sessions WHERE cmp_id = :cmp ORDER BY session_id DESC LIMIT 1', ['cmp' => $ctx->cmpId]);

    // Bring the running total in line with the fixture events before closing:
    // the till maintains it incrementally and the fixture wrote events directly.
    Db::run('UPDATE pos_register_sessions SET expected_cash = 9300 WHERE session_id = :id', ['id' => $sessionId]);

    (new RegisterService($ctx, $auth))->close($sessionId, [
        'counted_cash' => 9200, 'variance_reason' => 'Counted twice, still short.',
    ]);

    $board = (new ControlsBoard(dashboardWindow($ctx, $auth)))->build();

    assertSame(9300.0, $board['cash']['expected_cash'], 'expected cash after close');
    assertSame(9200.0, $board['cash']['counted_cash'], 'counted cash');
    assertSame(-100.0, $board['cash']['variance'], 'variance is a shortage');
    assertTrue($board['cash']['reconciles'], 'the recomputed drawer matches the running total');

    $shift = $board['shifts'][0];
    assertSame(-100.0, $shift['variance'], 'the shift row carries the same variance');
    assertSame('approved', $shift['review_state'], 'a variance the closer approved is approved, not pending');
});

check('a split tender puts only its cash half in the drawer', function () use ($ctx, $auth) {
    resetDatabase();
    [, $terminalId] = seedOutlet($ctx);
    $sessionId = openShift($ctx, $auth, $terminalId, 1000.0);
    $cart = seedCart($ctx, $auth, $terminalId, $sessionId);

    $total = (float) $cart['total_amount'];
    $cash  = 100.0;
    (new CheckoutService($ctx, $auth))->checkout((int) $cart['cart_id'], [
        'payments' => [
            ['payment_mode' => 'card', 'amount' => round($total - $cash, 2), 'reference' => '4321'],
            ['payment_mode' => 'cash', 'amount' => $cash, 'tendered' => 200, 'change_given' => 100],
        ],
    ]);

    $board = (new ControlsBoard(dashboardWindow($ctx, $auth)))->build();

    // 100 taken, 100 given back as change: nothing net entered the drawer.
    assertSame(0.0, $board['cash']['cash_sales'], 'cash sales are net of change');
    assertSame(1000.0, $board['cash']['expected_cash'], 'the card half never touches the drawer');

    $modes = [];
    foreach ($board['tenders']['lines'] as $line) {
        $modes[$line['payment_mode']] = $line;
    }
    assertSame(Tenders::COLLECTED, $modes['cash']['settlement_state'], 'cash is collected');
    assertSame(Tenders::RECORDED, $modes['card']['settlement_state'], 'card is recorded, never confirmed');
    assertSame(null, $modes['card']['provider_confirmed'], 'there is no provider-confirmed figure to show');
    assertSame(false, $board['tenders']['provider']['available'], 'no payment provider is integrated');
});

check('the overview counts completed bills, excludes voids and keeps returns separate', function () use ($ctx, $auth) {
    resetDatabase();
    [, $terminalId] = seedOutlet($ctx);
    $sessionId = openShift($ctx, $auth, $terminalId, 500.0);

    $paid = seedCart($ctx, $auth, $terminalId, $sessionId);
    (new CheckoutService($ctx, $auth))->checkout((int) $paid['cart_id'], [
        'payments' => [['payment_mode' => 'cash', 'amount' => (float) $paid['total_amount']]],
    ]);

    $voided = seedCart($ctx, $auth, $terminalId, $sessionId);
    (new CartService($ctx, $auth))->void((int) $voided['cart_id'], ['reason' => 'Customer changed their mind']);

    $board = (new OverviewBoard(dashboardWindow($ctx, $auth)))->build();

    assertSame(1, $board['sales']['bills'], 'one completed bill');
    assertSame(round((float) $paid['total_amount'], 4), round($board['sales']['net'], 4), 'net sales is the completed bill');
    assertSame(0.0, $board['sales']['returns_value'], 'no returns yet');
    assertSame(0, $board['sales']['returns_count'], 'no returns yet');
    // A void is an exception, not a negative sale.
    assertSame(1, (int) Db::scalar("SELECT COUNT(*) FROM pos_carts WHERE cmp_id = :cmp AND status = 'VOID'", ['cmp' => $ctx->cmpId]), 'the void is still on the record');
    assertSame(false, $board['insights']['ai']['available'], 'nothing claims to be AI');
    foreach ($board['insights']['items'] as $item) {
        assertSame('rule', $item['kind'], 'every brief item is labelled rule-based');
    }
});

check('another company\'s takings never appear on this one\'s board', function () use ($ctx, $auth) {
    resetDatabase();
    [, $terminalId] = seedOutlet($ctx);
    $sessionId = openShift($ctx, $auth, $terminalId, 0.0);
    $mine = seedCart($ctx, $auth, $terminalId, $sessionId);
    (new CheckoutService($ctx, $auth))->checkout((int) $mine['cart_id'], [
        'payments' => [['payment_mode' => 'cash', 'amount' => (float) $mine['total_amount']]],
    ]);

    // A second company, trading on its own tills.
    $other = freshContext(99, 5, 0);
    [, $otherTerminal] = (function () use ($other) {
        $locationId = (int) Db::insert('pos_location_profiles', [
            'cmp_id' => $other->cmpId, 'bo_id' => 0, 'location_code' => 'OTHER',
            'display_name' => 'Somebody else', 'pos_mode' => 'retail',
        ], 'location_id');
        $terminalId = (int) Db::insert('pos_terminals', [
            'cmp_id' => $other->cmpId, 'location_id' => $locationId, 'terminal_code' => 'X1',
        ], 'terminal_id');

        return [$locationId, $terminalId];
    })();
    $otherSession = openShift($other, $auth, $otherTerminal, 7777.0);
    $theirs = seedCart($other, $auth, $otherTerminal, $otherSession);
    (new CheckoutService($other, $auth))->checkout((int) $theirs['cart_id'], [
        'payments' => [['payment_mode' => 'cash', 'amount' => (float) $theirs['total_amount']]],
    ]);

    $board = (new OverviewBoard(dashboardWindow($ctx, $auth)))->build();
    assertSame(1, $board['sales']['bills'], 'only this company\'s bill is counted');

    $controls = (new ControlsBoard(dashboardWindow($ctx, $auth)))->build();
    assertSame(0.0, $controls['cash']['opening_float'], 'the other company\'s float is not in this drawer');
    foreach ($controls['shifts'] as $shift) {
        assertTrue($shift['session_id'] !== $otherSession, 'the other company\'s shift is not listed');
    }

    $retail = (new RetailBoard(dashboardWindow($ctx, $auth)))->build();
    foreach ($retail['counters'] as $counter) {
        assertTrue($counter['terminal_id'] !== $otherTerminal, 'the other company\'s till is not listed');
    }
});

check('a cashier is refused the boards that need reports.view', function () use ($ctx) {
    resetDatabase();
    seedOutlet($ctx);
    Permissions::seed($ctx);
    $cashier = cashierAuth();

    $profileId = (int) Db::scalar(
        'SELECT profile_id FROM pos_permission_profiles WHERE cmp_id = :cmp AND profile_code = :code',
        ['cmp' => $ctx->cmpId, 'code' => 'cashier'],
    );
    Db::insert('pos_permission_assignments', [
        'cmp_id' => $ctx->cmpId, 'user_uuid' => $cashier->uuid, 'profile_id' => $profileId,
    ], 'assignment_id');

    assertSame(false, Permissions::allows($ctx, $cashier, 'reports.view'), 'a cashier has no reports.view');
    assertThrows(
        static fn () => Permissions::assert($ctx, $cashier, 'reports.view'),
        'cannot',
        'the permission gate the overview and customers boards call refuses a cashier',
    );
    // And the one a cashier DOES have, which is why Retail and Controls let
    // them in at all.
    assertTrue(Permissions::allows($ctx, $cashier, 'sell'), 'a cashier may sell');
    assertTrue(Permissions::allows($ctx, $cashier, 'shift.close'), 'a cashier may close their own till');
});

check('a cashier on the controls board sees their own shift and nobody else\'s', function () use ($ctx, $auth) {
    resetDatabase();
    [, $terminalId] = seedOutlet($ctx);
    Permissions::seed($ctx);

    $cashier = cashierAuth();
    $profileId = (int) Db::scalar(
        'SELECT profile_id FROM pos_permission_profiles WHERE cmp_id = :cmp AND profile_code = :code',
        ['cmp' => $ctx->cmpId, 'code' => 'cashier'],
    );
    Db::insert('pos_permission_assignments', [
        'cmp_id' => $ctx->cmpId, 'user_uuid' => $cashier->uuid, 'profile_id' => $profileId,
    ], 'assignment_id');

    $ownersShift = openShift($ctx, $auth, $terminalId, 3000.0);
    (new RegisterService($ctx, $auth))->close($ownersShift, ['counted_cash' => 3000]);

    $theirShift = openShift($ctx, $cashier, $terminalId, 250.0);

    $window = dashboardWindow($ctx, $cashier);
    assertSame(false, $window->seesEveryone, 'a cashier does not see every till');

    $board = (new ControlsBoard($window))->build();
    $ids = array_map(static fn (array $s): int => $s['session_id'], $board['shifts']);
    assertSame([$theirShift], $ids, 'only the cashier\'s own shift');
    assertSame(250.0, $board['cash']['opening_float'], 'and only their own drawer');

    // The manager sees both.
    $managerBoard = (new ControlsBoard(dashboardWindow($ctx, $auth)))->build();
    assertSame(2, count($managerBoard['shifts']), 'the manager sees both shifts');
});

check('a business day that starts at 6am keeps last night\'s takings on last night', function () use ($ctx, $auth) {
    resetDatabase();
    [$locationId, $terminalId] = seedOutlet($ctx);
    Db::update('pos_location_profiles', [
        'trading_timezone' => 'Asia/Kolkata', 'day_start_minutes' => 360,
    ], ['location_id' => $locationId, 'cmp_id' => $ctx->cmpId]);

    $sessionId = openShift($ctx, $auth, $terminalId, 0.0);
    $cart = seedCart($ctx, $auth, $terminalId, $sessionId);
    (new CheckoutService($ctx, $auth))->checkout((int) $cart['cart_id'], [
        'payments' => [['payment_mode' => 'cash', 'amount' => (float) $cart['total_amount']]],
    ]);

    // 2026-03-11 01:30 Asia/Kolkata = 2026-03-10 20:00 UTC. With a 6am day
    // start that sale belongs to the business date 2026-03-10.
    Db::run("UPDATE pos_carts SET created_at = TIMESTAMPTZ '2026-03-10 20:00:00+00' WHERE cart_id = :id", ['id' => (int) $cart['cart_id']]);

    $onTheNight = (new OverviewBoard(dashboardWindow($ctx, $auth, [
        'location_id' => $locationId, 'from' => '2026-03-10', 'to' => '2026-03-10',
    ])))->build();
    assertSame(1, $onTheNight['sales']['bills'], 'the sale is on the night it was taken');

    $theNextMorning = (new OverviewBoard(dashboardWindow($ctx, $auth, [
        'location_id' => $locationId, 'from' => '2026-03-11', 'to' => '2026-03-11',
    ])))->build();
    assertSame(0, $theNextMorning['sales']['bills'], 'and not on the calendar day the clock rolled into');
});

check('the retail board keeps a held bill visible however the date filter moves', function () use ($ctx, $auth) {
    resetDatabase();
    [, $terminalId] = seedOutlet($ctx);
    $sessionId = openShift($ctx, $auth, $terminalId, 0.0);
    $cart = seedCart($ctx, $auth, $terminalId, $sessionId);
    (new CartService($ctx, $auth))->hold((int) $cart['cart_id'], ['hold_label' => 'Blue jacket']);

    // A window that contains none of today.
    $board = (new RetailBoard(dashboardWindow($ctx, $auth, ['from' => '2020-01-01', 'to' => '2020-01-02'])))->build();

    assertSame(1, $board['kpis']['held_bills'], 'a held bill is on the counter whatever the date filter says');
    assertSame('Blue jacket', $board['held_bills'][0]['reference'], 'and is findable by what the cashier labelled it');
    assertSame(0, $board['kpis']['bills'], 'while the sales figures do respect the window');
});

check('device health is reported as configuration, never as a live connection', function () use ($ctx, $auth) {
    $board = (new RetailBoard(dashboardWindow($ctx, $auth)))->build();

    assertSame('not_verified', $board['devices']['verification'], 'the panel says it has not verified anything');
    $terminal = $board['devices']['terminals'][0];
    foreach ($terminal['peripherals'] as $peripheral) {
        assertTrue(
            in_array($peripheral['state'], ['configured', 'not_configured'], true),
            'a peripheral is configured or not — never "connected": ' . $peripheral['state'],
        );
    }
});

check('an unreachable Inventory is reported as unknown stock, not as nothing being low', function () use ($ctx, $auth) {
    stubFail('replenishment', 503);
    try {
        $board = (new RetailBoard(dashboardWindow($ctx, $auth)))->build();
    } finally {
        stubRecover();
    }

    assertSame(false, $board['stock']['available'], 'the panel says the answer is unknown');
    assertSame('inventory_unavailable', $board['stock']['reason'], 'and why');
    assertSame([], $board['stock']['items'], 'with no invented items');
});

check('margin is withheld from someone who may not see it', function () use ($ctx) {
    $cashier = cashierAuth();
    $board = (new OverviewBoard(dashboardWindow($ctx, $cashier)))->build();

    assertSame(false, $board['margin']['available'], 'no margin for a cashier');
    assertSame('not_permitted', $board['margin']['reason'], 'and the reason is the permission, not a missing cost');
    assertTrue(!array_key_exists('gross_margin', $board['margin']), 'the figure is absent, not zeroed');
});

check('margin for someone who may see it is revenue minus Inventory\'s cost, never minus the sale price', function () use ($ctx, $auth) {
    resetDatabase();
    [, $terminalId] = seedOutlet($ctx);
    $sessionId = openShift($ctx, $auth, $terminalId, 0.0);

    // Two units at 1000 and three at 500, the worked example from the brief.
    $carts = new CartService($ctx, $auth);
    $cart = $carts->open(['terminal_id' => $terminalId, 'session_id' => $sessionId, 'order_kind' => 'retail']);
    $cartId = (int) $cart['cart_id'];
    $carts->addLine($cartId, ['item_id' => 101, 'quantity' => 2, 'rate' => 1000, 'estimated_tax_pc' => 0]);
    $carts->addLine($cartId, ['item_id' => 102, 'quantity' => 3, 'rate' => 500, 'estimated_tax_pc' => 0]);
    $full = $carts->find($cartId);
    (new CheckoutService($ctx, $auth))->checkout($cartId, [
        'payments' => [['payment_mode' => 'cash', 'amount' => (float) $full['total_amount']]],
    ]);

    $board = (new OverviewBoard(dashboardWindow($ctx, $auth)))->build();

    assertSame(true, $board['margin']['available'], 'the owner may see margin');
    assertSame(3500.0, $board['margin']['revenue'], 'commercial value is 2x1000 + 3x500');
    // The stub prices every item at 80, so cost is 5 units x 80 = 400 — a
    // number that could only come from Inventory. Had the board used the sale
    // price as cost, revenue and cost would be equal and margin would be zero.
    assertSame(400.0, $board['margin']['cost'], 'cost comes from Inventory, not from the price charged');
    assertSame(3100.0, $board['margin']['gross_margin'], 'margin is revenue minus Inventory cost');
    assertTrue($board['margin']['cost'] !== $board['margin']['revenue'], 'selling price is never used as stock cost');
});

check('low stock comes from Inventory live and is marked as read, not stored', function () use ($ctx, $auth) {
    $board = (new RetailBoard(dashboardWindow($ctx, $auth)))->build();

    assertSame(true, $board['stock']['available'], 'Inventory answered');
    assertSame(2, count($board['stock']['items']), 'both low items are listed');
    assertSame('Classic Cola 500ml', $board['stock']['items'][0]['display_name'], 'named as Inventory named it');
    assertTrue(str_contains($board['stock']['source'], 'never stored'), 'and the panel says it is not kept');

    // The release-blocking ownership suite proves the general rule; this proves
    // the specific one: reading a stock figure did not write one.
    $stored = Db::all(
        "SELECT column_name FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'pos_cart_lines' AND column_name LIKE '%stock%'",
    );
    assertSame([], $stored, 'reading availability stored no stock column');
});

check('splitting a table preserves every quantity and the two bills add up to the one', function () use ($ctx, $auth) {
    resetDatabase();
    [$locationId, $terminalId] = seedOutlet($ctx, 'restaurant');
    $floorId = (int) Db::insert('pos_floors', [
        'cmp_id' => $ctx->cmpId, 'location_id' => $locationId, 'floor_code' => 'GF', 'floor_name' => 'Ground',
    ], 'floor_id');
    $tableId = (int) Db::insert('pos_tables', [
        'cmp_id' => $ctx->cmpId, 'floor_id' => $floorId, 'table_code' => 'T01', 'seats' => 4,
    ], 'table_id');

    $tables = new TableService($ctx, $auth);
    $session = $tables->open($tableId, ['covers' => 4, 'terminal_id' => $terminalId]);
    $sessionId = (int) $session['table_session_id'];
    $cartId = (int) Db::scalar(
        "SELECT cart_id FROM pos_carts WHERE cmp_id = :cmp AND table_session_id = :sid AND status <> 'VOID' ORDER BY cart_id LIMIT 1",
        ['cmp' => $ctx->cmpId, 'sid' => $sessionId],
    );

    $carts = new CartService($ctx, $auth);
    $carts->addLine($cartId, ['item_id' => 101, 'quantity' => 2, 'rate' => 150, 'estimated_tax_pc' => 5]);
    $carts->addLine($cartId, ['item_id' => 102, 'quantity' => 3, 'rate' => 80, 'estimated_tax_pc' => 5]);

    $before = $carts->find($cartId);
    $beforeTotal = round((float) $before['total_amount'], 4);
    $beforeQty = 0.0;
    $moving = [];
    foreach ($before['lines'] as $line) {
        $beforeQty += (float) $line['quantity'];
        if ((int) $line['item_id'] === 102) {
            $moving[] = (int) $line['line_id'];
        }
    }

    $tables->split($sessionId, ['line_ids' => $moving]);

    $carts2 = (new CartService($ctx, $auth));
    $rows = Db::all(
        "SELECT cart_id FROM pos_carts WHERE cmp_id = :cmp AND table_session_id = :sid AND status <> 'VOID' ORDER BY cart_id",
        ['cmp' => $ctx->cmpId, 'sid' => $sessionId],
    );
    assertSame(2, count($rows), 'a split leaves two bills on the table');

    $afterTotal = 0.0;
    $afterQty = 0.0;
    foreach ($rows as $row) {
        $cart = $carts2->find((int) $row['cart_id']);
        $afterTotal += (float) $cart['total_amount'];
        foreach ($cart['lines'] as $line) {
            $afterQty += (float) $line['quantity'];
        }
    }

    assertSame($beforeTotal, round($afterTotal, 4), 'the two bills add up to what the one was');
    assertSame($beforeQty, $afterQty, 'no quantity was created or lost in the split');
});

check('the restaurant board counts a table as occupied and its ticket as late by the station clock', function () use ($ctx, $auth) {
    $board = (new RestaurantBoard(dashboardWindow($ctx, $auth)))->build();

    assertSame(1, $board['kpis']['tables_occupied'], 'the split table is still occupied');
    assertSame(4, $board['kpis']['covers'], 'with its covers');
    assertSame('rule', $board['delays']['kind'], 'a delay is a timer, not a suggestion');
    assertTrue($board['floors'] !== [], 'the floor is drawn');
    assertSame('occupied', $board['floors'][0]['tables'][0]['state'], 'and the table reads occupied');
});

check('the restaurant board reports the flow, times a served ticket and says what it cannot know', function () use ($ctx, $auth) {
    resetDatabase();
    [$locationId, $terminalId] = seedOutlet($ctx, 'restaurant');
    openShift($ctx, $auth, $terminalId, 0.0);

    $floorId = (int) Db::insert('pos_floors', [
        'cmp_id' => $ctx->cmpId, 'location_id' => $locationId, 'floor_code' => 'GF', 'floor_name' => 'Ground',
    ], 'floor_id');
    $tableId = (int) Db::insert('pos_tables', [
        'cmp_id' => $ctx->cmpId, 'floor_id' => $floorId, 'table_code' => 'T01', 'seats' => 4,
    ], 'table_id');
    Db::insert('pos_tables', [
        'cmp_id' => $ctx->cmpId, 'floor_id' => $floorId, 'table_code' => 'T02', 'seats' => 2,
    ], 'table_id');

    // Ten minutes is this station's own patience, and the late figure is
    // measured against it rather than against one global number.
    $stationId = (int) Db::insert('pos_kds_stations', [
        'cmp_id' => $ctx->cmpId, 'location_id' => $locationId, 'station_code' => 'MAIN',
        'station_name' => 'Main kitchen', 'late_after_minutes' => 10,
    ], 'station_id');

    $tables = new TableService($ctx, $auth);
    $tableSession = $tables->open($tableId, ['covers' => 3, 'terminal_id' => $terminalId]);
    $tableSessionId = (int) $tableSession['table_session_id'];
    $cartId = (int) Db::scalar(
        "SELECT cart_id FROM pos_carts WHERE cmp_id = :cmp AND table_session_id = :sid AND status <> 'VOID' ORDER BY cart_id LIMIT 1",
        ['cmp' => $ctx->cmpId, 'sid' => $tableSessionId],
    );
    $carts = new CartService($ctx, $auth);
    $carts->addLine($cartId, ['item_id' => 101, 'quantity' => 2, 'rate' => 150, 'estimated_tax_pc' => 5]);
    $carts->addLine($cartId, ['item_id' => 102, 'quantity' => 1, 'rate' => 90, 'estimated_tax_pc' => 5]);

    // The clocks come from PostgreSQL rather than PHP so the interval the board
    // measures is exactly the interval this test asked for.
    $fire = static function (string $no, string $status, int $firedMinutesAgo, ?int $servedMinutesAgo) use ($ctx, $locationId, $cartId, $tableSessionId, $stationId): void {
        Db::run(
            "INSERT INTO pos_kots (cmp_id, fy_id, location_id, cart_id, table_session_id, station_id, kot_no, status, fired_by, fired_at, served_at)
             VALUES (:cmp, :fy, :loc, :cart, :ts, :st, :no, :status, 'tester',
                     NOW() - (:fired || ' minutes')::interval,
                     CASE WHEN :served::text IS NULL THEN NULL ELSE NOW() - (:served || ' minutes')::interval END)",
            [
                'cmp' => $ctx->cmpId, 'fy' => $ctx->fyId, 'loc' => $locationId, 'cart' => $cartId,
                'ts' => $tableSessionId, 'st' => $stationId, 'no' => $no, 'status' => $status,
                'fired' => (string) $firedMinutesAgo,
                'served' => $servedMinutesAgo === null ? null : (string) $servedMinutesAgo,
            ],
        );
    };

    $fire('KOT-1', 'NEW', 40, null);        // forty minutes out, ten allowed: late
    $fire('KOT-2', 'PREPARING', 2, null);   // two minutes out: fine
    $fire('KOT-3', 'SERVED', 30, 12);       // fired thirty ago, served twelve ago: eighteen minutes

    $board = (new RestaurantBoard(dashboardWindow($ctx, $auth, ['location_id' => $locationId])))->build();

    $flow = [];
    foreach ($board['flow']['stages'] as $stage) {
        $flow[$stage['key']] = $stage;
    }
    assertSame(1, $flow['received']['count'], 'the queued ticket is in Received');
    assertSame('live', $flow['received']['basis'], 'and Received is a live count');
    assertSame(1, $flow['in_kitchen']['count'], 'the cooking ticket is in the kitchen');
    assertSame(0, $flow['ready']['count'], 'nothing is waiting under the pass');
    assertSame(1, $flow['served']['count'], 'one ticket went out');
    assertSame('window', $flow['served']['basis'], 'and Served is the one figure the date filter moves');
    assertSame(1, $board['flow']['overdue'], 'one ticket is past its own station clock, not both');

    assertSame(true, $board['serve']['available'], 'a ticket was marked served, so there is a time to report');
    assertSame(1080, $board['serve']['average_seconds'], 'fired to served is eighteen minutes');
    assertSame(1, $board['serve']['sampled'], 'over one ticket, and the count is published beside the figure');
    assertSame(null, $board['serve']['change_pc'], 'nothing was served the day before, so there is no comparison');

    // The two figures POS cannot answer are gaps, never zeroes.
    assertSame(false, $board['rating']['available'], 'POS collects no guest feedback');
    assertSame('not_implemented', $board['rating']['reason'], 'and says why rather than showing a score');
    assertSame(null, $board['sales']['change_pc'], 'the day before took nothing, so there is no percentage');

    // Service is read from the tills and is not a switch this product has.
    assertSame('open', $board['service']['state'], 'a shift is open on a till here');
    assertSame(false, $board['service']['changeable'], 'and POS has no separate open/closed control');

    assertSame(true, $board['setup']['configured'], 'tables exist, so this is a restaurant with a quiet night');

    assertSame(1, count($board['orders']['items']), 'the seated table is the one order on the board');
    $order = $board['orders']['items'][0];
    assertSame('delayed', $order['state'], 'its state is derived from its own tickets, worst first');
    assertSame('T01', $order['table_code'], 'and it names the table');
    assertSame('running', $order['elapsed_basis'], 'an open order is timed as running, not as time taken');
    // Lines, not units, which is what the retail board's held bills count too.
    assertSame(2, $order['item_count'], 'with the two lines that are on it');

    // A table with no session is free, and the donut is drawn from these.
    assertSame(2, $board['kpis']['tables_total'], 'two tables');
    assertSame(1, $board['kpis']['tables_occupied'], 'one of them seated');
    assertSame(1, $board['kpis']['tickets_served'], 'and one ticket served today');
});

check('the customers board counts identified bills only, and says loyalty does not exist', function () use ($ctx, $auth) {
    resetDatabase();
    [, $terminalId] = seedOutlet($ctx);
    $sessionId = openShift($ctx, $auth, $terminalId, 0.0);

    // One anonymous sale, two for the same named customer.
    foreach ([null, 4242, 4242] as $accountId) {
        $carts = new CartService($ctx, $auth);
        $cart = $carts->open(array_filter([
            'terminal_id' => $terminalId, 'session_id' => $sessionId, 'order_kind' => 'retail',
            'customer_account_id' => $accountId,
        ], static fn ($v) => $v !== null));
        $cartId = (int) $cart['cart_id'];
        $carts->addLine($cartId, ['item_id' => 101, 'quantity' => 1, 'rate' => 100, 'estimated_tax_pc' => 0]);
        $full = $carts->find($cartId);
        (new CheckoutService($ctx, $auth))->checkout($cartId, [
            'payments' => [['payment_mode' => 'cash', 'amount' => (float) $full['total_amount']]],
        ]);
    }

    $board = (new CustomersBoard(dashboardWindow($ctx, $auth)))->build();

    assertSame(3, $board['coverage']['bills'], 'three bills');
    assertSame(2, $board['coverage']['identified_bills'], 'two of them identified');
    assertSame(1, $board['coverage']['anonymous_bills'], 'and one anonymous');
    assertSame(1, $board['kpis']['identified_customers'], 'one customer, who came twice');
    assertSame(1, $board['kpis']['new_customers'], 'new on this POS');
    assertSame(100.0, $board['kpis']['repeat_rate_pc'], 'and they repeated inside the window');
    assertSame(false, $board['loyalty']['available'], 'loyalty does not exist in this product');
    assertSame('not_implemented', $board['loyalty']['reason'], 'and the screen says why rather than showing a zero');
    assertSame(false, $board['offers']['available'], 'offer performance needs attribution POS does not have');
    assertSame(false, $board['suggestions']['sending']['available'], 'nothing here sends a campaign');
});

check('a dashboard refuses a date range longer than a year rather than scanning one', function () use ($ctx, $auth) {
    assertThrows(
        static fn () => dashboardWindow($ctx, $auth, ['from' => '2020-01-01', 'to' => '2026-01-01']),
        'longer than a year',
        'an unbounded range is refused',
    );
    assertThrows(
        static fn () => dashboardWindow($ctx, $auth, ['from' => 'last tuesday']),
        'looks like',
        'a date that is not a date is refused',
    );
});

check('the overview computes each shared aggregate once, not once per panel', function () use ($ctx, $auth) {
    resetDatabase();
    [, $terminalId] = seedOutlet($ctx);
    $sessionId = openShift($ctx, $auth, $terminalId, 0.0);
    $cart = seedCart($ctx, $auth, $terminalId, $sessionId);
    (new CheckoutService($ctx, $auth))->checkout((int) $cart['cart_id'], [
        'payments' => [['payment_mode' => 'cash', 'amount' => (float) $cart['total_amount']]],
    ]);

    $board = new OverviewBoard(dashboardWindow($ctx, $auth));
    $built = $board->build();

    // The briefing strip reads the same counts the KPI cards, the attention list
    // and the panels show. Each of those is an aggregate over pos_carts, and
    // computing them per panel meant several passes to draw one screen — the
    // rules that read a panel back (peak hour reads the series, the returns rule
    // reads the reason breakdown, the counter rule reads the till totals) would
    // each have re-run their query without this.
    $memo = new \ReflectionProperty(OverviewBoard::class, 'memo');
    $memo->setAccessible(true);
    $cached = array_keys($memo->getValue($board));
    sort($cached);
    assertSame(
        ['attention', 'comparison', 'counters', 'outlets', 'returns_voids', 'sales', 'series', 'top_items'],
        $cached,
        'the shared aggregates are computed once each',
    );

    // And the panels that read them agree, which is the point of computing once:
    // three separate passes could straddle a write and disagree.
    assertSame(1, $built['sales']['bills'], 'the KPI row');
    assertSame(0, $built['attention']['posting_failed'], 'the attention panel');
    assertTrue($built['insights']['sufficient_data'], 'and the brief built from the same counts');
});

check('the overview keeps a return and a void apart, and does not call a void money', function () use ($ctx, $auth) {
    resetDatabase();
    [, $terminalId] = seedOutlet($ctx);
    $sessionId = openShift($ctx, $auth, $terminalId, 500.0);

    $paid = seedCart($ctx, $auth, $terminalId, $sessionId);
    (new CheckoutService($ctx, $auth))->checkout((int) $paid['cart_id'], [
        'payments' => [['payment_mode' => 'cash', 'amount' => (float) $paid['total_amount']]],
    ]);

    $voided = seedCart($ctx, $auth, $terminalId, $sessionId);
    (new CartService($ctx, $auth))->void((int) $voided['cart_id'], ['reason' => 'billing_error']);

    (new ReturnService($ctx, $auth))->create([
        'cart_id'     => (int) $paid['cart_id'],
        'session_id'  => $sessionId,
        'resolution'  => 'refund_cash',
        'reason_code' => 'quality_issue',
        'lines' => [['item_id' => 101, 'return_qty' => 1, 'rate' => 120, 'display_name' => 'Stub item 101', 'warehouse_id' => 3]],
    ]);

    $board = (new OverviewBoard(dashboardWindow($ctx, $auth)))->build();
    $split = $board['returns_voids'];

    assertSame(1, count($split['returns']), 'one return reason');
    assertSame('quality_issue', $split['returns'][0]['reason'], 'the reason the cashier gave');
    assertSame('Quality issue', $split['returns'][0]['display_name'], 'said the way a cashier would say it');
    assertTrue($split['returns'][0]['amount_is_money'], 'a refund is money that moved');

    assertSame(1, count($split['voids']), 'one void reason');
    assertSame('billing_error', $split['voids'][0]['reason'], 'the void reason is kept, not merged into the returns');
    // THE POINT OF THE WHOLE BLOCK. A void cancelled a bill that was never
    // taken, so its value sizes the bill and is not money that went back. A
    // screen that totalled the two columns would report a refund figure that
    // reconciles against nothing.
    assertTrue($split['voids'][0]['amount_is_money'] === false, 'a void is not money that moved');

    assertSame(1, $split['totals']['returns_count'], 'returns are totalled on their own');
    assertSame(1, $split['totals']['voids_count'], 'and voids on their own');
});

check('the heatmap puts a sale in the hour of the clock and the day of the trading', function () use ($ctx, $auth) {
    resetDatabase();
    [, $terminalId] = seedOutlet($ctx);
    $sessionId = openShift($ctx, $auth, $terminalId, 500.0);
    $cart = seedCart($ctx, $auth, $terminalId, $sessionId);
    (new CheckoutService($ctx, $auth))->checkout((int) $cart['cart_id'], [
        'payments' => [['payment_mode' => 'cash', 'amount' => (float) $cart['total_amount']]],
    ]);

    $board = (new OverviewBoard(dashboardWindow($ctx, $auth)))->build();
    $cells = $board['activity']['cells'];

    assertSame(1, count($cells), 'one sale, one cell');
    assertSame(1, $cells[0]['bills'], 'counted once');

    $expected = new \DateTimeImmutable('now', new \DateTimeZone($board['activity']['timezone']));
    assertSame((int) $expected->format('H'), $cells[0]['hour'], 'the hour is the outlet\'s own wall clock');
    assertSame((int) $expected->format('N'), $cells[0]['dow'], 'and the day is ISO, Monday first');
});

check('an outlet id belonging to another company is a 404, not an empty board', function () use ($ctx, $auth) {
    $foreign = (int) Db::insert('pos_location_profiles', [
        'cmp_id' => 12345, 'bo_id' => 0, 'location_code' => 'THEIRS', 'display_name' => 'Not yours', 'pos_mode' => 'retail',
    ], 'location_id');

    assertThrows(
        static fn () => dashboardWindow($ctx, $auth, ['location_id' => $foreign]),
        'does not exist in this company',
        'a foreign outlet id is refused rather than silently returning nothing',
    );
});

echo "\nShift report\n";

check('the shift report counts this shift only, and zero is a figure rather than a gap', function () use ($ctx, $auth) {
    resetDatabase();
    [, $terminalId] = seedOutlet($ctx);

    // An earlier shift on the same till, closed. Its takings must not leak.
    $earlier = openShift($ctx, $auth, $terminalId, 100.0);
    $earlierCart = seedCart($ctx, $auth, $terminalId, $earlier);
    (new CheckoutService($ctx, $auth))->checkout((int) $earlierCart['cart_id'], [
        'payments' => [['payment_mode' => 'cash', 'amount' => (float) $earlierCart['total_amount']]],
    ]);
    (new RegisterService($ctx, $auth))->close($earlier, [
        'counted_cash' => 100.0 + (float) $earlierCart['total_amount'],
    ]);

    $sessionId = openShift($ctx, $auth, $terminalId, 500.0);
    $paid = seedCart($ctx, $auth, $terminalId, $sessionId);
    (new CheckoutService($ctx, $auth))->checkout((int) $paid['cart_id'], [
        'payments' => [['payment_mode' => 'cash', 'amount' => (float) $paid['total_amount']]],
    ]);
    $voided = seedCart($ctx, $auth, $terminalId, $sessionId);
    (new CartService($ctx, $auth))->void((int) $voided['cart_id'], ['reason' => 'Customer changed their mind']);

    $board = shiftBoard($ctx, $auth, ['session_id' => $sessionId])->build();

    assertSame($sessionId, $board['shift']['session_id'], 'the shift asked for');
    assertSame(1, $board['metrics']['bills'], 'one completed bill on THIS shift');
    assertSame(round((float) $paid['total_amount'], 4), round($board['metrics']['net_sales'], 4), 'net sales is this shift\'s bill');
    assertSame(1, $board['metrics']['voids'], 'the void is counted as an exception, not a sale');
    // Zero is a value. A shift that discounted nothing reads 0.00, never null.
    assertSame(0.0, $board['metrics']['discounts'], 'no discount given is zero, not missing');
    assertSame(0.0, $board['metrics']['refunds'], 'no refund is zero, not missing');
    assertSame('open', $board['shift']['state'], 'the till is still open');
});

check('an uncounted drawer has no variance, rather than a variance of zero', function () use ($ctx, $auth) {
    resetDatabase();
    [, $terminalId] = seedOutlet($ctx);
    $sessionId = openShift($ctx, $auth, $terminalId, 2000.0);

    $board = shiftBoard($ctx, $auth, ['session_id' => $sessionId])->build();

    assertSame(2000.0, $board['cash']['expected'], 'the float is what the drawer should hold');
    assertSame(null, $board['cash']['counted'], 'nobody has counted it');
    assertSame(null, $board['cash']['variance'], 'so there is no variance — not a zero one');
    assertSame('uncounted', $board['cash']['variance_state'], 'and it says so');
    assertSame(false, $board['shift']['reconciled'], 'an open shift is not reconciled');
});

check('the variance is judged against the tolerance this shop set, not a constant', function () use ($ctx, $auth) {
    resetDatabase();
    [, $terminalId] = seedOutlet($ctx);
    Db::insert('pos_settings', ['cmp_id' => $ctx->cmpId, 'cash_variance_tolerance' => 100], 'cmp_id');

    $sessionId = openShift($ctx, $auth, $terminalId, 2000.0);
    (new RegisterService($ctx, $auth))->close($sessionId, [
        'counted_cash' => 1950, 'variance_reason' => 'Short at handover',
    ]);

    $board = shiftBoard($ctx, $auth, ['session_id' => $sessionId])->build();
    assertSame(-50.0, $board['cash']['variance'], 'fifty short');
    assertSame('within_tolerance', $board['cash']['variance_state'], 'and this shop allows a hundred');
    assertSame('reconciled', $board['shift']['state'], 'so the shift reads as reconciled');

    // The same drawer, at a shop that allows nothing.
    Db::update('pos_settings', ['cash_variance_tolerance' => 0], ['cmp_id' => $ctx->cmpId]);
    $strict = shiftBoard($ctx, $auth, ['session_id' => $sessionId])->build();
    assertSame('out_of_tolerance', $strict['cash']['variance_state'], 'the same fifty is now out of tolerance');
    assertSame('variance', $strict['shift']['state'], 'and the shift says a variance was found');
});

check('the denomination sheet is kept with the count that produced it', function () use ($ctx, $auth) {
    resetDatabase();
    [, $terminalId] = seedOutlet($ctx);
    $sessionId = openShift($ctx, $auth, $terminalId, 2000.0);

    (new RegisterService($ctx, $auth))->close($sessionId, [
        'counted_cash' => 2000,
        'denominations' => [
            ['denomination' => 500, 'quantity' => 3],
            ['denomination' => 200, 'quantity' => 2],
            ['denomination' => 100, 'quantity' => 1],
            ['denomination' => 50,  'quantity' => 0],
        ],
    ]);

    $board = shiftBoard($ctx, $auth, ['session_id' => $sessionId])->build();
    $sheet = $board['denominations'];

    assertSame(true, $sheet['has_sheet'], 'the sheet came back');
    assertSame(2000.0, $sheet['counted_total'], 'and it adds up to the count');
    assertSame(0.0, $sheet['variance'], 'which balanced the drawer');

    $byFace = [];
    foreach ($sheet['rows'] as $row) {
        $byFace[(string) $row['denomination']] = $row['quantity'];
    }
    assertSame(3, $byFace['500'], 'three five-hundreds');
    assertSame(1, $byFace['100'], 'one hundred');
    // A denomination nobody counted is null, never zero: "we did not count any"
    // and "there were none" are different claims about a drawer.
    assertSame(null, $byFace['20'], 'an uncounted denomination is null, not zero');
});

check('a count that does not add up to the figure beside it is refused', function () use ($ctx, $auth) {
    resetDatabase();
    [, $terminalId] = seedOutlet($ctx);
    $sessionId = openShift($ctx, $auth, $terminalId, 2000.0);

    assertThrows(
        static fn () => (new RegisterService($ctx, $auth))->close($sessionId, [
            'counted_cash' => 2000,
            'denominations' => [['denomination' => 500, 'quantity' => 2]],
            'variance_reason' => 'never reached',
        ]),
        'add up to',
        'two figures for one drawer is refused rather than silently preferred',
    );

    assertSame('OPEN', Db::scalar('SELECT status FROM pos_register_sessions WHERE session_id = :s', ['s' => $sessionId]), 'and the shift stays open');
});

check('the comparison is the previous shift on the same till', function () use ($ctx, $auth) {
    resetDatabase();
    [, $terminalId] = seedOutlet($ctx);

    $first = openShift($ctx, $auth, $terminalId, 0.0);
    $firstCart = seedCart($ctx, $auth, $terminalId, $first);
    (new CheckoutService($ctx, $auth))->checkout((int) $firstCart['cart_id'], [
        'payments' => [['payment_mode' => 'cash', 'amount' => (float) $firstCart['total_amount']]],
    ]);
    (new RegisterService($ctx, $auth))->close($first, ['counted_cash' => (float) $firstCart['total_amount']]);

    $second = openShift($ctx, $auth, $terminalId, 0.0);
    foreach ([1, 2] as $_) {
        $cart = seedCart($ctx, $auth, $terminalId, $second);
        (new CheckoutService($ctx, $auth))->checkout((int) $cart['cart_id'], [
            'payments' => [['payment_mode' => 'cash', 'amount' => (float) $cart['total_amount']]],
        ]);
    }

    $board = shiftBoard($ctx, $auth, ['session_id' => $second])->build();
    assertSame($first, $board['comparison']['session_id'], 'it compares against the shift before it');
    assertSame(1, $board['comparison']['metrics']['bills'], 'which took one bill');
    assertSame(100.0, $board['comparison']['bills_pct'], 'two bills against one is up a hundred per cent');

    // The first shift has nothing before it, and does not invent a comparison.
    $firstBoard = shiftBoard($ctx, $auth, ['session_id' => $first])->build();
    assertSame(null, $firstBoard['comparison'], 'the first shift compares against nothing');
});

check('the trail shows a no-sale drawer open once, not once per table that recorded it', function () use ($ctx, $auth) {
    resetDatabase();
    [, $terminalId] = seedOutlet($ctx);
    $sessionId = openShift($ctx, $auth, $terminalId, 500.0);

    // One no-sale writes a drawer event, an approval event AND an audit row.
    (new RegisterService($ctx, $auth))->drawerEvent($sessionId, [
        'event_kind' => 'no_sale_open', 'reason' => 'Change for a customer',
    ]);

    $board = shiftBoard($ctx, $auth, ['session_id' => $sessionId]);
    $events = $board->events($sessionId, null, 50, 0);

    $noSales = array_values(array_filter(
        $events['items'],
        static fn (array $e): bool => $e['title'] === 'No-sale drawer open',
    ));
    assertSame(1, count($noSales), 'one fact, one row');
    assertSame('drawer', $noSales[0]['category'], 'filed under the drawer');
    assertSame('review', $noSales[0]['severity'], 'and worth a look');

    // Opening the shift is in there exactly once too.
    $opens = array_values(array_filter(
        $events['items'],
        static fn (array $e): bool => $e['category'] === 'shift',
    ));
    assertSame(1, count($opens), 'the shift opened once');

    $filtered = $board->events($sessionId, 'drawer', 50, 0);
    assertSame(1, $filtered['total'], 'filtering to the drawer finds the no-sale');
});

check('every cash sale is kept out of the trail, so six movements are not buried under four hundred', function () use ($ctx, $auth) {
    resetDatabase();
    [, $terminalId] = seedOutlet($ctx);
    $sessionId = openShift($ctx, $auth, $terminalId, 500.0);

    foreach ([1, 2, 3] as $_) {
        $cart = seedCart($ctx, $auth, $terminalId, $sessionId);
        (new CheckoutService($ctx, $auth))->checkout((int) $cart['cart_id'], [
            'payments' => [['payment_mode' => 'cash', 'amount' => (float) $cart['total_amount']]],
        ]);
    }

    $tenders = (int) Db::scalar(
        "SELECT COUNT(*) FROM pos_cash_drawer_events WHERE session_id = :s AND event_kind = 'sale_tender'",
        ['s' => $sessionId],
    );
    assertTrue($tenders >= 3, 'the sales did reach the drawer');

    $events = shiftBoard($ctx, $auth, ['session_id' => $sessionId])->events($sessionId, null, 50, 0);
    foreach ($events['items'] as $event) {
        assertTrue($event['code'] !== 'sale_tender', 'no sale tender in the trail');
    }
    // They are still in the money: the tender mix and the cash summary count them.
    $board = shiftBoard($ctx, $auth, ['session_id' => $sessionId])->build();
    assertSame(3, $board['metrics']['bills'], 'and the three bills are still counted');
    assertTrue($board['cash']['cash_sales'] > 0, 'and the cash is still in the drawer sum');
});

check('a cashier reads their own shift and is refused somebody else\'s', function () use ($ctx, $auth) {
    resetDatabase();
    [, $terminalId] = seedOutlet($ctx);
    Permissions::seed($ctx);

    $cashier = cashierAuth();
    $profileId = (int) Db::scalar(
        'SELECT profile_id FROM pos_permission_profiles WHERE cmp_id = :cmp AND profile_code = :code',
        ['cmp' => $ctx->cmpId, 'code' => 'cashier'],
    );
    Db::insert('pos_permission_assignments', [
        'cmp_id' => $ctx->cmpId, 'user_uuid' => $cashier->uuid, 'profile_id' => $profileId,
    ], 'assignment_id');

    $managersShift = openShift($ctx, $auth, $terminalId, 3000.0);
    (new RegisterService($ctx, $auth))->close($managersShift, ['counted_cash' => 3000]);
    $theirShift = openShift($ctx, $cashier, $terminalId, 250.0);

    $theirs = shiftBoard($ctx, $cashier, ['session_id' => $theirShift])->build();
    assertSame($theirShift, $theirs['shift']['session_id'], 'their own shift opens');
    assertSame(1, count($theirs['context']['shifts']), 'and the selector offers only theirs');

    assertThrows(
        static fn () => shiftBoard($ctx, $cashier, ['session_id' => $managersShift]),
        'another cashier',
        'a shift belonging to someone else is refused, not quietly emptied',
    );

    // The manager sees both in the selector.
    $managers = shiftBoard($ctx, $auth, ['session_id' => $managersShift])->build();
    assertSame(2, count($managers['context']['shifts']), 'the manager sees both shifts');
});

check('a suspicious-activity finding names the rule that produced it', function () use ($ctx, $auth) {
    resetDatabase();
    [, $terminalId] = seedOutlet($ctx);
    Db::insert('pos_settings', ['cmp_id' => $ctx->cmpId, 'cash_variance_tolerance' => 0], 'cmp_id');

    $sessionId = openShift($ctx, $auth, $terminalId, 1000.0);
    (new RegisterService($ctx, $auth))->close($sessionId, [
        'counted_cash' => 900, 'variance_reason' => 'Unexplained',
    ]);

    $board = shiftBoard($ctx, $auth, ['session_id' => $sessionId])->build();
    $found = $board['risk']['suspicious'];

    assertSame('rule', $found['kind'], 'rule-based, and labelled as such');
    assertTrue(count($found['items']) >= 1, 'the variance rule fired');
    foreach ($found['items'] as $item) {
        assertTrue($item['rule'] !== '', 'every finding states the rule behind it');
    }

    $tiles = [];
    foreach ($board['risk']['tiles'] as $tile) {
        $tiles[$tile['kind']] = $tile;
    }
    assertSame('danger', $tiles['suspicious']['tone'], 'and the tile says so');
    // A tile with nothing on it is not red.
    assertSame('success', $tiles['voids']['tone'], 'no voids is not an alarm');
    assertSame(0, $tiles['voids']['count'], 'and reads zero');
});

check('a shift that sold nothing still reports its drawer, and the outlet decides the day', function () use ($ctx, $auth) {
    resetDatabase();
    [$locationId, $terminalId] = seedOutlet($ctx);
    Db::update('pos_location_profiles', [
        'trading_timezone' => 'Asia/Kolkata', 'day_start_minutes' => 360,
    ], ['location_id' => $locationId, 'cmp_id' => $ctx->cmpId]);

    $sessionId = openShift($ctx, $auth, $terminalId, 750.0);
    // A shift opened at 1am local belongs to the previous business day.
    Db::run(
        "UPDATE pos_register_sessions SET opened_at = ((DATE '2026-05-27' + TIME '01:00') AT TIME ZONE 'Asia/Kolkata') WHERE session_id = :s",
        ['s' => $sessionId],
    );

    $board = shiftBoard($ctx, $auth, ['session_id' => $sessionId])->build();
    assertSame('2026-05-26', $board['shift']['date'], 'a 1am shift belongs to the night before');
    assertSame(0, $board['metrics']['bills'], 'it sold nothing');
    assertSame(750.0, $board['cash']['expected'], 'and the float is still real');
    assertSame(0, $board['channels']['total_orders'], 'no channels');
    assertSame([], $board['payment_mix'], 'no tenders');

    // Asked for by date rather than by id, it is still the shift that is found.
    $byDate = shiftBoard($ctx, $auth, ['location_id' => $locationId, 'date' => '2026-05-26'])->build();
    assertSame($sessionId, $byDate['shift']['session_id'], 'and the business date finds it');

    $wrongDay = shiftBoard($ctx, $auth, ['location_id' => $locationId, 'date' => '2026-05-27'])->build();
    assertSame(null, $wrongDay['shift'], 'the next day has no shift, and says so rather than erroring');
});

check('the retail command centre measures checkout and refuses to invent a queue', function () use ($ctx, $auth) {
    resetDatabase();
    [, $terminalId] = seedOutlet($ctx);
    $sessionId = openShift($ctx, $auth, $terminalId, 2000.0);

    $carts = new CartService($ctx, $auth);
    for ($i = 0; $i < 3; $i++) {
        $cart = seedCart($ctx, $auth, $terminalId, $sessionId);
        (new CheckoutService($ctx, $auth))->checkout((int) $cart['cart_id'], [
            'payments' => [['payment_mode' => 'cash', 'amount' => (float) $cart['total_amount']]],
        ]);
    }
    // One cart voided before payment, which is the only abandonment POS sees,
    // and one left open on the counter.
    $voided = $carts->open(['terminal_id' => $terminalId, 'session_id' => $sessionId, 'order_kind' => 'retail']);
    $carts->void((int) $voided['cart_id'], ['reason' => 'Customer changed their mind']);
    $carts->open(['terminal_id' => $terminalId, 'session_id' => $sessionId, 'order_kind' => 'retail']);

    $board = (new RetailBoard(dashboardWindow($ctx, $auth)))->build();
    $health = $board['checkout_health'];

    assertSame(false, $health['wait']['available'], 'no waiting time is reported');
    assertSame('not_observed', $health['wait']['reason'], 'and the reason is that nothing observes a queue');
    assertTrue(!array_key_exists('minutes', $health['wait']), 'the figure is absent, not zeroed');

    assertSame(3, $health['completion']['completed'], 'three bills were paid for');
    assertSame(1, $health['completion']['voided'], 'one was voided before payment');
    assertSame(5, $health['completion']['started'], 'five carts were opened in the window');
    assertSame(20.0, $health['abandonment']['rate_pc'], 'one of the five carts opened walked away');
    assertSame(1, $health['on_counter']['carts'], 'and one is still sitting on the counter');
});

check('nothing on the retail board is badged as an AI insight while no model is configured', function () use ($ctx, $auth) {
    $board = (new RetailBoard(dashboardWindow($ctx, $auth)))->build();

    assertSame(false, $board['pulse']['ai']['available'], 'the pulse strip says no model wrote it');
    foreach ($board['pulse']['items'] as $item) {
        assertSame('rule', $item['kind'], 'every pulse item is a rule: ' . $item['title']);
    }
    assertSame('rule', $board['alerts']['kind'], 'and so is every operational alert');
    foreach ($board['alerts']['items'] as $alert) {
        assertSame('rule', $alert['kind'], 'alert kind: ' . $alert['title']);
    }
});

check('the retail trend buckets a single day by hour and a range by day', function () use ($ctx, $auth) {
    $day = (new RetailBoard(dashboardWindow($ctx, $auth)))->build();
    assertSame('hour', $day['trend']['bucket'], 'one day is bucketed by hour');
    assertTrue($day['trend']['points'] !== [], 'and has the hours that took money');

    $range = (new RetailBoard(dashboardWindow($ctx, $auth, [
        'from' => gmdate('Y-m-d', strtotime('-6 days')), 'to' => gmdate('Y-m-d'),
    ])))->build();
    assertSame('day', $range['trend']['bucket'], 'a week is bucketed by day');
    assertSame(7, count($range['trend']['points']), 'with a point for every day in the window, zeros included');

    // Gross margin is NOT on the metric list: unit cost belongs to Inventory
    // and a margin from the counter price alone would be a guess.
    $keys = array_column($day['trend']['metrics'], 'key');
    assertTrue(!in_array('gross_margin', $keys, true), 'no margin metric is offered on this board');
});

check('categories say which product owns the grouping rather than drawing an empty ring', function () use ($ctx, $auth) {
    // The seeded lines carry Inventory item ids and no POS menu item, and the
    // stub answers items without a group, so nothing can be placed.
    $board = (new RetailBoard(dashboardWindow($ctx, $auth)))->build();

    assertSame(false, $board['categories']['available'], 'the panel does not claim a breakdown it could not build');
    assertSame('no_grouping', $board['categories']['reason'], 'and says why');
    assertSame([], $board['categories']['rows'], 'with no invented categories');
    assertTrue($board['categories']['total'] > 0, 'while still reporting what the period actually took');
    assertTrue(
        str_contains($board['categories']['note'], 'does not keep its own grouping'),
        'and names the product that owns item grouping',
    );
});

check('shift readiness counts only checks this product actually keeps', function () use ($ctx, $auth) {
    $board = (new RetailBoard(dashboardWindow($ctx, $auth)))->build();
    $readiness = $board['readiness'];

    assertSame(true, $readiness['available'], 'there is a till to be ready');
    foreach ($readiness['checks'] as $check) {
        assertTrue($check['of'] > 0, 'a check that applies to nothing is not shown: ' . $check['key']);
        assertTrue($check['ready'] <= $check['of'], 'no check is more than complete: ' . $check['key']);
    }

    $keys = array_column($readiness['checks'], 'key');
    assertTrue(!in_array('paper', $keys, true), 'there is no paper-roll check, because nothing measures paper');
    assertTrue(in_array('printer', $keys, true), 'the printer row is about configuration and is present');
    assertTrue($readiness['percent'] >= 0 && $readiness['percent'] <= 100, 'the ring is a percentage');
});

check('the exceptions comparison is windowed against windowed, never against a running total', function () use ($ctx, $auth) {
    $board = (new RetailBoard(dashboardWindow($ctx, $auth, ['compare' => 'previous'])))->build();

    assertTrue($board['comparison'] !== null, 'a comparison was asked for and built');
    assertSame(
        $board['kpis']['exceptions'] - $board['attention']['stuck'],
        $board['kpis']['exceptions_windowed'],
        'the windowed count is the headline minus the sales stuck on every date',
    );
    assertTrue(
        array_key_exists('exceptions_windowed', $board['comparison']),
        'and the comparison offers the same measure to compare it with',
    );
});

echo "\nData ownership (release-blocking)\n";

/** @return list<string> */
function posTables(): array
{
    return array_map(
        static fn (array $r) => (string) $r['table_name'],
        Db::all("SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY table_name"),
    );
}

/** @return list<string> */
function posColumns(): array
{
    return array_map(
        static fn (array $r) => $r['table_name'] . '.' . $r['column_name'],
        Db::all("SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = 'public' ORDER BY table_name, column_name"),
    );
}

check('no table mirrors another product', function () {
    // A table whose NAME claims to hold another product's data. The check is on
    // the name because that is what a mirror is called when someone adds one.
    $forbidden = [
        'pos_items', 'pos_item_master', 'pos_stock', 'pos_stock_balances', 'pos_inventory',
        'pos_accounts', 'pos_ledger', 'pos_vouchers', 'pos_invoices', 'pos_customers',
        'pos_parties', 'pos_companies', 'pos_branches', 'pos_warehouses', 'pos_batches',
        'pos_item_mirror', 'pos_account_mirror', 'pos_sync_state', 'pos_sync_log',
        'pos_replication_log', 'pos_reconciliation', 'pos_outbox', 'pos_inbox',
    ];

    $present = array_values(array_intersect($forbidden, posTables()));
    assertSame([], $present, 'these tables mirror data another product owns: ' . implode(', ', $present));
});

check('no column caches another product master or stores its balance', function () {
    // Names that would mean a copy rather than a reference. An *_id or *_uuid
    // is a reference and is fine; a name, a rate, a stock figure or a balance
    // is a copy and is not.
    $forbidden = [
        'pos_menu_items.item_name', 'pos_menu_items.item_code', 'pos_menu_items.stock_qty',
        'pos_menu_items.available_qty', 'pos_menu_items.purchase_cost', 'pos_menu_items.last_synced_at',
        'pos_cart_lines.stock_qty', 'pos_cart_lines.available_qty', 'pos_cart_lines.cost_price',
        'pos_cart_lines.valuation_rate', 'pos_cart_lines.closing_stock',
        'pos_carts.customer_balance', 'pos_carts.customer_outstanding', 'pos_carts.credit_limit',
        'pos_register_sessions.cash_account_balance', 'pos_register_sessions.books_cash_balance',
        'pos_returns.customer_balance',
    ];

    $present = array_values(array_intersect($forbidden, posColumns()));
    assertSame([], $present, 'these columns cache or duplicate another product data: ' . implode(', ', $present));
});

check('nothing stores a stock level', function () {
    // POS never holds a stock figure, not even a hint of one. Availability is
    // read live from Inventory on the request that needs it.
    $suspicious = array_values(array_filter(posColumns(), static function (string $column): bool {
        [$table, $name] = explode('.', $column, 2);

        return preg_match('/(^|_)(stock|on_hand|closing|opening_stock|available)(_|$)/', $name) === 1
            // 'availability' on a menu item is the kitchen saying sold out. It
            // is POS' own judgement, not a stock number, and the column next to
            // it (availability_note) says who decided.
            // Three exceptions, all POS' own judgements rather than stock:
            //   availability*   the kitchen saying sold out, set by a person
            //   available_from  service hours — a TIME, not a quantity
            //   available_to    the other end of those hours
            && !in_array($column, [
                'pos_menu_items.availability', 'pos_menu_items.availability_note',
                'pos_menu_items.availability_set_at',
                'pos_menu_items.available_from', 'pos_menu_items.available_to',
            ], true);
    }));

    assertSame([], $suspicious, 'these look like stored stock: ' . implode(', ', $suspicious));
});

check('the only remote references stored are ids, uuids and numbers', function () {
    // Everything POS keeps about Books and Inventory, listed. If a new one
    // appears it has to be added here deliberately, which is the point.
    $allowed = [
        'pos_carts.books_voucher_id', 'pos_carts.books_voucher_uuid', 'pos_carts.books_voucher_no',
        'pos_carts.inventory_document_uuid', 'pos_carts.customer_account_id',
        'pos_cart_payments.books_account_id',
        'pos_cash_drawer_events.books_voucher_uuid',
        'pos_returns.books_invoice_id', 'pos_returns.books_invoice_uuid', 'pos_returns.books_invoice_no',
        'pos_returns.books_credit_note_id', 'pos_returns.books_credit_note_uuid',
        'pos_returns.inventory_document_uuid', 'pos_returns.customer_account_id',
        'pos_location_profiles.default_cash_account_id', 'pos_location_profiles.walk_in_account_id',
        'pos_location_profiles.default_warehouse_id',
        // A booking points at the guest's Books account when they have one. The
        // name and mobile beside it are what was typed on the phone, not a copy
        // of the account — the same arrangement a walk-in cart already uses.
        'pos_table_reservations.customer_account_id',
        'pos_menu_items.item_id', 'pos_menu_items.bom_id', 'pos_menu_items.tax_cat_id',
        'pos_modifier_options.item_id',
        'pos_cart_lines.item_id', 'pos_cart_lines.unit_id', 'pos_cart_lines.warehouse_id',
        'pos_cart_lines.batch_id', 'pos_cart_lines.tax_cat_id',
        'pos_kot_lines.item_id',
        'pos_return_lines.item_id', 'pos_return_lines.unit_id', 'pos_return_lines.warehouse_id',
        'pos_return_lines.batch_id',
    ];

    $found = array_values(array_filter(posColumns(), static function (string $column): bool {
        [, $name] = explode('.', $column, 2);

        return preg_match('/^(books_|inventory_)/', $name) === 1
            || in_array($name, ['item_id', 'unit_id', 'warehouse_id', 'batch_id', 'tax_cat_id', 'bom_id', 'customer_account_id'], true);
    }));

    $unexpected = array_values(array_diff($found, $allowed));
    assertSame([], $unexpected, 'new cross-product columns appeared and must be justified: ' . implode(', ', $unexpected));
});

check('no scheduled job replicates anything', function () {
    // The integration command table is the whole outbound mechanism, and it
    // holds COMMANDS, not data. Prove it: every column is about the attempt,
    // never about the other product's document.
    $columns = array_map(
        static fn (array $r) => (string) $r['column_name'],
        Db::all("SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'pos_integration_commands'"),
    );

    $expected = [
        'command_id', 'cmp_id', 'fy_id', 'bo_id', 'target_service', 'command_type',
        'entity_type', 'entity_id', 'idempotency_key', 'status', 'attempts',
        'request_summary', 'external_reference', 'last_error', 'last_attempt_at',
        'completed_at', 'created_at', 'updated_at',
    ];

    sort($columns);
    sort($expected);
    assertSame($expected, $columns, 'the command table grew columns that look like stored remote data');
});

check('the offline cache guarantee is enforced by the database, not by code', function () {
    $index = Db::first(
        "SELECT indexdef FROM pg_indexes
         WHERE tablename = 'pos_offline_submissions' AND indexdef ILIKE '%UNIQUE%' AND indexdef ILIKE '%client_uuid%'",
    );

    assertTrue($index !== null, 'a unique index on (cmp_id, client_uuid) is what makes an offline sale idempotent');
    assertTrue(str_contains((string) $index['indexdef'], 'cmp_id'), 'and it must be scoped per company');
});

// ---------------------------------------------------------------------------

echo "\n{$passed} passed, {$failed} failed\n\n";
exit($failed === 0 ? 0 : 1);
