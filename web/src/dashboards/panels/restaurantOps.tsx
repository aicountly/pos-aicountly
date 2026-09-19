/**
 * The Restaurant Operations command centre.
 *
 * These are the panels a manager standing on the floor reads in the first ten
 * seconds: how full the room is, where every ticket has got to, what is on the
 * board right now, and the one thing worth walking over to. The detailed
 * screens — the floor plan, the kitchen board, the menu — stay in
 * ./restaurant.tsx and stay the place work is actually done.
 *
 * Nothing here holds its own copy of anything. Every figure comes from one
 * board response, and the derived ones come from restaurantInsight.ts so two
 * panels cannot disagree about the same number.
 */

import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import {
  ArrowRight,
  Bike,
  CalendarDays,
  ChefHat,
  ChevronDown,
  ClipboardList,
  Coffee,
  ConciergeBell,
  LayoutGrid,
  Plus,
  Power,
  Receipt,
  ScanLine,
  ShoppingBag,
  Sparkles,
  UtensilsCrossed,
  X,
} from 'lucide-react'
import { usePos } from '../../context/PosContext'
import { DonutChart } from '../charts'
import { clock, count, duration, money, titleCase } from '../format'
import { Panel, PanelSkeleton, StatusBadge, Unavailable, type BadgeTone } from '../shell'
import {
  TABLE_STATE_COLOUR,
  TABLE_STATE_LABEL,
  TABLE_STATE_ORDER,
  type RestaurantOperationalMetrics,
  type RestaurantSignal,
} from '../restaurantInsight'
import type { RestaurantBoard, RestaurantOrderState, RestaurantOrderSummary } from '../types'

// ---------------------------------------------------------------------------
// Service state
// ---------------------------------------------------------------------------

/**
 * Whether the restaurant is serving.
 *
 * READ-ONLY ON PURPOSE. POS has no open/closed switch: a shift being open on a
 * till here IS the restaurant being open. Drawing a dropdown of states the
 * backend cannot be put into would be a control that silently does nothing, so
 * this is a disclosure that explains what the state means and points at the
 * screen that actually changes it.
 */
export function RestaurantServiceState({ service }: { service: RestaurantBoard['service'] }) {
  const [open, setOpen] = useState(false)
  const wrap = useRef<HTMLDetailsElement | null>(null)

  useEffect(() => {
    if (!open) return

    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }
    const onClick = (event: MouseEvent) => {
      if (wrap.current && event.target instanceof Node && !wrap.current.contains(event.target)) setOpen(false)
    }

    document.addEventListener('keydown', onKey)
    document.addEventListener('mousedown', onClick)

    return () => {
      document.removeEventListener('keydown', onKey)
      document.removeEventListener('mousedown', onClick)
    }
  }, [open])

  const serving = service.state === 'open'

  return (
    <details
      ref={wrap}
      className={`pos-service pos-service--${service.state}`}
      open={open}
      onToggle={(event) => setOpen((event.currentTarget as HTMLDetailsElement).open)}
    >
      <summary className="pos-service__summary">
        <span className="pos-service__dot" aria-hidden />
        <span className="pos-service__text">
          <strong>{service.label}</strong>
          <small>
            {serving && service.since ? `Since ${clock(service.since)}` : serving ? 'Serving' : 'No till open'}
          </small>
        </span>
        <ChevronDown size={15} className="pos-service__chevron" aria-hidden />
      </summary>

      <div className="pos-service__panel">
        <p className="pos-muted">{service.note}</p>
        <p className="pos-muted">
          {count(service.open_shifts)} shift{service.open_shifts === 1 ? '' : 's'} open on the tills in scope.
        </p>
        <div className="pos-actions">
          <Link className="pos-button pos-button--small pos-button--secondary" to="/">
            Open the till
          </Link>
          <Link className="pos-button pos-button--small pos-button--secondary" to="/reports">
            Shift report
          </Link>
        </div>
      </div>
    </details>
  )
}

// ---------------------------------------------------------------------------
// Order flow
// ---------------------------------------------------------------------------

