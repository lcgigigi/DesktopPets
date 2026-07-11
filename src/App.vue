<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import type { UnlistenFn } from '@tauri-apps/api/event'
import { emitTo, listen } from '@tauri-apps/api/event'
import MascotWindow from './views/MascotWindow.vue'
import PanelWindow from './views/PanelWindow.vue'
import { createDesktopAuthState, listenDesktopAuthCallbacks } from './services/desktop-auth.service'
import { onDesktopUnauthorized } from './services/request'
import { validateDesktopSession } from './services/session.service'
import { sysMessageService } from './services/sys-message.service'
import { websocketService } from './services/websocket.service'
import { openDesktopLogin, openSysMessageDetail, openWorkbench, showAssistant, showPanelWindow, hidePanelWindow } from './services/window.service'
import { useMascotStore } from './stores/mascot'
import { useTaskStore } from './stores/task'
import { useUserStore } from './stores/user'
import type { MascotStatus } from './types/mascot'
import type { SysMessageNotification } from './types/sys-message'
import type { TaskCreatedEvent } from './types/task'
import { env } from './utils/env'
import { storage } from './utils/storage'

const taskStore = useTaskStore()
const mascotStore = useMascotStore()
const userStore = useUserStore()
const windowMode = new URLSearchParams(window.location.search).get('window') || 'mascot'
const socketStatus = ref(env.enableMock ? 'mock' : 'closed')
const currentSysMessage = ref<SysMessageNotification | null>(null)
const sysMessageQueue = ref<SysMessageNotification[]>([])
const recentSysMessageKeys = new Set<string>()
const authPending = ref(false)
const SESSION_VALIDATION_INTERVAL = 5 * 60 * 1000
let removeTaskListener: (() => void) | undefined
let removeStatusListener: (() => void) | undefined
let removeTrayListener: (() => void) | undefined
let removeTrayLogoutListener: (() => void) | undefined
let removePanelTaskListener: (() => void) | undefined
let removeMascotMessageListener: (() => void) | undefined
let removeSysMessageListener: (() => void) | undefined
let removeDeepLinkListener: UnlistenFn | undefined
let removeUnauthorizedListener: (() => void) | undefined
let sessionValidationTimer: number | undefined

const currentTask = computed(() => taskStore.currentTask)
const sysMessageUserId = computed(() => userStore.userInfo?.userId || env.desktopUserId || env.mockUserId)
const needsAuth = computed(() => !env.enableMock && !userStore.isAuthenticated)
const showLogout = computed(() => !env.enableMock && userStore.isAuthenticated)

document.documentElement.dataset.window = windowMode
document.body.dataset.window = windowMode

function rememberSysMessageKey(key: string) {
  recentSysMessageKeys.add(key)
  window.setTimeout(() => recentSysMessageKeys.delete(key), 5000)
}

function showNextSysMessage() {
  currentSysMessage.value = sysMessageQueue.value.shift() ?? null
  if (currentSysMessage.value) {
    void emitTo('mascot', 'mascot-close-overlays', {})
    void hidePanelWindow()
  }
}

function pushSysMessage(message: SysMessageNotification) {
  if (recentSysMessageKeys.has(message.dedupeKey)) return
  rememberSysMessageKey(message.dedupeKey)

  void emitTo('mascot', 'mascot-close-overlays', {})

  if (currentSysMessage.value) {
    sysMessageQueue.value.push(message)
  } else {
    currentSysMessage.value = message
  }
  void hidePanelWindow()
}

function hideCurrentSysMessage(message: SysMessageNotification) {
  if (currentSysMessage.value?.dedupeKey === message.dedupeKey) {
    showNextSysMessage()
    return
  }

  sysMessageQueue.value = sysMessageQueue.value.filter((item) => item.dedupeKey !== message.dedupeKey)
}

function handleSysMessageRead(message: SysMessageNotification) {
  hideCurrentSysMessage(message)
}

function handleSysMessageView(message: SysMessageNotification) {
  const detailId = message.bizId || message.id
  storage.setLastSysMessageDetail({
    messageId: message.id,
    detailId,
    bizType: message.bizType
  })
  hideCurrentSysMessage(message)
  void openSysMessageDetail(message)
}

function connectDesktopSockets(options: { force?: boolean } = {}) {
  if (needsAuth.value) return

  websocketService.connect()
  sysMessageService.connect(sysMessageUserId.value, options)
}

