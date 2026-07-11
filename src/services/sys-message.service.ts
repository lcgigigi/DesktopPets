import type { SysMessageNotification, SysMessagePushPayload, SysMessageStatus } from '../types/sys-message'
import { env } from '../utils/env'

type MessageListener = (message: SysMessageNotification) => void

let socket: WebSocket | null = null
let reconnectTimer: number | undefined
let reconnectAttempts = 0
let shouldReconnect = true
let activeUserId = ''
const messageListeners = new Set<MessageListener>()

interface LocationLike {
  protocol: string
  host: string
}

function notifyMessage(message: SysMessageNotification) {
  messageListeners.forEach((listener) => listener(message))
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

function normalizeSysMessage(payload: SysMessagePushPayload): SysMessageNotification | null {
  if (payload.type !== 'sys_message') return null

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

  const nextSocket = new WebSocket(url)
  socket = nextSocket

  nextSocket.addEventListener('open', () => {
    if (socket !== nextSocket) return
    reconnectAttempts = 0
  })
  nextSocket.addEventListener('message', (event) => {
    if (socket !== nextSocket || typeof event.data !== 'string') return

    try {
      const message = normalizeSysMessage(JSON.parse(event.data) as SysMessagePushPayload)
      if (message) notifyMessage(message)
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
  connect(userId: string) {
    if (env.enableMock) return

    const nextUserId = userId.trim()
    if (!nextUserId) return

    if (
      activeUserId === nextUserId &&
      socket &&
      (socket.readyState === WebSocket.CONNECTING || socket.readyState === WebSocket.OPEN)
    ) {
      return
    }

    activeUserId = nextUserId
    shouldReconnect = true
    reconnectAttempts = 0
    connectSocket()
  },
  disconnect() {
    shouldReconnect = false
    activeUserId = ''
    teardownSocket()
  }
}
