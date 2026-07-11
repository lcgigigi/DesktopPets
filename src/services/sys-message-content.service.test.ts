import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SysMessageNotification } from '../types/sys-message'

vi.mock('./todo.service', () => ({
  getTodoDetail: vi.fn(),
  resolveTodoUserNames: vi.fn(),
}))

import { getTodoDetail, resolveTodoUserNames } from './todo.service'
import { getSysMessageFallback, resolveSysMessageContent } from './sys-message-content.service'

function message(overrides: Partial<SysMessageNotification>): SysMessageNotification {
  return {
    id: '1',
    rawId: 1,
    dedupeKey: '1',
    msgSubject: '站内消息',
    msgContent: '',
    msgStatus: 0,
    msgType: 1,
    ...overrides,
  }
}

describe('sys-message-content.service', () => {
  beforeEach(() => {
    vi.mocked(getTodoDetail).mockReset()
    vi.mocked(resolveTodoUserNames).mockReset()
    vi.mocked(resolveTodoUserNames).mockResolvedValue(new Map())
  })

  it('shows the sender name and content for a newly assigned todo', async () => {
    vi.mocked(getTodoDetail).mockResolvedValue({
      creatorNickName: '王小明',
      content: '整理项目复盘材料',
    })

    await expect(
      resolveSysMessageContent(
        message({
          msgSubject: '您有一条新的待办',
          msgContent: '创建人：10001\n标题：整理项目复盘材料',
          bizType: 1,
          bizId: '153',
        }),
      ),
    ).resolves.toBe('10001 派发给你一条待办：整理项目复盘材料')
  })

  it('uses the message handler as the completer and resolves the employee number', async () => {
    vi.mocked(getTodoDetail).mockResolvedValue({ content: '提交周报', handlerNickName: '不应使用' })
    vi.mocked(resolveTodoUserNames).mockResolvedValue(new Map([['1110691', '田坤坤']]))

    await expect(
      resolveSysMessageContent(
        message({
          msgSubject: '待办已完成',
          msgContent: '处理人：1110691\n处理说明：已完成',
          bizType: 1,
          bizId: '147',
        }),
      ),
    ).resolves.toBe('田坤坤 已完成待办：提交周报')
  })

  it('shows the todo content and schedule for an upcoming reminder', async () => {
    await expect(
      resolveSysMessageContent(
        message({
          msgSubject: '任务即将结束',
          msgContent:
            '你的任务即将结束，请前往处理\n标题：明天早上九点开早会\n开始时间：2026-07-09T09:00\n结束时间：2026-07-09T10:00',
          bizType: 2,
          bizId: '148',
        }),
      ),
    ).resolves.toBe('明天早上九点开早会（2026-07-09 09:00 至 2026-07-09 10:00）')
  })

  it('parses JSON todo content and keeps the server text if details cannot fill a completed message', async () => {
    await expect(
      resolveSysMessageContent(
        message({
          msgSubject: '待办提醒',
          msgContent: '{"title":"确认会议纪要","startDateShow":"2026-07-09 09:45:00"}',
          bizType: 1,
          bizId: '201',
        }),
      ),
    ).resolves.toBe('确认会议纪要（时间：2026-07-09 09:45）')

    vi.mocked(getTodoDetail).mockResolvedValue(null)
    await expect(
      resolveSysMessageContent(
        message({ msgSubject: '待办已完成', msgContent: '待办 #147', bizType: 1, bizId: '147' }),
      ),
    ).resolves.toBe('待办 #147')
    expect(getSysMessageFallback(message({ msgContent: '' }))).toBe('你收到一条新的系统消息')
  })
})
