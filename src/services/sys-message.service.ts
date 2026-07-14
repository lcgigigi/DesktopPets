import type { SysMessageNotification, SysMessagePushPayload, SysMessageStatus } from '../types/sys-message'
import { env } from '../utils/env'
import { request } from './request'

type MessageListener = (message: SysMessageNotification) => void

let socket: WebSocket | null = null
let reconnectTimer: number | undefined
let reconnectAttempts = 0
let shouldReconnect = true
let activeUserId = ''
let pollTimer: number | undefined
let polling = false
let pollInitialized = false
const messageListeners = new Set<MessageListener>()
const knownMessageIds = new Set<string>()
const SYS_MESSAGE_POLL_INTERVAL = 10_000
const MAX_KNOWN_MESSAGE_IDS = 500

interface LocationLike {
  protocol: string
  host: string
}

interface SysMessageBackendItem {
  id?: string | number
  msgSubject?: string | null
  msgContent?: string | null
  msgStatus?: number | null
  msgType?: number | null
  bizType?: number | null
  bizId?: string | number | null
  createTime?: string | null
}

interface SysMessagePagePayload {
  rows?: SysMessageBackendItem[] | null
  list?: SysMessageBackendItem[] | null
}

function notifyMessage(message: SysMessageNotification) {
  messageListeners.forEach((listener) => listener(message))
}

function rememberMessage(message: SysMessageNotification) {
  if (knownMessageIds.has(message.id)) return false

  knownMessageIds.add(message.id)
  if (knownMessageIds.size > MAX_KNOWN_MESSAGE_IDS) {
    const oldestId = knownMessageIds.values().next().value
    if (oldestId) knownMessageIds.delete(oldestId)
  }
  return true
}

function deliverMessage(message: SysMessageNotification) {
  if (rememberMessage(message)) notifyMessage(message)
}

function toId(value?: string | number | null) {
  return value === null || value === undefined ? '' : String(value).trim()
}

function toNumber(value: unknown, fallback = 0) {
  const numeric = Number(value)
  return Number.isFinite(numeric) ? numeric : fallback
}

function toStatus(value: unknown): SysMessageStatus {
  return Number(value) === 1 ? 1 : 0
}

function normalizeSysMessageItem(payload: SysMessageBackendItem): SysMessageNotification | null {
  const id = toId(payload.id)
  if (!id) return null

  const createTime = payload.createTime?.trim() || undefined
  const msgSubject = payload.msgSubject?.trim() || '站内消息'
  const msgContent = payload.msgContent?.trim() || ''

  return {
    id,
    rawId: payload.id ?? id,
    dedupeKey: [id, createTime || '', msgSubject, msgContent].join('|'),
    msgSubject,
    msgContent,
    msgStatus: toStatus(payload.msgStatus),
    msgType: toNumber(payload.msgType, 1),
    bizType:
      payload.bizType === null || payload.bizType === undefined
        ? undefined
        : toNumber(payload.bizType),
    bizId: toId(payload.bizId) || undefined,
    createTime
  }
}

function normalizeSysMessage(payload: SysMessagePushPayload): SysMessageNotification | null {
  if (payload.type !== 'sys_message') return null
  return normalizeSysMessageItem(payload)
}

function toWsProtocol(protocol: string) {
  return protocol === 'https:' ? 'wss:' : 'ws:'
}

function getDefaultLocation(): LocationLike | undefined {
  if (typeof window === 'undefined') return undefined

  return {
    protocol: window.location.protocol,
    host: window.location.host
  }
}

function normalizeWebSocketBaseUrl(baseUrl: string, location = getDefaultLocation()) {
  const trimmed = baseUrl.trim().replace(/\/+$/, '')

  if (!trimmed) {
    if (!location?.host) return ''
    return `${toWsProtocol(location.protocol)}//${location.host}/websocket`
  }

  if (trimmed.startsWith('ws://') || trimmed.startsWith('wss://')) {
    return trimmed.endsWith('/websocket') ? trimmed : `${trimmed}/websocket`
  }

  if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
    const url = new URL(trimmed)
    url.protocol = toWsProtocol(url.protocol)
    return url.toString().replace(/\/+$/, '').endsWith('/websocket')
      ? url.toString().replace(/\/+$/, '')
      : `${url.toString().replace(/\/+$/, '')}/websocket`
  }

  const resolved = `ws://${trimmed}`
  return resolved.endsWith('/websocket') ? resolved : `${resolved}/websocket`
}

