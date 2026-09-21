# The Shift Report

One shift, and everything a manager has to decide about it. Route `/reports`,
sidebar entry **Shift report**, and the screen a supervisor opens at handover.

It is not a sixth dashboard. The five boards answer questions about a *period*;
this answers questions about a *drawer* — what it sold, how it was paid, what
needed allowing, and whether the money in it agrees with the money that should
be in it. The one irreversible action in POS, closing a till, lives here.

| | |
|---|---|
| Route | `/reports?location_id=&date=&session_id=` |
| Board endpoint | `GET v1/shift-report` |
| Audit trail | `GET v1/shift-report/events` |
| Risk drill-down | `GET v1/shift-report/risk` |
| Reconcile | `POST v1/shifts/{id}/close` (the existing close, with a denomination sheet) |
| Who may open it | `reports.view` **or** `shift.close` **or** `shift.open` |

`reports.view` sees every till in the outlet. Anyone else sees only the shifts
they opened — narrowed in SQL by `ShiftReportBoard::dayScope()`, not by leaving
a control off the screen. A `session_id` belonging to another cashier answers
403 rather than an empty page.

## One request paints the page

Six endpoints answering six questions about the same shift would be six
connections from a tablet on shop broadband and six chances to render half a
shift, so the board is one round trip. Only the two lists that grow without
limit are separate, and only one of them loads eagerly:

- the **audit trail** ships its first twelve rows inside the board response and
  re-asks the server when somebody filters or turns a page;
- the **rows behind a risk tile** are not fetched at all until a tile is opened.

## Which shift

`session_id` wins when it is given, and the outlet and the date follow from it —
a link to one shift has to open that shift, not whatever is on that till today.
With no shift named, the outlet's business date decides and an OPEN shift beats
the most recent closed one, because an open till is the one somebody is standing
at.

A shift belongs to the business date it **opened** on, using the same
`trading_timezone` / `day_start_minutes` boundary the five boards use — the same
code, so a night shift cannot land on different days on two screens.

## The figures

| Figure | How it is counted |
|---|---|
| Bills | `pos_carts` where `status = 'COMPLETED'` on this session |
| Net sales | `SUM(total_amount)` over those bills |
| Gross sales | net sales + discount given. Stated rather than implied — "gross" means four different things |
| Average bill | net sales ÷ bills. Zero bills is `0`, never a division |
| Discount given | `SUM(discount_amount)` |
| Refunds | `SUM(refund_amount)` from `pos_returns` on this session, excluding `CANCELLED` |
| Voids | `pos_carts` where `status = 'VOID'` |

The comparison is **the previous shift on the same till**, not the previous day:
a manager reading a handover wants to know whether this shift was busier than
the one it took over from. Where there is no previous shift, or where it took
nothing, there is no comparison — `up ∞%` is not a fact about a shop.

Each KPI carries which direction is good news, separately from which direction
it moved. Refunds down 42% is a fall and a win; discounts up 8% is a rise and a
cost. A strip that painted every arrow-up green would say a shift with more
voids went well.

## Expected cash

The same formula as Cash, Shifts & Controls, recomputed from this session's own
drawer events:

```
expected = opening float
         + cash taken on sales (net of change given)
         + cash pay-ins
         − cash refunds
         − cash payouts and petty withdrawals
         − safe drops

variance = counted − expected            (negative is short)
```

Card, UPI and on-account tenders never enter the drawer and are not in this sum.
A split bill paid ₹400 card and ₹100 cash contributes ₹100.

Both figures are returned: `expected` (summed from the events) and
`running_expected` (the total the till maintains as it goes). They should agree;
where they do not, the reconcile dialog says so rather than inheriting one of
them silently.

A drawer nobody has counted has `counted: null` and `variance: null` — never
zero. Zero would report every open till as balancing perfectly.

## The variance is coloured by the shop's own tolerance

`pos_settings.cash_variance_tolerance`, editable through `PUT v1/settings`.

| State | When | How it reads |
|---|---|---|
| `balanced` | exactly zero | green |
| `within_tolerance` | inside the tolerance | amber, and still shown |
| `out_of_tolerance` | beyond it | red, and somebody has to act |
| `uncounted` | nothing counted | neutral |

Default `0`, which reports every difference — the safe answer for a shop that
has not decided yet. Nothing in the stylesheet knows about ₹50.

## The denomination sheet

Counting a drawer produces notes and coins, and "counted ₹32,400" throws away
the count that produced it. The sheet is stored as
`pos_cash_drawer_events.detail` on the `closing_count` event — the count itself,
not a table of its own — as `[{denomination, quantity, amount}]`. The same shape
is accepted on `POST v1/shifts` for an opening float that was counted in.

`pos_settings.cash_denominations` is what this shop counts in, largest first. A
shop trading outside India sets its own; nothing assumes INR past the default.

