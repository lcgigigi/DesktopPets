import { getTodoDetail, resolveTodoUserNames } from './todo.service'
import type { SysMessageNotification } from '../types/sys-message'
import type { SmartTodoMain } from '../types/todo'

type MessageFields = {
  title: string
  content: string
  sender: string
  handler: string
  startTime: string
  endTime: string
}

const SENDER_LABELS = new Set(['创建人', '派发人', '发送人'])
const HANDLER_LABELS = new Set(['处理人', '完成人', '执行人'])
const TITLE_LABELS = new Set(['标题', '待办', '任务名称', '事项'])
const CONTENT_LABELS = new Set(['内容', '待办内容', '任务内容'])
const START_TIME_LABELS = new Set(['开始时间', '开始'])
const END_TIME_LABELS = new Set(['结束时间', '截止时间', '截止', '到期时间'])

function toText(value: unknown) {
  return value === null || value === undefined ? '' : String(value).trim()
}

function createFields(): MessageFields {
  return {
    title: '',
    content: '',
    sender: '',
    handler: '',
    startTime: '',
    endTime: '',
  }
}

function firstText(...values: unknown[]) {
  return values.map(toText).find(Boolean) || ''
}

function parseJsonFields(content: string): MessageFields | null {
  const trimmed = content.trim()
  if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) return null

  try {
    const payload = JSON.parse(trimmed) as Record<string, unknown>
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null

    return {
      title: firstText(payload.title, payload.task, payload.name),
      content: firstText(payload.content, payload.todoContent, payload.taskContent, payload.title),
      sender: firstText(
        payload.creatorNickName,
        payload.creatorName,
        payload.senderName,
        payload.creatorId,
        payload.senderId,
      ),
      handler: firstText(
        payload.handlerNickName,
        payload.handlerName,
        payload.currentHandlerName,
        payload.currentHandlerId,
        payload.handlerId,
      ),
      startTime: firstText(payload.startDateShow, payload.startDate),
      endTime: firstText(payload.endDateShow, payload.endDate, payload.deadline),
    }
  } catch {
    return null
  }
}

function parseLineFields(content: string): MessageFields {
  const fields = createFields()

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim()
    const separator = line.search(/[:：]/)
    if (separator <= 0) continue

    const label = line.slice(0, separator).trim()
    const value = line.slice(separator + 1).trim()
    if (!value) continue

    if (SENDER_LABELS.has(label)) fields.sender = value
    else if (HANDLER_LABELS.has(label)) fields.handler = value
    else if (TITLE_LABELS.has(label)) fields.title = value
    else if (CONTENT_LABELS.has(label)) fields.content = value
    else if (START_TIME_LABELS.has(label)) fields.startTime = value
    else if (END_TIME_LABELS.has(label)) fields.endTime = value
  }

  return fields
}

function getMessageFields(message: SysMessageNotification) {
  const content = message.msgContent.trim()
  return parseJsonFields(content) || parseLineFields(content)
}

function getTodoContent(todo: SmartTodoMain | null) {
  if (!todo) return ''
  return firstText(todo.content, todo.title, todo.remark, todo.otherContent, todo.completeDesc)
}

function getTodoSender(todo: SmartTodoMain | null) {
  if (!todo) return ''
  return firstText(todo.creatorNickName, todo.creatorName, todo.creatorId)
}

function getTodoHandler(todo: SmartTodoMain | null) {
  if (!todo) return ''
  return firstText(
    todo.handlerNickName,
    todo.currentHandlerName,
    todo.currentHandlerId,
    todo.handlerId,
  )
}

function normalizeDateTime(value: string) {
  return value
    .replace('T', ' ')
    .replace(/\.\d{3}Z?$/, '')
    .replace(/Z$/, '')
    .slice(0, 16)
}

function formatTimeHint(startTime: string, endTime: string) {
  const start = normalizeDateTime(startTime)
  const end = normalizeDateTime(endTime)
  if (start && end && start !== end) return `（${start} 至 ${end}）`
  if (end) return `（截止：${end}）`
  if (start) return `（时间：${start}）`
  return ''
}

function isCompletedMessage(message: SysMessageNotification) {
  return /待办已完成|已完成|处理完成/.test(message.msgSubject)
}

function isAssignmentMessage(message: SysMessageNotification) {
  return /新.*待办|待办.*派发|派发.*待办|您有一条新的待办/.test(message.msgSubject)
}

function isDueMessage(message: SysMessageNotification) {
  return /即将|提醒|截止|到期|结束/.test(message.msgSubject)
}

function isTodoMessage(message: SysMessageNotification) {
  return message.bizType === 1 || /待办|任务/.test(message.msgSubject)
}

function getPersonIds(value: string) {
  return value
    .split(/[、,，]/)
    .map((item) => item.trim())
    .filter((item) => /^\d+$/.test(item))
}

function resolvePerson(value: string, names: Map<string, string>) {
  if (!value) return ''
  return value
    .split(/([、,，])/)
    .map((part) => names.get(part.trim()) || part)
    .join('')
    .trim()
}

export function getSysMessageFallback(message: SysMessageNotification) {
  return message.msgContent.trim() || '你收到一条新的系统消息'
}

export async function resolveSysMessageContent(message: SysMessageNotification) {
  const fallback = getSysMessageFallback(message)
  const fields = getMessageFields(message)
  const todo = isTodoMessage(message) && message.bizId ? await getTodoDetail(message.bizId) : null

  const sender = firstText(fields.sender, getTodoSender(todo))
  const handler = firstText(fields.handler, getTodoHandler(todo))
  const content = firstText(fields.content, fields.title, getTodoContent(todo))
  const startTime = firstText(fields.startTime, todo?.startDateShow, todo?.startDate)
  const endTime = firstText(fields.endTime, todo?.endDateShow, todo?.endDate)
  const names = await resolveTodoUserNames([...getPersonIds(sender), ...getPersonIds(handler)])

  if (isCompletedMessage(message) && handler && content) {
    return `${resolvePerson(handler, names)} 已完成待办：${content}`
  }

  if (isAssignmentMessage(message) && sender && content) {
    return `${resolvePerson(sender, names)} 派发给你一条待办：${content}`
  }

  if (isDueMessage(message) && content) {
    return `${content}${formatTimeHint(startTime, endTime)}`
  }

  return fallback
}
