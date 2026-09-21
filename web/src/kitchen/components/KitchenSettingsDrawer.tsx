/**
 * Kitchen settings.
 *
 * Every switch here changes something a kitchen can see immediately on the
 * board behind it, and every one is stored on this device. There is
 * deliberately NO "show item images": the ticket lines this API returns carry a
 * name, a quantity, modifiers and notes, and no picture — a toggle for images
 * that do not exist would be a dead control, and inventing a photo URL for a
 * dish would put a stock photograph of someone else's food on a cook's screen.
 *
 * Saving is immediate. A drawer that needed a Save button would be a drawer a
 * cook closes having changed nothing.
 */

import { SLA_THRESHOLDS, SERVED_COUNTS } from '../preferences'
import type { KdsStation, KitchenPreferences } from '../types'
import { Drawer } from './Drawer'
import { Segment, Switch } from './controls'

export function KitchenSettingsDrawer({
  preferences,
  stations,
  soundSupported,
  onChange,
  onReset,
  onClose,
}: {
  preferences: KitchenPreferences
  stations: KdsStation[]
  soundSupported: boolean
  onChange: (patch: Partial<KitchenPreferences>) => void
  onReset: () => void
  onClose: () => void
}) {
  return (
    <Drawer
      title="Kitchen settings"
      description="Saved on this screen only. Every kitchen display can be set up differently."
      onClose={onClose}
      footer={
        <>
          <button type="button" className="kds-btn" onClick={onReset}>
            Reset to defaults
          </button>
          <button type="button" className="kds-btn kds-btn--on" onClick={onClose}>
            Done
          </button>
        </>
      }
    >
      <fieldset className="kds-fieldset">
        <legend>Display</legend>

        <div className="kds-setting">
          <span className="kds-setting__label">
            <strong>Density</strong>
            <span>Compact fits more tickets on a wall screen.</span>
          </span>
          <Segment
            label="Display density"
            value={preferences.density}
            onChange={(density) => onChange({ density })}
            options={[
              { value: 'comfortable', label: 'Comfortable' },
              { value: 'compact', label: 'Compact' },
            ]}
          />
        </div>

        <div className="kds-setting">
          <span className="kds-setting__label">
            <strong>Recently served column</strong>
            <span>Keeps the last few tickets on screen so the pass can check them.</span>
          </span>
          <Switch
            label="Show the recently served column"
            checked={preferences.showServed}
            onChange={(showServed) => onChange({ showServed })}
          />
        </div>

        {preferences.showServed && (
          <div className="kds-setting">
            <span className="kds-setting__label">
              <strong>Tickets to keep</strong>
              <span>How many served tickets stay in that column.</span>
            </span>
            <Segment
              label="Recently served count"
              value={preferences.servedCount}
              onChange={(servedCount) => onChange({ servedCount })}
              options={SERVED_COUNTS.map((n) => ({ value: n, label: String(n) }))}
            />
          </div>
        )}
      </fieldset>

      <fieldset className="kds-fieldset">
        <legend>Timing</legend>

        <div className="kds-setting">
          <span className="kds-setting__label">
            <strong>Warn at</strong>
            <span>
              How far into a station’s own prep target a ticket starts warning. Past the target it is late, and that
              threshold belongs to the station.
            </span>
          </span>
          <Segment
            label="Warning threshold"
            value={preferences.slaWarnPc}
            onChange={(slaWarnPc) => onChange({ slaWarnPc })}
            options={SLA_THRESHOLDS.map((n) => ({ value: n, label: `${n}%` }))}
          />
        </div>

        <div className="kds-setting">
          <span className="kds-setting__label">
            <strong>Auto refresh</strong>
            <span>Re-reads the board every few seconds. Ticket clocks keep running either way.</span>
          </span>
          <Switch
            label="Refresh the board automatically"
            checked={preferences.autoRefresh}
            onChange={(autoRefresh) => onChange({ autoRefresh })}
          />
        </div>

        {stations.length > 0 && (
          <div className="kds-setting">
            <span className="kds-setting__label">
              <strong>Station this screen opens on</strong>
              <span>For a display fixed above one section.</span>
            </span>
            <select
              className="kds-select"
              aria-label="Default kitchen station"
              value={preferences.defaultStationId === null ? 'all' : String(preferences.defaultStationId)}
              onChange={(event) =>
                onChange({ defaultStationId: event.target.value === 'all' ? null : Number(event.target.value) })
              }
            >
              <option value="all">All stations</option>
              {stations.map((station) => (
                <option key={station.station_id} value={station.station_id}>
                  {station.station_name}
                </option>
              ))}
            </select>
          </div>
        )}
      </fieldset>

      <fieldset className="kds-fieldset">
        <legend>Sound</legend>

        {!soundSupported && (
          <p className="kds-notice kds-notice--info" style={{ marginBottom: 14 }}>
            <span className="kds-notice__body">This browser offers no audio, so new tickets will be silent.</span>
          </p>
        )}

        <div className="kds-setting">
          <span className="kds-setting__label">
            <strong>Sound</strong>
            <span>The master switch, matching the button in the header.</span>
          </span>
          <Switch label="Sound" checked={preferences.sound} onChange={(sound) => onChange({ sound })} />
        </div>

        <div className="kds-setting">
          <span className="kds-setting__label">
            <strong>New ticket chime</strong>
            <span>Two short notes when a ticket is fired.</span>
          </span>
          <Switch
            label="New ticket chime"
            checked={preferences.newOrderAlert}
            onChange={(newOrderAlert) => onChange({ newOrderAlert })}
          />
        </div>

        <div className="kds-setting">
          <span className="kds-setting__label">
            <strong>Volume</strong>
            <span>{Math.round(preferences.volume * 100)}% of this device’s volume.</span>
          </span>
          <input
            type="range"
            className="kds-range"
            min={0}
            max={100}
            step={5}
            value={Math.round(preferences.volume * 100)}
            aria-label="Chime volume"
            disabled={!preferences.sound || !preferences.newOrderAlert}
            onChange={(event) => onChange({ volume: Number(event.target.value) / 100 })}
          />
        </div>
      </fieldset>
    </Drawer>
  )
}
