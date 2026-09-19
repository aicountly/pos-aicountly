/**
 * One return, in full.
 *
 * THE THREE STEPS ARE THREE BUTTONS, and that is deliberate — it is how this
 * product has always worked and the reason survives the redesign. The goods
 * coming back (Inventory), the credit note (Books) and the counter's approval
 * are three different products' decisions; one button that silently did all
 * three would hide which of them failed, and the cashier is standing in front
 * of a customer.
 *
 * NOTHING HERE IS INVENTED. Where POS does not record a timestamp for a step,
 * this panel says so rather than showing the row's `updated_at` under a label
 * that implies otherwise. The timeline is the audit log when the viewer may see
 * it, and is absent when they may not.
 */

import { useCallback, useEffect, useState } from 'react'
import { PackageCheck, Printer, Receipt, ThumbsUp } from 'lucide-react'
import { CommandStrip } from '../components/CommandStrip'
import { dateTime, decimal, money, titleCase } from '../dashboards/format'
import { StatusBadge } from '../dashboards/shell'
import { Notice } from '../ui'
import { returnsService } from '../services/returns'
import { Drawer } from './Drawer'
import {
  CHANNEL_TERMS,
  CONDITION_TERMS,
  labelFor,
  REASON_TERMS,
  RESOLUTION_TERMS,
  STATUS_TERMS,
  termFor,
} from './vocabulary'
import type { ReturnAuditEntry } from './types'
import type { PosReturn } from '../services/types'

type Step = 'approve' | 'receive' | 'settle'

const STEP_LABELS: Record<Step, string> = {
  approve: 'Approve',
  receive: 'Take the goods back',
  settle: 'Raise the credit note',
}

const AUDIT_ACTIONS: Record<string, string> = {
  'return.created': 'Return taken at the counter',
  'return.approved': 'Approved',
  'return.received': 'Goods booked back in',
  'return.settled': 'Credit note raised',
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="returns-detail__row">
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="returns-detail__section">
      <h3>{title}</h3>
      {children}
    </section>
  )
}

