<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { emitTo, listen } from '@tauri-apps/api/event'
import MascotWindow from './views/MascotWindow.vue'
import PanelWindow from './views/PanelWindow.vue'
import { websocketService } from './services/websocket.service'
import { openWorkbench, showAssistant, showPanelWindow } from './services/window.service'
import { useMascotStore } from './stores/mascot'
import { useTaskStore } from './stores/task'
import type { MascotStatus } from './types/mascot'
import type { TaskCreatedEvent } from './types/task'
import { env } from './utils/env'

const taskStore = useTaskStore()
const mascotStore = useMascotStore()
const windowMode = new URLSearchParams(window.location.search).get('window') || 'mascot'
const socketStatus = ref(env.enableMock ? 'mock' : 'closed')
let removeTaskListener: (() => void) | undefined
let removeStatusListener: (() => void) | undefined
let removeTrayListener: (() => void) | undefined
let removePanelTaskListener: (() => void) | undefined
let removeMascotMessageListener: (() => void) | undefined

const currentTask = computed(() => taskStore.currentTask)

document.documentElement.dataset.window = windowMode
document.body.dataset.window = windowMode

onMounted(async () => {
  if (windowMode === 'mascot') {
    removeMascotMessageListener = await listen<{
      message: string
      status?: MascotStatus
      autoReset?: boolean
    }>('mascot-message', (event) => {
      mascotStore.showMessage(event.payload.message, event.payload.status, event.payload.autoReset)
    })

    removeTaskListener = websocketService.onTask((event) => {
      mascotStore.showMessage('收到一个新任务', 'remind', true)
      void showPanelWindow()
      void emitTo('panel', 'task-created', event)
    })
    removeStatusListener = websocketService.onStatus((status) => {
      socketStatus.value = status
      void emitTo('panel', 'socket-status', status)
    })
    websocketService.connect()
    void showAssistant()
  }

  if (windowMode === 'panel') {
    try {
      removePanelTaskListener = await listen<TaskCreatedEvent>('task-created', (event) => {
        taskStore.pushTask(event.payload)
      })
      removeStatusListener = await listen<string>('socket-status', (event) => {
        socketStatus.value = event.payload
      })
    } catch {
      removePanelTaskListener = undefined
      removeStatusListener = undefined
    }
  }

  if (windowMode === 'mascot') {
    try {
      removeTrayListener = await listen('tray-open-workbench', () => openWorkbench())
    } catch {
      removeTrayListener = undefined
    }
  }
})

onUnmounted(() => {
  removeTaskListener?.()
  removeStatusListener?.()
  removeTrayListener?.()
  removePanelTaskListener?.()
  removeMascotMessageListener?.()
  if (windowMode === 'mascot') {
    websocketService.disconnect()
  }
})
</script>

<template>
  <main class="app-shell" :class="[`is-${windowMode}`]">
    <MascotWindow v-if="windowMode === 'mascot'" />
    <PanelWindow v-else :socket-status="socketStatus" :mock-enabled="env.enableMock" :task="currentTask" />
  </main>
</template>
