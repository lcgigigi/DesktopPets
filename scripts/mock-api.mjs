import http from 'node:http'
import { URL } from 'node:url'

const host = '127.0.0.1'
const port = Number(process.env.MOCK_API_PORT || 8080)
const drafts = new Map()

const users = [
  {
    id: 'leader-zhang',
    name: '刘美华'
  },
  {
    id: 'employee-liu',
    name: '刘畅'
  }
]

function jsonResponse(response, statusCode, payload) {
  response.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'content-type, authorization',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS'
  })
  response.end(JSON.stringify(payload))
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    let body = ''
    request.setEncoding('utf8')
    request.on('data', (chunk) => {
      body += chunk
    })
    request.on('end', () => {
      if (!body.trim()) {
        resolve({})
        return
      }
      try {
        resolve(JSON.parse(body))
      } catch (error) {
        reject(error)
      }
    })
    request.on('error', reject)
  })
}

function ymd(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

function addDays(date, days) {
  const next = new Date(date)
  next.setDate(next.getDate() + days)
  return next
}

function normalizeTime(hour, minute = 0) {
  return `${String(Math.min(Math.max(hour, 0), 23)).padStart(2, '0')}:${String(
    Math.min(Math.max(minute, 0), 59)
  ).padStart(2, '0')}`
}

function parseChineseNumber(value) {
  const digits = {
    零: 0,
    一: 1,
    二: 2,
    两: 2,
    三: 3,
    四: 4,
    五: 5,
    六: 6,
    七: 7,
    八: 8,
    九: 9
  }
  if (value === '十') return 10
  if (value.startsWith('十')) return 10 + (digits[value.slice(1)] ?? 0)
  if (value.endsWith('十')) return (digits[value[0]] ?? 1) * 10
  if (value.includes('十')) {
    const [ten, one] = value.split('十')
    return (digits[ten] ?? 1) * 10 + (digits[one] ?? 0)
  }
  return digits[value]
}

function resolveAssignee(text) {
  return users.find((user) => text.includes(user.name)) ?? users[0]
}

function parseTodoText(text) {
  const normalizedText = text.trim()
  const baseDate = new Date()
  let date = ymd(baseDate)
  let endDate

  if (normalizedText.includes('后天')) {
    date = ymd(addDays(baseDate, 2))
  } else if (normalizedText.includes('明天')) {
    date = ymd(addDays(baseDate, 1))
  } else if (normalizedText.includes('今天')) {
    date = ymd(baseDate)
  }

  const monthDayMatch = normalizedText.match(/(\d{1,2})\s*月\s*(\d{1,2})\s*[日号]?/)
  if (monthDayMatch) {
    date = ymd(new Date(baseDate.getFullYear(), Number(monthDayMatch[1]) - 1, Number(monthDayMatch[2])))
  }

  if (normalizedText.includes('本周内')) {
    const day = baseDate.getDay() || 7
    endDate = ymd(addDays(baseDate, 7 - day))
  } else if (normalizedText.includes('下周前')) {
    const day = baseDate.getDay() || 7
    endDate = ymd(addDays(baseDate, 8 - day))
  } else if (normalizedText.includes('本月内')) {
    endDate = ymd(new Date(baseDate.getFullYear(), baseDate.getMonth() + 1, 0))
  }

  let time
  if (normalizedText.includes('上午')) time = '09:00'
  if (normalizedText.includes('下午')) time = '14:00'
  if (normalizedText.includes('晚上')) time = '19:00'

  const timeMatch = normalizedText.match(/(\d{1,2})\s*(?:点|时|:|：)\s*(\d{1,2})?\s*分?/)
  if (timeMatch) {
    let hour = Number(timeMatch[1])
    const minute = Number(timeMatch[2] ?? 0)
    if ((normalizedText.includes('下午') || normalizedText.includes('晚上')) && hour < 12) hour += 12
    time = normalizeTime(hour, minute)
  }
  const chineseTimeMatch = normalizedText.match(/([零一二两三四五六七八九十]{1,3})\s*(?:点|时)/)
  if (!timeMatch && chineseTimeMatch) {
    let hour = parseChineseNumber(chineseTimeMatch[1])
    if (typeof hour === 'number') {
      if ((normalizedText.includes('下午') || normalizedText.includes('晚上')) && hour < 12) hour += 12
      time = normalizeTime(hour)
    }
  }

  const assignee = resolveAssignee(normalizedText)
  const title = normalizedText
    .replace(/提醒我|提醒|待办|创建|安排|明天|后天|今天|上午|下午|晚上/g, '')
    .replace(/\d{1,2}\s*(?:点|时|:|：)\s*\d{0,2}\s*分?/g, '')
    .replace(/[零一二两三四五六七八九十]{1,3}\s*(?:点|时)/g, '')
    .trim()

  return {
    title: title || normalizedText.slice(0, 28) || '桌面待办',
    date,
    endDate,
    time,
    assigneeId: assignee.id,
    assigneeName: assignee.name,
    source: `桌面助手：${normalizedText}`
  }
}

function createCalendarEvent(draft, payload) {
  const assigneeId = payload.assigneeId ?? draft.result.assigneeId ?? users[0].id
  const assigneeName = payload.assigneeName ?? draft.result.assigneeName ?? users[0].name

  return {
    id: `evt-${payload.date}-${Date.now()}`,
    date: payload.date,
    endDate: payload.endDate && payload.endDate !== payload.date ? payload.endDate : undefined,
    time: payload.time || undefined,
    title: payload.title.trim(),
    type: 'task',
    owner: assigneeName,
    status: 'todo',
    source: payload.source?.trim() || draft.result.source || '桌面助手',
    creatorId: 'leader-zhang',
    creatorName: '刘美华',
    assigneeId,
    assigneeName
  }
}

async function handleRequest(request, response) {
  if (request.method === 'OPTIONS') {
    jsonResponse(response, 204, {})
    return
  }

  const url = new URL(request.url ?? '/', `http://${host}:${port}`)

  try {
    if (request.method === 'POST' && url.pathname === '/api/ai/todo/parse') {
      const body = await readBody(request)
      const text = String(body.text ?? '').trim()
      if (!text) {
        jsonResponse(response, 400, { code: 400, message: '请输入待办内容' })
        return
      }

      const draftId = `todo_draft_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`
      const draft = {
        draftId,
        rawText: text,
        confidence: 0.92,
        needConfirm: true,
        status: 'pending',
        result: parseTodoText(text)
      }
      drafts.set(draftId, draft)
      jsonResponse(response, 200, { code: 0, data: draft })
      return
    }

    if (request.method === 'GET' && url.pathname === '/api/todo/draft/detail') {
      const draftId = url.searchParams.get('draftId') ?? ''
      const draft = drafts.get(draftId)
      if (!draft) {
        jsonResponse(response, 404, { code: 404, message: '待办草稿不存在或已过期' })
        return
      }
      jsonResponse(response, 200, { code: 0, data: draft })
      return
    }

    if (request.method === 'POST' && url.pathname === '/api/todo/createFromDraft') {
      const body = await readBody(request)
      const draft = drafts.get(body.draftId)
      if (!draft) {
        jsonResponse(response, 404, { code: 404, message: '待办草稿不存在或已过期' })
        return
      }

      const event = createCalendarEvent(draft, body.payload ?? draft.result)
      draft.status = 'confirmed'
      drafts.set(draft.draftId, draft)
      jsonResponse(response, 200, { code: 0, data: { success: true, event } })
      return
    }

    if (request.method === 'POST' && url.pathname === '/api/desktop/task/action') {
      const body = await readBody(request)
      jsonResponse(response, 200, {
        code: 0,
        data: {
          success: true,
          taskStatus: body.action === 'cancel' ? 'cancelled' : body.action === 'later' ? 'snoozed' : 'confirmed',
          message: '操作成功'
        }
      })
      return
    }

    jsonResponse(response, 404, { code: 404, message: '接口不存在' })
  } catch (error) {
    jsonResponse(response, 500, {
      code: 500,
      message: error instanceof Error ? error.message : 'Mock API 异常'
    })
  }
}

http.createServer(handleRequest).listen(port, host, () => {
  console.log(`Mock API listening on http://${host}:${port}`)
})
