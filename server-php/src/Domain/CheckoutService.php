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
 * Checkout — the moment a cart becomes a sale.
 *
 * ONE SALE, ONE INVOICE, TWO MOVEMENTS:
 *
 *   Books      writes the tax invoice and the receipt against it. The invoice
 *              number, the statutory tax and the receivable are all Books'.
 *   Inventory  records the goods leaving the shop. The stock movement is
 *              Inventory's.
 *   POS        keeps the cart, the tenders the cashier took, and two reference
 *              uuids. That is all.
 *
 * WHY BOOKS FIRST. If stock went out first and Books then refused (a locked
 * period, a missing account), the shop would have goods out of the door and no
 * invoice — the worst of the four possible half-states, and the hardest to
 * find later. Posting the invoice first means the failure mode is an invoice
 * with stock not yet relieved, which is visible on the sale, retryable on the
 * same key, and correct in the accounts meanwhile.
 *
 * THE IDEMPOTENCY KEY IS MINTED AND STORED BEFORE THE CALL. If the network
 * dies after Books has written the voucher but before we see the response, the
 * retry presents the same key and Books replays its original answer instead of
 * writing a second invoice. This is the whole reason a till can be rebooted
 * mid-sale without double-billing a customer.
 *
 * OFFLINE. A till with no connection sells from a device-local cache and mints
 * a client_uuid per sale. When the connection returns it submits those sales
 * here; pos_offline_submissions has UNIQUE (cmp_id, client_uuid), so the same
 * sale arriving three times is recognised twice. The device cache is NOT a
 * replica of Inventory or Books — it is a throwaway copy, and nothing here ever
 * reads from it as though it were authoritative.
 */
final class CheckoutService
{
    public const COMMAND_INVOICE = 'pos.sale.invoice';
    public const COMMAND_ISSUE   = 'pos.sale.stock_issue';

    public function __construct(
        private readonly Context $ctx,
        private readonly Auth $auth,
    ) {
    }

    /**
     * Take payment and post the sale.
     *
     * @param array<string, mixed> $input
     */
    public function checkout(int $cartId, array $input): array
    {
        Permissions::assert($this->ctx, $this->auth, 'sell');

        $carts = new CartService($this->ctx, $this->auth);
        $cart  = $carts->find($cartId);

        if ($cart === []) {
            Http::notFound('That sale does not exist.');
        }
        if ($cart['status'] === 'COMPLETED') {
            // Not an error. The till asked again because it did not hear the
            // first answer, and the honest reply is the sale it already made.
            return $this->result($cartId);
        }
        if ($cart['status'] === 'VOID') {
            Http::conflict('This sale was voided and cannot be paid for.');
        }
        if ($cart['lines'] === []) {
            Http::validationFailed('There is nothing on this sale.');
        }

        $payments = $this->normalisePayments($input['payments'] ?? []);
        if ($payments === []) {
            Http::validationFailed('How is the customer paying?', ['field' => 'payments']);
        }

        $paid  = round(array_sum(array_column($payments, 'amount')), 4);
        $total = (float) $cart['total_amount'];

        // Customer credit is the one tender that may leave a balance: it IS the
        // balance, carried on the customer's account in Books.
        $onCredit = array_filter($payments, static fn (array $p) => $p['payment_mode'] === 'customer_credit');
        if ($paid + 0.0001 < $total && $onCredit === []) {
            Http::validationFailed(
                'The payment is short by ' . number_format($total - $paid, 2) . '. Take the rest, or put the balance on the customer\'s account.',
                ['field' => 'payments', 'total' => $total, 'paid' => $paid],
            );
        }
        if ($onCredit !== [] && self::id($cart['customer_account_id']) === null) {
            Http::validationFailed('A sale on credit needs a customer account.', ['field' => 'customer_account_id']);
        }

        // Record the tenders BEFORE going to Books. If the post fails, the
        // cashier's screen still shows what they took, and the retry does not
        // ask them to key it again.
        Db::transaction(function () use ($cartId, $payments) {
            Db::run('DELETE FROM pos_cart_payments WHERE cart_id = :cart', ['cart' => $cartId]);
            foreach ($payments as $payment) {
                Db::insert('pos_cart_payments', [
                    'cart_id'          => $cartId,
                    'cmp_id'           => $this->ctx->cmpId,
                    'payment_mode'     => $payment['payment_mode'],
                    'amount'           => $payment['amount'],
                    'tendered'         => $payment['tendered'],
                    'change_given'     => $payment['change_given'],
                    'reference'        => $payment['reference'],
                    'books_account_id' => $payment['books_account_id'],
                ], 'payment_id');
            }
        });

        $invoice = $this->postInvoice($cartId);
        if (!$invoice['ok']) {
            Http::error(502, 'books_unavailable',
                'The sale could not be recorded in Books. Nothing has been billed — press Retry, or hold the sale and finish it when the connection is back.',
                ['retryable' => $invoice['retryable'], 'detail' => $invoice['message'], 'cart_id' => $cartId],
            );
        }

        $this->postStockIssue($cartId);

        $final = $carts->find($cartId);
        if (($final['books_voucher_uuid'] ?? null) !== null && $final['status'] !== 'COMPLETED') {
            Db::update('pos_carts', ['status' => 'COMPLETED', 'updated_at' => self::now()], ['cart_id' => $cartId, 'cmp_id' => $this->ctx->cmpId]);
        }

        $this->creditDrawer($cartId);

        Audit::record($this->ctx, $this->auth, 'sale.completed', 'cart', $cartId, null, [
            'total_amount' => $total, 'books_voucher_uuid' => $final['books_voucher_uuid'] ?? null,
        ]);

        return $this->result($cartId);
    }

