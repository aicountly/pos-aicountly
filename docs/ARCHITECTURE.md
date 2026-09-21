# Aicountly POS — architecture

## The one rule

**POS reads other products live, on the request that needs the answer. It never
keeps a copy.**

There is no mirror table, no shadow master, no nightly job, no reconciliation
cron, no dual-write, and no direct SQL into another product's database. When
this product needs an item, a price, a stock figure or a customer, it asks the
product that owns it, on that request, and uses the answer without writing it
down.

This is enforced, not just intended. `server-php/tests/integration.php` ends
with a release-blocking section that reads `information_schema` and fails the
build if a mirror table, a cached remote master or a stored balance appears.

## Who owns what

| Thing | Owner | What POS holds |
|---|---|---|
| Company, branch, financial year | **Manage** | `cmp_id`, `bo_id`, `fy_id` |
| Item, stock, batch, recipe, cost | **Inventory** | `item_id`, `warehouse_id`, `batch_id`, `unit_id` |
| Invoice, credit note, tax, receivable | **Books** | `books_voucher_id` / `_uuid` / `_no` |
| Stock movement for a sale | **Inventory** | `inventory_document_uuid` |
| Customer account | **Books** (Contacts later) | `customer_account_id` |
| Till, shift, drawer, cart, ticket, table, menu, counter return | **POS** | all of it |

POS owns the *counter*. It does not own the catalogue, the stock or the books.

## What POS does own, and why each is not a copy

Three things look like duplication and are not:

**`pos_cart_lines.rate` and `.display_name`.** The price the shop actually
charged this customer, and the name printed on their receipt. These are facts
about the sale, not a cached master — nothing refreshes them, and a receipt
reprinted a year later must still read correctly after the item was renamed or
repriced. The distinction is whether anything ever *updates* the value. Nothing
does.

**`pos_menu_items.menu_price`.** A decision this outlet made. One Inventory item
with one sale rate is 180 in the dining room and 140 on the terrace; that is
POS' own pricing, not a copy of Inventory's.

**`pos_menu_items.availability`.** The kitchen saying the biryani is finished.
Often true while Inventory still shows units, because a portion is not a unit
and because ingredients spoil. Set by a person, cleared by a person, and never
touched by a stock figure changing.

**`pos_register_sessions.expected_cash`.** What *this shift's own events* say
should be in the drawer. Not the company's cash balance — that is Books', and a
cash sale posts there like any other. When the drawer is short by 200, Books is
not wrong; the cash is genuinely missing, and this column is how you find out
which shift lost it.

## Integration commands, instead of a reconciliation job

Every outbound call is a row in `pos_integration_commands`:

```
PENDING ──▶ POSTING ──▶ COMPLETED          reference stored, done
               │
               ├──────▶ FAILED             transport failure; retryable, same key
               └──────▶ BLOCKED            business refusal; retrying will not help
```

A row holds a **command** ("post this sale to Books"), the idempotency key, and
the reference the other product handed back. It never holds a copy of the other
product's document, so there is no second copy to reconcile.

**The key is minted and stored BEFORE the call.** That ordering is the whole
defence against a double-billed customer: if the network dies after Books wrote
the voucher but before the response arrives, the retry presents the same key and
Books replays its original answer instead of writing a second invoice.

**FAILED and BLOCKED are kept apart** because retrying a locked period is
pointless, and a UI that offers Retry there teaches people to press it twice.

**There is no cron.** A retry happens when someone presses Retry, or when the
next request touching that document drains it. A scheduled sweeper would be
indistinguishable from the synchronisation this architecture exists to avoid,
and it would hide failures from the person who could fix them. Stuck commands
are shown on the document they belong to, and counted on the manager's screen.

## Checkout: one sale, one invoice, two movements

```
  POS                      Books                    Inventory
   │                         │                          │
   ├─ 1. post invoice ──────▶│  writes the tax invoice   │
   │◀── voucher uuid ────────┤  and the receipt          │
   │                         │                          │
   ├─ 2. post stock issue ───┼─────────────────────────▶│  relieves stock
   │◀── document uuid ───────┼──────────────────────────┤
```

**Books first, deliberately.** If stock went out first and Books then refused,
the shop would have goods out of the door and no invoice — the worst of the four
half-states and the hardest to find later. Posting the invoice first means the
failure mode is *an invoice with stock not yet relieved*: visible on the sale,
retryable on the same key, and correct in the accounts meanwhile.

**Step 2 is not fatal.** By the time it runs the customer has paid and left.
Refusing the whole checkout because Inventory was slow would leave a paid
invoice the till pretends did not happen.

`postInvoice()` and `postStockIssue()` **return** their outcome rather than
sending a response, because two callers need different behaviour from the same
failure: an interactive checkout wants a 502 the cashier can act on, while an
offline batch must record the failure against the submission and carry on with
the next sale.