const STAGE_ICON: Record<RestaurantBoard['flow']['stages'][number]['key'], ReactNode> = {
  received: <Receipt size={18} aria-hidden />,
  in_kitchen: <ChefHat size={18} aria-hidden />,
  ready: <ConciergeBell size={18} aria-hidden />,
  served: <UtensilsCrossed size={18} aria-hidden />,
}

/**
 * Where every ticket is, as four counts.
 *
 * Three of the four are LIVE and the fourth is not, and the row says which —
 * "Served 6" beside three live counts reads as six plates under the pass unless
 * it is labelled, and that is the sort of mistake that gets a table forgotten.
 */
export function OrderFlowPanel({ board }: { board: RestaurantBoard }) {
  const empty = board.flow.stages.every((stage) => stage.count === 0)

  return (
    <Panel
      title="Order flow"
      description={<LiveTag />}
      action={
        <Link className="pos-button pos-button--quiet pos-button--small" to="/kitchen">
          All tickets <ArrowRight size={13} aria-hidden />
        </Link>
      }
    >
      {empty ? (
        <Unavailable muted title="Nothing is out">
          No ticket is queued, cooking or waiting, and none has gone out in this period.
        </Unavailable>
      ) : (
        <ol className="pos-flow">
          {board.flow.stages.map((stage, index) => (
            <li key={stage.key} className="pos-flow__stage">
              {index > 0 && <span className="pos-flow__link" aria-hidden />}
              <span className={`pos-flow__icon pos-flow__icon--${stage.key}`} aria-hidden>
                {STAGE_ICON[stage.key]}
              </span>
              <strong className="pos-flow__count">{count(stage.count)}</strong>
              <span className="pos-flow__label">{stage.label}</span>
              <span className="pos-flow__basis">{stage.basis === 'live' ? 'now' : 'this period'}</span>
            </li>
          ))}
        </ol>
      )}

      {board.flow.overdue > 0 && (
        <p className="pos-note">
          <StatusBadge tone="danger">
            {count(board.flow.overdue)} past the station&rsquo;s time
          </StatusBadge>{' '}
          counted inside the queued and cooking figures above.
        </p>
      )}

      <p className="pos-note">{board.flow.note}</p>
    </Panel>
  )
}

// ---------------------------------------------------------------------------
// Table status
// ---------------------------------------------------------------------------

/**
 * The room as one figure and four counts.
 *
 * There is no "Reserved" slice, because POS has no reservations: the four
 * states drawn here are the four a table session can actually be in. A wedge
 * for a feature that does not exist would read as "nobody has booked", which is
 * a claim this product cannot make.
 */
export function TableStatusPanel({ metrics }: { metrics: RestaurantOperationalMetrics }) {
  const counts: Record<(typeof TABLE_STATE_ORDER)[number], number> = {
    occupied: metrics.occupiedTables,
    available: metrics.availableTables,
    billing: metrics.billingTables,
    cleaning: metrics.cleaningTables,
  }

  // Derived from the slices rather than taken from the KPI row, so the figure
  // in the middle of the ring is always the ring's own arithmetic. A centre
  // that disagreed with the legend beside it would be read as a bug in the
  // counting, which is a worse thing to lose than a rounding.
  const inUse = counts.occupied + counts.billing + counts.cleaning

  return (
    <Panel
      title="Table status"
      description={
        metrics.occupancyPc === null ? 'No tables yet.' : `${metrics.occupancyPc}% of the room is seated.`
      }
      action={
        <Link className="pos-button pos-button--quiet pos-button--small" to="/floor">
          Floor plan <ArrowRight size={13} aria-hidden />
        </Link>
      }
    >
      {metrics.totalTables === 0 ? (
        <Unavailable muted title="No tables yet">
          Add a floor and its tables under Setup to see the room here.
        </Unavailable>
      ) : (
        <div className="pos-tablestatus">
          <DonutChart
            slices={TABLE_STATE_ORDER.map((state) => ({
              key: state,
              label: TABLE_STATE_LABEL[state],
              value: counts[state],
              colour: TABLE_STATE_COLOUR[state],
            }))}
            centreValue={`${count(inUse)} / ${count(metrics.totalTables)}`}
            centreLabel="In use"
            caption="Tables by state"
            format={(value) => count(value)}
          />

          <ul className="pos-tablelegend">
            {TABLE_STATE_ORDER.map((state) => (
              <li key={state}>
                <span
                  className="pos-legend__swatch pos-legend__swatch--square"
                  style={{ background: TABLE_STATE_COLOUR[state] }}
                  aria-hidden
                />
                <span>{TABLE_STATE_LABEL[state]}</span>
                <strong>{count(counts[state])}</strong>
              </li>
            ))}
          </ul>
        </div>
      )}

      <p className="pos-note">
        {count(metrics.covers)} cover{metrics.covers === 1 ? '' : 's'} seated. POS has no reservations, so there is no
        booked state to show.
      </p>
    </Panel>
  )
}