    /**
     * Post the tax invoice to Books.
     *
     * Public so the Retry button can call it on a sale whose invoice failed,
     * without the cashier re-entering anything.
     *
     * RETURNS its outcome rather than sending a response, because two callers
     * need different behaviour from the same failure: an interactive checkout
     * wants a 502 the cashier can act on, while an offline batch has to record
     * the failure against the submission and carry on with the next sale. A
     * method that exited would make the second impossible.
     *
     * @return array{ok: bool, status: int, message: string, retryable: bool}
     */
    public function postInvoice(int $cartId): array
    {
        $cart = (new CartService($this->ctx, $this->auth))->find($cartId);
        if ($cart === []) {
            Http::notFound('That sale does not exist.');
        }
        if (($cart['books_voucher_uuid'] ?? null) !== null) {
            return self::posted();
        }

        $command = IntegrationCommand::open($this->ctx, 'books', self::COMMAND_INVOICE, 'cart', $cartId, [
            'total_amount' => (float) $cart['total_amount'],
            'lines'        => count($cart['lines']),
        ]);
        $commandId = (int) $command['command_id'];
        if (($command['status'] ?? '') === IntegrationCommand::COMPLETED) {
            return self::posted();
        }
        IntegrationCommand::markPosting($commandId);

        $response = (new BooksClient())
            ->withService($this->auth->uuid)
            ->createAndPostVoucher($this->ctx, BooksClient::VCH_SALES, $this->invoicePayload($cart), (string) $command['idempotency_key']);

        if (!$response['ok']) {
            $message = (string) ($response['error'] ?? 'Books did not accept the sale.');

            // A business refusal and a transport failure are different answers.
            // Books saying "that period is locked" will say it again on every
            // retry, so offering Retry there just teaches people to press it
            // twice; a timeout is worth pressing.
            $blocked = in_array($response['status'], [409, 422], true);
            $blocked ? IntegrationCommand::block($commandId, $message) : IntegrationCommand::fail($commandId, $message);

            return ['ok' => false, 'status' => (int) $response['status'], 'message' => $message, 'retryable' => !$blocked];
        }

        $voucher = $response['body']['data'] ?? [];
        IntegrationCommand::complete($commandId, [
            'books_voucher_id'   => $voucher['vch_txn_id'] ?? null,
            'books_voucher_uuid' => $voucher['vch_uuid'] ?? null,
            'books_voucher_no'   => $voucher['vch_no'] ?? null,
        ]);

        Db::update('pos_carts', [
            'status'             => 'COMPLETED',
            'books_voucher_id'   => self::id($voucher['vch_txn_id'] ?? $voucher['voucher_id'] ?? null),
            'books_voucher_uuid' => self::text($voucher['vch_uuid'] ?? $voucher['voucher_uuid'] ?? null),
            'books_voucher_no'   => self::text($voucher['vch_no'] ?? $voucher['voucher_no'] ?? null),
            'updated_at'         => self::now(),
        ], ['cart_id' => $cartId, 'cmp_id' => $this->ctx->cmpId]);

        return self::posted();
    }

