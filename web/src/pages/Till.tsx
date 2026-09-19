import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { CreditCard, Loader2, Lock, Pause, Play, Search, Trash2, Wallet, X } from 'lucide-react'
import { usePos } from '../context/PosContext'
import { api, ApiError } from '../services/api'
import type { Cart, CatalogItem, PaymentMode, RegisterSession } from '../services/types'
import { cacheGet, cachePut, deviceUuid, outboxAdd, type OutboxSale } from '../offline/db'
import { Button, Card, Field, Input, Notice, Select, money } from '../ui'
import { CommandStrip } from '../components/CommandStrip'

/**
 * The kinds of order this till can start.
 *
 * `order_kind` is a real column the API already validates, and a takeaway is
 * the same sale with a different label on it — so the quick actions on the
 * restaurant board deep-link here with ?order_kind=takeaway rather than a
 * second checkout screen existing. Anything unrecognised falls back to a
 * counter sale; a URL is a claim, not an instruction.
 */
const ORDER_KINDS = {
  retail: 'Counter sale',
  takeaway: 'Takeaway',
  delivery: 'Delivery',
  quick_service: 'Quick service',
} as const

type TillOrderKind = keyof typeof ORDER_KINDS

const PAYMENT_MODES: { value: PaymentMode; label: string }[] = [
  { value: 'cash', label: 'Cash' },
  { value: 'card', label: 'Card' },
  { value: 'upi', label: 'UPI' },
  { value: 'bank', label: 'Bank transfer' },
  { value: 'customer_credit', label: 'On account' },
  { value: 'gift_card', label: 'Gift card' },
  { value: 'other', label: 'Other' },
]

