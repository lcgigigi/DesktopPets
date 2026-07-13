<script setup lang="ts">
import { computed } from 'vue'
import spriteSheetUrl from '../assets/mascot/xiaoli-spritesheet.webp'
import type { MascotAnimationState, MascotStatus } from '../types/mascot'

const props = defineProps<{
  status: MascotStatus
  animationState?: MascotAnimationState
}>()

type SpriteState = {
  row: number
  frames: number
  duration: number
}

const SPRITE_DISPLAY_HEIGHT = 160
const SPRITE_SOURCE_CELL_WIDTH = 192
const SPRITE_SOURCE_CELL_HEIGHT = 208
const spriteScale = SPRITE_DISPLAY_HEIGHT / SPRITE_SOURCE_CELL_HEIGHT

const spriteStates: Record<string, SpriteState> = {
  idle: { row: 0, frames: 6, duration: 3200 },
  thinking: { row: 7, frames: 6, duration: 1800 },
  waiting: { row: 6, frames: 6, duration: 2200 },
  remind: { row: 3, frames: 4, duration: 900 },
  waving: { row: 3, frames: 4, duration: 900 },
  success: { row: 4, frames: 5, duration: 900 },
  jumping: { row: 4, frames: 5, duration: 900 },
  error: { row: 5, frames: 8, duration: 1800 },
  failed: { row: 5, frames: 8, duration: 1800 },
  'running-left': { row: 2, frames: 8, duration: 720 },
  'running-right': { row: 1, frames: 8, duration: 720 },
  'cooling-office': { row: 7, frames: 6, duration: 1800 }
}

const resolvedState = computed<MascotStatus | MascotAnimationState>(() => {
  if (props.animationState) return props.animationState
  return props.status
})

const spriteStyle = computed(() => {
  const sprite = spriteStates[resolvedState.value] ?? spriteStates.idle

  return {
    backgroundImage: `url(${spriteSheetUrl})`,
    '--sprite-row-offset': `-${sprite.row * SPRITE_DISPLAY_HEIGHT}px`,
    '--sprite-end-offset': `-${sprite.frames * SPRITE_SOURCE_CELL_WIDTH * spriteScale}px`,
    '--sprite-animation': `mascot-sprite-play ${sprite.duration}ms steps(${sprite.frames}) infinite`
  }
})
</script>

<template>
  <button
    class="mascot-avatar"
    :class="[`is-${status}`, `is-visual-${resolvedState}`]"
    type="button"
    aria-label="单击打开输入框，双击打开工作台"
  >
    <span class="status-orbit" />
    <span
      class="mascot-sprite"
      :style="spriteStyle"
      aria-hidden="true"
    />
  </button>
</template>