    /**
     * Tell Inventory the goods left the shop.
     *
     * Deliberately NOT fatal. By the time this runs the customer has paid and
     * walked out with the goods; refusing the whole checkout because Inventory
     * is slow would leave a paid invoice the till pretends did not happen. The
     * command is left FAILED, it shows on the sale, and Retry finishes it.
     *
     * @return array{ok: bool, status: int, message: string, retryable: bool}
     */
    public function postStockIssue(int $cartId): array
    {
        $cart = (new CartService($this->ctx, $this->auth))->find($cartId);
        if ($cart === [] || ($cart['inventory_document_uuid'] ?? null) !== null) {
            return self::posted();
        }

        $stockLines = array_values(array_filter(
            $cart['lines'],
            static fn (array $l) => $l['item_id'] !== null && (float) $l['quantity'] > 0,
        ));
        if ($stockLines === []) {
            return self::posted();
        }

        $command = IntegrationCommand::open($this->ctx, 'inventory', self::COMMAND_ISSUE, 'cart', $cartId, [
            'lines' => count($stockLines),
        ]);
        $commandId = (int) $command['command_id'];
        if (($command['status'] ?? '') === IntegrationCommand::COMPLETED) {
            return self::posted();
        }
        IntegrationCommand::markPosting($commandId);

        $payload = [
            'document_type'        => 'POS_SALE',
            'document_date'        => substr((string) $cart['created_at'], 0, 10),
            'source_app'           => 'pos',
            'source_document_type' => 'pos.sale',
            'source_document_id'   => $cartId,
            'source_document_uuid' => (string) $cart['cart_uuid'],
            'source_document_no'   => (string) ($cart['books_voucher_no'] ?? $cart['token_no'] ?? $cartId),
            'party_ref'            => (string) ($cart['customer_account_id'] ?? ''),
            'narration'            => 'Counter sale ' . ($cart['books_voucher_no'] ?? ('token ' . ($cart['token_no'] ?? $cartId))),
            'lines' => array_map(static fn (array $line) => [
                'source_line_ref' => (string) $line['line_id'],
                'item_id'         => (int) $line['item_id'],
                'warehouse_id'    => $line['warehouse_id'] === null ? null : (int) $line['warehouse_id'],
                'batch_id'        => $line['batch_id'] === null ? null : (int) $line['batch_id'],
                'unit_id'         => $line['unit_id'] === null ? null : (int) $line['unit_id'],
                'serials'         => $line['serials'],
                'qty'             => (float) $line['quantity'],
                'rate'            => (float) $line['rate'],
                'amount'          => (float) $line['line_amount'],
                'direction'       => 'out',
                'description'     => $line['display_name'],
            ], $stockLines),
        ];

        $response = (new InventoryClient())->withService($this->auth->uuid)->postDocument($this->ctx, $payload, (string) $command['idempotency_key']);

        if (!$response['ok']) {
            $message = (string) ($response['error'] ?? 'Inventory did not accept the stock movement.');
            $blocked = in_array($response['status'], [409, 422], true);
            $blocked ? IntegrationCommand::block($commandId, $message) : IntegrationCommand::fail($commandId, $message);

            return ['ok' => false, 'status' => (int) $response['status'], 'message' => $message, 'retryable' => !$blocked];
        }

        $document = $response['body']['data'] ?? [];
        IntegrationCommand::complete($commandId, ['inventory_document_uuid' => $document['document_uuid'] ?? null]);

        Db::update('pos_carts', [
            'inventory_document_uuid' => self::text($document['document_uuid'] ?? null),
            'updated_at'              => self::now(),
        ], ['cart_id' => $cartId, 'cmp_id' => $this->ctx->cmpId]);

        return self::posted();
    }

    /**
     * Finish a sale whose invoice or stock issue did not go through.
     *
     * Runs on the SAME command rows, so the same idempotency keys are
     * presented. This is why Retry is safe to press twice.
     */
    public function retry(int $cartId): array
    {
        Permissions::assert($this->ctx, $this->auth, 'sell');

        $invoice = $this->postInvoice($cartId);
        if (!$invoice['ok']) {
            Http::error(502, 'books_unavailable', $invoice['message'], ['retryable' => $invoice['retryable'], 'cart_id' => $cartId]);
        }

        $issue = $this->postStockIssue($cartId);
        $this->creditDrawer($cartId);

        $result = $this->result($cartId);
        if (!$issue['ok']) {
            // The invoice is through, so the sale is real and the customer has
            // gone. Saying so beats a green tick that hides a stock movement
            // still waiting.
            $result['warning'] = 'The sale is billed, but stock has not been relieved yet: ' . $issue['message'];
        }

        return $result;
    }

