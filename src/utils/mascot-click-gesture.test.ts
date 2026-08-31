import { describe, expect, it } from 'vitest'
import {
  MASCOT_DOUBLE_CLICK_MAX_INTERVAL_MS,
  MASCOT_DOUBLE_CLICK_MIN_INTERVAL_MS,
  classifyMascotClickContinuation,
  type MascotCompletedClick,
} from './mascot-click-gesture'

const firstClick: MascotCompletedClick = {
  pressedAt: 1000,
  screenX: 800,
  screenY: 500,
  pointerType: 'mouse',
}

function nextClick(overrides: Partial<MascotCompletedClick> = {}): MascotCompletedClick {
  return {
    ...firstClick,
    pressedAt: firstClick.pressedAt + 140,
    screenX: firstClick.screenX + 2,
    screenY: firstClick.screenY - 1,
    ...overrides,
  }
}

describe('mascot click gesture', () => {
  it('promotes two distinct nearby presses to the workbench double-click action', () => {
    expect(classifyMascotClickContinuation(firstClick, nextClick())).toBe('double')
  })

  it('ignores an implausibly fast duplicate completion from a touchpad or WebView2', () => {
    expect(classifyMascotClickContinuation(firstClick, nextClick({
      pressedAt: firstClick.pressedAt + MASCOT_DOUBLE_CLICK_MIN_INTERVAL_MS - 1,
    }))).toBe('duplicate')
  })

  it('keeps slow, distant, and different-pointer presses as separate single clicks', () => {
    expect(classifyMascotClickContinuation(firstClick, nextClick({
      pressedAt: firstClick.pressedAt + MASCOT_DOUBLE_CLICK_MAX_INTERVAL_MS + 1,
    }))).toBe('separate')
    expect(classifyMascotClickContinuation(firstClick, nextClick({ screenX: 830 }))).toBe('separate')
    expect(classifyMascotClickContinuation(firstClick, nextClick({ pointerType: 'touch' }))).toBe('separate')
  })
})
