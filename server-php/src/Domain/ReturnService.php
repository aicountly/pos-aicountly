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
                // An exchange is settled by a new sale on the till. The cart that
                // sale is being rung up on is linked here when the caller has one,
                // so the two halves of the exchange can be read back together.
                'exchange_cart_id'    => self::id($input['exchange_cart_id'] ?? null),
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
        $return['restock']       = (bool) $return['restock'];
        foreach (['cart_id', 'exchange_cart_id', 'terminal_id', 'session_id', 'customer_account_id', 'books_invoice_id'] as $id) {
            $return[$id] = ($return[$id] ?? null) === null ? null : (int) $return[$id];
        }
        $return['lines'] = array_map(static function (array $line): array {
            $line['line_id']     = (int) $line['line_id'];
            $line['item_id']     = $line['item_id'] === null ? null : (int) $line['item_id'];
            $line['return_qty']  = (float) $line['return_qty'];
            $line['rate']        = (float) $line['rate'];
            $line['line_amount'] = (float) $line['line_amount'];

            return $line;
        }, Db::all('SELECT * FROM pos_return_lines WHERE return_id = :id ORDER BY line_no', ['id' => $returnId]));

        $return['commands'] = IntegrationCommand::forEntity($this->ctx, 'return', $returnId);
        $return['context'] = $this->context($return);

        return $return;
    }

    /**
     * Who the return belongs to, and where it was taken.
     *
     * READ, NOT COPIED. The customer's name, the channel the sale came through
     * and the till's name live on the cart and the terminal; none of them is
     * written onto the return, so a till renamed today is renamed on last
     * month's returns as well. A return taken against a paper invoice has no
     * cart and therefore no context, and says so by being null rather than by
     * inventing a walk-in.
     *
     * @param array<string, mixed> $return
     * @return array<string, mixed>
     */
    private function context(array $return): array
    {
        $cart = null;
        if ($return['cart_id'] !== null) {
            $cart = Db::first(
                'SELECT cart_id, cart_uuid, order_kind, token_no, customer_name, customer_mobile,
                        subtotal_amount, discount_amount, estimated_tax_amount, total_amount,
                        books_voucher_no, books_voucher_uuid, created_at
                 FROM pos_carts WHERE cart_id = :id AND cmp_id = :cmp',
                ['id' => (int) $return['cart_id'], 'cmp' => $this->ctx->cmpId],
            );
        }

        $terminal = null;
        if ($return['terminal_id'] !== null) {
            $terminal = Db::first(
                'SELECT terminal_id, terminal_code, display_name, location_id
                 FROM pos_terminals WHERE terminal_id = :id AND cmp_id = :cmp',
                ['id' => (int) $return['terminal_id'], 'cmp' => $this->ctx->cmpId],
            );
        }

        $exchange = null;
        if (($return['exchange_cart_id'] ?? null) !== null) {
            $exchange = Db::first(
                'SELECT cart_id, status, total_amount, books_voucher_no
                 FROM pos_carts WHERE cart_id = :id AND cmp_id = :cmp',
                ['id' => (int) $return['exchange_cart_id'], 'cmp' => $this->ctx->cmpId],
            );
        }

        return [
            'customer_name'   => $cart['customer_name'] ?? null,
            'customer_mobile' => $cart['customer_mobile'] ?? null,
            'channel'         => $cart['order_kind'] ?? null,
            'token_no'        => $cart['token_no'] ?? null,
            'sale_total'      => isset($cart['total_amount']) ? (float) $cart['total_amount'] : null,
            'sale_subtotal'   => isset($cart['subtotal_amount']) ? (float) $cart['subtotal_amount'] : null,
            'sale_discount'   => isset($cart['discount_amount']) ? (float) $cart['discount_amount'] : null,
            'sale_tax'        => isset($cart['estimated_tax_amount']) ? (float) $cart['estimated_tax_amount'] : null,
            'sale_date'       => $cart['created_at'] ?? null,
            'terminal_code'   => $terminal['terminal_code'] ?? null,
            'terminal_name'   => $terminal['display_name'] ?? null,
            'exchange_sale'   => $exchange === null ? null : [
                'cart_id'      => (int) $exchange['cart_id'],
                'status'       => (string) $exchange['status'],
                'total_amount' => (float) $exchange['total_amount'],
                'invoice_no'   => $exchange['books_voucher_no'],
            ],
        ];
    }

    // -----------------------------------------------------------------------
    // The returns register, and the analytics over the same rows
    // -----------------------------------------------------------------------

    /**
     * Where a return came in through, when the sale it came off is not ours.
     *
     * A return taken at the counter against a paper invoice has no cart, so it
     * has no order kind either. That is a fact about the return and is labelled
     * as one rather than being quietly counted as a walk-in.
     */
    public const CHANNEL_UNLINKED = 'unlinked';

    /** A return whose reason nobody recorded. Counted, and named for what it is. */
    public const REASON_UNSPECIFIED = 'unspecified';

    /**
     * The joins every query on this screen shares.
     *
     * The customer's name and the channel a sale came through are the CART's.
     * They are read from it here rather than copied onto the return, so a
     * customer renamed in Books is renamed on last month's returns too.
     */
    private const REGISTER_FROM = '
        FROM pos_returns r
        LEFT JOIN pos_carts c ON c.cart_id = r.cart_id
        LEFT JOIN pos_terminals t ON t.terminal_id = r.terminal_id
        LEFT JOIN (
            SELECT return_id, COUNT(*) AS line_count, COALESCE(SUM(return_qty), 0) AS item_qty
            FROM pos_return_lines
            GROUP BY return_id
        ) li ON li.return_id = r.return_id';

    /** What a caller may order the register by, and the column each name means. */
    private const SORTABLE = [
        'return_date'   => 'r.return_date',
        'refund_amount' => 'r.refund_amount',
        'created_at'    => 'r.created_at',
        'return_no'     => 'r.return_no',
        'status'        => 'r.status',
    ];

    /**
     * The filter every query on the returns screen reads.
     *
     * ONE builder, deliberately. A KPI counted over a different set of rows
     * from the table underneath it is a screen that lies, and it lies quietly —
     * which is worse than an error. The register, the four tab counts, the
     * trend, the reasons and the channels all go through here.
     *
     * @param array<string, mixed> $filters
     * @return array{0: string, 1: array<string, mixed>}
     */
    private function filterClause(array $filters): array
    {
        [$scope, $params] = $this->ctx->scopeClause('r');
        $where = [$scope];

        $from = self::dateOrNull($filters['from'] ?? null);
        if ($from !== null) {
            $where[] = 'r.return_date >= :f_from';
            $params['f_from'] = $from;
        }

        $to = self::dateOrNull($filters['to'] ?? null);
        if ($to !== null) {
            $where[] = 'r.return_date <= :f_to';
            $params['f_to'] = $to;
        }

        foreach ([['status', 'r.status', 'f_st'], ['resolution', 'r.resolution', 'f_rs']] as [$key, $column, $prefix]) {
            $values = self::listOf($filters[$key] ?? null);
            if ($values === []) {
                continue;
            }
            $names = [];
            foreach ($values as $index => $value) {
                $names[] = ':' . $prefix . $index;
                $params[$prefix . $index] = $value;
            }
            $where[] = $column . ' IN (' . implode(', ', $names) . ')';
        }

        foreach ([['terminal_id', 'r.terminal_id', 'f_terminal'], ['session_id', 'r.session_id', 'f_session'], ['cart_id', 'r.cart_id', 'f_cart']] as [$key, $column, $name]) {
            if (!empty($filters[$key])) {
                $where[] = $column . ' = :' . $name;
                $params[$name] = (int) $filters[$key];
            }
        }

        if (!empty($filters['reason_code'])) {
            $where[] = "COALESCE(NULLIF(r.reason_code, ''), :f_reason_none) = :f_reason";
            $params['f_reason_none'] = self::REASON_UNSPECIFIED;
            $params['f_reason'] = (string) $filters['reason_code'];
        }

        if (!empty($filters['channel'])) {
            $where[] = 'COALESCE(c.order_kind, :f_channel_none) = :f_channel';
            $params['f_channel_none'] = self::CHANNEL_UNLINKED;
            $params['f_channel'] = (string) $filters['channel'];
        }

        if (isset($filters['min_amount']) && is_numeric($filters['min_amount'])) {
            $where[] = 'r.refund_amount >= :f_min';
            $params['f_min'] = (float) $filters['min_amount'];
        }
        if (isset($filters['max_amount']) && is_numeric($filters['max_amount'])) {
            $where[] = 'r.refund_amount <= :f_max';
            $params['f_max'] = (float) $filters['max_amount'];
        }

        if (!empty($filters['search'])) {
            // The item name is on the return's own lines, so searching for what
            // came back does not need Inventory to be reachable.
            $where[] = '(r.return_no ILIKE :f_q OR r.books_invoice_no ILIKE :f_q OR r.reason_note ILIKE :f_q'
                . ' OR c.customer_name ILIKE :f_q OR c.customer_mobile ILIKE :f_q OR c.token_no ILIKE :f_q'
                . ' OR EXISTS (SELECT 1 FROM pos_return_lines rl'
                . ' WHERE rl.return_id = r.return_id AND rl.display_name ILIKE :f_q))';
            $params['f_q'] = '%' . $filters['search'] . '%';
        }

        return [implode(' AND ', $where), $params];
    }

    /**
     * One page of the register.
     *
     * @param array<string, mixed> $filters
     * @return array{0: list<array<string, mixed>>, 1: int}
     */
    public function listReturns(array $filters, int $limit, int $offset, string $sort = 'return_date', string $order = 'DESC'): array
    {
        [$clause, $params] = $this->filterClause($filters);

        $column = self::SORTABLE[$sort] ?? self::SORTABLE['return_date'];
        $direction = strtoupper($order) === 'ASC' ? 'ASC' : 'DESC';

        $total = (int) Db::scalar('SELECT COUNT(*)' . self::REGISTER_FROM . ' WHERE ' . $clause, $params);

        $rows = Db::all(
            'SELECT r.return_id, r.return_uuid, r.return_no, r.return_date, r.status, r.resolution, r.restock,
                    r.reason_code, r.reason_note, r.refund_amount, r.customer_account_id, r.cart_id,
                    r.books_invoice_no, r.books_invoice_uuid, r.books_credit_note_uuid, r.inventory_document_uuid,
                    r.exchange_cart_id, r.terminal_id, r.session_id, r.bo_id,
                    r.created_by, r.approved_by, r.created_at, r.updated_at,
                    c.customer_name, c.customer_mobile, c.order_kind, c.token_no,
                    c.total_amount AS sale_total, c.created_at AS sale_date,
                    t.terminal_code, t.display_name AS terminal_name,
                    COALESCE(li.line_count, 0) AS line_count,
                    COALESCE(li.item_qty, 0) AS item_qty'
            . self::REGISTER_FROM . '
             WHERE ' . $clause . '
             ORDER BY ' . $column . ' ' . $direction . ', r.return_id DESC
             LIMIT ' . (int) $limit . ' OFFSET ' . (int) $offset,
            $params,
        );

        return [array_map(self::castRow(...), $rows), $total];
    }

    /**
     * The numbers above the register: KPIs, the trend, why goods came back and
     * where they came from.
     *
     * Everything here is aggregated by PostgreSQL over the SAME filter the
     * table uses, and the comparison window is the one immediately before this
     * one and the same length. Nothing is computed in the browser and nothing
     * is estimated.
     *
     * @param array<string, mixed> $filters
     * @return array<string, mixed>
     */
    public function summary(array $filters): array
    {
        [$from, $to] = self::window($filters);
        $days = self::daysBetween($from, $to);

        // The window immediately before this one, of the same length, so the
        // two are comparable. A month against a week is not a comparison.
        $previousTo = self::shiftDate($from, -1);
        $previousFrom = self::shiftDate($previousTo, -($days - 1));

        $current = ['from' => $from, 'to' => $to] + $filters;
        $previous = ['from' => $previousFrom, 'to' => $previousTo] + $filters;

        $totals = $this->totals($current);
        $comparison = $this->totals($previous);

        return [
            'window'            => ['from' => $from, 'to' => $to, 'days' => $days],
            'comparison_window' => ['from' => $previousFrom, 'to' => $previousTo, 'days' => $days],
            'kpis'              => $totals,
            'comparison'        => $comparison,
            'register_counts'   => [
                'all'       => $totals['total_returns'],
                'refunds'   => $totals['refund_count'],
                'exchanges' => $totals['exchange_count'],
                'pending'   => $totals['pending_count'],
            ],
            'trend'              => $this->trend($current, $from, $to),
            'reasons'            => $this->reasons($current),
            'comparison_reasons' => $this->reasons($previous),
            'conditions'         => $this->conditions($current),
            'channels'           => $this->channels($current),
            'statuses'           => $this->statuses($current),
        ];
    }

    /**
     * What a sale still has coming back.
     *
     * The cashier needs three numbers per line — sold, already returned, still
     * returnable — and the third is the one that decides whether this return is
     * allowed. It is computed here, from the returns themselves, by the SAME
     * rule create() enforces: per item, over every return on that sale that has
     * not been cancelled. A UI that worked out the remainder for itself would
     * eventually disagree with the server, and the customer is standing there.
     *
     * @return array<string, mixed>
     */
    public function eligibility(int $cartId): array
    {
        Permissions::assert($this->ctx, $this->auth, 'return.create');

        [$scope, $params] = $this->ctx->scopeClause();
        $params['cart'] = $cartId;

        $cart = Db::first(
            'SELECT cart_id, cart_uuid, status, order_kind, token_no, customer_account_id, customer_name,
                    customer_mobile, subtotal_amount, discount_amount, service_charge_amount, tip_amount,
                    estimated_tax_amount, total_amount, books_voucher_id, books_voucher_uuid, books_voucher_no,
                    terminal_id, session_id, created_at
             FROM pos_carts WHERE cart_id = :cart AND ' . $scope,
            $params,
        );
        if ($cart === null) {
            Http::notFound('That sale is not on this till.');
        }

        $lines = Db::all(
            'SELECT line_id, line_no, item_id, unit_id, warehouse_id, batch_id, display_name, menu_item_id,
                    quantity, rate, discount_amount, estimated_tax_pc, estimated_tax_amount, line_amount
             FROM pos_cart_lines WHERE cart_id = :cart ORDER BY line_no',
            ['cart' => $cartId],
        );

        $returned = [];
        foreach (Db::all(
            "SELECT l.item_id, SUM(l.return_qty) AS qty
             FROM pos_return_lines l
             JOIN pos_returns r ON r.return_id = l.return_id
             WHERE r.cart_id = :cart AND r.cmp_id = :cmp AND r.status <> 'CANCELLED'
             GROUP BY l.item_id",
            ['cart' => $cartId, 'cmp' => $this->ctx->cmpId],
        ) as $row) {
            if ($row['item_id'] !== null) {
                $returned[(int) $row['item_id']] = (float) $row['qty'];
            }
        }

        $sold = [];
        foreach ($lines as $line) {
            if ($line['item_id'] === null) {
                continue;
            }
            $itemId = (int) $line['item_id'];
            $sold[$itemId] = ($sold[$itemId] ?? 0.0) + (float) $line['quantity'];
        }

        $items = [];
        foreach ($sold as $itemId => $soldQty) {
            $alreadyReturned = $returned[$itemId] ?? 0.0;
            $items[] = [
                'item_id'        => $itemId,
                'sold_qty'       => round($soldQty, 4),
                'returned_qty'   => round($alreadyReturned, 4),
                'returnable_qty' => round(max(0.0, $soldQty - $alreadyReturned), 4),
            ];
        }

        $priorReturns = Db::all(
            'SELECT return_id, return_no, return_date, status, resolution, refund_amount
             FROM pos_returns WHERE cart_id = :cart AND cmp_id = :cmp ORDER BY return_id DESC',
            ['cart' => $cartId, 'cmp' => $this->ctx->cmpId],
        );

        return [
            'cart' => [
                'cart_id'              => (int) $cart['cart_id'],
                'cart_uuid'            => $cart['cart_uuid'],
                'status'               => $cart['status'],
                'order_kind'           => $cart['order_kind'],
                'token_no'             => $cart['token_no'],
                'customer_account_id'  => $cart['customer_account_id'] === null ? null : (int) $cart['customer_account_id'],
                'customer_name'        => $cart['customer_name'],
                'customer_mobile'      => $cart['customer_mobile'],
                'subtotal_amount'      => (float) $cart['subtotal_amount'],
                'discount_amount'      => (float) $cart['discount_amount'],
                'service_charge_amount' => (float) $cart['service_charge_amount'],
                'tip_amount'           => (float) $cart['tip_amount'],
                'estimated_tax_amount' => (float) $cart['estimated_tax_amount'],
                'total_amount'         => (float) $cart['total_amount'],
                'books_voucher_id'     => $cart['books_voucher_id'] === null ? null : (int) $cart['books_voucher_id'],
                'books_voucher_uuid'   => $cart['books_voucher_uuid'],
                'books_voucher_no'     => $cart['books_voucher_no'],
                'terminal_id'          => $cart['terminal_id'] === null ? null : (int) $cart['terminal_id'],
                'session_id'           => $cart['session_id'] === null ? null : (int) $cart['session_id'],
                'created_at'           => $cart['created_at'],
            ],
            'returnable' => $cart['status'] === 'COMPLETED',
            'lines' => array_map(static function (array $line): array {
                foreach (['quantity', 'rate', 'discount_amount', 'estimated_tax_pc', 'estimated_tax_amount', 'line_amount'] as $numeric) {
                    $line[$numeric] = (float) $line[$numeric];
                }
                $line['line_id'] = (int) $line['line_id'];
                $line['line_no'] = (int) $line['line_no'];
                $line['item_id'] = $line['item_id'] === null ? null : (int) $line['item_id'];

                return $line;
            }, $lines),
            'items'   => $items,
            'returns' => array_map(static function (array $row): array {
                $row['return_id'] = (int) $row['return_id'];
                $row['refund_amount'] = (float) $row['refund_amount'];

                return $row;
            }, $priorReturns),
        ];
    }

    /**
     * The rows this window is about, named once and selected from four times.
     *
     * A CTE rather than four copies of the same WHERE: the trend, the reasons
     * and the channels are three views of ONE set of returns, and writing the
     * filter out again for each is how they drift apart.
     */
    private function scopedCte(array $filters): array
    {
        [$clause, $params] = $this->filterClause($filters);

        $cte = 'WITH scoped AS (
                    SELECT r.return_id, r.return_date, r.refund_amount, r.resolution, r.status,
                           r.reason_code, c.order_kind, COALESCE(li.item_qty, 0) AS item_qty'
            . self::REGISTER_FROM . '
                    WHERE ' . $clause . '
                ) ';

        return [$cte, $params];
    }

    /** @return array<string, float|int> */
    private function totals(array $filters): array
    {
        [$cte, $params] = $this->scopedCte($filters);

        $row = Db::first(
            $cte . "SELECT COUNT(*) AS total_returns,
                           COALESCE(SUM(refund_amount), 0) AS return_value,
                           COALESCE(SUM(item_qty), 0) AS items_returned,
                           COUNT(*) FILTER (WHERE resolution = 'exchange') AS exchange_count,
                           COUNT(*) FILTER (WHERE resolution <> 'exchange') AS refund_count,
                           COUNT(*) FILTER (WHERE status IN ('DRAFT', 'APPROVED', 'RECEIVED')) AS pending_count,
                           COALESCE(SUM(refund_amount) FILTER (WHERE status = 'SETTLED'), 0) AS settled_value
                    FROM scoped",
            $params,
        ) ?? [];

        $totalReturns = (int) ($row['total_returns'] ?? 0);
        $exchanges = (int) ($row['exchange_count'] ?? 0);

        return [
            'total_returns'    => $totalReturns,
            'return_value'     => round((float) ($row['return_value'] ?? 0), 2),
            'items_returned'   => round((float) ($row['items_returned'] ?? 0), 4),
            'exchange_count'   => $exchanges,
            'refund_count'     => (int) ($row['refund_count'] ?? 0),
            'pending_count'    => (int) ($row['pending_count'] ?? 0),
            'settled_value'    => round((float) ($row['settled_value'] ?? 0), 2),
            // Null, not zero: "no returns at all" and "no return was an
            // exchange" are different facts and a 0% on an empty window is the
            // second one asserted without evidence.
            'exchange_ratio_pc' => $totalReturns > 0 ? round(($exchanges / $totalReturns) * 100, 1) : null,
        ];
    }

    /**
     * One point per day, including the days nothing came back.
     *
     * generate_series fills the gaps in SQL. A line chart drawn only over the
     * days that have rows compresses a quiet week into a straight segment and
     * reads as steady trading.
     *
     * @return list<array<string, mixed>>
     */
    private function trend(array $filters, string $from, string $to): array
    {
        [$cte, $params] = $this->scopedCte($filters);
        $params['t_from'] = $from;
        $params['t_to'] = $to;

        $rows = Db::all(
            $cte . "SELECT to_char(d, 'YYYY-MM-DD') AS date,
                           COUNT(s.return_id) AS return_count,
                           COALESCE(SUM(s.refund_amount), 0) AS return_value,
                           COALESCE(SUM(s.item_qty), 0) AS items
                    FROM generate_series(:t_from::date, :t_to::date, interval '1 day') d
                    LEFT JOIN scoped s ON s.return_date = d::date
                    GROUP BY d
                    ORDER BY d",
            $params,
        );

        return array_map(static fn (array $row): array => [
            'date'         => (string) $row['date'],
            'return_count' => (int) $row['return_count'],
            'return_value' => round((float) $row['return_value'], 2),
            'items'        => round((float) $row['items'], 4),
        ], $rows);
    }

    /** @return list<array<string, mixed>> */
    private function reasons(array $filters): array
    {
        [$cte, $params] = $this->scopedCte($filters);
        $params['r_none'] = self::REASON_UNSPECIFIED;

        $rows = Db::all(
            $cte . "SELECT COALESCE(NULLIF(reason_code, ''), :r_none) AS reason_code,
                           COUNT(*) AS return_count,
                           COALESCE(SUM(item_qty), 0) AS items,
                           COALESCE(SUM(refund_amount), 0) AS amount
                    FROM scoped
                    GROUP BY 1
                    ORDER BY items DESC, return_count DESC",
            $params,
        );

        return self::withShare($rows, 'items', static fn (array $row): array => [
            'reason_code'  => (string) $row['reason_code'],
            'return_count' => (int) $row['return_count'],
            'items'        => round((float) $row['items'], 4),
            'amount'       => round((float) $row['amount'], 2),
        ]);
    }

    /** @return list<array<string, mixed>> */
    private function conditions(array $filters): array
    {
        [$cte, $params] = $this->scopedCte($filters);

        $rows = Db::all(
            $cte . 'SELECT rl.condition_code,
                           COALESCE(SUM(rl.return_qty), 0) AS items,
                           COALESCE(SUM(rl.line_amount), 0) AS amount
                    FROM pos_return_lines rl
                    JOIN scoped s ON s.return_id = rl.return_id
                    GROUP BY rl.condition_code
                    ORDER BY items DESC',
            $params,
        );

        return self::withShare($rows, 'items', static fn (array $row): array => [
            'condition_code' => (string) $row['condition_code'],
            'items'          => round((float) $row['items'], 4),
            'amount'         => round((float) $row['amount'], 2),
        ]);
    }

    /** @return list<array<string, mixed>> */
    private function channels(array $filters): array
    {
        [$cte, $params] = $this->scopedCte($filters);
        $params['c_none'] = self::CHANNEL_UNLINKED;

        $rows = Db::all(
            $cte . 'SELECT COALESCE(order_kind, :c_none) AS channel,
                           COUNT(*) AS return_count,
                           COALESCE(SUM(refund_amount), 0) AS amount
                    FROM scoped
                    GROUP BY 1
                    ORDER BY return_count DESC',
            $params,
        );

        return self::withShare($rows, 'return_count', static fn (array $row): array => [
            'channel'      => (string) $row['channel'],
            'return_count' => (int) $row['return_count'],
            'amount'       => round((float) $row['amount'], 2),
        ]);
    }

    /** @return list<array<string, mixed>> */
    private function statuses(array $filters): array
    {
        [$cte, $params] = $this->scopedCte($filters);

        $rows = Db::all(
            $cte . 'SELECT status, COUNT(*) AS return_count, COALESCE(SUM(refund_amount), 0) AS amount
                    FROM scoped GROUP BY status ORDER BY return_count DESC',
            $params,
        );

        return array_map(static fn (array $row): array => [
            'status'       => (string) $row['status'],
            'return_count' => (int) $row['return_count'],
            'amount'       => round((float) $row['amount'], 2),
        ], $rows);
    }

    /**
     * Add each row's share of the whole.
     *
     * Computed here rather than in the browser so the percentage beside a bar
     * and the figure beside it were derived from the same numbers.
     *
     * @param list<array<string, mixed>> $rows
     * @param callable(array<string, mixed>): array<string, mixed> $shape
     * @return list<array<string, mixed>>
     */
    private static function withShare(array $rows, string $weight, callable $shape): array
    {
        $total = 0.0;
        foreach ($rows as $row) {
            $total += (float) $row[$weight];
        }

        $out = [];
        foreach ($rows as $row) {
            $shaped = $shape($row);
            $shaped['share_pc'] = $total > 0 ? round(((float) $row[$weight] / $total) * 100, 1) : 0.0;
            $out[] = $shaped;
        }

        return $out;
    }

    /** @return array<string, mixed> */
    private static function castRow(array $row): array
    {
        $row['return_id'] = (int) $row['return_id'];
        $row['refund_amount'] = (float) $row['refund_amount'];
        $row['line_count'] = (int) $row['line_count'];
        $row['item_qty'] = (float) $row['item_qty'];
        $row['sale_total'] = $row['sale_total'] === null ? null : (float) $row['sale_total'];
        $row['restock'] = (bool) $row['restock'];

        foreach (['cart_id', 'exchange_cart_id', 'terminal_id', 'session_id', 'customer_account_id', 'bo_id'] as $id) {
            $row[$id] = $row[$id] === null ? null : (int) $row[$id];
        }

        return $row;
    }

    /**
     * The window a summary is about.
     *
     * Defaults to the last thirty days rather than all of history: a company in
     * its third year has a returns table that is not a page.
     *
     * @param array<string, mixed> $filters
     * @return array{0: string, 1: string}
     */
    private static function window(array $filters): array
    {
        $to = self::dateOrNull($filters['to'] ?? null) ?? gmdate('Y-m-d');
        $from = self::dateOrNull($filters['from'] ?? null) ?? self::shiftDate($to, -29);

        if ($from > $to) {
            [$from, $to] = [$to, $from];
        }

        return [$from, $to];
    }

    private static function daysBetween(string $from, string $to): int
    {
        $start = new \DateTimeImmutable($from . ' 00:00:00', new \DateTimeZone('UTC'));
        $end = new \DateTimeImmutable($to . ' 00:00:00', new \DateTimeZone('UTC'));

        return max(1, (int) $start->diff($end)->days + 1);
    }

    private static function shiftDate(string $date, int $days): string
    {
        $moment = new \DateTimeImmutable($date . ' 00:00:00', new \DateTimeZone('UTC'));

        return $moment->modify(($days >= 0 ? '+' : '-') . abs($days) . ' days')->format('Y-m-d');
    }

    private static function dateOrNull(mixed $raw): ?string
    {
        return is_string($raw) && preg_match('/^\d{4}-\d{2}-\d{2}$/', trim($raw)) === 1 ? trim($raw) : null;
    }

    /**
     * A repeated filter, however it arrived.
     *
     * `status=DRAFT,APPROVED` on the query string and `["DRAFT","APPROVED"]` in
     * a body mean the same thing. Capped, because an IN list is a query plan.
     *
     * @return list<string>
     */
    private static function listOf(mixed $raw): array
    {
        if (is_array($raw)) {
            $values = $raw;
        } elseif (is_string($raw) && trim($raw) !== '') {
            $values = explode(',', $raw);
        } else {
            return [];
        }

        $out = [];
        foreach ($values as $value) {
            if (!is_scalar($value)) {
                continue;
            }
            $text = trim((string) $value);
            if ($text !== '' && !in_array($text, $out, true)) {
                $out[] = $text;
            }
            if (count($out) >= 12) {
                break;
            }
        }

        return $out;
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