export default function Till() {
  const { terminalId, terminal, can, session: posSession } = usePos()
  const [searchParams] = useSearchParams()

  const orderKind = useMemo<TillOrderKind>(() => {
    const raw = searchParams.get('order_kind')

    return raw !== null && raw in ORDER_KINDS ? (raw as TillOrderKind) : 'retail'
  }, [searchParams])

  const [shift, setShift] = useState<RegisterSession | null>(null)
  const [cart, setCart] = useState<Cart | null>(null)
  const [held, setHeld] = useState<Cart[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [offline, setOffline] = useState(() => !navigator.onLine)

  const scanRef = useRef<HTMLInputElement | null>(null)

  // ------------------------------------------------------------------
  // Shift
  // ------------------------------------------------------------------

  const loadShift = useCallback(async () => {
    if (!terminalId) {
      setShift(null)
      return
    }
    try {
      const response = await api.one<{ session: RegisterSession | null }>('v1/shifts/current', { terminal_id: terminalId })
      setShift(response.data.session)
    } catch {
      // Offline. The till keeps whatever it already knew about the shift.
    }
  }, [terminalId])

  const loadHeld = useCallback(async () => {
    if (!terminalId) return
    try {
      const response = await api.list<Cart>('v1/carts', { status: 'HELD', terminal_id: terminalId, limit: 20 })
      setHeld(response.data)
    } catch {
      setHeld([])
    }
  }, [terminalId])

  useEffect(() => {
    void loadShift()
    void loadHeld()
  }, [loadShift, loadHeld])

  useEffect(() => {
    const on = () => setOffline(false)
    const off = () => setOffline(true)
    window.addEventListener('online', on)
    window.addEventListener('offline', off)
    return () => {
      window.removeEventListener('online', on)
      window.removeEventListener('offline', off)
    }
  }, [])

  const openShift = async (openingFloat: number) => {
    if (!terminalId) return
    setBusy(true)
    setError(null)
    try {
      const response = await api.post<RegisterSession>('v1/shifts', { terminal_id: terminalId, opening_float: openingFloat })
      setShift(response.data)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not open the till.')
    } finally {
      setBusy(false)
    }
  }

  // ------------------------------------------------------------------
  // Cart
  // ------------------------------------------------------------------

  const ensureCart = useCallback(async (): Promise<Cart | null> => {
    if (cart && cart.status === 'OPEN') return cart
    if (!terminalId) return null

    const response = await api.post<Cart>('v1/carts', {
      terminal_id: terminalId,
      session_id: shift?.session_id ?? null,
      order_kind: orderKind,
    })
    setCart(response.data)
    return response.data
  }, [cart, terminalId, shift, orderKind])

  const addItem = async (item: CatalogItem, quantity = 1) => {
    setBusy(true)
    setError(null)
    try {
      const target = await ensureCart()
      if (!target) throw new Error('Choose a till first.')

      const response = await api.post<Cart>(`v1/carts/${target.cart_id}/lines`, {
        item_id: item.item_id,
        quantity,
        display_name: item.item_name,
        unit_id: item.unit_id,
        rate: item.sale_rate,
        estimated_tax_pc: item.tax_rate,
        tax_cat_id: item.tax_cat_id,
      })
      setCart(response.data)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not add that item.')
    } finally {
      setBusy(false)
      scanRef.current?.focus()
    }
  }

  const changeQty = async (lineId: number, quantity: number) => {
    if (!cart) return
    setBusy(true)
    try {
      const response = await api.put<Cart>(`v1/carts/${cart.cart_id}/lines/${lineId}`, { quantity })
      setCart(response.data)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not change that line.')
    } finally {
      setBusy(false)
    }
  }

  const removeLine = async (lineId: number) => {
    if (!cart) return
    const reason = posOrPrompt('Why is this line coming off?')
    if (reason === null) return
    setBusy(true)
    try {
      const response = await api.del<Cart>(`v1/carts/${cart.cart_id}/lines/${lineId}`, { reason })
      setCart(response.data)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not remove that line.')
    } finally {
      setBusy(false)
    }
  }

  const holdCart = async () => {
    if (!cart) return
    setBusy(true)
    try {
      await api.post(`v1/carts/${cart.cart_id}/hold`, { hold_label: cart.customer_name ?? undefined })
      setCart(null)
      await loadHeld()
      setNotice('Sale held. Call it back from the list on the right.')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not hold that sale.')
    } finally {
      setBusy(false)
    }
  }

  const resumeCart = async (cartId: number) => {
    setBusy(true)
    try {
      const response = await api.post<Cart>(`v1/carts/${cartId}/resume`, {})
      setCart(response.data)
      await loadHeld()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not resume that sale.')
    } finally {
      setBusy(false)
    }
  }

  const voidCart = async () => {
    if (!cart) return
    const reason = posOrPrompt('Why is this sale being voided?')
    if (reason === null) return
    setBusy(true)
    try {
      await api.post(`v1/carts/${cart.cart_id}/void`, { reason })
      setCart(null)
      setNotice('Sale voided.')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not void that sale.')
    } finally {
      setBusy(false)
    }
  }

  // ------------------------------------------------------------------
  // Render
  // ------------------------------------------------------------------

  if (!terminalId) {
    // Two different situations, and telling them apart matters. "Pick a till"
    // is useless advice when there is no till to pick and the header's picker
    // has therefore rendered nothing — that is a dead end with no way forward
    // on the screen, which is exactly what a freshly set-up company sees.
    const noTillsExist = (posSession?.terminals.length ?? 0) === 0

    if (noTillsExist) {
      return (
        <Notice tone="info" title="No till has been set up yet">
          A till is the counter this browser is standing at — the drawer, the shift and the receipts are all recorded
          against one, so selling cannot start until there is one.{' '}
          {can('terminal.manage') ? (
            <>
              Create an outlet and its first till in <Link to="/setup">Setup</Link>.
            </>
          ) : (
            <>Ask whoever administers POS to add one in Setup.</>
          )}
        </Notice>
      )
    }

    return (
      <Notice tone="info" title="Which till is this?">
        Choose the till at the top of the page. Everything a till does — the drawer, the shift, the receipts — is
        recorded against it, so it has to be picked before selling.
      </Notice>
    )
  }

  if (!shift) {
    return <OpenTill terminal={terminal?.display_name ?? terminal?.terminal_code ?? 'this till'} onOpen={openShift} busy={busy} error={error} />
  }

  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 24rem', gap: '1rem', alignItems: 'start' }}>
      <div style={{ display: 'grid', gap: '1rem', minWidth: 0 }}>
        {offline && (
          <Notice tone="warning" title="No connection">
            This till is still selling. Sales are kept on this machine and sent up the moment the connection is back —
            each one carries an id so it cannot be billed twice.
          </Notice>
        )}
        {error && <Notice tone="danger" onDismiss={() => setError(null)}>{error}</Notice>}
        {notice && <Notice tone="success" onDismiss={() => setNotice(null)}>{notice}</Notice>}

        <Scanner inputRef={scanRef} onPick={addItem} offline={offline} />

        <Card
          title="On the counter"
          subtitle={[
            ORDER_KINDS[(cart?.order_kind ?? orderKind) as TillOrderKind] ?? ORDER_KINDS[orderKind],
            cart?.token_no ? `Token ${cart.token_no}` : null,
          ]
            .filter(Boolean)
            .join(' · ')}
        >
          {!cart || cart.lines.length === 0 ? (
            <p style={{ color: 'var(--muted)', margin: 0 }}>Scan or search for the first item.</p>
          ) : (
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr style={{ textAlign: 'left', color: 'var(--muted)', fontSize: '0.78rem' }}>
                  <th style={{ padding: '0.35rem 0' }}>Item</th>
                  <th style={{ width: '6rem' }}>Qty</th>
                  <th style={{ width: '7rem', textAlign: 'right' }}>Rate</th>
                  <th style={{ width: '7rem', textAlign: 'right' }}>Amount</th>
                  <th style={{ width: '2rem' }} />
                </tr>
              </thead>
              <tbody>
                {cart.lines.map((line) => (
                  <tr key={line.line_id} style={{ borderTop: '1px solid var(--border)' }}>
                    <td style={{ padding: '0.45rem 0' }}>
                      {line.display_name}
                      {line.modifiers.length > 0 && (
                        <div style={{ color: 'var(--muted)', fontSize: '0.78rem' }}>
                          {line.modifiers.map((m) => m.option_name).join(', ')}
                        </div>
                      )}
                    </td>
                    <td>
                      <Input
                        type="number"
                        min={0.001}
                        step="any"
                        value={line.quantity}
                        onChange={(e) => void changeQty(line.line_id, Number(e.target.value))}
                        style={{ width: '5rem' }}
                      />
                    </td>
                    <td className="num" style={{ textAlign: 'right' }}>{money(line.rate)}</td>
                    <td className="num" style={{ textAlign: 'right' }}>{money(line.line_amount)}</td>
                    <td style={{ textAlign: 'right' }}>
                      {can('cart.void_line') && (
                        <button
                          type="button"
                          onClick={() => void removeLine(line.line_id)}
                          title="Remove this line"
                          style={{ background: 'none', border: 'none', color: 'var(--muted)', cursor: 'pointer' }}
                        >
                          <Trash2 size={15} aria-hidden />
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>

        {cart?.commands && cart.commands.length > 0 && <CommandStrip commands={cart.commands} />}
      </div>

      <div style={{ display: 'grid', gap: '1rem' }}>
        <PayPanel
          cart={cart}
          shift={shift}
          offline={offline}
          terminalId={terminalId}
          canDiscountOverride={can('discount.override')}
          discountLimit={posSession?.settings.cashier_discount_limit_pc ?? 5}
          onDone={(message) => {
            setCart(null)
            setNotice(message)
            void loadShift()
            scanRef.current?.focus()
          }}
          onError={setError}
          onCartChange={setCart}
        />

        {cart && cart.status === 'OPEN' && (
          <div style={{ display: 'flex', gap: '0.5rem' }}>
            {can('cart.hold') && (
              <Button tone="ghost" onClick={() => void holdCart()} disabled={busy || cart.lines.length === 0}>
                <Pause size={14} aria-hidden /> Hold
              </Button>
            )}
            {can('cart.void') && (
              <Button tone="danger" onClick={() => void voidCart()} disabled={busy}>
                <X size={14} aria-hidden /> Void
              </Button>
            )}
          </div>
        )}

        {held.length > 0 && (
          <Card title="Held sales" subtitle={`${held.length} waiting`}>
            <div style={{ display: 'grid', gap: '0.4rem' }}>
              {held.map((h) => (
                <button
                  key={h.cart_id}
                  type="button"
                  onClick={() => void resumeCart(h.cart_id)}
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    padding: '0.5rem 0.6rem',
                    border: '1px solid var(--border)',
                    borderRadius: 'var(--radius-sm)',
                    background: 'var(--surface-2)',
                    cursor: 'pointer',
                    color: 'var(--fg)',
                  }}
                >
                  <span>
                    <Play size={12} aria-hidden style={{ marginRight: '0.35rem' }} />
                    {h.hold_label ?? h.customer_name ?? `Token ${h.token_no ?? h.cart_id}`}
                  </span>
                  <span className="num">{money(h.total_amount)}</span>
                </button>
              ))}
            </div>
          </Card>
        )}

        <Card title="This shift" subtitle="What the drawer should hold">
          <dl style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '0.3rem 1rem', margin: 0 }}>
            <dt style={{ color: 'var(--muted)' }}>Opened with</dt>
            <dd className="num" style={{ margin: 0, textAlign: 'right' }}>{money(shift.opening_float)}</dd>
            <dt style={{ color: 'var(--muted)' }}>Should hold</dt>
            <dd className="num" style={{ margin: 0, textAlign: 'right' }}>{money(shift.expected_cash)}</dd>
          </dl>
        </Card>
      </div>
    </div>
  )
}

/** window.prompt, in one place, so it is easy to replace with a proper dialog. */
function posOrPrompt(question: string): string | null {
  const answer = window.prompt(question)
  if (answer === null) return null
  return answer.trim()
}

// ---------------------------------------------------------------------------
// Opening the till
// ---------------------------------------------------------------------------

function OpenTill({
  terminal,
  onOpen,
  busy,
  error,
}: {
  terminal: string
  onOpen: (openingFloat: number) => Promise<void>
  busy: boolean
  error: string | null
}) {
  const [float, setFloat] = useState('0')

  return (
    <Card title={`Open ${terminal}`} subtitle="Count what is in the drawer before the first sale">
      {error && <Notice tone="danger">{error}</Notice>}
      <Field label="Opening float" hint="The cash already in the drawer. Counting it now is what makes the close-out mean something.">
        <Input type="number" min={0} step="any" value={float} onChange={(e) => setFloat(e.target.value)} autoFocus />
      </Field>
      <Button onClick={() => void onOpen(Number(float) || 0)} disabled={busy}>
        {busy ? <Loader2 size={14} className="spin" aria-hidden /> : <Lock size={14} aria-hidden />} Open the till
      </Button>
    </Card>
  )
}

// ---------------------------------------------------------------------------
// The scanner
// ---------------------------------------------------------------------------

/**
 * Scan or search.
 *
 * A barcode scanner types fast and presses Enter, so Enter on a non-empty box
 * is treated as a scan and looked up exactly; anything else is a search. When
 * the till is offline the lookup falls back to the device cache, and the screen
 * SAYS SO — a cached price may be out of date, and a cashier arguing with a
 * customer about it deserves to know where the number came from.
 *
 * React 19 passes ref as an ordinary prop, so no forwardRef is needed.
 */
function Scanner({
  onPick,
  offline,
  inputRef,
}: {
  onPick: (item: CatalogItem) => void
  offline: boolean
  inputRef: React.RefObject<HTMLInputElement | null>
}) {
  const [term, setTerm] = useState('')
  const [results, setResults] = useState<CatalogItem[]>([])
  const [searching, setSearching] = useState(false)
  const [fromCache, setFromCache] = useState(false)
  const [missing, setMissing] = useState(false)

  const lookup = async (code: string) => {
    setSearching(true)
    setFromCache(false)
    setMissing(false)
    try {
      const response = await api.one<CatalogItem>('v1/catalog/barcode', { code })
      // Kept on THIS DEVICE so the same scan works when the line drops. It is a
      // convenience copy, never the answer when the server can be asked.
      await cachePut(`barcode:${code}`, response.data)
      onPick(response.data)
      setTerm('')
      setResults([])
    } catch (e) {
      const cached = await cacheGet<CatalogItem>(`barcode:${code}`)
      if (cached) {
        setFromCache(true)
        onPick(cached.value)
        setTerm('')
        setResults([])
      } else if (e instanceof ApiError && e.status === 404) {
        setMissing(true)
      } else {
        setMissing(true)
      }
    } finally {
      setSearching(false)
    }
  }

  const search = async (q: string) => {
    setMissing(false)
    if (q.trim().length < 2) {
      setResults([])
      return
    }
    setSearching(true)
    try {
      const response = await api.one<CatalogItem[]>('v1/catalog/items/search', { q, limit: 12 })
      setResults(response.data)
      setFromCache(false)
    } catch {
      setResults([])
    } finally {
      setSearching(false)
    }
  }

  return (
    <Card>
      <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
        <Search size={16} aria-hidden style={{ color: 'var(--muted)' }} />
        <Input
          ref={inputRef}
          value={term}
          placeholder={offline ? 'Scan — offline, using this till\u2019s saved prices' : 'Scan a barcode, or type to search'}
          autoFocus
          onChange={(e) => {
            setTerm(e.target.value)
            void search(e.target.value)
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && term.trim() !== '') {
              e.preventDefault()
              void lookup(term.trim())
            }
          }}
          style={{ flex: 1 }}
        />
        {searching && <Loader2 size={15} className="spin" aria-hidden style={{ color: 'var(--muted)' }} />}
      </div>

      {fromCache && (
        <p style={{ color: 'var(--warn-fg, #fbbf24)', fontSize: '0.8rem', margin: '0.5rem 0 0' }}>
          Priced from this till\u2019s saved copy \u2014 check it against the shelf.
        </p>
      )}
      {missing && (
        <p style={{ color: 'var(--muted)', fontSize: '0.8rem', margin: '0.5rem 0 0' }}>
          Nothing found for that code, and this till has no saved copy of it.
        </p>
      )}

      {results.length > 0 && (
        <div style={{ display: 'grid', gap: '0.3rem', marginTop: '0.6rem' }}>
          {results.map((item) => (
            <button
              key={item.item_id}
              type="button"
              onClick={() => {
                onPick(item)
                setTerm('')
                setResults([])
              }}
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                padding: '0.45rem 0.6rem',
                border: '1px solid var(--border)',
                borderRadius: 'var(--radius-sm)',
                background: 'var(--surface-2)',
                cursor: 'pointer',
                color: 'var(--fg)',
                textAlign: 'left',
              }}
            >
              <span>{item.item_name}</span>
              <span className="num" style={{ color: 'var(--muted)' }}>{money(item.sale_rate ?? 0)}</span>
            </button>
          ))}
        </div>
      )}
    </Card>
  )
}

