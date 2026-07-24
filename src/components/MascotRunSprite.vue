<script setup lang="ts">
import { computed } from 'vue'
import runningSpriteSheetUrl from '../assets/mascot/xiaoli-running-spritesheet.webp'
import type { RunningDirection } from '../utils/mascot-drag-motion'
import {
  mascotRunCycleDurationMs,
  mascotRunFrameCount
} from '../utils/mascot-run-timeline'

const props = defineProps<{
  direction: RunningDirection
  active: boolean
}>()

const SPRITE_WIDTH = 132
// Running feet dip lower than the other poses. Each atlas cell includes a
// dedicated 12px transparent floor so DPI resampling never clips a shoe.
const SPRITE_HEIGHT = 122
const SPRITE_SHEET_WIDTH = SPRITE_WIDTH * mascotRunFrameCount
const SPRITE_SHEET_HEIGHT = SPRITE_HEIGHT * 2

const frameStyle = computed<Record<string, string>>(() => ({
  backgroundImage: `url(${runningSpriteSheetUrl})`,
  backgroundSize: `${SPRITE_SHEET_WIDTH}px ${SPRITE_SHEET_HEIGHT}px`,
  '--run-row-offset': props.direction === 'running-right' ? '0px' : `-${SPRITE_HEIGHT}px`,
  '--run-last-frame-offset': `-${(mascotRunFrameCount - 1) * SPRITE_WIDTH}px`,
  '--run-cycle-duration': `${mascotRunCycleDurationMs}ms`,
  animationPlayState: props.active ? 'running' : 'paused'
}))
</script>

<template>
  <span class="mascot-run-sprite" aria-hidden="true">
    <span class="mascot-run-sprite__frame" :style="frameStyle" />
  </span>
</template>
