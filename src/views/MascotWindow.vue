<script setup lang="ts">
import { getCurrentWindow } from '@tauri-apps/api/window'
import { onMounted, onUnmounted, ref, watch, computed } from 'vue'
import type { UnlistenFn } from '@tauri-apps/api/event'
import { listen } from '@tauri-apps/api/event'
import AuthLoginTip from '../components/AuthLoginTip.vue'
import MascotContextMenu from '../components/MascotContextMenu.vue'
import MascotAvatar from '../components/MascotAvatar.vue'
import MascotBubble from '../components/MascotBubble.vue'
import SysMessageTip from '../components/SysMessageTip.vue'
import {
  MASCOT_NATIVE_DRAG_ENDED_EVENT,
  MASCOT_REVEAL_EVENT,
  hidePanelWindow,
  openWorkbench,
  peekMascotWindow,
  revealMascotWindow,
  setMascotNotificationVisible,
  startMascotWindowDrag,
  syncPanelWindow,
  togglePanelWindow
} from '../services/window.service'
import { useMascotStore } from '../stores/mascot'
import type { MascotAnimationState } from '../types/mascot'
import type { SysMessageNotification } from '../types/sys-message'
import {
  advanceRunningDirection,
  createRunningDirectionState
} from '../utils/mascot-drag-motion'