function stopSessionValidation() {
  window.clearInterval(sessionValidationTimer)
  sessionValidationTimer = undefined
}

function clearDesktopSession(message: string, status: MascotStatus = 'remind') {
  websocketService.disconnect()
  sysMessageService.disconnect()
  userStore.clearSession()
  authPending.value = false
  currentSysMessage.value = null
  sysMessageQueue.value = []
  recentSysMessageKeys.clear()
  socketStatus.value = env.enableMock ? 'mock' : 'closed'
  stopSessionValidation()
  mascotStore.showMessage(message, status, true)
}

function handleSessionExpired() {
  if (!userStore.isAuthenticated || env.enableMock) return
  clearDesktopSession('登录状态已过期，请重新登录', 'remind')
}

async function validateAndRestoreSession(options: { forceReconnect?: boolean } = {}) {
  if (env.enableMock || !userStore.isAuthenticated) return

  const currentUserId = userStore.userInfo?.userId || ''
  const result = await validateDesktopSession(currentUserId)
  if (result.status === 'unauthorized') {
    handleSessionExpired()
    return
  }

  if (result.status === 'valid') {
    userStore.setUserInfo(result.userInfo)
  }

  connectDesktopSockets({ force: options.forceReconnect })
}

function startSessionValidation() {
  stopSessionValidation()
  if (env.enableMock || !userStore.isAuthenticated) return

  sessionValidationTimer = window.setInterval(() => {
    void validateAndRestoreSession({ forceReconnect: true })
  }, SESSION_VALIDATION_INTERVAL)
}

function startDesktopLogin() {
  const state = createDesktopAuthState()
  authPending.value = true
  void hidePanelWindow()
  mascotStore.showMessage('已打开网页登录', 'thinking', true)
  void openDesktopLogin(state)
}

function handleLogout() {
  if (!userStore.isAuthenticated) {
    mascotStore.showMessage('当前未登录', 'thinking', true)
    return
  }

  if (env.enableMock) {
    clearDesktopSession('已清除本地登录态', 'success')
    return
  }

  clearDesktopSession('已退出登录', 'success')
}

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
      void emitTo('mascot', 'mascot-close-overlays', {})
      void showPanelWindow()
      void emitTo('panel', 'task-created', event)
    })
    removeStatusListener = websocketService.onStatus((status) => {
      socketStatus.value = status
      void emitTo('panel', 'socket-status', status)
    })
    removeSysMessageListener = sysMessageService.onMessage((message) => {
      pushSysMessage(message)
    })
    removeUnauthorizedListener = onDesktopUnauthorized(handleSessionExpired)
    removeDeepLinkListener = await listenDesktopAuthCallbacks((payload) => {
      userStore.setSession(payload)
      authPending.value = false
      mascotStore.showMessage('登录成功，消息提醒已开启', 'success', true)
      connectDesktopSockets({ force: true })
      startSessionValidation()
      void validateAndRestoreSession()
    })
    if (needsAuth.value) {
      mascotStore.showMessage('请先登录后接收消息', 'remind', true)
    } else {
      void validateAndRestoreSession({ forceReconnect: true })
      startSessionValidation()
    }
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
      removeTrayLogoutListener = await listen('tray-logout', () => handleLogout())
    } catch {
      removeTrayListener = undefined
      removeTrayLogoutListener = undefined
    }
  }
})

onUnmounted(() => {
  removeTaskListener?.()
  removeStatusListener?.()
  removeTrayListener?.()
  removeTrayLogoutListener?.()
  removePanelTaskListener?.()
  removeMascotMessageListener?.()
  removeSysMessageListener?.()
  removeDeepLinkListener?.()
  removeUnauthorizedListener?.()
  stopSessionValidation()
  if (windowMode === 'mascot') {
    websocketService.disconnect()
    sysMessageService.disconnect()
  }
})
</script>

<template>
  <main class="app-shell" :class="[`is-${windowMode}`]">
    <MascotWindow
      v-if="windowMode === 'mascot'"
      :needs-auth="needsAuth"
      :auth-pending="authPending"
      :show-logout="showLogout"
      :sys-message="currentSysMessage"
      :pending-sys-message-count="sysMessageQueue.length"
      @login="startDesktopLogin"
      @logout="handleLogout"
      @read-sys-message="handleSysMessageRead"
      @view-sys-message="handleSysMessageView"
    />
    <PanelWindow v-else :socket-status="socketStatus" :mock-enabled="env.enableMock" :task="currentTask" />
  </main>
</template>
