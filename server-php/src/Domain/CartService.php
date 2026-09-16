<?php

declare(strict_types=1);

namespace Aicountly\Api\Domain;

use Aicountly\Api\Audit;
use Aicountly\Api\Auth;
use Aicountly\Api\Clients\InventoryClient;
use Aicountly\Api\Context;
use Aicountly\Api\Db;
use Aicountly\Api\Http;
use Aicountly\Api\Permissions;

/**
 * The cart — what is on the counter right now.
 *
 * A cart is NOT an invoice and NOT a stock movement. It is a working document
 * that exists between the first scan and the moment money changes hands, and
 * after checkout it keeps only a reference to the sale Books wrote.
 *
 * WHERE THE NUMBERS COME FROM. Item names, prices and tax rates are read LIVE
 * from Inventory on the request that needs them. What is stored on a line is
 * the price the shop actually charged this customer — a commercial fact of the
 * sale that belongs to the sale — plus a display name so a receipt reprinted a
 * year later still reads sensibly after the item was renamed. Neither is a
 * cached master: nothing refreshes them, nothing reconciles them, and the
 * release-blocking ownership test asserts no stock, cost or master column is
 * ever added here.
 *
 * THE TAX HERE IS AN ESTIMATE, and the column says so. Books computes the
 * statutory tax when it writes the invoice, because place of supply, reverse
 * charge and composition are accounting rules that live with the accounts. The
 * till shows a number so the customer knows what to pay; if Books computes a
 * different one, Books is right and the receipt shows Books' figure.
 */
final class CartService
{
    public function __construct(
        private readonly Context $ctx,
        private readonly Auth $auth,
    ) {
    }

    /** @param array<string, mixed> $input */
    public function open(array $input): array
    {
        Permissions::assert($this->ctx, $this->auth, 'sell');

        $terminalId = self::id($input['terminal_id'] ?? null);
        $sessionId  = self::id($input['session_id'] ?? null);

        $kind = self::text($input['order_kind'] ?? null) ?? 'retail';
        $allowed = ['retail', 'dine_in', 'takeaway', 'delivery', 'qr_order', 'quick_service'];
        if (!in_array($kind, $allowed, true)) {
            Http::validationFailed('That is not a kind of order this till takes.', ['field' => 'order_kind', 'allowed' => $allowed]);
        }

        if ($terminalId !== null && $sessionId === null) {
            $session = (new RegisterService($this->ctx, $this->auth))->currentForTerminal($terminalId);
            $sessionId = $session === null ? null : (int) $session['session_id'];

            // A counter sale takes money NOW, so it needs a drawer to put it in
            // and a shift to answer for it. A waiter seating a table does not:
            // the money comes at the end, on whichever till settles the bill,
            // and demanding a shift here would stop the floor working before
            // the first till was even opened.
            if ($sessionId === null && in_array($kind, ['retail', 'quick_service'], true)) {
                Http::conflict('This till has no shift open. Open the till before selling.');
            }
        }

        return Db::transaction(function () use ($input, $terminalId, $sessionId, $kind) {
            $token = $terminalId === null ? null : NumberSeries::nextToken($this->ctx, $terminalId);

            $cartId = (int) Db::insert('pos_carts', [
                'cmp_id'              => $this->ctx->cmpId,
                'fy_id'               => $this->ctx->fyId,
                'bo_id'               => $this->ctx->boId,
                'terminal_id'         => $terminalId,
                'session_id'          => $sessionId,
                'status'              => 'OPEN',
                'order_kind'          => $kind,
                'customer_account_id' => self::id($input['customer_account_id'] ?? null),
                'customer_name'       => self::text($input['customer_name'] ?? null),
                'customer_mobile'     => self::text($input['customer_mobile'] ?? null),
                'table_session_id'    => self::id($input['table_session_id'] ?? null),
                'token_no'            => $token,
                'offline_created'     => (bool) ($input['offline_created'] ?? false),
                'device_uuid'         => self::text($input['device_uuid'] ?? null),
                'opened_by'           => $this->auth->uuid,
            ], 'cart_id');

            Audit::record($this->ctx, $this->auth, 'cart.opened', 'cart', $cartId, null, ['order_kind' => $kind, 'token_no' => $token]);

            return $this->find($cartId);
        });
    }

