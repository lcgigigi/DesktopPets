interface MascotIdleContext {
  isNotifying: boolean
  isDragging: boolean
  isPeeked: boolean
  isPointerInside: boolean
  panelVisible: boolean
  panelHasText: boolean
  panelFocused: boolean
}

export function shouldPauseMascotIdleHide(context: MascotIdleContext) {
  return context.isNotifying
    || context.isDragging
    || context.isPeeked
    || context.isPointerInside
    || (context.panelVisible && (context.panelHasText || context.panelFocused))
}
