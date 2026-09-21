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

The filter bar offers four quick ranges (Today, Last 7 days, Last 30 days, This
month) and two comparisons. Two, not the seven a designer might list, because
`Window::comparison` builds two — a longer menu would be a menu of windows
nothing behind the screen knows how to compute.

One request backs a whole board. Every panel reads the same response, so no two
panels can disagree, there is no waterfall of spinners, and a refresh is one
round trip. On Business Overview the aggregates each panel shares are memoised
per request (`OverviewBoard::once`), because the briefing rules read the panels
back — peak hour reads the series, the returns rule reads the reason breakdown,
the counter rule reads the till totals — and without it each of those re-ran its
own query.

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

### Returns and voids are two things

They share a panel on Business Overview because a manager asks about them in one
breath. They keep separate counts, separate values and separate `kind`s because
they are not the same event:

| | Return | Void |
|---|---|---|
| What happened | Goods came back, a credit was raised | A bill was cancelled before it was ever taken |
| Money moved | Yes | No |
| Valued at | `pos_returns.refund_amount` | The cart total the bill would have been |
| `amount_is_money` | `true` | `false` |

Totalling the two columns produces a refund figure that reconciles against
nothing, which is why the API sends them as two lists with two subtotals and the
screen never adds them.

### The heatmap reads two clocks

`activity.cells` is keyed by ISO day-of-week and hour. The **hour** is the
wall-clock hour in the outlet's timezone, because "when is the lunch rush" is a
question about the clock on the wall. The **day** is the *business* day, shifted
by `day_start_minutes`, so a bar's 1am Saturday takings sit on Friday's row —
the same day they sit on everywhere else on the board.

Cells arrive hourly and unbinned. The screen bins them into the columns it has
room for; binning in the API would fix the shape of a picture in the contract.

### Returns are scoped like sales

`pos_returns` carries `terminal_id`, so an outlet or till filter narrows refunds
exactly as it narrows sales. Before this, the Returns card answered for the whole
company while every figure beside it answered for one outlet, and the two were
read as one story.

## The briefing strip is rule-based, and says so

The panel on Business Overview is headed **Aicountly AI Insights** because that
is the surface a model will eventually publish to. POS has no model integration,
so today every item on it is a threshold crossing computed in SQL from POS' own
rows — a count, a ratio, a comparison against the window the person chose.

Three things keep that honest and all three are load-bearing:

- the panel carries a **BETA** badge;
- every card inside the drawer is badged **Rule-based alert**, from
  `InsightItem.kind`, not from the panel;
- the drawer closes with the server's own `insights.ai.note` saying no model
  produced any of it.

When a model does publish here its items arrive with `kind: 'ai'` and badge
themselves differently. The badge is on the item and never on the panel, for
exactly that reason.

Rules only fire when the numbers behind them exist. There is no "no data" card
and no rounded-up encouragement: a quiet shop gets a short strip, which is the
honest shape of a quiet shop. Each item carries a `metric` and a `detail` — the
two short lines the strip shows — alongside the `title` and `explanation` the
drawer shows, and both are built from the same figures so the summary can never
disagree with the detail.

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
  and "nobody has points" must not render identically. **Zero is a sixth thing**:
  a shop that took ₹0.00 has data and renders its panels, and a failed request
  never renders ₹0.00 in their place.
- The trend chart's highlight is reachable from the keyboard — the chart takes
  focus and the arrow keys walk the bars, announcing each through a live region.
  A tooltip only a mouse can open is a tooltip half the shop cannot use.
- Sparklines are the one chart without a table under them. The KPI card states
  its figure and its movement in words directly above the line, so the line
  carries an `aria-label` summarising the shape instead of a second table of
  twelve values under every card.
- Movement and meaning are separate on a KPI card. The arrow follows the
  movement, the colour follows whether that movement is good news. On Returns
  they disagree: refunds rising is an increase and a problem.
- A drawer traps nothing it should not — Escape closes it, focus moves in on
  open and returns to whatever opened it on close.
- One panel throwing does not take the board down. Each is wrapped in a
  `PanelBoundary`, so seven good panels stay on screen and the eighth says what
  is missing.

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