// ---------------------------------------------------------------------------
// Payment
// ---------------------------------------------------------------------------

interface Tender {
  payment_mode: PaymentMode
  amount: string
  reference: string
}

function PayPanel({
  cart,
  shift,
  offline,
  terminalId,
  canDiscountOverride,
  discountLimit,
  onDone,
  onError,
  onCartChange,
}: {
  cart: Cart | null
  shift: RegisterSession
  offline: boolean
  terminalId: number
  canDiscountOverride: boolean
  discountLimit: number
  onDone: (message: string) => void
  onError: (message: string) => void
  onCartChange: (cart: Cart) => void
}) {
  const [tenders, setTenders] = useState<Tender[]>([{ payment_mode: 'cash', amount: '', reference: '' }])
  const [busy, setBusy] = useState(false)

  const total = cart?.total_amount ?? 0
  const paid = useMemo(() => tenders.reduce((sum, t) => sum + (Number(t.amount) || 0), 0), [tenders])
  const change = Math.max(0, paid - total)
  const due = Math.max(0, total - paid)

  const pay = async () => {
    if (!cart) return
    setBusy(true)
    try {
      const payments = tenders
        .filter((t) => Number(t.amount) > 0)
        .map((t) => ({
          payment_mode: t.payment_mode,
          amount: Number(t.amount),
          tendered: t.payment_mode === 'cash' ? Number(t.amount) : undefined,
          change_given: 0,
          reference: t.reference || undefined,
        }))

      // The cash line absorbs the change, so the drawer arithmetic matches what
      // actually happened: this much came in, this much went back out.
      const cashIndex = payments.findIndex((p) => p.payment_mode === 'cash')
      if (cashIndex >= 0 && change > 0) {
        payments[cashIndex] = { ...payments[cashIndex], amount: payments[cashIndex].amount - change, change_given: change }
      }

      if (offline) {
        await queueOffline(cart, payments, terminalId, shift.session_id)
        onDone('Taken offline. It goes up on its own when the connection is back.')
        return
      }

      const response = await api.post<Cart>(`v1/carts/${cart.cart_id}/checkout`, { payments })
      onCartChange(response.data)
      onDone(
        response.data.warning
          ? `Paid. ${response.data.warning}`
          : `Paid. Invoice ${response.data.books_voucher_no ?? 'raised in Books'}.`,
      )
    } catch (e) {
      if (e instanceof ApiError && e.retryable) {
        onError(`${e.message} Nothing has been billed — press Pay again when you are ready.`)
      } else {
        onError(e instanceof Error ? e.message : 'The payment did not go through.')
      }
    } finally {
      setBusy(false)
      setTenders([{ payment_mode: 'cash', amount: '', reference: '' }])
    }
  }

  if (!cart || cart.lines.length === 0) {
    return (
      <Card title="Payment">
        <p style={{ color: 'var(--muted)', margin: 0 }}>Add something to the sale first.</p>
      </Card>
    )
  }

  return (
    <Card title="Payment">
      <dl style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '0.25rem 1rem', margin: '0 0 0.75rem' }}>
        <dt style={{ color: 'var(--muted)' }}>Items</dt>
        <dd className="num" style={{ margin: 0, textAlign: 'right' }}>{money(cart.subtotal_amount)}</dd>
        {cart.discount_amount > 0 && (
          <>
            <dt style={{ color: 'var(--muted)' }}>Discount</dt>
            <dd className="num" style={{ margin: 0, textAlign: 'right' }}>−{money(cart.discount_amount)}</dd>
          </>
        )}
        <dt style={{ color: 'var(--muted)' }} title="Books works out the statutory tax on the invoice. This is the counter estimate.">
          Tax (estimate)
        </dt>
        <dd className="num" style={{ margin: 0, textAlign: 'right' }}>{money(cart.estimated_tax_amount)}</dd>
        <dt style={{ fontWeight: 700 }}>To pay</dt>
        <dd className="num" style={{ margin: 0, textAlign: 'right', fontWeight: 700, fontSize: '1.15rem' }}>{money(total)}</dd>
      </dl>

      {tenders.map((tender, index) => (
        <div key={index} style={{ display: 'grid', gap: '0.4rem', marginBottom: '0.5rem' }}>
          <div style={{ display: 'flex', gap: '0.4rem' }}>
            <Select
              value={tender.payment_mode}
              onChange={(e) =>
                setTenders((prev) => prev.map((t, i) => (i === index ? { ...t, payment_mode: e.target.value as PaymentMode } : t)))
              }
              style={{ width: '9rem' }}
            >
              {PAYMENT_MODES.map((mode) => (
                <option key={mode.value} value={mode.value}>{mode.label}</option>
              ))}
            </Select>
            <Input
              type="number"
              min={0}
              step="any"
              placeholder={index === 0 ? String(total) : '0'}
              value={tender.amount}
              onChange={(e) => setTenders((prev) => prev.map((t, i) => (i === index ? { ...t, amount: e.target.value } : t)))}
              style={{ flex: 1 }}
            />
          </div>
          {tender.payment_mode !== 'cash' && tender.payment_mode !== 'customer_credit' && (
            <Input
              placeholder="Reference from the terminal slip — last 4 digits or the UPI id"
              value={tender.reference}
              onChange={(e) => setTenders((prev) => prev.map((t, i) => (i === index ? { ...t, reference: e.target.value } : t)))}
            />
          )}
        </div>
      ))}

      <button
        type="button"
        onClick={() => setTenders((prev) => [...prev, { payment_mode: 'card', amount: '', reference: '' }])}
        style={{ background: 'none', border: 'none', color: 'var(--muted)', cursor: 'pointer', fontSize: '0.82rem', padding: 0 }}
      >
        + Split across another tender
      </button>

      <div style={{ marginTop: '0.75rem', display: 'grid', gap: '0.25rem' }}>
        {due > 0 && (
          <p style={{ margin: 0, color: 'var(--warn-fg, #fbbf24)' }}>
            Short by <span className="num">{money(due)}</span>
          </p>
        )}
        {change > 0 && (
          <p style={{ margin: 0, fontWeight: 700 }}>
            Change <span className="num">{money(change)}</span>
          </p>
        )}
      </div>

      <Button
        onClick={() => void pay()}
        disabled={busy || paid <= 0}
        style={{ width: '100%', marginTop: '0.75rem', justifyContent: 'center' }}
      >
        {busy ? <Loader2 size={15} className="spin" aria-hidden /> : offline ? <Wallet size={15} aria-hidden /> : <CreditCard size={15} aria-hidden />}
        {offline ? 'Take payment (offline)' : 'Take payment'}
      </Button>

      {!canDiscountOverride && (
        <p style={{ color: 'var(--muted)', fontSize: '0.78rem', margin: '0.6rem 0 0' }}>
          You can give up to {discountLimit}% off. A manager has to approve more.
        </p>
      )}
    </Card>
  )
}

