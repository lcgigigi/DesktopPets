import { request } from './request'
import { mockHandleTaskAction } from './mock.service'
import type { TaskActionRequest, TaskActionResponse } from '../types/task'
import { env } from '../utils/env'

export async function handleTaskAction(params: TaskActionRequest): Promise<TaskActionResponse> {
  if (env.enableMock && !env.useMockApi) {
    return mockHandleTaskAction(params)
  }

  return request.post('/desktop/task/action', params)
}
