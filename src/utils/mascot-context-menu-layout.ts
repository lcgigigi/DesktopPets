export const MASCOT_CONTEXT_MENU_WIDTH = 168
export const MASCOT_CONTEXT_MENU_HEIGHT = 42
export const MASCOT_CONTEXT_MENU_TAIL_HEIGHT = 5
export const MASCOT_CONTEXT_MENU_EDGE_PADDING = 12
export const MASCOT_CONTEXT_MENU_GAP = 18
export const MASCOT_COMPACT_OVERLAY_WIDTH = 240
export const MASCOT_COMPACT_OVERLAY_HEIGHT = 208
export const MASCOT_AVATAR_HEIGHT = 128
export const MASCOT_EXPANDED_BOTTOM_PADDING = 8

export interface MascotContextMenuLayout {
  x: number
  y: number
  width: number
  fitsAboveAvatar: boolean
  fitsHorizontally: boolean
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), Math.max(min, max))
}

export function getMascotContextMenuLayout(
  viewportWidth: number,
  viewportHeight: number,
  expanded = false
): MascotContextMenuLayout {
  const safeViewportWidth = Math.max(0, viewportWidth)
  const safeViewportHeight = Math.max(0, viewportHeight)
  const availableWidth = Math.max(
    0,
    safeViewportWidth - MASCOT_CONTEXT_MENU_EDGE_PADDING * 2
  )
  const width = Math.min(MASCOT_CONTEXT_MENU_WIDTH, availableWidth)
  const maxX = safeViewportWidth - width - MASCOT_CONTEXT_MENU_EDGE_PADDING
  const x = clamp(
    (safeViewportWidth - width) / 2,
    MASCOT_CONTEXT_MENU_EDGE_PADDING,
    maxX
  )
  const avatarBottomPadding = expanded ? MASCOT_EXPANDED_BOTTOM_PADDING : 0
  const avatarTop = safeViewportHeight - avatarBottomPadding - MASCOT_AVATAR_HEIGHT
  const desiredY = avatarTop - MASCOT_CONTEXT_MENU_HEIGHT - MASCOT_CONTEXT_MENU_GAP
  const maxY = safeViewportHeight
    - MASCOT_CONTEXT_MENU_HEIGHT
    - MASCOT_CONTEXT_MENU_EDGE_PADDING
  const y = clamp(
    desiredY,
    MASCOT_CONTEXT_MENU_EDGE_PADDING,
    maxY
  )

  return {
    x,
    y,
    width,
    fitsAboveAvatar:
      y + MASCOT_CONTEXT_MENU_HEIGHT + MASCOT_CONTEXT_MENU_TAIL_HEIGHT <= avatarTop,
    fitsHorizontally: width === MASCOT_CONTEXT_MENU_WIDTH
  }
}