## Offline

**The cache is on the device.** A till that loses its connection keeps selling
from an IndexedDB cache in the browser (`web/src/offline/db.ts`). That cache is
non-authoritative, disposable and per-device. It is never merged with another
till's, never uploaded as a catalogue, and never read by the server. The only
thing that travels up is a sale.

**One sale per device uuid, enforced by the database:**

```sql
UNIQUE (cmp_id, client_uuid)   -- on pos_offline_submissions
```

The device mints `client_uuid` before the sale is attempted. The same sale
arriving three times — because the response was lost, because the browser
retried, because the till was rebooted mid-upload — is recognised twice. A
device may resend its entire queue as often as it likes.

**A device drops a sale from its own queue only on POSTED.** Not on CONFLICT,
not on a failed send. `accepted` in the batch response counts POSTED and nothing
else; a sale sitting in CONFLICT is not accepted however politely it was
received.

**CONFLICT and RECEIVED are different.** CONFLICT means something must change
before it will ever post (a closed period, a customer that no longer exists) and
a person has to look at it. RECEIVED means try again.

**Abandoning is explicit and permissioned.** A sale the shop took and the books
never saw is a real hole; someone owns the decision to leave it, and the row
stays with who abandoned it and why.

## Aicountly Pay does not exist yet

Nothing here pretends to be a payment gateway. `payment_mode` records what the
cashier did — cash in the drawer, a card run on an external terminal, a UPI
transfer — and `reference` holds what they typed from the slip. A value with 12
or more digits is **refused outright**, not truncated, because a system that
quietly truncates teaches cashiers that typing card numbers is fine. No PAN ever
reaches this database.

## Cross-service call rules

POS obeys the fleet invariant in
`Inventory-aicountly/docs/CROSS_SERVICE_CALL_RULES.md`: a synchronous request
from A to B must not have B synchronously re-enter A on the same request path.
`X-Saas-Origin` carries the origin and `CrossServiceCallContext` refuses the
re-entry. This is not about recursion — it is about PHP-FPM pools starving each
other, which took the fleet down once already.

Two timeout budgets, both with connect bounds: optional reads 2s/6s, required
writes 3s/20s.

## The five dashboards

Five boards over POS' own rows, each with its own endpoint, its own permission
check and its own SQL scope. See [DASHBOARDS.md](DASHBOARDS.md) for the full
contract; the two things worth knowing here are what they refuse to claim, and
what decides who sees them.

**They refuse to claim four things**, because the obvious thing to draw would be
a lie: a provider-confirmed tender total (there is no payment provider), a device
connection status (a browser cannot ask a printer anything), a loyalty balance
(there is no loyalty module) and an AI suggestion (there is no model
integration). Each is rendered as an explicit *unavailable* state that looks
different from an empty one — "there is no loyalty scheme" and "no customer has
any points" must not render identically.

**Visibility is two questions.** Permissions decide what a person may do;
`pos_location_profiles.pos_mode` decides what kind of shop this is, so a
retail-only outlet has no Restaurant tab rather than an empty one. Hiding a tab
is presentation — every endpoint asserts its own permission, and a cashier
without `reports.view` who opens Retail or Controls gets their own tills and
their own shifts, narrowed in SQL rather than by a panel the UI left out.

**The business date is the outlet's, not the server's.** Migration 004 adds
`trading_timezone` and `day_start_minutes` to the outlet. A bar that closes at
2am takes money on Friday night that lands on Saturday in UTC, and every sales
figure is wrong by one night's takings until the day boundary is the shop's own.
These are POS' operating configuration for its own counter day — the same kind of
thing as `service_charge_pc` beside them — not a copy of any Manage master.

## Permissions

Six shipped roles — cashier, waiter, captain, kitchen, manager, pos_admin —
defined in `server-php/src/Permissions.php`. **Enforced in the backend.** A
cashier who can see the void button is a cashier the UI told about voids; a
cashier who can *void* is one the API let.

The permissions that matter on a till are the ones around money leaving it:
`drawer.no_sale`, `discount.override`, `price.override`, `cart.void`,
`kot.cancel`, `shift.approve_variance`, `refund.give`, `offline.resolve`. Every
one of them writes a row to `pos_approval_events` — the fraud trail, shown on
the manager's screen.

## The audit log

`pos_audit_log` is append-only, enforced by PostgreSQL triggers rather than by
convention. The triggers are row-level, so `TRUNCATE` still works and the test
suite can reset itself; `UPDATE` and `DELETE` raise. There is a test that proves
it by actually attempting both.

## Layout

