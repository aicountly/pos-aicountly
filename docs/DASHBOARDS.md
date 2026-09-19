# The home screen and the five POS dashboards

## The home screen

`/` is not a sixth board. It is the operational home: whether this counter can
sell, what is in the way, and what the shop took today — in that order.

It adds **no endpoint**. It asks `v1/dashboards/overview` (when the person has
`reports.view`) and `v1/dashboards/retail` (`reports.view` or `sell`), joins
them to `v1/session`, this till's `v1/shifts/current`, unsettled rows from
`v1/returns` and this device's own outbox, and composes the result in
`web/src/home/model.ts`. A second definition of "today's takings" would be one
more thing to keep in step with this one.

Permissions are respected by not asking. A person without `reports.view` is not
shown a zero where the shop's takings would be; the board is not requested and
the card says the figure is not theirs. A cashier with `sell` gets the retail
board's figures, which the server has already narrowed to their own counters,
and the card says so.

What it will not claim, for the same reasons the boards will not:

* **System Health is not a device monitor.** The connection and the outbox are
  live because the browser owns them. The printer, the drawer and the kitchen
  rows report what the till is *configured* with and say so; the payments row
  reads "Recorded only", never "Operational", because POS integrates no
  provider. Where a check could not be read at all the summary says "Some
  checks unavailable" rather than "All systems operational".
* **The Aicountly AI card is rule-based.** Every item is a threshold crossing
  over POS' own rows and carries a "Rule-based" tag, and the card's foot says no
  model is connected. There is no predicted footfall, no suggested staffing and
  no trending product, because nothing in this product observes or forecasts
  those. Server-side items arrive through the same list when they exist.

## The five dashboards

Five boards, one shell. Each is a real question a shop asks, and each is built
from a separate endpoint that enforces its own permission and scopes its own
rows.

| Board | Route | Endpoint | Who may open it |
|---|---|---|---|
| Business Overview | `/overview` | `GET v1/dashboards/overview` | `reports.view` |
| Retail Operations | `/retail` | `GET v1/dashboards/retail` | `reports.view` **or** `sell` |
| Restaurant Operations | `/restaurant` | `GET v1/dashboards/restaurant` | `reports.view` **or** `table.open` **or** `kds.operate` |
| Customers & Growth | `/customers` | `GET v1/dashboards/customers` | `reports.view` |
| Cash, Shifts & Controls | `/controls` | `GET v1/dashboards/controls` | `reports.view` **or** `shift.close` **or** `shift.open` |

Two drill-downs sit behind them, both paged server-side:

| | |
|---|---|
| `GET v1/cash-movements` | `reports.view`, `drawer.cash_io` or `shift.close` |
| `GET v1/audit-log` | `reports.view` |

## What decides whether a board is visible

Two questions, and both have to pass.

**What may this person do?** Permissions come from the server. A cashier has no
`reports.view`, so Business Overview and Customers are not theirs. They do have
`sell` and `shift.close`, so Retail and Controls open — and `Window::seesEveryone`
is false for them, which narrows the SQL to their own tills and their own shifts.
That narrowing happens in the query, not by leaving a panel out.

**What kind of shop is this?** `pos_location_profiles.pos_mode` is `retail`,
`restaurant`, `quick_service` or `hybrid`. A retail-only outlet does not get a
Restaurant tab that is empty; it does not get one at all. With no outlet
selected, a board appears if *any* outlet in the company is of a kind it applies
to.

Hiding a tab is presentation. A URL typed by someone who may not open that board
answers 403.

## Filters

All five share one bar, and every filter lives in the URL so a link carries what
the sender was looking at.

| Parameter | Meaning |
|---|---|
| `from`, `to` | Business dates, inclusive. Default: today. Range capped at 400 days. |
| `location_id` | One outlet. An id from another company is a 404, never an empty board. |
| `terminal_id` | One till. Rejected when it is not in the chosen outlet. |
| `session_id` | One shift. |
| `compare` | `previous`, `same_weekday`, or absent for no comparison. |

## The business date is not UTC midnight

`pos_location_profiles.trading_timezone` and `.day_start_minutes` say when this
outlet's counter day begins. A bar with `day_start_minutes = 360` takes money at
1am on Saturday that belongs to Friday's trading, and every figure on every board
is wrong by one night's takings until that is respected.

Every window is therefore a half-open interval of *instants* computed from the
outlet's own day boundary, and the SQL compares `created_at >= :from AND
created_at < :to`. Never `::date`, which silently means the server's date.

With no outlet chosen the company's outlets may disagree, so the fallback is UTC
midnight and the screen says which timezone it used.

Set them like this:

```sql
UPDATE pos_location_profiles
   SET trading_timezone = 'Asia/Kolkata',
       day_start_minutes = 360           -- a day that starts at 6am
 WHERE location_id = :id AND cmp_id = :cmp;
```

`daily_target` on the same table drives the "% of target" column. It is NULL by
default, and while it is NULL no target column is drawn — a progress bar against
an invented target is worse than no progress bar.

## What the numbers mean

**Net sales** is `SUM(pos_carts.total_amount)` over `COMPLETED` carts in the
window. Tax-inclusive. Discounts already deducted. Voids excluded entirely.
Returns are **not** netted off — they are their own figure, because a refund
against last week's sale would otherwise silently reduce today's takings and
nobody could reconcile the drawer against it.

These are POS' counted takings. Books owns the accounting figure and the two can
legitimately differ; every board says so rather than implying one number under
two meanings.

Every SUM runs in PostgreSQL over `NUMERIC(18,4)` columns, so the arithmetic is
decimal. PHP sees a total only to put it in JSON, and the browser only to format
it.

### Expected cash

```
expected cash = opening float
              + cash taken on sales (NET of change given)
              + authorised cash pay-ins
              − cash refunds paid out of the drawer
              − cash payouts and petty withdrawals
              − safe drops