    /**
     * Add or replace a line.
     *
     * The item is looked up in Inventory on this request. If Inventory cannot
     * answer, the line is still accepted using what the caller sent — a till
     * that stops selling because a lookup timed out is a till that costs the
     * shop its queue. What is NOT accepted on a failed lookup is an invented
     * price: the caller must have sent one, from its own cache, and the
     * response says the price is unverified so the screen can say so too.
     *
     * @param array<string, mixed> $input
     */
    public function addLine(int $cartId, array $input): array
    {
        Permissions::assert($this->ctx, $this->auth, 'sell');

        $cart = $this->requireOpen($cartId);

        $itemId     = self::id($input['item_id'] ?? null);
        $menuItemId = self::id($input['menu_item_id'] ?? null);
        if ($itemId === null && $menuItemId === null) {
            Http::validationFailed('Pick an item.', ['field' => 'item_id']);
        }

        $qty = (float) ($input['quantity'] ?? 1);
        if ($qty <= 0) {
            Http::validationFailed('A line needs a quantity above zero.', ['field' => 'quantity']);
        }

        $menuItem = null;
        if ($menuItemId !== null) {
            $menuItem = Db::first(
                'SELECT * FROM pos_menu_items WHERE menu_item_id = :id AND cmp_id = :cmp',
                ['id' => $menuItemId, 'cmp' => $this->ctx->cmpId],
            );
            if ($menuItem === null) {
                Http::notFound('That menu item does not exist.');
            }
            if ($menuItem['availability'] === 'SOLD_OUT') {
                Http::conflict(($menuItem['display_name'] ?? 'That item') . ' is sold out.');
            }
            $itemId ??= self::id($menuItem['item_id'] ?? null);
        }

        // LIVE lookup. Inventory owns the item; we are asking, not remembering.
        $live = $this->lookupItem($itemId);

        $rate = array_key_exists('rate', $input) && $input['rate'] !== null
            ? round((float) $input['rate'], 4)
            : $this->defaultRate($menuItem, $live, $input);

        if ($rate === null) {
            Http::validationFailed(
                'This item has no price, and Inventory could not be reached to look one up. Type the price to continue.',
                ['field' => 'rate'],
            );
        }

        // A price the cashier typed over the catalogue price is a separate
        // permission, because it is the cheapest way to steal from a till.
        if ($this->isOverride($rate, $menuItem, $live)) {
            Permissions::assert($this->ctx, $this->auth, 'price.override');
        }

        $discountPc = round((float) ($input['discount_pc'] ?? 0), 3);
        $this->assertDiscountAllowed($discountPc);

        $lineAmount    = round($qty * $rate, 4);
        $discountAmt   = array_key_exists('discount_amount', $input) && $input['discount_amount'] !== null
            ? round((float) $input['discount_amount'], 4)
            : round($lineAmount * $discountPc / 100, 4);
        $netAmount     = round($lineAmount - $discountAmt, 4);
        $taxPc         = $this->taxPercent($menuItem, $live, $input);
        $estimatedTax  = round($netAmount * $taxPc / 100, 4);

        return Db::transaction(function () use ($cartId, $cart, $input, $itemId, $menuItemId, $menuItem, $live, $qty, $rate, $discountPc, $discountAmt, $netAmount, $taxPc, $estimatedTax) {
            // The lock is on the CART, not on an aggregate over its lines:
            // PostgreSQL refuses FOR UPDATE with an aggregate, and the cart row
            // is the right thing to lock anyway — line numbers are unique per
            // cart, so holding that row is what makes the next number exclusive.
            Db::run('SELECT cart_id FROM pos_carts WHERE cart_id = :cart FOR UPDATE', ['cart' => $cartId]);
            $lineNo = 1 + (int) Db::scalar(
                'SELECT COALESCE(MAX(line_no), 0) FROM pos_cart_lines WHERE cart_id = :cart',
                ['cart' => $cartId],
            );

            $lineId = (int) Db::insert('pos_cart_lines', [
                'cart_id'          => $cartId,
                'cmp_id'           => $this->ctx->cmpId,
                'line_no'          => $lineNo,
                'item_id'          => $itemId,
                'unit_id'          => self::id($input['unit_id'] ?? $live['unit_id'] ?? null),
                'warehouse_id'     => self::id($input['warehouse_id'] ?? null) ?? $this->defaultWarehouse($cart),
                'batch_id'         => self::id($input['batch_id'] ?? null),
                'serials'          => array_values(array_filter((array) ($input['serials'] ?? []), 'is_string')),
                'display_name'     => self::text($input['display_name'] ?? null)
                    ?? self::text($menuItem['display_name'] ?? null)
                    ?? self::text($live['item_name'] ?? $live['name'] ?? null)
                    ?? 'Item',
                'menu_item_id'     => $menuItemId,
                'parent_line_id'   => self::id($input['parent_line_id'] ?? null),
                'modifiers'        => $this->normaliseModifiers($input['modifiers'] ?? []),
                'instructions'     => self::text($input['instructions'] ?? null),
                'quantity'         => $qty,
                'rate'             => $rate,
                'discount_pc'      => $discountPc,
                'discount_amount'  => $discountAmt,
                'tax_cat_id'       => self::id($input['tax_cat_id'] ?? $menuItem['tax_cat_id'] ?? $live['tax_cat_id'] ?? null),
                'estimated_tax_pc' => $taxPc,
                'line_amount'      => $netAmount,
                'estimated_tax_amount' => $estimatedTax,
                'kitchen_status'   => $menuItemId === null ? null : 'NEW',
            ], 'line_id');

            $this->recalculate($cartId);

            Audit::record($this->ctx, $this->auth, 'cart.line_added', 'cart', $cartId, null, [
                'line_id' => $lineId, 'item_id' => $itemId, 'quantity' => $qty, 'rate' => $rate,
            ]);

            return $this->find($cartId);
        });
    }

