<?php

declare(strict_types=1);

namespace Aicountly\Api\Controllers;

use Aicountly\Api\Audit;
use Aicountly\Api\Db;
use Aicountly\Api\Http;
use Aicountly\Api\Permissions;

/**
 * Setting the shop up: outlets, tills, devices, floors, stations, roles.
 *
 * A LOCATION here is a POS outlet profile, not a branch master — the branch is
 * Manage's, and bo_id points at it. What this holds is what the till needs to
 * know about selling at that branch: which warehouse stock comes out of, which
 * cash account takes the money, whether the place runs tables.
 */
final class AdminController extends Controller
{
    // -----------------------------------------------------------------------
    // Outlets
    // -----------------------------------------------------------------------

    public static function locations(): void
    {
        [$auth, $ctx] = self::enter();
        Http::data(['locations' => Db::all(
            'SELECT * FROM pos_location_profiles WHERE cmp_id = :cmp ORDER BY location_code',
            ['cmp' => $ctx->cmpId],
        )]);
    }

    public static function saveLocation(?string $id = null): void
    {
        [$auth, $ctx] = self::enter();
        Permissions::assert($ctx, $auth, 'terminal.manage');

        $body = Http::body();
        $values = array_filter([
            'bo_id'                   => isset($body['bo_id']) ? (int) $body['bo_id'] : null,
            'location_code'           => self::text($body['location_code'] ?? null),
            'display_name'            => self::text($body['display_name'] ?? null),
            'pos_mode'                => self::mode($body['pos_mode'] ?? null),
            'vertical_preset'         => self::text($body['vertical_preset'] ?? null),
            'default_warehouse_id'    => self::id($body['default_warehouse_id'] ?? null),
            'default_cash_account_id' => self::id($body['default_cash_account_id'] ?? null),
            'walk_in_account_id'      => self::id($body['walk_in_account_id'] ?? null),
            'currency_code'           => self::text($body['currency_code'] ?? null),
            'service_charge_pc'       => isset($body['service_charge_pc']) ? round((float) $body['service_charge_pc'], 3) : null,
        ], static fn ($v) => $v !== null);

        foreach (['tips_enabled', 'allow_negative_override', 'is_active'] as $flag) {
            if (array_key_exists($flag, $body)) {
                $values[$flag] = (bool) $body[$flag];
            }
        }

        if ($id === null) {
            if (($values['location_code'] ?? null) === null) {
                Http::validationFailed('Give the outlet a code.', ['field' => 'location_code']);
            }
            $values['cmp_id'] = $ctx->cmpId;
            $values['bo_id'] ??= $ctx->boId;
            $locationId = (int) Db::insert('pos_location_profiles', $values, 'location_id');
            Audit::record($ctx, $auth, 'location.created', 'location', $locationId, null, $values);
            Http::data(Db::first('SELECT * FROM pos_location_profiles WHERE location_id = :id', ['id' => $locationId]) ?? [], 201);
        }

        $values['updated_at'] = gmdate('Y-m-d H:i:s');
        if (Db::update('pos_location_profiles', $values, ['location_id' => (int) $id, 'cmp_id' => $ctx->cmpId]) === 0) {
            Http::notFound('That outlet does not exist.');
        }
        Audit::record($ctx, $auth, 'location.changed', 'location', (int) $id, null, $values);

        Http::data(Db::first('SELECT * FROM pos_location_profiles WHERE location_id = :id', ['id' => (int) $id]) ?? []);
    }

    // -----------------------------------------------------------------------
    // Tills
    // -----------------------------------------------------------------------

    public static function terminals(): void
    {
        [$auth, $ctx] = self::enter();
        $rows = Db::all(
            "SELECT t.*, l.location_code,
                    (SELECT s.session_id FROM pos_register_sessions s
                      WHERE s.terminal_id = t.terminal_id AND s.status = 'OPEN' LIMIT 1) AS open_session_id
             FROM pos_terminals t
             JOIN pos_location_profiles l ON l.location_id = t.location_id
             WHERE t.cmp_id = :cmp ORDER BY l.location_code, t.terminal_code",
            ['cmp' => $ctx->cmpId],
        );

        Http::data(['terminals' => array_map(static function (array $t): array {
            $t['terminal_id'] = (int) $t['terminal_id'];
            $t['default_payment_modes'] = Db::jsonColumn($t['default_payment_modes'] ?? null);
            $t['kot_printer_routes'] = Db::jsonColumn($t['kot_printer_routes'] ?? null);
            $t['open_session_id'] = $t['open_session_id'] === null ? null : (int) $t['open_session_id'];

            return $t;
        }, $rows)]);
    }

