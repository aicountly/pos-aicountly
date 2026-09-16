<?php

declare(strict_types=1);

namespace Aicountly\Api\Domain;

use Aicountly\Api\Audit;
use Aicountly\Api\Auth;
use Aicountly\Api\Clients\BooksClient;
use Aicountly\Api\Clients\InventoryClient;
use Aicountly\Api\Context;
use Aicountly\Api\Db;
use Aicountly\Api\Http;
use Aicountly\Api\IntegrationCommand;
use Aicountly\Api\Permissions;

/**
 * Counter returns — the customer is standing there with the goods.
 *
 * Three products, three jobs:
 *
 *   POS        the counter decision — may this come back, is it restocked or
 *              written off, who approved it, and what the customer got
 *   Inventory  the physical receipt back into stock
 *   Books      the credit note, and what it does to the receivable
 *
 * THE ORDER IS THE OPPOSITE OF A SALE, and deliberately. Goods come back first,
 * because the customer is handing them over and refusing to record that would
 * leave stock in the shop nobody knows about. The credit follows.
 *
 * REFUND, NOT PAYMENT. Cash going out of the drawer is recorded as a drawer
 * event and is an operational fact. The accounting side is Books' credit note.
 * Aicountly Pay does not exist yet, so a card refund is what the cashier did on
 * the external terminal, recorded with its slip reference — nothing here
 * pretends to reverse a card payment.
 */
final class ReturnService
{
    public const COMMAND_RECEIPT = 'pos.return.receipt';
    public const COMMAND_CREDIT  = 'pos.return.credit_note';

    public function __construct(
        private readonly Context $ctx,
        private readonly Auth $auth,
    ) {
    }

    /**
     * Take a return at the counter.
     *
     * @param array<string, mixed> $input
     */
    public function create(array $input): array
    {
        Permissions::assert($this->ctx, $this->auth, 'return.create');

        $lines = $this->normaliseLines($input['lines'] ?? []);
        if ($lines === []) {
            Http::validationFailed('What is coming back?', ['field' => 'lines']);
        }

        $resolution = self::text($input['resolution'] ?? null) ?? 'refund_cash';
        $allowed = ['refund_cash', 'refund_original', 'credit_note', 'exchange', 'store_credit'];
        if (!in_array($resolution, $allowed, true)) {
            Http::validationFailed('That is not a way this till settles a return.', ['field' => 'resolution', 'allowed' => $allowed]);
        }

        $settings = Db::first('SELECT * FROM pos_settings WHERE cmp_id = :cmp', ['cmp' => $this->ctx->cmpId]) ?? [];
        $reason = self::text($input['reason_note'] ?? null);
        if (($settings['require_reason_on_return'] ?? true) && $reason === null && self::text($input['reason_code'] ?? null) === null) {
            Http::validationFailed('Say why the goods are coming back.', ['field' => 'reason_note']);
        }

        $originalCartId = self::id($input['cart_id'] ?? null);
        $original = null;
        if ($originalCartId !== null) {
            $original = Db::first(
                'SELECT * FROM pos_carts WHERE cart_id = :id AND cmp_id = :cmp',
                ['id' => $originalCartId, 'cmp' => $this->ctx->cmpId],
            );
            if ($original === null) {
                Http::notFound('That sale is not on this till.');
            }
            if ($original['status'] !== 'COMPLETED') {
                Http::conflict('That sale never went through, so there is nothing to return. Void it instead.');
            }
            $this->assertNotOverReturned($originalCartId, $lines);
        }

        $refund = round(array_sum(array_map(static fn (array $l) => $l['line_amount'], $lines)), 4);

        return Db::transaction(function () use ($input, $lines, $resolution, $reason, $original, $originalCartId, $refund) {
            $returnId = (int) Db::insert('pos_returns', [
                'cmp_id'              => $this->ctx->cmpId,
                'fy_id'               => $this->ctx->fyId,
                'bo_id'               => $this->ctx->boId,
                'terminal_id'         => self::id($input['terminal_id'] ?? $original['terminal_id'] ?? null),
                'session_id'          => self::id($input['session_id'] ?? $original['session_id'] ?? null),
                'return_no'           => NumberSeries::next($this->ctx, 'return'),
                'return_date'         => self::date($input['return_date'] ?? null),
                'cart_id'             => $originalCartId,
                'books_invoice_id'    => self::id($original['books_voucher_id'] ?? $input['books_invoice_id'] ?? null),
                'books_invoice_uuid'  => self::text($original['books_voucher_uuid'] ?? $input['books_invoice_uuid'] ?? null),
                'books_invoice_no'    => self::text($original['books_voucher_no'] ?? null),
                'customer_account_id' => self::id($input['customer_account_id'] ?? $original['customer_account_id'] ?? null),
                'status'              => 'DRAFT',
                'resolution'          => $resolution,
                'restock'             => (bool) ($input['restock'] ?? true),
                'reason_code'         => self::text($input['reason_code'] ?? null),
                'reason_note'         => $reason,
                'refund_amount'       => $refund,
                'created_by'          => $this->auth->uuid,
            ], 'return_id');

            foreach ($lines as $line) {
                Db::insert('pos_return_lines', [
                    'return_id'      => $returnId,
                    'cmp_id'         => $this->ctx->cmpId,
                    'line_no'        => $line['line_no'],
                    'cart_line_id'   => $line['cart_line_id'],
                    'item_id'        => $line['item_id'],
                    'unit_id'        => $line['unit_id'],
                    'warehouse_id'   => $line['warehouse_id'],
                    'batch_id'       => $line['batch_id'],
                    'display_name'   => $line['display_name'],
                    'return_qty'     => $line['return_qty'],
                    'rate'           => $line['rate'],
                    'line_amount'    => $line['line_amount'],
                    'condition_code' => $line['condition_code'],
                ], 'line_id');
            }

            Audit::record($this->ctx, $this->auth, 'return.created', 'return', $returnId, null, [
                'refund_amount' => $refund, 'resolution' => $resolution,
            ]);

            return $this->find($returnId);
        });
    }

