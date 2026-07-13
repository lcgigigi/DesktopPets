<script setup lang="ts">
import { computed } from 'vue'
import type { SysMessageNotification } from '../types/sys-message'

const props = defineProps<{
  message: SysMessageNotification
  displayContent: string
  pendingCount?: number
}>()

const emit = defineEmits<{
  view: [message: SysMessageNotification]
  read: [message: SysMessageNotification]
}>()

const title = computed(() => props.message.msgSubject || '站内消息')
const isTodo = computed(() => /待办|todo/i.test(title.value))
const isCompletedTodo = computed(() => /待办已完成|已完成|处理完成/.test(title.value))

const badgeLabel = computed(() => {
  if (isCompletedTodo.value) return '待办已完成'
  if (isTodo.value) return '新待办'
  return '消息提醒'
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
      <header class="sys-message-tip__header">
        <span class="sys-message-tip__badge">
          <span class="sys-message-tip__badge-indicator" aria-hidden="true" />
          {{ badgeLabel }}
        </span>
        <span v-if="(pendingCount ?? 0) > 0" class="sys-message-tip__queue-count">+{{ pendingCount }}</span>
        <span class="sys-message-tip__live-dot" aria-hidden="true">
          <span class="sys-message-tip__live-dot-core" />
        </span>
      </header>

      <div class="sys-message-tip__body">
        <strong>{{ title }}</strong>
        <p class="sys-message-tip__summary">{{ displayContent }}</p>
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
