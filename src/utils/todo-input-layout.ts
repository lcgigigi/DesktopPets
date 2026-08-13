export const TODO_TEXTAREA_MIN_HEIGHT = 38
export const TODO_TEXTAREA_MAX_HEIGHT = 138
export const TODO_PANEL_BASE_HEIGHT = 78
export const TODO_PANEL_MAX_HEIGHT = TODO_PANEL_BASE_HEIGHT
  + TODO_TEXTAREA_MAX_HEIGHT
  - TODO_TEXTAREA_MIN_HEIGHT
export const TODO_PANEL_ERROR_HEIGHT = 42

export function clampTodoTextareaHeight(scrollHeight: number) {
  if (!Number.isFinite(scrollHeight)) return TODO_TEXTAREA_MIN_HEIGHT
  return Math.min(
    TODO_TEXTAREA_MAX_HEIGHT,
    Math.max(TODO_TEXTAREA_MIN_HEIGHT, Math.ceil(scrollHeight))
  )
}

export function getTodoPanelHeight(textareaHeight: number, hasError = false) {
  const clampedTextareaHeight = clampTodoTextareaHeight(textareaHeight)
  return TODO_PANEL_BASE_HEIGHT
    + clampedTextareaHeight
    - TODO_TEXTAREA_MIN_HEIGHT
    + (hasError ? TODO_PANEL_ERROR_HEIGHT : 0)
}
