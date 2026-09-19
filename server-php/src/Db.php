<?php

declare(strict_types=1);

namespace Aicountly\Api;

use PDO;
use PDOException;
use PDOStatement;

/**
 * PostgreSQL connection for this product's OWN database.
 *
 * It reaches exactly one schema: the tables this product owns. It is never
 * pointed at Books, Inventory or Manage — those are read and written through
 * their HTTP APIs (see src/Clients). A cross-database join is not a shortcut
 * here, it is the architecture failing: two products would then hold two
 * answers to the same question and something would have to reconcile them.
 */
final class Db
{
    private static ?PDO $pdo = null;

    public static function connect(): PDO
    {
        if (self::$pdo instanceof PDO) {
            return self::$pdo;
        }

        // Checked before the credentials, because a PHP without the PostgreSQL
        // driver produces a connection error that reads exactly like a database
        // that is down — and cPanel configures the web PHP and the SSH PHP
        // separately, so migrations can run happily over SSH while every page
        // on the site fails here. Saying so plainly is the difference between
        // ticking one box in Select PHP Version and searching the network for a
        // fault that was never there.
        if (!DbDiagnosis::driverLoaded()) {
            throw new PDOException(
                'could not find driver: this PHP has no pdo_pgsql extension (SAPI ' . PHP_SAPI . ', PHP ' . PHP_VERSION . ').',
            );
        }

        $host = Env::get('DB_HOST', '127.0.0.1');
        $port = Env::get('DB_PORT', '5432');
        $name = Env::get('DB_NAME');
        $user = Env::get('DB_USER');
        $pass = Env::get('DB_PASS');

        if ($name === '' || $user === '') {
            throw new PDOException('Database is not configured (DB_NAME / DB_USER missing from api/.env).');
        }

        $dsn = sprintf('pgsql:host=%s;port=%s;dbname=%s', $host, $port, $name);

        $pdo = new PDO($dsn, $user, $pass, [
            PDO::ATTR_ERRMODE            => PDO::ERRMODE_EXCEPTION,
            PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
            // Real prepares. Emulation would send NUMERIC(18,4) money as a string
            // literal and let PostgreSQL guess the type, which is how a rate
            // silently becomes text in one query and numeric in the next.
            PDO::ATTR_EMULATE_PREPARES   => false,
        ]);

        $schema = Env::get('DB_SCHEMA');
        if ($schema !== '') {
            $pdo->exec('SET search_path TO ' . self::quoteIdentifier($schema) . ', public');
        }

        return self::$pdo = $pdo;
    }

    /** @param array<string|int, mixed> $params */
    public static function run(string $sql, array $params = []): PDOStatement
    {
        $stmt = self::connect()->prepare($sql);

        try {
            $stmt->execute($params);
        } catch (PDOException $e) {
            throw self::nameTheParameter($e, $sql, $params);
        }

        return $stmt;
    }

    /**
     * Say WHICH parameter, when PostgreSQL will only say how many.
     *
     * Emulated prepares are off (see connect()), so a placeholder the caller
     * forgot to supply is not a PHP error and not caught by anything here: the
     * statement reaches PostgreSQL, which counts one more parameter than the
     * bind supplies and rejects all of it with
     *
     *     bind message supplies 4 parameters, but prepared statement
     *     "pdo_stmt_00000006" requires 5
     *
     * — a sentence naming neither the query nor the missing name, on a
     * generated statement id that means nothing outside the connection. That
     * is what one live endpoint answered 503 with. Both halves of the answer
     * are already here: the names in the SQL and the keys in the array.
     *
     * @param array<string|int, mixed> $params
     */
    private static function nameTheParameter(PDOException $e, string $sql, array $params): PDOException
    {
        if (!str_contains($e->getMessage(), 'bind message supplies')) {
            return $e;
        }

        // `:name`, but never the `::` of a PostgreSQL cast: the lookbehind
        // stops `:from::date` from being read as a second placeholder `:date`.
        if (preg_match_all('/(?<!:):([a-zA-Z_][a-zA-Z0-9_]*)/', $sql, $matches) === false) {
            return $e;
        }

        $wanted = array_values(array_unique($matches[1]));
        if ($wanted === []) {
            return $e;
        }

        // Only the missing direction is handled here. A value with no
        // placeholder never reaches PostgreSQL: PDO rejects it first with
        // "HY093 Invalid parameter number: :status", which already names it.
        $missing = array_values(array_diff($wanted, array_map('strval', array_keys($params))));
        if ($missing === []) {
            return $e;
        }

        return new DbParameterMismatch(
            $e->getMessage() . ' -- never supplied: :' . implode(', :', $missing),
            $e,
        );
    }

