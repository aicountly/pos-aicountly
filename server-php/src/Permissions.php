<?php

declare(strict_types=1);

namespace Aicountly\Api;

/**
 * POS roles.
 *
 * A till is a shared machine with several people behind it in a shift, so the
 * permissions here are about what a person standing at that machine may do —
 * give a discount, void a line, open the drawer without a sale, cancel a KOT
 * the kitchen has already started.
 *
 * ENFORCED IN THE BACKEND. A cashier who can see the void button is a cashier
 * the UI told about voids; a cashier who can void is one the API let.
 */
final class Permissions
{
    public const TABLE_PROFILES    = 'pos_permission_profiles';
    public const TABLE_ASSIGNMENTS = 'pos_permission_assignments';

    /** @var array<string, array<string, string>> */
    public const CATALOG = [
        'Selling' => [
            'sell'              => 'Take a sale',
            'cart.hold'         => 'Hold and resume a cart',
            'cart.void_line'    => 'Remove a line before payment',
            'cart.void'         => 'Void a whole cart before payment',
            'discount.give'     => 'Give a discount within the limit',
            'discount.override' => 'Give a discount beyond the limit',
            'price.override'    => 'Change a price',
        ],
        'Money' => [
            'drawer.open'     => 'Open the drawer',
            'drawer.no_sale'  => 'Open the drawer without a sale',
            'drawer.cash_io'  => 'Record cash in and cash out',
            'shift.open'      => 'Open a till',
            'shift.close'     => 'Close a till and count the drawer',
            'shift.approve_variance' => 'Approve a drawer that does not balance',
        ],
        'Returns' => [
            'return.create'  => 'Take a return',
            'return.approve' => 'Approve a return',
            'refund.give'    => 'Give a refund',
        ],
        'Restaurant' => [
            'table.open'     => 'Seat a table',
            'table.transfer' => 'Move a table or change its waiter',
            'table.merge'    => 'Merge and split tables',
            'kot.fire'       => 'Send a ticket to the kitchen',
            'kot.cancel'     => 'Cancel a ticket the kitchen has',
            'kds.operate'    => 'Work the kitchen screen',
            'menu.availability' => 'Mark an item sold out',
        ],
        'Sensitive' => [
            'cost.view'      => 'See purchase cost',
            'margin.view'    => 'See margin',
            'reports.view'   => 'See till and shift reports',
            'negative_stock.override' => 'Sell past a stock warning',
        ],
        'Administration' => [
            'terminal.manage' => 'Set up terminals and outlets',
            'menu.manage'     => 'Edit the menu',
            'settings.manage' => 'Change POS settings',
            'access.manage'   => 'Manage POS roles',
            'offline.resolve' => 'Resolve an offline sale that would not post',
        ],
    ];

    /**
     * The roles a new outlet starts with.
     *
     * @var array<string, array{name:string, description:string, permissions:list<string>}>
     */
    public const TEMPLATES = [
        'cashier' => [
            'name' => 'Cashier',
            'description' => 'Sells and takes money. No voids past a line, no cost, no reports.',
            'permissions' => ['sell', 'cart.hold', 'cart.void_line', 'discount.give', 'drawer.open', 'shift.open', 'shift.close'],
        ],
        'waiter' => [
            'name' => 'Waiter',
            'description' => 'Seats tables and sends tickets to the kitchen.',
            'permissions' => ['sell', 'cart.hold', 'table.open', 'table.transfer', 'kot.fire'],
        ],
        'captain' => [
            'name' => 'Captain',
            'description' => 'A waiter who can also move tables and cancel a ticket.',
            'permissions' => [
                'sell', 'cart.hold', 'cart.void_line', 'discount.give',
                'table.open', 'table.transfer', 'table.merge', 'kot.fire', 'kot.cancel',
            ],
        ],
        'kitchen' => [
            'name' => 'Kitchen',
            'description' => 'The kitchen screen, and nothing else. No prices, no money.',
            'permissions' => ['kds.operate', 'menu.availability'],
        ],
        'manager' => [
            'name' => 'Manager',
            'description' => 'Approves what a cashier cannot do alone, and closes the day.',
            'permissions' => [
                'sell', 'cart.hold', 'cart.void_line', 'cart.void', 'discount.give', 'discount.override',
                'price.override', 'drawer.open', 'drawer.no_sale', 'drawer.cash_io',
                'shift.open', 'shift.close', 'shift.approve_variance',
                'return.create', 'return.approve', 'refund.give',
                'table.open', 'table.transfer', 'table.merge', 'kot.fire', 'kot.cancel',
                'menu.availability', 'cost.view', 'margin.view', 'reports.view',
                'negative_stock.override', 'offline.resolve',
            ],
        ],
        'pos_admin' => [
            'name' => 'POS admin',
            'description' => 'Everything, including setting up terminals and the menu.',
            'permissions' => [],
        ],
    ];

