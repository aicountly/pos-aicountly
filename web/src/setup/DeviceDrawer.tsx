/**
 * Pairing a device with a till.
 *
 * The token this issues is what lets a machine post sales while nobody is
 * signed in, so it is handled as a credential and not as a field:
 *
 *   • The server keeps only sha256 of it. There is no endpoint that can read
 *     one back, which is why losing it means pairing again rather than looking
 *     it up.
 *   • It is shown once, in component state, and goes nowhere else — not
 *     localStorage, not the URL, not a log line.
 *   • Leaving this step is a deliberate click, so the code cannot disappear
 *     behind an accidental Escape before it has been copied.
 */

import { Fragment, useMemo, useState } from 'react'
import { Check, Copy, Loader2, ShieldCheck } from 'lucide-react'
import { pairDevice } from './data'
import type { SetupOutlet, SetupTill } from './types'
import { outletName, tillName } from './types'
import { Drawer, Field, Section, useToast } from './ui'

type Stage = 'choose' | 'issued'

export function DeviceDrawer({
  outlets,
  tills,
  defaultTillId,
  onClose,
  onPaired,
}: {
  outlets: SetupOutlet[]
  tills: SetupTill[]
  defaultTillId?: number | null
  onClose: () => void
  onPaired: () => void
}) {
  const toast = useToast()
  const usableTills = useMemo(
    () =>
      tills.filter(
        (till) =>
          till.is_active !== false &&
          outlets.find((outlet) => outlet.location_id === till.location_id)?.is_active !== false,
      ),
    [tills, outlets],
  )

  const seed = usableTills.find((till) => till.terminal_id === defaultTillId) ?? usableTills[0] ?? null

  const [locationId, setLocationId] = useState<number | null>(seed?.location_id ?? null)
  const [terminalId, setTerminalId] = useState<number | null>(seed?.terminal_id ?? null)
  const [label, setLabel] = useState('')
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [stage, setStage] = useState<Stage>('choose')
  const [busy, setBusy] = useState(false)
  const [token, setToken] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  const tillsHere = usableTills.filter((till) => till.location_id === locationId)
  const sellable = outlets.filter((outlet) => outlet.is_active !== false)

  async function issue(event: React.FormEvent) {
    event.preventDefault()
    if (busy) return

    const found: Record<string, string> = {}
    if (locationId === null) found.outlet = 'Choose the outlet this device works at.'
    if (terminalId === null) found.till = 'Choose the till this device operates.'
    if (label.trim() === '') found.label = 'Name the device, so it can be told apart when one is lost.'
    setErrors(found)
    if (Object.keys(found).length > 0) return

    setBusy(true)
    try {
      const result = await pairDevice(terminalId as number, label)
      setToken(result.device_token)
      setStage('issued')
      toast.success('Device paired.', 'Copy the pairing code before closing — it is not shown again.')
    } catch (error) {
      toast.failure(
        'Could not pair that device.',
        error instanceof Error ? error.message : 'Please try again in a moment.',
      )
    } finally {
      setBusy(false)
    }
  }

  async function copy() {
    if (!token) return
    try {
      await navigator.clipboard.writeText(token)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 2500)
    } catch {
      // Clipboard access can be refused; the code is selectable, so say that
      // rather than pretend the copy worked.
      toast.warn('Copy was blocked by the browser.', 'Select the code and copy it by hand.')
    }
  }

  function done() {
    setToken(null)
    onPaired()
  }

  const steps = [
    { label: 'Outlet', done: locationId !== null },
    { label: 'Till', done: terminalId !== null },
    { label: 'Pairing code', done: stage === 'issued' },
  ]
  const current = stage === 'issued' ? 2 : terminalId !== null ? 1 : 0

  return (
    <Drawer
      title={stage === 'issued' ? 'Device paired' : 'Pair device'}
      description={
        stage === 'issued'
          ? 'Enter this code on the device to finish. It cannot be shown again.'
          : 'Authorise a machine to operate a till, using a one-time code.'
      }
      // While a code is on screen, the close button finishes the flow rather
      // than discarding a credential the administrator may not have copied.
      onClose={stage === 'issued' ? done : onClose}
      footer={
        stage === 'issued' ? (
          <>
            <button type="button" className="pos-button pos-button--secondary" onClick={() => void copy()}>
              {copied ? <Check size={15} aria-hidden /> : <Copy size={15} aria-hidden />}
              {copied ? 'Copied' : 'Copy pairing code'}
            </button>
            <button type="button" className="pos-button pos-button--primary" onClick={done}>
              I have copied it
            </button>
          </>
        ) : (
          <>
            <button type="button" className="pos-button pos-button--secondary" onClick={onClose} disabled={busy}>
              Cancel
            </button>
            <button
              type="submit"
              form="setup-device-form"
              className="pos-button pos-button--primary"
              disabled={busy || usableTills.length === 0}
            >
              {busy && <Loader2 size={15} className="setup-spin" aria-hidden />}
              {busy ? 'Generating…' : 'Generate pairing code'}
            </button>
          </>
        )
      }
    >
      <form id="setup-device-form" className="setup-drawer__form" onSubmit={issue} noValidate>
        <div className="setup-drawer__body">
          <ol className="setup-steps" aria-label="Pairing progress">
            {steps.map((step, index) => (
              <Fragment key={step.label}>
                <li
                  className={`setup-steps__item${
                    index === current ? ' setup-steps__item--on' : step.done ? ' setup-steps__item--done' : ''
                  }`}
                  aria-current={index === current ? 'step' : undefined}
                >
                  <span className="setup-steps__num" aria-hidden>
                    {step.done && index !== current ? <Check size={12} /> : index + 1}
                  </span>
                  {step.label}
                </li>
                {index < steps.length - 1 && <li className="setup-steps__rule" aria-hidden />}
              </Fragment>
            ))}
          </ol>

          {stage === 'choose' ? (
            <>
              <Section title="Which till" description="A device is authorised for exactly one till.">
                <Field label="Outlet" required error={errors.outlet}>
                  {(props) => (
                    <select
                      {...props}
                      value={locationId ?? ''}
                      onChange={(event) => {
                        const next = event.target.value === '' ? null : Number(event.target.value)
                        setLocationId(next)
                        setTerminalId(null)
                      }}
                    >
                      <option value="">Choose an outlet</option>
                      {sellable.map((outlet) => (
                        <option key={outlet.location_id} value={outlet.location_id}>
                          {outletName(outlet)}
                        </option>
                      ))}
                    </select>
                  )}
                </Field>

                <Field
                  label="Till"
                  required
                  error={errors.till}
                  hint={
                    locationId !== null && tillsHere.length === 0
                      ? 'That outlet has no active till yet. Add one first.'
                      : undefined
                  }
                >
                  {(props) => (
                    <select
                      {...props}
                      value={terminalId ?? ''}
                      disabled={locationId === null || tillsHere.length === 0}
                      onChange={(event) => setTerminalId(event.target.value === '' ? null : Number(event.target.value))}
                    >
                      <option value="">Choose a till</option>
                      {tillsHere.map((till) => (
                        <option key={till.terminal_id} value={till.terminal_id}>
                          {tillName(till)} · {till.terminal_code}
                        </option>
                      ))}
                    </select>
                  )}
                </Field>
              </Section>

              <Section title="Which machine" description="The name is how a lost device is found in this list later.">
                <Field label="Device name" required error={errors.label}>
                  {(props) => (
                    <input
                      {...props}
                      value={label}
                      onChange={(event) => setLabel(event.target.value)}
                      placeholder="Counter iPad"
                      autoComplete="off"
                      maxLength={80}
                    />
                  )}
                </Field>

                <p className="pos-unavailable pos-unavailable--muted" style={{ marginTop: 4 }}>
                  <ShieldCheck size={16} aria-hidden style={{ flex: '0 0 auto', marginTop: 1 }} />
                  <span>
                    POS stores only a hash of the pairing code, so nobody — including this screen — can read one back
                    afterwards. If it is lost, pair the device again and revoke the old registration.
                  </span>
                </p>
              </Section>
            </>
          ) : (
            <Section
              title="For security, this pairing code is shown only once"
              description="Type or paste it into the device now. Closing this panel discards it for good."
            >
              <code className="setup-secret">{token}</code>
              <p className="setup-field__help" style={{ marginTop: 10 }}>
                Paired with <strong>{tills.find((till) => till.terminal_id === terminalId)?.terminal_code ?? '—'}</strong>
                {' '}as <strong>{label.trim()}</strong>.
              </p>
            </Section>
          )}
        </div>
      </form>
    </Drawer>
  )
}
