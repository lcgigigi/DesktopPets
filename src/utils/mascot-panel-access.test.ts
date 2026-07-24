import { describe, expect, it } from 'vitest'
import { canOpenMascotTodoPanel } from './mascot-panel-access'

describe('canOpenMascotTodoPanel', () => {
  it('keeps the login prompt blocking todo input before login', () => {
    expect(canOpenMascotTodoPanel(true, false)).toBe(false)
  })

  it('opens todo input after login when no system message is covering the mascot', () => {
    expect(canOpenMascotTodoPanel(false, false)).toBe(true)
  })

  it('keeps an active system message visible instead of opening todo input', () => {
    expect(canOpenMascotTodoPanel(false, true)).toBe(false)
  })
})
