<script setup lang="ts">
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import { onMounted, onUnmounted, ref } from 'vue'
import MascotContextMenu from '../components/MascotContextMenu.vue'
import {
  exitAssistant,
  hideAssistant,
  hideMascotContextMenu,
  setMascotContextMenuReady,
  type MascotContextMenuPlacement
} from '../services/window.service'

const previewParams = new URLSearchParams(window.location.search)
const previewPlacement = previewParams?.get('placement')
const placement = ref<'above' | 'below'>(previewPlacement === 'below' ? 'below' : 'above')
const requestedTailX = Number(previewParams?.get('tailX'))
const tailX = ref(Number.isFinite(requestedTailX) ? requestedTailX : 84)
let removePlacementListener: UnlistenFn | undefined

function closeMenu() {
  void hideMascotContextMenu()
}

function handleHide() {
  void hideAssistant()
}

function handleExit() {
  void exitAssistant()
}

function handleKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape') closeMenu()
}

onMounted(async () => {
  window.addEventListener('keydown', handleKeydown)
  removePlacementListener = await listen<MascotContextMenuPlacement>(
    'mascot-context-menu-placement',
    (event) => {
      placement.value = event.payload.placement
      tailX.value = event.payload.tailX
    }
  )
  await setMascotContextMenuReady()
})

onUnmounted(() => {
  window.removeEventListener('keydown', handleKeydown)
  removePlacementListener?.()
})
</script>

<template>
  <section
    class="mascot-menu-window"
    :class="`is-${placement}`"
    aria-label="机器人右键菜单窗口"
    @pointerdown.self="closeMenu"
    @contextmenu.prevent
  >
    <MascotContextMenu
      :x="12"
      :y="placement === 'above' ? 4 : 14"
      :width="168"
      :placement="placement"
      :tail-x="tailX"
      @hide="handleHide"
      @exit="handleExit"
      @close="closeMenu"
    />
  </section>
</template>
