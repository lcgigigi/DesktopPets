<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import spriteSheetUrl from '../assets/mascot/xiaoli-spritesheet.webp'
import motionSpriteSheetUrl from '../assets/mascot/xiaoli-motion-spritesheet.webp'
import MascotRunSprite from './MascotRunSprite.vue'
import type { MascotAnimationState, MascotStatus } from '../types/mascot'
import type { RunningDirection } from '../utils/mascot-drag-motion'

const props = defineProps<{
  status: MascotStatus
  animationState?: MascotAnimationState
}>()

type SpriteState = {
  sheet: 'main' | 'motion'
  row: number
  frames: number
  duration: number
  animation: 'mascot-sprite-idle' | 'mascot-sprite-active'
  iterations?: 'infinite' | '1'
  direction?: 'normal' | 'reverse'
}

const SPRITE_DISPLAY_WIDTH = 132
const SPRITE_DISPLAY_HEIGHT = 110
const spriteSheets = {
  main: { url: spriteSheetUrl, columns: 12, rows: 10 },
  motion: { url: motionSpriteSheetUrl, columns: 24, rows: 3 }
} as const
const isHovered = ref(false)
const showRunLayer = ref(false)
const isReturningFromRun = ref(false)
const lastRunningDirection = ref<RunningDirection>('running-right')
let runReturnTimer: number | undefined

const spriteStates: Record<string, SpriteState> = {
  idle: { sheet: 'main', row: 0, frames: 12, duration: 5200, animation: 'mascot-sprite-idle' },
  hover: { sheet: 'main', row: 1, frames: 6, duration: 1100, animation: 'mascot-sprite-active' },
  thinking: { sheet: 'main', row: 2, frames: 12, duration: 2600, animation: 'mascot-sprite-active' },
  waiting: { sheet: 'main', row: 3, frames: 6, duration: 900, animation: 'mascot-sprite-active' },
  remind: { sheet: 'main', row: 4, frames: 12, duration: 1800, animation: 'mascot-sprite-active' },
  waving: { sheet: 'main', row: 4, frames: 12, duration: 1800, animation: 'mascot-sprite-active' },
  success: { sheet: 'main', row: 5, frames: 6, duration: 900, animation: 'mascot-sprite-active' },
  error: { sheet: 'main', row: 6, frames: 6, duration: 1000, animation: 'mascot-sprite-active' },
  peeking: {
    sheet: 'motion', row: 2, frames: 12, duration: 560,
    animation: 'mascot-sprite-active', iterations: '1'
  },
  revealing: {
    sheet: 'motion', row: 2, frames: 12, duration: 400,
    animation: 'mascot-sprite-active', iterations: '1', direction: 'reverse'
  },
  'cooling-office': { sheet: 'main', row: 9, frames: 6, duration: 1400, animation: 'mascot-sprite-active' }
}

const resolvedState = computed<string>(() => {
  if (props.animationState === 'jumping') return 'success'
  if (props.animationState === 'failed') return 'error'
  if (props.animationState) return props.animationState
  if (props.status === 'hover' || (props.status === 'idle' && isHovered.value)) return 'hover'
  return props.status
})

const runningDirection = computed<RunningDirection | undefined>(() => {
  if (resolvedState.value === 'running-left' || resolvedState.value === 'running-right') {
    return resolvedState.value
  }
  return undefined
})

watch(runningDirection, (direction, previousDirection) => {
  window.clearTimeout(runReturnTimer)
  runReturnTimer = undefined

  if (direction) {
    lastRunningDirection.value = direction
    showRunLayer.value = true
    isReturningFromRun.value = false
    return
  }

  if (!previousDirection) return
  isReturningFromRun.value = true
  runReturnTimer = window.setTimeout(() => {
    showRunLayer.value = false
    isReturningFromRun.value = false
    runReturnTimer = undefined
  }, 280)
}, { immediate: true })

const spriteStyle = computed(() => {
  const sprite = spriteStates[resolvedState.value] ?? spriteStates.idle
  const sheet = spriteSheets[sprite.sheet]
  // Active animations travel one full cell past the final frame. Combined
  // with steps(frameCount), this gives every frame an equal visible interval;
  // the old frameCount - 1 setup only showed the last frame at the loop reset.
  const isOneShot = sprite.iterations === '1'
  const stepCount = sprite.animation === 'mascot-sprite-active' && !isOneShot
    ? sprite.frames
    : Math.max(1, sprite.frames - 1)

  return {
    backgroundImage: `url(${sheet.url})`,
    '--sprite-display-width': `${SPRITE_DISPLAY_WIDTH}px`,
    '--sprite-display-height': `${SPRITE_DISPLAY_HEIGHT}px`,
    '--sprite-sheet-width': `${sheet.columns * SPRITE_DISPLAY_WIDTH}px`,
    '--sprite-sheet-height': `${sheet.rows * SPRITE_DISPLAY_HEIGHT}px`,
    '--sprite-row-offset': `-${sprite.row * SPRITE_DISPLAY_HEIGHT}px`,
    '--sprite-end-offset': `-${stepCount * SPRITE_DISPLAY_WIDTH}px`,
    '--sprite-animation': [
      sprite.animation,
      `${sprite.duration}ms`,
      `steps(${stepCount}, end)`,
      sprite.iterations ?? 'infinite',
      sprite.direction ?? 'normal',
      isOneShot ? 'both' : 'none'
    ].join(' ')
  }
})

onBeforeUnmount(() => {
  window.clearTimeout(runReturnTimer)
})
</script>

<template>
  <button
    class="mascot-avatar"
    :class="[
      `is-${status}`,
      `is-visual-${resolvedState}`,
      {
        'is-returning-from-run': isReturningFromRun,
        'is-returning-right': isReturningFromRun && lastRunningDirection === 'running-right',
        'is-returning-left': isReturningFromRun && lastRunningDirection === 'running-left'
      }
    ]"
    type="button"
    aria-label="单击打开输入框，双击打开工作台"
    @mouseenter="isHovered = true"
    @mouseleave="isHovered = false"
  >
    <span class="status-orbit" />
    <span
      class="mascot-sprite-stage"
      :class="{
        'is-running': Boolean(runningDirection),
        'is-returning': isReturningFromRun,
        'is-returning-right': isReturningFromRun && lastRunningDirection === 'running-right',
        'is-returning-left': isReturningFromRun && lastRunningDirection === 'running-left'
      }"
    >
      <span
        :key="runningDirection ? 'run-base' : resolvedState"
        class="mascot-sprite mascot-sprite--base"
        :style="spriteStyle"
        aria-hidden="true"
      />
      <MascotRunSprite
        v-if="showRunLayer"
        :direction="lastRunningDirection"
        :active="Boolean(runningDirection)"
      />
    </span>
  </button>
</template>
