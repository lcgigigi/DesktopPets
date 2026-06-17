import { defineStore } from 'pinia'
import { handleTaskAction as requestTaskAction } from '../services/task.service'
import { openCalendar } from '../services/window.service'
import type { TaskAction, TaskCreatedEvent } from '../types/task'

interface TaskItem extends TaskCreatedEvent {
  handling?: boolean
  error?: string
}

interface TaskState {
  taskQueue: TaskItem[]
  currentTask: TaskItem | null
  latestMessage: string
}

export const useTaskStore = defineStore('task', {
  state: (): TaskState => ({
    taskQueue: [],
    currentTask: null,
    latestMessage: ''
  }),
  actions: {
    pushTask(event: TaskCreatedEvent) {
      const exists = this.taskQueue.some((item) => item.eventId === event.eventId)
      if (exists) return
      const nextTask = { ...event }
      this.taskQueue.unshift(nextTask)
      this.currentTask = nextTask
      this.latestMessage = '收到一个新任务'
    },
    removeTask(taskId: string) {
      this.taskQueue = this.taskQueue.filter((item) => item.payload.taskId !== taskId)
      this.currentTask = this.taskQueue[0] ?? null
    },
    async handleAction(eventId: string, taskId: string, action: TaskAction) {
      const task = this.taskQueue.find((item) => item.eventId === eventId && item.payload.taskId === taskId)
      if (!task || task.handling) return false

      if (action === 'openDetail') {
        await openCalendar(taskId)
        this.latestMessage = '已打开任务详情'
        return true
      }

      task.handling = true
      task.error = ''
      try {
        const response = await requestTaskAction({ eventId, taskId, action })
        if (!response.success) {
          throw new Error(response.message || '操作失败，请重试')
        }
        this.latestMessage = response.message || '操作成功'
        this.removeTask(taskId)
        return true
      } catch (error) {
        task.error = error instanceof Error ? error.message : '操作失败，请重试'
        this.latestMessage = task.error
        return false
      } finally {
        task.handling = false
      }
    }
  }
})
