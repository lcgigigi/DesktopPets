<script setup lang="ts">
import { emitTo, listen } from '@tauri-apps/api/event'
import type { UnlistenFn } from '@tauri-apps/api/event'
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import TaskPushCard from '../components/TaskPushCard.vue'
import TodoInputBox from '../components/TodoInputBox.vue'
import {
  PANEL_ACTIVITY_EVENT,
  PANEL_REVEAL_EVENT,
  hidePanelWindow,
  openWorkbench,
  setPanelActivity,
  setPanelHeight,
  type PanelRevealPayload,
} from '../services/window.service'
import { useMascotStore } from '../stores/mascot'
import { useTaskStore, type TaskItem } from '../stores/task'
import type { MascotStatus } from '../types/mascot'
import type { TaskAction } from '../types/task'

const props = defineProps<{
  socketStatus: string
  mockEnabled: boolean
  task: TaskItem | null
}>()

const TASK_PANEL_HEIGHT = 240
const mascotStore = useMascotStore()
const taskStore = useTaskStore()
const inputBoxRef = ref<InstanceType<typeof TodoInputBox> | null>(null)
const taskCardRef = ref<InstanceType<typeof TaskPushCard> | null>(null)
const loading = ref(false)
const submitError = ref('')
const isRevealing = ref(false)
const panelHasText = ref(false)
const panelFocused = ref(false)
const pendingTaskCount = computed(() => Math.max(0, taskStore.taskQueue.length - 1))
let revealTimer: number | undefined
let focusTimer: number | undefined
let revealFrame: number | undefined
let removeRevealListener: UnlistenFn | undefined
let removeSessionClearedListener: UnlistenFn | undefined
let panelActivityInitialized = false

function focusVisibleControl() {
  if (props.task) taskCardRef.value?.focusCard()
  else inputBoxRef.value?.focus()
}

function syncVisiblePanelHeight() {
  if (props.task) void setPanelHeight(TASK_PANEL_HEIGHT)
  else inputBoxRef.value?.syncHeight()
}

function playPanelReveal(options: PanelRevealPayload = { focus: false }) {
  window.clearTimeout(revealTimer)
  window.clearTimeout(focusTimer)
  window.cancelAnimationFrame(revealFrame ?? 0)
  isRevealing.value = false
  revealFrame = window.requestAnimationFrame(() => {
    isRevealing.value = true
    revealTimer = window.setTimeout(() => {
      isRevealing.value = false
    }, 220)
  })
  syncVisiblePanelHeight()
  publishPanelActivity()
  // Only a deliberate mascot click may move keyboard focus into the panel.
  // Server pushes and post-notification restores animate without activation or
  // preselecting the destructive completion action.
  if (options.focus) {
    focusTimer = window.setTimeout(focusVisibleControl, 80)
  }
}

onMounted(async () => {
  syncVisiblePanelHeight()
  publishPanelActivity()
  removeRevealListener = await listen<PanelRevealPayload>(PANEL_REVEAL_EVENT, (event) => {
    playPanelReveal(event.payload)
  })
  removeSessionClearedListener = await listen('desktop-session-cleared', async () => {
    submitError.value = ''
    loading.value = false
    await nextTick()
    inputBoxRef.value?.clear()
  })
})

onUnmounted(() => {
  window.clearTimeout(revealTimer)
  window.clearTimeout(focusTimer)
  window.cancelAnimationFrame(revealFrame ?? 0)
  removeRevealListener?.()
  removeSessionClearedListener?.()
})

watch(() => props.task, async () => {
  publishPanelActivity()
  await nextTick()
  syncVisiblePanelHeight()
})

function showMascotMessage(message: string, status?: MascotStatus, autoReset = false) {
  mascotStore.showMessage(message, status, autoReset)
  void emitTo('mascot', 'mascot-message', { message, status, autoReset })
}

function publishPanelActivity() {
  panelActivityInitialized = true
  const activity = {
    // A visible task is active panel content and must not be treated like an
    // empty draft by the native idle-hide policy.
    hasText: panelHasText.value || Boolean(props.task),
    focused: panelFocused.value,
  }
  void setPanelActivity(activity)
  void emitTo('mascot', PANEL_ACTIVITY_EVENT, activity)
}

function handleDraftChange(text: string) {
  const hasText = text.trim().length > 0
  if (panelActivityInitialized && panelHasText.value === hasText) return
  panelHasText.value = hasText
  publishPanelActivity()
}

function handleFocusChange(focused: boolean) {
  if (panelActivityInitialized && panelFocused.value === focused) return
  panelFocused.value = focused
  publishPanelActivity()
}

function handleHeightChange(height: number) {
  if (!props.task) void setPanelHeight(height)
}

async function submitTodo(text: string) {
  if (loading.value) return

  submitError.value = ''
  loading.value = true
  try {
    const opened = await openWorkbench({ todoText: text })
    if (!opened) {
      submitError.value = '未能打开工作台，请检查默认浏览器后重试。'
      return
    }

    inputBoxRef.value?.clear()
    const hidden = await hidePanelWindow()
    if (hidden) showMascotMessage('已打开工作台', 'success', true)
  } catch {
    submitError.value = '未能打开工作台，请检查默认浏览器后重试。'
  } finally {
    loading.value = false
    if (submitError.value) {
      await nextTick()
      inputBoxRef.value?.syncHeight()
      inputBoxRef.value?.focus()
    }
  }
}

async function handleTaskAction(eventId: string, taskId: string, action: TaskAction) {
  if (props.task?.handling) return

  const succeeded = await taskStore.handleAction(eventId, taskId, action)

  await nextTick()
  syncVisiblePanelHeight()
  if (!succeeded || action === 'confirm') focusVisibleControl()
}
</script>

<template>
  <section
    class="pet-prompt"
    :class="{ 'is-revealing': isRevealing, 'has-task': task }"
    :aria-label="task ? '任务提醒' : '一句话创建'"
  >
    <TaskPushCard
      v-if="task"
      ref="taskCardRef"
      :task="task"
      :pending-count="pendingTaskCount"
      @action="handleTaskAction"
    />
    <TodoInputBox
      v-else
      ref="inputBoxRef"
      :loading="loading"
      :error="submitError"
      @submit="submitTodo"
      @draft-change="handleDraftChange"
      @focus-change="handleFocusChange"
      @height-change="handleHeightChange"
    />
    <span class="pet-prompt__tail" aria-hidden="true" />
  </section>
</template>