    /** @param array<string, mixed> $input */
    public function updateLine(int $cartId, int $lineId, array $input): array
    {
        Permissions::assert($this->ctx, $this->auth, 'sell');

        $cart = $this->requireOpen($cartId);
        $line = Db::first(
            'SELECT * FROM pos_cart_lines WHERE line_id = :id AND cart_id = :cart AND cmp_id = :cmp',
            ['id' => $lineId, 'cart' => $cartId, 'cmp' => $this->ctx->cmpId],
        );
        if ($line === null) {
            Http::notFound('That line is not on this sale.');
        }

        // A line the kitchen has already started is not a line the cashier may
        // quietly edit. Changing it means amending the ticket, which the
        // kitchen has to see.
        if (in_array((string) ($line['kitchen_status'] ?? ''), ['PREPARING', 'READY', 'SERVED'], true)) {
            Http::conflict('The kitchen has already started this item. Cancel the ticket line instead of editing it.');
        }

        $qty  = array_key_exists('quantity', $input) ? (float) $input['quantity'] : (float) $line['quantity'];
        $rate = array_key_exists('rate', $input) ? round((float) $input['rate'], 4) : (float) $line['rate'];

        if ($qty <= 0) {
            Http::validationFailed('A line needs a quantity above zero. Remove the line instead.', ['field' => 'quantity']);
        }
        if (array_key_exists('rate', $input) && abs($rate - (float) $line['rate']) > 0.0001) {
            Permissions::assert($this->ctx, $this->auth, 'price.override');
        }

        $discountPc = array_key_exists('discount_pc', $input) ? round((float) $input['discount_pc'], 3) : (float) $line['discount_pc'];
        if (abs($discountPc - (float) $line['discount_pc']) > 0.0001) {
            $this->assertDiscountAllowed($discountPc);
        }

        $gross       = round($qty * $rate, 4);
        $discountAmt = array_key_exists('discount_amount', $input) && $input['discount_amount'] !== null
            ? round((float) $input['discount_amount'], 4)
            : round($gross * $discountPc / 100, 4);
        $netAmount   = round($gross - $discountAmt, 4);
        $taxPc       = (float) $line['estimated_tax_pc'];

        return Db::transaction(function () use ($cartId, $lineId, $line, $input, $qty, $rate, $discountPc, $discountAmt, $netAmount, $taxPc) {
            Db::update('pos_cart_lines', [
                'quantity'             => $qty,
                'rate'                 => $rate,
                'discount_pc'          => $discountPc,
                'discount_amount'      => $discountAmt,
                'line_amount'          => $netAmount,
                'estimated_tax_amount' => round($netAmount * $taxPc / 100, 4),
                'instructions'         => array_key_exists('instructions', $input) ? self::text($input['instructions']) : $line['instructions'],
                'updated_at'           => self::now(),
            ], ['line_id' => $lineId, 'cmp_id' => $this->ctx->cmpId]);

            $this->recalculate($cartId);

            Audit::record($this->ctx, $this->auth, 'cart.line_changed', 'cart', $cartId,
                ['quantity' => (float) $line['quantity'], 'rate' => (float) $line['rate']],
                ['quantity' => $qty, 'rate' => $rate],
            );

            return $this->find($cartId);
        });
    }

