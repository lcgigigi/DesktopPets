import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ post: vi.fn() }))

vi.mock('./request', () => ({
  request: { post: mocks.post },
}))

vi.mock('./mock.service', () => ({
  mockHandleTaskAction: vi.fn(),
}))

vi.mock('../utils/env', () => ({
  env: { enableMock: false, useMockApi: false },
}))

import { handleTaskAction } from './task.service'

describe('task.service', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('explicitly rejects later until server-side persistence is connected', async () => {
    await expect(handleTaskAction({
      eventId: 'evt-1',
      taskId: 'task-1',
      action: 'later',
    })).rejects.toThrow('尚未接入后台')
  })

  it('does not report completion when the backend returns data=false', async () => {
    mocks.post.mockResolvedValue(false)

    await expect(handleTaskAction({
      eventId: 'evt-2',
      taskId: 'task-2',
      action: 'confirm',
    })).rejects.toThrow('后台未确认')
  })

  it('reports completion only when the backend explicitly returns true', async () => {
    mocks.post.mockResolvedValue(true)

    await expect(handleTaskAction({
      eventId: 'evt-3',
      taskId: 'task-3',
      action: 'confirm',
    })).resolves.toMatchObject({ success: true, taskStatus: 'completed' })
  })

  it('does not report cancellation when the backend returns data=false', async () => {
    mocks.post.mockResolvedValue(false)

    await expect(handleTaskAction({
      eventId: 'evt-4',
      taskId: 'task-4',
      action: 'cancel',
    })).rejects.toThrow('后台未确认')
  })

  it('reports cancellation only when the backend explicitly returns true', async () => {
    mocks.post.mockResolvedValue(true)

    await expect(handleTaskAction({
      eventId: 'evt-5',
      taskId: 'task-5',
      action: 'cancel',
    })).resolves.toMatchObject({ success: true, taskStatus: 'cancelled' })
  })
})
