<script setup lang="ts">
import { LogicalPosition } from '@tauri-apps/api/dpi'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { onMounted, onUnmounted, ref, watch, computed } from 'vue'
import type { UnlistenFn } from '@tauri-apps/api/event'
import { listen } from '@tauri-apps/api/event'
import AuthLoginTip from '../components/AuthLoginTip.vue'
import MascotContextMenu from '../components/MascotContextMenu.vue'
import MascotAvatar from '../components/MascotAvatar.vue'
import MascotBubble from '../components/MascotBubble.vue'
import SysMessageTip from '../components/SysMessageTip.vue'
import { hidePanelWindow, openWorkbench, setMascotNotificationVisible, setMascotPosition, syncPanelWindow, togglePanelWindow } from '../services/window.service'
import { useMascotStore } from '../stores/mascot'
import type { MascotAnimationState } from '../types/mascot'
import type { SysMessageNotification } from '../types/sys-message'

const props = defineProps<{
  needsAuth: boolean
  authPending: boolean
  authErrorMessage?: string
  showLogout: boolean
  sysMessage: SysMessageNotification | null
  sysMessageContent: string
  pendingSysMessageCount?: number
}>()

const emit = defineEmits<{
  login: []
  logout: []
  readSysMessage: [message: SysMessageNotification]
  viewSysMessage: [message: SysMessageNotification]
}>()

const mascotStore = useMascotStore()
const contextMenu = ref<{ x: number; y: number } | null>(null)
const isDragging = ref(false)
const contextMenuSize = { width: 124, height: 40 }
const animationState = ref<MascotAnimationState>()
const dragThreshold = 5
const avatarSingleClickDelayMs = 280
let dragState:
  | {
      pointerId: number
      startScreenX: number
      startScreenY: number
      startWindowX: number
      startWindowY: number
      startedOnAvatar: boolean
      dragging: boolean
    }
  | undefined
let pendingFrame = 0
let pendingPosition: LogicalPosition | undefined
let transientAnimationTimer: number | undefined
let avatarSingleClickTimer: number | undefined
let removeCloseOverlaysListener: UnlistenFn | undefined

function clearAvatarSingleClickTimer() {
  window.clearTimeout(avatarSingleClickTimer)
  avatarSingleClickTimer = undefined
}

function scheduleAvatarSingleClick() {
  if (avatarSingleClickTimer !== undefined) {
    clearAvatarSingleClickTimer()
    void openWorkbench()
    return
  }

  avatarSingleClickTimer = window.setTimeout(() => {
    avatarSingleClickTimer = undefined
    togglePanel()
  }, avatarSingleClickDelayMs)
}

function dismissTransientOverlays() {
  closeContextMenu()
  mascotStore.resetStatus()
}

function isOverlayInteraction(target: EventTarget | null) {
  return (
    target instanceof Element &&
    Boolean(target.closest('.auth-login-tip, .sys-message-tip, .mascot-context-menu, .mascot-bubble'))
  )
}

function togglePanel() {
  // 登录提示或系统消息展开时，优先让用户处理当前提示，避免吉祥物点击打开输入框。
  if (hasExpandedNotification.value) return

  dismissTransientOverlays()
  playTransientAnimation('waiting', 900)
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
  if (isOverlayInteraction(event.target)) return

  event.preventDefault()
  const target = event.currentTarget as HTMLElement
  target.setPointerCapture(event.pointerId)
  const startedOnAvatar =
    event.target instanceof Element && Boolean(event.target.closest('.mascot-avatar'))

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
      startedOnAvatar,
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
    void setMascotPosition(nextPosition.x, nextPosition.y)
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
  if (isOverlayInteraction(event.target)) {
    dragState = undefined
    isDragging.value = false
    return
  }

  const target = event.currentTarget as HTMLElement
  if (target.hasPointerCapture(event.pointerId)) {
    target.releasePointerCapture(event.pointerId)
  }

  const wasDragging = dragState.dragging
  const startedOnAvatar = dragState.startedOnAvatar
  dragState = undefined
  isDragging.value = false

  if (wasDragging) {
    animationState.value = undefined
    void syncPanelWindow()
    return
  }

  if (startedOnAvatar) {
    scheduleAvatarSingleClick()
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

  const wasDragging = dragState.dragging
  dragState = undefined
  isDragging.value = false
  animationState.value = undefined

  if (wasDragging) {
    void syncPanelWindow()
  }
}

function closeContextMenu() {
  contextMenu.value = null
}

function clampMenuPosition(x: number, y: number, width: number, height: number) {
  return {
    x: Math.min(Math.max(8, x), width - contextMenuSize.width - 8),
    y: Math.min(Math.max(8, y), height - contextMenuSize.height - 8)
  }
}

function handleContextMenu(event: MouseEvent) {
  event.preventDefault()
  // 登录提示已经提供登录入口时，不再显示重复的右键菜单入口。
  if (props.needsAuth) return
  if (!props.showLogout) return

  void hidePanelWindow()
  mascotStore.resetStatus()

  const container = event.currentTarget as HTMLElement
  const rect = container.getBoundingClientRect()
  const centeredX = (rect.width - contextMenuSize.width) / 2
  contextMenu.value = clampMenuPosition(centeredX, 10, rect.width, rect.height)
}

function handleOutsidePointerDown(event: PointerEvent) {
  const target = event.target
  if (target instanceof Element && target.closest('.mascot-context-menu')) return
  closeContextMenu()
}

watch(contextMenu, (menu) => {
  if (menu) {
    window.addEventListener('pointerdown', handleOutsidePointerDown, true)
    window.addEventListener('keydown', handleContextMenuKeydown)
  } else {
    window.removeEventListener('pointerdown', handleOutsidePointerDown, true)
    window.removeEventListener('keydown', handleContextMenuKeydown)
  }
})

function handleContextMenuKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape') closeContextMenu()
}