// ---------------------------------------------------------------------------
// Today's orders
// ---------------------------------------------------------------------------

const ORDER_STATE: Record<RestaurantOrderState, { label: string; tone: BadgeTone }> = {
  seated: { label: 'Seated', tone: 'neutral' },
  placed: { label: 'Ordering', tone: 'neutral' },
  in_kitchen: { label: 'In the kitchen', tone: 'warning' },
  ready: { label: 'Ready', tone: 'info' },
  served: { label: 'Served', tone: 'success' },
  delayed: { label: 'Running late', tone: 'danger' },
  paid: { label: 'Settled', tone: 'success' },
  cancelled: { label: 'Void', tone: 'neutral' },
}

/** The state in words inside the chip, never in the colour alone. */
export function OrderStateBadge({ state }: { state: RestaurantOrderState }) {
  const shown = ORDER_STATE[state] ?? ORDER_STATE.placed

  return <StatusBadge tone={shown.tone}>{shown.label}</StatusBadge>
}

/** Where a row drills into. Never a screen invented for this list. */
function orderHref(order: RestaurantOrderSummary): string | null {
  if (order.table_session_id !== null) return `/floor?session=${order.table_session_id}`
  if (order.tickets > 0) return '/kitchen'

  return null
}

function OrderRow({ order }: { order: RestaurantOrderSummary }) {
  const where = order.table_code
    ? `Table ${order.table_code}`
    : titleCase(order.order_kind)
  const elapsed = `${order.elapsed_basis === 'took' ? 'took ' : ''}${duration(order.elapsed_seconds)}`

  const body = (
    <>
      <span className="pos-orderrow__ref">{order.reference}</span>
      <span className="pos-orderrow__where">
        {where}
        {order.customer_name && (
          <span className="pos-muted" style={{ display: 'block' }}>
            {order.customer_name}
          </span>
        )}
      </span>
      <span className="pos-orderrow__items pos-muted">
        {count(order.item_count)} item{order.item_count === 1 ? '' : 's'}
      </span>
      <span className="pos-orderrow__state">
        <OrderStateBadge state={order.state} />
      </span>
      <span className="pos-orderrow__clock num">{elapsed}</span>
    </>
  )

  const href = orderHref(order)
  const description = `Order ${order.reference}, ${where}, ${order.item_count} items, ${
    (ORDER_STATE[order.state] ?? ORDER_STATE.placed).label
  }, ${elapsed}`

  if (href) {
    return (
      <Link className="pos-orderrow" to={href} aria-label={`${description}. Open it`}>
        {body}
      </Link>
    )
  }

  return (
    <div className="pos-orderrow pos-orderrow--static" aria-label={description}>
      {body}
    </div>
  )
}

/**
 * What is on the board.
 *
 * Open orders are listed WHATEVER the date filter says — an order on the floor
 * is open until it is settled, and hiding last night's unsettled table because
 * the filter says today hides the one thing most worth seeing.
 */
export function TodaysOrdersPanel({ board }: { board: RestaurantBoard }) {
  return (
    <Panel
      title="Orders on the board"
      description={<LiveTag />}
      action={
        <Link className="pos-button pos-button--quiet pos-button--small" to="/floor">
          View all <ArrowRight size={13} aria-hidden />
        </Link>
      }
    >
      {board.orders.items.length === 0 ? (
        <Unavailable muted title="No orders yet">
          New orders appear here as soon as a table is seated or a counter order is started.
        </Unavailable>
      ) : (
        <div className="pos-orderlist">
          {board.orders.items.map((order) => (
            <OrderRow key={order.cart_id} order={order} />
          ))}
        </div>
      )}

      <p className="pos-note">{board.orders.note}</p>
    </Panel>
  )
}

