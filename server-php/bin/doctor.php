<?php

declare(strict_types=1);

/**
 * Why the API cannot reach its database, answered on the server.
 *
 *   php bin/doctor.php            check everything, print what is wrong
 *   php bin/doctor.php --quiet    print only the failures
 *
 * Run it from the api folder on the host that serves the site. It checks the
 * same things in the same order the app does — PHP, driver, .env, TCP, login,
 * schema, privileges — and stops at the first one that is actually broken,
 * because every check after a failed connection reports the same failure again.
 *
 * It prints full driver messages, including the database and role names. That
 * is the whole point of it being a CLI tool: the person running it already has
 * the .env open. Nothing here is ever served over HTTP — see the guard below.
 *
 * Exit codes: 0 the app can use its database, 1 it cannot.
 */

namespace Aicountly\Api;

// This file sits in the document root, under api/bin, where Apache will serve
// any real file. Running the diagnostics from a browser would hand a stranger
// the host, database and role names in the clear. It is CLI-only, and says so
// here as well as in .htaccess, because .htaccess needs AllowOverride to be on
// and this does not.
if (PHP_SAPI !== 'cli') {
    http_response_code(404);
    exit;
}

require __DIR__ . '/../src/Env.php';
require __DIR__ . '/../src/Autoload.php';

$envPath = __DIR__ . '/../.env';
Env::load($envPath);

$quiet = in_array('--quiet', array_slice($argv, 1), true);

$failures = [];

function ok(string $label, string $detail = ''): void
{
    global $quiet;
    if (!$quiet) {
        echo "  ok    {$label}" . ($detail === '' ? '' : "  —  {$detail}") . "\n";
    }
}

function bad(string $label, string $detail, string $fix): void
{
    global $failures;
    echo "  FAIL  {$label}\n";
    foreach (explode("\n", wordwrap($detail, 88)) as $line) {
        echo "        {$line}\n";
    }
    echo "\n        Fix: ";
    $wrapped = explode("\n", wordwrap($fix, 82));
    echo array_shift($wrapped) . "\n";
    foreach ($wrapped as $line) {
        echo "             {$line}\n";
    }
    echo "\n";
    $failures[] = $label;
}

function heading(string $text): void
{
    global $quiet;
    if (!$quiet) {
        echo "\n{$text}\n";
    }
}

/** Stop here: everything downstream would report this same failure again. */
function giveUp(): never
{
    echo "\n" . str_repeat('-', 72) . "\n";
    echo "Not usable. Fix the failure above and run this again.\n";
    exit(1);
}

echo "POS API — database diagnostics\n";
echo str_repeat('=', 72) . "\n";

// ---------------------------------------------------------------------------
// 1. The PHP running this
// ---------------------------------------------------------------------------

heading('PHP');

echo $quiet ? '' : "  note  binary: " . (PHP_BINARY ?: 'unknown') . "\n";

if (PHP_VERSION_ID >= 80100) {
    ok('version', PHP_VERSION);
} else {
    bad(
        'version',
        'This PHP is ' . PHP_VERSION . '. The API needs 8.1 or newer (it uses readonly properties, which are a parse error before 8.1).',
        'Run this with a newer build, e.g. /opt/cpanel/ea-php84/root/usr/bin/php bin/doctor.php — cPanel keeps every installed version under /opt/cpanel.',
    );
    giveUp();
}

if (DbDiagnosis::driverLoaded()) {
    ok('pdo_pgsql', 'PDO drivers: ' . implode(', ', \PDO::getAvailableDrivers()));
} else {
    bad(
        'pdo_pgsql',
        'This PHP has no PostgreSQL driver. Available PDO drivers: '
            . (implode(', ', \PDO::getAvailableDrivers()) ?: 'none'),
        DbDiagnosis::describe('driver_missing')['fix'],
    );
    giveUp();
}

echo $quiet ? '' : "  note  this is the CLI PHP. cPanel configures the WEB PHP separately, so\n"
    . "        check GET /api/health too — its \"config.driver\" is the web one.\n";

// ---------------------------------------------------------------------------
// 2. The .env
// ---------------------------------------------------------------------------

heading('Configuration');

$realEnv = realpath($envPath);

if ($realEnv !== false && is_readable($realEnv)) {
    ok('.env', $realEnv);
} else {
    bad(
        '.env',
        'No readable .env at ' . $envPath . '. The API reads it on every request and it is never deployed, so it has to exist on this server.',
        'cp .env.example .env from the api folder, fill in the database section, and make sure the web user can read it (chmod 640).',
    );
    giveUp();
}

$host = Env::get('DB_HOST', '127.0.0.1');
$port = Env::get('DB_PORT', '5432');
$name = Env::get('DB_NAME');
$user = Env::get('DB_USER');
$pass = Env::get('DB_PASS');
$schema = Env::get('DB_SCHEMA');

$missing = [];
if ($name === '') {
    $missing[] = 'DB_NAME';
}
if ($user === '') {
    $missing[] = 'DB_USER';
}

if ($missing === []) {
    ok('DB_HOST', $host . ':' . $port);
    ok('DB_NAME', $name);
    ok('DB_USER', $user);
    ok('DB_PASS', $pass === '' ? 'empty (fine only if the server trusts this role without one)' : 'set, ' . strlen($pass) . ' characters');
    if ($schema !== '') {
        ok('DB_SCHEMA', $schema);
    }
    if (!str_contains($name, '_') || !str_contains($user, '_')) {
        echo "  note  cPanel prefixes both names with the account, e.g. cpaneluser_pos.\n"
            . "        Neither of these has an underscore, which is worth a second look.\n";
    }
} else {
    bad(
        'database settings',
        implode(' and ', $missing) . ' ' . (count($missing) === 1 ? 'is' : 'are') . ' missing from ' . $realEnv
            . '. Note that a key with an empty value counts as missing, and that a real environment variable of the same name wins over the file.',
        DbDiagnosis::describe('not_configured')['fix'],
    );
    giveUp();
}

