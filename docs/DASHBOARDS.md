# The five POS dashboards

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

## Retail Operations, panel by panel

One request — `GET v1/dashboards/retail` — returns the whole board, so every
panel on screen is the same snapshot rather than nine widgets racing each
other. It refreshes every 45 seconds while the tab is visible, stops entirely
when it is hidden, and catches up once on return; Refresh invalidates it by
hand.

| Block | Panel | Built from |
|---|---|---|
| `kpis` | the five metric cards | `pos_carts`, `pos_terminals`, `pos_register_sessions` |
| `comparison` | the trend badges on those cards | the same aggregates over the comparison window |
| `trend` | Hourly sales trend | completed carts bucketed by hour (one day) or day (a range), in the outlet's timezone |
| `counters` | Live counter status | one row per active till, with its shift, its open carts and its rate |
| `checkout_health` | Queue & checkout health | see the queue gap below |
| `categories` | Top selling categories | POS menu categories, then Inventory's item groups for the rest |
| `alerts` | Operational alerts | posting, offline, drawer variances, aging holds, void rate, quiet tills, Inventory's answer |
| `readiness` | Shift readiness | shifts open, opening floats, printers configured, devices registered, drawers awaiting sign-off |
| `pulse` | Operations pulse | the two worst alerts, the sales swing, the usual busiest hour |

**Trend badges are coloured by intent, not by direction.** A rise in completed
bills is good and a rise in median checkout is not, so `MetricTrend` carries
`intent` separately from `direction`. Bills on hold and active counters carry
no badge at all: both are right-now figures that ignore the date filter, and
there is no previous value to compare them against. "Needs attention" compares
`exceptions_windowed` with the same measure over the comparison window, because
the headline count also carries sales stuck on every date.

**Counter state** is one of `busy` (a cart is open on it), `open`, `idle` (a
shift is open and nothing has been rung up for 45 minutes — only ever said
about a window that includes now), `closing`, or `closed`. There is no
`offline` state: a till that is not talking to us cannot tell us so, and is
indistinguishable from one that is quiet.

**Cashier names.** POS stores the sign-on identifier, not a directory. The
signed-in person sees their own name; everyone else is shown by the shortened
identifier their shift was opened with, with the whole of it in the tooltip.

**Category grouping is not POS'.** POS owns the menu's categories and nothing
else — a scanned item's group belongs to Inventory. The board reads the menu
category where the line has one, asks Inventory live (one bulk call, never one
per line) for the rest, and reports `coverage_pc` for how much of the period it
could place. When it can place none it returns `available: false,
reason: no_grouping` and says which product owns the answer.

**Shift readiness has no paper check.** Nothing here knows how much paper is in
a till. The row says whether a printer was *configured*, which is the fact POS
has. Each check reports `ready` of `of`, checks that apply to nothing are
dropped, and the ring is the share of the rest that pass — so the percentage
cannot be inflated by a check the shop does not use.

**Export** writes CSV of what the board already fetched, gated on
`reports.view`. There is no PDF or spreadsheet writer in this product and
adding one to put four tables in a file would be a large dependency for a small
job; the menu offers what actually works rather than three items where two
produce a CSV under the wrong extension.

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

The Retail board's **Queue & checkout health** panel is built around that gap
rather than papering over it. `checkout_health.wait` is always
`available: false, reason: not_observed`, and the three figures beside it are
ones the counter really produces:

| Shown | Is |
|---|---|
| Slowest 1 in 10 | P90 of cart-open to cart-complete, same exclusions as the median |
| Paid for | completed ÷ (completed + voided) over carts opened in the window |
| Walked away | voided-before-payment ÷ carts opened — the only abandonment POS can see |

The counter table's **On counter** column is carts `OPEN` or `HELD` on that
till right now. It is not headed "Queue" and the panel's footnote says why.

*What would close this gap:* a device that counts people — a ticket dispenser, a
door sensor, a camera — with a per-outlet feed POS could read live.

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

That applies to the Retail board's strip too. It is headed **Operations pulse**
with a **Rule-based** badge, never "AI Pulse", and both the heading and the
badge flip the day `pulse.ai.available` turns true. The strip's contents are
the two worst open alerts, the swing against the comparison window, and the
hour this outlet is usually busiest — the last from a 28-day aggregate of its
own completed bills, offered only while the chosen window is still running and
only with at least 20 bills over 5 trading days behind it. It is labelled a
pattern in the rows, not a forecast.

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