const hasBubbleMessage = computed(() => Boolean(mascotStore.message))
const hasExpandedNotification = computed(() => Boolean(props.sysMessage || props.needsAuth))
const isContextMenuOpen = computed(() => contextMenu.value !== null)
const avatarAnimationState = computed<MascotAnimationState | undefined>(() => {
  return props.sysMessage ? 'waving' : animationState.value
})
const isNotifying = computed(
  () => hasExpandedNotification.value || hasBubbleMessage.value || isContextMenuOpen.value
)

watch(
  () => props.sysMessage,
  (message) => {
    if (message) {
      closeContextMenu()
      void hidePanelWindow()
    }
  }
)

watch(hasBubbleMessage, (visible) => {
  if (!visible) return
  closeContextMenu()
  void hidePanelWindow()
})

watch(
  () => ({
    visible: isNotifying.value,
    compact: (hasBubbleMessage.value || isContextMenuOpen.value) && !hasExpandedNotification.value
  }),
  ({ visible, compact }) => {
    void setMascotNotificationVisible(visible, compact)
  },
  { immediate: true }
)

onMounted(async () => {
  removeCloseOverlaysListener = await listen('mascot-close-overlays', () => {
    dismissTransientOverlays()
  })
})

onUnmounted(() => {
  window.clearTimeout(transientAnimationTimer)
  clearAvatarSingleClickTimer()
  if (pendingFrame) window.cancelAnimationFrame(pendingFrame)
  window.removeEventListener('pointerdown', handleOutsidePointerDown, true)
  window.removeEventListener('keydown', handleContextMenuKeydown)
  removeCloseOverlaysListener?.()
  void setMascotNotificationVisible(false)
})
</script>

<template>
  <section
    class="mascot-window"
    :class="{
      'is-dragging': isDragging,
      'is-notifying': isNotifying,
      'has-expanded-notification': hasExpandedNotification
    }"
    @pointerdown="handlePointerDown"
    @pointermove="handlePointerMove"
    @pointerup="finishPointer"
    @pointercancel="cancelPointer"
    @contextmenu="handleContextMenu"
  >
    <MascotContextMenu
      v-if="contextMenu"
      :x="contextMenu.x"
      :y="contextMenu.y"
      :show-login="needsAuth"
      :show-logout="showLogout"
      @login="emit('login')"
      @logout="emit('logout')"
      @close="closeContextMenu"
    />
    <AuthLoginTip
      v-if="needsAuth"
      :pending="authPending"
      :message="authErrorMessage"
      @login="emit('login')"
    />
    <SysMessageTip
      v-else-if="sysMessage"
      :key="sysMessage.dedupeKey"
      :message="sysMessage"
      :display-content="sysMessageContent"
      :pending-count="pendingSysMessageCount || 0"
      @read="emit('readSysMessage', $event)"
      @view="emit('viewSysMessage', $event)"
    />
    <MascotBubble v-else-if="mascotStore.message" :message="mascotStore.message" />
    <MascotAvatar
      :status="mascotStore.status"
      :animation-state="avatarAnimationState"
    />
  </section>
</template>
