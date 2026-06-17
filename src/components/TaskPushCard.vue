<script setup lang="ts">
import { computed } from 'vue'
import type { TaskAction, TaskCreatedEvent } from '../types/task'
import { formatDateTime } from '../utils/time'

const props = defineProps<{
  task: TaskCreatedEvent & { handling?: boolean; error?: string }
}>()

const emit = defineEmits<{
  action: [eventId: string, taskId: string, action: TaskAction]
}>()

const displayTime = computed(() => {
  const deadline = props.task.payload.deadline
  if (!deadline) return '16:00'

  const normalized = formatDateTime(deadline)
  const match = normalized.match(/(\d{2}:\d{2})/)
  return match?.[1] ?? normalized
})

const taskTitle = computed(() => props.task.payload.title || '确认会议纪要')
const taskContent = computed(() => props.task.payload.content || '确认今天下班前确认本周会议纪要内容。')
</script>

<template>
  <article class="task-card">
    <div class="task-card__time">
      <div class="task-card__time-icon">
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M8 2v4" />
          <path d="M16 2v4" />
          <rect x="3" y="5" width="18" height="15" rx="3" />
          <path d="M3 10h18" />
          <circle cx="17" cy="17" r="3" />
          <path d="M17 15.5V17l1.2.8" />
        </svg>
      </div>
      <strong>{{ displayTime }}</strong>
    </div>
    <div class="task-card__content">
      <h3>{{ taskTitle }}</h3>
      <p>{{ taskContent }}</p>
      <p v-if="task.error" class="task-card__error">{{ task.error }}</p>
      <div class="task-card__actions">
        <button
          class="task-card__action task-card__action--done"
          type="button"
          :disabled="task.handling"
          @click="emit('action', task.eventId, task.payload.taskId, 'confirm')"
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="m7 12 3 3 7-7" />
            <circle cx="12" cy="12" r="9" />
          </svg>
          <span>{{ task.handling ? '处理中' : '完成' }}</span>
        </button>
        <button
          class="task-card__action task-card__action--later"
          type="button"
          :disabled="task.handling"
          @click="emit('action', task.eventId, task.payload.taskId, 'later')"
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <circle cx="12" cy="12" r="9" />
            <path d="M12 7v5l3 2" />
          </svg>
          <span>稍后提醒</span>
        </button>
        <button
          class="task-card__action task-card__action--view"
          type="button"
          :disabled="task.handling"
          @click="emit('action', task.eventId, task.payload.taskId, 'openDetail')"
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M2.5 12s3.5-6 9.5-6 9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6Z" />
            <circle cx="12" cy="12" r="3" />
          </svg>
          <span>查看</span>
        </button>
      </div>
    </div>
  </article>
</template>
