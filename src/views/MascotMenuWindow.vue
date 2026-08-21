<script setup lang="ts">
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import { nextTick, onMounted, onUnmounted, ref } from 'vue'
import MascotContextMenu from '../components/MascotContextMenu.vue'
import {
  exitAssistant,
  ackMascotContextMenuLayout,
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
const isPlacementPreview = import.meta.env.DEV && previewParams.has('placement')
const menuGeneration = ref<number | null>(isPlacementPreview ? 0 : null)
const menuEntering = ref(isPlacementPreview)
const menuWindow = ref<HTMLElement | null>(null)
let removePlacementListener: UnlistenFn | undefined

function closeMenu() {
  menuGeneration.value = null
  menuEntering.value = false
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

async function applyPlacement(payload: MascotContextMenuPlacement) {
  const generation = payload.generation
  placement.value = payload.placement
  tailX.value = payload.tailX
  menuEntering.value = false
  // A generation key remounts the menu, which replays its focus initialization
  // and guarantees that every opening starts safely on “隐藏”.
  menuGeneration.value = generation
  await nextTick()
  // Windows suspends requestAnimationFrame for a fully hidden WebView2 HWND.
  // Reading layout after Vue's DOM flush proves that placement/tail styles are
  // committed without waiting for a frame that cannot run until native show.
  const menuWindowElement = menuWindow.value
  if (!menuWindowElement) {
    closeMenu()
    return
  }
  menuWindowElement.getBoundingClientRect()
  if (menuGeneration.value !== generation) return

  const shown = await ackMascotContextMenuLayout(generation)
  if (menuGeneration.value !== generation) return
  if (!shown) {
    menuGeneration.value = null
    return
  }
  // The native HWND is visible only after ACK succeeds. Starting the CSS
  // animation now ensures it is observable instead of running while hidden.
  menuEntering.value = true
}

onMounted(async () => {
  window.addEventListener('keydown', handleKeydown)
  removePlacementListener = await listen<MascotContextMenuPlacement>(
    'mascot-context-menu-placement',
    (event) => {
      void applyPlacement(event.payload)
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
    ref="menuWindow"
    class="mascot-menu-window"
    :class="`is-${placement}`"
    aria-label="机器人右键菜单窗口"
    @pointerdown.self="closeMenu"
    @contextmenu.prevent
  >
    <MascotContextMenu
      v-if="menuGeneration !== null"
      :key="menuGeneration"
      :x="12"
      :y="placement === 'above' ? 8 : 14"
      :width="192"
      :placement="placement"
      :tail-x="tailX"
      :entering="menuEntering"
      @hide="handleHide"
      @exit="handleExit"
      @close="closeMenu"
    />
  </section>
</template>