    /** Remove a line before payment. A separate permission from selling. */
    public function removeLine(int $cartId, int $lineId, array $input = []): array
    {
        Permissions::assert($this->ctx, $this->auth, 'cart.void_line');

        $cart = $this->requireOpen($cartId);
        $line = Db::first(
            'SELECT * FROM pos_cart_lines WHERE line_id = :id AND cart_id = :cart AND cmp_id = :cmp',
            ['id' => $lineId, 'cart' => $cartId, 'cmp' => $this->ctx->cmpId],
        );
        if ($line === null) {
            Http::notFound('That line is not on this sale.');
        }
        if (in_array((string) ($line['kitchen_status'] ?? ''), ['PREPARING', 'READY', 'SERVED'], true)) {
            Http::conflict('The kitchen has already made this. Cancel the ticket line — a manager has to approve that.');
        }

        $reason = self::text($input['reason'] ?? null);
        if ($this->settings()['require_reason_on_void'] && ($reason === null || $reason === '')) {
            Http::validationFailed('Say why this line is coming off.', ['field' => 'reason']);
        }

        return Db::transaction(function () use ($cartId, $cart, $lineId, $line, $reason) {
            Db::run('DELETE FROM pos_cart_lines WHERE line_id = :id AND cmp_id = :cmp', ['id' => $lineId, 'cmp' => $this->ctx->cmpId]);

            Db::insert('pos_approval_events', [
                'cmp_id'       => $this->ctx->cmpId,
                'terminal_id'  => $cart['terminal_id'],
                'session_id'   => $cart['session_id'],
                'cart_id'      => $cartId,
                'event_kind'   => 'void_line',
                'requested_by' => $this->auth->uuid,
                'approved_by'  => $this->auth->uuid,
                'reason'       => $reason,
                'detail'       => [
                    'item_id' => $line['item_id'], 'display_name' => $line['display_name'],
                    'quantity' => (float) $line['quantity'], 'line_amount' => (float) $line['line_amount'],
                ],
            ], 'approval_id');

            $this->recalculate($cartId);

            Audit::record($this->ctx, $this->auth, 'cart.line_removed', 'cart', $cartId, ['line_id' => $lineId], null, $reason ?? '');

            return $this->find($cartId);
        });
    }

    /** Park the sale so the next customer can be served. */
    public function hold(int $cartId, array $input): array
    {
        Permissions::assert($this->ctx, $this->auth, 'cart.hold');

        $cart = $this->requireOpen($cartId);

        Db::update('pos_carts', [
            'status'     => 'HELD',
            'hold_label' => self::text($input['hold_label'] ?? null) ?? ($cart['customer_name'] ?? ('Token ' . ($cart['token_no'] ?? '—'))),
            'updated_at' => self::now(),
        ], ['cart_id' => $cartId, 'cmp_id' => $this->ctx->cmpId]);

        Audit::record($this->ctx, $this->auth, 'cart.held', 'cart', $cartId, null, null);

        return $this->find($cartId);
    }

