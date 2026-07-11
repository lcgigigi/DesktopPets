<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { getSysMessageFallback, resolveSysMessageContent } from '../services/sys-message-content.service'
import type { SysMessageNotification } from '../types/sys-message'

const props = defineProps<{
  message: SysMessageNotification
  pendingCount?: number
}>()

const emit = defineEmits<{
  view: [message: SysMessageNotification]
  read: [message: SysMessageNotification]
}>()

const displayContent = ref(getSysMessageFallback(props.message))

async function resolveDisplayContent(message: SysMessageNotification, dedupeKey: string) {
  displayContent.value = getSysMessageFallback(message)
  const content = await resolveSysMessageContent(message)
  if (props.message.dedupeKey === dedupeKey) displayContent.value = content
}

watch(
  () => props.message.dedupeKey,
  () => {
    void resolveDisplayContent(props.message, props.message.dedupeKey)
  },
  { immediate: true }
)

const title = computed(() => props.message.msgSubject || '站内消息')
const isTodo = computed(() => /待办|todo/i.test(title.value))
const isCompletedTodo = computed(() => /待办已完成|已完成|处理完成/.test(title.value))

const badgeLabel = computed(() => {
  if (isCompletedTodo.value) return '叮~ 待办完成'
  if (isTodo.value) return '叮~ 新待办'
  return '小力提醒你'
})

const tipTone = computed(() => (isTodo.value ? 'todo' : 'notice'))
</script>

<template>
  <article
    class="sys-message-tip"
    :class="`sys-message-tip--${tipTone}`"
    aria-live="polite"
    @pointerdown.stop
    @pointermove.stop
    @pointerup.stop
    @click.stop
  >
    <div class="sys-message-tip__card">
      <span class="sys-message-tip__deco sys-message-tip__deco--star" aria-hidden="true">✦</span>
      <span class="sys-message-tip__deco sys-message-tip__deco--sparkle" aria-hidden="true">✧</span>
      <span class="sys-message-tip__deco sys-message-tip__deco--bubble" aria-hidden="true" />

      <header class="sys-message-tip__header">
        <span class="sys-message-tip__badge">
          <span class="sys-message-tip__badge-emoji" aria-hidden="true">{{ isTodo ? '🔔' : '💬' }}</span>
          {{ badgeLabel }}
        </span>
        <span v-if="(pendingCount ?? 0) > 0" class="sys-message-tip__queue-count">+{{ pendingCount }}</span>
        <span class="sys-message-tip__live-dot" aria-hidden="true">
          <span class="sys-message-tip__live-dot-core" />
        </span>
      </header>

      <div class="sys-message-tip__body">
        <strong>{{ title }}</strong>
        <p>{{ displayContent }}</p>
      </div>

      <div class="sys-message-tip__actions">
        <button class="sys-message-tip__button sys-message-tip__button--primary" type="button" @click.stop="emit('view', message)">
          查看详情
        </button>
        <button class="sys-message-tip__button" type="button" @click.stop="emit('read', message)">
          知道了
        </button>
      </div>
    </div>

    <span class="sys-message-tip__tail" aria-hidden="true" />
  </article>
</template>