    public static function saveTerminal(?string $id = null): void
    {
        [$auth, $ctx] = self::enter();
        Permissions::assert($ctx, $auth, 'terminal.manage');

        $body = Http::body();
        $values = array_filter([
            'location_id'    => self::id($body['location_id'] ?? null),
            'terminal_code'  => self::text($body['terminal_code'] ?? null),
            'display_name'   => self::text($body['display_name'] ?? null),
            'terminal_kind'  => self::text($body['terminal_kind'] ?? null),
            'receipt_printer' => self::text($body['receipt_printer'] ?? null),
        ], static fn ($v) => $v !== null);

        if (isset($body['default_payment_modes']) && is_array($body['default_payment_modes'])) {
            $values['default_payment_modes'] = array_values(array_filter($body['default_payment_modes'], 'is_string'));
        }
        if (isset($body['kot_printer_routes']) && is_array($body['kot_printer_routes'])) {
            $values['kot_printer_routes'] = $body['kot_printer_routes'];
        }
        if (array_key_exists('is_active', $body)) {
            $values['is_active'] = (bool) $body['is_active'];
        }

        if ($id === null) {
            if (($values['location_id'] ?? null) === null || ($values['terminal_code'] ?? null) === null) {
                Http::validationFailed('A till needs an outlet and a code.');
            }
            $values['cmp_id'] = $ctx->cmpId;
            $terminalId = (int) Db::insert('pos_terminals', $values, 'terminal_id');
            Audit::record($ctx, $auth, 'terminal.created', 'terminal', $terminalId, null, $values);
            Http::data(Db::first('SELECT * FROM pos_terminals WHERE terminal_id = :id', ['id' => $terminalId]) ?? [], 201);
        }

        $values['updated_at'] = gmdate('Y-m-d H:i:s');
        if (Db::update('pos_terminals', $values, ['terminal_id' => (int) $id, 'cmp_id' => $ctx->cmpId]) === 0) {
            Http::notFound('That till does not exist.');
        }
        Audit::record($ctx, $auth, 'terminal.changed', 'terminal', (int) $id, null, $values);

        Http::data(Db::first('SELECT * FROM pos_terminals WHERE terminal_id = :id', ['id' => (int) $id]) ?? []);
    }

    /**
     * Pair a physical device with a till.
     *
     * The token is returned ONCE, at registration, and only its hash is kept.
     * A device token is what lets a till post sales while nobody is signed in,
     * so a stored plaintext token is a stored ability to write invoices.
     */
    public static function registerDevice(): void
    {
        [$auth, $ctx] = self::enter();
        Permissions::assert($ctx, $auth, 'terminal.manage');

        $body = Http::body();
        $terminalId = self::id($body['terminal_id'] ?? null);
        $deviceUuid = self::text($body['device_uuid'] ?? null);

        if ($terminalId === null || $deviceUuid === null) {
            Http::validationFailed('A device registers against a till, with the uuid the device generated.');
        }

        $terminal = Db::first('SELECT terminal_id FROM pos_terminals WHERE terminal_id = :id AND cmp_id = :cmp', ['id' => $terminalId, 'cmp' => $ctx->cmpId]);
        if ($terminal === null) {
            Http::notFound('That till does not exist.');
        }

        $token = bin2hex(random_bytes(32));

        $deviceId = (int) Db::insert('pos_device_registrations', [
            'cmp_id'            => $ctx->cmpId,
            'terminal_id'       => $terminalId,
            'device_uuid'       => $deviceUuid,
            'device_label'      => self::text($body['device_label'] ?? null),
            'device_token_hash' => hash('sha256', $token),
            'status'            => 'ACTIVE',
            'registered_by'     => $auth->uuid,
        ], 'device_id');

        Audit::record($ctx, $auth, 'device.registered', 'device', $deviceId, null, ['terminal_id' => $terminalId, 'device_uuid' => $deviceUuid]);

        Http::data([
            'device_id'   => $deviceId,
            'device_uuid' => $deviceUuid,
            // Shown once. There is no endpoint that returns it again, because
            // there is nothing stored that could.
            'device_token' => $token,
            'notice' => 'Copy this token now — it is not shown again.',
        ], 201);
    }

    public static function revokeDevice(string $id): void
    {
        [$auth, $ctx] = self::enter();
        Permissions::assert($ctx, $auth, 'terminal.manage');

        $reason = self::text(Http::body()['reason'] ?? null);
        if ($reason === null) {
            Http::validationFailed('Say why the device is being revoked.', ['field' => 'reason']);
        }

        if (Db::update('pos_device_registrations', [
            'status'         => 'REVOKED',
            'revoked_at'     => gmdate('Y-m-d H:i:s'),
            'revoked_reason' => $reason,
        ], ['device_id' => (int) $id, 'cmp_id' => $ctx->cmpId]) === 0) {
            Http::notFound('That device is not registered.');
        }

        Audit::record($ctx, $auth, 'device.revoked', 'device', (int) $id, null, null, $reason);
        Http::data(['revoked' => true]);
    }

