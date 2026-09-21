/**
 * The two controls the settings drawer needs and the app does not already own.
 *
 * Both say their state IN WORDS beside the control, not only by where a knob
 * has slid to. A kitchen screen is read at a glance in bad light by someone
 * who is not looking for a subtlety of position.
 */

export function Switch({
  checked,
  onChange,
  label,
}: {
  checked: boolean
  onChange: (next: boolean) => void
  /** Names the setting for a screen reader; the visible name is beside it. */
  label: string
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      className="kds-switch"
      onClick={() => onChange(!checked)}
    >
      <span aria-hidden>{checked ? 'On' : 'Off'}</span>
      <span className="kds-switch__track" aria-hidden />
    </button>
  )
}

export function Segment<T extends string | number>({
  value,
  options,
  onChange,
  label,
}: {
  value: T
  options: { value: T; label: string }[]
  onChange: (next: T) => void
  label: string
}) {
  return (
    <div className="kds-segment" role="group" aria-label={label}>
      {options.map((option) => (
        <button
          key={String(option.value)}
          type="button"
          aria-pressed={option.value === value}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  )
}
