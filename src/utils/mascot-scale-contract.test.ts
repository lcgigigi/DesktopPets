import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import mascotAvatarSource from '../components/MascotAvatar.vue?raw'
import mascotRunSpriteSource from '../components/MascotRunSprite.vue?raw'
import rustSource from '../../src-tauri/src/main.rs?raw'
import tauriConfigSource from '../../src-tauri/tauri.conf.json?raw'

const appStyles = readFileSync(new URL('../assets/styles/app.css', import.meta.url), 'utf8')
const baseStyles = readFileSync(new URL('../assets/styles/base.css', import.meta.url), 'utf8')

function numericConst(source: string, name: string) {
  const match = source.match(new RegExp(`const ${name}(?:: f64)? = ([0-9.]+)`))
  expect(match, `missing numeric constant ${name}`).not.toBeNull()
  return Number(match?.[1])
}

function cssRule(source: string, selector: string) {
  const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = source.match(new RegExp(`(?:^|\\n)${escapedSelector}\\s*\\{([^}]*)\\}`))

  expect(match, `missing standalone CSS rule ${selector}`).not.toBeNull()
  return match?.[1] ?? ''
}

describe('mascot one-third-smaller size contract', () => {
  const tauriConfig = JSON.parse(tauriConfigSource) as {
    app: { windows: Array<{ label: string; width: number; height: number }> }
  }

  it('keeps the collapsed native window synchronized with Tauri and both CSS roots', () => {
    const mascotWindow = tauriConfig.app.windows.find((window) => window.label === 'mascot')
    const nativeWidth = numericConst(rustSource, 'MASCOT_WIDTH')
    const nativeHeight = numericConst(rustSource, 'MASCOT_HEIGHT')

    expect(mascotWindow).toMatchObject({ width: 120, height: 104 })
    expect(nativeWidth).toBe(mascotWindow?.width)
    expect(nativeHeight).toBe(mascotWindow?.height)
    expect(cssRule(appStyles, '.app-shell.is-mascot')).toContain('min-width: 120px')
    expect(cssRule(appStyles, '.app-shell.is-mascot')).toContain('min-height: 104px')
    expect(baseStyles).toMatch(/data-window='mascot'[\s\S]*?min-width: 120px;[\s\S]*?min-height: 104px;/)
  })

  it('keeps the avatar, base sprite and running sprite dimensions aligned', () => {
    const avatarWidth = numericConst(rustSource, 'MASCOT_AVATAR_WIDTH')
    const avatarHeight = numericConst(rustSource, 'MASCOT_AVATAR_HEIGHT')
    const avatarRule = cssRule(appStyles, '.mascot-avatar')
    const stageRule = cssRule(appStyles, '.mascot-sprite-stage')
    const runRule = cssRule(appStyles, '.mascot-run-sprite')

    expect([avatarWidth, avatarHeight]).toEqual([96, 88])
    expect(avatarRule).toContain('width: 96px')
    expect(avatarRule).toContain('height: 88px')
    expect(stageRule).toContain('width: 90px')
    expect(stageRule).toContain('height: 84px')
    expect(runRule).toContain('width: 90px')
    expect(runRule).toContain('height: 84px')
    expect(mascotAvatarSource).toContain('const SPRITE_DISPLAY_WIDTH = 90')
    expect(mascotAvatarSource).toContain('const SPRITE_DISPLAY_HEIGHT = 75')
    expect(mascotRunSpriteSource).toContain('const SPRITE_WIDTH = 90')
    expect(mascotRunSpriteSource).toContain('const SPRITE_HEIGHT = 84')
  })

  it('preserves the source sprite aspect ratio while reducing the visible robot by about one third', () => {
    const oldSprite = { width: 132, height: 110 }
    const resizedSprite = {
      width: numericConst(mascotAvatarSource, 'SPRITE_DISPLAY_WIDTH'),
      height: numericConst(mascotAvatarSource, 'SPRITE_DISPLAY_HEIGHT')
    }

    expect(resizedSprite.width / resizedSprite.height).toBe(oldSprite.width / oldSprite.height)
    expect(resizedSprite.width / oldSprite.width).toBeGreaterThanOrEqual(0.66)
    expect(resizedSprite.width / oldSprite.width).toBeLessThanOrEqual(0.69)
    expect(resizedSprite.height / oldSprite.height).toBeGreaterThanOrEqual(0.66)
    expect(resizedSprite.height / oldSprite.height).toBeLessThanOrEqual(0.69)
  })

  it('retains symmetric transparent gutters around the resized avatar', () => {
    const windowWidth = numericConst(rustSource, 'MASCOT_WIDTH')
    const windowHeight = numericConst(rustSource, 'MASCOT_HEIGHT')
    const avatarWidth = numericConst(rustSource, 'MASCOT_AVATAR_WIDTH')
    const avatarHeight = numericConst(rustSource, 'MASCOT_AVATAR_HEIGHT')

    expect((windowWidth - avatarWidth) / 2).toBe(12)
    expect((windowHeight - avatarHeight) / 2).toBe(8)
    expect(numericConst(rustSource, 'MASCOT_NOTIFICATION_BOTTOM_PADDING')).toBe(8)
    expect(numericConst(rustSource, 'MASCOT_PEEK_VISIBLE_WIDTH')).toBe(68)
    expect(numericConst(rustSource, 'MASCOT_MESSAGE_HEIGHT')).toBe(176)
  })
})
