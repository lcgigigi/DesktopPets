<script setup lang="ts">
import { computed } from 'vue'
import type { SysMessageNotification } from '../types/sys-message'
import {
  formatSysMessageDisplayTime,
  normalizeSysMessageDateTime
} from '../utils/sys-message-display'

const props = defineProps<{
  message: SysMessageNotification
  displayContent: string
  pendingCount?: number
  readPending?: boolean
  readAllPending?: boolean
  actionError?: string
}>()

const emit = defineEmits<{
  view: [message: SysMessageNotification]
  read: [message: SysMessageNotification]
  readAll: []
}>()

const title = computed(() => props.message.msgSubject || '站内消息')
const isCompletedTodo = computed(() => /待办已完成|已完成|处理完成/.test(title.value))
const isMeeting = computed(() => props.message.bizType === 2 || /会议/.test(title.value))
const isTask = computed(
  () => !isMeeting.value && (props.message.bizType === 1 || /待办|任务|todo/i.test(title.value))
)
const isNewTodo = computed(() => /新待办|新的待办|派发/.test(title.value))
const titleId = computed(() => `sys-message-title-${props.message.id.replace(/[^a-zA-Z0-9_-]/g, '-')}`)
const summaryId = computed(() => `sys-message-summary-${props.message.id.replace(/[^a-zA-Z0-9_-]/g, '-')}`)

const badgeLabel = computed(() => {
  if (isCompletedTodo.value) return '待办已完成'
  if (isMeeting.value) return '会议提醒'
  if (isNewTodo.value) return '新待办'
  if (isTask.value) return '任务提醒'
  return '消息提醒'
})

const tipTone = computed(() => {
  if (isMeeting.value) return 'meeting'
  if (isTask.value) return 'todo'
  return 'notice'
})

const displayTime = computed(() => formatSysMessageDisplayTime(props.message.createTime))
const dateTimeValue = computed(() => normalizeSysMessageDateTime(props.message.createTime))
const pendingLabel = computed(() => {
  const count = Math.max(0, props.pendingCount ?? 0)
  if (!count) return ''
  return `另有 ${count > 99 ? '99+' : count} 条`
})
const announcement = computed(() => {
  const content = props.displayContent.trim().replace(/[。！？!?]+$/, '')
  return `${badgeLabel.value}：${title.value}。${content}。${displayTime.value}`
})
</script>

<template>
  <article
    class="sys-message-tip"
    :class="[`sys-message-tip--${tipTone}`, { 'has-action-error': actionError }]"
    role="dialog"
    aria-modal="false"
    :aria-busy="readPending"
    :aria-labelledby="titleId"
    :aria-describedby="summaryId"
    @pointerdown.stop
    @pointermove.stop
    @pointerup.stop
    @click.stop
  >
    <span class="sr-only" role="status" aria-live="polite" aria-atomic="true">
      {{ announcement }}
    </span>
    <div class="sys-message-tip__card">
      <header class="sys-message-tip__header">
        <span class="sys-message-tip__badge">
          <span class="sys-message-tip__badge-indicator" aria-hidden="true" />
          <span class="sys-message-tip__badge-label">{{ badgeLabel }}</span>
        </span>
        <span class="sys-message-tip__meta">
          <span v-if="pendingLabel" class="sys-message-tip__queue-count">{{ pendingLabel }}</span>
          <time class="sys-message-tip__time" :datetime="dateTimeValue">{{ displayTime }}</time>
        </span>
      </header>

      <div class="sys-message-tip__body">
        <h2 :id="titleId">{{ title }}</h2>
        <div class="sys-message-tip__summary-shell">
          <p
            :id="summaryId"
            class="sys-message-tip__summary"
            tabindex="0"
          >
            {{ displayContent }}
          </p>
        </div>
      </div>

      <p v-if="actionError" class="sys-message-tip__error" role="alert">
        {{ actionError }}
      </p>

      <div class="sys-message-tip__actions">
        <button
          class="sys-message-tip__button"
          type="button"
          :disabled="readPending"
          @click.stop="emit('read', message)"
        >
          {{ readPending ? '处理中…' : '知道了' }}
        </button>
        <button
          v-if="(pendingCount ?? 0) > 0"
          class="sys-message-tip__button sys-message-tip__button--read-all"
          type="button"
          :disabled="readPending"
          :aria-label="`将当前及其余 ${pendingCount ?? 0} 条提醒全部标为已读，共 ${(pendingCount ?? 0) + 1} 条`"
          :title="`全部标为已读（共 ${(pendingCount ?? 0) + 1} 条）`"
          @click.stop="emit('readAll')"
        >
          {{ readAllPending ? '处理中…' : '全部已读' }}
        </button>
        <button
          class="sys-message-tip__button sys-message-tip__button--primary"
          type="button"
          :disabled="readPending"
          @click.stop="emit('view', message)"
        >
          查看详情
        </button>
      </div>
    </div>

    <span class="sys-message-tip__tail" aria-hidden="true" />
  </article>
</template>
