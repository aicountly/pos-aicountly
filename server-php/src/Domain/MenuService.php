<?php

declare(strict_types=1);

namespace Aicountly\Api\Domain;

use Aicountly\Api\Audit;
use Aicountly\Api\Auth;
use Aicountly\Api\Clients\InventoryClient;
use Aicountly\Api\Context;
use Aicountly\Api\Db;
use Aicountly\Api\Http;
use Aicountly\Api\Permissions;

/**
 * The menu — how the till PRESENTS what the shop sells.
 *
 * THE LINE THIS DRAWS. Inventory owns the item: what it is, what it costs, how
 * much there is, what it is made of. POS owns the PRESENTATION: which button it
 * sits behind, what it is called on the menu, what colour the tile is, whether
 * it shows on delivery, and what the restaurant charges for it here.
 *
 * So a menu item holds an item_id — a REFERENCE to Inventory's item — and never
 * a copy of its name, stock, cost or recipe. When the till needs those it asks
 * Inventory, on the request that needs them. A menu_price is stored because it
 * is a decision this outlet made, not a copy of anything: an Inventory item
 * with one sale rate can be 180 in the dining room and 140 on the terrace.
 *
 * SOLD OUT IS A HUMAN JUDGEMENT, NOT A STOCK LEVEL. The kitchen marking the
 * biryani sold out is the head chef saying there is no more, which is often
 * true while Inventory still shows units — because a portion is not a unit, and
 * because ingredients spoil. That flag is POS' own and is cleared by a person,
 * not by a stock figure changing.
 */
final class MenuService
{
    public function __construct(
        private readonly Context $ctx,
        private readonly Auth $auth,
    ) {
    }

    /**
     * The menu for a till, ready to render.
     *
     * @param array<string, mixed> $filters
     */
    public function present(array $filters): array
    {
        $locationId = self::id($filters['location_id'] ?? null);
        $channel    = self::channel($filters['channel'] ?? 'dine_in');

        $params = ['cmp' => $this->ctx->cmpId];
        $where = ['m.cmp_id = :cmp', 'm.is_active = TRUE'];

        if ($locationId !== null) {
            $where[] = '(m.location_id = :loc OR m.location_id IS NULL)';
            $params['loc'] = $locationId;
        }

        $column = match ($channel) {
            'takeaway' => 'show_takeaway',
            'delivery' => 'show_delivery',
            'qr'       => 'show_qr',
            default    => 'show_dine_in',
        };
        $where[] = 'm.' . $column . ' = TRUE';

        if (!empty($filters['search'])) {
            $where[] = '(m.display_name ILIKE :q OR m.short_name ILIKE :q)';
            $params['q'] = '%' . $filters['search'] . '%';
        }

        $items = Db::all(
            'SELECT m.*, c.category_name, c.colour AS category_colour, s.station_name
             FROM pos_menu_items m
             LEFT JOIN pos_menu_categories c ON c.category_id = m.category_id
             LEFT JOIN pos_kds_stations s ON s.station_id = m.station_id
             WHERE ' . implode(' AND ', $where) . '
             ORDER BY c.sort_order, c.category_name, m.sort_order, m.display_name
             LIMIT 2000',
            $params,
        );

        $now = gmdate('H:i:s');

        return [
            'channel'    => $channel,
            'categories' => $this->categories($locationId),
            'items'      => array_map(static function (array $item) use ($now): array {
                $item['menu_item_id'] = (int) $item['menu_item_id'];
                $item['item_id']      = $item['item_id'] === null ? null : (int) $item['item_id'];
                $item['menu_price']   = $item['menu_price'] === null ? null : (float) $item['menu_price'];

                // A breakfast item outside breakfast hours is shown greyed, not
                // hidden: a cashier looking for it needs to find it and be told
                // why it is unavailable, not conclude the menu is broken.
                $from = $item['available_from'];
                $to   = $item['available_to'];
                $item['in_service_hours'] = $from === null || $to === null
                    ? true
                    : ($from <= $to ? ($now >= $from && $now <= $to) : ($now >= $from || $now <= $to));

                return $item;
            }, $items),
        ];
    }

    /** @return list<array<string, mixed>> */
    public function categories(?int $locationId = null): array
    {
        $params = ['cmp' => $this->ctx->cmpId];
        $where = 'cmp_id = :cmp AND is_active = TRUE';
        if ($locationId !== null) {
            $where .= ' AND (location_id = :loc OR location_id IS NULL)';
            $params['loc'] = $locationId;
        }

        return Db::all('SELECT * FROM pos_menu_categories WHERE ' . $where . ' ORDER BY sort_order, category_name', $params);
    }

