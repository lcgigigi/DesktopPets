import { describe, expect, it } from 'vitest'
import { getVisibleTaskActions } from './task-actions'

describe('task card actions', () => {
  it('keeps the connected safe defaults for legacy payloads', () => {
    expect(getVisibleTaskActions()).toEqual([
      { key: 'confirm', label: '完成' },
      { key: 'openDetail', label: '查看详情' },
    ])
  })

  it('does not invent completion permission when the server only offers other actions', () => {
    expect(getVisibleTaskActions([
      { key: 'later', label: '稍后提醒' },
      { key: 'cancel', label: '取消任务' },
    ])).toEqual([{ key: 'openDetail', label: '查看详情' }])
  })

  it('never exposes unpersisted later actions or trusts server-provided button labels', () => {
    expect(getVisibleTaskActions([
      { key: 'confirm', label: '管理员强制完成' },
      { key: 'later', label: '已保存到稍后' },
      { key: 'openDetail', label: '任意文案' },
    ])).toEqual([
      { key: 'confirm', label: '完成' },
      { key: 'openDetail', label: '查看详情' },
    ])
  })
})
