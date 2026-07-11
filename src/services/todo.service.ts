import { request } from './request'
import { mockParseTodo } from './mock.service'
import type { SmartTodoDetailResponse, SmartTodoMain, TodoParseResponse } from '../types/todo'
import { env } from '../utils/env'

interface SmartTodoAnalyzeData {
  task?: string
  date?: string
  time?: string
  startDate?: string
  endDate?: string
  startDateShow?: string
  endDateShow?: string
  assigneeId?: string | number
  assigneeIds?: string
  remark?: string
}

function todayDate() {
  return new Date().toISOString().slice(0, 10)
}

function parseDateTime(value?: string | null) {
  const trimmed = value?.trim()
  if (!trimmed) return {}

  const [datePart, timePart] = trimmed.replace('T', ' ').split(/\s+/)
  return {
    date: /^\d{4}-\d{2}-\d{2}$/.test(datePart) ? datePart : undefined,
    time: timePart?.slice(0, 5)
  }
}

function normalizeAssigneeId(data: SmartTodoAnalyzeData) {
  const assigneeIds = data.assigneeIds?.trim()
  if (assigneeIds) return assigneeIds
  if (data.assigneeId === null || data.assigneeId === undefined) return undefined
  return String(data.assigneeId).trim() || undefined
}

function normalizeAnalyzeResult(data: SmartTodoAnalyzeData, sourceText: string): TodoParseResponse {
  const startFromShow = parseDateTime(data.startDateShow)
  const startFromDate = parseDateTime(data.startDate)
  const endFromShow = parseDateTime(data.endDateShow)
  const endFromDate = parseDateTime(data.endDate)
  const date = data.date?.trim() || startFromShow.date || startFromDate.date || todayDate()
  const endDate = endFromShow.date || endFromDate.date

  return {
    confidence: 0.9,
    draftId: `smart_todo_${Date.now()}`,
    needConfirm: true,
    result: {
      title: data.task?.trim() || sourceText.trim(),
      date,
      endDate,
      time: data.time?.trim().slice(0, 5) || startFromShow.time || startFromDate.time,
      assigneeId: normalizeAssigneeId(data),
      assigneeName: normalizeAssigneeId(data),
      source: data.remark?.trim() || `桌面助手：${sourceText.trim()}`
    }
  }
}

export async function getTodoDetail(todoId: string): Promise<SmartTodoMain | null> {
  const id = todoId.trim()
  if (!id) return null

  try {
    const data = await request.get<unknown, SmartTodoDetailResponse>(`/smart-todo/${encodeURIComponent(id)}`)
    return data?.mainTodo ?? null
  } catch {
    return null
  }
}

export async function parseTodo(text: string): Promise<TodoParseResponse> {
  if (env.enableMock && !env.useMockApi) {
    return mockParseTodo(text)
  }

  const data = await request.post<unknown, SmartTodoAnalyzeData>('/smart-todo/analyze', {
    text: text.trim()
  })

  return normalizeAnalyzeResult(data, text)
}