    public function resume(int $cartId): array
    {
        Permissions::assert($this->ctx, $this->auth, 'cart.hold');

        $cart = $this->find($cartId);
        if ($cart === []) {
            Http::notFound('That sale does not exist.');
        }
        if ($cart['status'] !== 'HELD') {
            Http::conflict('That sale is not on hold.');
        }

        Db::update('pos_carts', ['status' => 'OPEN', 'updated_at' => self::now()], ['cart_id' => $cartId, 'cmp_id' => $this->ctx->cmpId]);
        Audit::record($this->ctx, $this->auth, 'cart.resumed', 'cart', $cartId, null, null);

        return $this->find($cartId);
    }

    /**
     * Void the whole sale before payment.
     *
     * A cart that has reached Books is not voidable from here: the sale exists,
     * and undoing it is a credit note, which is a different document with a
     * different approval. Saying so plainly is more useful than a generic
     * "cannot void".
     *
     * @param array<string, mixed> $input
     */
    public function void(int $cartId, array $input): array
    {
        Permissions::assert($this->ctx, $this->auth, 'cart.void');

        $cart = $this->find($cartId);
        if ($cart === []) {
            Http::notFound('That sale does not exist.');
        }
        if ($cart['status'] === 'COMPLETED') {
            Http::conflict('This sale has already gone through. Take a return instead of voiding it.');
        }
        if ($cart['status'] === 'VOID') {
            Http::conflict('This sale is already void.');
        }

        $reason = self::text($input['reason'] ?? null);
        if ($this->settings()['require_reason_on_void'] && ($reason === null || $reason === '')) {
            Http::validationFailed('Say why this sale is being voided.', ['field' => 'reason']);
        }

        return Db::transaction(function () use ($cartId, $cart, $reason) {
            Db::update('pos_carts', [
                'status'      => 'VOID',
                'voided_by'   => $this->auth->uuid,
                'void_reason' => $reason,
                'updated_at'  => self::now(),
            ], ['cart_id' => $cartId, 'cmp_id' => $this->ctx->cmpId]);

            Db::run(
                "UPDATE pos_kots SET status = 'CANCELLED', cancelled_at = :now, cancelled_by = :by,
                        cancel_reason = :reason, updated_at = :now
                 WHERE cart_id = :cart AND cmp_id = :cmp AND status NOT IN ('CANCELLED', 'SERVED')",
                ['now' => self::now(), 'by' => $this->auth->uuid, 'reason' => $reason ?? 'Sale voided', 'cart' => $cartId, 'cmp' => $this->ctx->cmpId],
            );

            Db::insert('pos_approval_events', [
                'cmp_id'       => $this->ctx->cmpId,
                'terminal_id'  => $cart['terminal_id'],
                'session_id'   => $cart['session_id'],
                'cart_id'      => $cartId,
                'event_kind'   => 'void_cart',
                'requested_by' => $this->auth->uuid,
                'approved_by'  => $this->auth->uuid,
                'reason'       => $reason,
                'detail'       => ['total_amount' => (float) $cart['total_amount'], 'lines' => count($cart['lines'])],
            ], 'approval_id');

            Audit::record($this->ctx, $this->auth, 'cart.voided', 'cart', $cartId, ['status' => $cart['status']], ['status' => 'VOID'], $reason ?? '');

            return $this->find($cartId);
        });
    }

    /**
     * Apply a bill-level discount, service charge or tip.
     *
     * @param array<string, mixed> $input
     */
    public function applyCharges(int $cartId, array $input): array
    {
        Permissions::assert($this->ctx, $this->auth, 'sell');

        $cart = $this->requireOpen($cartId);
        $values = ['updated_at' => self::now()];

        if (array_key_exists('discount_amount', $input)) {
            $discount = round((float) $input['discount_amount'], 4);
            $subtotal = (float) $cart['subtotal_amount'];
            $pc = $subtotal > 0 ? round($discount / $subtotal * 100, 3) : 0.0;
            $this->assertDiscountAllowed($pc);
            $values['discount_amount'] = $discount;
        }
        if (array_key_exists('service_charge_amount', $input)) {
            $values['service_charge_amount'] = round((float) $input['service_charge_amount'], 4);
        }
        if (array_key_exists('tip_amount', $input)) {
            $values['tip_amount'] = round((float) $input['tip_amount'], 4);
        }
        if (array_key_exists('customer_account_id', $input)) {
            $values['customer_account_id'] = self::id($input['customer_account_id']);
        }
        if (array_key_exists('customer_name', $input)) {
            $values['customer_name'] = self::text($input['customer_name']);
        }
        if (array_key_exists('customer_mobile', $input)) {
            $values['customer_mobile'] = self::text($input['customer_mobile']);
        }

        return Db::transaction(function () use ($cartId, $values) {
            Db::update('pos_carts', $values, ['cart_id' => $cartId, 'cmp_id' => $this->ctx->cmpId]);
            $this->recalculate($cartId);

            return $this->find($cartId);
        });
    }