```
server-php/
  index.php                front controller: health, portal relay, the API
  src/
    Routes.php             every route, in one place
    Auth.php               portal session key or service key
    Context.php            cmp/fy/bo, and the tenant check that fails CLOSED
    Db.php                 PDO, real prepared statements, nestable transactions
    Http.php               envelopes; throws under CLI so tests can assert
    IntegrationCommand.php the outbound lifecycle
    Permissions.php        the catalogue and the six roles
    CrossServiceCallContext.php
    Clients/               BooksClient, InventoryClient, ManageClient, ContactsClient
    Domain/                NumberSeries, RegisterService, CartService,
                           CheckoutService, KotService, TableService,
                           MenuService, ReturnService
    Domain/Dashboards/     Window (filters, business date, tenant scope),
                           Tenders (what a tender proves), and one board per
                           dashboard: Overview, Retail, Restaurant, Customers,
                           Controls
    Controllers/           Till, Restaurant, Returns, Catalog, Admin,
                           Settings, Dashboard
  database/migrations/     001 terminals · 002 restaurant · 003 integration
                           · 004 dashboards (trading day, targets, read indexes)
  tests/
    integration.php        100 tests, incl. the release-blocking ownership suite
    run.sh                 real PostgreSQL + a stub for Books and Inventory
    stub/router.php        the stub

web/src/
  offline/db.ts            the device cache and the outbox — read its header
  offline/sync.ts          draining the outbox
  services/api.ts          typed fetch; one 401 retry with a fresh key
  context/PosContext.tsx   company scope, permissions, which till this is
  services/returns.ts      every call the Returns workspace makes
  dashboards/              the .pos-* design system, shared shell and charts
  kitchen/                 the kitchen display: service.ts (the only door to
                           the API), derive.ts (pure ageing, SLA, grouping),
                           the hooks, and components/
  returns/                 the Returns & Exchanges workspace: hero, KPIs,
                           analytics, register, filters, detail drawer and the
                           new-return flow
  pages/                   Till, Floor, Kitchen, Returns, OfflineQueue,
                           Reports, Setup
```

## The kitchen display

`GET v1/kds` answers a whole kitchen screen in one round trip: the live queue,
the tickets just served, what each station is carrying, and today's prep
performance. They are four questions with one scope, and asking them separately
would let the board and the figures beside it disagree.

Three rules hold on that screen and are worth stating, because each one is a
bug somebody eventually writes:

**A ticket's clock stops at `ready_at`.** Prep time is fired → ready, which is
what the kitchen controls. Leaving it running until it is served marks the
kitchen down for a waiter who was slow to the pass.

**Late is the STATION's threshold, never a global one.** A bar ticket is late
after four minutes and a tandoor ticket is not, so `pos_kds_stations.
late_after_minutes` decides — per ticket, in the SQL and in the browser alike.

**Today is the OUTLET's trading day.** The same `trading_timezone` and
`day_start_minutes` the dashboards use, so a kitchen still open at 1am does not
watch its on-time figure reset mid-service. With no outlet chosen the outlets
may disagree, and the honest fallback is UTC midnight.

The browser derives nothing it cannot honestly derive. The three counts across
the top are totals of the tickets in view and always agree with the columns
underneath; average prep time and on-time percentage are counted by PostgreSQL
over the whole session and read as **unavailable** where the server has not
answered, because an average computed from the two hundred tickets a screen
happens to be holding is not the kitchen's average.

Refreshing is polling, because polling is what this app has — no second
realtime stack was added beside it. A hidden tab does not poll at all, and the
ticket clocks tick locally in between, so the ageing stays live without a
request behind it.

## Charts, without a chart library

The dashboards draw their own SVG. Every candidate library is 50-150 kB on a till
that is often a cheap tablet on shop broadband, and six chart shapes cover the
five boards and the returns register — each about twenty lines of path
arithmetic. The trade favours the arithmetic.

The accessibility consequence is handled rather than ignored: an SVG is invisible
to a screen reader and unreadable to someone who cannot separate the series
colours, so **every chart renders the same numbers as a real `<table>`**,
present in the accessibility tree always and visible where it helps. The picture
is the summary; the table is the data.

## Running the tests

```bash
server-php/tests/run.sh
```

Needs PHP with `pdo_pgsql` and a reachable PostgreSQL. It creates the schema,
starts the stub on 8794, and runs everything. The last section is
release-blocking: if it goes red, someone has added synchronisation.

## Things deliberately absent

Tested for, in `integration.php`:

- no `pos_items`, `pos_stock`, `pos_accounts`, `pos_customers` — or any other
  table named after another product's data
- no `pos_sync_state`, `pos_sync_log`, `pos_replication_log`,
  `pos_reconciliation`, `pos_outbox`, `pos_inbox`
- no column storing a stock level anywhere
- no customer balance, credit limit or outstanding amount
- no cost or valuation rate on a cart line
- no column on `pos_integration_commands` that holds another product's document