    /**
     * The modifier groups a menu item offers, with their options.
     *
     * @return list<array<string, mixed>>
     */
    public function modifiers(int $menuItemId): array
    {
        $groups = Db::all(
            'SELECT g.* FROM pos_modifier_groups g
             JOIN pos_menu_item_modifiers l ON l.group_id = g.group_id
             WHERE l.menu_item_id = :id AND g.cmp_id = :cmp
             ORDER BY l.sort_order, g.group_name',
            ['id' => $menuItemId, 'cmp' => $this->ctx->cmpId],
        );

        foreach ($groups as &$group) {
            $group['group_id'] = (int) $group['group_id'];
            $group['options'] = array_map(static function (array $option): array {
                $option['option_id']   = (int) $option['option_id'];
                $option['price_delta'] = (float) $option['price_delta'];

                return $option;
            }, Db::all(
                'SELECT * FROM pos_modifier_options WHERE group_id = :g AND is_active = TRUE ORDER BY sort_order, option_name',
                ['g' => $group['group_id']],
            ));
        }

        return $groups;
    }

    /**
     * Create or update a menu item.
     *
     * @param array<string, mixed> $input
     */
    public function save(?int $menuItemId, array $input): array
    {
        Permissions::assert($this->ctx, $this->auth, 'menu.manage');

        $name = self::text($input['display_name'] ?? null);
        if ($menuItemId === null && $name === null) {
            Http::validationFailed('What is this called on the menu?', ['field' => 'display_name']);
        }

        // A menu item that sells stock must point at a real Inventory item. We
        // verify the reference LIVE rather than storing a copy of the item, so
        // a typo is caught here instead of at the first sale.
        $itemId = self::id($input['item_id'] ?? null);
        if ($itemId !== null) {
            $response = (new InventoryClient())->withSession($this->auth->sesKey())->item($this->ctx, $itemId);
            if ($response['status'] === 404) {
                Http::validationFailed('That item does not exist in Inventory.', ['field' => 'item_id']);
            }
            // An unreachable Inventory is not a wrong item_id, and blocking menu
            // setup on it would be a worse failure than accepting the reference.
        }

        $values = array_filter([
            'cmp_id'        => $this->ctx->cmpId,
            'location_id'   => self::id($input['location_id'] ?? null),
            'category_id'   => self::id($input['category_id'] ?? null),
            'item_id'       => $itemId,
            'bom_id'        => self::id($input['bom_id'] ?? null),
            'display_name'  => $name,
            'short_name'    => self::text($input['short_name'] ?? null),
            'description'   => self::text($input['description'] ?? null),
            'image_ref'     => self::text($input['image_ref'] ?? null),
            'menu_price'    => isset($input['menu_price']) ? round((float) $input['menu_price'], 4) : null,
            'tax_cat_id'    => self::id($input['tax_cat_id'] ?? null),
            'station_id'    => self::id($input['station_id'] ?? null),
            'prep_minutes'  => isset($input['prep_minutes']) ? (int) $input['prep_minutes'] : null,
            'sort_order'    => isset($input['sort_order']) ? (int) $input['sort_order'] : null,
            'available_from' => self::text($input['available_from'] ?? null),
            'available_to'  => self::text($input['available_to'] ?? null),
        ], static fn ($v) => $v !== null);

        foreach (['show_dine_in', 'show_takeaway', 'show_delivery', 'show_qr', 'is_active'] as $flag) {
            if (array_key_exists($flag, $input)) {
                $values[$flag] = (bool) $input[$flag];
            }
        }

        if ($menuItemId === null) {
            $menuItemId = (int) Db::insert('pos_menu_items', $values, 'menu_item_id');
            Audit::record($this->ctx, $this->auth, 'menu.item_created', 'menu_item', $menuItemId, null, ['display_name' => $name]);
        } else {
            unset($values['cmp_id']);
            $values['updated_at'] = self::now();
            $updated = Db::update('pos_menu_items', $values, ['menu_item_id' => $menuItemId, 'cmp_id' => $this->ctx->cmpId]);
            if ($updated === 0) {
                Http::notFound('That menu item does not exist.');
            }
            Audit::record($this->ctx, $this->auth, 'menu.item_changed', 'menu_item', $menuItemId, null, $values);
        }

        if (isset($input['modifier_group_ids']) && is_array($input['modifier_group_ids'])) {
            $this->linkModifierGroups($menuItemId, $input['modifier_group_ids']);
        }

        return $this->findItem($menuItemId);
    }