/**
 * Put a sale on this device's queue.
 *
 * The uuid is minted HERE, before anything is attempted, and it is what makes
 * a resend safe: the server recognises it however many times it arrives.
 */
async function queueOffline(
  cart: Cart,
  payments: { payment_mode: string; amount: number; tendered?: number; change_given: number; reference?: string }[],
  terminalId: number,
  sessionId: number,
): Promise<void> {
  const sale: OutboxSale = {
    client_uuid: crypto.randomUUID(),
    device_uuid: deviceUuid(),
    terminal_id: terminalId,
    session_id: sessionId,
    client_created_at: new Date().toISOString(),
    order_kind: cart.order_kind,
    customer_name: cart.customer_name,
    customer_mobile: cart.customer_mobile,
    customer_account_id: cart.customer_account_id,
    token_no: cart.token_no,
    discount_amount: cart.discount_amount,
    service_charge_amount: cart.service_charge_amount,
    tip_amount: cart.tip_amount,
    lines: cart.lines.map((line) => ({
      item_id: line.item_id,
      menu_item_id: line.menu_item_id,
      unit_id: line.unit_id,
      warehouse_id: line.warehouse_id,
      batch_id: line.batch_id,
      display_name: line.display_name,
      quantity: line.quantity,
      rate: line.rate,
      discount_pc: line.discount_pc,
      discount_amount: line.discount_amount,
      estimated_tax_pc: line.estimated_tax_pc,
      instructions: line.instructions,
    })),
    payments: payments.map((p) => ({
      payment_mode: p.payment_mode,
      amount: p.amount,
      tendered: p.tendered ?? null,
      change_given: p.change_given,
      reference: p.reference ?? null,
    })),
    queuedAt: Date.now(),
    attempts: 0,
    lastError: null,
    status: 'QUEUED',
  }

  await outboxAdd(sale)
}
