import type { DesktopEvent, TaskActionRequest, TaskActionResponse, TaskCreatedPayload } from '../types/task'
import type { TodoParseResponse } from '../types/todo'
import { nowTimestamp } from '../utils/time'

export function mockParseTodo(text: string): Promise<TodoParseResponse> {
  return new Promise((resolve) => {
    window.setTimeout(() => {
      resolve({
        confidence: 0.92,
        draftId: `todo_draft_${Date.now()}`,
        needConfirm: true,
        result: {
          title: text.includes('会议纪要') ? '确认会议纪要' : text.slice(0, 28),
          date: '2026-06-04',
          time: '15:00',
          assigneeId: 'leader-zhang',
          assigneeName: '刘美华',
          source: `桌面助手：${text}`
        }
      })
    }, 650)
  })
}

export function mockHandleTaskAction(params: TaskActionRequest): Promise<TaskActionResponse> {
  return new Promise((resolve) => {
    window.setTimeout(() => {
      resolve({
        success: true,
        taskStatus: params.action === 'cancel' ? 'cancelled' : params.action === 'later' ? 'snoozed' : 'confirmed',
        message: '操作成功'
      })
    }, 360)
  })
}

export function createMockTaskEvent(index: number): DesktopEvent<TaskCreatedPayload> {
  return {
    eventId: `mock_evt_${String(index).padStart(3, '0')}`,
    eventType: 'task.created',
    timestamp: nowTimestamp(),
    needAck: true,
    payload: {
      taskId: `mock_task_${String(index).padStart(3, '0')}`,
      title: index % 2 === 0 ? '确认下月规划会材料' : '确认会议纪要',
      content: index % 2 === 0 ? '请在今天 16:00 前确认材料内容。' : '请在今天下班前确认本周会议纪要内容。',
      deadline: index % 2 === 0 ? '2026-05-28 16:00:00' : '2026-05-28 18:00:00',
      priority: 'normal',
      creatorName: '系统管理员',
      actions: [
        { key: 'confirm', label: '确认' },
        { key: 'cancel', label: '取消' },
        { key: 'later', label: '稍后' }
      ]
    }
  }
}
