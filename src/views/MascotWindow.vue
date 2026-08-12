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
  PANEL_ACTIVITY_EVENT,
  PANEL_VISIBILITY_EVENT,
  type MascotDockSide,
  type PanelActivityPayload,
  exitAssistant,
  hideAssistant,
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
import {
  getMascotContextMenuLayout
} from '../utils/mascot-context-menu-layout'
import { canOpenMascotTodoPanel } from '../utils/mascot-panel-access'
import { shouldPauseMascotIdleHide } from '../utils/mascot-idle-policy'

const props = defineProps<{
  needsAuth: boolean
  authPending: boolean
  authErrorMessage?: string
  sysMessage: SysMessageNotification | null
  sysMessageContent: string
  pendingSysMessageCount?: number
  sysMessageReadPending?: boolean
  sysMessageActionError?: string
}>()

const emit = defineEmits<{
  login: []
  readSysMessage: [message: SysMessageNotification]
  viewSysMessage: [message: SysMessageNotification]
}>()

const mascotStore = useMascotStore()
const previewAnimationStates: readonly MascotAnimationState[] = [
  'idle',
  'running-left',
  'running-right',
  'waving',
  'jumping',
  'failed',
  'waiting',
  'remind',
  'success',
  'cooling-office',
  'peeking',
  'peeking-left',
  'revealing',
  'revealing-left'
]
const requestedPreviewAnimation = import.meta.env.DEV
  ? new URLSearchParams(window.location.search).get('previewAnimation')
  : null
const previewAnimationState = requestedPreviewAnimation
  && previewAnimationStates.includes(requestedPreviewAnimation as MascotAnimationState)
  ? requestedPreviewAnimation as MascotAnimationState
  : undefined
const contextMenu = ref<{ x: number; y: number; width: number } | null>(null)
const isDragging = ref(false)
const animationState = ref<MascotAnimationState>()
const dragThreshold = 8
const avatarSingleClickDelayMs = 280
const idleHideDelayMs = 60 * 1000
const peekRevealDurationMs = 480
const nativeDragSafetyTimeoutMs = 15 * 1000
const isPeeked = ref(false)
const peekSide = ref<MascotDockSide>('right')
const isPointerInside = ref(false)
const panelVisible = ref(false)
const panelHasText = ref(false)
const panelFocused = ref(false)
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
let contextMenuOpeningGeneration = 0
let runningMotion = createRunningDirectionState()
let removeCloseOverlaysListener: UnlistenFn | undefined
let removePanelActivityListener: UnlistenFn | undefined
let removePanelVisibilityListener: UnlistenFn | undefined
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
  if (shouldPauseIdleHide()) return

  idleHideTimer = window.setTimeout(() => {
    idleHideTimer = undefined
    if (shouldPauseIdleHide()) {
      scheduleIdleHide()
      return
    }
    void peekMascotWindow(prefersReducedMotion()).then((side) => {
      if (!side) {
        refreshIdleHideSchedule()
        return
      }
      peekSide.value = side
      isPeeked.value = true
      peekTransition.value = undefined
    })
  }, idleHideDelayMs)
}

function shouldPauseIdleHide() {
  return shouldPauseMascotIdleHide({
    isNotifying: isNotifying.value,
    isDragging: isDragging.value,
    isPeeked: isPeeked.value,
    isPointerInside: isPointerInside.value,
    panelVisible: panelVisible.value,
    panelHasText: panelHasText.value,
    panelFocused: panelFocused.value
  })
}

function refreshIdleHideSchedule() {
  if (shouldPauseIdleHide()) {
    clearIdleHideTimer()
  } else {
    scheduleIdleHide()
  }
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
  if (!canOpenMascotTodoPanel(props.needsAuth, Boolean(props.sysMessage))) return

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
  contextMenuOpeningGeneration += 1
  contextMenu.value = null
}

function viewportMatchesContextMenuLayout(container: HTMLElement, expanded: boolean) {
  const rect = container.getBoundingClientRect()
  const layout = getMascotContextMenuLayout(rect.width, rect.height, expanded)
  return layout.fitsHorizontally && layout.fitsAboveAvatar
}

