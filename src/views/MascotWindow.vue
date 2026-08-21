<script setup lang="ts">
import { getCurrentWindow } from '@tauri-apps/api/window'
import { nextTick, onMounted, onUnmounted, ref, watch, computed } from 'vue'
import type { UnlistenFn } from '@tauri-apps/api/event'
import { listen } from '@tauri-apps/api/event'
import AuthLoginTip from '../components/AuthLoginTip.vue'
import MascotAvatar from '../components/MascotAvatar.vue'
import MascotBubble from '../components/MascotBubble.vue'
import SysMessageTip from '../components/SysMessageTip.vue'
import {
  MASCOT_NATIVE_DRAG_ENDED_EVENT,
  MASCOT_NATIVE_REVEALED_EVENT,
  MASCOT_CONTEXT_MENU_VISIBILITY_EVENT,
  MASCOT_REVEAL_EVENT,
  PANEL_ACTIVITY_EVENT,
  PANEL_VISIBILITY_EVENT,
  type MascotDockSide,
  type PanelActivityPayload,
  finishMascotNotificationCollapse,
  hidePanelWindow,
  openWorkbench,
  peekMascotWindow,
  revealMascotWindow,
  setMascotNotificationVisible,
  showNotificationWindow,
  showMascotContextMenu,
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
import { mascotWaitingInteractionMs } from '../utils/mascot-animation-timing'
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
  sysMessageReadAllPending?: boolean
  sysMessageActionError?: string
}>()

const emit = defineEmits<{
  login: []
  readSysMessage: [message: SysMessageNotification]
  readAllSysMessages: []
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
const isDragging = ref(false)
const animationState = ref<MascotAnimationState>()
const dragThreshold = 8
const avatarSingleClickDelayMs = 280
const idleHideDelayMs = 60 * 1000
const peekHideDurationMs = 560
const peekRevealDurationMs = 480
const nativeDragSafetyTimeoutMs = 15 * 1000
const notificationLayoutRetryDelayMs = 120
const scaleChangeLayoutDebounceMs = 48
const isPeeked = ref(false)
const peekSide = ref<MascotDockSide>('right')
const isPointerInside = ref(false)
const panelVisible = ref(false)
const panelHasText = ref(false)
const panelFocused = ref(false)
const isContextMenuVisible = ref(false)
const peekTransition = ref<'peeking' | 'revealing'>()
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
let removePanelActivityListener: UnlistenFn | undefined
let removePanelVisibilityListener: UnlistenFn | undefined
let removeWindowMovedListener: UnlistenFn | undefined
let removeWindowScaleChangedListener: UnlistenFn | undefined
let removeNativeDragEndedListener: UnlistenFn | undefined
let removeNativeRevealedListener: UnlistenFn | undefined
let removeContextMenuVisibilityListener: UnlistenFn | undefined
let nativeNotificationLayout = { visible: false, compact: false }
let nativeNotificationLayoutGeneration = 0
let notificationLayoutRetryTimer: number | undefined
let scaleChangeLayoutTimer: number | undefined
let notificationRevealGeneration = 0
let notificationCoordinatorReady = false
let scaleChangeLayoutPending = false

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
  options: { reveal?: boolean; force?: boolean; hideDuringResize?: boolean } = {}
): Promise<boolean> {
  const reveal = options.reveal ?? false
  if (
    !options.force
    && !reveal
    && nativeNotificationLayout.visible === visible
    && nativeNotificationLayout.compact === compact
  ) return true

  const generation = ++nativeNotificationLayoutGeneration
  const synced = await setMascotNotificationVisible(visible, compact, {
    reveal,
    reducedMotion: prefersReducedMotion(),
    hideDuringResize: options.hideDuringResize
  })
  if (generation !== nativeNotificationLayoutGeneration) return false

  if (synced) {
    nativeNotificationLayout = { visible, compact }
    return true
  }
  return false
}

