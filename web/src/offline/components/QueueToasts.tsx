/**
 * Small confirmations, bottom right.
 *
 * A cashier who presses Post needs to be told the sale went, by name — "it
 * disappeared from the list" is not confirmation, it is the same thing a lost
 * sale looks like. Anything that FAILED does not auto-dismiss: a message about
 * money that did not arrive should not time out while someone serves a queue.
 */

import { useEffect } from 'react'
import { AlertTriangle, CheckCircle2, Info, XCircle } from 'lucide-react'

export type ToastTone = 'success' | 'warning' | 'danger' | 'info'

export interface Toast {
  id: number
  tone: ToastTone
  title: string
  detail?: string
}

const ICON = {
  success: CheckCircle2,
  warning: AlertTriangle,
  danger: XCircle,
  info: Info,
}

function ToastRow({ toast, onDismiss }: { toast: Toast; onDismiss: (id: number) => void }) {
  const Icon = ICON[toast.tone]

  useEffect(() => {
    // Failures stay until they are read and dismissed.
    if (toast.tone === 'danger' || toast.tone === 'warning') return

    const timer = window.setTimeout(() => onDismiss(toast.id), 5000)
    return () => window.clearTimeout(timer)
  }, [toast.id, toast.tone, onDismiss])

  return (
    <div className={`q-toast q-toast--${toast.tone}`} role={toast.tone === 'danger' ? 'alert' : 'status'}>
      <Icon
        size={15}
        aria-hidden
        style={{
          marginTop: 1,
          color:
            toast.tone === 'success'
              ? 'var(--q-green)'
              : toast.tone === 'danger'
                ? 'var(--q-red)'
                : toast.tone === 'warning'
                  ? 'var(--q-amber)'
                  : 'var(--q-blue)',
        }}
      />
      <div style={{ minWidth: 0 }}>
        <strong>{toast.title}</strong>
        {toast.detail && <span>{toast.detail}</span>}
      </div>
      <button type="button" className="q-toast__close" onClick={() => onDismiss(toast.id)} aria-label="Dismiss">
        &times;
      </button>
    </div>
  )
}

export function QueueToasts({ toasts, onDismiss }: { toasts: Toast[]; onDismiss: (id: number) => void }) {
  if (toasts.length === 0) return null

  return (
    <div className="q-toasts">
      {toasts.map((toast) => (
        <ToastRow key={toast.id} toast={toast} onDismiss={onDismiss} />
      ))}
    </div>
  )
}
