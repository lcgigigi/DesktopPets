import { describe, expect, it } from 'vitest'
import {
  mascotAnimationTiming,
  mascotIdleMotionDurationMs,
  mascotMessageAutoResetMs,
  mascotWaitingInteractionMs
} from './mascot-animation-timing'

describe('mascot production animation timing', () => {
  it('keeps every moving pose sequence at twelve authored poses per second or faster', () => {
    for (const [state, timing] of Object.entries(mascotAnimationTiming)) {
      if (state === 'idle') continue
      expect(
        timing.frames / timing.durationMs * 1000,
        `${state} cadence`
      ).toBeGreaterThanOrEqual(12)
    }

    const idlePoseChanges = mascotAnimationTiming.idle.frames - 1
    expect(idlePoseChanges / mascotIdleMotionDurationMs * 1000).toBeGreaterThanOrEqual(12)
  })

  it('ends automatic messages only on complete animation cycles', () => {
    for (const state of ['thinking', 'remind', 'success', 'error'] as const) {
      expect(
        mascotMessageAutoResetMs % mascotAnimationTiming[state].durationMs,
        `${state} auto reset`
      ).toBe(0)
    }
  })

  it('plays exactly one complete waiting cycle for click feedback', () => {
    expect(mascotWaitingInteractionMs).toBe(mascotAnimationTiming.waiting.durationMs)
  })
})
