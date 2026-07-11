<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { getTodoDetail } from '../services/todo.service'
import type { SysMessageNotification } from '../types/sys-message'
import type { SmartTodoMain } from '../types/todo'

const props = defineProps<{
  message: SysMessageNotification
  pendingCount?: number
}>()

const emit = defineEmits<{
  view: [message: SysMessageNotification]
  read: [message: SysMessageNotification]
}>()

const displayContent = ref('')

function toText(value: unknown) {
  if (value === null || value === undefined) return ''
  return String(value).trim()
}

function parseJsonObject(value: string) {
  const trimmed = value.trim()
  if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) return null

  try {
    const parsed = JSON.parse(trimmed) as unknown
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

function formatTodoDateTime(value: unknown) {
  const text = toText(value)
  if (!text) return ''

  return text
    .replace('T', ' ')
    .replace(/\.\d{3}Z?$/, '')
    .replace(/Z$/, '')
    .slice(0, 16)
}

function getTodoId(payload: { id?: unknown }) {
  return toText(payload.id)
}

function parseCommaSeparated(value: unknown) {
  return toText(value)
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
}

function pickRecipientAssigneeId(todo: SmartTodoMain | Record<string, unknown>) {
  const ids = parseCommaSeparated(todo.assigneeIds)
  return ids[1] || ''
}

function pickRecipientAssigneeName(todo: SmartTodoMain | Record<string, unknown>) {
  const recipientId = pickRecipientAssigneeId(todo)
  const nickNames = parseCommaSeparated(todo.assigneeNickName)

  if (nickNames.length >= 2) return nickNames[1]

  const handlerId = toText(todo.handlerId)
  const handlerName = toText(todo.handlerNickName)
  if (recipientId && handlerId === recipientId && handlerName) return handlerName

  return handlerName
}

function pickTodoContent(todo: SmartTodoMain | Record<string, unknown>) {
  const content = toText(todo.content)
  if (content) return content

  const title = toText(todo.title)
  if (title) return title

  for (const key of ['remark', 'otherContent', 'completeDesc']) {
    const text = toText(todo[key as keyof typeof todo])
    if (text) return text
  }

  return ''
}

function isCompletedTodoSubject(subject: string) {
  return /待办已完成|已完成|处理完成/.test(subject)
}

function buildCompletedTodoContent(todo: SmartTodoMain | Record<string, unknown>) {
  const assigneeName = pickRecipientAssigneeName(todo)
  const taskContent = pickTodoContent(todo)

  if (assigneeName && taskContent) {
    return `您派发给 ${assigneeName} 的「${taskContent}」已经处理完成啦，快去查看吧！`
  }
  if (assigneeName) {
    return `您派发给 ${assigneeName} 的待办已经处理完成啦，快去查看吧！`
  }
  if (taskContent) {
    return `您派发的「${taskContent}」已经处理完成啦，快去查看吧！`
  }

  return ''
}

function buildTodoMessageContent(todo: SmartTodoMain | Record<string, unknown>, subject = '') {
  if (isCompletedTodoSubject(subject)) {
    const completed = buildCompletedTodoContent(todo)
    if (completed) return completed
  }

  const mainContent = pickTodoContent(todo)
  if (mainContent) return mainContent

  const todoId = getTodoId(todo)
  const startTime = formatTodoDateTime(todo.startDateShow || todo.startDate)
  const endTime = formatTodoDateTime(todo.endDateShow || todo.endDate)
  const timeText = startTime && endTime && endTime !== startTime ? `${startTime} 至 ${endTime}` : startTime

  if (todoId && timeText) return `待办 #${todoId} · ${timeText}`
  if (todoId) return `待办 #${todoId}`
  if (timeText) return timeText

  return ''
}

function buildDisplayContent(message: SysMessageNotification) {
  const subject = message.msgSubject?.trim() || '站内消息'
  const rawContent = message.msgContent?.trim() || ''

  if (!rawContent) {
    return isCompletedTodoSubject(subject) ? '' : '你收到一条新的系统消息'
  }

  const parsed = parseJsonObject(rawContent)
  if (parsed) {
    return buildTodoMessageContent(parsed, subject) || (isCompletedTodoSubject(subject) ? '' : '你收到一条新的待办')
  }

  if (isCompletedTodoSubject(subject) && /^\d+$/.test(rawContent) && rawContent === message.bizId) {
    return ''
  }

  return rawContent
}

function completedFallback() {
  return '您派发的待办已经处理完成啦，快去查看吧！'
}

async function resolveDisplayContent(message: SysMessageNotification) {
  let content = buildDisplayContent(message)

  if (isCompletedTodoSubject(message.msgSubject || '') && message.bizId?.trim()) {
    const detail = await getTodoDetail(message.bizId)
    if (detail) {
      content = buildTodoMessageContent(detail, message.msgSubject) || content
    }
  }

  displayContent.value =
    content ||
    (isCompletedTodoSubject(message.msgSubject || '') ? completedFallback() : '你收到一条新的系统消息')
}

watch(
  () => props.message.dedupeKey,
  () => {
    void resolveDisplayContent(props.message)
  },
  { immediate: true }
)

const title = computed(() => props.message.msgSubject || '站内消息')
const isTodo = computed(() => /待办|todo/i.test(title.value))
const isCompletedTodo = computed(() => isCompletedTodoSubject(title.value))

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
