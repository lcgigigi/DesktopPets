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
  if (env.enableMock && !env.useMockApi) {
    return mockHandleTaskAction(params)
  }

  if (params.action === 'confirm') {
    await request.post<unknown, boolean>(
      `/smart-todo/complete/${encodeURIComponent(params.taskId)}`,
      undefined,
      {
        params: { handleDesc: '桌面助手标记完成' }
      }
    )

    return successResponse('completed', '已完成')
  }

  if (params.action === 'cancel') {
    await request.post<unknown, boolean>('/smart-todo/reject', {
      id: params.taskId,
      handleDesc: '桌面助手取消'
    })

    return successResponse('cancelled', '已取消')
  }

  if (params.action === 'later') {
    return successResponse('snoozed', '已稍后提醒')
  }

  return successResponse('opened', '已打开任务详情')
}