    /**
     * Accept a batch of sales a till made while it was offline.
     *
     * THE GUARANTEE: one sale per (company, device uuid), enforced by a unique
     * index rather than by hopeful code. A submission that arrives twice —
     * because the response was lost, because the browser retried, because the
     * till was rebooted mid-upload — is recognised and its original outcome
     * replayed. The device may resend its whole queue as often as it likes.
     *
     * @param array<string, mixed> $input
     * @return array<string, mixed>
     */
    public function submitOffline(array $input): array
    {
        Permissions::assert($this->ctx, $this->auth, 'sell');

        $sales = $input['sales'] ?? [];
        if (!is_array($sales) || $sales === []) {
            Http::validationFailed('There is nothing to submit.', ['field' => 'sales']);
        }
        if (count($sales) > 200) {
            Http::validationFailed('Send at most 200 sales at a time.', ['field' => 'sales']);
        }

        $results = [];
        foreach ($sales as $sale) {
            if (!is_array($sale)) {
                continue;
            }
            $results[] = $this->acceptOfflineSale($sale);
        }

        // ACCEPTED MEANS POSTED, and nothing else. A sale sitting in CONFLICT is
        // not accepted however politely it was received: the shop took money
        // the books have not seen, and a counter that called that a success is
        // a counter that hides the hole. The device reads these numbers to
        // decide what to drop from its own queue, so being generous here would
        // lose sales for real.
        $posted = static fn (array $r): bool => $r['status'] === 'POSTED';

        return [
            'accepted'   => count(array_filter($results, $posted)),
            'duplicate'  => count(array_filter($results, static fn (array $r) => $r['duplicate'])),
            'failed'     => count(array_filter($results, static fn (array $r) => !$posted($r))),
            'conflicted' => count(array_filter($results, static fn (array $r) => $r['status'] === 'CONFLICT')),
            'pending'    => count(array_filter($results, static fn (array $r) => $r['status'] === 'RECEIVED')),
            'results'    => $results,
        ];
    }

    /**
     * One offline sale.
     *
     * @param array<string, mixed> $sale
     * @return array<string, mixed>
     */
    private function acceptOfflineSale(array $sale): array
    {
        $clientUuid = self::text($sale['client_uuid'] ?? null);
        $deviceUuid = self::text($sale['device_uuid'] ?? null);

        if ($clientUuid === null || $deviceUuid === null) {
            return ['client_uuid' => $clientUuid, 'status' => 'FAILED', 'duplicate' => false,
                    'message' => 'A sale made offline must carry the uuid the device minted for it.'];
        }

        // The replay check. A submission already seen returns its original
        // outcome — the device gets the same answer however many times it asks.
        $existing = Db::first(
            'SELECT * FROM pos_offline_submissions WHERE cmp_id = :cmp AND client_uuid = :uuid',
            ['cmp' => $this->ctx->cmpId, 'uuid' => $clientUuid],
        );
        if ($existing !== null) {
            if ($existing['status'] === 'POSTED') {
                return $this->offlineResult($existing, true);
            }
            // It was received but never got through. Try again on the same row,
            // and therefore on the same keys.
            return $this->drainOfflineSubmission((int) $existing['submission_id'], true);
        }

        $terminalId = self::id($sale['terminal_id'] ?? null);

        try {
            $submissionId = (int) Db::insert('pos_offline_submissions', [
                'cmp_id'            => $this->ctx->cmpId,
                'fy_id'             => $this->ctx->fyId,
                'bo_id'             => $this->ctx->boId,
                'terminal_id'       => $terminalId,
                'device_uuid'       => $deviceUuid,
                'client_uuid'       => $clientUuid,
                'status'            => 'RECEIVED',
                'client_created_at' => self::timestamp($sale['client_created_at'] ?? null),
                'payload'           => $sale,
            ], 'submission_id');
        } catch (\PDOException $e) {
            // Two uploads of the same sale racing each other. The unique index
            // caught the second; the answer is the first one's outcome.
            if (($e->getCode() ?? '') !== '23505') {
                throw $e;
            }
            $row = Db::first(
                'SELECT * FROM pos_offline_submissions WHERE cmp_id = :cmp AND client_uuid = :uuid',
                ['cmp' => $this->ctx->cmpId, 'uuid' => $clientUuid],
            );

            return $row === null
                ? ['client_uuid' => $clientUuid, 'status' => 'FAILED', 'duplicate' => true, 'message' => 'That sale is already being processed.']
                : $this->offlineResult($row, true);
        }

        return $this->drainOfflineSubmission($submissionId, false);
    }

