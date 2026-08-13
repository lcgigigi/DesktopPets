import { describe, expect, it } from 'vitest'
import mascotAvatarSource from '../components/MascotAvatar.vue?raw'
import appStyles from '../assets/styles/app.css?raw'

describe('mascot single-layer rendering contract', () => {
  it('renders exactly one sprite element with no transition overlap layer', () => {
    expect(mascotAvatarSource.match(/class="mascot-sprite /g)).toHaveLength(1)
    expect(mascotAvatarSource).not.toContain('<Transition')
    expect(mascotAvatarSource).not.toContain('MascotRunSprite')
    expect(mascotAvatarSource).not.toContain('showRunLayer')
    expect(appStyles).not.toContain('.mascot-run-sprite')
    expect(appStyles).not.toContain('.mascot-sprite-state-enter-active')
    expect(appStyles).not.toContain('.mascot-sprite-state-leave-active')
  })

  it('uses safe bounded jump-none playback for loops and one-shot sequences', () => {
    expect(mascotAvatarSource).toContain('steps(${sprite.frames}, jump-none)')
    expect(mascotAvatarSource).toContain('sprite.frames - 1')
    expect(mascotAvatarSource).not.toContain('sprite.frames * SPRITE_DISPLAY_WIDTH')
  })

  it('uses separate 2x runtime atlases for running and peeking', () => {
    expect(mascotAvatarSource).toContain('xiaoli-running-spritesheet.webp')
    expect(mascotAvatarSource).toContain('xiaoli-peek-spritesheet.webp')
    expect(mascotAvatarSource).not.toContain('xiaoli-motion-spritesheet.webp')
  })

  it('never resamples the raster avatar through an outer settle transform', () => {
    expect(appStyles).not.toContain('.mascot-window.is-dragging .mascot-avatar.is-visual-running-right')
    expect(appStyles).not.toContain('.mascot-window.is-dragging .mascot-avatar.is-visual-running-left')
    expect(appStyles).not.toContain('@keyframes mascot-reveal-settle')
    expect(appStyles).not.toContain('@keyframes mascot-run-return')

    const avatarRule = appStyles.match(/(?:^|\n)\.mascot-avatar\s*\{([^}]*)\}/)?.[1] ?? ''
    expect(avatarRule).not.toMatch(/\btransform(?:-origin)?:/)
    expect(avatarRule).not.toMatch(/\btransition:\s*transform/)
  })
})