const props = defineProps<{
  needsAuth: boolean
  authPending: boolean
  authErrorMessage?: string
  showLogout: boolean
  sysMessage: SysMessageNotification | null
  sysMessageContent: string
  pendingSysMessageCount?: number
  sysMessageReadPending?: boolean
  sysMessageActionError?: string
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
const compactOverlaySize = { width: 220, height: 176 }
const animationState = ref<MascotAnimationState>()
const dragThreshold = 5
const avatarSingleClickDelayMs = 280
const idleHideDelayMs = 60 * 1000
const peekRevealDurationMs = 480
const nativeDragSafetyTimeoutMs = 15 * 1000
const isPeeked = ref(false)
const isPointerInside = ref(false)
const peekTransition = ref<'revealing'>()
let dragState:
  | {
      pointerId: number
      startScreenX: number
      startScreenY: number
      startedOnAvatar: boolean
      dragging: boolean
      nativeDragStarted: boolean
      lastScreenX: number
    }
  | undefined
let transientAnimationTimer: number | undefined
let avatarSingleClickTimer: number | undefined
let idleHideTimer: number | undefined
let peekTransitionTimer: number | undefined
let nativeDragIdleTimer: number | undefined
let lastNativeWindowX: number | undefined
let runningMotion = createRunningDirectionState()
let removeCloseOverlaysListener: UnlistenFn | undefined
let removeWindowMovedListener: UnlistenFn | undefined
let removeNativeDragEndedListener: UnlistenFn | undefined
let nativeNotificationLayout = { visible: false, compact: false }
let nativeNotificationLayoutGeneration = 0

function clearIdleHideTimer() {
  window.clearTimeout(idleHideTimer)
  idleHideTimer = undefined
}

function prefersReducedMotion() {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

async function syncNativeNotificationLayout(
  visible: boolean,
  compact: boolean,
  options: { reveal?: boolean; force?: boolean } = {}
) {
  const reveal = options.reveal ?? false
  if (
    !options.force
    && !reveal
    && nativeNotificationLayout.visible === visible
    && nativeNotificationLayout.compact === compact
  ) return

  const generation = ++nativeNotificationLayoutGeneration
  await setMascotNotificationVisible(visible, compact, {
    reveal,
    reducedMotion: prefersReducedMotion()
  })
  if (generation === nativeNotificationLayoutGeneration) {
    nativeNotificationLayout = { visible, compact }
  }
}

function scheduleIdleHide() {
  clearIdleHideTimer()
  if (isNotifying.value || isDragging.value || isPeeked.value || isPointerInside.value) return

  idleHideTimer = window.setTimeout(() => {
    idleHideTimer = undefined
    if (isNotifying.value || isDragging.value || isPointerInside.value) {
      scheduleIdleHide()
      return
    }
    isPeeked.value = true
    peekTransition.value = undefined
    void peekMascotWindow(prefersReducedMotion())
  }, idleHideDelayMs)
}

function handlePointerEnter() {
  isPointerInside.value = true
  clearIdleHideTimer()
  if (!isPeeked.value) return

  startPeekReveal()
}

function handlePointerLeave() {
  isPointerInside.value = false
  scheduleIdleHide()
}

function revealFromInteraction() {
  clearIdleHideTimer()
  const wasPeeked = startPeekReveal()
  scheduleIdleHide()
  return wasPeeked
}

function handleExternalReveal() {
  if (isPeeked.value) startPeekReveal(false)
  scheduleIdleHide()
}

function startPeekReveal(moveWindow = true) {
  if (!isPeeked.value) return false

  isPeeked.value = false
  peekTransition.value = 'revealing'
  window.clearTimeout(peekTransitionTimer)
  const reducedMotion = prefersReducedMotion()
  peekTransitionTimer = window.setTimeout(() => {
    peekTransition.value = undefined
  }, reducedMotion ? 0 : peekRevealDurationMs)
  if (moveWindow) void revealMascotWindow(reducedMotion)
  return true
}

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
  if (usesExpandedNotificationLayout.value) return

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

function resetRunningCadence() {
  runningMotion = createRunningDirectionState()
}

function resetRunningMotion() {
  resetRunningCadence()
  lastNativeWindowX = undefined
}

function updateRunningMotion(deltaX: number, forceDirection = false) {
  const result = advanceRunningDirection(runningMotion, deltaX, forceDirection)
  runningMotion = result.state
  if (result.changed && result.state.direction) {
    animationState.value = result.state.direction
  }
}

function handlePointerDown(event: PointerEvent) {
  if (event.button !== 0) return
  if (revealFromInteraction()) {
    event.preventDefault()
    return
  }
  if (isOverlayInteraction(event.target)) return

  event.preventDefault()
  const target = event.currentTarget as HTMLElement
  target.setPointerCapture(event.pointerId)
  const startedOnAvatar =
    event.target instanceof Element && Boolean(event.target.closest('.mascot-avatar'))

  dragState = {
    pointerId: event.pointerId,
    startScreenX: event.screenX,
    startScreenY: event.screenY,
    startedOnAvatar,
    dragging: false,
    nativeDragStarted: false,
    lastScreenX: event.screenX
  }
  resetRunningMotion()
}

function beginNativeDrag(target: HTMLElement) {
  if (!dragState || dragState.nativeDragStarted) return
  dragState.nativeDragStarted = true
  lastNativeWindowX = undefined

  if (target.hasPointerCapture(dragState.pointerId)) {
    target.releasePointerCapture(dragState.pointerId)
  }

  // Let the operating system compositor move the transparent window. Sending
  // one set-position IPC call per animation frame creates a command backlog on
  // Windows and is the source of the visible stop-start drag motion.
  void startMascotWindowDrag().catch(() => {
    finishNativeDrag()
  })
  window.clearTimeout(nativeDragIdleTimer)
  nativeDragIdleTimer = window.setTimeout(finishNativeDrag, nativeDragSafetyTimeoutMs)
}

function finishNativeDrag() {
  if (!isDragging.value) return
  dragState = undefined
  isDragging.value = false
  animationState.value = undefined
  resetRunningMotion()
  window.clearTimeout(nativeDragIdleTimer)
  nativeDragIdleTimer = undefined
  void syncPanelWindow()
  scheduleIdleHide()
}

function handlePointerMove(event: PointerEvent) {
  if (!dragState || event.pointerId !== dragState.pointerId) return

  const deltaX = event.screenX - dragState.startScreenX
  const deltaY = event.screenY - dragState.startScreenY
  if (!dragState.dragging && Math.hypot(deltaX, deltaY) < dragThreshold) return

  const incrementalDeltaX = event.screenX - dragState.lastScreenX
  dragState.lastScreenX = event.screenX

  const startedDragging = !dragState.dragging
  dragState.dragging = true
  isDragging.value = true
  updateRunningMotion(startedDragging ? deltaX : incrementalDeltaX, startedDragging)
  event.preventDefault()
  beginNativeDrag(event.currentTarget as HTMLElement)
}

function finishGlobalNativeDrag() {
  if (!dragState?.nativeDragStarted) return
  finishNativeDrag()
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

  if (wasDragging) {
    finishNativeDrag()
    return
  }

  dragState = undefined
  isDragging.value = false

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
  const nativeDragStarted = dragState.nativeDragStarted
  if (nativeDragStarted) return
  dragState = undefined
  isDragging.value = false
  animationState.value = undefined
  resetRunningMotion()

  if (wasDragging) {
    void syncPanelWindow()
  }
}

function closeContextMenu() {
  contextMenu.value = null
}

function clampMenuPosition(x: number, y: number, width: number, height: number) {
  const maxX = Math.max(8, width - contextMenuSize.width - 8)
  const maxY = Math.max(8, height - contextMenuSize.height - 8)

  return {
    x: Math.min(Math.max(8, x), maxX),
    y: Math.min(Math.max(8, y), maxY)
  }
}

function handleContextMenu(event: MouseEvent) {
  event.preventDefault()
  revealFromInteraction()
  if (usesExpandedNotificationLayout.value) return
  // 登录提示已经提供登录入口时，不再显示重复的右键菜单入口。
  if (props.needsAuth) return
  if (!props.showLogout) return

  void hidePanelWindow()
  mascotStore.resetStatus()

  const container = event.currentTarget as HTMLElement
  const rect = container.getBoundingClientRect()
  // The native window expands after this state update. Calculate against the
  // expanded width immediately so the menu never starts at a negative x.
  const overlayWidth = Math.max(rect.width, compactOverlaySize.width)
  const centeredX = (overlayWidth - contextMenuSize.width) / 2
  contextMenu.value = clampMenuPosition(
    centeredX,
    20,
    overlayWidth,
    Math.max(rect.height, compactOverlaySize.height)
  )
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
const isExpandedNotificationDismissing = ref(false)
const isBubbleMessageDismissing = ref(false)
const isContextMenuDismissing = ref(false)
const usesExpandedNotificationLayout = computed(
  () => hasExpandedNotification.value || isExpandedNotificationDismissing.value
)
const isContextMenuOpen = computed(() => contextMenu.value !== null)
const usesCompactNotificationLayout = computed(
  () => hasBubbleMessage.value
    || isBubbleMessageDismissing.value
    || isContextMenuOpen.value
    || isContextMenuDismissing.value
)
const avatarAnimationState = computed<MascotAnimationState | undefined>(() => {
  if (peekTransition.value === 'revealing') return 'revealing'
  if (isPeeked.value) return 'peeking'
  return props.sysMessage ? 'waving' : animationState.value
})
const isNotifying = computed(
  () => usesExpandedNotificationLayout.value || usesCompactNotificationLayout.value
)

watch(
  hasExpandedNotification,
  (visible, wasVisible) => {
    if (visible) {
      isExpandedNotificationDismissing.value = false
    } else if (wasVisible) {
      // Keep the large native window and flex layout until Vue has removed the
      // fading card. Shrinking earlier clips its top-left corner over Xiaoli.
      isExpandedNotificationDismissing.value = true
    }
  },
  { flush: 'sync' }
)

function hasVisibleOverlay() {
  return hasExpandedNotification.value || hasBubbleMessage.value || isContextMenuOpen.value
}

async function releaseDismissedNotificationLayout() {
  const releaseExpanded = !hasExpandedNotification.value && isExpandedNotificationDismissing.value
  const releaseBubble = !hasBubbleMessage.value && isBubbleMessageDismissing.value
  const releaseContextMenu = !isContextMenuOpen.value && isContextMenuDismissing.value
  if (!releaseExpanded && !releaseBubble && !releaseContextMenu) return

  // Preserve the current flex layout until the native window has already been
  // resized around the avatar. Releasing the class first lets one expanded
  // WebView frame recenter Xiaoli and is perceived as a position jump.
  if (!hasVisibleOverlay()) {
    await syncNativeNotificationLayout(false, false, { force: true })
  }

  if (releaseExpanded && !hasExpandedNotification.value) {
    isExpandedNotificationDismissing.value = false
  }
  if (releaseBubble && !hasBubbleMessage.value) {
    isBubbleMessageDismissing.value = false
  }
  if (releaseContextMenu && !isContextMenuOpen.value) {
    isContextMenuDismissing.value = false
  }

  // A new item can arrive while the native command is in flight. In that case
  // explicitly restore its requested layout because isNotifying may have stayed
  // true throughout and therefore not retriggered the watcher below.
  if (hasVisibleOverlay()) {
    await syncNativeNotificationLayout(
      true,
      !hasExpandedNotification.value,
      { force: true }
    )
  }
}

function handleExpandedOverlayAfterLeave() {
  void releaseDismissedNotificationLayout()
}

watch(
  hasBubbleMessage,
  (visible, wasVisible) => {
    if (visible) {
      isBubbleMessageDismissing.value = false
    } else if (wasVisible) {
      isBubbleMessageDismissing.value = true
    }
  },
  { flush: 'sync' }
)

watch(
  isContextMenuOpen,
  (visible, wasVisible) => {
    if (visible) {
      isContextMenuDismissing.value = false
    } else if (wasVisible) {
      isContextMenuDismissing.value = true
    }
  },
  { flush: 'sync' }
)

function handleContextMenuAfterLeave() {
  void releaseDismissedNotificationLayout()
}

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
    compact: usesCompactNotificationLayout.value && !usesExpandedNotificationLayout.value
  }),
  ({ visible, compact }) => {
    clearIdleHideTimer()
    let reveal = false
    if (visible) {
      if (isPeeked.value) reveal = startPeekReveal(false)
    } else {
      scheduleIdleHide()
    }
    void syncNativeNotificationLayout(visible, compact, { reveal })
  },
  { immediate: true }
)