    /** @var array<string, list<string>> */
    private static array $cache = [];

    public static function assert(Context $ctx, Auth $auth, string $permission): void
    {
        if (!self::allows($ctx, $auth, $permission)) {
            Http::forbidden('You cannot ' . self::describe($permission) . '. Ask a manager.');
        }
    }

    public static function allows(Context $ctx, Auth $auth, string $permission): bool
    {
        if ($auth->isService()) {
            return true;
        }
        if ($auth->accessType() === 1) {
            return true;
        }

        return in_array($permission, self::granted($ctx, $auth), true);
    }

    /** @return list<string> */
    public static function granted(Context $ctx, Auth $auth): array
    {
        $key = $ctx->cmpId . ':' . $auth->uuid;
        if (isset(self::$cache[$key])) {
            return self::$cache[$key];
        }

        if ($auth->isService() || $auth->accessType() === 1) {
            return self::$cache[$key] = self::all();
        }

        try {
            $rows = Db::all(
                'SELECT p.permissions
                 FROM ' . self::TABLE_ASSIGNMENTS . ' a
                 JOIN ' . self::TABLE_PROFILES . ' p ON p.profile_id = a.profile_id
                 WHERE a.cmp_id = :cmp AND a.user_uuid = :uuid AND p.is_active = TRUE',
                ['cmp' => $ctx->cmpId, 'uuid' => $auth->uuid],
            );
        } catch (\Throwable $e) {
            error_log('[permissions] lookup failed: ' . $e->getMessage());

            return self::$cache[$key] = [];
        }

        $granted = [];
        foreach ($rows as $row) {
            foreach (Db::jsonColumn($row['permissions'] ?? null) as $permission) {
                if (is_string($permission)) {
                    $granted[$permission] = true;
                }
            }
        }

        return self::$cache[$key] = array_keys($granted);
    }

    /**
     * Drop the memoised grant for one caller.
     *
     * Needed because the grant is worked out once per request and an access-type
     * promotion can arrive after that. Without this, anything that asked what a
     * user may do BEFORE Manage confirmed they own the company would pin the
     * empty answer for the rest of the request — and the correctness of the
     * whole permission system would rest on nobody ever reordering two lines in
     * Controller::enter().
     */
    public static function forget(Context $ctx, Auth $auth): void
    {
        unset(self::$cache[$ctx->cmpId . ':' . $auth->uuid]);
    }

    /** @return list<string> */
    public static function all(): array
    {
        $out = [];
        foreach (self::CATALOG as $group) {
            foreach (array_keys($group) as $permission) {
                $out[] = $permission;
            }
        }

        return $out;
    }

    public static function exists(string $permission): bool
    {
        return in_array($permission, self::all(), true);
    }

    public static function seed(Context $ctx): void
    {
        $existing = (int) Db::scalar('SELECT COUNT(*) FROM ' . self::TABLE_PROFILES . ' WHERE cmp_id = :cmp', ['cmp' => $ctx->cmpId]);
        if ($existing > 0) {
            return;
        }

        foreach (self::TEMPLATES as $code => $template) {
            Db::insert(self::TABLE_PROFILES, [
                'cmp_id'       => $ctx->cmpId,
                'profile_code' => $code,
                'profile_name' => $template['name'],
                'description'  => $template['description'],
                'permissions'  => $code === 'pos_admin' ? self::all() : $template['permissions'],
                'is_system'    => true,
            ], 'profile_id');
        }
    }

    private static function describe(string $permission): string
    {
        foreach (self::CATALOG as $group) {
            if (isset($group[$permission])) {
                return strtolower($group[$permission]);
            }
        }

        return 'do that';
    }
}
