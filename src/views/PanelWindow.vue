<script setup lang="ts">
import { emitTo, listen } from '@tauri-apps/api/event'
import type { UnlistenFn } from '@tauri-apps/api/event'
import { onMounted, onUnmounted, ref } from 'vue'
import TodoInputBox from '../components/TodoInputBox.vue'
import {
  PANEL_REVEAL_EVENT,
  hidePanelWindow,
  openWorkbench,
  setPanelExpanded
} from '../services/window.service'
import { useMascotStore } from '../stores/mascot'
import type { MascotStatus } from '../types/mascot'

defineProps<{
  socketStatus: string
  mockEnabled: boolean
  task: unknown
}>()

const mascotStore = useMascotStore()
const inputBoxRef = ref<InstanceType<typeof TodoInputBox> | null>(null)
const loading = ref(false)
const isRevealing = ref(false)
let revealTimer: number | undefined
let revealFrame: number | undefined
let removeRevealListener: UnlistenFn | undefined

function playPanelReveal() {
  window.clearTimeout(revealTimer)
  window.cancelAnimationFrame(revealFrame ?? 0)
  isRevealing.value = false
  revealFrame = window.requestAnimationFrame(() => {
    isRevealing.value = true
    revealTimer = window.setTimeout(() => {
      isRevealing.value = false
    }, 220)
  })
  window.setTimeout(() => inputBoxRef.value?.focus(), 80)
}

onMounted(async () => {
  void setPanelExpanded(false)
  playPanelReveal()
  removeRevealListener = await listen(PANEL_REVEAL_EVENT, playPanelReveal)
})

onUnmounted(() => {
  window.clearTimeout(revealTimer)
  window.cancelAnimationFrame(revealFrame ?? 0)
  removeRevealListener?.()
})

function showMascotMessage(message: string, status?: MascotStatus, autoReset = false) {
  mascotStore.showMessage(message, status, autoReset)
  void emitTo('mascot', 'mascot-message', { message, status, autoReset })
}

async function submitTodo(text: string) {
  loading.value = true
  showMascotMessage('正在打开工作台...', 'thinking')
  try {
    await openWorkbench({ todoText: text })
    showMascotMessage('已打开工作台', 'success', true)
    void hidePanelWindow()
  } catch {
    showMascotMessage('打开工作台失败', 'error', true)
  } finally {
    loading.value = false
  }
}
</script>

<template>
  <section
    class="pet-prompt"
    :class="{ 'is-revealing': isRevealing }"
    aria-label="一句话创建"
  >
    <TodoInputBox ref="inputBoxRef" :loading="loading" @submit="submitTodo" />
    <span class="pet-prompt__tail" aria-hidden="true" />
  </section>
</template>
