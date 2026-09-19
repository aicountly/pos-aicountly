<?php

declare(strict_types=1);

namespace Aicountly\Api;

use PDOException;

/**
 * A query whose placeholders and values do not agree, said in those terms.
 *
 * PostgreSQL reports this as "bind message supplies 4 parameters, but prepared
 * statement \"pdo_stmt_00000006\" requires 5", which names neither the query
 * nor the parameter. With emulated prepares off — and they are off here on
 * purpose, see Db — that message is what a placeholder with no value looks
 * like, and it is the whole of what the caller gets. This subclass exists to
 * carry the enriched message while keeping the driver's SQLSTATE, so
 * DbDiagnosis still classifies it and nothing upstream has to know it happened.
 */
final class DbParameterMismatch extends PDOException
{
    public function __construct(string $message, PDOException $previous)
    {
        parent::__construct($message, 0, $previous);

        // PDO puts SQLSTATE in `code` as a string, which the int-typed parent
        // constructor cannot take. Both are writable from a subclass.
        $this->code = $previous->getCode();
        $this->errorInfo = $previous->errorInfo;
    }
}