    /**
     * @param array<string|int, mixed> $params
     * @return array<string, mixed>|null
     */
    public static function first(string $sql, array $params = []): ?array
    {
        $row = self::run($sql, $params)->fetch();

        return $row === false ? null : $row;
    }

    /**
     * @param array<string|int, mixed> $params
     * @return list<array<string, mixed>>
     */
    public static function all(string $sql, array $params = []): array
    {
        return self::run($sql, $params)->fetchAll();
    }

    /** @param array<string|int, mixed> $params */
    public static function scalar(string $sql, array $params = []): mixed
    {
        $value = self::run($sql, $params)->fetchColumn();

        return $value === false ? null : $value;
    }

    /**
     * INSERT ... RETURNING, so the generated key comes back on the same round trip.
     *
     * @param array<string, mixed> $values
     */
    public static function insert(string $table, array $values, string $returning = 'id'): mixed
    {
        $columns = array_keys($values);
        $sql = sprintf(
            'INSERT INTO %s (%s) VALUES (%s) RETURNING %s',
            self::quoteIdentifier($table),
            implode(', ', array_map([self::class, 'quoteIdentifier'], $columns)),
            implode(', ', array_map(static fn (string $c) => ':' . $c, $columns)),
            self::quoteIdentifier($returning),
        );

        return self::run($sql, self::bindable($values))->fetchColumn();
    }

    /**
     * @param array<string, mixed> $values
     * @param array<string, mixed> $where
     */
    public static function update(string $table, array $values, array $where): int
    {
        if ($values === []) {
            return 0;
        }
        $set = implode(', ', array_map(
            static fn (string $c) => self::quoteIdentifier($c) . ' = :set_' . $c,
            array_keys($values),
        ));
        $conds = implode(' AND ', array_map(
            static fn (string $c) => self::quoteIdentifier($c) . ' = :where_' . $c,
            array_keys($where),
        ));

        $params = [];
        foreach (self::bindable($values) as $k => $v) {
            $params['set_' . $k] = $v;
        }
        foreach (self::bindable($where) as $k => $v) {
            $params['where_' . $k] = $v;
        }

        return self::run(
            sprintf('UPDATE %s SET %s WHERE %s', self::quoteIdentifier($table), $set, $conds),
            $params,
        )->rowCount();
    }

    /**
     * Run $work inside one transaction, rolling back on any throwable.
     *
     * Nested calls join the outer transaction rather than opening a second one —
     * PostgreSQL has no nested BEGIN, and a nested COMMIT here would end the
     * outer caller's transaction early and leave its later writes unprotected.
     *
     * @template T
     * @param callable(PDO): T $work
     * @return T
     */
    public static function transaction(callable $work): mixed
    {
        $pdo = self::connect();
        if ($pdo->inTransaction()) {
            return $work($pdo);
        }

        $pdo->beginTransaction();
        try {
            $result = $work($pdo);
            $pdo->commit();

            return $result;
        } catch (\Throwable $e) {
            if ($pdo->inTransaction()) {
                $pdo->rollBack();
            }
            throw $e;
        }
    }

    /**
     * Arrays and objects are stored as JSON; booleans as PostgreSQL literals.
     *
     * @param array<string, mixed> $values
     * @return array<string, mixed>
     */
    private static function bindable(array $values): array
    {
        $out = [];
        foreach ($values as $key => $value) {
            if (is_array($value)) {
                $out[$key] = json_encode($value, JSON_UNESCAPED_UNICODE);
            } elseif (is_bool($value)) {
                $out[$key] = $value ? 'true' : 'false';
            } else {
                $out[$key] = $value;
            }
        }

        return $out;
    }

    /** Identifiers come from this codebase, never from a request; the check is a guard against a future typo. */
    public static function quoteIdentifier(string $name): string
    {
        if (preg_match('/^[a-z_][a-z0-9_]*$/', $name) !== 1) {
            throw new PDOException('Refusing to use "' . $name . '" as an SQL identifier.');
        }

        return '"' . $name . '"';
    }

    /** Decode a jsonb column that PDO hands back as a string. */
    public static function jsonColumn(mixed $raw): array
    {
        if (is_array($raw)) {
            return $raw;
        }
        if (!is_string($raw) || $raw === '') {
            return [];
        }
        $decoded = json_decode($raw, true);

        return is_array($decoded) ? $decoded : [];
    }
}
