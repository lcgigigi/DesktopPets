import { describe, expect, it } from 'vitest'
import { shouldPauseMascotIdleHide } from './mascot-idle-policy'

const idleContext = {
  isNotifying: false,
  isDragging: false,
  isPeeked: false,
  isPointerInside: false,
  panelVisible: false,
  panelHasText: false,
  panelFocused: false
}

describe('mascot idle policy', () => {
  it('pauses hiding while a visible panel contains a draft', () => {
    expect(shouldPauseMascotIdleHide({
      ...idleContext,
      panelVisible: true,
      panelHasText: true
    })).toBe(true)
  })

  it('pauses hiding while the user is editing an empty visible panel', () => {
    expect(shouldPauseMascotIdleHide({
      ...idleContext,
      panelVisible: true,
      panelFocused: true
    })).toBe(true)
  })

  it('does not keep the mascot awake for a saved draft in a panel hidden by an outside click', () => {
    expect(shouldPauseMascotIdleHide({
      ...idleContext,
      panelHasText: true
    })).toBe(false)
  })
})