variance      = counted cash − expected cash        (negative = short)
```

Non-cash tenders are not in the drawer and are not in this sum. A split bill paid
₹400 card and ₹100 cash contributes ₹100 — which is why the sum runs over
`pos_cash_drawer_events`, every row of which is a cash movement, rather than over
`pos_cart_payments` where the card row would have to be remembered and excluded
each time.

Worked example, and the fixture the test suite asserts:

| | |
|---|---|
| Opening float | ₹2,000 |
| Cash sales | ₹16,500 |
| Cash refunds | −₹700 |
| Cash payouts | −₹500 |
| Cash drops | −₹8,000 |
| **Expected** | **₹9,300** |
| Counted | ₹9,200 |
| **Variance** | **−₹100** — a shortage |

The board recomputes this from the drawer events and shows it beside the till's
own running `pos_register_sessions.expected_cash`. If they ever disagree the
screen says so, because that is a bug worth seeing rather than a discrepancy
silently inheriting one of the two.

A drawer nobody has counted has `counted_cash: null` and `variance: null`. The
screen renders "Not counted yet", never a zero.

## What these boards deliberately will not say

Each of these is a place where the obvious thing to draw would be a lie.

**No provider-confirmed tender total.** POS integrates no payment provider.
Aicountly Pay does not exist and nothing here depends on it. A card or UPI row
means a cashier looked at a separate terminal, saw an approval and typed the
reference: a *recorded* tender, not a confirmed collection. Cash is `collected`
because the drawer is counted; everything else is `recorded`, and the
reconciliation table's "Provider confirmed" column reads "Not available" rather
than repeating the recorded figure under a second heading.

*What would close this gap:* a provider API offering a settlement batch listing
by business date, a per-transaction status lookup keyed on a reference POS can
store, and a refund status. None exists to integrate with.

**No device connection status.** A browser cannot ask whether a receipt printer
has paper or a scanner is plugged in. The Devices panel reports what each till is
*configured* with and is labelled `not_verified`. `pos_device_registrations.last_seen_at`
is not surfaced as a liveness signal, because nothing in the product writes it.

**No queue lengths or waiting-customer counts.** Nothing observes a queue — no
camera, no ticket dispenser, no door counter. Checkout duration *is* shown,
because it is measured from POS' own two timestamps, and the basis is printed
next to it. Bills recorded in under a second are excluded: `created_at` is
written by PostgreSQL at microsecond precision and `updated_at` by PHP at second
precision, so their difference is meaningless below a second.

**No loyalty.** There is no points table, no tier and no liability in this
product, and none is read from another. The panel says so and does not show a
zero — a zero reads as "no customer has any points", which is a different and
much worse claim.

*What would close this gap:* an accrual rule, a redemption call that is
idempotent under concurrent use, and a reversal path a return triggers.

**No offer performance.** Nothing records that a bill resulted from an offer, so
attribution cannot be computed.

**No AI suggestions.** POS has no model integration configured. Every item on
every brief is a threshold crossing computed from POS' own rows, and each is
badged **Rule-based alert**. There are no confidence percentages anywhere,
because nothing here produces one. When a POS-owned model integration lands
through Console's central key arrangement, it adds items badged **AI suggestion**
alongside these — it does not relabel them.

**No marketplace channels.** Order channels lists only what this outlet has
actually taken an order through, and says how many external connectors are
configured (usually none).

## The three states of a sale

A sale that has left the counter is not "done" or "not done". It has a payment
outcome, a Books outcome and an Inventory outcome, and the Retail board's Recent
bills table shows all three as separate columns.

| State | Means | Recovery |
|---|---|---|
| `posted` | The other product's reference is stored. | — |
| `in_flight` | Sent, no answer yet. The outcome is **unknown**. | Wait. Never retry blind. |
| `failed` | Transport failure. | Retry on the same idempotency key. |
| `blocked` | Refused for a business reason. | Fix the cause. Retrying cannot work. |
| `not_attempted` | Nothing was sent. | — |

The Controls board offers **Retry** on `failed` only. `blocked` gets an
explanation instead, because a button that cannot work teaches people to press it
twice, and `in_flight` gets neither, because pressing anything is the one thing
that could turn an unknown into a double posting.

## Accessibility

- Every chart renders the same numbers as a real `<table>`, present in the
  accessibility tree always and on screen where it helps.
- No meaning is carried by colour alone. Every badge contains words; the floor
  plan names all four table states in its legend.
- Primary touch targets are at least 44px.
- One visible focus ring, on the action green, application-wide.
- Loading, error, empty, **unavailable** and permission states are distinct.
  "Unavailable" is styled unlike "empty" on purpose: "there is no loyalty scheme"
  and "nobody has points" must not render identically.

## Stale data across a company switch

Switching company while a request is in flight has one acceptable outcome: the
old company's figures never reach the screen. Two mechanisms, both needed, in
`web/src/dashboards/useDashboard.ts`:

1. The in-flight request is aborted **and** its response discarded by a
   generation counter — an abort is not instantaneous and a response can already
   be in the microtask queue.
2. The loaded board is cleared during render, the moment the scope changes, so
   there is no frame showing one company's takings under another's name.

A hook that only does the first still leaves the last render on screen.