    /**
     * Approve the return.
     *
     * A cashier may take a return; approving one is a separate permission,
     * because a return is money leaving the till against goods nobody has
     * checked yet.
     *
     * @param array<string, mixed> $input
     */
    public function approve(int $returnId, array $input): array
    {
        Permissions::assert($this->ctx, $this->auth, 'return.approve');

        $return = $this->find($returnId);
        if ($return === []) {
            Http::notFound('That return does not exist.');
        }
        if ($return['status'] !== 'DRAFT') {
            Http::conflict('This return is already ' . strtolower((string) $return['status']) . '.');
        }

        Db::transaction(function () use ($returnId, $return, $input): void {
            Db::update('pos_returns', [
                'status'      => 'APPROVED',
                'approved_by' => $this->auth->uuid,
                'updated_at'  => self::now(),
            ], ['return_id' => $returnId, 'cmp_id' => $this->ctx->cmpId]);

            Db::insert('pos_approval_events', [
                'cmp_id'       => $this->ctx->cmpId,
                'terminal_id'  => self::id($return['terminal_id']),
                'session_id'   => self::id($return['session_id']),
                'cart_id'      => self::id($return['cart_id']),
                'event_kind'   => 'return',
                'requested_by' => (string) $return['created_by'],
                'approved_by'  => $this->auth->uuid,
                'reason'       => self::text($input['note'] ?? null) ?? $return['reason_note'],
                'detail'       => ['return_no' => $return['return_no'], 'refund_amount' => (float) $return['refund_amount']],
            ], 'approval_id');

            Audit::record($this->ctx, $this->auth, 'return.approved', 'return', $returnId,
                ['status' => 'DRAFT'], ['status' => 'APPROVED'], self::text($input['note'] ?? null) ?? '');
        });

        return $this->find($returnId);
    }

