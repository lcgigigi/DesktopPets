import { describe, expect, it } from 'vitest'
import {
  advanceRunningDirection,
  createRunningDirectionState,
  runningDirectionSwitchDistance
} from './mascot-drag-motion'

describe('mascot drag direction', () => {
  it('enters the initial drag direction immediately', () => {
    const result = advanceRunningDirection(createRunningDirectionState(), 8, true)

    expect(result.changed).toBe(true)
    expect(result.state.direction).toBe('running-right')
  })

  it('ignores sub-pixel native window jitter', () => {
    const state = { direction: 'running-right' as const, pendingDistance: 0 }

    expect(advanceRunningDirection(state, -1).state).toBe(state)
  })

  it('requires deliberate reverse travel before switching direction', () => {
    const initial = { direction: 'running-right' as const, pendingDistance: 0 }
    const firstReverse = advanceRunningDirection(initial, -6)
    const secondReverse = advanceRunningDirection(firstReverse.state, -7)
    const committedReverse = advanceRunningDirection(secondReverse.state, -4)

    expect(firstReverse.changed).toBe(false)
    expect(secondReverse.state.direction).toBe('running-right')
    expect(committedReverse.changed).toBe(true)
    expect(committedReverse.state.direction).toBe('running-left')
    expect(runningDirectionSwitchDistance).toBe(16)
  })

  it('cancels a pending reversal when motion returns to the current direction', () => {
    const pending = advanceRunningDirection(
      { direction: 'running-right', pendingDistance: 0 },
      -8
    ).state
    const resumed = advanceRunningDirection(pending, 3)

    expect(resumed.state).toEqual({ direction: 'running-right', pendingDistance: 0 })
    expect(resumed.changed).toBe(false)
  })
})
