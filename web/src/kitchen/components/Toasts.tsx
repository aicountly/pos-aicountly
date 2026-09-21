/**
 * The kitchen's own toasts.
 *
 * This application has no global snackbar, and adding one for this screen
 * would be a fleet-wide decision taken to solve a local problem. These are
 * scoped to the kitchen page, they carry a polite live region so a status
 * change is announced rather than only drawn, and they clear themselves.
 */

import { memo } from 'react'
import { CircleCheck, TriangleAlert } from 'lucide-react'

export interface Toast {
  id: number
  tone: 'ok' | 'bad'
  message: string
}

export const Toasts = memo(function Toasts({ toasts }: { toasts: Toast[] }) {
  return (
    <div className="kds-toasts" role="status" aria-live="polite">
      {toasts.map((toast) => (
        <div key={toast.id} className={`kds-toast kds-toast--${toast.tone}`}>
          {toast.tone === 'ok' ? (
            <CircleCheck size={16} aria-hidden style={{ flexShrink: 0, marginTop: 1, color: 'var(--success)' }} />
          ) : (
            <TriangleAlert size={16} aria-hidden style={{ flexShrink: 0, marginTop: 1, color: 'var(--danger)' }} />
          )}
          <span>{toast.message}</span>
        </div>
      ))}
    </div>
  )
})