onMounted(async () => {
  window.addEventListener(MASCOT_REVEAL_EVENT, handleExternalReveal)
  window.addEventListener('pointerup', finishGlobalNativeDrag, true)
  window.addEventListener('mouseup', finishGlobalNativeDrag, true)
  removeCloseOverlaysListener = await listen('mascot-close-overlays', () => {
    dismissTransientOverlays()
  })
  removeNativeDragEndedListener = await listen(MASCOT_NATIVE_DRAG_ENDED_EVENT, () => {
    finishNativeDrag()
  })
  removeWindowMovedListener = await getCurrentWindow().onMoved(({ payload }) => {
    if (!isDragging.value) return
    if (lastNativeWindowX !== undefined) {
      updateRunningMotion(payload.x - lastNativeWindowX)
    }
    lastNativeWindowX = payload.x
  })
  scheduleIdleHide()
})

onUnmounted(() => {
  window.clearTimeout(transientAnimationTimer)
  window.clearTimeout(peekTransitionTimer)
  window.clearTimeout(nativeDragIdleTimer)
  clearAvatarSingleClickTimer()
  clearIdleHideTimer()
  window.removeEventListener('pointerdown', handleOutsidePointerDown, true)
  window.removeEventListener('keydown', handleContextMenuKeydown)
  window.removeEventListener(MASCOT_REVEAL_EVENT, handleExternalReveal)
  window.removeEventListener('pointerup', finishGlobalNativeDrag, true)
  window.removeEventListener('mouseup', finishGlobalNativeDrag, true)
  removeCloseOverlaysListener?.()
  removeWindowMovedListener?.()
  removeNativeDragEndedListener?.()
  void syncNativeNotificationLayout(false, false, { force: true })
})
</script>

