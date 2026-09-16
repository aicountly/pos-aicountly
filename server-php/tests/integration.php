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

function resetDatabase(): void
{
    $tables = [
        'pos_return_lines', 'pos_returns', 'pos_offline_submissions',
        'pos_kds_events', 'pos_kot_lines', 'pos_kots',
        'pos_cart_payments', 'pos_cart_lines', 'pos_carts',
        'pos_approval_events', 'pos_cash_drawer_events', 'pos_register_sessions',
        'pos_table_sessions', 'pos_tables', 'pos_floors',
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