    /**
     * Take the goods back into stock — Inventory's job, asked for by us.
     *
     * Damaged goods are still received: Inventory records the condition and
     * decides where they land. Refusing to receive them would leave goods in
     * the building that no system knows about.
     */
    public function receive(int $returnId): array
    {
        Permissions::assert($this->ctx, $this->auth, 'return.approve');

        $return = $this->find($returnId);
        if ($return === []) {
            Http::notFound('That return does not exist.');
        }
        if ($return['status'] !== 'APPROVED') {
            Http::conflict('Approve the return before taking the goods back.');
        }
        if ($return['inventory_document_uuid'] !== null) {
            return $this->find($returnId);
        }

        $stockLines = array_values(array_filter(
            $return['lines'],
            static fn (array $l) => $l['item_id'] !== null && (float) $l['return_qty'] > 0,
        ));

        if ($stockLines === [] || !$return['restock']) {
            // Nothing to put back — a service charge refunded, or goods written
            // off at the counter. The return still proceeds to its credit note.
            Db::update('pos_returns', ['status' => 'RECEIVED', 'updated_at' => self::now()], ['return_id' => $returnId, 'cmp_id' => $this->ctx->cmpId]);

            return $this->find($returnId);
        }

        $command = IntegrationCommand::open($this->ctx, 'inventory', self::COMMAND_RECEIPT, 'return', $returnId, ['lines' => count($stockLines)]);
        $commandId = (int) $command['command_id'];
        if (($command['status'] ?? '') === IntegrationCommand::COMPLETED) {
            return $this->find($returnId);
        }
        IntegrationCommand::markPosting($commandId);

        $payload = [
            'document_type'        => 'POS_RETURN',
            'document_date'        => (string) $return['return_date'],
            'source_app'           => 'pos',
            'source_document_type' => 'pos.return',
            'source_document_id'   => $returnId,
            'source_document_uuid' => (string) $return['return_uuid'],
            'source_document_no'   => (string) $return['return_no'],
            'party_ref'            => (string) ($return['customer_account_id'] ?? ''),
            'narration'            => 'Counter return ' . $return['return_no'],
            'lines' => array_map(static fn (array $line) => [
                'source_line_ref' => (string) $line['line_id'],
                'item_id'         => (int) $line['item_id'],
                'warehouse_id'    => $line['warehouse_id'] === null ? null : (int) $line['warehouse_id'],
                'batch_id'        => $line['batch_id'] === null ? null : (int) $line['batch_id'],
                'unit_id'         => $line['unit_id'] === null ? null : (int) $line['unit_id'],
                'qty'             => (float) $line['return_qty'],
                'rate'            => (float) $line['rate'],
                'amount'          => (float) $line['line_amount'],
                'direction'       => 'in',
                'description'     => $line['condition_code'] === 'good' ? $line['display_name'] : ('Returned ' . $line['condition_code']),
            ], $stockLines),
            'metadata' => [
                'restock'    => (bool) $return['restock'],
                'conditions' => array_map(static fn (array $l) => [
                    'line_id' => (int) $l['line_id'], 'condition' => $l['condition_code'],
                ], $stockLines),
            ],
        ];

        $response = (new InventoryClient())->withService($this->auth->uuid)->postDocument($this->ctx, $payload, (string) $command['idempotency_key']);

        if (!$response['ok']) {
            $message = (string) ($response['error'] ?? 'Inventory did not accept the return.');
            $blocked = in_array($response['status'], [409, 422], true);
            $blocked ? IntegrationCommand::block($commandId, $message) : IntegrationCommand::fail($commandId, $message);
            Http::error(502, 'inventory_unavailable', $message, ['retryable' => !$blocked]);
        }

        $document = $response['body']['data'] ?? [];
        IntegrationCommand::complete($commandId, ['inventory_document_uuid' => $document['document_uuid'] ?? null]);

        Db::update('pos_returns', [
            'status'                  => 'RECEIVED',
            'inventory_document_uuid' => self::text($document['document_uuid'] ?? null),
            'updated_at'              => self::now(),
        ], ['return_id' => $returnId, 'cmp_id' => $this->ctx->cmpId]);

        Audit::record($this->ctx, $this->auth, 'return.received', 'return', $returnId, null, [
            'inventory_document_uuid' => $document['document_uuid'] ?? null,
        ]);

        return $this->find($returnId);
    }

