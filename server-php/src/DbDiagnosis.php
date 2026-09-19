<?php

declare(strict_types=1);

namespace Aicountly\Api;

/**
 * WHY A DATABASE CALL FAILED, said in one word.
 *
 * WHY THIS EXISTS. Every database failure used to reach the screen as the same
 * sentence: "The POS database is not reachable right now. Please retry." That
 * sentence is true of exactly one of the causes below. It was also shown when
 * the schema had never been installed, when this server's PHP had no PostgreSQL
 * driver, when the password was wrong, and when the role could not read a table
 * — four things with four different fixes, none of which is retrying. A person
 * looking at that banner, with the credentials in front of them and no way to
 * tell any of those apart, has been told nothing.
 *
 * So a failure is classified once, here, and everything that reports one reads
 * from this: the front controller's 503, GET /api/health, and bin/doctor.php.
 *
 * WHAT IT MUST NOT SAY. PostgreSQL's own text names the database, the role and
 * the host — "no pg_hba.conf entry for host X, user Y, database Z" hands all
 * three to whoever reads it. The public message here therefore says what is
 * wrong and what fixes it, and never what anything is called. The driver's full
 * text goes to the error log, under a reference the operator can grep for.
 */
final class DbDiagnosis
{
    /**
     * SQLSTATE classes worth telling apart, by the five-character code
     * PostgreSQL returns. Connection-time failures are NOT in here: libpq
     * reports all of them as 08006 regardless of cause, so a wrong password
     * and an unplugged server arrive with the same code and are separated by
     * message instead. See fromMessage().
     */
    private const BY_SQLSTATE = [
        '3D000' => 'no_such_database',
        '28P01' => 'refused',
        '28000' => 'refused',
        '42P01' => 'schema_missing',
        '42P02' => 'schema_missing',
        '42703' => 'schema_stale',
        '42501' => 'permission_denied',
        '53300' => 'overloaded',
        '53400' => 'overloaded',
        '57P03' => 'starting_up',
        '08001' => 'unreachable',
        '08004' => 'refused',
        '08007' => 'unreachable',
        '57P01' => 'unreachable',
        '57P02' => 'unreachable',
    ];

    /**
     * What each reason means to the person reading it, and what to do about it.
     *
     * `retryable` is the one the UI acts on: pressing the button again can only
     * help where the cause is transient. Offering Retry for a schema that was
     * never installed is an invitation to press it forever.
     *
     * @var array<string, array{message: string, fix: string, retryable: bool}>
     */
    private const REASONS = [
        'not_configured' => [
            'message'   => 'The POS database has not been configured on this server.',
            'fix'       => 'api/.env is missing DB_NAME or DB_USER. Copy api/.env.example to api/.env and fill in the database section. On cPanel both names carry the account prefix, e.g. cpaneluser_pos.',
            'retryable' => false,
        ],
        'driver_missing' => [
            'message'   => 'This server\'s PHP cannot talk to PostgreSQL.',
            'fix'       => 'The pdo_pgsql extension is not loaded in the PHP that serves this domain. Enable it in cPanel under Select PHP Version > Extensions (tick pdo_pgsql AND pgsql). Note the web PHP and the SSH PHP are configured separately, so migrations can succeed while the site still fails.',
            'retryable' => false,
        ],
        'unreachable' => [
            'message'   => 'The POS database is not reachable right now. Please retry.',
            'fix'       => 'Nothing answered on DB_HOST:DB_PORT. Check the PostgreSQL service is running and that DB_HOST is what this machine calls it — on cPanel that is localhost or 127.0.0.1, never the public hostname.',
            'retryable' => true,
        ],
        'refused' => [
            'message'   => 'The POS database refused this server\'s credentials.',
            'fix'       => 'The role or password was rejected, or pg_hba.conf has no entry for this host. Re-enter DB_USER and DB_PASS, and in cPanel confirm the user is added to the database with ALL PRIVILEGES.',
            'retryable' => false,
        ],
        'no_such_database' => [
            'message'   => 'The POS database named in this server\'s configuration does not exist.',
            'fix'       => 'DB_NAME names a database the server does not have. On cPanel the real name carries the account prefix, so a database created as "pos" is "cpaneluser_pos". Use the prefixed name.',
            'retryable' => false,
        ],
        'schema_missing' => [
            'message'   => 'The POS database is reachable, but its tables have not been created yet.',
            'fix'       => 'Migrations have never run against this database. From the api folder: php bin/migrate.php --status, then php bin/migrate.php.',
            'retryable' => false,
        ],
        'schema_stale' => [
            'message'   => 'The POS database is a version behind this release.',
            'fix'       => 'A column this code needs is not in the database, so some migrations are pending. From the api folder: php bin/migrate.php.',
            'retryable' => false,
        ],
        'permission_denied' => [
            'message'   => 'The POS database refused to let this server read its own tables.',
            'fix'       => 'The role connects but lacks privileges on the tables — usually because the tables were created by a different role. In cPanel add DB_USER to the database with ALL PRIVILEGES, or GRANT on the existing tables.',
            'retryable' => false,
        ],
        'overloaded' => [
            'message'   => 'The POS database is out of connections right now. Please retry.',
            'fix'       => 'The server hit max_connections or ran out of room. It usually clears on its own; if it does not, look for a process holding connections open.',
            'retryable' => true,
        ],
        'starting_up' => [
            'message'   => 'The POS database is still starting up. Please retry in a moment.',
            'fix'       => 'PostgreSQL is running but not yet accepting queries — normal for a few seconds after a restart or a crash recovery.',
            'retryable' => true,
        ],
        'error' => [
            'message'   => 'The POS database could not answer that request.',
            'fix'       => 'No specific cause was recognised. The driver\'s own message is in the PHP error log under the reference in this response, and php bin/doctor.php will reproduce it in full.',
            'retryable' => true,
        ],
    ];