    /**
     * Build the cart for an offline submission and post it.
     *
     * @return array<string, mixed>
     */
    private function drainOfflineSubmission(int $submissionId, bool $duplicate): array
    {
        $submission = Db::first(
            'SELECT * FROM pos_offline_submissions WHERE submission_id = :id AND cmp_id = :cmp',
            ['id' => $submissionId, 'cmp' => $this->ctx->cmpId],
        );
        if ($submission === null) {
            Http::notFound('That offline sale is not here.');
        }

        $payload = Db::jsonColumn($submission['payload'] ?? null);
        $cartId  = self::id($submission['cart_id']);
        $attempt = (int) $submission['attempts'] + 1;

        if ($cartId === null) {
            $cartId = $this->buildOfflineCart($submission, $payload);
            Db::update('pos_offline_submissions', ['cart_id' => $cartId, 'updated_at' => self::now()], ['submission_id' => $submissionId]);
        }

        $invoice = $this->postInvoice($cartId);

        if (!$invoice['ok']) {
            // The submission stays, visible on the offline queue screen, and the
            // device is told plainly. A device must NOT drop a sale from its own
            // queue on this answer — only on POSTED or a duplicate.
            //
            // CONFLICT and RECEIVED are kept apart deliberately: CONFLICT means
            // something has to change before this will ever post (a locked
            // period, a customer that no longer exists) and a person must look
            // at it; RECEIVED means try again.
            $blocked = !$invoice['retryable'];

            Db::update('pos_offline_submissions', [
                'status'          => $blocked ? 'CONFLICT' : 'RECEIVED',
                'conflict_kind'   => $blocked ? 'rejected' : null,
                'conflict_detail' => $blocked ? $invoice['message'] : null,
                'attempts'        => $attempt,
                'last_error'      => $invoice['message'],
                'updated_at'      => self::now(),
            ], ['submission_id' => $submissionId]);

            $row = Db::first('SELECT * FROM pos_offline_submissions WHERE submission_id = :id', ['id' => $submissionId]) ?? $submission;

            return $this->offlineResult($row, $duplicate);
        }

        // Stock can lag the invoice without the sale being unposted — the goods
        // went with the customer hours ago. The command row carries the failure
        // and Retry finishes it.
        $issue = $this->postStockIssue($cartId);
        $this->creditDrawer($cartId);

        Db::update('pos_offline_submissions', [
            'status'     => 'POSTED',
            'posted_at'  => self::now(),
            'attempts'   => $attempt,
            'last_error' => $issue['ok'] ? null : $issue['message'],
            'updated_at' => self::now(),
        ], ['submission_id' => $submissionId]);

        Audit::record($this->ctx, $this->auth, 'offline.posted', 'offline_submission', $submissionId, null, ['cart_id' => $cartId]);

        $row = Db::first('SELECT * FROM pos_offline_submissions WHERE submission_id = :id', ['id' => $submissionId]) ?? $submission;

        return $this->offlineResult($row, $duplicate);
    }

    /** @return array{ok: bool, status: int, message: string, retryable: bool} */
    private static function posted(): array
    {
        return ['ok' => true, 'status' => 200, 'message' => '', 'retryable' => false];
    }