    /**
     * Check stock for what is in the cart — live, from Inventory.
     *
     * Advisory, not a gate. A till that refuses to sell what is physically in
     * the customer's hand because a number disagrees is a till the shop stops
     * using. The answer goes on screen; selling past it needs a permission.
     */
    public function stockCheck(int $cartId): array
    {
        $cart = $this->find($cartId);
        if ($cart === []) {
            Http::notFound('That sale does not exist.');
        }

        $lines = array_values(array_filter($cart['lines'], static fn (array $l) => $l['item_id'] !== null));
        if ($lines === []) {
            return ['reachable' => true, 'lines' => []];
        }

        $response = (new InventoryClient())->withSession($this->auth->sesKey())->checkAvailability($this->ctx, array_map(static fn (array $l) => [
            'item_id'      => (int) $l['item_id'],
            'warehouse_id' => $l['warehouse_id'] === null ? null : (int) $l['warehouse_id'],
            'batch_id'     => $l['batch_id'] === null ? null : (int) $l['batch_id'],
            'qty'          => (float) $l['quantity'],
        ], $lines));

        if (!$response['ok']) {
            // Unreachable is not "in stock" and not "out of stock". It is
            // unknown, and the screen says so rather than inventing either.
            return ['reachable' => false, 'lines' => [], 'message' => 'Stock could not be checked right now.'];
        }

        return ['reachable' => true, 'lines' => $response['body']['data'] ?? []];
    }

    public function find(int $cartId): array
    {
        $cart = Db::first(
            'SELECT * FROM pos_carts WHERE cart_id = :id AND cmp_id = :cmp',
            ['id' => $cartId, 'cmp' => $this->ctx->cmpId],
        );
        if ($cart === null) {
            return [];
        }

        $cart['lines'] = array_map(static function (array $line): array {
            $line['line_id']    = (int) $line['line_id'];
            $line['item_id']    = $line['item_id'] === null ? null : (int) $line['item_id'];
            $line['quantity']   = (float) $line['quantity'];
            $line['rate']       = (float) $line['rate'];
            $line['line_amount'] = (float) $line['line_amount'];
            $line['modifiers']  = Db::jsonColumn($line['modifiers'] ?? null);
            $line['serials']    = Db::jsonColumn($line['serials'] ?? null);

            return $line;
        }, Db::all('SELECT * FROM pos_cart_lines WHERE cart_id = :cart ORDER BY line_no', ['cart' => $cartId]));

        $cart['payments'] = array_map(static function (array $p): array {
            $p['amount'] = (float) $p['amount'];

            return $p;
        }, Db::all('SELECT * FROM pos_cart_payments WHERE cart_id = :cart ORDER BY payment_id', ['cart' => $cartId]));

        $cart['cart_id']         = (int) $cart['cart_id'];
        $cart['subtotal_amount'] = (float) $cart['subtotal_amount'];
        $cart['discount_amount'] = (float) $cart['discount_amount'];
        $cart['service_charge_amount'] = (float) $cart['service_charge_amount'];
        $cart['tip_amount']      = (float) $cart['tip_amount'];
        $cart['estimated_tax_amount'] = (float) $cart['estimated_tax_amount'];
        $cart['total_amount']    = (float) $cart['total_amount'];
        $cart['paid_amount']     = array_sum(array_column($cart['payments'], 'amount'));
        $cart['balance_due']     = round($cart['total_amount'] - $cart['paid_amount'], 4);

        return $cart;
    }