    /**
     * Raise the credit note in Books and settle the customer.
     *
     * The credit is Books'; the cash out of the drawer is ours. Both are
     * recorded, neither is invented.
     */
    public function settle(int $returnId): array
    {
        Permissions::assert($this->ctx, $this->auth, 'refund.give');

        $return = $this->find($returnId);
        if ($return === []) {
            Http::notFound('That return does not exist.');
        }
        if (!in_array($return['status'], ['RECEIVED', 'APPROVED'], true)) {
            Http::conflict('Take the goods back before settling the return.');
        }
        if ($return['books_credit_note_uuid'] !== null) {
            return $this->find($returnId);
        }

        $command = IntegrationCommand::open($this->ctx, 'books', self::COMMAND_CREDIT, 'return', $returnId, [
            'return_no' => $return['return_no'], 'refund_amount' => (float) $return['refund_amount'],
        ]);
        $commandId = (int) $command['command_id'];
        if (($command['status'] ?? '') === IntegrationCommand::COMPLETED) {
            return $this->find($returnId);
        }
        IntegrationCommand::markPosting($commandId);

        $payload = [
            'vch_date'     => (string) $return['return_date'],
            'party_acc_id' => self::id($return['customer_account_id']),
            'narration'    => 'Counter return ' . $return['return_no'],
            'reference_no' => (string) $return['return_no'],
            'bo_id'        => (int) $return['bo_id'],

            'source_app'           => 'pos',
            'source_document_type' => 'pos.return',
            'source_document_id'   => $returnId,
            'source_document_uuid' => (string) $return['return_uuid'],

            // The invoice being credited, so Books allocates against the
            // original sale rather than leaving a credit floating.
            'against_voucher_id'   => self::id($return['books_invoice_id']),
            'against_voucher_uuid' => $return['books_invoice_uuid'],

            // How the customer was made whole. Books decides the accounting;
            // this says what happened at the counter.
            'refund_mode'   => (string) $return['resolution'],
            'refund_amount' => (float) $return['refund_amount'],

            'inventory_lines' => array_values(array_map(static fn (array $line) => [
                'source_line_ref' => (string) $line['line_id'],
                'item_id'         => $line['item_id'] === null ? null : (int) $line['item_id'],
                'unit_id'         => $line['unit_id'] === null ? null : (int) $line['unit_id'],
                'mc_id'           => $line['warehouse_id'] === null ? null : (int) $line['warehouse_id'],
                'description'     => $line['display_name'],
                'qty'             => (float) $line['return_qty'],
                'rate'            => (float) $line['rate'],
                'amount'          => (float) $line['line_amount'],
            ], array_filter($return['lines'], static fn (array $l) => $l['item_id'] !== null))),
        ];

        $response = (new BooksClient())
            ->withService($this->auth->uuid)
            ->createAndPostVoucher($this->ctx, BooksClient::VCH_CREDIT_NOTE, $payload, (string) $command['idempotency_key']);

        if (!$response['ok']) {
            $message = (string) ($response['error'] ?? 'Books did not accept the credit note.');
            $blocked = in_array($response['status'], [409, 422], true);
            $blocked ? IntegrationCommand::block($commandId, $message) : IntegrationCommand::fail($commandId, $message);
            Http::error(502, 'books_unavailable',
                'The credit note could not be raised. Nothing has been credited — press Retry.',
                ['retryable' => !$blocked, 'detail' => $message],
            );
        }

        $voucher = $response['body']['data'] ?? [];
        IntegrationCommand::complete($commandId, [
            'books_credit_note_id'   => $voucher['vch_txn_id'] ?? null,
            'books_credit_note_uuid' => $voucher['vch_uuid'] ?? null,
        ]);

        Db::update('pos_returns', [
            'status'                 => 'SETTLED',
            'books_credit_note_id'   => self::id($voucher['vch_txn_id'] ?? $voucher['voucher_id'] ?? null),
            'books_credit_note_uuid' => self::text($voucher['vch_uuid'] ?? $voucher['voucher_uuid'] ?? null),
            'updated_at'             => self::now(),
        ], ['return_id' => $returnId, 'cmp_id' => $this->ctx->cmpId]);

        $this->debitDrawer($return);

        Audit::record($this->ctx, $this->auth, 'return.settled', 'return', $returnId, null, [
            'books_credit_note_uuid' => $voucher['vch_uuid'] ?? null,
        ]);

        return $this->find($returnId);
    }

