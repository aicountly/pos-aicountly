/**
 * The rest of the POS settings.
 *
 * Everything in this panel is a column of `pos_settings` that `PUT v1/settings`
 * actually accepts. Nothing here is a placeholder for a feature that does not
 * exist yet — a settings screen full of switches that change nothing is worse
 * than a short one, because people set them and then wonder why the till
 * ignored them. What POS genuinely does not configure is said at the bottom,
 * with where it does live.
 */

import { useEffect, useState } from 'react'
import { AlertTriangle, Loader2, RefreshCw } from 'lucide-react'
import type { PosSettings } from '../services/types'
import { usePos } from '../context/PosContext'
import { fetchSettings, saveSettings } from './data'
import { Drawer, Field, Section, SkeletonLine, useToast } from './ui'

export function SettingsDrawer({ canManage, onClose }: { canManage: boolean; onClose: () => void }) {
  const { session } = usePos()
  const toast = useToast()
  const [settings, setSettings] = useState<PosSettings | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [form, setForm] = useState<PosSettings | null>(null)
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({})

  function load() {
    setLoading(true)
    setError(null)
    fetchSettings()
      .then((row) => {
        setSettings(row)
        setForm(row)
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : 'We could not load your POS settings.'))
      .finally(() => setLoading(false))
  }

  useEffect(load, [])

  function set<K extends keyof PosSettings>(key: K, value: PosSettings[K]) {
    setForm((current) => (current ? { ...current, [key]: value } : current))
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    if (!form || saving) return

    const found: Record<string, string> = {}
    if (form.return_prefix.trim() === '') found.return_prefix = 'A return still needs a prefix.'
    if (form.kot_prefix.trim() === '') found.kot_prefix = 'A kitchen ticket still needs a prefix.'
    const limit = Number(form.cashier_discount_limit_pc)
    if (!Number.isFinite(limit) || limit < 0 || limit > 100) found.discount = 'Enter a percentage between 0 and 100.'
    setFieldErrors(found)
    if (Object.keys(found).length > 0) return

    setSaving(true)
    try {
      const saved = await saveSettings({
        return_prefix: form.return_prefix.trim(),
        kot_prefix: form.kot_prefix.trim(),
        cashier_discount_limit_pc: limit,
        require_reason_on_void: form.require_reason_on_void,
        require_reason_on_return: form.require_reason_on_return,
        offline_grace_minutes: Math.max(0, Number(form.offline_grace_minutes) || 0),
        cache_warn_after_minutes: Math.max(0, Number(form.cache_warn_after_minutes) || 0),
      })
      setSettings(saved)
      setForm(saved)
      toast.success('POS settings saved.')
    } catch (e) {
      toast.failure('Could not save those settings.', e instanceof Error ? e.message : 'Please try again.')
    } finally {
      setSaving(false)
    }
  }

  const dirty = Boolean(form && settings && JSON.stringify(form) !== JSON.stringify(settings))

  return (
    <Drawer
      title="Other settings"
      description="Numbering, discounts, what a cashier must explain, and how long a till may work offline."
      onClose={onClose}
      footer={
        <>
          <button type="button" className="pos-button pos-button--secondary" onClick={onClose} disabled={saving}>
            {canManage ? 'Cancel' : 'Close'}
          </button>
          {canManage && (
            <button
              type="submit"
              form="setup-settings-form"
              className="pos-button pos-button--primary"
              disabled={saving || !dirty || form === null}
            >
              {saving && <Loader2 size={15} className="setup-spin" aria-hidden />}
              {saving ? 'Saving…' : 'Save settings'}
            </button>
          )}
        </>
      }
    >
      <form id="setup-settings-form" className="setup-drawer__form" onSubmit={submit} noValidate>
        <div className="setup-drawer__body">
          {loading && (
            <div style={{ display: 'grid', gap: 16 }} aria-live="polite">
              <span className="pos-visually-hidden">Loading POS settings</span>
              <SkeletonLine width="40%" height={16} />
              <SkeletonLine height={44} />
              <SkeletonLine height={44} />
              <SkeletonLine width="60%" height={16} />
              <SkeletonLine height={44} />
            </div>
          )}

          {!loading && error !== null && (
            <div className="pos-unavailable" style={{ alignItems: 'center' }}>
              <AlertTriangle size={16} aria-hidden />
              <div style={{ minWidth: 0 }}>{error}</div>
              <button
                type="button"
                className="pos-button pos-button--secondary pos-button--small"
                onClick={load}
                style={{ marginLeft: 'auto' }}
              >
                <RefreshCw size={13} aria-hidden /> Retry
              </button>
            </div>
          )}

          {!loading && form !== null && (
            <>
              <Section title="Numbering" description="The prefix in front of each number POS issues itself.">
                <div className="setup-grid2">
                  <Field label="Return prefix" error={fieldErrors.return_prefix}>
                    {(props) => (
                      <input
                        {...props}
                        value={form.return_prefix}
                        disabled={!canManage}
                        onChange={(event) => set('return_prefix', event.target.value)}
                        maxLength={12}
                        autoComplete="off"
                      />
                    )}
                  </Field>
                  <Field label="Kitchen ticket prefix" error={fieldErrors.kot_prefix}>
                    {(props) => (
                      <input
                        {...props}
                        value={form.kot_prefix}
                        disabled={!canManage}
                        onChange={(event) => set('kot_prefix', event.target.value)}
                        maxLength={12}
                        autoComplete="off"
                      />
                    )}
                  </Field>
                </div>
                <p className="setup-field__help">
                  Invoice numbers are not here: a POS sale posts to Smart Books, and Books issues the voucher number.
                </p>
              </Section>

              <Section title="Sales behaviour" description="What a cashier may do without calling a manager over.">
                <Field
                  label="Cashier discount limit %"
                  error={fieldErrors.discount}
                  hint="Beyond this, a cashier needs the “Give a discount beyond the limit” permission."
                >
                  {(props) => (
                    <input
                      {...props}
                      type="number"
                      min={0}
                      max={100}
                      step="0.01"
                      value={form.cashier_discount_limit_pc}
                      disabled={!canManage}
                      onChange={(event) => set('cashier_discount_limit_pc', Number(event.target.value))}
                    />
                  )}
                </Field>
              </Section>

              <Section title="What must be explained" description="A reason is kept with the record and shows in the audit log.">
                <label className="setup-switch">
                  <span className="setup-switch__text">
                    <strong>Require a reason to void</strong>
                    <span>Asked before a cart or a line is thrown away.</span>
                  </span>
                  <input
                    type="checkbox"
                    checked={form.require_reason_on_void}
                    disabled={!canManage}
                    onChange={(event) => set('require_reason_on_void', event.target.checked)}
                  />
                </label>
                <label className="setup-switch">
                  <span className="setup-switch__text">
                    <strong>Require a reason to return</strong>
                    <span>Asked at the counter before a refund is raised.</span>
                  </span>
                  <input
                    type="checkbox"
                    checked={form.require_reason_on_return}
                    disabled={!canManage}
                    onChange={(event) => set('require_reason_on_return', event.target.checked)}
                  />
                </label>
              </Section>

              <Section title="Offline" description="How long a till may keep selling once it has lost the server.">
                <div className="setup-grid2">
                  <Field label="Offline grace (minutes)" hint="After this, the till stops taking new sales.">
                    {(props) => (
                      <input
                        {...props}
                        type="number"
                        min={0}
                        max={1440}
                        value={form.offline_grace_minutes}
                        disabled={!canManage}
                        onChange={(event) => set('offline_grace_minutes', Number(event.target.value))}
                      />
                    )}
                  </Field>
                  <Field label="Warn about the cache after (minutes)" hint="How stale the device's catalogue may get before it says so.">
                    {(props) => (
                      <input
                        {...props}
                        type="number"
                        min={0}
                        max={10080}
                        value={form.cache_warn_after_minutes}
                        disabled={!canManage}
                        onChange={(event) => set('cache_warn_after_minutes', Number(event.target.value))}
                      />
                    )}
                  </Field>
                </div>
              </Section>

              <Section title="Configured elsewhere" description="So nobody looks for these here.">
                <ul style={{ margin: 0, paddingLeft: '1.1rem', color: 'var(--muted)', fontSize: 12.5, lineHeight: 1.7 }}>
                  <li>
                    <strong style={{ color: 'var(--fg)' }}>Tax rates and tax categories</strong> — Smart Books. POS reads
                    them live and never keeps a second set.
                  </li>
                  <li>
                    <strong style={{ color: 'var(--fg)' }}>Invoice numbering</strong> — Smart Books, which issues the
                    voucher a sale becomes.
                  </li>
                  <li>
                    <strong style={{ color: 'var(--fg)' }}>Warehouses and stock rules</strong> — Aicountly Inventory. An
                    outlet points at one; the stock itself stays there.
                  </li>
                  <li>
                    <strong style={{ color: 'var(--fg)' }}>Company, branch and financial year</strong> — Aicountly
                    Manage, through the selector at the top of this page.
                  </li>
                  <li>
                    <strong style={{ color: 'var(--fg)' }}>Payment modes and the receipt printer</strong> — per till,
                    under Tills.
                  </li>
                </ul>
              </Section>

              {/*
                * Carried over from the old Setup page, where it was a card at
                * the bottom called "What you can do". It is the answer to "why
                * is that button greyed out", so it stays — moved next to the
                * settings it explains rather than dropped for the redesign.
                */}
              {session && (
                <Section
                  title="What you can do"
                  description="Granted by your POS role and enforced by the server, not by which buttons this screen shows."
                >
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                    {session.permissions.map((permission) => (
                      <span key={permission} className="setup-chip setup-chip--neutral">
                        {permission}
                      </span>
                    ))}
                    {session.permissions.length === 0 && (
                      <span className="setup-field__help">This role has no POS permissions.</span>
                    )}
                  </div>
                </Section>
              )}

              {!canManage && (
                <p className="setup-field__help" style={{ marginTop: 16 }}>
                  Your role can read these settings but not change them. The server enforces that, not this screen.
                </p>
              )}
            </>
          )}
        </div>
      </form>
    </Drawer>
  )
}
