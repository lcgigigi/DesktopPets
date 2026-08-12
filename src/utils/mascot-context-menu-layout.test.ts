import { describe, expect, it } from 'vitest'
import {
  MASCOT_AVATAR_HEIGHT,
  MASCOT_COMPACT_OVERLAY_HEIGHT,
  MASCOT_COMPACT_OVERLAY_WIDTH,
  MASCOT_CONTEXT_MENU_EDGE_PADDING,
  MASCOT_CONTEXT_MENU_GAP,
  MASCOT_CONTEXT_MENU_HEIGHT,
  MASCOT_CONTEXT_MENU_TAIL_HEIGHT,
  MASCOT_CONTEXT_MENU_WIDTH,
  getMascotContextMenuLayout
} from './mascot-context-menu-layout'

describe('getMascotContextMenuLayout', () => {
  it.each([
    ['100% / 1920×1080', 1],
    ['125% / 1920×1080', 1.25],
    ['150% / 2560×1440', 1.5],
    ['175% / 2880×1800', 1.75],
    ['200% / 3840×2160', 2]
  ])('keeps the compact menu inside its window at %s', (_label, scale) => {
    const layout = getMascotContextMenuLayout(
      MASCOT_COMPACT_OVERLAY_WIDTH,
      MASCOT_COMPACT_OVERLAY_HEIGHT
    )

    expect(layout.width * scale).toBe(MASCOT_CONTEXT_MENU_WIDTH * scale)
    expect(layout.x * scale).toBeGreaterThanOrEqual(MASCOT_CONTEXT_MENU_EDGE_PADDING * scale)
    expect((layout.x + layout.width) * scale).toBeLessThanOrEqual(
      (MASCOT_COMPACT_OVERLAY_WIDTH - MASCOT_CONTEXT_MENU_EDGE_PADDING) * scale
    )
    expect(layout.fitsHorizontally).toBe(true)
    expect(layout.fitsAboveAvatar).toBe(true)
  })

  it('leaves the tail and shadow gap above the mascot instead of covering its head', () => {
    const layout = getMascotContextMenuLayout(
      MASCOT_COMPACT_OVERLAY_WIDTH,
      MASCOT_COMPACT_OVERLAY_HEIGHT
    )
    const avatarTop = MASCOT_COMPACT_OVERLAY_HEIGHT - MASCOT_AVATAR_HEIGHT

    expect(layout.y + MASCOT_CONTEXT_MENU_HEIGHT + MASCOT_CONTEXT_MENU_TAIL_HEIGHT)
      .toBeLessThan(avatarTop)
  })

  it('uses the actual viewport as a safe fallback while a high-DPI native resize is pending', () => {
    const layout = getMascotContextMenuLayout(168, MASCOT_COMPACT_OVERLAY_HEIGHT)

    expect(layout.width).toBe(168 - MASCOT_CONTEXT_MENU_EDGE_PADDING * 2)
    expect(layout.x).toBe(MASCOT_CONTEXT_MENU_EDGE_PADDING)
    expect(layout.x + layout.width).toBe(168 - MASCOT_CONTEXT_MENU_EDGE_PADDING)
  })

  it('positions the menu above the mascot in the expanded login and reminder window', () => {
    const layout = getMascotContextMenuLayout(320, 480)

    expect(layout).toMatchObject({
      width: MASCOT_CONTEXT_MENU_WIDTH,
      fitsHorizontally: true,
      fitsAboveAvatar: true
    })
  })

  it('uses the measured avatar position to keep a consistent visual gap at fractional DPI', () => {
    const measuredAvatarTop = 86.4
    const layout = getMascotContextMenuLayout(
      MASCOT_COMPACT_OVERLAY_WIDTH,
      MASCOT_COMPACT_OVERLAY_HEIGHT,
      measuredAvatarTop
    )

    expect(layout.y + MASCOT_CONTEXT_MENU_HEIGHT + MASCOT_CONTEXT_MENU_GAP)
      .toBeCloseTo(measuredAvatarTop)
    expect(layout.fitsAboveAvatar).toBe(true)
  })
})
