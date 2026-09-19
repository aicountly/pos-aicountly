/**
 * Shift readiness.
 *
 * Every row is a column this product actually keeps. There is deliberately no
 * "receipt paper" check: a browser cannot see how much paper is in a till, so
 * the row says whether a printer was ever CONFIGURED, which is the fact POS
 * has. The ring is the share of the checks below it that pass, and it is only
 * ever drawn over checks that apply.
 */

import { Check, Circle, Minus } from 'lucide-react'
import { count, percent } from '../../format'
import { ContextualEmpty, Panel } from '../../shell'
import type { RetailBoard, RetailReadinessCheck } from '../../types'

function Mark({ check }: { check: RetailReadinessCheck }) {
  const done = check.ready >= check.of
  const partial = !done && check.ready > 0

  return (
    <span
      className={`pos-readiness__mark pos-readiness__mark--${done ? 'done' : partial ? 'part' : 'none'}`}
      aria-hidden
    >
      {done ? <Check size={14} strokeWidth={3} /> : partial ? <Minus size={14} strokeWidth={3} /> : <Circle size={12} />}
    </span>
  )
}

function Ring({ value }: { value: number }) {
  const radius = 40
  const circumference = 2 * Math.PI * radius
  const clamped = Math.max(0, Math.min(100, value))

  return (
    <div className="pos-readiness__ring">
      <svg viewBox="0 0 96 96" role="img" aria-label={`${Math.round(clamped)} per cent of the readiness checks pass`}>
        <circle className="pos-readiness__track" cx="48" cy="48" r={radius} fill="none" strokeWidth="10" />
        <circle
          className="pos-readiness__value"
          cx="48"
          cy="48"
          r={radius}
          fill="none"
          strokeWidth="10"
          strokeLinecap="round"
          strokeDasharray={`${(clamped / 100) * circumference} ${circumference}`}
          transform="rotate(-90 48 48)"
        />
        <text className="pos-readiness__pc" x="48" y="50" textAnchor="middle">
          {Math.round(clamped)}%
        </text>
        <text className="pos-readiness__of" x="48" y="64" textAnchor="middle">
          ready
        </text>
      </svg>
    </div>
  )
}

export function ShiftReadiness({ board }: { board: RetailBoard }) {
  const readiness = board.readiness

  return (
    <Panel title="Shift readiness">
      {!readiness.available ? (
        <ContextualEmpty title="No active shifts">
          {readiness.note} Open a till shift to begin retail operations.
        </ContextualEmpty>
      ) : (
        <>
          <div className="pos-readiness">
            <Ring value={readiness.percent ?? 0} />

            <div>
              <strong style={{ display: 'block', marginBottom: 10, fontSize: 13 }}>
                {count(readiness.ready)} of {count(readiness.total)} counter
                {readiness.total === 1 ? '' : 's'} ready
              </strong>

              <ul className="pos-readiness__checks">
                {readiness.checks.map((check) => (
                  <li key={check.key} className="pos-readiness__check" title={check.note}>
                    <Mark check={check} />
                    {/* The tick is decoration; this is the state, in words and
                        in figures, for anyone the colour does not reach. */}
                    <span>{check.label}</span>
                    <span>
                      {count(check.ready)}/{count(check.of)}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          </div>

          <p className="pos-note">
            {readiness.note}
            {readiness.percent !== null && ` Currently ${percent(readiness.percent, 0)}.`}
          </p>
        </>
      )}
    </Panel>
  )
}