    /**
     * Mark an item sold out, or bring it back.
     *
     * A human decision, made by a human, cleared by a human. Nothing sweeps
     * this flag and no stock figure changes it.
     *
     * @param array<string, mixed> $input
     */
    public function setAvailability(int $menuItemId, array $input): array
    {
        Permissions::assert($this->ctx, $this->auth, 'menu.availability');

        $state = strtoupper((string) ($input['availability'] ?? ''));
        if (!in_array($state, ['AVAILABLE', 'SOLD_OUT', 'HIDDEN'], true)) {
            Http::validationFailed('An item is available, sold out, or hidden.', [
                'field' => 'availability', 'allowed' => ['AVAILABLE', 'SOLD_OUT', 'HIDDEN'],
            ]);
        }

        $before = $this->findItem($menuItemId);
        if ($before === []) {
            Http::notFound('That menu item does not exist.');
        }

        Db::update('pos_menu_items', [
            'availability'        => $state,
            'availability_note'   => self::text($input['note'] ?? null),
            'availability_set_at' => self::now(),
            'updated_at'          => self::now(),
        ], ['menu_item_id' => $menuItemId, 'cmp_id' => $this->ctx->cmpId]);

        Audit::record($this->ctx, $this->auth, 'menu.availability_set', 'menu_item', $menuItemId,
            ['availability' => $before['availability']], ['availability' => $state], self::text($input['note'] ?? null) ?? '');

        return $this->findItem($menuItemId);
    }

    public function findItem(int $menuItemId): array
    {
        $item = Db::first(
            'SELECT * FROM pos_menu_items WHERE menu_item_id = :id AND cmp_id = :cmp',
            ['id' => $menuItemId, 'cmp' => $this->ctx->cmpId],
        );
        if ($item === null) {
            return [];
        }

        $item['menu_item_id'] = (int) $item['menu_item_id'];
        $item['item_id']      = $item['item_id'] === null ? null : (int) $item['item_id'];
        $item['menu_price']   = $item['menu_price'] === null ? null : (float) $item['menu_price'];
        $item['modifier_groups'] = $this->modifiers($menuItemId);
        $item['combo_components'] = Db::all(
            'SELECT c.*, m.display_name FROM pos_combo_components c
             JOIN pos_menu_items m ON m.menu_item_id = c.component_menu_item_id
             WHERE c.combo_menu_item_id = :id AND c.cmp_id = :cmp ORDER BY c.sort_order',
            ['id' => $menuItemId, 'cmp' => $this->ctx->cmpId],
        );

        return $item;
    }

    /** @param array<int, mixed> $groupIds */
    private function linkModifierGroups(int $menuItemId, array $groupIds): void
    {
        Db::transaction(function () use ($menuItemId, $groupIds): void {
            Db::run('DELETE FROM pos_menu_item_modifiers WHERE menu_item_id = :id', ['id' => $menuItemId]);

            $sort = 0;
            foreach ($groupIds as $groupId) {
                if (!is_numeric($groupId)) {
                    continue;
                }
                Db::insert('pos_menu_item_modifiers', [
                    'menu_item_id' => $menuItemId,
                    'group_id'     => (int) $groupId,
                    'cmp_id'       => $this->ctx->cmpId,
                    'sort_order'   => $sort++,
                ], 'link_id');
            }
        });
    }

    private static function channel(mixed $raw): string
    {
        $value = is_string($raw) ? strtolower(trim($raw)) : 'dine_in';

        return in_array($value, ['dine_in', 'takeaway', 'delivery', 'qr'], true) ? $value : 'dine_in';
    }

    private static function id(mixed $raw): ?int
    {
        if ($raw === null || $raw === '' || $raw === 0 || $raw === '0') {
            return null;
        }

        return (int) $raw;
    }

    private static function text(mixed $raw): ?string
    {
        if (!is_string($raw)) {
            return null;
        }
        $trimmed = trim($raw);

        return $trimmed === '' ? null : $trimmed;
    }

    private static function now(): string
    {
        return gmdate('Y-m-d H:i:s');
    }
}
