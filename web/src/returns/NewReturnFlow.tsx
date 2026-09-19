/**
 * Taking a return at the counter, in the order the counter does it.
 *
 * FIND THE SALE FIRST. Everything after step one is read from that sale — the
 * items, their prices, the customer, the invoice, the till. Nothing is retyped,
 * which is what stops a return being valued at a price the shop never charged.
 *
 * THE QUANTITY IS THE SERVER'S. What is still returnable per item comes from
 * `/v1/returns/eligibility`, computed by the same rule `create()` enforces, so
 * the number the cashier is offered is the number that will be accepted. The
 * browser clamps to it for the cashier's sake; the server refuses regardless.
 *
 * THE TOTALS HERE ARE A PREVIEW. They are arithmetic on figures the server
 * sent, shown so the customer can be told what they are getting. The refund
 * that is actually recorded is the one the API computes from the lines it
 * receives, and the tax on the credit note is Books'.
 *
 * AN EXCHANGE IS A RETURN PLUS A SALE. POS does not have a private notion of
 * "swap": the goods come back on a return, and the replacement goes out on a
 * normal cart that is parked on the till for payment. The two halves are linked
 * by `exchange_cart_id` so they can be read back together.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ArrowLeft, ArrowRight, Check, Minus, Plus, Search, Trash2 } from 'lucide-react'
import { ApiError } from '../services/api'
import { returnsService } from '../services/returns'
import { decimal, money } from '../dashboards/format'
import { Notice } from '../ui'
import { Drawer } from './Drawer'
import { formatDate } from './periods'
import { CONDITION_TERMS, REASON_CHOICES, REASON_TERMS, RESOLUTION_TERMS } from './vocabulary'
import type { NewReturnPayload, ReturnCondition, ReturnEligibility, ReturnResolution } from './types'
import type { Cart, CatalogItem, PosReturn } from '../services/types'

type Step = 'sale' | 'items' | 'settle' | 'replace' | 'review' | 'done'

const CONDITIONS: ReturnCondition[] = ['good', 'damaged', 'expired', 'wrong_item']

interface Replacement {
  item: CatalogItem
  quantity: number
}

const STEP_TITLES: Record<Step, string> = {
  sale: 'Find the original sale',
  items: 'What is coming back',
  settle: 'Reason and settlement',
  replace: 'Replacement goods',
  review: 'Check and confirm',
  done: 'Return taken',
}

function useDebounced<T>(value: T, delay: number): T {
  const [debounced, setDebounced] = useState(value)

  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(value), delay)

    return () => window.clearTimeout(timer)
  }, [value, delay])

  return debounced
}

export function NewReturnFlow({
  open,
  terminalId,
  canSell,
  onClose,
  onCreated,
  onOpenReturn,
}: {
  open: boolean
  /** The till this browser is signed on to. Null when none has been chosen. */
  terminalId: number | null
  canSell: boolean
  onClose: () => void
  onCreated: () => void
  onOpenReturn: (returnId: number) => void
}) {
  const [step, setStep] = useState<Step>('sale')
  const [error, setError] = useState<string | null>(null)

  const [term, setTerm] = useState('')
  const debouncedTerm = useDebounced(term, 300)
  const [sales, setSales] = useState<Cart[] | null>(null)
  const [searching, setSearching] = useState(false)

  const [eligibility, setEligibility] = useState<ReturnEligibility | null>(null)
  const [loadingSale, setLoadingSale] = useState(false)
  const [quantities, setQuantities] = useState<Record<number, number>>({})
  const [conditions, setConditions] = useState<Record<number, ReturnCondition>>({})

  const [reason, setReason] = useState<string>('')
  const [note, setNote] = useState('')
  const [resolution, setResolution] = useState<ReturnResolution>('refund_original')
  const [restock, setRestock] = useState(true)

  const [itemTerm, setItemTerm] = useState('')
  const debouncedItemTerm = useDebounced(itemTerm, 300)
  const [itemResults, setItemResults] = useState<CatalogItem[]>([])
  const [replacements, setReplacements] = useState<Replacement[]>([])

  const [shiftId, setShiftId] = useState<number | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [created, setCreated] = useState<PosReturn | null>(null)
  /** Kept so a retry after a half-failure does not open a second replacement cart. */
  const exchangeCartId = useRef<number | null>(null)
  const inFlight = useRef(false)

  const reset = useCallback(() => {
    setStep('sale')
    setError(null)
    setTerm('')
    setSales(null)
    setEligibility(null)
    setQuantities({})
    setConditions({})
    setReason('')
    setNote('')
    setResolution('refund_original')
    setRestock(true)
    setItemTerm('')
    setItemResults([])
    setReplacements([])
    setCreated(null)
    exchangeCartId.current = null
    inFlight.current = false
  }, [])

  useEffect(() => {
    if (open) reset()
  }, [open, reset])

  // Which drawer a cash refund would come out of: the shift open on this till
  // now, never the one the original sale was rung up on.
  useEffect(() => {
    if (!open || terminalId === null) {
      setShiftId(null)

      return undefined
    }

    const controller = new AbortController()
    returnsService
      .currentShift(terminalId, controller.signal)
      .then((response) => setShiftId(response.data.session?.session_id ?? null))
      .catch(() => {
        if (!controller.signal.aborted) setShiftId(null)
      })

    return () => controller.abort()
  }, [open, terminalId])

  // Recent completed sales when the box is empty, matches once somebody types.
  useEffect(() => {
    if (!open || step !== 'sale') return undefined

    const controller = new AbortController()
    setSearching(true)

    const request =
      debouncedTerm.trim().length >= 2
        ? returnsService.findSales(debouncedTerm.trim(), controller.signal)
        : returnsService.recentSales(controller.signal)

    request
      .then((response) => setSales(response.data))
      .catch((failure: Error) => {
        if (controller.signal.aborted) return
        setSales([])
        setError(failure.message)
      })
      .finally(() => {
        if (!controller.signal.aborted) setSearching(false)
      })

    return () => controller.abort()
  }, [open, step, debouncedTerm])

  useEffect(() => {
    if (step !== 'replace' || debouncedItemTerm.trim().length < 2) {
      setItemResults([])

      return undefined
    }

    const controller = new AbortController()
    returnsService
      .searchItems(debouncedItemTerm.trim(), controller.signal)
      .then((response) => setItemResults(response.data))
      .catch(() => {
        if (!controller.signal.aborted) setItemResults([])
      })

    return () => controller.abort()
  }, [step, debouncedItemTerm])

  const chooseSale = async (cart: Cart) => {
    setLoadingSale(true)
    setError(null)
    try {
      const response = await returnsService.eligibility(cart.cart_id)
      setEligibility(response.data)
      setQuantities({})
      setConditions({})
      setStep('items')
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Could not open that sale.')
    } finally {
      setLoadingSale(false)
    }
  }

  /** What is still returnable for an item, after what this form has already claimed. */
  const remainingFor = useCallback(
    (itemId: number | null, exceptLineId: number): number => {
      if (!eligibility || itemId === null) return Number.POSITIVE_INFINITY

      const allowance = eligibility.items.find((entry) => entry.item_id === itemId)?.returnable_qty ?? 0
      const claimed = eligibility.lines
        .filter((line) => line.item_id === itemId && line.line_id !== exceptLineId)
        .reduce((sum, line) => sum + (quantities[line.line_id] ?? 0), 0)

      return Math.max(0, allowance - claimed)
    },
    [eligibility, quantities],
  )

  const setQuantity = (lineId: number, next: number) => {
    const line = eligibility?.lines.find((candidate) => candidate.line_id === lineId)
    if (!line) return

    const ceiling = Math.min(line.quantity, remainingFor(line.item_id, lineId))
    const clamped = Math.max(0, Math.min(next, ceiling))

    setQuantities((current) => ({ ...current, [lineId]: Number(clamped.toFixed(4)) }))
  }

  const selectedLines = useMemo(
    () => (eligibility?.lines ?? []).filter((line) => (quantities[line.line_id] ?? 0) > 0),
    [eligibility, quantities],
  )

  const returningQty = useMemo(
    () => selectedLines.reduce((sum, line) => sum + (quantities[line.line_id] ?? 0), 0),
    [selectedLines, quantities],
  )

  const returnValue = useMemo(
    () => selectedLines.reduce((sum, line) => sum + (quantities[line.line_id] ?? 0) * line.rate, 0),
    [selectedLines, quantities],
  )

  const replacementValue = useMemo(
    () => replacements.reduce((sum, entry) => sum + entry.quantity * (entry.item.sale_rate ?? 0), 0),
    [replacements],
  )

  const isExchange = resolution === 'exchange'
  const canBuildReplacement = isExchange && canSell && terminalId !== null
  const difference = replacementValue - returnValue

  const submit = async () => {
    if (!eligibility || inFlight.current) return

    inFlight.current = true
    setSubmitting(true)
    setError(null)

    try {
      // The replacement sale first: an open cart is not a financial commitment
      // and can be voided, whereas a return that is already recorded cannot be
      // un-taken if the cart then fails.
      if (canBuildReplacement && replacements.length > 0 && exchangeCartId.current === null) {
        const cart = await returnsService.openCart({
          terminal_id: terminalId,
          session_id: shiftId,
          order_kind: eligibility.cart.order_kind ?? 'retail',
          customer_account_id: eligibility.cart.customer_account_id,
          customer_name: eligibility.cart.customer_name,
          customer_mobile: eligibility.cart.customer_mobile,
        })
        exchangeCartId.current = cart.data.cart_id

        for (const entry of replacements) {
          await returnsService.addCartLine(cart.data.cart_id, {
            item_id: entry.item.item_id,
            quantity: entry.quantity,
            display_name: entry.item.item_name,
            unit_id: entry.item.unit_id,
            rate: entry.item.sale_rate,
            estimated_tax_pc: entry.item.tax_rate,
            tax_cat_id: entry.item.tax_cat_id,
          })
        }
      }

      const payload: NewReturnPayload = {
        cart_id: eligibility.cart.cart_id,
        terminal_id: terminalId ?? eligibility.cart.terminal_id,
        session_id: shiftId ?? eligibility.cart.session_id,
        customer_account_id: eligibility.cart.customer_account_id,
        resolution,
        restock,
        reason_code: reason,
        reason_note: note.trim() || null,
        exchange_cart_id: exchangeCartId.current,
        lines: selectedLines.map((line) => ({
          cart_line_id: line.line_id,
          item_id: line.item_id,
          unit_id: line.unit_id,
          warehouse_id: line.warehouse_id,
          batch_id: line.batch_id,
          display_name: line.display_name ?? 'Item',
          return_qty: quantities[line.line_id] ?? 0,
          rate: line.rate,
          condition_code: conditions[line.line_id] ?? 'good',
        })),
      }

      const response = await returnsService.create(payload)
      setCreated(response.data)

      if (exchangeCartId.current !== null) {
        // Parked rather than left open, so it shows up in the till's held bills
        // and the cashier can resume it to take the difference.
        try {
          await returnsService.holdCart(exchangeCartId.current, `Exchange ${response.data.return_no}`)
        } catch {
          // The cart exists either way; the success panel says where it is.
        }
      }

      setStep('done')
      onCreated()
    } catch (failure) {
      const message =
        failure instanceof ApiError
          ? failure.message
          : failure instanceof Error
            ? failure.message
            : 'The return could not be taken.'
      setError(
        exchangeCartId.current !== null
          ? `${message} The replacement sale is already on the till as an open cart; nothing has been credited.`
          : message,
      )
    } finally {
      setSubmitting(false)
      inFlight.current = false
    }
  }

  const stepOrder = useMemo<Step[]>(
    () =>
      isExchange && canBuildReplacement
        ? ['sale', 'items', 'settle', 'replace', 'review']
        : ['sale', 'items', 'settle', 'review'],
    [isExchange, canBuildReplacement],
  )

  // Changing the settlement changes the sequence — an exchange gains a
  // replacement step and losing it must not leave the drawer on a step that no
  // longer exists, with Back and Continue both doing nothing.
  useEffect(() => {
    if (step !== 'done' && !stepOrder.includes(step)) setStep('review')
  }, [step, stepOrder])

  const canContinue =
    (step === 'sale' && eligibility !== null) ||
    (step === 'items' && selectedLines.length > 0) ||
    (step === 'settle' && reason !== '') ||
    step === 'replace' ||
    step === 'review'

  const goNext = () => {
    const index = stepOrder.indexOf(step)
    if (index >= 0 && index < stepOrder.length - 1) setStep(stepOrder[index + 1])
  }

  const goBack = () => {
    const index = stepOrder.indexOf(step)
    if (index > 0) setStep(stepOrder[index - 1])
  }

  return (
    <Drawer
      open={open}
      size="wide"
      eyebrow="New return"
      title={STEP_TITLES[step]}
      onClose={onClose}
      footer={
        step === 'done' ? (
          <>
            <button type="button" className="returns-button returns-button--ghost" onClick={reset}>
              Take another return
            </button>
            <button
              type="button"
              className="returns-button returns-button--primary"
              onClick={() => {
                if (created) onOpenReturn(created.return_id)
                onClose()
              }}
            >
              Open this return
            </button>
          </>
        ) : (
          <>
            <button
              type="button"
              className="returns-button returns-button--ghost"
              onClick={goBack}
              disabled={stepOrder.indexOf(step) === 0 || submitting}
            >
              <ArrowLeft size={15} aria-hidden />
              Back
            </button>

            {step === 'review' ? (
              <button
                type="button"
                className="returns-button returns-button--primary"
                onClick={() => void submit()}
                disabled={submitting || selectedLines.length === 0}
              >
                <Check size={15} aria-hidden />
                {submitting ? 'Taking the return…' : 'Confirm and take the return'}
              </button>
            ) : (
              <button
                type="button"
                className="returns-button returns-button--primary"
                onClick={goNext}
                disabled={!canContinue}
              >
                Continue
                <ArrowRight size={15} aria-hidden />
              </button>
            )}
          </>
        )
      }
    >
      {step !== 'done' && (
        <ol className="returns-steps" aria-label="Steps">
          {stepOrder.map((candidate, index) => (
            <li
              key={candidate}
              className={
                candidate === step
                  ? 'returns-steps__item returns-steps__item--current'
                  : stepOrder.indexOf(step) > index
                    ? 'returns-steps__item returns-steps__item--done'
                    : 'returns-steps__item'
              }
              aria-current={candidate === step ? 'step' : undefined}
            >
              <span className="returns-steps__number">{index + 1}</span>
              {STEP_TITLES[candidate]}
            </li>
          ))}
        </ol>
      )}

      {error && (
        <Notice tone="danger" onDismiss={() => setError(null)}>
          {error}
        </Notice>
      )}

      {step === 'sale' && (
        <>
          <label className="returns-field">
            <span>Bill number, customer, mobile or token</span>
            <span className="returns-search returns-search--inline">
              <Search size={15} aria-hidden className="returns-search__icon" />
              <input
                type="search"
                value={term}
                onChange={(event) => setTerm(event.target.value)}
                placeholder="INV-02658, 98xxxxxx21, Amit…"
                autoComplete="off"
              />
            </span>
          </label>

          <p className="pos-note">
            Only completed sales taken on this POS can be returned against. A sale billed elsewhere has to be credited
            in Smart Books.
          </p>

          {searching && !sales && <p className="pos-muted">Looking…</p>}

          {sales && sales.length === 0 && (
            <p className="pos-muted">
              {debouncedTerm.trim().length >= 2 ? 'No completed sale matches that.' : 'No completed sales yet.'}
            </p>
          )}

          <ul className="returns-salelist">
            {(sales ?? []).map((cart) => (
              <li key={cart.cart_id}>
                <button
                  type="button"
                  className="returns-sale"
                  onClick={() => void chooseSale(cart)}
                  disabled={loadingSale}
                >
                  <span className="returns-sale__head">
                    <strong>{cart.books_voucher_no ?? `Sale #${cart.cart_id}`}</strong>
                    <span className="num">{money(cart.total_amount)}</span>
                  </span>
                  <span className="returns-sale__meta">
                    {cart.customer_name ?? 'Walk-in'} · {formatDate(cart.created_at.slice(0, 10))}
                    {cart.token_no ? ` · Token ${cart.token_no}` : ''}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </>
      )}

      {step === 'items' && eligibility && (
        <>
          <div className="returns-sale-summary">
            <div>
              <strong>{eligibility.cart.books_voucher_no ?? `Sale #${eligibility.cart.cart_id}`}</strong>
              <span className="pos-muted">
                {eligibility.cart.customer_name ?? 'Walk-in'} · {formatDate(eligibility.cart.created_at.slice(0, 10))}
              </span>
            </div>
            <span className="num">{money(eligibility.cart.total_amount)}</span>
          </div>

          {eligibility.returns.length > 0 && (
            <Notice tone="info" title="This sale has been returned against before">
              {eligibility.returns.map((prior) => `${prior.return_no} (${money(prior.refund_amount)})`).join(', ')}. The
              quantities below already allow for them.
            </Notice>
          )}

          <div className="pos-table-wrap">
            <table className="pos-table returns-itemtable">
              <thead>
                <tr>
                  <th scope="col">Item</th>
                  <th scope="col" className="is-number">
                    Sold
                  </th>
                  <th scope="col" className="is-number">
                    Returnable
                  </th>
                  <th scope="col" className="is-number">
                    Rate
                  </th>
                  <th scope="col">Coming back</th>
                  <th scope="col">Condition</th>
                </tr>
              </thead>
              <tbody>
                {eligibility.lines.map((line) => {
                  const chosen = quantities[line.line_id] ?? 0
                  const ceiling = Math.min(line.quantity, remainingFor(line.item_id, line.line_id))

                  return (
                    <tr key={line.line_id}>
                      <td>{line.display_name ?? `Item #${line.item_id ?? '—'}`}</td>
                      <td className="is-number">{decimal(line.quantity, 3)}</td>
                      <td className="is-number">{decimal(ceiling, 3)}</td>
                      <td className="is-number">{money(line.rate)}</td>
                      <td>
                        <span className="returns-stepper">
                          <button
                            type="button"
                            onClick={() => setQuantity(line.line_id, chosen - 1)}
                            disabled={chosen <= 0}
                            aria-label={`One fewer ${line.display_name ?? 'item'}`}
                          >
                            <Minus size={14} aria-hidden />
                          </button>
                          <input
                            type="number"
                            min={0}
                            max={ceiling}
                            step="0.001"
                            value={chosen}
                            onChange={(event) => setQuantity(line.line_id, Number.parseFloat(event.target.value) || 0)}
                            aria-label={`Quantity of ${line.display_name ?? 'item'} coming back`}
                          />
                          <button
                            type="button"
                            onClick={() => setQuantity(line.line_id, chosen + 1)}
                            disabled={chosen >= ceiling}
                            aria-label={`One more ${line.display_name ?? 'item'}`}
                          >
                            <Plus size={14} aria-hidden />
                          </button>
                        </span>
                      </td>
                      <td>
                        <select
                          value={conditions[line.line_id] ?? 'good'}
                          disabled={chosen <= 0}
                          aria-label={`Condition of ${line.display_name ?? 'item'}`}
                          onChange={(event) =>
                            setConditions((current) => ({
                              ...current,
                              [line.line_id]: event.target.value as ReturnCondition,
                            }))
                          }
                        >
                          {CONDITIONS.map((condition) => (
                            <option key={condition} value={condition}>
                              {CONDITION_TERMS[condition].label}
                            </option>
                          ))}
                        </select>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>

          <div className="returns-runningtotal">
            <span>Coming back</span>
            <strong className="num">{money(returnValue)}</strong>
          </div>
        </>
      )}

      {step === 'settle' && (
        <>
          <label className="returns-field">
            <span>Why are the goods coming back?</span>
            <select value={reason} onChange={(event) => setReason(event.target.value)} required>
              <option value="">Choose a reason</option>
              {REASON_CHOICES.map((code) => (
                <option key={code} value={code}>
                  {REASON_TERMS[code].label}
                </option>
              ))}
            </select>
          </label>

          <label className="returns-field">
            <span>Anything to add (optional)</span>
            <textarea
              value={note}
              onChange={(event) => setNote(event.target.value)}
              rows={2}
              placeholder="What the customer said, a slip reference…"
            />
          </label>

          <fieldset className="returns-fieldset">
            <legend>How is the customer being settled?</legend>
            <div className="returns-checks">
              {(Object.keys(RESOLUTION_TERMS) as ReturnResolution[]).map((option) => {
                const cashWithoutShift = option === 'refund_cash' && shiftId === null

                return (
                  <label key={option} className="returns-check">
                    <input
                      type="radio"
                      name="resolution"
                      value={option}
                      checked={resolution === option}
                      disabled={cashWithoutShift}
                      onChange={() => setResolution(option)}
                    />
                    <span>
                      {RESOLUTION_TERMS[option].label}
                      <small>
                        {cashWithoutShift
                          ? 'No till is open on this terminal, so cash cannot come out of a drawer'
                          : RESOLUTION_TERMS[option].description}
                      </small>
                    </span>
                  </label>
                )
              })}
            </div>
          </fieldset>

          <label className="returns-check returns-check--single">
            <input type="checkbox" checked={restock} onChange={(event) => setRestock(event.target.checked)} />
            <span>
              Put the goods back into stock
              <small>
                Untick for goods written off at the counter. Inventory is told either way — stock nobody recorded is
                stock nobody can find.
              </small>
            </span>
          </label>
        </>
      )}

      {step === 'replace' && (
        <>
          <p className="pos-note">
            The replacement is a normal sale: Inventory prices it and Smart Books invoices it. It is parked on this till
            as a held bill for you to take the difference on.
          </p>

          <label className="returns-field">
            <span>Find the replacement item</span>
            <span className="returns-search returns-search--inline">
              <Search size={15} aria-hidden className="returns-search__icon" />
              <input
                type="search"
                value={itemTerm}
                onChange={(event) => setItemTerm(event.target.value)}
                placeholder="Item name or code…"
                autoComplete="off"
              />
            </span>
          </label>

          {itemResults.length > 0 && (
            <ul className="returns-salelist">
              {itemResults.map((item) => (
                <li key={item.item_id}>
                  <button
                    type="button"
                    className="returns-sale"
                    onClick={() => {
                      setReplacements((current) =>
                        current.some((entry) => entry.item.item_id === item.item_id)
                          ? current.map((entry) =>
                              entry.item.item_id === item.item_id
                                ? { ...entry, quantity: entry.quantity + 1 }
                                : entry,
                            )
                          : [...current, { item, quantity: 1 }],
                      )
                      setItemTerm('')
                    }}
                  >
                    <span className="returns-sale__head">
                      <strong>{item.item_name}</strong>
                      <span className="num">{money(item.sale_rate ?? 0)}</span>
                    </span>
                    <span className="returns-sale__meta">{item.item_code}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}

          {replacements.length > 0 && (
            <ul className="returns-replacements">
              {replacements.map((entry) => (
                <li key={entry.item.item_id}>
                  <span>{entry.item.item_name}</span>
                  <span className="returns-stepper">
                    <button
                      type="button"
                      aria-label={`One fewer ${entry.item.item_name}`}
                      onClick={() =>
                        setReplacements((current) =>
                          current
                            .map((candidate) =>
                              candidate.item.item_id === entry.item.item_id
                                ? { ...candidate, quantity: candidate.quantity - 1 }
                                : candidate,
                            )
                            .filter((candidate) => candidate.quantity > 0),
                        )
                      }
                    >
                      <Minus size={14} aria-hidden />
                    </button>
                    <output className="num">{entry.quantity}</output>
                    <button
                      type="button"
                      aria-label={`One more ${entry.item.item_name}`}
                      onClick={() =>
                        setReplacements((current) =>
                          current.map((candidate) =>
                            candidate.item.item_id === entry.item.item_id
                              ? { ...candidate, quantity: candidate.quantity + 1 }
                              : candidate,
                          ),
                        )
                      }
                    >
                      <Plus size={14} aria-hidden />
                    </button>
                  </span>
                  <strong className="num">{money(entry.quantity * (entry.item.sale_rate ?? 0))}</strong>
                  <button
                    type="button"
                    className="returns-icon-button"
                    aria-label={`Remove ${entry.item.item_name}`}
                    onClick={() =>
                      setReplacements((current) =>
                        current.filter((candidate) => candidate.item.item_id !== entry.item.item_id),
                      )
                    }
                  >
                    <Trash2 size={15} aria-hidden />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </>
      )}

      {step === 'review' && eligibility && (
        <>
          <dl className="returns-detail__grid">
            <div className="returns-detail__row">
              <dt>Original sale</dt>
              <dd>
                {eligibility.cart.books_voucher_no ?? `Sale #${eligibility.cart.cart_id}`} ·{' '}
                {money(eligibility.cart.total_amount)}
              </dd>
            </div>
            <div className="returns-detail__row">
              <dt>Coming back</dt>
              <dd>
                {selectedLines.length} line{selectedLines.length === 1 ? '' : 's'} ·{' '}
                {decimal(returningQty, 3)} item{returningQty === 1 ? '' : 's'}
              </dd>
            </div>
            <div className="returns-detail__row">
              <dt>Reason</dt>
              <dd>{reason ? REASON_TERMS[reason]?.label ?? reason : 'Not chosen'}</dd>
            </div>
            <div className="returns-detail__row">
              <dt>Settled as</dt>
              <dd>{RESOLUTION_TERMS[resolution].label}</dd>
            </div>
          </dl>

          <div className="returns-totals">
            <div className="pos-split">
              <span>Value coming back</span>
              <strong className="num">{money(returnValue)}</strong>
            </div>

            {isExchange && (
              <>
                <div className="pos-split">
                  <span>Replacement goods</span>
                  <strong className="num">{money(replacementValue)}</strong>
                </div>
                <div className="pos-split pos-split--total pos-split--emphasis">
                  <span>{difference >= 0 ? 'Difference payable by the customer' : 'Difference refundable'}</span>
                  <strong className="num">{money(Math.abs(difference))}</strong>
                </div>
              </>
            )}

            {!isExchange && (
              <div className="pos-split pos-split--total pos-split--emphasis">
                <span>To be credited</span>
                <strong className="num">{money(returnValue)}</strong>
              </div>
            )}
          </div>

          <p className="pos-note">
            These figures are a preview built from the sale's own prices. The amount recorded is the one the server
            computes from the lines it receives, and the tax on the credit note is Smart Books'. Nothing is credited
            until the return is approved and settled.
          </p>

          {isExchange && replacements.length === 0 && (
            <Notice tone="info" title="No replacement goods chosen">
              The return will be recorded as an exchange. Ring the replacement up on the till as a normal sale.
            </Notice>
          )}
        </>
      )}

      {step === 'done' && created && (
        <div className="returns-success">
          <span className="returns-success__mark" aria-hidden>
            <Check size={26} />
          </span>
          <h3>{created.return_no} taken</h3>
          <p className="pos-muted">
            {money(created.refund_amount)} recorded as {RESOLUTION_TERMS[created.resolution as ReturnResolution]?.label ?? created.resolution}.
            It is a draft until somebody with the permission approves it, so nothing has been credited yet.
          </p>

          {exchangeCartId.current !== null && (
            <Notice tone="info" title="The replacement sale is on the till">
              It is held as <strong>Exchange {created.return_no}</strong>. Resume it from the till to take{' '}
              {money(Math.abs(difference))} {difference >= 0 ? 'from' : 'back to'} the customer.
            </Notice>
          )}
        </div>
      )}
    </Drawer>
  )
}
