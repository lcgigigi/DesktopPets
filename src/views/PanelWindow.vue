<script setup lang="ts">
import { emitTo } from '@tauri-apps/api/event'
import { onMounted, ref } from 'vue'
import TodoInputBox from '../components/TodoInputBox.vue'
import { hidePanelWindow, openWorkbench, setPanelExpanded } from '../services/window.service'
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

onMounted(() => {
  void setPanelExpanded(false)
  window.setTimeout(() => inputBoxRef.value?.focus(), 80)
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
  <section class="pet-prompt" aria-label="一句话创建">
    <TodoInputBox ref="inputBoxRef" :loading="loading" @submit="submitTodo" />
    <span class="pet-prompt__tail" aria-hidden="true" />
  </section>
</template>