    /**
     * Classify one failure.
     *
     * @return array{reason: string, message: string, fix: string, retryable: bool}
     */
    public static function of(\Throwable $e): array
    {
        return self::describe(self::reasonFor($e));
    }

    /**
     * Everything known about a reason, for callers that have the word already.
     *
     * @return array{reason: string, message: string, fix: string, retryable: bool}
     */
    public static function describe(string $reason): array
    {
        $known = self::REASONS[$reason] ?? self::REASONS['error'];

        return ['reason' => $reason] + $known;
    }

    private static function reasonFor(\Throwable $e): string
    {
        $sqlstate = (string) $e->getCode();
        if (isset(self::BY_SQLSTATE[$sqlstate])) {
            // A connect-time 08006 says only "the connection failed" and is
            // deliberately absent from the table; anything else that carries a
            // real SQLSTATE has already said what it means.
            return self::BY_SQLSTATE[$sqlstate];
        }

        return self::fromMessage($e->getMessage());
    }

    /**
     * The cause a connection failure only states in prose.
     *
     * Order matters: "role ... does not exist" and "database ... does not
     * exist" both contain the same three words, and the more specific test has
     * to run first or every refused role is reported as a missing database.
     */
    private static function fromMessage(string $message): string
    {
        $m = strtolower($message);

        return match (true) {
            str_contains($m, 'could not find driver'),
            str_contains($m, 'driver not found')          => 'driver_missing',
            str_contains($m, 'not configured')            => 'not_configured',
            str_contains($m, 'pg_hba'),
            str_contains($m, 'password authentication'),
            str_contains($m, 'authentication failed'),
            str_contains($m, 'role ') && str_contains($m, 'does not exist') => 'refused',
            str_contains($m, 'database ') && str_contains($m, 'does not exist') => 'no_such_database',
            str_contains($m, 'relation ') && str_contains($m, 'does not exist') => 'schema_missing',
            str_contains($m, 'column ') && str_contains($m, 'does not exist')   => 'schema_stale',
            str_contains($m, 'permission denied')         => 'permission_denied',
            str_contains($m, 'connection refused'),
            str_contains($m, 'could not connect'),
            str_contains($m, 'no such host'),
            str_contains($m, 'could not translate host'),
            str_contains($m, 'connection timed out'),
            str_contains($m, 'timeout expired')           => 'unreachable',
            str_contains($m, 'the database system is starting up') => 'starting_up',
            str_contains($m, 'too many clients')          => 'overloaded',
            default                                        => 'error',
        };
    }

    /**
     * Log the failure in full and return the reference that names this log line.
     *
     * The reference is the whole point: the caller is handed a short string,
     * the log line carries the same one, and `grep` closes the gap between a
     * screenshot of an error and the sentence that explains it.
     */
    public static function log(\Throwable $e, string $context, string $reason): string
    {
        $reference = strtoupper(bin2hex(random_bytes(3)));

        error_log(sprintf(
            '[pos] db %s ref=%s on %s: SQLSTATE[%s] %s @ %s:%d',
            $reason,
            $reference,
            $context === '' ? '(startup)' : $context,
            (string) $e->getCode(),
            $e->getMessage(),
            $e->getFile(),
            $e->getLine(),
        ));

        return $reference;
    }

    /** Whether the PHP answering THIS request can speak PostgreSQL at all. */
    public static function driverLoaded(): bool
    {
        return extension_loaded('pdo_pgsql') && in_array('pgsql', \PDO::getAvailableDrivers(), true);
    }
}
