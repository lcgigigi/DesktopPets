import type { TaskCreatedEvent } from '../types/task'
import { env } from '../utils/env'

type TaskListener = (event: TaskCreatedEvent) => void
type StatusListener = (status: 'connecting' | 'connected' | 'reconnecting' | 'mock' | 'closed') => void

let socket: WebSocket | null = null
let reconnectTimer: number | undefined
let shouldReconnect = true
let connectionGeneration = 0
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

    if (!env.wsUrl.trim()) {
      emitStatus('closed')
      return
    }

    if (socket && (socket.readyState === WebSocket.CONNECTING || socket.readyState === WebSocket.OPEN)) {
      return
    }

    shouldReconnect = true
    emitStatus('connecting')
    const generation = ++connectionGeneration
    const nextSocket = new WebSocket(env.wsUrl)
    socket = nextSocket
    const isCurrentConnection = () => socket === nextSocket && connectionGeneration === generation
    nextSocket.addEventListener('open', () => {
      if (!isCurrentConnection()) return
      emitStatus('connected')
    })
    nextSocket.addEventListener('message', (message) => {
      if (!isCurrentConnection()) return
      try {
        const event = JSON.parse(message.data) as TaskCreatedEvent
        if (event.eventType === 'task.created') {
          emitTask(event)
        }
      } catch (error) {
        console.warn('Invalid websocket message', error)
      }
    })
    nextSocket.addEventListener('close', () => {
      if (!isCurrentConnection()) return
      socket = null
      if (!shouldReconnect) return
      emitStatus('reconnecting')
      window.clearTimeout(reconnectTimer)
      reconnectTimer = window.setTimeout(() => {
        reconnectTimer = undefined
        if (connectionGeneration === generation && shouldReconnect) websocketService.connect()
      }, 3000)
    })
    nextSocket.addEventListener('error', () => {
      if (!isCurrentConnection()) return
      nextSocket.close()
    })
  },
  disconnect() {
    shouldReconnect = false
    connectionGeneration += 1
    emitStatus('closed')
    window.clearTimeout(reconnectTimer)
    reconnectTimer = undefined
    const previousSocket = socket
    socket = null
    previousSocket?.close()
  }
}