    public function find(int $returnId): array
    {
        $return = Db::first(
            'SELECT * FROM pos_returns WHERE return_id = :id AND cmp_id = :cmp',
            ['id' => $returnId, 'cmp' => $this->ctx->cmpId],
        );
        if ($return === null) {
            return [];
        }

        $return['return_id']     = (int) $return['return_id'];
        $return['refund_amount'] = (float) $return['refund_amount'];
        $return['lines'] = array_map(static function (array $line): array {
            $line['line_id']     = (int) $line['line_id'];
            $line['item_id']     = $line['item_id'] === null ? null : (int) $line['item_id'];
            $line['return_qty']  = (float) $line['return_qty'];
            $line['rate']        = (float) $line['rate'];
            $line['line_amount'] = (float) $line['line_amount'];

            return $line;
        }, Db::all('SELECT * FROM pos_return_lines WHERE return_id = :id ORDER BY line_no', ['id' => $returnId]));

        $return['commands'] = IntegrationCommand::forEntity($this->ctx, 'return', $returnId);

        return $return;
    }

    /** @return array{0: list<array<string, mixed>>, 1: int} */
    public function listReturns(array $filters, int $limit, int $offset): array
    {
        [$scope, $params] = $this->ctx->scopeClause();
        $where = [$scope];

        if (!empty($filters['status'])) {
            $where[] = 'status = :status';
            $params['status'] = (string) $filters['status'];
        }
        if (!empty($filters['session_id'])) {
            $where[] = 'session_id = :sid';
            $params['sid'] = (int) $filters['session_id'];
        }
        if (!empty($filters['search'])) {
            $where[] = '(return_no ILIKE :q OR books_invoice_no ILIKE :q)';
            $params['q'] = '%' . $filters['search'] . '%';
        }

        $clause = implode(' AND ', $where);
        $total = (int) Db::scalar('SELECT COUNT(*) FROM pos_returns WHERE ' . $clause, $params);
        $rows = Db::all(
            'SELECT return_id, return_no, return_date, status, resolution, refund_amount, customer_account_id,
                    books_invoice_no, books_credit_note_uuid, inventory_document_uuid, created_by, created_at
             FROM pos_returns WHERE ' . $clause . ' ORDER BY return_id DESC LIMIT ' . (int) $limit . ' OFFSET ' . (int) $offset,
            $params,
        );

        return [array_map(static function (array $r): array {
            $r['return_id'] = (int) $r['return_id'];
            $r['refund_amount'] = (float) $r['refund_amount'];

            return $r;
        }, $rows), $total];
    }