    /** @return array{0: list<array<string, mixed>>, 1: int} */
    public function listCarts(array $filters, int $limit, int $offset): array
    {
        [$scope, $params] = $this->ctx->scopeClause();
        $where = [$scope];

        if (!empty($filters['status'])) {
            $where[] = 'status = :status';
            $params['status'] = (string) $filters['status'];
        }
        if (!empty($filters['terminal_id'])) {
            $where[] = 'terminal_id = :terminal';
            $params['terminal'] = (int) $filters['terminal_id'];
        }
        if (!empty($filters['session_id'])) {
            $where[] = 'session_id = :session';
            $params['session'] = (int) $filters['session_id'];
        }
        if (!empty($filters['table_session_id'])) {
            $where[] = 'table_session_id = :ts';
            $params['ts'] = (int) $filters['table_session_id'];
        }
        if (!empty($filters['search'])) {
            $where[] = '(customer_name ILIKE :q OR customer_mobile ILIKE :q OR token_no ILIKE :q OR books_voucher_no ILIKE :q)';
            $params['q'] = '%' . $filters['search'] . '%';
        }

        $clause = implode(' AND ', $where);
        $total = (int) Db::scalar('SELECT COUNT(*) FROM pos_carts WHERE ' . $clause, $params);
        $rows = Db::all(
            'SELECT cart_id, cart_uuid, status, order_kind, token_no, hold_label, customer_name, customer_mobile,
                    total_amount, books_voucher_no, books_voucher_uuid, terminal_id, session_id, table_session_id,
                    offline_created, created_at, updated_at
             FROM pos_carts WHERE ' . $clause . '
             ORDER BY cart_id DESC LIMIT ' . (int) $limit . ' OFFSET ' . (int) $offset,
            $params,
        );

        return [array_map(static function (array $r): array {
            $r['cart_id'] = (int) $r['cart_id'];
            $r['total_amount'] = (float) $r['total_amount'];

            return $r;
        }, $rows), $total];
    }

    /**
     * Recompute the cart totals from its lines.
     *
     * Stored rather than computed on read because a receipt has to reprint to
     * the paisa a year later, and because the till adds tips and service charge
     * that are not derivable from the lines alone. These are totals of OUR
     * document, not a cached copy of anyone else's number.
     */
    public function recalculate(int $cartId): void
    {
        $totals = Db::first(
            'SELECT COALESCE(SUM(line_amount), 0) AS subtotal, COALESCE(SUM(estimated_tax_amount), 0) AS tax
             FROM pos_cart_lines WHERE cart_id = :cart',
            ['cart' => $cartId],
        ) ?? ['subtotal' => 0, 'tax' => 0];

        $cart = Db::first('SELECT * FROM pos_carts WHERE cart_id = :id', ['id' => $cartId]);
        if ($cart === null) {
            return;
        }

        $subtotal = round((float) $totals['subtotal'], 4);
        $tax      = round((float) $totals['tax'], 4);
        $discount = round((float) $cart['discount_amount'], 4);
        $service  = round((float) $cart['service_charge_amount'], 4);
        $tip      = round((float) $cart['tip_amount'], 4);

        Db::update('pos_carts', [
            'subtotal_amount'      => $subtotal,
            'estimated_tax_amount' => $tax,
            'total_amount'         => round($subtotal - $discount + $service + $tax + $tip, 4),
            'updated_at'           => self::now(),
        ], ['cart_id' => $cartId, 'cmp_id' => $this->ctx->cmpId]);
    }

    /** @return array<string, mixed> */
    public function requireOpen(int $cartId): array
    {
        $cart = $this->find($cartId);
        if ($cart === []) {
            Http::notFound('That sale does not exist.');
        }
        if ($cart['status'] === 'COMPLETED') {
            Http::conflict('This sale has already gone through. Start a new one.');
        }
        if ($cart['status'] === 'VOID') {
            Http::conflict('This sale was voided.');
        }

        return $cart;
    }