export function ReturnDetailsDrawer({
  returnId,
  open,
  can,
  onClose,
  onChanged,
}: {
  returnId: number | null
  open: boolean
  can: (permission: string) => boolean
  onClose: () => void
  /** Fired whenever the record changes, so the register behind can refresh. */
  onChanged: () => void
}) {
  const [record, setRecord] = useState<PosReturn | null>(null)
  const [audit, setAudit] = useState<ReturnAuditEntry[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState<Step | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(
    async (signal?: AbortSignal) => {
      if (returnId === null) return
      setLoading(true)
      try {
        const response = await returnsService.one(returnId, signal)
        setRecord(response.data)
        setError(null)
      } catch (failure) {
        if (signal?.aborted) return
        setRecord(null)
        setError(failure instanceof Error ? failure.message : 'Could not load that return.')
      } finally {
        if (!signal?.aborted) setLoading(false)
      }
    },
    [returnId],
  )

  useEffect(() => {
    if (!open || returnId === null) {
      setRecord(null)
      setAudit(null)

      return undefined
    }

    const controller = new AbortController()
    void load(controller.signal)

    return () => controller.abort()
  }, [open, returnId, load])

  // The audit log is a separate permission from the return itself, so it is
  // fetched separately and its absence is not an error on this panel.
  useEffect(() => {
    if (!open || returnId === null || !can('reports.view')) {
      setAudit(null)

      return undefined
    }

    const controller = new AbortController()
    returnsService
      .auditTrail(returnId, controller.signal)
      .then((response) => setAudit(response.data))
      .catch(() => {
        if (!controller.signal.aborted) setAudit([])
      })

    return () => controller.abort()
  }, [open, returnId, can])

  const advance = async (step: Step) => {
    if (!record) return
    setBusy(step)
    setError(null)
    try {
      const response = await returnsService.advance(record.return_id, step)
      setRecord(response.data)
      onChanged()
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'That step did not go through.')
    } finally {
      setBusy(null)
    }
  }

  const status = record ? termFor(STATUS_TERMS, record.status) : null
  const resolution = record ? RESOLUTION_TERMS[record.resolution as keyof typeof RESOLUTION_TERMS] : undefined
  const context = record?.context

  const steps: Step[] = []
  if (record) {
    if (record.status === 'DRAFT' && can('return.approve')) steps.push('approve')
    if (record.status === 'APPROVED' && can('return.approve')) steps.push('receive')
    if ((record.status === 'RECEIVED' || record.status === 'APPROVED') && can('refund.give')) steps.push('settle')
  }

  return (
    <Drawer
      open={open}
      eyebrow="Return"
      title={record?.return_no ?? (loading ? 'Loading…' : 'Return')}
      badge={status ? <StatusBadge tone={status.tone ?? 'neutral'}>{status.label}</StatusBadge> : undefined}
      onClose={onClose}
      actions={
        record ? (
          <button
            type="button"
            className="returns-button returns-button--secondary"
            onClick={() => window.print()}
            title="Print this return as a counter acknowledgement"
          >
            <Printer size={15} aria-hidden />
            Print
          </button>
        ) : undefined
      }
      footer={
        steps.length > 0 ? (
          <>
            <p className="pos-muted returns-detail__footnote">
              Each step is a separate decision, so a failure names the product that refused it.
            </p>
            {steps.map((step) => (
              <button
                key={step}
                type="button"
                className="returns-button returns-button--primary"
                disabled={busy !== null}
                onClick={() => void advance(step)}
              >
                {step === 'approve' && <ThumbsUp size={15} aria-hidden />}
                {step === 'receive' && <PackageCheck size={15} aria-hidden />}
                {step === 'settle' && <Receipt size={15} aria-hidden />}
                {busy === step ? 'Working…' : STEP_LABELS[step]}
              </button>
            ))}
          </>
        ) : undefined
      }
    >
      {error && (
        <Notice tone="danger" onDismiss={() => setError(null)}>
          {error}
        </Notice>
      )}

      {loading && !record && (
        <div className="returns-skeleton-stack" aria-hidden>
          {[0, 1, 2, 3, 4, 5].map((index) => (
            <span key={index} className="returns-skeleton returns-skeleton--line" />
          ))}
        </div>
      )}

      {record && (
        <>
          {record.commands && record.commands.length > 0 && <CommandStrip commands={record.commands} />}

          <Section title="Overview">
            <dl className="returns-detail__grid">
              <Row label="Return date">{dateTime(record.created_at)}</Row>
              <Row label="Original invoice">{record.books_invoice_no ?? 'Not linked to a POS sale'}</Row>
              <Row label="Customer">{context?.customer_name ?? 'Walk-in'}</Row>
              {context?.customer_mobile && <Row label="Mobile">{context.customer_mobile}</Row>}
              <Row label="Channel">
                {context?.channel ? labelFor(CHANNEL_TERMS, context.channel) : 'No linked sale'}
              </Row>
              <Row label="Till">{context?.terminal_name ?? context?.terminal_code ?? 'Not recorded'}</Row>
              <Row label="Settled as">{resolution?.label ?? titleCase(record.resolution)}</Row>
              <Row label="Reason">
                {record.reason_code ? labelFor(REASON_TERMS, record.reason_code) : 'Not stated'}
                {record.reason_note && <small className="pos-muted">{record.reason_note}</small>}
              </Row>
              <Row label="Back on the shelf">{record.restock ? 'Yes, restocked' : 'No, written off'}</Row>
            </dl>
          </Section>

          <Section title="What came back">
            <div className="pos-table-wrap">
              <table className="pos-table">
                <thead>
                  <tr>
                    <th scope="col">Item</th>
                    <th scope="col" className="is-number">
                      Qty
                    </th>
                    <th scope="col" className="is-number">
                      Rate
                    </th>
                    <th scope="col" className="is-number">
                      Amount
                    </th>
                    <th scope="col">Condition</th>
                  </tr>
                </thead>
                <tbody>
                  {record.lines.map((line) => (
                    <tr key={line.line_id}>
                      <td>{line.display_name ?? `Item #${line.item_id ?? '—'}`}</td>
                      <td className="is-number">{decimal(line.return_qty, 3)}</td>
                      <td className="is-number">{money(line.rate)}</td>
                      <td className="is-number">{money(line.line_amount)}</td>
                      <td>{labelFor(CONDITION_TERMS, line.condition_code)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Section>

          <Section title="Settlement">
            <dl className="returns-detail__grid">
              {context?.sale_total != null && <Row label="Original sale">{money(context.sale_total)}</Row>}
              <Row label="Value returned">
                <strong>{money(record.refund_amount)}</strong>
              </Row>
              <Row label="How">{resolution?.description ?? titleCase(record.resolution)}</Row>
              {context?.exchange_sale && (
                <>
                  <Row label="Replacement sale">
                    {context.exchange_sale.invoice_no ?? `Cart #${context.exchange_sale.cart_id}`} ·{' '}
                    {titleCase(context.exchange_sale.status)}
                  </Row>
                  <Row label="Replacement value">{money(context.exchange_sale.total_amount)}</Row>
                  <Row
                    label={
                      context.exchange_sale.total_amount >= record.refund_amount
                        ? 'Difference payable'
                        : 'Difference refundable'
                    }
                  >
                    <strong>{money(Math.abs(context.exchange_sale.total_amount - record.refund_amount))}</strong>
                  </Row>
                </>
              )}
            </dl>

            <p className="pos-note">
              The tax on the credit note is computed by Smart Books when it raises it, not here. This panel shows what
              the counter agreed; Books holds what was posted.
            </p>
          </Section>

          <Section title="References">
            <dl className="returns-detail__grid">
              <Row label="Credit note">{record.books_credit_note_uuid ?? 'Not raised yet'}</Row>
              <Row label="Stock document">{record.inventory_document_uuid ?? 'Not booked in yet'}</Row>
              <Row label="Original invoice reference">{record.books_invoice_uuid ?? '—'}</Row>
            </dl>
          </Section>

          {audit !== null && (
            <Section title="Timeline">
              {audit.length === 0 ? (
                <p className="pos-muted">Nothing has been recorded against this return yet.</p>
              ) : (
                <ul className="pos-timeline">
                  {audit.map((entry) => (
                    <li key={entry.audit_id}>
                      <div className="pos-timeline__head">
                        <span className="pos-timeline__action">
                          {AUDIT_ACTIONS[entry.action] ?? titleCase(entry.action)}
                        </span>
                        <span className="pos-muted">{dateTime(entry.created_at)}</span>
                      </div>
                      {entry.reason && <p className="pos-timeline__detail">{entry.reason}</p>}
                    </li>
                  ))}
                </ul>
              )}
            </Section>
          )}

          <Section title="Audit">
            <dl className="returns-detail__grid">
              <Row label="Taken by">{record.created_by}</Row>
              <Row label="Taken at">{dateTime(record.created_at)}</Row>
              <Row label="Approved by">{record.approved_by ?? 'Not approved yet'}</Row>
              <Row label="Last changed">{dateTime(record.updated_at)}</Row>
            </dl>
            {!can('reports.view') && (
              <p className="pos-note">
                The full change history needs the reports permission, so it is not shown here rather than shown empty.
              </p>
            )}
          </Section>
        </>
      )}
    </Drawer>
  )
}