<template>
  <section
    class="mascot-window"
    :class="{
      'is-dragging': isDragging,
      'is-notifying': isNotifying,
      'has-expanded-notification': usesExpandedNotificationLayout
    }"
    @pointerdown="handlePointerDown"
    @pointerenter="handlePointerEnter"
    @pointerleave="handlePointerLeave"
    @pointermove="handlePointerMove"
    @pointerup="finishPointer"
    @pointercancel="cancelPointer"
    @contextmenu="handleContextMenu"
  >
    <Transition name="mascot-overlay" @after-leave="handleContextMenuAfterLeave">
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
    </Transition>
    <Transition
      name="mascot-overlay"
      mode="out-in"
      @after-leave="handleExpandedOverlayAfterLeave"
    >
      <AuthLoginTip
        v-if="needsAuth"
        key="auth-login"
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
        :read-pending="sysMessageReadPending"
        :action-error="sysMessageActionError"
        @read="emit('readSysMessage', $event)"
        @view="emit('viewSysMessage', $event)"
      />
      <MascotBubble
        v-else-if="mascotStore.message"
        key="mascot-message"
        :message="mascotStore.message"
      />
    </Transition>
    <MascotAvatar
      :status="mascotStore.status"
      :animation-state="avatarAnimationState"
    />
  </section>
</template>