    public static function devices(): void
    {
        [$auth, $ctx] = self::enter();
        Permissions::assert($ctx, $auth, 'terminal.manage');

        Http::data(['devices' => Db::all(
            'SELECT device_id, terminal_id, device_uuid, device_label, status, last_seen_at,
                    registered_by, revoked_at, revoked_reason, created_at
             FROM pos_device_registrations WHERE cmp_id = :cmp ORDER BY device_id DESC',
            ['cmp' => $ctx->cmpId],
        )]);
    }

    // -----------------------------------------------------------------------
    // Floors, tables, stations
    // -----------------------------------------------------------------------

    public static function floors(): void
    {
        [$auth, $ctx] = self::enter();
        Http::data(['floors' => Db::all(
            'SELECT * FROM pos_floors WHERE cmp_id = :cmp ORDER BY sort_order, floor_name',
            ['cmp' => $ctx->cmpId],
        )]);
    }

    public static function createFloor(): void
    {
        [$auth, $ctx] = self::enter();
        Permissions::assert($ctx, $auth, 'terminal.manage');

        $body = Http::body();
        $floorId = (int) Db::insert('pos_floors', [
            'cmp_id'      => $ctx->cmpId,
            'location_id' => self::id($body['location_id'] ?? null),
            'floor_code'  => self::text($body['floor_code'] ?? null) ?? 'GF',
            'floor_name'  => self::text($body['floor_name'] ?? null) ?? 'Ground floor',
            'sort_order'  => (int) ($body['sort_order'] ?? 0),
        ], 'floor_id');

        Http::data(Db::first('SELECT * FROM pos_floors WHERE floor_id = :id', ['id' => $floorId]) ?? [], 201);
    }

    public static function createTable(): void
    {
        [$auth, $ctx] = self::enter();
        Permissions::assert($ctx, $auth, 'terminal.manage');

        $body = Http::body();
        $floorId = self::id($body['floor_id'] ?? null);
        if ($floorId === null) {
            Http::validationFailed('Which floor is the table on?', ['field' => 'floor_id']);
        }

        $tableId = (int) Db::insert('pos_tables', [
            'cmp_id'     => $ctx->cmpId,
            'floor_id'   => $floorId,
            'table_code' => self::text($body['table_code'] ?? null) ?? 'T1',
            'table_name' => self::text($body['table_name'] ?? null),
            'seats'      => max(1, (int) ($body['seats'] ?? 2)),
            'layout_x'   => isset($body['layout_x']) ? (int) $body['layout_x'] : null,
            'layout_y'   => isset($body['layout_y']) ? (int) $body['layout_y'] : null,
        ], 'table_id');

        Http::data(Db::first('SELECT * FROM pos_tables WHERE table_id = :id', ['id' => $tableId]) ?? [], 201);
    }

    public static function stations(): void
    {
        [$auth, $ctx] = self::enter();
        Http::data(['stations' => Db::all(
            'SELECT * FROM pos_kds_stations WHERE cmp_id = :cmp ORDER BY sort_order, station_name',
            ['cmp' => $ctx->cmpId],
        )]);
    }

    public static function createStation(): void
    {
        [$auth, $ctx] = self::enter();
        Permissions::assert($ctx, $auth, 'terminal.manage');

        $body = Http::body();
        $locationId = self::id($body['location_id'] ?? null);
        if ($locationId === null) {
            Http::validationFailed('Which outlet is the station in?', ['field' => 'location_id']);
        }

        $stationId = (int) Db::insert('pos_kds_stations', [
            'cmp_id'             => $ctx->cmpId,
            'location_id'        => $locationId,
            'station_code'       => self::text($body['station_code'] ?? null) ?? 'MAIN',
            'station_name'       => self::text($body['station_name'] ?? null) ?? 'Main kitchen',
            'station_kind'       => self::text($body['station_kind'] ?? null) ?? 'main',
            'printer_name'       => self::text($body['printer_name'] ?? null),
            'late_after_minutes' => max(1, (int) ($body['late_after_minutes'] ?? 15)),
            'sort_order'         => (int) ($body['sort_order'] ?? 0),
        ], 'station_id');

        Http::data(Db::first('SELECT * FROM pos_kds_stations WHERE station_id = :id', ['id' => $stationId]) ?? [], 201);
    }

    // -----------------------------------------------------------------------
    // Roles
    // -----------------------------------------------------------------------