// ---------------------------------------------------------------------------
// Attention strip
// ---------------------------------------------------------------------------

/**
 * The counts that are not hero figures but must not be lost.
 *
 * Only what is actually true appears. A chip reading "0 running late" is not
 * news, and a strip full of zeroes is how people learn to stop reading the one
 * that matters.
 */
export function OperationalAttention({ metrics }: { metrics: RestaurantOperationalMetrics }) {
  const items: Array<{ id: string; tone: BadgeTone; label: string; href: string }> = []

  if (metrics.lateTickets > 0) {
    items.push({
      id: 'late',
      tone: 'danger',
      label: `${count(metrics.lateTickets)} running late`,
      href: '/kitchen',
    })
  }
  if (metrics.readyTickets > 0) {
    items.push({
      id: 'ready',
      tone: 'info',
      label: `${count(metrics.readyTickets)} ready to serve`,
      href: '/kitchen',
    })
  }
  if (metrics.kitchenTickets > 0) {
    items.push({
      id: 'kitchen',
      tone: 'warning',
      label: `${count(metrics.kitchenTickets)} in the kitchen`,
      href: '/kitchen',
    })
  }
  if (metrics.unsettledBills > 0) {
    items.push({
      id: 'unsettled',
      tone: 'warning',
      label: `${count(metrics.unsettledBills)} unsettled · ${money(metrics.unsettledValue)}`,
      href: '/floor',
    })
  }
  if (metrics.billingTables > 0) {
    items.push({
      id: 'billing',
      tone: 'warning',
      label: `${count(metrics.billingTables)} waiting for the bill`,
      href: '/floor',
    })
  }
  if (metrics.menuUnavailable > 0) {
    items.push({
      id: 'menu',
      tone: 'neutral',
      label: `${count(metrics.menuUnavailable)} off the menu`,
      href: '/restaurant',
    })
  }

  if (items.length === 0) return null

  return (
    <section className="pos-attentionstrip" aria-label="Needs attention">
      <span className="pos-attentionstrip__label">Needs attention</span>
      <div className="pos-attentionstrip__items">
        {items.map((item) => (
          <Link key={item.id} className="pos-attentionchip" to={item.href}>
            <StatusBadge tone={item.tone} dot>
              {item.label}
            </StatusBadge>
          </Link>
        ))}
      </div>
    </section>
  )
}

// ---------------------------------------------------------------------------
// The suggestion strip
// ---------------------------------------------------------------------------

const SIGNAL_TONE: Record<RestaurantSignal['severity'], BadgeTone> = {
  danger: 'danger',
  warning: 'warning',
  info: 'neutral',
  success: 'success',
}

/**
 * Aicountly's suggestion for the floor.
 *
 * THE BADGE IS THE HONEST PART. POS has no model integration, so every line
 * this renders is a threshold crossed by a figure the server counted, and it
 * says "Rule-based alert" rather than borrowing credit from a model that is not
 * there. When an intelligence endpoint lands it answers the same shape and its
 * items badge themselves "AI suggestion" — see restaurantInsight.ts.
 */
export function AicountlyInsightStrip({
  signal,
  onDismiss,
}: {
  signal: RestaurantSignal
  onDismiss: () => void
}) {
  return (
    <section
      className={`pos-suggest pos-suggest--${signal.severity}`}
      aria-label="Aicountly suggests"
    >
      <span className="pos-suggest__mark" aria-hidden>
        <Sparkles size={20} />
      </span>

      <div className="pos-suggest__body">
        <div className="pos-inline pos-suggest__meta">
          <strong>Aicountly AI Suggests</strong>
          <StatusBadge tone={SIGNAL_TONE[signal.severity]}>
            {signal.kind === 'ai' ? 'AI suggestion' : 'Rule-based alert'}
          </StatusBadge>
        </div>
        <p className="pos-suggest__title">{signal.title}</p>
        <p className="pos-muted">{signal.explanation}</p>
      </div>

      <div className="pos-suggest__actions">
        {signal.evidenceHref && (
          <Link className="pos-button pos-button--small pos-button--suggest" to={signal.evidenceHref}>
            {signal.evidenceLabel ?? 'View evidence'} <ArrowRight size={13} aria-hidden />
          </Link>
        )}
        <button
          type="button"
          className="pos-iconbutton"
          onClick={onDismiss}
          aria-label="Dismiss this suggestion"
          title="Dismiss until the next refresh"
        >
          <X size={16} aria-hidden />
        </button>
      </div>
    </section>
  )
}