function notificationLayoutStillDesired(visible: boolean, compact: boolean) {
  return isNotifying.value === visible
    && (usesCompactNotificationLayout.value && !usesExpandedNotificationLayout.value) === compact
}

async function revealNotificationAfterLayout(
  visible: boolean,
  compact: boolean,
  reveal: boolean,
  generation: number,
  attempt = 0,
) {
  // A visible overlay always forces a native bounds confirmation. The cached
  // size alone cannot tell whether the user previously soft-hid the HWND.
  const synced = await syncNativeNotificationLayout(visible, compact, {
    reveal,
    force: visible || attempt > 0,
  })
  if (
    generation !== notificationRevealGeneration
    || !notificationLayoutStillDesired(visible, compact)
  ) return

  let shown = true
  if (synced && visible && notificationCoordinatorReady) {
    // Never expose a stale collapsed/compact frame: bounds success is the
    // mandatory predecessor of the non-activating native show.
    shown = await showNotificationWindow()
  }

  if (synced && shown) return
  if (attempt >= 1) return

  window.clearTimeout(notificationLayoutRetryTimer)
  notificationLayoutRetryTimer = window.setTimeout(() => {
    notificationLayoutRetryTimer = undefined
    if (
      generation !== notificationRevealGeneration
      || !notificationLayoutStillDesired(visible, compact)
    ) return
    void revealNotificationAfterLayout(visible, compact, reveal, generation, attempt + 1)
  }, notificationLayoutRetryDelayMs)
}

function scheduleScaleChangedLayoutSync() {
  scaleChangeLayoutPending = true
  window.clearTimeout(scaleChangeLayoutTimer)
  scaleChangeLayoutTimer = window.setTimeout(() => {
    scaleChangeLayoutTimer = undefined
    // Native dragging owns the HWND until mouse-up. Re-fitting in the middle of
    // that operation fights Windows; finishNativeDrag schedules the same work.
    if (isDragging.value) return

    requestAnimationFrame(() => requestAnimationFrame(() => {
      if (!scaleChangeLayoutPending || isDragging.value) return
      scaleChangeLayoutPending = false
      const visible = isNotifying.value
      const compact = usesCompactNotificationLayout.value && !usesExpandedNotificationLayout.value
      void syncNativeNotificationLayout(visible, compact, { force: true }).then((synced) => {
        if (synced && panelVisible.value) void syncPanelWindow()
      })
    }))
  }, scaleChangeLayoutDebounceMs)
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
    const reducedMotion = prefersReducedMotion()
    void peekMascotWindow(reducedMotion).then((side) => {
      if (!side) {
        refreshIdleHideSchedule()
        return
      }
      peekSide.value = side
      peekTransition.value = 'peeking'
      window.clearTimeout(peekTransitionTimer)
      peekTransitionTimer = window.setTimeout(() => {
        if (peekTransition.value !== 'peeking') return
        isPeeked.value = true
        peekTransition.value = undefined
      }, reducedMotion ? 0 : peekHideDurationMs)
    })
  }, idleHideDelayMs)
}