    /**
     * Rebuild the cart the device sold from.
     *
     * Its lines are taken AS THE DEVICE SOLD THEM — the price the customer was
     * actually charged, which is a fact about the sale, not a cached master to
     * be re-derived. Re-pricing it now against today's catalogue would bill the
     * customer something other than what the receipt in their hand says.
     *
     * @param array<string, mixed> $submission
     * @param array<string, mixed> $payload
     */
    private function buildOfflineCart(array $submission, array $payload): int
    {
        $lines = $payload['lines'] ?? [];
        if (!is_array($lines) || $lines === []) {
            Http::validationFailed('That offline sale has no lines.');
        }

        return Db::transaction(function () use ($submission, $payload, $lines): int {
            $cartId = (int) Db::insert('pos_carts', [
                'cmp_id'              => $this->ctx->cmpId,
                'fy_id'               => $this->ctx->fyId,
                'bo_id'               => $this->ctx->boId,
                'terminal_id'         => self::id($submission['terminal_id']),
                'session_id'          => self::id($payload['session_id'] ?? null),
                'status'              => 'OPEN',
                'order_kind'          => self::text($payload['order_kind'] ?? null) ?? 'retail',
                'customer_account_id' => self::id($payload['customer_account_id'] ?? null),
                'customer_name'       => self::text($payload['customer_name'] ?? null),
                'customer_mobile'     => self::text($payload['customer_mobile'] ?? null),
                'token_no'            => self::text($payload['token_no'] ?? null),
                'discount_amount'     => round((float) ($payload['discount_amount'] ?? 0), 4),
                'service_charge_amount' => round((float) ($payload['service_charge_amount'] ?? 0), 4),
                'tip_amount'          => round((float) ($payload['tip_amount'] ?? 0), 4),
                'offline_created'     => true,
                'device_uuid'         => (string) $submission['device_uuid'],
                'opened_by'           => self::text($payload['opened_by'] ?? null) ?? $this->auth->uuid,
                'created_at'          => (string) $submission['client_created_at'],
            ], 'cart_id');

            $lineNo = 0;
            foreach ($lines as $line) {
                if (!is_array($line)) {
                    continue;
                }
                $lineNo++;
                $qty  = round((float) ($line['quantity'] ?? 0), 4);
                $rate = round((float) ($line['rate'] ?? 0), 4);
                $discount = round((float) ($line['discount_amount'] ?? 0), 4);
                $net  = round(($qty * $rate) - $discount, 4);
                $taxPc = round((float) ($line['estimated_tax_pc'] ?? 0), 3);

                Db::insert('pos_cart_lines', [
                    'cart_id'          => $cartId,
                    'cmp_id'           => $this->ctx->cmpId,
                    'line_no'          => $lineNo,
                    'item_id'          => self::id($line['item_id'] ?? null),
                    'unit_id'          => self::id($line['unit_id'] ?? null),
                    'warehouse_id'     => self::id($line['warehouse_id'] ?? null),
                    'batch_id'         => self::id($line['batch_id'] ?? null),
                    'serials'          => array_values(array_filter((array) ($line['serials'] ?? []), 'is_string')),
                    'display_name'     => self::text($line['display_name'] ?? null) ?? 'Item',
                    'menu_item_id'     => self::id($line['menu_item_id'] ?? null),
                    'modifiers'        => is_array($line['modifiers'] ?? null) ? $line['modifiers'] : [],
                    'instructions'     => self::text($line['instructions'] ?? null),
                    'quantity'         => $qty,
                    'rate'             => $rate,
                    'discount_pc'      => round((float) ($line['discount_pc'] ?? 0), 3),
                    'discount_amount'  => $discount,
                    'tax_cat_id'       => self::id($line['tax_cat_id'] ?? null),
                    'estimated_tax_pc' => $taxPc,
                    'estimated_tax_amount' => round($net * $taxPc / 100, 4),
                    'line_amount'      => $net,
                ], 'line_id');
            }

            foreach ((array) ($payload['payments'] ?? []) as $payment) {
                if (!is_array($payment)) {
                    continue;
                }
                Db::insert('pos_cart_payments', [
                    'cart_id'      => $cartId,
                    'cmp_id'       => $this->ctx->cmpId,
                    'payment_mode' => self::paymentMode($payment['payment_mode'] ?? 'cash'),
                    'amount'       => round((float) ($payment['amount'] ?? 0), 4),
                    'tendered'     => isset($payment['tendered']) ? round((float) $payment['tendered'], 4) : null,
                    'change_given' => round((float) ($payment['change_given'] ?? 0), 4),
                    'reference'    => self::reference($payment['reference'] ?? null),
                ], 'payment_id');
            }

            (new CartService($this->ctx, $this->auth))->recalculate($cartId);

            return $cartId;
        });
    }

    /**
     * The offline queue, for the screen that shows what has not got through.
     *
     * @return array{0: list<array<string, mixed>>, 1: int}
     */
    public function offlineQueue(array $filters, int $limit, int $offset): array
    {
        [$scope, $params] = $this->ctx->scopeClause();
        $where = [$scope];

        if (!empty($filters['status'])) {
            $where[] = 'status = :status';
            $params['status'] = (string) $filters['status'];
        } else {
            $where[] = "status <> 'POSTED'";
        }
        if (!empty($filters['terminal_id'])) {
            $where[] = 'terminal_id = :terminal';
            $params['terminal'] = (int) $filters['terminal_id'];
        }

        $clause = implode(' AND ', $where);
        $total = (int) Db::scalar('SELECT COUNT(*) FROM pos_offline_submissions WHERE ' . $clause, $params);
        $rows = Db::all(
            'SELECT submission_id, client_uuid, device_uuid, terminal_id, status, cart_id, conflict_kind,
                    conflict_detail, attempts, last_error, client_created_at, received_at, posted_at,
                    resolved_by, resolved_at
             FROM pos_offline_submissions WHERE ' . $clause . '
             ORDER BY submission_id DESC LIMIT ' . (int) $limit . ' OFFSET ' . (int) $offset,
            $params,
        );

        return [$rows, $total];
    }

    /** Push a stuck offline sale through again, on its original keys. */
    public function retryOffline(int $submissionId): array
    {
        Permissions::assert($this->ctx, $this->auth, 'offline.resolve');

        return $this->drainOfflineSubmission($submissionId, false);
    }