// ---------------------------------------------------------------------------
// Quick actions
// ---------------------------------------------------------------------------

interface QuickAction {
  id: string
  label: string
  icon: ReactNode
  to?: string
  /** Any one of these is enough. Empty means everyone. */
  permissions: string[]
  primary?: boolean
  /** Why this cannot be pressed, in the words a manager would use. */
  unavailable?: string
}

/**
 * The ten things a manager does from this screen.
 *
 * Every enabled action goes to a route that exists. Where POS has no screen for
 * something a restaurant expects — reservations, editing the menu — the action
 * is present and DISABLED with the reason in plain words, rather than absent
 * (which looks like an oversight) or linking somewhere unrelated (which is
 * worse).
 */
export function RestaurantQuickActions() {
  const { can } = usePos()

  const actions: QuickAction[] = [
    {
      id: 'open-table',
      label: 'Open table',
      icon: <Plus size={18} aria-hidden />,
      to: '/floor',
      permissions: ['table.open'],
      primary: true,
    },
    { id: 'new-order', label: 'New order', icon: <ScanLine size={18} aria-hidden />, to: '/', permissions: ['sell'] },
    { id: 'kds', label: 'KDS view', icon: <ChefHat size={18} aria-hidden />, to: '/kitchen', permissions: ['kds.operate'] },
    {
      id: 'reservations',
      label: 'Reservations',
      icon: <CalendarDays size={18} aria-hidden />,
      permissions: [],
      // TODO(route): no reservations or waitlist exists in POS yet. When one
      // lands, point this at it — do not link it at the floor screen, which
      // cannot answer a booking.
      unavailable: 'POS does not take bookings yet. Seat walk-ins from the floor screen.',
    },
    {
      id: 'takeaway',
      label: 'Takeaway order',
      icon: <ShoppingBag size={18} aria-hidden />,
      to: '/?order_kind=takeaway',
      permissions: ['sell'],
    },
    {
      id: 'delivery',
      label: 'Delivery order',
      icon: <Bike size={18} aria-hidden />,
      to: '/?order_kind=delivery',
      permissions: ['sell'],
    },
    {
      id: 'menu',
      label: 'Menu',
      icon: <UtensilsCrossed size={18} aria-hidden />,
      permissions: [],
      // TODO(route): pos_menu_items has no editor screen in this app. Menu
      // availability is shown read-only further down the board.
      unavailable: 'The menu is not editable from POS yet. Availability is shown further down this board.',
    },
    {
      id: 'shift-report',
      label: 'Shift report',
      icon: <ClipboardList size={18} aria-hidden />,
      to: '/reports',
      permissions: ['reports.view'],
    },
    {
      id: 'end-shift',
      label: 'End shift',
      icon: <Power size={18} aria-hidden />,
      to: '/reports',
      permissions: ['shift.close'],
    },
  ]

  const allowed = actions.filter(
    (action) => action.permissions.length === 0 || action.permissions.some((permission) => can(permission)),
  )

  if (allowed.length === 0) return null

  return (
    <section className="pos-quickactions" aria-label="Quick actions">
      <h2>Quick actions</h2>

      <div className="pos-quickactions__grid">
        {allowed.map((action) =>
          action.to ? (
            <Link
              key={action.id}
              to={action.to}
              className={`pos-quickaction${action.primary ? ' pos-quickaction--primary' : ''}`}
            >
              <span className="pos-quickaction__icon" aria-hidden>
                {action.icon}
              </span>
              <span>{action.label}</span>
            </Link>
          ) : (
            <button
              key={action.id}
              type="button"
              className="pos-quickaction"
              disabled
              title={action.unavailable}
              aria-label={`${action.label}. ${action.unavailable ?? 'Not available'}`}
            >
              <span className="pos-quickaction__icon" aria-hidden>
                {action.icon}
              </span>
              <span>{action.label}</span>
              <span className="pos-quickaction__note">Not yet in POS</span>
            </button>
          ),
        )}
      </div>
    </section>
  )
}

