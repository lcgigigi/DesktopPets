import { request } from './request'
import { mockParseTodo } from './mock.service'
import type {
  SmartTodoDetailResponse,
  SmartTodoMain,
  SmartTodoUser,
  TodoParseResponse,
} from '../types/todo'
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

let userNameCache: Map<string, string> | null = null
let userNameRequest: Promise<Map<string, string>> | null = null

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

function extractMainTodo(
  data: SmartTodoMain | SmartTodoDetailResponse | null | undefined,
): SmartTodoMain | null {
  if (!data) return null
  if ('mainTodo' in data) return (data as SmartTodoDetailResponse).mainTodo ?? null
  return data as SmartTodoMain
}

export async function getTodoDetail(todoId: string): Promise<SmartTodoMain | null> {
  const id = todoId.trim()
  if (!id) return null

  try {
    const data = await request.get<unknown, SmartTodoMain | SmartTodoDetailResponse>(
      `/smart-todo/${encodeURIComponent(id)}`,
    )
    return extractMainTodo(data)
  } catch {
    return null
  }
}

async function loadTodoUserNames() {
  if (userNameCache) return userNameCache
  if (userNameRequest) return userNameRequest

  userNameRequest = request
    .get<unknown, SmartTodoUser[]>('/smart-todo/user-list')
    .then((users) => {
      const names = new Map<string, string>()
      for (const user of users ?? []) {
        const id = user.badge === null || user.badge === undefined ? '' : String(user.badge).trim()
        const name = user.name?.trim() || ''
        if (id && name) names.set(id, name)
      }
      userNameCache = names
      return names
    })
    .finally(() => {
      userNameRequest = null
    })

  return userNameRequest
}

export async function resolveTodoUserNames(ids: string[]) {
  const uniqueIds = [...new Set(ids.map((id) => id.trim()).filter(Boolean))]
  if (uniqueIds.length === 0) return new Map<string, string>()

  try {
    const names = await loadTodoUserNames()
    return new Map(uniqueIds.flatMap((id) => (names.has(id) ? [[id, names.get(id)!]] : [])))
  } catch {
    return new Map<string, string>()
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