    /**
     * Give up on an offline sale that will never post, with a reason.
     *
     * Deliberately explicit and permissioned: a sale the shop took and the
     * books never saw is a real hole, and someone has to own the decision to
     * leave it. The row stays, with who abandoned it and why.
     *
     * @param array<string, mixed> $input
     */
    public function abandonOffline(int $submissionId, array $input): array
    {
        Permissions::assert($this->ctx, $this->auth, 'offline.resolve');

        $note = self::text($input['note'] ?? null);
        if ($note === null) {
            Http::validationFailed('Say why this sale is being abandoned.', ['field' => 'note']);
        }

        $submission = Db::first(
            'SELECT * FROM pos_offline_submissions WHERE submission_id = :id AND cmp_id = :cmp',
            ['id' => $submissionId, 'cmp' => $this->ctx->cmpId],
        );
        if ($submission === null) {
            Http::notFound('That offline sale is not here.');
        }
        if ($submission['status'] === 'POSTED') {
            Http::conflict('That sale did post. There is nothing to abandon.');
        }

        Db::update('pos_offline_submissions', [
            'status'          => 'ABANDONED',
            'resolved_by'     => $this->auth->uuid,
            'resolved_at'     => self::now(),
            'resolution_note' => $note,
            'updated_at'      => self::now(),
        ], ['submission_id' => $submissionId, 'cmp_id' => $this->ctx->cmpId]);

        Audit::record($this->ctx, $this->auth, 'offline.abandoned', 'offline_submission', $submissionId, null, null, $note);

        $row = Db::first('SELECT * FROM pos_offline_submissions WHERE submission_id = :id', ['id' => $submissionId]) ?? [];

        return $this->offlineResult($row, false);
    }

    /**
     * The sale, with the state of everything it depends on.
     *
     * @return array<string, mixed>
     */
    public function result(int $cartId): array
    {
        $cart = (new CartService($this->ctx, $this->auth))->find($cartId);
        if ($cart === []) {
            Http::notFound('That sale does not exist.');
        }

        $cart['commands'] = IntegrationCommand::forEntity($this->ctx, 'cart', $cartId);

        return $cart;
    }

    /**
     * The invoice payload for Books.
     *
     * Books computes the statutory tax itself from the lines and the party. We
     * send what we charged and what we took; we do not tell the accountant what
     * the tax is.
     *
     * @param array<string, mixed> $cart
     * @return array<string, mixed>
     */
    private function invoicePayload(array $cart): array
    {
        $payments = Db::all('SELECT * FROM pos_cart_payments WHERE cart_id = :cart ORDER BY payment_id', ['cart' => (int) $cart['cart_id']]);

        return [
            'vch_date'     => substr((string) $cart['created_at'], 0, 10),
            'party_acc_id' => self::id($cart['customer_account_id']),
            'party_name'   => $cart['customer_name'],
            'party_mobile' => $cart['customer_mobile'],
            'narration'    => 'Counter sale at till' . ($cart['token_no'] === null ? '' : (' — token ' . $cart['token_no'])),
            'reference_no' => (string) ($cart['token_no'] ?? $cart['cart_uuid']),
            'bo_id'        => (int) $cart['bo_id'],

            'source_app'           => 'pos',
            'source_document_type' => 'pos.sale',
            'source_document_id'   => (int) $cart['cart_id'],
            'source_document_uuid' => (string) $cart['cart_uuid'],

            // A counter sale is paid at the counter, so the receipt rides with
            // the invoice. Books decides how to represent that — one voucher or
            // two — because that is an accounting decision, not a till one.
            'settlements' => array_map(static fn (array $p) => [
                'payment_mode' => (string) $p['payment_mode'],
                'amount'       => (float) $p['amount'],
                'reference'    => $p['reference'],
                'acc_id'       => $p['books_account_id'] === null ? null : (int) $p['books_account_id'],
            ], $payments),

            'discount_amount'       => (float) $cart['discount_amount'],
            'service_charge_amount' => (float) $cart['service_charge_amount'],
            'tip_amount'            => (float) $cart['tip_amount'],

            'inventory_lines' => array_values(array_map(static fn (array $line) => [
                'source_line_ref' => (string) $line['line_id'],
                'item_id'         => $line['item_id'] === null ? null : (int) $line['item_id'],
                'unit_id'         => $line['unit_id'] === null ? null : (int) $line['unit_id'],
                'mc_id'           => $line['warehouse_id'] === null ? null : (int) $line['warehouse_id'],
                'description'     => $line['display_name'],
                'qty'             => (float) $line['quantity'],
                'rate'            => (float) $line['rate'],
                'discount_amount' => (float) $line['discount_amount'],
                'tax_cat_id'      => $line['tax_cat_id'] === null ? null : (int) $line['tax_cat_id'],
                'amount'          => (float) $line['line_amount'],
            ], $cart['lines'])),
        ];
    }

