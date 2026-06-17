export type TaskAction = 'confirm' | 'cancel' | 'later' | 'openDetail'

export interface DesktopEvent<T = unknown> {
  eventId: string
  eventType: string
  timestamp: string
  needAck?: boolean
  payload: T
}

export interface TaskCreatedPayload {
  taskId: string
  title: string
  content?: string
  deadline?: string
  priority?: 'low' | 'normal' | 'high'
  creatorName?: string
  actions?: Array<{
    key: TaskAction
    label: string
  }>
}

export interface TaskActionRequest {
  eventId: string
  taskId: string
  action: TaskAction
}

export interface TaskActionResponse {
  success: boolean
  taskStatus: string
  message: string
}

export type TaskCreatedEvent = DesktopEvent<TaskCreatedPayload>

