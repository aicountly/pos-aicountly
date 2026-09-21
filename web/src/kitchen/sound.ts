/**
 * The new-ticket chime.
 *
 * Synthesised rather than shipped as a file, for three reasons: a kitchen
 * display is often on a machine that never sees the open internet, an audio
 * asset is one more thing that can 404 into silence, and a two-note tone is
 * small enough to write down.
 *
 * Nothing is created until the first ticket actually arrives, because
 * constructing an AudioContext on page load produces a browser warning and,
 * in a tab that has never been touched, a suspended context that never plays.
 */

let context: AudioContext | null = null

type AudioContextCtor = typeof AudioContext

function audioContext(): AudioContext | null {
  if (context) return context

  const Ctor: AudioContextCtor | undefined =
    window.AudioContext ?? (window as unknown as { webkitAudioContext?: AudioContextCtor }).webkitAudioContext
  if (!Ctor) return null

  try {
    context = new Ctor()

    return context
  } catch {
    return null
  }
}

/**
 * Two short notes, rising.
 *
 * Rising because it has to be heard over extraction fans and a pass bell
 * without being another alarm; short because it will play a few hundred times
 * in a service.
 */
export function playNewTicketChime(volume: number): void {
  const ctx = audioContext()
  if (!ctx) return

  // A context can be suspended until the page has been interacted with. Asking
  // is free, and failing to resume simply means no sound rather than an error.
  if (ctx.state === 'suspended') void ctx.resume().catch(() => undefined)

  const level = Math.min(1, Math.max(0, volume)) * 0.28
  if (level === 0) return

  const start = ctx.currentTime

  for (const [index, frequency] of [880, 1318.5].entries()) {
    const oscillator = ctx.createOscillator()
    const gain = ctx.createGain()

    oscillator.type = 'sine'
    oscillator.frequency.value = frequency

    const at = start + index * 0.14
    gain.gain.setValueAtTime(0.0001, at)
    gain.gain.exponentialRampToValueAtTime(level, at + 0.02)
    gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.22)

    oscillator.connect(gain).connect(ctx.destination)
    oscillator.start(at)
    oscillator.stop(at + 0.24)
  }
}