function buildSysMessageWebSocketUrl(userId: string) {
  const baseUrl = normalizeWebSocketBaseUrl(env.sysMessageWsBaseUrl)
  if (!baseUrl || !userId.trim()) return ''

  return `${baseUrl}/${encodeURIComponent(userId.trim())}`
}

async function pollUnreadMessages() {
  if (polling || !activeUserId.trim()) return

  polling = true
  try {
    const payload = await request.get<unknown, SysMessagePagePayload>('/sys-message/page', {
      params: {
        pageNum: 1,
        pageSize: 20,
        msgStatus: 0,
      },
    })
    const messages = (payload?.rows ?? payload?.list ?? [])
      .map((item) => normalizeSysMessageItem(item))
      .filter((item): item is SysMessageNotification => Boolean(item))

    if (!pollInitialized) {
      pollInitialized = true
      const newestMessage = messages[0]
      const shouldNotifyNewest = Boolean(newestMessage && !knownMessageIds.has(newestMessage.id))
      messages.forEach((message) => rememberMessage(message))
      if (newestMessage && shouldNotifyNewest) notifyMessage(newestMessage)
      return
    }

    messages
      .filter((message) => !knownMessageIds.has(message.id))
      .reverse()
      .forEach((message) => deliverMessage(message))
  } catch (error) {
    console.warn('Sys message polling failed', error)
  } finally {
    polling = false
  }
}

function startPolling(reset: boolean) {
  window.clearInterval(pollTimer)
  if (reset) {
    pollInitialized = false
    knownMessageIds.clear()
  }

  void pollUnreadMessages()
  pollTimer = window.setInterval(() => {
    void pollUnreadMessages()
  }, SYS_MESSAGE_POLL_INTERVAL)
}

function stopPolling() {
  window.clearInterval(pollTimer)
  pollTimer = undefined
  polling = false
  pollInitialized = false
  knownMessageIds.clear()
}

function teardownSocket() {
  window.clearTimeout(reconnectTimer)
  if (!socket) return

  const existing = socket
  socket = null
  existing.close()
}

function scheduleReconnect() {
  if (!shouldReconnect || !activeUserId.trim()) return

  window.clearTimeout(reconnectTimer)
  const delay = Math.min(30000, 3000 + reconnectAttempts * 2000)
  reconnectTimer = window.setTimeout(() => {
    reconnectAttempts += 1
    connectSocket()
  }, delay)
}

function connectSocket() {
  if (!activeUserId.trim()) return

  const url = buildSysMessageWebSocketUrl(activeUserId)
  if (!url) return

  teardownSocket()

  let nextSocket: WebSocket
  try {
    nextSocket = new WebSocket(url)
  } catch (error) {
    console.warn('Sys message websocket connection failed', error)
    scheduleReconnect()
    return
  }
  socket = nextSocket

  nextSocket.addEventListener('open', () => {
    if (socket !== nextSocket) return
    reconnectAttempts = 0
  })
  nextSocket.addEventListener('message', (event) => {
    if (socket !== nextSocket || typeof event.data !== 'string') return

    try {
      const message = normalizeSysMessage(JSON.parse(event.data) as SysMessagePushPayload)
      if (message) deliverMessage(message)
    } catch (error) {
      console.warn('Invalid sys_message websocket payload', error)
    }
  })
  nextSocket.addEventListener('close', () => {
    if (socket !== nextSocket) return
    socket = null
    if (shouldReconnect) scheduleReconnect()
  })
  nextSocket.addEventListener('error', () => {
    if (socket === nextSocket) nextSocket.close()
  })
}

export const sysMessageService = {
  onMessage(listener: MessageListener) {
    messageListeners.add(listener)
    return () => messageListeners.delete(listener)
  },
  connect(userId: string, options: { force?: boolean } = {}) {
    if (env.enableMock) return

    const nextUserId = userId.trim()
    if (!nextUserId) return
    const userChanged = activeUserId !== nextUserId

    activeUserId = nextUserId
    shouldReconnect = true
    startPolling(userChanged)

    if (
      !options.force &&
      !userChanged &&
      socket &&
      (socket.readyState === WebSocket.CONNECTING || socket.readyState === WebSocket.OPEN)
    ) {
      return
    }

    reconnectAttempts = 0
    connectSocket()
  },
  disconnect() {
    shouldReconnect = false
    activeUserId = ''
    stopPolling()
    teardownSocket()
  }
}
