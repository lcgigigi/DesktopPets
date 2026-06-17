<script setup lang="ts">
import { computed, ref } from 'vue'
import libaoUrl from '../assets/mascot/libao.png'
import type { MascotAnimationState, MascotStatus } from '../types/mascot'

const props = defineProps<{
  status: MascotStatus
  animationState?: MascotAnimationState
}>()

const isHovered = ref(false)

const resolvedState = computed<MascotStatus | MascotAnimationState>(() => {
  if (props.animationState) return props.animationState
  if (isHovered.value && props.status === 'idle') return 'hover'
  return props.status
})
</script>

<template>
  <button
    class="mascot-avatar"
    :class="[`is-${status}`, `is-visual-${resolvedState}`]"
    type="button"
    aria-label="打开华力 AI 桌面助手"
    @pointerenter="isHovered = true"
    @pointerleave="isHovered = false"
  >
    <span class="status-orbit" />
    <img
      class="mascot-sprite"
      :src="libaoUrl"
      alt=""
      aria-hidden="true"
    >
  </button>
</template>