    public static function saveProfile(?string $id = null): void
    {
        [$auth, $ctx] = self::enter();
        Permissions::assert($ctx, $auth, 'access.manage');

        $body = Http::body();
        $permissions = array_values(array_filter(
            (array) ($body['permissions'] ?? []),
            static fn ($p) => is_string($p) && Permissions::exists($p),
        ));

        if ($id === null) {
            $profileId = (int) Db::insert(Permissions::TABLE_PROFILES, [
                'cmp_id'       => $ctx->cmpId,
                'profile_code' => self::text($body['profile_code'] ?? null) ?? ('role_' . bin2hex(random_bytes(3))),
                'profile_name' => self::text($body['profile_name'] ?? null) ?? 'New role',
                'description'  => self::text($body['description'] ?? null),
                'permissions'  => $permissions,
            ], 'profile_id');
            Audit::record($ctx, $auth, 'role.created', 'profile', $profileId, null, ['permissions' => $permissions]);
            Http::data(Db::first('SELECT * FROM ' . Permissions::TABLE_PROFILES . ' WHERE profile_id = :id', ['id' => $profileId]) ?? [], 201);
        }

        $existing = Db::first(
            'SELECT * FROM ' . Permissions::TABLE_PROFILES . ' WHERE profile_id = :id AND cmp_id = :cmp',
            ['id' => (int) $id, 'cmp' => $ctx->cmpId],
        );
        if ($existing === null) {
            Http::notFound('That role does not exist.');
        }
        if ($existing['is_system'] && isset($body['permissions'])) {
            Http::conflict('The shipped roles cannot be edited. Copy one and change the copy.');
        }

        $values = array_filter([
            'profile_name' => self::text($body['profile_name'] ?? null),
            'description'  => self::text($body['description'] ?? null),
        ], static fn ($v) => $v !== null);
        if (isset($body['permissions'])) {
            $values['permissions'] = $permissions;
        }
        if (array_key_exists('is_active', $body)) {
            $values['is_active'] = (bool) $body['is_active'];
        }

        Db::update(Permissions::TABLE_PROFILES, $values, ['profile_id' => (int) $id, 'cmp_id' => $ctx->cmpId]);
        Audit::record($ctx, $auth, 'role.changed', 'profile', (int) $id, $existing, $values);

        Http::data(Db::first('SELECT * FROM ' . Permissions::TABLE_PROFILES . ' WHERE profile_id = :id', ['id' => (int) $id]) ?? []);
    }

    public static function assignProfile(): void
    {
        [$auth, $ctx] = self::enter();
        Permissions::assert($ctx, $auth, 'access.manage');

        $body = Http::body();
        $userUuid = self::text($body['user_uuid'] ?? null);
        $profileId = self::id($body['profile_id'] ?? null);

        if ($userUuid === null || $profileId === null) {
            Http::validationFailed('Say who gets which role.');
        }

        Db::run(
            'DELETE FROM ' . Permissions::TABLE_ASSIGNMENTS . ' WHERE cmp_id = :cmp AND user_uuid = :uuid',
            ['cmp' => $ctx->cmpId, 'uuid' => $userUuid],
        );

        // A switch PIN is for changing cashier mid-shift without a full sign-in.
        // Stored hashed, like any other credential.
        $pin = self::text($body['switch_pin'] ?? null);

        $assignmentId = (int) Db::insert(Permissions::TABLE_ASSIGNMENTS, [
            'cmp_id'          => $ctx->cmpId,
            'user_uuid'       => $userUuid,
            'profile_id'      => $profileId,
            'switch_pin_hash' => $pin === null ? null : password_hash($pin, PASSWORD_DEFAULT),
        ], 'assignment_id');

        Audit::record($ctx, $auth, 'role.assigned', 'assignment', $assignmentId, null, ['user_uuid' => $userUuid, 'profile_id' => $profileId]);

        Http::data(['assignment_id' => $assignmentId], 201);
    }

    public static function assignments(): void
    {
        [$auth, $ctx] = self::enter();
        Permissions::assert($ctx, $auth, 'access.manage');

        Http::data(['assignments' => Db::all(
            'SELECT a.assignment_id, a.user_uuid, a.profile_id, p.profile_name,
                    (a.switch_pin_hash IS NOT NULL) AS has_switch_pin, a.created_at
             FROM ' . Permissions::TABLE_ASSIGNMENTS . ' a
             JOIN ' . Permissions::TABLE_PROFILES . ' p ON p.profile_id = a.profile_id
             WHERE a.cmp_id = :cmp ORDER BY p.profile_name, a.user_uuid',
            ['cmp' => $ctx->cmpId],
        )]);
    }

    private static function mode(mixed $raw): ?string
    {
        $value = is_string($raw) ? strtolower(trim($raw)) : null;
        if ($value === null || $value === '') {
            return null;
        }

        return in_array($value, ['retail', 'restaurant', 'quick_service', 'hybrid'], true) ? $value : null;
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
}