function shouldPauseIdleHide() {
  if (isContextMenuVisible.value) return true
  if (peekTransition.value) return true
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
  if (!isPeeked.value && peekTransition.value !== 'peeking') return

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
  if (!isPeeked.value && peekTransition.value !== 'peeking') return false

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
  playTransientAnimation('waiting', mascotWaitingInteractionMs)
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
  window.clearTimeout(notificationLayoutRetryTimer)
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
  if (scaleChangeLayoutPending) {
    scheduleScaleChangedLayoutSync()
  } else {
    void syncPanelWindow()
  }
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
  if (startedDragging) clearAvatarSingleClickTimer()
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

async function handleContextMenu(event: MouseEvent) {
  event.preventDefault()
  if (!(event.target instanceof Element) || !event.target.closest('.mascot-avatar')) return
  clearAvatarSingleClickTimer()

  if (isPeeked.value || peekTransition.value) {
    // A context menu needs a stable anchor immediately. Revealing without an
    // animated native move avoids racing the menu placement with peek motion.
    await revealMascotWindow(true)
    isPeeked.value = false
    peekTransition.value = undefined
  }
  // Keep the mascot visible while the detached menu performs its first-load
  // handshake. Native visibility is the only authority that flips this state.
  void hidePanelWindow()
  if (!await showMascotContextMenu()) {
    refreshIdleHideSchedule()
    void releaseDismissedNotificationLayout()
  }
}

const hasBubbleMessage = computed(() => Boolean(mascotStore.message))
const hasExpandedNotification = computed(
  () => Boolean(props.sysMessage || props.needsAuth)
)
const isExpandedNotificationDismissing = ref(false)
const isBubbleMessageDismissing = ref(false)
const usesExpandedNotificationLayout = computed(
  () => hasExpandedNotification.value || isExpandedNotificationDismissing.value
)
const usesCompactNotificationLayout = computed(
  () => hasBubbleMessage.value
    || isBubbleMessageDismissing.value
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
  return hasExpandedNotification.value || hasBubbleMessage.value
}

async function releaseDismissedNotificationLayout() {
  const releaseExpanded = !hasExpandedNotification.value && isExpandedNotificationDismissing.value
  const releaseBubble = !hasBubbleMessage.value && isBubbleMessageDismissing.value
  if (!releaseExpanded && !releaseBubble) return

  // WebView2 can retain a tile from the old large backbuffer when a transparent
  // HWND is shrunk while visible. Hide only for this dismissal resize, then
  // force the collapsed DOM layout before showing the HWND again.
  if (!hasVisibleOverlay()) {
    await syncNativeNotificationLayout(false, false, {
      force: true,
      hideDuringResize: true,
    })
  }

  if (releaseExpanded && !hasExpandedNotification.value) {
    isExpandedNotificationDismissing.value = false
  }
  if (releaseBubble && !hasBubbleMessage.value) {
    isBubbleMessageDismissing.value = false
  }

  await nextTick()
  document.querySelector('.mascot-window')?.getBoundingClientRect()
  await new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
  })
  await finishMascotNotificationCollapse()

  // A new item can arrive while the native command is in flight. In that case
  // explicitly restore its requested layout because isNotifying may have stayed
  // true throughout and therefore not retriggered the watcher below.
  if (hasVisibleOverlay()) {
    const generation = ++notificationRevealGeneration
    await revealNotificationAfterLayout(
      true,
      !hasExpandedNotification.value,
      false,
      generation,
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
  () => props.sysMessage,
  (message) => {
    if (message) {
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

watch(
  () => ({
    visible: isNotifying.value,
    compact: usesCompactNotificationLayout.value && !usesExpandedNotificationLayout.value,
    identity: props.sysMessage?.dedupeKey
      || (props.needsAuth ? 'auth' : '')
      || mascotStore.message,
    pendingCount: props.pendingSysMessageCount || 0,
  }),
  ({ visible, compact }) => {
    clearIdleHideTimer()
    let reveal = false
    if (visible) {
      if (isPeeked.value) reveal = startPeekReveal(false)
    } else {
      scheduleIdleHide()
    }
    const generation = ++notificationRevealGeneration
    window.clearTimeout(notificationLayoutRetryTimer)
    notificationLayoutRetryTimer = undefined
    void revealNotificationAfterLayout(visible, compact, reveal, generation)
  },
  // Update the DOM layout first, then atomically resize the native WebView.
  // Otherwise Windows can briefly draw the avatar against its old flex layout
  // at the expanded window's new top-left position.
  { immediate: true, flush: 'post' }
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
  removeNativeRevealedListener = await listen(MASCOT_NATIVE_REVEALED_EVENT, () => {
    isPeeked.value = false
    peekTransition.value = undefined
    window.clearTimeout(peekTransitionTimer)
    scheduleIdleHide()
  })
  removeContextMenuVisibilityListener = await listen<boolean>(
    MASCOT_CONTEXT_MENU_VISIBILITY_EVENT,
    (event) => {
      isContextMenuVisible.value = event.payload
      refreshIdleHideSchedule()
      if (!event.payload) void releaseDismissedNotificationLayout()
    }
  )
  removeWindowMovedListener = await getCurrentWindow().onMoved(({ payload }) => {
    if (!isDragging.value) return
    if (lastNativeWindowX !== undefined) {
      updateRunningMotion(payload.x - lastNativeWindowX)
    }
    lastNativeWindowX = payload.x
  })
  removeWindowScaleChangedListener = await getCurrentWindow().onScaleChanged(() => {
    // Tao has already applied WM_DPICHANGED by this point. Re-run our own
    // work-area fit/clamp because a 320x480 card can otherwise overflow a
    // high-DPI laptop even though its logical size stayed unchanged.
    scheduleScaleChangedLayoutSync()
  })

  // The initial reactive watcher can run while the native window is still
  // completing setup. Reapply the desired bounds after mount so a first-run
  // login card cannot be rendered inside the collapsed 120x104 mascot window
  // and survive only as a clipped horizontal border.
  await syncNativeNotificationLayout(
    isNotifying.value,
    usesCompactNotificationLayout.value && !usesExpandedNotificationLayout.value,
    { force: true }
  )
  notificationCoordinatorReady = true
  scheduleIdleHide()
})

onUnmounted(() => {
  window.clearTimeout(transientAnimationTimer)
  window.clearTimeout(peekTransitionTimer)
  window.clearTimeout(nativeDragIdleTimer)
  window.clearTimeout(notificationLayoutRetryTimer)
  window.clearTimeout(scaleChangeLayoutTimer)
  scaleChangeLayoutPending = false
  notificationRevealGeneration += 1
  clearAvatarSingleClickTimer()
  clearIdleHideTimer()
  window.removeEventListener(MASCOT_REVEAL_EVENT, handleExternalReveal)
  window.removeEventListener('pointerup', finishGlobalNativeDrag, true)
  window.removeEventListener('mouseup', finishGlobalNativeDrag, true)
  removeCloseOverlaysListener?.()
  removePanelActivityListener?.()
  removePanelVisibilityListener?.()
  removeWindowMovedListener?.()
  removeWindowScaleChangedListener?.()
  removeNativeDragEndedListener?.()
  removeNativeRevealedListener?.()
  removeContextMenuVisibilityListener?.()
  void syncNativeNotificationLayout(false, false, { force: true })
})
</script>

<template>
  <section
    class="mascot-window"
    :class="{
      'is-dragging': isDragging || previewAnimationState?.startsWith('running-'),
      'is-notifying': isNotifying,
      'has-expanded-notification': usesExpandedNotificationLayout,
      'has-context-menu': isContextMenuVisible
    }"
    @pointerdown="handlePointerDown"
    @pointerenter="handlePointerEnter"
    @pointerleave="handlePointerLeave"
    @pointermove="handlePointerMove"
    @pointerup="finishPointer"
    @pointercancel="cancelPointer"
    @contextmenu="handleContextMenu"
  >
    <Transition
      name="mascot-overlay"
      mode="out-in"
      @after-leave="handleExpandedOverlayAfterLeave"
    >
      <AuthLoginTip
        v-if="!isContextMenuVisible && needsAuth"
        key="auth-login"
        :pending="authPending"
        :message="authErrorMessage"
        @login="emit('login')"
      />
      <SysMessageTip
        v-else-if="!isContextMenuVisible && sysMessage"
        :key="sysMessage.dedupeKey"
        :message="sysMessage"
        :display-content="sysMessageContent"
        :pending-count="pendingSysMessageCount || 0"
        :read-pending="sysMessageReadPending"
        :read-all-pending="sysMessageReadAllPending"
        :action-error="sysMessageActionError"
        @read="emit('readSysMessage', $event)"
        @read-all="emit('readAllSysMessages')"
        @view="emit('viewSysMessage', $event)"
      />
      <MascotBubble
        v-else-if="!isContextMenuVisible && mascotStore.message"
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
