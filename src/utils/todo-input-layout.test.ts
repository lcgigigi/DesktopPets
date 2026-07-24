import { describe, expect, it } from 'vitest'
import {
  clampTodoTextareaHeight,
  getTodoPanelHeight,
  TODO_PANEL_BASE_HEIGHT,
  TODO_PANEL_MAX_HEIGHT,
  TODO_TEXTAREA_MAX_HEIGHT,
  TODO_TEXTAREA_MIN_HEIGHT
} from './todo-input-layout'

describe('todo input layout', () => {
  it('keeps short text at the compact panel height', () => {
    expect(clampTodoTextareaHeight(12)).toBe(TODO_TEXTAREA_MIN_HEIGHT)
    expect(getTodoPanelHeight(12)).toBe(TODO_PANEL_BASE_HEIGHT)
  })

  it('grows the native panel with wrapped input text', () => {
    expect(getTodoPanelHeight(86)).toBe(TODO_PANEL_BASE_HEIGHT + 48)
  })

  it('caps extreme content and lets the textarea scroll without clipping the window', () => {
    expect(clampTodoTextareaHeight(1000)).toBe(TODO_TEXTAREA_MAX_HEIGHT)
    expect(getTodoPanelHeight(1000)).toBe(TODO_PANEL_MAX_HEIGHT)
  })
})