// ---------------------------------------------------------------------------
// 3. Is anything listening
// ---------------------------------------------------------------------------

heading('Network');

$socket = @fsockopen($host, (int) $port, $errno, $errstr, 5.0);
if (is_resource($socket)) {
    fclose($socket);
    ok('tcp', 'something is listening on ' . $host . ':' . $port);
} else {
    bad(
        'tcp',
        'Nothing answered on ' . $host . ':' . $port . ' (' . ($errstr ?: 'no detail') . ', errno ' . $errno . ').',
        DbDiagnosis::describe('unreachable')['fix'],
    );
    giveUp();
}

// ---------------------------------------------------------------------------
// 4. Logging in
// ---------------------------------------------------------------------------

heading('Connection');

try {
    $pdo = Db::connect();
    ok('connect', 'authenticated as ' . $user);
} catch (\PDOException $e) {
    $diagnosis = DbDiagnosis::of($e);
    bad('connect', 'SQLSTATE[' . $e->getCode() . '] ' . $e->getMessage(), $diagnosis['fix']);
    giveUp();
}

try {
    $who = $pdo->query('SELECT current_database() AS db, current_user AS role, version() AS server')->fetch();
    ok('identity', 'database ' . $who['db'] . ', role ' . $who['role']);
    ok('server', explode(' on ', (string) $who['server'])[0]);
    ok('search_path', (string) $pdo->query('SHOW search_path')->fetchColumn());
} catch (\PDOException $e) {
    bad('query', 'SQLSTATE[' . $e->getCode() . '] ' . $e->getMessage(), DbDiagnosis::of($e)['fix']);
    giveUp();
}

// ---------------------------------------------------------------------------
// 5. The schema
// ---------------------------------------------------------------------------

heading('Schema');

$files = glob(__DIR__ . '/../database/migrations/*.sql') ?: [];
sort($files, SORT_STRING);

if ($files === []) {
    bad(
        'migration files',
        'No .sql files under api/database/migrations. The deploy ships that folder, so an api/ without it is a partial upload.',
        'Re-run the deploy workflow, or rsync server-php/ to api/ again.',
    );
    giveUp();
}

try {
    $applied = [];
    foreach (Db::all('SELECT filename, checksum FROM pos_sql_migrations ORDER BY filename') as $row) {
        $applied[(string) $row['filename']] = (string) $row['checksum'];
    }
    ok('migration table', count($applied) . ' recorded');
} catch (\PDOException $e) {
    if (DbDiagnosis::of($e)['reason'] === 'schema_missing') {
        bad(
            'migration table',
            'This database has no pos_sql_migrations table, so no migration has ever been applied to it. Every endpoint that reads a row will answer 503 until they are.',
            DbDiagnosis::describe('schema_missing')['fix'],
        );
    } else {
        bad('migration table', 'SQLSTATE[' . $e->getCode() . '] ' . $e->getMessage(), DbDiagnosis::of($e)['fix']);
    }
    giveUp();
}

$pending = [];
$drifted = [];
foreach ($files as $path) {
    $file = basename($path);
    $checksum = hash('sha256', (string) file_get_contents($path));
    if (!isset($applied[$file])) {
        $pending[] = $file;
    } elseif ($applied[$file] !== $checksum) {
        $drifted[] = $file;
    }
}

if ($pending === []) {
    ok('migrations', count($files) . ' of ' . count($files) . ' applied');
} else {
    bad(
        'migrations',
        count($pending) . ' migration(s) have never been applied here: ' . implode(', ', $pending),
        'From the api folder: ' . PHP_BINARY . ' bin/migrate.php',
    );
}

if ($drifted !== []) {
    bad(
        'migration drift',
        'Applied but edited since: ' . implode(', ', $drifted) . '. The file and the database no longer agree, and re-applying would not undo what the old version did.',
        'Add a new migration for the change instead of editing an applied one. If the edit was cosmetic, the recorded checksum is what needs correcting.',
    );
}

// ---------------------------------------------------------------------------
// 6. Can the role actually read its tables
// ---------------------------------------------------------------------------

heading('Privileges');

foreach (['pos_carts', 'pos_register_sessions', 'pos_settings'] as $table) {
    try {
        Db::scalar('SELECT COUNT(*) FROM ' . Db::quoteIdentifier($table));
        ok('select ' . $table);
    } catch (\PDOException $e) {
        $diagnosis = DbDiagnosis::of($e);
        bad('select ' . $table, 'SQLSTATE[' . $e->getCode() . '] ' . $e->getMessage(), $diagnosis['fix']);
        break;
    }
}

// ---------------------------------------------------------------------------

echo "\n" . str_repeat('-', 72) . "\n";

if ($failures === []) {
    echo "The database is reachable and the schema is up to date.\n\n";
    echo "If the site still reports a database error, the WEB PHP is the one to\n";
    echo "look at, not this one. Open https://<your host>/api/health and read\n";
    echo "database.config.driver — false there means the domain's PHP has no\n";
    echo "pdo_pgsql even though this CLI does.\n";
    exit(0);
}

echo count($failures) . " problem(s): " . implode(', ', $failures) . "\n";
exit(1);
