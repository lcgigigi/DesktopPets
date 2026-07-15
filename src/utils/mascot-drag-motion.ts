export type RunningDirection = 'running-left' | 'running-right'

export type RunningDirectionState = {
  direction?: RunningDirection
  pendingDirection?: RunningDirection
  pendingDistance: number
}

export const runningDirectionSwitchDistance = 16
export const runningDeltaDeadZone = 1.5

export function createRunningDirectionState(): RunningDirectionState {
  return { pendingDistance: 0 }
}

export function advanceRunningDirection(
  state: RunningDirectionState,
  deltaX: number,
  forceDirection = false
): { state: RunningDirectionState; changed: boolean } {
  const distance = Math.abs(deltaX)
  if (distance < runningDeltaDeadZone) return { state, changed: false }

  const nextDirection: RunningDirection = deltaX < 0 ? 'running-left' : 'running-right'
  if (forceDirection || !state.direction) {
    return {
      state: { direction: nextDirection, pendingDistance: 0 },
      changed: state.direction !== nextDirection
    }
  }

  if (nextDirection === state.direction) {
    return {
      state: { direction: state.direction, pendingDistance: 0 },
      changed: false
    }
  }

  const pendingDistance =
    state.pendingDirection === nextDirection
      ? state.pendingDistance + distance
      : distance
  if (pendingDistance < runningDirectionSwitchDistance) {
    return {
      state: {
        direction: state.direction,
        pendingDirection: nextDirection,
        pendingDistance
      },
      changed: false
    }
  }

  return {
    state: { direction: nextDirection, pendingDistance: 0 },
    changed: true
  }
}