    /**
     * Refuse to return more than was sold.
     *
     * Checked against OUR OWN return rows for that sale, not against a stored
     * "returned quantity" on the cart. Nothing is denormalised, so nothing can
     * drift out of step with the returns themselves.
     *
     * @param list<array<string, mixed>> $lines
     */
    private function assertNotOverReturned(int $cartId, array $lines): void
    {
        $sold = [];
        foreach (Db::all('SELECT line_id, item_id, quantity FROM pos_cart_lines WHERE cart_id = :cart', ['cart' => $cartId]) as $row) {
            if ($row['item_id'] !== null) {
                $sold[(int) $row['item_id']] = ($sold[(int) $row['item_id']] ?? 0) + (float) $row['quantity'];
            }
        }

        $already = [];
        foreach (Db::all(
            "SELECT l.item_id, SUM(l.return_qty) AS qty
             FROM pos_return_lines l
             JOIN pos_returns r ON r.return_id = l.return_id
             WHERE r.cart_id = :cart AND r.cmp_id = :cmp AND r.status <> 'CANCELLED'
             GROUP BY l.item_id",
            ['cart' => $cartId, 'cmp' => $this->ctx->cmpId],
        ) as $row) {
            if ($row['item_id'] !== null) {
                $already[(int) $row['item_id']] = (float) $row['qty'];
            }
        }

        foreach ($lines as $line) {
            if ($line['item_id'] === null) {
                continue;
            }
            $itemId = (int) $line['item_id'];
            $soldQty = $sold[$itemId] ?? 0.0;
            $returned = ($already[$itemId] ?? 0.0) + (float) $line['return_qty'];

            if ($returned > $soldQty + 0.0001) {
                Http::conflict(
                    'Only ' . rtrim(rtrim(number_format($soldQty - ($already[$itemId] ?? 0.0), 3), '0'), '.')
                        . ' of ' . ($line['display_name'] ?? 'that item') . ' can still come back on this sale.',
                    ['item_id' => $itemId, 'sold' => $soldQty, 'already_returned' => $already[$itemId] ?? 0.0],
                );
            }
        }
    }

    /** Cash handed back over the counter, off this shift's drawer. */
    private function debitDrawer(array $return): void
    {
        $sessionId = self::id($return['session_id']);
        if ($sessionId === null || $return['resolution'] !== 'refund_cash') {
            return;
        }

        $amount = (float) $return['refund_amount'];
        if ($amount <= 0) {
            return;
        }

        Db::transaction(function () use ($sessionId, $return, $amount): void {
            Db::insert('pos_cash_drawer_events', [
                'session_id' => $sessionId,
                'cmp_id'     => $this->ctx->cmpId,
                'event_kind' => 'refund',
                'amount'     => $amount,
                'reason'     => 'return:' . $return['return_id'],
                'actor_uuid' => $this->auth->uuid,
            ], 'event_id');

            Db::run(
                'UPDATE pos_register_sessions SET expected_cash = expected_cash - :amount, updated_at = :now
                 WHERE session_id = :id AND cmp_id = :cmp',
                ['amount' => $amount, 'now' => self::now(), 'id' => $sessionId, 'cmp' => $this->ctx->cmpId],
            );
        });
    }

    /**
     * @param mixed $raw
     * @return list<array<string, mixed>>
     */
    private function normaliseLines(mixed $raw): array
    {
        if (!is_array($raw)) {
            return [];
        }

        $out = [];
        $lineNo = 0;
        foreach ($raw as $line) {
            if (!is_array($line)) {
                continue;
            }
            $qty = round((float) ($line['return_qty'] ?? 0), 4);
            if ($qty <= 0) {
                continue;
            }
            $rate = round((float) ($line['rate'] ?? 0), 4);
            $condition = self::text($line['condition_code'] ?? null) ?? 'good';
            if (!in_array($condition, ['good', 'damaged', 'expired', 'wrong_item'], true)) {
                Http::validationFailed('That is not a condition goods come back in.', [
                    'field' => 'condition_code', 'allowed' => ['good', 'damaged', 'expired', 'wrong_item'],
                ]);
            }

            $out[] = [
                'line_no'        => ++$lineNo,
                'cart_line_id'   => self::id($line['cart_line_id'] ?? null),
                'item_id'        => self::id($line['item_id'] ?? null),
                'unit_id'        => self::id($line['unit_id'] ?? null),
                'warehouse_id'   => self::id($line['warehouse_id'] ?? null),
                'batch_id'       => self::id($line['batch_id'] ?? null),
                'display_name'   => self::text($line['display_name'] ?? null) ?? 'Item',
                'return_qty'     => $qty,
                'rate'           => $rate,
                'line_amount'    => isset($line['line_amount']) ? round((float) $line['line_amount'], 4) : round($qty * $rate, 4),
                'condition_code' => $condition,
            ];
        }

        return $out;
    }

    private static function date(mixed $raw): string
    {
        if (is_string($raw) && preg_match('/^\d{4}-\d{2}-\d{2}$/', $raw) === 1) {
            return $raw;
        }

        return gmdate('Y-m-d');
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