**There is deliberately no expected quantity per denomination.** POS knows what
the drawer should hold; it cannot know which notes it should hold it in, because
nobody records that a ₹500 sale was paid with two ₹200s and a ₹100. Inventing
that column would put a made-up figure on a cash record. The comparison that is
real — counted, expected, variance — sits in the panel beside the table.

## Risk tiles

Six counts, each with what it means and what to do about it. Tone follows the
*state* of the thing rather than its category: four overrides a manager approved
are a record and read amber; one nobody approved is a question and reads red.

| Tile | Counted from |
|---|---|
| Voids | `pos_carts` at `VOID` |
| No-sale drawer opens | `pos_approval_events` at `no_sale` |
| Price/discount overrides | `pos_approval_events` at `discount` or `price_override` |
| Refund requests | `pos_returns` other than `CANCELLED` |
| Manager approvals pending | `pos_approval_events` with `approved_by IS NULL` |
| Suspicious activity | the rules below |

**Suspicious activity is rule-based and says so.** There is no model here and no
learned threshold; each rule is a stated fact about this shift's own rows, and
the screen prints the rule next to the finding so a manager can judge it rather
than trust it.

| Rule | Fires when |
|---|---|
| `variance_out_of_tolerance` | `abs(variance) > cash_variance_tolerance` |
| `no_sale_burst` | no-sale opens ≥ `pos_settings.no_sale_review_threshold` (default 5, `0` turns it off) |
| `unapproved_voids` | a void event with `approved_by IS NULL` |
| `closed_with_pending_approvals` | the shift closed with unsigned approvals on it |

## The audit trail

Three tables record what happened on a shift, and an event appears from exactly
**one** of them — opening the drawer with no sale writes a drawer event, an
approval event *and* an audit row, so a trail that read all three would show it
three times.

| Source | What it supplies |
|---|---|
| `pos_audit_log` | the shift's own open and close |
| `pos_cash_drawer_events` | cash movements, no-sale opens, the closing count |
| `pos_approval_events` | what a manager had to allow (excluding `no_sale` and `drawer`, which the drawer already supplied) |

Three drawer kinds are excluded. `sale_tender` and `change_given` are every
cash sale of the shift, and four hundred of them bury the six movements
somebody is looking for — they are in the tender mix and the cash summary
instead. `opening_float` is the shift opening, which the audit log already
records; the float rides on that row, read out of its own after-state.

## Reconciling

The primary action does **not** close the till. It opens a three-step dialog —
review what should be in the drawer, count it note by note, then confirm — and
only the last step calls `POST v1/shifts/{id}/close`.

The count is entered as denominations and the total is derived from them. Where
a caller sends both `counted_cash` and `denominations` they have to agree to the
paisa, or the request is refused: two figures for the same drawer is how a
disputed count becomes unarguable in the wrong direction.

A variance needs a reason, and one beyond the tolerance needs
`shift.approve_variance`. Both are enforced in `RegisterService::close()`; the
dialog says so first, so nobody counts a drawer twice to find out.

**It cannot be submitted twice.** The button disables while the request is in
flight, and a shift that is already `CLOSED` answers 409 rather than closing
again — which is what this screen relies on instead of an idempotency key of its
own.

## Export and share

POS has no report service and no public-link service, and this screen does not
pretend otherwise.

**Export PDF** prints the page through the browser's own PDF writer, and the
print stylesheet re-lays it out as a report rather than photographing the
screen: the shell and every control drop away, a header block appears with the
company, outlet, till, shift, cashier and generated timestamp, and the hidden
table under each chart becomes visible — a colour chart photocopied in greyscale
is not a report.

**Share** hands over a link to this application. Whoever follows it still signs
in and still needs permission to see it. A shift report is a cash record.

## What POS still cannot do

- **Name anybody but you.** POS stores an actor's uuid and nothing else; the
  name belongs to the portal, and copying it here would be a stale name the day
  somebody marries. The signed-in user is named because the request carries
  their session; everyone else is a shortened uuid. A directory lookup on
  Manage would fix this for the whole product, not just this screen.
- **Confirm a non-cash tender.** There is no payment provider integration. Cash
  is `collected` because the drawer is counted; everything else is `recorded`
  from a terminal slip a cashier read, and the two are never added together
  under one word.
- **Render the report server-side.** A `GET v1/shift-report/pdf` returning a
  laid-out document is the honest version of Export PDF, and is the one piece of
  this screen that genuinely wants backend work.

## The line at the bottom

> Figures are counted from this POS. Accounting figures are maintained in Books
> and may differ.

It is not decoration. Books owns the ledger, its figure for the same day can
legitimately differ — a voucher an accountant cancelled, a sale still in
flight — and a screen that quietly showed a second number under the same word
would be worse than one that says which number it is showing.
