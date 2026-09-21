/**
 * Result messages for cash actions.
 *
 * POS ships no toast library, and this is not a reason to add one: a list, a
 * role and a dismiss button is the whole requirement. `role="status"` on the
 * region means a screen reader hears "Cash deposit recorded" without the focus
 * moving, which is exactly right for a confirmation.
 *
 * A failure is never announced as a success. The tone comes from what the API
 * answered, not from the fact that a button was pressed.
 */

import { CheckCircle2, TriangleAlert, X } from 'lucide-react'

export interface Toast {
  id: number
  tone: 'success' | 'danger'
  message: string
}

export function Toasts({ toasts, onDismiss }: { toasts: Toast[]; onDismiss: (id: number) => void }) {
  if (toasts.length === 0) return null

  return (
    <div className="cc-toasts" role="status" aria-live="polite">
      {toasts.map((toast) => (
        <div key={toast.id} className={`cc-toast cc-toast--${toast.tone}`}>
          <span className="cc-toast__icon" aria-hidden>
            {toast.tone === 'success' ? <CheckCircle2 size={16} /> : <TriangleAlert size={16} />}
          </span>
          <span className="cc-toast__body">{toast.message}</span>
          <button type="button" className="cc-toast__dismiss" aria-label="Dismiss" onClick={() => onDismiss(toast.id)}>
            <X size={14} aria-hidden />
          </button>
        </div>
      ))}
    </div>
  )
}
