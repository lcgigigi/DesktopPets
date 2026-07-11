import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ get: vi.fn() }))

vi.mock('./request', () => ({
  request: { get: mocks.get },
}))

import { getTodoDetail } from './todo.service'

describe('getTodoDetail', () => {
  beforeEach(() => {
    mocks.get.mockReset()
  })

  it('accepts the wrapped detail response used by the web workbench', async () => {
    mocks.get.mockResolvedValue({ mainTodo: { id: 101, content: '准备周会材料' }, childTodoList: [] })

    await expect(getTodoDetail('101')).resolves.toMatchObject({ id: 101, content: '准备周会材料' })
  })

  it('accepts a direct todo object as well', async () => {
    mocks.get.mockResolvedValue({ id: 102, title: '提交日报', creatorNickName: '李华' })

    await expect(getTodoDetail('102')).resolves.toMatchObject({ id: 102, title: '提交日报' })
  })
})