    /** @return array<string, mixed> */
    public function settings(): array
    {
        $row = Db::first('SELECT * FROM pos_settings WHERE cmp_id = :cmp', ['cmp' => $this->ctx->cmpId]);
        if ($row === null) {
            Db::insert('pos_settings', ['cmp_id' => $this->ctx->cmpId], 'cmp_id');
            $row = Db::first('SELECT * FROM pos_settings WHERE cmp_id = :cmp', ['cmp' => $this->ctx->cmpId]) ?? [];
        }

        return $row;
    }

    private function assertDiscountAllowed(float $discountPc): void
    {
        if ($discountPc <= 0) {
            return;
        }

        Permissions::assert($this->ctx, $this->auth, 'discount.give');

        $limit = (float) ($this->settings()['cashier_discount_limit_pc'] ?? 5);
        if ($discountPc > $limit && !Permissions::allows($this->ctx, $this->auth, 'discount.override')) {
            Http::forbidden(
                'You can give up to ' . rtrim(rtrim(number_format($limit, 2), '0'), '.') . '%. A manager has to approve more than that.',
            );
        }
    }

    /** @return array<string, mixed> */
    private function lookupItem(?int $itemId): array
    {
        if ($itemId === null) {
            return [];
        }

        $response = (new InventoryClient())->withSession($this->auth->sesKey())->item($this->ctx, $itemId);

        return $response['ok'] ? (array) ($response['body']['data'] ?? []) : [];
    }

    /** @param array<string, mixed>|null $menuItem @param array<string, mixed> $live @param array<string, mixed> $input */
    private function defaultRate(?array $menuItem, array $live, array $input): ?float
    {
        if ($menuItem !== null && $menuItem['menu_price'] !== null) {
            return round((float) $menuItem['menu_price'], 4);
        }
        foreach (['sale_rate', 'selling_price', 'mrp', 'rate'] as $field) {
            if (isset($live[$field]) && is_numeric($live[$field])) {
                return round((float) $live[$field], 4);
            }
        }

        return null;
    }

    /** @param array<string, mixed>|null $menuItem @param array<string, mixed> $live */
    private function isOverride(float $rate, ?array $menuItem, array $live): bool
    {
        $catalogue = $this->defaultRate($menuItem, $live, []);

        return $catalogue !== null && abs($rate - $catalogue) > 0.0001;
    }

    /** @param array<string, mixed>|null $menuItem @param array<string, mixed> $live @param array<string, mixed> $input */
    private function taxPercent(?array $menuItem, array $live, array $input): float
    {
        if (isset($input['estimated_tax_pc']) && is_numeric($input['estimated_tax_pc'])) {
            return round((float) $input['estimated_tax_pc'], 3);
        }
        foreach (['tax_rate', 'gst_rate', 'tax_pc'] as $field) {
            if (isset($live[$field]) && is_numeric($live[$field])) {
                return round((float) $live[$field], 3);
            }
        }

        return 0.0;
    }

    /** @param array<string, mixed> $cart */
    private function defaultWarehouse(array $cart): ?int
    {
        if ($cart['terminal_id'] === null) {
            return null;
        }

        $warehouse = Db::scalar(
            'SELECT l.default_warehouse_id FROM pos_terminals t
             JOIN pos_location_profiles l ON l.location_id = t.location_id
             WHERE t.terminal_id = :id AND t.cmp_id = :cmp',
            ['id' => (int) $cart['terminal_id'], 'cmp' => $this->ctx->cmpId],
        );

        return $warehouse === null ? null : (int) $warehouse;
    }

    /** @return list<array<string, mixed>> */
    private function normaliseModifiers(mixed $raw): array
    {
        if (!is_array($raw)) {
            return [];
        }

        $out = [];
        foreach ($raw as $modifier) {
            if (!is_array($modifier)) {
                continue;
            }
            $out[] = [
                'option_id'   => isset($modifier['option_id']) ? (int) $modifier['option_id'] : null,
                'group_name'  => isset($modifier['group_name']) ? (string) $modifier['group_name'] : null,
                'option_name' => (string) ($modifier['option_name'] ?? ''),
                'price_delta' => round((float) ($modifier['price_delta'] ?? 0), 4),
            ];
        }

        return $out;
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
