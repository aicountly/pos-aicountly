<?php

declare(strict_types=1);

namespace Aicountly\Api\Controllers;

use Aicountly\Api\Audit;
use Aicountly\Api\Db;
use Aicountly\Api\Http;
use Aicountly\Api\IntegrationCommand;
use Aicountly\Api\Permissions;

/**
 * Who am I, what may I do, and how is this outlet set up.
 */
final class SettingsController extends Controller
{
    /**
     * The first call a till makes.
     *
     * Everything the screen needs to render itself without a second round
     * trip: who the cashier is, what they may do, which outlets and tills they
     * can sign on to, and the shop's own settings.
     */
    public static function session(): void
    {
        [$auth, $ctx] = self::enter();

        Permissions::seed($ctx);

        $locations = Db::all(
            'SELECT location_id, location_code, display_name, pos_mode, vertical_preset, bo_id,
                    default_warehouse_id, default_cash_account_id, currency_code, service_charge_pc,
                    tips_enabled, allow_negative_override
             FROM pos_location_profiles WHERE cmp_id = :cmp AND is_active = TRUE ORDER BY location_code',
            ['cmp' => $ctx->cmpId],
        );

        $terminals = Db::all(
            'SELECT terminal_id, terminal_uuid, location_id, terminal_code, display_name, terminal_kind,
                    receipt_printer, default_payment_modes
             FROM pos_terminals WHERE cmp_id = :cmp AND is_active = TRUE ORDER BY terminal_code',
            ['cmp' => $ctx->cmpId],
        );

        Http::data([
            'user' => [
                'uuid'         => $auth->uuid,
                'display_name' => $auth->displayName(),
                'kind'         => $auth->kind,
            ],
            'company' => ['cmp_id' => $ctx->cmpId, 'fy_id' => $ctx->fyId, 'bo_id' => $ctx->boId],
            'permissions' => Permissions::granted($ctx, $auth),
            'locations'   => array_map(static function (array $l): array {
                $l['location_id'] = (int) $l['location_id'];
                $l['service_charge_pc'] = (float) $l['service_charge_pc'];

                return $l;
            }, $locations),
            'terminals' => array_map(static function (array $t): array {
                $t['terminal_id'] = (int) $t['terminal_id'];
                $t['location_id'] = (int) $t['location_id'];
                $t['default_payment_modes'] = Db::jsonColumn($t['default_payment_modes'] ?? null);

                return $t;
            }, $terminals),
            'settings' => self::settingsRow($ctx->cmpId),
        ]);
    }

    public static function permissions(): void
    {
        [$auth, $ctx] = self::enter();

        Http::data([
            'catalog'   => Permissions::CATALOG,
            'granted'   => Permissions::granted($ctx, $auth),
            'profiles'  => Db::all(
                'SELECT profile_id, profile_code, profile_name, description, permissions, is_system, is_active
                 FROM ' . Permissions::TABLE_PROFILES . ' WHERE cmp_id = :cmp ORDER BY profile_name',
                ['cmp' => $ctx->cmpId],
            ),
        ]);
    }

    public static function show(): void
    {
        [$auth, $ctx] = self::enter();
        Http::data(self::settingsRow($ctx->cmpId));
    }

    public static function update(): void
    {
        [$auth, $ctx] = self::enter();
        Permissions::assert($ctx, $auth, 'settings.manage');

        $body = Http::body();
        $values = [];

        foreach (['return_prefix', 'kot_prefix'] as $field) {
            if (isset($body[$field]) && is_string($body[$field]) && trim($body[$field]) !== '') {
                $values[$field] = trim($body[$field]);
            }
        }
        foreach (['cashier_discount_limit_pc'] as $field) {
            if (isset($body[$field]) && is_numeric($body[$field])) {
                $values[$field] = round((float) $body[$field], 3);
            }
        }
        foreach (['offline_grace_minutes', 'cache_warn_after_minutes'] as $field) {
            if (isset($body[$field]) && is_numeric($body[$field])) {
                $values[$field] = max(0, (int) $body[$field]);
            }
        }
        foreach (['require_reason_on_void', 'require_reason_on_return'] as $field) {
            if (array_key_exists($field, $body)) {
                $values[$field] = (bool) $body[$field];
            }
        }

        if ($values === []) {
            Http::validationFailed('There is nothing to change.');
        }

        $before = self::settingsRow($ctx->cmpId);
        $values['updated_at'] = gmdate('Y-m-d H:i:s');
        Db::update('pos_settings', $values, ['cmp_id' => $ctx->cmpId]);

        Audit::record($ctx, $auth, 'settings.changed', 'settings', $ctx->cmpId, $before, $values);

        Http::data(self::settingsRow($ctx->cmpId));
    }

    /**
     * Everything still waiting on another product.
     *
     * This is what stands in for a reconciliation job. It is a plain list of
     * commands that have not completed, shown to the person who can do
     * something about them, rather than a cron comparing two copies of the
     * same data at three in the morning.
     */
    public static function outstanding(): void
    {
        [$auth, $ctx] = self::enter();
        Permissions::assert($ctx, $auth, 'reports.view');

        Http::data([
            'commands' => array_map(static function (array $row): array {
                $row['command_id'] = (int) $row['command_id'];
                $row['request_summary'] = Db::jsonColumn($row['request_summary'] ?? null);
                $row['external_reference'] = $row['external_reference'] === null ? null : Db::jsonColumn($row['external_reference']);

                return $row;
            }, IntegrationCommand::outstanding($ctx)),
        ]);
    }

    private static function settingsRow(int $cmpId): array
    {
        $row = Db::first('SELECT * FROM pos_settings WHERE cmp_id = :cmp', ['cmp' => $cmpId]);
        if ($row === null) {
            Db::insert('pos_settings', ['cmp_id' => $cmpId], 'cmp_id');
            $row = Db::first('SELECT * FROM pos_settings WHERE cmp_id = :cmp', ['cmp' => $cmpId]) ?? [];
        }

        $row['cashier_discount_limit_pc'] = (float) ($row['cashier_discount_limit_pc'] ?? 0);
        $row['offline_grace_minutes'] = (int) ($row['offline_grace_minutes'] ?? 0);
        $row['cache_warn_after_minutes'] = (int) ($row['cache_warn_after_minutes'] ?? 120);

        return $row;
    }
}
