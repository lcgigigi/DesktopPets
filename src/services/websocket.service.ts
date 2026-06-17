import type { TaskCreatedEvent } from '../types/task'
import { env } from '../utils/env'

type TaskListener = (event: TaskCreatedEvent) => void
type StatusListener = (status: 'connecting' | 'connected' | 'reconnecting' | 'mock' | 'closed') => void

let socket: WebSocket | null = null
let reconnectTimer: number | undefined
let shouldReconnect = true
const taskListeners = new Set<TaskListener>()
const statusListeners = new Set<StatusListener>()

function emitStatus(status: Parameters<StatusListener>[0]) {
  statusListeners.forEach((listener) => listener(status))
}

function emitTask(event: TaskCreatedEvent) {
  taskListeners.forEach((listener) => listener(event))
}

export const websocketService = {
  onTask(listener: TaskListener) {
    taskListeners.add(listener)
    return () => taskListeners.delete(listener)
  },
  onStatus(listener: StatusListener) {
    statusListeners.add(listener)
    return () => statusListeners.delete(listener)
  },
  connect() {
    if (env.enableMock) {
      emitStatus('mock')
      return
    }

    if (socket && (socket.readyState === WebSocket.CONNECTING || socket.readyState === WebSocket.OPEN)) {
      return
    }

    shouldReconnect = true
    emitStatus('connecting')
    socket = new WebSocket(env.wsUrl)
    socket.addEventListener('open', () => emitStatus('connected'))
    socket.addEventListener('message', (message) => {
      try {
        const event = JSON.parse(message.data) as TaskCreatedEvent
        if (event.eventType === 'task.created') {
          emitTask(event)
        }
      } catch (error) {
        console.warn('Invalid websocket message', error)
      }
    })
    socket.addEventListener('close', () => {
      socket = null
      if (!shouldReconnect) return
      emitStatus('reconnecting')
      window.clearTimeout(reconnectTimer)
      reconnectTimer = window.setTimeout(() => websocketService.connect(), 3000)
    })
    socket.addEventListener('error', () => socket?.close())
  },
  disconnect() {
    shouldReconnect = false
    emitStatus('closed')
    window.clearTimeout(reconnectTimer)
    socket?.close()
    socket = null
  }
}
