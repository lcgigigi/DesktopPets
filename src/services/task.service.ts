import { request } from './request'
import { mockHandleTaskAction } from './mock.service'
import type { TaskActionRequest, TaskActionResponse } from '../types/task'
import { env } from '../utils/env'

function successResponse(taskStatus: string, message: string): TaskActionResponse {
  return {
    success: true,
    taskStatus,
    message
  }
}

export async function handleTaskAction(params: TaskActionRequest): Promise<TaskActionResponse> {
  if (params.action === 'later') {
    throw new Error('“稍后提醒”尚未接入后台，本版本不可用')
  }

  if (env.enableMock && !env.useMockApi) {
    return mockHandleTaskAction(params)
  }

  if (params.action === 'confirm') {
    const completed = await request.post<unknown, boolean>(
      `/smart-todo/complete/${encodeURIComponent(params.taskId)}`,
      undefined,
      {
        params: { handleDesc: '桌面助手标记完成' }
      }
    )

    if (completed !== true) {
      throw new Error('后台未确认任务已完成，请稍后重试')
    }

    return successResponse('completed', '已完成')
  }

  if (params.action === 'cancel') {
    const cancelled = await request.post<unknown, boolean>('/smart-todo/reject', {
      id: params.taskId,
      handleDesc: '桌面助手取消'
    })

    if (cancelled !== true) {
      throw new Error('后台未确认任务已取消，请稍后重试')
    }

    return successResponse('cancelled', '已取消')
  }

  return successResponse('opened', '已打开任务详情')
}
