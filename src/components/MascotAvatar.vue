<script setup lang="ts">
import { computed, ref } from 'vue'
import greetingSpriteUrl from '../assets/mascot/ip-design/xiaoli-action-greeting-strip.png'
import workingSpriteUrl from '../assets/mascot/ip-design/xiaoli-action-working-strip.png'
import type { MascotAnimationState, MascotStatus } from '../types/mascot'

const props = defineProps<{
  status: MascotStatus
  animationState?: MascotAnimationState
}>()

const isHovered = ref(false)
const workingStates: ReadonlyArray<MascotStatus | MascotAnimationState> = [
  'thinking',
  'waiting',
  'running-left',
  'running-right',
  'failed',
  'error',
  'cooling-office'
]

const resolvedState = computed<MascotStatus | MascotAnimationState>(() => {
  if (props.animationState) return props.animationState
  if (isHovered.value && props.status === 'idle') return 'hover'
  return props.status
})

const spriteUrl = computed(() => {
  return workingStates.includes(resolvedState.value) ? workingSpriteUrl : greetingSpriteUrl
})
</script>

<template>
  <button
    class="mascot-avatar"
    :class="[`is-${status}`, `is-visual-${resolvedState}`]"
    type="button"
    aria-label="单击打开输入框，双击打开工作台"
    @pointerenter="isHovered = true"
    @pointerleave="isHovered = false"
  >
    <span class="status-orbit" />
    <span
      class="mascot-sprite"
      :style="{ backgroundImage: `url(${spriteUrl})` }"
      aria-hidden="true"
    />
  </button>
</template>