async function waitForContextMenuViewport(container: HTMLElement, expanded: boolean) {
  if (viewportMatchesContextMenuLayout(container, expanded)) return

  const deadline = performance.now() + 600
  while (performance.now() < deadline) {
    await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()))
    if (viewportMatchesContextMenuLayout(container, expanded)) return
  }
}

async function handleContextMenu(event: MouseEvent) {
  event.preventDefault()
  if (!(event.target instanceof Element) || !event.target.closest('.mascot-avatar')) return

  const openingGeneration = ++contextMenuOpeningGeneration
  revealFromInteraction()

  void hidePanelWindow()
  mascotStore.resetStatus()

  const container = event.currentTarget as HTMLElement
  let isExpanded = usesExpandedNotificationLayout.value
  // Resize the transparent native window before rendering the menu. On
  // 125%-200% Windows DPI the WebView resize event can trail SetWindowPos;
  // rendering first leaves the menu inside the old 168px-wide viewport.
  await syncNativeNotificationLayout(true, !isExpanded, { force: true })
  if (openingGeneration !== contextMenuOpeningGeneration) return
  isExpanded = usesExpandedNotificationLayout.value
  await waitForContextMenuViewport(container, isExpanded)
  if (openingGeneration !== contextMenuOpeningGeneration) return

  const rect = container.getBoundingClientRect()
  contextMenu.value = getMascotContextMenuLayout(rect.width, rect.height, isExpanded)
}

function handleHide() {
  closeContextMenu()
  mascotStore.resetStatus()
  void hideAssistant()
}

function handleExit() {
  closeContextMenu()
  void exitAssistant()
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
const hasExpandedNotification = computed(
  () => Boolean(props.sysMessage || props.needsAuth)
)
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
  if (previewAnimationState) return previewAnimationState
  if (peekTransition.value === 'revealing') {
    return peekSide.value === 'left' ? 'revealing-left' : 'revealing'
  }
  if (isPeeked.value) return peekSide.value === 'left' ? 'peeking-left' : 'peeking'
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

watch(
  () => props.needsAuth,
  (needsAuth) => {
    if (needsAuth) void hidePanelWindow()
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
  removePanelActivityListener = await listen<PanelActivityPayload>(PANEL_ACTIVITY_EVENT, (event) => {
    panelHasText.value = event.payload.hasText
    panelFocused.value = event.payload.focused
    refreshIdleHideSchedule()
  })
  removePanelVisibilityListener = await listen<boolean>(PANEL_VISIBILITY_EVENT, (event) => {
    panelVisible.value = event.payload
    if (!event.payload) panelFocused.value = false
    refreshIdleHideSchedule()
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

  // The initial reactive watcher can run while the native window is still
  // completing setup. Reapply the desired bounds after mount so a first-run
  // login card cannot be rendered inside the collapsed 168x144 mascot window
  // and survive only as a clipped horizontal border.
  await syncNativeNotificationLayout(
    isNotifying.value,
    usesCompactNotificationLayout.value && !usesExpandedNotificationLayout.value,
    { force: true }
  )
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
  removePanelActivityListener?.()
  removePanelVisibilityListener?.()
  removeWindowMovedListener?.()
  removeNativeDragEndedListener?.()
  void syncNativeNotificationLayout(false, false, { force: true })
})
</script>

<template>
  <section
    class="mascot-window"
    :class="{
      'is-dragging': isDragging || previewAnimationState?.startsWith('running-'),
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
        :width="contextMenu.width"
        @hide="handleHide"
        @exit="handleExit"
        @close="closeContextMenu"
      />
    </Transition>
    <Transition
      name="mascot-overlay"
      mode="out-in"
      @after-leave="handleExpandedOverlayAfterLeave"
    >
      <AuthLoginTip
        v-if="needsAuth && !isContextMenuOpen"
        key="auth-login"
        :pending="authPending"
        :message="authErrorMessage"
        @login="emit('login')"
      />
      <SysMessageTip
        v-else-if="sysMessage && !isContextMenuOpen"
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
