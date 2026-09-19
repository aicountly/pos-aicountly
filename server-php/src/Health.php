<?php

declare(strict_types=1);

namespace Aicountly\Api;

use PDOException;

/**
 * What /api/health can honestly say about this deployment.
 *
 * WHY THIS EXISTS. Health used to answer 200 as soon as PHP was serving, which
 * is a liveness check and nothing more. That let a deploy go green, and a
 * monitor stay quiet, on an app where every real endpoint answered 503 because
 * its database had never been created. "The process is up" and "the app works"
 * are different claims and only one of them is useful.
 *
 * It now also reports whether the database answers and whether the schema has
 * been applied, which is the difference between an app somebody can use and one
 * that only looks alive.
 *
 * WHY IT REPORTS THE DRIVER AND THE .ENV. Those two facts are about the PHP
 * that answers THIS request, and no other check can see them. cPanel configures
 * the web PHP and the SSH PHP separately, so a deploy can run migrations
 * successfully over SSH and leave the website unable to load pdo_pgsql at all —
 * from the outside that looks exactly like a database that is down. Reading
 * them here, from the web handler, is what tells those two apart.
 *
 * WHAT IT MUST NOT SAY. This endpoint is UNAUTHENTICATED and public. The
 * driver's own message names the database, the role and the host — PostgreSQL's
 * "no pg_hba.conf entry for host X, user Y, database Z" hands all three to
 * anyone who asks. So the reason is reduced to a category here and the detail
 * goes to the error log, where the person fixing it can read it and a passer-by
 * cannot. Everything reported below is a boolean or a category for the same
 * reason: it says whether a thing is set, never what it is set to.
 */
final class Health
{
    /** Migration bookkeeping table for this product. */
    private const MIGRATIONS_TABLE = 'pos_sql_migrations';

    /**
     * @return array<string, mixed>
     */
    public static function database(): array
    {
        // Reported whatever happens next, because these are the two causes a
        // connection error cannot distinguish itself from.
        $config = [
            'driver'     => DbDiagnosis::driverLoaded(),
            'env_file'   => is_readable(__DIR__ . '/../.env'),
            'configured' => Env::get('DB_NAME') !== '' && Env::get('DB_USER') !== '',
        ];

        // Asked first, and answered without touching the network: a PHP that
        // cannot load pdo_pgsql fails in a way that is indistinguishable from
        // an unreachable server, and on some builds it fails before PDOException
        // itself exists to be caught.
        if ($config['driver'] !== true) {
            return [
                'reachable' => false,
                'reason'    => 'driver_missing',
                'config'    => $config,
                'schema'    => null,
            ];
        }

        try {
            $pdo = Db::connect();
        } catch (PDOException $e) {
            $reason = DbDiagnosis::of($e)['reason'];
            DbDiagnosis::log($e, 'health', $reason);

            return [
                'reachable' => false,
                'reason'    => $reason,
                'config'    => $config,
                'schema'    => null,
            ];
        } catch (\Throwable $e) {
            error_log('[health] database check failed: ' . $e->getMessage());

            return ['reachable' => false, 'reason' => 'error', 'config' => $config, 'schema' => null];
        }

        $onDisk = count(glob(__DIR__ . '/../database/migrations/*.sql') ?: []);

        try {
            $applied = (int) $pdo->query('SELECT COUNT(*) FROM ' . self::MIGRATIONS_TABLE)->fetchColumn();
        } catch (\Throwable) {
            // No bookkeeping table means migrate.php has never run here. That is
            // a normal state on a host somebody has only just created, not an
            // error worth logging.
            $applied = 0;
        }

        return [
            'reachable' => true,
            'reason'    => null,
            'config'    => $config,
            'schema'    => [
                'applied' => $applied,
                'pending' => max(0, $onDisk - $applied),
                // The one field worth reading at a glance: can this app be used?
                'ready'   => $onDisk > 0 && $applied >= $onDisk,
            ],
        ];
    }

    /**
     * One sentence naming what to do next, or null when nothing is wrong.
     *
     * Health is the page somebody opens when the app is broken, so it should
     * not make them look the category up somewhere else.
     */
    public static function advice(array $database): ?string
    {
        if ($database['reachable'] !== true) {
            return DbDiagnosis::describe((string) ($database['reason'] ?? 'error'))['fix'];
        }

        if (($database['schema']['ready'] ?? false) !== true) {
            return DbDiagnosis::describe('schema_missing')['fix'];
        }

        return null;
    }
}