    /** Cash taken and change given, onto this shift's drawer. */
    private function creditDrawer(int $cartId): void
    {
        $cart = Db::first('SELECT session_id, status FROM pos_carts WHERE cart_id = :id AND cmp_id = :cmp', ['id' => $cartId, 'cmp' => $this->ctx->cmpId]);
        $sessionId = $cart === null ? null : self::id($cart['session_id']);
        if ($sessionId === null || ($cart['status'] ?? '') !== 'COMPLETED') {
            return;
        }

        $already = (int) Db::scalar(
            "SELECT COUNT(*) FROM pos_cash_drawer_events
             WHERE session_id = :sid AND event_kind = 'sale_tender' AND reason = :ref",
            ['sid' => $sessionId, 'ref' => 'cart:' . $cartId],
        );
        if ($already > 0) {
            return;
        }

        $cash = Db::first(
            "SELECT COALESCE(SUM(amount), 0) AS taken, COALESCE(SUM(change_given), 0) AS change_given
             FROM pos_cart_payments WHERE cart_id = :cart AND payment_mode = 'cash'",
            ['cart' => $cartId],
        ) ?? ['taken' => 0, 'change_given' => 0];

        $net = round((float) $cash['taken'] - (float) $cash['change_given'], 4);
        if (abs($net) < 0.0001) {
            return;
        }

        Db::transaction(function () use ($sessionId, $cartId, $net) {
            Db::insert('pos_cash_drawer_events', [
                'session_id' => $sessionId,
                'cmp_id'     => $this->ctx->cmpId,
                'event_kind' => 'sale_tender',
                'amount'     => $net,
                'reason'     => 'cart:' . $cartId,
                'actor_uuid' => $this->auth->uuid,
            ], 'event_id');

            Db::run(
                'UPDATE pos_register_sessions SET expected_cash = expected_cash + :amount, updated_at = :now
                 WHERE session_id = :id AND cmp_id = :cmp',
                ['amount' => $net, 'now' => self::now(), 'id' => $sessionId, 'cmp' => $this->ctx->cmpId],
            );
        });
    }

    /**
     * @param mixed $raw
     * @return list<array<string, mixed>>
     */
    private function normalisePayments(mixed $raw): array
    {
        if (!is_array($raw)) {
            return [];
        }

        $out = [];
        foreach ($raw as $payment) {
            if (!is_array($payment)) {
                continue;
            }
            $amount = round((float) ($payment['amount'] ?? 0), 4);
            if ($amount <= 0) {
                continue;
            }
            $out[] = [
                'payment_mode'     => self::paymentMode($payment['payment_mode'] ?? 'cash'),
                'amount'           => $amount,
                'tendered'         => isset($payment['tendered']) ? round((float) $payment['tendered'], 4) : null,
                'change_given'     => round((float) ($payment['change_given'] ?? 0), 4),
                'reference'        => self::reference($payment['reference'] ?? null),
                'books_account_id' => self::id($payment['books_account_id'] ?? null),
            ];
        }

        return $out;
    }

    private static function paymentMode(mixed $raw): string
    {
        $mode = is_string($raw) ? strtolower(trim($raw)) : 'cash';
        $allowed = ['cash', 'card', 'upi', 'bank', 'customer_credit', 'gift_card', 'other'];

        if (!in_array($mode, $allowed, true)) {
            Http::validationFailed('That is not a way this till takes money.', ['field' => 'payment_mode', 'allowed' => $allowed]);
        }

        return $mode;
    }

    /**
     * A payment reference the cashier typed from an external terminal's slip.
     *
     * NEVER a card number. Anything that looks like a PAN is refused outright
     * rather than truncated, because a system that quietly truncates teaches
     * cashiers it is fine to type them. Aicountly Pay does not exist yet and
     * nothing here pretends to be a gateway.
     */
    private static function reference(mixed $raw): ?string
    {
        $value = self::text($raw);
        if ($value === null) {
            return null;
        }

        $digits = preg_replace('/\D/', '', $value) ?? '';
        if (strlen($digits) >= 12) {
            Http::validationFailed(
                'Do not type card numbers here. The last four digits from the terminal slip, or the UPI reference, is what belongs in this box.',
                ['field' => 'reference'],
            );
        }

        return mb_substr($value, 0, 120);
    }

    /**
     * @param array<string, mixed> $row
     * @return array<string, mixed>
     */
    private function offlineResult(array $row, bool $duplicate): array
    {
        return [
            'submission_id' => (int) ($row['submission_id'] ?? 0),
            'client_uuid'   => $row['client_uuid'] ?? null,
            'status'        => (string) ($row['status'] ?? 'RECEIVED'),
            'duplicate'     => $duplicate,
            'cart_id'       => self::id($row['cart_id'] ?? null),
            'message'       => $row['last_error'] ?? ($row['conflict_detail'] ?? null),
        ];
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

    private static function timestamp(mixed $raw): string
    {
        if (is_string($raw) && $raw !== '' && strtotime($raw) !== false) {
            return gmdate('Y-m-d H:i:s', (int) strtotime($raw));
        }

        return self::now();
    }

    private static function now(): string
    {
        return gmdate('Y-m-d H:i:s');
    }
}