// ---------------------------------------------------------------------------
// The session panel
// ---------------------------------------------------------------------------

/**
 * What service looks like right now, at the bottom of the board.
 *
 * Two entirely different panels behind one heading, and which one shows is
 * decided by whether anything is actually happening. A restaurant with eight
 * live orders must never be told it has no session open — that is the
 * contradiction this component exists to prevent.
 */
export function RestaurantSessionPanel({
  board,
  metrics,
}: {
  board: RestaurantBoard
  metrics: RestaurantOperationalMetrics
}) {
  const active = metrics.occupiedTables > 0 || metrics.activeOrders > 0 || metrics.kitchenTickets > 0

  if (!active) {
    return (
      <section className="pos-session" aria-label="Restaurant session">
        <div className="pos-session__art" aria-hidden>
          <span className="pos-session__table">
            <Coffee size={26} />
          </span>
        </div>

        <div className="pos-session__copy">
          <h2>No table is open</h2>
          <p className="pos-muted">
            {metrics.serviceOpen
              ? 'A till here has a shift open, so the restaurant is ready. Seat a table or start a counter order to begin.'
              : 'No till here has a shift open. Seat a table to start the floor, or open a till when you are ready to take money.'}
          </p>

          <div className="pos-actions">
            <Link className="pos-button pos-button--primary" to="/floor">
              <Plus size={15} aria-hidden /> Open table
            </Link>
            <Link className="pos-button pos-button--secondary" to="/floor">
              <LayoutGrid size={15} aria-hidden /> View floor plan
            </Link>
          </div>
        </div>
      </section>
    )
  }

  const waiting = board.floors
    .flatMap((floor) => floor.tables)
    .filter((table) => table.state === 'billing' || table.state === 'cleaning')

  return (
    <section className="pos-session pos-session--active" aria-label="Service right now">
      <div className="pos-session__copy">
        <h2>Service is running</h2>
        <p className="pos-muted">
          {count(metrics.occupiedTables)} table{metrics.occupiedTables === 1 ? '' : 's'} seated ·{' '}
          {count(metrics.covers)} cover{metrics.covers === 1 ? '' : 's'} · {count(metrics.activeOrders)} open order
          {metrics.activeOrders === 1 ? '' : 's'} worth {money(metrics.unsettledValue)} on the floor.
        </p>

        <div className="pos-actions">
          <Link className="pos-button pos-button--primary" to="/floor">
            <Plus size={15} aria-hidden /> Open table
          </Link>
          <Link className="pos-button pos-button--secondary" to="/floor">
            <LayoutGrid size={15} aria-hidden /> View floor plan
          </Link>
          <Link className="pos-button pos-button--secondary" to="/kitchen">
            <ChefHat size={15} aria-hidden /> Kitchen
          </Link>
        </div>
      </div>

      <div className="pos-session__side">
        <h3>Tables wanting something</h3>
        {waiting.length === 0 ? (
          <p className="pos-muted">
            No table is waiting for a bill or a clear-down. Nothing needs a walk over right now.
          </p>
        ) : (
          <ul className="pos-session__list">
            {waiting.slice(0, 5).map((table) => (
              <li key={table.table_id}>
                <span>
                  <strong>{table.table_code}</strong>
                  <span className="pos-muted" style={{ display: 'block' }}>
                    {table.state === 'billing' ? 'Asked for the bill' : 'Waiting to be cleared'}
                  </span>
                </span>
                <StatusBadge tone={table.state === 'billing' ? 'warning' : 'info'}>
                  {table.running_total !== null && table.running_total > 0
                    ? money(table.running_total)
                    : duration(table.seated_seconds)}
                </StatusBadge>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  )
}

// ---------------------------------------------------------------------------
// Setting the restaurant up
// ---------------------------------------------------------------------------

/**
 * What to do when there is no restaurant here at all.
 *
 * "No restaurant set up here" and "the restaurant is quiet today" are the same
 * zeroes and completely different problems. This is the first, and it is a
 * checklist rather than a shrug: every line is a count the server actually
 * made, so a shop halfway through setting up can see exactly where it stopped.
 */
export function RestaurantSetupPanel({ setup }: { setup: RestaurantBoard['setup'] }) {
  const { can } = usePos()

  return (
    <section className="pos-setup" aria-label="Set up Restaurant Operations">
      <div className="pos-setup__copy">
        <p className="pos-eyebrow">GETTING STARTED</p>
        <h2>Set up Restaurant Operations</h2>
        <p className="pos-muted">
          Create the floor, its tables, the kitchen stations and the menu, and this board fills itself in as service
          runs. Nothing here needs to be entered twice — the tables and the menu are the same ones the floor and the
          kitchen screens use.
        </p>

        <div className="pos-actions">
          {can('terminal.manage') ? (
            <Link className="pos-button pos-button--primary" to="/setup">
              Set up the restaurant
            </Link>
          ) : (
            <span className="pos-muted">Ask whoever administers POS to finish the setup.</span>
          )}
          <Link className="pos-button pos-button--secondary" to="/floor">
            View floor plan
          </Link>
        </div>
      </div>

      <ol className="pos-setup__steps">
        <li className="pos-setup__progress" aria-hidden>
          <span className="pos-bar__track">
            <span
              className="pos-bar__fill"
              style={{ width: `${setup.total > 0 ? (setup.done / setup.total) * 100 : 0}%` }}
            />
          </span>
          <span className="pos-muted">
            {setup.done} of {setup.total} done
          </span>
        </li>

        {setup.steps.map((step) => (
          <li key={step.key} className={step.done ? 'pos-setup__step pos-setup__step--done' : 'pos-setup__step'}>
            <span className="pos-setup__tick" aria-hidden>
              {step.done ? '✓' : ''}
            </span>
            <span>{step.label}</span>
            <StatusBadge tone={step.done ? 'success' : 'neutral'}>
              {step.done ? `${count(step.count)} added` : 'Not yet'}
            </StatusBadge>
          </li>
        ))}
      </ol>
    </section>
  )
}

// ---------------------------------------------------------------------------
// Odds and ends
// ---------------------------------------------------------------------------

/** "Live", with the word in it as well as the dot. */
export function LiveTag() {
  return (
    <span className="pos-live" title="Counted from what is true right now. The date filter does not change it.">
      <span className="pos-live__dot" aria-hidden />
      Live
    </span>
  )
}

/** POS collects no guest feedback. This says so; it never shows a score. */
export function GuestFeedbackNote({ rating }: { rating: RestaurantBoard['rating'] }) {
  return (
    <Unavailable title="No guest feedback">
      {rating.note} <span className="pos-muted">What would close this: {rating.contract_gap}</span>
    </Unavailable>
  )
}

/**
 * The board's shape, drawn empty.
 *
 * Matches the real layout so the page does not jump when the figures land —
 * a dashboard that reflows twice on every load is a dashboard people misread.
 */
export function RestaurantBoardSkeleton() {
  return (
    <>
      <div className="pos-grid-ops">
        <div className="pos-panel pos-panel--skeleton">
          <div className="pos-panel__body">
            <PanelSkeleton rows={2} height={58} />
          </div>
        </div>
        <div className="pos-panel pos-panel--skeleton">
          <div className="pos-panel__body">
            <PanelSkeleton rows={2} height={58} />
          </div>
        </div>
        <div className="pos-panel pos-panel--skeleton">
          <div className="pos-panel__body">
            <PanelSkeleton rows={4} height={28} />
          </div>
        </div>
      </div>

      <div className="pos-panel pos-panel--skeleton">
        <div className="pos-panel__body">
          <PanelSkeleton rows={2} height={44} />
        </div>
      </div>
    </>
  )
}
