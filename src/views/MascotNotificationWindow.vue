<script setup lang="ts">
import { emitTo, listen, type UnlistenFn } from '@tauri-apps/api/event'
import { onMounted, onUnmounted, ref } from 'vue'
import SysMessageTip from '../components/SysMessageTip.vue'
import {
  hideMascotSystemNotificationWindow,
  MASCOT_SYSTEM_NOTIFICATION_ACTION_EVENT,
  MASCOT_SYSTEM_NOTIFICATION_PRESENT_EVENT,
  setMascotSystemNotificationReady,
  type MascotSystemNotificationAction,
  type MascotSystemNotificationPresentation,
} from '../services/window.service'

const presentation = ref<MascotSystemNotificationPresentation | null>(null)
let removePresentationListener: UnlistenFn | undefined

if (import.meta.env.DEV && new URLSearchParams(window.location.search).get('preview') === 'sys-message') {
  presentation.value = {
    generation: 1,
    message: {
      id: 'notification-window-preview',
      rawId: 'notification-window-preview',
      dedupeKey: 'notification-window-preview',
      msgSubject: '会议即将开始',
      msgContent: '您的项目评审会议将在 15 分钟后开始，请提前准备相关材料。',
      msgStatus: 0,
      msgType: 1,
      bizType: 2,
      bizId: 'notification-window-preview',
      createTime: '2026-08-21 16:55',
    },
    displayContent: '您的项目评审会议将在 15 分钟后开始，请提前准备相关材料。',
    pendingCount: 2,
    readPending: false,
    readAllPending: false,
    actionError: '',
  }
}

function publishAction(action: MascotSystemNotificationAction) {
  void emitTo('mascot', MASCOT_SYSTEM_NOTIFICATION_ACTION_EVENT, action)
}

function handleRead() {
  if (!presentation.value) return
  publishAction({ action: 'read', message: presentation.value.message })
}

function handleReadAll() {
  publishAction({ action: 'readAll' })
}

function handleView() {
  if (!presentation.value) return
  publishAction({ action: 'view', message: presentation.value.message })
}

function handleAfterLeave() {
  // A newer message may arrive while the old card is fading. Never let the
  // stale after-leave callback hide that newer presentation.
  if (!presentation.value) void hideMascotSystemNotificationWindow()
}

onMounted(async () => {
  removePresentationListener = await listen<MascotSystemNotificationPresentation | null>(
    MASCOT_SYSTEM_NOTIFICATION_PRESENT_EVENT,
    (event) => {
      presentation.value = event.payload
    },
  )
  await setMascotSystemNotificationReady()
})

onUnmounted(() => {
  removePresentationListener?.()
})
</script>

<template>
  <section class="mascot-notification-window" aria-label="机器人消息提醒窗口">
    <Transition name="mascot-overlay" mode="out-in" @after-leave="handleAfterLeave">
      <SysMessageTip
        v-if="presentation"
        :key="presentation.generation"
        :message="presentation.message"
        :display-content="presentation.displayContent"
        :pending-count="presentation.pendingCount"
        :read-pending="presentation.readPending"
        :read-all-pending="presentation.readAllPending"
        :action-error="presentation.actionError"
        @read="handleRead"
        @read-all="handleReadAll"
        @view="handleView"
      />
    </Transition>
  </section>
</template>
