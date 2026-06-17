<script setup lang="ts">
import { LogicalPosition } from '@tauri-apps/api/dpi'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { onUnmounted, ref } from 'vue'
import MascotAvatar from '../components/MascotAvatar.vue'
import MascotBubble from '../components/MascotBubble.vue'
import { syncPanelWindow, togglePanelWindow } from '../services/window.service'
import { useMascotStore } from '../stores/mascot'
import type { MascotAnimationState } from '../types/mascot'

const mascotStore = useMascotStore()
const isDragging = ref(false)
const animationState = ref<MascotAnimationState>()
const dragThreshold = 5
let dragState:
  | {
      pointerId: number
      startScreenX: number
      startScreenY: number
      startWindowX: number
      startWindowY: number
      dragging: boolean
    }
  | undefined
let pendingFrame = 0
let pendingPosition: LogicalPosition | undefined
let transientAnimationTimer: number | undefined

function togglePanel() {
  playTransientAnimation('jumping', 520)
  void togglePanelWindow()
}

function playTransientAnimation(state: MascotAnimationState, durationMs: number) {
  animationState.value = state
  window.clearTimeout(transientAnimationTimer)
  transientAnimationTimer = window.setTimeout(() => {
    animationState.value = undefined
  }, durationMs)
}

async function handlePointerDown(event: PointerEvent) {
  if (event.button !== 0) return

  event.preventDefault()
  const target = event.currentTarget as HTMLElement
  target.setPointerCapture(event.pointerId)

  try {
    const appWindow = getCurrentWindow()
    const [position, scaleFactor] = await Promise.all([appWindow.outerPosition(), appWindow.scaleFactor()])
    const logicalPosition = position.toLogical(scaleFactor)
    dragState = {
      pointerId: event.pointerId,
      startScreenX: event.screenX,
      startScreenY: event.screenY,
      startWindowX: logicalPosition.x,
      startWindowY: logicalPosition.y,
      dragging: false
    }
  } catch {
    dragState = undefined
  }
}

function schedulePosition(position: LogicalPosition) {
  pendingPosition = position
  if (pendingFrame) return

  pendingFrame = window.requestAnimationFrame(() => {
    pendingFrame = 0
    if (!pendingPosition) return
    const nextPosition = pendingPosition
    pendingPosition = undefined
    void getCurrentWindow().setPosition(nextPosition)
  })
}

function handlePointerMove(event: PointerEvent) {
  if (!dragState || event.pointerId !== dragState.pointerId) return

  const deltaX = event.screenX - dragState.startScreenX
  const deltaY = event.screenY - dragState.startScreenY
  if (!dragState.dragging && Math.hypot(deltaX, deltaY) < dragThreshold) return

  dragState.dragging = true
  isDragging.value = true
  animationState.value = deltaX < 0 ? 'running-left' : 'running-right'
  event.preventDefault()
  schedulePosition(new LogicalPosition(dragState.startWindowX + deltaX, dragState.startWindowY + deltaY))
}

function finishPointer(event: PointerEvent) {
  if (!dragState || event.pointerId !== dragState.pointerId) return

  const target = event.currentTarget as HTMLElement
  if (target.hasPointerCapture(event.pointerId)) {
    target.releasePointerCapture(event.pointerId)
  }

  const wasDragging = dragState.dragging
  dragState = undefined
  isDragging.value = false

  if (wasDragging) {
    playTransientAnimation('jumping', 360)
    void syncPanelWindow()
    return
  }

  togglePanel()
}

function cancelPointer(event: PointerEvent) {
  if (!dragState || event.pointerId !== dragState.pointerId) return

  const target = event.currentTarget as HTMLElement
  if (target.hasPointerCapture(event.pointerId)) {
    target.releasePointerCapture(event.pointerId)
  }
  dragState = undefined
  isDragging.value = false
  animationState.value = undefined
}

onUnmounted(() => {
  window.clearTimeout(transientAnimationTimer)
  if (pendingFrame) window.cancelAnimationFrame(pendingFrame)
})
</script>

<template>
  <section
    class="mascot-window"
    :class="{ 'is-dragging': isDragging }"
    @pointerdown="handlePointerDown"
    @pointermove="handlePointerMove"
    @pointerup="finishPointer"
    @pointercancel="cancelPointer"
    @contextmenu.prevent
  >
    <MascotBubble :message="mascotStore.message" />
    <MascotAvatar :status="mascotStore.status" :animation-state="animationState" />
  </section>
</template>
